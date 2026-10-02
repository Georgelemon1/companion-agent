#!/usr/bin/env python3
"""步骤 3/5：把 $BUILD/rootfs 打成 APK 用的载荷（payload.zip + payload.manifest）。

产出（都放进 APK 的 assets/）：
  payload.zip       只装**普通文件的内容**，路径为相对 rootfs 的路径
  payload.manifest  `八进制mode<TAB>路径[<TAB>符号链接目标]`，一行一个条目

为什么不像 tar 那样一个文件搞定：Android 的 java.util.zip.ZipEntry **没有**
getExternalAttributes()（那是 OpenJDK 的扩展），所以 unix 权限位与符号链接只能另存一份清单。

两个必须处理的坑（都会**静默**毁掉结果）：
  ① usrmerge：Ubuntu 24.04 的 /bin 是指向 usr/bin 的**符号链接**。用 os.walk 时它出现在
     dirnames 里却不会产出条目 —— 于是整个 /bin 不进载荷，启动时找不到 /bin/sh。
     这里手写 scandir 递归，先判 is_symlink()、再判 is_dir()，一个都不漏。
  ② 设备节点 / FIFO / socket 无法在 Android 应用沙箱里重建（mknod 被拒），一律跳过 ——
     它们也没有意义：PRoot 会把宿主机的 /dev /proc /sys 直接 bind 进去，guest 的这几个
     目录会被完全遮住。

打包后做完整性自检：源树里**每一个**路径都必须出现在 manifest 里，每个普通文件在 zip 里
的大小必须与源一致，且整包能重新打开、逐条 CRC 校验通过。
"""
import hashlib
import os
import stat
import sys
import zipfile

BUILD = os.environ.get('BUILD', '/mnt/e/android-build/work')
ROOTFS = os.path.join(BUILD, 'rootfs')
OUT = os.path.join(BUILD, 'payload')


def walk(root):
    """递归遍历，返回 [(relpath, mode, kind, linktarget, abspath)]；不跟随符号链接。"""
    out = []

    def rec(absdir, rel):
        with os.scandir(absdir) as it:
            for entry in sorted(it, key=lambda e: e.name):
                relpath = f'{rel}/{entry.name}' if rel else entry.name
                if entry.is_symlink():
                    target = os.readlink(entry.path)
                    lst = os.lstat(entry.path)
                    out.append((relpath, lst.st_mode, 'link', target, entry.path))
                elif entry.is_dir(follow_symlinks=False):
                    lst = os.lstat(entry.path)
                    out.append((relpath, lst.st_mode, 'dir', None, entry.path))
                    rec(entry.path, relpath)
                elif entry.is_file(follow_symlinks=False):
                    lst = os.lstat(entry.path)
                    out.append((relpath, lst.st_mode, 'file', None, entry.path))
                else:
                    lst = os.lstat(entry.path)
                    out.append((relpath, lst.st_mode, 'other', None, entry.path))

    rec(root, '')
    return out


def main():
    if not os.path.isdir(ROOTFS):
        print(f'缺少 {ROOTFS}（先跑 02-prepare-rootfs.sh）', file=sys.stderr)
        return 1
    os.makedirs(OUT, exist_ok=True)
    zip_path = os.path.join(OUT, 'payload.zip')
    manifest_path = os.path.join(OUT, 'payload.manifest')

    entries = walk(ROOTFS)
    kinds = {}
    for item in entries:
        kinds[item[2]] = kinds.get(item[2], 0) + 1
    print(f'  条目 {len(entries)}  {kinds}')

    manifest_lines = []
    files = 0
    skipped = []
    total_uncompressed = 0
    for relpath, mode, kind, target, abspath in entries:
        if kind == 'other':
            skipped.append(relpath)
            continue
        if kind == 'link':
            manifest_lines.append(f'{mode:o}\t{relpath}\t{target}')
        else:
            manifest_lines.append(f'{mode:o}\t{relpath}')
        if kind == 'file':
            files += 1

    with open(manifest_path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('\n'.join(manifest_lines))
        fh.write('\n')

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, allowZip64=True,
                         compresslevel=6) as zf:
        for relpath, mode, kind, target, abspath in entries:
            if kind != 'file':
                continue
            # 保持原始 mtime 意义不大，但保持大小/内容一致是硬要求
            zf.write(abspath, arcname=relpath)

    # ── 自检 ────────────────────────────────────────────────────────────────
    print('  自检：')
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        bad = zf.testzip()
        if bad is not None:
            print(f'  ❌ zip CRC 校验失败: {bad}', file=sys.stderr)
            return 1
        print(f'    zip 条目 {len(names)} / 应装普通文件 {files} '
              f'{"✅" if len(names) == files else "❌"}')
        source_files = {r for r, m, k, t, a in entries if k == 'file'}
        missing = source_files - names
        if missing:
            print(f'  ❌ 有 {len(missing)} 个普通文件没进 zip，例如 '
                  f'{sorted(missing)[:5]}', file=sys.stderr)
            return 1
        size_mismatch = []
        for relpath, mode, kind, target, abspath in entries:
            if kind != 'file':
                continue
            if zf.getinfo(relpath).file_size != os.path.getsize(abspath):
                size_mismatch.append(relpath)
        if size_mismatch:
            print(f'  ❌ {len(size_mismatch)} 个文件大小不一致，例如 '
                  f'{size_mismatch[:5]}', file=sys.stderr)
            return 1
        print('    逐个文件大小一致 ✅   CRC 全通过 ✅')

    # 关键路径必须在（少一个手机上就跑不起来）。
    # 注意 `bin/sh` 不能这么查：Ubuntu 24.04 是 usrmerge，`/bin` 本身就是指向 usr/bin 的
    # 符号链接，真实条目叫 `usr/bin/sh`（它又是指向 dash 的软链）。查 `bin/sh` 必然落空 ——
    # 这正是"指向目录的软链"那类坑的镜像版本。
    must = ['usr/bin/sh', 'usr/bin/dash', 'usr/local/bin/node', 'opt/companion/start.sh',
            'opt/companion/liblinkfix.so', 'opt/companion/app/launcher.mjs',
            'opt/companion/app/cordis.patch.yml', 'opt/companion/app/public/index.html',
            'opt/companion/app/node_modules/@deepseek-ai/dsh-app-boot/package.json']
    manifest_entries = {}
    for line in manifest_lines:
        parts = line.split('\t')
        manifest_entries[parts[1]] = parts[2] if len(parts) > 2 else None
    ok = True
    for path in must:
        present = path in manifest_entries
        ok = ok and present
        print(f'    {path:<58} {"✅" if present else "❌ 缺失"}')
    # usrmerge 自检：/bin、/lib、/lib64 必须是软链
    for link, target in (('bin', 'usr/bin'), ('lib', 'usr/lib'), ('sbin', 'usr/sbin')):
        good = manifest_entries.get(link) == target
        ok = ok and good
        print(f'    {link:<58} {"✅ -> " + target if good else "❌ 应该是指向 " + target + " 的软链"}')
    if not ok:
        print('  ❌ 关键路径缺失，别把这个载荷打进 APK', file=sys.stderr)
        return 1

    if skipped:
        print(f'    跳过 {len(skipped)} 个设备节点/FIFO/socket（被 PRoot 的 /dev 挂载遮住，无影响）')
        print(f'      例如 {skipped[:5]}')

    # zip64 必须没有：Android 的 ZipInputStream 对 zip64 支持参差，而我们根本不需要它
    with open(zip_path, 'rb') as fh:
        blob = fh.read()
    for sig, label in ((b'PK\x06\x06', 'zip64 EOCD'), (b'PK\x06\x07', 'zip64 locator')):
        if sig in blob:
            print(f'  ❌ payload.zip 里出现了 {label}（不该有）', file=sys.stderr)
            return 1
    manifest_size = os.path.getsize(manifest_path)
    zip_size = os.path.getsize(zip_path)
    digest = hashlib.sha256(blob).hexdigest()
    print(f'    payload.zip      {zip_size/1048576:.1f} MB  sha256={digest}')
    print(f'    payload.manifest {manifest_size/1048576:.2f} MB  {len(manifest_lines)} 行')
    print('== 3 完成 ==')
    return 0


if __name__ == '__main__':
    sys.exit(main())

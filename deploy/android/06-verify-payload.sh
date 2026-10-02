#!/bin/sh
# 附加校验（在 WSL 里跑，可选但强烈建议）：把载荷真的解出来，然后用 qemu-aarch64 执行它。
#
# 本机没有安卓设备、没有模拟器，所以"装上真机能不能跑"验不了。但载荷本身可以验：
#   * 按 manifest 重建的 rootfs，/bin/sh 能不能起来（usrmerge 软链对不对）
#   * start.sh 在真 dash 下语法是否成立
#   * liblinkfix.so 能不能被 aarch64 glibc 的 ld.so 预载进来（它挂不上，node 就会起不来）
#   * 各 .node 原生扩展的 ELF 架构
#
# ⚠️ 已知做不了的一步：**qemu-user 在本机跑不了 arm64 的 node**。
#    WSL1 报的内核是 4.4，而 qemu-user 的 probe_guest_base() 依赖 MAP_FIXED_NOREPLACE
#    （Linux 4.17+ 才有），所以它找不到 guest_base；显式 -B 也被判"地址空间已被占用"。
#    表现：dash 这种小体积非 PIE 程序能跑，node（93 MB 非 PIE 镜像）跑不了。
#    脚本会把这一步标成"未验证"，而不是悄悄跳过。
#
# 用法：
#   wsl -u root -- env BUILD=/mnt/e/android-build/work bash deploy/android/06-verify-payload.sh
set -eu

BUILD="${BUILD:-/mnt/e/android-build/work}"
ZIP="$BUILD/payload/payload.zip"
MANIFEST="$BUILD/payload/payload.manifest"
DEST="${DEST:-$BUILD/extract-sim}"
QEMU="${QEMU:-/usr/bin/qemu-aarch64-static}"

[ -f "$ZIP" ] || { echo "缺少 $ZIP" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "缺少 $MANIFEST" >&2; exit 1; }
[ -x "$QEMU" ] || { echo "缺少 $QEMU（apt install qemu-user-static）" >&2; exit 1; }

FAIL=0
note() { echo "$1"; }
ok()   { echo "   ✅ $1"; }
bad()  { echo "   ❌ $1"; FAIL=$((FAIL + 1)); }

echo "== 6.1 按 manifest 重建 rootfs → $DEST =="
rm -rf "$DEST"
mkdir -p "$DEST"
python3 - "$ZIP" "$MANIFEST" "$DEST" <<'PY'
import os, sys, stat, zipfile
zip_path, manifest_path, dest = sys.argv[1], sys.argv[2], sys.argv[3]

# ① 按 zip 全解成普通文件（与 Payload.java 同序）
with zipfile.ZipFile(zip_path) as zf:
    zf.extractall(dest)

# ② 按 manifest 建目录 / 落软链 / 设权限位（Payload.java 的同一套语义）
dirs, links, modes = [], [], []
with open(manifest_path, encoding='utf-8') as fh:
    for line in fh:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 2:
            continue
        mode = int(parts[0], 8)
        path = os.path.join(dest, parts[1])
        if stat.S_ISLNK(mode):
            links.append((path, parts[2] if len(parts) > 2 else ''))
        elif stat.S_ISDIR(mode):
            dirs.append((path, mode))
        else:
            modes.append((path, mode))

for path, mode in sorted(dirs, key=lambda d: d[0].count('/')):
    os.makedirs(path, exist_ok=True)
for path, target in links:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.islink(path) or os.path.exists(path):
        if not os.path.isdir(path) or os.path.islink(path):
            os.remove(path)
    os.symlink(target, path)
for path, mode in modes:
    try:
        os.chmod(path, stat.S_IMODE(mode))
    except OSError:
        pass
print(f'   目录 {len(dirs)}  软链 {len(links)}  权限位 {len(modes)}')
PY

echo "== 6.2 关键路径与软链 =="
for p in bin/sh usr/bin/dash usr/local/bin/node opt/companion/start.sh \
         opt/companion/liblinkfix.so opt/companion/app/launcher.mjs \
         opt/companion/app/cordis.patch.yml opt/companion/app/public/index.html; do
  if [ -e "$DEST/$p" ] || [ -L "$DEST/$p" ]; then
    ok "$p -> $(readlink "$DEST/$p" 2>/dev/null || echo '(实体)')"
  else
    bad "$p 缺失"
  fi
done

echo "== 6.3 qemu-aarch64 真跑 /bin/sh（证明 usrmerge 软链重建正确） =="
if OUT=$($QEMU -L "$DEST" "$DEST/bin/sh" -c 'readlink -f /bin/sh 2>/dev/null || echo dash' 2>&1); then
  ok "/bin/sh 起来了：$OUT"
else
  bad "/bin/sh 跑不起来：$OUT"
fi

echo "== 6.4 dash -n 检查 start.sh 语法（真 dash，不是 bash） =="
if OUT=$($QEMU -L "$DEST" "$DEST/bin/sh" -n /opt/companion/start.sh 2>&1); then
  ok "start.sh 语法通过"
else
  bad "start.sh 语法错误：$OUT"
fi

echo "== 6.5 liblinkfix.so 能否被 aarch64 glibc 预载（挂不上 node 就起不来） =="
if OUT=$($QEMU -L "$DEST" -E LD_PRELOAD=/opt/companion/liblinkfix.so \
        "$DEST/bin/sh" -c 'echo preload-ok' 2>&1); then
  case "$OUT" in
    *preload-ok*) ok "LD_PRELOAD 生效：$OUT" ;;
    *) bad "预载后输出不对：$OUT" ;;
  esac
else
  bad "预载失败：$OUT"
fi
# liblinkfix 的设计要求"没有 libc 依赖"（少一个符号就少一种整个沙箱起不来的可能）
if python3 - "$DEST/opt/companion/liblinkfix.so" <<'PY'
import struct, sys
blob = open(sys.argv[1], 'rb').read()
assert blob[:4] == b'\x7fELF', 'not ELF'
e_shoff, = struct.unpack_from('<Q', blob, 0x28)
e_shentsize, e_shnum, e_shstrndx = struct.unpack_from('<HHH', blob, 0x3A)
secs = [struct.unpack_from('<IIQQQQIIQQ', blob, e_shoff + i * e_shentsize) for i in range(e_shnum)]
shstr = secs[e_shstrndx]
names = blob[shstr[4]:shstr[4] + shstr[5]]
def name_at(off):
    end = names.index(b'\0', off)
    return names[off:end].decode()
needed = []
for s in secs:
    if name_at(s[0]) == '.dynamic':
        data = blob[s[4]:s[4] + s[5]]
        for j in range(0, len(data), 16):
            tag, val = struct.unpack_from('<qQ', data, j)
            if tag == 0:
                break
            if tag == 1:
                dynstr = next(x for x in secs if name_at(x[0]) == '.dynstr')
                ds = blob[dynstr[4]:dynstr[4] + dynstr[5]]
                needed.append(ds[val:ds.index(b'\0', val)].decode())
print('   DT_NEEDED:', needed if needed else '（无 —— 完全自包含）')
sys.exit(1 if needed else 0)
PY
then ok "liblinkfix.so 无 libc 依赖（自包含）"; else bad "liblinkfix.so 有 DT_NEEDED，风险偏高"; fi

echo "== 6.6 arm64 node 本机跑不了（诚实的说明，不是跳过） =="
if OUT=$($QEMU -L "$DEST" "$DEST/usr/local/bin/node" -v 2>&1); then
  ok "node 能跑：$OUT"
else
  note "   ⚠️  未验证：$OUT"
  note "      原因：WSL1 内核 4.4 没有 MAP_FIXED_NOREPLACE，qemu-user 找不到 guest_base。"
  note "      影响：'载荷里的 node 在 arm64 glibc 下能起来'这一条**只能上真机验**。"
  note "      已用别的证据兜底：ELF 架构 + 版本串 + 原生扩展架构（见 05-verify-apk.mjs §5/§6）。"
fi

echo "== 6.7 结论 =="
if [ "$FAIL" -eq 0 ]; then
  echo "   ✅ 载荷重建算法（zip + manifest：权限位 + 软链）与 guest 侧脚本/linkfix 均可执行"
else
  echo "   ❌ $FAIL 项未通过"
fi
echo "   ⚠️  这仍**不是**真机验证：PRoot 在 Android 上的行为、SELinux execve、前台服务、"
echo "      WebView、开机自启，全部仍未验证。"
exit "$FAIL"

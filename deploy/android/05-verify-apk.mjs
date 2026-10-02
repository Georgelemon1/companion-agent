// 步骤 5/5：对产物 APK 做**静态**校验。
//
// 这里刻意不依赖 aapt2：二进制 AndroidManifest.xml 由本文件自己解析（AXML 格式），
// zip 布局、对齐、内部载荷的 ELF 架构也都自己读 —— 用另一条实现验证构建结果，
// 比"再用一遍同一套工具"更有意义。
//
// 能验的（本机可验，见 README 的"验过什么"）：结构完备、对齐正确、签名有效（由
// apksigner 在 4.10 验）、载荷里的 node/proot/linkfix 都是 aarch64、依赖是按 linux-arm64 解析的。
// 不能验的（见 README 的"未验证"）：真机安装、WebView 渲染、前台服务存活、开机自启、
// SELinux 上下文、PRoot 在真 Android 上的实际行为。
//
// 用法: node 05-verify-apk.mjs <apk> [work 目录]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const apkPath = process.argv[2];
const workDir = process.argv[3] || process.env.APK_WORK || 'E:/android-build/work-apk';
if (!apkPath) {
  console.error('用法: node 05-verify-apk.mjs <apk> [work 目录]');
  process.exit(2);
}

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
};

// ── 通用 zip 读取 ────────────────────────────────────────────────────────────
function listZip(blob, label) {
  let eocd = -1;
  for (let i = blob.length - 22; i >= 0; i--) {
    if (blob.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${label}: 找不到 EOCD`);
  const count = blob.readUInt16LE(eocd + 10);
  const cdOffset = blob.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (blob.readUInt32LE(p) !== 0x02014b50) throw new Error(`${label}: 中央目录签名错误 @${p}`);
    const method = blob.readUInt16LE(p + 10);
    const csize = blob.readUInt32LE(p + 20);
    const usize = blob.readUInt32LE(p + 24);
    const nameLen = blob.readUInt16LE(p + 28);
    const extraLen = buf16(blob, p + 30);
    const cmtLen = buf16(blob, p + 32);
    const localOffset = blob.readUInt32LE(p + 42);
    const name = blob.toString('utf8', p + 46, p + 46 + nameLen);
    if (blob.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`${label}: 本地头签名错误 ${name}`);
    const dataOffset = localOffset + 30 + buf16(blob, localOffset + 26) + buf16(blob, localOffset + 28);
    out.push({ name, method, csize, usize, localOffset, dataOffset, raw: () => blob.subarray(dataOffset, dataOffset + csize) });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
function buf16(blob, at) { return blob.readUInt16LE(at); }

function readEntry(blob, entry) {
  const raw = entry.raw();
  return entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
}

/** 只解压前 limit 字节（用来读大条目的文件头，不用把 110 MB 的 node 全解开）。 */
function inflatePrefix(raw, limit) {
  return new Promise((resolve, reject) => {
    const inflater = zlib.createInflateRaw();
    const parts = [];
    let got = 0;
    inflater.on('data', (chunk) => {
      parts.push(chunk);
      got += chunk.length;
      if (got >= limit) { inflater.destroy(); resolve(Buffer.concat(parts).subarray(0, limit)); }
    });
    inflater.on('end', () => resolve(Buffer.concat(parts)));
    inflater.on('error', reject);
    inflater.write(raw);
    inflater.end();
  });
}

// ── 二进制 AndroidManifest.xml（AXML）解析 ───────────────────────────────────
function parseAxml(blob) {
  if (blob.readUInt16LE(0) !== 0x0003) throw new Error('不是 RES_XML（AXML）');
  let p = blob.readUInt16LE(2);          // headerSize
  let strings = [];
  const elements = [];
  while (p < blob.length) {
    const type = blob.readUInt16LE(p);
    const size = blob.readUInt32LE(p + 4);
    if (size <= 0) break;
    if (type === 0x0001) {
      const stringCount = blob.readUInt32LE(p + 8);
      const flags = blob.readUInt32LE(p + 16);
      const stringsStart = blob.readUInt32LE(p + 20);
      const utf8 = (flags & 0x100) !== 0;
      const offsets = [];
      for (let i = 0; i < stringCount; i++) offsets.push(blob.readUInt32LE(p + 28 + i * 4));
      strings = offsets.map((off) => {
        const at = p + stringsStart + off;
        if (utf8) {
          let len = blob[at];
          let cursor = at + 1;
          if (len & 0x80) { len = ((len & 0x7F) << 8) | blob[cursor++]; }
          cursor += 1; // utf16 长度字节数
          return blob.toString('utf8', cursor, cursor + len);
        }
        let len = blob.readUInt16LE(at);
        let cursor = at + 2;
        if (len & 0x8000) { len = ((len & 0x7FFF) << 16) | blob.readUInt16LE(cursor); cursor += 2; }
        return blob.toString('utf16le', cursor, cursor + len * 2);
      });
    } else if (type === 0x0102) {         // START_ELEMENT
      const nameIdx = blob.readUInt32LE(p + 20);
      const attrStart = blob.readUInt16LE(p + 24);
      const attrSize = blob.readUInt16LE(p + 26);
      const attrCount = blob.readUInt16LE(p + 28);
      const attrs = [];
      for (let i = 0; i < attrCount; i++) {
        const at = p + 16 + attrStart + i * attrSize;
        const nsIdx = blob.readUInt32LE(at);
        const aNameIdx = blob.readUInt32LE(at + 4);
        const dataType = blob[at + 15];
        const data = blob.readUInt32LE(at + 16);
        attrs.push({
          ns: nsIdx === 0xFFFFFFFF ? '' : strings[nsIdx],
          name: strings[aNameIdx],
          type: dataType,
          // AXML 的布尔用 INT_BOOLEAN(0x12) 表示，true 是 0xFFFFFFFF（不是 1）；
          // 直接当整数比会得到 4294967295，看起来像"没设"。这里就地归一化。
          value: dataType === 0x03 ? strings[data]
            : dataType === 0x12 ? (data !== 0)
              : data,
        });
      }
      elements.push({ name: strings[nameIdx], attrs });
    }
    p += size;
  }
  return elements;
}

function el(elements, name) { return elements.filter((e) => e.name === name); }
function attr(element, name) {
  const found = element.attrs.find((a) => a.name === name);
  return found ? found.value : undefined;
}

// ── ELF 头 ──────────────────────────────────────────────────────────────────
function elfInfo(buf, label) {
  if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7F454C46) return { label, ok: false, why: '不是 ELF' };
  const machine = buf.readUInt16LE(18);
  const type = buf.readUInt16LE(16);
  const cls = buf[4];
  return {
    label, ok: machine === 0xB7 && cls === 2,
    machine: '0x' + machine.toString(16), cls, type,
    why: machine === 0xB7 ? 'AArch64' : `machine=0x${machine.toString(16)}（不是 AArch64）`,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const apk = fs.readFileSync(apkPath);
console.log(`APK: ${apkPath}  ${(apk.length / 1048576).toFixed(1)} MB  sha256=${crypto.createHash('sha256').update(apk).digest('hex').slice(0, 16)}`);

console.log('\n[1] zip 结构与对齐');
const entries = listZip(apk, 'apk');
const names = new Set(entries.map((e) => e.name));
const need = ['AndroidManifest.xml', 'resources.arsc', 'classes.dex',
  'lib/arm64-v8a/libproot.so', 'assets/payload.zip', 'assets/payload.manifest'];
for (const n of need) check(names.has(n), `存在 ${n}`);
check(!entries.some((e) => e.name.startsWith('lib/') && !e.name.startsWith('lib/arm64-v8a/')),
  '原生库只含 arm64-v8a（没有混进 x86/armeabi）',
  entries.filter((e) => e.name.startsWith('lib/')).map((e) => e.name).join(', '));
const arsc = entries.find((e) => e.name === 'resources.arsc');
check(arsc && arsc.method === 0 && arsc.dataOffset % 4 === 0,
  'resources.arsc STORED + 4 字节对齐', `method=${arsc && arsc.method} dataOff=${arsc && arsc.dataOffset}`);
for (const e of entries.filter((x) => x.name.endsWith('.so'))) {
  check(e.method === 0 && e.dataOffset % 4096 === 0,
    `${e.name} STORED + 4096 页对齐`, `method=${e.method} dataOff=${e.dataOffset}`);
}
check(!apk.includes(Buffer.from('PK\x06\x06', 'latin1')), '没有 zip64（Android 的 ZipInputStream 对它支持参差）');

console.log('\n[2] AndroidManifest.xml（自写 AXML 解析）');
const elements = parseAxml(readEntry(apk, entries.find((e) => e.name === 'AndroidManifest.xml')));
const manifest = el(elements, 'manifest')[0];
check(!!manifest, '有 <manifest>');
check(attr(manifest, 'package') === 'dev.companion.agent', `package=${attr(manifest, 'package')}`);
const usesSdk = el(elements, 'uses-sdk')[0];
check(attr(usesSdk, 'minSdkVersion') === 26, `minSdkVersion=${attr(usesSdk, 'minSdkVersion')}`);
check(attr(usesSdk, 'targetSdkVersion') === 28,
  `targetSdkVersion=${attr(usesSdk, 'targetSdkVersion')}（**故意低**：只有 legacy SELinux 域才能 execve 私有目录里的二进制）`);
const permissions = el(elements, 'uses-permission').map((e) => attr(e, 'name'));
for (const p of ['android.permission.INTERNET', 'android.permission.FOREGROUND_SERVICE',
  'android.permission.WAKE_LOCK', 'android.permission.RECEIVE_BOOT_COMPLETED']) {
  check(permissions.includes(p), `权限 ${p}`);
}
const app = el(elements, 'application')[0];
check(attr(app, 'extractNativeLibs') === true,
  `application/extractNativeLibs=${attr(app, 'extractNativeLibs')}（决定 libproot.so 会不会被解到 nativeLibraryDir）`);
check(attr(app, 'usesCleartextTraffic') === true,
  `application/usesCleartextTraffic=${attr(app, 'usesCleartextTraffic')}（targetSdk 28 下访问 127.0.0.1 必须开）`);
check(el(elements, 'activity').length === 1, `activity=${el(elements, 'activity').map((e) => attr(e, 'name')).join(',')}`);
check(el(elements, 'service').length === 1, `service=${el(elements, 'service').map((e) => attr(e, 'name')).join(',')}`);
const receiver = el(elements, 'receiver')[0];
check(!!receiver && attr(receiver, 'name').includes('BootReceiver'),
  `receiver=${receiver && attr(receiver, 'name')}（开机自启）`);

console.log('\n[3] classes.dex');
const dex = readEntry(apk, entries.find((e) => e.name === 'classes.dex'));
const dexMagic = dex.toString('latin1', 0, 8);
check(/^dex\n0\d\d\0$/.test(dexMagic), `dex magic=${JSON.stringify(dexMagic)}`);
check(dex.readUInt32LE(32) === dex.length, `dex 头声明长度=${dex.readUInt32LE(32)} 实际=${dex.length}`);
// dex 里的类名是 MUTF-8 明文，可以直接搜
const dexText = dex.toString('latin1');
for (const cls of ['Ldev/companion/agent/MainActivity;', 'Ldev/companion/agent/CompanionService;',
  'Ldev/companion/agent/BootReceiver;', 'Ldev/companion/agent/Payload;', 'Ldev/companion/agent/Proot;']) {
  check(dexText.includes(cls), `dex 含 ${cls}`);
}

console.log('\n[4] libproot.so（真机 execve 的就是它）');
const proot = readEntry(apk, entries.find((e) => e.name === 'lib/arm64-v8a/libproot.so'));
const prootElf = elfInfo(proot, 'libproot.so');
check(prootElf.ok, 'libproot.so 是 AArch64 ELF64', prootElf.why);
// PRoot 5.1+ 把 loader 直接嵌进二进制（运行时写到 PROOT_TMP_DIR）
let elfCount = 0;
for (let i = 0; i + 4 <= proot.length; i++) {
  if (proot[i] === 0x7F && proot[i + 1] === 0x45 && proot[i + 2] === 0x4C && proot[i + 3] === 0x46) elfCount++;
}
check(elfCount >= 2, `proot 里嵌入了 loader（ELF 头出现 ${elfCount} 次）→ 不需要额外文件`);

console.log('\n[5] assets/payload.zip（自带运行时的全部内容）');
const payloadZipBuf = readEntry(apk, entries.find((e) => e.name === 'assets/payload.zip'));
const payloadEntries = listZip(payloadZipBuf, 'payload.zip');
const pnames = new Map(payloadEntries.map((e) => [e.name, e]));
console.log(`   载荷条目 ${payloadEntries.length}  解压后合计 ${(payloadEntries.reduce((a, e) => a + e.usize, 0) / 1048576).toFixed(0)} MB`);
for (const n of ['usr/local/bin/node', 'opt/companion/start.sh', 'opt/companion/liblinkfix.so',
  'opt/companion/app/launcher.mjs', 'opt/companion/app/cordis.patch.yml',
  'opt/companion/app/public/index.html', 'opt/companion/app/public/papercut/version.json',
  'opt/companion/app/companion/index.js',
  'opt/companion/app/node_modules/@deepseek-ai/dsh-app-boot/package.json']) {
  check(pnames.has(n), `载荷含 ${n}`);
}
check(!payloadEntries.some((e) => e.name.startsWith('dev/') && !e.name.startsWith('dev/null')),
  '没有把设备节点塞进载荷（/dev 由 PRoot bind 覆盖）',
  payloadEntries.filter((e) => e.name.startsWith('dev/')).map((e) => e.name).slice(0, 6).join(', '));

const nodeEntry = pnames.get('usr/local/bin/node');
if (nodeEntry) {
  const head = await inflatePrefix(nodeEntry.raw(), 64);
  const nodeElf = elfInfo(head, 'node');
  check(nodeElf.ok, '载荷里的 node 是 AArch64 ELF64', nodeElf.why);
  // 版本字符串：官方 node 二进制里有 "v24.13.0"
  const bigger = await inflatePrefix(nodeEntry.raw(), 64 * 1024 * 1024);
  const versionHit = /v24\.\d+\.\d+/.exec(bigger.toString('latin1'));
  check(!!versionHit, `node 版本串 ${versionHit ? versionHit[0] : '未找到'}`);
}
const linkfixEntry = pnames.get('opt/companion/liblinkfix.so');
if (linkfixEntry) {
  const linkfixElf = elfInfo(readEntry(payloadZipBuf, linkfixEntry), 'liblinkfix.so');
  check(linkfixElf.ok, 'liblinkfix.so 是 AArch64 ELF64', linkfixElf.why);
}

console.log('\n[6] 依赖树是按 linux-arm64 解析的（踩过的坑：按宿主平台挑错预编译件）');
const NM = 'opt/companion/app/node_modules/';
const nodeModulesPaths = payloadEntries.map((e) => e.name).filter((n) => n.startsWith(NM));
// 只对"在 linux-arm64 上真的会被加载的那批"要求架构正确。
// node-pty 这类包会把 darwin/linux-x64/win32 的 prebuild 一起发出来（包本身就长这样），
// 它们在里面躺着不影响运行，不能当成"平台解析错了"。
const TARGET = /(linux-arm64|linux_arm64|linux-arm64-gnu|arm64-v8a)/;
const FOREIGN = /(darwin|win32|android|linux-x64|linux-x32|musl_arm64\/|musl-x64)/;
const natives = nodeModulesPaths.filter((n) => n.endsWith('.node'));
const targetNatives = natives.filter((n) => TARGET.test(n) || !FOREIGN.test(n));
const foreignNatives = natives.filter((n) => FOREIGN.test(n) && !TARGET.test(n));
const wrongArch = [];
for (const name of targetNatives) {
  const entry = pnames.get(name);
  const head = await inflatePrefix(entry.raw(), 64);
  const info = elfInfo(head, name);
  if (!info.ok) wrongArch.push(`${name.replace(NM, '')} (${info.why})`);
}
check(targetNatives.length > 0, `linux-arm64 目标原生扩展 ${targetNatives.length} 个`,
  targetNatives.map((n) => n.replace(NM, '')).join('  '));
check(wrongArch.length === 0, '这批原生扩展全是 AArch64 ELF', wrongArch.join('; '));
console.log(`   ℹ️  另有 ${foreignNatives.length} 个其它平台的 prebuild 随包发出（node-pty 等，
      包结构如此，运行时按 platform 取 linux-arm64 那份，不影响）`);

// 关键：按平台选择的 optionalDependencies 必须落在 linux-arm64(-gnu) 上，
// 而且不能出现 win32/darwin/android 的兄弟包。这是"按宿主平台挑错件"的直接判据。
//
// 判据要写成 `<名字>-<os>-<arch>[-<libc>]` 这种**平台后缀包**的形状：
// 像 @deepseek-ai/dsh-win32-process 这种"名字里带 win32、但本身是跨平台库的常规依赖"
// 不该被误判（它提供 win32 实现，在 linux 上只是不会被加载）。
const PLATFORM_PKG = /-(linux|win32|darwin|android|freebsd)-(x64|arm64|ia32|arm|universal)(-|$)/;
const pkgDirs = new Set(nodeModulesPaths
  .map((n) => n.replace(NM, '').split('/'))
  .filter((parts) => parts[0])
  .map((parts) => (parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0])));
const platformPkgs = [...pkgDirs].filter((p) => PLATFORM_PKG.test(p));
const wrongPlatform = platformPkgs.filter((p) => /-(win32|darwin|android|freebsd)-/.test(p));
const linuxPkgs = platformPkgs.filter((p) => /-linux-/.test(p));
check(wrongPlatform.length === 0, '没有任何 win32/darwin/android 平台专属包被装上',
  wrongPlatform.join(', ') || '（干净）');
check(linuxPkgs.some((p) => /linux-arm64/.test(p)), '平台专属包装的是 linux-arm64 那份',
  linuxPkgs.join('  '));
const windowsOnlyLibs = [...pkgDirs].filter((p) => /-(win32|windows)-/.test(p) && !PLATFORM_PKG.test(p));
if (windowsOnlyLibs.length) {
  console.log(`   ℹ️  闭包里还有 ${windowsOnlyLibs.length} 个"名字带 win32 的跨平台库"（正常，如 ${windowsOnlyLibs.slice(0, 3).join(', ')}）`);
}
// 会话落盘要用的 flock 就是这两个包提供的（glibc 分支）
for (const need of ['@deepseek-ai/node-addon-system-linux-arm64', 'node-addon-require-builtin-linux-arm64-gnu']) {
  check(pkgDirs.has(need) || [...pkgDirs].some((p) => p === need), `关键平台包 ${need}`);
  const hit = targetNatives.filter((n) => n.includes(need));
  check(hit.length > 0, `${need} 里的 .node`, hit.map((n) => n.replace(NM, '')).join(' '));
}

console.log('\n[7] assets/payload.manifest（权限位与符号链接的载体）');
const manifestText = readEntry(apk, entries.find((e) => e.name === 'assets/payload.manifest')).toString('utf8');
const lines = manifestText.split('\n').filter(Boolean);
console.log(`   清单 ${lines.length} 行`);
const links = new Map();
for (const line of lines) {
  const parts = line.split('\t');
  if (parts.length >= 3) links.set(parts[1], parts[2]);
}
check(links.get('bin') === 'usr/bin', `usrmerge 软链 bin → ${links.get('bin')}（**这正是"整个 /bin 没进载荷"的那个坑**）`);
check(links.get('lib') === 'usr/lib', `lib → ${links.get('lib')}`);
check(links.get('usr/bin/sh') !== undefined || lines.some((l) => l.includes('usr/bin/dash')),
  '有 /bin/sh 的落点（dash）');
for (const n of ['usr/local/bin/node', 'opt/companion/start.sh', 'opt/companion/app/launcher.mjs']) {
  check(lines.some((l) => l.endsWith('\t' + n)), `清单含 ${n}`);
}

console.log('\n=== 结果 ===');
if (failures === 0) {
  console.log('✅ 全部静态校验通过。');
  console.log('   ⚠️  本机没有安卓设备/模拟器，"能装能跑"这一层**未验证** —— 见 README-安卓APK.md 的"未验证清单"。');
} else {
  console.log(`❌ ${failures} 项未通过。`);
}
process.exit(failures === 0 ? 0 : 1);

// 把 aapt2 link 产出的 base.apk + classes.dex + 原生库 + assets 合成一个未签名 APK。
//
// 用法：
//   node lib/pack-apk.mjs <base.apk> <out-unsigned.apk> <spec.json>
//
// spec.json:
//   { "entries": [ { "name": "classes.dex", "from": "…/classes.dex" },
//                  { "name": "lib/arm64-v8a/libproot.so", "from": "…", "store": true, "alignment": 4096 } ] }
//
// base.apk 里的条目（AndroidManifest.xml / resources.arsc / res/**）原样搬过来，
// 其中 resources.arsc 强制 STORED + 4 字节对齐 —— Android 11+ 的硬要求。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { writeZip, readLayout } from './zipwrite.mjs';

const [baseApk, outApk, specPath] = process.argv.slice(2);
if (!baseApk || !outApk || !specPath) {
  console.error('用法: node lib/pack-apk.mjs <base.apk> <out.apk> <spec.json>');
  process.exit(2);
}

/** 从一个已存在的 zip 里取出每个条目的原始（解压后）内容。 */
function slurp(file) {
  const blob = fs.readFileSync(file);
  const entries = [];
  let eocd = -1;
  for (let i = blob.length - 22; i >= 0; i--) {
    if (blob.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD: ' + file);
  const count = blob.readUInt16LE(eocd + 10);
  let p = blob.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = blob.readUInt16LE(p + 10);
    const csize = blob.readUInt32LE(p + 20);
    const usize = blob.readUInt32LE(p + 24);
    const nameLen = blob.readUInt16LE(p + 28);
    const extraLen = blob.readUInt16LE(p + 30);
    const cmtLen = blob.readUInt16LE(p + 32);
    const localOffset = blob.readUInt32LE(p + 42);
    const name = blob.toString('utf8', p + 46, p + 46 + nameLen);
    const lNameLen = blob.readUInt16LE(localOffset + 26);
    const lExtraLen = blob.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
    const raw = blob.subarray(dataOffset, dataOffset + csize);
    let content;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      content = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`不支持的压缩方法 ${method}（${name}）`);
    }
    if (content.length !== usize) {
      throw new Error(`大小不符 ${name}: ${content.length} != ${usize}`);
    }
    entries.push({ name, content });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

const entries = [];

// 1) aapt2 的产物：资源与清单。resources.arsc 不压缩且 4 字节对齐。
for (const item of slurp(baseApk)) {
  if (item.name === 'resources.arsc') {
    entries.push({ name: item.name, data: item.content, store: true, alignment: 4 });
  } else {
    entries.push({ name: item.name, data: item.content });
  }
}

// 2) 追加条目
// 容忍 UTF-8 BOM：PowerShell 的 Set-Content -Encoding UTF8 在旧版本上会写 BOM，
// 而 JSON.parse 碰到 BOM 会直接抛。
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
for (const item of spec.entries) {
  if (!fs.existsSync(item.from)) {
    throw new Error(`缺少 ${item.from}（spec 里的 ${item.name}）`);
  }
  entries.push({
    name: item.name,
    data: fs.readFileSync(item.from),
    store: item.store === true,
    // 不写死 1：留 undefined 让 zipwrite 用它的默认值（STORED → 至少 4 字节对齐）
    alignment: item.alignment,
  });
}

entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
writeZip(outApk, entries);

// 3) 立刻按本地头复读一遍布局，断言对齐（用数据偏移，不是本地头偏移）
const layout = readLayout(outApk);
let bad = 0;
for (const item of layout) {
  // STORED 条目至少要 4 字节对齐（zipalign 的判据）；.so 加到 4096
  const want = item.name === 'resources.arsc' ? 4
    : item.name.endsWith('.so') ? 4096
      : item.method === 'store' ? 4 : 1;
  const ok = item.dataOffset % want === 0;
  if (!ok) bad++;
  if (!ok || want > 1) {
    console.log(`  ${ok ? '✅' : '❌'} ${item.name.padEnd(34)} ${item.method.padEnd(8)} ` +
      `dataOff=${item.dataOffset} align=${want} ${item.usize} 字节`);
  }
}
if (bad > 0) {
  console.error(`❌ ${bad} 个条目的数据偏移未对齐`);
  process.exit(1);
}
console.log(`  ${layout.length} 个条目，对齐全部通过 ✅  总大小 ${(fs.statSync(outApk).size / 1048576).toFixed(1)} MB`);

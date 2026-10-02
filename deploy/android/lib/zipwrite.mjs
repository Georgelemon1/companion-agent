// 最小但"对齐正确"的 zip 写入器 —— 只服务于一个目的：手写 APK 包。
//
// 为什么不用现成的 zip 库：APK 对 zip 布局有两个硬要求，通用库不提供控制
//   ① resources.arsc 必须 **STORED（不压缩）+ 4 字节对齐**（否则 Android 11+ 拒装）；
//   ② .so 必须 **页对齐（4096）**（extractNativeLibs=true 时非必需，但两种模式都能用）。
//
// 对齐是怎么做到的（这里错过一次就会自己打脸）：
//   读 zip 的人是这样算数据起点的 —— dataOffset = localHeaderOffset + 30 + nameLen + extraLen。
//   所以"填充"不能是塞在本地头和内容之间的裸字节（那样 dataOffset 的算法就对不上，
//   内容会错位），必须写成**本地头里的 extra field**。
//   这里用 Android 自己那套填充字段：id=0xD935（zipalign 用的就是它），
//   长度字段是"剩余填充字节数"，总长 = 4 + padding。
//
// 校验用「数据偏移」而不是「本地头偏移」—— 这是唯一有意义的判据。
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** 固定时间戳：让同样的输入产出同样的字节（可复现构建）。 */
const DOS_TIME = 0;          // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;  // 2026-01-01

/**
 * @param {string} outPath
 * @param {Array<{name:string, data:Buffer, store?:boolean, alignment?:number, externalAttrs?:number}>} entries
 * @returns {Array<{name:string, offset:number, size:number, alignment:number}>} 便于外部断言
 */
export function writeZip(outPath, entries) {
  const fd = fs.openSync(outPath, 'w');
  const central = [];
  const layout = [];
  let offset = 0;

  const writeAt = (buf) => { fs.writeSync(fd, buf, 0, buf.length, offset); offset += buf.length; };

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const store = entry.store === true;
    const payload = store ? raw : zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    // 未压缩（STORED）的条目**一律**至少 4 字节对齐：这是 zipalign 的硬要求，
    // 而 zipalign 的判据只看 STORED 条目。这里踩过一次 —— 早先只有 resources.arsc 和 .so
    // 显式给了对齐，assets/payload.zip 靠字节数凑巧对齐才通过；载荷一小，它立刻错位、
    // `zipalign -c` 报 Verification FAILED。所以默认值必须写死在这里，不能靠运气。
    const alignment = entry.alignment || (store ? 4 : 1);

    // 求出让数据起点对齐所需的 extra 长度：extraLen 只能是 0，或 >= 4（id+len 两个字段）
    const base = offset + 30 + nameBuf.length;
    let extraLen = 0;
    if (alignment > 1 && base % alignment !== 0) {
      const need = (alignment - (base % alignment)) % alignment;
      extraLen = need >= 4 ? need : need + alignment;
      if ((base + extraLen) % alignment !== 0) {
        throw new Error(`内部错误：无法为 ${entry.name} 求出对齐填充（base=${base} need=${need}）`);
      }
    }
    const extra = Buffer.alloc(extraLen);
    if (extraLen >= 4) {
      extra.writeUInt16LE(0xD935, 0);          // Android 对齐填充字段
      extra.writeUInt16LE(extraLen - 4, 2);    // 该字段的载荷长度
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                // version needed
    local.writeUInt16LE(0x0800, 6);            // flags: UTF-8 文件名
    local.writeUInt16LE(store ? 0 : 8, 8);     // 压缩方法
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(extraLen, 28);

    const localHeaderOffset = offset;
    const dataOffset = offset + 30 + nameBuf.length + extraLen;
    if (dataOffset % alignment !== 0) {
      throw new Error(`对齐失败 ${entry.name}: 数据偏移 ${dataOffset} 不是 ${alignment} 的倍数`);
    }
    if (raw.length > 0xFFFFFFFF || payload.length > 0xFFFFFFFF || dataOffset > 0xFFFFFFFF) {
      throw new Error(`条目超出非 zip64 上限: ${entry.name}`);
    }

    writeAt(local);
    writeAt(nameBuf);
    writeAt(extra);
    writeAt(payload);

    central.push({ nameBuf, crc, csize: payload.length, usize: raw.length, store, offset: localHeaderOffset, externalAttrs: entry.externalAttrs });
    layout.push({ name: entry.name, offset: dataOffset, size: raw.length, alignment, method: store ? 'store' : 'deflate' });
  }

  const cdStart = offset;
  for (const item of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);                 // version made by
    head.writeUInt16LE(20, 6);                 // version needed
    head.writeUInt16LE(0x0800, 8);             // flags
    head.writeUInt16LE(item.store ? 0 : 8, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(item.crc, 16);
    head.writeUInt32LE(item.csize, 20);
    head.writeUInt32LE(item.usize, 24);
    head.writeUInt16LE(item.nameBuf.length, 28);
    head.writeUInt16LE(0, 30);                 // extra len
    head.writeUInt16LE(0, 32);                 // comment len
    head.writeUInt16LE(0, 34);                 // disk
    head.writeUInt16LE(0, 36);                 // internal attrs
    head.writeUInt32LE(item.externalAttrs === undefined ? 0 : item.externalAttrs, 38);
    head.writeUInt32LE(item.offset, 42);
    writeAt(head);
    writeAt(item.nameBuf);
  }
  const cdSize = offset - cdStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  writeAt(eocd);
  fs.closeSync(fd);
  return layout;
}

/** 复读一个 zip 的布局（校验用，纯读本地头，不信任我们自己的返回值）。 */
export function readLayout(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD');
  if (eocd + 22 !== buf.length && buf.readUInt16LE(eocd + 20) !== 0) throw new Error('EOCD 有注释，未预期');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录签名错误 @' + p);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('本地头签名错误 for ' + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    out.push({
      name, method: method === 0 ? 'store' : 'deflate', csize, usize,
      dataOffset: localOffset + 30 + lNameLen + lExtraLen, localOffset,
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// 给 tar 包里的指定文件**写死可执行权限位**（0755），再 gzip 成 .tar.gz
//
// 为什么需要：本机是 Windows，bsdtar 打的包里所有文件都是 0644；
// 而 macOS 上 `启动.command` 没有执行位就**双击不了**（Finder 会说"无法打开"）。
// WSL 没装发行版、也没有别的 POSIX 层可以设权限，所以直接改 tar 头：
//   tar 的每个条目头是 512 字节，mode 在偏移 100、长度 8（八进制 ASCII），
//   改完必须重算偏移 148 处的 8 字节校验和（先当空白，再按无符号字节求和）。
//
// 用法: node fix-tar-mode.mjs <输入.tar> <输出.tar.gz> <需要 0755 的文件名> [更多文件名...]
import { readFileSync, writeFileSync, createReadStream } from 'node:fs'
import { gzipSync } from 'node:zlib'

const [src, dst, ...execNames] = process.argv.slice(2)
if (src === undefined || dst === undefined || execNames.length === 0) {
  throw new Error('用法: node fix-tar-mode.mjs <in.tar> <out.tar.gz> <文件名...>')
}

const buf = readFileSync(src)
const startOffset = (h) => Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
const sizeOf = (h) => Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
const nameOf = (h) => {
  const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
  const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
  return prefix === '' ? name : `${prefix}/${name}`
}

/** 重算校验和（偏移 148，8 字节；计算时该字段按 8 个空格处理） */
function fixChecksum(header) {
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const b of header) sum += b
  const oct = sum.toString(8).padStart(6, '0')
  header.write(oct, 148, 6, 'ascii')
  header[154] = 0
  header[155] = 0x20
}

let pos = 0
let patched = 0
const seen = []
const isRegularFile = (type) => type === '0' || type === '\0' || type === ''
const matches = (name, want) => name === want || name.endsWith(`/${want}`)
while (pos + 512 <= buf.length) {
  const header = buf.subarray(pos, pos + 512)
  if (header.every((b) => b === 0)) break               // 归档结束
  const name = nameOf(header)
  const size = sizeOf(header)
  const type = String.fromCharCode(header[156])
  seen.push({ name, type })
  // 归档里的条目名带顶层目录前缀（companion-agent-mac-arm64/启动.command），
  // 所以按"末尾路径段"匹配（踩过：裸名全等导致 0 个被改写）。
  // 另外**只改常规文件**：bsdtar 给中文名会额外写一条 PAX 扩展头
  // （PaxHeader/启动.command，type='x'），它不该被算进"改写了几项"——
  // 踩过：把它算进去会让"期望 2 个、实际 3 个"的严格等值校验误报失败。
  if (isRegularFile(type) && execNames.some((w) => matches(name, w))) {
    header.fill(0x20, 100, 108)
    header.write('0000755', 100, 7, 'ascii')
    header[107] = 0
    fixChecksum(header)
    patched += 1
  }
  pos += 512 + Math.ceil(size / 512) * 512
}

writeFileSync(dst, gzipSync(buf, { level: 6 }))
console.log(`  条目 ${seen.length} 个，改写权限 ${patched} 个 -> ${dst}`)

// 判定标准：每个目标都要有一条**常规文件**条目、且已设成 0755。
// 不用"改写总数 == 目标数"这种等值校验 —— PAX 头、重复条目都会让它误报。
let missing = 0
for (const w of execNames) {
  const hit = seen.find((s) => matches(s.name, w) && isRegularFile(s.type))
  if (hit) console.log(`  ✅ ${w}（常规文件条目在档）`)
  else { console.log(`  ❌ ${w} 没有常规文件条目`); missing += 1 }
}
if (missing > 0) process.exit(1)

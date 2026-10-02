// 校验 .tar.gz 里指定文件的权限位（读 tar 头，不信打包器的自述）
//
// 用法: node verify-tar-mode.mjs <文件.tar.gz> [期望 0755 的路径片段...]
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'

const [src, ...wants] = process.argv.slice(2)
if (src === undefined) throw new Error('用法: node verify-tar-mode.mjs <文件.tar.gz> [路径片段...]')

const buf = gunzipSync(readFileSync(src))
const nameOf = (h) => {
  const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
  const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
  return prefix === '' ? name : `${prefix}/${name}`
}
const sizeOf = (h) => Number.parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8)
const modeOf = (h) => h.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim()
const typeOf = (h) => String.fromCharCode(h[156])

let pos = 0
let entries = 0
const hits = []
while (pos + 512 <= buf.length) {
  const h = buf.subarray(pos, pos + 512)
  if (h.every((b) => b === 0)) break
  entries += 1
  const name = nameOf(h)
  const type = typeOf(h)
  if (wants.some((w) => name === w || name.endsWith(`/${w}`))) {
    // type：'0'/'\0' = 常规文件，'5' = 目录，'x' = PAX 扩展头（bsdtar 为中文名写的，不是真文件）
    const kind = type === '5' ? 'dir' : (type === '0' || type === '\0' || type === '' ? 'file' : `type${type}`)
    hits.push({ name, type: kind, rawType: type, mode: modeOf(h), size: sizeOf(h) })
  }
  pos += 512 + Math.ceil(sizeOf(h) / 512) * 512
}

console.log(`  归档 ${src}`)
console.log(`  条目总数 ${entries}`)
console.log(`  匹配 ${hits.length} 条：`)
for (const h of hits) {
  const perm = h.type === 'file'
    ? (/[1357]$/.test(h.mode) ? '可执行 ✅' : '不可执行 ❌')
    : '（非常规文件，权限无意义）'
  console.log(`    ${h.type.padEnd(6)} mode=${h.mode.padEnd(8)} ${h.size.toString().padStart(9)} B  ${h.name}  ${perm}`)
}
const need = wants.filter((w) => !hits.some((h) => (h.name === w || h.name.endsWith(`/${w}`)) && h.type === 'file' && /[1357]$/.test(h.mode)))
if (need.length > 0) {
  console.log(`  ❌ 这些没拿到可执行位：${need.join(', ')}`)
  process.exit(1)
}
console.log('  ✅ 需要可执行的文件都拿到了 0755')

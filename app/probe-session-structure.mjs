// 探查会话数据源的真实结构（字段名、层级），为抓"模型原始返回"铺路
// 用法：node app/probe-session-structure.mjs

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SID = 'session-def831ed-d70e-4df7-9135-e34303bb904c'

console.log('═══ ① state/sessions 目录树 ═══')
const root = 'state/sessions'
function walk(dir, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    const pad = '  '.repeat(depth + 1)
    if (e.isDirectory()) {
      console.log(`${pad}📁 ${e.name}/`)
      walk(p, depth + 1, maxDepth)
    } else {
      console.log(`${pad}📄 ${e.name}  ${(statSync(p).size / 1024).toFixed(1)} KB`)
    }
  }
}
if (existsSync(root)) walk(root)

console.log('\n═══ ② DSH 会话日志顶层结构 ═══')
const log = `C:\\Users\\PC\\.dsh\\storages\\session_projcache\\sessions\\${SID}.json`
if (!existsSync(log)) { console.log(`  ❌ 不存在: ${log}`); process.exit(1) }
const json = JSON.parse(readFileSync(log, 'utf8'))

/** 打印对象的键与类型（不展开大数组）。 */
function shape(node, name, depth = 0, maxDepth = 3) {
  const pad = '  '.repeat(depth + 1)
  if (node === null || typeof node !== 'object') {
    const v = typeof node === 'string' ? JSON.stringify(node.slice(0, 60)) : String(node)
    console.log(`${pad}${name}: ${typeof node} = ${v}`)
    return
  }
  if (Array.isArray(node)) {
    console.log(`${pad}${name}: Array(${node.length})`)
    if (node.length > 0 && depth < maxDepth) shape(node[0], '[0]', depth + 1, maxDepth)
    return
  }
  console.log(`${pad}${name}: Object{${Object.keys(node).slice(0, 14).join(', ')}}`)
  if (depth < maxDepth) {
    for (const k of Object.keys(node).slice(0, 10)) shape(node[k], k, depth + 1, maxDepth)
  }
}
shape(json, '(顶层)', 0, 3)

// 找所有出现过 "role" 或 "content" 的路径
console.log('\n═══ ③ 含 role / content 的路径（前 25 个）═══')
const hits = []
function scan(node, path, depth = 0) {
  if (depth > 10 || hits.length > 400) return
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) { node.slice(0, 40).forEach((x, i) => scan(x, `${path}[${i}]`, depth + 1)); return }
  for (const [k, v] of Object.entries(node)) {
    const np = path === '' ? k : `${path}.${k}`
    if (k === 'role' || k === 'content') hits.push(`${np}  =  ${typeof v === 'string' ? JSON.stringify(v.slice(0, 70)) : (Array.isArray(v) ? `Array(${v.length})` : typeof v)}`)
    scan(v, np, depth + 1)
  }
}
scan(json, '', 0)
for (const h of hits.slice(0, 25)) console.log(`  ${h}`)
console.log(`  ... 共 ${hits.length} 处`)

// 找含 [em: 的原始文本
console.log('\n═══ ④ 全文搜索 "[em:"（模型原始标记）═══')
const raw = readFileSync(log, 'utf8')
const idxs = []
let from = 0
while (true) {
  const i = raw.indexOf('[em:', from)
  if (i < 0) break
  idxs.push(i)
  from = i + 1
}
console.log(`  出现 ${idxs.length} 次`)
for (const i of idxs.slice(0, 3)) {
  console.log(`  ── 位置 ${i} 附近 ──`)
  console.log('  ' + raw.slice(Math.max(0, i - 160), i + 260).replace(/\\n/g, ' ⏎ ').replace(/\\"/g, '"'))
}

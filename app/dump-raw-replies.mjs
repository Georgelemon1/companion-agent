// 导出模型原始返回（含 [em:] 标记的原文）
//
// 数据结构（实测）：
//   events: type === 'assistant/message'
//     data.turn / data.step
//     data.message.content[]  —— 块数组，block.type === 'text' 是正式回复；'reasoning' 是思考
//     data.message.source     —— { kind:'model', provider, model }
//     data.usage              —— inputTokens / outputTokens / reasoningTokens
//     data.stream[]            —— 逐块到达时间（用于诊断"是不是真流式"）
//
// 为什么要分开"正式回复"与"思考"：模型在**思考里也会写 [em:] 草稿**，
// 混在一起会误判成"标记泄漏"。出站只取 content 里的 text 块。
//
// 用法：
//   node app/dump-raw-replies.mjs           最近 5 条正式回复
//   node app/dump-raw-replies.mjs 12        最近 12 条
//   node app/dump-raw-replies.mjs 5 --full  同时打印思考
//   node app/dump-raw-replies.mjs 0 --stats 统计

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const args = process.argv.slice(2)
const LIMIT = Number(args.find((a) => /^\d+$/.test(a)) ?? 5)
const FULL = args.includes('--full')
const STATS = args.includes('--stats')

function findLog() {
  const root = 'state/sessions'
  const out = []
  for (const cwdDir of readdirSync(root)) {
    const p1 = join(root, cwdDir)
    if (!statSync(p1).isDirectory()) continue
    for (const sidDir of readdirSync(p1)) {
      const p2 = join(p1, sidDir)
      if (!statSync(p2).isDirectory()) continue
      for (const f of readdirSync(p2)) {
        if (f.endsWith('.jsonl.zstd')) out.push({ path: join(p2, f), size: statSync(join(p2, f)).size })
      }
    }
  }
  out.sort((a, b) => b.size - a.size)
  return out[0] ?? null
}

/** 多帧 zstd：按魔数切帧逐个解压。 */
function readLogText(path) {
  const buf = readFileSync(path)
  const M = [0x28, 0xb5, 0x2f, 0xfd]
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) offsets.push(i)
  }
  let text = ''
  for (const [i, off] of offsets.entries()) {
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length
    try { text += zstdDecompressSync(buf.subarray(off, end)).toString('utf8') } catch { /* 坏帧 */ }
  }
  return { text, frames: offsets.length }
}

const log = findLog()
const { text, frames } = readLogText(log.path)
const events = text.split('\n').filter((l) => l.trim() !== '')
  .map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const rows = []
for (const e of events) {
  if (e.type !== 'assistant/message') continue
  const content = e.data?.message?.content ?? []
  let reply = ''
  let reasoning = ''
  for (const b of content) {
    const t = typeof b === 'string' ? b : (b?.text ?? '')
    if (/reason/i.test(b?.type ?? '')) reasoning += t
    else reply += t
  }
  rows.push({
    turn: e.data?.turn ?? null,
    step: e.data?.step ?? null,
    at: e.time ?? null,
    model: e.data?.message?.source?.model ?? '?',
    provider: e.data?.message?.source?.provider ?? '?',
    outTokens: e.data?.usage?.outputTokens ?? null,
    reasoningTokens: e.data?.usage?.reasoningTokens ?? null,
    reply: reply.trim(),
    reasoning: reasoning.trim(),
  })
}

console.log(`数据源  ${log.path}`)
console.log(`        ${(log.size / 1024).toFixed(1)} KB 压缩 → ${frames} 帧 → ${(text.length / 1024).toFixed(0)} KB`)
console.log(`模型    ${rows[0]?.provider ?? '?'} / ${rows[0]?.model ?? '?'}`)
console.log(`共 ${rows.length} 条 assistant/message\n`)

if (STATS) {
  const withMark = rows.filter((r) => /\[em:/.test(r.reply)).length
  const reasonWithMark = rows.filter((r) => /\[em:/.test(r.reasoning)).length
  const hasReason = rows.filter((r) => r.reasoning !== '').length
  console.log('=== 统计 ===')
  console.log(`  正式回复含 [em: 标记      ${withMark} / ${rows.length}`)
  console.log(`  思考里含 [em:（草稿）     ${reasonWithMark} / ${rows.length}`)
  console.log(`  有思考内容的              ${hasReason} / ${rows.length}`)
  console.log(`  回复长度  最短 ${Math.min(...rows.map((r) => r.reply.length))}  最长 ${Math.max(...rows.map((r) => r.reply.length))}`)
  console.log('\n=== 各条的标记数 ===')
  for (const r of rows) {
    const n = (r.reply.match(/\[em:[a-z]+:\d+\]/g) ?? []).length
    const labels = [...r.reply.matchAll(/\[em:([a-z]+):(\d+)\]/g)].map((m) => `${m[1]}@${m[2]}`).join(' ')
    console.log(`  turn ${String(r.turn).padStart(3)}  step ${r.step}  ${String(r.reply.length).padStart(4)} 字符  ${String(n).padStart(2)} 个标记  ${labels}`)
  }
  process.exit(0)
}

const tail = rows.slice(-LIMIT)
console.log('═'.repeat(76))
if (LIMIT > 0) console.log(`最近 ${tail.length} 条（模型原文，含 [em:] 标记）`)
console.log('═'.repeat(76))

for (const r of tail) {
  const labels = [...r.reply.matchAll(/\[em:([a-z]+):(\d+)\]/g)].map((m) => `${m[1]}@${m[2]}`).join('  ')
  console.log(`\n▶ turn ${r.turn} step ${r.step}   ${new Date(r.at).toLocaleString('zh-CN')}`)
  console.log(`  out=${r.outTokens} tok  reasoning=${r.reasoningTokens} tok   ${r.reply.length} 字符   标记: ${labels || '(无)'}`)
  if (FULL && r.reasoning !== '') {
    console.log('  ┌─ 思考 ─────────────────────────────────────────')
    for (const l of r.reasoning.split('\n')) console.log('  │ ' + l)
  }
  console.log('  ┌─ 正式回复 ─────────────────────────────────────')
  for (const l of r.reply.split('\n')) console.log('  │ ' + l)
  console.log('  └' + '─'.repeat(50))
}

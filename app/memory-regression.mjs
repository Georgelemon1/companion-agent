// P5-B 记忆命中率回归 —— 测"她能不能想起相关的事"。
//
// 为什么需要：记忆层此前只验证过"卡片有没有写进去"，从没验证过
// **召回准不准**。而"记得你说过的小事"是这个角色的核心承诺之一。
//
// 语料里的提问刻意用**换一种说法**（用户不会原样重复），这才是真实召回场景。
// 全部离线：不调模型、不起应用。
// 用法：node app/memory-regression.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompanionState } from './companion/state.js'
import { extractFacts } from './companion/memory.js'

let pass = 0
let fail = 0
const notes = []
const report = (line) => { notes.push(line); console.log(`     ${line}`) }
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`) }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'memory-regression-'))
const state = new CompanionState(join(dir, 'test.db'))

// ── 建立记忆：用户分几轮讲了自己的事 ──────────────────────────────────────
/** 每条是 [用户原话, 期望被抽出的关键片段]。 */
const LEARNING = [
  ['我叫阿哲，今年 28 岁，住在杭州', '阿哲'],
  ['我养了一只猫叫豆豆，还有只狗叫旺财', '豆豆'],
  ['我最喜欢 Radiohead，也爱听坂本龙一', 'Radiohead'],
  ['我讨厌早起，早上永远起不来', '早起'],
  ['我妈总说我太要强了', '妈'],
  ['下周要去面试，是一家做机器人的公司', '面试'],
  ['我打算下个月去冰岛看极光', '冰岛'],
  ['我最近一直睡不好，压力挺大的', '睡不好'],
]

console.log('\n【① 学习阶段：卡片是否被正确抽出】')
let cardCount = 0
for (const [text] of LEARNING) {
  const facts = extractFacts([text])
  for (const fact of facts) {
    if (state.remember(fact) !== undefined) cardCount += 1
  }
}
report(`从 ${LEARNING.length} 句话里抽出 ${cardCount} 张卡片（去重后）`)
const allCards = state.listMemories(100)
report(`库内卡片 ${allCards.length} 张：`)
for (const card of allCards.slice(0, 12)) {
  report(`  [${card.importance}] ${card.subject}: ${card.content}`)
}
check('抽出了卡片', allCards.length >= 8, `${allCards.length} 张`)
check('卡片内容不含说话人标签污染', !allCards.some((c) => c.content.includes('用户：')))

// ── 召回测试：换一种说法提问，看能不能捞回正确的卡片 ──────────────────────
console.log('\n【② 召回：换种说法提问（真实场景）】')
/** [提问（换过说法）, 期望召回卡片里应含的关键词] */
const RECALL_CASES = [
  ['我最近又在听 Radiohead 了', 'Radiohead'],
  ['豆豆最近怎么样来着', '豆豆'],
  ['面试准备得还行吧', '面试'],
  ['极光那趟旅行', '冰岛'],
  ['我最近还是睡不好', '睡不好'],
  ['早起真的好痛苦', '早起'],
  ['我妈又念叨我了', '妈'],
  ['我叫什么来着', '阿哲'],
]

let hits = 0
let recalledTotal = 0
const misses = []
for (const [query, expected] of RECALL_CASES) {
  const got = state.recallMemories(query, 3)
  recalledTotal += got.length
  const hit = got.some((card) => card.content.includes(expected))
  if (hit) hits += 1
  else misses.push(`「${query}」期望含「${expected}」，实际召回：${got.map((c) => c.content).join(' | ') || '（空）'}`)
}
const recallRate = hits / RECALL_CASES.length
report(`召回命中：${hits}/${RECALL_CASES.length} = ${(recallRate * 100).toFixed(0)}%`)
report(`平均每次召回条数：${(recalledTotal / RECALL_CASES.length).toFixed(1)}`)
if (misses.length > 0) {
  console.log('     漏掉的：')
  for (const m of misses) console.log(`       · ${m}`)
}
check('召回命中率 ≥ 75%', recallRate >= 0.75, `${(recallRate * 100).toFixed(0)}%`)

// ── 精确率：召回里不该塞满无关卡片 ────────────────────────────────────────
console.log('\n【③ 精确率：召回结果里无关卡片的比例】')
let relevant = 0
let total = 0
for (const [query, expected] of RECALL_CASES) {
  for (const card of state.recallMemories(query, 3)) {
    total += 1
    if (card.content.includes(expected)) relevant += 1
  }
}
const precision = total === 0 ? 0 : relevant / total
report(`首条命中率（Top-1 是否相关）：${
  RECALL_CASES.filter(([q, e]) => (state.recallMemories(q, 1)[0]?.content ?? '').includes(e)).length
}/${RECALL_CASES.length}`)
check('召回结果里相关卡片占比 ≥ 25%', precision >= 0.25, `${(precision * 100).toFixed(0)}%（共 ${total} 条）`)

// ── 主动候选：该提重要且久未提的，避开刚提过的 ────────────────────────────
console.log('\n【④ 主动候选：选题逻辑】')
const candidates = state.proactiveMemoryCandidates({ limit: 10 })
report(`候选 ${candidates.length} 张，前 5：`)
for (const card of candidates.slice(0, 5)) {
  report(`  score=${card.score} [${card.importance}] ${card.content}`)
}
check('有候选可选', candidates.length > 0, `${candidates.length} 张`)
check('候选按分数降序', candidates.every((c, i) => i === 0 || c.score <= candidates[i - 1].score))
check('候选都是够重要的（≥5）', candidates.every((c) => c.importance >= 5))

// 标记一张为"已提过"，它应在 72 小时内不再出现在候选里
const target = candidates[0]
state.markMemoryTold(target.id)
const afterTold = state.proactiveMemoryCandidates({ limit: 10 })
const stillThere = afterTold.some((c) => c.id === target.id)
check('刚提过的卡片被排除出候选（72h 冷却）', !stillThere, `「${target.content}」${stillThere ? '仍在候选' : '已排除'}`)

// ── 去重：同一件事说两遍，不该出现两张卡 ──────────────────────────────────
console.log('\n【⑤ 去重与提及计数】')
const before = state.listMemories(100).length
state.remember(extractFacts(['我养了一只猫叫豆豆'])[0])
const after = state.listMemories(100).length
const doudou = state.listMemories(100).find((c) => c.content.includes('豆豆'))
check('重复提及不产生新卡片', after === before, `${before} → ${after}`)
check('提及次数被累加', (doudou?.mentions ?? 0) >= 2, `mentions=${doudou?.mentions}`)

state.close()
rmSync(dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log('\n关键观测量（用于调参）：')
for (const line of notes) console.log(`  · ${line}`)
process.exitCode = fail === 0 ? 0 : 1

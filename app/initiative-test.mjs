// 主动性决策的单元测试 —— 不起应用，直接验门逻辑与动机分。
// 用法：node app/initiative-test.mjs
import {
  checkGates, decide, inQuietHours, scoreMotivation, renderInitiativePrompt,
} from './companion/initiative.js'

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass += 1; console.log(`  ✅ ${label}`) } else { fail += 1; console.log(`  ❌ ${label}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`) }
}

/** 构造一个本地时间，避免测试受机器时区影响。 */
const at = (hh, mm = 0) => new Date(2026, 8, 13, hh, mm, 0)

console.log('\n【静默时段】')
check('22:00 不在 23:00-08:00 内', inQuietHours(at(22), ['23:00', '08:00']), false)
check('23:30 在内', inQuietHours(at(23, 30), ['23:00', '08:00']), true)
check('02:00 在内（跨零点）', inQuietHours(at(2), ['23:00', '08:00']), true)
check('07:59 在内', inQuietHours(at(7, 59), ['23:00', '08:00']), true)
check('08:00 已出静默', inQuietHours(at(8), ['23:00', '08:00']), false)
check('同日区间 13:00-14:00 命中', inQuietHours(at(13, 30), ['13:00', '14:00']), true)
check('start==end 视为无静默', inQuietHours(at(13, 30), ['13:00', '13:00']), false)

console.log('\n【预算门】')
const baseGate = {
  now: at(15),
  config: { dailyCap: 3, minCooldownMinutes: 90, missBackoffFactor: 3, idleThresholdHours: 8, respectQuietHours: true, quietHours: ['23:00', '08:00'] },
  state: { sentToday: 0, missStreak: 0, lastSentAt: undefined, lastUserAt: at(15).getTime() - 9 * 3_600_000, agentBusy: false },
}
check('空闲 9h、配额充足 → 放行', checkGates(baseGate).allowed, true)
check('agent 忙 → 拒绝', checkGates({ ...baseGate, state: { ...baseGate.state, agentBusy: true } }).reason, 'agent-busy')
check('配额用尽 → 拒绝', checkGates({ ...baseGate, state: { ...baseGate.state, sentToday: 3 } }).reason, 'daily-cap')
check('空闲不足 → 拒绝', checkGates({ ...baseGate, state: { ...baseGate.state, lastUserAt: at(15).getTime() - 2 * 3_600_000 } }).reason, 'not-idle-enough')
check(
  '刚发过（冷却中）→ 拒绝',
  checkGates({ ...baseGate, state: { ...baseGate.state, lastSentAt: at(15).getTime() - 30 * 60_000 } }).reason,
  'cooldown',
)
check(
  '冷却退避：missStreak=2 时 30 分钟仍被拦（90*9=810 分钟）',
  checkGates({ ...baseGate, state: { ...baseGate.state, missStreak: 2, lastSentAt: at(15).getTime() - 30 * 60_000 } }).reason,
  'cooldown',
)
check(
  '静默时段优先于其他门',
  checkGates({ ...baseGate, now: at(2), state: { ...baseGate.state, sentToday: 5 } }).reason,
  'quiet-hours',
)

console.log('\n【动机分（可解释性）】')
const strong = scoreMotivation({
  kind: 'memory',
  memory: { importance: 9 },
  relation: { intimacy: 0.6, rapport: 0.5 },
  idleHours: 24,
  hoursSinceTold: 200,
})
const weak = scoreMotivation({
  kind: 'memory',
  memory: { importance: 5 },
  relation: { intimacy: 0.05, rapport: 0.1 },
  idleHours: 1,
  hoursSinceTold: 1,
})
check('重要记忆 + 关系近 → 过阈', strong.score >= 7, true)
check('琐碎记忆 + 刚提过 → 不过阈', weak.score >= 7, false)
check('分数由可读项组成', strong.breakdown.length >= 3, true)
console.log(`     高分构成：${strong.breakdown.map((b) => `${b.label}=${b.value}`).join(' + ')} = ${strong.score}`)
console.log(`     低分构成：${weak.breakdown.map((b) => `${b.label}=${b.value}`).join(' + ')} = ${weak.score}`)

console.log('\n【分类型动机阈值（P5 调参结论）】')
// 记忆型门槛更高：只有真的值得才提。这是"想更自然"的正确手段——
// 早期误用"放宽空闲门"来增加自然度，结果一天从 0.86 次涨到 2.43 次、撞满每日上限。
const memoryCandidate = { kind: 'memory', memory: { id: 1, content: '他下周要面试', importance: 9 }, relation: { intimacy: 0.3 }, idleHours: 20, hoursSinceTold: 300 }
const idleCandidate = { kind: 'idle', relation: { intimacy: 0.35, rapport: 0.5 }, idleHours: 30 }
/** 浮点容差比较（7×1.35 = 9.450000000000001，不能用严格相等）。 */
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

check('记忆型门槛 = 基础阈值 × 1.35',
  near(decide({ candidates: [memoryCandidate], now: at(15), config: baseGate.config, state: baseGate.state }).ranked[0].threshold, 9.45), true)
check('空闲型门槛 = 基础阈值', decide({ candidates: [idleCandidate], now: at(15), config: baseGate.config, state: baseGate.state }).ranked[0].threshold, 7)
// 这条断言本身也是一条回归：阈值必须**可达**。
// ×1.5 时典型记忆候选只有 10.27 分、差 0.23 过不去——等于把"想起你"这条通道关掉。
check('典型记忆候选能过记忆型门槛（阈值可达）',
  decide({ candidates: [memoryCandidate], now: at(15), config: baseGate.config, state: baseGate.state }).send, true)

console.log('\n【总决策】')
const candidates = [memoryCandidate, idleCandidate]
const decision = decide({ candidates, now: at(15), config: baseGate.config, state: baseGate.state, relation: { intimacy: 0.3 } })
check('有高分候选 → 决定发送', decision.send, true)
check('选中的是记忆型（分更高）', decision.chose.kind, 'memory')
check('候选被排序', decision.ranked[0].score >= decision.ranked[1].score, true)

const gated = decide({ candidates, now: at(2), config: baseGate.config, state: baseGate.state, relation: { intimacy: 0.3 } })
check('静默时段 → 不发', gated.send, false)
check('但仍保留排序结果可供观察', gated.ranked.length, 2)

const none = decide({ candidates: [], now: at(15), config: baseGate.config, state: baseGate.state })
check('无候选 → 不发', none.send, false)

console.log('\n【投递文本】')
const prompt = renderInitiativePrompt(decision.chose)
check('标注了"不是他说的话"', prompt.includes('不是他说的话'), true)
check('带上了记忆内容', prompt.includes('他下周要面试'), true)
check('要求一到两句', prompt.includes('一到两句'), true)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

// 事实抽取的单元测试 —— 只在规则层验证，不起应用。
// 用法：node app/memory-test.mjs
import { extractFacts } from './companion/memory.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`) } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** 抽取并返回内容列表。 */
const facts = (text) => extractFacts([text]).map((f) => f.content)
/**
 * 判断是否抽到了包含某片段的事实。
 * 比较前去掉空白：抽取结果里不该强求空格，但断言写死空格会误报失败。
 */
function has(text, fragment) {
  const list = facts(text)
  const norm = (s) => s.replace(/\s+/g, '')
  return { ok: list.some((c) => norm(c).includes(norm(fragment))), list }
}

console.log('\n【宠物】')
for (const [text, fragment] of [
  ['我养了一只猫叫豆豆', '豆豆'],
  ['我养了猫叫豆豆', '豆豆'],
  ['我有只狗叫旺财', '旺财'],
  ['我的猫叫豆豆', '豆豆'],
]) {
  const r = has(text, fragment)
  check(`${text} → 含「${fragment}」`, r.ok, r.list.join(' | '))
}

console.log('\n【名字与身份】')
for (const [text, fragment] of [
  ['我叫阿哲', '阿哲'],
  ['我的名字是阿哲', '阿哲'],
  ['我今年 28 岁', '28 岁'],
  ['我住在杭州', '杭州'],
]) {
  const r = has(text, fragment)
  check(`${text} → 含「${fragment}」`, r.ok, r.list.join(' | '))
}

console.log('\n【计划与行程】')
for (const [text, fragment] of [
  ['下周要去面试', '面试'],
  ['明天考试', '考试'],
  ['下个月要出差', '出差'],
  ['我打算下个月开始学吉他', '吉他'],
]) {
  const r = has(text, fragment)
  check(`${text} → 含「${fragment}」`, r.ok, r.list.join(' | '))
}

console.log('\n【喜好 / 家人 / 在意的事】')
for (const [text, fragment] of [
  ['我最喜欢 Radiohead', 'Radiohead'],
  ['我讨厌早起', '早起'],
  ['我妈总说我太要强', '妈'],
  ['我最近一直睡不好', '睡不好'],
]) {
  const r = has(text, fragment)
  check(`${text} → 含「${fragment}」`, r.ok, r.list.join(' | '))
}

console.log('\n【说话人标签不该进卡片】')
const labelled = extractFacts(['用户：我叫阿哲，我养了一只猫叫豆豆'])
check('带标签的输入不会把「用户：」写进内容', !labelled.some((f) => f.content.includes('用户：')), labelled.map((f) => f.content).join(' | '))

console.log('\n【重要性分级】')
const imp = (text) => extractFacts([text]).map((f) => f.importance)
check('名字是最高的（≥9）', Math.max(...imp('我叫阿哲')) >= 9, `importance=${imp('我叫阿哲')}`)
check('宠物次高（≥8）', Math.max(...imp('我养了一只猫叫豆豆')) >= 8, `importance=${imp('我养了一只猫叫豆豆')}`)

console.log('\n【不该误抽】')
const noise = facts('嗯嗯，好的，你说得对。')
check('纯寒暄不产生高重要度卡片', !noise.some((c) => c.includes('嗯嗯')), noise.join(' | ') || '（无卡片）')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

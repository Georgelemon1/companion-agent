// 词表覆盖检查：把真实聊天里高频的情绪说法过一遍，看本地通道是否漏判。
// 用法：node app/coverage.mjs
import { heuristicAppraise } from './companion/appraisal.js'

/** 期望能被识别的真实说法（覆盖失败/自我否定/睡眠/亲密/生气/求陪 等场景）。 */
const CASES = [
  ['面试挂了，准备了两个月', 'sadness'],
  ['我最近一直睡不好', 'fear'],
  ['老觉得自己不行', 'sadness'],
  ['今天被老板骂了，好烦', 'anger'],
  ['有点焦虑，deadline 快到了', 'fear'],
  ['我今天超级开心！！！', 'joy'],
  ['谢谢你一直陪着我', 'joy'],
  ['我真的很喜欢你', 'affection'],
  ['一个人待着挺孤独的', 'affection'],
  ['你别烦我', 'hurt'],
  ['没事，我陪你', 'calm'],
  ['居然是这样，我没想到', 'surprise'],
  ['我妈总说我太要强', null],
]

let missed = 0
console.log('文本'.padEnd(34) + '| 命中标签                      | 新意')
console.log('-'.repeat(78))
for (const [text, expected] of CASES) {
  const r = heuristicAppraise(text, [])
  const labels = Object.keys(r.deltas)
  const ok = expected === null || labels.includes(expected)
  if (!ok) missed += 1
  const mark = expected === null ? '  ' : ok ? '✅' : '❌'
  console.log(`${mark} ${text.padEnd(30)}| ${(labels.join(',') || '（无）').padEnd(30)}| ${r.novelty.toFixed(2)}`)
}
console.log('-'.repeat(78))
console.log(missed === 0 ? '全部关键场景均被识别' : `有 ${missed} 个场景未被识别`)
process.exitCode = missed === 0 ? 0 : 1

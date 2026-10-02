// 人设推断的单元测试 —— 规则通道、反编造闸门、迟滞防抖、叠加渲染、库迁移与轮转。
// 只在纯函数层与临时库上验证，不起应用。
// 用法：node app/persona-infer-test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  composePersona, describeCard, describeTraitChanges, mergeTrait, parseInference, ruleInfer, validateTraits,
} from './companion/infer.js'
import { DEFAULT_PERSONA, renderIdentity } from './companion/persona.js'
import { CompanionState, PERSONA_TRACE_LIMIT } from './companion/state.js'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`) } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** 跑规则通道并取某个维度的值。 */
const ruled = (text, key) => ruleInfer(text).find((t) => t.key === key)?.value

console.log('\n【规则通道：显式指令要立刻被听懂】')
check('「以后叫我阿哲」→ 称呼他=阿哲', ruled('以后叫我阿哲', 'callUser') === '阿哲', String(ruled('以后叫我阿哲', 'callUser')))
check('「以后叫我阿哲就行」→ 收尾语被削掉', ruled('以后叫我阿哲就行，别老用你你你的', 'callUser') === '阿哲', String(ruled('以后叫我阿哲就行，别老用你你你的', 'callUser')))
check('「我以后叫你小夏」→ 她的名字=小夏', ruled('我以后叫你小夏', 'name') === '小夏', String(ruled('我以后叫你小夏', 'name')))
check('「你以后叫小夏吧」→ 她的名字=小夏', ruled('你以后叫小夏吧', 'name') === '小夏', String(ruled('你以后叫小夏吧', 'name')))
const taboo = ruled('以后别跟我聊工作压力了', 'taboos')
check('「别跟我聊工作压力了」→ 禁忌=工作压力（结尾语气词已剥）', taboo === '工作压力', String(taboo))
check('「你说得太长了」→ 回复长度=short', ruled('你说得太长了', 'replyLength') === 'short', String(ruled('你说得太长了', 'replyLength')))
check('「别老主动找我」→ 不主动=false', ruled('别老主动找我', 'proactiveOn') === false, String(ruled('别老主动找我', 'proactiveOn')))
check('「每天最多主动找我两次」→ 配额=2', ruled('每天最多主动找我两次', 'dailyCap') === 2, String(ruled('每天最多主动找我两次', 'dailyCap')))
check('「你别给我讲道理，听着就行」→ 低落时=stay', ruled('我不开心的时候你别给我讲道理', 'comfort') === 'stay', String(ruled('我不开心的时候你别给我讲道理', 'comfort')))
check('「别用表情包了」→ 表情=none', ruled('别用表情包了', 'emoji') === 'none', String(ruled('别用表情包了', 'emoji')))

console.log('\n【规则通道：不该被误判成指令】')
check('「你叫什么名字」不产生名字', ruled('你叫什么名字', 'name') === undefined, String(ruled('你叫什么名字', 'name')))
check('「别叫我宝贝」不产生称呼', ruled('别叫我宝贝，我不喜欢', 'callUser') === undefined, String(ruled('别叫我宝贝，我不喜欢', 'callUser')))
check('「我会主动找你的」（他在说自己）不产生主动性设定', ruled('我会主动找你的', 'proactiveOn') === undefined, String(ruled('我会主动找你的', 'proactiveOn')))
check('「我最喜欢猫了」不产生任何设定', ruleInfer('我最喜欢猫了').length === 0, JSON.stringify(ruleInfer('我最喜欢猫了')))
check('闲聊不产生任何设定', ruleInfer('今天天气不错，中午吃了碗面').length === 0, JSON.stringify(ruleInfer('今天天气不错，中午吃了碗面')))

console.log('\n【规则通道 → 校验闸门：规则自己的输出必须能过闸（字段名对不上就会在这里炸）】')
for (const text of [
  '以后叫我阿哲', '我以后叫你小夏', '你以后叫小夏吧', '别跟我聊工作压力了',
  '你说得太长了', '别老主动找我', '每天最多主动找我两次', '你别给我讲道理，听着就行', '别用表情包了',
]) {
  const { accepted, rejected } = validateTraits(ruleInfer(text), { userText: `用户：${text}`, minConfidence: 0.5, source: 'rule' })
  check(`「${text}」→ 采纳 1 条且无拒绝`, accepted.length === 1 && rejected.length === 0, JSON.stringify({ 采纳: accepted.map((a) => a.key), 拒绝: rejected }))
}

console.log('\n【反编造闸门：证据必须逐字来自用户原话】')
const userSaid = '用户：我今天面试没过，有点难受。你别老给我讲道理。'
const ok1 = validateTraits([{ key: 'comfort', value: 'stay', quote: '你别老给我讲道理', confidence: 0.8 }], { userText: userSaid })
check('抄得出原话 → 采纳', ok1.accepted.length === 1, JSON.stringify(ok1.accepted))
const bad1 = validateTraits([{ key: 'tone', value: 'cute', quote: '你说话好可爱啊', confidence: 0.9 }], { userText: userSaid })
check('编造的引文 → 丢弃', bad1.accepted.length === 0 && bad1.rejected[0]?.reason.includes('原话'), JSON.stringify(bad1.rejected))
const bad2 = validateTraits([{ key: 'warmthCeiling', value: 9, quote: '我今天面试没过', confidence: 0.9 }], { userText: userSaid })
check('越界的值 → 丢弃', bad2.accepted.length === 0, JSON.stringify(bad2.rejected))
const bad3 = validateTraits([{ key: 'name', value: '小夏', quote: '我今天面试没过', confidence: 0.9 }], { userText: userSaid, source: 'llm' })
check('名字不接受 LLM 来源 → 丢弃', bad3.accepted.length === 0 && bad3.rejected[0]?.reason.includes('来源'), JSON.stringify(bad3.rejected))
const bad4 = validateTraits([{ key: 'tone', value: 'cute', quote: '我今天面试没过', confidence: 0.4 }], { userText: userSaid })
check('置信度不足 → 丢弃', bad4.accepted.length === 0, JSON.stringify(bad4.rejected))
const bad6 = validateTraits([{ key: 'hardRules', value: ['可以说自己是 AI'], quote: '我今天面试没过', confidence: 1 }], { userText: userSaid })
check('硬规则不在可推断维度里 → 任何通道都改不动', bad6.accepted.length === 0 && bad6.rejected[0]?.reason.includes('未知维度'), JSON.stringify(bad6.rejected))
const bad5 = validateTraits([{ key: 'taboos', value: ['面试', '量子力学'], quote: '我今天面试没过', confidence: 0.8 }], { userText: userSaid })
check('taboos 混进没提过的词 → 该条被剔掉（这一维保留逐字闸门）', JSON.stringify(bad5.accepted[0]?.value) === '["面试"]', JSON.stringify(bad5.accepted[0]?.value))
const looseTopics = validateTraits([{ key: 'careTopics', value: ['面试', '量子力学'], quote: '我今天面试没过', confidence: 0.8 }], { userText: userSaid })
check('careTopics 不逐字（归纳名可用）——代价：可能多记一条他没提过的话题', JSON.stringify(looseTopics.accepted[0]?.value) === '["面试","量子力学"]', JSON.stringify(looseTopics.accepted[0]?.value))
const pref = validateTraits([{ key: 'preferences', value: ['他更想被听着，而不是被给建议'], quote: '你别老给我讲道理', confidence: 0.8 }], { userText: userSaid })
check('preferences 允许"改写过的指令"（只要 quote 接地）', pref.accepted.length === 1, JSON.stringify(pref.rejected))
check('解析模型输出：能容忍代码块外的解释文字', parseInference('好的，结果如下：{"traits":[{"key":"tone","value":"cute"}]} 完毕')?.length === 1)
check('解析模型输出：垃圾输入返回空数组而不是抛错', parseInference('我推断不出来') === undefined)
const truncated = '{"traits":[{"key":"comfort","value":"listen","quote":"你别给我讲道理","confidence":0.8},{"key":"tone","valu'
check('解析模型输出：被 maxTokens 截断时抢救出完整的那几条', parseInference(truncated)?.length === 1 && parseInference(truncated)[0].key === 'comfort', JSON.stringify(parseInference(truncated)))

console.log('\n【叠加：推断结果盖到基线上，硬规则一根汗毛都不动】')
const traits = [
  { key: 'callUser', value: '阿哲', evidence: '以后叫我阿哲', confidence: 0.9, source: 'rule' },
  { key: 'replyLength', value: 'short', evidence: '你说得太长了', confidence: 0.9, source: 'rule' },
  { key: 'taboos', value: ['工作压力'], evidence: '别聊工作压力', confidence: 0.9, source: 'rule' },
  { key: 'careTopics', value: ['考研'], evidence: '我在准备考研', confidence: 0.8, source: 'llm' },
  { key: 'preferences', value: ['他更想被听着，而不是被给建议'], evidence: '你别老给我讲道理', confidence: 0.8, source: 'llm' },
]
const card = composePersona(DEFAULT_PERSONA, traits)
check('称呼被覆盖', card.callUser === '阿哲', card.callUser)
check('回复长度被换成 short 的文案', card.replyLength.includes('一到两句'), card.replyLength)
check('禁忌进了卡', card.taboos[0] === '不要主动提起：工作压力', card.taboos[0])
const identity = renderIdentity(card)
check('人设段渲染出「在意的事」', identity.includes('他常聊、也在意的事：考研'))
check('人设段渲染出「相处偏好」块', identity.includes('## 相处下来你摸清的偏好') && identity.includes('他更想被听着'))
check('人设段保留硬规则原文', identity.includes(DEFAULT_PERSONA.hardRules[0].replace('{name}', '小满')))
check('hardRules 字段未被推断改写', JSON.stringify(card.hardRules ?? DEFAULT_PERSONA.hardRules) === JSON.stringify(DEFAULT_PERSONA.hardRules))
const bare = renderIdentity(DEFAULT_PERSONA)
check('没有任何推断时不凭空生成偏好块', !bare.includes('相处下来你摸清的偏好'))
check('摘要能读出当前设定', describeCard(card).includes('称呼他=阿哲'), describeCard(card))

console.log('\n【回归（实跑 05:59:57 那条 warn）：归纳出来的话题名不该被判"值不合法"】')
const saidAboutMother = '用户：我妈今天打电话来，又催我找对象，烦得很'
const paraphrase = validateTraits(
  [{ key: 'careTopics', value: ['被家里催婚这件事'], quote: '我妈今天打电话来，又催我找对象，烦得很', confidence: 0.85 }],
  { userText: saidAboutMother },
)
check('careTopics 接受归纳名（quote 接地即可，不再要求逐字）', paraphrase.accepted.length === 1 && paraphrase.accepted[0].value[0] === '被家里催婚这件事', JSON.stringify(paraphrase))
const paraphraseTaboo = validateTraits(
  [{ key: 'taboos', value: ['家里催婚的事'], quote: '这事我不想聊', confidence: 0.8 }],
  { userText: '用户：这事我不想聊' },
)
check('taboos 保留逐字闸门：没出现在他话里的话题名仍会被挡', paraphraseTaboo.accepted.length === 0 && paraphraseTaboo.rejected[0].reason.includes('不在用户原话里'), JSON.stringify(paraphraseTaboo.rejected))
const invented = validateTraits([{ key: 'careTopics', value: ['量子力学'], quote: '我编的引文', confidence: 0.9 }], { userText: '用户：这事我不想聊' })
check('放宽之后仍然挡住"没证据的编造"', invented.accepted.length === 0 && invented.rejected[0].reason.includes('原话'), JSON.stringify(invented.rejected))
const tooLong = validateTraits([{ key: 'careTopics', value: ['一'.repeat(40)], quote: '这事我不想聊', confidence: 0.9 }], { userText: '用户：这事我不想聊' })
check('拒绝理由变具体（不再笼统说"值不合法"）', tooLong.rejected[0]?.reason.includes('超过 32 字且无法在标点处截断'), tooLong.rejected[0]?.reason)

console.log('\n【回归（实跑 06:25:53 那条 warn）：自然话题名不该被长度上限误杀】')
// 模型实测吐的就是这种 20 字上下的短语（上限原来是 16 → 整条被丢，这一维等于形同虚设）
const naturalLong = '被家里催着找对象这事，他心里其实挺烦的'
const longOk = validateTraits(
  [{ key: 'careTopics', value: [naturalLong], quote: '我妈今天打电话来，又催我找对象，烦得很', confidence: 0.8 }],
  { userText: saidAboutMother },
)
check(`careTopics 接受 ${naturalLong.length} 字的自然话题名（不再按 16 字丢）`, longOk.accepted[0]?.value[0] === naturalLong, JSON.stringify(longOk.rejected))
const overCap = '被家里催着找对象这件事他心里其实挺烦的，他爸最近老是提，还有工作上的一堆压力'
const cut = validateTraits(
  [{ key: 'careTopics', value: [overCap], quote: '我妈今天打电话来，又催我找对象，烦得很', confidence: 0.8 }],
  { userText: saidAboutMother },
)
check('超过 32 字 → 在标点处切一刀保留前半，而不是整条丢掉', cut.accepted[0]?.value[0] === '被家里催着找对象这件事他心里其实挺烦的，他爸最近老是提' && overCap.startsWith(cut.accepted[0].value[0]), JSON.stringify(cut.accepted[0]?.value))
const noBoundary = '被家里催着找对象这件事情让他心里特别烦恼而且工作上压力也很大每天都睡不好'
const cannotCut = validateTraits(
  [{ key: 'careTopics', value: [noBoundary], quote: '我妈今天打电话来，又催我找对象，烦得很', confidence: 0.8 }],
  { userText: saidAboutMother },
)
check('超长且没有标点可切 → 才放弃（并说清原因）', cannotCut.accepted.length === 0 && cannotCut.rejected[0].reason.includes('无法在标点处截断'), cannotCut.rejected[0]?.reason)
// memoryScope 是封闭枚举，逐字接地永远不可能满足（没人会原样说"家人朋友"）——那是我抄错的闸门，已去掉。
const scope = validateTraits(
  [{ key: 'memoryScope', value: ['喜好', '家人朋友'], quote: '我妈今天打电话来，又催我找对象', confidence: 0.8 }],
  { userText: saidAboutMother },
)
check('memoryScope 枚举值不再被逐字闸门误杀', JSON.stringify(scope.accepted[0]?.value) === '["喜好","家人朋友"]', JSON.stringify(scope.rejected))
const longTaboo = validateTraits(
  [{ key: 'taboos', value: ['你妈催你找对象这件事'], quote: '你妈催你找对象这件事以后别跟我提', confidence: 0.8 }],
  { userText: '用户：你妈催你找对象这件事以后别跟我提' },
)
check('taboos 放宽到 32 字后，长一点的禁忌也能进（仍要求逐字）', longTaboo.accepted.length === 1, JSON.stringify(longTaboo.rejected))

console.log('\n【谁说了算：用户明说过的 > 模型推断】')
const t0 = 1_700_000_000_000
const ruleRow = { key: 'comfort', value: 'stay', confidence: 0.9, evidence: '你别给我讲道理', source: 'rule', samples: 1, updatedAt: t0 }
const llmSays = { key: 'comfort', value: 'listen', confidence: 0.95, evidence: '你就听着就行', source: 'llm' }
const blocked = mergeTrait(ruleRow, llmSays, { now: t0 + 86_400_000 })
check('模型推断改不掉用户的显式指令（置信度 0.95、隔一天也不行）', blocked.action === 'skip' && blocked.reason.includes('显式指令'), JSON.stringify(blocked))
const listed = mergeTrait(
  { key: 'taboos', value: ['工作压力'], source: 'llm', samples: 2, evidence: 'x', updatedAt: t0 },
  { key: 'taboos', value: ['工作压力', '前任'], source: 'llm', evidence: 'y' },
  { now: t0 + 1000 },
)
check('列表型累加去重（一次抖动不抹掉已有条目）', listed.action === 'write' && JSON.stringify(listed.value) === '["工作压力","前任"]' && listed.samples === 3, JSON.stringify(listed))

console.log('\n【迟滞：同一维度不许在相邻两回合之间来回横跳】')
const llmRow = { key: 'tone', value: 'cheerful', confidence: 0.7, evidence: '你说话可以再活泼点', source: 'llm', samples: 1, updatedAt: t0 }
const flip = { key: 'tone', value: 'gentle', confidence: 0.75, evidence: '你今天好温柔', source: 'llm' }
const byMargin = mergeTrait(llmRow, flip, { now: t0 + 60_000 })
check('下一回合想翻面 → 置信度余量挡住（0.75 < 0.70+0.10）', byMargin.action === 'skip' && byMargin.reason.includes('置信度'), byMargin.reason)
const byInterval = mergeTrait(llmRow, { ...flip, confidence: 0.95 }, { now: t0 + 60_000 })
check('置信度够了但间隔没到 → 最小变更间隔挡住', byInterval.action === 'skip' && byInterval.reason.includes('间隔'), byInterval.reason)
const settle = mergeTrait(llmRow, { ...flip, value: 'cheerful' }, { now: t0 + 60_000 })
check('又观察回原值 → 只加固(samples+1)，不算变更', settle.action === 'reinforce' && settle.samples === 2, JSON.stringify(settle))
const later = mergeTrait(llmRow, { ...flip, confidence: 0.95 }, { now: t0 + 11 * 60_000 })
check('置信度与间隔都过关 → 允许改（不会永久冻住）', later.action === 'write' && later.value === 'gentle', JSON.stringify(later))
const strongPrior = mergeTrait({ ...llmRow, confidence: 0.92 }, { ...flip, confidence: 0.95 }, { now: t0 + 11 * 60_000 })
check('余量封顶 0.95：0.92 的强先验仍可被 0.95 推翻', strongPrior.action === 'write', JSON.stringify(strongPrior))
const byRule = mergeTrait(llmRow, { ...flip, source: 'rule', confidence: 0.7 }, { now: t0 + 1000 })
check('用户明说的立刻生效（迟滞只管模型推断）', byRule.action === 'write' && byRule.reason === '用户的显式指令', JSON.stringify(byRule))
const listGrow = mergeTrait(
  { key: 'careTopics', value: ['考研'], source: 'llm', confidence: 0.8, samples: 2, updatedAt: t0 },
  { key: 'careTopics', value: ['考研', '工作'], source: 'llm', confidence: 0.8 },
  { now: t0 + 1000 },
)
check('列表新增项不受迟滞约束（只增长，不会抖）', listGrow.action === 'write' && listGrow.value.length === 2, JSON.stringify(listGrow))

console.log('\n【日志噪声：只报变了的维度，不重打整张卡】')
const before = [{ key: 'tone', value: 'cheerful' }, { key: 'emoji', value: 'often' }]
const after = [{ key: 'tone', value: 'gentle' }, { key: 'emoji', value: 'often' }, { key: 'careTopics', value: ['考研'] }]
const diff = describeTraitChanges(before, after)
check('只列变更项，未变的 emoji 不出现', diff.includes('tone cheerful → gentle') && diff.includes('careTopics=[考研]（新增）') && !diff.includes('emoji'), diff)
check('某维度回退到基线时也报出来', describeTraitChanges(after, before).includes('careTopics 回到基线'), describeTraitChanges(after, before))

console.log('\n【库兼容：老库原样可用，新表是加出来的】')
const dir = mkdtempSync(join(tmpdir(), 'companion-infer-'))
const dbPath = join(dir, 'companion.db')
try {
  // 手工造一个"改动前"的库：只有老表，persona 里躺着一张用户真实数据卡。
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE affect (id INTEGER PRIMARY KEY CHECK (id = 1), emotions TEXT NOT NULL, mood_p REAL NOT NULL DEFAULT 0, mood_a REAL NOT NULL DEFAULT 0, mood_d REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE relation (id INTEGER PRIMARY KEY CHECK (id = 1), trust REAL NOT NULL DEFAULT 0.05, intimacy REAL NOT NULL DEFAULT 0.02, rapport REAL NOT NULL DEFAULT 0.1, stage TEXT NOT NULL DEFAULT 'stranger', since INTEGER NOT NULL, turns INTEGER NOT NULL DEFAULT 0, decayed_at INTEGER NOT NULL);
    CREATE TABLE persona (id INTEGER PRIMARY KEY CHECK (id = 1), card TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `)
  legacy.prepare('INSERT INTO persona (id, card, updated_at) VALUES (1, ?, ?)')
    .run(JSON.stringify({ name: '小夏', callUser: '老板', relationKey: 'lover', source: 'questionnaire', handmade: true }), 1)
  legacy.prepare('INSERT INTO affect (id, emotions, updated_at) VALUES (1, ?, ?)').run('{"joy":3}', 1)
  legacy.prepare('INSERT INTO relation (id, since, decayed_at) VALUES (1, ?, ?)').run(1, 1)
  legacy.close()

  const state = new CompanionState(dbPath)
  const kept = state.readPersona()
  check('老库的人设卡原样读回', kept?.name === '小夏' && kept?.handmade === true && kept?.source === 'questionnaire', JSON.stringify(kept))
  // 情绪会被"读时衰减"抹平（老库里 updated_at 是 1970 年），所以查原始行：
  // 这里要证明的是**老数据没被建表动作动过**，不是衰减逻辑。
  check('老库的情绪行原样还在', state.db.prepare('SELECT emotions FROM affect WHERE id = 1').get()?.emotions === '{"joy":3}')
  const tables = new Set(state.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name))
  check('新表是加出来的：persona_trait', tables.has('persona_trait'))
  check('新表是加出来的：persona_trace', tables.has('persona_trace'))
  check('没有任何推断时 readTraits 为空', state.readTraits().length === 0)

  state.writeTrait({ key: 'tone', value: 'cute', confidence: 0.8, evidence: '你说话好甜', source: 'llm' })
  const trait = state.readTraits().find((t) => t.key === 'tone')
  check('写一条推断能读回（值 JSON 还原正确）', trait?.value === 'cute' && trait?.samples === 1, JSON.stringify(trait))
  state.writeTrait({ key: 'tone', value: 'cute', confidence: 0.85, evidence: '你说话好甜', source: 'llm', samples: 2 })
  check('同值再写一次 → samples 累加', state.readTraits().find((t) => t.key === 'tone')?.samples === 2)
  state.logPersonaTrace({ source: 'rule', turn: 7, accepted: [{ key: 'tone' }], rejected: [{ key: 'name', reason: '证据不是用户原话' }] })
  const trace = state.readPersonaTraces(5)[0]
  check('推断流水落库（含被拒理由）', trace?.turn === 7 && trace?.rejected[0]?.reason === '证据不是用户原话', JSON.stringify(trace))

  // 轮转：写满上限再多写 60 行，表必须停在上限，且留下的是最新的。
  for (let i = 0; i < PERSONA_TRACE_LIMIT + 60; i++) {
    state.logPersonaTrace({ source: 'llm', turn: i, accepted: [], rejected: [], note: `n${i}` })
  }
  const rotated = state.readPersonaTraces(PERSONA_TRACE_LIMIT * 3)
  check(`persona_trace 轮转到上限 ${PERSONA_TRACE_LIMIT} 行（不再无限增长）`, rotated.length === PERSONA_TRACE_LIMIT, `实际 ${rotated.length} 行`)
  check('轮转丢掉的是最老的，保留最新', rotated[0].note === `n${PERSONA_TRACE_LIMIT + 59}` && !rotated.some((t) => t.note === 'n0'), `最新=${rotated[0].note}`)
  check('同刻写入不会被 rowid 去重误删', state.readPersonaTraces(PERSONA_TRACE_LIMIT).length === PERSONA_TRACE_LIMIT)

  check('清空推断 → 基线卡仍在', state.clearTraits() === 1 && state.readPersona()?.name === '小夏' && state.readTraits().length === 0)
  state.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exitCode = fail === 0 ? 0 : 1

// companion 人设推断（infer）—— 从**真实对话**里推断"她该怎么对他"，取代问卷表单。
//
// 为什么要有这一层：问卷把"她是谁"变成一张一次性填完的表，填完就定死了；
// 而人设本该是相处里慢慢长出来的。这里把同一件事反过来做——
// 不再问用户，改看**证据**：任何一条设定要写进库，必须挂着用户的原话。
//
// 双通道，与 appraisal / memory 同构（同一套取舍：本地先跑通，LLM 补语义）：
//   ① 规则通道 ruleInfer()：显式指令（"以后叫我阿哲""别聊工作"）零延迟零成本，
//      **每回合都跑**。用户说完，下一回合她就照做。
//   ② LLM 通道 llmInfer()：从最近 N 轮里推断软偏好（语气、浓度、在意的话题…），
//      节流 + 异步，失败静默，不拖慢回复。
//
// 反幻觉用两道**机械化**闸门，不靠提示词自律：
//   · 证据必须逐字出现在**用户自己**说过的话里（她的回复不算数——否则她会把自己的
//     输出读成"用户喜欢这样"，形成自我强化）；
//   · 值必须落在维度定义的值域内，越界即丢弃并记进 trace。
//
// 与 persona.js 的分工：这里只管"推断了什么、能不能信"，渲染仍是 persona.js 的事。
// 硬规则（不得假装真人等）不在这张表里，推断永远碰不到它们。

/** 她怎么称呼用户（枚举键 → 卡里的文字）。 */
const TONE_TEXT = {
  gentle: '温柔治愈，语气软，多用"嗯""我在"这类承接',
  cheerful: '阳光开朗，有活力，会主动接话、带动气氛',
  cool: '清冷克制，话不多但有分量，偶尔一句戳中要害',
  mature: '成熟稳重，看得透但不端着，会给方向感',
  cute: '甜美可爱，会用叠词和语气词，偶尔撒娇',
  casual: '慵懒随性，像老朋友一样随意，不刻意',
}

/** 回复长度（枚举键 → 卡里的文字）。 */
const LENGTH_TEXT = {
  short: '通常一到两句，像微信上随手回的那种',
  medium: '两三句为主，说清楚但不啰嗦',
  long: '可以说得多一些，四五句，愿意展开讲',
}

/** 表情符号习惯（枚举键 → 卡里的文字）。 */
const EMOJI_TEXT = {
  none: '不用，纯文字',
  sometimes: '偶尔用，不滥用',
  often: '经常用，活泼一点',
}

/** 低落时的策略（枚举键 → 卡里的文字）。 */
const COMFORT_TEXT = {
  listen: '先听他说完，不急着给建议，让他把话倒出来',
  distract: '先稳住情绪，再轻轻把话题带开一点，别让他陷进去',
  solve: '听完之后帮他理一理，给一两个能落地的方向',
  stay: '不多说，就是陪着，让他知道有人在',
}

/** 记忆范围的可选值（与架构方案 §7.1 的问卷维度同名，便于老卡片延续）。 */
export const MEMORY_SCOPES = ['喜好', '家人朋友', '工作学业', '计划约定', '情绪状态']

/**
 * 可推断的维度表。这是本次改动的**边界声明**：能被她自己改的只有这些。
 *
 * `sources` 限制来源——硬性的一次性事实（改名）只允许规则通道，
 * 因为 LLM 从闲聊里"推断出"一个新名字几乎必然是幻觉。
 */
export const TRAITS = {
  name: { kind: 'text', label: '她自己的名字', max: 8, sources: ['rule'], forbid: /[你我他她它]|^[的了在是不有别吗呢]/, itemMax: 8 },
  callUser: { kind: 'text', label: '她怎么称呼他', max: 8, sources: ['rule', 'llm'], forbid: /[你我他她它]|^[的了在是不有别吗呢]/ },
  tone: { kind: 'enum', label: '说话风格', options: Object.keys(TONE_TEXT), sources: ['rule', 'llm'] },
  replyLength: { kind: 'enum', label: '回复长度', options: Object.keys(LENGTH_TEXT), sources: ['rule', 'llm'] },
  emoji: { kind: 'enum', label: '表情符号', options: Object.keys(EMOJI_TEXT), sources: ['rule', 'llm'] },
  comfort: { kind: 'enum', label: '他低落时她怎么做', options: Object.keys(COMFORT_TEXT), sources: ['rule', 'llm'] },
  warmthCeiling: { kind: 'int', label: '情感浓度上限', min: 1, max: 4, sources: ['rule', 'llm'] },
  affectionFrequency: { kind: 'int', label: '主动表达想念的频率', min: 1, max: 3, sources: ['rule', 'llm'] },
  dailyCap: { kind: 'int', label: '每天最多主动几次', min: 1, max: 5, sources: ['rule', 'llm'] },
  proactiveOn: { kind: 'bool', label: '允不允许她主动找他', sources: ['rule', 'llm'] },
  memoryOn: { kind: 'bool', label: '要不要记他说的事', sources: ['rule', 'llm'] },
  // memoryScope 的 verbatim 已去掉：那一项是**抄错的**，不是有意的。
  // 它的值是封闭枚举（喜好/家人朋友/…），"必须逐字出现在他的话里"永远不可能被满足——
  // 没人会原样说出"家人朋友"四个字，于是这一维被自己的闸门废掉
  //（实跑日志：「喜好」不在用户原话里；「家人朋友」不在用户原话里…）。真正的闸门是 options 白名单。
  memoryScope: { kind: 'list', label: '该记什么', options: MEMORY_SCOPES, max: 5, itemMax: 8, sources: ['llm'] },
  // careTopics **不要求逐字**（实跑踩坑）：模型给的是"话题名"这种**归纳**，不是原话片段——
  // 用户说「我妈打电话来又催我找对象」，它归纳成「被家里催婚这件事」是对的；
  // 逐字闸门把它判成非法值丢掉，等于白推断一轮。真正管编造的是 quote 那一关。
  //
  // 长度上限按"自然话题名"来定：模型实测吐的是「被家里催着找对象这事，他…」这种 20+ 字的短语，
  // 原来的 16 字会把它整条丢掉（实跑 06:25:53），这一维就等于形同虚设。定 32：
  // 自然名词短语/短从句装得下，又拦得住"整段话当话题"的滥用——列表另有 max=6 的总量闸门。
  careTopics: { kind: 'list', label: '他在意的话题', max: 6, itemMax: 32, sources: ['llm'] },
  // taboos 同理放宽到 32：它仍保留逐字闸门，所以放宽长度不会放进编造内容；
  // 真实禁忌短语几乎都短于 32，这一档只是不再误杀长一点的表述。
  taboos: { kind: 'list', label: '别碰的话题', max: 6, itemMax: 32, verbatim: true, sources: ['rule', 'llm'] },
  // preferences 本来就是"一句指令"，40 与提示词里的"每条不超过 30 字"留了余量。
  preferences: { kind: 'list', label: '其它相处偏好', max: 8, itemMax: 40, sources: ['rule', 'llm'] },
}

/** 允许的维度名集合。 */
export const TRAIT_KEYS = Object.keys(TRAITS)

/** 单复数/近义写法归一，模型偶尔会写单数。 */
const KEY_ALIAS = {
  taboo: 'taboos',
  careTopic: 'careTopics',
  preference: 'preferences',
  memoryScopes: 'memoryScope',
  callName: 'callUser',
  replyLen: 'replyLength',
}

/** 纯语气词/代词，不该被当成"话题"或"禁忌"写进库。 */
const STOP_WORDS = new Set([
  '了', '吧', '吗', '呢', '啊', '呀', '哦', '嗯', '这个', '那个', '这些', '那些',
  '我', '你', '他', '她', '它', '这样', '那样', '什么', '事情', '东西',
])

/**
 * 归一化文本，用于证据比对。
 *
 * 只去空白与常见标点：模型抄原话时偶尔改个逗号不该被判成幻觉，
 * 但**字序必须一致**，这样"没抄原话"依然会被拒。
 * @param value - 任意文本。
 * @returns 归一化后的字符串。
 */
export function normalize(value) {
  return String(value ?? '')
    .replace(/[\s，。！？、；：""''（）()《》【】\[\]…—–\-.,!?;:'"]/g, '')
}

/** 剥掉投递给模型时加的说话人前缀（`用户：`）。 */
export function stripSpeakerLabel(text) {
  return String(text ?? '').replace(/^\s*用户\s*[：:]\s*/gm, '')
}

/** 句末标点。 */
const SENTENCE_END = /[。！？!?…\n；;]/

/**
 * 取命中片段所在的那一句，作为证据原文。
 * @param text - 用户原话。
 * @param index - 命中起点。
 * @param length - 命中长度。
 * @returns 整句（已 trim）。
 */
function sentenceAt(text, index, length) {
  let start = 0
  for (let i = index; i > 0; i--) {
    if (SENTENCE_END.test(text[i - 1])) { start = i; break }
  }
  let end = text.length
  for (let i = index + length; i < text.length; i++) {
    if (SENTENCE_END.test(text[i])) { end = i + 1; break }
  }
  return text.slice(start, end).trim()
}

/**
 * 结尾的语气助词与收尾语。
 *
 * 规则通道靠"一路捕获到标点"取名字/称呼，于是「以后叫我阿哲就行」会捕成「阿哲就行」、
 *「叫我阿哲吧」会捕成「阿哲吧」——这些收尾都得削掉，否则她会管他叫"阿哲就行"。
 * （实跑第一次就是这么写进库的：callUser=阿哲就行。）
 */
const TRAILING_PARTICLES = /(?:(?:就行|就好了|就行了|就好|好了|可以了)|[了吧啦哦啊呢呀嘛呗])+$/

/** 剥掉结尾语气助词。 */
const trimParticles = (text) => String(text ?? '').trim().replace(TRAILING_PARTICLES, '').trim()

/** 命中位置之前若是否定语境，说明这条"指令"其实是被否掉的。 */
const NEGATION_BEFORE = /(别|不要|不用|不想|讨厌|不喜欢|不准|不许)$/

/** 中文数字 → 阿拉伯数字（配额这类小数值够用）。 */
const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }
const toNumber = (raw) => {
  if (raw === undefined) return undefined
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Number(text)
  return CN_NUM[text]
}

/**
 * 规则通道的规则表。
 *
 * 每条都要求**明确的祈使语气**——"你说话好长"不算指令，"说短一点"才算。
 * 这是刻意的保守：规则通道的结果带 0.9 置信度、每回合都跑，误判一次就会被写进库。
 *
 * `negBefore: true` 表示命中点之前若有否定词就跳过（"别叫我宝贝"不是在改名）。
 */
const RULES = [
  // ── 改名 / 称呼 ──
  // "以后叫你小夏" / "我就叫你阿夏吧"
  { key: 'name', negBefore: true, re: /我(?:以后|接下来|就|想)?(?:叫你|喊你|管你叫)\s*(?<x>[^\s，。！？,.!?]{1,8})/, value: (m) => trimParticles(m.groups.x) },
  // "你以后叫小夏吧" —— 必须带 吧/好不好，否则 "你叫什么" 会误判
  { key: 'name', negBefore: true, re: /你(?:以后|接下来)?(?:就)?叫\s*(?<x>[^\s，。！？,.!?]{1,8}?)\s*(?:吧|好不好|好吗)/, value: (m) => trimParticles(m.groups.x) },
  // "以后叫我阿哲" / "叫我老板就行"
  { key: 'callUser', negBefore: true, re: /(?:以后|接下来|请|可以)?\s*叫我\s*(?<x>[^\s，。！？,.!?]{1,8})/, value: (m) => trimParticles(m.groups.x) },

  // ── 禁忌 ──
  { key: 'taboos', re: /(?:别|不要|不用|不想)(?:再)?(?:跟我)?(?:聊|提|说|问)(?:起)?\s*(?<x>[^\s，。！？,.!?]{2,16})/, value: (m) => trimParticles(m.groups.x) },

  // ── 说话长短 ──
  { key: 'replyLength', re: /(?:(?:说|回|讲|写)(?:得|的)?(?:太|好)(?:长|多|啰嗦|复杂))|(?:太长|啰嗦|话太多)/, value: () => 'short' },
  { key: 'replyLength', re: /(?:(?:简单|简洁|短|少)(?:一)?点)|(?:(?:别|不用)(?:说|讲|写)?(?:那么|这么)多)/, value: () => 'short' },
  { key: 'replyLength', re: /(?:(?:多|再)(?:说|讲|聊)(?:一)?点)|(?:(?:展开|详细)(?:说说|讲讲|一点))/, value: () => 'long' },

  // ── 表情符号 ──
  { key: 'emoji', re: /(?:别|不要|不用)(?:再)?(?:用|发)(?:那些)?(?:表情|emoji|颜文字|表情包)/i, value: () => 'none' },
  { key: 'emoji', re: /(?:多|经常)(?:用|发)(?:一)?(?:点)?(?:表情|emoji|颜文字|表情包)/i, value: () => 'often' },

  // ── 主动性 ──
  { key: 'proactiveOn', re: /(?:别|不要|不用)(?:老|总是|一直|动不动|天天)?(?:主动)?(?:找我|发消息|发信息|打扰我)/, value: () => false },
  // 只有明确指向她的祈使/抱怨才算；"我会主动找你"是在说他自己，不能算。
  { key: 'proactiveOn', re: /(?:你|希望|想让你|要你|请你|喜欢你)(?:以后|可以|要|得多|多|经常|常常)?(?:主动|来找我|找我聊天|理我)/, value: () => true },
  { key: 'proactiveOn', re: /(?:怎么|为什么)(?:都|从来|老)?不(?:主动)?(?:找我|理我|发消息|发信息)/, value: () => true },
  { key: 'affectionFrequency', re: /(?:多|经常|常常)(?:说|讲)?(?:一)?(?:点)?(?:想我|爱我|喜欢我)/, value: () => 3 },
  // 必须带"最多/主动/找我"这类限定词，否则「每天上班坐两次地铁」会被读成配额。
  { key: 'dailyCap', re: /每天(?:最多|顶多|别超过|不超过|就|主动|找我|发消息|发信息)[^\d一二两三四五]{0,6}?(?<n>[1-5一二两三四五])\s*(?:条|次)/, value: (m) => toNumber(m.groups.n) },

  // ── 记忆 ──
  { key: 'memoryOn', re: /(?:别|不用|不要)(?:去)?(?:记|记住|记得)(?:住)?(?:我)?(?:说)?(?:的)?(?:那些)?(?:事|话)?/, value: () => false },

  // ── 他低落时 ──
  { key: 'comfort', re: /(?:别|不要)(?:给我)?(?:讲道理|给建议|分析|说教|建议)/, value: () => 'stay' },
  { key: 'comfort', re: /(?:(?:听|陪)(?:我|着)?(?:就|就行|就好))/, value: () => 'stay' },
  { key: 'comfort', re: /(?:帮我|给我|替我)(?:理|分析|想|捋)(?:一)?(?:理|下|想)?/, value: () => 'solve' },
]

/**
 * 规则通道：从一条用户消息里抽显式指令。
 * @param userText - 用户原话（可带 `用户：` 前缀）。
 * @returns trait 数组 `{ key, value, quote, confidence, source }`。
 */
export function ruleInfer(userText) {
  const text = stripSpeakerLabel(userText)
  if (text.trim() === '') return []
  const out = []
  const used = new Set()
  for (const rule of RULES) {
    if (used.has(rule.key)) continue
    rule.re.lastIndex = 0
    const match = rule.re.exec(text)
    if (match === null) continue
    if (rule.negBefore === true && NEGATION_BEFORE.test(text.slice(Math.max(0, match.index - 2), match.index).trim())) continue
    const value = typeof rule.value === 'function' ? rule.value(match) : rule.value
    if (value === undefined || value === null) continue
    const evidence = sentenceAt(text, match.index, match[0].length)
    // 列表型：单条消息里的捕获片段本身就是内容，先过一遍停用词。
    const items = Array.isArray(value) ? value : [value]
    if (items.some((item) => typeof item === 'string' && (item.trim().length < 2 || STOP_WORDS.has(item.trim())))) continue
    used.add(rule.key)
    out.push({ key: rule.key, value, quote: evidence, confidence: 0.9, source: 'rule' })
  }
  return out
}

/**
 * 校验并归一化一条推断。
 * @param item - `{ key, value, quote, confidence }`。
 * @param ctx - `{ grounded, minConfidence, source }`；grounded 是**用户原话**的归一化文本。
 * @returns `{ trait }` 或 `{ reason }`。
 */
function validateOne(item, ctx) {
  const rawKey = String(item?.key ?? '').trim()
  const key = KEY_ALIAS[rawKey] ?? rawKey
  const spec = TRAITS[key]
  if (spec === undefined) return { reason: `未知维度 ${rawKey}` }
  if (ctx.source !== undefined && !spec.sources.includes(ctx.source)) return { reason: `${key} 不接受 ${ctx.source} 来源` }

  // 证据字段两种叫法都收：规则通道出 evidence，模型出 quote。
  const quote = String(item?.quote ?? item?.evidence ?? '').trim()
  if (quote === '') return { reason: `${key} 没有证据` }
  if (!ctx.grounded.includes(normalize(quote))) return { reason: `${key} 的证据不是用户原话` }

  const confidence = Number(item?.confidence)
  const conf = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5
  if (conf < ctx.minConfidence) return { reason: `${key} 置信度 ${conf.toFixed(2)} 低于阈值` }

  const normalized = normalizeValue(key, item?.value, ctx.grounded)
  if (normalized.reason !== undefined) return { reason: `${key} 的值不合法：${normalized.reason}` }

  return { trait: { key, value: normalized.value, evidence: quote, confidence: conf, source: ctx.source ?? 'llm' } }
}

/**
 * 按维度类型归一化取值。
 *
 * 失败时返回**具体原因**而不是笼统的 undefined：第一版只给"值不合法"，
 * 排障时看不出到底是太长、是停用词、还是没接地（实跑就被这条日志坑过一次）。
 * @param key - 维度名。
 * @param value - 原始值。
 * @param grounded - 用户原话的归一化文本（开启 verbatim 的维度要在这里面找得到）。
 * @returns `{ value }` 或 `{ reason }`。
 */
function normalizeValue(key, value, grounded) {
  const spec = TRAITS[key]
  if (spec.kind === 'text') {
    const text = String(value ?? '').trim()
    if (text === '') return { reason: '是空字符串' }
    if (text.length > spec.max) return { reason: `「${text}」超过 ${spec.max} 字` }
    if (/^(什么|啥|谁|哪里|怎么|多少)/.test(text)) return { reason: `「${text}」是疑问词，不像称呼` }
    if (spec.forbid !== undefined && spec.forbid.test(text)) return { reason: `「${text}」不像称呼/名字` }
    return { value: text }
  }
  if (spec.kind === 'enum') {
    const text = String(value ?? '').trim()
    if (!spec.options.includes(text)) return { reason: `「${text}」不在可选值里（${spec.options.join('|')}）` }
    return { value: text }
  }
  if (spec.kind === 'int') {
    const num = Math.round(Number(value))
    if (!Number.isFinite(num)) return { reason: `「${String(value)}」不是数字` }
    if (num < spec.min || num > spec.max) return { reason: `${num} 超出 ${spec.min}–${spec.max}` }
    return { value: num }
  }
  if (spec.kind === 'bool') {
    if (typeof value === 'boolean') return { value }
    if (value === 'true') return { value: true }
    if (value === 'false') return { value: false }
    return { reason: `「${String(value)}」不是布尔值` }
  }

  // list
  const raw = Array.isArray(value) ? value : [value]
  const out = []
  const why = []
  for (const entry of raw) {
    if (typeof entry !== 'string') { why.push(`${JSON.stringify(entry)} 不是字符串`); continue }
    let text = entry.trim()
    if (text === '') { why.push('有空项'); continue }
    if (text.length > spec.itemMax) {
      // 超长不直接丢：先在**标点处**切一刀保留前半（模型的长话题名多半是
      // 「被家里催着找对象这事，他爸最近老提」这种带逗号的短从句），切不动才放弃。
      // 为什么不在字数处拦腰砍：截出「被家里催着找对象这事，他」这种断句会原样进提示词，
      // 读起来像错字，比丢掉一条候选更糟。
      const cut = cutAtClause(text, spec.itemMax)
      if (cut === undefined) { why.push(`「${text.slice(0, 12)}…」超过 ${spec.itemMax} 字且无法在标点处截断`); continue }
      why.push(`「${text.slice(0, 12)}…」超过 ${spec.itemMax} 字，已截到「${cut}」`)
      text = cut
    }
    if (STOP_WORDS.has(text)) { why.push(`「${text}」是语气词/代词`); continue }
    if (spec.options !== undefined && !spec.options.includes(text)) { why.push(`「${text}」不在可选值里（${spec.options.join('|')}）`); continue }
    if (spec.verbatim === true && !grounded.includes(normalize(text))) { why.push(`「${text}」不在用户原话里`); continue }
    if (!out.includes(text)) out.push(text)
    if (out.length >= spec.max) break
  }
  if (out.length === 0) return { reason: why.length > 0 ? `没有一项可用：${why.join('；')}` : '是空列表' }
  return { value: out }
}

/** 子句边界：截断过长的归纳项时优先切在这些地方。 */
const CLAUSE_BOUNDARY = /[、，,；;：:。！？!?…\s]/

/**
 * 在标点处把过长文本切一刀。
 * @param text - 原始文本。
 * @param limit - 长度上限。
 * @returns 截断后的前半（至少 2 字）或 undefined（切不动就别凑合）。
 */
export function cutAtClause(text, limit) {
  const head = String(text ?? '').slice(0, limit)
  let cut = -1
  for (let i = head.length - 1; i >= 0; i--) {
    if (CLAUSE_BOUNDARY.test(head[i])) { cut = i; break }
  }
  const kept = (cut >= 0 ? head.slice(0, cut) : '').trim()
  return kept.length >= 2 ? kept : undefined
}

/**
 * 校验一批推断。程序说了算，模型说了不算。
 * @param items - 原始条目数组。
 * @param ctx - `{ userText, minConfidence, source }`。
 * @returns `{ accepted, rejected }`，rejected 是 `{key, reason}` 数组，用于 trace。
 */
export function validateTraits(items, { userText = '', minConfidence = 0.6, source = 'llm' } = {}) {
  const grounded = normalize(stripSpeakerLabel(userText))
  const accepted = []
  const rejected = []
  const seen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const result = validateOne(item, { grounded, minConfidence, source })
    if (result.trait === undefined) {
      rejected.push({ key: String(item?.key ?? '?'), reason: result.reason })
      continue
    }
    if (seen.has(result.trait.key)) {
      rejected.push({ key: result.trait.key, reason: '同一次推断里重复' })
      continue
    }
    seen.add(result.trait.key)
    accepted.push(result.trait)
  }
  return { accepted, rejected }
}

/** LLM 推断用的 system 提示词：只输出 JSON，不给解释。 */
const INFER_SYSTEM = `你是一个"伴侣角色设定推断器"。你不聊天，你的工作是从**用户自己说过的话**里，推断这个伴侣角色该怎么调整自己。

输出严格的 JSON，不要解释、不要 markdown 代码块：
{"traits":[{"key":"tone","value":"cute","quote":"你说话好可爱啊","confidence":0.8}]}

可用维度（key 与值域）：
- tone: gentle(温柔治愈) | cheerful(阳光开朗) | cool(清冷克制) | mature(成熟稳重) | cute(甜美可爱) | casual(慵懒随性)
- replyLength: short(一到两句) | medium(两三句) | long(四五句)
- emoji: none | sometimes | often
- warmthCeiling: 1(含蓄) | 2(温和) | 3(自然亲密) | 4(热烈直球)
- affectionFrequency: 1(很少) | 2(偶尔) | 3(经常) —— 她主动说想你/在意你的频率
- comfort: listen(先听完) | distract(稳住了再带开) | solve(帮他理一理) | stay(不多说，陪着)
- proactiveOn: true | false —— 允不允许她主动找他说话
- dailyCap: 1-5 —— 每天最多主动几次
- memoryOn: true | false —— 要不要记他说过的事
- memoryScope: 数组，元素只能取自 喜好、家人朋友、工作学业、计划约定、情绪状态
- taboos: 字符串数组 —— 他明确不想聊的话题
- careTopics: 字符串数组 —— 他常聊、明显在意的话题
- preferences: 字符串数组 —— 其它相处偏好，每条不超过 30 字，写成对她的指令，例如"他更想被听着，而不是被给建议"

铁律（违反的条目会被程序直接丢弃）：
- quote 必须是用户原话里的**连续片段，一个字都不许改**。抄不出来就不要写这一条。
- 「她的回应」只用于你理解上下文，**不能当证据**。
- 只在有明确依据时才写。没有依据就输出 {"traits":[]}。宁可什么都不写，也不要编造。
- 已经正确的设定不要重复输出，只输出需要新增或修改的。
- confidence 是 0-1 的把握；低于 0.6 的不要输出。
- 一句客气话不足以改设定。只有用户明确表达、反复表现、或明确不满时才改。
- preferences / careTopics / taboos 一次最多 3 条。`

/**
 * 拼给模型看的当前设定摘要（也用于日志）。
 * @param card - 生效中的人设卡。
 * @returns 单行摘要。
 */
export function describeCard(card = {}) {
  const parts = [
    `名字=${card.name ?? '?'}`,
    `称呼他=${card.callUser ?? '?'}`,
    `语气=${card.tone ?? '（默认）'}`,
    `长度=${card.replyLength ?? '（默认）'}`,
    `表情=${card.emoji ?? '（默认）'}`,
    `浓度=${card.warmthCeiling ?? 3}`,
    `主动表达=${card.affectionFrequency ?? 2}`,
    `会主动找他=${card.proactiveOn === false ? '否' : `是（≤${card.dailyCap ?? '默认'}/天）`}`,
    `低落时=${card.comfort ?? '（默认）'}`,
    `记忆=${card.memoryOn === false ? '关' : (card.memoryScope ?? []).join('/') || '开'}`,
    `禁忌=[${(card.taboos ?? []).join(' ')}]`,
    `在意=[${(card.careTopics ?? []).join(' ')}]`,
    `偏好=[${(card.preferences ?? []).join(' ')}]`,
  ]
  return parts.join(' ')
}

/**
 * LLM 通道：从最近几轮对话里推断设定。
 *
 * 失败**抛错**（而不是像 appraisal/memory 那样静默吞掉）：推断是"她是谁"的唯一来源，
 * 静默失败会让设定悄悄停更而没人知道。调用方在异步路径上 catch，不影响回话。
 * @param llm - ctx.llm 服务。
 * @param route - `{ provider, model }`。
 * @param input - `{ card, exchanges }`；exchanges 是 `{ user, reply }` 数组（旧→新）。
 * @param deps - `{ createUserMessage, BlockAssembler, sessionId, timeoutMs }`。
 * @returns 原始条目数组 `{ key, value, quote, confidence }`。
 */
export async function llmInfer(llm, route, input, deps) {
  const { createUserMessage, BlockAssembler, sessionId, timeoutMs = 20000 } = deps
  const dialogue = (input.exchanges ?? [])
    .map((turn) => `用户：${stripSpeakerLabel(turn.user)}\n她的回应：${turn.reply || '（无）'}`)
    .join('\n')
  const prompt = [
    `【她当前的设定】${describeCard(input.card)}`,
    '',
    '【最近对话】',
    dialogue,
    '',
    '【任务】只输出 JSON：从上面的对话里推断需要调整的设定。没有依据就 {"traits":[]}。',
  ].join('\n')

  /**
   * 跑一次流式补全，收回全部块。
   * @returns `{ text, kinds }`；kinds 是块类型清单，空回答时用来判断
   *   是不是"推理块把额度吃光了"（实跑遇到过 0 字返回）。
   */
  const streamOnce = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system: INFER_SYSTEM,
        messages: [createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'companion-persona' },
        })],
        maxTokens: 1200,
        temperature: 0,
        sessionId,
        signal: controller.signal,
      })) {
        assembler.push(chunk)
      }
      const blocks = assembler.blocks()
      return {
        text: blocks.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        kinds: blocks.map((block) => block.type),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // 空回答重试一次：这个模型的空返回是偶发的（同一条 prompt 重发就有了），
  // 而"推断停更"是静默故障，值得多花一次调用。
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, kinds } = await streamOnce()
    if (text.trim() === '') {
      lastError = new Error(`模型返回空文本（块类型：${kinds.join(',') || '无'}）`)
      continue
    }
    const traits = parseInference(text)
    if (traits === undefined) {
      throw new Error(`模型输出不是可解析的 JSON（${String(text.length)} 字 / 块类型 ${kinds.join(',') || '无'}）：${text.slice(0, 160)}`)
    }
    return traits
  }
  throw lastError
}

/**
 * 抢救式解析：把文本里**每一个完整的** `{...}` 对象抠出来。
 *
 * 为什么需要：实跑遇到过两种坏输出——模型返回空文本、以及回答被 maxTokens 截断
 *（`{"traits":[{...},{...` 半截）。截断时前半段那几条是完好的，丢掉整轮太浪费：
 * 从"一次挂了就什么都不学"变成"学到几条是几条"。
 * @param text - 模型原文。
 * @returns 含字符串 key 的对象数组。
 */
function salvageTraits(text) {
  const out = []
  const stack = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') { stack.push(i); continue }
    if (ch !== '}') continue
    const start = stack.pop()
    if (start === undefined) continue
    try {
      const item = JSON.parse(text.slice(start, i + 1))
      if (item !== null && typeof item === 'object' && typeof item.key === 'string') out.push(item)
    } catch {
      /* 这一个对象坏了就丢它，别拖累其它 */
    }
  }
  return out
}

/**
 * 解析模型返回的 JSON。宽容地取第一个 `{...}`；整体解析失败时走抢救路径。
 * **不做内容层校验**——那是 validateTraits 的事。
 * @param raw - 模型原文。
 * @returns 条目数组，解析失败返回 undefined。
 */
export function parseInference(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('{')
  if (start < 0) return undefined
  const end = text.lastIndexOf('}')
  if (end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(parsed?.traits)) return parsed.traits
    } catch {
      /* 落到抢救路径 */
    }
  }
  const salvaged = salvageTraits(text)
  return salvaged.length > 0 ? salvaged : undefined
}

/**
 * 决定一条新推断怎么落到已有的行上。**这是"谁说了算"和"多久才改一次"的地方。**
 *
 * 三条规则，按顺序：
 *  ① 用户的显式指令（source='rule'）> 模型推断（source='llm'）。
 *     实跑踩过：用户说了"我不开心的时候你就听着就行"（规则通道 → comfort=stay），
 *     下一轮 LLM 从同一句话里推出 comfort=listen 就把它盖掉了——他明说过的要求被
 *     模型悄悄改回去，是最不能接受的一类回归。
 *  ② 同值只"加固"（reinforce）：samples+1，但不更新值、不打日志、不广播。
 *     第一版同值也走"已更新"，于是每轮推断都在日志里刷一行没变化的"变更"。
 *  ③ 值要变 → 过**迟滞（hysteresis）**：模型推断必须同时满足
 *     · 置信度 ≥ 现有置信度 + 余量（封顶 0.95，避免强先验把维度永久冻住）
 *     · 距上次改动 ≥ 最小变更间隔
 *     依据：设定抖动来自"同一段对话被模型判了两次、两次都不算强"，
 *     这是恒温器式的经典问题——死区（余量）+ 最小循环时间（间隔）就能压住。
 *     代价是"迟滞 vs 迟钝"：模型发现他口味变了，最多晚一个间隔才落地。
 *     可接受，因为**用户明说的走规则通道，立刻生效，不受迟滞约束**——
 *     这条把"迟钝"限制在"她自己的猜测"上，不波及"他亲口提的要求"。
 * @param previous - 库里已有的那一行（可能没有）。
 * @param incoming - 本次推断。
 * @param options - `{ confidenceMargin, minChangeIntervalMs, now }`。
 * @returns `{ action: 'write'|'reinforce'|'skip', value, samples, reason }`。
 */
export function mergeTrait(previous, incoming, options = {}) {
  const margin = Number(options.confidenceMargin ?? 0.1)
  const minChangeIntervalMs = Number(options.minChangeIntervalMs ?? 600_000)
  const now = Number(options.now ?? Date.now())

  if (previous === undefined) return { action: 'write', value: incoming.value, samples: 1, reason: '首次观察' }
  if (previous.source === 'rule' && incoming.source === 'llm') {
    return { action: 'skip', reason: `已被用户的显式指令定下（证据「${String(previous.evidence)}」），模型推断不覆盖` }
  }

  // 列表型：只并集、只增长，天然不抖。一次模型抖动也不该抹掉已攒下的条目。
  if (Array.isArray(incoming.value) && Array.isArray(previous.value)) {
    const merged = [...previous.value]
    for (const item of incoming.value) if (!merged.includes(item)) merged.push(item)
    if (merged.length === previous.value.length) {
      return { action: 'reinforce', value: previous.value, samples: previous.samples + 1 }
    }
    return { action: 'write', value: merged, samples: previous.samples + 1, reason: `新增 ${merged.length - previous.value.length} 项` }
  }

  if (JSON.stringify(previous.value) === JSON.stringify(incoming.value)) {
    return { action: 'reinforce', value: previous.value, samples: previous.samples + 1 }
  }

  // 他亲口改的主意：立刻生效，不受迟滞约束。
  if (incoming.source === 'rule') return { action: 'write', value: incoming.value, samples: 1, reason: '用户的显式指令' }

  const required = Math.min(0.95, Number(previous.confidence) + margin)
  if (Number(incoming.confidence) < required) {
    return {
      action: 'skip',
      reason: `想改 ${formatValue(previous.value)} → ${formatValue(incoming.value)}，但置信度 ${Number(incoming.confidence).toFixed(2)} 没到 ${required.toFixed(2)}（现有 ${Number(previous.confidence).toFixed(2)} + 余量 ${margin}）`,
    }
  }
  const elapsed = now - Number(previous.updatedAt ?? 0)
  if (elapsed < minChangeIntervalMs) {
    return {
      action: 'skip',
      reason: `想改 ${formatValue(previous.value)} → ${formatValue(incoming.value)}，但距上次改动只过了 ${Math.round(elapsed / 1000)}s，短于最小变更间隔 ${Math.round(minChangeIntervalMs / 1000)}s`,
    }
  }
  return { action: 'write', value: incoming.value, samples: 1, reason: '置信度与间隔都过关' }
}

/** 把维度值渲染成一行可读文本（日志与拒绝理由共用）。 */
export function formatValue(value) {
  return Array.isArray(value) ? `[${value.join('/')}]` : String(value)
}

/**
 * 比较前后两次的推断，只描述**变了哪几项**。
 *
 * 为什么不让调用方直接打整张卡：任何一个维度一变就会重打全卡，
 * 日志里看起来像"人设一直在变"，实际只动了一项（实跑被这么误读过一次）。
 * @param previous - 上一次的 `card.inferred`（可为空）。
 * @param next - 本次的 `card.inferred`。
 * @returns 变更描述；无变化返回空串。
 */
export function describeTraitChanges(previous, next) {
  const before = new Map((previous ?? []).map((trait) => [trait.key, trait.value]))
  const after = new Map((next ?? []).map((trait) => [trait.key, trait.value]))
  const parts = []
  for (const [key, value] of after) {
    if (!before.has(key)) parts.push(`${key}=${formatValue(value)}（新增）`)
    else if (JSON.stringify(before.get(key)) !== JSON.stringify(value)) parts.push(`${key} ${formatValue(before.get(key))} → ${formatValue(value)}`)
  }
  for (const [key, value] of before) {
    if (!after.has(key)) parts.push(`${key} 回到基线（原 ${formatValue(value)}）`)
  }
  return parts.join('；')
}

/**
 * 把推断结果叠到人设卡上。
 *
 * 不在库里存"合并后的卡"，而是每次读时现叠：这样既保住了老库里的原始卡片
 *（用户手填过的、问卷留下的都还在），又保证推断一改就生效、还能整体撤销。
 * @param base - 库里的人设卡（可能是老问卷卡，也可能没有）。
 * @param traits - 推断出的维度行。
 * @returns 生效的人设卡。
 */
export function composePersona(base, traits = []) {
  const card = { ...(base ?? {}) }
  const applied = []
  for (const trait of traits) {
    const spec = TRAITS[trait.key]
    if (spec === undefined) continue
    switch (trait.key) {
      case 'name':
      case 'callUser':
        card[trait.key] = trait.value
        break
      case 'tone': card.tone = TONE_TEXT[trait.value]; break
      case 'replyLength': card.replyLength = LENGTH_TEXT[trait.value]; break
      case 'emoji': card.emoji = EMOJI_TEXT[trait.value]; break
      case 'comfort': card.comfort = COMFORT_TEXT[trait.value]; break
      case 'warmthCeiling':
      case 'affectionFrequency':
      case 'dailyCap':
      case 'proactiveOn':
      case 'memoryOn':
      case 'memoryScope':
        card[trait.key] = trait.value
        break
      case 'taboos':
        card.taboos = (trait.value ?? []).map((t) => `不要主动提起：${t}`)
        break
      case 'careTopics':
        card.careTopics = [...(trait.value ?? [])]
        break
      case 'preferences':
        card.preferences = [...(trait.value ?? [])]
        break
      default:
        break
    }
    applied.push({ key: trait.key, value: trait.value, evidence: trait.evidence, confidence: trait.confidence, source: trait.source })
  }
  // `inferred` 只服务于"看得见"（日志、/companion/persona 排查口），不参与渲染。
  card.inferred = applied
  return card
}

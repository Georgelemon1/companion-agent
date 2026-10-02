// companion 情绪评价（appraisal）—— 决定"她对我这句话是什么反应"。
//
// 双通道：
//   ① 本地词表启发式：零延迟、零成本、可预测。每一条用户消息立即生效。
//   ② LLM 精评：可读反讽/间接表达，但会给每个回合加一次模型调用延迟。
//      默认**关闭**（架构方案 §5.1 的务实取舍：先跑通零成本通道，再按体感开）。
//
// 本地通道还负责产出**关系信号**：用户待她的态度 + 自我披露程度。

import { EMOTIONS, EMOTION_LABELS } from './state.js'

/**
 * 情绪词表。命中即给出该情绪的基量增量。
 *
 * 标定原则（踩过坑）：**一次普通消息不应把情绪顶到 8+**。
 * 强度刻度是 0–10，其中 3 以下=淡淡的、3–6=明显、6+=很强烈；
 * 因此一条真诚的暖话给到 4–6 是合适的，只有极端表达才该接近 8。
 * 过高的基量会让情绪失去区分度，"连续说同一件事强度递减"也就看不出来了。
 */
const LEXICON = [
  // ── 开心 ──
  { re: /(哈哈|嘿嘿|嘻嘻|笑死|太好|好开心|开心|高兴|爽|棒|不错|赞|喜欢|爱你|太可爱|好可爱)/g, deltas: { joy: 1.3, affection: 0.5 } },
  // ── 难过 ──
  { re: /(难过|伤心|哭|想哭|委屈|低落|沮丧|郁闷|难受|心里堵|emo|情绪不好)/g, deltas: { sadness: 1.5 } },
  // ── 失败 / 挫败（口语高频：挂了、没过、被拒、搞砸、黄了） ──
  { re: /(挂了|没过|没通过|被拒|搞砸|砸了|黄了|凉了|失败|考砸|面试.*没|被刷)/g, deltas: { sadness: 1.6, fear: 0.5 } },
  // ── 自我否定（比"难过"更需要被接住，且会伤到自己） ──
  { re: /(觉得自己不行|我不行|我真没用|我很差|配不上|没资格|一无是处|自我怀疑|我很废|我是废物)/g, deltas: { sadness: 1.8, fear: 0.8 } },
  // ── 睡眠 / 身体耗竭（口语说法多） ──
  { re: /(睡不着|失眠|睡不好|熬夜|多梦|做噩梦|头疼|胃疼|没胃口|吃不下|身体垮|很虚)/g, deltas: { fear: 1.0, sadness: 1.0 } },
  // ── 生气 ──
  // 注意包含"被骂/好烦/烦"这类日常抱怨：它们是最高频的负面表达之一，
  // 早期只写了"烦死"导致「今天被老板骂了，好烦」漏判（由 coverage.mjs 抓出）。
  { re: /(生气|愤怒|讨厌|烦死|好烦|很烦|烦躁|真烦|气死|火大|被骂|挨骂|骂了|滚|闭嘴|垃圾|傻|蠢|笨死)/g, deltas: { anger: 1.3, hurt: 0.7 } },
  // ── 不安 / 压力 ──
  { re: /(焦虑|紧张|害怕|担心|慌|压力|deadline|截止|来不及|失眠|睡不着|撑不住|累死|好累|疲惫)/g, deltas: { fear: 1.2, sadness: 0.6 } },
  // ── 惊讶 ──
  { re: /(真的假的|不会吧|竟然|居然|天啊|天哪|震惊|没想到|卧槽|我去)/g, deltas: { surprise: 1.5 } },
  // ── 心动 / 亲密表达 ──
  { re: /(想你|想我|抱抱|摸摸|亲亲|宝贝|亲爱的|老婆|老公|喜欢你|爱你|心动|甜|好乖|乖)/g, deltas: { affection: 1.6, joy: 0.6 } },
  // ── 受伤（指向她的负面评价） ──
  { re: /(你不行|真没用|好烦你|不想理你|讨厌你|你走开|别烦我|你懂什么|笨死了你)/g, deltas: { hurt: 1.7, sadness: 0.9 } },
  // ── 平静 / 安抚 ──
  { re: /(没事|没关系|别担心|冷静|慢慢来|深呼吸|我陪你|陪你|不急|放轻松)/g, deltas: { calm: 1.4, joy: 0.3 } },
  // ── 道谢 / 认可（对她好） ──
  { re: /(谢谢|谢了|感谢|辛苦|多亏|有你在|幸好有你|你真好|你最懂)/g, deltas: { joy: 1.0, affection: 0.9 } },
  // ── 孤独 / 求陪 ──
  { re: /(一个人|孤独|寂寞|没人|好无聊|陪陪我|陪我聊|在吗|在不在)/g, deltas: { affection: 1.0, sadness: 0.5 } },
]

/** 自我披露的线索：用户在讲自己的事， intimacy 应随之上升。 */
const DISCLOSURE_PATTERNS = [
  /我(今天|昨天|明天|最近|刚才|现在|一直|总是|从来)/g,
  /我(觉得|感觉|认为|发现|意识到|明白)/g,
  /我(的|家|妈|爸|爸|哥|姐|弟|妹|工作|同事|老板|朋友|猫|狗)/g,
  /我(想|要|打算|计划|决定|准备)/g,
  /我(小时候|以前|大学|高中|曾经)/g,
]

/** 亲密表达（用于关系正信号，与情绪分开算）。 */
const WARMTH_PATTERNS = [
  /(喜欢你|爱你|想你|在乎你|你很重要)/g,
  /(谢谢|感谢|辛苦|多亏|有你在)/g,
  /(你真|你最|你好)(好|棒|懂|温柔|可爱|贴心)/g,
  /(抱抱|摸摸|亲亲|贴贴)/g,
]

/** 伤害表达（关系负信号）。 */
const HARM_PATTERNS = [
  /(你不行|真没用|好烦你|不想理你|讨厌你|别烦我|你懂什么|笨死)/g,
  /(滚|闭嘴|垃圾|废物)/g,
]

/** 否定词：出现在情绪词前会翻转极性。 */
const NEGATION = /(不|没|别|无|未|不是|不太|没有)$/

/**
 * 统计一个正则的命中次数。
 * @param re - 带 g 标志的正则。
 * @param text - 待匹配文本。
 * @returns 命中次数。
 */
function countMatches(re, text) {
  re.lastIndex = 0
  let count = 0
  while (re.exec(text) !== null) {
    count += 1
    if (count > 20) break
  }
  return count
}

/**
 * 单条词表项在一次消息里的最大计入次数。
 * 需要封顶的原因：「开心」「喜欢」「谢谢」这类词很容易在一句话里反复出现，
 * 若不封顶，一条普通消息就能把情绪推到 9+，情绪就失去了区分度。
 */
const MAX_HITS_PER_ENTRY = 2

/**
 * 字符二元组 Jaccard 相似度，用于判断"这条消息是不是刚说过的那句"。
 * 刻意用最朴素的做法：只为复读检测服务，不需要语义模型。
 * @param a - 文本 A。
 * @param b - 文本 B。
 * @returns 0…1 的相似度。
 */
export function similarity(a, b) {
  if (a === b) return 1
  const grams = (s) => {
    const set = new Set()
    const clean = s.replace(/[\s，。！？~、,.!?]/g, '')
    for (let i = 0; i + 2 <= clean.length; i++) set.add(clean.slice(i, i + 2))
    return set
  }
  const ga = grams(a)
  const gb = grams(b)
  if (ga.size === 0 || gb.size === 0) return 0
  let shared = 0
  for (const g of ga) if (gb.has(g)) shared += 1
  return shared / (ga.size + gb.size - shared)
}

/**
 * 复读检测：最近的用户消息里若有高度相似的，说明他在重复同一件事。
 *
 * 为什么需要：人不会因为同一件事被讲第二遍就更激动。
 * 没有这一层，"我今天好开心"连说三遍会让 joy 从 1.3 一路爬到 3.9，
 * 与"情绪连续性"的直觉相悖，也让她显得没有记忆。
 * @param text - 本次用户消息。
 * @param recent - 最近的用户消息列表（由新到旧）。
 * @param threshold - 判定为重复的相似度阈值。
 * @returns 0…1 的新意系数，1 表示全新内容。
 */
export function novelty(text, recent, threshold = 0.7) {
  let repeats = 0
  for (const previous of recent.slice(0, 3)) {
    if (similarity(text, previous) >= threshold) repeats += 1
  }
  // 幂次衰减，但**不归零**：第一次复读 ×0.45，之后每多一次再 ×0.45，下限 0.25。
  //
  // 为什么要设下限：早期版本衰减到 0.06，导致同一句真心话第 4 遍之后情绪完全不动
  //（P5 回归实测：2.10 → 0.04 → 0.00 → 0.00…）。人对重复的亲密表达是**钝化**而非**失聪**——
  // 她说"听五遍也不腻"比"第五遍我毫无波澜"更自然。
  return repeats === 0 ? 1 : Math.max(0.25, 0.45 ** repeats)
}

/**
 * 本地启发式评价：从一条用户消息算出情绪增量与关系信号。
 *
 * 做法是先扫词表累加原始增量，再对"否定用法"做修正（如「不开心」不该给 joy）。
 * @param text - 用户消息的纯文本。
 * @returns 情绪增量、关系信号、披露度、以及命中的标签（便于调试与前端展示）。
 */
export function heuristicAppraise(text, recent = []) {
  const deltas = {}
  const hits = []

  for (const entry of LEXICON) {
    entry.re.lastIndex = 0
    let match
    let used = 0
    while ((match = entry.re.exec(text)) !== null) {
      const before = text.slice(Math.max(0, match.index - 2), match.index)
      const negated = NEGATION.test(before)
      // 同一词表项最多计入 MAX_HITS_PER_ENTRY 次；超出只记录命中，不再累加。
      const counts = used < MAX_HITS_PER_ENTRY
      if (counts) used += 1
      for (const [label, amount] of Object.entries(entry.deltas)) {
        // 被否定的正性情绪降权并转成轻微负性，反之亦然。
        const signed = negated && (label === 'joy' || label === 'affection' || label === 'calm')
          ? -amount * 0.6
          : amount
        deltas[label] = (deltas[label] ?? 0) + (counts ? signed : 0)
      }
      hits.push(match[0])
    }
  }

  // 关系信号：善意 − 伤害，钳制到 −1…1。
  let warmth = 0
  for (const re of WARMTH_PATTERNS) warmth += Math.min(MAX_HITS_PER_ENTRY, countMatches(re, text)) * 0.5
  let harm = 0
  for (const re of HARM_PATTERNS) harm += Math.min(MAX_HITS_PER_ENTRY, countMatches(re, text)) * 0.7
  const signal = Math.max(-1, Math.min(1, warmth - harm))

  // 披露度：命中越多类披露线索，说明他越在讲自己的事。
  let disclosureHits = 0
  for (const re of DISCLOSURE_PATTERNS) disclosureHits += Math.min(1, countMatches(re, text))
  const disclosure = Math.min(1, disclosureHits / 3)

  // 长消息本身也是投入的信号（愿意多打字的用户值得多一点 intimacy）。
  if (text.length > 80) {
    deltas.affection = (deltas.affection ?? 0) + 0.4
  }

  // 单条消息对每种情绪的贡献封顶，避免一句话就顶满。
  for (const [label, value] of Object.entries(deltas)) {
    deltas[label] = Math.max(-4, Math.min(4, value))
  }

  // 新意衰减：重复同一件事时情绪不该继续累积（人对复读的情绪反应是钝化的）。
  const noveltyFactor = novelty(text, recent)
  if (noveltyFactor < 1) {
    for (const [label, value] of Object.entries(deltas)) {
      deltas[label] = value * noveltyFactor
    }
  }
  // 复读同样不该无限加固关系（否则刷同一句话就能涨 intimacy）。
  const sig = clampSignal(signal * noveltyFactor)

  return { deltas, signal: sig, disclosure, hits, novelty: noveltyFactor }
}

/** 把关系信号钳制到 −1…1。 */
function clampSignal(value) {
  return Math.max(-1, Math.min(1, value))
}

/** 精评用的 system 提示词：只输出 JSON，不给解释。 */
const APPRAISAL_SYSTEM = `你是一个情绪评价器。给你一段用户对"伴侣角色"说的话，你要判断这句话会在**伴侣角色心里**激起什么情绪。

规则：
- 输出严格的 JSON，不要任何解释、不要 markdown 代码块。
- 情绪标签只能从这个集合里选：${EMOTIONS.join(', ')}
- 每项是增量，范围 -4 到 +4。正数表示该情绪被激起，负数表示被平复。
- 只写非零项。若无明显情绪波动，输出 {"calm": 0.5}。
- "signal" 是用户对伴侣角色的态度：-1（伤害/贬低）到 1（善意/亲密），0 为中性。
- "disclosure" 是用户自我披露的程度：0（没讲自己的事）到 1（讲了很多私人的事）。
- 注意反讽、玩笑、言不由衷：「我才不想你呢」实际是亲密表达。`

/**
 * 解析 LLM 返回的 JSON，做严格校验。
 * @param raw - 模型原文。
 * @returns 归一化后的评价结果，解析失败返回 undefined。
 */
function parseAppraisal(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  const deltas = {}
  for (const [label, value] of Object.entries(parsed)) {
    if (label === 'signal' || label === 'disclosure') continue
    if (!EMOTIONS.includes(label)) continue
    const num = Number(value)
    if (!Number.isFinite(num) || num === 0) continue
    deltas[label] = Math.max(-4, Math.min(4, num))
  }
  return {
    deltas,
    signal: Number.isFinite(Number(parsed.signal)) ? Math.max(-1, Math.min(1, Number(parsed.signal))) : 0,
    disclosure: Number.isFinite(Number(parsed.disclosure)) ? Math.max(0, Math.min(1, Number(parsed.disclosure))) : 0,
  }
}

/**
 * LLM 精评一个回合。失败一律返回 undefined，由调用方回退到本地通道结果。
 * @param llm - ctx.llm 服务。
 * @param route - { provider, model }。
 * @param input - 用户消息、她的回复、当前情绪状态。
 * @param deps - { createUserMessage, BlockAssembler, sessionId, timeoutMs }。
 * @returns 评价结果或 undefined。
 */
export async function llmAppraise(llm, route, input, deps) {
  const { createUserMessage, BlockAssembler, sessionId, timeoutMs = 20000 } = deps
  const stateDigest = Object.entries(input.emotions)
    .map(([label, value]) => `${EMOTION_LABELS[label] ?? label}=${Number(value).toFixed(1)}`)
    .join('、') || '平静'
  const prompt = [
    `【伴侣角色当前情绪】${stateDigest}`,
    `【用户这次说】${input.userText}`,
    `【伴侣角色的回应】${input.replyText || '（无）'}`,
  ].join('\n')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const assembler = new BlockAssembler()
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      system: APPRAISAL_SYSTEM,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'companion-affect' },
      })],
      maxTokens: 220,
      temperature: 0,
      sessionId,
      signal: controller.signal,
    })) {
      assembler.push(chunk)
    }
    const text = assembler.blocks()
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    return parseAppraisal(text)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

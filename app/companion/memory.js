// companion-memory 的事实抽取 —— 把用户说的话变成可检索、可主动提起的卡片。
//
// 双通道，与情绪评价同构：
//   ① 本地规则：零延迟零成本。靠句式（"我喜欢的/我叫/我养了/我下周要"）抽取结构化事实。
//   ② LLM 抽取：能读懂"随口一提"的隐含事实，但每回合多一次模型调用。默认关闭。
//
// 为什么用事实卡片而不是纯向量：主动提起一件事要同时满足
// 「内容相关 + 够重要 + 有段时间没提」（见架构方案 §3 调研结论），
// 纯向量只能解决第一项。

/**
 * 抽取到的实体类别。类别决定它在提示词里怎么被叙述，
 * 也决定"该不该主动提起"的权重起点。
 */
export const SUBJECTS = {
  identity: '关于他是谁',
  preference: '他的喜好',
  pet: '他的宠物',
  family: '他的家人',
  work: '他的工作或学业',
  plan: '他的计划或约定',
  event: '他经历的事',
  feeling: '他在意的事',
}

/**
 * 本地抽取规则。
 *
 * 每条规则：`about` 类别、`re` 带命名组的正则、`weight` 重要度起点。
 * 用命名组 `(?<x>...)` 把要记的内容直接圈出来，避免再写一层解析。
 */
const RULES = [
  // 喜好：喜欢的 / 最爱 / 讨厌
  {
    about: 'preference',
    weight: 7,
    re: /我(?:最|很|超|特别)?(?:喜欢|爱|最爱)(?<x>[^，。！？,.!?\n]{1,24})/g,
    render: (m) => `他喜欢${m}`,
  },
  {
    about: 'preference',
    weight: 6,
    re: /我(?:最)?(?:讨厌|不喜欢|受不了)(?<x>[^，。！？,.!?\n]{1,24})/g,
    render: (m) => `他讨厌${m}`,
  },
  // 身份：名字 / 年龄 / 城市
  {
    about: 'identity',
    weight: 9,
    re: /我(?:叫|的名字是|名字叫)\s*(?<x>[^，。！？,.!?\n]{1,16})/g,
    render: (m) => `他叫${m}`,
  },
  {
    about: 'identity',
    // 允许 "我今年 28 岁" 这类带空格的写法。
    weight: 7,
    re: /我\s*(?:今年)?\s*(?<x>\d{1,2})\s*岁/g,
    render: (m) => `他今年${m}岁`,
  },
  {
    about: 'identity',
    weight: 7,
    re: /我(?:住在|在|来自)\s*(?<x>[^，。！？,.!?\n]{2,12}?)(?:上班|工作|读书|住|生活|，|。|$)/g,
    render: (m) => `他在${m}`,
  },
  // 宠物
  // 覆盖四种自然说法：我养了一只猫叫X / 我养了猫叫X / 我有只狗叫X / 我的猫叫X。
  // 踩过两次坑：① name 组没被读取；② 补"养了/有"分支时把"我的"分支改丢了。
  {
    about: 'pet',
    weight: 8,
    re: /我(?:(?:养了|有)\s*(?:一?只)?|的\s*)(?<kind>猫|狗|仓鼠|兔子|鸟)\s*(?:叫|名叫|名字叫|是)?\s*(?<name>[^，。！？,.!?\n]{0,10})/g,
    render: (m, groups) => groups.name ? `他养了一只${groups.kind}叫${groups.name}` : `他养了${groups.kind}`,
  },
  // 家人
  {
    about: 'family',
    weight: 7,
    re: /我(?<who>妈|爸|妈妈|爸爸|哥|姐|弟|妹|老婆|老公|女朋友|男朋友|儿子|女儿)(?<x>[^，。！？,.!?\n]{0,20})/g,
    render: (m, groups) => `他提到${groups.who}${groups.x ?? ''}`,
  },
  // 工作 / 学业
  {
    about: 'work',
    weight: 7,
    re: /我(?:在|是)(?<x>[^，。！？,.!?\n]{2,16}?)(?:上班|工作|实习|读书|上学)/g,
    render: (m) => `他在${m}${''}`,
  },
  {
    about: 'work',
    weight: 8,
    // 关键：**不能要求以"我"开头**。中文里主语常省略，"下周要去面试"是自然说法。
    // 第一版强制 `我` 开头，导致这类最值得提醒的计划全部漏抽。
    re: /(?<when>下周[一二三四五六日天]?|下个月|明天|后天|这周[一二三四五六日天]?|周末)?\s*(?:要去|要|得去|得|准备|打算|即将|马上)?\s*(?<x>面试|考试|答辩|汇报|出差|体检|复诊|搬家|入职|报到)/g,
    render: (m, groups) => groups.when ? `他${groups.when}要${groups.x}` : `他提到要${groups.x}`,
  },
  // 计划 / 约定
  {
    about: 'plan',
    weight: 8,
    re: /我(?:打算|计划|准备|想要|决定|约定)(?<x>[^，。！？,.!?\n]{1,26})/g,
    render: (m) => `他打算${m}`,
  },
  {
    about: 'plan',
    weight: 9,
    re: /我(?<when>下周[一二三四五六日天]|下个月|明天|后天|这周[一二三四五六日天]|下个?月\d+[号日])(?<x>[^，。！？,.!?\n]{1,24})/g,
    render: (m, groups) => `他${groups.when}要${m}`,
  },
  // 经历
  {
    about: 'event',
    weight: 6,
    re: /我(?:今天|昨天|前天|上周|刚才|刚刚)(?<x>[^，。！？,.!?\n]{2,26})/g,
    render: (m, groups) => `他${groups['0']?.startsWith('我') ? '' : ''}${m}`,
  },
  // 在意的事 / 情绪来源
  // 允许**叠用**时间副词（"我最近一直睡不好"）并容忍空格。
  // 第一版只允许一个副词，漏掉了最常见的这种叠用说法。
  {
    about: 'feeling',
    weight: 8,
    re: /我(?:(?:最近|一直|总是|这几天|这阵子)\s*)+(?<x>(?:睡不好|失眠|很累|压力大|焦虑|不开心|emo|没动力|撑不住|想辞职|很迷茫)[^，。！？,.!?\n]{0,14})/g,
    render: (m) => `他最近${m}`,
  },
]

/** 从一句话里生成关键词（供召回匹配用）。中文没有词边界，取 2–4 字的片段。 */
function keywordsOf(text) {
  const clean = String(text ?? '').replace(/[\s，。！？、,.!?~"'（）()【】]/g, '')
  const out = new Set()
  for (let size = 2; size <= 4; size++) {
    for (let i = 0; i + size <= clean.length; i++) {
      out.add(clean.slice(i, i + size))
    }
  }
  return [...out]
}

/**
 * 合并两组关键词并去重、限量。
 *
 * 限量是因为关键词会写进 SQLite 并被召回扫描；无节制地堆 2–4 字片段
 * 会让扫描成本随消息长度平方增长。
 * @param lists - 若干关键词数组。
 * @param limit - 上限。
 * @returns 去重后的关键词数组。
 */
function mergeKeywords(...lists) {
  const merged = new Set()
  for (const list of lists) {
    for (const keyword of list ?? []) {
      if (keyword.length >= 2) merged.add(keyword)
      if (merged.size >= 300) break
    }
  }
  return [...merged]
}

/**
 * 本地抽取事实卡片。
 * @param messages - 本回合用户说的话（数组，会拼成一段）。
 * @returns 卡片数组 `{ subject, content, keywords, importance }`。
 */
export function extractFacts(messages) {
  const text = Array.isArray(messages) ? messages.join('\n') : String(messages ?? '')
  const found = []
  const seen = new Set()

  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let match
    while ((match = rule.re.exec(text)) !== null) {
      const groups = match.groups ?? {}
      // 内容可能落在不同命名组里（x / name / kind），逐个兜底。
      // 第一版只读 groups.x，宠物规则用的是 groups.name，于是整条被静默跳过。
      const inner = groups.x ?? groups.name ?? groups.kind ?? ''
      if (typeof inner !== 'string' || inner.trim().length === 0) continue
      const content = rule.render(inner.trim(), groups).trim()
      const key = `${rule.about}|${content}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({
        subject: rule.about,
        content,
        // 关键词取自**完整命题 + 原句命中片段**，而不只是被捕获的那个词。
        //
        // 为什么：P5 召回回归发现，只用捕获片段时「他叫阿哲」的关键词里没有"叫"，
        // 于是问"我叫什么来着"召回为空（8 次提问里 2 次全空、平均仅召回 0.8 条）。
        // 把命题本身与整句上下文一起纳入关键词，覆盖面立刻上来。
        keywords: mergeKeywords(keywordsOf(content), keywordsOf(match[0])),
        importance: rule.weight,
      })
      if (found.length >= 12) break
    }
  }

  // 自我披露多、或消息很长时，把整句也存一张低重要度的卡，
  // 保证"他讲过的事"至少有一条可检索的记录。
  if (text.trim().length >= 30) {
    const content = `他说过：${text.trim().slice(0, 60)}`
    const key = `event|${content}`
    if (!seen.has(key)) {
      found.push({ subject: 'event', content, keywords: keywordsOf(text), importance: 4 })
    }
  }

  return found
}

/** LLM 抽取用的 system 提示词。 */
const EXTRACT_SYSTEM = `你是一个记忆抽取器。给你一段用户对伴侣角色说的话，请抽取出**值得长期记住**的事实，输出严格 JSON。

规则：
- 只输出 JSON 数组，不要解释、不要 markdown 代码块。
- 每项形如 {"subject": "...", "content": "...", "importance": 1-10}
- subject 只能是这些之一：${Object.keys(SUBJECTS).join(', ')}
- content 用第三人称陈述，简短（不超过 30 字），例如「他养了一只猫叫豆豆」「他下周要面试」。
- importance：9-10=身份/重要约定，7-8=喜好/家人/重要计划，5-6=日常经历，1-4=随口一提。
- 只记**关于用户本人**的稳定事实或未来事件。不要记寒暄、不要记你自己说过的话。
- 没有值得记的就输出 []。`

/**
 * 解析 LLM 返回的卡片数组，逐项做严格校验。
 * @param raw - 模型原文。
 * @returns 卡片数组，解析失败返回 undefined。
 */
function parseFacts(raw) {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return undefined
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const out = []
  for (const item of parsed) {
    const subject = String(item?.subject ?? '')
    const content = String(item?.content ?? '').trim()
    if (!Object.hasOwn(SUBJECTS, subject) || content === '') continue
    const importance = Math.max(1, Math.min(10, Math.round(Number(item?.importance) || 5)))
    out.push({ subject, content, keywords: keywordsOf(content), importance })
    if (out.length >= 12) break
  }
  return out
}

/**
 * LLM 事实抽取。失败一律返回 undefined，由调用方回退到本地结果。
 * @param llm - ctx.llm 服务。
 * @param route - { provider, model }。
 * @param input - { userText, replyText }。
 * @param deps - { createUserMessage, BlockAssembler, sessionId, timeoutMs }。
 * @returns 卡片数组或 undefined。
 */
export async function llmExtractFacts(llm, route, input, deps) {
  const { createUserMessage, BlockAssembler, sessionId, timeoutMs = 20000 } = deps
  const prompt = [
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
      system: EXTRACT_SYSTEM,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'companion-memory' },
      })],
      maxTokens: 500,
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
    return parseFacts(text)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

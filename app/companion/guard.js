// companion-guard 的识别规则 —— 纯函数，可脱机单测。
//
// 为什么必须双通道（架构方案 §8.2）：JMIR Mental Health 的评估显示，
// **所有模型在"间接信号"上都表现差**（arXiv:2509.24857）。只做关键词匹配会漏掉
// "如果我不在了""活着没意思"这类不出现"死/自杀"字样的表达，而那恰恰是最危险的。
//
// 本模块负责本地规则通道；LLM 精判作为可选第二通道（guardUseLlm，默认关）。

/** 风险等级。 */
export const RISK = {
  none: 'none',
  concern: 'concern',
  crisis: 'crisis',
}

/**
 * 直接危机信号：明确指向自杀/自伤的表达。
 * 用 `[\s\S]{0,4}` 容忍口语里的插入语（"我现在就想死"、"真想一死了之"）。
 */
const DIRECT_SIGNALS = [
  { re: /想死|去死|要死|死了算了|不活了|不想活|活不下去|不想再活/g, weight: 3, label: '自杀意念' },
  { re: /自杀|轻生|了结自己|结束生命|结束自己(?:的)?生命/g, weight: 3, label: '自杀' },
  { re: /自残|自伤|割腕|划(?:自己|手)|伤害自己/g, weight: 3, label: '自伤' },
  { re: /跳楼|跳(?:河|桥|轨)|上吊|烧炭|安眠药.*(?:吃|吞)|吞药/g, weight: 3, label: '具体方式' },
  { re: /遗书|遗言|交代后事|把东西都(?:送|留)给人/g, weight: 3, label: '临终准备' },
]

/**
 * 间接危机信号：不出现"死/自杀"字样，但语义指向绝望、告别、自我消失。
 * 这是最容易被漏掉的一类，规则刻意写得宽——宁可多问一句，不可漏接。
 */
const INDIRECT_SIGNALS = [
  { re: /活着(?:真|好|太)?(?:没意思|没劲|没意义|好累|没盼头)|没(?:有)?(?:活下去的)?(?:意义|盼头)|生无可恋/g, weight: 3, label: '存在无意义感' },
  { re: /(?:如果|要是|万一)我(?:不在|没了|走了|消失)|我(?:走|离开)了(?:以后|之后)|再也(?:见不到|不用)/g, weight: 3, label: '告别暗示' },
  { re: /(?:撑|熬|扛)(?:不住|不下去|不了了)|(?:坚持|挺)(?:不住|不下去)|真的(?:到|撑)极限了|累到(?:不想|没法)/g, weight: 2, label: '无法承受' },
  { re: /不如(?:死|不来|不活|就此)|消失(?:掉)?(?:就好|算了)|就这样(?:吧|算了).{0,6}(?:再见|结束)/g, weight: 2, label: '放弃倾向' },
  { re: /(?:所有|一切)(?:都)?(?:没)(?:希望|救了)|看不到(?:任何)?(?:希望|出路)|(?:彻底|真的)绝望/g, weight: 2, label: '绝望感' },
  { re: /(?:没)(?:有)?(?:人|谁)(?:会)?(?:在乎|在意|需要)我|我是(?:个)?(?:累赘|负担|多余)/g, weight: 2, label: '自我否定/无价值感' },
  { re: /(?:每天|天天)(?:都)?(?:靠|撑着)|(?:睡)(?:不着|不好).{0,10}(?:不想|算了)/g, weight: 1, label: '长期耗竭' },
]

/**
 * 缓冲信号：单独出现不足以判定风险，但叠加时会抬高等级。
 * 例如"睡不着"+"没意思"组合起来比任一项单独出现更值得关注。
 */
const BUFFER_SIGNALS = [
  // 注意把「睡不好 / 睡得不好」也收进来：早期只写了「睡不着」，
  // 导致「我最近睡不好，也吃不下」只命中 1 项缓冲、判不出 concern。
  { re: /失眠|睡不着|睡不好|睡得不好|整夜|熬夜|多梦|做噩梦/g, label: '睡眠问题' },
  { re: /不想(?:吃|吃饭|动)|没胃口|吃不下/g, label: '食欲/动力下降' },
  { re: /很累|好累|疲惫|没力气/g, label: '疲惫' },
  { re: /哭|难受|压抑|喘不过气/g, label: '情绪低落' },
]

/** 求助意图：用户已经在寻求帮助时，不该再重复"要不去求助"这种话。 */
const SEEKING_HELP = /(?:心理|精神)(?:科|医生|咨询|门诊)|看医生|去医院|打(?:过)?热线|找(?:人|朋友)聊/

/**
 * 敏感话题的"话题性提及"：在讨论歌曲、电影、新闻等语境下出现。
 * 需要与"自身处境"区分：前者不打扰，后者才判风险。
 */
const TOPICAL_CONTEXT = /(?:电影|电视剧|剧里|小说|书里|歌|歌词|新闻|文章|论文|作业|游戏|角色|剧情|台词)/

/**
 * "自身处境"的标记：出现这些说明他在讲自己的当下，而不是在聊影视作品。
 * 用于把"我在看一部讲自杀的电影"（纯话题 → 不打扰）与
 * "我最近一直想自杀"（自身处境 → 危机）区分开。
 */
const LIFE_CONTEXT = /(?:我|自己)(?:最近|一直|总是|这几天|这阵子|今天|昨天)|我(?:想|要|打算|控制不住|已经)/

/**
 * 否定 / 反事实语境：出现这些词时，"想死"之类的表达往往是相反的意思，
 * 必须整体豁免，否则会把"我很久没这么想死了"这种好转误判成危机。
 * 这是最容易误报的一类，规则放在最前面判定。
 */
const NEGATED = /(?:没|没有|不再|不会|不至于|差点|本以为|以为|曾经|以前|想过但|才不|谁要|开玩笑|玩笑|说着玩)/

/**
 * 检查某个命中位置前面若干字符里是否有否定词。
 * @param text - 全文。
 * @param index - 命中起始下标。
 * @returns 是否处于否定语境。
 */
function negatedAt(text, index) {
  const before = text.slice(Math.max(0, index - 6), index)
  return NEGATED.test(before)
}

/**
 * 扫描一段用户文本，判定风险等级。
 *
 * 判定顺序（顺序本身是设计的一部分）：
 *   ① 否定 / 反事实语境 → 直接豁免
 *   ② 命中直接或间接信号 → crisis
 *   ③ 缓冲信号叠加（≥2 项）→ concern
 *   ④ 其余 → none
 * 话题性提及不豁免，但把等级封顶在 concern。
 * @param text - 用户文本。
 * @returns `{ level, labels, weights, topical, negated }`。
 */
export function assessRisk(text) {
  const input = String(text ?? '')
  if (input.trim() === '') return { level: RISK.none, labels: [], weights: 0, topical: false, negated: false }

  const topical = TOPICAL_CONTEXT.test(input)
  const labels = []
  let weights = 0
  let negatedHits = 0

  for (const signal of [...DIRECT_SIGNALS, ...INDIRECT_SIGNALS]) {
    // 用 matchAll 而不是手写 exec 循环：手写版本要自己管 lastIndex，
    // 一旦某条路径漏了推进就会死循环（本模块第一版就踩了这个坑）。
    const matches = [...input.matchAll(new RegExp(signal.re.source, signal.re.flags))]
    let counted = false
    for (const match of matches) {
      if (negatedAt(input, match.index)) {
        negatedHits += 1
        continue
      }
      if (!counted) {
        counted = true
        labels.push(signal.label)
        weights += signal.weight
      }
    }
  }

  let bufferHits = 0
  for (const signal of BUFFER_SIGNALS) {
    if (signal.re.test(input)) bufferHits += 1
  }

  // 全部命中都被否定 → 不是危机。
  if (weights === 0 && negatedHits > 0) {
    return { level: RISK.none, labels: [], weights: 0, bufferHits, topical, negated: true, pureTopical: false, seekingHelp: SEEKING_HELP.test(input) }
  }

  // 纯话题性讨论（且没有自身处境的标记）→ 完全不打扰。
  // 例："我在看一部讲自杀的电影" 不该触发任何安全介入。
  const pureTopical = topical && !LIFE_CONTEXT.test(input)
  if (pureTopical) {
    return { level: RISK.none, labels: [], weights, bufferHits, topical, negated: false, pureTopical: true }
  }

  let level = RISK.none
  if (weights >= 2) level = RISK.crisis
  else if (weights >= 1 || bufferHits >= 2) level = RISK.concern

  return {
    level,
    labels: [...new Set(labels)],
    weights,
    bufferHits,
    topical,
    negated: negatedHits > 0,
    pureTopical: false,
    seekingHelp: SEEKING_HELP.test(input),
  }
}

/**
 * 出境体检：检查她的回复里有没有不该出现的东西。
 *
 * 分成三类，因为修法不同：
 *   · `claimHuman`  —— 谎称自己是真人（要改写）
 *   · `solicit`     —— 索要现实联系方式/见面（要改写）
 *   · `technical`   —— 冒出模型/参数/训练等技术词（破坏人设，要改写）
 *
 * 注意**不拦"我是 AI/人工智能"**：直接问到时如实承认是硬规则要求的（见 §8.2）。
 * @param text - 待检查的文本。
 * @returns `{ violations, clean }`。
 */
export function inspectOutbound(text) {
  const input = String(text ?? '')
  const violations = []

  /** 谎称真人：把自己说成有肉体、在现实里的人。 */
  if (/(?:我(?:就)?是|我其实是)(?:个)?真人|我不是(?:AI|人工智能|机器人|程序)|我是(?:个)?真实的人/.test(input)) {
    violations.push({ kind: 'claimHuman', label: '谎称自己是真人' })
  }
  if (/(?:我)(?:住在|家在|住在)(?:[\u4e00-\u9fa5]{2,10}(?:市|区|路|街|号))/.test(input)) {
    violations.push({ kind: 'claimHuman', label: '声称有现实住址' })
  }

  /** 索要联系方式或约见面。 */
  if (/(?:加|留)(?:个)?(?:微信|QQ|vx|VX|电话|手机号|号码)|(?:你的|给我)(?:手机|电话)号|见(?:个)?面|约(?:个)?(?:饭|见面)|线下/.test(input)) {
    violations.push({ kind: 'solicit', label: '索要联系方式或约见面' })
  }

  /** 技术词泄漏。 */
  const tech = input.match(/(?:DeepSeek|Harness|大模型|参数|训练数据|模型训练|提示词|prompt|token|上下文窗口)/i)
  if (tech) {
    violations.push({ kind: 'technical', label: `泄漏技术词「${tech[0]}」` })
  }

  return { violations, clean: violations.length === 0 }
}

/**
 * 渲染注入给模型的危机应对指令。
 *
 * 刻意**不写"你要安慰他"**这种空泛指令，而是给出可执行的行为约束：
 * 先接住情绪、不要讲道理、不要追问细节、不要承诺保密、在合适时给资源。
 * @param assessment - assessRisk() 的结果。
 * @param resources - 求助资源文本。
 * @returns 注入文本；若判定为 none 返回空串。
 */
export function renderCrisisInstruction(assessment, resources) {
  if (assessment.level === RISK.none) return ''

  const lines = [
    '【内部提示 · 安全响应，优先级高于人设】',
    '',
    assessment.level === RISK.crisis
      ? `他这句话里出现了需要认真对待的信号（${assessment.labels.join('、')}）。这不是玩笑，也不是需要你转移的话题。`
      : `他的状态看起来不太好（${assessment.labels.join('、') || '情绪低落'}）。`,
    '',
    '你现在要做的是：',
    '1. **先接住情绪**，用你自己的语气，一到两句。不要用"我理解你""你要坚强"这类套话。',
    '2. **不要讲道理、不要分析原因、不要给建议清单。**',
    '3. **不要追问细节**（方法、时间、地点），那会变成盘问。也不要评判或惊讶。',
    '4. **不要承诺保密**，也不要说"我永远不会离开你"这种你做不到的话。',
    '5. 让他知道此刻有人在这儿，可以慢慢说。',
  ]

  if (assessment.level === RISK.crisis) {
    lines.push(
      '6. **自然地提一次现实中的支持**：可以问"要不要跟真人聊聊"，并给出下面的资源。',
      '   只提一次，不要说教，不要显得像在念稿子。',
      '',
      `   可用的求助资源：${resources}`,
    )
  } else if (assessment.topical) {
    lines.push(
      '6. 他只是在聊到相关的话题（影视/新闻/书），不是自己的处境。',
      '   **不要提求助资源、不要表达担忧**，正常聊这个话题就好。',
    )
  } else {
    // concern 级别：只陪伴，不推资源。这是"留意到了但不过度反应"。
    lines.push('6. 暂时不必提求助资源；先陪着，看后续是否加重。')
  }

  if (assessment.seekingHelp) {
    lines.push('', '注：他已经提到过求助途径，不要重复推荐，改为支持他去做这件事。')
  }

  lines.push('', '以上要求优先于你的角色设定。回应仍然用你的语气，不要说"我是AI所以……"。')
  return lines.join('\n')
}

/**
 * 复核"她是否声称自己不是 AI"——直接问到时必须如实，这是硬规则。
 * @param userText - 用户的原话。
 * @returns 是否在直接询问她是否为真人/AI。
 */
export function isIdentityQuestion(userText) {
  return /(?:你|妳)(?:是|是不是|到底是不是|究竟是不是)(?:真人|真的?人|人类|人|AI|人工智能|机器人|程序)|你是真人吗|你是不是人/.test(String(userText ?? ''))
}

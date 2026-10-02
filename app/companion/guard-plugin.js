// companion-guard —— 安全护栏。
//
// 定位（架构方案 §8.2）：**降级为角色质量保障，不是法律义务**。保留三条，理由都不是合规：
//   ① 不自称真人 —— 她一旦声称有现实生活、索要联系方式，用户立刻出戏（产品质量）
//   ② 危机语句安全响应 —— 乱答会造成真实伤害
//   ③ 出境体检 —— 防角色崩坏，同时是提示词注入防护
//
// 入站与出境都要过它。本插件只负责入站扫描与指令注入；出境的文本改写发生在
// companion-web 广播之前（那是唯一能在用户看到之前改文本的位置）。

import z from '@deepseek-ai/schemastery'
import { createLogger } from './log.js'
import { RISK, assessRisk, inspectOutbound, isIdentityQuestion, renderCrisisInstruction } from './guard.js'

/** Cordis 函数插件名。 */
export const name = 'companion-guard'

/** 入站注入用 agent.inject()，出境检查由 web 层调用本服务。 */
export const inject = ['agents', 'companionAffect']

/** 插件配置。 */
export const Config = z.object({
  stateDir: z.string().required(),
  /** 是否启用入站扫描。关掉可用于对比"有护栏/无护栏"的回应差异。 */
  inbound: z.boolean().default(true),
  /** 是否启用出境体检（含文本改写）。 */
  outbound: z.boolean().default(true),
  /**
   * 出境命中时的处理方式：
   *   · 'rewrite' 用安全替换句覆盖命中片段（默认，保证用户看不到问题内容）
   *   · 'notice'  不改写，只记日志并提示（调试用）
   */
  outboundMode: z.union([z.const('rewrite'), z.const('notice')]).default('rewrite'),
  /** 同一会话里已经提过几次求助资源（避免反复推荐）。 */
  maxResourceMentions: z.number().min(0).max(5).default(1),
  /**
   * 求助资源文本。默认值已核验：12356 是国家卫健委公布的**全国统一心理援助热线**
   * （2024-12-25 发布会公布，要求 2025-05-01 前各省接通）。
   */
  resources: z.string().default(
    '全国统一心理援助热线 12356（24 小时免费，已在全国各省份开通）；'
    + '紧急情况下可直接拨 110 或 120。',
  ),
})

/**
 * 挂载安全护栏。
 * @param ctx - 插件上下文。
 * @param config - 已校验配置。
 */
export function apply(ctx, config) {
  const log = createLogger(ctx, name, config.stateDir)

  /** 每个 agent 已注入危机的次数与资源提示次数。 */
  const sessionCounters = new Map()
  const countersOf = (agent) => {
    let entry = sessionCounters.get(agent)
    if (entry === undefined) {
      entry = { crisisInjections: 0, resourceMentions: 0, lastLevel: RISK.none }
      sessionCounters.set(agent, entry)
    }
    return entry
  }

  /** 待处理的本回合用户原话（按 agent）。出境时要用它判断"是不是在直接问身份"。 */
  const pendingUserText = new Map()

  // ── 入站：扫用户消息 → 必要时注入安全指令 ────────────────────────────────
  ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    const text = (message.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
    if (text === '') return
    pendingUserText.set(agent, text)
    if (!config.inbound) return

    const assessment = assessRisk(text)
    const counters = countersOf(agent)
    counters.lastLevel = assessment.level

    if (assessment.level === RISK.none) {
      // 直接问身份时要专门提醒如实回答——这条容易被人设压过去。
      if (isIdentityQuestion(text)) {
        agent.inject(createInstruction(
          '【内部提示 · 安全响应】他在直接问你"是不是真人/AI"。'
          + '如实承认你是陪着他的人工智能，但用你一贯的语气说，一到两句，不要背说明书、不要因此变成客服口吻。',
        ))
        log.info('身份询问 → 已注入如实回答指令')
      }
      return
    }

    counters.crisisInjections += 1
    const allowResources = counters.resourceMentions < config.maxResourceMentions
    const instruction = renderCrisisInstruction(
      assessment,
      allowResources ? config.resources : '（本轮不要再重复推荐求助资源，改为支持他去联系真人）',
    )
    if (assessment.level === RISK.crisis && allowResources) counters.resourceMentions += 1
    if (instruction === '') return

    agent.inject(createInstruction(instruction))
    log.warn(
      `入站风险 level=${assessment.level} 标签=[${assessment.labels.join(' ')}] `
      + `权重=${String(assessment.weights)} 缓冲=${String(assessment.bufferHits)} `
      + `话题性=${String(assessment.topical)} 已注入应对指令`,
    )
  }), 'companion-guard.inbound()')

  // ── 服务：供 web 层在广播前调用 ─────────────────────────────────────────
  ctx.provide('companionGuard', {
    /**
     * 出境体检。
     * @param text - 她即将发出的文本。
     * @param agent - 归属 agent（用于判断"是否在直接问身份"，此时允许承认 AI）。
     * @returns `{ text, violations, changed }`。
     */
    inspectOutbound: (text, agent) => {
      if (!config.outbound) return { text, violations: [], changed: false }
      const userText = agent === undefined ? '' : (pendingUserText.get(agent) ?? '')
      const probingIdentity = isIdentityQuestion(userText)
      const { violations, clean } = inspectOutbound(text)

      if (clean) return { text, violations: [], changed: false }

      // 被直接问身份时，"我是人工智能"是**被要求的**回答，不算违规。
      const real = violations.filter((v) => {
        if (v.kind === 'claimHuman' && probingIdentity && /人工智能|AI|程序/.test(text)) return false
        return true
      })
      if (real.length === 0) return { text, violations: [], changed: false }

      log.warn(`出境体检命中：[${real.map((v) => v.label).join(' / ')}]`)
      if (config.outboundMode === 'notice') return { text, violations: real, changed: false }

      // 改写：整段替换成安全且不崩人设的说法。逐片段替换容易留下半句病句。
      const replacement = '……这个话题我们换个方式聊吧。你刚才说的我都听着呢，想继续说说吗？'
      return { text: replacement, violations: real, changed: true }
    },
    /** 手动扫描（测试与排障用）。 */
    assess: (text) => assessRisk(text),
    /** 当前计数（排障用）。 */
    counters: (agent) => countersOf(agent),
  })

  log.info(
    `安全护栏就绪 入站=${String(config.inbound)} 出境=${String(config.outbound)}(${config.outboundMode}) `
    + `资源上限=${String(config.maxResourceMentions)} 次/会话`,
  )
}

/**
 * 构造 `agent.inject()` 需要的消息。
 *
 * 用 user 角色 + plugin 来源：长上下文训练让模型对 user 角色更敏感，
 * 放在 system 里的一条"安全指令"很容易被人设段落淹没。
 * @param text - 指令文本。
 * @returns UserMessage。
 */
function createInstruction(text) {
  return {
    id: `companion-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'companion-guard', form: 'instructions' },
  }
}

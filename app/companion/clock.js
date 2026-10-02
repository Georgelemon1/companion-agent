// companion-clock —— 全应用**唯一**持有定时器的插件。
//
// 为什么必须唯一（架构方案 §3.2）：多个定时器各自判定"该不该说话"会互相打架，
// 也无法统一做预算与冷却。所有与时间相关的判定都从这里发出。
//
// 每个 tick 做三件事：
//   ① 结算"她开口了但没人回" → 冷却退避
//   ② 组候选（记忆型 / 空闲型）→ 动机评分 → 过预算门
//   ③ 通过则 agent.followup() 投递，并记进 initiative_log
//
// 同时负责事实抽取：用户消息在回合收尾时被抽成卡片写进记忆。
// 放在这里而不是 affect 里，是因为"记忆写入"与"什么时候该提起它"是同一件事的两端。

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createLogger } from './log.js'
import { decide, renderInitiativePrompt } from './initiative.js'
import { extractFacts, llmExtractFacts } from './memory.js'

/** Cordis 函数插件名。 */
export const name = 'companion-clock'

/** 唯一定时器 + 投递能力 + 记忆服务。 */
export const inject = ['timer', 'agents', 'sessions', 'companionAffect', 'agentDefaultModel']

/** 插件配置。 */
export const Config = z.object({
  stateDir: z.string().required(),
  /** tick 间隔（毫秒）。默认 60 秒——主动性不需要更细的粒度。 */
  tickMs: z.number().min(5000).max(3_600_000).default(60_000),

  // ── 动机分阈值 ──
  /** 过此分才考虑开口。调低会更主动，调高会更沉默。 */
  motivationThreshold: z.number().min(1).max(20).default(7),

  // ── 预算门 ──
  /** 每天最多主动几次。 */
  dailyCap: z.number().min(0).max(20).default(3),
  /** 两次主动之间的最小间隔（分钟）。 */
  minCooldownMinutes: z.number().min(1).max(1440).default(90),
  /** 连续未获回应时冷却的退避倍数（missStreak 次方）。 */
  missBackoffFactor: z.number().min(1).max(10).default(3),
  /** 多久没说话才算"可以主动找他"（小时）。下限 10 秒级别，为的是验收与排障不用真等几小时。 */
  idleThresholdHours: z.number().min(0.0028).max(240).default(8),
  /** 她开口后多久没被回应算一次 miss（分钟）。 */
  missAfterMinutes: z.number().min(1).max(1440).default(30),
  /** 是否遵守静默时段。 */
  respectQuietHours: z.boolean().default(true),
  /** 静默时段 [起, 止]，支持跨零点。 */
  quietHours: z.array(z.string()).default(['23:00', '08:00']),

  // ── 记忆 ──
  /** 是否用 LLM 抽取事实（默认关：本地规则零成本，先跑通）。 */
  extractWithLlm: z.boolean().default(false),
  extractModel: z.string().default(''),
  extractTimeoutMs: z.number().min(1000).max(120000).default(20000),
})

/** 取模型内容块里的纯文本。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
}

/**
 * 挂载时钟与主动性。
 * @param ctx - 插件上下文。
 * @param config - 已校验配置。
 */
export function apply(ctx, config) {
  const log = createLogger(ctx, name, config.stateDir)
  const affect = ctx.get('companionAffect')

  /** 本回合待抽取的用户消息（按 agent 记录）。 */
  const pendingUser = new Map()
  /** agent 是否正忙（忙时不投递，避免打断自己）。 */
  const busyAgents = new Set()
  /** 最近一次 tick 的决策快照，供前端与排障查看"她为什么没开口"。 */
  let lastTick
  /** 上一次记录的决策特征，用于抑制重复日志。 */
  let lastTickSignature = ''
  /**
   * 本次回合是不是由主动开口引发的。
   * 机制：投递前置位，回合收尾取用并清零。这样前端能把主动消息与回复区分开。
   */
  let awaitingProactiveReply = false
  /** 主动开口的订阅者（companion-web 用它标消息来源）。 */
  const initiativeListeners = new Set()
  const emitInitiative = (payload) => {
    for (const listener of initiativeListeners) {
      try {
        listener(payload)
      } catch {
        /* 单个订阅者出错不影响时钟 */
      }
    }
  }

  // ── 挂钩点：用户消息 → 记录活动 + 待抽取 ────────────────────────────────
  ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    const text = textOf(message.content)
    if (text === '') return
    affect.noteUserActivity?.()
    const list = pendingUser.get(agent) ?? []
    list.push(text)
    pendingUser.set(agent, list)
  }), 'companion-clock.inbox()')

  // 忙闲状态：她说话时不投递新的主动消息。
  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') busyAgents.add(agent)
    else busyAgents.delete(agent)
  }), 'companion-clock.status()')

  // ── 挂钩点：回合收尾 → 抽事实卡片 ───────────────────────────────────────
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    // 主动开口引发的回合：通知前端给这条消息打标。取用即清零。
    if (awaitingProactiveReply) {
      awaitingProactiveReply = false
      emitInitiative({ type: 'initiative.fired' })
    }

    const texts = pendingUser.get(agent)
    if (texts === undefined || texts.length === 0) return
    pendingUser.delete(agent)

    let replyText = ''
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'assistant/message') continue
      if (event.data?.turn !== turn) continue
      const text = textOf(event.data?.message?.content)
      if (text !== '') replyText = text
    }

    const userText = texts.join('\n')
    // 抽取前先剥掉说话人标签（"用户：…"）。它是为了帮模型区分发言来源才加的，
    // 不该被当作事实内容写进卡片——第一版就把"用户：我叫阿哲…"整句存进去了。
    const cleanText = userText.replace(/^\s*用户\s*[：:]\s*/gm, '')
    const local = extractFacts([cleanText])
    let wrote = 0
    for (const fact of local) {
      if (affect.remember?.(fact) !== undefined) wrote += 1
    }
    if (wrote > 0) {
      log.info(`抽取到 ${wrote} 张卡片：${local.map((f) => f.content).slice(0, 4).join(' / ')}`)
    }

    if (!config.extractWithLlm) return
    void (async () => {
      const llm = ctx.get('llm')
      const defaultModel = ctx.get('agentDefaultModel')
      if (llm === undefined || defaultModel === undefined) return
      const selection = defaultModel.currentSelection()
      const route = {
        provider: selection?.provider,
        model: config.extractModel !== '' ? config.extractModel : selection?.model,
      }
      if (typeof route.provider !== 'string' || typeof route.model !== 'string') return
      const refined = await llmExtractFacts(llm, route, { userText, replyText }, {
        createUserMessage,
        BlockAssembler,
        sessionId: agent.session.id,
        timeoutMs: config.extractTimeoutMs,
      })
      if (refined === undefined) {
        log.warn('LLM 事实抽取未返回可用结果，保留本地结果')
        return
      }
      let extra = 0
      for (const fact of refined) {
        if (affect.remember?.(fact) !== undefined) extra += 1
      }
      log.info(`LLM 补抽 ${extra} 张卡片`)
    })()
  }), 'companion-clock.extract()')

  // ── tick ────────────────────────────────────────────────────────────────
  const rootsOf = () => {
    const agents = ctx.get('agents')
    if (agents === undefined) return []
    return agents.roots()
  }

  /** 结算"开口了但没人回"。 */
  const settleMisses = (now) => {
    const state = affect.initiativeState()
    if (state.lastSentAt === undefined) return
    const sinceSentMin = (now.getTime() - state.lastSentAt) / 60_000
    if (sinceSentMin < config.missAfterMinutes) return
    // 她开口之后用户有没有再说话？说了就说明不是被无视。
    if (state.lastUserAt > state.lastSentAt) return
    const streak = affect.noteInitiativeMiss?.() ?? 0
    log.warn(`主动消息未被回应，连续第 ${streak} 次 → 冷却退避 ×${config.missBackoffFactor ** streak}`)
  }

  const tick = () => {
    const now = new Date()
    const roots = rootsOf()
    if (roots.length === 0) {
      lastTick = { at: now.toISOString(), reason: 'no-agent' }
      return
    }
    const agent = roots[0]

    settleMisses(now)

    const relation = affect.relation()
    const state = affect.initiativeState()
    const sinceDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

    // ── 组候选 ──
    const candidates = []
    for (const card of affect.proactiveMemoryCandidates({ limit: 5 })) {
      candidates.push({
        kind: 'memory',
        memory: { id: card.id, content: card.content, importance: card.importance },
        hoursSinceTold: card.hoursSinceTold,
        idleHours: (now.getTime() - state.lastUserAt) / 3_600_000,
        relation,
      })
    }
    // 空闲型候选：没有具体的事想说，只是"有点想他"。
    candidates.push({
      kind: 'idle',
      idleHours: (now.getTime() - state.lastUserAt) / 3_600_000,
      relation,
    })

    const decision = decide({
      candidates,
      now,
      relation,
      config: {
        dailyCap: config.dailyCap,
        minCooldownMinutes: config.minCooldownMinutes,
        missBackoffFactor: config.missBackoffFactor,
        idleThresholdHours: config.idleThresholdHours,
        respectQuietHours: config.respectQuietHours,
        quietHours: config.quietHours,
        motivationThreshold: config.motivationThreshold,
      },
      state: {
        sentToday: affect.countInitiativesSince?.(sinceDayStart) ?? 0,
        missStreak: state.missStreak,
        lastSentAt: state.lastSentAt,
        lastUserAt: state.lastUserAt,
        agentBusy: busyAgents.has(agent),
      },
    })

    lastTick = {
      at: now.toISOString(),
      send: decision.send,
      reason: decision.gate.reason,
      top: decision.ranked[0] === undefined
        ? undefined
        : { kind: decision.ranked[0].kind, score: decision.ranked[0].score, breakdown: decision.ranked[0].breakdown },
    }

    // 只在"决策发生变化"时记录，避免每 30 秒刷一行无用日志。
    const signature = `${decision.send}|${decision.gate.reason}|${decision.ranked[0]?.score ?? 0}`
    if (signature !== lastTickSignature) {
      lastTickSignature = signature
      const top = decision.ranked[0]
      log.info(
        `tick → ${decision.send ? '发送' : '不发送'}（${decision.gate.reason}）`
        + (top === undefined ? ' 无候选' : ` 最高分=${top.score.toFixed(2)} kind=${top.kind}`)
        + (decision.gate.cooldownMs === undefined ? '' : ` 冷却=${Math.round(decision.gate.cooldownMs / 60000)}min 剩余=${Math.round((decision.gate.remainingMs ?? 0) / 60000)}min`),
      )
    }

    if (!decision.send) return

    const chose = decision.chose
    const prompt = renderInitiativePrompt(chose)
    // 先标记，再投递：前端据此把这条消息标成"她主动说的"。
    // 必须在 followup 之前，因为 followup 会同步唤醒驱动器。
    awaitingProactiveReply = true
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'companion-initiative' },
      }))
    } catch (error) {
      awaitingProactiveReply = false
      log.error(`主动投递失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }

    affect.logInitiative?.({
      kind: chose.kind,
      score: chose.score,
      content: chose.memory?.content ?? `空闲 ${Math.round(chose.idleHours ?? 0)} 小时`,
      memoryId: chose.memory?.id,
    })
    if (chose.kind === 'memory' && chose.memory?.id !== undefined) {
      affect.markMemoryTold?.(chose.memory.id)
    }
    log.info(`主动开口 kind=${chose.kind} score=${chose.score.toFixed(2)} 理由=[${chose.breakdown.map((b) => `${b.label}=${b.value}`).join(' ')}]`)
  }

  // 唯一的定时器。ctx.interval 由 timer 服务混入，随本 fiber 卸载自动清理。
  ctx.interval(tick, config.tickMs)

  // 启动时立刻跑一次，便于观察配置是否合理。
  ctx.timeout(tick, 2000)

  /** 暴露给前端与排障使用。 */
  ctx.provide('companionInitiative', {
    lastTick: () => lastTick,
    /** 手动触发一次 tick（测试与调试用）。 */
    poke: () => {
      tick()
      return lastTick
    },
    /** 订阅"她主动开口了"。 */
    subscribe: (listener) => {
      initiativeListeners.add(listener)
      return () => initiativeListeners.delete(listener)
    },
    /** 最近的主动开口记录。 */
    recent: (limit) => affect.recentInitiatives?.(limit) ?? [],
  })

  log.info(`时钟就绪 tick=${config.tickMs}ms cap=${config.dailyCap}/天 冷却=${config.minCooldownMinutes}min 静默=${config.quietHours.join('-')} 阈值=${config.motivationThreshold}`)
}

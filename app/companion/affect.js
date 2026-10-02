// companion-affect —— 情感骨骼插件。
//
// 一个插件同时提供两个服务（状态机只有一个宿主，没必要拆成两个生命周期）：
//   · ctx.companionAffect   —— 情绪：读/衰减/施加
//   · ctx.companionRelation —— 关系：读/衰减/按交互推进
//
// 事件挂钩（这是"她像活的"的来源，全部读自 dsh-agent 的公开事件面）：
//   agent/inbox/inserted → 记下用户这次说了什么
//   agent/turn-stopping  → 回合将收尾，取她这轮的回复
//   → 异步做情绪评价 + 关系推进 + **人设推断** → 广播
//
// 评价与推断都放在 turn-stopping 之后异步做，是为了**不拖慢回复**：
// 情绪与设定在下一个回合前生效即可。
//
// 人设：`persona()` 读的是"基线卡 + 对话里推断出的覆盖项"，每次现叠不缓存，
// 所以推断一落库，下一回合的提示词就是新的（详见 infer.js）。

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompanionState } from './state.js'
import { heuristicAppraise, llmAppraise } from './appraisal.js'
import { DEFAULT_PERSONA, projectState, renderState } from './persona.js'
import { composePersona, describeCard, llmInfer, mergeTrait, ruleInfer, stripSpeakerLabel, validateTraits } from './infer.js'
import { createLogger } from './log.js'

/** Cordis 函数插件名。 */
export const name = 'companion-affect'

/**
 * 评价与推送需要 LLM 路由和会话服务；
 * `timer` 用于 WAL 周期维护——**必须显式声明**，
 * 否则 cordis 会拒绝 `ctx.interval`（"cannot get property timer without inject"）。
 */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'timer']

/** 插件配置。 */
export const Config = z.object({
  /** SQLite 路径。 */
  dbPath: z.string().required(),
  /**
   * 是否用 LLM 精评每个回合。
   * 默认关闭：本地词表零延迟零成本，先跑通；开启后能给每回合加一次模型调用，
   * 能读懂反讽和间接表达，但会增加一次请求的延迟与花费。
   */
  appraiseWithLlm: z.boolean().default(false),
  /** 精评用哪个模型；留空则跟随默认路由。 */
  appraiseModel: z.string().default(''),
  appraiseTimeoutMs: z.number().min(1000).max(120000).default(20000),
  /**
   * WAL 维护周期（毫秒）。默认 5 分钟。
   * 必须显式 checkpoint：`wal_autocheckpoint` 默认 1000 页（4 MB），
   * 而这库全部数据才约 11 页，永远够不到阈值 → WAL 只增不清。
   */
  checkpointIntervalMs: z.number().min(10_000).max(3_600_000).default(300_000),
  /** 状态目录（日志落在这里）。 */
  stateDir: z.string().required(),

  // ── 人设推断（取代问卷表单：不再让用户填，改从真实对话里推） ──────────────
  /** 总开关。关掉则只剩"基线卡 + 默认角色"，一个字都不会被推断改写。 */
  inferPersona: z.boolean().default(true),
  /**
   * LLM 通道至少隔几个回合跑一次。
   * 规则通道（"以后叫我阿哲"这类显式指令）不受这个限制——每回合都跑。
   */
  inferEveryTurns: z.number().min(1).max(50).default(2),
  /** 两次 LLM 推断之间的最小间隔（毫秒），防止连发消息把模型打爆。 */
  inferMinIntervalMs: z.number().min(1000).max(3_600_000).default(60_000),
  /** 推断看最近几轮对话。 */
  inferWindow: z.number().min(2).max(20).default(6),
  /** 推断用哪个模型；留空则跟随默认路由（短 prompt，不必另配）。 */
  inferModel: z.string().default(''),
  inferTimeoutMs: z.number().min(1000).max(120_000).default(20_000),
  /** 低于此置信度的推断不写库。 */
  inferMinConfidence: z.number().min(0).max(1).default(0.6),
  /**
   * 迟滞·置信度余量：模型想把某个维度**改成另一个值**时，
   * 新置信度必须 ≥ 现有置信度 + 本余量（封顶 0.95）。用户明说的走规则通道，不受它约束。
   */
  traitConfidenceMargin: z.number().min(0).max(0.5).default(0.1),
  /**
   * 迟滞·最小变更间隔（毫秒）：同一个维度多久之内不许再改值。
   * 默认 10 分钟。调大 = 更稳但更迟钝；调 0 = 关掉迟滞（回到"每轮都可能翻"的老行为）。
   */
  traitMinChangeIntervalMs: z.number().min(0).max(86_400_000).default(600_000),
})

/** 取模型内容块里的纯文本。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
}

/**
 * 挂载情感骨骼。
 * @param ctx - 插件上下文。
 * @param config - 已校验配置。
 */
export function apply(ctx, config) {
  const log = createLogger(ctx, name, config.stateDir)
  const state = new CompanionState(config.dbPath)
  ctx.effect(() => () => state.close(), 'companion-affect.db()')

  /** 情绪/关系变化时的订阅者（companion-web 用它推送到前端）。 */
  const listeners = new Set()
  const emit = (payload) => {
    for (const listener of listeners) {
      try {
        listener(payload)
      } catch {
        /* 单个订阅者出错不影响状态机 */
      }
    }
  }

  /** 本回合待评价的用户消息（按 agent 记录）。 */
  const pending = new Map()
  /** 最近几条用户消息，供复读检测使用（新意衰减在 appraisal 里做）。 */
  const recentUserTexts = []
  /** 最近一条用户原话：记忆召回以它为准。 */
  let lastUserText = ''
  /** 召回缓存：同一轮里同一段话不重复扫描。 */
  let recallCache = { text: '', cards: [] }
  /** 复读检测保留的最近消息条数。 */
  const RECENT_WINDOW = 4
  /** 复读检测的相似度阈值。 */
  const REPEAT_THRESHOLD = 0.7

  const snapshot = () => {
    const affect = state.readAffect()
    const relation = state.readRelation()
    return { affect, relation, projected: projectState(affect, relation) }
  }

  const broadcastState = (reason) => {
    const { projected } = snapshot()
    emit({ type: 'affect.update', reason, ...projected })
  }

  /**
   * 广播"人设变了"。
   *
   * 前端目前只用到 affect.update；这条是给排障与后续面板留的口子
   *（WS 上能直接看到她这轮改了哪几项、凭什么改）。
   * @param reason - 'rule' | 'llm' | 'reset'。
   */
  const broadcastPersona = (reason) => {
    emit({
      type: 'persona.update',
      reason,
      summary: describeCard(service.persona() ?? DEFAULT_PERSONA),
      traits: state.readTraits().map((trait) => ({
        key: trait.key,
        value: trait.value,
        evidence: trait.evidence,
        confidence: trait.confidence,
        source: trait.source,
        samples: trait.samples,
      })),
    })
  }

  /** 把一次评价结果落进状态机并广播。 */
  const commitAppraisal = (result, cause) => {
    const { affect, relation } = snapshot()
    const emotions = state.applyEmotion(result.deltas, cause)
    const nextRelation = state.applyInteraction(result.signal, result.disclosure)
    void emotions
    void relation
    broadcastState(cause)
    return { emotions, relation: nextRelation }
  }

  // ── 服务：情绪 + 关系 ────────────────────────────────────────────────────
  const service = {
    /** 当前情绪（读时顺带衰减）。 */
    affect: () => state.readAffect(),
    /** 当前关系（读时顺带衰减）。 */
    relation: () => state.readRelation(),
    /**
     * 生效中的人设卡 = 基线卡 **叠加** 对话里推断出的设定。
     *
     * 每次调用都现叠、不缓存：persona-plugin 的段落渲染函数每回合调它一次，
     * 所以推断一落库，下一回合的提示词就是新的——"改了立刻生效"就落在这里。
     * 库里有基线卡、或已有任何推断时返回卡片；两者都没有才返回 undefined
     *（那是全新库，交给 persona-plugin 播种默认角色）。
     */
    persona: () => {
      const base = state.readPersona()
      const traits = state.readTraits()
      if (base === undefined && traits.length === 0) return undefined
      return composePersona(base ?? DEFAULT_PERSONA, traits)
    },
    /** 基线卡（库里那张，不含推断覆盖）。 */
    personaBase: () => state.readPersona(),
    /**
     * 写基线卡。**对话推断不走这里**——推断写 persona_trait 表，
     * 这样基线（用户手填/导入/默认）与"长出来的"两部分永远分得开、可整体撤销。
     */
    writePersona: (card) => state.writePersona(card),
    /** 推断出的设定行（带用户原话证据）。 */
    traits: () => state.readTraits(),
    /** 最近的推断流水（含被拒条目与理由）。 */
    personaTraces: (limit) => state.readPersonaTraces(limit),
    /** 丢掉全部推断，回到基线卡。 */
    resetInferred: () => {
      const removed = state.clearTraits()
      broadcastPersona('reset')
      return removed
    },
    /** 生效设定的单行摘要（日志与排查口用）。 */
    describePersona: () => describeCard(service.persona() ?? DEFAULT_PERSONA),
    /** 一次性拿全（含前端投影）。 */
    snapshot,
    /** 手动施加情绪（调试或后续的主动情绪用）。 */
    apply: (deltas, cause = 'manual') => commitAppraisal({ deltas, signal: 0, disclosure: 0 }, cause),
    /** 手动推进关系（调试用）。 */
    interact: (signal, disclosure = 0) => {
      const relation = state.applyInteraction(signal, disclosure)
      broadcastState('manual-interaction')
      return relation
    },
    /** 订阅状态变化，返回退订函数。 */
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 渲染系统提示词用的状态摘要。 */
    renderStateText: () => {
      const affect = state.readAffect()
      const relation = state.readRelation()
      // 召回与当前话题相关的记忆。这个提供者会被每步调用，所以按"最近用户原话"做缓存，
      // 避免同一轮里重复做关键词扫描。
      let memories = []
      if (lastUserText !== '') {
        if (recallCache.text !== lastUserText) {
          recallCache = { text: lastUserText, cards: state.recallMemories(lastUserText, 3) }
        }
        memories = recallCache.cards
      }
      return renderState(affect, relation, memories)
    },

    // ── 记忆层（事实卡片） ──────────────────────────────────────────────
    /** 记下一张事实卡片。 */
    remember: (fact) => state.remember(fact),
    /** 列出卡片。 */
    listMemories: (limit) => state.listMemories(limit),
    /** 按文本召回（她说话前想"他提过什么相关的"）。 */
    recallMemories: (text, limit) => state.recallMemories(text, limit),
    /** 值得主动提起的候选。 */
    proactiveMemoryCandidates: (options) => state.proactiveMemoryCandidates(options),
    /** 标记某张卡片已被主动提起。 */
    markMemoryTold: (id) => state.markMemoryTold(id),

    // ── 主动性预算（状态由 affect 持有，决策在 clock 里做） ──────────────
    /** 读主动性状态（上次发送时间、连续未回应次数、用户最近活动时间）。 */
    initiativeState: () => state.readInitiativeState(),
    /** 记用户说话了。 */
    noteUserActivity: () => state.noteUserActivity(),
    /** 统计某时刻后已发出多少条主动消息。 */
    countInitiativesSince: (sinceMs) => state.countInitiativesSince(sinceMs),
    /** 记录一次主动开口。 */
    logInitiative: (record) => state.logInitiative(record),
    /** 记录一次未被回应。 */
    noteInitiativeMiss: () => state.noteInitiativeMiss(),
    /** 最近的主动开口记录（前端与排障用）。 */
    recentInitiatives: (limit = 20) => state.recentInitiatives(limit),
  }
  ctx.provide('companionAffect', service)
  ctx.provide('companionRelation', {
    read: () => state.readRelation(),
    interact: service.interact,
  })

  // ── WAL 维护 ─────────────────────────────────────────────────────────────
  // SQLite 的自动 checkpoint 阈值是 1000 页（4 MB），而这个库总数据约 11 页，
  // 写入速率永远够不到阈值，于是 WAL 只增不清（实测涨到 1.89 MB / 主库 44 KB）。
  // 这里按周期做 PASSIVE checkpoint：不阻塞读写，把已提交页并回主库。
  ctx.interval(() => {
    const result = state.checkpoint('PASSIVE')
    if (result !== undefined && result.checkpointed > 0) {
      log.info(`WAL checkpoint: 并回 ${String(result.checkpointed)} 页（剩余日志 ${String(result.log)} 页）`)
    }
  }, config.checkpointIntervalMs)
  // 启动时也做一次，把上次遗留的 WAL 先清掉（TRUNCATE 才能真的缩小文件）。
  const startupCheckpoint = state.checkpoint('TRUNCATE')
  if (startupCheckpoint !== undefined && startupCheckpoint.checkpointed > 0) {
    log.info(`启动 WAL 清理：并回 ${String(startupCheckpoint.checkpointed)} 页`)
  }

  // ── 人设推断：从真实对话里长设定（取代问卷表单） ─────────────────────────
  //
  // 两条通道，边界很清楚：
  //   · 规则通道：显式指令（"以后叫我阿哲""别聊工作"）→ 同步、每回合都跑、零成本。
  //   · LLM 通道：软偏好（语气、浓度、在意的话题…）→ 异步、节流、失败不影响回话。
  // 两条通道都必须过 validateTraits 的接地检查：证据得逐字来自**用户自己**说过的话。

  /** LLM 通道离上次跑过了几个回合（初始就绪，让她从早期对话就开始学）。 */
  let turnsSinceInfer = config.inferEveryTurns
  /** 上一次 LLM 推断的时刻。 */
  let lastInferAt = 0
  /** 同一时刻只允许一次 LLM 推断在飞（她的回复不等它）。 */
  let inferBusy = false

  /**
   * 取最近 N 轮对话（旧→新）。
   *
   * 只配对"用户发言 + 她紧接着的回复"：插件投递的主动性提示不算用户发言，
   * 混进来会让模型把内部指令当成他说的话。
   * @param agent - 当前 Agent。
   * @param limit - 最多几轮。
   * @returns `[{ user, reply }]`。
   */
  const recentExchanges = (agent, limit) => {
    const pairs = []
    let pendingUser = null
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'user/message') {
        if (event.data?.source?.kind !== 'user') continue
        const text = stripSpeakerLabel(textOf(event.data?.content)).trim()
        if (text !== '') pendingUser = text
        continue
      }
      if (event.type === 'assistant/message' && pendingUser !== null) {
        pairs.push({ user: pendingUser, reply: textOf(event.data?.message?.content) })
        pendingUser = null
      }
    }
    return pairs.slice(-limit)
  }

  /**
   * 把推断落库。合并/覆盖/迟滞的规则集中在 infer.js 的 mergeTrait 里
   *（关键两条：用户的显式指令优先于模型推断；模型改值要过置信度余量 + 最小变更间隔）。
   * @param traits - 已通过校验的推断条目。
   * @returns `{ written, reinforced, skipped }`；只有 written 会打日志与广播。
   */
  const commitTraits = (traits) => {
    const written = []
    const skipped = []
    const reinforced = []
    if (traits.length === 0) return { written, reinforced, skipped }
    const existing = new Map(state.readTraits().map((row) => [row.key, row]))
    for (const trait of traits) {
      const decision = mergeTrait(existing.get(trait.key), trait, {
        confidenceMargin: config.traitConfidenceMargin,
        minChangeIntervalMs: config.traitMinChangeIntervalMs,
      })
      if (decision.action === 'skip') {
        skipped.push({ key: trait.key, reason: decision.reason })
        continue
      }
      // reinforce = 同一个值又被观察到一次：只加 samples，不算变更。
      // 第一版把它也当"已更新"，于是每轮都在日志里刷一行没变的设定。
      state.writeTrait({ ...trait, value: decision.value, samples: decision.samples })
      const record = { key: trait.key, value: decision.value, evidence: trait.evidence, confidence: trait.confidence, source: trait.source }
      if (decision.action === 'reinforce') reinforced.push(record)
      else written.push(record)
    }
    return { written, reinforced, skipped }
  }

  /** 一行摘要，日志与 trace 共用。 */
  const summarize = (traits) => traits
    .map((t) => `${t.key}=${Array.isArray(t.value) ? `[${t.value.join('/')}]` : String(t.value)}`)
    .join(' ')

  /**
   * 跑一次推断。规则通道同步、LLM 通道异步，两者都不阻塞回话。
   * @param agent - 当前 Agent。
   * @param userText - 本回合用户说的话（可能多条，已带说话人前缀）。
   * @param turn - 回合号。
   */
  const inferPersonaFromTurn = (agent, userText, turn) => {
    if (!config.inferPersona) return

    // ① 规则通道：本回合就走，下一回合她就照做。
    const ruled = ruleInfer(userText)
    if (ruled.length > 0) {
      const { accepted, rejected } = validateTraits(ruled, { userText, minConfidence: 0.5, source: 'rule' })
      const { written, reinforced, skipped } = commitTraits(accepted)
      const rejectedAll = [...rejected, ...skipped]
      state.logPersonaTrace({ source: 'rule', turn, accepted: written, rejected: rejectedAll, note: `显式指令 / 加固 ${reinforced.length} 项` })
      if (written.length > 0) {
        log.info(`人设（规则通道）已更新：${summarize(written)} ← 证据「${written[0].evidence}」`)
        broadcastPersona('rule')
      }
      for (const bad of rejectedAll) log.warn(`规则通道丢弃一条推断：${bad.key} —— ${bad.reason}`)
    }

    // ② LLM 通道：节流 + 异步。失败只记一行，绝不冒泡到回合路径上。
    turnsSinceInfer += 1
    if (turnsSinceInfer < config.inferEveryTurns || inferBusy) return
    const now = Date.now()
    if (now - lastInferAt < config.inferMinIntervalMs) return
    const exchanges = recentExchanges(agent, config.inferWindow)
    // 少于两轮没有可推断的东西，别浪费一次调用。
    if (exchanges.length < 2) return
    turnsSinceInfer = 0
    lastInferAt = now
    inferBusy = true

    void (async () => {
      try {
        const llm = ctx.get('llm')
        const defaultModel = ctx.get('agentDefaultModel')
        if (llm === undefined || defaultModel === undefined) {
          log.warn('LLM 推断不可用（llm / agentDefaultModel 服务缺失），本轮只跑规则通道')
          return
        }
        const selection = defaultModel.currentSelection()
        const route = {
          provider: selection?.provider,
          model: config.inferModel !== '' ? config.inferModel : selection?.model,
        }
        if (typeof route.provider !== 'string' || typeof route.model !== 'string') return

        const card = service.persona() ?? DEFAULT_PERSONA
        let raw
        try {
          raw = await llmInfer(llm, route, { card, exchanges }, {
            createUserMessage,
            BlockAssembler,
            sessionId: agent.session.id,
            timeoutMs: config.inferTimeoutMs,
          })
        } catch (error) {
          // 推断失败只记一行：她的回复早已发出，这条路径慢半拍也不影响它。
          log.warn(`LLM 推断未完成（保留现有设定）：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        // 证据只能来自**用户那半边**：她的回复只用于理解上下文，不能当依据。
        const userSide = exchanges.map((exchange) => exchange.user).join('\n')
        const { accepted, rejected } = validateTraits(raw, {
          userText: userSide,
          minConfidence: config.inferMinConfidence,
          source: 'llm',
        })
        const committed = commitTraits(accepted)
        const rejectedAll = [...rejected, ...committed.skipped]
        state.logPersonaTrace({
          source: 'llm',
          turn,
          accepted: committed.written,
          rejected: rejectedAll,
          note: `窗口 ${exchanges.length} 轮 / 候选 ${raw.length} 条 / 加固 ${committed.reinforced.length} 项`,
        })
        if (committed.written.length > 0) {
          log.info(`人设（LLM 推断）已更新：${summarize(committed.written)} ← 证据「${committed.written.map((t) => t.evidence).join('」「')}」`)
          broadcastPersona('llm')
        } else {
          log.info(`人设（LLM 推断）：本轮无需改动（候选 ${raw.length} 条，加固 ${committed.reinforced.length} 项，未采纳 ${rejectedAll.length} 条）`)
        }
        for (const bad of rejectedAll) log.warn(`LLM 推断未采纳：${bad.key} —— ${bad.reason}`)
      } catch (error) {
        log.warn(`LLM 推断失败（不影响回话）：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        inferBusy = false
      }
    })()
  }

  // ── 挂钩点 ──────────────────────────────────────────────────────────────

  // 用户消息进 inbox：记下来，等回合收尾一起评价。
  ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    const text = textOf(message.content)
    if (text === '') return
    lastUserText = text
    const list = pending.get(agent) ?? []
    list.push(text)
    pending.set(agent, list)
  }), 'companion-affect.inbox()')

  // 回合将收尾：取她的回复 → 异步评价 → 推进关系 → 广播。
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const userTexts = pending.get(agent)
    if (userTexts === undefined || userTexts.length === 0) return
    pending.delete(agent)

    // 从会话日志取这一回合里她的最后一条回复。
    let replyText = ''
    for (const event of agent.session.snapshotEvents()) {
      if (event.type !== 'assistant/message') continue
      if (event.data?.turn !== turn) continue
      const text = textOf(event.data?.message?.content)
      if (text !== '') replyText = text
    }

    const userText = userTexts.join('\n')
    const local = heuristicAppraise(userText, recentUserTexts)

    // 先落本地通道的结果：零延迟，保证任何情况下情绪都有反应。
    commitAppraisal(
      { deltas: local.deltas, signal: local.signal, disclosure: local.disclosure },
      'heuristic',
    )
    log.info(
      `评价 turn=${String(turn)} 新意=${local.novelty.toFixed(2)} 命中=[${local.hits.slice(0, 6).join(' ')}] signal=${local.signal.toFixed(2)} disclosure=${local.disclosure.toFixed(2)}`,
    )

    // 记进复读窗口（新的在前）。
    recentUserTexts.unshift(userText)
    if (recentUserTexts.length > RECENT_WINDOW) recentUserTexts.length = RECENT_WINDOW

    // 人设推断。放在情绪评价之后、LLM 精评的分支**之前**——
    // 精评默认关闭，写在后头会连同推断一起被 return 掉。
    inferPersonaFromTurn(agent, userText, turn)

    if (!config.appraiseWithLlm) return

    // 精评：异步、失败静默回退到本地结果。
    void (async () => {
      const defaultModel = ctx.get('agentDefaultModel')
      const llm = ctx.get('llm')
      if (defaultModel === undefined || llm === undefined) return
      const selection = defaultModel.currentSelection()
      const route = {
        provider: selection?.provider,
        model: config.appraiseModel !== '' ? config.appraiseModel : selection?.model,
      }
      if (typeof route.provider !== 'string' || typeof route.model !== 'string') return
      const { affect } = snapshot()
      const refined = await llmAppraise(llm, route, {
        userText,
        replyText,
        emotions: affect.emotions,
      }, {
        createUserMessage,
        BlockAssembler,
        sessionId: agent.session.id,
        timeoutMs: config.appraiseTimeoutMs,
      })
      if (refined === undefined) {
        log.warn('LLM 精评未返回可用结果，保留本地评价')
        return
      }
      // 精评结果是"绝对判断"，直接加到当前状态上（本地通道的结果已在内）。
      commitAppraisal(refined, 'llm')
      log.info(`精评 turn=${String(turn)} deltas=${JSON.stringify(refined.deltas)} signal=${refined.signal.toFixed(2)}`)
    })()
  }), 'companion-affect.turnEnd()')

  // 状态被外部读取时不需要广播；但启动时先广播一次基线，让前端面板有初始值。
  broadcastState('startup')
  log.info(`情感骨骼就绪 dbPath=${config.dbPath}`)
}

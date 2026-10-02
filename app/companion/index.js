// companion-web —— 拟人情感互动智能体的 P0 通道层。
//
// 一个插件同时提供三样东西：
//   1. 静态文件服务（自建轻前端的 HTML/CSS/JS）
//   2. WebSocket 通道（文本通道与状态通道分离，见架构方案 §3.3）
//   3. 一个常驻的伴侣 Agent 生命周期：创建或恢复会话、转发用户消息、流式回传
//
// 设计要点：Agent 常驻而非按请求创建，这样情绪/关系的连续状态（P1 起）才有宿主，
// 也是"她主动找你说话"（P2，agent.followup）能成立的前提。

import { randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * 表情标记的兼容剥离。
 *
 * 标记体系（`[em:标签:强度]`）已随旧情绪立绘删除：提示词不再要求模型输出标记，
 * 立绘也换成剪纸三态（待机/思考/说话）。这里仍留一个剥离器，是因为
 * **老会话历史里存着标记原文**——重连拉历史时会原样显示给用户（曾经就是这么漏的）。
 */
const EMOTION_MARK_RE = /\[em:[a-z_]+(?::[\d.]+)?\]/gi

/** 剥掉文本里的表情标记。 */
const stripEmotionMarks = (text) => text.replace(EMOTION_MARK_RE, '')

/**
 * 流式"标记挂起"过滤器。
 *
 * 只做一件事：把**可能是标记前缀**的尾巴留住，等下一块到齐再判定——
 * 标记被切在两个 chunk 之间时不会漏出半截给人看。正文里的 `[` 会立刻放行。
 */
class MarkHoldback {
  /** 挂起的尾巴（可能是半截标记）。 */
  buf = ''

  /**
   * 推入一块增量。
   * @param chunk - 模型增量原文。
   * @returns 可以安全外发的可见文本。
   */
  push(chunk) {
    this.buf += chunk
    const open = this.buf.lastIndexOf('[')
    if (open !== -1) {
      const tail = this.buf.slice(open)
      const closed = this.buf.indexOf(']', open) !== -1
      // 只有"看起来还可能是标记"的尾巴才挂起（限长，避免正文里的 [ 被无限扣住）
      if (!closed && tail.length <= 24 && /^\[[a-z:0-9._]*$/i.test(tail)) {
        const emit = this.buf.slice(0, open)
        this.buf = tail
        return stripEmotionMarks(emit)
      }
    }
    const emit = this.buf
    this.buf = ''
    return stripEmotionMarks(emit)
  }
}

/** 句末标点：说话分段在这些地方断开。 */
const SENTENCE_END = '。！？!?…\n'

/**
 * 把一条回复切成"说话段"。
 *
 * 旧的分段来自情绪标记（一段一个表情），标记体系删掉后改用句子——
 * 前端在段与段之间停 320ms，这个停顿正好落在句子之间，像她换了口气。
 * @param text - 剥离标记后的正文。
 * @returns 非空句子数组。
 */
const splitSentences = (text) => {
  const parts = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (SENTENCE_END.includes(ch)) { parts.push(buf); buf = '' }
  }
  if (buf !== '') parts.push(buf)
  return parts.filter((p) => p.trim() !== '')
}

/** Cordis 函数插件名。 */
export const name = 'companion-web'

/** 生命周期开始前必须具备的服务。 */
export const inject = ['agents', 'sessions', 'agentDefaultModel']

/** 插件配置。 */
export const Config = z.object({
  port: z.number().min(1).max(65535).default(4180),
  host: z.string().default('127.0.0.1'),
  /** 应用状态目录（会话 id 锚点等）。 */
  stateDir: z.string().required(),
  /** 前端静态资源目录，相对 cordis.yml 所在目录或绝对路径。 */
  publicDir: z.string().default('./public'),
  /** 模型输入里给用户文字加的说话人标签，用于区分用户发言与插件注入的上下文。 */
  speakerLabel: z.string().default('用户'),
})

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
}

/** 从一个内容块数组里抽出纯文本（用于界面显示与状态摘要）。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
}

/** 把模型内容块归约为展示用文本。 */
function blocksToText(blocks) {
  const text = textOf(blocks)
  if (text !== '') return text
  const calls = (blocks ?? []).filter((b) => b?.type === 'tool-call').map((b) => b.name)
  return calls.length > 0 ? `（调用了工具：${calls.join(', ')}）` : ''
}

/**
 * 把会话事件日志折成前端可渲染的历史。
 *
 * 关键：主动开口的投递文本（`source.kind === 'plugin'`）**不能显示**——
 * 那是给模型看的内部提示，不是她说的话。但它会影响**紧随其后**那条回复的标记：
 * 它在历史里留下痕迹，刷新页面后也要能分辨"哪句是她主动说的"。
 *
 * @param events - session.snapshotEvents() 的结果。
 * @param speakerLabel - 投递给模型时给用户文字加的前缀（如 `用户`）。
 *   历史里必须剥掉它，理由见下面 user/message 分支的注释。
 * @returns `[{ role, text, proactive? }]`。
 */
function historyFrom(events, speakerLabel = '用户') {
  const out = []
  let pendingProactive = false
  // 投递时给模型加的是 `${speakerLabel}：`（全角冒号）。历史展示要剥掉它。
  const prefix = `${speakerLabel}：`
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (source?.kind !== 'user') {
        // 插件投递的内部提示：不显示，但记下"下一条她说的是主动开口"。
        if (source?.plugin === 'companion-initiative') pendingProactive = true
        continue
      }
      let text = textOf(event.data.content)
      // ⚠️ **必须剥掉说话人前缀再进历史**。
      //
      // 踩过的坑（用户报"用户消息前面为什么会显示用户二字"）：
      // 投递给模型时拼的是 `用户：${text}`（见 handleChat 的 forModel），
      // 而那条文本**原样写进了会话日志**。定稿路径与流式路径都不看日志，
      // 所以实时发言没有前缀；**只有刷新/重连拉历史时才带出来**。
      //
      // 与"情绪标记泄漏"是同一类问题：**给模型看的标记混进了展示层**。
      // 那次漏在 message.done 之后的历史路径，这次漏在 user/message 这一支。
      if (text.startsWith(prefix)) text = text.slice(prefix.length)
      if (text !== '') out.push({ role: 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const raw = blocksToText(event.data?.message?.content)
      if (raw === '') continue
      // ⚠️ 必须剥掉表情标记再进历史。
      //
      // 踩过的坑（用户报"情绪标签被一起输出了"）：会话日志里存的是**原始文本**
      //（含 `[em:joy:5]`），而定稿路径和流式路径都会把标记剥掉，
      // 只有这里漏了 —— 于是页面刷新/重连后，历史里的回复会带标记显示出来。
      // 表现为"间歇性泄漏"，很难复现，因为只有重新拉历史时才出现。
      const text = stripEmotionMarks(raw)
      if (text === '') continue
      out.push({ role: 'companion', text, proactive: pendingProactive })
      pendingProactive = false
    }
  }
  return out
}

/**
 * 挂载通道层：静态服务 + WebSocket + 常驻伴侣 Agent。
 * @param ctx - 插件上下文，携带 agents / sessions / agentDefaultModel 服务。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx, config) {
  const stateDir = resolve(config.stateDir)
  const publicDir = resolve(config.publicDir)
  const statePath = join(stateDir, 'companion-state.json')

  mkdirSync(stateDir, { recursive: true })

  if (!existsSync(publicDir)) {
    ctx.logger(name).warn(`publicDir 不存在，静态服务将只提供错误页：${publicDir}`)
  }

  /** 已连接的浏览器端。 */
  const clients = new Set()
  /** 最近一次状态投影；连上新客户端时用它初始化立绘与面板。 */
  let latestState
  /**
   * 本回合的起始 seq 与"是否收到过文本增量"。
   * 用来在 status 回到 idle 时判断"这个回合要不要补一条收尾"——
   * 主动开口的回合不经过 handleChat，只能靠这里收尾。
   */
  let runningFromSeq
  let runningHadDelta = false
  /** 本次收尾是否已由 status 钩子完成（避免与 handleChat 重复广播）。 */
  let finalizedByStatusHook = false
  /** 本回合累积的增量文本（原始，**含**表情标记）；定稿时用它做解析。 */
  let pendingText = ''
  /**
   * 流式剥离器：把表情标记从外发文本里滤掉，同时暂存"可能是标记前缀"的尾巴。
   * 每回合重置（见 resetStreamState）。
   */
  let liveFilter = null
  /** 已通过流式外发出去的**可见**字符数（不含空白）。 */
  let streamChars = 0
  /** 流式时序埋点：首块/末块时刻与块数，用于判断底层是否真流式。 */
  let firstChunkAt = 0
  let lastChunkAt = 0
  let streamChunkCount = 0


  /** 每回合开头的流式状态复位。 */
  const resetStreamState = () => {
    liveFilter = null
    streamChars = 0
    pendingText = ''
  }

  const broadcast = (payload) => {
    const data = JSON.stringify(payload)
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(data)
    }
  }

  // ── 常驻 Agent ────────────────────────────────────────────────────────────
  let agent
  /** 本次启动的失败原因（供 health 暴露，便于外部诊断，不用翻日志）。 */
  let readyError
  const logPath = join(stateDir, 'companion.log')
  /**
   * 写状态目录日志 + cordis logger。
   *
   * 行格式与其他插件（共用 log.js）保持一致，带 `[插件名]` 前缀——
   * 否则按插件名过滤日志会漏掉本插件（status-companion.ps1 就因此一度
   * 把 companion-web 报成"未就绪"）。
   */
  const log = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] [${name}] ${message}\n`
    try {
      appendFileSync(logPath, line)
    } catch {
      /* 日志失败不能影响主流程 */
    }
    const logger = ctx.logger(name)
    if (level === 'error') logger.error(message)
    else if (level === 'warn') logger.warn(message)
    else logger.info(message)
  }

  const ready = (async () => {
    log('info', 'ready(): 开始')
    // 关键时序：等整棵树挂载完成再创建 Agent。
    // agent-loop 的工厂是在它的构造函数里注册的，而构造函数要等它 inject 的
    // sessionProjections 等六项服务就绪；因此在本插件 apply() 时工厂可能还没注册，
    // 直接 create() 会得到 "no agent factory registered"。
    await ctx.get('loader')?.await()
    log('info', 'loader 已完成挂载')

    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const defaultModel = ctx.get('agentDefaultModel')
    log('info', `服务可用性 agents=${agents !== undefined} sessions=${sessions !== undefined} defaultModel=${defaultModel !== undefined}`)
    if (agents === undefined || sessions === undefined || defaultModel === undefined) {
      throw new Error('agents / sessions / agentDefaultModel 三项服务必须就绪')
    }

    // 复用自己的会话：会话 id 落在 state 里，重启后接着上一次继续，而不是另开一段。
    let stored
    try {
      stored = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      stored = undefined
    }

    const selection = defaultModel.currentSelection()
    log('info', `模型路由 provider=${selection.provider} model=${selection.model}`)
    if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') {
      throw new Error(`agentDefaultModel 未给出可用的 provider/model：${JSON.stringify(selection)}`)
    }
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
    }

    let handle
    if (typeof stored?.sessionId === 'string' && stored.sessionId !== '') {
      log('info', `尝试恢复会话 ${stored.sessionId}`)
      try {
        // 注意字段名是 resumeSessionId（ResumeAgentOptions），不是 sessionId ——
        // 写错会让持久化层拿到 undefined，报 encodeSegment 的 TypeError。
        handle = await agents.resume({
          resumeSessionId: stored.sessionId,
          agentOptions,
          setup,
        })
        log('info', `恢复成功 session=${String(handle.agent.session.id)} 事件数=${handle.agent.session.seq}`)
      } catch (error) {
        log('warn', `恢复会话失败，改为新建：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      }
    }

    if (handle === undefined) {
      // agent id 必须与 session id 一致（registry 会校验），格式沿用 dsh 的 `session-<uuid>`。
      const sessionId = brandString(`session-${randomUUID()}`)
      log('info', `创建新会话 ${sessionId}`)
      handle = await agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
      log('info', `创建成功 session=${String(handle.agent.session.id)}`)
    }
    writeFileSync(statePath, `${JSON.stringify({ sessionId: String(handle.agent.session.id) }, null, 2)}\n`)

    agent = handle.agent
    log('info', '等待 agent 静止')
    await agent.whenIdle()
    // 立刻落盘一次，让"会话不丢"可被外部直接检视（sessions.flush）。
    log('info', 'flush 会话')
    await sessions.flush(agent.session)

    log('info', `伴侣会话就绪：${String(agent.session.id)}`)
    broadcast({ type: 'ready', sessionId: String(agent.session.id) })
    return agent
  })().catch((error) => {
    readyError = error instanceof Error ? error.stack ?? error.message : String(error)
    log('error', `ready() 失败：${readyError}`)
    return undefined
  })

  // ── 状态通道：情绪/关系变化 → 前端立绘与面板 ─────────────────────────────
  // 可选依赖：情感骨骼缺席时（例如只跑通道层做排查）这条通道自动静默。
  ctx.inject(['companionAffect'], (affectCtx) => {
    const affect = affectCtx.companionAffect
    // 订阅接口返回退订函数则由 effect 托管；返回 boolean 之类则忽略。
    const unsubscribe = affect.subscribe((payload) => {
      if (payload?.type === 'affect.update') latestState = payload
      broadcast(payload)
    })
    if (typeof unsubscribe === 'function') ctx.effect(() => unsubscribe, 'companion-web.affect()')
    log('info', '已接上状态通道（affect.update）')
  })

  // ── 主动性通道：她主动开口时给前端打标 ───────────────────────────────────
  ctx.inject(['companionInitiative'], (initiativeCtx) => {
    const initiative = initiativeCtx.companionInitiative
    const unsubscribe = initiative.subscribe((payload) => {
      broadcast(payload)
    })
    if (typeof unsubscribe === 'function') ctx.effect(() => unsubscribe, 'companion-web.initiative()')
    log('info', '已接上主动性通道（initiative.fired）')
  })

  // ── 流式：先缓冲，出境体检后再广播 ──────────────────────────────────────
  // 为什么不边流边播：出境体检要在**完整文本**上判断才可靠（"我不是AI"只有拼起来
  // 才看得出来），而流式增量一旦发出去就没法收回。安全优先于"逐字蹦"的观感，
  // 所以这里攒成一段、体检通过后一次性广播。
  ctx.effect(() => ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (agent === undefined || subject !== agent) return
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'text-delta' && chunk.text !== '') {
      runningHadDelta = true
      pendingText += chunk.text

      // ── 流式外发（此前是"攒完再一次性发"，用户要求改成真流式）─────────────
      // 边到边发，同时把表情标记剥掉——标记绝不能出现在聊天界面上。
      // 提示词已不再要求模型写标记，但**老会话历史里还有**，模型可能跟着模仿；
      // 另外标记被切在两个 chunk 之间时，不做挂起就会漏出半截（见 MarkHoldback）。
      if (liveFilter === null) {
        liveFilter = new MarkHoldback()
        // 临时埋点：量一下模型增量到底是"陆续到达"还是"一次性涌出"。
        firstChunkAt = Date.now()
        streamChunkCount = 0
      }
      streamChunkCount += 1
      lastChunkAt = Date.now()
      const visible = liveFilter.push(chunk.text)
      if (visible !== '') {
        streamChars += visible.replace(/\s/g, '').length
        broadcast({ type: 'message.delta', text: visible })
      }
    }
  }), 'companion-web.stream()')

  /**
   * 定稿一条回复：剥表情标记 → 过出境体检 → 收尾广播。
   * 所有出站路径（用户发言、主动开口）都必须走这里。
   *
   * ⚠️ 与改造前的关键差别：正文**已经通过 message.delta 流式发出去了**，
   * 所以这里**不能再广播一次完整正文**（那会把气泡内容翻倍）。
   * 正常情况只补一条 message.done；只有护栏改写了文本时才补一条 message.replace 让前端纠正。
   *
   * @param fromSeq - 本回合起始 seq；给了就直接从会话日志取完整正文（更可靠）。
   */
  const finalizeReply = (fromSeq) => {
    const current = agent
    if (current === undefined) return ''
    let raw = ''
    if (fromSeq !== undefined) {
      for (const event of current.session.snapshotEvents(fromSeq)) {
        if (event.type !== 'assistant/message') continue
        const text = blocksToText(event.data?.message?.content)
        if (text !== '') raw = text
      }
    }
    if (raw === '') raw = pendingText

    // 剥掉（老会话历史可能残留的）表情标记，拿到干净正文。
    const visible = stripEmotionMarks(raw)
    pendingText = ''

    const guard = ctx.get('companionGuard')
    let outbound = visible
    let rewritten = false
    if (guard !== undefined) {
      // 护栏读**剥离后的正文**（标记是给程序看的，不该参与安全检查）
      const result = guard.inspectOutbound(visible, current)
      if (result.changed) {
        log('warn', `出境体检改写了一条回复（${result.violations.map((v) => v.label).join(' / ')}）`)
        outbound = result.text
        rewritten = true
      }
    }

    // 护栏改写了 → 已经流式发出去的正文是错的，必须让前端整段替换
    if (rewritten) {
      broadcast({ type: 'message.replace', text: outbound })
    }

    // 输出模式诊断。
    //
    // ⚠️ 这里曾经用"增量跨度是否 < 200ms"来判断输出模式，并让前端走两条不同路径。
    // 那是个**错误的设计**——实测日志证明这个判断会反复横跳：
    //     paced   增量 15 块，跨度 26ms，   可见字符 9
    //     stream  增量 142 块，跨度 542ms， 可见字符 122
    //     paced   增量 88 块，跨度 29ms，   可见字符 82
    //     stream  增量 231 块，跨度 831ms， 可见字符 264
    // 于是短回复走"节拍吐字 + 立绘按段驱动"，长回复走"一次性落文本 + 立绘只靠
    // 瞬时的 message.emotion 驱动"——后者正是用户报的
    // "流式有时候失效" + "动态不是所有时候都有"。
    //
    // 而且跨度的差异只是**模型吐字快慢**，不是"流式与否"：
    // 542ms/122 字 ≈ 224 字/秒，远快于阅读速度，所以无论如何都要节拍化。
    //
    // 现在的做法：**不再分模式**，输出节奏统一由前端的节拍器决定，
    // 立绘统一由 segments 驱动。这里只保留诊断日志。
    if (streamChunkCount > 0) {
      const spread = lastChunkAt - firstChunkAt
      const cps = spread > 0 ? Math.round((streamChars / spread) * 1000) : 0
      log(
        'info',
        `流式诊断：增量 ${String(streamChunkCount)} 块，跨度 ${String(spread)}ms，`
        + `可见字符 ${String(streamChars)}（模型吐字约 ${String(cps)} 字/秒）`
        + ` ⇒ 统一交前端节拍化输出`,
      )
    }

    // 说话分段：句末标点处断开。前端按它决定"分几次说、每次之间停多久"。
    // 旧分段来自情绪标记（一段一个表情），标记体系删除后改用句子。
    const segments = splitSentences(outbound).map((text) => ({
      label: 'calm',
      intensity: 0,
      text,
      chars: text.length,
    }))

    broadcast({
      type: 'message.done',
      text: outbound,
      // 说话分段：每段 { label, intensity, text, chars }。
      // 前端按它逐段吐字；label/intensity 已无视觉含义，保留字段形状免前端改形。
      segments,
      // 流式期间已发出的可见字符数
      streamedChars: streamChars,
    })

    // 收尾复位，避免影响下一个回合
    resetStreamState()
    return outbound
  }

  // ── 回合收尾：通知前端刷新 ───────────────────────────────────────────────
  // 这里同时承担**主动开口的收尾**：她主动说话走的是 clock 的 agent.followup()，
  // 不经过 handleChat，所以文本流会一直挂在"正在输入"状态。
  // 判定依据是"本回合确实产生了新的 assistant 文本"，避免纯工具回合产生空收尾。
  ctx.effect(() => ctx.on('agent/status', ({ agent: subject, status }) => {
    if (agent === undefined || subject !== agent) return
    broadcast({ type: 'agent.status', status })

    if (status === 'running') {
      runningFromSeq = agent.session.seq
      runningHadDelta = false
      // 回合开始：复位流式状态（剥离器、字符计数、标记记录）。
      // 放在这里而不是 handleChat 里，是因为**主动开口**那条路径不经过 handleChat。
      resetStreamState()
      return
    }

    // status 回到 idle：若本回合有增量且还没收尾，就走统一的定稿路径。
    if (status === 'idle' && runningHadDelta && runningFromSeq !== undefined) {
      runningHadDelta = false
      const from = runningFromSeq
      runningFromSeq = undefined
      const reply = finalizeReply(from)
      log('info', `主动回合收尾 回复长度=${String(reply.length)}`)
      // 用户发言那条路径也会收尾；已在它自己那里发过一次，这里标记避免重复。
      finalizedByStatusHook = true
    }
  }), 'companion-web.status()')

  /** 处理一条用户消息：投递到常驻 Agent 并等待回合结束。 */
  const handleChat = async (ws, text) => {
    const current = agent ?? await ready
    if (current === undefined) {
      ws.send(JSON.stringify({ type: 'error', code: 'agent_unavailable', message: '伴侣会话未就绪（缺服务或创建失败），请看服务端日志。' }))
      return
    }
    if (current.status === 'running') {
      ws.send(JSON.stringify({ type: 'error', code: 'busy', message: '她还在说上一句，稍等一下。' }))
      return
    }
    if (typeof text !== 'string' || text.trim() === '') return

    // 标签只进模型输入，不进界面显示：让模型能区分"用户说的"与"插件注入的上下文"。
    const forModel = `${config.speakerLabel}：${text}`
    const turnStartSeq = current.session.seq
    finalizedByStatusHook = false
    current.followup(createUserMessage({
      content: [{ type: 'text', text: forModel }],
      source: { kind: 'user' },
    }))

    try {
      await current.whenIdle()
      // status 钩子可能已经定稿过（同一回合的 idle 事件先于 whenIdle() 兑现），
      // 这时不再重复发，否则前端会收到两条 done。
      if (finalizedByStatusHook) {
        finalizedByStatusHook = false
        return
      }
      const reply = finalizeReply(turnStartSeq)
      log('info', `回合收尾 seq ${String(turnStartSeq)}→${String(current.session.seq)} 回复长度=${String(reply.length)}`)
    } catch (error) {
      log('error', `回合异常：${error instanceof Error ? error.message : String(error)}`)
      broadcast({
        type: 'error',
        code: 'turn_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ── HTTP + WebSocket ─────────────────────────────────────────────────────
  /**
   * 安全地从 `root` 下取一个文件路径。
   *
   * 用 `relative()` 判断是否越界，而不是 `startsWith(root)` ——
   * 后者会把 `/public-evil/` 误判为在 `/public/` 之内（前缀相同但不是子目录）。
   * @param root - 允许访问的根目录（已 resolve 的绝对路径）。
   * @param rel - 相对路径。
   * @returns 位于 root 内的绝对路径；越界时返回 undefined。
   */
  const safeJoin = (root, rel) => {
    const target = resolve(join(root, rel))
    const r = relative(root, target)
    if (r.startsWith('..') || isAbsolute(r)) return undefined
    return target
  }

  const serveStatic = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 现在只有 publicDir 一个根：剪纸素材落在 app/public/papercut/ 内，
    // 所以旧的 /avatar/ 外部挂载点（指向 assets/avatar 雪碧图）已随旧立绘一并删除。
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const target = safeJoin(publicDir, rel)
    if (target === undefined) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    // 前端源文件（index.html / app.js / papercut*.js / style.css / *.html）**一律 no-cache**。
    //
    // 踩过的坑：这条路径原先**完全没设缓存头**（上面 /avatar/* 那条设了，这条漏了）。
    // 于是浏览器按启发式规则自行决定缓存时长，改完 CSS/JS 后不硬刷新就看不到变化——
    // 表现为"我改了但界面没变"，只能靠反复 Ctrl+F5 绕过。
    //
    // `no-cache` 不是"不缓存"，而是**每次都要回源校验**（配合 ETag 就是 304，很便宜）。
    // 这些文件很小（合计约 92 KB）且改动频繁，值得这个代价。
    //
    // 例外：papercut/ 下的素材是构建产物、文件名不变内容就不变，长缓存可以省掉每次开页面
    // 24 次回源校验。**但 version.json 必须排除**：它是批次版本号，图片 URL 靠它加 `?v=`；
    // 若连它一起长缓存，前端就永远拿不到新版本号 —— 换素材批次后界面还是旧画风（踩过）。
    const immutable = rel.startsWith('papercut/') && !rel.endsWith('version.json')
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=86400' : 'no-cache',
    })
    createReadStream(target).pipe(res)
  }

  ctx.effect(() => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/companion/health')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          ok: readyError === undefined,
          sessionId: agent === undefined ? null : String(agent.session.id),
          status: agent === undefined ? (readyError === undefined ? 'starting' : 'failed') : agent.status,
          clients: clients.size,
          ...(readyError === undefined ? {} : { error: readyError }),
        }))
        return
      }

      // 人设排查口：她现在的设定是从哪来的、凭什么。
      //
      // 只读，且只在本机监听（127.0.0.1）。存在的理由：设定不再由表单决定，
      // 而是每回合从对话里长出来，所以"她到底被改成了什么样、依据是哪句原话"
      // 必须能被直接看到——否则推断就成了黑箱。
      if (req.url?.startsWith('/companion/persona')) {
        const affect = ctx.get('companionAffect')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          summary: affect?.describePersona?.() ?? null,
          card: affect?.persona?.() ?? null,
          base: affect?.personaBase?.() ?? null,
          traits: affect?.traits?.() ?? [],
          traces: affect?.personaTraces?.(10) ?? [],
        }))
        return
      }

      // 浏览器布局诊断回传口（配 public/diag.html）。
      //
      // 为什么需要它：本机 Chrome/Edge 都起不来（沙箱里都是空输出），
      // 我**无法在浏览器里渲染验证 CSS**。于是改用"让用户的浏览器测完回传"这条路：
      // diag.html 在页面里跑一遍 getComputedStyle / matchMedia，把结果 POST 到这里，
      // 落进日志供我读取。这是在没有本机浏览器的前提下拿到真实渲染数据的唯一办法。
      if (req.url?.startsWith('/companion/diag-report') && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body)
            log('info', `布局诊断回传：${JSON.stringify(parsed)}`)
          } catch {
            log('warn', `布局诊断回传解析失败，原文前 500 字：${body.slice(0, 500)}`)
          }
          res.writeHead(204).end()
        })
        return
      }

      serveStatic(req, res)
    })

    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/companion/ws') {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        clients.add(ws)
        ws.on('close', () => clients.delete(ws))
        ws.on('error', (error) => ctx.logger(name).warn(`socket 错误：${error.message}`))

        // 连上先给历史与状态，刷新页面后立绘/消息流都能恢复。
        const current = agent
        ws.send(JSON.stringify({
          type: 'init',
          sessionId: current === undefined ? null : String(current.session.id),
          status: current === undefined ? 'starting' : current.status,
          history: current === undefined ? [] : historyFrom(current.session.snapshotEvents(), config.speakerLabel),
          state: latestState ?? null,
        }))

        ws.on('message', (raw) => {
          let message
          try {
            message = JSON.parse(String(raw))
          } catch {
            ws.send(JSON.stringify({ type: 'error', code: 'bad_json', message: '消息不是合法 JSON。' }))
            return
          }
          if (message?.type === 'chat.send') {
            handleChat(ws, message.text).catch((error) => {
              ctx.logger(name).error(error)
            })
            return
          }
          if (message?.type === 'state.query') {
            const now = agent
            ws.send(JSON.stringify({
              type: 'init',
              sessionId: now === undefined ? null : String(now.session.id),
              status: now === undefined ? 'starting' : now.status,
              history: now === undefined ? [] : historyFrom(now.session.snapshotEvents(), config.speakerLabel),
              state: latestState ?? null,
            }))
            return
          }
          // 主动性排障通道：她为什么没开口，比"什么都没发生"更好查。
          if (message?.type === 'initiative.inspect') {
            const affect = ctx.get('companionAffect')
            const initiative = ctx.get('companionInitiative')
            ws.send(JSON.stringify({
              type: 'initiative.inspect',
              lastTick: initiative?.lastTick?.() ?? null,
              budget: affect?.initiativeState?.() ?? null,
              memories: (affect?.listMemories?.(10) ?? []).map((card) => ({
                id: card.id,
                subject: card.subject,
                content: card.content,
                importance: card.importance,
                toldCount: card.toldCount,
                mentions: card.mentions,
              })),
              recent: initiative?.recent?.(10) ?? [],
            }))
            return
          }
          // 手动催一次 tick：把空闲阈值等条件在测试里缩短到秒级，不必真等 8 小时。
          if (message?.type === 'initiative.poke') {
            const initiative = ctx.get('companionInitiative')
            const result = initiative?.poke?.() ?? null
            ws.send(JSON.stringify({ type: 'initiative.poke', result }))
            return
          }
          // 问卷体系（persona.form / persona.submit）已随「填表定制她」一并删除：
          // 她的设定改由 infer.js 从真实对话里推断，不再由前端提交。
        })
      })
    })

    server.on('error', (error) => {
      log('error', `HTTP 服务错误：${error.message}${error.code === 'EADDRINUSE' ? `（端口 ${config.port} 已被占用，可能已有一个实例在跑）` : ''}`)
    })

    server.listen(config.port, config.host, () => {
      log('info', `companion 前端已就绪：http://${config.host}:${String(config.port)}`)
    })

    return () => {
      for (const ws of clients) ws.terminate()
      clients.clear()
      wss.close()
      server.close()
    }
  }, 'companion-web.http()')
}

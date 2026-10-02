// companion-initiative 的决策逻辑 —— 纯函数，便于脱离运行时单测。
//
// 设计要点（架构方案 §4.2）：
//   · **不预测"下一说话者"**。Inner Thoughts（CHI'25）实测 GPT-4o 在 self-selection
//     场景准确率仅 0.121，低于随机基线 0.127；因此这里用**动机评分**，不是分类器。
//   · 预算门与动机分**分离**：分数决定"值不值得说"，门决定"现在能不能说"。
//     两者混在一起会让调参变成玄学。
//   · 默认保守：宁可少说。伴侣类产品最大的体验杀手是打扰。

/** 主动开口的类型。 */
export const INITIATIVE_KINDS = {
  memory: '想起他之前说过的事',
  idle: '他很久没说话了',
}

/**
 * 算出一条主动消息的动机分。
 *
 * 刻意做成可解释的加法（每一项都对应一个真实理由），
 * 而不是拍一个 0–1 的黑箱分——调参时要知道是哪一项把它推过阈值的。
 * @param candidate - { kind, memory, relation, idleHours, hoursSinceTold }。
 * @returns `{ score, breakdown }`。
 */
export function scoreMotivation(candidate) {
  const parts = []
  const add = (label, value) => {
    if (value > 0) parts.push({ label, value: Number(value.toFixed(2)) })
    return value
  }

  let score = 0

  if (candidate.kind === 'memory') {
    // 事情越重要越值得提
    add('memory-importance', (candidate.memory?.importance ?? 5) * 0.6)
    // 越久没提过越新鲜
    const sinceTold = candidate.hoursSinceTold ?? 168
    add('staleness', Math.min(2, sinceTold / 72))
    // 关系越近越有资格主动提私事
    add('closeness', (candidate.relation?.intimacy ?? 0) * 4)
    // 有段时间没聊了，提起来才自然（刚聊完就"我想起你说过"很假）
    add('idle-window', Math.min(2, (candidate.idleHours ?? 0) / 12))
  } else if (candidate.kind === 'idle') {
    // 空闲本身构成理由，但权重低于"有事想说"
    add('idle-hours', Math.min(4, (candidate.idleHours ?? 0) / 6))
    add('closeness', (candidate.relation?.intimacy ?? 0) * 3)
    add('rapport', (candidate.relation?.rapport ?? 0) * 2)
  } else if (candidate.kind === 'date') {
    add('date-proximity', 7)
    add('memory-importance', (candidate.memory?.importance ?? 5) * 0.4)
  }

  score = parts.reduce((sum, part) => sum + part.value, 0)
  return { score: Number(score.toFixed(2)), breakdown: parts }
}

/** 把毫秒差换算成小时。 */
function hoursSince(fromMs, nowMs) {
  if (fromMs === undefined || fromMs === null) return Number.POSITIVE_INFINITY
  return Math.max(0, (nowMs - fromMs) / 3_600_000)
}

/** 解析 "HH:MM" 形式的时刻为当天的分钟数。 */
function minutesOfDay(text) {
  const [h, m] = String(text).split(':')
  return Number(h) * 60 + Number(m ?? 0)
}

/**
 * 判断"现在是否处于静默时段"。支持跨零点（如 23:00–08:00）。
 * @param now - 参考时间。
 * @param quietHours - `[start, end]`，如 `['23:00', '08:00']`。
 * @returns 是否应保持静默。
 */
export function inQuietHours(now, quietHours) {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = minutesOfDay(quietHours[0])
  const end = minutesOfDay(quietHours[1])
  if (start === end) return false
  return start < end
    ? cur >= start && cur < end      // 同日区间
    : cur >= start || cur < end      // 跨零点区间
}

/**
 * 预算门：决定"现在能不能说"。
 *
 * 每道门失败都返回一个**可读的原因**，这样日志与前端能解释"她为什么没开口"——
 * 排查主动性时，"什么都没发生"是最难查的状态。
 * @param input - 时间、配置与状态。
 * @returns `{ allowed, reason, cooldownMs }`。
 */
export function checkGates(input) {
  const { now, config, state } = normalizeGateInput(input)

  if (state.agentBusy) return deny('agent-busy')

  if (config.respectQuietHours && inQuietHours(now, config.quietHours)) return deny('quiet-hours')

  if (state.sentToday >= config.dailyCap) return deny('daily-cap')

  // 冷却随"连续未获回应"退避：她说了没人理，就该更安静，而不是更频繁。
  const baseCooldown = config.minCooldownMinutes * 60_000
  const backoff = config.missBackoffFactor ** Math.max(0, state.missStreak)
  const cooldownMs = baseCooldown * backoff
  const sinceLast = now.getTime() - (state.lastSentAt ?? 0)
  if (state.lastSentAt !== undefined && sinceLast < cooldownMs) {
    return { allowed: false, reason: 'cooldown', cooldownMs, remainingMs: cooldownMs - sinceLast }
  }

  const idleHours = hoursSince(state.lastUserAt, now.getTime())
  const threshold = idleThresholdFor(input.kind ?? 'idle', config)
  if (idleHours < threshold) return deny('not-idle-enough', { idleHours, threshold })

  return { allowed: true, reason: 'ok', idleHours, cooldownMs }
}

/**
 * 空闲门阈值：多久没说话才允许主动找他。
 *
 * 对**记忆型**候选放宽到最多 2.5 小时。理由（P5 回归发现的问题）：
 * 统一用 8 小时门槛时，7 天模拟里她恰好一天只开口一次、且都落在同一个时段——
 * 因为 8 小时空闲配上用户每天 4 个活跃时段，实际只剩一个窗口。
 * 一个固定在某个钟点说话的伴侣是僵硬的；而"想起一件事"本来就该更随性。
 * 空闲型候选仍用完整阈值——没事找事，才需要一个像样的理由。
 * @param kind - 候选类型（memory / idle）。
 * @param config - 含 idleThresholdHours。
 * @returns 该类型适用的空闲阈值（小时）。
 */
function idleThresholdFor(kind, config) {
  return kind === 'memory' ? Math.min(config.idleThresholdHours, 5) : config.idleThresholdHours
}

/**
 * 动机阈值：分数过多少才真的开口。
 *
 * 记忆型用更高的门槛。这是被 P5 回归逼出来的结论：
 * 起初"想更自然一点"的做法是**放宽空闲门**，结果一天从 0.86 次涨到 2.43 次、
 * 大部分日子撞满每日上限——从"偶尔想起你"变成"例行三条"。
 * 正确的手段是**提高开口门槛**：记忆型只有真的值得才说，
 * 频次自然降下来，而每次开口的分量上去了。
 * @param kind - 候选类型。
 * @param config - 含 motivationThreshold / memoryThreshold。
 * @returns 适用的阈值。
 */
function thresholdFor(kind, config) {
  if (kind !== 'memory') return config.motivationThreshold
  // 1.35 而不是更高的倍数：×1.5 时中低亲密度下记忆型候选几乎永远过不了阈
  //（实测典型候选 10.27 vs 阈值 10.5），那就等于把"想起你"这条通道关掉了。
  // 1.35 既让它明显难过空闲型，又在中低亲密度下可达。
  return config.memoryThreshold ?? config.motivationThreshold * 1.35
}

/** 统一门检查的入参形状，避免调用方各写一份默认值。 */
function normalizeGateInput(input) {
  const config = {
    dailyCap: 3,
    minCooldownMinutes: 90,
    missBackoffFactor: 3,
    idleThresholdHours: 8,
    respectQuietHours: true,
    quietHours: ['23:00', '08:00'],
    ...input.config,
  }
  const state = {
    sentToday: 0,
    missStreak: 0,
    agentBusy: false,
    lastSentAt: undefined,
    lastUserAt: input.now.getTime(),
    ...input.state,
  }
  return { now: input.now, config, state, relation: input.relation }
}

/** 构造一个"被拒绝"的门结果。 */
function deny(reason, extra = {}) {
  return { allowed: false, reason, ...extra }
}

/**
 * 组装最终决定：先算候选的动机分，再按分数与门挑出**一个**要发的。
 *
 * 阈值**按候选类型分别判定**：记忆型用更高的门槛（见 thresholdFor），
 * 这样"想更自然地开口"是靠提高标准实现，而不是靠放宽时机——后者只会变成刷频。
 * @param input - { candidates, config, state, relation, now }。
 * @returns `{ send, chose, gate, ranked }`。
 */
export function decide(input) {
  const now = input.now ?? new Date()
  const config = { motivationThreshold: 7, ...(input.config ?? {}) }

  const ranked = (input.candidates ?? [])
    .map((candidate) => {
      const { score, breakdown } = scoreMotivation(candidate)
      const threshold = thresholdFor(candidate.kind, config)
      return { ...candidate, score, breakdown, threshold, passes: score >= threshold }
    })
    .sort((a, b) => b.score - a.score)

  const passes = ranked.filter((item) => item.passes)
  if (passes.length === 0) {
    return { send: false, gate: { allowed: false, reason: 'below-threshold' }, ranked }
  }

  const gate = checkGates({ ...input, now, kind: passes[0].kind })
  if (!gate.allowed) return { send: false, gate, ranked }

  return { send: true, chose: passes[0], gate, ranked }
}

/**
 * 渲染主动开口时投递给模型的内部提示。
 *
 * 用 user 角色是**必须**的：长上下文训练让模型对 user 角色更敏感，system 里的一条
 * "去主动说话"很容易被淹没。因此要在文本里明确标注这不是他说的话，避免她以为用户开口了。
 * @param chose - decide() 选中的候选。
 * @returns 投递文本。
 */
export function renderInitiativePrompt(chose) {
  const lines = [
    '【内部提示 · 不是他说的话】',
    '你想主动找他说话。下面是你此刻的念头，请据此自然开口：',
    '',
  ]
  if (chose.kind === 'memory' && chose.memory !== undefined) {
    lines.push(`你忽然想起他说过的一件事：「${chose.memory.content}」。`)
    lines.push('像自己想起来一样自然地说出来，可以问问他后来怎么样了。')
  } else if (chose.kind === 'idle') {
    lines.push(`他已经 ${Math.round(chose.idleHours ?? 0)} 小时没跟你说话了，你有点想他。`)
  } else if (chose.kind === 'date') {
    lines.push(`他提过的日子快到了：「${chose.memory?.content ?? ''}」。`)
  }
  lines.push('', '要求：')
  lines.push('- 一到两句，口语，像微信上突然发来的消息。')
  lines.push('- 不要提这条提示，不要解释你为什么找他。')
  lines.push('- 如果他之前明显在难过，语气要先照顾他。')
  return lines.join('\n')
}

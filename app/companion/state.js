// companion 情感状态机 —— 情绪 + 关系，持久化在 SQLite。
//
// 两个状态明确解耦（架构方案 §8.3）：
//   · 情绪 = 易变、可重建的当下状态，会随时间衰减
//   · 关系 = 慢变量，按日历时间演进，不可丢
//
// 情绪模型：离散标签为键、强度 0–10 为值（LLM 友好、省 token），
// 每种情绪有各自的衰减半衰期；PAD 只在引擎内部插值，用于语气强度与立绘。
// 关系模型：四原则防刷分（架构方案 §5.2）。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 情绪标签。前六个是基本情绪，affection/hurt 是伴侣场景特有的关系型情绪。 */
export const EMOTIONS = ['joy', 'sadness', 'anger', 'fear', 'surprise', 'affection', 'hurt', 'calm']

/**
 * 负性情绪集合。用于"心情调制消退"（见 readAffect）。
 * calm 是中性稳态、affection 是正性，都不在此列。
 */
export const NEGATIVE = new Set(['sadness', 'anger', 'fear', 'hurt'])

/** 各情绪的中文名（注入提示词与推送前端用）。 */
export const EMOTION_LABELS = {
  joy: '开心',
  sadness: '难过',
  anger: '生气',
  fear: '不安',
  surprise: '惊讶',
  affection: '心动',
  hurt: '受伤',
  calm: '平静',
}

/**
 * 每种情绪的衰减半衰期（小时）。这是"她会自己好起来"的核心参数。
 *
 * 标定过程（P5 回归驱动）：最初 joy=3h、sadness=6h，但持续交互下负性情绪
 * 每轮只衰减 3.6%、却打进 1.5，于是平衡点落在 7–8（实测残留 sadness=8.78）。
 * 现在的取值让**持续交互下的平衡点落在 3–5**，同时保留"受伤比开心持续更久"的直觉。
 */
const HALF_LIFE_HOURS = {
  joy: 2.5,
  sadness: 3.5,
  anger: 3,
  fear: 3.5,
  surprise: 0.5,
  affection: 5,
  hurt: 6,
  calm: 1.5,
}

/** 情绪低于此值即视为消失（OCC 的 Thres 思想：低于阈值消亡，而不是无限逼近）。 */
const EMOTION_THRESHOLD = 0.15

/**
 * `persona_trace` 的保留行数上限（写入时轮转，**不是无界账本**）。
 *
 * 这条流水是"她推断了什么、凭什么、丢了什么"的账本，价值高，但只有最近几天对排障有用。
 * 写入频率约每次推断一行（默认每 2 回合一次 LLM + 每次显式指令一次规则），
 * 按每天 50 回合算约 30 行/天——不设上限的话一年就是一万多行，库体积与排查查询白涨。
 */
export const PERSONA_TRACE_LIMIT = 200

/** 关系阶段阈值。注意这是**自研**取值，无公开工程标准，需按体感调。 */
const STAGES = [
  { id: 'stranger', label: '陌生', minTurns: 0, trust: 0, intimacy: 0 },
  { id: 'acquaintance', label: '熟识', minTurns: 20, trust: 0.25, intimacy: 0.15 },
  { id: 'close', label: '亲近', minTurns: 80, trust: 0.5, intimacy: 0.4 },
  { id: 'intimate', label: '亲密', minTurns: 200, trust: 0.72, intimacy: 0.65 },
]

/**
 * 把年/月/日/时换算成小时差。
 * @param fromMs - 起始时间戳（毫秒）。
 * @param toMs - 结束时间戳（毫秒）。
 * @returns 小时数，负数钳制为 0（时钟倒退时不让状态乱跳）。
 */
function hoursBetween(fromMs, toMs) {
  return Math.max(0, (toMs - fromMs) / 3_600_000)
}

/**
 * 按半衰期做指数衰减。
 * @param value - 当前强度。
 * @param halfLifeHours - 半衰期（小时）。
 * @param elapsedHours - 经过小时数。
 * @returns 衰减后的强度。
 */
function decay(value, halfLifeHours, elapsedHours) {
  if (elapsedHours <= 0 || value <= 0) return value
  return value * 0.5 ** (elapsedHours / halfLifeHours)
}

/** 把数值钳制到区间。 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 情感状态机。持有 SQLite 连接，暴露情绪与关系两套读写。
 */
export class CompanionState {
  /**
   * @param dbPath - SQLite 文件路径；目录不存在会自动创建。
   */
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS affect (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        emotions     TEXT    NOT NULL,
        mood_p       REAL    NOT NULL DEFAULT 0,
        mood_a       REAL    NOT NULL DEFAULT 0,
        mood_d       REAL    NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relation (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        trust        REAL    NOT NULL DEFAULT 0.05,
        intimacy     REAL    NOT NULL DEFAULT 0.02,
        rapport      REAL    NOT NULL DEFAULT 0.1,
        stage        TEXT    NOT NULL DEFAULT 'stranger',
        since        INTEGER NOT NULL,
        turns        INTEGER NOT NULL DEFAULT 0,
        decayed_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS affect_log (
        at           INTEGER NOT NULL,
        label        TEXT    NOT NULL,
        delta        REAL    NOT NULL,
        intensity    REAL    NOT NULL,
        cause        TEXT
      );
      CREATE TABLE IF NOT EXISTS relation_log (
        at           INTEGER NOT NULL,
        signal       REAL    NOT NULL,
        disclosure   REAL    NOT NULL,
        trust        REAL    NOT NULL,
        intimacy     REAL    NOT NULL,
        stage        TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS persona (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        card         TEXT    NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      -- 从**真实对话**里推断出的设定：每个维度一行，永远挂着用户原话当证据。
      --
      -- 为什么与 persona 表分开：persona 存的是**基线卡**（用户手填过、或默认播种的），
      -- 这张表存的是**相处里长出来的覆盖项**。两者都留着、读时叠加，于是
      -- ① 老库一个字都不用改；② 推断整体可撤销（删这张表就回到基线）。
      CREATE TABLE IF NOT EXISTS persona_trait (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        confidence  REAL NOT NULL DEFAULT 0.5,
        evidence    TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT 'llm',
        samples     INTEGER NOT NULL DEFAULT 1,
        first_at    INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      -- 每次推断动作的流水（含被拒条目），用来回答"她推断了什么、凭什么"。
      -- 只保留最近 PERSONA_TRACE_LIMIT 行（写入时轮转），不是无界账本。
      CREATE TABLE IF NOT EXISTS persona_trace (
        at          INTEGER NOT NULL,
        source      TEXT    NOT NULL,
        turn        INTEGER NOT NULL DEFAULT 0,
        accepted    TEXT    NOT NULL DEFAULT '[]',
        rejected    TEXT    NOT NULL DEFAULT '[]',
        note        TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS persona_trace_at ON persona_trace (at DESC);
      -- 事实卡片：不可丢的长期资产（与情绪表刻意分开，见架构方案 §8.3）
      CREATE TABLE IF NOT EXISTS memory (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        subject      TEXT    NOT NULL,
        content      TEXT    NOT NULL,
        keywords     TEXT    NOT NULL,
        importance   INTEGER NOT NULL DEFAULT 5,
        first_at     INTEGER NOT NULL,
        last_at      INTEGER NOT NULL,
        mentions     INTEGER NOT NULL DEFAULT 1,
        -- 主动提起过的次数与最近一次，用于"同一条别反复说"
        told_count   INTEGER NOT NULL DEFAULT 0,
        told_at      INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS memory_dedupe ON memory (subject, content);
      -- 主动开口的记录与预算
      CREATE TABLE IF NOT EXISTS initiative_log (
        at           INTEGER NOT NULL,
        kind         TEXT    NOT NULL,
        score        REAL    NOT NULL,
        content      TEXT    NOT NULL,
        memory_id    INTEGER,
        outcome      TEXT    NOT NULL DEFAULT 'sent'
      );
      CREATE TABLE IF NOT EXISTS initiative_state (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        last_sent_at  INTEGER,
        -- 连续未获回应的次数，用于冷却退避
        miss_streak   INTEGER NOT NULL DEFAULT 0,
        -- 最近一次用户说话的时间（判定空闲时长）
        last_user_at  INTEGER NOT NULL
      );
    `)
    this.#seed()
  }

  /** 插入单例行（幂等）。 */
  #seed() {
    const now = Date.now()
    this.db.prepare('INSERT OR IGNORE INTO affect (id, emotions, updated_at) VALUES (1, ?, ?)')
      .run('{}', now)
    this.db.prepare('INSERT OR IGNORE INTO relation (id, since, decayed_at) VALUES (1, ?, ?)')
      .run(now, now)
    this.db.prepare('INSERT OR IGNORE INTO initiative_state (id, last_user_at) VALUES (1, ?)')
      .run(now)
  }

  /**
   * 读取并**顺带衰减**情绪状态。衰减写在读路径上，所以任何一次读取都拿到当前值，
   * 不依赖后台定时器是否刚好跑过。
   * @param nowMs - 参考时刻，默认当前时间。
   * @returns 情绪强度表（只含未消亡的）、PAD、以及本次衰减消掉的情绪。
   */
  readAffect(nowMs = Date.now()) {
    const row = this.db.prepare('SELECT emotions, mood_p, mood_a, mood_d, updated_at FROM affect WHERE id = 1').get()
    const elapsed = hoursBetween(Number(row.updated_at), nowMs)
    const before = JSON.parse(row.emotions)
    const moodP = Number(row.mood_p)
    const after = {}
    const faded = []
    for (const [label, intensity] of Object.entries(before)) {
      let halfLife = HALF_LIFE_HOURS[label] ?? 4
      // 心情调制消退（P5 回归发现的问题）。
      //
      // 起因：负性情绪"打得更重 + 退得更慢"双重不对称，3000 轮混合语料后
      // sadness 积到 8.78、fear 6.98 —— 等于长期背着一身没消化的难过。
      // 而真实心理现象是：心情好时负性情绪消退更快，心情差时更慢。
      if (NEGATIVE.has(label)) halfLife *= moodP > 0.15 ? 0.6 : moodP < -0.15 ? 1.4 : 1
      const next = decay(Number(intensity), halfLife, elapsed)
      if (next < EMOTION_THRESHOLD) faded.push(label)
      else after[label] = Number(next.toFixed(3))
    }
    // mood 也向基线漂移：它是"心情"，比情绪慢、比关系快。
    const drift = clamp(elapsed / 6, 0, 1)
    const mood = {
      p: Number((Number(row.mood_p) * (1 - drift)).toFixed(3)),
      a: Number((Number(row.mood_a) * (1 - drift)).toFixed(3)),
      d: Number((Number(row.mood_d) * (1 - drift)).toFixed(3)),
    }
    if (elapsed > 0.001) {
      this.db.prepare('UPDATE affect SET emotions = ?, mood_p = ?, mood_a = ?, mood_d = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(after), mood.p, mood.a, mood.d, nowMs)
      for (const label of faded) {
        this.db.prepare('INSERT INTO affect_log (at, label, delta, intensity, cause) VALUES (?, ?, ?, ?, ?)')
          .run(nowMs, label, 0, 0, 'decay-faded')
      }
    }
    return { emotions: after, mood, faded, elapsedHours: elapsed }
  }

  /**
   * 施加一批情绪增量（来自评价结果）。
   * @param deltas - 标签 → 增量（可为负）。
   * @param cause - 归因说明，写进日志便于回看。
   * @param nowMs - 参考时刻。
   * @returns 施加后的情绪状态。
   */
  applyEmotion(deltas, cause = 'appraisal', nowMs = Date.now()) {
    const current = this.readAffect(nowMs)
    const next = { ...current.emotions }
    const applied = []
    for (const [label, rawDelta] of Object.entries(deltas)) {
      if (!EMOTIONS.includes(label)) continue
      const delta = Number(rawDelta)
      if (!Number.isFinite(delta) || delta === 0) continue
      // 软上限（saturating）：越接近满格，新的增量越难推动。
      //
      // 为什么需要它：P5 回归发现纯正性交互下 joy/affection 会无上限累积到 9+，
      // 一个人不可能"被夸 400 轮后越来越开心"。真实体感是：已经很高兴时，
      // 新的好事只让你从 6 到 6.5。
      //
      // 但**保留一次性极端冲击能冲到 10**：所以在 5.0 以下不打折，
      // 之后线性衰减到 8.0 处的 0.5×、9.0 处的 0.2×。
      const before = next[label] ?? 0
      const scale = before <= 5 ? 1 : before <= 8 ? 1 - (before - 5) / 6 : Math.max(0.2, 1 - (before - 5) / 5)
      const value = clamp(before + delta * scale, 0, 10)
      if (value < EMOTION_THRESHOLD) delete next[label]
      else next[label] = Number(value.toFixed(3))
      applied.push({ label, delta: delta * scale, intensity: next[label] ?? 0 })
    }
    if (applied.length === 0) return current
    // mood 被情绪牵引：正性情绪抬 P，高唤醒抬 A，愤怒/掌控抬 D。
    // 增益刻意取小（0.03 量级）：mood 是"最近这段时间的心情"，不该被单条消息打满。
    // 踩过的坑：增益 0.06 时一句暖话就能把 mood_p 推到 0.99，mood 随即失去意义。
    const MOOD_GAIN = 0.03
    const p = clamp(current.mood.p + ((deltas.joy ?? 0) + (deltas.affection ?? 0)
      - (deltas.sadness ?? 0) - (deltas.anger ?? 0) - (deltas.hurt ?? 0)) * MOOD_GAIN, -1, 1)
    const a = clamp(current.mood.a + ((deltas.surprise ?? 0) + (deltas.fear ?? 0) + (deltas.anger ?? 0)
      - (deltas.calm ?? 0)) * MOOD_GAIN * 1.5, -1, 1)
    const d = clamp(current.mood.d + ((deltas.anger ?? 0) + (deltas.joy ?? 0)
      - (deltas.fear ?? 0) - (deltas.hurt ?? 0)) * MOOD_GAIN, -1, 1)

    // 一个事务包住"更新状态 + 写日志"：否则每条语句各一次 fsync，
    // 批量场景（回归测试、长时间高频交互）会慢两个数量级。
    this.db.exec('BEGIN')
    try {
      this.db.prepare('UPDATE affect SET emotions = ?, mood_p = ?, mood_a = ?, mood_d = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(next), p, a, d, nowMs)
      const insertLog = this.db.prepare('INSERT INTO affect_log (at, label, delta, intensity, cause) VALUES (?, ?, ?, ?, ?)')
      for (const item of applied) {
        insertLog.run(nowMs, item.label, item.delta, item.intensity, cause)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return { emotions: next, mood: { p, a, d }, faded: [], elapsedHours: 0 }
  }

  /**
   * 读取并**顺带衰减**关系状态。
   * P3 原则：按日历时间衰减，不按交互次数——否则沉默的用户也在涨分。
   * @param nowMs - 参考时刻。
   * @returns 关系状态。
   */
  readRelation(nowMs = Date.now()) {
    const row = this.db.prepare('SELECT trust, intimacy, rapport, stage, since, turns, decayed_at FROM relation WHERE id = 1').get()
    const elapsed = hoursBetween(Number(row.decayed_at), nowMs)
    // trust/intimacy 以"周"为尺度衰减，rapport（热络感）以"天"为尺度。
    const trust = decay(Number(row.trust), 24 * 30, elapsed)
    const intimacy = decay(Number(row.intimacy), 24 * 45, elapsed)
    const rapport = decay(Number(row.rapport), 24 * 2, elapsed)
    const days = hoursBetween(Number(row.since), nowMs) / 24
    const stage = resolveStage({ trust, intimacy, turns: Number(row.turns) })
    if (elapsed > 0.001) {
      this.db.prepare('UPDATE relation SET trust = ?, intimacy = ?, rapport = ?, stage = ?, decayed_at = ? WHERE id = 1')
        .run(Number(trust.toFixed(4)), Number(intimacy.toFixed(4)), Number(rapport.toFixed(4)), stage, nowMs)
    }
    return {
      trust: Number(trust.toFixed(4)),
      intimacy: Number(intimacy.toFixed(4)),
      rapport: Number(rapport.toFixed(4)),
      stage,
      days: Number(days.toFixed(1)),
      turns: Number(row.turns),
    }
  }

  /**
   * 施加一次交互对关系的影响。
   *
   * P1 逼近式增长：trust/intimacy += k·(1−当前值)·signal —— 越亲密越难再涨。
   * P2 不对称：负信号按原值生效，不给 (1−value) 折扣 —— 信任建立慢、崩塌快。
   * @param signal - 交互信号 −1…1（正=善意，负=伤害）。
   * @param disclosure - 自我披露程度 0…1（用户说了多少关于自己的事）。
   * @param nowMs - 参考时刻。
   * @returns 更新后的关系状态。
   */
  applyInteraction(signal, disclosure = 0, nowMs = Date.now()) {
    const current = this.readRelation(nowMs)
    const positive = signal > 0
    const disc = clamp(disclosure, 0, 1)
    const sig = clamp(signal, -1, 1)

    // 正增益随亲密递减；负增益不打折。
    const trustGain = positive ? 0.02 * (1 - current.trust) * sig : 0.05 * sig
    const intimacyGain = positive ? 0.03 * (1 - current.intimacy) * (sig + disc * 0.6) : 0.06 * sig
    // rapport（热络感）是快变量：一句暖心话就明显升温。
    const rapportGain = positive ? 0.18 * (1 - current.rapport) * (sig + disc * 0.4) : 0.25 * sig

    const trust = clamp(current.trust + trustGain, 0, 1)
    const intimacy = clamp(current.intimacy + intimacyGain, 0, 1)
    const rapport = clamp(current.rapport + rapportGain, 0, 1)

    // P4 多信号与门升级：阶段跃迁要求 trust/intimacy/回合数**同时**达标，禁单回合跳级。
    const turns = current.turns + 1
    const stage = resolveStage({ trust, intimacy, turns })

    this.db.prepare('UPDATE relation SET trust = ?, intimacy = ?, rapport = ?, stage = ?, turns = ?, decayed_at = ? WHERE id = 1')
      .run(Number(trust.toFixed(4)), Number(intimacy.toFixed(4)), Number(rapport.toFixed(4)), stage, turns, nowMs)
    this.db.prepare('INSERT INTO relation_log (at, signal, disclosure, trust, intimacy, stage) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowMs, sig, disc, Number(trust.toFixed(4)), Number(intimacy.toFixed(4)), stage)

    return { trust: Number(trust.toFixed(4)), intimacy: Number(intimacy.toFixed(4)), rapport: Number(rapport.toFixed(4)), stage, days: current.days, turns }
  }

  /** 读取人设卡（未初始化返回 undefined）。 */
  readPersona() {
    const row = this.db.prepare('SELECT card FROM persona WHERE id = 1').get()
    return row === undefined ? undefined : JSON.parse(row.card)
  }

  /**
   * 写入人设卡。
   * @param card - 人设对象。
   * @param nowMs - 参考时刻。
   */
  writePersona(card, nowMs = Date.now()) {
    this.db.prepare('INSERT INTO persona (id, card, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET card = excluded.card, updated_at = excluded.updated_at')
      .run(JSON.stringify(card), nowMs)
  }

  // ── 推断出的设定 ────────────────────────────────────────────────────────

  /**
   * 读取全部推断设定（新的在前）。
   * @returns `{ key, value, confidence, evidence, source, samples, firstAt, updatedAt }` 数组。
   */
  readTraits() {
    const rows = this.db.prepare(
      'SELECT key, value, confidence, evidence, source, samples, first_at, updated_at FROM persona_trait ORDER BY updated_at DESC',
    ).all()
    return rows.map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.value)),
      confidence: Number(row.confidence),
      evidence: String(row.evidence),
      source: String(row.source),
      samples: Number(row.samples),
      firstAt: Number(row.first_at),
      updatedAt: Number(row.updated_at),
    }))
  }

  /**
   * 写入一条推断设定（存在则覆盖）。
   *
   * 合并/累积的语义由调用方决定：这里只负责存。`samples` 表示这个值被观察到几次，
   * 用于区分"一句话定下的"和"反复印证过的"。
   * @param trait - `{ key, value, confidence, evidence, source, samples }`。
   * @param nowMs - 参考时刻。
   * @returns 落库后的 samples。
   */
  writeTrait(trait, nowMs = Date.now()) {
    const existing = this.db.prepare('SELECT samples, first_at FROM persona_trait WHERE key = ?').get(String(trait.key))
    const samples = Math.max(1, Math.round(Number(trait.samples ?? (existing === undefined ? 1 : Number(existing.samples) + 1))))
    const firstAt = existing === undefined ? nowMs : Number(existing.first_at)
    this.db.prepare(`
      INSERT INTO persona_trait (key, value, confidence, evidence, source, samples, first_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value, confidence = excluded.confidence, evidence = excluded.evidence,
        source = excluded.source, samples = excluded.samples, updated_at = excluded.updated_at
    `).run(
      String(trait.key),
      JSON.stringify(trait.value),
      Number(trait.confidence ?? 0.5),
      String(trait.evidence ?? ''),
      String(trait.source ?? 'llm'),
      samples,
      firstAt,
      nowMs,
    )
    return samples
  }

  /**
   * 清空推断设定（回到基线卡）。
   * @returns 删掉的行数。
   */
  clearTraits() {
    const result = this.db.prepare('DELETE FROM persona_trait').run()
    return Number(result.changes ?? 0)
  }

  /**
   * 记一次推断流水，并把表轮转回 {@link PERSONA_TRACE_LIMIT} 行以内。
   *
   * 轮转放在**写入路径**上（而不是定时器）：这张表只有推断会写，
   * 写完顺手裁一次既不用第二个定时器，也不会出现"长期不写就没人裁"。
   * 用 rowid 排序而不是 at：同一毫秒可能落两行（规则通道 + LLM 通道），
   * 按 at 去重会误删同刻的另一行。
   * @param record - `{ source, turn, accepted, rejected, note }`。
   * @param nowMs - 参考时刻。
   * @returns 本次裁掉的行数。
   */
  logPersonaTrace(record, nowMs = Date.now()) {
    this.db.prepare('INSERT INTO persona_trace (at, source, turn, accepted, rejected, note) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        nowMs,
        String(record.source ?? 'llm'),
        Number(record.turn ?? 0),
        JSON.stringify(record.accepted ?? []),
        JSON.stringify(record.rejected ?? []),
        String(record.note ?? ''),
      )
    const trimmed = this.db.prepare(
      'DELETE FROM persona_trace WHERE rowid NOT IN (SELECT rowid FROM persona_trace ORDER BY at DESC, rowid DESC LIMIT ?)',
    ).run(PERSONA_TRACE_LIMIT)
    return Number(trimmed.changes ?? 0)
  }

  /**
   * 最近的推断流水（新的在前）。
   * @param limit - 条数上限。
   * @returns 流水数组，accepted/rejected 已解析。
   */
  readPersonaTraces(limit = 10) {
    const rows = this.db.prepare('SELECT at, source, turn, accepted, rejected, note FROM persona_trace ORDER BY at DESC LIMIT ?')
      .all(Math.max(1, Math.round(Number(limit) || 10)))
    return rows.map((row) => ({
      at: Number(row.at),
      source: String(row.source),
      turn: Number(row.turn),
      accepted: JSON.parse(String(row.accepted)),
      rejected: JSON.parse(String(row.rejected)),
      note: String(row.note),
    }))
  }

  // ── 事实卡片（记忆层） ──────────────────────────────────────────────────

  /**
   * 记下一张事实卡片。同一 (subject, content) 已存在时只累加次数并刷新时间，
   * 并按新的重要度取较大值——用户第 N 次提到同一件事，说明它更重要。
   * @param fact - { subject, content, keywords, importance }。
   * @param nowMs - 参考时刻。
   * @returns 卡片 id。
   */
  remember(fact, nowMs = Date.now()) {
    const subject = String(fact.subject ?? 'general')
    const content = String(fact.content ?? '').trim()
    if (content === '') return undefined
    const importance = Math.max(1, Math.min(10, Math.round(Number(fact.importance) || 5)))
    const keywords = Array.isArray(fact.keywords) ? fact.keywords.join(' ') : String(fact.keywords ?? '')

    const existing = this.db.prepare('SELECT id, importance, mentions FROM memory WHERE subject = ? AND content = ?')
      .get(subject, content)
    if (existing !== undefined) {
      this.db.prepare('UPDATE memory SET last_at = ?, mentions = mentions + 1, importance = MAX(importance, ?), keywords = ? WHERE id = ?')
        .run(nowMs, importance, keywords, existing.id)
      return Number(existing.id)
    }
    const result = this.db.prepare(
      'INSERT INTO memory (subject, content, keywords, importance, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(subject, content, keywords, importance, nowMs, nowMs)
    return Number(result.lastInsertRowid)
  }

  /** 列出事实卡片（默认按重要度、再按最近提到排序）。 */
  listMemories(limit = 40) {
    return this.db.prepare(
      'SELECT id, subject, content, keywords, importance, first_at, last_at, mentions, told_count, told_at FROM memory ORDER BY importance DESC, last_at DESC LIMIT ?',
    ).all(Number(limit)).map((row) => ({
      id: Number(row.id),
      subject: String(row.subject),
      content: String(row.content),
      keywords: String(row.keywords).split(' ').filter((k) => k !== ''),
      importance: Number(row.importance),
      firstAt: Number(row.first_at),
      lastAt: Number(row.last_at),
      mentions: Number(row.mentions),
      toldCount: Number(row.told_count),
      toldAt: row.told_at === null ? undefined : Number(row.told_at),
    }))
  }

  /**
   * 按当前对话文本召回相关卡片。
   *
   * 打分刻意用**加法**而不是向量相似度：主动提起一件事需要「内容相关 + 够重要 + 有段时间没提」
   * 三个条件同时成立，纯语义相似度只解决第一个（见架构方案 §3 调研结论）。
   * @param text - 待匹配的文本。
   * @param limit - 返回条数。
   * @returns 命中的卡片，按分数降序。
   */
  recallMemories(text, limit = 5) {
    const haystack = String(text ?? '')
    const now = Date.now()
    const scored = []
    for (const card of this.listMemories(200)) {
      let score = 0
      // 关键词命中（每个字符都算，中文没有词边界）
      for (const keyword of card.keywords) {
        if (keyword !== '' && haystack.includes(keyword)) score += 2
      }
      // 整体内容片段命中
      for (let i = 0; i + 4 <= card.content.length; i += 2) {
        if (haystack.includes(card.content.slice(i, i + 4))) score += 1
      }
      if (score <= 0) continue
      score += card.importance / 5
      scored.push({ ...card, score: Number(score.toFixed(2)) })
    }
    if (scored.length > 0) return scored.sort((a, b) => b.score - a.score).slice(0, Number(limit))

    // 兜底：一个词都没匹配上时，至少把最重要的几张卡带上。
    //
    // 为什么需要：P5 回归显示纯关键词召回会整段落空（8 次提问里 2 次空手而归）。
    // 对"她会记得你"这个承诺来说，**空手而归比给一张不太相关的卡更糟**——
    // 而且这些卡片只是作为"你记得的事"提供给模型，用不用由她决定，塞错代价很小。
    return this.listMemories(Math.min(Number(limit), 2)).map((card) => ({ ...card, score: 0 }))
  }

  /**
   * 取"值得主动提起"的候选卡片。
   *
   * 与召回相反：这里不要求内容相关，而要求**重要度高 + 久未提起**。
   * @param options - { limit, excludeRecentlyToldHours }。
   * @returns 候选卡片（含每张的候选分）。
   */
  proactiveMemoryCandidates({ limit = 5, excludeRecentlyToldHours = 72 } = {}) {
    const now = Date.now()
    const cutoff = now - excludeRecentlyToldHours * 3_600_000
    const out = []
    for (const card of this.listMemories(200)) {
      // 最近刚提过的不再提（同一条别反复说）
      if (card.toldAt !== undefined && card.toldAt > cutoff) continue
      if (card.importance < 5) continue
      const hoursSinceTold = card.toldAt === undefined ? Number.POSITIVE_INFINITY : (now - card.toldAt) / 3_600_000
      const hoursSinceMention = (now - card.lastAt) / 3_600_000
      // 候选分：重要度为主，久未提起与久未更新为辅
      const score = card.importance * 0.6
        + Math.min(2, hoursSinceTold === Number.POSITIVE_INFINITY ? 2 : hoursSinceTold / 72)
        + Math.min(1.5, hoursSinceMention / 48)
      out.push({ ...card, score: Number(score.toFixed(2)), hoursSinceTold })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, Number(limit))
  }

  /** 标记某张卡片已被主动提起。 */
  markMemoryTold(id, nowMs = Date.now()) {
    this.db.prepare('UPDATE memory SET told_count = told_count + 1, told_at = ? WHERE id = ?').run(nowMs, Number(id))
  }

  // ── 主动性预算与冷却 ────────────────────────────────────────────────────

  /** 读取主动性状态。 */
  readInitiativeState() {
    const row = this.db.prepare('SELECT last_sent_at, miss_streak, last_user_at FROM initiative_state WHERE id = 1').get()
    return {
      lastSentAt: row.last_sent_at === null ? undefined : Number(row.last_sent_at),
      missStreak: Number(row.miss_streak),
      lastUserAt: Number(row.last_user_at),
    }
  }

  /** 记录用户说话了（刷新空闲计时，并清掉未回应计数）。 */
  noteUserActivity(nowMs = Date.now()) {
    this.db.prepare('UPDATE initiative_state SET last_user_at = ?, miss_streak = 0 WHERE id = 1').run(nowMs)
  }

  /** 统计某时间点之后已发出多少条主动消息。 */
  countInitiativesSince(sinceMs) {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM initiative_log WHERE at >= ? AND outcome = ?').get(sinceMs, 'sent')
    return Number(row.n)
  }

  /**
   * 记录一次主动开口。
   * @param record - { kind, score, content, memoryId }。
   * @param nowMs - 参考时刻。
   */
  logInitiative(record, nowMs = Date.now()) {
    this.db.prepare('INSERT INTO initiative_log (at, kind, score, content, memory_id, outcome) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nowMs, String(record.kind), Number(record.score) || 0, String(record.content ?? ''), record.memoryId ?? null, 'sent')
    this.db.prepare('UPDATE initiative_state SET last_sent_at = ? WHERE id = 1').run(nowMs)
  }

  /**
   * 记录一次"她开口了但没被回应"，用于冷却退避。
   * @param nowMs - 参考时刻。
   * @returns 新的连续未回应次数。
   */
  noteInitiativeMiss(nowMs = Date.now()) {
    this.db.prepare('UPDATE initiative_state SET miss_streak = miss_streak + 1 WHERE id = 1').run()
    const row = this.db.prepare('SELECT miss_streak FROM initiative_state WHERE id = 1').get()
    return Number(row.miss_streak)
  }

  /** 最近的主动开口记录（前端展示与排障用）。 */
  recentInitiatives(limit = 20) {
    return this.db.prepare(
      'SELECT at, kind, score, content, outcome FROM initiative_log ORDER BY at DESC LIMIT ?',
    ).all(Number(limit)).map((row) => ({
      at: Number(row.at),
      kind: String(row.kind),
      score: Number(row.score),
      content: String(row.content),
      outcome: String(row.outcome),
    }))
  }

  /**
   * 把 WAL 里已提交的页并回主库，让 WAL 不再无界增长。
   *
   * 为什么必须显式做：`wal_autocheckpoint` 默认 1000 页（4 MB），而这个库
   * 全部数据只有约 11 页——写入速率永远够不到阈值，于是 WAL 只增不清。
   * 实测：反复启动几次后 WAL 涨到 1.89 MB（主库仅 44 KB），手动 checkpoint 直接归零。
   *
   * 用 PASSIVE 而不是 TRUNCATE：PASSIVE 不阻塞任何读写、不等读者，
   * 适合放在定时维护里高频调用；想立刻把文件缩到 0 才用 TRUNCATE。
   * @param mode - 'PASSIVE' | 'TRUNCATE' | 'FULL' | 'RESTART'。
   * @returns `{ busy, log, checkpointed }`；失败返回 undefined（维护不该抛）。
   */
  checkpoint(mode = 'PASSIVE') {
    try {
      const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get()
      if (row === undefined) return undefined
      return { busy: Number(row.busy), log: Number(row.log), checkpointed: Number(row.checkpointed) }
    } catch {
      // checkpoint 失败（例如别的连接正持锁）不该影响主流程，下个周期再试。
      return undefined
    }
  }

  /** 关闭数据库连接。 */
  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 依多信号与门解析关系阶段。
 * @param input - trust / intimacy / turns。
 * @returns 阶段 id。
 */
export function resolveStage({ trust, intimacy, turns }) {
  let stage = 'stranger'
  for (const candidate of STAGES) {
    if (turns >= candidate.minTurns && trust >= candidate.trust && intimacy >= candidate.intimacy) stage = candidate.id
  }
  return stage
}

/** 阶段 id → 中文名。 */
export function stageLabel(stage) {
  return STAGES.find((s) => s.id === stage)?.label ?? '陌生'
}

/** 关系阶段的叙事化描述，供提示词使用（不写数字，避免"亲密度 0.62"这种出戏感）。 */
export const STAGE_NARRATIVE = {
  stranger: '你们才刚认识，你对他还保持着礼貌的距离感，不会过分热络',
  acquaintance: '你们已经熟络起来，说话可以放松一些，偶尔开开玩笑',
  close: '你把他当成很亲近的人，会主动关心他的日常，也会说些心里话',
  intimate: '他在你心里是很特别的人，你会自然地表达想念和在意，语气亲密',
}

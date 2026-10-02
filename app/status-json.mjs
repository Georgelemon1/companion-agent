// 状态查询的服务端助手：读 SQLite 与文件，输出机器可读的 JSON。
//
// 为什么单独一个文件：PowerShell 读不了 SQLite，而状态里最有价值的部分
// （情绪向量、关系、记忆卡片、主动性预算）都在库里。
// 输出 JSON 而不是直接打印，是为了让 status-companion.ps1 能统一排版。
//
// 用法：node app/status-json.mjs <stateDir>

import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const stateDir = process.argv[2] ?? join(import.meta.dirname, '..', 'state')
const dbPath = join(stateDir, 'companion.db')

/** 文件大小，不存在按 0。 */
const size = (p) => {
  try { return statSync(p).size } catch { return 0 }
}
/** 只读一行，失败返回 undefined。 */
function tryGet(db, sql, ...params) {
  try { return db.prepare(sql).get(...params) } catch { return undefined }
}
/** 只读多行，失败返回空数组。 */
function tryAll(db, sql, ...params) {
  try { return db.prepare(sql).all(...params) } catch { return [] }
}

const out = {
  ok: true,
  generatedAt: new Date().toISOString(),
  files: {
    db: size(dbPath),
    wal: size(`${dbPath}-wal`),
    shm: size(`${dbPath}-shm`),
    log: size(join(stateDir, 'companion.log')),
  },
}

// 会话锚点
try {
  const anchor = JSON.parse(readFileSync(join(stateDir, 'companion-state.json'), 'utf8'))
  out.sessionId = typeof anchor.sessionId === 'string' ? anchor.sessionId : null
} catch {
  out.sessionId = null
}

if (!existsSync(dbPath)) {
  out.ok = false
  out.error = `找不到数据库：${dbPath}`
  console.log(JSON.stringify(out))
  process.exit(0)
}

let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (error) {
  out.ok = false
  out.error = `打不开数据库（可能被写锁占用）：${error.message}`
  console.log(JSON.stringify(out))
  process.exit(0)
}

// ── 情绪 ──
const affectRow = tryGet(db, 'SELECT emotions, mood_p, mood_a, mood_d, updated_at FROM affect WHERE id = 1')
if (affectRow !== undefined) {
  out.affect = {
    emotions: (() => { try { return JSON.parse(affectRow.emotions) } catch { return {} } })(),
    mood: {
      p: Number(Number(affectRow.mood_p).toFixed(3)),
      a: Number(Number(affectRow.mood_a).toFixed(3)),
      d: Number(Number(affectRow.mood_d).toFixed(3)),
    },
    updatedAt: Number(affectRow.updated_at),
  }
}

// ── 关系 ──
const relationRow = tryGet(db, 'SELECT trust, intimacy, rapport, stage, since, turns FROM relation WHERE id = 1')
if (relationRow !== undefined) {
  out.relation = {
    trust: Number(Number(relationRow.trust).toFixed(4)),
    intimacy: Number(Number(relationRow.intimacy).toFixed(4)),
    rapport: Number(Number(relationRow.rapport).toFixed(4)),
    stage: String(relationRow.stage),
    turns: Number(relationRow.turns),
    days: Number(((Date.now() - Number(relationRow.since)) / 86_400_000).toFixed(1)),
  }
}

// ── 人设 ──
const personaRow = tryGet(db, 'SELECT card, updated_at FROM persona WHERE id = 1')
if (personaRow !== undefined) {
  try {
    const card = JSON.parse(personaRow.card)
    out.persona = { name: card.name, relationKey: card.relationKey, source: card.source, updatedAt: Number(personaRow.updated_at) }
  } catch { /* 卡片损坏就不报 */ }
}

// ── 记忆 ──
const memoryCount = tryGet(db, 'SELECT COUNT(*) AS n FROM memory')
out.memory = {
  count: memoryCount === undefined ? 0 : Number(memoryCount.n),
  cards: tryAll(db, 'SELECT subject, content, importance, mentions, told_count FROM memory ORDER BY importance DESC, last_at DESC LIMIT 8')
    .map((row) => ({
      subject: String(row.subject),
      content: String(row.content),
      importance: Number(row.importance),
      mentions: Number(row.mentions),
      told: Number(row.told_count),
    })),
}

// ── 主动性 ──
const initState = tryGet(db, 'SELECT last_sent_at, miss_streak, last_user_at FROM initiative_state WHERE id = 1')
const dayStart = new Date()
dayStart.setHours(0, 0, 0, 0)
const sentToday = tryGet(db, 'SELECT COUNT(*) AS n FROM initiative_log WHERE at >= ? AND outcome = ?', dayStart.getTime(), 'sent')
out.initiative = {
  sentToday: sentToday === undefined ? 0 : Number(sentToday.n),
  missStreak: initState === undefined ? 0 : Number(initState.miss_streak),
  lastSentAt: initState?.last_sent_at == null ? null : Number(initState.last_sent_at),
  lastUserAt: initState?.last_user_at == null ? null : Number(initState.last_user_at),
  idleHours: initState?.last_user_at == null ? null : Number(((Date.now() - Number(initState.last_user_at)) / 3_600_000).toFixed(2)),
  recent: tryAll(db, 'SELECT at, kind, score, content FROM initiative_log ORDER BY at DESC LIMIT 5')
    .map((row) => ({ at: Number(row.at), kind: String(row.kind), score: Number(row.score), content: String(row.content) })),
}

// ── 日志尾部（最近的运行期事件）──
out.logTail = []
try {
  const lines = readFileSync(join(stateDir, 'companion.log'), 'utf8').split('\n').filter((l) => l.trim() !== '')
  out.logTail = lines.slice(-12)
} catch { /* 没有日志文件 */ }

db.close()
console.log(JSON.stringify(out))

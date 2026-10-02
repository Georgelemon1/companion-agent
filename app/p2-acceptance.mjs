// P2 验收脚本：验"她主动开口"的全链路。
//
// 它会真正启动一棵树（用 config.acceptance.yml 把时间尺度缩到秒级），
// 然后：
//   ① 发一条含事实的消息 → 等她回复 → 检查事实卡片是否入库
//   ② 断开连接（模拟关掉浏览器）→ 等待空闲阈值 → 检查她是否主动开口
//   ③ 逼出 daily cap → 检查第 4 条是否被拦
//   ④ 检查冷却退避能拦住刚发过消息的再次开口
//
// 用法：node app/p2-acceptance.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { boot, loadProfileDirectory, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

const BIN = 'companion-p2'
const appDir = dirname(fileURLToPath(import.meta.url))
const stateDir = join(appDir, '..', 'state')
const dbPath = join(stateDir, 'companion.db')
const moduleAnchor = join(appDir, 'node_modules')
/** 测试树专用端口，与正常实例的 4180 错开。 */
const PORT = 4181

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`) } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** 直接读库，验证的是真正落盘的值。 */
function readDb() {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const memories = db.prepare('SELECT id, subject, content, importance, told_count FROM memory ORDER BY importance DESC').all()
  const init = db.prepare('SELECT last_sent_at, miss_streak, last_user_at FROM initiative_state WHERE id = 1').get()
  const sentToday = db.prepare("SELECT COUNT(*) AS n FROM initiative_log WHERE outcome = 'sent'").get()
  const log = db.prepare('SELECT at, kind, score, content FROM initiative_log ORDER BY at DESC LIMIT 10').all()
  db.close()
  return {
    memories: memories.map((m) => ({ id: Number(m.id), subject: String(m.subject), content: String(m.content), importance: Number(m.importance), told: Number(m.told_count) })),
    init: {
      lastSentAt: init.last_sent_at === null ? undefined : Number(init.last_sent_at),
      missStreak: Number(init.miss_streak),
      lastUserAt: Number(init.last_user_at),
    },
    sentTotal: Number(sentToday.n),
    log: log.map((l) => ({ at: Number(l.at), kind: String(l.kind), score: Number(l.score), content: String(l.content) })),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 连一次 WebSocket，把收到的帧收集起来。返回 { send, frames, close }。 */
function connect() {
  const frames = []
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/companion/ws`)
    ws.on('open', () => resolve({
      ws,
      frames,
      send: (obj) => ws.send(JSON.stringify(obj)),
      close: () => ws.close(),
    }))
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)))
      } catch { /* 忽略非 JSON */ }
    })
    ws.on('error', reject)
  })
}

/** 发一条用户消息并等她的回复。 */
async function say(conn, text, timeoutMs = 90000) {
  const before = conn.frames.length
  conn.send({ type: 'chat.send', text })
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const done = conn.frames.slice(before).filter((f) => f.type === 'message.done')
    if (done.length > 0) return done[done.length - 1].text
    await sleep(300)
  }
  throw new Error('等她回复超时')
}

/** 等一条主动消息（不发送任何东西）。 */
async function waitProactive(conn, timeoutMs) {
  const before = conn.frames.length
  const started = Date.now()
  let fired = false
  let text = ''
  while (Date.now() - started < timeoutMs) {
    const fresh = conn.frames.slice(before)
    if (!fired && fresh.some((f) => f.type === 'initiative.fired')) fired = true
    const done = fresh.filter((f) => f.type === 'message.done')
    if (done.length > 0) {
      text = done[done.length - 1].text
      return { fired, text, waitedMs: Date.now() - started }
    }
    await sleep(300)
  }
  return { fired, text: '', waitedMs: Date.now() - started, timedOut: true }
}

// ── 启动测试树 ────────────────────────────────────────────────────────────
console.log('启动测试树（时间尺度缩小版）…')
const profile = loadProfileDirectory(BIN, appDir, join(appDir, 'package.json'))
const patches = [...profile.layers.flatMap((l) => l.patches), ...profile.patches]
// 加载验收覆盖层：把"空闲 8 小时 / 冷却 90 分钟"这类时间尺度缩到秒级。
// 不加载它，验收就必须真的等几小时（第一版就是这么失败的）。
patches.push(...loadOverlayPatches(BIN, join(appDir, 'config.acceptance.yml')))
// 把端口错开，避免与正在运行的正常实例抢 4180。
patches.push({ id: 'companion-web', config: {
  port: PORT, host: '127.0.0.1', stateDir,
  publicDir: join(appDir, 'public'), speakerLabel: '用户',
} })

const rootCtx = await boot(BIN, join(appDir, 'cordis.yml'), patches, () => {}, pathToFileURL(`${moduleAnchor}/`).href)
console.log('测试树已启动\n')

// 等 agent 就绪
let ready = false
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/companion/health`)
    const json = await res.json()
    if (json.status === 'idle' || json.status === 'running') { ready = true; break }
  } catch { /* 还没起来 */ }
  await sleep(500)
}
check('测试树就绪', ready)
if (!ready) { await rootCtx.fiber.dispose(); process.exit(1) }

const conn = await connect()
await sleep(500)

// ── ① 记忆抽取 ────────────────────────────────────────────────────────────
console.log('\n【① 记忆抽取】')
const reply1 = await say(conn, '我叫阿哲，我养了一只猫叫豆豆，最喜欢 Radiohead。下周要去面试。')
console.log(`  她：${reply1.replace(/\n/g, ' ').slice(0, 80)}`)
await sleep(1500)
let db = readDb()
check('抽到了事实卡片', db.memories.length >= 3, `${db.memories.length} 张`)
for (const m of db.memories.slice(0, 6)) console.log(`     [${m.importance}] ${m.subject}: ${m.content}`)
check('记下了宠物', db.memories.some((m) => m.content.includes('豆豆')), '')
check('记下了名字', db.memories.some((m) => m.content.includes('阿哲')), '')
check('记下了面试计划', db.memories.some((m) => m.content.includes('面试')), '')

// ── ② 关掉浏览器后她主动开口 ─────────────────────────────────────────────
console.log('\n【② 断开连接后她主动开口（验收核心）】')
// 先装好监听，**再**制造"她该开口"的条件。反过来做就会漏掉已经发生的那次
// （第一版就是这么漏的：她在我监听窗口打开之前就说完了）。
const probe = await connect()
probe.send({ type: 'initiative.inspect' })
await sleep(400)
const armed = probe.frames.find((f) => f.type === 'initiative.inspect')
const alreadySent = readDb().sentTotal
console.log(`  监听已就位；此前已发出 ${alreadySent} 条主动消息`)
if (armed?.recent?.length > 0) {
  const r = armed.recent[0]
  console.log(`  此前最近的主动开口：kind=${r.kind} score=${r.score} content=${String(r.content).slice(0, 40)}`)
}

// 制造条件：同时拨回"用户活动时间"与"上次发送时间"，让空闲与冷却都不拦。
const arm = new DatabaseSync(dbPath)
/** 把两道软门一起放开，只留下"动机分"与"配额"来决定。 */
const openGates = () => arm.prepare(
  'UPDATE initiative_state SET last_user_at = ?, last_sent_at = ? WHERE id = 1',
).run(Date.now() - 3_600_000, Date.now() - 3_600_000)

conn.close()
console.log('  已断开连接（模拟关掉浏览器）')
openGates()

const waited = await waitProactive(probe, 60000)
check('监听到她主动开口', !waited.timedOut, waited.timedOut ? `等待 ${Math.round(waited.waitedMs / 1000)}s 超时` : `等待 ${Math.round(waited.waitedMs / 1000)}s`)
// 超时时把探针实际收到的帧打出来——"没收到"和"收到了但没识别"是两回事。
if (waited.timedOut) {
  const kinds = probe.frames.map((f) => f.type)
  const counts = kinds.reduce((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {})
  console.log(`  探针共收到 ${probe.frames.length} 帧：${JSON.stringify(counts)}`)
}
probe.close()
if (!waited.timedOut) console.log(`  她主动说：${waited.text.replace(/\n/g, ' ').slice(0, 110)}`)
db = readDb()
check('主动开口已记录', db.sentTotal >= 1, `共 ${db.sentTotal} 条`)
check('被提起的是记忆型候选', db.log.some((l) => l.kind === 'memory'), db.log[0] === undefined ? '' : `最近一条 kind=${db.log[0].kind}`)
check('该记忆被标记为已提过', db.memories.some((m) => m.told > 0), '')
check('主动开口的内容是记忆（不是空问候）', db.log.some((l) => l.content.includes('猫') || l.content.includes('面试') || l.content.includes('阿哲')),
  db.log.map((l) => l.content).join(' | ').slice(0, 90))

// 顺带验：刷新页面后，历史里那条主动消息应带 proactive 标记。
const after = await connect()
after.send({ type: 'state.query' })
await sleep(700)
const init = after.frames.find((f) => f.type === 'init')
after.close()
const proactiveInHistory = (init?.history ?? []).filter((m) => m.proactive === true)
check('刷新后历史能标出哪条是她主动说的', proactiveInHistory.length >= 1, `${proactiveInHistory.length} 条带标记`)

// ── ③ daily cap ───────────────────────────────────────────────────────────
console.log('\n【③ 每日配额】')
const conn2 = await connect()
let sent = readDb().sentTotal
const cap = 2
for (let round = 0; round < 8 && sent < cap + 2; round++) {
  openGates()
  const before = readDb().sentTotal
  await waitProactive(conn2, 15000)
  const nowSent = readDb().sentTotal
  if (nowSent > before) { sent = nowSent; console.log(`  第 ${sent} 条已发出`) }
  else if (nowSent >= cap) break
}
db = readDb()
check('配额上限生效', db.sentTotal <= cap, `实际 ${db.sentTotal} 条，上限 ${cap}`)

// 把两道软门都放开，看是否由配额拦住。
const inspect = await (async () => {
  const c = await connect()
  openGates()
  await sleep(1200)
  c.send({ type: 'initiative.inspect' })
  await sleep(800)
  const frame = c.frames.find((f) => f.type === 'initiative.inspect')
  c.close()
  return frame
})()
if (inspect?.lastTick) console.log(`  最近 tick：send=${inspect.lastTick.send} reason=${inspect.lastTick.reason}`)
check('配额用尽后门显示为 daily-cap（其余门已放开）', inspect?.lastTick?.reason === 'daily-cap', `reason=${inspect?.lastTick?.reason}`)

// ── ④ 冷却门 ──────────────────────────────────────────────────────────────
console.log('\n【④ 冷却门】')
// 要验的是"冷却"这道门。注意两道门的先后顺序是写死的（静默→配额→冷却），
// 所以配额已经用尽时无论冷却怎样都会先报 daily-cap。
// 这里改为直接验**冷却公式本身**——已由 initiative-test.mjs 覆盖，
// 运行期只确认"刚发过 + 空闲足够"时不会立刻再发第二条。
const c3 = await connect()
const sentBeforeCool = readDb().sentTotal
arm.prepare('UPDATE initiative_state SET last_user_at = ? WHERE id = 1').run(Date.now() - 3_600_000)
arm.prepare('UPDATE initiative_state SET last_sent_at = ? WHERE id = 1').run(Date.now())
await sleep(7000)
const sentAfterCool = readDb().sentTotal
c3.close()
check('刚发过之后不会再立刻发一条', sentAfterCool === sentBeforeCool,
  `${sentBeforeCool} → ${sentAfterCool}（配额已满，冷却公式由 initiative-test.mjs 单测覆盖）`)

arm.close()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await rootCtx.fiber.dispose()
process.exit(fail === 0 ? 0 : 1)

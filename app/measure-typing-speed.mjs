// 精确测"长文吐字速度" —— 判断是不是被加速到像"蹦出来"
//
// 用户报："长文字流式输出依然有问题"。但 diagnose-stream 显示长文确实在逐步吐字。
// 怀疑：长文的每字时长被预算压到接近下限（18ms），**看着就像一次性蹦出来**。
//
// 本脚本：发一条消息，50ms 一次采样末条气泡字数，算出**实际吐字速率**并给判读。
//
// 用法：node app/measure-typing-speed.mjs ["要说的话"] [采样毫秒]

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9229
const TEXT = process.argv[2] ?? '请详细说说你对我的看法，越具体越好，至少五百字。'
const profile = mkdtempSync(join(tmpdir(), 'spd-'))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1904,998', 'about:blank',
], { detached: true, stdio: 'ignore' })
child.unref()

let list = null
for (let i = 0; i < 40; i += 1) {
  try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json()
        if (list.length > 0) break } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 250))
}
if (!list || list.length === 0) { console.log('❌ CDP 没起来'); process.exit(1) }

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('http://127.0.0.1:4180/')}`, { method: 'PUT' })).json()
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
const send = (method, params = {}) => {
  id += 1; const myId = id
  return new Promise((res) => { pend.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })) })
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await new Promise((r) => setTimeout(r, 4000))

// 采样器：每 50ms 记录末条气泡字数
await evalJs(`(() => {
  const box = document.getElementById('messages')
  window.__spd = []
  window.__spd0 = Date.now()
  if (window.__spdTimer) clearInterval(window.__spdTimer)
  window.__spdTimer = setInterval(() => {
    const all = box.querySelectorAll('.msg.companion')
    const last = all[all.length - 1]
    window.__spd.push({ t: Date.now() - window.__spd0, len: last ? (last.textContent || '').length : 0, n: all.length })
  }, 50)
  return true
})()`)

// 发消息
await evalJs(`(() => {
  const input = document.getElementById('input')
  input.value = ${JSON.stringify(TEXT)}
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  return true
})()`)

await new Promise((r) => setTimeout(r, 40000))
const samples = await evalJs('window.__spd')
await evalJs('clearInterval(window.__spdTimer)')

// 只保留"最后一条气泡在增长"的阶段
const finalN = samples[samples.length - 1]?.n ?? 0
const growth = samples.filter((s) => s.n === finalN)
const first = growth.find((s) => s.len > 0)
const last = growth[growth.length - 1]
if (!first || !last) { console.log('❌ 没采到增长'); process.exit(1) }

const chars = last.len - first.len
const ms = last.t - first.t
const perChar = chars > 0 ? ms / chars : 0

console.log(`\n=== 末条气泡吐字过程 ===`)
console.log(`  从 ${first.len} 字涨到 ${last.len} 字（共 ${chars} 字）`)
console.log(`  用时 ${(ms / 1000).toFixed(1)} 秒`)
console.log(`  **每字 ${perChar.toFixed(1)}ms  →  ${(1000 / perChar).toFixed(1)} 字/秒**`)

// 连续性：相邻采样之间字数跃进了多少
const steps = []
for (let i = 1; i < growth.length; i += 1) {
  const d = growth[i].len - growth[i - 1].len
  if (d > 0) steps.push(d)
}
const maxStep = steps.length > 0 ? Math.max(...steps) : 0
const avgStep = steps.length > 0 ? steps.reduce((a, b) => a + b, 0) / steps.length : 0
const bigSteps = steps.filter((d) => d > 5).length

console.log(`\n=== 连续性（采样间隔 50ms）===`)
console.log(`  有增长的采样点 ${steps.length} 个`)
console.log(`  每次平均涨 ${avgStep.toFixed(2)} 字，最多一次涨 ${maxStep} 字`)
console.log(`  单次涨 >5 字的次数：${bigSteps}（这些就是"蹦"）`)

console.log(`\n=== 判读 ===`)
const cps = perChar > 0 ? 1000 / perChar : 0
if (cps >= 40) console.log(`  ❌ ${cps.toFixed(0)} 字/秒 —— 这已经是"一次性蹦出来"的观感`)
else if (cps >= 25) console.log(`  🟡 ${cps.toFixed(0)} 字/秒 —— 偏快，接近"蹦"`)
else if (cps >= 10) console.log(`  ✅ ${cps.toFixed(0)} 字/秒 —— 能看出逐字`)
else console.log(`  ✅ ${cps.toFixed(0)} 字/秒 —— 从容`)

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

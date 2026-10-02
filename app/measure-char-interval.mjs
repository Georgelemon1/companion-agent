// 量"逐字间隔是否准确、是否漂移" —— 只统计真正在增长的阶段
//
// 背景：`playPaced` 用 setTimeout 链逐字（每字一个 200ms 定时器）。
// 每跳都有开销，实际间隔 = 200ms + ε，**会累积漂移**。
// 这个脚本用"相邻增长的间隔中位数"直接量出 ε 有多大。
//
// 用法：node app/measure-char-interval.mjs ["要说的话"]

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9234
const TEXT = process.argv[2] ?? '你好'
const profile = mkdtempSync(join(tmpdir(), 'ci-'))

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

// 用 MutationObserver 精确记录"每次文本变化的时间与长度"（比轮询采样准得多）
await evalJs(`(() => {
  const box = document.getElementById('messages')
  window.__chg = []
  window.__chg0 = Date.now()
  const lastLen = () => {
    const all = box.querySelectorAll('.msg.companion')
    return all.length === 0 ? 0 : (all[all.length - 1].textContent || '').length
  }
  let prev = lastLen()
  new MutationObserver(() => {
    const now = lastLen()
    if (now !== prev) { window.__chg.push({ t: Date.now() - window.__chg0, len: now }); prev = now }
  }).observe(box, { childList: true, characterData: true, subtree: true })
  return true
})()`)

await evalJs(`(() => {
  const input = document.getElementById('input')
  input.value = ${JSON.stringify(TEXT)}
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  return true
})()`)

await new Promise((r) => setTimeout(r, 40000))
const chg = await evalJs('window.__chg')

console.log(`=== 文本变化 ${chg.length} 次 ===`)
if (chg.length < 4) { console.log('  变化太少，无法判断'); process.exit(0) }

// 相邻两次变化的时间间隔（只保留"长度 +1"的，即真正逐字）
const deltas = []
for (let i = 1; i < chg.length; i += 1) {
  const dl = chg[i].len - chg[i - 1].len
  if (dl === 1) deltas.push(chg[i].t - chg[i - 1].t)
}
if (deltas.length === 0) { console.log('  没有"逐字 +1"的变化'); process.exit(0) }

const sorted = [...deltas].sort((a, b) => a - b)
const med = sorted[Math.floor(sorted.length / 2)]
const min = sorted[0]
const max = sorted[sorted.length - 1]

// 判读要**排除停顿**：超过 400ms 的间隔多半是段间停顿（IDLE_BRIDGE_MS）
// 或后台节流，不属于"逐字节拍"。把它们算进平均会把结论带偏
//（实测：中位 202ms 完全正确，但混进一次 566ms 停顿后"平均"变成 228ms，
//  于是判读误报"漂移 28ms"）。
const GAP_MS = 400
const pacing = deltas.filter((d) => d <= GAP_MS)
const gaps = deltas.filter((d) => d > GAP_MS)
const avg = pacing.length > 0 ? pacing.reduce((a, b) => a + b, 0) / pacing.length : med
const p90 = [...pacing].sort((a, b) => a - b)[Math.floor(pacing.length * 0.9)] ?? max

console.log(`\n=== 逐字间隔（长度 +1 共 ${deltas.length} 次，其中 ${pacing.length} 次属于逐字节拍）===`)
console.log(`  中位数 ${med}ms   平均 ${avg.toFixed(1)}ms   P90 ${p90}ms   最小 ${min}ms`)
console.log(`  目标   200ms（5 字/秒）`)
console.log('')
const drift = med - 200
console.log(`  中位数偏差 ${drift >= 0 ? '+' : ''}${drift}ms/字`)
if (Math.abs(drift) <= 5) console.log('  ✅ 间隔准确（中位数就是 200ms）')
else if (Math.abs(drift) <= 20) console.log(`  🟡 中位数偏 ${drift}ms`)
else console.log(`  ❌ 中位数偏 ${drift}ms，明显不准`)

if (gaps.length > 0) {
  console.log(`\n  停顿 ${gaps.length} 次（>${GAP_MS}ms，属于段间停顿/节流，不计入逐字节拍）：`)
  for (const g of gaps.slice(0, 6)) console.log(`    ${g}ms`)
}

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

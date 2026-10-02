// 跑一个真实回合，全程采样立绘两层的几何，查"跳跃"是否还在
//
// 第一轮修复（setFrame 只驱动可见层 + 对称清 manual）后，
// 需要验证**真实回合**（不是手动调 API）里也不会出现两层的错位。
//
// 用法：node app/verify-turn-stability.mjs ["要说的话"]

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9230
const TEXT = process.argv[2] ?? '随便聊聊你今天想到的事。'
const profile = mkdtempSync(join(tmpdir(), 'turn-'))

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

// 每 40ms 采两层的 (manual, state, opacity, bgPos)
await evalJs(`(() => {
  window.__stab = []
  window.__stab0 = Date.now()
  if (window.__stabTimer) clearInterval(window.__stabTimer)
  window.__stabTimer = setInterval(() => {
    const layers = [...document.querySelectorAll('.ca-layer')].map(el => ({
      c: String(el.className).includes('base') ? 'B' : 'O',
      m: el.dataset.manual === '1',
      s: el.dataset.state ?? '',
      o: getComputedStyle(el).opacity,
      p: getComputedStyle(el).backgroundPosition,
    }))
    window.__stab.push({ t: Date.now() - window.__stab0, layers })
  }, 40)
  return true
})()`)

await evalJs(`(() => {
  const input = document.getElementById('input')
  input.value = ${JSON.stringify(TEXT)}
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  return true
})()`)

await new Promise((r) => setTimeout(r, 25000))
const samples = await evalJs('window.__stab')
await evalJs('clearInterval(window.__stabTimer)')

console.log(`=== 采样 ${samples.length} 次 ===\n`)

// 统计"两层同时 manual=1"的次数 —— 这就是两个头
let bothManual = 0
// 统计"两层同时 opacity>0.1"的次数 —— 视觉上叠加
let bothVisible = 0
for (const s of samples) {
  const base = s.layers.find((l) => l.c === 'B')
  const over = s.layers.find((l) => l.c === 'O')
  if (!base || !over) continue
  if (base.m && over.m) bothManual += 1
  if (Number(base.o) > 0.1 && Number(over.o) > 0.1) bothVisible += 1
}
console.log(`  两层同时 manual=1 的采样：${bothManual} / ${samples.length}  ${bothManual === 0 ? '✅' : '❌ 会出现两个头'}`)
console.log(`  两层同时可见(op>0.1) 的采样：${bothVisible} / ${samples.length}  ${bothVisible === 0 ? '✅' : '⚠️ 叠加显示'}`)

// 状态切换序列
const changes = []
for (const s of samples) {
  const active = s.layers.find((l) => l.m) ?? s.layers.find((l) => Number(l.o) > 0.5)
  const key = active ? `${active.c}|${active.s}|${active.m ? 'M' : 'A'}` : 'none'
  const prev = changes[changes.length - 1]
  if (!prev || prev.key !== key) changes.push({ key, t: s.t, ...active })
}
console.log(`\n=== 立绘状态切换序列（${changes.length} 次）===`)
for (const c of changes.slice(0, 24)) {
  console.log(`  +${String(c.t).padStart(6)}ms  ${c.c === 'B' ? '底层' : '情绪层'}  ${String(c.s).padEnd(11)} ${c.m ? '手动' : 'CSS动画'}`)
}
if (changes.length > 24) console.log(`  … 还有 ${changes.length - 24} 次`)

// 检查是否有"基础层在情绪层可见时仍在跑动画且位置不同"→ 潜在错位
const conflicts = []
for (const s of samples) {
  const base = s.layers.find((l) => l.c === 'B')
  const over = s.layers.find((l) => l.c === 'O')
  if (!base || !over) continue
  if (Number(base.o) > 0.1 && Number(over.o) > 0.1 && base.p !== over.p) {
    conflicts.push({ t: s.t, b: base.p, o: over.p })
  }
}
console.log(`\n=== 错位冲突（两层都可见且背景位置不同）===`)
console.log(`  ${conflicts.length} 次  ${conflicts.length === 0 ? '✅ 没有错位' : '❌ 会出现错位画面'}`)
for (const c of conflicts.slice(0, 6)) console.log(`    +${c.t}ms  base=${c.b}  overlay=${c.o}`)

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  writeFileSync('state/turn-stability.png', Buffer.from(shot.result.data, 'base64'))
  console.log('\n📷 state/turn-stability.png')
}

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

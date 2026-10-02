// 端到端验证：在真实 Chrome 里发一条消息，观察立绘是否被逐字驱动
//
// 验证三件事（对应用户 2026-09-15 的三条要求）：
//   ① 思考态是否快速到达峰值（而不是慢慢放）
//   ② 吐字时是否逐字下发帧号（data-manual=1 + --ca-fr-* 在变）
//   ③ 每个动态是否从初始帧起、在初始帧止（帧号从 0 单调增到库末帧）
//
// 用法：node app/e2e-verify.mjs

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9226
const profile = mkdtempSync(join(tmpdir(), 'e2e-'))

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

await new Promise((r) => setTimeout(r, 3500)) // 等 init + manifest 拉取

console.log('=== 环境自检 ===')
const env = await evalJs(`(() => {
  const root = document.querySelector('.ca-root')
  return {
    hasAvatar: root !== null,
    manual: document.querySelector('[data-manual="1"]') !== null,
    manifestLoaded: !!document.querySelector('.ca-layer[data-state]'),
  }
})()`)
console.log('  ' + JSON.stringify(env))

// 装一个探针：每 40ms 采一次立绘状态，记录 (手动模式, 状态, background-position)
console.log('\n=== 注入采样探针 ===')
await evalJs(`(() => {
  window.__probe = []
  if (window.__probeTimer) clearInterval(window.__probeTimer)
  window.__probeTimer = setInterval(() => {
    const layer = document.querySelector('.ca-layer[data-manual="1"]')
      || document.querySelector('.ca-overlay[data-state]')
      || document.querySelector('.ca-base[data-state]')
    if (!layer) { window.__probe.push({ t: Date.now(), none: true }); return }
    window.__probe.push({
      t: Date.now(),
      manual: layer.dataset.manual === '1',
      state: layer.dataset.state ?? null,
      pos: getComputedStyle(layer).backgroundPosition,
    })
  }, 40)
  return true
})()`)
console.log('  ✅ 探针已注入（40ms 一次）')

// 发一条消息（走真实 WebSocket）
const SENT_AT = await evalJs(`(() => {
  const input = document.getElementById('input')
  const form = document.getElementById('composer')
  input.value = '你今天过得怎么样？跟我说说。'
  form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  return Date.now()
})()`)
console.log(`\n=== 已发送消息（t=${SENT_AT}）===`)

// 等回复播完
await new Promise((r) => setTimeout(r, 16000))

const probe = await evalJs('window.__probe')
await evalJs('clearInterval(window.__probeTimer)')

console.log(`\n=== 采样 ${probe.length} 次 ===`)

// 压缩成"状态+帧位"变化序列
const changes = []
for (const p of probe) {
  if (p.none) continue
  const last = changes[changes.length - 1]
  const key = `${p.manual ? 'M' : 'A'}|${p.state}|${p.pos}`
  if (last === undefined || last.key !== key) {
    changes.push({ key, t: p.t, manual: p.manual, state: p.state, pos: p.pos })
  }
}

console.log('\n=== 变化序列（M=手动帧模式，A=CSS 动画）===')
for (const c of changes.slice(0, 70)) {
  const dt = c.t - SENT_AT
  const x = /(-?[\d.]+)px/.exec(c.pos)?.[1] ?? '?'
  console.log(`  +${String(dt).padStart(6)}ms  ${c.manual ? 'M' : 'A'}  ${String(c.state).padEnd(11)} x=${x}`)
}
if (changes.length > 70) console.log(`  … 还有 ${changes.length - 70} 次变化`)

// ── 断言 ────────────────────────────────────────────────────────────────
console.log('\n=== 判读 ===')
const manualChanges = changes.filter((c) => c.manual)
const thinkingManual = manualChanges.filter((c) => c.state === 'thinking')

const firstThinking = probe.find((p) => p.state === 'thinking' && p.manual)
const firstSpeech = probe.find((p) => p.manual && p.state !== 'thinking')
console.log(`  ① 思考态进入手动模式: ${firstThinking ? '✅ 是' : '❌ 否'}`)
if (firstThinking) {
  const thinkFrames = thinkingManual.length
  const thinkMs = (thinkingManual[thinkingManual.length - 1]?.t ?? firstThinking.t) - firstThinking.t
  console.log(`     思考帧变化 ${thinkFrames} 次，用时 ${thinkMs}ms（55ms/帧，应 ≈ 0.5s 到峰值）`)
  console.log(`     ${thinkMs < 1200 ? '✅ 快速到达峰值' : '❌ 太慢'}`)
}

console.log(`  ② 吐字时进入手动模式: ${firstSpeech ? '✅ 是' : '❌ 否'}`)
if (firstSpeech) {
  const speech = manualChanges.filter((c) => c.state !== 'thinking')
  // 判读帧号是否单调（从 0 增到更大）
  const xs = speech.map((c) => Math.abs(Number(/(-?[\d.]+)px/.exec(c.pos)?.[1] ?? 0)))
  const monotonic = xs.every((v, i) => i === 0 || v >= xs[i - 1] - 1)
  console.log(`     吐字期间帧位变化 ${speech.length} 次，x 从 ${xs[0]} 到 ${xs[xs.length - 1]}`)
  console.log(`     ${monotonic ? '✅ 单调递增（纯正放，无倒放）' : '❌ 非单调'}`)
  console.log(`     ${xs[0] === 0 ? '✅ 从初始帧（x=0）起' : '❌ 不是从初始帧起'}`)
}

const states = [...new Set(probe.filter((p) => p.state).map((p) => p.state))]
console.log(`  ③ 出现过的状态: ${states.join(' → ')}`)

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

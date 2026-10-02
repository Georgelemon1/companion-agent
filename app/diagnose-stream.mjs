// 诊断流式输出：抓一次完整回合的 WebSocket 消息时序
//
// 用户报"流式输出有问题"。不猜，直接量：
//   · 服务端按什么顺序发 delta / emotion / done
//   · 前端何时开气泡、何时吐字、吐了几个字
//   · 有没有"先出一整条、又流式一遍"的重复显示
//
// 做法：在页面里挂钩 WebSocket，把收发消息记进 __wsLog，同时用 MutationObserver
// 记录 #messages 的 DOM 变化。发一条消息后回读两份记录对照。
//
// 用法：node app/diagnose-stream.mjs ["要说的话"]

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9227
const TEXT = process.argv[2] ?? '你今天过得怎么样？'
const profile = mkdtempSync(join(tmpdir(), 'ds-'))

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
  if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text }
  return r.result?.result?.value
}

// 必须在页面脚本之前挂钩 —— 用 Page.addScriptToEvaluateOnNewDocument
await send('Page.enable')
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__wsLog = []
    window.__domLog = []
    const OrigWS = window.WebSocket
    window.WebSocket = function (...args) {
      const sock = new OrigWS(...args)
      const t0 = Date.now()
      window.__wsLog.push({ t: 0, dir: 'open', url: String(args[0]) })
      sock.addEventListener('message', (ev) => {
        let type = '?'
        let extra = ''
        let keys = ''
        try {
          const o = JSON.parse(ev.data)
          type = o.type
          keys = Object.keys(o).join(',')
          if (type === 'message.delta') extra = 'len=' + String(o.text ?? '').length
          else if (type === 'message.done') extra = 'textLen=' + String(o.text ?? '').length + ' segs=' + (o.segments?.length ?? 0)
          else if (type === 'message.emotion') extra = o.label + '@' + o.intensity
          else if (type === 'agent.status') extra = o.status
        } catch {}
        window.__wsLog.push({ t: Date.now() - t0, dir: 'in', type, extra, keys })
      })
      sock.addEventListener('send', () => {})
      const origSend = sock.send.bind(sock)
      sock.send = (d) => { window.__wsLog.push({ t: Date.now() - t0, dir: 'out', type: 'raw' }); return origSend(d) }
      return sock
    }
    window.WebSocket.prototype = OrigWS.prototype
    Object.assign(window.WebSocket, OrigWS)
  `,
})

await send('Page.navigate', { url: 'http://127.0.0.1:4180/' })
await new Promise((r) => setTimeout(r, 4500))

// 挂钩 DOM 观察：**只看最后一条气泡**，否则 120 条历史会把关键信息埋掉
await evalJs(`(() => {
  const box = document.getElementById('messages')
  window.__domLog = []
  window.__domStart = Date.now()
  const n = () => box.querySelectorAll('.msg').length
  const lastLen = () => {
    const all = box.querySelectorAll('.msg')
    return all.length === 0 ? 0 : (all[all.length - 1].textContent || '').length
  }
  let prevN = n()
  let prevLen = lastLen()
  window.__domLog.push({ t: 0, n: prevN, len: prevLen })
  new MutationObserver(() => {
    const cn = n()
    const cl = lastLen()
    if (cn !== prevN || cl !== prevLen) {
      window.__domLog.push({ t: Date.now() - window.__domStart, n: cn, len: cl })
      prevN = cn; prevLen = cl
    }
  }).observe(box, { childList: true, characterData: true, subtree: true })
  return true
})()`)

console.log(`=== 发送：「${TEXT}」 ===`)
await evalJs(`(() => {
  const input = document.getElementById('input')
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  input.value = ${JSON.stringify(TEXT)}
  document.getElementById('composer').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
  return true
})()`)

await new Promise((r) => setTimeout(r, 45000))

const wsLog = await evalJs('window.__wsLog')
const domLog = await evalJs('window.__domLog')

console.log('\n═══ WebSocket 消息时序 ═══')
// 汇总连续同类型（`open` 那条没有 extra 字段，要兜住）
const summary = []
for (const e of wsLog) {
  const extra = String(e.extra ?? '')
  const len = Number((extra.match(/len=(\d+)/) ?? [0, 0])[1])
  const last = summary[summary.length - 1]
  if (last !== undefined && last.type === e.type && e.type === 'message.delta') {
    last.n += 1; last.len += len; last.tEnd = e.t; continue
  }
  summary.push({ ...e, extra, n: 1, len, tEnd: e.t })
}
for (const s of summary) {
  const span = s.tEnd !== s.t ? `（跨度 ${s.tEnd - s.t}ms）` : ''
  const cnt = s.type === 'message.delta' ? ` ×${s.n} 共${s.len}字` : ''
  console.log(`  +${String(s.t).padStart(6)}ms  ${s.dir === 'in' ? '↓' : '↑'} ${String(s.type).padEnd(18)} ${s.type === 'message.delta' ? '' : s.extra}${cnt}${span}`)
}

console.log('\n═══ #messages 最后一条气泡的字数变化 ═══')
console.log('  （只看最后一条，历史气泡不计）')
console.log(`  气泡数    时间      末条字数`)
for (const d of domLog) {
  console.log(`  ${String(d.n).padStart(4)}   +${String(d.t).padStart(6)}ms  ${String(d.len).padStart(4)}`)
}

// 判读
console.log('\n═══ 判读 ═══')
const last = domLog[domLog.length - 1]
const doneMsg = wsLog.find((e) => e.type === 'message.done')
const doneT = doneMsg?.t ?? Infinity
const doneLen = Number(doneMsg?.extra?.match(/textLen=(\d+)/)?.[1] ?? 0)
const segs = Number(doneMsg?.extra?.match(/segs=(\d+)/)?.[1] ?? 0)
console.log(`  message.done：正文 ${doneLen} 字、${segs} 段，在 +${doneT}ms`)
console.log(`  done 的字段: ${doneMsg?.keys ?? "(没收到 done)"}`)
console.log(`  末条气泡最终 ${last?.len} 字，气泡总数 ${last?.n}`)
console.log(`  ${last?.len === doneLen ? '✅ 气泡字数 == done 正文长度（没有截断/没有多余）' : `❌ 不一致：气泡 ${last?.len} vs done ${doneLen}`}`)

// 吐字过程：done 之后字数是否逐步增长
const during = domLog.filter((d) => d.t > doneT)
console.log(`  done 之后有 ${during.length} 次字数变化`)
if (during.length >= 2) {
  const first = during[0]
  const lastD = during[during.length - 1]
  console.log(`    从 ${first.len} 字逐步涨到 ${lastD.len} 字，用时 ${lastD.t - first.t}ms`)
  console.log(`    ${lastD.len > first.len ? '✅ 有逐字吐字过程' : '❌ 一次性全出（没有吐字）'}`)
} else {
  console.log(`    ❌ done 之后没有吐字过程 —— 文字是一次性出现的`)
}

// 思考态是否占位
const think = wsLog.find((e) => e.type === 'agent.status' && e.extra === 'running')
const firstEmotion = wsLog.find((e) => e.type === 'message.emotion')
console.log(`  用户发出 → running: ${think?.t ?? '?'}ms；首个 emotion: ${firstEmotion?.t ?? '?'}ms`)
console.log(`  running → 首个正文信号：${firstEmotion ? firstEmotion.t - think.t : '?'}ms`)

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

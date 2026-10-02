// 验证"无气泡"：读 .msg 的实际计算样式（比截图可靠 —— 截图受合成层刷新时机影响）
// 用法：node app/verify-nobubble.mjs

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9235
const profile = mkdtempSync(join(tmpdir(), 'nb-'))

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

// 等连上（她有历史消息才有 .msg 可测）
let ready = false
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 500))
  const n = await evalJs(`document.querySelectorAll('#messages .msg').length`)
  if (typeof n === 'number' && n > 0) { ready = true; console.log(`历史消息 ${n} 条，开始验证\n`); break }
}
if (!ready) console.log('⚠️ 没等到历史消息，仍按当前 DOM 验证\n')

const REPORT = `(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return { sel, missing: true }
    const s = getComputedStyle(el)
    const keep = ['backgroundColor','backgroundImage','borderRadius','borderWidth','paddingTop','paddingLeft','backdropFilter','boxShadow','textShadow','color','fontSize','maxWidth','textAlign']
    const o = { sel }
    for (const k of keep) o[k] = s[k]
    const r = el.getBoundingClientRect()
    o.rect = [+r.width.toFixed(0), +r.height.toFixed(0)]
    return o
  }
  const box = document.getElementById('messages')
  const bs = box ? getComputedStyle(box) : null
  return {
    companion: pick('#messages .msg.companion'),
    user: pick('#messages .msg.user'),
    messagesBox: bs ? { backgroundImage: bs.backgroundImage, backgroundColor: bs.backgroundColor } : null,
    counts: {
      companion: document.querySelectorAll('#messages .msg.companion').length,
      user: document.querySelectorAll('#messages .msg.user').length,
    },
  }
})()`

const d = await evalJs(REPORT)
const transparent = (v) => v === 'rgba(0, 0, 0, 0)' || v === 'transparent'

console.log('=== 她的消息（.msg.companion）===')
if (d.companion.missing) console.log('  （没有她的消息）')
else {
  const c = d.companion
  console.log(`  背景色     ${c.backgroundColor}   ${transparent(c.backgroundColor) ? '✅ 透明' : '❌ 有底色'}`)
  console.log(`  背景图     ${c.backgroundImage === 'none' ? '✅ none' : '❌ ' + c.backgroundImage.slice(0, 40)}`)
  console.log(`  圆角       ${c.borderRadius}   ${c.borderRadius === '0px' ? '✅ 无' : '⚠️ 有圆角'}`)
  console.log(`  内边距     ${c.paddingTop} / ${c.paddingLeft}   ${c.paddingTop === '0px' ? '✅ 无' : '⚠️ 有'}`)
  console.log(`  毛玻璃     ${c.backdropFilter}   ${c.backdropFilter === 'none' ? '✅ 无' : '❌ 还有'}`)
  console.log(`  描边       ${String(c.textShadow).slice(0, 60)}`)
  console.log(`  ${c.textShadow !== 'none' ? '✅ 有 text-shadow（可读性靠它）' : '❌ 没有描边，浅色立绘上会糊'}`)
  console.log(`  文字色     ${c.color}`)
}

console.log('\n=== 用户的消息（.msg.user）===')
if (d.user.missing) console.log('  （没有用户消息）')
else {
  const u = d.user
  console.log(`  背景色     ${u.backgroundColor}   ${transparent(u.backgroundColor) ? '✅ 透明' : '❌ 有底色'}`)
  console.log(`  圆角       ${u.borderRadius}   ${u.borderRadius === '0px' ? '✅ 无' : '⚠️ 有圆角'}`)
  console.log(`  文字色     ${u.color}   对齐 ${u.textAlign}`)
}

console.log('\n=== 消息区（#messages）===')
if (d.messagesBox === null) console.log('  （没有 #messages）')
else {
  const bg = d.messagesBox.backgroundImage
  console.log(`  背景图     ${bg === 'none' ? '✅ none（不再是大气泡面板）' : '❌ ' + bg.slice(0, 50)}`)
  console.log(`  背景色     ${d.messagesBox.backgroundColor}   ${transparent(d.messagesBox.backgroundColor) ? '✅ 透明' : '⚠️ 有色'}`)
}

console.log('\n=== 气泡数量（应只由消息数决定，不是 UI 元素）===')
console.log(`  她的 ${d.counts.companion} 条，用户 ${d.counts.user} 条`)

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

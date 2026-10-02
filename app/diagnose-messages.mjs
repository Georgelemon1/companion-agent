// 量消息区的真实几何 —— 查"消息没贴底"到底卡在哪
//
// 现象：`#messages` 设了 `justify-content: flex-end` 且面板沉底，
// 但渲染里消息仍贴面板顶部、底部留约 190px 空白。
// 我的 CSS 推理与实际不符，所以直接量。
//
// 用法：node app/diagnose-messages.mjs

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9224
const profile = mkdtempSync(join(tmpdir(), 'cdp3-'))

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1904,998', 'about:blank',
], { detached: true, stdio: 'ignore' })
child.unref()

let list = null
for (let i = 0; i < 40; i += 1) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
    list = await r.json()
    if (list.length > 0) break
  } catch { /* 等 */ }
  await new Promise((r) => setTimeout(r, 250))
}
if (list === null || list.length === 0) { console.log('❌ CDP 没起来'); process.exit(1) }

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
  id += 1
  const myId = id
  return new Promise((res) => { pend.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params })) })
}

await new Promise((r) => setTimeout(r, 3000))

const PROBE = `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return { y:+r.y.toFixed(1), bottom:+r.bottom.toFixed(1), h:+r.height.toFixed(1),
             scrollH: el.scrollHeight, clientH: el.clientHeight, scrollTop: el.scrollTop,
             justify: s.justifyContent, marginTop: s.marginTop, flex: s.flex,
             display: s.display, flexDir: s.flexDirection, overflow: s.overflowY,
             position: s.position, height: s.height }
  }
  const m = document.getElementById('messages')
  const chat = document.getElementById('chat')
  const comp = document.getElementById('composer')
  const header = document.getElementById('chat-header')
  const kids = m ? [...m.children] : []
  return {
    app: box(document.getElementById('app')),
    header: box(header),
    messages: box(m),
    composer: box(comp),
    chat: box(chat),
    childCount: kids.length,
    children: kids.map((el, i) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return { i, cls: el.className, y:+r.y.toFixed(1), bottom:+r.bottom.toFixed(1), h:+r.height.toFixed(1),
               text: (el.textContent||'').slice(0,18), offsetTop: el.offsetTop,
               marginTop: s.marginTop, alignSelf: s.alignSelf }
    }),
    // 面板内的空白：最后一条的 bottom 到面板 bottom 的距离
    gapBelowLast: (() => {
      if (!m || kids.length === 0) return null
      const last = kids[kids.length-1].getBoundingClientRect()
      return +(m.getBoundingClientRect().bottom - last.bottom).toFixed(1)
    })(),
    gapAboveFirst: (() => {
      if (!m || kids.length === 0) return null
      const first = kids[0].getBoundingClientRect()
      return +(first.top - m.getBoundingClientRect().top).toFixed(1)
    })(),
  }
})()`

const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
const d = r.result?.result?.value
if (!d) { console.log('❌ 无返回:', JSON.stringify(r).slice(0, 500)) }
else {
  const show = (name, o) => {
    if (!o) { console.log(`\n${name}: 不存在`); return }
    console.log(`\n=== ${name} ===`)
    console.log(`  rect    y=${o.y} bottom=${o.bottom} h=${o.h}`)
    console.log(`  scroll  scrollH=${o.scrollH} clientH=${o.clientH} scrollTop=${o.scrollTop}`)
    console.log(`  css     height=${o.height} flex=${o.flex} marginTop=${o.marginTop}`)
    console.log(`          display=${o.display} dir=${o.flexDir} justify=${o.justify} overflowY=${o.overflow}`)
  }
  show('#app', d.app)
  show('#chat-header', d.header)
  show('#messages', d.messages)
  show('#composer', d.composer)
  show('#chat', d.chat)
  console.log(`\n=== 面板内空白 ===`)
  console.log(`  第一条上方空白: ${d.gapAboveFirst}px`)
  console.log(`  最后一条下方空白: ${d.gapBelowLast}px`)
  console.log(`\n=== 消息（共 ${d.childCount} 条）===`)
  for (const c of d.children) {
    console.log(`  [${c.i}] ${String(c.cls).padEnd(14)} y=${String(c.y).padStart(6)} bottom=${String(c.bottom).padStart(6)} h=${String(c.h).padStart(6)}  alignSelf=${c.alignSelf}  "${c.text}"`)
  }
}

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

// 组合探针：同一页面状态下，既报"当前可见的是哪几条消息"，又存截图
//
// 目的：查清 `cdp-inspect.mjs` 的截图为何显示旧消息——
// 几何测量（scrollTop=11723，最新消息在底部）与截图内容矛盾。
//
// 用法：node app/diagnose-visible.mjs

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9225
const profile = mkdtempSync(join(tmpdir(), 'cdp4-'))
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

// 给足时间让 init 历史渲染 + rAF 滚动完成
await new Promise((r) => setTimeout(r, 4000))

const PROBE = `(() => {
  const m = document.getElementById('messages')
  if (!m) return { error: 'no #messages' }
  const mr = m.getBoundingClientRect()
  const kids = [...m.children]
  const visible = []
  for (const [i, el] of kids.entries()) {
    const r = el.getBoundingClientRect()
    // 与消息区可视矩形有交集即算可见
    if (r.bottom > mr.top && r.top < mr.bottom) {
      visible.push({ i, y:+r.y.toFixed(0), text: (el.textContent||'').slice(0,26) })
    }
  }
  return {
    total: kids.length,
    scrollTop: m.scrollTop,
    scrollH: m.scrollHeight,
    clientH: m.clientHeight,
    atBottom: Math.abs(m.scrollHeight - m.scrollTop - m.clientHeight) < 4,
    last3: kids.slice(-3).map((el,i)=>({ i: kids.length-3+i, text:(el.textContent||'').slice(0,26) })),
    visible: visible.slice(0, 12),
  }
})()`

const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
const d = r.result?.result?.value
console.log('=== 同一状态下的可见性 ===')
console.log(`  消息总数 ${d.total}   scrollTop=${d.scrollTop}  scrollH=${d.scrollH}  clientH=${d.clientH}`)
console.log(`  ${d.atBottom ? '✅ 已在底部' : '❌ 不在底部'}`)
console.log('\n  最后 3 条（应出现在底部可见区）:')
for (const x of d.last3) console.log(`    [${x.i}] "${x.text}"`)
console.log('\n  当前**可见**的消息:')
for (const v of d.visible) console.log(`    y=${String(v.y).padStart(4)}  [${v.i}] "${v.text}"`)

// 紧跟着截图（同一状态）
//
// ⚠️ 加 `fromSurface: false`：默认的 `fromSurface: true` 抓的是**合成器表面**，
// 实测会拿到**过期帧**——探针明明报"已滚到底、显示 [115] 最新消息"，
// 截图里却还是滚动前的旧消息。滚动内容 + `backdrop-filter` + `mask` 这些
// 合成层在表面捕获时没刷新。从渲染器直接取帧才准。
const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false })
if (shot.result?.data) {
  writeFileSync('state/visible-check.png', Buffer.from(shot.result.data, 'base64'))
  console.log('\n📷 state/visible-check.png （fromSurface:false）')
} else {
  console.log('\n❌ 截图失败:', JSON.stringify(shot).slice(0, 200))
}

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch {} }
setTimeout(() => process.exit(0), 300)

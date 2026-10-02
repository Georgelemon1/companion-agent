// 用 Chrome DevTools Protocol 拿真实渲染数据
//
// 背景：此前一直无法在浏览器里验证 CSS（本机 Chrome 直接调用无输出）。
// 实测发现：**`Start-Process` + 重定向输出可以**，直接 `& chrome` 不行。
// 于是走 CDP：起 headless Chrome（开 --remote-debugging-port），用 HTTP 拿 target，
// 再用 WebSocket 发 Runtime.evaluate 读 getComputedStyle / matchMedia。
//
// 这是"我能自己看到渲染结果"的关键工具——不必再让用户在浏览器里来回跑诊断页。
//
// 用法：node app/cdp-inspect.mjs [url] [width] [height]

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const url = process.argv[2] ?? 'http://127.0.0.1:4180/'
const W = Number(process.argv[3] ?? 1904)
const H = Number(process.argv[4] ?? 998)
const PORT = 9222

const profile = mkdtempSync(join(tmpdir(), 'cdp-'))

/** 探测 CDP 是否就绪。 */
async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
  return res.json()
}

const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  'about:blank',
], { detached: true, stdio: 'ignore' })
child.unref()

// 等 CDP 端口起来
let list = null
for (let i = 0; i < 40; i += 1) {
  try { list = await targets(); if (list.length > 0) break } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 250))
}
if (list === null || list.length === 0) {
  console.log('❌ CDP 没能启动')
  process.exit(1)
}
console.log(`✅ Chrome CDP 就绪（viewport ${W}×${H}）`)

/** 打开一个 tab 并拿到它的 ws。 */
async function newTab(targetUrl) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  return res.json()
}

const tab = await newTab(url)
const ws = new WebSocket(tab.webSocketDebuggerUrl)
let msgId = 0
const pending = new Map()

ws.addEventListener('message', (event) => {
  const m = JSON.parse(String(event.data))
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

/** 发一条 CDP 命令。 */
function send(method, params = {}) {
  msgId += 1
  const id = msgId
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

// 等页面加载 + 立绘就位
await new Promise((r) => setTimeout(r, 2500))

const PROBE = `(() => {
  const app = document.getElementById('app')
  const cs = app ? getComputedStyle(app) : null
  const rect = app ? app.getBoundingClientRect() : null
  const mq = {}
  for (const q of ['(min-width: 700px)','(min-height: 620px)','(min-width: 700px) and (min-height: 620px)','(min-aspect-ratio: 1/1)']) {
    mq[q] = window.matchMedia(q).matches
  }
  const layers = [...document.querySelectorAll('.ca-layer')].map(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect()
    return { cls: el.className.replace('ca-layer ',''), state: el.dataset.state ?? null,
             w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             left: +r.left.toFixed(1), top: +r.top.toFixed(1),
             bgSize: s.backgroundSize, opacity: s.opacity }
  })
  return {
    viewport: { innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio },
    mediaQueries: mq,
    app: cs ? { width: cs.width, height: cs.height, radius: cs.borderRadius,
                display: cs.display, rectW: +rect.width.toFixed(1), rectH: +rect.height.toFixed(1),
                left: +rect.left.toFixed(1), top: +rect.top.toFixed(1) } : null,
    bodyDisplay: getComputedStyle(document.body).display,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    stageRect: (() => { const s=document.getElementById('stage'); if(!s) return null
                        const r=s.getBoundingClientRect(); return {w:+r.width.toFixed(1),h:+r.height.toFixed(1)} })(),
    layers,
  }
})()`

const result = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
const data = result.result?.result?.value
if (data === undefined) {
  console.log('❌ 探针没有返回数据:', JSON.stringify(result).slice(0, 400))
} else {
  console.log('\n=== 视口 ===')
  console.log(`  innerWidth×innerHeight = ${data.viewport.innerW}×${data.viewport.innerH}   dpr=${data.viewport.dpr}`)
  console.log('\n=== 媒体查询判定 ===')
  for (const [q, hit] of Object.entries(data.mediaQueries)) {
    console.log(`  ${hit ? '✅ 命中' : '❌ 不命中'}  ${q}`)
  }
  console.log('\n=== #app 计算样式（决定性）===')
  if (data.app === null) console.log('  ❌ 找不到 #app')
  else {
    console.log(`  width=${data.app.width}  height=${data.app.height}  radius=${data.app.radius}`)
    console.log(`  渲染矩形 ${data.app.rectW}×${data.app.rectH}  位置 left=${data.app.left} top=${data.app.top}`)
    console.log(`  ${Math.abs(data.app.rectW - 390) < 2 ? '✅ 是 390px 手机宽' : '❌ 不是 390px —— 手机框没生效'}`)
  }
  console.log(`\n  body: display=${data.bodyDisplay}  bg=${data.bodyBg}`)
  console.log(`  #stage: ${data.stageRect ? data.stageRect.w + '×' + data.stageRect.h : '(无)'}`)
  console.log('\n=== 立绘层 ===')
  for (const l of data.layers) {
    console.log(`  ${l.cls.padEnd(12)} state=${String(l.state).padEnd(11)} ${l.w}×${l.h} @(${l.left},${l.top})  bgSize=${l.bgSize}  opacity=${l.opacity}`)
  }
}

// 截图留证
//
// ⚠️ 已知限制：本页面（滚动内容 + `backdrop-filter` + `mask`）的截图**可能是过期帧**。
// 实测：探针同一时刻报 `scrollTop=11723`（已滚到底、显示最新消息），
// 而截图里仍是滚动前的旧消息。`fromSurface:false` 会得到空白图，不可用。
//
// ⇒ **以 `Runtime.evaluate` 的 DOM 测量为准，截图只当参考。**
// 要判断"当前可见哪些内容"，用 `app/diagnose-visible.mjs`（它同时报可见项与几何）。
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  const file = 'state/render-check.png'
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  console.log(`\n📷 截图已存: ${file}（注意：合成层可能未刷新，以 DOM 测量为准）`)
}

ws.close()
try { process.kill(-child.pid) } catch { try { child.kill() } catch { /* 已退出 */ } }
setTimeout(() => process.exit(0), 300)

// 像素批次缩放方式对比：同一帧、同一尺寸，只换 image-rendering，各截一张放大图
// 用法: node compare-pixel-scaling.mjs [帧路径]
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const FRAME = process.argv[2] ?? 'papercut/idle/3.jpg'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9335
const BASE = 'http://127.0.0.1:4180'
const profile = mkdtempSync(join(tmpdir(), 'pc-pixcmp-'))

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=400,900', '--hide-scrollbars', `${BASE}/`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pageWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 等 CDP */ }
    await sleep(250)
  }
  throw new Error('CDP 未就绪')
}

const ws = new WebSocket(await pageWs(), { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let seq = 0
const pending = new Map()
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.id !== undefined && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id)
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }))
})
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
// 模拟 dpr=2 的屏幕：这时"糊不糊"才看得出来
await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 2, mobile: false })

for (let i = 0; i < 80; i++) {
  if (await evalJs('Boolean(window.CompanionStage && window.CompanionStage.debug().imgLoaded)')) break
  await sleep(250)
}

const ver = await evalJs(`window.CompanionStage.debug().batch.version`)
console.log('批次版本:', ver, '| 页面自动选择的缩放:', await evalJs('window.CompanionStage.debug().batch.imageRendering'))
console.log('按调试键冻结渲染循环，改用同一帧、只换缩放方式对比：')

// 冻结 rAF 循环（下一次 tick 不再排队），之后手动控制 <img>
await evalJs('window.requestAnimationFrame = () => 0; "frozen"')

const shot = async (name, clip) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(join('../state', name), Buffer.from(data, 'base64'))
  console.log(`  📷 ../state/${name}`)
}

for (const mode of ['auto', 'pixelated']) {
  await evalJs(`(() => {
    const img = document.querySelector('#stage .pc-img');
    img.style.imageRendering = '${mode}';
    img.src = './${FRAME}?v=${ver}';
    return 'ok'
  })()`)
  // 等这一帧解码完
  for (let i = 0; i < 40; i++) {
    if (await evalJs('(() => { const i = document.querySelector("#stage .pc-img"); return i.complete && i.naturalWidth > 0 })()')) break
    await sleep(100)
  }
  await sleep(300)
  const info = await evalJs(`(() => {
    const i = document.querySelector('#stage .pc-img');
    const r = i.getBoundingClientRect();
    return JSON.stringify({ rendering: i.style.imageRendering, natural: i.naturalWidth + 'x' + i.naturalHeight, box: Math.round(r.width) + 'x' + Math.round(r.height), scale: +(r.width / i.naturalWidth).toFixed(3) })
  })()`)
  console.log(`  [${mode}] ${info}`)
  // 头部区域放大（CSS 坐标裁切，scale=2 输出设备像素）
  await shot(`pixel-${mode}-head.png`, { x: 110, y: 40, width: 180, height: 220, scale: 2 })
  await shot(`pixel-${mode}-full.png`, { x: 0, y: 0, width: 400, height: 900, scale: 1 })
}

ws.close(); chrome.kill(); process.exit(0)

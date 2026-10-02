// 真实聊天链路 → 立绘状态验证
// 走真浏览器 UI 发一条消息，采样立绘状态序列，核对 待机 → 思考 → 说话 → 待机
// 用法: node verify-chat-stage.mjs ["消息文本"]
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const TEXT = process.argv[2] ?? '你好，今天过得怎么样？'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const BASE = 'http://127.0.0.1:4180'
const profile = mkdtempSync(join(tmpdir(), 'pc-chat-'))

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=390,844', '--hide-scrollbars', `${BASE}/`,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function pageWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.url.startsWith(BASE))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* CDP 未起来 */ }
    await sleep(250)
  }
  throw new Error('CDP 未就绪')
}

const ws = new WebSocket(await pageWs(), { perMessageDeflate: false })
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
let seq = 0
const pending = new Map()
const errors = []
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text)
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

for (let i = 0; i < 80; i++) {
  if (await evalJs('Boolean(window.CompanionStage && window.CompanionStage.debug().imgLoaded)')) break
  await sleep(250)
}
const conn = await evalJs(`document.getElementById('conn-text').textContent`)
console.log('连接状态:', conn)

// 在页面里挂采样器（记录 模式/说话/帧号 的每次变化）
await evalJs(`window.__s=[]; window.__t0=performance.now(); window.__last='';
  window.__t=setInterval(() => {
    const d = window.CompanionStage.debug();
    const k = d.mode + '|' + d.talking + '|' + d.set + '#' + d.num + '/' + d.layer;
    if (k !== window.__last) { window.__last = k; window.__s.push([Math.round(performance.now()-window.__t0), k]) }
  }, 80); 'ok'`)

// 走真实 UI：填输入框并提交表单
console.log(`发送（走 UI 表单）: ${TEXT}`)
await evalJs(`(() => {
  const input = document.getElementById('input');
  input.value = ${JSON.stringify(TEXT)};
  document.getElementById('composer').requestSubmit();
  return 'ok'
})()`)

// 采样直到"说话结束后回待机"，最多 75s
const deadline = Date.now() + 75000
let sawTalking = false
while (Date.now() < deadline) {
  await sleep(500)
  const st = JSON.parse(await evalJs(`JSON.stringify(window.__s.map(x=>x[1]))`))
  if (st.some((s) => s.includes('|true|'))) sawTalking = true
  const last = st.at(-1) ?? ''
  // 说话之后又回到非说话态 → 收工
  if (sawTalking && last.includes('|false|') && !last.includes('mouth#')) break
}
await evalJs(`clearInterval(window.__t); 'ok'`)
const raw = JSON.parse(await evalJs('JSON.stringify(window.__s)'))
const bubbles = await evalJs(`document.querySelectorAll('#messages > *').length`)
const lastText = await evalJs(`(document.querySelector('#messages > *:last-child')?.textContent ?? '').slice(0, 60)`)

console.log('\n立绘状态序列（80ms 采样，只记变化）：')
for (const [t, k] of raw) {
  const [mode, talking, frame] = k.split('|')
  console.log(`  +${String(t).padStart(6)}ms  mode=${mode.padEnd(8)} 说话=${talking.padEnd(5)} 帧=${frame}`)
}

const seqStr = raw.map(([, k]) => k)
const firstThink = seqStr.findIndex((k) => k.startsWith('thinking|'))
const firstTalk = seqStr.findIndex((k) => k.includes('|true|'))
const lastIdle = seqStr.at(-1) ?? ''
const check = (label, ok, detail = '') => console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`)
console.log('\n== 判定 ==')
check('等回复时切到思考素材', firstThink >= 0, `第 ${firstThink + 1} 次变化`)
check('思考出现在说话之前', firstThink >= 0 && firstTalk > firstThink, `思考#${firstThink + 1} → 说话#${firstTalk + 1}`)
check('说话期间出现张嘴帧', seqStr.some((k) => k.includes('mouth#')), seqStr.filter((k) => k.includes('mouth#')).length + ' 次')
check('说完回到待机（不残留张嘴/思考）', lastIdle.startsWith('idle|false|idle#'), lastIdle)
check('聊天区有她的回复', String(lastText).trim().length > 0, String(lastText).replace(/\n/g, ' '))
check('无 JS 报错', errors.length === 0, errors.slice(0, 2).join(' | '))
console.log(`  （气泡节点数 ${bubbles}）`)

const { data } = await send('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(join('../state', 'stage-chat.png'), Buffer.from(data, 'base64'))
console.log('  📷 ../state/stage-chat.png')

ws.close(); chrome.kill(); process.exit(0)

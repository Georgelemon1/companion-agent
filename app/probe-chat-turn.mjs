// 裸 WS 探针：发一条消息，把服务端推来的每一帧原样打出来（诊断空回复）
// 用法: node probe-chat-turn.mjs ["消息文本"] [端口]
import WebSocket from 'ws'

const TEXT = process.argv[2] ?? '在吗？'
const PORT = Number(process.argv[3] ?? 4180)
const t0 = Date.now()
const ts = () => `+${String(Date.now() - t0).padStart(6)}ms`
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/companion/ws`)
let done = false

ws.on('open', () => {
  console.log(`${ts()} 已连接，发送: ${TEXT}`)
  ws.send(JSON.stringify({ type: 'chat.send', text: TEXT }))
})
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  const brief = { ...m }
  if (typeof brief.text === 'string' && brief.text.length > 120) brief.text = `${brief.text.slice(0, 120)}…(${brief.text.length}字)`
  if (Array.isArray(brief.segments)) brief.segments = `[${brief.segments.length} 段] ` + brief.segments.map((s) => `${s.chars}字`).join('/')
  if (Array.isArray(brief.history)) brief.history = `[${brief.history.length} 条]`
  if (m.type === 'message.done') done = true
  console.log(`${ts()} ${m.type}  ${JSON.stringify(brief)}`)
})
ws.on('error', (e) => console.log(`${ts()} WS 错误: ${e.message}`))
ws.on('close', () => console.log(`${ts()} 连接关闭`))
setTimeout(() => { console.log(`${ts()} ${done ? '（已收到 message.done）' : '（60s 内没等到 message.done）'}`); process.exit(0) }, 60000)

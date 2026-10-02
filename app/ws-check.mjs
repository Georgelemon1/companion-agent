// 端到端测试客户端：连上 companion 的 WebSocket，发一条消息，打印事件流。
// 用法：node ws-check.mjs "要说的话"
import { WebSocket } from 'ws'

const text = process.argv[2] ?? '你好，能听见我吗？'
const url = process.argv[3] ?? 'ws://127.0.0.1:4180/companion/ws'

const ws = new WebSocket(url)
let deltas = 0
/** 每个增量到达的时刻，用于证明流式。 */
const arrivals = []
/** 累积所有增量文本，用于校验标记有没有漏到正文里。 */
let deltaText = ''
/** 收到的表情标记。 */
const emotions = []
const started = Date.now()

const timer = setTimeout(() => {
  console.log('\n[超时] 45 秒内没有收到 message.done')
  process.exit(2)
}, 45000)

ws.on('open', () => {
  console.log('[open] 已连接')
  setTimeout(() => {
    console.log(`[send] ${text}`)
    ws.send(JSON.stringify({ type: 'chat.send', text }))
  }, 600)
})

ws.on('message', (raw) => {
  let msg
  try {
    msg = JSON.parse(String(raw))
  } catch {
    console.log('[raw]', String(raw).slice(0, 200))
    return
  }

  if (msg.type === 'init') {
    console.log(`[init] sessionId=${msg.sessionId ?? '(null)'} status=${msg.status} history=${(msg.history ?? []).length} 条`)
    return
  }
  if (msg.type === 'ready') {
    console.log(`[ready] sessionId=${msg.sessionId}`)
    return
  }
  if (msg.type === 'message.delta') {
    deltas += 1
    // 记录到达时刻，用于证明"真流式"（增量应该随时间陆续到达，而不是一次性全来）
    arrivals.push(Date.now() - started)
    deltaText += msg.text
    if (deltas <= 3) console.log(`[delta#${deltas}] +${arrivals[arrivals.length - 1]}ms ${JSON.stringify(msg.text)}`)
    return
  }
  if (msg.type === 'message.emotion') {
    // 她输出的表情标记（服务端已从正文剥离）。这就是驱动立绘的那条。
    emotions.push({ label: msg.label, intensity: msg.intensity, at: Date.now() - started })
    console.log(`[emotion] +${Date.now() - started}ms  label=${msg.label} intensity=${msg.intensity}`)
    return
  }
  if (msg.type === 'message.replace') {
    console.log(`\n[replace] 护栏改写了正文，前端应整段替换`)
    return
  }
  if (msg.type === 'message.done') {
    console.log(`\n[done] 共 ${deltas} 个增量，耗时 ${Date.now() - started}ms`)
    if (arrivals.length > 1) {
      const span = arrivals[arrivals.length - 1] - arrivals[0]
      console.log(`[输出模式] ${msg.outputMode ?? "(未提供)"}`)
    console.log(`[流式证据] 首个增量 +${arrivals[0]}ms，末个 +${arrivals[arrivals.length - 1]}ms，跨度 ${span}ms`)
      console.log(`           增量分散在 ${span}ms 内 ⇒ ${span > 200 ? '✅ 真流式' : '⚠️ 增量一次性到达 → 前端按 segments 节拍化输出'}`)
    }
    if (msg.segments !== undefined) {
      console.log(`[情绪脚本] ${msg.segments.length} 段：`)
      for (const s of msg.segments) {
        console.log(`   ${String(s.label).padEnd(10)} 强度${String(s.intensity).padStart(4)}  ${s.chars} 字  ${JSON.stringify(s.text.slice(0, 24))}`)
      }
      if (msg.segments.length === 0) console.log('   ⚠️ 没有分段 —— 她没输出任何表情标记，立绘会退回旧逻辑')
    }
    console.log('[她的回复]')
    console.log(msg.text || deltaText)
    // 标记校验：正文里绝不能出现 [em:
    const leaked = (msg.text || deltaText).includes('[em:')
    console.log(leaked ? '  ❌ 标记漏到正文里了！' : '  ✅ 正文里没有标记残留')
    clearTimeout(timer)
    ws.close()
    return
  }
  if (msg.type === 'affect.update') {
    // 立绘舞台依赖这条：label=原始情绪键、intensity=0-10、emotions=强度表。
    // 早期没监听它，导致"服务端到底推没推状态"无从验证。
    const top = (msg.emotions ?? [])[0]
    const detail = top ? `${top.text} ${Number(top.value).toFixed(2)}` : '（无）'
    console.log(`[affect] label=${msg.label} intensity=${msg.intensity} 最强=${detail}`)
    return
  }
  if (msg.type === 'agent.status') {
    console.log(`[status] ${msg.status}`)
    return
  }
  if (msg.type === 'error') {
    console.log(`[error] code=${msg.code} message=${msg.message}`)
    clearTimeout(timer)
    ws.close()
    process.exit(1)
  }
  console.log('[other]', JSON.stringify(msg).slice(0, 200))
})

ws.on('close', () => {
  console.log('[close]')
  process.exit(0)
})
ws.on('error', (error) => {
  console.log('[连接失败]', error.message)
  clearTimeout(timer)
  process.exit(3)
})

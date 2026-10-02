// 消息计数探针 —— 一次回合里，每种消息到底收到几条
//
// 用途：用户报告"内容显示两遍"。要定位是服务端重复发、还是前端重复渲染，
// 最直接的办法是数一数一次回合里 message.done 到底来了几条。
//
// 用法：node app/ws-count.mjs "要说的话"

import { WebSocket } from 'ws'

const text = process.argv[2] ?? '你好'
const counts = new Map()
const seq = []
let deltas = 0
let deltaChars = 0

const ws = new WebSocket('ws://127.0.0.1:4180/companion/ws')
const started = Date.now()
const timer = setTimeout(() => {
  console.log('\n[超时] 强制结束')
  report()
  process.exit(0)
}, 45000)

function report() {
  console.log('\n=== 消息计数 ===')
  for (const [type, n] of [...counts.entries()].sort()) {
    const flag = (type === 'message.done' && n > 1) ? '  ← ❌ 重复发送！' : ''
    console.log(`  ${type.padEnd(18)} ${String(n).padStart(3)} 条${flag}`)
  }
  console.log(`\n  message.delta 共 ${deltas} 条，累计可见字符 ${deltaChars}`)
  console.log('\n=== 消息顺序（前 20 条）===')
  console.log('  ' + seq.slice(0, 20).join(' → '))
}

ws.on('open', () => {
  console.log('[open] 已连接')
})

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(String(raw)) } catch { return }
  const t = String(msg.type ?? '(无type)')
  counts.set(t, (counts.get(t) ?? 0) + 1)
  if (seq.length < 60) seq.push(t)

  if (t === 'init') {
    console.log(`[init] history=${(msg.history ?? []).length} 条`)
    ws.send(JSON.stringify({ type: 'chat.send', text }))
    return
  }
  if (t === 'message.delta') {
    deltas += 1
    deltaChars += String(msg.text ?? '').length
    return
  }
  if (t === 'message.done') {
    console.log(`\n[done#${counts.get('message.done')}] 文本长度=${String(msg.text ?? '').length} 模式=${msg.outputMode} 分段=${(msg.segments ?? []).length}`)
    if (counts.get('message.done') > 1) {
      console.log('  ❌ 同一回合收到多条 done —— 服务端重复发送')
    }
    // 等一小会儿看还有没有后续消息（判断是否真重复）
    setTimeout(() => {
      clearTimeout(timer)
      report()
      console.log('\n结论：')
      const doneCount = counts.get('message.done') ?? 0
      console.log(doneCount === 1
        ? '  ✅ 服务端只发了一条 done —— 显示两遍是前端渲染问题'
        : `  ❌ 服务端发了 ${doneCount} 条 done —— 服务端重复发送`)
      ws.close()
      process.exit(0)
    }, 2500)
    return
  }
  if (t === 'message.emotion') {
    console.log(`[emotion] ${msg.label}@${msg.intensity}`)
    return
  }
  if (t === 'affect.update') return
  console.log(`[${t}] ${JSON.stringify(msg).slice(0, 120)}`)
})

ws.on('error', (e) => { console.log('[error]', e.message); process.exit(1) })

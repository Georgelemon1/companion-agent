// P1 验收脚本：连发多条消息，每条后读一次状态，用于验证情绪连续性/关系演进。
// 用法：node acceptance.mjs "消息1" "消息2" ...
import { WebSocket } from 'ws'
import { DatabaseSync } from 'node:sqlite'

const DB = 'E:\\deepseek harness workspace1\\projects\\companion-agent\\state\\companion.db'
const messages = process.argv.slice(2)

/** 直接读库看状态（绕开服务，验证的是真正落盘的值）。 */
function readState() {
  const db = new DatabaseSync(DB, { readOnly: true })
  const affect = db.prepare('SELECT emotions, mood_p, mood_a, mood_d FROM affect WHERE id = 1').get()
  const relation = db.prepare('SELECT trust, intimacy, rapport, stage, turns FROM relation WHERE id = 1').get()
  db.close()
  return {
    emotions: JSON.parse(affect.emotions),
    mood: { p: Number(affect.mood_p.toFixed(3)), a: Number(affect.mood_a.toFixed(3)), d: Number(affect.mood_d.toFixed(3)) },
    relation: {
      trust: Number(relation.trust.toFixed(4)),
      intimacy: Number(relation.intimacy.toFixed(4)),
      rapport: Number(relation.rapport.toFixed(4)),
      stage: relation.stage,
      turns: relation.turns,
    },
  }
}

/** 发一条消息并等回合结束。 */
function send(text) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:4180/companion/ws')
    let reply = ''
    const timer = setTimeout(() => { ws.close(); reject(new Error('超时')) }, 90000)
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'chat.send', text })), 400))
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'message.done') {
        reply = msg.text
        clearTimeout(timer)
        ws.close()
      }
      if (msg.type === 'error') {
        clearTimeout(timer)
        ws.close()
        reject(new Error(`${msg.code}: ${msg.message}`))
      }
    })
    ws.on('close', () => resolve(reply))
    ws.on('error', reject)
  })
}

const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${Number(v).toFixed(1)}`).join(' ') || '（无）'

for (const [index, text] of messages.entries()) {
  process.stdout.write(`\n【第 ${index + 1} 条】${text}\n`)
  const reply = await send(text)
  const state = readState()
  process.stdout.write(`  她：${reply.replace(/\n/g, ' ')}\n`)
  process.stdout.write(`  情绪：${fmt(state.emotions)}  mood(p=${state.mood.p} a=${state.mood.a} d=${state.mood.d})\n`)
  process.stdout.write(`  关系：${JSON.stringify(state.relation)}\n`)
}

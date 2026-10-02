// companion 的"她记得什么"到底长什么样：直接读 state/companion.db
// 用法: node inspect-memory.mjs
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dbPath = join(import.meta.dirname, '..', 'state', 'companion.db')
if (!existsSync(dbPath)) throw new Error(`没有数据库：${dbPath}`)
console.log(`库文件：state/companion.db  ${(statSync(dbPath).size / 1024).toFixed(1)} KB`)
for (const suffix of ['-wal', '-shm']) {
  const p = dbPath + suffix
  if (existsSync(p)) console.log(`         state/companion.db${suffix}  ${(statSync(p).size / 1024).toFixed(1)} KB`)
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
console.log('\n== 表清单与行数 ==')
const counts = {}
for (const { name } of tables) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
  counts[name] = n
  console.log(`  ${name.padEnd(20)} ${String(n).padStart(5)} 行`)
}

const show = (label, sql, limit = 5) => {
  console.log(`\n== ${label} ==`)
  const rows = db.prepare(sql).all()
  if (rows.length === 0) { console.log('  （空）'); return }
  for (const r of rows.slice(0, limit)) {
    const parts = Object.entries(r).map(([k, v]) => {
      let s = v === null ? 'null' : String(v)
      if (s.length > 90) s = `${s.slice(0, 90)}…`
      return `${k}=${s}`
    })
    console.log('  ' + parts.join('  '))
  }
  if (rows.length > limit) console.log(`  …共 ${rows.length} 行`)
}

// memory 是"她记住的事实卡片"表：先看结构再看内容
const memSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='memory'").get()
console.log('\n== memory 表结构 ==')
console.log(memSchema?.sql ?? '（没有 memory 表）')

if (counts.memory > 0) {
  show('记忆卡片（按重要度）', 'SELECT * FROM memory ORDER BY importance DESC LIMIT 8')
}
for (const t of ['persona', 'affect', 'relation', 'initiative_state']) {
  if (counts[t] > 0) show(`${t} 表`, `SELECT * FROM ${t} LIMIT 2`)
}

// 会话语料在另一个地方：state/sessions/**（jsonl.zstd）
console.log('\n== 会话语料 ==')
const sessRoot = join(import.meta.dirname, '..', 'state', 'sessions')
if (existsSync(sessRoot)) {
  let total = 0, files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { files++; total += statSync(p).size }
    }
  }
  walk(sessRoot)
  console.log(`  state/sessions/  ${files} 个文件，${(total / 1024 / 1024).toFixed(2)} MB（jsonl + zstd 压缩）`)
}
db.close()

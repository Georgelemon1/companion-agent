// 看 companion.db 的结构与是否存了原始文本
// 用法：node app/probe-db.mjs

import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('state/companion.db', { readOnly: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
console.log('=== 表 ===')
for (const { name } of tables) {
  const c = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c
  console.log(`  ${name.padEnd(24)} ${String(c).padStart(6)} 行`)
}

console.log('\n=== 各表的列 ===')
for (const { name } of tables) {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
  console.log(`  ${name}:`)
  console.log('    ' + cols.map((c) => `${c.name}:${c.type}`).join(', '))
}

// 找可能有文本的表，看一行样本
console.log('\n=== 样本（找含对话文本的列）===')
for (const { name } of tables) {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all()
  const textCols = cols.filter((c) => /text|content|body|message|reply|raw/i.test(c.name))
  if (textCols.length === 0) continue
  const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid DESC LIMIT 2`).all()
  console.log(`  ── ${name} ──`)
  for (const r of rows) {
    for (const c of textCols) {
      const v = r[c.name]
      if (typeof v === 'string' && v.length > 0) {
        const has = /\[em:/.test(v)
        console.log(`    ${c.name} ${has ? '✅含[em:' : ''} (${v.length} 字符): ${JSON.stringify(v.slice(0, 110))}`)
      }
    }
  }
}

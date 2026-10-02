// WAL 诊断：确认增长原因，并验证 checkpoint 是否有效。
// 用法：node app/diagnose-wal.mjs
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'

const DB = process.argv[2] ?? 'E:\\deepseek harness workspace1\\projects\\companion-agent\\state\\companion.db'

/** 文件大小，不存在按 0。 */
const size = (p) => {
  try { return statSync(p).size } catch { return 0 }
}
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)} MB`

console.log('=== 观测前 ===')
console.log(`  companion.db      ${mb(size(DB))}`)
console.log(`  companion.db-wal  ${mb(size(`${DB}-wal`))}`)
console.log(`  companion.db-shm  ${mb(size(`${DB}-shm`))}`)

const db = new DatabaseSync(DB)

console.log('\n=== 当前 PRAGMA ===')
for (const pragma of ['journal_mode', 'wal_autocheckpoint', 'page_size', 'page_count']) {
  const row = db.prepare(`PRAGMA ${pragma}`).get()
  console.log(`  ${pragma.padEnd(18)} ${JSON.stringify(row)}`)
}

// freelist_count 告诉我们"空闲页"有多少——WAL 里堆积的大量页通常是可回收的旧版本。
const free = db.prepare('PRAGMA freelist_count').get()
console.log(`  freelist_count     ${JSON.stringify(free)}`)

console.log('\n=== 手动执行 TRUNCATE checkpoint ===')
const before = size(`${DB}-wal`)
const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
console.log(`  返回: ${JSON.stringify(result)}`)
const after = size(`${DB}-wal`)
console.log(`  WAL: ${mb(before)} -> ${mb(after)}`)
console.log(`  结论: ${after < before ? '✅ checkpoint 有效，说明增长是"未触发 checkpint"而非数据真的那么多' : '❌ checkpoint 没缩小 WAL，需另找原因'}`)

console.log('\n=== 各表行数（判断写入量来源）===')
for (const table of ['affect_log', 'relation_log', 'memory', 'initiative_log', 'affect', 'relation']) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
    console.log(`  ${table.padEnd(14)} ${row.n} 行`)
  } catch (error) {
    console.log(`  ${table.padEnd(14)} 读取失败: ${error.message}`)
  }
}

db.close()
console.log('\n=== 关闭连接后再看（SQLite 会在最后一个连接关闭时 checkpoint）===')
console.log(`  companion.db-wal  ${mb(size(`${DB}-wal`))}`)

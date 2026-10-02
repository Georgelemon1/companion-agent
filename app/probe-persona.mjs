// 看"她现在的设定是什么、凭什么" —— 直接问运行中的实例，而不是自己读库。
//
// 为什么走 HTTP 而不是读 SQLite：推断是**应用进程写**的，走 /companion/persona
// 拿到的是她此刻真正在用的那一份（含基线卡 + 推断覆盖的叠加结果），
// 顺带证明"没重启也已经生效"。
//
// 用法：node app/probe-persona.mjs [端口]
const PORT = Number(process.argv[2] ?? 4180)

const res = await fetch(`http://127.0.0.1:${PORT}/companion/persona`)
if (!res.ok) {
  console.error(`HTTP ${res.status} —— 实例起来了吗？（http://127.0.0.1:${PORT}/companion/health）`)
  process.exit(1)
}
const data = await res.json()

console.log(`\n=== 生效中的设定（运行中实例的实时视图）===`)
console.log(data.summary ?? '（空）')

console.log(`\n=== 基线卡（库里那张，推断前）===`)
console.log(data.base === null ? '（无：整卡都是默认 + 推断）' : JSON.stringify(data.base))

console.log(`\n=== 从对话里推断出的设定（${data.traits.length} 条，带证据）===`)
if (data.traits.length === 0) console.log('（还没有：需要真实对话积累信号）')
for (const t of data.traits) {
  const value = Array.isArray(t.value) ? `[${t.value.join(' / ')}]` : String(t.value)
  console.log(`  · ${t.key} = ${value}`)
  console.log(`      来源=${t.source} 置信=${t.confidence} 观察到=${t.samples}次`)
  console.log(`      证据：「${t.evidence}」`)
  console.log(`      更新于 ${new Date(t.updatedAt).toISOString()}`)
}

console.log(`\n=== 推断流水（最近 ${data.traces.length} 次动作，含被拒条目）===`)
for (const tr of data.traces) {
  const accepted = tr.accepted.map((a) => a.key).join(',') || '无'
  const rejected = tr.rejected.map((r) => `${r.key}(${r.reason})`).join(' ') || '无'
  console.log(`  [${new Date(tr.at).toISOString()}] 通道=${tr.source} turn=${tr.turn} 采纳=${accepted} 拒绝=${rejected} ${tr.note}`)
}
console.log('')

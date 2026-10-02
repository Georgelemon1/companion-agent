// 看 dsh-android 的仓库结构与构建方式，判断能否复用；顺带查本机 Java/Gradle
const base = 'https://api.github.com/repos/itiswdwa/dsh-android'
const h = { 'user-agent': 'dsh-probe', accept: 'application/vnd.github+json' }

async function j(url, accept = h.accept) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000)
  const r = await fetch(url, { headers: { ...h, accept }, signal: c.signal })
  clearTimeout(t)
  return r.ok ? { ok: true, data: await r.json() } : { ok: false, status: r.status }
}

const tree = await j(`${base}/git/trees/HEAD?recursive=1`)
if (tree.ok) {
  const paths = tree.data.tree.map((n) => n.path)
  console.log(`=== 仓库文件数 ${paths.length}（truncated=${tree.data.truncated}）===`)
  const top = paths.filter((p) => !p.includes('/'))
  console.log('顶层:', top.join('  '))
  const dirs = [...new Set(paths.filter((p) => p.includes('/')).map((p) => p.split('/').slice(0, 2).join('/')))]
  console.log('\n二级目录（前 40）:')
  console.log(dirs.slice(0, 40).join('\n'))
  const interesting = paths.filter((p) => /\.(java|kt|gradle|md)$/.test(p) && !p.includes('docs/images'))
  console.log(`\n代码/构建文件（${interesting.length}）:`)
  console.log(interesting.slice(0, 40).join('\n'))
}

for (const f of ['docs/BUILD.md', 'docs/ARCHITECTURE.md', 'README.md']) {
  const r = await fetch(`${base}/contents/${f}`, { headers: { ...h, accept: 'application/vnd.github.raw' } })
  if (!r.ok) { console.log(`\n--- ${f}: HTTP ${r.status} ---`); continue }
  const txt = await r.text()
  console.log(`\n--- ${f}（前 60 行）---`)
  console.log(txt.split('\n').slice(0, 60).join('\n'))
  break
}

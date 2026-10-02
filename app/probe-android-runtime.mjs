// 用可达的 api.github.com 取关键事实（github.com 直连超时）
const targets = [
  ['capawesome nodejs-mobile (维护分支) latest release', 'https://api.github.com/repos/capawesome-team/nodejs-mobile/releases/latest', 'release'],
  ['janeasystems nodejs-mobile (原版) latest release', 'https://api.github.com/repos/janeasystems/nodejs-mobile/releases/latest', 'release'],
  ['dsh-android 仓库信息', 'https://api.github.com/repos/itiswdwa/dsh-android', 'repo'],
  ['dsh-android README', 'https://api.github.com/repos/itiswdwa/dsh-android/readme', 'raw'],
]

for (const [label, url, kind] of targets) {
  try {
    const c = new AbortController()
    const t = setTimeout(() => c.abort(), 25000)
    const headers = { 'user-agent': 'dsh-probe', accept: kind === 'raw' ? 'application/vnd.github.raw' : 'application/vnd.github+json' }
    const r = await fetch(url, { headers, signal: c.signal })
    clearTimeout(t)
    console.log(`\n=== ${label} → HTTP ${r.status} ===`)
    if (!r.ok) { console.log('  (取不到)'); continue }
    if (kind === 'raw') {
      const txt = await r.text()
      console.log(txt.split('\n').slice(0, 40).join('\n'))
    } else if (kind === 'release') {
      const j = await r.json()
      console.log('  tag:', j.tag_name, '| 发布:', j.published_at, '| 资产数:', (j.assets ?? []).length)
      console.log('  资产:', (j.assets ?? []).map((a) => a.name).slice(0, 6).join(', '))
      console.log('  说明节选:', (j.body ?? '').replace(/\r?\n/g, ' ').slice(0, 500))
    } else {
      const j = await r.json()
      console.log('  描述:', j.description)
      console.log('  语言:', j.language, '| 星:', j.stargazers_count, '| 更新:', j.updated_at, '| 大小:', j.size, 'KB')
    }
  } catch (e) {
    console.log(`\n=== ${label} → 失败: ${e.name} ${e.message} ===`)
  }
}

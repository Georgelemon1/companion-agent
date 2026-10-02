// 只读探针：把"本应用最终组合出来的 patch 行"原样打印出来（不 boot、不占端口）。
//
// 为什么需要它：cordis.patch.yml 里 `disabled: true` 写错 id 不报错、只是不生效。
// 这个脚本走与 launcher.mjs 完全相同的 loadProfileDirectory 路径，于是可以核对
// "我关的那一行，名字到底在不在组合里"。
//
// 用法: node probe-profile-rows.mjs [--json]
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)))
const profile = loadProfileDirectory('companion', appDir, join(appDir, 'package.json'))

console.log(`layers=${profile.layers.length}  ownPatches=${profile.patches.length}`)
console.log('--- layers ---')
for (const layer of profile.layers) {
  console.log(`  ${layer.name ?? '(unnamed)'}  patches=${layer.patches?.length ?? 0}`)
}

/** 把一条 patch 行里的 disabled 值变成可读文本（可能是 !!js 节点） */
const describe = (v) => {
  if (v === undefined) return '(未设置)'
  if (typeof v === 'boolean') return String(v)
  if (v && typeof v === 'object') {
    if ('type' in v || 'value' in v || 'source' in v) return JSON.stringify(v)
    return JSON.stringify(v)
  }
  return String(v)
}

const all = [...profile.layers.flatMap((l) => l.patches ?? []), ...profile.patches]
const rows = []
for (const p of all) {
  if (Array.isArray(p.insert)) for (const r of p.insert) rows.push({ layer: 'insert', ...r })
  else rows.push({ layer: 'overlay', ...p })
}

console.log(`\n--- 组合后的 patch 行（${rows.length} 条）---`)
for (const r of rows) {
  const kind = r.insert !== undefined ? 'insert' : (r.id ?? '(no id)')
  console.log(`  ${String(kind).padEnd(28)} name=${r.name ?? '-'}  disabled=${describe(r.disabled)}  layer=${r.layer}`)
}

if (process.argv.includes('--json')) {
  console.log('\n--- raw json ---')
  console.log(JSON.stringify(rows.map((r) => ({ id: r.id, name: r.name, disabled: r.disabled, insert: Array.isArray(r.insert) ? r.insert.map((x) => x.id) : undefined })), null, 2))
}

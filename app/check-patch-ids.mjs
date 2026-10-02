// 校验：cordis.patch.yml 里我写的每个 `- id: X / disabled: true` 是否真在组合里。
//
// 为什么需要：patch 行按 id 寻址，id 写错**不报错**、只是不生效（"改了个寂寞"）。
// 这个脚本把 patch 文件里的 id 抽出来，跟 probe-profile-rows 的实际行集对账。
//
// 用法: node check-patch-ids.mjs
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)))
const profile = loadProfileDirectory('companion', appDir, join(appDir, 'package.json'))
const all = [...profile.layers.flatMap((l) => l.patches ?? []), ...profile.patches]
const ids = new Set()
for (const p of all) {
  if (Array.isArray(p.insert)) for (const r of p.insert) ids.add(r.id)
  else if (p.id) ids.add(p.id)
}

// 抽取本文件里所有 "disabled: true" 行的 id
const src = readFileSync(join(appDir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)
const declared = []
for (let i = 0; i < src.length; i += 1) {
  const m = /^\s*-\s*id:\s*(\S+)\s*$/.exec(src[i])
  if (!m) continue
  if (/^\s*disabled:\s*true\s*$/.test(src[i + 1] ?? '')) declared.push({ id: m[1], line: i + 1 })
}

const bad = declared.filter((d) => !ids.has(d.id))
console.log(`patch 文件里显式 disabled:true 的行：${declared.length} 条`)
for (const d of declared) console.log(`  ${bad.includes(d) ? '❌ 组合里没有这个 id' : '✅'}  L${String(d.line).padStart(3)}  ${d.id}`)
console.log(`\n组合总行数=${ids.size}；对不上的 id=${bad.length}`)
process.exitCode = bad.length === 0 ? 0 : 1

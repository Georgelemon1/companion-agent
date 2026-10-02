// 可移植性审计：companion 真正需要的依赖闭包里，有没有原生模块 / 平台限制
//
// 背景（2026-09-30）：要把后端搬进 Android（Termux）。dsh-base 是完整 agent 宿主，
// 挂了一堆手机上不存在或不需要的东西（pwsh、landlock 沙箱、node-pty…）。
// 所以路线是"给手机一个裁剪 profile"，而裁剪可行的前提是：
// **她真正需要的那部分依赖闭包必须全是纯 JS**（或至少无 glibc/Windows 原生二进制）。
//
// 2026-09-30 第二轮：cordis.patch.yml 里已经加了一层"手机移植裁剪层"（关了 40+ 行，
// 实测 health 200 + 能回话）。本脚本的 ROOTS 同步改成**裁剪后实际挂载的集合**，
// 否则报告里会混进已经关掉的包（旧版 ROOTS 里的 dsh-config-editor /
// dsh-compaction-image-offload / dsh-attachment-local 就是这种情况）。
//
// 用法: node audit-portability.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 活动 DSH 的包目录（本机是 Windows 安装，只用来读依赖元数据） */
const PKG_ROOT = 'E:\\deepseek harness workspace1\\.dsh-new\\0.1.7-alpha.2\\node_modules'
const SCOPE = join(PKG_ROOT, '@deepseek-ai')

/**
 * companion 裁剪后**仍然挂在树上**的根集合（对齐 app/cordis.patch.yml 最终行集）。
 * 口径：row 最终 disabled !== true 的包，加上"没有独立行但是 ctx.fs 提供者"的
 * dsh-fs-sandbox 及其基类 dsh-fs-local（koffi 就藏在这一支里）。
 * 刻意排除：dsh-settings / dsh-config-editor / dsh-plugin-manager（无 profileContext，
 * 本来就没挂）、dsh-attachment-local、dsh-subprocess-local、dsh-sandbox-local、
 * 以及所有 tool-* / skill* / subagent* / web* / workflow* / goal* / spill*。
 */
const ROOTS = [
  // —— LLM 路由与重试 ——
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/dsh-llm-retry',
  // 注意：dsh-llm-pi-ai 已在裁剪层关掉（本应用没有 settings 服务，它永远休眠），
  // 去掉它直接从手机构建里省掉 @aws-sdk/* + @anthropic-ai/sdk 一大坨。
  // —— agent / 会话循环 ——
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-agent-instructions',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  // —— 会话存储与投影 ——
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence-jsonl',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-session-projection-cache',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-session-checkpoint-policy',
  '@deepseek-ai/dsh-storage',
  '@deepseek-ai/dsh-storage-json',
  '@deepseek-ai/dsh-storage-domain',
  // —— 凭据 / 授权 / 账号 ——
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-credentials-local',
  '@deepseek-ai/dsh-authorization',
  '@deepseek-ai/dsh-deepseek-account-platform',
  // —— 上下文预算：压缩（她陪聊几百轮要靠它）——
  '@deepseek-ai/dsh-token-meter',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-command-feedback',
  // —— 文件系统 seam（ctx.fs 的实际提供者；dsh-fs-local 的 koffi 是 win32 惰性分支）——
  '@deepseek-ai/dsh-fs-sandbox',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-fs-observation-policy',
  // —— 杂项基础服务 ——
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/dsh-tool-call-timeout-policy',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-util-time',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/dsh-util-crypto',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cordis-plugin-timer',
  // —— 非 @deepseek-ai 作用域：她自己的运行时依赖 ——
  'ws',
]

/** 已知原生/平台相关的包名特征（命中即需人工确认有无 android-arm64 预编译） */
const NATIVE_HINTS = [
  'sharp', 'onnxruntime', 'node-pty', 'koffi', 'better-sqlite3', 'sqlite3',
  'landlock', 'acl', 'pty', 'canvas', 'esbuild', 'rollup', 'swc', 'napi',
  'node-addon',
]

/** 运行期"惰性加载原生库"的源码特征（比包名更能说明问题） */
const NATIVE_LOAD_PATTERNS = [
  /require\(\s*['"](koffi|node-pty|sharp|onnxruntime-node)['"]\s*\)/g,
  /import\(\s*['"](koffi|node-pty|sharp|onnxruntime-node)['"]\s*\)/g,
  /from\s+['"](koffi|node-pty|sharp|onnxruntime-node)['"]/g,
  /node-addon-system/g,
]

const resolveDir = (name) => {
  const p = join(PKG_ROOT, name)
  return existsSync(p) ? p : null
}
const isThirdParty = (name) => !name.startsWith('@deepseek-ai/')

const seen = new Map()          // name -> { version, parents:Set }
const missing = new Set()
const nativeHits = []
const loadSites = []

function walk(name, depth, parent) {
  const dir = resolveDir(name)
  if (seen.has(name)) { if (parent) seen.get(name).parents.add(parent); return }
  if (dir === null) { missing.add(name); return }
  let pj
  try { pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { return }
  seen.set(name, { version: pj.version, depth, parents: new Set(parent ? [parent] : []) })

  // 原生迹象 1：包名特征
  if (NATIVE_HINTS.some((h) => name.toLowerCase().includes(h))) nativeHits.push({ name, why: '包名特征', depth })
  // 原生迹象 2：binding.gyp / .node 二进制
  try {
    if (existsSync(join(dir, 'binding.gyp'))) nativeHits.push({ name, why: 'binding.gyp', depth })
    const files = readdirSync(dir)
    if (files.some((f) => f.endsWith('.node'))) nativeHits.push({ name, why: '含 .node 二进制', depth })
    if (existsSync(join(dir, 'prebuilds'))) nativeHits.push({ name, why: 'prebuilds/', depth })
  } catch { /* 读不到就算了 */ }
  // 原生迹象 3：平台限制字段
  if (pj.os !== undefined || pj.cpu !== undefined) {
    nativeHits.push({ name, why: `package.json 限 os=${JSON.stringify(pj.os)} cpu=${JSON.stringify(pj.cpu)}`, depth })
  }
  // 原生迹象 4：安装脚本（node-gyp 编译）
  const scripts = pj.scripts ?? {}
  if (typeof scripts.install === 'string' && /gyp|prebuild|node-gyp|cnoke/.test(scripts.install)) {
    nativeHits.push({ name, why: `install 脚本：${scripts.install}`, depth })
  }
  // 原生迹象 5：源码里的运行期加载点（这才是 Android 上真正会炸的地方）
  if (!isThirdParty(name)) {
    const libDir = join(dir, 'lib')
    for (const f of listJs(libDir)) {
      let src
      try { src = readFileSync(f, 'utf8') } catch { continue }
      for (const re of NATIVE_LOAD_PATTERNS) {
        re.lastIndex = 0
        if (re.test(src)) loadSites.push(`${name}/${f.slice(libDir.length + 1)}`)
      }
    }
  }

  for (const dep of Object.keys(pj.dependencies ?? {})) walk(dep, depth + 1, name)
}

function* listJs(dir) {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* listJs(p)
    else if (e.name.endsWith('.js')) yield p
  }
}

for (const r of ROOTS) walk(r, 0, null)

const list = [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))
console.log(`companion 裁剪后闭包：${list.length} 个包（含 ${ROOTS.length} 个根）`)
console.log('\n--- 原生/平台相关命中 ---')
if (nativeHits.length === 0) console.log('  ✅ 无')
else for (const h of nativeHits) console.log(`  ⚠️  ${h.name}（${h.why}，深度 ${h.depth}）`)
if (missing.size > 0) {
  console.log('\n--- 本机未安装（需在手机上 npm install 时确认）---')
  for (const m of missing) console.log('  · ' + m)
}
console.log('\n--- 运行期原生加载点（源码里出现 koffi/node-pty/sharp/onnxruntime/node-addon-system 的文件）---')
if (loadSites.length === 0) console.log('  ✅ 无')
else for (const s of [...new Set(loadSites)].sort()) console.log('  ⚠️  ' + s)
console.log('\n--- 闭包清单 ---')
for (const [name, info] of list) console.log(`  ${name.replace('@deepseek-ai/', '')}@${info.version}`)

// 顺带报告：companion 自己那几个插件文件里 import 了哪些 DSH 包（这些也必须进闭包）
const appDir = join(import.meta.dirname, 'companion')
console.log('\n--- companion 插件自身 import 的包 ---')
for (const f of readdirSync(appDir).filter((x) => x.endsWith('.js'))) {
  const src = readFileSync(join(appDir, f), 'utf8')
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
  if (imports.length > 0) console.log(`  ${f}: ${[...new Set(imports)].join(', ')}`)
}

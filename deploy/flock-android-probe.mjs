// 探针：拿**真实的会话写入路径**验证 Android 会话锁降级
//
// 这不是"造一个假调用"：下面走的 create → flush → close → open(write) → append
// 就是应用在"开新会话、续聊、再续聊"时走的同一条码路，日志真的落到临时目录里。
//
// 关键点：本文件在**顶层同步**把 process.platform 改成 'android' ——
// 应用在手机上就是这个值（Termux/Android 不报 linux）。这样：
//   · SessionWriteLease.acquire 跳过 win32 分支，落到 POSIX flock 路（真问题所在）
//   · 持久化层走 materializePosix（真手机上也走这条）
// 改这个值必须在**动态 import 之前**：持久化层在模块初始化时就把
// process.platform 抓进了 internals.platform（index.js:1616）。
//
// 模块解析锚点：本文件在 deploy/ 下，而依赖装在 app/node_modules（junction）。
// 所以两条 import 都显式指向 app/ 下的真实文件 URL —— 不靠 cwd，也不靠
// deploy/ 上面有没有 node_modules（第一版就栽在这里：拿 ERR_MODULE_NOT_FOUND
// 当成了"flock 不可用"，是假阳性）。
//
// 用法（两条，用来对照）：
//   不加 shim：$env:COMPANION_FLOCK_SHIM_SELFTEST='no-shim'
//              node --import ./deploy/flock-probe-win-dirfsync-noop.mjs ./deploy/flock-android-probe.mjs
//   加了 shim：$env:COMPANION_FLOCK_SHIM_SELFTEST='expected-to-pass'
//              node --import ./deploy/flock-shim.mjs --import ./deploy/flock-probe-win-dirfsync-noop.mjs ./deploy/flock-android-probe.mjs
//   （那个 dirfsync-noop 只解决"Windows 不支持目录 fsync"这一条平台噪声，见其文件头）
//
// 退出码：0 = 本次运行符合预期；1 = 不符合（会打印是哪一条不成立）。

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

/**
 * 读一份会话日志的**全部行**。
 * 坑（实测）：持久化层把每个批次写成**独立的 zstd 帧**再拼接，
 * 而 Node 的 zstdDecompressSync 只解**第一帧**就停 —— 于是"其实写成功了"
 * 会被读成"只有一行 header"。这里按 zstd 帧魔数切开，逐帧解完再拼。
 */
function readLogLines(path) {
  const raw = readFileSync(path)
  if (!path.endsWith('.zstd')) return raw.toString('utf8').split('\n').filter(Boolean)
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) { starts.push(i); i += 3 }
  }
  if (starts.length === 0) return []
  const parts = []
  for (const [index, start] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1] : raw.length
    try { parts.push(zstdDecompressSync(raw.subarray(start, end)).toString('utf8')) } catch { /* 跳坏帧，剩下的帧仍然有用 */ }
  }
  return parts.join('').split('\n').filter(Boolean)
}

// ── 0. 伪装成手机 + 解析锚点 ───────────────────────────────────────────────
Object.defineProperty(process, 'platform', { value: 'android', configurable: true })
const SHIM_ON = process.env.COMPANION_FLOCK_SHIM_SELFTEST === 'expected-to-pass'

/** 指向 app/ 下的真实包文件（deploy/ 上面没有 node_modules，解析锚点必须显式给）。 */
const ANCHOR = new URL('../app/', import.meta.url)
const BACKEND_URL = pathToFileURL(fileURLToPath(new URL('node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js', ANCHOR))).href

/**
 * 直接 import 真实 flock 模块文件（file URL）—— **不经过 module hook**：
 * 钩子拦的是说明符，不是路径（实测：file URL 会绕过钩子）。
 * 所以这一层测的是"原封不动的原生入口在 android 上是什么行为"，
 * 两个 arm 用它做**对照基线**：没有它，加了 shim 之后就无法回答
 * "到底是 shim 起了作用，还是 platform 伪装没生效"。
 */
const REAL_FLOCK_URL = pathToFileURL(fileURLToPath(new URL('node_modules/@deepseek-ai/node-addon-system/lib/flock.js', ANCHOR))).href

const root = mkdtempSync(join(tmpdir(), 'companion-flock-probe-'))
const ok = []
const bad = []
const check = (name, pass, detail) => {
  ;(pass ? ok : bad).push(`${name}${detail === undefined ? '' : `　${detail}`}`)
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail === undefined ? '' : `　${detail}`}`)
}

console.log(`[探针] platform=${process.platform}-${process.arch}  node=${process.versions.node}`)
console.log(`[探针] 本次期望：${SHIM_ON ? '加 shim → 写入成功' : '不加 shim → 写入失败'}`)

// ── 1. 对照基线：直接 import 真实 flock 模块文件（file URL，绕过钩子）────────
console.log('\n【第 1 层】对照基线：真实 flock 原生入口（file URL，钩子拦不到）')
let flockError
try {
  const { tryLockExclusive } = await import(REAL_FLOCK_URL)
  await tryLockExclusive(999999)
  check('真实原生入口可用（不该发生：platform=android）', false)
} catch (error) {
  flockError = error
  check('真实原生入口在 android 上抛平台不支持', error.code === 'ERR_FLOCK_UNSUPPORTED_PLATFORM', `code=${error.code}｜${String(error.message).slice(0, 50)}`)
}

// ── 1b. 调用面：bare 说明符 —— 钩子真正要拦的那条路 ────────────────────────
// 用 app/ 里的一个临时模块当锚点（ESM 的解析锚点是**导入方文件**，不是 cwd），
// 这样 import 的就是应用代码用的那个说明符本身。
console.log('\n【第 1b 层】调用面：import "@deepseek-ai/node-addon-system/flock"（裸说明符）')
const TARGET = '@deepseek-ai/node-addon-system/flock'
const appDir = fileURLToPath(ANCHOR)
const anchorFile = join(appDir, `.probe-bare-import-${process.pid}.mjs`)
writeFileSync(anchorFile, `export * from ${JSON.stringify(TARGET)}\n`)
let shimActive = false
try {
  const viaBare = await import(pathToFileURL(anchorFile).href)
  shimActive = !String(viaBare.tryLockExclusive).includes('loadBinding')
  await viaBare.tryLockExclusive(999999)
  // 钩子接线自检：加了 shim 却拿到真模块 = 钩子没生效，必须当场失败，
  // 否则下面的"写入成功"会变成假阳性。
  check('加了 shim：裸说明符拿到的是桩（无原生 addon）', !SHIM_ON || shimActive, String(viaBare.tryLockExclusive).replace(/\s+/g, ' ').slice(0, 44))
  check('钩子接线正确（SHIM_ON 与实际一致）', SHIM_ON === shimActive, `SHIM_ON=${SHIM_ON} shimActive=${shimActive}`)
} catch (error) {
  // 无 shim 时应有的表现：裸说明符 import 直接抛平台不支持。
  check('无 shim：裸说明符 import 抛平台不支持', !SHIM_ON, `code=${error.code}｜${String(error.message).slice(0, 56)}`)
  check('钩子接线正确（无 shim 时不该有桩）', !SHIM_ON)
} finally {
  rmSync(anchorFile, { force: true })
}

// ── 2. 真实写入路径：create → flush（写 header）─────────────────────────────
console.log('\n【第 2 层】真实持久化层：create → flush（落 header 到磁盘）')
const { default: JsonlSessionPersistence } = await import(BACKEND_URL)

// 最小可用 ctx：install() 只用 on/effect/logger；Service 基类用 ctx.reflect.provide。
const ctx = {
  on() { return () => {} },
  effect(fn) { fn(); return () => {} },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  reflect: { provide() {} },
}

const id = `session-probe-${Date.now().toString(36)}`
// 压缩用环境变量可切：zstd 是线上默认；none 用来把"写入路径"和"zstd 编解码"
// 两件事分开看（实测 zstd 在多帧读回时会报 corrupt，见报告）。
const COMPRESSION = process.env.COMPANION_PROBE_COMPRESSION ?? 'zstd'
const backend = new JsonlSessionPersistence(ctx, { root, compression: COMPRESSION })
console.log(`  [诊断] compression=${COMPRESSION}`)

// 先声明：无 shim 时第一步（首次落盘）就会炸；有 shim 时两步都该成功。
// 这里不把"两步都成功"写成断言 —— 断言写在磁盘事实上（第 4 层），
// 因为"存不下会话"的判据是磁盘里有没有事件，不是哪一步先报错。
let flushError
try {
  const handle = await backend.create({ version: 4, id, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false, delegationDepth: 0 })
  await handle.flush()
  await handle.close()
  check('create + flush（首次落盘）成功', true)
} catch (error) {
  flushError = error
  check('create + flush（首次落盘）失败 —— 无 shim 时的实际表现', !SHIM_ON, `${error.code ?? 'n/a'}｜${String(error.message).slice(0, 70)}`)
}

const projDir = readdirSync(root, { withFileTypes: true }).find((e) => e.isDirectory())?.name
const dir = projDir === undefined ? root : join(root, projDir, id)
const listOrEmpty = (p) => { try { return readdirSync(p) } catch { return [] } }
const logFiles = listOrEmpty(dir).filter((f) => f.startsWith('session.v'))
const headerLines = logFiles.length > 0 ? readLogLines(join(dir, logFiles[0])) : []
const headerText = headerLines[0] ?? ''
if (SHIM_ON) {
  check('会话文件已落盘', logFiles.length > 0, logFiles.join(',') || `目录内容：${JSON.stringify(listOrEmpty(dir))}`)
  check('文件里第一行是本次会话的 header', headerText.includes(id), headerText.slice(0, 108))
} else {
  // 无 shim 时的**正向断言**：会话根本没落盘，目录里只剩一个拿不到锁的 session.lock
  check('无 shim：会话文件未落盘（只剩拿不到锁的 session.lock）', logFiles.length === 0, `目录内容：${JSON.stringify(listOrEmpty(dir))}`)
}

// ── 3. 真实写入路径：open(write) —— 续聊/重开会话时必须重新拿租约 ─────────────
// SessionWriteLease.acquire 在 android 上拿到的是 ERR_FLOCK_UNSUPPORTED_PLATFORM，
// 而调用方只把 EAGAIN 当"别人在写"，于是原样上抛。
// 注意：若第 2 步已经炸了，写占用还挂在 tracker 里（实测表现为
// "already owned by an active write handle"），所以这一步在无 shim 时
// 可能报的是占用而不是平台错 —— 两者都是"写不进去"。
console.log('\n【第 3 层】真实持久化层：open(write) + append（拿租约 → 追加事件）')
const physPath = () => {
  const f = listOrEmpty(dir).find((n) => n.startsWith('session.v'))
  return f === undefined ? undefined : join(dir, f)
}
const before = physPath() === undefined ? 0 : statSync(physPath()).size
console.log(`  [诊断] append 前物理字节数：${before}`)
let appended = false
let openError
try {
  const handle = await backend.open(id, 'write')
  await handle.append([{ seq: 0, type: 'user/message', data: { message: { role: 'user', content: '探针：会话锁降级本机验证' } } }])
  // 显式过一遍耐久屏障：append 只是缓冲 + 排程，flush 才是"落盘"的语义边界
  // （实测：只 append + close 时磁盘仍只有 header 一行）。
  await handle.flush()
  await handle.close()
  appended = true
  check('open(write) + append + flush 成功', SHIM_ON, SHIM_ON ? '' : '本不该成功')
} catch (error) {
  openError = error
  check('open(write) 失败 —— 无 shim 时的实际表现', !SHIM_ON, `${error.code ?? 'n/a'}｜${String(error.message).slice(0, 66)}`)
}
const afterSize = physPath() === undefined ? 0 : statSync(physPath()).size
console.log(`  [诊断] append 后物理字节数：${afterSize}（变化 ${afterSize - before}）`)
// 诊断：后端自己怎么看这条会话（事件数 / 字节数），以及物理文件大小
try {
  const st = await backend.stat(id)
  console.log(`  [诊断] backend.stat: revision=${String(st?.revision)} sizeBytes=${st?.sizeBytes} 事件数=${st?.events?.length ?? 'n/a'}`)
} catch (error) { console.log(`  [诊断] backend.stat 失败：${String(error.message).slice(0, 70)}`) }
try {
  const probeFile = listOrEmpty(dir).find((f) => f.startsWith('session.v'))
  console.log(`  [诊断] 物理文件：${probeFile ?? '(无)'} ${probeFile === undefined ? '' : `${statSync(join(dir, probeFile)).size} B`}`)
} catch { /* 诊断失败不影响主结论 */ }

// ── 4. 复查磁盘：事件真的写进去了吗（这才是"存得下会话"的直接证据）──────────
// 判据用**磁盘内容**，不用 backend.open(id,'read')：
//   实测（win32 原生路径、不带任何 shim）同一进程内 open(read) 刚写完的会话
//   会读到 0 条、zstd 还会报 "stored log is corrupt" —— 那是与 flock 无关的
//   既有行为（见报告"未验证/越界发现"），拿它当判据会误判本次修复。
console.log('\n【第 4 层】复查磁盘内容（逐帧解 zstd，行数/内容都看）')
const after = listOrEmpty(dir).filter((f) => f.startsWith('session.v'))
const finalPath = after.length > 0 ? join(dir, after[0]) : undefined
const lines = finalPath === undefined ? [] : readLogLines(finalPath)
const finalSize = finalPath === undefined ? 0 : statSync(finalPath).size
console.log(`  文件：${after.join(',') || '(无会话文件)'}　最终大小：${finalSize} B　解出 ${lines.length} 行`)
for (const [index, line] of lines.entries()) console.log(`    [${index}] ${line.slice(0, 150)}`)
const body = lines.join('\n')

if (SHIM_ON) {
  check('会话文件已落盘', after.length > 0, after.join(','))
  check(`append 真的写进了文件（字节数 ${before} → ${finalSize}）`, finalSize > before, `增长 ${finalSize - before} B`)
  check('日志里有 header + 事件两行', lines.length === 2, `实际 ${lines.length} 行`)
  check('事件内容确实在文件里（磁盘原文可读）', body.includes('探针：会话锁降级本机验证'))
} else {
  check('无 shim：会话文件未落盘（只剩拿不到锁的 session.lock）', after.length === 0, `目录内容：${JSON.stringify(listOrEmpty(dir))}`)
  check('无 shim：磁盘里没有任何事件内容', !body.includes('探针：会话锁降级本机验证'))
}

// ── 5. 收尾 ───────────────────────────────────────────────────────────────
try { await backend.dispose?.() } catch { /* 探针结束，dispose 失败不影响结论 */ }
console.log(`\n[探针] 通过 ${ok.length} 项，失败 ${bad.length} 项`)
for (const f of bad) console.log(`  ❌ ${f}`)
if (!SHIM_ON) {
  console.log(`[探针] 无 shim｜flock 原语错误：code=${flockError?.code}｜${flockError?.message}`)
  if (flushError !== undefined) console.log(`[探针] 无 shim｜首次落盘错误：code=${flushError.code ?? 'n/a'}｜${String(flushError.message).slice(0, 110)}`)
  if (openError !== undefined) console.log(`[探针] 无 shim｜open(write) 错误：code=${openError.code ?? 'n/a'}｜${String(openError.message).slice(0, 110)}`)
}
// 判定标准（这里的"预期"是行为预期，不是报错预期）：
//   加了 shim → 全绿，且事件真的落在磁盘上；
//   不加 shim → 原语的错必须是 ERR_FLOCK_UNSUPPORTED_PLATFORM，且**磁盘里没有事件**。
const expected = SHIM_ON
  ? bad.length === 0
  : flockError?.code === 'ERR_FLOCK_UNSUPPORTED_PLATFORM' && finalSize === 0 && !appended
console.log(expected ? '[探针] 结果符合预期' : '[探针] 结果不符合预期')
rmSync(root, { recursive: true, force: true })
process.exit(expected ? 0 : 1)

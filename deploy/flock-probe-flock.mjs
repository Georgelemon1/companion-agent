// 探测：这台机器上**原生 flock 到底能不能用**。
//
// 只做一件事：真的去拿一把独占锁（tryLockExclusive 对真实文件的 fd）。
// 不靠猜 platform —— 因为"platform 是 linux 但 addon 装不上"也是一种坏情况
// （Termux 是 Bionic libc，glibc/musl 的预编译 .node 都装不进去），
// 只有真调用才能分辨。退出码：0 = 可用；非 0 = 不可用（原因打到 stderr）。
//
// 由 deploy/termux-start.sh 调用；只有这里失败，它才挂 flock-shim.mjs。
//
// 两个必须注意的点（都是实测踩过的）：
//   ① 用**文件 URL** import 真实模块文件，不要用裸说明符：
//      本文件在 deploy/ 下，deploy/ 上面没有 node_modules；裸说明符会
//      ERR_MODULE_NOT_FOUND，于是"探测失败"变成假阳性（探针自己的解析失败）。
//   ② 如果探测时 shim 已经被挂上（例如启动脚本顺序被改坏），裸说明符会拿到
//      桩 —— 桩永远成功，于是"原生可用"变成假阳性。这里显式识别桩并**判失败**：
//      探测的语义是"这台机器原生能不能用"，不是"现在能不能拿到锁"。

import { mkdtempSync, openSync, closeSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REAL_FLOCK = pathToFileURL(fileURLToPath(new URL('../app/node_modules/@deepseek-ai/node-addon-system/lib/flock.js', import.meta.url))).href
const { tryLockExclusive } = await import(REAL_FLOCK)

// ② 真模块里有 loadBinding（惰性加载原生 addon）；桩里没有。
if (!String(tryLockExclusive).includes('loadBinding')) {
  process.stderr.write('探测时发现 flock 已被替换成桩实现 —— 无法判断原生是否可用，按不可用处理\n')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'companion-flock-check-'))
const file = join(dir, 'probe.lock')
let fd
try {
  fd = openSync(file, 'w')
  // 真去拿锁。刚建的空文件不可能被别人占用，所以任何 reject 都按不可用处理。
  await tryLockExclusive(fd)
  console.log('flock ok')
} catch (error) {
  process.stderr.write(`flock 不可用：${error?.code ?? 'n/a'}｜${error?.message ?? String(error)}\n`)
  process.exitCode = 1
} finally {
  if (fd !== undefined) { try { closeSync(fd) } catch { /* 关不掉也不影响结论 */ } }
  rmSync(dir, { recursive: true, force: true })
}

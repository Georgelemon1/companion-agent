// companion-agent · Android 会话锁降级桩（CommonJS）
//
// 它冒充的是 @deepseek-ai/node-addon-system/flock（lib/flock.js），
// 但**不含任何原生代码**：所有锁操作立即成功。
//
// 为什么可以这样做（不是我想当然，是上游自己写的）：
//   dsh-session-persistence-jsonl/lib/index.js 的 lease 模块注释（约 :637）说，
//   浏览器 worker 场景就是把原生 flock 入口换成"立即成功"的空实现 ——
//   因为它是单进程，进程内的写占用（tracker.writers）已经排除了所有写者。
//   手机端也是单进程（一个 Termux 里的 node），前提同构。
//
// 为什么不干脆让上游走 win32 信号量分支：process.platform 在 Android 上是
//   "android"，两个分支都不匹配，只能落回 POSIX flock，而 Bionic libc 没有
//   对应的预编译 addon（optionalDependencies 里只有 darwin/linux 的 glibc+musl）。
//
// 用 CJS 而不是 ESM：调用方靠 `import { tryLockExclusive }` 取具名导出，
//   而 Node 对 CJS 做具名导出静态分析（cjs-module-lexer）能识别
//   `exports.x = ...` 与 `Object.defineProperty(exports, 'x', ...)` 两种写法。
//   这样 import 与 require 两条路都能拿到同一份实现。
'use strict'

/**
 * 假装拿到独占锁。真实现是异步 flock(2)；这里立即 resolve，
 * 并且**不碰 fd**（fd 的所有权仍归调用方，与上游契约一致）。
 * @param {number} fd 调用方持有的文件描述符（这里不使用）。
 * @returns {Promise<void>} 总是成功。
 */
exports.tryLockExclusive = async function tryLockExclusive(fd) {
  void fd
}

/**
 * 兜底：上游 flock 目前只导出 tryLockExclusive（见 flock.d.ts）。
 * 若将来新增导出而本桩没跟上，**必须显式报错**而不是静默返回 undefined ——
 * 静默的 undefined 会让"锁没生效"变成偶发怪问题，比直接崩难查得多。
 */
const IMPLEMENTED = new Set(['tryLockExclusive'])
for (const name of ['tryLockShared', 'unlock', 'tryLock', 'lockExclusive', 'lockShared', 'release']) {
  if (IMPLEMENTED.has(name)) continue
  Object.defineProperty(exports, name, {
    enumerable: true,
    configurable: true,
    writable: true,
    value: function notImplemented() {
      throw new Error(
        `flock-shim: 未实现的导出 "${name}"（companion-agent 的 Android 单进程降级桩）。` +
        `上游 @deepseek-ai/node-addon-system/flock 新增了这个导出，请补上实现再上真机。`,
      )
    },
  })
}

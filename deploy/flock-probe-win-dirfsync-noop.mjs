// 仅用于本机（Windows）验证的旁路件 —— 让"POSIX 落盘路径"能在 Windows 上跑通。
//
// 为什么需要它（实测得到的硬限制，不是猜）：
//   把 process.platform 伪装成 android 后，持久化层走的是 materializePosix →
//   syncDirPosix → open(dir,'r') + handle.sync()，也就是**对目录 fsync**。
//   这在 Linux/Bionic 上是合法且必要的（保证目录项崩溃后可恢复），
//   但 Windows 不允许对目录句柄 fsync —— 实测抛
//   `EPERM: operation not permitted, fsync`，于是探针还没走到会话锁就先死了。
//   也就是说：这个 EPERM 是"在 Windows 上模拟 Android 路径"的观测噪声，
//   与我们要验证的 flock 降级无关。
//
// 本件做的事：只在 Windows 上、只在本探针进程内，把 node:fs/promises 的 open()
// 包一层 —— 当 handle.sync() 因 Windows 不支持目录 fsync 而 EPERM 时，把它变成
// 无操作（目录 fsync 在 Windows 只是空谈：没有这个语义，忽略它不改变任何断言）。
//
// 三条安全边界：
//   ① 只有在 COMPANION_FLOCK_SHIM_SELFTEST 被显式设置时才加载（必须显式开启）；
//   ② 只在 win32 上改（Linux/手机上是纯透传，行为零变化）；
//   ③ 只吞 **EPERM**，其它错误一律原样抛 —— 不然会把真实故障吃掉。
// 它**不进手机包、不参与正式启动**。

import { registerHooks } from 'node:module'

const ENABLED = process.env.COMPANION_FLOCK_SHIM_SELFTEST !== undefined && process.platform === 'win32'
const SYNTHETIC_URL = 'companion-probe:fs-promises-dirfsync-noop'

if (ENABLED) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 只把**别人**要的 node:fs/promises 换成合成件；合成件自己要的那个必须放行，
      // 否则它会解析回自己（实测报 "Detected cycle while resolving name"）。
      if (specifier === 'node:fs/promises' && context.parentURL !== SYNTHETIC_URL) {
        return { url: SYNTHETIC_URL, format: 'module', shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      if (url !== SYNTHETIC_URL) return nextLoad(url, context)
      // 生成件里直接用字面量 "node:fs/promises"：
      // 本 hook 只认 SYNTHETIC_URL，所以这个说明符会正常透传到真模块。
      // （别在这里用 import.meta.resolve —— 实测它会解析回本合成 URL，
      //   于是生成件变成自引用，报 "Detected cycle while resolving name"。）
      // 也不能写 `export * from "node:fs/promises"`：实测那样生成出来的模块
      // **没有任何具名导出**（Node 把 node:fs/promises 当 CJS，export * 导不出东西），
      // 调用方会报 "does not provide an export named 'link'"。所以显式列出名字转发。
      const NAMES = ['access', 'appendFile', 'chmod', 'copyFile', 'cp', 'lchmod', 'lstat', 'link', 'lutimes',
        'mkdir', 'mkdtemp', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'rmdir',
        'stat', 'statfs', 'symlink', 'truncate', 'unlink', 'utimes', 'watch', 'writeFile', 'constants']
      const source = `
import * as real from "node:fs/promises"
export { ${NAMES.join(', ')} } from "node:fs/promises"
export function open(...args) {
  return real.open(...args).then((handle) => {
    const wrapped = Object.create(handle)
    // 目录 fsync 在 Windows 上不存在（实测 EPERM）。只吞这一种错误。
    Object.defineProperty(wrapped, 'sync', {
      enumerable: false,
      value: async () => {
        try { return await handle.sync() } catch (error) {
          if (error?.code === 'EPERM') return undefined
          throw error
        }
      },
    })
    return wrapped
  })
}
`
      return { format: 'module', source, shortCircuit: true }
    },
  })
}

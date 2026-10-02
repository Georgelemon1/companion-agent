// companion-agent · Android 会话锁降级 —— module hook 入口（ESM）
//
// 作用域**只有一个子路径**：`@deepseek-ai/node-addon-system/flock`。
// 其它任何模块（包括同包的 ./landlock-run）都原样透传给默认解析器。
//
// 用法（由 deploy/termux-start.sh 在探测到 flock 不可用时挂上）：
//   node --import <本文件绝对路径> app/launcher.mjs
//
// 为什么用 module.register() 而不是 --experimental-loader：
//   --experimental-loader 在新版 Node 上已废弃并会打印 ExperimentalWarning；
//   module.register() 从 Node 20.6 起是等价且受支持的现代写法（本机实测 v24.13.0）。
//
// 为什么要注册**两套**钩子（这里是实测结论，不是照抄文档）：
//   · module.register()（异步、跑在独立 loader 线程）只作用于 ESM 的
//     import / import()。实测：`require()` 完全绕过它，照旧拿到真模块。
//   · require() 走的是同步 CJS 钩子，必须用 module.registerHooks()（Node 22.15+/23.5+）
//     注册 —— 实测它能拦住 require()。
//   本机 node v24.13.0 两个 API 都在。目标说明符在两条路上的解析结果被指向
//   同一个 CJS 桩，所以无论调用方用 import 还是 require，行为一致。
//   （当前唯一调用方 dsh-session-persistence-jsonl/lib/index.js:11 用的是 import，
//     但 ESM 里同样可以 createRequire，所以两条路都得堵上。）

import { register, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 被替换的模块说明符（精确匹配，不做前缀匹配 —— 避免误伤同包其它子路径）。 */
const TARGET = '@deepseek-ai/node-addon-system/flock'

/** 桩文件：与本文件同目录，随手机包一起走。 */
const STUB_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'flock-shim-stub.cjs')).href

// ── 钩子线程侧 ─────────────────────────────────────────────────────────────
// initialize 由 register() 传入的 data 调用一次（钩子线程不共享本模块的
// 模块级状态，常量只能这样搬过去）。
let target = TARGET
let stubUrl = STUB_URL
export function initialize(data) {
  if (data?.target !== undefined) target = data.target
  if (data?.stubUrl !== undefined) stubUrl = data.stubUrl
}

/** 只拦这一个说明符；其余一律交给默认解析器。 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === target) {
    return { url: stubUrl, format: 'commonjs', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

// ── 主线程侧 ───────────────────────────────────────────────────────────────
// 本文件被加载两次：一次是 `--import` 指定的进程入口（主线程），一次是
// register() 把它当钩子模块在**钩子线程**里加载。只有主线程那次该注册钩子；
// 钩子线程里再 register 会变成嵌套钩子（不致命，但没必要且日志会像挂了两次）。
// 区分办法：register() 之前先打一个环境变量（worker 线程继承主线程 env 的快照）。
if (process.env.__COMPANION_FLOCK_SHIM_REGISTERED__ !== '1') {
  process.env.__COMPANION_FLOCK_SHIM_REGISTERED__ = '1'

  // ① 同步钩子：拦住 require()（含 createRequire）。老 Node 没有这个 API 就跳过，
  //    此时 ESM 路仍然由下面的 register() 兜住。
  if (typeof registerHooks === 'function') {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === TARGET) {
          return { url: STUB_URL, format: 'commonjs', shortCircuit: true }
        }
        return nextResolve(specifier, context)
      },
    })
  }

  // ② 异步钩子（独立线程）：拦住 ESM 的 import / import()。
  register(import.meta.url, { data: { target: TARGET, stubUrl: STUB_URL } })
}

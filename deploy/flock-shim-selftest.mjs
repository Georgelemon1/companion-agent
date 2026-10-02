// 探针：验证 flock-shim.mjs 的钩子语义
//
// 要回答五件事（都靠实测，不靠猜）：
//   ① 主线程 ESM import 目标子路径 → 是否被换成桩
//   ② CJS 侧（createRequire，锚点与 app 代码一致）→ 是否也拿到桩
//   ③ 未实现的导出是否显式抛错（而不是静默 undefined）
//   ④ 桩是否"立即成功"且不碰 fd（连明显非法的 fd 都不该报错）
//   ⑤ 作用域是否只在这一个子路径上（不相关模块照常可用）
//
// 用法（必须从 app/ 目录跑，否则 node_modules 解析锚点不对）：
//   node --import ../deploy/flock-shim.mjs ../deploy/flock-shim-selftest.mjs

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'          // ⑤ 不相关的内置模块，必须照常可用
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'  // ① ESM 路

// ② CJS 锚点必须与真实调用方同构：app 目录下的文件（launcher.mjs）。
//    用本探针文件当锚点是**错的** —— deploy/ 上面没有 node_modules，
//    默认解析器会 MODULE_NOT_FOUND，那样测的是"找不到包"而不是"钩子有没有改道"。
const APP_DIR = fileURLToPath(new URL('../app/', import.meta.url))
const require = createRequire(pathToFileURL(join(APP_DIR, 'launcher.mjs')))

let failures = 0
function check(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : `　${detail}`}`)
  if (!ok) failures += 1
}

console.log(`[自检] platform=${process.platform}-${process.arch}  node=${process.versions.node}`)

// ① ESM 具名导出拿到了吗？拿到的是桩吗（不是原生模块）？
check('ESM 具名导出 tryLockExclusive 可解析', typeof tryLockExclusive === 'function')
const esmSrc = tryLockExclusive.toString()
check('ESM 侧拿到的是桩实现（无原生 addon）', esmSrc.includes('void fd'), esmSrc.replace(/\s+/g, ' ').slice(0, 60))

// ④ 桩必须立即成功，且不碰 fd
await tryLockExclusive(999999)
check('tryLockExclusive(非法 fd) 立即成功、不碰 fd', true)

// ② CJS require 也要拿到同一份桩
const viaCjs = require('@deepseek-ai/node-addon-system/flock')
check('CJS require 也能拿到桩', typeof viaCjs.tryLockExclusive === 'function')
check('CJS 与 ESM 是同一份实现', viaCjs.tryLockExclusive.toString() === esmSrc, viaCjs.tryLockExclusive.toString().replace(/\s+/g, ' ').slice(0, 46))
check('CJS 路径不含原生 addon（纯 JS 桩）', !String(viaCjs.tryLockExclusive).includes('loadBinding'))
// 注：require.resolve() 不走钩子（实测：它只做路径解析、不经过 registerHooks），
// 所以这里**不**断言 resolve 改道 —— 能拦住的是 require() 本身，那才是调用面。

// ③ 未实现的导出必须显式抛错（不许静默 undefined）
check('未实现导出存在且会抛错', typeof viaCjs.tryLockShared === 'function')
let threw = ''
try { viaCjs.tryLockShared(1) } catch (error) { threw = String(error.message) }
check('未实现导出抛的是可读错误', threw.includes('未实现的导出'), threw.slice(0, 56))

// ⑤ 作用域：不相关的模块与不相关的子路径都不许被影响
const pkg = JSON.parse(readFileSync(new URL('../app/package.json', import.meta.url), 'utf8'))
check('不相关的文件读取不受影响', typeof pkg.name === 'string', pkg.name)
let otherPath = ''
try { otherPath = require.resolve('@deepseek-ai/node-addon-system/package.json') } catch { /* 记在下面 */ }
check('同包其它子路径未被改道', otherPath.endsWith('package.json') && !otherPath.includes('shim'), otherPath)

console.log(failures === 0 ? '[自检] 全部通过' : `[自检] ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)

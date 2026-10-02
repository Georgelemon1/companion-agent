// companion-agent 独立启动器。
//
// 不经过 dsh CLI：直接用 @deepseek-ai/dsh-app-boot 装载本应用自有的 profile 目录。
// loadProfileDirectory 的契约正是"应用自有 profile，其包工程与生命周期属于该应用"，
// 所以本应用不读写 $DSH_HOME/profiles —— 只有凭据与 settings 仍来自 ~/.dsh
// （DSH_HOME 不变），会话数据由 cordis.patch.yml 指向项目内的 state/。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  boot,
  loadProfileDirectory,
  installFailLoud,
} from '@deepseek-ai/dsh-app-boot'

const BIN = 'companion'
const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here)
/** 本应用的依赖闭包锚点：与已安装的 DSH 共用一份模块解析（node_modules junction）。 */
const moduleAnchor = join(appDir, 'node_modules')

/** 进程关闭控制：先给整棵树优雅 dispose 的机会，超时再强退。 */
const SHUTDOWN_TIMEOUT_MS = 5000
function createShutdown(dispose, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  let pending
  let app
  return {
    setApp(ctx) { app = ctx },
    shutdown(code) {
      if (pending !== undefined) return pending
      const timeout = setTimeout(() => process.exit(code), timeoutMs)
      timeout.unref?.()
      pending = Promise.resolve().then(dispose).then(
        () => { clearTimeout(timeout); process.exitCode = code },
        () => { clearTimeout(timeout); process.exit(code) },
      )
      return pending
    },
    get app() { return app },
  }
}

async function main() {
  const rootConfig = join(appDir, 'cordis.yml')
  // 一次性读到 package.json 的 profile 清单，确认 bundles 声明存在（配置错误要早点响）。
  const manifest = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error(`${BIN}: app/package.json 缺少 dsh.profile.bundles`)
  }

  const profile = loadProfileDirectory(BIN, appDir, join(appDir, 'package.json'))
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches]

  let rootCtx
  const shutdown = createShutdown(async () => {
    await rootCtx?.fiber.dispose()
  })

  installFailLoud(BIN, process, async () => {
    await rootCtx?.fiber.dispose()
  })

  process.on('SIGINT', () => shutdown.shutdown(0))
  process.on('SIGTERM', () => shutdown.shutdown(0))

  rootCtx = await boot(
    BIN,
    rootConfig,
    patches,
    () => {
      // prepare：树挂载前的主机准备。本应用不需要额外注入，保留钩子以便后续扩展。
    },
    pathToFileURL(`${moduleAnchor}/`).href,
  )
  shutdown.setApp(rootCtx)

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`${BIN}: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`)
  })
}

main().catch((error) => {
  process.stderr.write(`${BIN}: 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})

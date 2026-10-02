// 共享日志助手。
//
// 为什么不用 ctx.logger：本机后台启动时 cordis logger 的输出不可见，
// 排障时容易误判为"插件没跑"。所有 companion 插件统一走这里：
// 同时写状态目录下的文件 + cordis logger（有终端时仍能看到）。

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 状态目录到 logger 的映射，避免每个插件各建一份。 */
const loggers = new Map()

/**
 * 创建一个写文件 + 写 cordis logger 的日志函数。
 * @param ctx - 插件上下文（用于 ctx.logger）。
 * @param pluginName - 插件名，写进每行便于区分来源。
 * @param stateDir - 状态目录（日志落在其 companion.log）。
 * @returns { info, warn, error } 三个级别的日志函数。
 */
export function createLogger(ctx, pluginName, stateDir) {
  const key = stateDir
  if (!loggers.has(key)) {
    mkdirSync(dirname(join(stateDir, 'companion.log')), { recursive: true })
    loggers.set(key, join(stateDir, 'companion.log'))
  }
  const logPath = loggers.get(key)
  const cordisLogger = ctx.logger(pluginName)

  const write = (level, message) => {
    const line = `${new Date().toISOString()} [${level}] [${pluginName}] ${message}\n`
    try {
      appendFileSync(logPath, line)
    } catch {
      /* 日志失败不能影响主流程 */
    }
    if (level === 'error') cordisLogger.error(message)
    else if (level === 'warn') cordisLogger.warn(message)
    else cordisLogger.info(message)
  }

  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

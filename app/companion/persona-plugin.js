// companion-persona —— 把"她是谁"和"她现在什么状态"接进系统提示词。
//
// 为什么必须在 agent 作用域注册：`systemPrompt.section()` 是**按调用上下文定作用域**的，
// 而 {model}/{cwd} 这类变量的解析依赖当前 Agent 的 AssembleContext。在 agent.ctx 上注册，
// 段才能读到正确的 agent；全局注册会与部署级默认人设相撞。
//
// 两条段：identity（稳定身份，人设卡渲染）与 state（情绪+关系，按步实时渲染）。
// 都走 section 而非 context —— context 会被渲染成持久 user 消息塞进历史。

import z from '@deepseek-ai/schemastery'
import { DEFAULT_PERSONA, SECTION_ORDER, renderIdentity } from './persona.js'
import { describeCard, describeTraitChanges } from './infer.js'
import { createLogger } from './log.js'

/** Cordis 函数插件名。 */
export const name = 'companion-persona'

/** 状态段读的是 affect 服务提供的渲染函数。 */
export const inject = ['companionAffect']

/** 插件配置。 */
export const Config = z.object({
  /** 人设卡 JSON 文件路径；存在则覆盖数据库里的卡（方便手工编辑角色）。 */
  personaFile: z.string().default(''),
  /** 是否注入动态状态段。关掉可用于排查"是不是状态段让人设变味"。 */
  injectState: z.boolean().default(true),
  /** 状态目录（日志落在这里）。 */
  stateDir: z.string().required(),
})

/**
 * 挂载人设层。
 * @param ctx - 插件上下文（承载 companionAffect 服务）。
 * @param config - 已校验配置。
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx, name, config.stateDir)
  const affect = ctx.get('companionAffect')
  if (affect === undefined) {
    logger.error('companionAffect 服务不可用，人设层未挂载')
    return
  }

  /** 播种：数据库里没有卡片就先写入默认角色。 */
  const seeded = affect.persona()
  if (seeded === undefined) {
    affect.writePersona?.(DEFAULT_PERSONA)
    logger.info(`未发现人设卡，已播种默认角色「${DEFAULT_PERSONA.name}」`)
  } else {
    logger.info(`已加载人设卡：角色=${seeded.name} 来源=${seeded.source ?? '未知'}`)
  }

  /**
   * 每次渲染都从库里读最新设定（基线卡 + 对话里推断出的覆盖项）。
   *
   * 为什么不缓存：设定**每回合都可能被她自己改**（infer.js 从最近对话里推断），
   * 而缓存下来的卡片要等 Agent 重建才会更新。读一次 SQLite 的成本远低于重建一个会话。
   *
   * 顺带做一件事：设定一变就打一行日志。段落文本函数由 systemPrompt 在**每次组装时**
   * 调用，所以这行日志出现在"下一个回合"，它同时也是"改了立刻生效"唯一可复核的证据。
   *
   * 只打**变了哪几项**，不打整张卡：任何一个维度一变就重打全卡，
   * 日志里看起来像"人设一直在变"，实际只动了一项（实跑被这么误读过）。全卡走
   * `/companion/persona` 或 `node app/probe-persona.mjs`，那才是看全景的地方。
   */
  let lastInferred
  const currentCard = () => {
    const card = affect.persona() ?? seeded ?? DEFAULT_PERSONA
    const inferred = card.inferred ?? []
    if (JSON.stringify(inferred) !== JSON.stringify(lastInferred)) {
      const previous = lastInferred
      lastInferred = inferred
      if (previous === undefined) {
        logger.info(`人设段已装载：${describeCard(card)}`)
      } else {
        logger.info(`人设段已更新（下一回合即生效）：${describeTraitChanges(previous, inferred) || '（无值变化）'}`)
      }
    }
    return card
  }

  // 每个 Agent 创建时，在**它自己的作用域**里注册两段提示词。
  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    const section = agent.ctx.get('systemPrompt')
    if (section === undefined) {
      logger.warn('该 Agent 没有 systemPrompt 服务，跳过人设注册')
      return
    }

    const disposers = []

    // ① 稳定身份段：让"她"压过部署默认的编码助手人设。
    disposers.push(section.section({
      name: 'companion:identity',
      order: SECTION_ORDER.identity,
      text: () => renderIdentity(currentCard()),
    }))

    // ② 动态状态段：按步渲染，所以每次组装都拿最新情绪（含读时衰减）。
    if (config.injectState) {
      disposers.push(section.section({
        name: 'companion:state',
        order: SECTION_ORDER.state,
        text: () => affect.renderStateText(),
      }))
    }

    logger.info(`已为 Agent ${String(agent.session.id)} 注册人设段（identity + ${config.injectState ? 'state' : '无状态'}）`)

    agent.ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'companion-persona.dispose()')
  }), 'companion-persona.register()')

  logger.info(`人设层就绪 角色=${currentCard().name}`)
}

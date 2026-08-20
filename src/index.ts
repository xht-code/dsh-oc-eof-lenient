/**
 * dsh-oc-eof-lenient
 *
 * `llm/stream` waterfall 中间件：对目标 provider 的模型流做 OpenCode 风格的
 * EOF 宽容。某些 OpenAI 兼容网关在已产出一整轮内容后直接关闭 SSE、不发送
 * `finish_reason`，pi-ai 会将此归类为 `TRANSPORT: Stream ended without
 * finish_reason` 并使整次调用失败重试；OpenCode 使用的 AI SDK 在同一流上把
 * EOF 当作正常完成。
 *
 * 本插件不改任何适配器源码：只在目标路由的流进入 harness 装配器（以及
 * retry/replay 层）之前，把上述错误结尾改写成正常完成。
 *
 * 启用位置：直接写在对应 provider 的配置里（llm-pi-ai.providers.<name> 下），
 * 支持 provider 级（对该 provider 全部模型生效）与模型级（覆盖 provider 级）。
 * 未开启的 provider / 模型与其它错误原样透传，不受影响。
 *
 * @module dsh-oc-eof-lenient
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { applyLenientEof, type LenientEofOptions } from './leniency.js'

/** 插件注册名（同时作为 cordis 插件 id）。 */
export const name = 'dsh-oc-eof-lenient'

/** 需要 llm 与 settings 服务已就绪，llm/stream 事件与 llm-pi-ai 设置才可用。 */
export const inject = ['llm', 'settings']

/** 本插件在目标 provider / model 配置里读取的启用标志（布尔）。 */
export const EOF_LENIENT_FLAG = 'eofLenient'

/** 插件配置（仅作行为开关；启用范围不在这里声明，而在对应 provider 配置下面）。 */
export interface Config {
  /** 仅在已产出完整内容块时改写；false 表示任意位置都改写（默认 true）。 */
  requireCompletedContent: boolean
  /** auto：有完整工具调用块则以 tool-calls 结束，否则 stop；stop：恒为 stop（默认 auto）。 */
  finishReason: 'auto' | 'stop'
}

/** 运行时 schema（提供 CLI/界面默认值与前缀校验）。 */
export const Config = z.object({
  requireCompletedContent: z.boolean().default(true),
  finishReason: z.union([z.const('auto'), z.const('stop')]).default('auto'),
})

/** llm-pi-ai 设置命名空间，插件在这里读 provider 配置下的启用标志。 */
const LLM_PI_AI = settingsNamespace('llm-pi-ai')

/**
 * 从 llm-pi-ai 设置段解析启用范围：provider 级与 model 级两块标志。
 * 若该命名空间尚未注册（返回 undefined）或无可读配置，则视为未启用。
 * @param ctx - 插件上下文。
 * @param provider - 路由 id。
 * @param model - 模型 id。
 * @returns 该路由是否启用 EOF 宽容。
 */
export function leniencyEnabled(ctx: Context, provider: string, model: string): boolean {
  const section = ctx.settings.get(LLM_PI_AI) as
    | { providers?: Record<string, unknown> }
    | undefined
  const profile = section?.providers?.[provider] as
    | { models?: Array<Record<string, unknown>>; eofLenient?: unknown }
    | undefined
  if (profile === undefined) return false
  // 模型级标志更具体，优先于 provider 级；显式 false 也可用于在 provider 级开启的
  // 前提下关闭某一个模型。
  const modelFlag = profile.models
    ?.find((entry) => entry.id === model)?.[EOF_LENIENT_FLAG]
  if (modelFlag !== undefined) return Boolean(modelFlag)
  return Boolean(profile[EOF_LENIENT_FLAG])
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const options: LenientEofOptions = {
    requireCompletedContent: config.requireCompletedContent ?? true,
    finishReason: config.finishReason ?? 'auto',
  }

  const dispose = ctx.on('llm/stream', (request: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    // 未启用（未在对应 provider/model 配置下写 eofLenient）的路由原样透传。
    if (request.provider === undefined || !leniencyEnabled(ctx, request.provider, request.model)) return next()
    return applyLenientEof(next(), options)
  })

  ctx.logger?.info?.('[' + name + '] 已激活：读取 llm-pi-ai.providers.<name> 下的 ' + EOF_LENIENT_FLAG + ' 标志。')
  // 非 global 监听随插件上下文销毁自动移除，无需手动清理。
  void dispose
}
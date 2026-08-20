/**
 * EOF 宽容流包装：`llm/stream` 中间件的纯逻辑核心。
 *
 * 目标场景：OC 网关在已产出一整轮内容（文本或工具调用）后关闭 SSE，且不发送
 * 标准的 `finish_reason`/终止帧。pi-ai 将其归类为
 * `TRANSPORT: Stream ended without finish_reason` 的 in-stream 错误结尾；
 * OpenCode 使用的 AI SDK 在同一条流上把 EOF 当作正常完成。本模块在目标 provider
 * 的流到达 harness 装配器之前，把这种「内容已完整、仅缺终止帧」的结尾改写成
 * 正常 `stop`（或 `tool-calls`）完成，从而与 OpenCode 行为对齐。
 *
 * 保守策略：只有已产出一个完整内容块（text/tool-call 的 block-end）时才会改写；
 * 空流上的同类错误（真实的中途截断）原样透传，不让宽容掩盖传输故障。
 *
 * @module dsh-oc-eof-lenient/leniency
 */
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'

/** pi-ai 对「流在终止事件前结束」的标准报错文本。 */
const MISSING_FINISH_REASON_TEXT = 'Stream ended without finish_reason'

/** 本插件期望匹配的传输错误结尾。 */
export interface LenientEofOptions {
  /** 仅在已产出完整内容块时才改写；`false` 表示任意位置都改写（默认 true）。 */
  requireCompletedContent: boolean
  /** `auto`：有完整工具调用块则以 tool-calls 结束，否则 stop；`stop`：恒为 stop。 */
  finishReason: 'auto' | 'stop'
}

/**
 * 判断一个 `finish` chunk 是否为本插件要宽容的「缺 finish_reason 的传输错误结尾」。
 * @param chunk - harness 流 chunk。
 * @returns 命中时为 `true`。
 */
export function isMissingFinishReasonError(chunk: StreamChunk): boolean {
  if (chunk.type !== 'finish' || chunk.reason.kind !== 'error') return false
  const failure = chunk.reason.failure
  if (failure.code !== 'TRANSPORT') return false
  const message = failure.message ?? ''
  return message.includes(MISSING_FINISH_REASON_TEXT)
}

/** 由本插件合成的正常完成 reason。 */
function syntheticFinish(sawToolCall: boolean, finishReason: LenientEofOptions['finishReason']): FinishReason {
  return finishReason === 'auto' && sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
}

/**
 * 包装上游适配器流，对目标 provider 做 EOF 宽容改写；其余 chunk 原样透传。
 * @param upstream - 已解析适配器产出的原始 chunk 流。
 * @param options - 宽容策略。
 * @returns 改写后的 chunk 流。
 */
export async function* applyLenientEof(
  upstream: AsyncIterable<StreamChunk>,
  options: LenientEofOptions,
): AsyncGenerator<StreamChunk> {
  // 是否已看到完整内容块（text/tool-call 的 block-end）；reasoning 块不计入交付内容。
  let sawText = false
  let sawToolCall = false
  for await (const chunk of upstream) {
    if (chunk.type === 'block-end') {
      if (chunk.block.type === 'tool-call') {
        sawToolCall = true
      } else if (chunk.block.type === 'text') {
        sawText = true
      }
    }
    if (!isMissingFinishReasonError(chunk)) {
      yield chunk
      continue
    }
    // 缺终止帧的传输错误结尾：内容已完整则改为正常完成，否则保守透传错误。
    const hasCompletedContent = sawText || sawToolCall
    if (options.requireCompletedContent && !hasCompletedContent) {
      yield chunk
      continue
    }
    yield { type: 'finish', reason: syntheticFinish(sawToolCall, options.finishReason) }
    return
  }
}

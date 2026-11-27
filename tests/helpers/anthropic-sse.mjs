// 聊天层用例的**上游 SSE 应答替身**（Anthropic 协议 / deepseek 渠道）。
//
// 为什么抽到 helpers 而不是每个用例各抄一份：`check:test-duplication` 的 R1（逐字相同 ≥20 行）
// 会把「两处一模一样的事件流构造」判红（#955 撞过这条：新增的用例与 #379 的用例逐字重复 23 行）。
// 事件顺序也不能少一个：少 `message_start` / `message_delta`，stream 收尾判定就会走偏，
// 用例会以「没有回复」失败，看不出真正原因。
//
// 用法：
//   import { anthropicStream } from '../helpers/anthropic-sse.mjs'
//   globalThis.fetch = async () => anthropicStream('收到')
//
// 需要别的模型/渠道时请在本文件加参数，不要在用例里另抄一份事件流。
const encoder = new TextEncoder()

/**
 * 造一个**可流式消费**的 `Response`（`text/event-stream`）。
 *
 * @param {string} text 助手正文（单个 text block）
 * @param {{ model?: string, messageId?: string, outputTokens?: number }} [options]
 * @returns {Response}
 */
export const anthropicStream = (text, options = {}) => {
  const model = options.model ?? 'deepseek-flash'
  const messageId = options.messageId ?? 'msg-stream'
  const outputTokens = options.outputTokens ?? 20
  return new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        send({
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        send({ type: 'content_block_stop', index: 0 })
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        })
        send({ type: 'message_stop' })
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

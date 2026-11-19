/**
 * OpenAI 兼容协议 ↔ 本应用内部（Anthropic Messages 风格）协议的翻译层。
 *
 * 只有这一个模块知道 OpenAI 的字段长什么样；上层（client.ts / store.ts / 组件）继续只认
 * CreateMessageRequest 与 MessageStreamEvent，因此 openai 模式不需要在 UI 层加任何分支。
 *
 * 请求方向（Anthropic 请求体 → OpenAI 请求体）
 * - system → messages 头部的 {role:'system'}
 * - messages 里 user / assistant 原样映射；content 是 block 数组时只取 type:'text' 拼接，
 *   图片（image）与文档（document）直接丢弃（openai spec 的 caps.vision=false，界面上也传不出附件）
 * - thinking 字段的落地方式由 spec.reasoningParam 决定（#297，三档）：
 *   · `none`（默认）→ 丢弃。OpenAI 协议没有这个字段，DeepSeek 的 reasoning_effort 不是通用的
 *     chat/completions 参数，转发给第三方中转只会换来 400；openai spec 默认就是这一档，
 *     界面上也没有开关，「丢弃」是本模块的选择（见 CHANGELOG 1.3.0）。
 *   · `reasoning_effort` → 开启思考时加 `reasoning_effort: 'low'|'medium'|'high'`（档位来自 spec）
 *   · `thinking_enabled` → 开启思考时加 `thinking: { type: 'enabled' }`
 *   「开启没开启」只认 body.thinking.type（上游 store 已按 REQUEST_GATES 决定），
 *   这里不判断渠道能力，只做协议翻译 —— 两处职责不重叠。
 *   safety_check / title / tools 不在这里剥：REQUEST_GATES 已经在 store.ts 决定发不发。
 * - stream: true 必带；另带 stream_options.include_usage 以便上游回传真实用量
 *
 * 响应方向（OpenAI SSE → Anthropic 事件流）
 * 逐个 chunk 翻译成严格合法的事件序列：
 *   message_start → content_block_start(text) → content_block_delta(text_delta)*
 *   → content_block_stop → message_delta(stop_reason + usage) → message_stop
 * 若上游下发 reasoning_content（部分兼容实现即使不开思考也会带），另开一个 thinking 块，
 * 先 thinking_delta 再 content_block_stop，正文接着开 text 块，不需要为此改 caps。
 *
 * 脏数据一律容错，不抛错也不卡死：空 choices、delta 为空对象、非 JSON 的 data 行、
 * 多 choices（只取 index 0）、没有 [DONE] 的断流（照常收尾）、只带 usage 的收尾 chunk。
 */
import type { ServerSentEvent } from './sse.js'
import {
  reasoningEffortOf,
  reasoningParamOf,
  type ProviderSpec,
  type ReasoningEffort,
} from './providers.js'
import type {
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

// ---------- 请求方向 ----------

/** OpenAI chat/completions 的 message；content 一律是纯字符串 */
export type OpenAIChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 本应用实际会发出的 OpenAI 请求体（基础对话 + 可选的显式思考参数） */
export type OpenAIChatRequest = {
  model: string
  messages: OpenAIChatMessage[]
  stream: true
  stream_options: { include_usage: boolean }
  /** `reasoningParam: 'reasoning_effort'` 且开启思考时才有 */
  reasoning_effort?: ReasoningEffort
  /** `reasoningParam: 'thinking_enabled'` 且开启思考时才有 */
  thinking?: { type: 'enabled' }
}

/**
 * 思考参数按 spec 的档位翻译（#297）。
 * `enabled` 为 false（用户没开开关 / 渠道不支持）时**不发任何思考字段**：
 * 关闭态不该给上游留一个 `reasoning_effort` 之类的尾巴，那是「关了还在思考」。
 */
export const reasoningFields = (
  spec: Pick<ProviderSpec, 'reasoningParam' | 'reasoningEffort'>,
  enabled: boolean
): Pick<OpenAIChatRequest, 'reasoning_effort' | 'thinking'> => {
  if (!enabled) {
    return {}
  }
  switch (reasoningParamOf(spec)) {
    case 'reasoning_effort':
      return { reasoning_effort: reasoningEffortOf(spec) }
    case 'thinking_enabled':
      return { thinking: { type: 'enabled' } }
    default:
      // none / 非法值：保持丢弃（fail-closed，与 1.3.0 行为一致）
      return {}
  }
}

/**
 * 内容 → 纯字符串：block 数组只保留 text 块，图片/文档/思考/工具块全部丢弃。
 * 多个 text 块（例如被思考块隔开的正文）按空行拼接，与 reply.ts 的回传风格一致。
 */
export const contentToString = (content: MessageParam['content']): string => {
  if (typeof content === 'string') {
    return content
  }
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

const isEmptyContent = (message: MessageParam): boolean =>
  message.role === 'latest_reminder' || contentToString(message.content).trim() === ''

/**
 * Anthropic 请求体 → OpenAI 请求体（thinking 按 spec.reasoningParam 决定丢弃还是翻译）。
 * `spec` 省略时按 `none` 处理：老调用方（单测 / 探测）行为不变，仍是「丢弃」。
 */
export const toOpenAIRequest = (
  body: CreateMessageRequest,
  spec?: Pick<ProviderSpec, 'reasoningParam' | 'reasoningEffort'>
): OpenAIChatRequest => {
  const messages: OpenAIChatMessage[] = []
  // system 不进 messages 数组之外的任何地方：OpenAI 用 messages 头部的 system 行表达
  if (body.system.trim()) {
    messages.push({ role: 'system', content: body.system })
  }
  for (const message of body.messages) {
    // latest_reminder 已由 foldReminders 折进 system，这里只做兜底跳过
    if (isEmptyContent(message)) {
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    messages.push({ role: message.role, content: contentToString(message.content) })
  }
  return {
    model: body.model,
    messages,
    stream: true,
    // 不带它 OpenAI 不会在流里返回用量；兼容实现普遍接受该字段，不认的会直接忽略
    stream_options: { include_usage: true },
    // 开启态 = 本轮真的要思考（store.ts 已按 REQUEST_GATES 判定过渠道能力）
    ...(spec ? reasoningFields(spec, body.thinking?.type === 'enabled') : {}),
  }
}

// ---------- 响应方向 ----------

/** finish_reason 映射表；未知值按正常结束处理（工具已关，tool_calls 也归到 end_turn） */
const FINISH_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'end_turn',
  function_call: 'end_turn',
  content_filter: 'refusal',
}

export const mapFinishReason = (reason: string): StopReason => FINISH_REASONS[reason] ?? 'end_turn'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const ZERO_USAGE: MessageUsage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
}

/**
 * OpenAI usage → Anthropic usage。
 * prompt_tokens 含命中缓存的部分，Anthropic 的 input_tokens 只算未命中的，因此拆成两段；
 * 缓存字段兼容 prompt_tokens_details.cached_tokens 与 DeepSeek 的 prompt_cache_hit_tokens。
 */
export const readUsage = (value: unknown): MessageUsage | null => {
  if (!isRecord(value)) {
    return null
  }
  const prompt = num(value.prompt_tokens ?? value.input_tokens)
  const details = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {}
  const cacheRead = Math.min(num(details.cached_tokens ?? value.prompt_cache_hit_tokens), prompt)
  return {
    input_tokens: prompt - cacheRead,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cacheRead,
    output_tokens: num(value.completion_tokens ?? value.output_tokens),
  }
}

/** 流里明确下发了错误帧（部分中转在断流前回 `{"error":{...}}`），交给 client.ts 转成 ApiError */
export class OpenAIStreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenAIStreamError'
  }
}

type BlockKind = 'text' | 'thinking'

type TranslatorState = {
  started: boolean
  /** 当前打开的内容块；null 表示没有打开的块 */
  block: { kind: BlockKind; index: number } | null
  nextIndex: number
  stopReason: StopReason | null
  usage: MessageUsage | null
  id: string
  model: string
}

/** 翻译器需要的入参：任意 SSE 事件序列（同步数组或异步生成器都行） */
type SseSource = AsyncIterable<Pick<ServerSentEvent, 'data'>> | Iterable<Pick<ServerSentEvent, 'data'>>

const asAsyncIterable = <T>(source: AsyncIterable<T> | Iterable<T>): AsyncIterable<T> =>
  Symbol.asyncIterator in source
    ? (source as AsyncIterable<T>)
    : (async function* () {
        yield* source as Iterable<T>
      })()

function* startMessage(state: TranslatorState): Generator<MessageStreamEvent> {
  state.started = true
  yield {
    type: 'message_start',
    message: { id: state.id, model: state.model, usage: ZERO_USAGE },
  }
}

function* closeBlock(state: TranslatorState): Generator<MessageStreamEvent> {
  if (!state.block) {
    return
  }
  const { index } = state.block
  state.block = null
  yield { type: 'content_block_stop', index }
}

/** 打开（或切换到）指定类型的块；切块时先关掉上一个，保证事件序列合法 */
function* ensureBlock(state: TranslatorState, kind: BlockKind): Generator<MessageStreamEvent> {
  if (!state.started) {
    yield* startMessage(state)
  }
  if (state.block?.kind === kind) {
    return
  }
  yield* closeBlock(state)
  const index = state.nextIndex
  state.nextIndex += 1
  state.block = { kind, index }
  yield {
    type: 'content_block_start',
    index,
    content_block:
      kind === 'text'
        ? { type: 'text', text: '' }
        : // 签名由上游签名机制提供，OpenAI 兼容协议没有，留空串
          { type: 'thinking', thinking: '', signature: '' },
  }
}

function* appendDelta(
  state: TranslatorState,
  kind: BlockKind,
  text: string
): Generator<MessageStreamEvent> {
  yield* ensureBlock(state, kind)
  const index = (state.block as { kind: BlockKind; index: number }).index
  yield {
    type: 'content_block_delta',
    index,
    delta:
      kind === 'text'
        ? { type: 'text_delta', text }
        : { type: 'thinking_delta', thinking: text },
  }
}

/**
 * 把 OpenAI SSE 事件序列翻译成 Anthropic 风格事件序列。
 * 无论上游怎么脏，结束时一定补齐 content_block_stop / message_delta / message_stop，
 * 所以上层不会因为缺 [DONE] 而卡在 streaming 状态。
 */
export async function* translateOpenAIStream(
  events: SseSource,
  fallback: { id?: string; model?: string } = {}
): AsyncGenerator<MessageStreamEvent> {
  const state: TranslatorState = {
    started: false,
    block: null,
    nextIndex: 0,
    stopReason: null,
    usage: null,
    id: fallback.id ?? '',
    model: fallback.model ?? '',
  }

  for await (const event of asAsyncIterable(events)) {
    const data = typeof event?.data === 'string' ? event.data.trim() : ''
    // 空 data 与注释行（`: ping`）由 SSE 解析层丢弃，这里再兜一层
    if (!data) {
      continue
    }
    if (data === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      // 非 JSON 的 data 行（心跳、日志回显）：跳过，不影响后续内容
      continue
    }
    if (!isRecord(payload)) {
      continue
    }
    if (isString(payload.error) || isRecord(payload.error)) {
      const detail = isRecord(payload.error) ? payload.error : {}
      throw new OpenAIStreamError(
        isString(detail.message) ? detail.message : JSON.stringify(payload.error)
      )
    }
    // 首个能解析的 chunk 就开消息，即使它只带 role，正文稍后才到
    if (!state.started) {
      if (isString(payload.id)) {
        state.id = payload.id
      }
      if (isString(payload.model)) {
        state.model = payload.model
      }
      yield* startMessage(state)
    }
    const usage = readUsage(payload.usage)
    if (usage) {
      state.usage = usage
    }
    const choices = Array.isArray(payload.choices) ? payload.choices.filter(isRecord) : []
    // 空 choices 常见于只带 usage 的收尾 chunk，不能当成错误。
    // 同一 chunk 带多条 choices 时只认 index 为 0 的那条（n=1 请求的正常形态）；
    // 上游偶尔不写 index，此时只有单条才当作第一条。
    const choice =
      choices.find((item) => item.index === 0) ??
      (choices.length === 1 ? choices[0] : null)
    if (!choice) {
      continue
    }
    const delta = isRecord(choice.delta) ? choice.delta : null
    if (delta) {
      // 部分兼容实现即使不开思考也会下发 reasoning_content，单独开一个 thinking 块
      const reasoning = [delta.reasoning_content, delta.reasoning].find(isString)
      if (reasoning) {
        yield* appendDelta(state, 'thinking', reasoning)
      }
      const content = Array.isArray(delta.content)
        ? // 少数实现把 content 拆成 [{type:'text',text}] 数组
          delta.content
            .flatMap((part) => (isRecord(part) && isString(part.text) ? [part.text] : []))
            .join('')
        : delta.content
      if (isString(content) && content !== '') {
        yield* appendDelta(state, 'text', content)
      }
    }
    const finish = choice.finish_reason
    if (isString(finish) && finish !== '') {
      // finish_reason 到了就先关正文块；message_delta 留到收尾，
      // 让紧随其后的 usage-only chunk 也能并进同一条 message_delta。
      state.stopReason = mapFinishReason(finish)
      yield* closeBlock(state)
    }
  }

  // 收尾：保证事件序列完整（断流、空流、没有 [DONE] 都在这里补齐）
  if (!state.started) {
    yield* startMessage(state)
  }
  yield* closeBlock(state)
  yield {
    type: 'message_delta',
    delta: { stop_reason: state.stopReason ?? 'end_turn', stop_sequence: null },
    ...(state.usage ? { usage: state.usage } : {}),
  }
  yield { type: 'message_stop' }
}

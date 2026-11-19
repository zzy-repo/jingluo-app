/**
 * 会话自动标题（Anthropic / OpenAI 兼容模式）。
 *
 * DeepSeek 官方模式由服务端生成标题（请求带 title:{enabled:true}，响应 message_delta.delta.title 返回），
 * 那条路径与这里无关，也不受这里影响。Anthropic / OpenAI 兼容协议没有这个字段，会话恒显示「新对话」，
 * 所以在首轮回答正常结束后，本地补一次标题请求：
 *
 * 1. 只喂第一条人类消息，并包成 JSON 数组（模型看到的是数据而不是新指令，防注入）
 * 2. **流式**、max_tokens 很小、不开 thinking（省 token）。标题只取第一个非空行，
 *    所以读到「第一行已完整」或长度到上限就立刻断开连接（#93），不等整段生成完：
 *    上游少生成一截 token，也少占一会儿并发槽位
 * 3. 硬限制：maxInputBytes / maxOutputTokens / timeoutMs
 * 4. 输出清洗：只取第一个非空行、剥掉整行的强调外壳、去掉引号与控制字符
 * 5. 任何失败（超时 / 网络 / 非 2xx / 空 / finish 原因异常 / 清洗后为空）都回退到本地截取，
 *    回退后仍算成功——会话有可辨识的标题就够了，不给用户报错。
 * 6. 背压（issue #112）：这批非流式请求走 autoTitleQueue.ts 的并发上限（默认 2）+ 有界队列
 *    （默认 6），队列溢出明确跳过并计数；被限流（429 / 限流语义）单独记账，不混进普通失败。
 *    跳过或失败都只是不发请求，标题照旧回退本地截取，用户无感。
 *
 * 走哪个接口：完全复用当前生效的服务类型（providers.ts / apiConfig.ts）——
 * anthropic 模式 {base}/v1/messages，openai 模式 {base}/v1/chat/completions，
 * 鉴权头由 client.authHeaders 按 spec.auth 决定，与聊天请求一致。
 */
import {
  getApiKey,
  getBaseUrl,
  getCurrentSpec,
  getMessagesUrl,
  getModel,
} from '../api/apiConfig.js'
import { authHeaders, request } from '../api/client.js'
import { readServerSentEvents } from '../api/sse.js'
import { translate } from '../../i18n/index.js'
import { autoTitleLimiter, isAutoTitleThrottled } from './autoTitleQueue.js'
import { LIMITS } from '../limits.js'
import { createTitleStreamReader, type TitleStreamProtocol } from './autoTitleStream.js'

/**
 * 生成标题的 system prompt（标题语言跟随消息语言）。
 * 与 DSH 的 dsh-session-title-first-prompt-llm 同义：只输出标题本身，信息量太少也要给最佳猜测。
 * 文案走 i18n（zh 为原硬编码文案逐字原文，en 由 i18n 提供）——issue #18。
 */
export const autoTitleSystemPrompt = (): string =>
  [
    translate('autoTitlePromptIntro'),
    translate('autoTitlePromptFormat'),
    translate('autoTitlePromptLanguage'),
    translate('autoTitlePromptLength'),
    translate('autoTitlePromptFallback'),
  ].join('\n')

/** 超时上限：到点就放弃，用本地截取兜底 */
export const AUTO_TITLE_TIMEOUT_MS = LIMITS.autoTitle.timeoutMs
/** 输出上限：标题用不到更多 token */
export const AUTO_TITLE_MAX_OUTPUT_TOKENS = LIMITS.autoTitle.maxOutputTokens
/** 输入上限：只喂第一条消息，超出按字节截断（硬上限，防止恶意长文烧钱） */
export const AUTO_TITLE_MAX_INPUT_BYTES = LIMITS.autoTitle.maxInputBytes
/** 清洗后的标题最长保留多少字符（超出说明模型没按要求输出，直接截断） */
export const AUTO_TITLE_MAX_CHARS = 48
/** 本地截取：取首条消息的前多少个字符 */
export const AUTO_TITLE_FALLBACK_CHARS = 20
/** 本地截取回退到句读处时，至少保留多少个字符（太短就不回退了） */
const AUTO_TITLE_ROLLBACK_MIN = 6

/** 开头常见的语气前缀（可叠用：「你好，请问…」「麻烦帮我…」） */
const PLEASANTRY =
  /^(你好|您好|哈喽|嗨|hi|hello|hey|请问|请教一下|想请教|我想问一下|我想问|想问一下|想问|帮我|帮忙|麻烦|请帮|请|劳驾)[\s,，。.！!？?、；;：:~～]*/i

/** 句读：本地截取时优先在这里断开 */
const SENTENCE_MARKS = ['，', '。', '？', '！', '；', '、', '：', ',', '.', '?', '!', ';', ':']

const TRAILING_PUNCT = /[\s，。、；：,.;:！!？?~～\-—…]+$/

/** 按 UTF-8 字节数截断，避免把多字节字符切成半个 */
const clampBytes = (text: string, maxBytes: number): string => {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) {
    return text
  }
  let end = text.length
  while (end > 0 && encoder.encode(text.slice(0, end)).length > maxBytes) {
    end -= 1
  }
  return text.slice(0, end)
}

/**
 * 本地截取兜底：取第一条用户消息，去掉开头语气前缀，取前 20 个字符、去掉换行，
 * 被截断时回退到最近的句读处并补省略号。
 */
export const fallbackTitle = (text: string): string => {
  let body = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  // 语气前缀可能叠用，循环剥离到稳定为止
  for (;;) {
    const next = body.replace(PLEASANTRY, '').trim()
    if (next === body || !next) {
      break
    }
    body = next
  }
  if (!body) {
    return ''
  }
  const flat = body.replace(/\s+/g, ' ').trim()
  if (flat.length <= AUTO_TITLE_FALLBACK_CHARS) {
    return flat.replace(TRAILING_PUNCT, '') || flat
  }
  let head = flat.slice(0, AUTO_TITLE_FALLBACK_CHARS)
  // 被截断：退回最近的句读处，避免标题停在半个词上
  const cut = SENTENCE_MARKS.reduce((best, mark) => Math.max(best, head.lastIndexOf(mark)), -1)
  if (cut >= AUTO_TITLE_ROLLBACK_MIN) {
    head = head.slice(0, cut)
  }
  head = head.replace(TRAILING_PUNCT, '').trim() || head.trim()
  return `${head}…`
}

/**
 * 输出清洗：第一个非空行 → 剥掉整行的 * / ** / *** 强调外壳（保留行内强调）→
 * 去掉引号、控制字符与「标题：」这类前缀。清洗后为空返回 null（调用方据此回退）。
 */
export const sanitizeTitle = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || !raw) {
    return null
  }
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) {
    return null
  }
  let title = line
  // 整行被强调标记包裹时才剥壳；「**a** 和 b」这种行内强调保持原样
  const wrapped = /^(\*{1,3})([\s\S]+)\1$/.exec(title)
  if (wrapped) {
    title = wrapped[2].trim()
  }
  // 控制字符（C0 / DEL / 零宽 / 行分隔符）一律去掉
  title = [...title]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0
      return (
        code > 0x1f &&
        code !== 0x7f &&
        (code < 0x200b || code > 0x200f) &&
        code !== 0x2028 &&
        code !== 0x2029
      )
    })
    .join('')
  // 「标题：xxx」这类前缀
  title = title.replace(/^(标题|title)\s*[:：]\s*/i, '')
  // 成对引号 / 书名号外壳
  const quoted = /^(["'`“”‘’「」『』《》])([\s\S]+)(["'`“”‘’「」『』《》])$/.exec(title.trim())
  if (quoted) {
    title = quoted[2]
  }
  title = title
    .trim()
    .replace(/^[#>*\-\s]+/, '')
    .trim()
  if (!title) {
    return null
  }
  return title.slice(0, AUTO_TITLE_MAX_CHARS).trim() || null
}

/** 只喂第一条消息，包成 JSON 数组：模型看到的是数据，不是新指令 */
const encodeUserText = (text: string): string =>
  JSON.stringify([clampBytes(text.trim(), AUTO_TITLE_MAX_INPUT_BYTES)])

type TitleReply = { text: string | null }

/** Anthropic 协议响应：tool_use / max_tokens 视为失败，不拿半截内容当标题 */
const readAnthropicReply = (payload: unknown): TitleReply => {
  const body = payload as {
    content?: { type?: string; text?: string }[]
    stop_reason?: string | null
  } | null
  const blocks = Array.isArray(body?.content) ? body.content : []
  if (blocks.some((block) => block?.type === 'tool_use')) {
    return { text: null }
  }
  const stop = body?.stop_reason
  if (stop && stop !== 'end_turn' && stop !== 'stop_sequence') {
    return { text: null }
  }
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  return { text }
}

/** OpenAI 协议响应：finish_reason 不是 stop、或返回 tool_calls 一律视为失败 */
const readOpenAIReply = (payload: unknown): TitleReply => {
  const body = payload as {
    choices?: {
      finish_reason?: string | null
      message?: { content?: unknown; tool_calls?: unknown[] }
    }[]
  } | null
  const choice = body?.choices?.[0]
  if (!choice) {
    return { text: null }
  }
  if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) {
    return { text: null }
  }
  const finish = choice.finish_reason
  if (finish && finish !== 'stop') {
    return { text: null }
  }
  const content = choice.message?.content
  if (typeof content === 'string') {
    return { text: content }
  }
  if (Array.isArray(content)) {
    return {
      text: content
        .map((part) => {
          const item = part as { type?: string; text?: string }
          return item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
        })
        .join(''),
    }
  }
  return { text: null }
}

/** 标题请求体：流式（拿到标题行即断开）、max_tokens 很小、不开 thinking */
const toTitleRequest = (text: string): unknown => {
  const spec = getCurrentSpec()
  const user = encodeUserText(text)
  if (spec.protocol === 'openai') {
    return {
      model: getModel(),
      max_tokens: AUTO_TITLE_MAX_OUTPUT_TOKENS,
      stream: true,
      messages: [
        { role: 'system', content: autoTitleSystemPrompt() },
        { role: 'user', content: user },
      ],
    }
  }
  return {
    model: getModel(),
    max_tokens: AUTO_TITLE_MAX_OUTPUT_TOKENS,
    stream: true,
    system: autoTitleSystemPrompt(),
    messages: [{ role: 'user', content: user }],
  }
}

/** 一次请求的结局：限流单独一支，避免「被限流」在统计里冒充普通失败 */
type TitleAttempt =
  | { kind: 'ok'; text: string }
  | { kind: 'empty' }
  | { kind: 'throttled' }
  | { kind: 'failed' }

/**
 * 读一次标题响应：流式增量拼标题，够用就断开（`reader.cancel()` 会真的掐掉上游生成，
 * 而不是把它读完再丢掉）。网关忽略 `stream: true` 直接回 JSON 时退回整段解析，
 * 行为与改流式之前完全一致。
 */
const readTitleReply = async (
  response: Response,
  protocol: TitleStreamProtocol,
  signal: AbortSignal
): Promise<TitleReply> => {
  const contentType = (response.headers.get('Content-Type') ?? '').toLowerCase()
  if (!response.body || !contentType.includes('text/event-stream')) {
    const payload: unknown = await response.json()
    return protocol === 'openai' ? readOpenAIReply(payload) : readAnthropicReply(payload)
  }
  const reader = createTitleStreamReader(protocol, { maxChars: AUTO_TITLE_MAX_CHARS })
  for await (const event of readServerSentEvents(response.body, signal)) {
    reader.push(event)
    const failure = reader.failure()
    if (failure) {
      throw failure
    }
    if (reader.enough()) {
      // 标题够用了：立刻退出循环，生成器在 finally 里取消正文读取（提前中止上游生成）
      break
    }
  }
  // 超时 / 调用方取消：宁可回退本地截取，也不把读了一半的内容当标题
  if (signal.aborted) {
    throw new Error('auto title stream aborted')
  }
  return reader.accepted() ? { text: reader.text() } : { text: null }
}

/**
 * 真正发一次标题请求（不含背压）。任何异常（超时、网络、非 2xx、非 JSON、finish 原因异常）
 * 都收成结局返回，这里不抛错、不打日志、不影响对话流。
 */
const attemptTitle = async (text: string, signal?: AbortSignal): Promise<TitleAttempt> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), AUTO_TITLE_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const spec = getCurrentSpec()
    const response = await request(getMessagesUrl(), {
      method: 'POST',
      headers: { ...authHeaders(getApiKey()), 'Content-Type': 'application/json' },
      body: JSON.stringify(toTitleRequest(text)),
      signal: controller.signal,
    })
    const reply = await readTitleReply(response, spec.protocol, controller.signal)
    return reply.text ? { kind: 'ok', text: reply.text } : { kind: 'empty' }
  } catch (error) {
    // 被限流（429 / 上游限流语义）要与普通失败分开记账：限流是可自愈的，不该混进失败率
    return isAutoTitleThrottled(error) ? { kind: 'throttled' } : { kind: 'failed' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 发起一次标题请求（带背压，见 autoTitleQueue.ts）：并发上限 + 有界队列，
 * 队列溢出或排队期间被取消就明确跳过（不发请求），任何失败都返回 null 交给本地截取兜底。
 */
const requestTitle = async (text: string, signal?: AbortSignal): Promise<string | null> => {
  if (!text.trim()) {
    return null
  }
  if (!getBaseUrl()) {
    return null
  }
  const outcome = await autoTitleLimiter.run(() => attemptTitle(text, signal), signal)
  if (outcome.status === 'skipped') {
    // dropped / aborted：这次就是不发（背压的目的），标题交给本地截取
    return null
  }
  if (outcome.status === 'error') {
    autoTitleLimiter.note('failed')
    return null
  }
  autoTitleLimiter.note(outcome.value.kind)
  return outcome.value.kind === 'ok' ? outcome.value.text : null
}

/**
 * 生成会话标题：优先用模型返回的清洗结果，任何失败都回退到本地截取。
 * 返回空串表示首条消息本身没有可用的文本（例如只发了附件），调用方保持「新对话」。
 */
export const generateSessionTitle = async (text: string, signal?: AbortSignal): Promise<string> => {
  const raw = await requestTitle(text, signal)
  const cleaned = sanitizeTitle(raw)
  if (cleaned) {
    return cleaned
  }
  return fallbackTitle(text)
}

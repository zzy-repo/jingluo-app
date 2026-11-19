import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import {
  getBaseUrl,
  getCurrentSpec,
  getFilesUrl,
  getMessagesUrl,
  joinUrl,
  normalizeBaseUrl,
} from './apiConfig.js'
import { markKeyRejected } from './keyRejection.js'
import { OpenAIStreamError, toOpenAIRequest, translateOpenAIStream } from './openaiAdapter.js'
import type { ProviderSpec } from './providers.js'
import { parseModelPayload } from './modelPayload.js'
export { parseModelPayload, pickModelIds } from './modelPayload.js'
import { readMessageEvent } from './parseEvent.js'
import { StreamIdleTimeoutError, readServerSentEvents } from './sse.js'
import { LIMITS } from '../limits.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/**
 * 地址不再写死：每次请求都从当前生效的模型服务配置（providers.ts）取 baseUrl + apiPath，
 * 构建期的 __API_ORIGIN__ 只作为新建配置的预填值。
 */
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

/**
 * 上游把网页当接口数据返回（路径不匹配、网关报错页等）
 * 流在 message_start 之后、message_stop 之前结束（连接被掐断、代理超时、读到一半报错）
 * 请求在超时预算内没拿到响应头
 */
export type ApiErrorCode =
  | 'upstream_returned_html'
  | 'stream_interrupted'
  | 'request_timed_out'
  | 'stream_idle'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'
  /** 预算内没拿到响应头：上游把连接晾着（与没到达服务端、4xx/5xx 都不同） */
  | 'timeout'
  /**
   * 响应头已经到手、正文也开始了，但连续一段时间没有新数据（#150）。
   * 与 timeout 的区别是失败发生的位置，与 interrupted 的区别是连接没断、只是不动。
   */
  | 'idle'

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number
  /** 机器可读的错误码，给需要精确分支的调用方用 */
  readonly code?: ApiErrorCode
  readonly localMessage?: TranslationMessage
  /** 原始报错原文：只进日志与元信息，不上界面 */
  readonly detail?: string
  /**
   * 上游响应体里自带的机器可读错误码（`error.code` / `error.type` / 顶层 `code`）。
   * 与 `code` 分工不同：`code` 是本客户端自己定义的错误码，这里是**上游原话**，
   * 用来认「额度用完」这一类各家写法不统一的情况（#299）。
   */
  readonly upstreamCode?: string

  constructor(
    kind: ApiErrorKind,
    message: string | TranslationMessage,
    status?: number,
    code?: ApiErrorCode,
    detail?: string,
    upstreamCode?: string
  ) {
    // 字段逐个赋值（不用 TS 参数属性）：单测直接在 Node 里 import 这个模块跑真代码。
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
    this.detail = detail
    this.upstreamCode = upstreamCode
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

/**
 * 断流：流在 message_start 之后、message_stop 之前结束，或被读到一半掐断。
 * 与「请求没发出去」的网络错误分开：界面要明说连接中断，而不是「网络异常」。
 * 原因不猜测，原始报错只放 detail 给日志。
 */
const streamInterrupted = (detail?: string): ApiError =>
  new ApiError(
    'interrupted',
    { key: 'replyStreamInterrupted' },
    undefined,
    'stream_interrupted',
    detail
  )

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

/** 从 `{ code, type }` 这类对象里取第一个非空字符串（上游 code 的两种放法） */
const readCodeField = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const entry = value as { code?: unknown; type?: unknown }
  for (const candidate of [entry.code, entry.type]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim()
    }
  }
  return undefined
}

/**
 * 上游错误体里的机器可读错误码：优先 `error.code` / `error.type`（OpenAI 与多数网关），
 * 再看顶层 `code`（部分网关的写法）。不看顶层 `type`——Anthropic 的 `type` 恒为 "error"，
 * 取它只会得到一个没信息量的字符串。
 */
const readUpstreamCode = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const fromError = readCodeField((body as { error?: unknown }).error)
  if (fromError) {
    return fromError
  }
  const top = (body as { code?: unknown }).code
  return typeof top === 'string' && top.trim() !== '' ? top.trim() : undefined
}

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let upstreamCode: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
    upstreamCode = readUpstreamCode(body)
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, undefined, undefined, upstreamCode)
}

/**
 * 上游返回了网页（text/html）：路径不匹配时网关常常 200 + 首页 HTML，
 * 这种响应绝不能当成回答渲染，统一转成明确错误。检查在状态码判断之前，
 * 避免 HTML 报错页的正文被当成错误信息展示。
 */
const isHtmlResponse = (response: Response): boolean =>
  (response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html')

/**
 * 请求默认超时：与 probeProvider 的连通性探测同一口径（15 秒）。
 * 只约束「拿到响应头」这一段——流式回答可能合法地持续很久，不在这里掐；
 * 正文读到一半断掉仍由 stream_interrupted 那条路负责（#41）。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = LIMITS.requestTimeoutMs

let requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS

/** 全局超时（毫秒）：合法正数生效，0 / NaN / 非数字一律回到默认，不做成「永不超时」 */
export const setRequestTimeout = (ms: number): void => {
  requestTimeoutMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : DEFAULT_REQUEST_TIMEOUT_MS
}

export const getRequestTimeout = (): number => requestTimeoutMs

/**
 * 流式正文的空闲超时（#150）：响应头到手之后，到「读到下一段数据」之间最多允许多久没动静。
 *
 * 为什么是 45 秒：
 * - 15 秒（DEFAULT_REQUEST_TIMEOUT_MS）是建连预算，直接套到正文上太紧：弱网下长回答
 *   几十秒才吐下一个分片是常事（#133 的 S3 就是每 3 秒来 1 个字节），照这个数会误杀正常回答；
 * - 仓库里已有「连续 40 秒没有新字节就判死」的口径（history/urlImport.ts 的
 *   DOWNLOAD_STALL_MS），同为弱网下载场景，取同一个量级，不另立一套判据；
 * - 界面 60 秒会提示「等待时间过长，可以停止后重新生成」（streamNotice 的 stalled 档），
 *   超时要在那之前落地，否则用户只看到一句「要不要停」却永远等不到结论；
 * - 这是「空闲」口径不是总时长：每读到一段新数据就重新计时，长回答持续出字永远不会被杀。
 */
export const STREAM_IDLE_TIMEOUT_MS = LIMITS.streamIdleTimeoutMs

let streamIdleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS

/** 空闲超时（毫秒）：合法正数生效，0 / NaN / 非数字一律回到默认，不做成「永不超时」 */
export const setStreamIdleTimeout = (ms: number): void => {
  streamIdleTimeoutMs = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : STREAM_IDLE_TIMEOUT_MS
}

export const getStreamIdleTimeout = (): number => streamIdleTimeoutMs

/**
 * 空闲超时错误：独立的 kind + code，上层可以（也应该）与「请求超时」「断流」分开处理。
 * 文案复用 replyWaitingStalled（「等待时间过长，可以停止后重新生成」）——语义是
 * 「等了太久、还能重来」，不是 requestTimeout 的「没有响应」；新增 i18n key 会和并行
 * 分支抢同一批文件，这一单先复用，等文案统一时再换专用 key（见 PR 说明）。
 */
const streamIdleTimedOut = (idleMs: number, detail?: string): ApiError =>
  new ApiError(
    'idle',
    { key: 'replyWaitingStalled' },
    undefined,
    'stream_idle',
    detail ?? `no data for ${idleMs}ms`
  )

/** 超时与「没到达服务端」「4xx/5xx」分开：它有自己的 kind / code / 文案 */
const requestTimedOut = (timeoutMs: number, detail?: string): ApiError =>
  new ApiError(
    'timeout',
    { key: 'requestTimeout', params: { seconds: Math.max(1, Math.round(timeoutMs / 1000)) } },
    undefined,
    'request_timed_out',
    detail
  )

export type RequestOptions = {
  /** 覆盖本次请求的预算（毫秒）；不传用 getRequestTimeout()。0 / 负数按默认值处理 */
  timeoutMs?: number
}

/**
 * 所有接口请求的唯一出口：统一带超时。
 * 超时用内部 controller 中断 fetch，与调用方自己的取消分开——
 * 调用方取消仍抛原始 abort（不是接口错误），超时抛 kind='timeout' 的 ApiError。
 */
export const request = async (
  url: string,
  init: RequestInit,
  options: RequestOptions = {}
): Promise<Response> => {
  const timeoutMs =
    options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : requestTimeoutMs
  const callerSignal = init.signal ?? null
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort()
    } else {
      callerSignal.addEventListener('abort', abortFromCaller, { once: true })
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (timedOut) {
      throw requestTimedOut(timeoutMs, error instanceof Error ? error.message : String(error))
    }
    if (callerSignal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  } finally {
    // 响应头已到：立刻撤掉预算，长回答的正文读取不受影响。
    // 调用方自己的 abort 监听要留着——它得继续管正文读取（用户点停止要能真的断开），
    // 所以这里只清计时器。
    clearTimeout(timer)
  }
  if (isHtmlResponse(response)) {
    throw new ApiError(
      'protocol',
      { key: 'upstreamReturnedHtml' },
      response.status,
      'upstream_returned_html'
    )
  }
  if (!response.ok) {
    // 401 = 上游明确说这把 Key 不行（#303 问题 3）：所有请求都走这里，所以在这里统一记一次，
    // 模型列表的自动探测随即停止，界面换成可读文案。其它状态码不改变「Key 是否有效」的判断。
    if (response.status === 401) {
      markKeyRejected('request')
    }
    throw await readErrorResponse(response)
  }
  return response
}

/** 没配服务地址时（Anthropic 协议必须自己填）先拦下，避免打到应用自身的相对路径 */
const ensureBaseUrl = (): void => {
  if (!getBaseUrl()) {
    throw new ApiError('network', { key: 'settingsBaseUrlRequired' })
  }
}

/**
 * 鉴权头完全按当前服务类型的 spec.auth 决定：
 * - 'x-api-key' → x-api-key + anthropic-version（Anthropic 风格，DeepSeek 官方同样接受）
 * - 'bearer'    → Authorization: Bearer（OpenAI 兼容服务类型）
 * beta 为 true 时附带 Files API 的 anthropic-beta。
 */
const sameHost = (url: string, other: string): boolean => {
  try {
    return new URL(url).host === new URL(other).host
  } catch {
    return false
  }
}

/**
 * anthropic-version 只在打「官方端点」时带：协议要求它，官方 CORS 白名单也放行；
 * 用户自填的中转大多只放行 x-api-key，带上会让浏览器预检失败（60010 实测）。
 */
const needsAnthropicVersion = (spec: ProviderSpec, baseUrl: string): boolean =>
  Boolean(
    spec.anthropicVersion && spec.defaults?.baseUrl && sameHost(baseUrl, spec.defaults.baseUrl)
  )

/**
 * 鉴权头完全按服务类型的 spec.auth 决定：
 * - 'x-api-key' → x-api-key（官方端点另带 anthropic-version，Anthropic 风格）
 * - 'bearer'    → Authorization: Bearer（OpenAI 兼容服务类型）
 * beta 为 true 时附带 Files API 的 anthropic-beta。
 *
 * `spec` 由调用方传入时就用它：探测/刷新这类「一次请求要同时决定路径和鉴权头」的场景，
 * 必须让两者来自**同一份 spec**，否则会拼出「A 渠道的路径 + B 渠道的鉴权头」这种请求。
 */
export const authHeaders = (
  apiKey: string,
  options: { beta?: boolean; baseUrl?: string; spec?: ProviderSpec } = {}
): Record<string, string> => {
  const spec = options.spec ?? getCurrentSpec()
  const baseUrl = options.baseUrl ?? getBaseUrl()
  const headers: Record<string, string> =
    spec.auth === 'bearer'
      ? { Authorization: `Bearer ${apiKey}` }
      : {
          'x-api-key': apiKey,
          ...(needsAnthropicVersion(spec, baseUrl)
            ? { 'anthropic-version': spec.anthropicVersion as string }
            : {}),
        }
  if (options.beta) {
    // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
    headers['anthropic-beta'] = FILES_BETA
  }
  return headers
}

/** 用 GET {paths.models} 校验 API Key（不产生费用）；地址与鉴权头都取当前 spec，且同源解析一次 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  ensureBaseUrl()
  const spec = getCurrentSpec()
  const baseUrl = getBaseUrl()
  await request(joinUrl(baseUrl, spec.paths.models), {
    method: 'GET',
    headers: authHeaders(apiKey, { baseUrl, spec }),
    signal,
  })
}

/**
 * 当前渠道没有 Files API 时的本地失败（**不发任何请求**）：入口应当已经禁用，
 * 走到这里说明有别的调用路径绕过了入口——照样按不可上传处理，绝不猜一个端点去试。
 */
const uploadUnsupported = (): ApiError => new ApiError('protocol', { key: 'uploadChannelUnsupported' })

/** 当前渠道是否支持附件上传（`paths.files` 声明了才算） */
export const supportsFileUpload = (): boolean => Boolean(getCurrentSpec().paths.files)

/** 附件上传地址；没有能力时为 null（调用方必须先判，本模块不再猜路径） */
export const getUploadUrl = (): string | null => getFilesUrl()

/**
 * POST {paths.files} 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 *
 * 端点来自 spec 的显式声明（官方渠道 = `/anthropic/v1/files`），**不再是 `{messages}/files`**：
 * 那个拼接在 OpenAI 协议渠道下会变成 `/v1/chat/completions/files`（网关无此路由，404，#303）。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  ensureBaseUrl()
  const url = getFilesUrl()
  if (!url) {
    throw uploadUnsupported()
  }
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(url, {
    method: 'POST',
    headers: authHeaders(apiKey, { beta: true }),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE {paths.files}/{file_id}（无上传能力的渠道直接按不可上传失败，不发请求） */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  ensureBaseUrl()
  const url = getFilesUrl()
  if (!url) {
    throw uploadUnsupported()
  }
  await request(`${url}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey, { beta: true }),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * 流式请求的耗时探针（Issue #306）：只报「什么时候到的」，不碰数据本身。
 *
 * 放在这一层而不是 store 里，是因为「响应头到手」这个时刻只有这里知道 ——
 * 调用方拿到的第一个事件已经是首字了，把两者混成一个时间点就永远分不出
 * 「上游排队慢」和「弱网吐字慢」（#101 的三条候选慢因）。
 */
export type StreamTimingHook = {
  /** 响应头到手（拿到 body 之前）：TTFB 到此为止 */
  onHeaders?: () => void
  /** 每收到一个流式事件（尚未 yield 给调用方） */
  onEvent?: () => void
}

/**
 * OpenAI 兼容上游（spec.protocol = 'openai'）：POST {paths.messages}（通常 /v1/chat/completions）。
 * 请求体与响应流都经 openaiAdapter 双向翻译，向上层产出的仍是 Anthropic 风格事件，
 * 因此 UI 与 store 不需要任何分支。断流/脏数据由翻译器收尾，这里只把错误帧转成 ApiError。
 */
async function* streamOpenAIMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  timing?: StreamTimingHook
): AsyncGenerator<MessageStreamEvent> {
  ensureBaseUrl()
  // spec 与地址/鉴权头来自同一份当前 spec：思考参数按它翻译（#297）
  const spec = getCurrentSpec()
  const response = await request(getMessagesUrl(), {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey, { spec }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(toOpenAIRequest(body, spec)),
    signal,
  })
  timing?.onHeaders?.()
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  try {
    for await (const event of translateOpenAIStream(
      readServerSentEvents(response.body, signal, getStreamIdleTimeout()),
      {
        model: body.model,
      }
    )) {
      timing?.onEvent?.()
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
  } catch (error) {
    // 正文阶段长时间没有新数据（#150）：先认它，别并进「断流」
    if (error instanceof StreamIdleTimeoutError) {
      throw streamIdleTimedOut(error.idleMs, error.message)
    }
    if (error instanceof OpenAIStreamError) {
      throw new ApiError('stream', error.message)
    }
    if (error instanceof ApiError || signal.aborted) {
      throw error
    }
    // 与 Anthropic 路径一致：读到一半断掉也是断流，原文只进日志。
    throw streamInterrupted(error instanceof Error ? error.message : String(error))
  }
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 * OpenAI 兼容协议走 streamOpenAIMessage，其余协议这一段的代码与 1.2.3 完全一致。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  timing?: StreamTimingHook
): AsyncGenerator<MessageStreamEvent> {
  ensureBaseUrl()
  if (getCurrentSpec().protocol === 'openai') {
    yield* streamOpenAIMessage(apiKey, body, signal, timing)
    return
  }
  const response = await request(getMessagesUrl(), {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey, { beta: hasFile(body) }),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  // 响应头到手：TTFB 到此为止（此后每一次读数据的间隔才是「吐字」）
  timing?.onHeaders?.()
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  try {
    for await (const { event: eventName, data } of readServerSentEvents(
      response.body,
      signal,
      getStreamIdleTimeout()
    )) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        // 有的网关把额度不足写在流内的 error 帧里：上游 code 一并带上，界面才能给出充值出路（#299）
        throw new ApiError(
          'stream',
          payload.error.message,
          undefined,
          undefined,
          undefined,
          readUpstreamCode(payload)
        )
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      timing?.onEvent?.()
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
  } catch (error) {
    // 正文阶段长时间没有新数据（#150）：单独一类错误，保留已收内容并允许重试；
    // 不能落到下面的 streamInterrupted，那会把「不动」说成「断了」。
    if (error instanceof StreamIdleTimeoutError) {
      throw streamIdleTimedOut(error.idleMs, error.message)
    }
    // 上面的错误帧与中止请求已经有明确分类，原样上抛
    if (error instanceof ApiError || signal.aborted) {
      throw error
    }
    // 响应体读到一半报错（连接被掐断、代理超时）：和「缺 message_stop」一样是断流，
    // 原文只进 detail 给日志，界面用固定文案。
    throw streamInterrupted(error instanceof Error ? error.message : String(error))
  }
  // 流在 message_stop 之前结束了。用户主动停止不算断流，先看 signal。
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  }
  // 不推测原因，只明确告诉用户是断流。
  throw streamInterrupted()
}

/** 连通性测试结果；失败时 reason 区分非法地址、超时、网络（含跨域）、HTTP 错误、非 JSON */
export type ProviderProbeResult = {
  ok: boolean
  /** HTTP 状态码，未收到响应时缺省 */
  status?: number
  /** 解析出的模型 id；空数组表示接口通但没给列表 */
  models: string[]
  reason?: 'invalid' | 'timeout' | 'network' | 'http' | 'json' | 'html'
  /** 原始错误信息（HTTP 与 JSON 情形） */
  message?: string
}

/**
 * 连通性测试：GET {baseUrl}{paths.models}，鉴权头按当前 spec。
 * 超时、断网/跨域、非 2xx、返回网页、非 JSON 分别给出可读原因，不抛异常。
 */
export const probeProvider = async (
  config: { baseUrl: string; apiKey: string },
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<ProviderProbeResult> => {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) {
    return { ok: false, models: [], reason: 'invalid' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 路径与鉴权头只解析一次 spec：两者必须同源，不能各读一遍当前渠道
  const spec = getCurrentSpec()
  const headers = authHeaders(config.apiKey, { baseUrl, spec })
  try {
    const url = `${baseUrl}${spec.paths.models}`
    let status: number
    let text: string
    let statusText = ''
    let contentType = ''
    if (Capacitor.isNativePlatform()) {
      const response = await Promise.race([
        CapacitorHttp.get({ url, headers }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new DOMException('Timed out', 'AbortError')), timeoutMs)
        ),
      ])
      status = response.status
      text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '')
      statusText = response.status.toString()
      contentType = 'application/json'
    } else {
      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
      status = response.status
      statusText = response.statusText
      contentType = response.headers.get('content-type') ?? ''
      text = await response.text().catch(() => '')
      if (isHtmlResponse(response)) {
        return { ok: false, status, models: [], reason: 'html' }
      }
    }
    const responseLike = {
      status,
      statusText,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
      },
    }
    if (isHtmlResponse(responseLike as Response)) {
      return { ok: false, status, models: [], reason: 'html' }
    }
    if (status < 200 || status >= 300) {
      // 探测走的是这条独立的小路（原生用 CapacitorHttp），401 同样要记一次「Key 判死」：
      // 否则「打开设置页 → 自动探测」会永远打下去（#303 问题 3）
      if (status === 401) {
        markKeyRejected('probe')
      }
      let message = text || statusText
      try {
        const body: unknown = JSON.parse(text)
        if (isErrorBody(body)) {
          message = body.error.message
        }
      } catch {
        // 非 JSON 错误体直接展示原文
      }
      return { ok: false, status, models: [], reason: 'http', message }
    }
    let body: unknown
    try {
      body = text
      if (typeof body === 'string') {
        body = JSON.parse(body)
      }
    } catch {
      return {
        ok: false,
        status,
        models: [],
        reason: 'json',
        message: text.slice(0, 200),
      }
    }
    return { ok: true, status, models: parseModelPayload(body) }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, models: [], reason: 'timeout' }
    }
    return {
      ok: false,
      models: [],
      reason: 'network',
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

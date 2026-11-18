import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import {
  getBaseUrl,
  getCurrentSpec,
  getMessagesBaseUrl,
  getMessagesUrl,
  getModelsUrl,
  normalizeBaseUrl,
} from './apiConfig.js'
import { OpenAIStreamError, toOpenAIRequest, translateOpenAIStream } from './openaiAdapter.js'
import type { ProviderSpec } from './providers.js'
import { parseModelPayload } from './modelPayload.js'
export { parseModelPayload, pickModelIds } from './modelPayload.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
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

/** 上游把网页当接口数据返回（路径不匹配、网关报错页等） */
export type ApiErrorCode = 'upstream_returned_html'

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

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    /** 机器可读的错误码，给需要精确分支的调用方用 */
    readonly code?: ApiErrorCode
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

/**
 * 上游返回了网页（text/html）：路径不匹配时网关常常 200 + 首页 HTML，
 * 这种响应绝不能当成回答渲染，统一转成明确错误。检查在状态码判断之前，
 * 避免 HTML 报错页的正文被当成错误信息展示。
 */
const isHtmlResponse = (response: Response): boolean =>
  (response.headers.get('Content-Type') ?? '').toLowerCase().includes('text/html')

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (isHtmlResponse(response)) {
    throw new ApiError('protocol', { key: 'upstreamReturnedHtml' }, response.status, 'upstream_returned_html')
  }
  if (!response.ok) {
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
  Boolean(spec.anthropicVersion && spec.defaults?.baseUrl && sameHost(baseUrl, spec.defaults.baseUrl))

/**
 * 鉴权头完全按当前服务类型的 spec.auth 决定：
 * - 'x-api-key' → x-api-key（官方端点另带 anthropic-version，Anthropic 风格）
 * - 'bearer'    → Authorization: Bearer（OpenAI 兼容服务类型）
 * beta 为 true 时附带 Files API 的 anthropic-beta。
 */
export const authHeaders = (
  apiKey: string,
  options: { beta?: boolean; baseUrl?: string } = {}
): Record<string, string> => {
  const spec = getCurrentSpec()
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

/** 用 GET {paths.models} 校验 API Key（不产生费用）；地址与鉴权头都取当前 spec */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  ensureBaseUrl()
  await request(getModelsUrl(), {
    method: 'GET',
    headers: authHeaders(apiKey),
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  ensureBaseUrl()
  const response = await request(`${getMessagesBaseUrl()}/files`, {
    method: 'POST',
    headers: authHeaders(apiKey, { beta: true }),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  ensureBaseUrl()
  await request(`${getMessagesBaseUrl()}/files/${encodeURIComponent(fileId)}`, {
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
 * OpenAI 兼容上游（spec.protocol = 'openai'）：POST {paths.messages}（通常 /v1/chat/completions）。
 * 请求体与响应流都经 openaiAdapter 双向翻译，向上层产出的仍是 Anthropic 风格事件，
 * 因此 UI 与 store 不需要任何分支。断流/脏数据由翻译器收尾，这里只把错误帧转成 ApiError。
 */
async function* streamOpenAIMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  ensureBaseUrl()
  const response = await request(getMessagesUrl(), {
    method: 'POST',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(toOpenAIRequest(body)),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  try {
    for await (const event of translateOpenAIStream(
      readServerSentEvents(response.body, signal),
      { model: body.model }
    )) {
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
  } catch (error) {
    if (error instanceof OpenAIStreamError) {
      throw new ApiError('stream', error.message)
    }
    throw error
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
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  ensureBaseUrl()
  if (getCurrentSpec().protocol === 'openai') {
    yield* streamOpenAIMessage(apiKey, body, signal)
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
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
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
  timeoutMs = 15000
): Promise<ProviderProbeResult> => {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!baseUrl) {
    return { ok: false, models: [], reason: 'invalid' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const url = `${baseUrl}${getCurrentSpec().paths.models}`
    let status: number
    let text: string
    let statusText = ''
    let contentType = ''
    if (Capacitor.isNativePlatform()) {
      const response = await Promise.race([
        CapacitorHttp.get({ url, headers: authHeaders(config.apiKey, { baseUrl }) }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new DOMException('Timed out', 'AbortError')), timeoutMs)),
      ])
      status = response.status
      text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '')
      statusText = response.status.toString()
      contentType = 'application/json'
    } else {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(config.apiKey, { baseUrl }),
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
    const responseLike = { status, statusText, headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null } }
    if (isHtmlResponse(responseLike as Response)) {
      return { ok: false, status, models: [], reason: 'html' }
    }
    if (status < 200 || status >= 300) {
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

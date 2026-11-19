/**
 * 向量化（embedding）接口：#397 把窗口记忆原型的独立客户端收进 API 层。
 *
 * 纪律（照抄 #303 / `paths.files` 的口径，不另立一套）：
 * - **地址**来自当前渠道 spec（`paths.embedding`）+ `getBaseUrl()`，由 `joinUrl` 拼接，
 *   不在这里拼字符串，也不接受调用方传 URL；`normalizeBaseUrl` 判非法（`http(s)://` 且能解析）。
 * - **鉴权头**来自 `authHeaders(...)`（按 `spec.auth` 决定 `x-api-key` 还是 `Bearer`）。
 * - **超时**来自 `request(...)`（`LIMITS.requestTimeoutMs`，可用 `timeoutMs` 覆盖本次预算）。
 * - **错误分类**来自 `classifyApiError`：4xx / 5xx / 超时 / 断网 / 非 JSON 各有可读结论。
 * - **没有 `paths.embedding` 的渠道 = 没有 embedding 能力**：本地直接返回原因，一次请求都不发。
 *   绝不猜一个 `/embeddings` 去试（#303 的 2059 条 404 就是这么来的）。
 *
 * 这一层**不抛错**：所有失败都收敛成 `{ ok: false, vectors: [], reason, detail?, status? }`，
 * 由调用方决定是提示还是静默降级。窗口记忆据此退化为纯 BM25，不阻塞对话（#397 关闭条件 3）。
 *
 * 不打包模型、不做本地推理：这里只有一次 HTTPS 请求。
 */
import {
  getApiKey,
  getBaseUrl,
  getCurrentSpec,
  getModel,
  joinUrl,
  normalizeBaseUrl,
} from './apiConfig.js'
import { ApiError, authHeaders, request } from './client.js'
import { classifyApiError } from './errors.js'

/**
 * 不可用的原因（机器可读，直接进召回统计的 `fallbackReason` 与诊断日志）：
 * - `channel-unsupported` 当前渠道没有 embedding 端点（DeepSeek 官方 / Anthropic 协议天然没有）
 * - `invalid-base-url`     渠道地址不是合法的 http(s) 地址（等同「没配」）
 * - `missing-api-key`      没有 API Key
 * - `http-<status>`        上游 4xx / 5xx（`detail` 里带 `classifyApiError` 的结论）
 * - `timeout` / `network`  没拿到响应头 / 没到达服务端
 * - `malformed-response`   上游回了网页或非约定结构
 * - `count-mismatch`       返回条数与请求条数不符
 * - `dimension-mismatch`   返回维度与预期（同批之间或与已探测维度）不一致
 * - `api-error`            其它未归类的失败
 */
export type EmbeddingReason =
  | 'channel-unsupported'
  | 'invalid-base-url'
  | 'missing-api-key'
  | 'timeout'
  | 'network'
  | 'malformed-response'
  | 'count-mismatch'
  | 'dimension-mismatch'
  | 'api-error'
  /** `http-<status>`：带状态码的失败，前缀固定，便于日志聚合 */
  | `http-${number}`

export type EmbeddingChannelState = {
  /** 地址、Key、端点三样齐了才算可用 */
  configured: boolean
  /** `configured` 为 false 时的原因；可用时为 `''` */
  reason: EmbeddingReason | ''
  baseUrl: string
  /** 实际请求地址；不可用时为空串（保证「不可用 ⇒ 没有地址可打」） */
  url: string
  model: string
  apiKey: string
}

export type EmbeddingResult = {
  ok: boolean
  /** 失败时恒为空数组：调用方不需要分支就能安全降级 */
  vectors: number[][]
  reason: EmbeddingReason | ''
  detail?: string
  status?: number
}

/**
 * 当前渠道的 embedding 配置快照。
 *
 * 模型名不来自渠道 spec 里的对话模型：embedding 模型与对话模型是两件事
 * （渠道里配的 `deepseek-flash` 去请求 `/embeddings` 只会 400）。调用方传自己的模型名，
 * 没传才回落到当前对话模型（等价于「让上游自己决定」，仅作兜底）。
 */
export const resolveEmbeddingChannel = (model?: string): EmbeddingChannelState => {
  const spec = getCurrentSpec()
  const baseUrl = normalizeBaseUrl(getBaseUrl()) ?? ''
  const apiKey = getApiKey().trim()
  const resolvedModel = String(model ?? '').trim() || getModel()
  const state: EmbeddingChannelState = {
    configured: false,
    reason: '',
    baseUrl,
    url: '',
    model: resolvedModel,
    apiKey,
  }
  const path = spec.paths.embedding
  if (!path) {
    return { ...state, reason: 'channel-unsupported' }
  }
  if (!baseUrl) {
    return { ...state, reason: 'invalid-base-url' }
  }
  if (!apiKey) {
    return { ...state, reason: 'missing-api-key' }
  }
  return { ...state, configured: true, url: joinUrl(baseUrl, path) }
}

const fail = (
  reason: EmbeddingReason,
  extra: { detail?: string; status?: number } = {}
): EmbeddingResult => ({ ok: false, vectors: [], reason, ...extra })

/** 一条向量：非空、长度一致、全是有限数（NaN / 字符串一律算坏数据） */
const isVector = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item))

/** 失败原因 → 可读细节：状态码 + `classifyApiError` 的结论 + 上游原话 */
const failureFromError = (error: unknown): EmbeddingResult => {
  if (error instanceof ApiError) {
    const detail = [classifyApiError(error), error.message, error.detail]
      .filter((part) => Boolean(part))
      .join(' / ')
    if (error.kind === 'timeout') {
      return fail('timeout', { detail })
    }
    if (error.kind === 'network') {
      return fail('network', { detail })
    }
    // 上游把网页当接口数据返回（路径不匹配 / 网关报错页）——先于状态码判，见 client.ts 的 isHtmlResponse
    if (error.kind === 'protocol') {
      return fail('malformed-response', { detail, status: error.status })
    }
    if (error.status !== undefined) {
      return fail(`http-${error.status}`, { detail, status: error.status })
    }
    return fail('api-error', { detail })
  }
  return fail('api-error', { detail: error instanceof Error ? error.message : String(error) })
}

/**
 * 请求一批向量。**永不抛错**。
 *
 * @param options.input     待向量化文本（空数组 = 成功且空结果，不发请求）
 * @param options.model     向量模型名；缺省用渠道对话模型兜底
 * @param options.expectedDimensions 期望维度（例如上次探测到的维度）：不一致即判失败并给出原因，
 *                                  避免模型被换掉后把不同维度的向量混进同一个索引
 * @param options.timeoutMs 覆盖本次请求预算（默认 `LIMITS.requestTimeoutMs`）
 */
export const embedTexts = async (options: {
  input: string[]
  model?: string
  expectedDimensions?: number
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<EmbeddingResult> => {
  const input = (options.input ?? []).map((text) => String(text ?? ''))
  if (input.length === 0) {
    return { ok: true, vectors: [], reason: '' }
  }
  const channel = resolveEmbeddingChannel(options.model)
  if (!channel.configured) {
    // 一次请求都不发：原因写清楚，日志里能直接看出是「渠道不支持」还是「没填 Key」
    const detail =
      channel.reason === 'channel-unsupported'
        ? `渠道 ${getCurrentSpec().kind} 没有 embedding 端点`
        : channel.reason === 'invalid-base-url'
          ? `渠道地址非法或为空：${getBaseUrl() || '(empty)'}`
          : `未配置 API Key（渠道 ${getCurrentSpec().kind}）`
    return fail(channel.reason || 'api-error', { detail })
  }

  let response: Response
  try {
    response = await request(
      channel.url,
      {
        method: 'POST',
        headers: {
          ...authHeaders(channel.apiKey, { baseUrl: channel.baseUrl }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: channel.model, input }),
        signal: options.signal,
      },
      options.timeoutMs !== undefined && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}
    )
  } catch (error) {
    return failureFromError(error)
  }

  const raw = await response.text()
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail('malformed-response', { status: response.status, detail: raw.slice(0, 200) })
  }

  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    return fail('malformed-response', {
      status: response.status,
      detail: `返回缺少 data 数组：${raw.slice(0, 200)}`,
    })
  }

  // 上游不保证顺序：按 index 排回来（缺 index 的按原顺序，index 相同的稳定排序）
  const ordered = data
    .slice()
    .sort((a, b) => (Number((a as { index?: number })?.index ?? 0) || 0) - (Number((b as { index?: number })?.index ?? 0) || 0))
  const vectors = ordered.map((item) => (item as { embedding?: unknown })?.embedding)

  if (vectors.length !== input.length) {
    return fail('count-mismatch', {
      status: response.status,
      detail: `期望 ${input.length} 条，实际 ${vectors.length} 条`,
    })
  }

  const invalid = vectors.findIndex((vector) => !isVector(vector))
  if (invalid >= 0) {
    return fail('malformed-response', {
      status: response.status,
      detail: `第 ${invalid} 条不是有效的数值向量`,
    })
  }

  const typed = vectors as number[][]
  const dimensions = typed[0].length
  const inconsistent = typed.findIndex((vector) => vector.length !== dimensions)
  if (inconsistent >= 0) {
    return fail('dimension-mismatch', {
      status: response.status,
      detail: `同批维度不一致：第 0 条 ${dimensions} 维，第 ${inconsistent} 条 ${typed[inconsistent].length} 维`,
    })
  }
  const expected = options.expectedDimensions
  if (expected !== undefined && expected > 0 && dimensions !== expected) {
    return fail('dimension-mismatch', {
      status: response.status,
      detail: `期望 ${expected} 维，实际 ${dimensions} 维（模型被换过？）`,
    })
  }

  return { ok: true, vectors: typed, reason: '' }
}

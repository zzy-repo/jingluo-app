/**
 * sub2api 的错误信封 → **一个**归一化错误（Issue #484 §四 + #487 实测更正）。
 *
 * 实测（2026-11-20，实例 0.2.22，`GET /api/v1/settings/public` 的 `data.version`）证明这里不是
 * 文档写的「三套信封」，而是 **四套 JSON + 一套纯文本**：
 *
 * | # | 来源 | 形状 | 实测样本 |
 * | --- | --- | --- | --- |
 * | 1 | 面板 `/api/v1/**`（业务失败） | `{code: <整数>, message, reason?}` | `{"code":404,"message":"Model plaza is not enabled"}` |
 * | 2 | 中间件（鉴权 / 限流 / 网关拒绝） | `{code: "UPPER_SNAKE", message}` | `{"code":"UNAUTHORIZED",...}`、`{"code":"api_key_in_query_deprecated",...}` |
 * | 3 | 网关 `/v1/**` | `{error: {code, message, param?, type?}}`（`code` 小写 snake） | `{"error":{"code":"model_not_found",...}}` |
 * | 4 | **429 限流** | `{error: "<字符串>", message}` —— **没有 `code` 字段** | `{"error":"rate limit exceeded","message":"..."}` |
 * | 5 | **未知路径 404** | **`text/plain` 的 `404 page not found`**（根本不是 JSON） | 边缘反代的 401 也是 text/plain |
 *
 * 补充实测（本地联调实例 0.2.20，2026-11-20）：
 *   - 429 与纯文本 404 在两个实例上**完全一致**（`{error:"rate limit exceeded"}` + `Retry-After: 42`；
 *     未知路径 `text/plain` 的 `404 page not found`）；
 *   - 网关心跳外的另一种形状：`{"error":{"message":"…","type":"permission_error"},"type":"error"}` ——
 *     `error` 里**可能只有 `type`、没有 `code`**，所以取码顺序是 `error.code` → `error.type`；
 *   - `/health` 在两个实例上不一致（0.2.20 有 `{"status":"ok"}`，0.2.22 是 404）→
 *     **客户端不许依赖健康检查**，它也不在白名单里。
 *
 * 三条结论（决定了本文件的写法）：
 *   - **必须先看 `content-type` 再决定要不要 `JSON.parse`**：对 text/plain 响应做 JSON 解析会抛；
 *   - **只按 `code` 分支，永不匹配 `message`**：401 有三个 message 变体（用户 `Authorization header is
 *     required` / admin `Authorization required` / 网关 `API Key ...`），按文本匹配会在 admin 路径上静默失效；
 *   - **429 没有 `code`**：任何 `if (body.code === 'RATE_LIMITED')` 都永远不会触发，只能按状态码分支。
 *
 * 界面上永远不直接显示服务端的 `message`（英文句子、随版本改），只显示本文件给的 i18n key。
 */

import type { ConsumeRawResponse } from './http.js'

/**
 * 归一化后的错误类别。
 *
 * 口径**与 `docs/sub2api-client-contract.md` §4 一致**（`auth | quota | rate_limit | redeem | key | server | unknown`），
 * 另外两个是契约表里没列但客户端必须能表达的情况：
 *   - `network`：**没拿到响应**（超时 / 连不上 / 非原生平台）—— 界面要能说「网络」而不是「服务端错误」，
 *     细分看 `code`（`TIMEOUT` / `NETWORK` / `UNSUPPORTED_PLATFORM`）；
 *   - `bad_request`：请求本身不合法（400 / 422），属于客户端 bug，不该提示用户「稍后重试」。
 */
export type ConsumeErrorKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'redeem'
  | 'key'
  | 'server'
  | 'network'
  | 'bad_request'
  | 'unknown'

/**
 * 命中的是哪套信封（排查用）。
 *  - `panel`        面板整数 `code`
 *  - `middleware`   中间件大写字符串 `code`
 *  - `gateway`      网关 `{error:{...}}`
 *  - `error_string` `{error:"<字符串>", message}`（429 专用）
 *  - `text`         **非 JSON**（未知路径 404 / 边缘反代 401）
 *  - `none`         空体 / 结构不认识
 */
export type ConsumeErrorEnvelope = 'panel' | 'middleware' | 'gateway' | 'error_string' | 'text' | 'none'

/**
 * 文案 key（与 `src/i18n/zh.ts` / `en.ts` 的键一一对应）。
 *
 * **W1-C 负责把这些 key 补进两份 i18n**（本层只回 key，不拼文案、不碰 DOM）。
 * 语义按 #484 §4.4 的「新语义」列：USD 额度、卡密过期 ≠ 卡密已用、`LOCKED` 是「处理中」不是失败。
 */
export type ConsumeMessageKey =
  | 'consumeErrUnknown'
  | 'consumeErrNetwork'
  | 'consumeErrTimeout'
  | 'consumeErrUnsupported'
  | 'consumeErrBadRequest'
  | 'consumeErrInvalidResponse'
  | 'consumeErrUnauthorized'
  | 'consumeErrAccountDisabled'
  | 'consumeErrForbidden'
  | 'consumeErrNotFound'
  | 'consumeErrRateLimited'
  | 'consumeErrServerUnavailable'
  | 'consumeErrKeyMissing'
  | 'consumeErrKeyInvalid'
  | 'consumeErrKeyDisabled'
  | 'consumeErrKeyExpired'
  | 'consumeErrKeyQuotaExhausted'
  | 'consumeErrKeyExists'
  | 'consumeErrInsufficientBalance'
  | 'consumeErrGroupNotAllowed'
  | 'consumeErrCardNotFound'
  | 'consumeErrCardNotFoundOrExpired'
  | 'consumeErrCardUsed'
  | 'consumeRedeemProcessing'
  | 'consumeErrInvitationInvalid'
  | 'consumeErrEmailCodeInvalid'
  | 'consumeErrNotEnabled'

/** 归一化错误：界面只认这几项，其中 `i18nKey` 是唯一该上屏的东西 */
export type Sub2ApiError = {
  kind: ConsumeErrorKind
  /**
   * 服务端原样给的码：中间件 `code` / 面板 `reason` / 网关 `error.code`。
   * 服务端没给（纯文本、429、空体）时是 `HTTP_<status>` / `NETWORK` / `TIMEOUT`。
   */
  code: string
  /** 面板业务码（`response.Error` 的 `reason` 字段），没有就是 undefined */
  reason?: string
  /** 服务端原始 message：**只用于排查日志，不上屏**（纯文本响应会截断到 200 字符） */
  message: string
  /** HTTP 状态码；0 = 没拿到响应 */
  status: number
  /** 是否可以重试（只表达「重试有意义」；卡密这类「绝不盲重试」由 redeem.ts 把关，#484 §4.3） */
  retryable: boolean
  envelope: ConsumeErrorEnvelope
  /** 429 的 `Retry-After`（毫秒）：按服务端给的秒数倒计时，客户端不自己算节奏 */
  retryAfterMs?: number
  /** 界面上该显示哪句文案 */
  i18nKey: ConsumeMessageKey
  /** 响应不是 JSON（text/plain）：调用方据此知道「不要指望有 code」 */
  nonJson?: true
}

/** 错误码 → `{kind, i18nKey}` 映射表（面板 `reason`、中间件字符串、网关小写码共用一张） */
export const CONSUME_ERROR_KEYS: Record<string, { kind: ConsumeErrorKind; i18nKey: ConsumeMessageKey }> = {
  // ── 中间件：会话（JWT）────────────────────────────────────────────────
  UNAUTHORIZED: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  INVALID_AUTH_HEADER: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  EMPTY_TOKEN: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  INVALID_TOKEN: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  TOKEN_EXPIRED: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  TOKEN_REVOKED: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  SESSION_BINDING_MISMATCH: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  USER_NOT_FOUND: { kind: 'auth', i18nKey: 'consumeErrForbidden' },
  USER_INACTIVE: { kind: 'auth', i18nKey: 'consumeErrAccountDisabled' },
  // ── 中间件：API Key（网关）───────────────────────────────────────────
  API_KEY_REQUIRED: { kind: 'key', i18nKey: 'consumeErrKeyMissing' },
  INVALID_API_KEY: { kind: 'key', i18nKey: 'consumeErrKeyInvalid' },
  API_KEY_DISABLED: { kind: 'key', i18nKey: 'consumeErrKeyInvalid' },
  API_KEY_EXPIRED: { kind: 'key', i18nKey: 'consumeErrKeyExpired' },
  API_KEY_QUOTA_EXHAUSTED: { kind: 'quota', i18nKey: 'consumeErrKeyQuotaExhausted' },
  API_KEY_AUTH_OVERLOADED: { kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  api_key_in_query_deprecated: { kind: 'key', i18nKey: 'consumeErrBadRequest' },
  // ── 中间件：权限 / 额度 / 限流 ────────────────────────────────────────
  INSUFFICIENT_BALANCE: { kind: 'quota', i18nKey: 'consumeErrInsufficientBalance' },
  GROUP_NOT_ALLOWED: { kind: 'key', i18nKey: 'consumeErrGroupNotAllowed' },
  FORBIDDEN: { kind: 'auth', i18nKey: 'consumeErrForbidden' },
  ACCESS_DENIED: { kind: 'auth', i18nKey: 'consumeErrForbidden' },
  STEP_UP_REQUIRED: { kind: 'auth', i18nKey: 'consumeErrForbidden' },
  RATE_LIMITED: { kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  INVALID_AUTH_RATE_LIMITED: { kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  INTERNAL_ERROR: { kind: 'server', i18nKey: 'consumeErrServerUnavailable' },
  // 503「MCP OAuth 没配」不是可重试的服务端故障，是「这个功能没开」→ 归 forbidden（不可重试）
  // 503「MCP OAuth 没配」= 这个功能没开，不是可重试的服务端故障
  MCP_OAUTH_NOT_CONFIGURED: { kind: 'unknown', i18nKey: 'consumeErrNotEnabled' },
  // ── 网关（`error.code` 小写 snake，实测）─────────────────────────────
  model_not_found: { kind: 'unknown', i18nKey: 'consumeErrNotFound' },
  unknown_api_path: { kind: 'unknown', i18nKey: 'consumeErrNotFound' },
  invalid_request_error: { kind: 'bad_request', i18nKey: 'consumeErrBadRequest' },
  authentication_error: { kind: 'auth', i18nKey: 'consumeErrUnauthorized' },
  permission_error: { kind: 'key', i18nKey: 'consumeErrGroupNotAllowed' },
  insufficient_quota: { kind: 'quota', i18nKey: 'consumeErrKeyQuotaExhausted' },
  rate_limit_error: { kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  rate_limit_exceeded: { kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  server_error: { kind: 'server', i18nKey: 'consumeErrServerUnavailable' },
  // ── 面板业务码（`reason` 字段）───────────────────────────────────────
  REDEEM_CODE_NOT_FOUND: { kind: 'redeem', i18nKey: 'consumeErrCardNotFound' },
  REDEEM_CODE_EXPIRED: { kind: 'redeem', i18nKey: 'consumeErrCardNotFoundOrExpired' },
  REDEEM_CODE_USED: { kind: 'redeem', i18nKey: 'consumeErrCardUsed' },
  REDEEM_CODE_LOCKED: { kind: 'redeem', i18nKey: 'consumeRedeemProcessing' },
  REDEEM_RATE_LIMITED: { kind: 'rate_limit', i18nKey: 'consumeErrRateLimited' },
  API_KEY_EXISTS: { kind: 'key', i18nKey: 'consumeErrKeyExists' },
  API_KEY_TOO_SHORT: { kind: 'key', i18nKey: 'consumeErrBadRequest' },
  API_KEY_INVALID_CHARS: { kind: 'key', i18nKey: 'consumeErrBadRequest' },
  INVITATION_CODE_INVALID: { kind: 'bad_request', i18nKey: 'consumeErrInvitationInvalid' },
  INVITATION_CODE_DISABLED: { kind: 'bad_request', i18nKey: 'consumeErrNotEnabled' },
  INVALID_VERIFY_CODE: { kind: 'bad_request', i18nKey: 'consumeErrEmailCodeInvalid' },
  VERIFY_CODE_INVALID: { kind: 'bad_request', i18nKey: 'consumeErrEmailCodeInvalid' },
}

/** 缺口记录：映射表覆盖不到的服务端码（#484 §四「覆盖不到时打日志并上报缺口」） */
export type ConsumeErrorGap = {
  code: string
  reason?: string
  status: number
  envelope: ConsumeErrorEnvelope
}

/** 未覆盖的码（同一次会话里同一个「信封:码」只记一次，供诊断层读） */
const unmappedCodes = new Set<string>()
let gapReporter: ((gap: ConsumeErrorGap) => void) | null = null

/** 诊断层（W1-B）可以把上报接进来；本层自己不 console、不读 DOM */
export const setConsumeGapReporter = (reporter: ((gap: ConsumeErrorGap) => void) | null): void => {
  gapReporter = reporter
}

/** 到目前为止没被映射表覆盖过的服务端码（排查用；正常情况下应当为空） */
export const unmappedConsumeCodes = (): string[] => [...unmappedCodes]

/** 测试用：清空缺口记录（不进产品路径） */
export const resetConsumeGaps = (): void => {
  unmappedCodes.clear()
}

const recordGap = (gap: ConsumeErrorGap): void => {
  const key = `${gap.envelope}:${gap.code}`
  if (unmappedCodes.has(key)) {return}
  unmappedCodes.add(key)
  gapReporter?.(gap)
}

/** 按 HTTP 状态码兜底（映射表查不到时用；顺序在服务端 `code` 之后） */
const kindFromStatus = (status: number): ConsumeErrorKind => {
  if (status === 400 || status === 422) {
    return 'bad_request'
  }
  if (status === 401 || status === 403) {
    return 'auth'
  }
  if (status === 402) {
    return 'quota'
  }
  if (status === 429) {
    return 'rate_limit'
  }
  if (status >= 500) {
    return 'server'
  }
  return 'unknown'
}

const keyFromStatus = (status: number): ConsumeMessageKey => {
  // 401 与 403 都归 kind 'auth'，但文案不同：401 = 会话缺失/过期，403 = 权限不足
  if (status === 401) {
    return 'consumeErrUnauthorized'
  }
  if (status === 403) {
    return 'consumeErrForbidden'
  }
  const kind = kindFromStatus(status)
  if (kind === 'bad_request') {
    return 'consumeErrBadRequest'
  }
  if (kind === 'quota') {
    return 'consumeErrInsufficientBalance'
  }
  if (kind === 'rate_limit') {
    return 'consumeErrRateLimited'
  }
  if (kind === 'server') {
    return 'consumeErrServerUnavailable'
  }
  return 'consumeErrUnknown'
}

/** `Retry-After` → 毫秒（只认秒数；HTTP-date 形态按「没给」处理） */
const retryAfterOf = (headers: Record<string, string>): number | undefined => {
  const raw = headers['retry-after']
  if (!raw) {return undefined}
  const seconds = Number(raw.trim())
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 判断「这个响应体是不是 JSON」：优先 content-type，其次看有没有解析出对象 */
const looksLikeJson = (raw: ConsumeRawResponse): boolean => {
  if (raw.contentType !== '') {return raw.contentType.includes('json')}
  // 头里没给 content-type（有的探针/网关会掉）→ 以「解析出来了」为准
  return raw.json !== null
}

/** 从四套 JSON 信封里取出 `{envelope, code, reason, message}`（顺序即优先级） */
const readEnvelope = (
  json: unknown
): { envelope: ConsumeErrorEnvelope; code: string; reason?: string; message: string } => {
  const body = asRecord(json)
  if (!body) {return { envelope: 'none', code: '', message: '' }}
  const message = str(body.message)

  // 网关：{error:{code, message, param?, type?}}（实测 `code` 是小写 snake）
  const gateway = asRecord(body.error)
  if (gateway) {
    const code = str(gateway.code) || str(gateway.type)
    return { envelope: 'gateway', code, message: str(gateway.message) || message }
  }

  // 429：{error:"<字符串>", message} —— **没有 code 字段**，靠状态码分支
  if (typeof body.error === 'string') {
    return { envelope: 'error_string', code: '', message: message || body.error }
  }

  // 面板：{code: <整数>, message, reason?}
  if (typeof body.code === 'number') {
    const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason : undefined
    return { envelope: 'panel', code: reason ?? '', reason, message }
  }

  // 中间件：{code: "UPPER_SNAKE", message}（也见过小写 snake 的 `api_key_in_query_deprecated`）
  if (typeof body.code === 'string' && body.code !== '') {
    return { envelope: 'middleware', code: body.code, message }
  }

  return { envelope: 'none', code: '', message }
}

/**
 * 把一次响应归一成 `Sub2ApiError`。
 *
 * 决策顺序：**传输层失败 → 非 JSON（text/plain）→ 四套 JSON 信封 → 状态码兜底**。
 * 映射表查不到的服务端码会记一条缺口（不是「未知错误」静默吞掉）；状态码兜底不记，避免噪音。
 */
export const parseSub2ApiError = (
  raw: ConsumeRawResponse,
  options: { path?: string } = {}
): Sub2ApiError => {
  void options

  // ① 没拿到响应：超时 / 连不上 / 非原生平台
  if (raw.status === 0) {
    const failure = raw.failure ?? 'network'
    if (failure === 'unsupported') {
      return {
        kind: 'network',
        code: 'UNSUPPORTED_PLATFORM',
        message: 'CapacitorHttp 不可用（非原生环境）',
        status: 0,
        retryable: false,
        envelope: 'none',
        i18nKey: 'consumeErrUnsupported',
      }
    }
    return {
      kind: 'network',
      code: failure === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      message: failure === 'timeout' ? '请求超时（没拿到响应）' : '连不上服务端（没拿到响应）',
      status: 0,
      retryable: true,
      envelope: 'none',
      i18nKey: failure === 'timeout' ? 'consumeErrTimeout' : 'consumeErrNetwork',
    }
  }

  const retryAfterMs = retryAfterOf(raw.headers)

  // ② 非 JSON：未知路径 404（gin 的 `404 page not found`）、边缘反代 Basic 401（`authentication required`）
  //    实测这两种都是 text/plain —— 直接 JSON.parse 会抛，所以先按 content-type 分流。
  if (!looksLikeJson(raw)) {
    const kind = kindFromStatus(raw.status)
    return {
      kind,
      code: `HTTP_${raw.status}`,
      message: raw.text.trim().slice(0, 200),
      status: raw.status,
      retryable: kind === 'server' || kind === 'rate_limit',
      envelope: 'text',
      nonJson: true,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      i18nKey: keyFromStatus(raw.status),
    }
  }

  // ③ 四套 JSON 信封
  const { envelope, code, reason, message } = readEnvelope(raw.json)
  const mapped = code === '' ? undefined : CONSUME_ERROR_KEYS[code]
  if (!mapped && code !== '') {
    recordGap({ code, reason, status: raw.status, envelope })
  }

  const kind = mapped?.kind ?? kindFromStatus(raw.status)
  return {
    kind,
    // 面板整数 code 没带 reason 时，code 用状态码表示（`HTTP_404`），不把 404 当业务码
    code: code === '' ? `HTTP_${raw.status}` : code,
    reason,
    message: message || raw.text.trim().slice(0, 200),
    status: raw.status,
    // 重试有意义 = 传输层 / 5xx / 429；业务失败（401/403/404/409）重试只会更糟
    retryable: kind === 'server' || kind === 'rate_limit',
    envelope,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    i18nKey: mapped?.i18nKey ?? keyFromStatus(raw.status),
  }
}

/** 会话类错误：W1-B 拿到它就试 `refresh`，刷新失败必须清登录态（#484 §二） */
export const isSessionError = (error: Sub2ApiError): boolean =>
  [
    'UNAUTHORIZED',
    'INVALID_AUTH_HEADER',
    'EMPTY_TOKEN',
    'INVALID_TOKEN',
    'TOKEN_EXPIRED',
    'TOKEN_REVOKED',
    'SESSION_BINDING_MISMATCH',
    'USER_NOT_FOUND',
  ].includes(error.code)

/** 卡密「正在处理」不是失败（#484 §4.4：禁止提示换卡） */
export const isRedeemLocked = (error: Sub2ApiError): boolean => error.code === 'REDEEM_CODE_LOCKED'

/** 卡密「已用过」：可能是自己上一次成功，文案必须提示「若已到账请刷新余额」 */
export const isRedeemUsed = (error: Sub2ApiError): boolean => error.code === 'REDEEM_CODE_USED'

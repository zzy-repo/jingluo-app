/**
 * 「我们的渠道」卡密 / 支付服务的客户端契约层。
 *
 * 这一层只有纯逻辑：不碰 DOM、不 import @capacitor/*、不读 localStorage，
 * 所有网络请求都通过注入的 `OursTransport` 发出（原生 CapacitorHttp / Web fetch，
 * 见 transport.ts）。因此 Node 单测可以直接 import 本文件，用假 transport 断言
 * 「发了什么请求、怎么解释响应」。
 *
 * 服务端契约（2026-11-18 实测，https://apia.ecsafe.cn，全站 HTTPS）：
 *   GET  /api/plans                      → { plans: [{ id, name, price, points, currency, enabled }] }
 *                                          价格与积分由服务端决定，App 不得硬编码
 *   GET  /buy?plan=<id>                  → 302 到支付宝收银台（Location 里带 out_trade_no，
 *                                          return_url 里带 order_token）
 *                                          ⚠️ 每次 GET 都会新建一笔订单：只能由用户点击触发一次
 *   GET  /api/order?out_trade_no=&order_token=
 *                                        → { out_trade_no, status, amount_fen, card_no, expire_at, message }
 *                                          status ∈ pending/paid/fulfilled/expired/failed
 *                                          只有 fulfilled 才有 card_no；order_token 不对 → 403；15 分钟过期
 *   POST /api/redeem {card_no, api_key, request_id}
 *                                        → { ok, card_no, points, api_key, sync }
 *                                          202 CREDIT_PENDING 是「处理中」，不是失败
 *   GET  /api/balance  Authorization: Bearer <Key>
 *                                        → { api_key: "…013812", valid: true }
 *                                          ⚠️ 只反映 Key 是否有效，**不返回剩余积分**：
 *                                          额度一律取邀请服务 /me 的 remaining_points（见 services/invite）
 *   错误统一 { code, message, request_id }
 *
 * 安全约束（硬性）：
 *   - API Key 只走 Authorization 请求头 / 请求体，**不进 URL query**。
 *   - 日志 / 提示文案里不出现完整 Key、完整卡密、带凭据的完整 URL：
 *     Key 只露尾 6 位，卡密只露尾 4 位，收银台地址只当作「要打开的链接」不落日志。
 */

import { maskCard, maskKey } from './mask.js'
import { ORDER_RESUME_MAX_AGE_MS, readStoredOrder, writeStoredOrder, type OrderStorage } from './orderStore.js'
import { ensureCustomerId, readCachedCustomerId } from './customerId.js'

export { maskCard, maskDeviceId, maskKey, maskTail } from './mask.js'

/** 卡密 / 支付服务地址（HTTPS）：价格、积分、发卡、兑换都问它 */
export const OURS_API_BASE = 'https://apia.ecsafe.cn'

/**
 * 购买是否放开。
 *
 * 2026-11-18 实测：/api/plans 的标价与 /buy 下发的 money= 一致（p1 = ¥3.00 / 300 积分，
 * 1 元 = 100 积分），不再有「标价 9.90、实付 0.10」的资损风险，因此放开购买入口。
 * 一旦服务端价格与套餐再次不一致，这里改回 false 即可整体收回（界面只留一行说明）。
 */
export const OURS_PAYMENT_OPEN = true

/** 各接口的读超时（毫秒）；超时与网络错误在状态里分开，文案也不同 */
export const OURS_TIMEOUTS = {
  plans: 10000,
  keyProbe: 10000,
  redeem: 15000,
  order: 10000,
  buy: 12000,
  /** 订单轮询：间隔 2s、总时长上限 60s（契约要求，不可调） */
  poll: { intervalMs: 2000, timeoutMs: 60000 },
} as const

/**
 * 一次请求的完整描述。
 *
 * `followRedirects` 在业务请求里**一律 false**：/buy 必须读 302 的 Location，
 * 跟随重定向会把 out_trade_no / order_token 一起丢掉，之后再也查不到单。
 */
export type OursHttpRequest = {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  followRedirects: boolean
}

/**
 * transport 结果：区分「拿到响应」与「连不上 / 超时」（后者没有 status）。
 * `location` 只在 3xx 时有值（/buy 的收银台地址就从这里取）。
 */
export type OursHttpResult =
  | { kind: 'response'; status: number; text: string; location?: string }
  | { kind: 'timeout' }
  | { kind: 'network' }

export type OursTransport = (request: OursHttpRequest) => Promise<OursHttpResult>

/** 界面文案的 key（与 i18n/zh.ts 的键一致；服务层只回 key，不拼文案） */
export type OursMessageKey =
  | 'oursQuotaNeedsClaim'
  | 'oursQuotaNeedsBind'
  | 'oursKeyProbeValid'
  | 'oursKeyProbeInvalid'
  | 'oursKeyProbeNetwork'
  | 'oursKeyProbeTimeout'
  | 'oursPlansFailed'
  | 'oursPlansLoading'
  | 'oursRedeemSuccess'
  | 'oursRedeemPending'
  | 'oursErrBadJson'
  | 'oursErrUnauthorized'
  | 'oursErrForbidden'
  | 'oursErrNotFound'
  | 'oursErrCardNotFound'
  | 'oursErrCardNotFoundOrExpired'
  | 'oursErrCardLeased'
  | 'oursErrApiKeyNotIssued'
  | 'oursErrCardUsed'
  | 'oursErrCardMissing'
  | 'oursErrKeyMissing'
  | 'oursErrKeyInvalid'
  | 'oursErrVerifyUnavailable'
  | 'oursErrRateLimited'
  | 'oursErrPlanNotFound'
  | 'oursErrPlanMissing'
  | 'oursErrOrderNotFound'
  | 'oursErrOrderTokenMissing'
  | 'oursErrCheckoutUnsupported'
  | 'oursErrCustomerMissing'
  | 'oursOrderStatusPending'
  | 'oursOrderStatusPaid'
  | 'oursOrderStatusFulfilled'
  | 'oursOrderStatusExpired'
  | 'oursOrderStatusFailed'
  | 'oursErrNetwork'
  | 'oursErrTimeout'
  | 'oursErrInvalidResponse'
  | 'oursErrUnknown'

/** 错误码 → 文案 key（服务端 code 优先，其次按 HTTP 状态码兜底） */
export const OURS_ERROR_KEYS: Record<string, OursMessageKey> = {
  PLAN_NOT_FOUND: 'oursErrPlanNotFound',
  PLAN_MISSING: 'oursErrPlanMissing',
  BAD_INPUT: 'oursErrBadJson',
  BAD_JSON: 'oursErrBadJson',
  UNAUTHORIZED: 'oursErrUnauthorized',
  FORBIDDEN: 'oursErrForbidden',
  NOT_FOUND: 'oursErrNotFound',
  CARD_NOT_FOUND: 'oursErrCardNotFound',
  CARD_ALREADY_USED: 'oursErrCardUsed',
  /** 卡密已迁到本机池兑换通道（与「已被使用」是两件事，文案必须分开） */
  CARD_LEASED: 'oursErrCardLeased',
  CARD_MISSING: 'oursErrCardMissing',
  API_KEY_MISSING: 'oursErrKeyMissing',
  API_KEY_INVALID: 'oursErrKeyInvalid',
  VERIFY_UNAVAILABLE: 'oursErrVerifyUnavailable',
  RATE_LIMITED: 'oursErrRateLimited',
  ORDER_NOT_FOUND: 'oursErrOrderNotFound',
}

/** 没有 code 时按状态码给个能看的文案（404 到底是卡密还是订单，只有 code 能区分） */
export const OURS_STATUS_KEYS: Record<number, OursMessageKey> = {
  400: 'oursErrBadJson',
  401: 'oursErrUnauthorized',
  403: 'oursErrForbidden',
  404: 'oursErrNotFound',
  409: 'oursErrCardUsed',
  429: 'oursErrRateLimited',
  503: 'oursErrVerifyUnavailable',
}

/** 订单状态 → 文案 key */
export type OursOrderStatus = 'pending' | 'paid' | 'fulfilled' | 'expired' | 'failed'

export const ORDER_STATUS_KEYS: Record<OursOrderStatus, OursMessageKey> = {
  pending: 'oursOrderStatusPending',
  paid: 'oursOrderStatusPaid',
  fulfilled: 'oursOrderStatusFulfilled',
  expired: 'oursOrderStatusExpired',
  failed: 'oursOrderStatusFailed',
}

/** 终态：轮询到这些状态就停（paid 仍在等发卡，继续轮） */
const TERMINAL_ORDER_STATUSES: OursOrderStatus[] = ['fulfilled', 'expired', 'failed']

export const isTerminalOrderStatus = (status: OursOrderStatus): boolean =>
  TERMINAL_ORDER_STATUSES.includes(status)

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  if (text.trim() === '') {
    return { ok: false }
  }
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? { ok: true, value } : { ok: false }
  } catch {
    return { ok: false }
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readString = (record: Record<string, unknown> | null, field: string): string => {
  const value = record?.[field]
  return typeof value === 'string' ? value : ''
}

const readNumber = (record: Record<string, unknown> | null, field: string): number | null => {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300

/** 超时 / 连不上这类传输层问题，统一换成可重试的文案 key */
const transportFailure = (result: Exclude<OursHttpResult, { kind: 'response' }>): OursMessageKey =>
  result.kind === 'timeout' ? 'oursErrTimeout' : 'oursErrNetwork'

/** 服务端错误码 → 文案 key（先看 code，再看状态码） */
const messageKeyFor = (code: string, status: number): OursMessageKey =>
  OURS_ERROR_KEYS[code] ?? OURS_STATUS_KEYS[status] ?? 'oursErrUnknown'

// ------------------------------------------------------------------ 积分文案

/** 积分数字：300 → "300"、3900 → "3,900"（千分位，不跟 locale 变），不含单位 */
const formatPointAmount = (points: number): string =>
  Math.trunc(Number.isFinite(points) ? points : 0)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * 积分文案：数字 + 单位，例：`formatPoints(300, t('oursPointsUnit'))` → zh「300 积分」/ en「300 points」。
 *
 * 单位**必须**由调用方从 i18n key `oursPointsUnit` 传入（Issue #94）：本模块是纯逻辑层，
 * 不读语言 store，也**不许**再在这里写死「积分」——写死过一次，en 语言下就上屏了中文。
 * 数值口径不变：只显示积分，**不做 points → 人民币折算**（Issue #75）：`/api/plans` 的实际口径不是
 * 「1 元 = 100 积分」（p1 = ¥0.10 / 300 积分），折算会给用户错误预期；人民币价格只在
 * 「套餐」处用后端下发的 price 展示。原来的 POINTS_PER_YUAN / pointsToYuan / formatYuan
 * 已随 #75 一并删除，别再拼回来。
 */
export const formatPoints = (points: number, unit: string): string => {
  const amount = formatPointAmount(points)
  return unit === '' ? amount : `${amount} ${unit}`
}

// ------------------------------------------------------------------ Key 校验

/**
 * Key 校验结果。**只回答「这把 Key 服务端认不认」**，不携带任何额度信息：
 * 额度属于邀请服务（/me 的 remaining_points），不要拿这里当余额用。
 */
export type OursKeyProbe =
  | { status: 'valid' | 'invalid'; keyTail: string }
  | { status: 'network' | 'timeout' | 'invalid-json'; keyTail: string }

/** 校验 Key：GET /api/balance + Authorization: Bearer <Key>，URL 里绝不带 Key */
export const probeApiKey = async (apiKey: string, transport: OursTransport): Promise<OursKeyProbe> => {
  const key = apiKey.trim()
  const keyTail = key === '' ? '' : maskKey(key)
  if (key === '') {
    return { status: 'invalid', keyTail }
  }
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/balance`,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.keyProbe,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { status: result.kind === 'timeout' ? 'timeout' : 'network', keyTail }
  }
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return { status: 'invalid-json', keyTail }
  }
  const body = asRecord(parsed.value)
  // 响应体里的 api_key 是打过码的（…013812）：仍然一律不读取、不返回、不落日志
  const valid = body?.valid === true
  return { status: valid && isSuccessStatus(result.status) ? 'valid' : 'invalid', keyTail }
}

// ------------------------------------------------------------------ 套餐

export type OursPlan = {
  id: string
  name: string
  /** 价格（元）；格式化交给 formatPlanPrice */
  price: number
  /** 套餐给的积分（1 元 = 100 积分） */
  points: number
  currency: string
  enabled: boolean
}

export type OursPlansState =
  | { status: 'success'; plans: OursPlan[] }
  | { status: 'error'; messageKey: OursMessageKey }

/** 价格文案：¥3.00 */
export const formatPlanPrice = (plan: OursPlan): string =>
  plan.currency === 'CNY' || plan.currency === ''
    ? `¥${plan.price.toFixed(2)}`
    : `${plan.price.toFixed(2)} ${plan.currency}`

/** 套餐副标题：`¥3.00 · 300 积分` / `¥3.00 · 300 points`（单位从 i18n 传入，见 formatPoints） */
export const formatPlanMeta = (plan: OursPlan, unit: string): string =>
  `${formatPlanPrice(plan)} · ${formatPoints(plan.points, unit)}`

const parsePlan = (value: unknown): OursPlan | null => {
  const record = asRecord(value)
  const id = readString(record, 'id')
  if (id === '' || record === null) {
    return null
  }
  return {
    id,
    name: readString(record, 'name') || id,
    price: readNumber(record, 'price') ?? 0,
    points: readNumber(record, 'points') ?? readNumber(record, 'quota') ?? 0,
    currency: readString(record, 'currency') || 'CNY',
    enabled: record.enabled !== false,
  }
}

/** 拉套餐：GET /api/plans（价格与积分以服务端为准，前端不写死） */
export const fetchPlans = async (transport: OursTransport): Promise<OursPlansState> => {
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/plans`,
    headers: { Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.plans,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { status: 'error', messageKey: transportFailure(result) }
  }
  if (!isSuccessStatus(result.status)) {
    return { status: 'error', messageKey: 'oursPlansFailed' }
  }
  const parsed = parseJson(result.text)
  if (!parsed.ok) {
    return { status: 'error', messageKey: 'oursPlansFailed' }
  }
  const raw = asRecord(parsed.value)?.plans
  if (!Array.isArray(raw)) {
    return { status: 'error', messageKey: 'oursPlansFailed' }
  }
  const plans = raw
    .map(parsePlan)
    .filter((plan): plan is OursPlan => plan !== null && plan.enabled)
  return plans.length === 0
    ? { status: 'error', messageKey: 'oursPlansFailed' }
    : { status: 'success', plans }
}

// ------------------------------------------------------------------ 卡密兑换

export type OursRedeemResult =
  | { kind: 'success'; points: number; cardTail: string }
  /** 202 CREDIT_PENDING：服务端受理但还没记账，**不是失败** */
  | { kind: 'pending'; cardTail: string }
  | {
      kind: 'error'
      code: string
      messageKey: OursMessageKey
      cardTail: string
      /** 网络 / 超时 / 503 这类可以原样重试（沿用同一个 request_id） */
      retryable: boolean
    }

/**
 * request_id 固定用卡密本身。
 *
 * 服务端按 request_id 去重：同一张卡超时重发时，重发必须能被识别成同一笔，
 * 而 card_no 天然一一对应、不需要额外保存一份 id（也就少一处会丢的状态）。
 */
export const requestIdForCard = (cardNo: string): string => cardNo.trim()

export type OursRedeemInput = { cardNo: string; apiKey: string; requestId: string }

/**
 * 卡密兑换：POST /api/redeem。
 * - 202 / CREDIT_PENDING → kind='pending'（处理中，界面不能说「失败」，也不催用户重试）
 * - 409 CARD_ALREADY_USED → 提示不要重复提交
 * - 400 API_KEY_INVALID → 提示重填 Key；503 VERIFY_UNAVAILABLE → 可重试
 */
export const redeemCard = async (
  input: OursRedeemInput,
  transport: OursTransport
): Promise<OursRedeemResult> => {
  const cardNo = input.cardNo.trim()
  const cardTail = cardNo === '' ? '' : maskCard(cardNo)
  if (cardNo === '') {
    return { kind: 'error', code: 'CARD_MISSING', messageKey: 'oursErrCardMissing', cardTail, retryable: false }
  }
  const key = input.apiKey.trim()
  if (key === '') {
    return { kind: 'error', code: 'API_KEY_MISSING', messageKey: 'oursErrKeyMissing', cardTail, retryable: false }
  }
  const result = await transport({
    method: 'POST',
    url: `${OURS_API_BASE}/api/redeem`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ card_no: cardNo, api_key: key, request_id: input.requestId }),
    timeoutMs: OURS_TIMEOUTS.redeem,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
      cardTail,
      retryable: true,
    }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? asRecord(parsed.value) : null
  // 业务码兼容两种信封：顶层 {code}（本服务）与 {error:{code}}（本机池那条链路）
  const code = readString(body, 'code') || readString(asRecord(body?.error), 'code')
  if (result.status === 202 || code === 'CREDIT_PENDING') {
    return { kind: 'pending', cardTail }
  }
  if (isSuccessStatus(result.status) && body !== null && body.ok === true) {
    return { kind: 'success', points: readNumber(body, 'points') ?? 0, cardTail }
  }
  if (!parsed.ok && isSuccessStatus(result.status)) {
    return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse', cardTail, retryable: false }
  }
  return {
    kind: 'error',
    code: code || `HTTP_${result.status}`,
    messageKey: messageKeyFor(code, result.status),
    cardTail,
    retryable: result.status >= 500,
  }
}

// ------------------------------------------------------------------ 收银台（/buy 的 302）

export type OursCheckout = {
  outTradeNo: string
  /** 查单令牌：必须保存（没有它 /api/order 一律 403） */
  orderToken: string
  /** 收银台地址：只能用系统浏览器打开，禁止内嵌 WebView */
  payUrl: string
}

/** 收银台地址只接受 https（原生插件也只放行 https），其余一律当作「没有支付入口」 */
export const isOpenableCheckout = (url: string): boolean => /^https:\/\//i.test(url.trim())

/**
 * 建单入口：`/buy?plan=<id>`（签名、单号、金额都已经拼在它的 302 目标里）。
 *
 * 两种用法，取决于运行环境（Issue #36）：
 *  - 网页版：把这个 URL 交给浏览器做**顶层导航**（`window.location.assign` / `<a href>`）。
 *    跨域顶层跳转不受 CORS 约束，也不需要读 Location —— 这正是网页版唯一正确的打开方式。
 *  - 原生：走 `startCheckout`（CapacitorHttp 不跟随重定向，读回 302 的 Location）。
 *
 * 绝不能用 `fetch(..., { redirect: 'manual' })` 去读它：规范规定跨域时只能拿到
 * `opaqueredirect`（status 0、没有 header），读不到 Location，也看不到目标 URL。
 */
export const buyUrl = (
  planId: string,
  customerId?: number | null,
  storage?: OrderStorage | null
): string => {
  const base = `${OURS_API_BASE}/buy?plan=${encodeURIComponent(planId.trim())}`
  // Issue #115：下单一律带 cid（订单归属该客户）；显式传 null 表示「明知道没有 cid」，
  // 那就不要拼 cid —— 调用方（navigateTopLevel / startCheckout）会因此拒绝下单，而不是悄悄建单。
  const cid = customerId === undefined ? readCachedCustomerId(storage) : customerId
  return cid === null || cid === undefined ? base : `${base}&cid=${cid}`
}

/** 付款回跳时地址栏带回来的查询参数：`?no=<out_trade_no>&order_token=<token>` */
export type OursOrderReturn = { outTradeNo: string; orderToken: string }

/**
 * 解析付款回跳参数（`?no=…&order_token=…`）。
 *
 * - `no` 是收银台 `return_url` 里的 out_trade_no；也兼容写成 `out_trade_no`
 * - `order_token` 缺一不可（没有它 /api/order 一律 403）
 * - 两个参数都在才算「这是一次回跳」，否则返回 null（正常打开页面不触发查单）
 */
export const parseOrderReturn = (search: string): OursOrderReturn | null => {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const outTradeNo = (params.get('no') ?? params.get('out_trade_no') ?? '').trim()
  const orderToken = (params.get('order_token') ?? '').trim()
  if (outTradeNo === '' || orderToken === '') {
    return null
  }
  return { outTradeNo, orderToken }
}

const parseUrl = (value: string): URL | null => {
  try {
    return new URL(value.trim())
  } catch {
    return null
  }
}

/**
 * 从 /buy 的 Location（或网页版兜底跟随后的最终地址）里取出单号与令牌。
 *
 * 实测格式（2026-11-18）：
 *   https://pay.xiaodouap.cn/submit.php?pid=…&out_trade_no=CP2026…&money=3.00
 *     &return_url=https%3A%2F%2Fapia.ecsafe.cn%2Freturn%3Fno%3DCP2026…%26order_token%3DLsx2…
 * 即 out_trade_no 在收银台地址自己身上，order_token 在 return_url 的 query 里。
 * 两处都兼容：收银台地址直接带 order_token 时优先用它。
 */
export const parseCheckoutTarget = (rawUrl: string): OursCheckout | null => {
  const url = parseUrl(rawUrl)
  if (url === null || !isOpenableCheckout(url.href)) {
    return null
  }
  const outTradeNo = url.searchParams.get('out_trade_no') ?? url.searchParams.get('no') ?? ''
  let orderToken = url.searchParams.get('order_token') ?? ''
  const returnUrl = url.searchParams.get('return_url')
  if (returnUrl !== null && returnUrl !== '') {
    const ret = parseUrl(returnUrl)
    if (ret !== null) {
      orderToken = orderToken || (ret.searchParams.get('order_token') ?? '')
    }
  }
  if (outTradeNo.trim() === '' || orderToken.trim() === '') {
    return null
  }
  return { outTradeNo: outTradeNo.trim(), orderToken: orderToken.trim(), payUrl: url.href }
}

export type OursCheckoutResult =
  | { kind: 'ok'; checkout: OursCheckout; replacedUnpaidOrder: boolean }
  /** 拿不到 Location（原生插件也读不到 302 头）→ 界面提示换条路，不猜单号 */
  | { kind: 'no-location' }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

/**
 * 建单：GET /buy?plan=<id>（**仅原生**用；网页版走 buyUrl + 顶层导航，见 Issue #36）。
 *
 * 关键点：
 *  - 只发一次（每次 GET 都会新建订单），界面只在用户点「去支付」时调用
 *  - 请求层 followRedirects=false：只读 3xx 的 Location，不跟随（跟随会丢单号令牌）
 *  - 网页版不该调用本函数：浏览器里 `fetch(redirect:'manual')` 只能拿到 opaqueredirect，
 *    永远拿不到 Location。网页版的正确做法是让浏览器顶层跳转到 buyUrl(planId)。
 */
export type OursCheckoutOptions = {
  /** 下单归属客户（cid）。不传就按「缓存 → provider」自己解析；显式 null 表示已知没有 */
  customerId?: number | null
  /** 注入存储（单测用）；默认浏览器 localStorage */
  storage?: OrderStorage | null
}

export const startCheckout = async (
  planId: string,
  transport: OursTransport,
  options: OursCheckoutOptions = {}
): Promise<OursCheckoutResult> => {
  const id = planId.trim()
  if (id === '') {
    return { kind: 'error', code: 'PLAN_MISSING', messageKey: 'oursErrPlanMissing' }
  }
  // Issue #115：拿不到 cid 就不下单。宁可让用户看到一句明确的提示，也不要建一张
  // 不知道属于谁的单——那正是「付了钱还显示等待支付」的成因。
  const customerId =
    options.customerId === undefined
      ? (readCachedCustomerId(options.storage) ?? (await ensureCustomerId(options.storage)))
      : options.customerId
  if (customerId === null || customerId === undefined) {
    return { kind: 'error', code: 'CUSTOMER_ID_MISSING', messageKey: 'oursErrCustomerMissing' }
  }
  const result = await transport({
    method: 'GET',
    url: buyUrl(id, customerId, options.storage),
    headers: { Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: OURS_TIMEOUTS.buy,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
    }
  }
  const location = (result.location ?? '').trim()
  const target = location !== '' ? parseCheckoutTarget(location) : null
  if (target !== null) {
    // Issue #115：每次建单成功都**覆盖**本地存档，轮询只跟最新这一单。
    // 旧实现只在弹层里写一次，连点两次「去支付」时存档可能停在上一单，回跳后就查错了单。
    const previous = readStoredOrder(options.storage)
    const replacedUnpaidOrder =
      previous !== null &&
      previous.outTradeNo !== target.outTradeNo &&
      Date.now() - previous.startedAt <= ORDER_RESUME_MAX_AGE_MS
    writeStoredOrder(
      {
        outTradeNo: target.outTradeNo,
        orderToken: target.orderToken,
        planId: id,
        startedAt: Date.now(),
      },
      options.storage
    )
    return { kind: 'ok', checkout: target, replacedUnpaidOrder }
  }
  if (result.status === 0 || location === '') {
    return { kind: 'no-location' }
  }
  if (isOpenableCheckout(location)) {
    // 给了 https 收银台地址但里面没有单号 / 令牌：付完款也查不到单，不如现在就说清楚
    return { kind: 'error', code: 'ORDER_TOKEN_MISSING', messageKey: 'oursErrOrderTokenMissing' }
  }
  // 明文收银台地址一律不开
  if (result.status >= 300 && result.status < 400) {
    return { kind: 'error', code: 'CHECKOUT_NOT_HTTPS', messageKey: 'oursErrCheckoutUnsupported' }
  }
  const parsed = parseJson(result.text)
  const code = readString(parsed.ok ? asRecord(parsed.value) : null, 'code')
  return {
    kind: 'error',
    code: code || `HTTP_${result.status}`,
    messageKey: messageKeyFor(code, result.status),
  }
}

// ------------------------------------------------------------------ 订单

export type OursOrder = {
  outTradeNo: string
  status: OursOrderStatus
  amountFen: number
  /** 展示用：卡密只留尾 4 位；未发卡时为空串 */
  cardTail: string
  /**
   * 完整卡密：只有 fulfilled 才有值。
   * **只留在内存里**（「一键兑换」要把它提交给 /api/redeem），
   * 不写日志、不写文案、不进 localStorage —— 界面一律显示 cardTail。
   */
  cardNo: string
  /** 服务端给的是 Unix 秒；解析不出来就是 null */
  expireAtSeconds: number | null
  message: string
}

export type OursOrderResult =
  | { kind: 'ok'; order: OursOrder }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

const parseOrderStatus = (value: string): OursOrderStatus | null =>
  value === 'pending' || value === 'paid' || value === 'fulfilled' || value === 'expired' || value === 'failed'
    ? value
    : null

const parseOrder = (value: unknown): OursOrder | null => {
  const record = asRecord(value)
  const status = parseOrderStatus(readString(record, 'status'))
  const outTradeNo = readString(record, 'out_trade_no')
  if (record === null || status === null || outTradeNo === '') {
    return null
  }
  const cardNo = readString(record, 'card_no')
  const expireRaw = record.expire_at
  const expireAtSeconds =
    typeof expireRaw === 'number' && Number.isFinite(expireRaw)
      ? expireRaw
      : typeof expireRaw === 'string' && /^\d+$/.test(expireRaw.trim())
        ? Number(expireRaw.trim())
        : null
  const fulfilled = status === 'fulfilled' && cardNo.trim() !== ''
  return {
    outTradeNo,
    status,
    amountFen: readNumber(record, 'amount_fen') ?? 0,
    cardTail: fulfilled ? maskCard(cardNo) : '',
    cardNo: fulfilled ? cardNo.trim() : '',
    expireAtSeconds,
    message: readString(record, 'message'),
  }
}

/** 查单：GET /api/order?out_trade_no=&order_token=（order_token 必须带，否则 403） */
export const queryOrder = async (
  input: { outTradeNo: string; orderToken: string },
  transport: OursTransport
): Promise<OursOrderResult> => {
  const outTradeNo = input.outTradeNo.trim()
  const orderToken = input.orderToken.trim()
  if (outTradeNo === '' || orderToken === '') {
    return { kind: 'error', code: 'ORDER_TOKEN_MISSING', messageKey: 'oursErrOrderTokenMissing' }
  }
  const query = `out_trade_no=${encodeURIComponent(outTradeNo)}&order_token=${encodeURIComponent(orderToken)}`
  const result = await transport({
    method: 'GET',
    url: `${OURS_API_BASE}/api/order?${query}`,
    headers: { Accept: 'application/json' },
    timeoutMs: OURS_TIMEOUTS.order,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: transportFailure(result),
    }
  }
  const parsed = parseJson(result.text)
  if (isSuccessStatus(result.status) && parsed.ok) {
    const order = parseOrder(parsed.value)
    return order === null
      ? { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse' }
      : { kind: 'ok', order }
  }
  const code = readString(parsed.ok ? asRecord(parsed.value) : null, 'code')
  return {
    kind: 'error',
    code: code || `HTTP_${result.status}`,
    messageKey: messageKeyFor(code, result.status),
  }
}

export type OursPollResult =
  | { kind: 'ok'; order: OursOrder; attempts: number }
  | { kind: 'timeout'; order: OursOrder | null; attempts: number }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }
  | { kind: 'cancelled'; order: OursOrder | null; attempts: number }

/**
 * 订单轮询状态机：2s 一次、总时长不超过 60s，只在有 order_token 时可用（没有令牌一次请求都不发）。
 *
 * - 终态（fulfilled / expired / failed）立即返回
 * - pending / paid 继续轮
 * - 到 60s 还没终态 → kind='timeout'（界面提示「稍后在订单查看卡密」，**不重复下单**）
 * - onUpdate 每次拿到新状态就回调一次（界面边轮边渲染）
 * - shouldStop 由界面注入（关闭弹层 / 切渠道时取消）
 * sleep / now 也可注入，单测里用假时钟验证间隔与上限。
 */
export const pollOrder = async (input: {
  outTradeNo: string
  orderToken: string
  transport: OursTransport
  intervalMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onUpdate?: (order: OursOrder) => void
  shouldStop?: () => boolean
}): Promise<OursPollResult> => {
  const intervalMs = input.intervalMs ?? OURS_TIMEOUTS.poll.intervalMs
  const timeoutMs = input.timeoutMs ?? OURS_TIMEOUTS.poll.timeoutMs
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const started = now()
  const maxAttempts = Math.max(1, Math.floor(timeoutMs / intervalMs) + 1)
  let attempts = 0
  let last: OursOrder | null = null
  for (;;) {
    if (input.shouldStop?.() === true) {
      return { kind: 'cancelled', order: last, attempts }
    }
    const result = await queryOrder(
      { outTradeNo: input.outTradeNo, orderToken: input.orderToken },
      input.transport
    )
    attempts += 1
    if (result.kind === 'error') {
      return { kind: 'error', code: result.code, messageKey: result.messageKey }
    }
    last = result.order
    input.onUpdate?.(result.order)
    if (isTerminalOrderStatus(result.order.status)) {
      return { kind: 'ok', order: result.order, attempts }
    }
    if (now() - started + intervalMs > timeoutMs || attempts >= maxAttempts) {
      return { kind: 'timeout', order: last, attempts }
    }
    await sleep(intervalMs)
  }
}

/**
 * 「我的购买」数据层（Issue #158）：`GET /api/orders` 的分页 / 筛选 / 解析 / 容错。
 *
 * 本文件是**唯一**的接口与类型定义处，界面那一半（另一 PR）只 import 这里，不重复定义。
 * 纯逻辑：不碰 DOM / React，也不 import i18n —— 错误只给 `kind`，文案由界面层按自己的 key 决定。
 *
 * 服务端契约（Issue #158，2026-11-19）：
 *   GET {base}/api/orders?limit=20&offset=0&status=
 *     Authorization: Bearer <apiKey>          ← Key 只走请求头，**永不进 query**
 *   → { customer_id, total, limit, offset, total_paid_yuan, orders: [...] }
 *
 * 为什么复用 transport.ts：原生（CapacitorHttp）/ Web（fetch）双实现与「超时 / 连不上」
 * 的区分已经在那里做过了，这里再写一套 fetch 只会让两端行为分叉。
 *
 * 安全约束（硬性）：
 *   - Key 只放 `Authorization` 头，URL 里只有 limit/offset/status；
 *   - 日志 / 错误原文里不出现完整 Key，卡号最多露后 4 位（`maskCardNo`）。
 */
import { record } from '../diagnostics/collector.js'
import { buildMeta } from '../diagnostics/fields.js'
import type { LogMeta } from '../diagnostics/types.js'
import { OURS_API_BASE, type OursHttpRequest, type OursTransport } from './api.js'
import { httpTransport } from './transport.js'

// ------------------------------------------------------------------ 类型（界面依赖这些名字）
export type PurchaseStatus = 'pending' | 'paid' | 'fulfilled' | 'expired' | 'failed'

export interface PurchaseOrder {
  outTradeNo: string
  planId: string
  planName: string
  planPoints: number
  amountYuan: number
  status: PurchaseStatus
  /** 后端给的中文（待支付 / 已支付处理中 / 已完成 / 已过期 / 失败），界面直接展示 */
  statusText: string
  cardNo: string | null
  cardStatus: 'leased' | 'used' | 'void' | null
  redeemState: 'issued' | 'redeemed' | null
  /** unix 秒 */
  createdAt: number
  /** unix 秒；没付款就是 null */
  paidAt: number | null
}

export interface PurchasePage {
  customerId: number | null
  total: number
  limit: number
  offset: number
  totalPaidYuan: number
  orders: PurchaseOrder[]
}

export interface FetchPurchasesParams {
  apiKey: string
  /** 默认 20，最大 100，超界夹住 */
  limit?: number
  /** 默认 0，负数按 0 */
  offset?: number
  /** 不传 / null 表示不过滤 */
  status?: PurchaseStatus | null
}

// ------------------------------------------------------------------ 常量
/** 每页默认条数（服务端默认也是 20） */
export const PURCHASES_DEFAULT_LIMIT = 20
/** 服务端上限：超过这个数一律夹到 100 */
export const PURCHASES_MAX_LIMIT = 100
/**
 * 读超时 12s：Issue #158 提到该接口对 62.106 有一次跨机调用（换 customer_id），
 * 弱网下可能慢 1~3 秒，用 /buy 那档 12s 而不是 10s，避免把「慢」误报成「超时」。
 */
export const PURCHASES_TIMEOUT_MS = 12000

/** 五个合法状态（其余一律归 failed，原文保留在 statusText 里） */
export const PURCHASE_STATUSES: readonly PurchaseStatus[] = [
  'pending',
  'paid',
  'fulfilled',
  'expired',
  'failed',
]

// ------------------------------------------------------------------ 错误
/**
 * 购买记录失败的分类（沿用 `services/api/client.ts` 里 `ApiError` 的风格：
 * `kind` + `status` + `code`，文案交给调用方）。
 *
 * 分这么细是为了让界面能分开说两件完全不同的事：
 *  - `unauthorized` / `keyMissing` → **要用户重新填 Key**，重试没有意义；
 *  - `network` / `timeout` / `server` / `rateLimited` → **可以重试**（`retryable === true`）。
 */
export type PurchaseErrorKind =
  | 'keyMissing'
  | 'unauthorized'
  | 'rejected'
  | 'network'
  | 'timeout'
  | 'server'
  | 'rateLimited'
  | 'badResponse'

const RETRYABLE_KINDS: readonly PurchaseErrorKind[] = ['network', 'timeout', 'server', 'rateLimited']
const NEEDS_KEY_KINDS: readonly PurchaseErrorKind[] = ['keyMissing', 'unauthorized']

export class PurchaseError extends Error {
  readonly kind: PurchaseErrorKind
  /** HTTP 状态码；请求没发出去 / 没拿到响应时没有 */
  readonly status?: number
  /** 服务端错误码（UNAUTHORIZED / RATE_LIMITED …），有就用 */
  readonly code?: string
  /** 原始报错，只进日志；**绝不放 Key / 完整卡号** */
  readonly detail?: string

  constructor(
    kind: PurchaseErrorKind,
    message: string,
    options: { status?: number; code?: string; detail?: string } = {}
  ) {
    // 字段逐个赋值（不用 TS 参数属性）：单测直接在 Node 里 import 这个模块跑真代码。
    super(message)
    this.name = 'PurchaseError'
    this.kind = kind
    this.status = options.status
    this.code = options.code
    this.detail = options.detail
  }

  /** 重试可能有用（网络 / 超时 / 5xx / 限流） */
  get retryable(): boolean {
    return RETRYABLE_KINDS.includes(this.kind)
  }

  /** 要用户重新填 Key（没填 / 401 / 403），重试没用 */
  get needsKey(): boolean {
    return NEEDS_KEY_KINDS.includes(this.kind)
  }
}

/** 别处拿到的未知错误要不要重试（不是 PurchaseError 一律按「不重试」） */
export const isRetryablePurchaseError = (error: unknown): boolean =>
  error instanceof PurchaseError && error.retryable

// ------------------------------------------------------------------ 小工具（防御式读取）
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readString = (record: Record<string, unknown> | null, keys: readonly string[]): string => {
  if (record === null) {
    return ''
  }
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') {
      const text = value.trim()
      if (text !== '') {
        return text
      }
    }
  }
  return ''
}

/**
 * 数字：真数字、或**纯数字串**（老版本后端会这么给）都认；其它（null / "abc" / NaN / 对象）一律 null。
 * 调用方用 `?? 默认值` 收口，所以非数字永远不会变成 NaN 漏到界面上。
 */
const readNumber = (record: Record<string, unknown> | null, keys: readonly string[]): number | null => {
  if (record === null) {
    return null
  }
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string') {
      const text = value.trim()
      if (/^-?\d+(?:\.\d+)?$/u.test(text)) {
        const parsed = Number(text)
        if (Number.isFinite(parsed)) {
          return parsed
        }
      }
    }
  }
  return null
}

/** 秒级时间：接受秒 / 数字串 / 毫秒 / ISO 字符串；认不出来就是 null */
const toSeconds = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value > 1e12 ? value / 1000 : value)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') {
      return null
    }
    if (/^\d+(?:\.\d+)?$/u.test(text)) {
      const seconds = Number(text)
      return Number.isFinite(seconds) && seconds > 0
        ? Math.floor(seconds > 1e12 ? seconds / 1000 : seconds)
        : null
    }
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
  }
  return null
}

const firstValue = (record: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const value = record[key]
    if (value !== undefined && value !== null) {
      return value
    }
  }
  return undefined
}

const roundYuan = (value: number): number => Math.round(value * 100) / 100

/** 夹取分页参数：非法值给默认值，数字夹到合法区间（与界面无关，纯口径） */
export const clampPurchasesLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PURCHASES_DEFAULT_LIMIT
  }
  const limit = Math.floor(value)
  if (limit <= 0) {
    return PURCHASES_DEFAULT_LIMIT
  }
  return Math.min(limit, PURCHASES_MAX_LIMIT)
}

export const clampPurchasesOffset = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  const offset = Math.floor(value)
  return offset > 0 ? offset : 0
}

const normalizeStatus = (raw: string): PurchaseStatus | null => {
  const text = raw.trim().toLowerCase()
  return (PURCHASE_STATUSES as readonly string[]).includes(text) ? (text as PurchaseStatus) : null
}

/**
 * 状态归一：大小写无关（后端给的是 `FULFILLED`），**认不出的归 failed**
 * （既能显示「失败」，也不会把未知状态当成「已完成」白送一次点击）。
 */
export const purchaseStatusOf = (raw: string): PurchaseStatus => normalizeStatus(raw) ?? 'failed'

const CARD_STATUSES: readonly NonNullable<PurchaseOrder['cardStatus']>[] = ['leased', 'used', 'void']
const REDEEM_STATES: readonly NonNullable<PurchaseOrder['redeemState']>[] = ['issued', 'redeemed']

const parseCardStatus = (raw: string): PurchaseOrder['cardStatus'] => {
  const text = raw.trim().toLowerCase()
  return (CARD_STATUSES as readonly string[]).includes(text)
    ? (text as NonNullable<PurchaseOrder['cardStatus']>)
    : null
}

const parseRedeemState = (raw: string): PurchaseOrder['redeemState'] => {
  const text = raw.trim().toLowerCase()
  return (REDEEM_STATES as readonly string[]).includes(text)
    ? (text as NonNullable<PurchaseOrder['redeemState']>)
    : null
}

// ------------------------------------------------------------------ 解析
/** `customer_id` 只认正整数（0 / NaN / 负数按「不知道」处理，与 #135 的口径一致） */
const parseCustomerIdFrom = (record: Record<string, unknown>): number | null => {
  const value = readNumber(record, ['customer_id', 'customerId'])
  if (value === null) {
    return null
  }
  const id = Math.floor(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/**
 * 单条订单解析：字段名以 snake_case 为准（服务端实际给的），camelCase 兜底。
 *
 * 安全默认值（任何一项坏了都不抛、不变成 NaN）：
 *  - 缺 out_trade_no → ''（保留这条记录，界面自己决定是否可操作）；不是对象的条目直接丢；
 *  - 金额 / 积分 / 时间非数字 → 0 / 0 / 0（paidAt 没付款才是 null）；
 *  - status 非法 → 'failed'；status_text 原样保留（后端中文，界面直接展示）。
 */
export const parsePurchaseOrder = (value: unknown): PurchaseOrder | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const rawStatus = readString(record, ['status', 'state', 'order_status'])
  const cardNo = readString(record, ['card_no', 'cardNo'])
  const planPoints = readNumber(record, ['plan_points', 'planPoints']) ?? 0
  const amountYuan = readNumber(record, ['amount_yuan', 'amountYuan', 'amount']) ?? 0
  return {
    outTradeNo: readString(record, ['out_trade_no', 'outTradeNo', 'no']),
    planId: readString(record, ['plan_id', 'planId']),
    planName: readString(record, ['plan_name', 'planName']),
    planPoints: Math.round(planPoints),
    amountYuan: roundYuan(amountYuan),
    status: purchaseStatusOf(rawStatus),
    statusText: readString(record, ['status_text', 'statusText']),
    cardNo: cardNo === '' ? null : cardNo,
    cardStatus: parseCardStatus(readString(record, ['card_status', 'cardStatus'])),
    redeemState: parseRedeemState(readString(record, ['redeem_state', 'redeemState'])),
    createdAt: toSeconds(firstValue(record, ['created_at', 'createdAt', 'time'])) ?? 0,
    paidAt: toSeconds(firstValue(record, ['paid_at', 'paidAt', 'pay_time'])),
  }
}

/**
 * 解析 `/api/orders` 响应。
 *
 * 防御口径（Issue #158 的验收要求：坏数据不能崩）：
 *  - 根不是对象 → null（调用方按 badResponse 报错，因为连结构都不对）；
 *  - `orders` 不是数组 → 当空列表（服务端改字段时界面显示「没有记录」，而不是整页报错）；
 *  - `total` 缺失/非法 → 退化成这一页的条数（这样「还有没有下一页」不会凭空说「有」）。
 */
export const parsePurchasePage = (value: unknown, fallback?: { limit: number; offset: number }): PurchasePage | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const rawOrders = record.orders
  const orders = Array.isArray(rawOrders)
    ? rawOrders
        .map(parsePurchaseOrder)
        .filter((order): order is PurchaseOrder => order !== null)
    : []
  const offset = clampPurchasesOffset(readNumber(record, ['offset']) ?? fallback?.offset ?? 0)
  const totalRaw = readNumber(record, ['total'])
  const total = totalRaw === null ? orders.length : Math.max(0, Math.floor(totalRaw))
  return {
    customerId: parseCustomerIdFrom(record),
    total,
    limit: clampPurchasesLimit(readNumber(record, ['limit']) ?? fallback?.limit ?? PURCHASES_DEFAULT_LIMIT),
    offset,
    totalPaidYuan: roundYuan(readNumber(record, ['total_paid_yuan', 'totalPaidYuan']) ?? 0),
    orders,
  }
}

// ------------------------------------------------------------------ 展示
/**
 * 卡号只显示后 4 位：`MUSE-3CYP-5NA3-AHSE-A3SR` → `••••A3SR`；null / 空 → ''。
 *
 * #834 之后实现搬到了 `ours/mask.ts`（「我的卡密」的列表渲染层不 import 整条 apia 传输栈），
 * 这里保留同名再导出 —— 既有调用点与单测一字不改，遮蔽口径仍然只有一份。
 */
export { maskCardNo } from './mask.js'

/** 还有下一页：offset + orders.length < total */
export function hasNextPage(page: PurchasePage): boolean {
  const offset = Number.isFinite(page.offset) ? page.offset : 0
  const total = Number.isFinite(page.total) ? page.total : 0
  return offset + page.orders.length < total
}

// ------------------------------------------------------------------ 拉取
const ordersUrl = (base: string, limit: number, offset: number, status: PurchaseStatus | null): string => {
  const url = new URL(`${base.replace(/\/+$/u, '')}/api/orders`)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))
  // 不传 status 就**不加这个参数**（服务端对空的 status= 也会当全量，但少一个参数少一种歧义）
  if (status !== null) {
    url.searchParams.set('status', status)
  }
  return url.href
}

const errorFromResponse = (status: number, code: string): PurchaseError => {
  const detail = code === '' ? `HTTP_${status}` : code
  // 403 和 401 对用户是同一件事：这把 Key 看不到这些订单 —— 都要重新填 Key，重试没用。
  if (status === 401 || status === 403) {
    return new PurchaseError('unauthorized', 'API Key 无效或已过期，请重新填写 Key', {
      status,
      code: detail,
    })
  }
  if (status === 429) {
    return new PurchaseError('rateLimited', '请求过于频繁，请稍后重试', { status, code: detail })
  }
  if (status >= 500) {
    return new PurchaseError('server', '服务暂时不可用，请稍后重试', { status, code: detail })
  }
  return new PurchaseError('rejected', '服务端拒绝了这次请求', { status, code: detail })
}

/**
 * 拉一页购买记录：`GET {base}/api/orders?limit&offset&status` + `Authorization: Bearer <apiKey>`。
 *
 * 失败一律抛 `PurchaseError`：
 *  - 没填 Key → `keyMissing`（不发请求）；401/403 → `unauthorized`（要重新填 Key）；
 *  - 超时 / 连不上 → `timeout` / `network`（可重试）；5xx → `server`（可重试）；429 → `rateLimited`；
 *  - 2xx 但结构不对 → `badResponse`。
 */
export function fetchPurchases(params: FetchPurchasesParams): Promise<PurchasePage> {
  return fetchPurchasesVia(params, httpTransport, OURS_API_BASE)
}

/**
 * 同上，但传输层与 base 可注入：单测用假 transport 断言「发了什么请求」，
 * 界面层只调 `fetchPurchases`（签名按 #158 规格，没有多余参数）。
 */
/** 失败分类 → 日志字段：`reason` 是 PurchaseError.kind，`upstreamCode` 是服务端短码（有才写） */
const purchaseFailureMeta = (error: unknown): LogMeta => {
  if (error instanceof PurchaseError) {
    return {
      reason: error.kind,
      ...(error.code === undefined || error.code === '' ? {} : { upstreamCode: error.code }),
    }
  }
  return { reason: 'unknown' }
}

export async function fetchPurchasesVia(
  params: FetchPurchasesParams,
  transport: OursTransport,
  base: string = OURS_API_BASE
): Promise<PurchasePage> {
  const startedAt = Date.now()
  const limit = clampPurchasesLimit(params.limit)
  const offset = clampPurchasesOffset(params.offset)
  const status = params.status === null || params.status === undefined ? null : normalizeStatus(params.status)
  /** 最近一次拿到 HTTP 状态码（没发出去 / 超时没有状态码，就不写这个键） */
  let httpStatus: number | undefined
  /**
   * 出口埋点（#312）：记录页空白到底是「一单都没有」（count=0 且 total=0）还是「请求失败」
   * （result=error + reason=PurchaseError.kind），只有日志能分开。
   * `limit` / `offset` / `total` 一起给，才看得出「只拉了第一页」还是「服务端确实没有更多」。
   * 这一层不透传缓存，`cacheHit` 恒 false（命中判定在上层弹层，那里有自己的埋点）。
   */
  const logMeta = (): LogMeta => ({
    ...buildMeta({
      stage: 'quota.orders',
      durationMs: Date.now() - startedAt,
      ...(httpStatus === undefined ? {} : { status: httpStatus }),
    }),
    source: 'purchases',
    limit,
    offset,
    cacheHit: false,
  })
  try {
    const apiKey = params.apiKey.trim()
    if (apiKey === '') {
      throw new PurchaseError('keyMissing', '还没有填写 API Key')
    }
    const request: OursHttpRequest = {
      method: 'GET',
      url: ordersUrl(base, limit, offset, status),
      // Key 只在这里出现：请求头。URL 里只有 limit/offset/status（见 ordersUrl）。
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      timeoutMs: PURCHASES_TIMEOUT_MS,
      followRedirects: false,
    }
    const result = await transport(request)
    if (result.kind === 'timeout') {
      throw new PurchaseError('timeout', '请求超时了，可以再试一次')
    }
    if (result.kind === 'network') {
      throw new PurchaseError('network', '网络不可用，请检查网络后重试')
    }
    httpStatus = result.status
    let parsed: unknown = null
    try {
      parsed = JSON.parse(result.text) as unknown
    } catch {
      parsed = null
    }
    if (result.status < 200 || result.status >= 300) {
      throw errorFromResponse(result.status, readString(asRecord(parsed), ['code', 'error']).toUpperCase())
    }
    const page = parsePurchasePage(parsed, { limit, offset })
    if (page === null) {
      throw new PurchaseError('badResponse', '服务端返回的数据看不懂', { status: result.status })
    }
    record('nav', 'info', 'ours purchases fetched', {
      ...logMeta(),
      result: 'ok',
      count: page.orders.length,
      total: page.total,
    })
    return page
  } catch (error) {
    record('warning', 'warn', 'ours purchases failed', {
      ...logMeta(),
      result: 'error',
      ...purchaseFailureMeta(error),
    })
    throw error
  }
}

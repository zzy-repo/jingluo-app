/**
 * 支付记录时间线数据层（Issue #189）：`/api/trail`、`/api/order/trail`、`/api/card/trail`
 * 的分页 / 解析 / 错误分类。
 *
 * 纯逻辑：不碰 DOM / React，也不 import i18n —— 错误只给 `kind`，文案由界面层按自己的 key 决定
 * （和 `purchases.ts` 同一套风格，界面那一半不必重复定义类型）。
 *
 * 服务端契约（Issue #189）：
 *   GET {base}/api/trail?limit=20&offset=0&status=       Authorization: Bearer <apiKey>
 *     → { customer_id, total, limit, offset, total_paid_yuan, orders: [
 *           { out_trade_no, plan_id, amount_yuan, status, status_text, created_at, paid_at,
 *             expire_at, card: { card_no, points, state, redeemed_at, redeemed_by_customer_id,
 *                                redeemed_key_tail } | null,
 *             timeline: [{ at, event, text, detail }], next_step } ] }
 *   GET {base}/api/order/trail?out_trade_no=            → 单个订单对象（形状同上）
 *   GET {base}/api/card/trail?card_no=                  → { card_no, purchase, redemption }
 *
 * 2026-11-19 本机实测（无凭据，只能打错误分支；失败字段形状是真的）：
 *   401 {"code":"UNAUTHORIZED","message":"需要 Bearer API Key"}     ← Key 只在请求头，URL 里只有业务参数
 *   400 {"code":"BAD_INPUT","message":"缺少 out_trade_no"}
 *   404 {"code":"ORDER_NOT_FOUND","message":"订单不存在"}
 *
 * 两条硬口径（验收盯着这两条）：
 *   - **503 `UNAVAILABLE` 不是「空列表」**：这是服务在维护，自动重试 1 次，还不行就报 `unavailable`。
 *     把停服渲染成「你没有买过」是骗用户。
 *   - **事件不设白名单**：`timeline` 里 App 不认识的新事件（例如 `amount_reconciled`）必须原样带出来，
 *     由界面回落到服务端给的 `text`。少显示一条就是把对账 / 补发这类关键动作藏起来。
 *
 * 安全约束（硬性，同 #158）：
 *   - Key 只放 `Authorization` 头，URL 里只有 limit/offset/status/out_trade_no/card_no；
 *   - 错误信息里不出现完整 Key，卡号最多露后 4 位（掩码在界面层 `maskTrailCard`，这里不落原文到日志）。
 */
import { OURS_API_BASE, type OursHttpRequest, type OursTransport } from './api.js'
import { httpTransport } from './transport.js'

// ------------------------------------------------------------------ 类型（界面依赖这些名字）
/** 订单状态：`CREATED → PAID → FULFILLED`，或 `EXPIRED`（超时关闭，可救回）/ `FAILED`（异常） */
export type TrailOrderStatus = 'created' | 'paid' | 'fulfilled' | 'expired' | 'failed'

/** 色调：只有四种，界面按 `data-tone` 上色，不用自己 if/else 猜颜色 */
export type TrailTone = 'pending' | 'success' | 'danger' | 'muted'

/** 时间线上一颗点 */
export interface TrailEvent {
  /** unix 秒；没给就是 null（界面显示占位符，不显示 1970） */
  at: number | null
  /** 服务端事件名，原样保留（不认识的也要留着） */
  event: string
  /** 服务端中文文案，界面在「不认识这个事件」时用它兜底 */
  text: string
  detail: Record<string, unknown>
  /** 历史补录：时间只是补录值，不精确（`detail.backfilled === true`） */
  backfilled: boolean
}

export interface TrailCard {
  cardNo: string
  points: number
  state: 'issued' | 'redeemed'
  redeemedAt: number | null
  /** 兑换这张卡的 customer_id（用来判断是不是本人兑换） */
  redeemedByCustomerId: number | null
  /** 兑换时用的 Key 尾号：用户对账时认这个 */
  redeemedKeyTail: string
}

export interface TrailOrder {
  outTradeNo: string
  planId: string
  amountYuan: number
  status: TrailOrderStatus
  /** 后端给的中文（待支付 / 已完成 / 已关闭 …），界面直接展示；缺了自行回落 i18n */
  statusText: string
  createdAt: number | null
  paidAt: number | null
  expireAt: number | null
  card: TrailCard | null
  /** 全程时间线，按服务端给的顺序（服务端已按时间正序） */
  timeline: TrailEvent[]
  /** 服务端给的下一步指引（超时关闭时尤其重要：24h 内付款会自动补发） */
  nextStep: string
}

export interface TrailPage {
  customerId: number | null
  total: number
  limit: number
  offset: number
  totalPaidYuan: number
  orders: TrailOrder[]
}

/** 卡密溯源里的兑换信息 */
export interface TrailRedemption {
  redeemed: boolean
  at: number | null
  points: number
  keyTail: string
  /** true = 本人兑换；false = 别人兑换；null = 服务端没说 */
  byMe: boolean | null
  /** 兑换来源（in_app / web …），原样展示 */
  source: string
}

export interface CardTrail {
  cardNo: string
  /** 这张卡对应的订单（查不到就是 null，可能是历史卡） */
  purchase: TrailOrder | null
  redemption: TrailRedemption
}

export interface FetchTrailParams {
  apiKey: string
  /** 默认 20，最大 50（服务端上限），超界夹住 */
  limit?: number
  /** 默认 0，负数按 0 */
  offset?: number
  /** 不传 / null 表示不过滤 */
  status?: TrailOrderStatus | null
}

// ------------------------------------------------------------------ 常量
/** 每页默认条数（服务端默认也是 20） */
export const TRAIL_DEFAULT_LIMIT = 20
/** 服务端上限 50：再大服务端会拒，客户端先夹住，别把一个必然失败的请求发出去 */
export const TRAIL_MAX_LIMIT = 50
/**
 * 读超时 12s：`/api/trail` 要跨机查卡密与兑换记录（同 #158 的 /api/orders），
 * 弱网下 1~3 秒是常态，用 12s 免得把「慢」报成「超时」。
 */
export const TRAIL_TIMEOUT_MS = 12000

/** 五个合法状态（其余一律归 failed，原文保留在 statusText 里） */
export const TRAIL_ORDER_STATUSES: readonly TrailOrderStatus[] = [
  'created',
  'paid',
  'fulfilled',
  'expired',
  'failed',
]

// 三条只读路径：写死在这里，测试里能直接对着契约核名
const TRAIL_PATH = '/api/trail'
const ORDER_TRAIL_PATH = '/api/order/trail'
const CARD_TRAIL_PATH = '/api/card/trail'

// ------------------------------------------------------------------ 错误
/**
 * 时间线失败的分类。比 `purchases.ts` 多两个：`notFound`（单号不存在 / 不是你的单）
 * 与 `unavailable`（503，服务在维护——**不是**空列表）。
 *
 * 分开是为了界面能说三件完全不同的事：
 *  - `unauthorized` / `keyMissing` → **重新填 Key**，重试没用；
 *  - `notFound` → 单号不存在；刻意**不区分**「没这单」与「不是你的单」（否则等于给了一个查单号的接口）；
 *  - `network` / `timeout` / `server` / `rateLimited` / `unavailable` → **可以重试**。
 */
export type TrailErrorKind =
  | 'keyMissing'
  | 'unauthorized'
  | 'notFound'
  | 'rejected'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unavailable'
  | 'rateLimited'
  | 'badResponse'

const RETRYABLE_KINDS: readonly TrailErrorKind[] = [
  'network',
  'timeout',
  'server',
  'unavailable',
  'rateLimited',
]
const NEEDS_KEY_KINDS: readonly TrailErrorKind[] = ['keyMissing', 'unauthorized']

export class TrailError extends Error {
  readonly kind: TrailErrorKind
  /** HTTP 状态码；请求没发出去 / 没拿到响应时没有 */
  readonly status?: number
  /** 服务端错误码（UNAUTHORIZED / ORDER_NOT_FOUND / UNAVAILABLE …） */
  readonly code?: string
  /** 原始报错，只进日志；**绝不放 Key / 完整卡号** */
  readonly detail?: string

  constructor(
    kind: TrailErrorKind,
    message: string,
    options: { status?: number; code?: string; detail?: string } = {}
  ) {
    // 字段逐个赋值（不用 TS 参数属性）：单测直接在 Node 里 import 这个模块跑真代码。
    super(message)
    this.name = 'TrailError'
    this.kind = kind
    this.status = options.status
    this.code = options.code
    this.detail = options.detail
  }

  /** 重试可能有用（网络 / 超时 / 5xx / 503 / 限流） */
  get retryable(): boolean {
    return RETRYABLE_KINDS.includes(this.kind)
  }

  /** 要用户重新填 Key（没填 / 401 / 403），重试没用 */
  get needsKey(): boolean {
    return NEEDS_KEY_KINDS.includes(this.kind)
  }
}

// ------------------------------------------------------------------ 小工具（防御式读取，与 purchases.ts 同口径）
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

/** 数字：真数字、或纯数字串（老版本后端会这么给）都认；其它一律 null，调用方 `?? 默认值` 收口 */
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

const readBoolean = (record: Record<string, unknown> | null, keys: readonly string[]): boolean | null => {
  if (record === null) {
    return null
  }
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') {
      return value
    }
    if (value === 'true' || value === 'false') {
      return value === 'true'
    }
    if (value === 1 || value === 0) {
      return value === 1
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

const parseCustomerIdFrom = (record: Record<string, unknown>): number | null => {
  const value = readNumber(record, ['customer_id', 'customerId'])
  if (value === null) {
    return null
  }
  const id = Math.floor(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 夹取分页参数：非法值给默认值，超上限夹到 50（服务端上限） */
export const clampTrailLimit = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TRAIL_DEFAULT_LIMIT
  }
  const limit = Math.floor(value)
  if (limit <= 0) {
    return TRAIL_DEFAULT_LIMIT
  }
  return Math.min(limit, TRAIL_MAX_LIMIT)
}

export const clampTrailOffset = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  const offset = Math.floor(value)
  return offset > 0 ? offset : 0
}

// ------------------------------------------------------------------ 状态
const normalizeStatus = (raw: string): TrailOrderStatus | null => {
  const text = raw.trim().toLowerCase()
  return (TRAIL_ORDER_STATUSES as readonly string[]).includes(text)
    ? (text as TrailOrderStatus)
    : null
}

/**
 * 状态归一：大小写无关（后端给的是 `FULFILLED`），**认不出的归 failed**
 * （宁可显示成「异常」，也不能把未知状态当成「已完成」白送用户一次点击）。
 */
export const trailStatusOf = (raw: string): TrailOrderStatus => normalizeStatus(raw) ?? 'failed'

/**
 * 状态 → 色调。
 *
 * `EXPIRED` 单独给 `muted`，**不能和 `failed` 同色**：超时关闭后 24 小时内付款会自动补发卡密，
 * 它是「已经结束了但还有救」，不是「这笔钱出事了」。染色成红的会让用户以为钱没了。
 */
export const trailToneOf = (status: TrailOrderStatus): TrailTone => {
  if (status === 'fulfilled') {
    return 'success'
  }
  if (status === 'failed') {
    return 'danger'
  }
  if (status === 'expired') {
    return 'muted'
  }
  return 'pending'
}

const EVENT_PENDING = ['order_created', 'issue_waiting_stock'] as const
const EVENT_SUCCESS = [
  'notify_ok',
  'paid_confirmed',
  'card_issued',
  'card_redeemed',
  'late_paid_recovered',
] as const
const EVENT_DANGER = ['notify_bad_amount', 'upstream_mismatch'] as const

/**
 * 事件 → 色调。
 *
 * 默认 `muted`：**不认识的事件不许被染成 success / danger**，因为这两个颜色会被用户读成结论
 * （「成功了」「出事了」）。新事件先按弱化色展示原文，等 App 认识了再加语义。
 */
export const eventToneOf = (event: string): TrailTone => {
  const name = event.trim().toLowerCase()
  if ((EVENT_SUCCESS as readonly string[]).includes(name)) {
    return 'success'
  }
  if ((EVENT_DANGER as readonly string[]).includes(name)) {
    return 'danger'
  }
  if ((EVENT_PENDING as readonly string[]).includes(name)) {
    return 'pending'
  }
  return 'muted'
}

// ------------------------------------------------------------------ 解析
/**
 * 单条时间线事件：**不筛事件名**。
 * `at` 认不出来 → null；`text` 原样保留（App 不认识这个事件时界面直接展示它）；
 * `backfilled` 只看 `detail.backfilled === true`（历史补录）。
 */
export const parseTrailEvent = (value: unknown): TrailEvent | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const detail = asRecord(record.detail) ?? {}
  const event = readString(record, ['event', 'type', 'name'])
  const text = readString(record, ['text', 'message', 'desc'])
  if (event === '' && text === '') {
    // 既没有事件名也没有文案：这条对用户没有任何信息量，丢掉
    return null
  }
  return {
    at: toSeconds(firstValue(record, ['at', 'time', 'created_at', 'createdAt'])),
    event,
    text,
    detail,
    backfilled: readBoolean(detail, ['backfilled', 'backfill']) === true,
  }
}

const parseTrailCard = (value: unknown): TrailCard | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const cardNo = readString(record, ['card_no', 'cardNo'])
  if (cardNo === '') {
    // 没有卡号 = 这一段没有卡密信息，别渲染一个空壳卡片骗用户「已发卡」
    return null
  }
  const rawState = readString(record, ['state', 'status']).toLowerCase()
  return {
    cardNo,
    points: Math.round(readNumber(record, ['points', 'plan_points', 'planPoints']) ?? 0),
    state: rawState === 'redeemed' ? 'redeemed' : 'issued',
    redeemedAt: toSeconds(firstValue(record, ['redeemed_at', 'redeemedAt'])),
    redeemedByCustomerId: (() => {
      const value = readNumber(record, ['redeemed_by_customer_id', 'redeemedByCustomerId'])
      if (value === null) {
        return null
      }
      const id = Math.floor(value)
      return Number.isSafeInteger(id) && id > 0 ? id : null
    })(),
    redeemedKeyTail: readString(record, ['redeemed_key_tail', 'redeemedKeyTail', 'key_tail']),
  }
}

/**
 * 单条订单解析：字段名以 snake_case 为准（服务端实际给的），camelCase 兜底。
 *
 * 安全默认值（任何一项坏了都不抛、不变成 NaN）：
 *  - 缺 out_trade_no → ''（保留这条记录，界面自己决定怎么显示）；不是对象的条目直接丢；
 *  - 金额 / 积分 / 时间非数字 → 0 / 0 / null；
 *  - status 非法 → 'failed'；status_text 缺失 → ''（界面回落到 i18n 文案）；
 *  - `timeline` 不是数组 → 空数组（**不是 undefined**，界面不用再判空）。
 */
export const parseTrailOrder = (value: unknown): TrailOrder | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const rawTimeline = record.timeline
  const timeline = Array.isArray(rawTimeline)
    ? rawTimeline.map(parseTrailEvent).filter((item): item is TrailEvent => item !== null)
    : []
  return {
    outTradeNo: readString(record, ['out_trade_no', 'outTradeNo', 'no']),
    planId: readString(record, ['plan_id', 'planId']),
    amountYuan: roundYuan(readNumber(record, ['amount_yuan', 'amountYuan', 'amount']) ?? 0),
    status: trailStatusOf(readString(record, ['status', 'state', 'order_status'])),
    statusText: readString(record, ['status_text', 'statusText']),
    createdAt: toSeconds(firstValue(record, ['created_at', 'createdAt', 'time'])),
    paidAt: toSeconds(firstValue(record, ['paid_at', 'paidAt', 'pay_time'])),
    expireAt: toSeconds(firstValue(record, ['expire_at', 'expireAt', 'expired_at'])),
    card: parseTrailCard(record.card),
    timeline,
    nextStep: readString(record, ['next_step', 'nextStep']),
  }
}

/**
 * 解析 `/api/trail` 响应。
 *
 * 防御口径：
 *  - 根不是对象 → null（调用方按 badResponse 报错，因为连结构都不对）；
 *  - `orders` 不是数组 → 当空列表（服务端改字段名时显示「没有记录」，而不是整页报错）；
 *  - `total` 缺失/非法 → 退化成这一页的条数（「还有没有下一页」不会凭空说「有」）。
 */
export const parseTrailPage = (
  value: unknown,
  fallback?: { limit: number; offset: number }
): TrailPage | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const rawOrders = record.orders
  const orders = Array.isArray(rawOrders)
    ? rawOrders.map(parseTrailOrder).filter((order): order is TrailOrder => order !== null)
    : []
  const offset = clampTrailOffset(readNumber(record, ['offset']) ?? fallback?.offset ?? 0)
  const totalRaw = readNumber(record, ['total'])
  const total = totalRaw === null ? orders.length : Math.max(0, Math.floor(totalRaw))
  return {
    customerId: parseCustomerIdFrom(record),
    total,
    limit: clampTrailLimit(readNumber(record, ['limit']) ?? fallback?.limit ?? TRAIL_DEFAULT_LIMIT),
    offset,
    totalPaidYuan: roundYuan(readNumber(record, ['total_paid_yuan', 'totalPaidYuan']) ?? 0),
    orders,
  }
}

/**
 * 解析 `/api/card/trail`：卡 → 订单 → 兑换三段。
 *
 * `redemption.redeemed === false` 时其它字段一律给安全默认值（0 / '' / null），
 * 界面用「还没兑换」一句话收口，不用逐字段判空。
 */
export const parseCardTrail = (value: unknown): CardTrail | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const cardNo = readString(record, ['card_no', 'cardNo'])
  if (cardNo === '') {
    return null
  }
  const redemption = asRecord(record.redemption) ?? {}
  const redeemed = readBoolean(redemption, ['redeemed']) === true
  return {
    cardNo,
    purchase: parseTrailOrder(record.purchase),
    redemption: {
      redeemed,
      at: redeemed ? toSeconds(firstValue(redemption, ['at', 'redeemed_at', 'redeemedAt'])) : null,
      points: redeemed ? Math.round(readNumber(redemption, ['points']) ?? 0) : 0,
      keyTail: redeemed ? readString(redemption, ['key_tail', 'keyTail']) : '',
      byMe: redeemed ? readBoolean(redemption, ['by_me', 'byMe']) : null,
      source: redeemed ? readString(redemption, ['source']) : '',
    },
  }
}

/** 还有下一页：offset + orders.length < total */
export function hasMoreTrail(page: Pick<TrailPage, 'total' | 'offset' | 'orders'>): boolean {
  const offset = Number.isFinite(page.offset) ? page.offset : 0
  const total = Number.isFinite(page.total) ? page.total : 0
  return offset + page.orders.length < total
}

// ------------------------------------------------------------------ 请求
const withBase = (base: string, path: string): URL =>
  new URL(`${base.replace(/\/+$/u, '')}${path}`)

const trailUrl = (base: string, limit: number, offset: number, status: TrailOrderStatus | null): string => {
  const url = withBase(base, TRAIL_PATH)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('offset', String(offset))
  // 不传 status 就**不加这个参数**（空 status= 少一种歧义）
  if (status !== null) {
    url.searchParams.set('status', status)
  }
  return url.href
}

const orderTrailUrl = (base: string, outTradeNo: string): string => {
  const url = withBase(base, ORDER_TRAIL_PATH)
  url.searchParams.set('out_trade_no', outTradeNo)
  return url.href
}

const cardTrailUrl = (base: string, cardNo: string): string => {
  const url = withBase(base, CARD_TRAIL_PATH)
  url.searchParams.set('card_no', cardNo)
  return url.href
}

/** Key 只在这里出现：请求头。URL 里只有业务参数。 */
const buildRequest = (url: string, apiKey: string): OursHttpRequest => ({
  method: 'GET',
  url,
  headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  timeoutMs: TRAIL_TIMEOUT_MS,
  followRedirects: false,
})

const errorFromResponse = (status: number, code: string): TrailError => {
  const detail = code === '' ? `HTTP_${status}` : code
  // 403 和 401 对用户是同一件事：这把 Key 看不到这些记录 —— 都要重新填 Key，重试没用。
  if (status === 401 || status === 403) {
    return new TrailError('unauthorized', 'API Key 无效或已过期，请重新填写 Key', { status, code: detail })
  }
  if (status === 404) {
    // 刻意不区分「没有这笔记录」与「这笔记录不是你的」：区分就等于送了个查单号的接口
    return new TrailError('notFound', '没有找到这笔记录', { status, code: detail })
  }
  if (status === 429) {
    return new TrailError('rateLimited', '请求过于频繁，请稍后重试', { status, code: detail })
  }
  if (status === 503) {
    return new TrailError('unavailable', '服务暂时不可用，请稍后重试', { status, code: detail })
  }
  if (status >= 500) {
    return new TrailError('server', '服务暂时不可用，请稍后重试', { status, code: detail })
  }
  return new TrailError('rejected', '服务端拒绝了这次请求', { status, code: detail })
}

const isUnavailable = (status: number, code: string): boolean => status === 503 || code === 'UNAVAILABLE'

/**
 * 发一次 GET 并把 body 解成 JSON；非 2xx 一律抛 `TrailError`。
 *
 * `retryOnUnavailable`：503 是「服务在维护」这种临时状况，自己再试一次（用户看不到抖动）；
 * 其它 5xx 不自动重放（真挂了重放也只是多打一次服务端，交给界面上的「重试」）。
 */
const requestParsed = async (
  url: string,
  apiKey: string,
  transport: OursTransport,
  retryOnUnavailable: boolean
): Promise<unknown> => {
  for (let attempt = 0; ; attempt += 1) {
    const result = await transport(buildRequest(url, apiKey))
    if (result.kind === 'timeout') {
      throw new TrailError('timeout', '请求超时了，可以再试一次')
    }
    if (result.kind === 'network') {
      throw new TrailError('network', '网络不可用，请检查网络后重试')
    }
    let payload: unknown = null
    try {
      payload = JSON.parse(result.text) as unknown
    } catch {
      payload = null
    }
    if (result.status >= 200 && result.status < 300) {
      return payload
    }
    const code = readString(asRecord(payload), ['code', 'error']).toUpperCase()
    if (isUnavailable(result.status, code) && retryOnUnavailable && attempt === 0) {
      continue
    }
    throw errorFromResponse(result.status, code)
  }
}

const requireKey = (apiKey: string): string => {
  const trimmed = apiKey.trim()
  if (trimmed === '') {
    throw new TrailError('keyMissing', '还没有填写 API Key')
  }
  return trimmed
}

const badResponse = (): TrailError => new TrailError('badResponse', '服务端返回的数据看不懂')

/**
 * 拉一页时间线：`GET {base}/api/trail?limit&offset&status` + `Authorization: Bearer <apiKey>`。
 *
 * 失败一律抛 `TrailError`：
 *  - 没填 Key → `keyMissing`（不发请求）；401/403 → `unauthorized`（要重新填 Key）；
 *  - 404 → `notFound`；503 → 自动重试 1 次后仍失败才 `unavailable`（**不是空列表**）；
 *  - 超时 / 连不上 → `timeout` / `network`；5xx → `server`；429 → `rateLimited`；
 *  - 2xx 但结构不对 → `badResponse`。
 */
export function fetchTrail(params: FetchTrailParams): Promise<TrailPage> {
  return fetchTrailVia(params, httpTransport, OURS_API_BASE)
}

/** 同上，但传输层与 base 可注入：单测断言「发了什么请求」，界面层只调 `fetchTrail`。 */
export async function fetchTrailVia(
  params: FetchTrailParams,
  transport: OursTransport,
  base: string = OURS_API_BASE
): Promise<TrailPage> {
  const apiKey = requireKey(params.apiKey)
  const limit = clampTrailLimit(params.limit)
  const offset = clampTrailOffset(params.offset)
  const status = params.status === null || params.status === undefined ? null : normalizeStatus(params.status)
  const payload = await requestParsed(trailUrl(base, limit, offset, status), apiKey, transport, true)
  const page = parseTrailPage(payload, { limit, offset })
  if (page === null) {
    throw badResponse()
  }
  return page
}

/** 按单号查一笔（`GET {base}/api/order/trail?out_trade_no=`）；传输层与 base 可注入。 */
export async function fetchOrderTrailVia(
  params: { apiKey: string; outTradeNo: string },
  transport: OursTransport,
  base: string = OURS_API_BASE
): Promise<TrailOrder> {
  const apiKey = requireKey(params.apiKey)
  const payload = await requestParsed(
    orderTrailUrl(base, params.outTradeNo.trim()),
    apiKey,
    transport,
    true
  )
  const order = parseTrailOrder(payload)
  if (order === null) {
    throw badResponse()
  }
  return order
}

/** 按卡号溯源（`GET {base}/api/card/trail?card_no=`）：这张卡怎么来的、被谁兑换了；传输层与 base 可注入。 */
export async function fetchCardTrailVia(
  params: { apiKey: string; cardNo: string },
  transport: OursTransport,
  base: string = OURS_API_BASE
): Promise<CardTrail> {
  const apiKey = requireKey(params.apiKey)
  const payload = await requestParsed(cardTrailUrl(base, params.cardNo.trim()), apiKey, transport, true)
  const trail = parseCardTrail(payload)
  if (trail === null) {
    throw badResponse()
  }
  return trail
}

/**
 * 付款记录（Issue #115）：`GET /api/orders` 的解析与拉取，外加「下单归属客户」（cid）的来源与缓存。
 *
 * 为什么需要 cid：`/buy?plan=<id>` 建单时后端要靠 `cid` 把订单挂到具体客户身上（实测
 * `/api/orders` 返回里就带 `customer_id`）。缺了它，付款成功后订单归属不明，App 这边一直
 * 看到「等待支付」——这就是 #115 那次 21:13 付款却显示未支付的直接原因。
 *
 * cid 从哪来（实测 2026-11-18，用真 Key 打过只读接口）：
 *  - `GET /api/orders`（Bearer Key）→ `{"customer_id": 10, ...}`：**唯一实测过的来源**；
 *  - 没有 Key（首购用户）时退回设备码通道：`GET <invite>/me?device_id=…`（邀请服务返回
 *    `customer_id`，`bind.ts` 的 `POST /bind` 也用它）——这条未在真机实测，失败就当拿不到。
 *
 * 本文件是纯逻辑（不碰 DOM / Capacitor），Node 单测直接 import；localStorage 一律注入。
 */
import type { OursMessageKey, OursTransport } from './api.js'
import { OURS_API_BASE } from './api.js'
import { maskCard } from './mask.js'
import { type OrderStorage } from './orderStore.js'
import { cacheCustomerId, parseCustomerId } from './customerId.js'

// 兼容既有调用方（api.ts / transport.ts / 单测）：cid 相关实现搬去 customerId.ts，
// 这里原样转发，避免为了绕模块环把 import 路径散到各处。
export {
  CUSTOMER_ID_STORAGE_KEY,
  cacheCustomerId,
  ensureCustomerId,
  fetchCustomerIdFromProfile,
  parseCustomerId,
  readCachedCustomerId,
  resetCustomerIdCache,
  setCustomerIdProvider,
  type CustomerIdProvider,
  type CustomerIdTransport,
} from './customerId.js'

/** 记录页最多展示 50 条（倒序，最新的在最前） */
export const PAYMENT_RECORDS_LIMIT = 50
/** 记录页三种展示态（服务端状态比这多，这里只分「等钱 / 成功 / 没成」三类） */
export type PaymentRecordStatus = 'pending' | 'completed' | 'expired'

export type PaymentRecord = {
  outTradeNo: string
  planId: string
  /** 金额（元；服务端给的是分，这里换算成元） */
  amountYuan: number
  status: PaymentRecordStatus
  /** 服务端原样状态（EXPIRED / FULFILLED …），排查用 */
  rawStatus: string
  /** 列表只用尾号（卡号后 4 位 + 掩码），完整卡密只给「查看卡密 / 去兑换」 */
  cardTail: string
  /** 完整卡密：只在单条详情里用，**不写日志、不进列表** */
  cardNo: string
  redeemed: boolean
  /** 下单时间（秒，服务端口径） */
  createdAt: number
  /** 支付时间（秒）；没付就是 null */
  paidAt: number | null
}

export type PaymentRecordsData = {
  customerId: number | null
  /** 服务端累计已支付（元） */
  totalPaidYuan: number
  orders: PaymentRecord[]
}

export type PaymentRecordsResult =
  | { kind: 'ok'; data: PaymentRecordsData }
  | { kind: 'error'; code: string; messageKey: OursMessageKey }

// ------------------------------------------------------------------ 小工具
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readString = (record: Record<string, unknown> | null, key: string): string => {
  const value = record === null ? undefined : record[key]
  return typeof value === 'string' ? value.trim() : ''
}

const readNumber = (record: Record<string, unknown> | null, key: string): number | null => {
  const value = record === null ? undefined : record[key]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/** 服务端时间两种写法都吃：秒（数字 / 数字串）或 ISO 字符串 */
const toSeconds = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.floor(value / 1000) : value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') {
      return null
    }
    if (/^\d+$/u.test(text)) {
      const seconds = Number(text)
      return seconds > 1e12 ? Math.floor(seconds / 1000) : seconds
    }
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null
  }
  return null
}

const firstTime = (record: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const seconds = toSeconds(record[key])
    if (seconds !== null) {
      return seconds
    }
  }
  return null
}

const STATUS_MAP: Record<string, PaymentRecordStatus> = {
  pending: 'pending',
  unpaid: 'pending',
  created: 'pending',
  create: 'pending',
  waiting: 'pending',
  processing: 'pending',
  paid: 'completed',
  success: 'completed',
  succeeded: 'completed',
  completed: 'completed',
  fulfilled: 'completed',
  delivered: 'completed',
  expired: 'expired',
  timeout: 'expired',
  failed: 'expired',
  failure: 'expired',
  cancelled: 'expired',
  canceled: 'expired',
  closed: 'expired',
  refunded: 'expired',
}

/** 服务端状态 → 三态展示（认不出的按「待支付」，原文留在 rawStatus 里） */
export const paymentStatusOf = (raw: string): PaymentRecordStatus =>
  STATUS_MAP[raw.trim().toLowerCase()] ?? 'pending'

const parseAmountYuan = (record: Record<string, unknown>): number => {
  const fen = readNumber(record, 'amount_fen')
  if (fen !== null) {
    return Math.round(fen) / 100
  }
  const yuan = readNumber(record, 'amount_yuan') ?? readNumber(record, 'amount') ?? 0
  return Math.round(yuan * 100) / 100
}

const parseRecord = (value: unknown): PaymentRecord | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const outTradeNo =
    readString(record, 'out_trade_no') || readString(record, 'outTradeNo') || readString(record, 'no')
  if (outTradeNo === '') {
    return null
  }
  const rawStatus =
    readString(record, 'status') || readString(record, 'state') || readString(record, 'order_status')
  const cardNo = readString(record, 'card_no') || readString(record, 'cardNo')
  const redeemedAt = toSeconds(record.redeemed_at)
  return {
    outTradeNo,
    planId: readString(record, 'plan_id') || readString(record, 'planId'),
    amountYuan: parseAmountYuan(record),
    status: paymentStatusOf(rawStatus),
    rawStatus,
    cardTail: cardNo === '' ? '' : maskCard(cardNo),
    cardNo,
    redeemed: record.redeemed === true || redeemedAt !== null,
    createdAt: firstTime(record, ['created_at', 'createdAt', 'started_at', 'time']) ?? 0,
    paidAt: firstTime(record, ['paid_at', 'paidAt', 'pay_time', 'paid_time']),
  }
}

/**
 * 解析 `/api/orders` 响应。
 *
 * 实测真实响应（该账号还没有已支付订单，2026-11-18）：
 *   `{"customer_id": 10, "total_paid_yuan": 0.0, "orders": []}`
 * `orders` 元素的字段名**没有实测样本**（列表为空），所以这里按 `/api/order` 已核实的
 * 字段名（`out_trade_no` / `status` / `amount_fen` / `card_no`）为主、常见别名兜底；
 * 「元素字段名未实测」这一点已写进 Issue #115。
 */
export const parsePaymentRecords = (value: unknown): PaymentRecordsData | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const rawOrders = record.orders
  if (!Array.isArray(rawOrders)) {
    return null
  }
  const orders = rawOrders
    .map(parseRecord)
    .filter((item): item is PaymentRecord => item !== null)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const at = a.item.paidAt ?? a.item.createdAt
      const bt = b.item.paidAt ?? b.item.createdAt
      return bt === at ? a.index - b.index : bt - at
    })
    .slice(0, PAYMENT_RECORDS_LIMIT)
    .map((entry) => entry.item)
  const total = readNumber(record, 'total_paid_yuan') ?? readNumber(record, 'totalPaidYuan') ?? 0
  return {
    customerId: parseCustomerId(record.customer_id ?? record.customerId),
    totalPaidYuan: Math.round(total * 100) / 100,
    orders,
  }
}

// ------------------------------------------------------------------ 拉取
const ordersUrl = (base: string): string => `${base.replace(/\/+$/u, '')}/api/orders`

/**
 * 拉付款记录：`GET /api/orders` + `Authorization: Bearer <apiKey>`。
 *
 * 两账号隔离靠的就是这个 Key：别人的 Key 拿不到我的订单（服务端按 Key 认客户），
 * Key 无效一律 401 `UNAUTHORIZED` —— 这里必须如实报错，不能糊成「没有订单」。
 */
export const fetchPaymentRecords = async (
  apiKey: string,
  transport: OursTransport,
  storage?: OrderStorage | null,
  base: string = OURS_API_BASE
): Promise<PaymentRecordsResult> => {
  const key = apiKey.trim()
  if (key === '') {
    return { kind: 'error', code: 'API_KEY_MISSING', messageKey: 'oursErrKeyMissing' }
  }
  const result = await transport({
    method: 'GET',
    url: ordersUrl(base),
    headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    timeoutMs: 10000,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: result.kind === 'timeout' ? 'oursErrTimeout' : 'oursErrNetwork',
    }
  }
  let parsed: unknown = null
  try {
    parsed = JSON.parse(result.text) as unknown
  } catch {
    parsed = null
  }
  if (result.status >= 200 && result.status < 300) {
    const data = parsePaymentRecords(parsed)
    if (data === null) {
      return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse' }
    }
    if (data.customerId !== null) {
      cacheCustomerId(data.customerId, storage)
    }
    return { kind: 'ok', data }
  }
  const body = asRecord(parsed)
  const code = (readString(body, 'code') || `HTTP_${result.status}`).toUpperCase()
  if (code === 'UNAUTHORIZED' || result.status === 401) {
    return { kind: 'error', code: 'UNAUTHORIZED', messageKey: 'oursErrUnauthorized' }
  }
  if (code === 'FORBIDDEN' || result.status === 403) {
    return { kind: 'error', code: 'FORBIDDEN', messageKey: 'oursErrForbidden' }
  }
  return { kind: 'error', code, messageKey: 'oursErrInvalidResponse' }
}

/**
 * 「下单属于哪个客户」（cid / customer_id）的解析与缓存（Issue #115）。
 *
 * 为什么单独一个文件：`api.ts`（下单要拼 cid）和付款记录（`GET /api/orders` 顺带把
 * customer_id 带回来）都要用它，而两边互不依赖才是干净的分层。`api.ts` 已经 import 本文件，
 * 如果本文件反过来 import `api.ts` 就成了模块环（oxlint import/no-cycle 直接报错），
 * 所以这里只用**结构兼容的最小传输形状**，不 import 那边的类型。
 *
 * 取值顺序：内存 → localStorage（上次拿到的就记住，下单不必再等一次往返）→ 注入的 provider。
 * provider 由 main.tsx 在启动时注入：有 API Key 走 `GET /api/orders`，没有 Key 走设备码 `/me`。
 * 全都拿不到就返回 null —— 调用方必须**拒绝下单**，绝不能发一次不带 cid 的 /buy
 * （那会建出一张不知道属于谁的单，用户付了钱 App 还一直显示「等待支付」）。
 */

import { browserStorage, type OrderStorage } from './orderStore.js'

/** cid 缓存键：拿到过就记住，下次下单直接用，不必再等一次网络往返 */
export const CUSTOMER_ID_STORAGE_KEY = 'chat-demo:ours-customer-id'

/**
 * 只用到「发一个 GET 拿 JSON」的最小传输形状：结构上与 api.ts 的 `OursTransport` 兼容
 * （那边只是多了 POST / followRedirects 等字段），但故意不 import 它 —— 见文件头。
 */
export type CustomerIdTransport = (request: {
  method: 'GET'
  url: string
  headers: Record<string, string>
  timeoutMs: number
  followRedirects: boolean
}) => Promise<
  | { kind: 'response'; status: number; text: string }
  | { kind: 'timeout' }
  | { kind: 'network' }
>

// ------------------------------------------------------------------ 小工具
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const storageOrBrowser = (storage?: OrderStorage | null): OrderStorage | null =>
  storage === undefined ? browserStorage() : storage

/** 归属客户编号：/api/orders 的 `customer_id`（也可能是数字串） */
export const parseCustomerId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value)
  }
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim())
    return parsed > 0 ? parsed : null
  }
  return null
}

export const readCachedCustomerId = (storage?: OrderStorage | null): number | null => {
  const target = storageOrBrowser(storage)
  if (target === null) {
    return null
  }
  try {
    return parseCustomerId(target.getItem(CUSTOMER_ID_STORAGE_KEY))
  } catch {
    return null
  }
}

export const cacheCustomerId = (customerId: number | null, storage?: OrderStorage | null): void => {
  const target = storageOrBrowser(storage)
  if (target === null) {
    return
  }
  try {
    if (customerId === null) {
      target.removeItem(CUSTOMER_ID_STORAGE_KEY)
      return
    }
    target.setItem(CUSTOMER_ID_STORAGE_KEY, String(customerId))
  } catch {
    // 存不了就算了：下一次下单还会重新解析
  }
}

/** 由 main.tsx 在启动时注入：先查 /api/orders，没有 Key 再问邀请服务 /me */
export type CustomerIdProvider = () => Promise<number | null>

let provider: CustomerIdProvider | null = null
let resolved: number | null | undefined

export const setCustomerIdProvider = (next: CustomerIdProvider | null): void => {
  provider = next
  resolved = undefined
}

/** 单测 / 换账号用：清掉内存里记住的那一份 */
export const resetCustomerIdCache = (): void => {
  resolved = undefined
}

/**
 * 拿 cid：内存 → localStorage → 注入的 provider（一次）。拿不到返回 null，
 * 调用方必须**不要**发不带 cid 的 /buy（见 `startCheckout`）。
 */
export const ensureCustomerId = async (storage?: OrderStorage | null): Promise<number | null> => {
  const cached = readCachedCustomerId(storage)
  if (cached !== null) {
    resolved = cached
    return cached
  }
  if (resolved !== undefined) {
    return resolved
  }
  if (provider === null) {
    return null
  }
  let fresh: number | null = null
  try {
    fresh = await provider()
  } catch {
    fresh = null
  }
  resolved = fresh
  if (fresh !== null) {
    cacheCustomerId(fresh, storage)
  }
  return fresh
}

/**
 * 设备码通道取 cid（没有 API Key 的首购用户）：`GET <base>/me?device_id=…`。
 *
 * base 由调用方传入（main.tsx 用 `INVITE_API_BASE`），这样本文件不必 import 邀请模块
 * （邀请 api.ts 反过来 import 本通道的 api.ts，硬连会成环）。
 * 任何失败都只返回 null：拿不到 cid 时「去支付」会明确报错，而不是悄悄发一次不带 cid 的下单。
 */
export const fetchCustomerIdFromProfile = async (input: {
  base: string
  deviceId: string
  transport: CustomerIdTransport
}): Promise<number | null> => {
  const deviceId = input.deviceId.trim()
  if (deviceId === '') {
    return null
  }
  try {
    const result = await input.transport({
      method: 'GET',
      url: `${input.base.replace(/\/+$/u, '')}/me?device_id=${encodeURIComponent(deviceId)}`,
      headers: { Accept: 'application/json' },
      timeoutMs: 10000,
      followRedirects: false,
    })
    if (result.kind !== 'response' || result.status < 200 || result.status >= 300) {
      return null
    }
    const record = asRecord(JSON.parse(result.text) as unknown)
    return parseCustomerId(record === null ? null : (record.customer_id ?? record.customerId))
  } catch {
    return null
  }
}

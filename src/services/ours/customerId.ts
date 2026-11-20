/**
 * 「订单属于哪个客户」（cid / customer_id）的解析与缓存（Issue #115）。
 *
 * 为什么单独一个文件：付款记录 / 购买记录（`GET /api/orders` 顺带把 customer_id 带回来）
 * 与业务层都要用它，而两边互不依赖才是干净的分层。如果本文件反过来 import `api.ts`
 * 就成了模块环（oxlint import/no-cycle 直接报错），所以这里只用**结构兼容的最小传输形状**。
 *
 * Issue #331 之后下单链路已停用（我们不建单）：cid 不再用来「归属新订单」，
 * 只用来查历史订单/付款记录。取值顺序仍是：内存 → localStorage → 注入的 provider；
 * provider 由 main.tsx 在启动时注入，只走 `GET /api/orders`（#590 删掉了没有 Key 时的旧设备码兜底）。
 * 全都拿不到就返回 null —— 调用方按「查不到记录」处理，不再阻断任何购买流程。
 */

import { recordAction } from '../diagnostics/collector.js'
import { buildMeta } from '../diagnostics/fields.js'
import { browserStorage, type OrderStorage } from './storage.js'

/** cid 缓存键：拿到过就记住，下次下单直接用，不必再等一次网络往返 */
export const CUSTOMER_ID_STORAGE_KEY = 'chat-demo:ours-customer-id'

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
 * 拿 cid：内存 → localStorage → 注入的 provider（一次）。拿不到返回 null。
 * #331 之后 cid 只用来查自己的历史订单（`/api/orders?cid=`）——不建单、不查单，
 * 所以拿不到 cid 不再是「不能付款」，只是「看不到历史」。
 */
export const ensureCustomerId = async (storage?: OrderStorage | null): Promise<number | null> => {
  /** cid 的来源：命中缓存 / 本会话已解析 / 这次现问 provider / 一个都没有 */
  type CidSource = 'cache' | 'memory' | 'provider' | 'none'
  /**
   * 出口埋点（#312）：cid 是「这笔订单是谁的」的唯一凭证。旧链路里拿不到 cid 会**拦住下单**
   * 并报 CUSTOMER_ID_MISSING；#331 之后下单已下线，缺 cid 只意味着「历史订单认不出主人」，
   * 所以这里记的是「有没有、从哪来」，不是「拦没拦」。
   * 只记来源与有无：cid 本身是客户编号（可识别信息），不进日志。
   */
  const settle = (customerId: number | null, source: CidSource, reason?: string): number | null => {
    recordAction('nav', 'ours-customer-id', {
      ...buildMeta({ stage: 'quota.cid' }),
      result: customerId === null ? 'missing' : 'ok',
      source,
      fromCache: source === 'cache' || source === 'memory',
      ...(reason === undefined ? {} : { reason }),
    })
    return customerId
  }
  const cached = readCachedCustomerId(storage)
  if (cached !== null) {
    resolved = cached
    return settle(cached, 'cache')
  }
  if (resolved !== undefined) {
    return settle(resolved, 'memory')
  }
  if (provider === null) {
    return settle(null, 'none', 'no-provider')
  }
  let fresh: number | null = null
  let threw = false
  try {
    fresh = await provider()
  } catch {
    fresh = null
    threw = true
  }
  // Issue #135：只记住**成功**的结果。失败（启动时还没网、设备还没绑定、还没领 Key）
  // 以前会被记成「这个会话没有 cid」，之后每次点「去支付」都被直接拒绝，直到重启 App。
  resolved = fresh === null ? undefined : fresh
  if (fresh !== null) {
    cacheCustomerId(fresh, storage)
  }
  return settle(
    fresh,
    fresh === null ? 'none' : 'provider',
    fresh === null ? (threw ? 'provider-error' : 'provider-empty') : undefined
  )
}

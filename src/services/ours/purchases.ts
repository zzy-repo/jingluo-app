/**
 * 「我的购买」数据层（Issue #158）：`GET /api/orders` 的分页 / 筛选 / 解析。
 *
 * 本文件是**唯一**的接口与类型定义处，界面那一半（另一 PR）只 import 这里，不重复定义。
 * 纯逻辑：不碰 DOM / React，也不 import i18n —— 错误只给 `kind`，文案由界面层按自己的 key 决定。
 *
 * 服务端契约（Issue #158，2026-11-19）：
 *   GET {base}/api/orders?limit=20&offset=0&status=
 *     Authorization: Bearer <apiKey>          ← Key 只走请求头，**永不进 query**
 *   → { customer_id, total, limit, offset, total_paid_yuan, orders: [...] }
 *
 * 安全约束（硬性）：
 *   - Key 只放 `Authorization` 头；
 *   - 日志 / 错误原文里不出现完整 Key，卡号最多露后 4 位（`maskCardNo`）。
 */
import { maskCard } from './mask.js'
import { OURS_API_BASE } from './api.js'
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
  statusText: string
  cardNo: string | null
  cardStatus: 'leased' | 'used' | 'void' | null
  redeemState: 'issued' | 'redeemed' | null
  createdAt: number
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
  limit?: number
  offset?: number
  status?: PurchaseStatus | null
}

/** 拉一页购买记录；失败抛 `PurchaseError`（kind 可区分「要重填 Key」与「可重试」） */
export function fetchPurchases(params: FetchPurchasesParams): Promise<PurchasePage> {
  void params
  void httpTransport
  void OURS_API_BASE
  throw new Error('fetchPurchases: TODO(#158 数据层实现)')
}

/** 卡号只显示后 4 位 */
export function maskCardNo(cardNo: string | null): string {
  void maskCard
  return cardNo === null ? '' : ''
}

/** 还有下一页：offset + orders.length < total */
export function hasNextPage(page: PurchasePage): boolean {
  void page
  return false
}

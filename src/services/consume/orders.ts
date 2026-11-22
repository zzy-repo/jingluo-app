/**
 * 「我的卡密」的**唯一数据源**（Issue #834）：`GET /api/v1/payment/orders/my`（JWT，面板通道）。
 *
 * 为什么换（#834）：旧数据源是 apia 的 `GET /api/orders`（`services/ours/purchases.ts`，
 * `Authorization: Bearer <sk- Key>`）。账号迁到 sub2api 之后，那把 Key 在 apia 眼里根本不存在 ——
 * 实测拿真 sub2api Key 打旧接口一律 **401 `UNAUTHORIZED` / 「API Key 无效」**，
 * 于是「我的卡密」空列表、自动兑现更是一个请求都发不出去（#784 的静默失效）。
 * 新接口用**登录态 JWT**，与兑换（`POST /api/v1/redeem`）、资料（`GET /api/v1/user/profile`）
 * 同一条通道，所以本模块走既有 `http.call()`（共享 client），不另建一套客户端。
 *
 * ## 服务端契约（#834 票面，2026-11-22）
 *
 * ```
 * GET /api/v1/payment/orders/my?page=1&page_size=20      Authorization: Bearer <JWT>
 * → { code: 0, data: { items: [...], total, page, page_size, pages } }
 * ```
 *
 * 每条订单（本项目只读这几项）：`out_trade_no`、`status`（`COMPLETED` / `PENDING` / `EXPIRED` …）、
 * `amount`（**到账额度，元**）、`pay_amount`（实付，元）、`created_at`、`paid_at`、`payment_type`、
 * 以及 **`recharge_code`（订单对应的卡号，只有 `status=COMPLETED` 才返回）**。
 *
 * 旧订单已导入，其 `payment_type = legacy_cardpay`；**没有 `plan_name`，也没有「卡是否已兑换」** ——
 * 所以：
 *   - 界面不读 `plan_name` / `status_text`，状态文案自己按 `status` 映射（`myCardsListView.ts`）；
 *   - 「这张卡兑没兑过」只能拿 `GET /api/v1/redeem/history` 按卡号交叉比对（`walletAutoRedeem.ts`）；
 *   - `recharge_code` 缺失是**正常形态**（非 COMPLETED 的订单本来就没有），解析成 `null`，不报错。
 *
 * ## 两条硬约束
 *
 *  1. **#209 能力探测**：不假设任何字段存在 —— `recharge_code` / `paid_at` 缺了就是 `null`，
 *     数字认不出就是 0，条目不是对象就丢掉，**不抛错、不产生 NaN**；
 *  2. **卡号只做展示与提交**：解析后原样留在内存里，界面用 `maskCardNo()` 打码（`maskCardNo` 是
 *     `services/ours/purchases.ts` 里的既有实现，这里不再写第二份遮蔽口径）；日志里只出现尾 4 位。
 *
 * 纯逻辑（不碰 DOM / React / i18n），裸 Node 可 import —— 解析与容错都在单测里钉住。
 */
import type { ConsumeCallResult, ConsumeHttp } from './http.js'

// ------------------------------------------------------------------ 类型（界面依赖这些名字）

/**
 * 一条「我的订单」。
 *
 * 字段名用 camelCase（TS 惯例），来源是服务端的 snake_case：`out_trade_no` → `outTradeNo`、
 * `recharge_code` → `rechargeCode`（**去重键就是 `outTradeNo`，语义等价于旧契约里的「订单号」**）。
 */
export type ConsumeMyOrder = {
  /** `out_trade_no`：一单一条，自动兑现的本地去重键 */
  outTradeNo: string
  /** 服务端原样状态字（大写枚举）；认不出就用原文，判定只认 `COMPLETED` */
  status: string
  /** **到账额度**（元）：卡密的面值，不是实付 */
  amountYuan: number
  /** 实付金额（元）；缺失就是 0（界面不拿它做任何判断） */
  payAmountYuan: number
  /** unix 秒；认不出来 = 0（界面按 0 显示空串，不显示 1970） */
  createdAt: number
  /** unix 秒；没付款 / 没这个字段 = null */
  paidAt: number | null
  /** `legacy_cardpay` 表示「旧订单导入」，其余是正常支付渠道 */
  paymentType: string
  /** 订单对应的卡号；**只有 `status=COMPLETED` 才可能有**，缺失 / 空串一律 null */
  rechargeCode: string | null
  /**
   * 卡密的兑换状态（#840）：`issued` 已发放未兑换、`redeemed` 已兑换、
   * `void` 已作废、`expired` 已过期。
   *
   * 契约上这是**可选**字段（#834 的 orders/my 原本不回答「兑没兑过」，#840 起才补上），
   * 所以老服务端 / 认不出的值时**这个键根本不出现**（不是 `null`）—— 与 `redeemable` 同一口径：
   * 「服务端没表态」就少一个键，界面沿用「有卡号就能兑」的老判定（`isOrderRedeemable`）。
   */
  redeemState?: MyOrderRedeemState
  /**
   * 服务端说的「这张卡现在可以直接兑换」。
   * **契约里只在 `true` 时出现**；缺失（`undefined`）= 服务端不表态，由界面按 `redeemState` 判。
   */
  redeemable?: boolean
}

/** 卡密兑换状态（与后端 `redeem_state` 一一对应，#840） */
export type MyOrderRedeemState = 'issued' | 'redeemed' | 'void' | 'expired'

export type ConsumeMyOrdersPage = {
  items: ConsumeMyOrder[]
  total: number
  page: number
  pageSize: number
  pages: number
}

export type ConsumeMyOrdersQuery = {
  /** 默认 1，非正整数按 1 */
  page?: number
  /** 默认 20，夹到 1..100 */
  pageSize?: number
}

// ------------------------------------------------------------------ 常量

/** 唯一「已完成」状态字：只有它能带卡号，也只有它能自动兑 */
export const MY_ORDER_COMPLETED = 'COMPLETED'

/** 每页默认条数（服务端默认也是 20） */
export const MY_ORDERS_DEFAULT_PAGE_SIZE = 20

/** 认识的 `redeem_state`（#840）：认不出的值一律 `null`，当成「服务端没表态」，不猜 */
export const MY_ORDER_REDEEM_STATES: readonly MyOrderRedeemState[] = [
  'issued',
  'redeemed',
  'void',
  'expired',
]

/** 服务端上限：超过一律夹到 100（与 `keys` / `usage` 的分页口径一致） */
export const MY_ORDERS_MAX_PAGE_SIZE = 100

// ------------------------------------------------------------------ 小工具（防御式读取，与 #158 同一套口径）

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
 * 数字：真数字、或**纯数字串**都认；其它（null / "abc" / NaN / 对象）一律 null。
 * 调用方用显式默认值收口，所以非数字永远不会变成 NaN 漏到界面上。
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

/**
 * 时间：接受秒 / 毫秒 / 数字串 / ISO 字符串（服务端给的是 RFC3339 带时区的字符串）。
 * 认不出来就是 null —— 时间只是展示，缺了不该让整条订单作废。
 */
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

/** 下单时间：认不出来就是 0（界面按 0 显示空串 —— 不显示一个来路不明的 1970） */
const createdAtOf = (record: Record<string, unknown>): number => {
  const seconds = toSeconds(firstValue(record, ['created_at', 'createdAt']))
  return seconds === null ? 0 : seconds
}

/** 分页兜底：调用方给的请求分页（`parseMyOrdersPage` 的第二参），没给就是默认值 */
const requestedPage = (fallback?: { page: number; pageSize: number }): number => {
  if (fallback === undefined) {
    return 1
  }
  return fallback.page
}

const requestedPageSize = (fallback?: { page: number; pageSize: number }): number => {
  if (fallback === undefined) {
    return MY_ORDERS_DEFAULT_PAGE_SIZE
  }
  return fallback.pageSize
}

const clampPage = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1
  }
  const page = Math.floor(value)
  return page > 0 ? page : 1
}

const clampPageSize = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MY_ORDERS_DEFAULT_PAGE_SIZE
  }
  const size = Math.floor(value)
  if (size <= 0) {
    return MY_ORDERS_DEFAULT_PAGE_SIZE
  }
  return Math.min(size, MY_ORDERS_MAX_PAGE_SIZE)
}

// ------------------------------------------------------------------ 解析

/** 订单是不是「已完成」：判定只认大写枚举，原文大小写不敏感（服务端给的一直是大写） */
export const isCompletedOrder = (order: Pick<ConsumeMyOrder, 'status'>): boolean =>
  order.status.trim().toUpperCase() === MY_ORDER_COMPLETED

/** `redeem_state` 解析：只认四个已知值（顺序即优先级不需要 —— 它是枚举，不是标志位），别的一律 null */
const parseRedeemState = (raw: string): MyOrderRedeemState | null => {
  const normalized = raw.trim().toLowerCase()
  return MY_ORDER_REDEEM_STATES.find((state) => state === normalized) ?? null
}

/**
 * 这张卡现在能不能「去兑换」（#840 关闭条件 5）。
 *
 * 口径（与后端契约 `redeem_state` / `redeemable` 一一对应）：
 *   · `void`（已作废）/ `expired`（已过期）/ `redeemed`（已兑换）→ **一概不给兑换入口**；
 *   · `redeemable === true`（服务端明确说能兑）→ 给；
 *   · `redeemable === false`（服务端明确说不能兑）→ 不给；
 *   · 两个字段都没有（老服务端 / #834 时期的 response）→ 沿用「有卡号就能兑」的老判定，
 *     否则这条改动会把所有未兑换的卡都锁死；
 *   · 没有卡号（非 COMPLETED 订单）→ 不给（本来也没有可提交的东西）。
 */
export const isOrderRedeemable = (order: ConsumeMyOrder): boolean => {
  if (rechargeCodeOf(order) === '') {
    return false
  }
  if (order.redeemState === 'void' || order.redeemState === 'expired' || order.redeemState === 'redeemed') {
    return false
  }
  if (order.redeemable === true) {
    return true
  }
  if (order.redeemable === false) {
    return false
  }
  return true
}

/**
 * 单条订单解析：字段名以 snake_case 为准（服务端实际给的），camelCase 兜底。
 *
 * 安全默认值（任何一项坏了都不抛、不变成 NaN）：
 *  - 不是对象的条目 → null（调用方丢掉它，继续解析剩下的）；
 *  - 缺 `out_trade_no` → ''（保留这条记录：界面自己决定能不能操作）；
 *  - `amount` / `pay_amount` / 时间非数字 → 0 / 0 / 0；`paid_at` 缺失才是 null；
 *  - **`recharge_code` 缺失 → null**（这正是非 COMPLETED 订单的正常形态，不是错误）；
 *  - **`status` 不是 COMPLETED → `rechargeCode` 一律 null**（卡号只属于已完成的订单，见下面那条注释）。
 */
export const parseMyOrder = (value: unknown): ConsumeMyOrder | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const status = readString(record, ['status', 'state'])
  const rawCode = readString(record, ['recharge_code', 'rechargeCode'])
  const amountYuan = readNumber(record, ['amount', 'amount_yuan', 'amountYuan'])
  const payAmountYuan = readNumber(record, ['pay_amount', 'payAmount'])
  // #840：`redeemable` 契约上是「只在 true 时出现」；显式 false 也认，**缺失留 undefined**
  // （把「缺失」当 false 会让所有未兑换的卡都长不出兑换按钮）
  const redeemable = record.redeemable === true ? true : record.redeemable === false ? false : undefined
  const redeemState = parseRedeemState(readString(record, ['redeem_state', 'redeemState']))
  return {
    outTradeNo: readString(record, ['out_trade_no', 'outTradeNo']),
    status,
    amountYuan: roundYuan(amountYuan === null ? 0 : amountYuan),
    payAmountYuan: roundYuan(payAmountYuan === null ? 0 : payAmountYuan),
    createdAt: createdAtOf(record),
    paidAt: toSeconds(firstValue(record, ['paid_at', 'paidAt'])),
    paymentType: readString(record, ['payment_type', 'paymentType']),
    // **卡号只属于「已完成」的订单**：契约里服务端只在 COMPLETED 才给 `recharge_code`，
    // 客户端这边也不允许别的状态带卡号（真出现就是服务端 bug，按「还没有卡」处理更安全 ——
    // 既不会把没付钱的卡展示给用户，也不会让自动兑现去兑一张未完成的单）
    rechargeCode: rawCode === '' || !isCompletedOrder({ status }) ? null : rawCode,
    // #840：`redeem_state` 认不出 / 缺失 → 不带这个键（老服务端不回答这件事，别假装它答了 null）
    ...(redeemState === null ? {} : { redeemState }),
    ...(redeemable === undefined ? {} : { redeemable }),
  }
}

/**
 * 解析 `GET /api/v1/payment/orders/my` 的信封（`http.call()` 已经把 `{code,data}` 拆到 `data` 这一层）。
 *
 * 防御口径（#209）：
 *  - 根不是对象 → null（连结构都不对，调用方按「响应异常」报错）；
 *  - `items` 不是数组 → 空列表（服务端改字段时界面显示「没有记录」，而不是整页报错）；
 *  - `total` 缺失/非法 → 退化成这一页的条数（这样「还有没有下一页」不会凭空说「有」）；
 *  - `page` / `page_size` / `pages` 非法 → 回落到请求时的分页 + 用 total 算。
 */
export const parseMyOrdersPage = (
  value: unknown,
  fallback?: { page: number; pageSize: number }
): ConsumeMyOrdersPage | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const rawItems = record.items
  const items = Array.isArray(rawItems)
    ? rawItems
        .map(parseMyOrder)
        .filter((order): order is ConsumeMyOrder => order !== null)
    : []
  const pageRaw = readNumber(record, ['page'])
  const page = clampPage(pageRaw === null ? requestedPage(fallback) : pageRaw)
  const pageSizeRaw = readNumber(record, ['page_size', 'pageSize'])
  const pageSize = clampPageSize(pageSizeRaw === null ? requestedPageSize(fallback) : pageSizeRaw)
  const totalRaw = readNumber(record, ['total'])
  const total = totalRaw === null ? items.length : Math.max(0, Math.floor(totalRaw))
  const pagesRaw = readNumber(record, ['pages'])
  const pages =
    pagesRaw === null ? (total === 0 ? 1 : Math.ceil(total / pageSize)) : Math.max(1, Math.floor(pagesRaw))
  return { items, total, page, pageSize, pages }
}

/**
 * 取「订单上的完整卡号」：非空且存在才算；缺失 / 空串 / 只有空白 → ''。
 * **不打码、不改写** —— 打码是展示层的事（`maskCardNo`），这里交出的是服务端给的那份原值。
 */
export const rechargeCodeOf = (order: Pick<ConsumeMyOrder, 'rechargeCode'>): string => {
  if (order.rechargeCode === null) {
    return ''
  }
  return order.rechargeCode.trim()
}

// ------------------------------------------------------------------ 拉取

/** 一页订单（只读，可重试；重试策略由调用方决定，本层只发一次） */
export const listMyOrders = (
  http: ConsumeHttp,
  query: ConsumeMyOrdersQuery = {}
): Promise<ConsumeCallResult<ConsumeMyOrdersPage>> => {
  const page = clampPage(query.page)
  const pageSize = clampPageSize(query.pageSize)
  return http
    .call<unknown>({
      method: 'GET',
      path: '/api/v1/payment/orders/my',
      query: { page, page_size: pageSize },
      timeout: 'read',
    })
    .then((result) => {
      if (!result.ok) {
        return result
      }
      const parsed = parseMyOrdersPage(result.data, { page, pageSize })
      if (parsed === null) {
        // 2xx 但信封不对：**不当成功**（否则界面显示空列表而不是「响应异常」）#487 的既有口径
        return {
          ok: false as const,
          error: {
            kind: 'unknown' as const,
            code: 'ORDERS_MY_BAD_RESPONSE',
            message: 'unexpected orders/my payload',
            status: result.status,
            retryable: false,
            envelope: 'panel' as const,
            i18nKey: 'consumeErrInvalidResponse' as const,
          },
          raw: result.raw,
        }
      }
      return { ...result, data: parsed }
    })
}

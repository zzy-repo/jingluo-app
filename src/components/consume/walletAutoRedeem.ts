/**
 * #784「付款回来 → 自动兑现卡密进账号余额」的**最小闭环**（纯逻辑 + 本地去重 + 埋点，裸 Node 可测）。
 *
 * 触发点只有一个：`openPayLinkInApp(url, onClosed)` 的 `onClosed`（= 用户从联动小铺收款页回到 App）。
 * 进钱包页 / 进卡密页 / 挂载组件**都不许触发** —— 那不是「付款回来」，只是「用户在看余额」。
 *
 * ## 数据源（#834 起：**必须**是 `GET /api/v1/payment/orders/my`）
 *
 * #834 之前这里打的是 apia 的 `GET /api/orders`（`fetchPurchases`，`Authorization: Bearer <sk- Key>`）。
 * 账号迁到 sub2api 之后，那把 Key 在 apia 侧根本不存在 —— 实测拿真 sub2api Key / 真 JWT 打旧接口
 * 一律 `401 UNAUTHORIZED`「API Key 无效」。于是自动兑现**一个请求都发不出去，且没有任何报错**
 * （这正是 #834 要求在本单里连带修掉的事）。现在它与「我的卡密」共用同一个数据源：
 * `consume.orders.my()`（`src/services/consume/orders.ts`，JWT 面板通道），所以**迁移后还能用**。
 *
 * ## 待兑判据（#834 的新契约）
 *
 * `status === 'COMPLETED'`（服务端大写枚举）**且** `recharge_code` 非空**且没被打码**。
 *
 * 为什么不再有 `redeemState === 'issued'`：新接口**不提供「这张卡兑没兑过」**（票面原文）。
 * 所以「已兑过就跳过」这一条改由既有 `GET /api/v1/redeem/history` 按卡号交叉比对
 * （`services/consume/redeem.ts: matchesRedeemCode`，同一套归一化 + 尾 4 位口径）：
 * 命中 → 这张卡已经在账号里了，不再提交；历史**读不到**是整个链路唯一「不可知」的场合，
 * 按既有口径**不猜**（`skipped: history-unknown`，不发请求）。
 *
 * 兑换本身**一行都不重写**：四态判定、超时先查 `/redeem/history` 核对、`409 REDEEM_CODE_LOCKED` = 处理中、
 * `202` / `status:accepted` = 受理未到账、到账后重拉 `/user/profile` 刷新 `balance` ——
 * 全部复用 `services/consume/redeem.ts` 与 `myCardsModel.ts:afterRedeemed()`。
 * 本文件只做「**该不该发这一枪**」和「发完以后告诉界面什么」。
 *
 * 四条硬约束（钱相关，逐条对应 #784）：
 *
 *  1. **本地按订单去重**：同一张卡（同一单）第二次进入不再提交。落盘的是**指纹**
 *     （`out_trade_no` 优先，没有 `out_trade_no` 就退到卡号指纹：FNV-1a + 尾 4 位），不是卡密原文
 *     —— 卡密全文不进 localStorage（#484 §7 红线）。
 *  2. **不自动重试**：`redeemCode()` 的 `retryAfterConfirm` 永远不传 true。sub2api 的兑换没有幂等键，
 *     第二枪只能由用户在那个手动「去兑换」入口里自己按下去。
 *  3. **打码卡号不自动兑**：`recharge_code` 只信「不含 `*` / `•`」的完整形态；打码了就只给手动入口。
 *  4. **只在付款回来触发**（见上）+ 日志 `stage: 'wallet.auto-redeem'`，只记卡号后 4 位与结果码。
 *
 * 还有两条与「不确定」有关的取舍：
 *  - **没有可用会话 / 未登录 → 一个请求都不发**（`loadOrders` 不注入 = 没有客户端来源，直接 `skipped`）；
 *  - 订单拉不到 / 读不出来 → `skipped`，不猜、不重试；兑换历史读不到 → 同样不猜
 *    （那意味着「不知道这张卡兑没兑过」，而重复提交一张已兑的卡只会换来一句假失败）。
 */

import type { TranslationKey } from '../../i18n/index.js'
import type { ConsumeMyOrder } from '../../services/consume/orders.js'
import { isCompletedOrder, rechargeCodeOf } from '../../services/consume/orders.js'
import { matchesRedeemCode, type ConsumeRedeemHistoryItem } from '../../services/consume/redeem.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { record } from '../../services/diagnostics/collector.js'
import { buildMeta } from '../../services/diagnostics/fields.js'
import { afterRedeemed } from './myCardsModel.js'

/** 埋点阶段（`services/diagnostics/fields.ts` 的 `Stage` 里登记过，写错编译期就红） */
export const AUTO_REDEEM_STAGE = 'wallet.auto-redeem'

/** 本地去重表：只存指纹，**不存卡密原文** */
export const AUTO_REDEEM_STORAGE_KEY = 'chat-demo:wallet-auto-redeem'

/** 最多记多少张：够挡住「反复从收款页回来」，又不会把 localStorage 撑大 */
export const MAX_REMEMBERED = 50

/**
 * 交叉比对「已兑换流水」时取多少条。
 *
 * `GET /api/v1/redeem/history` 是**已兑换**流水（`redeem_code_repo.go: ListByUser` 只按用户查），
 * 刚兑的那张一定在最前面；但一次「付款回来」可能隔了几天，用户这期间还兑过别的卡，
 * 所以按 50 条取（服务端上限 100），比默认的 20 条留了余量。取不到就 `skipped`，不猜。
 */
export const HISTORY_PAGE_SIZE = 50

/** 打码痕迹：`*`（契约里的 `MUSE-****-1234`）与 `mask.ts` 的实心点（`••••A3SR`）都算 */
const MASK_MARKERS = ['*', '•'] as const

/** `isPendingOrder` 读的字段：新增的几项全是可选（老后端缺字段 = 不触发对应的排除） */
type PendingGateOrder = Pick<ConsumeMyOrder, 'status' | 'rechargeCode'> &
  Partial<Pick<ConsumeMyOrder, 'id' | 'outTradeNo' | 'paymentType' | 'redeemState' | 'redeemable'>>

/** 用户自己兑换产生的流水（`GET orders/my` 会把它和订单混在一起返回），不是订单 */
const REDEEM_RECORD_PAYMENT_TYPE = 'redeem_code'
const REDEEM_RECORD_TRADE_NO_PREFIX = 'redeem-'

/**
 * 这条记录是不是「兑换记录」而不是订单：`payment_type=redeem_code`、`id` 为负数、
 * `out_trade_no` 以 `redeem-` 开头，**任一成立**即是。字段缺失 / 类型不对（#209）= 该条不触发。
 */
const isRedeemRecord = (order: PendingGateOrder): boolean => {
  const paymentType: unknown = order.paymentType
  if (typeof paymentType === 'string' && paymentType.trim().toLowerCase() === REDEEM_RECORD_PAYMENT_TYPE) {
    return true
  }
  const id: unknown = order.id
  if (typeof id === 'number' && id < 0) {
    return true
  }
  const tradeNo: unknown = order.outTradeNo
  return typeof tradeNo === 'string' && tradeNo.trim().toLowerCase().indexOf(REDEEM_RECORD_TRADE_NO_PREFIX) === 0
}

/**
 * 服务端明确表态「这张卡现在不能兑」：`redeem_state` 存在且不是 `issued`，
 * 或 `redeemable` 存在且不为 `true`。两个字段都缺失 = 没表态 = 不排除（旧后端行为不变）。
 */
const isDeclaredNotRedeemable = (order: PendingGateOrder): boolean => {
  const state: unknown = order.redeemState
  if (state !== undefined && state !== null && state !== 'issued') {
    return true
  }
  const redeemable: unknown = order.redeemable
  return redeemable !== undefined && redeemable !== null && redeemable !== true
}

/**
 * 一条订单上能不能自动兑 —— 判据：
 * `status === 'COMPLETED'`（#834 新契约：只有已完成的订单才发卡号）、`recharge_code` 非空、没被打码，
 * **并且**（#840 跟进）不是兑换记录、服务端没说「不能兑」。
 *
 * 为什么不再要求「32 位 hex」：真实卡号是服务端发的（`MUSE-3CYP-5NA3-AHSE-A3SR` 这类带分隔符的形态），
 * 形状白名单一旦写窄，真卡会被自己挡在门外 —— 而「打码与否」才是这里唯一必须判断的事。
 */
export const isPendingOrder = (order: PendingGateOrder): boolean => {
  if (!isCompletedOrder(order)) {
    return false
  }
  if (isRedeemRecord(order) || isDeclaredNotRedeemable(order)) {
    return false
  }
  const code = rechargeCodeOf(order)
  if (code === '') {
    return false
  }
  return !MASK_MARKERS.some((marker) => code.includes(marker))
}

/** 卡号是不是**完整**的（非空且没被打码）：自动兑之前必须过这一关 */
export const isFullCardNo = (cardNo: string): boolean => {
  const text = cardNo.trim()
  if (text === '') {
    return false
  }
  return !MASK_MARKERS.some((marker) => text.includes(marker))
}

/** 只取尾 4 位：日志 / 界面能用的最大信息量（`mask.ts` 同一口径） */
export const codeTail = (code: string): string => {
  const text = code.trim()
  return text.length <= 4 ? text : text.slice(-4)
}

/** 一张订单的时间口径（秒）：付过款就以付款时间为准，还没付款退到下单时间 */
const orderTime = (order: Pick<ConsumeMyOrder, 'paidAt' | 'createdAt'>): number => {
  const paid = typeof order.paidAt === 'number' && order.paidAt > 0 ? order.paidAt : 0
  const created = typeof order.createdAt === 'number' && order.createdAt > 0 ? order.createdAt : 0
  return paid > created ? paid : created
}

/**
 * 挑「最新一张待兑的卡」：`COMPLETED` + 卡号完整 + **历史里没有它**，按时间倒序取第一条。
 *
 * 服务端已经按 `created_at desc` 给了，但这里**自己再排一次**：判定不许依赖别人给的顺序
 * （翻页 / 过滤 / 后端改排序都可能在某一版把顺序弄丢）。
 */
export const pickPendingOrder = <T extends PendingGateOrder & Pick<ConsumeMyOrder, 'paidAt' | 'createdAt'>>(
  orders: readonly T[]
): T | null => {
  let picked: T | null = null
  let pickedAt = -1
  for (const order of orders) {
    if (!isPendingOrder(order)) {
      continue
    }
    const at = orderTime(order)
    if (picked === null || at > pickedAt) {
      picked = order
      pickedAt = at
    }
  }
  return picked
}

/**
 * 挑「最新一条打了码的待兑订单」：只用来给界面一句人话（「这张卡密是打码的」），**永不因此发请求**。
 * 调用时机是「完整卡号一条都没有」之后，所以顺序不影响正确性。
 */
export const pickMaskedOrder = <T extends Pick<ConsumeMyOrder, 'status' | 'rechargeCode'>>(
  orders: readonly T[]
): T | null => {
  for (const order of orders) {
    if (!isCompletedOrder(order)) {
      continue
    }
    const code = rechargeCodeOf(order)
    if (code !== '' && !isFullCardNo(code)) {
      return order
    }
  }
  return null
}

/**
 * 去重指纹：FNV-1a 32 位 + 尾 4 位。
 *
 * 为什么不是原文：卡密等于钱，落进 localStorage 就等于落进了「任何一个能读 localStorage 的地方」。
 * 指纹对同一张卡是稳定的（去重要的就是这个），但**反推不出**卡密。
 */
export const codeFingerprint = (code: string): string => {
  const text = code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${hash.toString(16).padStart(8, '0')}-${codeTail(text)}`
}

/**
 * 一张订单的去重令牌：**优先 `out_trade_no`**（一单一条，比卡号更稳），
 * 没有 `out_trade_no`（老后端 / 结构异常）就退到卡号指纹。
 *
 * #834 的口径：去重键就是新契约里的 `out_trade_no`（解析后叫 `outTradeNo`），
 * 与旧契约的「订单号」**语义等价**：它标识的是「这一单」，不是「这一张卡」。
 *
 * 为什么两个都要：只按卡号去重的话，服务端若在两次「付款回来」之间换了卡（补发），
 * 就会把「同一单的第二张卡」当成新卡再打一枪；只按 `out_trade_no` 去重的话，
 * 订单号缺失时去重直接失效。两者都覆盖才是钱的语义。
 */
export const orderFingerprint = (order: { outTradeNo?: string; rechargeCode?: string | null }): string => {
  const orderNo = (order.outTradeNo === undefined ? '' : order.outTradeNo).trim().toUpperCase()
  if (orderNo !== '') {
    return `order:${codeFingerprint(orderNo)}`
  }
  const card = order.rechargeCode === undefined || order.rechargeCode === null ? '' : order.rechargeCode
  return `card:${codeFingerprint(card)}`
}

const readMemory = (): string[] => {
  try {
    const raw = localStorage.getItem(AUTO_REDEEM_STORAGE_KEY)
    if (raw === null) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === 'object' && parsed !== null
        ? (parsed as { codes?: unknown }).codes
        : []
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []
  } catch {
    // 存储不可用 / 内容坏了：当作「没记住过」。反正这只是去重，坏了最坏是多发一枪
    return []
  }
}

/** 这条指纹是不是**已经自动提交过**（不论成败）。存储不可用时返回 false */
export const wasAutoSubmitted = (token: string): boolean => readMemory().includes(token)

/** 记住这条指纹（**发请求之前**写）：中途崩了也不会因为「忘了」再打一枪 */
export const rememberAutoSubmitted = (token: string): void => {
  const kept = readMemory().filter((item) => item !== token)
  kept.push(token)
  try {
    localStorage.setItem(
      AUTO_REDEEM_STORAGE_KEY,
      JSON.stringify({ v: 1, codes: kept.slice(-MAX_REMEMBERED) })
    )
  } catch {
    // 写不进去就算了：这次已经发出去了，下次最多重发一次（比抛错打断流程好）
  }
}

/** 测试 / 排查用：清空去重表 */
export const forgetAutoSubmitted = (): void => {
  try {
    localStorage.removeItem(AUTO_REDEEM_STORAGE_KEY)
  } catch {
    // 同上
  }
}

/** 跳过原因：每种都对应一句「为什么不发」，排查时不用从现象倒推 */
export type WalletAutoRedeemSkipReason =
  | 'not-signed-in'
  /** 没有可用会话（`loadOrders` 没注入）：拉不到订单，也就无从提交 */
  | 'no-session'
  | 'busy'
  | 'orders-failed'
  | 'no-pending'
  | 'no-code'
  | 'duplicate'
  /** 兑过的卡：`GET /api/v1/redeem/history` 里已经有这张卡的流水（#834 的交叉比对） */
  | 'already-redeemed'
  /** 兑换历史读不到：**不知道**兑没兑过 —— 不猜、不发（重复提交已兑的卡只会换来一句假失败） */
  | 'history-unknown'

/** 一次自动兑现的结局（界面只按它的 `kind` 分支，不自己推断） */
export type WalletAutoRedeemOutcome =
  /** 没发任何请求。`not-signed-in` 要给「登录后自动到账」，其余静默 */
  | { kind: 'skipped'; reason: WalletAutoRedeemSkipReason }
  /** 打码卡密：**没有**发 redeem，只给手动入口（`code` 是服务端打的码，可以原样显示） */
  | { kind: 'masked'; code: string; i18nKey: TranslationKey }
  /** 到账（余额已重拉过一次 `/user/profile`） */
  | {
      kind: 'credited'
      tail: string
      /** 面值（元）；服务端只说了「success」没给 type 时缺席 */
      amount?: number
      /** 兑换后的账户余额（元）；profile 读不到就缺席 */
      balance?: number
      /** 服务端原句（成功时通常就是 "success"，只作卡片副标题） */
      message: string
    }
  /** 受理未到账（`202` / `LOCKED`）：**不是失败**，不给重试，只给手动入口 */
  | { kind: 'processing'; tail: string; i18nKey: TranslationKey; message: string }
  /** 明确失败：不重试，只给手动入口 */
  | { kind: 'failed'; tail: string; i18nKey: TranslationKey; message: string }

/** 依赖：只认「兑换 / 读资料」+「拉一页订单」，测试给假实现即可 */
export type WalletAutoRedeemDeps = {
  client: Pick<ConsumeClient, 'redeem' | 'auth'>
  /** 登录态（未登录时**一个请求都不发**：拿空 JWT 打只会 401） */
  signedIn: boolean
  /**
   * 拉最近订单（`GET /api/v1/payment/orders/my`）。**没有可用会话就不要注入**：那等于
   * 「打不出有意义的请求」，留着 `undefined` 才能把「没有会话」和「拉失败」在日志里分开。
   */
  loadOrders?: () => Promise<ConsumeMyOrder[]>
}

/** 同一时刻只允许一次自动兑现（连点「去支付 → 回来」不会叠出两条流水线） */
let running = false

const logInfo = (result: string, tail?: string): void => {
  record('nav', 'info', 'wallet auto redeem', {
    ...buildMeta({ stage: AUTO_REDEEM_STAGE }),
    result,
    ...(tail === undefined || tail === '' ? {} : { 'card.tail': tail }),
  })
}

const logWarn = (result: string, tail?: string): void => {
  record('warning', 'warn', 'wallet auto redeem', {
    ...buildMeta({ stage: AUTO_REDEEM_STAGE }),
    result,
    ...(tail === undefined || tail === '' ? {} : { 'card.tail': tail }),
  })
}

/**
 * 付款回来之后的自动兑现（**最多一个 POST**）。
 *
 * 顺序：登录态 → 有没有订单来源 → 拉 `GET /api/v1/payment/orders/my` → 挑 `COMPLETED` 且卡号完整的
 * → 和 `GET /api/v1/redeem/history` 交叉比对，**已兑过的跳过** → 判本地去重 → **先落盘再发**
 * → 复用 `redeemCode()` → 到账则 `afterRedeemed()` 刷 `balance`。
 *
 * 所有异常都在这里收口成 `failed` / `skipped`：这个函数**永远不抛**，因为它跑在 UI 回调里，
 * 抛出去只会变成一条 unhandled rejection，而用户什么也看不到。
 */
export const runWalletAutoRedeem = async (deps: WalletAutoRedeemDeps): Promise<WalletAutoRedeemOutcome> => {
  if (!deps.signedIn) {
    logInfo('skipped:not-signed-in')
    return { kind: 'skipped', reason: 'not-signed-in' }
  }
  if (deps.loadOrders === undefined) {
    // 没有可用会话：订单接口打不了，也就不存在「待兑的卡」——不发任何请求
    logInfo('skipped:no-session')
    return { kind: 'skipped', reason: 'no-session' }
  }
  if (running) {
    logInfo('skipped:busy')
    return { kind: 'skipped', reason: 'busy' }
  }
  running = true
  try {
    return await run(deps, deps.loadOrders)
  } catch {
    // 传输层之外的意外（配置缺失、解析炸了……）：结论是「没兑成」，绝不因此再打一枪
    logWarn('failed:threw')
    return { kind: 'failed', tail: '', i18nKey: 'walletAutoRedeemFailed', message: '' }
  } finally {
    running = false
  }
}

/**
 * 剔除「历史里已经有流水」的订单（#834 的交叉比对）。
 *
 * 判据用 `matchesRedeemCode`（`redeem.ts` 既有的那一份）：归一化后包含完整卡密，或**尾 4 位对上**——
 * 因为服务端在流水里可能把中间打码成 `MUSE-****-1234`，尾 4 位是唯一能被 mask 保住的片段。
 */
const dropAlreadyRedeemed = (
  orders: readonly ConsumeMyOrder[],
  items: readonly ConsumeRedeemHistoryItem[]
): ConsumeMyOrder[] => {
  return orders.filter((order) => {
    const code = rechargeCodeOf(order)
    if (code === '') {
      return false
    }
    return !items.some((item) => matchesRedeemCode(item, code))
  })
}

const run = async (
  deps: WalletAutoRedeemDeps,
  loadOrders: () => Promise<ConsumeMyOrder[]>
): Promise<WalletAutoRedeemOutcome> => {
  let orders: ConsumeMyOrder[]
  try {
    orders = await loadOrders()
  } catch {
    // 订单读不到 = 「不知道有没有待兑」→ 不发、不猜、不重试
    logInfo('skipped:orders-failed')
    return { kind: 'skipped', reason: 'orders-failed' }
  }
  const candidates = orders.filter((order) => isPendingOrder(order))
  if (candidates.length === 0) {
    const masked = pickMaskedOrder(orders)
    if (masked !== null) {
      // 契约：#784 第 3 条 —— 打码卡号**不自动兑**，只给手动入口
      logInfo('masked', codeTail(rechargeCodeOf(masked)))
      return { kind: 'masked', code: rechargeCodeOf(masked), i18nKey: 'walletAutoRedeemMasked' }
    }
    logInfo('skipped:no-pending')
    return { kind: 'skipped', reason: 'no-pending' }
  }

  // #834：新接口不回答「这张卡兑没兑过」，只能问既有兑换历史。读不到 = 不可知 → 不发、不猜
  let history: Awaited<ReturnType<ConsumeClient['redeem']['history']>>
  try {
    history = await deps.client.redeem.history({ page: 1, pageSize: HISTORY_PAGE_SIZE })
  } catch {
    logWarn('skipped:history-unknown')
    return { kind: 'skipped', reason: 'history-unknown' }
  }
  if (!history.ok) {
    logWarn('skipped:history-unknown')
    return { kind: 'skipped', reason: 'history-unknown' }
  }

  const fresh = dropAlreadyRedeemed(candidates, history.data.items)
  if (fresh.length === 0) {
    // 全都已经在账号里了：这是**好事**，静默（用户回来看到的是余额已经到账）
    logInfo('skipped:already-redeemed')
    return { kind: 'skipped', reason: 'already-redeemed' }
  }

  const pending = pickPendingOrder(fresh)
  if (pending === null) {
    logInfo('skipped:no-pending')
    return { kind: 'skipped', reason: 'no-pending' }
  }
  const code = rechargeCodeOf(pending)
  if (code === '') {
    logInfo('skipped:no-code')
    return { kind: 'skipped', reason: 'no-code' }
  }
  const tail = codeTail(code)
  const token = orderFingerprint(pending)
  if (wasAutoSubmitted(token)) {
    logInfo('skipped:duplicate', tail)
    return { kind: 'skipped', reason: 'duplicate' }
  }
  // 先落盘再发：这一枪无论结果如何，都不会被下一次「付款回来」重打
  rememberAutoSubmitted(token)

  // 不传 `retryAfterConfirm`：自动路径**只发一次**（sub2api 没有幂等键）
  const outcome = await deps.client.redeem.redeem({ code })
  if (outcome.kind === 'redeemed') {
    // 到账后重拉 `/user/profile`：余额在 `user.balance`，不是某把 Key 的 quota（#676 §五）
    const aftermath = await afterRedeemed(outcome, deps.client.auth)
    logInfo('credited', tail)
    return {
      kind: 'credited',
      tail,
      ...(outcome.result.type === 'balance' ? { amount: outcome.result.value } : {}),
      ...(aftermath.refresh && aftermath.balance !== undefined ? { balance: aftermath.balance } : {}),
      message: outcome.result.message,
    }
  }
  if (outcome.kind === 'processing') {
    // 409 LOCKED / 202 受理：**正在处理**，不是失败 —— 文案交给 `error.i18nKey`
    logWarn('processing', tail)
    return { kind: 'processing', tail, i18nKey: outcome.error.i18nKey, message: outcome.error.message }
  }
  // `pending`（超时 + 核对未到账）与 `failed`（业务失败）在自动路径上是同一句话：
  // **不重试**，卡片给「去兑换」，用户自己决定要不要再按一次
  logWarn(outcome.kind === 'pending' ? 'failed:pending' : 'failed', tail)
  return { kind: 'failed', tail, i18nKey: outcome.error.i18nKey, message: outcome.error.message }
}

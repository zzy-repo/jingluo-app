import { createElement, type ReactNode } from 'react'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { hasMoreTrail, TRAIL_ORDER_STATUSES } from '../../services/ours/trail.js'
import type {
  CardTrail,
  CardTrailFetcher,
  TrailCard,
  TrailErrorKind,
  TrailEvent,
  TrailOrder,
  TrailOrderStatus,
  TrailPage,
  TrailTone,
} from '../../services/ours/trail.js'
import { LIMITS } from '../../services/limits.js'

/**
 * 支付记录时间线的**展示层 + 全部判定逻辑**（Issue #189）。
 *
 * 为什么单独一层（沿用 #158 `PurchaseRecordsView.ts` 的做法）：纯 Node 的 `node --test`
 * 只认得 `.ts`，认不出 `.tsx`（JSX 不在类型擦除范围内）。把「怎么显示 / 要不要显示」
 * 整块搬到不带 JSX、也不 import CSS 的本文件：
 *  - 用 `createElement` 而不是 JSX；
 *  - 样式类名与翻译函数由调用方注入（真机是 CSS Module 与 `useTranslate()`，单测是假 classNames 与真文案）。
 * 这样 `tests/unit/payment-trail-ui.test.mjs` 能对**真的组件代码**跑 `renderToStaticMarkup`。
 *
 * 三条这条 Issue 特有的硬口径（都在这里落地，不留给容器去记得）：
 *  1. **入口只在自有渠道**：`shouldShowPaymentTrail(kind)` 只认 `ours`（#166 的教训：门禁写在渲染处）。
 *  2. **EXPIRED ≠ FAILED**：超时关闭 24h 内付款会自动补发卡密，所以给弱化色 + 「下一步」+
 *     一键复制单号，绝不给「支付异常」这种结论。
 *  3. **503 停服不能渲染成空态**：把「服务在维护」说成「你没有买过」是骗用户。
 */

/** 翻译函数：组件不自己取语言，交给调用方 */
export type TrailTranslate = (key: TranslationKey, params?: TranslationParams) => string

/** 样式注入：不在这里 import CSS Module，测试环境也就能直接渲染 */
export type TrailClassNames = Record<string, string | undefined>

/** 按钮渲染器：真机是设计系统的 `Button`，单测是等价的最小 `<button>` 替身 */
export type ViewButtonProps = {
  variant?: 'primary' | 'outlined'
  size?: 's' | 'm'
  disabled?: boolean
  className?: string
  testId?: string
  onClick?: () => void
  children?: ReactNode
}

export type ViewButtonComponent = (props: ViewButtonProps) => ReactNode

// ------------------------------------------------------------------ 纯逻辑

/** 每页条数：界面与请求共用这一个常量（服务端契约默认 20） */
export const PAYMENT_TRAIL_PAGE_SIZE = 20

/**
 * 已支付但卡密还没发出来的订单会自己刷新几次（最典型的「等几秒」场景：
 * 支付平台回调 → 发卡，通常 1~3 秒）。4 秒一次，够快也不会把弱网打满。
 */
export const TRAIL_POLL_INTERVAL_MS = LIMITS.paymentTrail.pollIntervalMs

/**
 * 自动刷新封顶 2 分钟。再久就是真出问题了（缺货 / 上游卡住），
 * 一直轮询既费流量又让用户以为「再等等就好」，不如停下来让人点刷新或找客服。
 */
export const TRAIL_POLL_MAX_MS = LIMITS.paymentTrail.pollMaxMs

/**
 * 渠道门禁：**只有自有渠道（ours）才显示支付记录入口**。
 *
 * 这一条是 #166 的教训：别的渠道连 `/api/trail` 这个域名都没有，
 * 渲染出来只会得到一串 401 / 网络错误。判定放在这里，容器只管调它。
 */
export const shouldShowPaymentTrail = (kind: string | undefined | null): boolean => kind === 'ours'

// ------------------------------------------------------------------ 分页 / 筛选（#326）

/**
 * 状态筛选页签：`all` = 不传 `status`（服务端不需要这个参数），其余就是数据层的五个状态值。
 *
 * 页签文案**复用**既有的 `oursTrailStatus*`，只新增「全部」一个 key —— 这样页签上的字和卡片上的
 * 状态字永远是同一个词，不会出现「筛选写已完成、卡片写 FULFILLED」这种两套叫法。
 */
export type TrailStatusTab = 'all' | TrailOrderStatus

export type TrailStatusTabDef = { value: TrailStatusTab; labelKey: TranslationKey }

export const TRAIL_STATUS_TABS: readonly TrailStatusTabDef[] = [
  { value: 'all', labelKey: 'oursTrailTabAll' },
  { value: 'created', labelKey: 'oursTrailStatusCreated' },
  { value: 'paid', labelKey: 'oursTrailStatusPaid' },
  { value: 'fulfilled', labelKey: 'oursTrailStatusFulfilled' },
  { value: 'expired', labelKey: 'oursTrailStatusExpired' },
  { value: 'failed', labelKey: 'oursTrailStatusFailed' },
]

/**
 * 页签 → 请求参数。`all` 返回 null 时**连参数都不加**（`trailUrl` 只在 status 非 null 时 set，
 * `?status=` 空值多一种歧义，别给服务端）。
 *
 * 取值一律**小写**：#189 的 `normalizeStatus` 与单测固化的就是小写契约；
 * 2026-11-19 实测服务端对 `status` 不校验（大小写 / 逗号 / 垃圾值都回 200），
 * 所以发错大小写不会报错，而是**静默**换一种过滤结果 —— 只能靠客户端守住这个小写口径。
 */
export const tabToTrailStatus = (tab: TrailStatusTab): TrailOrderStatus | null =>
  tab === 'all' ? null : tab

/** 未知值（旧版本存的、URL 里拼的）一律归 `all`，不要让筛选条出现一个不存在的选中项 */
export const normalizeTrailTab = (value: unknown): TrailStatusTab =>
  typeof value === 'string' && (TRAIL_ORDER_STATUSES as readonly string[]).includes(value)
    ? (value as TrailOrderStatus)
    : 'all'

/**
 * 翻页去重（#326 的唯一实现点）：按 `out_trade_no` 合并，**已有顺序不动**，
 * 同号用新数据覆盖旧项 —— 轮询回填与「服务端两页有重叠」都走这一条。
 *
 * 空单号（服务端缺字段）不去重：把它们并成一条比多显示一行更糟。
 */
export const mergeTrailOrders = (
  existing: readonly TrailOrder[],
  incoming: readonly TrailOrder[]
): TrailOrder[] => {
  const merged: TrailOrder[] = []
  const indexByNo = new Map<string, number>()
  for (const order of [...existing, ...incoming]) {
    const outTradeNo = typeof order.outTradeNo === 'string' ? order.outTradeNo : ''
    if (outTradeNo === '') {
      merged.push(order)
      continue
    }
    const seen = indexByNo.get(outTradeNo)
    if (seen === undefined) {
      indexByNo.set(outTradeNo, merged.length)
      merged.push(order)
      continue
    }
    merged[seen] = order
  }
  return merged
}

/** 下一页的 `offset` = 已加载条数（`offset` 是纯 skip 计数，不是页码） */
export const nextTrailOffset = (items: readonly TrailOrder[]): number =>
  Array.isArray(items) ? items.length : 0

/**
 * 还有没有下一页：接上数据层那个一直没人调用的 `hasMoreTrail`（`trail.ts:555`），
 * 再补两条「不能让用户点到一个永远没进展的按钮」的护栏：
 *  - 这一页一条都没回来（服务端把 offset 丢了）→ 停；
 *  - 已加载条数已经到 `total`（服务端两页重叠、去重后没增加）→ 停。
 *
 * 注意 `total` 只从响应读：`hasMoreTrail` 用的是服务端回显的 `offset` + 本页条数 vs `total`，
 * 不是 `items.length` 推算出来的。
 */
export const canLoadMore = (
  page: Pick<TrailPage, 'total' | 'offset' | 'orders'> | null,
  loadedCount?: number
): boolean => {
  if (page === null || !Array.isArray(page.orders) || page.orders.length === 0) {
    return false
  }
  if (!hasMoreTrail(page)) {
    return false
  }
  if (typeof loadedCount === 'number' && Number.isFinite(loadedCount)) {
    return loadedCount < page.total
  }
  return true
}

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 服务端时间戳可能是秒也可能是毫秒（`paymentRecords` 那边是秒）。
 * ≥ 1e12 视为毫秒（约 2001 年之后），否则按秒补零。无法解析时返回 null。
 */
const toMillis = (value: number | null | undefined): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return value >= 1e12 ? value : value * 1000
}

/** 本地时区的 `YYYY-MM-DD HH:mm`：用户看到的必须是自己的时间，不是 UTC。无效值给占位符 */
export const formatTrailTime = (value: number | null | undefined): string => {
  const ms = toMillis(value)
  if (ms === null) {
    return '—'
  }
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 金额：`¥29.90`。非法值按 0，不让 NaN 漏到界面上 */
export const formatYuan = (yuan: number): string =>
  `¥${(Number.isFinite(yuan) ? yuan : 0).toFixed(2)}`

/** 积分：`3,000`（用户对账时按千分位读，别给 3000） */
export const formatPoints = (points: number): string => {
  const value = Number.isFinite(points) ? Math.round(points) : 0
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * 卡号只露后 4 位。时间线是用户会截图发群 / 发给客服的页面，
 * 完整卡密等于把「钱」直接印在图上（#158 同口径）。
 */
export const maskTrailCard = (cardNo: string | null | undefined): string => {
  if (typeof cardNo !== 'string') {
    return ''
  }
  const text = cardNo.trim()
  if (text === '') {
    return ''
  }
  const tail = text.slice(-4)
  return `••••${tail}`
}

// ------------------------------------------------------------------ 文案映射

const STATUS_KEYS: Record<TrailOrderStatus, TranslationKey> = {
  created: 'oursTrailStatusCreated',
  paid: 'oursTrailStatusPaid',
  fulfilled: 'oursTrailStatusFulfilled',
  expired: 'oursTrailStatusExpired',
  failed: 'oursTrailStatusFailed',
}

/**
 * 已知事件 → 文案 key。
 *
 * **不是白名单**：查不到就用服务端给的 `text`，连 text 都没有才用通用兜底文案。
 * 少一条事件（比如后端新加的对账动作）就等于把关键动作藏起来。
 */
const EVENT_KEYS: Record<string, TranslationKey> = {
  order_created: 'oursTrailEventOrderCreated',
  notify_ok: 'oursTrailEventNotifyOk',
  paid_confirmed: 'oursTrailEventPaidConfirmed',
  card_issued: 'oursTrailEventCardIssued',
  card_redeemed: 'oursTrailEventCardRedeemed',
  order_expired: 'oursTrailEventOrderExpired',
  late_paid_recovered: 'oursTrailEventLateRecovered',
  issue_waiting_stock: 'oursTrailEventWaitingStock',
  notify_bad_amount: 'oursTrailEventBadAmount',
  upstream_mismatch: 'oursTrailEventBadAmount',
}

/** 一条事件给用户看的字：已知走本地文案（跟着语言走），未知用服务端 text 兜底 */
export const trailEventText = (
  event: string,
  serverText: string,
  t: TrailTranslate
): string => {
  const key = EVENT_KEYS[event.trim().toLowerCase()]
  if (key !== undefined) {
    return t(key)
  }
  const text = typeof serverText === 'string' ? serverText.trim() : ''
  return text === '' ? t('oursTrailEventUnknown') : text
}

/** 状态字：服务端给了中文就用它（和后端口径一致），没给才回落到本地文案 */
export const trailStatusText = (order: TrailOrder, t: TrailTranslate): string =>
  order.statusText.trim() === '' ? t(STATUS_KEYS[order.status]) : order.statusText

/** 错误视图：文案全部落在 i18n key 上，界面里不出现英文原文 / 服务端原文 */
export type TrailErrorView = {
  messageKey: TranslationKey
  retryable: boolean
  needsKey: boolean
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  keyMissing: 'oursTrailErrKeyMissing',
  unauthorized: 'oursTrailErrUnauthorized',
  notFound: 'oursTrailErrNotFound',
  unavailable: 'oursTrailErrUnavailable',
  rateLimited: 'oursTrailErrRateLimited',
  timeout: 'oursTrailErrTimeout',
  network: 'oursTrailErrNetwork',
  server: 'oursTrailErrServer',
  badResponse: 'oursTrailErrBadResponse',
}

const RETRYABLE_KINDS: readonly TrailErrorKind[] = [
  'network',
  'timeout',
  'server',
  'unavailable',
  'rateLimited',
]
const NEEDS_KEY_KINDS: readonly TrailErrorKind[] = ['keyMissing', 'unauthorized']

/**
 * 任何错误 → 视图能用的一小撮东西。**永远不抛**：
 * 数据层换实现 / 抛了个裸对象 / 抛 null，界面都得有话说，不能白屏。
 */
export const describeTrailError = (error: unknown): TrailErrorView => {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const rawKind = record.kind
  const kind = typeof rawKind === 'string' ? rawKind : ''
  const messageKey = ERROR_KEYS[kind] ?? 'oursTrailErrUnknown'
  const retryable =
    typeof record.retryable === 'boolean'
      ? record.retryable
      : (RETRYABLE_KINDS as readonly string[]).includes(kind)
  const needsKey =
    typeof record.needsKey === 'boolean'
      ? record.needsKey
      : (NEEDS_KEY_KINDS as readonly string[]).includes(kind)
  return { messageKey, retryable, needsKey }
}

/**
 * 已支付的单子要不要继续自动刷新：只有 `paid`（钱到了、卡还没发）需要，
 * 且超过封顶就停手。`fulfilled` / `expired` / `failed` 再刷也不会变。
 */
export const shouldKeepPolling = (
  status: TrailOrderStatus | string,
  elapsedMs: number
): boolean => {
  if (status !== 'paid') {
    return false
  }
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0
  return elapsed < TRAIL_POLL_MAX_MS
}

// ------------------------------------------------------------------ 视图状态

/** 「加载更多」的三态：与首屏 loading / 整页 error 分开，失败只影响列表底部那一行 */
export type TrailMoreState = 'idle' | 'loading' | 'error'

export type TrailView =
  | { status: 'loading' }
  | { status: 'error'; error: TrailErrorView }
  | {
      status: 'ok'
      /** 最近一次请求回来的那一页（`hasMoreTrail` 判定要用它的 `offset` / `total`） */
      page: TrailPage | null
      /** 已累积的记录（首页 + 每次「加载更多」的追加，已按 `out_trade_no` 去重）；缺省 = `page.orders` */
      items?: TrailOrder[]
      /** 服务端 `total`：只来自响应，**永远不用 `items.length` 推算**（#326 关闭条件之一） */
      total?: number
      /** 加载更多的进度；缺省 `idle` */
      more?: TrailMoreState
    }

export type TrailFetcher = (params: {
  apiKey: string
  limit: number
  offset: number
  status?: TrailOrderStatus | null
}) => Promise<TrailPage>

export type TrailLoadResult =
  | { status: 'ok'; page: TrailPage }
  | { status: 'error'; error: TrailErrorView }

/**
 * 拉一页并归一成视图状态。**永不抛**（容器里不用再包 try/catch）：
 * 没填 Key 直接给 `keyMissing` 且**一个请求都不发**（省掉一次必然 401 的往返）。
 *
 * `status` 只在非 null 时进 query（`all` 页签连参数都不加），取值按 #189 的小写契约。
 */
export async function loadTrailPage(params: {
  fetchTrail: TrailFetcher
  apiKey: string
  /** 首页传 0；加载更多传「已加载条数」（`nextTrailOffset`） */
  offset: number
  status?: TrailOrderStatus | null
}): Promise<TrailLoadResult> {
  const apiKey = typeof params.apiKey === 'string' ? params.apiKey.trim() : ''
  if (apiKey === '') {
    return { status: 'error', error: describeTrailError({ kind: 'keyMissing' }) }
  }
  const query: { apiKey: string; limit: number; offset: number; status?: TrailOrderStatus | null } = {
    apiKey,
    limit: PAYMENT_TRAIL_PAGE_SIZE,
    offset: typeof params.offset === 'number' && Number.isFinite(params.offset) ? params.offset : 0,
  }
  if (params.status !== undefined && params.status !== null) {
    query.status = params.status
  }
  try {
    const page = await params.fetchTrail(query)
    return { status: 'ok', page }
  } catch (error) {
    return { status: 'error', error: describeTrailError(error) }
  }
}

// ------------------------------------------------------------------ 列表状态机（分页 / 筛选，#326）

/**
 * 列表状态的唯一写入口。放进本文件而不是 `.tsx`，是为了让「切换筛选要整段重置」
 * 「加载更多失败不清空列表」这类口径能在裸 Node 里直接跑断言（#189 的架构约定）。
 *
 * 两条最容易写错的语义，在这里用类型和分支钉死：
 *  - `tab`：切筛选 = `offset 0` + `items 清空` + `more idle`（旧页绝不能拼到新筛选后面）；
 *  - `more-failed`：只把底部标记成 error，`items` / `total` 一个字都不动。
 */
export type TrailListState = {
  tab: TrailStatusTab
  view: TrailView
}

export type TrailListAction =
  /** 切筛选页签：整段重置（不含 tab 本身） */
  | { type: 'tab'; tab: TrailStatusTab }
  /** 回到第一页重新拉（手动刷新 / 首屏）：保留 tab，清空已累积的页 */
  | { type: 'reload' }
  /** 第一页回来了 */
  | { type: 'loaded'; page: TrailPage }
  /** 第一页失败 */
  | { type: 'failed'; error: TrailErrorView }
  /** 点了「加载更多」 */
  | { type: 'more-start' }
  /** 加载更多成功：追加 + 去重 */
  | { type: 'more-loaded'; page: TrailPage }
  /** 加载更多失败：**不清空**已渲染的列表 */
  | { type: 'more-failed'; error: TrailErrorView }
  /** 静默轮询（4 秒）：只合并第一页，不动已加载的第 2 页起的内容 */
  | { type: 'silent'; page: TrailPage }

export const initialTrailListState: TrailListState = { tab: 'all', view: { status: 'loading' } }

/** 组一个成功视图：`items` 与 `total` 分开存，翻页时 total 不会被 items 的长度带偏 */
const okView = (page: TrailPage, items: TrailOrder[], more: TrailMoreState): TrailView => ({
  status: 'ok',
  page,
  items,
  total: page.total,
  more,
})

const itemsOf = (view: TrailView): TrailOrder[] =>
  view.status === 'ok' ? (view.items ?? view.page?.orders ?? []) : []

export const trailListReducer = (
  state: TrailListState,
  action: TrailListAction
): TrailListState => {
  const { view } = state
  switch (action.type) {
    case 'tab':
      // 换了筛选：offset 回到 0、旧列表整段丢掉，等新响应（页签条本身保留，只换列表区）
      return { tab: action.tab, view: { status: 'loading' } }
    case 'reload':
      return { ...state, view: { status: 'loading' } }
    case 'loaded':
      return { ...state, view: okView(action.page, mergeTrailOrders([], action.page.orders), 'idle') }
    case 'failed':
      return { ...state, view: { status: 'error', error: action.error } }
    case 'more-start':
      if (view.status !== 'ok') {
        return state
      }
      return { ...state, view: { ...view, more: 'loading' } }
    case 'more-loaded':
      if (view.status !== 'ok') {
        return state
      }
      return { ...state, view: okView(action.page, mergeTrailOrders(itemsOf(view), action.page.orders), 'idle') }
    case 'more-failed':
      if (view.status !== 'ok') {
        return state
      }
      return { ...state, view: { ...view, more: 'error' } }
    case 'silent':
      // 轮询只拉第一页：同号覆盖、顺序不变、第 2 页起的记录原地不动
      return {
        ...state,
        view: okView(action.page, mergeTrailOrders(itemsOf(view), action.page.orders), view.status === 'ok' ? (view.more ?? 'idle') : 'idle'),
      }
    default:
      return state
  }
}

/** 「是否还要继续 4 秒轮询」：看**全部已加载记录**，不能只看第一页（第 2 页有 paid 单也得刷） */
export const hasWaitingCard = (items: readonly TrailOrder[]): boolean =>
  items.some((order) => order.status === 'paid')

// ------------------------------------------------------------------ 时间线

const eventNode = (
  event: TrailEvent,
  index: number,
  c: TrailClassNames,
  t: TrailTranslate
): ReactNode => {
  const tone: TrailTone =
    event.event === '' ? 'muted' : toneOfEvent(event.event)
  return createElement(
    'li',
    {
      key: `event-${index}-${event.event}`,
      className: c.event,
      'data-event': event.event,
      'data-tone': tone,
      'data-backfilled': event.backfilled ? 'true' : 'false',
      'data-testid': 'trail-event',
    },
    createElement('span', { className: c.dot, 'aria-hidden': 'true', 'data-testid': 'trail-event-dot' }),
    createElement(
      'span',
      { className: c.eventTime, 'data-testid': 'trail-event-time' },
      formatTrailTime(event.at)
    ),
    createElement(
      'span',
      { className: c.eventText },
      trailEventText(event.event, event.text, t)
    ),
    // 历史补录：时间只是补录值，用户不能把它当准点
    event.backfilled
      ? createElement(
          'span',
          { className: c.badge, 'data-testid': 'trail-backfilled' },
          t('oursTrailBackfilled')
        )
      : null
  )
}

/** 事件色调：与数据层 `eventToneOf` 同口径，但这里只依赖字符串，避免展示层 import 运行时代码 */
const toneOfEvent = (event: string): TrailTone => {
  const name = event.trim().toLowerCase()
  if (
    ['notify_ok', 'paid_confirmed', 'card_issued', 'card_redeemed', 'late_paid_recovered'].includes(
      name
    )
  ) {
    return 'success'
  }
  if (['notify_bad_amount', 'upstream_mismatch'].includes(name)) {
    return 'danger'
  }
  if (['order_created', 'issue_waiting_stock'].includes(name)) {
    return 'pending'
  }
  return 'muted'
}

const statusTone = (status: TrailOrderStatus): TrailTone => {
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

/**
 * 卡密块：完整卡号不进 DOM，只给后 4 位 + 积分 + 兑换状态。
 *
 * 「查这张卡」（#325）：回调收到的是**完整卡号**（查询要它），但渲染出来的永远只有
 * `maskTrailCard` 的掩码 —— 事件参数不进 DOM、不进剪贴板。没传回调就不渲染入口
 * （别的宿主复用这个模块时不该冒出一个按不动的按钮）。
 */
const cardNode = (
  card: TrailCard,
  c: TrailClassNames,
  t: TrailTranslate,
  btn: ViewButtonComponent,
  onLookupCard?: (cardNo: string) => void
): ReactNode =>
  createElement(
    'div',
    { className: c.card, 'data-testid': 'trail-card', 'data-state': card.state },
    createElement(
      'div',
      { className: c.cardRow },
      createElement('span', { className: c.cardLabel }, t('oursTrailCardLabel')),
      createElement('span', { className: c.cardNo }, maskTrailCard(card.cardNo))
    ),
    createElement(
      'div',
      { className: c.cardRow },
      createElement('span', { className: c.cardLabel }, t('oursTrailCardPoints')),
      createElement('span', { className: c.points }, formatPoints(card.points))
    ),
    createElement(
      'div',
      { className: c.cardRow },
      createElement(
        'span',
        { className: c.cardState },
        card.state === 'redeemed' ? t('oursTrailCardRedeemed') : t('oursTrailCardNotRedeemed')
      ),
      card.state === 'redeemed' && card.redeemedKeyTail !== ''
        ? createElement(
            'span',
            { className: c.cardTail },
            `${t('oursTrailCardKeyTail')} ${card.redeemedKeyTail}`
          )
        : null,
      card.state === 'redeemed'
        ? createElement(
            'span',
            { className: c.cardTime },
            formatTrailTime(card.redeemedAt)
          )
        : null
    ),
    // 入口就在卡密块里（#325）：用户看到「这张卡」的同一行才有动机反查它，
    // 不另开设置入口 —— 卡号是凭据，入口越少越好。
    typeof onLookupCard === 'function' && card.cardNo.trim() !== ''
      ? createElement(
          'div',
          { className: c.cardLookup },
          btn({
            variant: 'outlined',
            size: 's',
            testId: 'trail-card-lookup',
            onClick: () => onLookupCard(card.cardNo),
            children: t('oursTrailCardLookup'),
          })
        )
      : null
  )

const orderNode = (
  order: TrailOrder,
  index: number,
  c: TrailClassNames,
  t: TrailTranslate,
  btn: ViewButtonComponent,
  onCopyOrderNo?: (outTradeNo: string) => void,
  onLookupCard?: (cardNo: string) => void
): ReactNode => {
  const tone = statusTone(order.status)
  const waiting = order.card === null && order.status === 'paid'
  return createElement(
    'li',
    {
      key: order.outTradeNo === '' ? `order-${index}` : order.outTradeNo,
      className: c.order,
      'data-status': order.status,
      'data-tone': tone,
      'data-out-trade-no': order.outTradeNo,
      'data-testid': 'trail-order',
    },
    createElement(
      'div',
      { className: c.orderHead },
      createElement(
        'span',
        { className: c.orderNo },
        order.outTradeNo === '' ? t('oursTrailOrderNoMissing') : order.outTradeNo
      ),
      createElement('span', { className: c.amount }, formatYuan(order.amountYuan))
    ),
    createElement(
      'div',
      { className: c.meta },
      createElement(
        'span',
        { className: c.status, 'data-status': order.status, 'data-tone': tone, 'data-testid': 'trail-status' },
        trailStatusText(order, t)
      ),
      createElement('span', { className: c.time }, formatTrailTime(order.createdAt))
    ),
    // 已支付但卡密还没发放：不渲染空壳卡片，直接说「等几秒」
    waiting
      ? createElement(
          'div',
          { className: c.hint, 'data-testid': 'trail-waiting-card' },
          t('oursTrailWaitingCard')
        )
      : null,
    order.card === null ? null : cardNode(order.card, c, t, btn, onLookupCard),
    order.timeline.length === 0
      ? null
      : createElement(
          'ol',
          { className: c.timeline, 'data-testid': 'trail-timeline' },
          ...order.timeline.map((event, index) => eventNode(event, index, c, t))
        ),
    order.nextStep.trim() === ''
      ? null
      : createElement(
          'div',
          { className: c.nextStep, 'data-testid': 'trail-next-step' },
          createElement(
            'div',
            { className: c.nextStepText },
            `${t('oursTrailNextStep')} ${order.nextStep}`
          ),
          // 超时关闭：给「还有救」的说明与一键复制单号，不给「失败」的结论
          order.status === 'expired'
            ? createElement(
                'div',
                { className: c.expired },
                createElement('div', { className: c.expiredHint }, t('oursTrailExpiredHint')),
                order.outTradeNo === ''
                  ? null
                  : btn({
                      variant: 'outlined',
                      size: 's',
                      testId: 'trail-copy-order-no',
                      onClick: () => onCopyOrderNo?.(order.outTradeNo),
                      children: t('oursTrailCopyOrderNo'),
                    })
              )
            : null
        )
  )
}

// ------------------------------------------------------------------ 主视图

export type PaymentTrailViewProps = {
  t: TrailTranslate
  classNames: TrailClassNames
  button: ViewButtonComponent
  view: TrailView
  /** 当前筛选页签：缺省 `all`（不传 tab 的老调用方行为不变） */
  tab?: TrailStatusTab
  /** 不给就不渲染页签条 */
  onTabChange?: (tab: TrailStatusTab) => void
  /** 点「加载更多」：追加下一页（不清空已渲染内容） */
  onLoadMore?: () => void
  /** 加载更多失败后的重试：重打**同一个 offset** */
  onRetryMore?: () => void
  onRetry?: () => void
  onRefresh?: () => void
  onCopyOrderNo?: (outTradeNo: string) => void
  /**
   * 点「查这张卡」（#325）：收到**完整卡号**，由容器负责查 `/api/card/trail`。
   * 不传就不渲染入口 —— 展示层不自己发请求，也不自己决定权限。
   */
  onLookupCard?: (cardNo: string) => void
}

export const PaymentTrailView = (props: PaymentTrailViewProps): ReactNode => {
  const {
    t,
    classNames: c,
    button: btn,
    view,
    tab = 'all',
    onTabChange,
    onLoadMore,
    onRetryMore,
    onRetry,
    onRefresh,
    onCopyOrderNo,
    onLookupCard,
  } = props
  const page = view.status === 'ok' ? view.page : null
  // `items` 是累积结果（翻页追加、已去重）；`page.orders` 只是最近一页，老调用方没传 items 时按它渲染
  const orders = view.status === 'ok' ? (view.items ?? page?.orders ?? []) : []
  const total = view.status === 'ok' ? (view.total ?? page?.total ?? 0) : 0
  const more: TrailMoreState = view.status === 'ok' ? (view.more ?? 'idle') : 'idle'

  /**
   * 状态筛选页签。只在调用方给了 `onTabChange` 时渲染 —— 卡密溯源面板复用本模块时不该长出筛选条。
   * 用 `role="tablist"` + `aria-selected`，和 #158 的「我的购买」同一套无障碍口径。
   */
  const tabs =
    typeof onTabChange !== 'function'
      ? null
      : createElement(
          'div',
          {
            className: c.tabs,
            role: 'tablist',
            'aria-label': t('oursTrailFilterLabel'),
            'data-testid': 'trail-tabs',
          },
          ...TRAIL_STATUS_TABS.map((item) => {
            const active = item.value === tab
            const className = [c.tab, active ? c.tabActive : null]
              .filter((name) => typeof name === 'string' && name !== '')
              .join(' ')
            return createElement(
              'button',
              {
                key: item.value,
                type: 'button',
                role: 'tab',
                className: className === '' ? undefined : className,
                'aria-selected': active ? 'true' : 'false',
                'data-active': active ? 'true' : 'false',
                'data-testid': `trail-tab-${item.value}`,
                onClick: () => onTabChange(item.value),
              },
              t(item.labelKey)
            )
          })
        )

  const head = createElement(
    'div',
    { className: c.head },
    // 标题由宿主弹层的标题栏给（`Modal.title`），这里只放统计与刷新，
    // 否则弹层顶部会出现两个一模一样的标题。
    page === null
      ? null
      : createElement(
          'div',
          { className: c.summary, 'data-testid': 'trail-summary' },
          // `total` 只从响应读：加载第 2、3 页时这个数不能变（更不能用 items.length 推算）
          createElement('span', { className: c.count }, t('oursTrailCount', { total })),
          createElement(
            'span',
            { className: c.totalPaid },
            t('oursTrailTotalPaid', { amount: formatYuan(page.totalPaidYuan) })
          )
        ),
    typeof onRefresh === 'function'
      ? createElement(
          'div',
          { className: c.actions },
          btn({
            variant: 'outlined',
            size: 's',
            testId: 'trail-refresh',
            onClick: onRefresh,
            children: t('oursTrailRefresh'),
          })
        )
      : null
  )

  const loading =
    view.status === 'loading'
      ? createElement(
          'div',
          { className: c.hint, 'data-testid': 'trail-loading' },
          t('oursTrailLoading')
        )
      : null

  const error =
    view.status === 'error'
      ? createElement(
          'div',
          { className: c.error, role: 'alert', 'data-testid': 'trail-error' },
          createElement('div', null, t(view.error.messageKey)),
          view.error.needsKey
            ? createElement('div', { className: c.hint }, t('oursTrailNeedKey'))
            : null,
          view.error.retryable && typeof onRetry === 'function'
            ? createElement(
                'div',
                { className: c.actions },
                btn({
                  variant: 'outlined',
                  size: 's',
                  testId: 'trail-retry',
                  onClick: onRetry,
                  children: t('oursTrailRetry'),
                })
              )
            : null
        )
      : null

  const empty =
    view.status === 'ok' && page !== null && orders.length === 0
      ? createElement(
          'div',
          { className: c.hint, 'data-testid': 'trail-empty' },
          // 筛选后的空态和「一笔都没买过」是两件事：前者要提示换个筛选，后者才是真没有
          tab === 'all' ? t('oursTrailEmpty') : t('oursTrailEmptyFiltered')
        )
      : null

  const list =
    orders.length === 0
      ? null
      : createElement(
          'ul',
          { className: c.list, 'data-testid': 'trail-order-list' },
          ...orders.map((order, index) =>
            orderNode(order, index, c, t, btn, onCopyOrderNo, onLookupCard)
          )
        )

  /**
   * 列表底部四态：加载更多 / 正在加载 / 失败可重试 / 已经到底了。
   *
   * 用**按钮**而不是无限滚动：弹层自己就是滚动容器，而 4 秒静默轮询会在滚动途中换掉内容，
   * 两者叠在一起既容易打断阅读，也难判「到底」。按钮式追加还能保证失败时旧内容原地不动。
   * 末页把按钮**换掉**（而不是禁用）：禁用的按钮在手机上仍占位，还会诱使用户反复点。
   */
  const moreNode =
    view.status !== 'ok' || page === null || orders.length === 0
      ? null
      : more === 'error'
        ? createElement(
            'div',
            { className: c.moreError, role: 'alert', 'data-testid': 'trail-more-error' },
            createElement('span', { className: c.moreErrorText }, t('oursTrailLoadMoreFailed')),
            btn({
              variant: 'outlined',
              size: 's',
              testId: 'trail-more-retry',
              onClick: onRetryMore ?? onLoadMore,
              children: t('oursTrailRetry'),
            })
          )
        : more === 'loading'
          ? createElement(
              'div',
              { className: c.hint, 'data-testid': 'trail-loading-more' },
              t('oursTrailLoadingMore')
            )
          : canLoadMore(page, orders.length)
            ? typeof onLoadMore === 'function'
              ? createElement(
                  'div',
                  { className: c.loadMore },
                  btn({
                    variant: 'outlined',
                    size: 's',
                    testId: 'trail-load-more',
                    onClick: onLoadMore,
                    children: t('oursTrailLoadMore'),
                  })
                )
              : null
            : createElement(
                'div',
                { className: c.end, 'data-testid': 'trail-end' },
                t('oursTrailEndOfList')
              )

  return createElement(
    'div',
    { className: c.root, 'data-testid': 'payment-trail' },
    head,
    tabs,
    loading,
    error,
    empty,
    list,
    moreNode
  )
}

// ------------------------------------------------------------------ 卡密溯源（#325：死代码转正）

export type CardTrailView =
  | { status: 'loading' }
  | { status: 'error'; error: TrailErrorView }
  | { status: 'ok'; trail: CardTrail | null }

/** 卡号查询的可注入形状就是数据层的 `CardTrailFetcher`：真实现是 `trail.ts` 的 `fetchCardTrail` */
export type { CardTrailFetcher }

export type CardTrailLoadResult =
  | { status: 'ok'; trail: CardTrail }
  | { status: 'error'; error: TrailErrorView }

/**
 * 查一张卡的溯源并归一成视图状态。**永不抛**，与 `loadTrailPage` 同一套口径：
 *
 *  - 没填 Key → `keyMissing`，**一个请求都不发**（省掉一次必然 401 的往返）；
 *  - 空卡号 → 直接按「没找到」收口，不发请求；
 *  - 404 → `notFound`：服务端对「这张卡不存在」和「这张卡不是你的」回**同一个** 404，
 *    客户端也只用一句话说明（`oursTrailErrNotFound`）。不区分才能保证这个入口
 *    不会被当成「拿卡号探别人订单」的探针（#325 权限边界）；
 *  - 其余交给 `describeTrailError`：401/403 引导重新绑定 Key（重试无意义），
 *    503 可重试且**不是空态**（沿用 #189 的「停服≠没记录」）。
 *
 * 卡号只顺着 `fetchCardTrail` 的参数进 query：本函数不打印、不埋点、不写剪贴板、不落存储。
 */
export async function loadCardTrail(params: {
  fetchCardTrail: CardTrailFetcher
  apiKey: string
  cardNo: string
}): Promise<CardTrailLoadResult> {
  const apiKey = typeof params.apiKey === 'string' ? params.apiKey.trim() : ''
  if (apiKey === '') {
    return { status: 'error', error: describeTrailError({ kind: 'keyMissing' }) }
  }
  const cardNo = typeof params.cardNo === 'string' ? params.cardNo.trim() : ''
  if (cardNo === '') {
    return { status: 'error', error: describeTrailError({ kind: 'notFound' }) }
  }
  try {
    const trail = await params.fetchCardTrail({ apiKey, cardNo })
    return { status: 'ok', trail }
  } catch (error) {
    return { status: 'error', error: describeTrailError(error) }
  }
}

/**
 * 兑换来源 → 文案：认识的原样翻译，不认识的原样显示服务端值。
 * 服务端以后加新来源（`mini_program` 之类）时，用户至少能看到原始标记，而不是一句「未知」。
 */
const CARD_SOURCE_KEYS: Record<string, TranslationKey> = {
  in_app: 'oursTrailCardSourceInApp',
  inapp: 'oursTrailCardSourceInApp',
  app: 'oursTrailCardSourceInApp',
  web: 'oursTrailCardSourceWeb',
  h5: 'oursTrailCardSourceWeb',
  site: 'oursTrailCardSourceWeb',
}

export const cardSourceText = (source: string, t: TrailTranslate): string => {
  const raw = typeof source === 'string' ? source.trim() : ''
  const key = CARD_SOURCE_KEYS[raw.toLowerCase()]
  if (key !== undefined) {
    return t(key)
  }
  return raw === '' ? t('oursTrailCardSourceUnknown') : raw
}

export type CardTrailPanelProps = {
  t: TrailTranslate
  classNames: TrailClassNames
  view: CardTrailView
  /** 重试上一张卡；只在可重试的错误上渲染按钮（401/403/404 重试没意义） */
  onRetry?: () => void
  /** 重试按钮的渲染器；不给就只有文案、没有按钮（纯文案也能测） */
  button?: ViewButtonComponent
}

/**
 * 卡密溯源面板：这张卡怎么来的、积分到账了没、是不是本人兑换的、从哪个渠道兑换的。
 *
 * 面板本身**不知道卡号也不知道 Key**：数据由容器查好，这里只渲染三种状态。
 * 卡号永远是 `maskTrailCard` 的掩码（后 4 位），完整卡号既不在 DOM 里，也不在 title/aria 里。
 */
export const CardTrailPanel = (props: CardTrailPanelProps): ReactNode => {
  const { t, classNames: c, view, onRetry, button } = props
  if (view.status === 'loading') {
    return createElement(
      'div',
      { className: c.hint, 'data-testid': 'trail-loading' },
      t('oursTrailLoading')
    )
  }
  if (view.status === 'error') {
    return createElement(
      'div',
      { className: c.error, role: 'alert', 'data-testid': 'trail-error' },
      // 404 与「不是你的卡」共用这一句：服务端不回区分，界面也不许猜
      createElement('div', null, t(view.error.messageKey)),
      view.error.needsKey
        ? createElement('div', { className: c.hint }, t('oursTrailNeedKey'))
        : null,
      view.error.retryable && typeof onRetry === 'function' && typeof button === 'function'
        ? createElement(
            'div',
            { className: c.actions },
            button({
              variant: 'outlined',
              size: 's',
              testId: 'trail-card-retry',
              onClick: onRetry,
              children: t('oursTrailRetry'),
            })
          )
        : null
    )
  }
  const trail = view.trail
  if (trail === null) {
    return createElement(
      'div',
      { className: c.hint, 'data-testid': 'trail-empty' },
      t('oursTrailEmpty')
    )
  }
  const { redemption } = trail
  return createElement(
    'div',
    {
      className: c.cardPanel,
      'data-testid': 'trail-card-panel',
      'data-redeemed': redemption.redeemed ? 'true' : 'false',
    },
    createElement(
      'div',
      { className: c.cardRow },
      createElement('span', { className: c.cardLabel }, t('oursTrailCardLabel')),
      createElement('span', { className: c.cardNo }, maskTrailCard(trail.cardNo))
    ),
    redemption.redeemed
      ? createElement(
          'div',
          null,
          createElement(
            'div',
            { className: c.cardRow },
            createElement('span', { className: c.cardState }, t('oursTrailCardRedeemed')),
            createElement('span', { className: c.points }, formatPoints(redemption.points))
          ),
          createElement(
            'div',
            { className: c.cardRow },
            createElement('span', { className: c.cardTime }, formatTrailTime(redemption.at)),
            redemption.keyTail === ''
              ? null
              : createElement(
                  'span',
                  { className: c.cardTail },
                  `${t('oursTrailCardKeyTail')} ${redemption.keyTail}`
                ),
            createElement(
              'span',
              { className: c.cardState },
              redemption.byMe === true
                ? t('oursTrailRedeemedByMe')
                : redemption.byMe === false
                  ? t('oursTrailRedeemedByOther')
                  : t('oursTrailRedeemedByUnknown')
            )
          ),
          // 兑换来源（#325 关闭条件点名要的字段）：/api/trail 的订单卡块里没有这一项
          createElement(
            'div',
            { className: c.cardRow, 'data-testid': 'trail-card-source' },
            createElement('span', { className: c.cardLabel }, t('oursTrailCardSourceLabel')),
            createElement('span', { className: c.cardSource }, cardSourceText(redemption.source, t))
          )
        )
      : createElement(
          'div',
          { className: c.hint, 'data-testid': 'trail-card-unredeemed' },
          t('oursTrailCardNotRedeemed')
        ),
    trail.purchase === null
      ? null
      : createElement(
          'div',
          { className: c.cardRow },
          createElement('span', { className: c.cardLabel }, t('oursTrailOrderNoLabel')),
          createElement('span', { className: c.orderNo }, trail.purchase.outTradeNo)
        ),
    // 权限边界写在用户看得见的地方：查不到不等于没有，别人的卡一律按「没找到」回
    createElement(
      'div',
      { className: c.hint, 'data-testid': 'trail-card-lookup-hint' },
      t('oursTrailCardLookupHint')
    )
  )
}

import { createElement, type ReactNode } from 'react'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type {
  CardTrail,
  TrailCard,
  TrailErrorKind,
  TrailEvent,
  TrailOrder,
  TrailOrderStatus,
  TrailPage,
  TrailTone,
} from '../../services/ours/trail.js'

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
export const TRAIL_POLL_INTERVAL_MS = 4000

/**
 * 自动刷新封顶 2 分钟。再久就是真出问题了（缺货 / 上游卡住），
 * 一直轮询既费流量又让用户以为「再等等就好」，不如停下来让人点刷新或找客服。
 */
export const TRAIL_POLL_MAX_MS = 120000

/**
 * 渠道门禁：**只有自有渠道（ours）才显示支付记录入口**。
 *
 * 这一条是 #166 的教训：别的渠道连 `/api/trail` 这个域名都没有，
 * 渲染出来只会得到一串 401 / 网络错误。判定放在这里，容器只管调它。
 */
export const shouldShowPaymentTrail = (kind: string | undefined | null): boolean => kind === 'ours'

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

export type TrailView =
  | { status: 'loading' }
  | { status: 'error'; error: TrailErrorView }
  | { status: 'ok'; page: TrailPage | null }

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
 */
export async function loadTrailPage(params: {
  fetchTrail: TrailFetcher
  apiKey: string
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

/** 卡密块：完整卡号不进 DOM，只给后 4 位 + 积分 + 兑换状态 */
const cardNode = (card: TrailCard, c: TrailClassNames, t: TrailTranslate): ReactNode =>
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
    )
  )

const orderNode = (
  order: TrailOrder,
  index: number,
  c: TrailClassNames,
  t: TrailTranslate,
  btn: ViewButtonComponent,
  onCopyOrderNo?: (outTradeNo: string) => void
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
    order.card === null ? null : cardNode(order.card, c, t),
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
  onRetry?: () => void
  onRefresh?: () => void
  onCopyOrderNo?: (outTradeNo: string) => void
}

export const PaymentTrailView = (props: PaymentTrailViewProps): ReactNode => {
  const { t, classNames: c, button: btn, view, onRetry, onRefresh, onCopyOrderNo } = props
  const page = view.status === 'ok' ? view.page : null
  const orders = page?.orders ?? []

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
          createElement('span', { className: c.count }, t('oursTrailCount', { total: page.total })),
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
          t('oursTrailEmpty')
        )
      : null

  const list =
    orders.length === 0
      ? null
      : createElement(
          'ul',
          { className: c.list, 'data-testid': 'trail-order-list' },
          ...orders.map((order, index) => orderNode(order, index, c, t, btn, onCopyOrderNo))
        )

  return createElement(
    'div',
    { className: c.root, 'data-testid': 'payment-trail' },
    head,
    loading,
    error,
    empty,
    list
  )
}

// ------------------------------------------------------------------ 卡密溯源

export type CardTrailView =
  | { status: 'loading' }
  | { status: 'error'; error: TrailErrorView }
  | { status: 'ok'; trail: CardTrail | null }

export type CardTrailPanelProps = {
  t: TrailTranslate
  classNames: TrailClassNames
  view: CardTrailView
}

/** 卡密溯源面板：这张卡怎么来的、积分到账了没、是不是本人兑换的 */
export const CardTrailPanel = (props: CardTrailPanelProps): ReactNode => {
  const { t, classNames: c, view } = props
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
      t(view.error.messageKey)
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
    { className: c.cardPanel, 'data-testid': 'trail-card-panel', 'data-redeemed': redemption.redeemed ? 'true' : 'false' },
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
        )
  )
}

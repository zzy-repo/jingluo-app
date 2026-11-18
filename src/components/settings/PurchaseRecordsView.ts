import { createElement, type ReactNode } from 'react'
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import {
  hasNextPage,
  maskCardNo,
  type PurchaseOrder,
  type PurchasePage,
  type PurchaseStatus,
} from '../../services/ours/purchases.js'

/**
 * 「我的购买」的**展示层 + 全部判定逻辑**（Issue #158）。
 *
 * 为什么单独一层（沿用 `importSkipped.ts` 的做法）：纯 Node 的 `node --test` 只认得 `.ts`，
 * 认不出 `.tsx`（JSX 不在类型擦除范围内），所以容器 `PurchaseRecordsDialog.tsx` 里的 JSX
 * 没法在单测里真渲染。把「怎么显示 / 要不要显示」整块搬到不带 JSX、也不 import CSS 的本文件：
 *  - 用 `createElement` 而不是 JSX；
 *  - 样式类名与翻译函数由调用方注入（真机是 CSS Module 与 `useTranslate()`，单测是假 classNames 与真实 zh 文案）。
 * 这样 `tests/unit/purchases-ui.test.mjs` 能对**真的组件代码**跑 `renderToStaticMarkup`，
 * 而不是对着测试自己复刻的一份假 DOM 断言。
 */

/** 翻译函数：组件不自己取语言，交给调用方 */
export type PurchaseTranslate = (key: TranslationKey, params?: TranslationParams) => string

/** 样式注入：不在这里 import CSS Module，测试环境也就能直接渲染 */
export type PurchaseClassNames = Record<string, string | undefined>

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
export const PURCHASE_PAGE_SIZE = 20

/** 筛选 tab：「全部」之外三个都直接映射到后端小写 `status` 取值 */
export type PurchaseTab = 'all' | 'fulfilled' | 'pending' | 'expired'

export const PURCHASE_TABS: readonly { value: PurchaseTab; labelKey: TranslationKey }[] = [
  { value: 'all', labelKey: 'oursPurchasesTabAll' },
  { value: 'fulfilled', labelKey: 'oursPurchasesTabFulfilled' },
  { value: 'pending', labelKey: 'oursPurchasesTabPending' },
  { value: 'expired', labelKey: 'oursPurchasesTabExpired' },
]

/** 卡片主操作：两种跳转都**复用**既有的「额度与卡密」弹层，不在这里另写一套兑换 / 下单 */
export type CardAction = 'redeem' | 'pay' | 'none'

/** tab → 传给后端的 `status`。「全部」传 null，表示不带筛选条件 */
export const tabToStatus = (tab: PurchaseTab): PurchaseStatus | null =>
  tab === 'all' ? null : tab

/**
 * 一张订单能做什么。先看发卡再看支付：
 * 已经发了卡的单子能做的只有「去兑换」；`pending`（待支付）才给「去支付」；
 * 其余（已兑换 / 已过期 / 失败 / 已支付但尚未发卡）没有主操作。
 */
export const cardActionFor = (order: PurchaseOrder): CardAction => {
  if (order.redeemState === 'issued') {
    return 'redeem'
  }
  if (order.status === 'pending') {
    return 'pay'
  }
  return 'none'
}

/** 完整卡号只在「已兑换」且确实有卡号时才允许展开 */
export const canExpandCard = (order: PurchaseOrder): boolean =>
  order.redeemState === 'redeemed' && typeof order.cardNo === 'string' && order.cardNo !== ''

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * 服务端时间戳可能是秒也可能是毫秒（`paymentRecords` 那边是秒）。
 * ≥ 1e12 视为毫秒（约 2001 年之后），否则按秒补零。无法解析时返回 null。
 */
const toMillis = (value: number): number | null => {
  if (!Number.isFinite(value) || value <= 0) {
    return null
  }
  return value >= 1e12 ? value : value * 1000
}

/** 本地时区的 `YYYY-MM-DD HH:mm`：用户看到的必须是自己的时间，不是 UTC */
export const formatPurchaseTime = (createdAt: number): string => {
  const ms = toMillis(createdAt)
  if (ms === null) {
    return '—'
  }
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return '—'
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const formatYuan = (yuan: number): string =>
  `¥${(Number.isFinite(yuan) ? yuan : 0).toFixed(2)}`

/** 错误视图：文案全部落在 i18n key 上，界面里不出现英文原文 */
export type PurchaseErrorView = {
  messageKey: TranslationKey
  retryable: boolean
  needsKey: boolean
}

const ERROR_KEYS: Record<string, TranslationKey> = {
  keyMissing: 'oursPurchasesErrKeyMissing',
  unauthorized: 'oursPurchasesErrUnauthorized',
  rateLimited: 'oursPurchasesErrRateLimited',
  timeout: 'oursPurchasesErrTimeout',
  network: 'oursPurchasesErrNetwork',
  server: 'oursPurchasesErrServer',
  rejected: 'oursPurchasesErrRejected',
  badResponse: 'oursPurchasesErrBadResponse',
}

const RETRYABLE_KINDS = new Set(['timeout', 'network', 'server', 'rateLimited'])
const NEEDS_KEY_KINDS = new Set(['keyMissing', 'unauthorized'])

/**
 * 数据层抛 `PurchaseError`（`kind` 是字段，`retryable` / `needsKey` 是 getter）。
 * 这里**按结构读**而不是 `instanceof`：两个 PR 并行合入，数据层的类名与导出还可能微调，
 * 结构读取不会因为「导出的名字变了」就整页编译不过。
 */
export const describePurchaseError = (error: unknown): PurchaseErrorView => {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null
  const kind = typeof record?.kind === 'string' ? record.kind : ''
  return {
    messageKey: ERROR_KEYS[kind] ?? 'oursPurchasesErrUnknown',
    retryable:
      typeof record?.retryable === 'boolean' ? record.retryable : RETRYABLE_KINDS.has(kind),
    needsKey: typeof record?.needsKey === 'boolean' ? record.needsKey : NEEDS_KEY_KINDS.has(kind),
  }
}

export type PurchasesView =
  | { status: 'loading' }
  | { status: 'ok'; page: PurchasePage }
  | { status: 'error'; error: PurchaseErrorView }

/** 与数据层 `fetchPurchases` 同签名：测试注入假实现，生产用真实现 */
export type FetchPurchases = (params: {
  apiKey: string
  limit?: number
  offset?: number
  status?: PurchaseStatus | null
}) => Promise<PurchasePage>

/**
 * 拉一页并归一成视图状态（永不抛）。没有 API Key 时**一条请求都不发**：
 * 查不到归属，发了也只是必然失败的一次往返。
 */
export const loadPurchasePage = async ({
  fetchPurchases: load,
  apiKey,
  tab,
  offset,
}: {
  fetchPurchases: FetchPurchases
  apiKey: string
  tab: PurchaseTab
  offset: number
}): Promise<PurchasesView> => {
  if (apiKey.trim() === '') {
    return {
      status: 'error',
      error: { messageKey: 'oursPurchasesErrKeyMissing', retryable: false, needsKey: true },
    }
  }
  try {
    const page = await load({
      apiKey,
      limit: PURCHASE_PAGE_SIZE,
      offset,
      status: tabToStatus(tab),
    })
    return { status: 'ok', page }
  } catch (error) {
    return { status: 'error', error: describePurchaseError(error) }
  }
}

// ------------------------------------------------------------------ 展示层

export type PurchaseRecordsViewProps = {
  t: PurchaseTranslate
  classNames: PurchaseClassNames
  /** 设计系统按钮（注入，见文件头） */
  button: ViewButtonComponent
  tab: PurchaseTab
  view: PurchasesView
  /** 展开查看完整卡号的那一单（同一时刻只展开一条；只在内存里） */
  expandedCard: string | null
  onTab: (tab: PurchaseTab) => void
  onRetry: () => void
  onPrev: () => void
  onNext: () => void
  onToggleCard: (outTradeNo: string) => void
  onCardAction: (order: PurchaseOrder, action: CardAction) => void
}

export const PurchaseRecordsView = ({
  t,
  classNames: c,
  button: btn,
  tab,
  view,
  expandedCard,
  onTab,
  onRetry,
  onPrev,
  onNext,
  onToggleCard,
  onCardAction,
}: PurchaseRecordsViewProps): ReactNode => {
  const page = view.status === 'ok' ? view.page : null
  const total = page === null ? 0 : page.total
  const canPrev = page !== null && page.offset > 0
  const canNext = page !== null && hasNextPage(page)

  // 累计实付是账号级口径，不受当前 tab 影响，所以一直用服务端返回的 total_paid_yuan
  const summary = createElement(
    'div',
    { className: c.summary, 'data-testid': 'purchases-summary' },
    createElement('span', { className: c.summaryLabel }, t('oursPurchasesTotalPaid')),
    createElement(
      'span',
      { className: c.summaryValue },
      page === null ? '—' : formatYuan(page.totalPaidYuan)
    )
  )

  const tabs = createElement(
    'div',
    { role: 'tablist', 'aria-label': t('oursPurchasesTitle'), className: c.tabs },
    ...PURCHASE_TABS.map((item) =>
      createElement(
        'button',
        {
          key: item.value,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === item.value,
          className: tab === item.value ? `${c.tab ?? ''} ${c.tabActive ?? ''}`.trim() : c.tab,
          'data-testid': `purchases-tab-${item.value}`,
          onClick: () => onTab(item.value),
        },
        t(item.labelKey)
      )
    )
  )

  const loading =
    view.status === 'loading'
      ? createElement(
          'div',
          { className: c.hint, 'data-testid': 'purchases-loading' },
          t('oursPurchasesLoading')
        )
      : null

  const error =
    view.status === 'error'
      ? createElement(
          'div',
          { className: c.error, role: 'alert', 'data-testid': 'purchases-error' },
          createElement('div', null, t(view.error.messageKey)),
          view.error.needsKey
            ? createElement('div', { className: c.hint }, t('oursPurchasesNeedKey'))
            : null,
          view.error.retryable
            ? createElement(
                'div',
                { className: c.actions },
                btn({
                  variant: 'outlined',
                  size: 's',
                  testId: 'purchases-retry',
                  onClick: onRetry,
                  children: t('oursPurchasesRetry'),
                })
              )
            : null
        )
      : null

  const empty =
    page !== null && page.orders.length === 0
      ? createElement(
          'div',
          { className: c.hint, 'data-testid': 'purchases-empty' },
          tab === 'all' ? t('oursPurchasesEmpty') : t('oursPurchasesEmptyFiltered')
        )
      : null

  const rows =
    page !== null && page.orders.length > 0
      ? page.orders.map((order) => {
          const action = cardActionFor(order)
          const opened = expandedCard === order.outTradeNo
          const tail = maskCardNo(order.cardNo)
          const expandable = canExpandCard(order)
          return createElement(
            'li',
            {
              key: order.outTradeNo,
              className: c.item,
              'data-status': order.status,
              'data-out-trade-no': order.outTradeNo,
              'data-testid': 'purchase-item',
            },
            createElement(
              'div',
              { className: c.itemHead },
              createElement('span', { className: c.planName }, order.planName),
              createElement('span', { className: c.amount }, formatYuan(order.amountYuan))
            ),
            createElement(
              'div',
              { className: c.meta },
              createElement(
                'span',
                { className: c.status, 'data-status': order.status },
                order.statusText
              ),
              createElement('span', { className: c.time }, formatPurchaseTime(order.createdAt)),
              tail === ''
                ? null
                : createElement(
                    'span',
                    { className: c.cardTail },
                    `${t('oursPurchasesCardTail')} ${tail}`
                  ),
              order.redeemState === 'redeemed'
                ? createElement('span', { className: c.redeemed }, t('oursPurchasesRedeemed'))
                : null
            ),
            action === 'none' && !expandable
              ? null
              : createElement(
                  'div',
                  { className: c.itemFoot },
                  expandable
                    ? btn({
                        variant: 'outlined',
                        size: 's',
                        testId: 'purchase-card-toggle',
                        onClick: () => onToggleCard(order.outTradeNo),
                        children: opened
                          ? t('oursPurchasesHideCard')
                          : t('oursPurchasesShowCard'),
                      })
                    : null,
                  action === 'redeem'
                    ? btn({
                        variant: 'primary',
                        size: 's',
                        testId: 'purchase-redeem',
                        onClick: () => onCardAction(order, 'redeem'),
                        children: t('oursPurchasesGoRedeem'),
                      })
                    : null,
                  action === 'pay'
                    ? btn({
                        variant: 'primary',
                        size: 's',
                        testId: 'purchase-pay',
                        onClick: () => onCardAction(order, 'pay'),
                        children: t('oursBuyAction'),
                      })
                    : null
                ),
            // 完整卡号只在用户点开之后才进 DOM，且只留在组件内存里（不进日志 / 存储）
            opened ? createElement('div', { className: c.cardNo, 'data-testid': 'purchase-card-no' }, order.cardNo) : null
          )
        })
      : null

  const list = rows === null ? null : createElement('ul', { className: c.list, 'data-testid': 'purchases-list' }, ...rows)

  const pager =
    page === null
      ? null
      : createElement(
          'div',
          { className: c.pager },
          createElement(
            'span',
            { className: c.count, 'data-testid': 'purchases-count' },
            t('oursPurchasesCount', { total })
          ),
          createElement(
            'div',
            { className: c.actions },
            btn({
              variant: 'outlined',
              size: 's',
              disabled: !canPrev,
              testId: 'purchases-prev',
              onClick: onPrev,
              children: t('oursPurchasesPrev'),
            }),
            btn({
              variant: 'outlined',
              size: 's',
              disabled: !canNext,
              testId: 'purchases-next',
              onClick: onNext,
              children: t('oursPurchasesNext'),
            })
          )
        )

  return createElement('div', { className: c.root, 'data-testid': 'purchases-root' }, summary, tabs, loading, error, empty, list, pager)
}

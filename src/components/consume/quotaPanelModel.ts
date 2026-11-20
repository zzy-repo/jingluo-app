/**
 * 「我的额度」面板（W1-C2 #487 / 契约 §3.3）。
 *
 * 额度**只有一个入口**：`GET /v1/usage`（sk- Key 通道，`consume.usage.gateway()`）。
 * 账号余额走另外一个接口（`/api/v1/user/profile`），所以这里不读它也**不推导**它 ——
 * 界面上「余额 / 已用 / 剩余」三个数全部来自这一次响应：
 *   · 余额 = `balance`（钱包模式）→ 缺了就用 `remaining`（受限 Key 的剩余额度）；
 *   · 已用 = **`spent`（= `usage.total.actual_cost`）**，**不是** `quota.used`
 *     —— 实测 `quota.used` 恒为 0，用它会把「已经花掉的钱」显示成 0（#484 §4.5 第 10 条）；
 *   · 剩余 = `remaining`；`quota.limit === 0` 表示**不限**而不是零额度。
 *
 * 没有 Key 时**不假装查过**：直接给「去账号页创建 Key」的引导（`noKey` 态），
 * 因为 `/v1/usage` 用 JWT 打会拿到 401 或网关的 `API_KEY_REQUIRED`，两种都不该让用户看见。
 */

import { createElement, type ReactNode } from 'react'

import type { ConsumeCallResult, ConsumeGatewayUsage, ConsumeUsageQuery } from '../../services/consume/index.js'
import {
  emptyBlock,
  errorBlock,
  firstNum,
  firstStr,
  formatDateTime,
  loadingBlock,
  numOf,
  panelFromResult,
  panelLoading,
  panelReady,
  panelShell,
  asRecord,
  statRow,
  toPanelError,
  formatCurrency,
  type PanelAsync,
  type PanelBlockProps,
  type PanelError,
} from './panels.js'

/** 面板只需要客户端这三样（结构化取子集，单测给假实现即可，不必造整个 client） */
export type QuotaSource = {
  hasApiKey: () => boolean
  usage: {
    gateway: () => Promise<ConsumeCallResult<ConsumeGatewayUsage>>
    list: (query?: ConsumeUsageQuery) => Promise<ConsumeCallResult<unknown>>
  }
}

/** 每页条数（界面与请求共用；服务端默认 20） */
export const QUOTA_USAGE_PAGE_SIZE = 10

/** 额度区三态 + `noKey`（没有 Key 不是错误，是「还没开始用」） */
export type QuotaState = { phase: 'noKey' } | PanelAsync<ConsumeGatewayUsage>

/** 用量列表里的一行：字段随服务端版本变，这里只挑界面能显示的四个 */
export type QuotaUsageRow = {
  id: string
  model: string
  at: string
  requests: number
  cost: number
}

export type QuotaUsagePage = {
  items: QuotaUsageRow[]
  page: number
  pages: number
  total: number
}

/** 汇总后的三个数 + 计划名（view 只认这一份，避免在渲染里散着算） */
export type QuotaSummary = {
  balance?: number
  spent: number
  remaining?: number
  /** `quota.limit === 0` = 不限（不是零额度） */
  unlimited: boolean
  /**
   * 要不要单独显示「剩余」。
   *
   * 钱包模式（`unrestricted`）下 `remaining` 就等于余额（服务端已扣过消费），再显示一行「剩余」
   * 会变成「余额 ¥11.83 / 已用 ¥0.05 / 剩余 ¥11.83」这种看着像算错的三个数；限额模式才需要它。
   */
  showRemaining: boolean
  planName: string
  requests: number
  tokens: number
}

export const quotaSummaryOf = (usage: ConsumeGatewayUsage): QuotaSummary => {
  const limit = usage.quota === undefined ? undefined : usage.quota.limit
  const limited = usage.mode === 'quota_limited'
  const balance = firstNum(usage.balance, usage.remaining)
  return {
    balance,
    // **已用**只认 spent（actual_cost）；`quota.used` 实测恒为 0，绝不用它
    spent: firstNum(usage.spent, usage.usageTotal?.actualCost) ?? 0,
    remaining: firstNum(usage.remaining, usage.quota?.remaining),
    // 「不限」只对**限额模式**有意义：钱包模式的 limit 常是 0，但含义是「这个字段不适用」
    unlimited: limited && limit === 0,
    showRemaining: limited || balance === undefined,
    planName: usage.planName ?? '',
    requests: numOf(usage.usageTotal?.requests) ?? 0,
    tokens: numOf(usage.usageTotal?.totalTokens) ?? 0,
  }
}

/**
 * 读一次额度。
 *
 * 没有 sk- Key 时**不发请求**（`noKey`）：这条通道的鉴权就是 Key 本身，
 * 用 JWT 硬打只会拿到 401 / `API_KEY_REQUIRED`，把「还没创建 Key」误报成「登录失效」。
 */
export const loadQuota = async (source: QuotaSource): Promise<QuotaState> => {
  if (!source.hasApiKey()) {
    return { phase: 'noKey' }
  }
  return panelFromResult(await source.usage.gateway())
}

/** 用量列表的一页（`/api/v1/usage`：JWT 通道，字段随版本变 → 容错解析） */
export const loadUsagePage = async (
  source: QuotaSource,
  page: number
): Promise<PanelAsync<QuotaUsagePage>> => {
  const result = await source.usage.list({ page, pageSize: QUOTA_USAGE_PAGE_SIZE })
  if (!result.ok) {
    return { phase: 'failed', error: toPanelError(result.error) }
  }
  return panelReady(toUsagePage(result.data))
}

/**
 * 容错解析用量列表。
 *
 * `list()` 的返回类型是 `unknown`（契约 §4.5 第 9 条：列表 / 汇总 / dashboard 三处字段不同，
 * 客户端层不硬编码）。这里只认「数组 + 常见字段名」，认不出的行**跳过**而不是渲染 `undefined`;
 * 一页都认不出时是空列表（空列表是正常态）。
 *
 * TODO(W1-A)：等 `usage.list()` 有正式类型后，这个函数应当只做字段改名，不做猜测。
 */
export const toUsagePage = (value: unknown): QuotaUsagePage => {
  const body = asRecord(value)
  const rawItems = Array.isArray(value)
    ? value
    : Array.isArray(body.items)
      ? body.items
      : Array.isArray(body.list)
        ? body.list
        : []
  const items: QuotaUsageRow[] = []
  rawItems.forEach((item, index) => {
    const row = asRecord(item)
    const model = firstStr(row.model, row.model_name, row.channel_name)
    const at = firstStr(row.created_at, row.createdAt, row.date, row.time)
    const requests = firstNum(row.requests, row.request_count, row.count) ?? 1
    const cost = firstNum(row.actual_cost, row.cost, row.total_cost, row.amount) ?? 0
    // 服务端的 id 常常是数字：`firstStr` 只认字符串，所以这里单独判一次
    const rawId = row.id === undefined ? undefined : row.id
    const id = typeof rawId === 'number' ? String(rawId) : firstStr(rawId, row.request_id, row.log_id)
    if (id === '' && model === '' && at === '') {
      return
    }
    items.push({
      id: id === '' ? `${index}` : id,
      model,
      at,
      requests,
      cost,
    })
  })
  const page = numOf(body.page) ?? numOf(body.current_page) ?? 1
  const pages = numOf(body.pages) ?? numOf(body.total_pages) ?? (items.length > 0 ? page : 0)
  const total = numOf(body.total) ?? items.length
  return { items, page, pages, total }
}

/** 追加下一页（按 id 去重：翻页期间服务端可能插入新记录，重复行比少一行更刺眼） */
export const appendUsagePage = (
  state: PanelAsync<QuotaUsagePage>,
  next: QuotaUsagePage
): PanelAsync<QuotaUsagePage> => {
  if (state.phase !== 'ready') {
    return panelReady(next)
  }
  const seen = new Set(state.data.items.map((row) => row.id))
  const merged = state.data.items.concat(next.items.filter((row) => !seen.has(row.id)))
  return panelReady({ ...next, items: merged, total: Math.max(next.total, merged.length) })
}

/** 还有下一页：只信服务端给的 `pages`（不拿 items.length 推） */
export const hasMoreUsage = (state: PanelAsync<QuotaUsagePage>): boolean =>
  state.phase === 'ready' && state.data.page < state.data.pages

export type QuotaPanelViewProps = PanelBlockProps & {
  quota: QuotaState
  expanded: boolean
  /** `null` = 还没展开过（懒加载，不在首屏白打一次列表） */
  usage: PanelAsync<QuotaUsagePage> | null
  loadingMore: boolean
  /** 「加载更多」这一页失败：记录还在，只在底部给错误 + 重试 */
  loadMoreError: PanelError | null
  onToggle: () => void
  onLoadMore: () => void
  onRetryQuota: () => void
  onRetryUsage: () => void
}

const usageRows = ({ t, c }: PanelBlockProps, rows: QuotaUsageRow[]): ReactNode =>
  createElement(
    'ul',
    { className: c.list, 'data-testid': 'quota-usage-list' },
    rows.map((row) =>
      createElement(
        'li',
        { className: c.listItem, key: row.id, 'data-testid': 'quota-usage-row' },
        createElement(
          'div',
          { className: c.listMain },
          createElement('span', { className: c.listTitle }, row.model === '' ? '—' : row.model),
          createElement('span', { className: c.listMeta }, formatDateTime(row.at))
        ),
        createElement(
          'div',
          { className: c.listSide },
          createElement('span', { className: c.listValue }, formatCurrency(row.cost)),
          createElement('span', { className: c.listMeta }, t('consumeRequestsCount', { count: row.requests }))
        )
      )
    )
  )

/** 额度面板（纯渲染：状态、重试、复制全由容器注入） */
export const QuotaPanelView = (props: QuotaPanelViewProps): ReactNode => {
  const { t, c, Button, quota, expanded, usage, loadingMore, loadMoreError, onToggle, onLoadMore, onRetryQuota, onRetryUsage } =
    props
  const body: ReactNode[] = []

  if (quota.phase === 'noKey') {
    body.push(
      createElement(
        'div',
        { className: c.guide, 'data-testid': 'quota-no-key' },
        createElement('p', { className: c.guideTitle }, t('consumeNoKeyTitle')),
        createElement('p', { className: c.hint }, t('consumeNoKeyBody'))
      )
    )
  } else if (quota.phase === 'loading') {
    body.push(loadingBlock(props))
  } else if (quota.phase === 'failed') {
    body.push(errorBlock(props, quota.error, onRetryQuota, 'quota-error'))
  } else {
    const summary = quotaSummaryOf(quota.data)
    body.push(
      createElement(
        'div',
        { className: c.stats, 'data-testid': 'quota-stats' },
        statRow(c, t('consumeBalanceLabel'), formatCurrency(summary.balance), 'quota-balance'),
        statRow(c, t('consumeUsed'), formatCurrency(summary.spent), 'quota-spent'),
        ...(summary.showRemaining
          ? [
              statRow(
                c,
                t('consumeRemaining'),
                summary.unlimited ? t('consumeUnlimited') : formatCurrency(summary.remaining),
                'quota-remaining'
              ),
            ]
          : [])
      )
    )
    if (summary.planName !== '') {
      body.push(createElement('p', { className: c.hint }, summary.planName))
    }
    if (summary.requests > 0) {
      body.push(
        createElement(
          'p',
          { className: c.hint },
          `${t('consumeRequestsCount', { count: summary.requests })} · ${t('consumeTokensCount', { count: summary.tokens })}`
        )
      )
    }
    body.push(
      createElement(
        'div',
        { className: c.actions },
        createElement(
          Button,
          { size: 's', variant: 'outlined', testId: 'quota-toggle', onClick: onToggle },
          t('consumeUsage')
        )
      )
    )
    if (expanded) {
      if (usage === null || usage.phase === 'loading') {
        body.push(loadingBlock(props))
      } else if (usage.phase === 'failed') {
        body.push(errorBlock(props, usage.error, onRetryUsage, 'quota-usage-error'))
      } else if (usage.data.items.length === 0) {
        body.push(emptyBlock(props, t('consumeUsageEmpty'), 'quota-usage-empty'))
      } else {
        body.push(usageRows(props, usage.data.items))
        if (loadMoreError !== null) {
          body.push(errorBlock(props, loadMoreError, onLoadMore, 'quota-more-error'))
        }
        if (hasMoreUsage(usage)) {
          body.push(
            createElement(
              'div',
              { className: c.actions },
              createElement(
                Button,
                { size: 's', variant: 'outlined', disabled: loadingMore, testId: 'quota-load-more', onClick: onLoadMore },
                loadingMore ? t('consumeLoadingMore') : t('consumeLoadMore')
              )
            )
          )
        }
      }
    }
  }

  return panelShell(c, t('consumeQuota'), body, 'quota-panel')
}

/** 首屏状态：有 Key 也先给 `loading`，避免闪一下空态 */
export const initialQuotaState = (source: QuotaSource): QuotaState =>
  source.hasApiKey() ? panelLoading<ConsumeGatewayUsage>() : { phase: 'noKey' }

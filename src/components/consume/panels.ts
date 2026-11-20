/**
 * 四个「账户与消费」面板（额度 / 账号 / 邀请 / 邮箱绑定）**共用的那一层**（W1-C2 #487）。
 *
 * 为什么单独一层（沿用 `settings/PurchaseRecordsView.ts` / `settings/PaymentTrailView.ts` 的做法）：
 * 纯 Node 的 `node --test` 只认 `.ts`，认不出 `.tsx`（JSX 不在类型擦除范围内）。把这几个面板里
 * 「会做判断」的部分（异步状态、错误文案、金额格式化、Key 遮蔽、动作 → 事件的纯函数）放在这里，
 * 单测才能对**真代码**跑 `renderToStaticMarkup` 并直接断言分支，而不是对着测试自己复刻的一份假 DOM。
 *
 * 三条口径（都是硬要求，改这里之前先看 #484）：
 *  1. **错误文案只认 `error.i18nKey`**：服务端的英文 `message` 只进日志，永不上屏；
 *     只有 `retryable === true` 时才渲染「重试」，业务失败（401/403/404/409）重试只会更糟。
 *  2. **金额一律「元」（CNY，1 元 = 1 额度）**：符号与小数位只由 {@link formatCurrency} 一处决定，
 *     四个面板都走它（没有 `$`、没有「积分」）；服务端若给 `{amount, currency}`，按 `currency` 渲染。
 *     不缓存余额做「还能不能发消息」的判断（A4：额度只以服务端响应为准）。
 *  3. **Key 原文只露一次**：创建成功后完整 Key 只交给 {@link keyTail} 之外的**一次**渲染，
 *     列表里永远是 `••••` + 末 4 位；这里不打日志、不进 URL。
 */

import { createElement, type ReactNode } from 'react'

import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import type { ConsumeCallResult, Sub2ApiError } from '../../services/consume/index.js'

/** 翻译函数：面板不自己取语言，由容器注入（单测注入真实 zh 文案） */
export type ConsumeTranslate = (key: TranslationKey, params?: TranslationParams) => string

/** 样式注入：不 import CSS Module，测试环境也就能直接渲染（真机是 CSS Module 的类名表） */
export type PanelClassNames = Record<string, string | undefined>

/** 设计系统按钮的入参（真机是 `base/Button`，单测是等价的最小 `<button>` 替身） */
export type PanelButtonProps = {
  variant?: 'primary' | 'outlined' | 'danger' | 'dangerOutlined'
  size?: 'l' | 'm' | 's'
  block?: boolean
  disabled?: boolean
  className?: string
  /** 真机忽略这一项（设计系统没有 testId），单测靠它找按钮 */
  testId?: string
  onClick?: () => void
  children?: ReactNode
}

export type PanelButton = (props: PanelButtonProps) => ReactNode

// ------------------------------------------------------------------ 异步状态

/**
 * 上屏用的错误：从 `Sub2ApiError` 只挑「界面该用的」三样 —— 文案 key、能不能重试、要不要重新登录。
 *
 * `needLogin` 在转换时一次算清（`status === 401` 或会话类错误码），容器就不用再碰服务端错误对象。
 */
export type PanelError = {
  i18nKey: TranslationKey
  /** 文案里的占位符（`consumeErrRateLimited` 的 `{seconds}` 等）；没占位符就不带 */
  params?: TranslationParams
  retryable: boolean
  needLogin: boolean
  /** 排查用（不进 DOM）：服务端码或 `HTTP_<status>` */
  code: string
}

/** 异步区段的三态：加载中 / 有数据 / 失败（空列表是「有数据」而不是失败，#484 §4.5 第 9 条） */
export type PanelAsync<T> =
  | { phase: 'loading' }
  | { phase: 'ready'; data: T }
  | { phase: 'failed'; error: PanelError }

export const panelLoading = <T>(): PanelAsync<T> => ({ phase: 'loading' })

export const panelReady = <T>(data: T): PanelAsync<T> => ({ phase: 'ready', data })

/** 服务端没给 `Retry-After` 时的「稍后」秒数（只是文案里的数字，不是客户端自造的频控窗口） */
const RETRY_SECONDS_FALLBACK = 60

/**
 * 带占位符的 error key → 参数。
 *
 * `consumeErr*` 里只有两条带 `{…}`（#504）：`{seconds}`（限流）与 `{amount}`（余额不足）。
 * 前者用服务端 `Retry-After` 换算，没有就退到 {@link RETRY_SECONDS_FALLBACK}；
 * 后者服务端**不给缺口金额**，用 `—` 占位 —— 编一个数字比留空更误导。
 */
const errorParams = (error: Sub2ApiError): TranslationParams | undefined => {
  if (error.i18nKey === 'consumeErrRateLimited') {
    const seconds =
      error.retryAfterMs === undefined ? RETRY_SECONDS_FALLBACK : Math.max(1, Math.ceil(error.retryAfterMs / 1000))
    return { seconds }
  }
  if (error.i18nKey === 'consumeErrInsufficientBalance') {
    return { amount: '—' }
  }
  return undefined
}

/** `Sub2ApiError` → 上屏错误（文案只走 `i18nKey`；服务端 message 留在这里不上屏） */
export const toPanelError = (error: Sub2ApiError): PanelError => {
  const params = errorParams(error)
  return {
    i18nKey: error.i18nKey,
    ...(params === undefined ? {} : { params }),
    retryable: error.retryable,
    needLogin: error.status === 401 || isSessionCode(error.code),
    code: error.code,
  }
}

/**
 * 会话类错误码（与 `services/consume/errors.ts` 的 `isSessionError` 同一口径）。
 *
 * 这里只判码、不 import 那份实现：`errors.ts` 的判定包含 `USER_NOT_FOUND` 等业务码，
 * 而那些码在本层应当是「没权限」而不是「重新登录」。列表保持同步修改（两处都要看一眼）。
 */
const SESSION_CODES = [
  'UNAUTHORIZED',
  'INVALID_AUTH_HEADER',
  'EMPTY_TOKEN',
  'INVALID_TOKEN',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'SESSION_BINDING_MISMATCH',
]

export const isSessionCode = (code: string): boolean => SESSION_CODES.includes(code)

/** 本地参数校验失败（没有发请求）：`code` 固定成 `CLIENT_VALIDATION`，不可重试 */
export const localPanelError = (i18nKey: TranslationKey): PanelError => ({
  i18nKey,
  retryable: false,
  needLogin: false,
  code: 'CLIENT_VALIDATION',
})

/** `ConsumeCallResult` → 三态；`ok:false` 只带 `error.i18nKey` 上屏 */
export const panelFromResult = <T>(result: ConsumeCallResult<T>): PanelAsync<T> =>
  result.ok ? panelReady(result.data) : { phase: 'failed', error: toPanelError(result.error) }

// ------------------------------------------------------------------ 格式化

/**
 * 金额的小数位那一截（不含符号）。
 *
 * 小额（<0.01）保留 4 位：真实账单里 `actual_cost` 常常是 `0.0031` 这种量级，
 * 一律 `toFixed(2)` 会把「用了但没有」变成 `0.00`，比不显示更容易误导。
 */
export const amountText = (value: number | undefined | null): string => {
  const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const abs = Math.abs(amount)
  const digits = abs > 0 && abs < 0.01 ? 4 : 2
  return amount.toFixed(digits)
}

/** 币种符号：只认后端真的会给的两种，其余按 ISO 码前缀显示（不猜、不硬编码） */
const CURRENCY_SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }

/** 本仓当前口径：**没有 USD、没有积分，1 元 = 1 额度**（#487 计量单位统一） */
export const DEFAULT_CURRENCY = 'CNY'

/**
 * `¥12.34` —— 四个面板**唯一**的金额写法。
 *
 * 为什么不再走 i18n 的金额模板（`consumeBalance` 那种 `$…` 字符串）：符号必须跟 `currency` 走
 * （后端若回 `{amount, currency:"CNY"}` 就直接用它），而 i18n 的金额 key 由统一线负责，
 * 两边各改一遍就会出现「`$` + `¥` 叠着」的产物。这里只做一件事：符号 + 小数位。
 */
export const formatCurrency = (
  value: number | undefined | null,
  currency: string = DEFAULT_CURRENCY
): string => {
  const code = currency.trim().toUpperCase()
  const symbol = CURRENCY_SYMBOLS[code]
  const digits = amountText(value)
  return symbol === undefined ? `${code} ${digits}` : `${symbol}${digits}`
}

/** 服务端时间可能是秒 / 毫秒 / ISO 串：统一成毫秒；认不出回 null（界面显示 `—`） */
const toMillis = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null
    }
    // 秒级时间戳（10 位）与毫秒（13 位）都见过：小于 1e12 当秒
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** `2026-11-20 16:05`（本地时区）。认不出时间给 `—`，不抛错 */
export const formatDateTime = (value: string | number | null | undefined): string => {
  const ms = toMillis(value)
  if (ms === null) {
    return '—'
  }
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Key 的末 4 位（短到不足 4 位就整串返回：假 Key / 测试值不该被切成空串） */
export const keyTail = (key: string): string => (key.length <= 4 ? key : key.slice(-4))

/** 列表里能显示的 Key：`••••abcd`。**完整 Key 只允许出现在「刚创建」那一次渲染里** */
export const maskedKey = (key: string): string => `••••${keyTail(key)}`

/** 邮箱脱敏：`a***@example.com`（本地部分只留首字符；没有 @ 就整串打码） */
export const maskedEmail = (email: string): string => {
  const at = email.lastIndexOf('@')
  if (at <= 0) {
    return email === '' ? '' : '••••'
  }
  const local = email.slice(0, at)
  const domain = email.slice(at)
  return `${local.slice(0, 1)}•••${domain}`
}

// ------------------------------------------------------------------ 容错读取（服务端字段随版本变）

/** `unknown` → 对象（数组 / null / 基本类型都给空对象，调用点不用重复判） */
export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export const strOf = (value: unknown): string => (typeof value === 'string' ? value : '')

export const numOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** 取第一个能认的数字（字段名各版本不一致时按优先级试） */
export const firstNum = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const parsed = numOf(value)
    if (parsed !== undefined) {
      return parsed
    }
  }
  return undefined
}

/** 取第一个非空字符串 */
export const firstStr = (...values: unknown[]): string => {
  for (const value of values) {
    const parsed = strOf(value)
    if (parsed !== '') {
      return parsed
    }
  }
  return ''
}

// ------------------------------------------------------------------ 通用块（加载 / 空 / 错）

export type PanelBlockProps = {
  t: ConsumeTranslate
  c: PanelClassNames
  Button: PanelButton
}

/** 加载中：一行静态文案（不用骨架屏：面板高度会跳，反而更像卡住） */
export const loadingBlock = ({ t, c }: PanelBlockProps): ReactNode =>
  createElement('p', { className: c.hint, 'data-testid': 'panel-loading' }, t('consumeLoadingMore'))

/** 空态：所有空列表都走这里，文案由调用点给（各面板的「空」含义不同） */
export const emptyBlock = (props: PanelBlockProps, text: string, testId = 'panel-empty'): ReactNode =>
  createElement('p', { className: props.c.hint, 'data-testid': testId }, text)

/**
 * 失败：`error.i18nKey` 的文案 + **只有可重试时**才出现的重试按钮。
 * 会话失效（`needLogin`）额外给一句「请重新登录」，并由容器负责调 `onNeedLogin()`。
 */
export const errorBlock = (
  { t, c, Button }: PanelBlockProps,
  error: PanelError,
  onRetry?: () => void,
  testId = 'panel-error'
): ReactNode => {
  const canRetry = error.retryable && onRetry !== undefined
  return createElement(
    'div',
    { className: c.error, 'data-testid': testId },
    createElement('p', { className: c.errorText }, t(error.i18nKey, error.params)),
    error.needLogin ? createElement('p', { className: c.hint }, t('consumeNeedLogin')) : null,
    canRetry
      ? createElement(
          Button,
          { size: 's', variant: 'outlined', testId: 'panel-retry', onClick: onRetry },
          t('retry')
        )
      : null
  )
}

/** 小标题（各面板的分区标题） */
export const sectionTitle = (c: PanelClassNames, text: ReactNode): ReactNode =>
  createElement('h3', { className: c.sectionTitle }, text)

/**
 * 「值 + 复制按钮」的一行：邀请码 / 完整 Key 共用。
 * `copied` 由容器管（复制成功才显示「已复制」），这里不碰剪贴板。
 */
export const copyRow = (
  { t, c, Button }: PanelBlockProps,
  options: {
    value: string
    copied: boolean
    onCopy: () => void
    testId: string
    label?: ReactNode
    /** 按钮文案（默认通用「复制 / 已复制」；Key / 邀请码各自有更具体的既有文案） */
    copyLabel?: TranslationKey
    copiedLabel?: TranslationKey
  }
): ReactNode =>
  createElement(
    'div',
    { className: c.copyRow },
    options.label === undefined ? null : createElement('span', { className: c.label }, options.label),
    createElement('code', { className: c.copyValue, 'data-testid': `${options.testId}-value` }, options.value),
    createElement(
      Button,
      { size: 's', variant: 'outlined', testId: `${options.testId}-copy`, onClick: options.onCopy },
      options.copied ? t(options.copiedLabel ?? 'copied') : t(options.copyLabel ?? 'copy')
    )
  )

/**
 * 一对「标签 + 值」，金额与计数都用它（390/360 下靠 flex 自动换行）。
 * `wide` = 独占一行（邮箱这类长值必须；否则会在 390 上从中间断字）。
 */
export const statRow = (
  c: PanelClassNames,
  label: ReactNode,
  value: ReactNode,
  testId?: string,
  wide = false
): ReactNode =>
  createElement(
    'div',
    {
      className: wide ? `${c.stat ?? ''} ${c.statWide ?? ''}`.trim() : c.stat,
      ...(testId === undefined ? {} : { 'data-testid': testId }),
    },
    createElement('span', { className: c.statLabel }, label),
    createElement('span', { className: c.statValue }, value)
  )

/**
 * 面板外壳：标题 + 内容（四个面板共用同一套边距 / 圆角，避免各写一份容器样式）。
 *
 * 子节点用**变参**展开而不是把数组当 children 传：数组形式的 children 在 React 里等同于列表，
 * 每项都要求 `key`，而这些区块是静态结构、天然没有「列表」语义（用量 / Key 那种真列表才带 key）。
 */
export const panelShell = (c: PanelClassNames, title: ReactNode, children: ReactNode[], testId: string): ReactNode =>
  createElement(
    'section',
    { className: c.panel, 'data-testid': testId },
    createElement('h2', { className: c.panelTitle }, title),
    ...children
  )

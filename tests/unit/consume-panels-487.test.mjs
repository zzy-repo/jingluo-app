// [layer: unit | 依赖: 无（纯 Node + renderToStaticMarkup，零浏览器、零网络） | Issue #487 W1-C2]
//
// 四个「账户与消费」面板（额度 / 账号 / 邀请 / 邮箱绑定）的组件级覆盖。
//
// 被测的是**真代码**：展示与判定都在 `src/components/consume/*.ts`（无 JSX、不 import CSS），
// 所以裸 Node 能直接 import 并 `renderToStaticMarkup`；`.tsx` 容器只做「注射客户端 + dispatch」，
// 逻辑挪不出来。这里的断言分三类：
//   1. 纯逻辑（格式化 / 遮蔽 / 容错解析 / reducer）—— 直接调函数；
//   2. 动作（load / create / sendCode ...）—— 用假客户端跑，断言「发出了什么请求 + 回了哪些事件」；
//   3. 渲染 —— 对真视图跑 renderToStaticMarkup，断言文案 key 对应的中文与关键 data-testid。
//
// 盯住的四条硬要求（本单验收口径）：
//   · 错误文案只走 `error.i18nKey`，且**只有 retryable 才出现重试按钮**；
//   · 额度「已用」取 `spent`（=`usage.total.actual_cost`），不是恒为 0 的 `quota.used`；
//   · Key 完整值只显示一次，列表永远只有末 4 位；
//   · `invitationCodeEnabled=false` 整块不渲染；`emailVerifyEnabled=false` 不再强调「必须先验证」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { installTsResolve } from '../helpers/dom-env.mjs'

installTsResolve()

const { zh } = await import('../../src/i18n/zh.ts')
const {
  formatDateTime,
  keyTail,
  maskedEmail,
  maskedKey,
  panelFromResult,
  toPanelError,
  amountText,
  formatCurrency,
} = await import('../../src/components/consume/panels.ts')
const {
  QuotaPanelView,
  appendUsagePage,
  hasMoreUsage,
  initialQuotaState,
  loadQuota,
  loadUsagePage,
  quotaSummaryOf,
  toUsagePage,
} = await import('../../src/components/consume/quotaPanelModel.ts')
const {
  AccountPanelView,
  initialAccountState,
  loggedOut,
  reduceAccount,
  runCreateKey,
  runDeleteKey,
  runLoadAccount,
  runLogout,
  runToggleKey,
  toAccountProfile,
} = await import('../../src/components/consume/accountPanelModel.ts')
const { InvitePanelView, loadInvite, toInviteDetail } = await import(
  '../../src/components/consume/invitePanelModel.ts'
)
const {
  EMAIL_RESEND_FALLBACK_SECONDS,
  EmailBindPanelView,
  initialEmailBindState,
  looksLikeEmail,
  reduceEmailBind,
  runBindEmail,
  runLoadEmailBind,
  runSendCode,
  runUnbindEmail,
  toEmailBindInfo,
} = await import('../../src/components/consume/emailBindPanelModel.ts')
const { emailCooldownRemaining } = await import('../../src/services/invite/emailCooldown.ts')

// ------------------------------------------------------------------ 装配

/** 与 i18n/index.ts 同一套占位符规则（不 import 那份带 zustand 的实现） */
const t = (key, params) => {
  const text = zh[key]
  assert.equal(typeof text, 'string', `文案表里没有键 ${String(key)}`)
  return text.replace(/\{(\w+)\}/gu, (whole, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole
  })
}

/** 设计系统 Button 的替身：testId → data-testid，其余透传 */
const Button = ({ testId, children, onClick, ...rest }) =>
  createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

const c = new Proxy({}, { get: (_target, name) => String(name) })

/** 渲染一个视图（视图函数直接返回 React 元素） */
const html = (element) => renderToStaticMarkup(element ?? createElement('div'))

const hasTestId = (markup, testId) => markup.includes(`data-testid="${testId}"`)

const RAW = { status: 200, ok: true, text: '', json: null, headers: {}, contentType: 'application/json' }

const ok = (data, raw) => ({ ok: true, data, status: 200, raw: raw ?? RAW })

const fail = ({ status = 500, code = 'INTERNAL_ERROR', kind = 'server', i18nKey = 'consumeErrServerUnavailable', retryable = status >= 500 || status === 429 } = {}) => ({
  ok: false,
  status,
  raw: { ...RAW, status, ok: false },
  error: { kind, code, message: 'server said something in english', status, retryable, envelope: 'panel', i18nKey },
})

/** 一把 Key（末 4 位 9f2c，用来断言「列表只显示尾 4 位」） */
const apiKey = (over = {}) => ({
  id: 7,
  name: '我的第一把',
  key: 'sk-live-0123456789abcdef9f2c',
  status: 'active',
  quota: 0,
  quotaUsed: 0,
  ...over,
})

// ------------------------------------------------------------------ 1. 纯逻辑

test('金额：一律「元」（¥），小额保 4 位；符号按 currency 走、不硬编码', () => {
  assert.equal(amountText(12.3), '12.30')
  assert.equal(amountText(0.0031), '0.0031')
  assert.equal(amountText(undefined), '0.00')
  // 默认 CNY：1 元 = 1 额度，没有 $、没有「积分」
  assert.equal(formatCurrency(1.5), '¥1.50')
  assert.equal(formatCurrency(11.83), '¥11.83')
  assert.equal(formatCurrency(0), '¥0.00')
  // 后端若给别的币种（{amount, currency}），符号跟着 currency 走
  assert.equal(formatCurrency(1.5, 'USD'), '$1.50')
  assert.equal(formatCurrency(1.5, 'CNY'), '¥1.50')
  assert.equal(formatCurrency(1.5, 'JPY'), 'JPY 1.50')
  assert.ok(!formatCurrency(9.9).includes('$'), '默认不许出现美元符号')
})

test('Key / 邮箱遮蔽：列表只露末 4 位，邮箱只留首字母', () => {
  assert.equal(keyTail('sk-live-abcdef9f2c'), '9f2c')
  assert.equal(keyTail('ab'), 'ab')
  assert.equal(maskedKey('sk-live-abcdef9f2c'), '••••9f2c')
  assert.equal(maskedEmail('someone@example.com'), 's•••@example.com')
  assert.equal(maskedEmail('no-at-sign'), '••••')
})

test('时间：秒 / 毫秒 / ISO 都认，认不出给 — 而不是 Invalid Date', () => {
  const ms = Date.UTC(2026, 10, 20, 8, 5)
  const local = formatDateTime(ms)
  assert.match(local, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u)
  // 秒级时间戳（10 位）与毫秒级（13 位）指同一刻
  assert.equal(formatDateTime(Math.floor(ms / 1000)), local)
  assert.equal(formatDateTime('2026-11-20T08:05:00.000Z'), local)
  assert.equal(formatDateTime('不是时间'), '—')
  assert.equal(formatDateTime(undefined), '—')
})

test('错误：带占位符的文案（限流 {seconds}）由 retryAfterMs 换算，不把 {seconds} 漏到界面上', () => {
  const throttled = fail({ status: 429, kind: 'rate_limit', code: 'HTTP_429', i18nKey: 'consumeErrRateLimited', retryable: true })
  throttled.error.retryAfterMs = 42000
  const panelError = toPanelError(throttled.error)
  assert.deepEqual(panelError.params, { seconds: 42 }, 'Retry-After 42s → 文案里的 42 秒')
  const markup = html(
    QuotaPanelView({
      t,
      c,
      Button,
      quota: { phase: 'failed', error: panelError },
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle: () => {},
      onLoadMore: () => {},
      onRetryQuota: () => {},
      onRetryUsage: () => {},
    })
  )
  assert.ok(markup.includes(t('consumeErrRateLimited', { seconds: 42 })))
  assert.ok(!markup.includes('{seconds}'), '占位符不许原样出现在界面上')

  // 服务端没给 Retry-After：文案用兜底秒数，仍不出现裸占位符
  const noHeader = toPanelError(fail({ status: 429, kind: 'rate_limit', code: 'HTTP_429', i18nKey: 'consumeErrRateLimited', retryable: true }).error)
  assert.equal(typeof noHeader.params.seconds, 'number')
})

test('错误：ok:false 只带 i18nKey / retryable / needLogin，服务端英文 message 不上屏', () => {
  const unauthorized = toPanelError(fail({ status: 401, kind: 'auth', code: 'UNAUTHORIZED', i18nKey: 'consumeErrUnauthorized', retryable: false }).error)
  assert.deepEqual(
    { i18nKey: unauthorized.i18nKey, retryable: unauthorized.retryable, needLogin: unauthorized.needLogin },
    { i18nKey: 'consumeErrUnauthorized', retryable: false, needLogin: true }
  )
  const serverDown = panelFromResult(fail())
  assert.equal(serverDown.phase, 'failed')
  assert.equal(serverDown.error.retryable, true)
  assert.equal(serverDown.error.needLogin, false)
})

// ------------------------------------------------------------------ 2. 额度面板

/** 钱包模式：`quota.limit = 0`（不限），已花 0.0514 而 `quota.used` 仍是 0（实测值） */
const walletUsage = {
  mode: 'unrestricted',
  isValid: true,
  remaining: 11.83,
  unit: 'USD',
  balance: 11.83,
  spent: 0.0514,
  quota: { limit: 0, used: 0, remaining: 11.83, unit: 'USD' },
  usageTotal: { requests: 3, inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 0, actualCost: 0.0514 },
  rateLimits: [],
}

test('额度：已用取 spent（actual_cost），不是恒为 0 的 quota.used', () => {
  const summary = quotaSummaryOf(walletUsage)
  assert.equal(summary.spent, 0.0514)
  assert.equal(summary.balance, 11.83)
  assert.equal(summary.remaining, 11.83)
  // 钱包模式（unrestricted）：limit 0 表示「这个字段不适用」，不是「不限额度」
  assert.equal(summary.unlimited, false)
  assert.equal(summary.showRemaining, false, '钱包模式的剩余等于余额，不再单列一行')

  // 限额模式：limit === 0 才是不限；有上限时剩余显示金额
  const limited = quotaSummaryOf({
    ...walletUsage,
    mode: 'quota_limited',
    remaining: 4.2,
    quota: { limit: 0, used: 0, remaining: 4.2, unit: 'USD' },
  })
  assert.equal(limited.unlimited, true)
  assert.equal(limited.showRemaining, true)
  const capped = quotaSummaryOf({
    ...walletUsage,
    mode: 'quota_limited',
    remaining: 4.2,
    quota: { limit: 6, used: 0, remaining: 4.2, unit: 'USD' },
  })
  assert.equal(capped.unlimited, false)
  assert.equal(capped.remaining, 4.2)
})

test('额度：没有 sk- Key 时不发请求，直接给「去创建 Key」的引导', async () => {
  let called = 0
  const source = {
    hasApiKey: () => false,
    usage: {
      gateway: async () => {
        called += 1
        return ok(walletUsage)
      },
      list: async () => ok({ items: [] }),
    },
  }
  assert.deepEqual(initialQuotaState(source), { phase: 'noKey' })
  assert.deepEqual(await loadQuota(source), { phase: 'noKey' })
  assert.equal(called, 0)

  const markup = html(
    QuotaPanelView({
      t,
      c,
      Button,
      quota: { phase: 'noKey' },
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle: () => {},
      onLoadMore: () => {},
      onRetryQuota: () => {},
      onRetryUsage: () => {},
    })
  )
  assert.ok(markup.includes(t('consumeNoKeyTitle')))
  assert.ok(markup.includes('账号'), '引导里要点名去「账号」标签页')
  assert.ok(hasTestId(markup, 'quota-no-key'))
})

test('额度：401 → needLogin（重试按钮不出现）；500 → 可重试', async () => {
  const unauthorized = await loadQuota({
    hasApiKey: () => true,
    usage: {
      gateway: async () => fail({ status: 401, kind: 'auth', code: 'UNAUTHORIZED', i18nKey: 'consumeErrUnauthorized', retryable: false }),
      list: async () => ok({ items: [] }),
    },
  })
  assert.equal(unauthorized.phase, 'failed')
  assert.equal(unauthorized.error.needLogin, true)

  const retryable = await loadQuota({
    hasApiKey: () => true,
    usage: {
      gateway: async () => fail(),
      list: async () => ok({ items: [] }),
    },
  })
  assert.equal(retryable.error.retryable, true)

  const baseProps = {
    t,
    c,
    Button,
    expanded: false,
    usage: null,
    loadingMore: false,
    loadMoreError: null,
    onToggle: () => {},
    onLoadMore: () => {},
    onRetryQuota: () => {},
    onRetryUsage: () => {},
  }
  const loginMarkup = html(QuotaPanelView({ ...baseProps, quota: unauthorized }))
  assert.ok(loginMarkup.includes(t('consumeErrUnauthorized')))
  assert.ok(loginMarkup.includes(t('consumeNeedLogin')))
  assert.ok(!hasTestId(loginMarkup, 'panel-retry'), '不可重试的错误不许出现重试按钮')

  const serverMarkup = html(QuotaPanelView({ ...baseProps, quota: retryable }))
  assert.ok(hasTestId(serverMarkup, 'panel-retry'))
})

test('额度：余额 / 已用 / 剩余三个数上屏，不限显示「不限」', () => {
  const markup = html(
    QuotaPanelView({
      t,
      c,
      Button,
      quota: { phase: 'ready', data: walletUsage },
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle: () => {},
      onLoadMore: () => {},
      onRetryQuota: () => {},
      onRetryUsage: () => {},
    })
  )
  assert.ok(markup.includes(formatCurrency(11.83)))
  assert.ok(markup.includes(formatCurrency(0.0514)), '已用是 actual_cost（不是 quota.used 的 0）')
  assert.ok(!markup.includes(formatCurrency(0)), 'spent 不能显示成 0')
  assert.ok(!markup.includes('$'), '金额不许出现美元符号')
  assert.ok(markup.includes(t('consumeBalanceLabel')))
  assert.ok(markup.includes(t('consumeUsage')))

  // 限额模式才有「剩余 / 不限」
  const limited = html(
    QuotaPanelView({
      t,
      c,
      Button,
      quota: {
        phase: 'ready',
        data: { ...walletUsage, mode: 'quota_limited', balance: undefined, remaining: 4.2, quota: { limit: 0, used: 0, remaining: 4.2, unit: 'USD' } },
      },
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle: () => {},
      onLoadMore: () => {},
      onRetryQuota: () => {},
      onRetryUsage: () => {},
    })
  )
  assert.ok(limited.includes(t('consumeUnlimited')))
  assert.ok(limited.includes(t('consumeRemaining')))
})

test('用量列表：字段随版本变也认得出；翻页按 id 去重；末页没有「加载更多」', () => {
  const page1 = toUsagePage({
    items: [
      { id: 1, model: 'deepseek-chat', created_at: '2026-11-20T08:00:00Z', requests: 2, actual_cost: 0.02 },
      { id: 2, model_name: 'deepseek-reasoner', date: '2026-11-20T09:00:00Z', count: 1, cost: 0.5 },
      { nothing: true },
    ],
    page: 1,
    pages: 2,
    total: 3,
  })
  assert.equal(page1.items.length, 2, '认不出的行跳过，不渲染 undefined')
  assert.equal(page1.items[1].model, 'deepseek-reasoner')
  assert.equal(page1.items[1].requests, 1)

  const page2 = toUsagePage({ items: [{ id: 2, model: 'deepseek-reasoner', created_at: '2026-11-20T09:00:00Z' }], page: 2, pages: 2, total: 3 })
  const state = appendUsagePage({ phase: 'ready', data: page1 }, page2)
  assert.equal(state.data.items.length, 2, '重复 id 不追加第二遍')
  assert.equal(hasMoreUsage(state), false)

  const more = appendUsagePage({ phase: 'ready', data: page1 }, { items: [], page: 2, pages: 2, total: 3 })
  assert.equal(hasMoreUsage({ phase: 'ready', data: { ...page1, page: 1, pages: 3 } }), true)
  assert.equal(more.phase, 'ready')
})

test('用量列表：展开后有线、可加载更多；追加失败只加错误、记录不丢', async () => {
  const source = {
    hasApiKey: () => true,
    usage: {
      gateway: async () => ok(walletUsage),
      list: async () => ok({ items: [{ id: 1, model: 'deepseek-chat', created_at: '2026-11-20T08:00:00Z', actual_cost: 0.02 }], page: 1, pages: 2, total: 2 }),
    },
  }
  const usage = await loadUsagePage(source, 1)
  assert.equal(usage.phase, 'ready')

  const props = {
    t,
    c,
    Button,
    quota: { phase: 'ready', data: walletUsage },
    expanded: true,
    usage,
    loadingMore: false,
    loadMoreError: null,
    onToggle: () => {},
    onLoadMore: () => {},
    onRetryQuota: () => {},
    onRetryUsage: () => {},
  }
  const markup = html(QuotaPanelView(props))
  assert.equal((markup.match(/data-testid="quota-usage-row"/gu) ?? []).length, 1)
  assert.ok(markup.includes(formatCurrency(0.02)))
  assert.ok(hasTestId(markup, 'quota-load-more'))

  const failedMore = html(
    QuotaPanelView({ ...props, loadMoreError: { i18nKey: 'consumeErrTimeout', retryable: true, needLogin: false, code: 'TIMEOUT' } })
  )
  assert.ok(hasTestId(failedMore, 'quota-usage-row'), '追加失败时已有记录必须还在')
  assert.ok(failedMore.includes(t('consumeErrTimeout')))
})

test('用量列表：空列表是正常态（空文案，不是错误）', async () => {
  const usage = await loadUsagePage(
    { hasApiKey: () => true, usage: { gateway: async () => ok(walletUsage), list: async () => ok({ items: [], page: 1, pages: 0 }) } },
    1
  )
  const markup = html(
    QuotaPanelView({
      t,
      c,
      Button,
      quota: { phase: 'ready', data: walletUsage },
      expanded: true,
      usage,
      loadingMore: false,
      loadMoreError: null,
      onToggle: () => {},
      onLoadMore: () => {},
      onRetryQuota: () => {},
      onRetryUsage: () => {},
    })
  )
  assert.ok(markup.includes(t('consumeUsageEmpty')))
  assert.ok(!hasTestId(markup, 'quota-load-more'))
})

// ------------------------------------------------------------------ 3. 账号面板

const accountSource = (over = {}) => ({
  auth: {
    profile: over.profile ?? (async () => ok({ id: 1, email: 'me@example.com', balance: 9.9 })),
    revokeAllSessions: over.revoke ?? (async () => ok(undefined)),
  },
  keys: {
    list: over.list ?? (async () => ok({ items: [apiKey()], total: 1, page: 1, pageSize: 20, pages: 1 })),
    create: over.create ?? (async () => ok(apiKey({ id: 9, name: '新 Key', key: 'sk-live-brandnew9f2c' }))),
    update: over.update ?? (async () => ok(apiKey({ status: 'inactive' }))),
    remove: over.remove ?? (async () => ok(undefined)),
  },
})

test('账号：注册时间从原始响应里读一次（ConsumeUser 还没映射 created_at）', () => {
  const raw = { ...RAW, json: { code: 0, message: 'success', data: { created_at: '2026-01-02T03:04:05Z' } } }
  const profile = toAccountProfile({ id: 1, email: 'me@example.com', balance: 3 }, raw)
  assert.equal(profile.registeredAt, '2026-01-02T03:04:05Z')
  assert.equal(profile.balance, 3)
  assert.equal(toAccountProfile({ id: 1, email: 'a@b.c' }).registeredAt, undefined)
})

test('账号：首屏资料 + Key 列表并行拉取，两个都可独立失败', async () => {
  const events = await runLoadAccount(accountSource())
  assert.equal(events.length, 2)
  const profile = events.find((event) => event.type === 'profile')
  const keys = events.find((event) => event.type === 'keys')
  assert.equal(profile.state.phase, 'ready')
  assert.equal(profile.state.data.email, 'me@example.com')
  assert.equal(keys.state.phase, 'ready')
  assert.equal(keys.state.data.items.length, 1)

  const broken = await runLoadAccount(accountSource({ list: async () => fail() }))
  assert.equal(broken.find((event) => event.type === 'keys').state.phase, 'failed')
  assert.equal(broken.find((event) => event.type === 'profile').state.phase, 'ready')
})

test('账号：创建 Key —— 空名字不发请求；成功后完整 Key 只出现一次', async () => {
  let created = 0
  const source = accountSource({
    create: async () => {
      created += 1
      return ok(apiKey({ id: 9, name: '新 Key', key: 'sk-live-brandnew9f2c' }))
    },
  })

  const invalid = await runCreateKey(source, '   ')
  assert.equal(invalid.length, 1)
  assert.equal(invalid[0].type, 'actionError')
  assert.equal(invalid[0].error.i18nKey, 'consumeKeyNameRequired')
  assert.equal(created, 0, '空名字不该打网络')

  const events = await runCreateKey(source, ' 新 Key ')
  assert.equal(created, 1)
  assert.equal(events[0].type, 'created')
  assert.equal(events[0].key.key, 'sk-live-brandnew9f2c')

  // reducer：新 Key 进列表顶部 + createdKey 记住完整值
  let state = initialAccountState({ id: 1, email: 'me@example.com' })
  state = { ...state, keys: { phase: 'ready', data: { items: [apiKey()], total: 1, page: 1, pageSize: 20, pages: 1 } } }
  state = events.reduce(reduceAccount, state)
  assert.equal(state.createdKey.key, 'sk-live-brandnew9f2c')
  assert.equal(state.keys.data.items.length, 2)
  assert.equal(state.draftName, '', '创建成功后清空输入框')

  const withOnce = html(AccountPanelView({ ...panelProps(state), copied: false }))
  assert.ok(withOnce.includes('sk-live-brandnew9f2c'), '完整 Key 必须能看一次')
  assert.ok(withOnce.includes(t('consumeKeyOnceTitle')))
  assert.ok(withOnce.includes(t('consumeKeyOnceBody')), '必须说清「只有这一次」')

  // 关掉之后：完整值彻底消失，列表只剩末 4 位
  const dismissed = reduceAccount(state, { type: 'createdDismiss' })
  assert.equal(dismissed.createdKey, null)
  const after = html(AccountPanelView({ ...panelProps(dismissed), copied: false }))
  assert.ok(!after.includes('sk-live-brandnew9f2c'), '完整 Key 不能再出现在 DOM 里')
  assert.ok(after.includes(maskedKey('sk-live-brandnew9f2c')))
  assert.ok(after.includes(t('consumeKeyTailOnly')))
})

const panelProps = (state, over = {}) => ({
  t,
  c,
  Button,
  state,
  copied: false,
  onCopyKey: () => {},
  onDraft: () => {},
  onCreate: () => {},
  onToggleKey: () => {},
  onAskDelete: () => {},
  onCancelDelete: () => {},
  onConfirmDelete: () => {},
  onDismissCreated: () => {},
  onAskLogout: () => {},
  onCancelLogout: () => {},
  onLogout: () => {},
  onRetry: () => {},
  ...over,
})

test('账号：列表里只出现末 4 位（完整 Key 不出现在列表态）', () => {
  const state = {
    ...initialAccountState({ id: 1, email: 'me@example.com', balance: 1.25 }),
    keys: { phase: 'ready', data: { items: [apiKey()], total: 1, page: 1, pageSize: 20, pages: 1 } },
  }
  const markup = html(AccountPanelView(panelProps(state)))
  assert.ok(markup.includes('9f2c'))
  assert.ok(!markup.includes('sk-live-0123456789abcdef9f2c'), '列表不许出现完整 Key')
  assert.ok(markup.includes(t('consumeKeyStatusActive')))
  assert.ok(markup.includes(t('consumeDeleteKey')))
  assert.ok(markup.includes(t('sub2authLogout')))
})

test('账号：停用 / 启用走同一个 update（只改 status）', async () => {
  const calls = []
  const source = accountSource({
    update: async (id, input) => {
      calls.push([id, input])
      return ok(apiKey({ status: input.status }))
    },
  })
  const deactivate = await runToggleKey(source, apiKey())
  assert.deepEqual(calls[0], [7, { status: 'inactive' }])
  assert.equal(deactivate[0].type, 'replaceKey')

  await runToggleKey(source, apiKey({ status: 'inactive' }))
  assert.deepEqual(calls[1][1], { status: 'active' })

  const failed = await runToggleKey(accountSource({ update: async () => fail() }), apiKey())
  assert.equal(failed[0].type, 'actionError')
})

test('账号：删除要二次确认；删掉后从列表移除并给一次性提示', () => {
  let state = {
    ...initialAccountState(null),
    keys: { phase: 'ready', data: { items: [apiKey(), apiKey({ id: 8, name: '第二把' })], total: 2, page: 1, pageSize: 20, pages: 1 } },
  }
  state = reduceAccount(state, { type: 'confirmDelete', id: 7 })
  assert.equal(state.confirmDeleteId, 7)
  assert.ok(html(AccountPanelView(panelProps(state))).includes(t('consumeDeleteConfirm')))

  state = reduceAccount(state, { type: 'removeKey', id: 7 })
  state = reduceAccount(state, { type: 'notice', notice: 'deleted' })
  assert.deepEqual(state.keys.data.items.map((item) => item.id), [8])
  assert.equal(state.confirmDeleteId, null)
  const markup = html(AccountPanelView(panelProps(state)))
  assert.ok(markup.includes(t('consumeKeyDeleted')))
})

test('账号：删除成功 / 退出登录的事件与「要重新登录」判定', async () => {
  const removed = await runDeleteKey(accountSource(), 7)
  assert.deepEqual(removed.map((event) => event.type), ['removeKey', 'notice'])
  assert.equal(loggedOut(removed), false)

  const out = await runLogout(accountSource())
  assert.equal(loggedOut(out), true, '撤会话成功后要通知外壳切登录')

  const failedLogout = await runLogout(accountSource({ revoke: async () => fail() }))
  assert.equal(loggedOut(failedLogout), false)
  assert.equal(failedLogout[0].error.retryable, true)
})

// ------------------------------------------------------------------ 4. 邀请面板

/**
 * 邀请面板的假客户端。#819-v2：`loadInvite` **只**读 `aff.detail()`（可见性 = 已登录 + aff 给了邀请码），
 * 所以这里不再有 `settings` 这一支 —— 想造「没有邀请码」就用 `aff` 回一个 `affCode: ''`。
 */
const inviteSource = (over = {}) => ({
  aff: {
    detail:
      over.aff ??
      (async () =>
        ok({
          userId: 1,
          affCode: 'INV-9F2C',
          affCount: 3,
          affQuota: 1.23,
          affFrozenQuota: 0.1,
          affHistoryQuota: 2.5,
          effectiveRebateRatePercent: 10,
          invitees: [],
        })),
  },
})

test('邀请：服务端没给邀请码时整块隐藏（返回 null，不是置灰）', async () => {
  // #819-v2：原来的判据是 `invitation_code_enabled=false`（那个开关只关注册页），现在改成
  // 「aff 没给 aff_code」—— 这是同一件事的更准版：面板整块内容就是邀请码，没码就没有可展示的东西。
  // 等价断言保留：hidden → 视图返回 null（不是置灰、不是占位）。
  const state = await loadInvite(
    inviteSource({
      aff: async () =>
        ok({ userId: 1, affCode: '', affCount: 0, affQuota: 0, affFrozenQuota: 0, affHistoryQuota: 0, invitees: [] }),
    })
  )
  assert.deepEqual(state, { phase: 'hidden' })
  assert.equal(InvitePanelView({ t, c, Button, state, copied: false, onCopy: () => {}, onRetry: () => {} }), null)
})

test('邀请：邀请码 / 人数 / 返利余额（USD）如实展示，语义写清「注册时填、按比例结算」', async () => {
  const state = await loadInvite(inviteSource())
  assert.equal(state.phase, 'ready')
  assert.deepEqual(toInviteDetail({ userId: 1, affCode: 'X', affCount: 1, affQuota: 0.5, affFrozenQuota: 0, affHistoryQuota: 0, invitees: [] }), {
    code: 'X',
    count: 1,
    rebateBalance: 0.5,
    frozenBalance: 0,
  })
  const markup = html(InvitePanelView({ t, c, Button, state, copied: false, onCopy: () => {}, onRetry: () => {} }))
  assert.ok(markup.includes('INV-9F2C'))
  assert.ok(markup.includes(t('inviteCount')))
  assert.ok(markup.includes(formatCurrency(1.23)))
  assert.ok(markup.includes(t('inviteCodeAtRegister')), '必须说清邀请码只在注册时填')
  assert.ok(markup.includes(t('inviteRebateRate', { percent: 10 })))
  assert.ok(!/立刻|马上得/.test(markup), '不许出现「立刻得积分」这类旧玩法')
  assert.ok(!hasTestId(markup, 'invite-claim'), '没有「领取」按钮（服务端没有这个能力）')
})

test('邀请：aff 读不出来 → 失败 + 可重试（不猜「有」也不猜「没有」）', async () => {
  // #819-v2：失败态的来源从「开关读不出来」换成「aff 读不出来」—— 判据换了、失败语义没换（不猜）。
  const state = await loadInvite(inviteSource({ aff: async () => fail() }))
  assert.equal(state.phase, 'failed')
  assert.equal(state.error.retryable, true)
  const markup = html(InvitePanelView({ t, c, Button, state, copied: false, onCopy: () => {}, onRetry: () => {} }))
  assert.ok(hasTestId(markup, 'panel-retry'))
})

test('邀请：aff 失败就是失败态（不再有「开关关掉 → 用 hidden 盖住错误」）', async () => {
  // #819-v2：旧的「hidden 优先于错误」是绑开关的副作用。现在没有开关可挡：读不到 aff 就如实说失败 + 重试，
  // 否则真出错的部署上会静默消失（那正是本单要修的观感）。
  const state = await loadInvite(inviteSource({ aff: async () => fail() }))
  assert.equal(state.phase, 'failed')
  assert.equal(state.error.retryable, true)
})

// ------------------------------------------------------------------ 5. 邮箱绑定面板

const emailSource = (over = {}) => ({
  settings: { get: over.settings ?? (async () => ok({ emailVerifyEnabled: true })) },
  auth: { profile: over.auth ?? (async () => ok({ id: 1, email: 'me@example.com', emailBound: true })) },
  email: {
    sendCode: over.sendCode ?? (async () => ok(undefined)),
    bind: over.bind ?? (async () => ok({ id: 1, email: 'new@example.com', emailBound: true })),
    unbind: over.unbind ?? (async () => ok({ id: 1, email: 'me@example.com', emailBound: false })),
  },
})

const emailProps = (state, over = {}) => ({
  t,
  c,
  Button,
  state,
  remaining: 0,
  onStartBind: () => {},
  onCancelForm: () => {},
  onDraftEmail: () => {},
  onDraftCode: () => {},
  onSendCode: () => {},
  onSubmit: () => {},
  onAskUnbind: () => {},
  onCancelUnbind: () => {},
  onUnbind: () => {},
  onRetry: () => {},
  ...over,
})

test('邮箱：已绑定 → 脱敏邮箱 + 更换 / 解绑；未绑定 → 绑定邮箱', () => {
  const bound = { ...initialEmailBindState(), info: { phase: 'ready', data: { email: 'me@example.com', bound: true, canUnbind: true, emailVerifyEnabled: true } } }
  const boundMarkup = html(EmailBindPanelView(emailProps(bound)))
  assert.ok(boundMarkup.includes(maskedEmail('me@example.com')))
  assert.ok(!boundMarkup.includes('me@example.com'), '绑定态不许显示完整邮箱')
  assert.ok(hasTestId(boundMarkup, 'email-bind-change'))
  assert.ok(hasTestId(boundMarkup, 'email-bind-unbind'))

  const unbound = { ...initialEmailBindState(), info: { phase: 'ready', data: { email: '', bound: false, canUnbind: true, emailVerifyEnabled: true } } }
  const unboundMarkup = html(EmailBindPanelView(emailProps(unbound)))
  assert.ok(unboundMarkup.includes(t('emailBindNotBound')))
  assert.ok(hasTestId(unboundMarkup, 'email-bind-start'))
})

test('邮箱：can_unbind=false 时不给解绑，并说清原因', () => {
  const state = { ...initialEmailBindState(), info: { phase: 'ready', data: { email: 'me@example.com', bound: true, canUnbind: false, emailVerifyEnabled: false } } }
  const markup = html(EmailBindPanelView(emailProps(state)))
  assert.ok(!hasTestId(markup, 'email-bind-unbind'))
  assert.ok(markup.includes(t('emailBindCannotUnbind')))
})

test('邮箱：emailVerifyEnabled=false 时不再强调「必须先验证」', () => {
  const on = { ...initialEmailBindState(), info: { phase: 'ready', data: { email: 'me@example.com', bound: true, canUnbind: true, emailVerifyEnabled: true } } }
  const off = { ...initialEmailBindState(), info: { phase: 'ready', data: { email: 'me@example.com', bound: true, canUnbind: true, emailVerifyEnabled: false } } }
  assert.ok(hasTestId(html(EmailBindPanelView(emailProps(on))), 'email-bind-verify-hint'))
  assert.ok(!hasTestId(html(EmailBindPanelView(emailProps(off))), 'email-bind-verify-hint'))
})

test('邮箱：发码成功起 60 秒倒计时，按钮逐秒显示剩余（复用 emailCooldown）', async () => {
  const now = Date.UTC(2026, 10, 20, 8, 0, 0)
  const events = await runSendCode(emailSource(), 'new@example.com', now)
  const cooldownEvent = events.find((event) => event.type === 'cooldown')
  assert.ok(cooldownEvent.cooldown !== null)
  assert.equal(cooldownEvent.cooldown.totalSeconds, EMAIL_RESEND_FALLBACK_SECONDS)
  assert.equal(emailCooldownRemaining(cooldownEvent.cooldown, now), EMAIL_RESEND_FALLBACK_SECONDS)
  assert.equal(emailCooldownRemaining(cooldownEvent.cooldown, now + 1000), EMAIL_RESEND_FALLBACK_SECONDS - 1)
  assert.equal(emailCooldownRemaining(cooldownEvent.cooldown, now + 60000), 0)
  assert.equal(events.find((event) => event.type === 'notice').notice, 'codeSent')

  let state = reduceEmailBind(initialEmailBindState(), {
    type: 'info',
    state: { phase: 'ready', data: { email: '', bound: false, canUnbind: true, emailVerifyEnabled: true } },
  })
  state = reduceEmailBind(state, { type: 'mode', mode: 'form' })
  state = events.reduce(reduceEmailBind, state)
  const markup = html(EmailBindPanelView(emailProps(state, { remaining: 42 })))
  assert.ok(markup.includes(t('sub2authCodeSent', { seconds: 42 })))
})

test('邮箱：429 按服务端 Retry-After 倒计时；邮箱格式错不发请求', async () => {
  const now = 1_000_000
  const throttled = await runSendCode(
    emailSource({ sendCode: async () => fail({ status: 429, kind: 'rate_limit', code: 'HTTP_429', i18nKey: 'consumeErrRateLimited', retryable: true }) }),
    'new@example.com',
    now
  )
  // 夹具没有 retryAfterMs：不倒计时（界面不假装有频控），只报错
  assert.equal(throttled.some((event) => event.type === 'cooldown'), false)
  assert.equal(throttled[0].error.i18nKey, 'consumeErrRateLimited')

  const withRetryAfter = fail({ status: 429, kind: 'rate_limit', code: 'HTTP_429', i18nKey: 'consumeErrRateLimited', retryable: true })
  withRetryAfter.error.retryAfterMs = 42000
  const timed = await runSendCode(emailSource({ sendCode: async () => withRetryAfter }), 'new@example.com', now)
  const cooldownEvent = timed.find((event) => event.type === 'cooldown')
  assert.equal(cooldownEvent.cooldown.totalSeconds, 42)
  assert.equal(emailCooldownRemaining(cooldownEvent.cooldown, now), 42)

  let sends = 0
  const bad = await runSendCode(
    emailSource({ sendCode: async () => {
      sends += 1
      return ok(undefined)
    } }),
    'not-an-email',
    now
  )
  assert.equal(sends, 0)
  assert.equal(bad[0].error.i18nKey, 'sub2authEmailInvalid')
  assert.equal(looksLikeEmail('a@b.co'), true)
})

test('邮箱：绑定 / 解绑成功后只更新邮箱与绑定态，验证开关保持不变', async () => {
  let state = {
    ...initialEmailBindState(),
    info: { phase: 'ready', data: { email: '', bound: false, canUnbind: true, emailVerifyEnabled: true } },
    mode: 'form',
  }
  state = (await runBindEmail(emailSource(), 'new@example.com', '123456')).reduce(reduceEmailBind, state)
  assert.equal(state.info.data.email, 'new@example.com')
  assert.equal(state.info.data.bound, true)
  assert.equal(state.info.data.emailVerifyEnabled, true, '开关不该被绑定动作改掉')
  assert.equal(state.mode, 'view')
  assert.equal(state.notice, 'bound')

  state = (await runUnbindEmail(emailSource())).reduce(reduceEmailBind, state)
  assert.equal(state.info.data.bound, false)
  assert.equal(state.notice, 'unbound')
  assert.equal(state.confirmUnbind, false)
})

test('邮箱：首屏把开关与绑定状态一起读回来', async () => {
  const events = await runLoadEmailBind(emailSource())
  assert.equal(events[0].state.phase, 'ready')
  assert.equal(events[0].state.data.bound, true)
  assert.equal(events[0].state.data.emailVerifyEnabled, true)
  assert.equal(
    toEmailBindInfo({ id: 1, email: 'x@y.z', identities: { email: { provider: 'email', bound: true, canUnbind: false } } }, { emailVerifyEnabled: false }).canUnbind,
    false
  )
})

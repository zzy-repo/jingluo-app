// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 usage 源 + renderToStaticMarkup） | Issue #487 阶段③]
//
// **额度面板主路径**（L1-3）：`QuotaPanel` 从「有没有 Key」到「三个数字上屏」再到「会话失效交回外壳」。
//
// 四行表格 = 用户真会遇到的四种界面：
//   ① 有 Key、读到了 → 余额 `¥` + 已用（**取 `spent`，不是恒为 0 的 `quota.used`**）；
//   ② 没有 Key → 引导去创建（**不发请求**：用 JWT 硬打只会拿到 401，把「还没建 Key」误报成「登录失效」）；
//   ③ 401 / 会话失效 → `needLogin`（容器据此调 `onNeedLogin()`，面板自己不跳转）；
//   ④ 5xx → 可重试（只有 `retryable` 才出现「重试」按钮）。
//
// `.tsx` 容器只做「注射 + dispatch」，判定全在 `quotaPanelModel.ts`（裸 Node 可 import），
// 所以这里跑的是真代码，不是复刻。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { initialQuotaState, loadQuota, quotaSummaryOf, QuotaPanelView } = await import(
  '../../src/components/consume/quotaPanelModel.ts'
)

/** `/v1/usage` 的实测形状（`quota.used` 恒 0，真花费在 `usage.total.actual_cost`） */
const usage = (over = {}) => ({
  mode: 'quota_limited',
  isValid: true,
  quota: { limit: 5, used: 0, remaining: 4.95, unit: 'USD' },
  remaining: 4.95,
  unit: 'USD',
  planName: '标准套餐',
  spent: 0.05,
  usageTotal: { requests: 7, inputTokens: 100, outputTokens: 200, totalTokens: 300, cacheReadTokens: 0, actualCost: 0.05 },
  rateLimits: [],
  ...over,
})

const ok = (data) => ({ ok: true, status: 200, raw: {}, data })

const fail = ({ status, code, kind, i18nKey, retryable }) => ({
  ok: false,
  status,
  raw: {},
  error: { kind, code, message: 'server said something in english', status, retryable, envelope: 'panel', i18nKey },
})

const render = (quota, extra = {}) =>
  markupOf(
    QuotaPanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      quota,
      expanded: false,
      usage: null,
      loadingMore: false,
      loadMoreError: null,
      onToggle() {},
      onLoadMore() {},
      onRetryQuota() {},
      onRetryUsage() {},
      ...extra,
    })
  )

/** 假 usage 源：`hasKey` 决定走不走请求，`gateway` 决定应答 */
const sourceOf = ({ hasKey, reply }) => {
  const calls = { gateway: 0 }
  return {
    calls,
    source: {
      hasApiKey: () => hasKey,
      usage: {
        gateway: async () => {
          calls.gateway += 1
          return reply
        },
        list: async () => ok({ items: [] }),
      },
    },
  }
}

const ROWS = [
  {
    label: '有 Key → 余额与「已用」上屏（已用取 spent，不是 quota.used）',
    hasKey: true,
    reply: ok(usage()),
    verify: async ({ state, calls, markup }) => {
      assert.equal(calls.gateway, 1, '有 Key 就该读一次额度')
      assert.equal(state.phase, 'ready')
      // 「已用」= spent(0.05)：quota.used 是 0，若误用它这里会变 ¥0.00
      const summary = quotaSummaryOf(state.data)
      assert.equal(summary.spent, 0.05)
      assert.equal(summary.showRemaining, true, '限额模式要单独显示剩余')
      assert.equal(summary.unlimited, false)
      assert.equal(textOf(markup, 'quota-spent').includes('¥0.05'), true, `已用应显示 ¥0.05，实际 ${textOf(markup, 'quota-spent')}`)
      assert.equal(markup.includes('¥0.00'), false, '「已用」不许取恒为 0 的 quota.used')
      assert.equal(textOf(markup, 'quota-balance').includes('¥'), true, '余额必须带人民币符号')
      assert.equal(textOf(markup, 'quota-remaining').includes('¥4.95'), true)
    },
  },
  {
    label: '没有 Key → 引导去创建，且一个请求都不发',
    hasKey: false,
    reply: ok(usage()),
    verify: async ({ state, calls, markup }) => {
      assert.equal(calls.gateway, 0, '没有 sk- Key 时不该打 /v1/usage（只会拿到 401/API_KEY_REQUIRED）')
      assert.deepEqual(state, { phase: 'noKey' })
      assert.equal(hasTestId(markup, 'quota-no-key'), true)
      assert.equal(markup.includes(translate('consumeNoKeyTitle')), true)
      assert.equal(markup.includes(translate('consumeNoKeyBody')), true)
    },
  },
  {
    label: '401 会话失效 → needLogin（交回外壳切登录），并提示重新登录',
    hasKey: true,
    reply: fail({ status: 401, code: 'INVALID_TOKEN', kind: 'auth', i18nKey: 'consumeErrUnauthorized', retryable: false }),
    verify: async ({ state, calls, markup }) => {
      assert.equal(calls.gateway, 1)
      assert.equal(state.phase, 'failed')
      assert.equal(state.error.needLogin, true, '容器就是按这一位调 onNeedLogin()')
      assert.equal(state.error.retryable, false, '401 重试只会更糟')
      assert.equal(hasTestId(markup, 'quota-error'), true)
      assert.equal(markup.includes(translate('consumeNeedLogin')), true)
      assert.equal(hasTestId(markup, 'panel-retry'), false, '会话失效不该给「重试」按钮')
    },
  },
  {
    label: '5xx 服务端错 → 可重试（出现重试按钮），但不要求重新登录',
    hasKey: true,
    reply: fail({
      status: 503,
      code: 'INTERNAL_ERROR',
      kind: 'server',
      i18nKey: 'consumeErrServerUnavailable',
      retryable: true,
    }),
    verify: async ({ state, markup }) => {
      assert.equal(state.phase, 'failed')
      assert.equal(state.error.needLogin, false)
      assert.equal(state.error.retryable, true)
      assert.equal(hasTestId(markup, 'panel-retry'), true)
      assert.equal(markup.includes(translate('consumeNeedLogin')), false)
    },
  },
]

test('L1 额度面板：有 Key / 无 Key / 401 / 5xx（表驱动）', async (t) => {
  for (const row of ROWS) {
    await t.test(row.label, async () => {
      const { source, calls } = sourceOf(row)
      // 首屏状态也要对：有 Key 先 loading（不闪空态），没有就 noKey
      assert.deepEqual(initialQuotaState(source), row.hasKey ? { phase: 'loading' } : { phase: 'noKey' })

      const state = await loadQuota(source)
      const markup = render(state)
      await row.verify({ state, calls, markup })
    })
  }
})

test('额度只有服务端一个来源：读不到就是「查不到」，不回落成 0', async () => {
  // 把「额度」当本地默认值 0 的那类实现，会让配额耗尽与读失败长得一模一样。
  const state = await loadQuota(sourceOf({ hasKey: true, reply: fail({ status: 500, code: 'HTTP_500', kind: 'server', i18nKey: 'consumeErrServerUnavailable', retryable: true }) }).source)
  assert.equal(state.phase, 'failed', '读不到必须是失败态，而不是 ready(0)')
  const markup = render(state)
  assert.equal(hasTestId(markup, 'quota-stats'), false, '失败时不许渲染任何余额数字')
})

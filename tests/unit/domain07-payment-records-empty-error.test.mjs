// [layer: unit —— 组件级（真弹层组件 / 真展示层 + 真数据层，假传输），零浏览器 | 耗时: <1s]
// C8「付款记录 / 我的购买：空态与错误态矩阵」—— 域 7 F7-06 F7-07（+ F7-09 的「空值不泄露」）
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 G4 的另一半）
//
// 空态/错误态断言的和正常态**互斥**（同一份 DOM 快照测不了两头），所以单独一张表：
//   1 付款记录：服务端说「没有订单」→ 空态，不是「加载失败」
//   2 付款记录：401 → 让用户重填 Key，不是「没有记录」
//   3 付款记录：503 → 错误文案 + 「刷新」可点（只读接口，重试安全）
//   4 我的购买：真没买过 vs 筛选后为空，两句不同文案
//   5 我的购买：401 → 中文文案 + 不给「重试」（重试没用）
//   6 两处都没有 API Key：一条请求都不发
//
// 跑法：node --test tests/unit/domain07-payment-records-empty-error.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'
import { createElement } from '../fixtures/domain06-07/mini-react.mjs'

const harness = await createHarness()
const { PaymentRecordsDialog } = await harness.importSource(
  'src/components/settings/PaymentRecordsDialog.tsx'
)
const { PurchaseRecordsView, loadPurchasePage } = await harness.importSource(
  'src/components/settings/PurchaseRecordsView.ts'
)
const { PurchaseError } = await harness.importSource('src/services/ours/purchases.ts')
const { zh } = await harness.importSource('src/i18n/zh.ts')

const KEY = 'sk-ours-records-empty-00112233445566'

const TestButton = ({ testId, disabled, onClick, children }) =>
  createElement('button', { type: 'button', 'data-testid': testId, disabled, onClick }, children)

const t = (key, params) =>
  String(zh[key] ?? `<missing:${key}>`).replaceAll(/\{(\w+)\}/gu, (placeholder, name) =>
    params?.[name] === undefined ? placeholder : String(params[name])
  )

const purchasesProps = (extra = {}) => ({
  t,
  classNames: {},
  button: TestButton,
  tab: 'all',
  view: { status: 'loading' },
  expandedCard: null,
  onTab: () => {},
  onRetry: () => {},
  onPrev: () => {},
  onNext: () => {},
  onToggleCard: () => {},
  onCardAction: () => {},
  ...extra,
})

test('C8/1 F7-06 付款记录：订单为空 → 空态文案，不是「加载失败」（否则用户会反复重试）', async () => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  harness.ctx.reply(() => TRANSPORT.json(200, { customer_id: 10, total_paid_yuan: 0, orders: [] }))
  const view = await harness.mount(PaymentRecordsDialog, { onClose: () => {} })
  const markup = view.html()

  assert.deepEqual(harness.ctx.paths, ['GET /api/orders'])
  assert.ok(markup.includes(zh.oursPayRecordsEmpty), '空列表要给空态文案')
  assert.ok(markup.includes(t('oursPayRecordsTotalPaid')), '累计已支付仍然显示（账号级口径）')
  assert.equal(markup.includes(zh.oursErrNetwork), false, '空列表不是网络错误')
  view.unmount()
})

test('C8/2 F7-06 付款记录 401：提示重填 Key，绝不说成「没有记录」', async () => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  harness.ctx.reply(() => TRANSPORT.json(401, { code: 'UNAUTHORIZED' }))
  const view = await harness.mount(PaymentRecordsDialog, { onClose: () => {} })

  const markup = view.html()
  assert.equal(view.text('modal').includes(zh.oursPayRecordsEmpty), false, '401 不许显示成空态')
  assert.ok(markup.includes(zh.oursErrUnauthorized), '401 → 「Key 无效 / 请重新填写」')
  assert.equal(markup.includes('UNAUTHORIZED'), false, '不许把服务端英文码直接上屏')
  view.unmount()
})

test('C8/3 F7-06 付款记录 503：可重试错误 + 「刷新」可点（只读接口，重试不会建单）', async () => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  let calls = 0
  harness.ctx.reply(() => {
    calls += 1
    return calls === 1
      ? TRANSPORT.json(503, { code: 'UNAVAILABLE' })
      : TRANSPORT.json(200, { customer_id: 10, total_paid_yuan: 0, orders: [] })
  })
  const view = await harness.mount(PaymentRecordsDialog, { onClose: () => {} })

  assert.ok(
    view.html().includes(zh.oursErrInvalidResponse),
    '503 落到「响应格式不对」这类可重试错误上'
  )

  // 刷新按钮始终可点（loading 之外），重试一次就恢复
  const refresh = view.findAll(
    (node) => node.type === 'button' && String(node.props.children) === zh.oursPayRecordsRefresh
  )[0]
  assert.ok(refresh, '找不到「刷新」按钮')
  assert.notEqual(refresh.props.disabled, true)
  await refresh.props.onClick()
  await view.settle()

  assert.deepEqual(
    harness.ctx.paths,
    ['GET /api/orders', 'GET /api/orders'],
    '刷新就是重新查一次只读接口'
  )
  assert.ok(view.html().includes(zh.oursPayRecordsEmpty), '第二次成功 → 回到正常态')
  view.unmount()
})

test('C8/4 F7-07 我的购买：「还没买过」与「换个筛选看看」是两句不同的话', async () => {
  const cases = [
    { tab: 'all', label: zh.oursPurchasesEmpty },
    { tab: 'pending', label: zh.oursPurchasesEmptyFiltered },
  ]
  for (const item of cases) {
    const emptyPage = {
      customerId: 10,
      total: 0,
      limit: 20,
      offset: 0,
      totalPaidYuan: 0,
      orders: [],
    }
    const loaded = await loadPurchasePage({
      fetchPurchases: async () => emptyPage,
      apiKey: KEY,
      tab: item.tab,
      offset: 0,
    })
    const view = await harness.mount(PurchaseRecordsView, {
      ...purchasesProps({ tab: item.tab, view: loaded }),
    })
    assert.equal(view.text('purchases-empty'), item.label, `tab=${item.tab} 的空态文案不对`)
    assert.equal(view.has('purchase-item'), false, '空列表不该渲染任何条目')
    view.unmount()
  }
})

test('C8/5 F7-07 我的购买 401：中文文案 + 不给「重试」（重试没用，得去重填 Key）', async () => {
  const unauthorized = new PurchaseError('unauthorized', 'API Key 无效', {
    status: 401,
    code: 'UNAUTHORIZED',
  })
  const loaded = await loadPurchasePage({
    fetchPurchases: async () => {
      throw unauthorized
    },
    apiKey: KEY,
    tab: 'all',
    offset: 0,
  })
  assert.equal(loaded.status, 'error')

  const view = await harness.mount(PurchaseRecordsView, { ...purchasesProps({ view: loaded }) })
  assert.equal(view.text('purchases-error').includes(zh.oursPurchasesErrUnauthorized), true)
  assert.equal(view.has('purchases-retry'), false, '401 不该给「重试」按钮')
  assert.equal(view.html().includes(zh.oursPurchasesErrUnknown), false, '不许落到未知错误文案')
  view.unmount()

  // 可重试类错误（网络 / 5xx）反过来必须给「重试」
  const retryable = await loadPurchasePage({
    fetchPurchases: async () => {
      throw new PurchaseError('server', '服务暂时不可用', { status: 503 })
    },
    apiKey: KEY,
    tab: 'all',
    offset: 0,
  })
  const retryView = await harness.mount(PurchaseRecordsView, {
    ...purchasesProps({ view: retryable }),
  })
  assert.equal(retryView.text('purchases-error').includes(zh.oursPurchasesErrServer), true)
  assert.equal(retryView.has('purchases-retry'), true, '503 是可重试错误，必须给「重试」')
  retryView.unmount()
})

test('C8/6 F7-06/F7-07 两处都没有 API Key：一条请求都不发，直接给「填写 Key」', async () => {
  harness.ctx.reset()
  harness.ctx.apiKey = ''
  harness.ctx.reply(() => {
    throw new Error('没有 Key 时不该发请求')
  })
  const dialog = await harness.mount(PaymentRecordsDialog, { onClose: () => {} })
  assert.deepEqual(harness.ctx.paths, [], '没有 Key 时付款记录不该发请求')
  assert.ok(dialog.html().includes(zh.oursPayRecordsNeedKey))
  dialog.unmount()

  const loaded = await loadPurchasePage({
    fetchPurchases: async () => {
      throw new Error('没有 Key 时不该发请求')
    },
    apiKey: '   ',
    tab: 'all',
    offset: 0,
  })
  assert.equal(loaded.status, 'error')
  assert.equal(loaded.error.needsKey, true)
  const purchases = await harness.mount(PurchaseRecordsView, {
    ...purchasesProps({ view: loaded }),
  })
  assert.ok(purchases.html().includes(zh.oursPurchasesNeedKey))
  assert.equal(purchases.has('purchases-retry'), false)
  purchases.unmount()
})

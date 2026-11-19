// [layer: unit —— 组件级（真弹层组件 / 真展示层 + 真数据层，假传输），零浏览器 | 耗时: <1s]
// C7「付款记录 / 我的购买：正常渲染矩阵」—— 域 7 F7-06 F7-07 F7-08 F7-09 F7-10
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 G4「PaymentRecordsDialog 组件级零测试」= 行 1/2）
//
// 两件事合在一张表里（它们本来就是一屏的两块，断言对象同为「渲染出来的 DOM」）：
//   付款记录（`PaymentRecordsDialog.tsx`，此前**整块 DOM 零测试**）：累计实付、每笔金额 / 状态 /
//     本地时间 / 卡密后 4 位，「查看卡密」才把完整卡密放进 DOM；收起后立刻消失。
//   我的购买（`PurchaseRecordsView.ts`）：状态筛选 tab、分页（limit 恒 20）、卡片主操作（去兑换 / 去支付）。
//
// 跑法：node --test tests/unit/domain07-payment-records-view.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'
import { createElement } from '../fixtures/domain06-07/mini-react.mjs'

const harness = await createHarness()
const { PaymentRecordsDialog, formatRecordTime } = await harness.importSource(
  'src/components/settings/PaymentRecordsDialog.tsx'
)
const {
  PURCHASE_PAGE_SIZE,
  PurchaseRecordsView,
  cardActionFor,
  formatPurchaseTime,
  formatYuan,
  loadPurchasePage,
} = await harness.importSource('src/components/settings/PurchaseRecordsView.ts')
const { maskCardNo } = await harness.importSource('src/services/ours/purchases.ts')
const { zh } = await harness.importSource('src/i18n/zh.ts')

const KEY = 'sk-ours-records-view-00112233445566'
const CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
const PAID_AT = 1763000000
const CREATED_AT = 1762990000

const TestButton = ({ testId, disabled, onClick, children }) =>
  createElement('button', { type: 'button', 'data-testid': testId, disabled, onClick }, children)

const noop = () => {}

const order = (extra = {}) => ({
  outTradeNo: 'CP20261119000001',
  planId: 'p1',
  planName: '体验套餐',
  planPoints: 300,
  amountYuan: 4.9,
  status: 'fulfilled',
  statusText: '已完成',
  cardNo: CARD,
  cardStatus: 'leased',
  redeemState: 'issued',
  createdAt: CREATED_AT,
  paidAt: PAID_AT,
  ...extra,
})

const page = (extra = {}) => ({
  customerId: 10,
  total: 1,
  limit: PURCHASE_PAGE_SIZE,
  offset: 0,
  totalPaidYuan: 4.9,
  orders: [order()],
  ...extra,
})

const purchasesProps = (extra = {}) => ({
  t: (key, params) =>
    String(zh[key] ?? `<missing:${key}>`).replaceAll(/\{(\w+)\}/gu, (placeholder, name) =>
      params?.[name] === undefined ? placeholder : String(params[name])
    ),
  classNames: {},
  button: TestButton,
  tab: 'all',
  view: { status: 'loading' },
  expandedCard: null,
  onTab: noop,
  onRetry: noop,
  onPrev: noop,
  onNext: noop,
  onToggleCard: noop,
  onCardAction: noop,
  ...extra,
})

// ------------------------------------------------------------------ 行 1：付款记录列表

test('C7/1 F7-06 + F7-09 付款记录：累计实付 / 每笔金额 / 状态 / 本地时间 / 卡尾都在，完整卡密不在 DOM', async () => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  harness.ctx.reply(() =>
    TRANSPORT.json(200, {
      customer_id: 10,
      total_paid_yuan: 4.9,
      orders: [
        {
          out_trade_no: 'CP20261119000001',
          amount_fen: 490,
          status: 'FULFILLED',
          card_no: CARD,
          paid_at: PAID_AT,
          redeemed: false,
        },
      ],
    })
  )
  const view = await harness.mount(PaymentRecordsDialog, { onClose: noop })
  const markup = view.html()

  assert.deepEqual(harness.ctx.paths, ['GET /api/orders'], '付款记录是只读的：只发一条 GET')
  assert.ok(markup.includes(zh.oursPayRecordsTotalPaid), '要显示「累计已支付」')
  assert.ok(markup.includes(formatYuan(4.9)), '累计与单笔金额都取服务端数值')
  assert.ok(markup.includes(zh.oursPayRecordsStatusCompleted), 'FULFILLED → 「已完成」')
  assert.ok(markup.includes(formatRecordTime(PAID_AT)), '时间是本地时区格式化后的那一份')
  assert.ok(markup.includes(maskCardNo(CARD)), '列表里只许出现掩码卡号（后 4 位）')
  assert.equal(markup.includes(CARD), false, '没点开之前完整卡密不许进 DOM')
  assert.ok(markup.includes('CP20261119000001'), '单号要可见（对账用）')
  view.unmount()
})

// ------------------------------------------------------------------ 行 2：展开 / 收起卡密

test('C7/2 F7-09 点「查看卡密」→ 完整卡密进 DOM 与复制按钮；收起后立刻消失', async () => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  harness.ctx.reply(() =>
    TRANSPORT.json(200, {
      customer_id: 10,
      total_paid_yuan: 4.9,
      orders: [
        {
          out_trade_no: 'CP1',
          amount_fen: 490,
          status: 'FULFILLED',
          card_no: CARD,
          paid_at: PAID_AT,
        },
      ],
    })
  )
  const view = await harness.mount(PaymentRecordsDialog, { onClose: noop })

  const toggle = view.findAll(
    (node) =>
      typeof node.props.onClick === 'function' &&
      node.type === 'button' &&
      String(node.props.children).includes(zh.oursPayRecordsViewCard)
  )[0]
  assert.ok(toggle, '找不到「查看卡密」按钮')

  await toggle.props.onClick()
  await view.settle()
  assert.ok(view.html().includes(CARD), '点开后完整卡密必须可见（用户要复制去兑换）')
  assert.ok(view.html().includes(zh.oursPayRecordsCopyCard), '点开后才有「复制卡密」')

  const hide = view.findAll(
    (node) =>
      node.type === 'button' && String(node.props.children).includes(zh.oursPayRecordsHideCard)
  )[0]
  assert.ok(hide, '展开后按钮应变成「收起卡密」')
  await hide.props.onClick()
  await view.settle()
  assert.equal(view.html().includes(CARD), false, '收起后完整卡密必须从 DOM 消失')
  assert.equal(harness.ctx.paths.length, 1, '展开/收起都是纯前端行为，不该重新请求')
  view.unmount()
})

// ------------------------------------------------------------------ 行 3：我的购买卡片主操作

test('C7/3 F7-10 卡片主操作：issued→去兑换 / pending→去支付 / redeemed→已兑换 / 过期失败→没有主操作', async () => {
  const CASES = [
    { name: '已发卡未兑换', order: order(), action: 'redeem', label: zh.oursPurchasesGoRedeem },
    {
      name: '待支付',
      order: order({
        status: 'pending',
        statusText: '待支付',
        cardNo: null,
        redeemState: null,
        paidAt: null,
      }),
      action: 'pay',
      label: zh.oursBuyAction,
    },
    {
      name: '已兑换',
      order: order({ redeemState: 'redeemed' }),
      action: 'none',
      label: zh.oursPurchasesRedeemed,
    },
    {
      name: '已过期',
      order: order({
        status: 'expired',
        statusText: '已过期',
        cardNo: null,
        redeemState: null,
        paidAt: null,
      }),
      action: 'none',
      label: null,
    },
    {
      name: '失败',
      order: order({
        status: 'failed',
        statusText: '失败',
        cardNo: null,
        redeemState: null,
        paidAt: null,
      }),
      action: 'none',
      label: null,
    },
  ]

  for (const item of CASES) {
    // 数据层口径（纯函数）
    assert.equal(cardActionFor(item.order), item.action, `${item.name}：cardActionFor 结论不对`)

    // 渲染口径：主操作按钮出现/不出现，点它回调带上哪个 action
    const actions = []
    const view = await harness.mount(PurchaseRecordsView, {
      ...purchasesProps({
        view: { status: 'ok', page: page({ total: 1, orders: [item.order] }) },
        onCardAction: (o, action) => actions.push({ no: o.outTradeNo, action }),
      }),
    })
    const markup = view.html()
    if (item.label !== null) {
      assert.ok(markup.includes(item.label), `${item.name}：缺少文案「${item.label}」`)
    }
    if (item.action === 'none') {
      assert.equal(
        markup.includes(zh.oursPurchasesGoRedeem) || markup.includes(zh.oursBuyAction),
        false,
        `${item.name}：不该出现任何主操作`
      )
    } else {
      const button = view.findAll(
        (node) => node.type === 'button' && String(node.props.children) === item.label
      )[0]
      assert.ok(button, `${item.name}：找不到「${item.label}」按钮`)
      await button.props.onClick()
      assert.deepEqual(
        actions,
        [{ no: item.order.outTradeNo, action: item.action }],
        `${item.name}：回调不对`
      )
    }
    view.unmount()
  }
})

// ------------------------------------------------------------------ 行 4：状态筛选 tab

test('C7/4 F7-07 筛选 tab：映射后端 status、切换回第一页、只有当前 tab aria-selected', async () => {
  const CASES = [
    { tab: 'all', status: null },
    { tab: 'fulfilled', status: 'fulfilled' },
    { tab: 'pending', status: 'pending' },
    { tab: 'expired', status: 'expired' },
  ]
  for (const item of CASES) {
    const calls = []
    const view = await loadPurchasePage({
      fetchPurchases: async (params) => {
        calls.push(params)
        return page({ offset: 0 })
      },
      apiKey: KEY,
      tab: item.tab,
      offset: 0,
    })
    assert.equal(view.status, 'ok')
    assert.deepEqual(calls, [
      { apiKey: KEY, limit: PURCHASE_PAGE_SIZE, offset: 0, status: item.status },
    ])

    // 点别的 tab → 回第一页（offset 0），且只有当前 tab 带 aria-selected
    const onTabs = []
    const rendered = await harness.mount(PurchaseRecordsView, {
      ...purchasesProps({
        tab: item.tab,
        view: { status: 'ok', page: page({ offset: 20, total: 40 }) },
        onTab: (tab) => onTabs.push(tab),
      }),
    })
    const selected = rendered.findAll(
      (node) => node.props.role === 'tab' && node.props['aria-selected'] === true
    )
    assert.equal(selected.length, 1, `${item.tab}：当前 tab 只能有一个 aria-selected`)
    assert.equal(selected[0].props['data-testid'], `purchases-tab-${item.tab}`)

    const other = rendered.findAll(
      (node) =>
        node.props.role === 'tab' && node.props['data-testid'] !== `purchases-tab-${item.tab}`
    )[0]
    await other.props.onClick()
    assert.equal(onTabs.length, 1, '点 tab 必须回传一次')
    rendered.unmount()

    // 切换 tab 时调用方要回到第一页（offset 0）：把它当契约钉在 loadPurchasePage 上
    const afterSwitch = []
    await loadPurchasePage({
      fetchPurchases: async (params) => {
        afterSwitch.push(params)
        return page()
      },
      apiKey: KEY,
      tab: onTabs[0],
      offset: 0,
    })
    assert.equal(afterSwitch[0].offset, 0)
  }
})

// ------------------------------------------------------------------ 行 5：分页

test('C7/5 F7-08 分页：limit 恒 20、offset 透传、上一页/下一页可用态跟 hasNextPage 一致', async () => {
  const calls = []
  const view = await loadPurchasePage({
    fetchPurchases: async (params) => {
      calls.push(params)
      return page({
        offset: params.offset,
        total: 45,
        orders: [order(), order({ outTradeNo: 'CP2' })],
      })
    },
    apiKey: KEY,
    tab: 'all',
    offset: 20,
  })
  assert.equal(view.status, 'ok')
  assert.deepEqual(calls, [{ apiKey: KEY, limit: PURCHASE_PAGE_SIZE, offset: 20, status: null }])
  assert.equal(calls[0].limit, PURCHASE_PAGE_SIZE, '每页恒定 20，绝不跟着页码漂')

  const rendered = await harness.mount(PurchaseRecordsView, {
    ...purchasesProps({ view: { status: 'ok', page: view.page }, onPrev: noop, onNext: noop }),
  })
  const markup = rendered.html()
  assert.ok(markup.includes(formatPurchaseTime(CREATED_AT)), '时间列用本地时区')
  // offset 20 + 2 条 < total 45 → 还能下一页；offset > 0 → 能上一页（可用态 = disabled 取反）
  assert.equal(
    rendered.node('purchases-next').props.disabled,
    false,
    '还有下一页时「下一页」必须可点'
  )
  assert.equal(
    rendered.node('purchases-prev').props.disabled,
    false,
    'offset>0 时「上一页」必须可点'
  )
  rendered.unmount()

  const lastPage = await loadPurchasePage({
    fetchPurchases: async (params) =>
      page({ offset: params.offset, total: 22, orders: [order(), order({ outTradeNo: 'CP3' })] }),
    apiKey: KEY,
    tab: 'all',
    offset: 20,
  })
  const tail = await harness.mount(PurchaseRecordsView, {
    ...purchasesProps({ view: { status: 'ok', page: lastPage.page } }),
  })
  assert.equal(tail.node('purchases-next').props.disabled, true, '最后一页「下一页」必须置灰')
  assert.equal(tail.node('purchases-prev').props.disabled, false, '最后一页仍可回上一页')
  tail.unmount()
})

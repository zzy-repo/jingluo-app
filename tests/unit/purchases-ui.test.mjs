// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s]
// Issue #158「我的购买」UI：组件级覆盖「有数据 / 空 / 错误 / 分页 / tab 切换 / issued 跳兑换」六种情况。
//
// 运行：node --test tests/unit/purchases-ui.test.mjs
//
// 关键做法（沿用 tests/unit/import-skipped-ui.test.mjs）：
//   展示层在 src/components/settings/PurchaseRecordsView.ts 里，是**纯 createElement**、不 import CSS，
//   所以裸 Node 能直接加载真代码并 renderToStaticMarkup 出真 DOM 字符串。
//   `.tsx` 的 JSX 不在 Node 的类型擦除范围内，单测加载不了它——这也正是把展示层单独拆出去的原因。
//
// 除了静态 markup，本文件还**直接调用组件函数拿到 React 元素树**，按 data-testid 找到按钮并
// 调用它的 onClick：这能在没有 DOM 的情况下验证「点了到底会不会走对分支」，
// 而不是只断言「按钮长得对」。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { PurchaseError, maskCardNo, hasNextPage } = await import(
  '../../src/services/ours/purchases.ts'
)
const {
  PURCHASE_PAGE_SIZE,
  PurchaseRecordsView,
  cardActionFor,
  describePurchaseError,
  formatPurchaseTime,
  formatYuan,
  loadPurchasePage,
  tabToStatus,
} = await import('../../src/components/settings/PurchaseRecordsView.ts')

// ------------------------------------------------------------------ 工具

/** 与 i18n/index.ts 的 createTranslate 等价：用真实 zh 文案渲染，占位符照抄真实现的规则 */
const createTranslate =
  (messages) =>
  (key, params) =>
    messages[key].replace(/\{(\w+)\}/g, (placeholder, name) => {
      const value = params?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
    })

const t = createTranslate(zh)

/** 假的设计系统按钮：只保留断言需要的部分（testId → data-testid） */
const TestButton = ({ testId, disabled, onClick, children }) =>
  createElement(
    'button',
    { type: 'button', 'data-testid': testId, disabled: disabled === true, onClick },
    children
  )

const noop = () => {}

/** 把字面量文案转成正则片段（文案里有「。」等不需要转义的字符，只为保险） */
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** 固定时间戳（秒）：2026-11-19T00:00:00Z */
const CREATED_AT = 1763510400

const order = (over = {}) => ({
  outTradeNo: 'CP20261119000001',
  planId: 'starter',
  planName: '体验套餐',
  planPoints: 300,
  amountYuan: 5.9,
  status: 'fulfilled',
  statusText: '已完成',
  cardNo: 'MUSE-3CYP-5NA3-AHSE-A3SR',
  cardStatus: 'used',
  redeemState: 'redeemed',
  createdAt: CREATED_AT,
  paidAt: CREATED_AT,
  ...over,
})

const page = (over = {}) => ({
  customerId: 10,
  total: 2,
  limit: PURCHASE_PAGE_SIZE,
  offset: 0,
  totalPaidYuan: 5.9,
  orders: [order(), order({ outTradeNo: 'CP20261119000002', planName: '进阶套餐' })],
  ...over,
})

/** 渲染 props → 纯展示层；所有回调都可被测试替换 */
const viewProps = (over = {}) => ({
  t,
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
  ...over,
})

const html = (over = {}) => renderToStaticMarkup(createElement(PurchaseRecordsView, viewProps(over)))

/** 把 React 元素树（组件函数直接返回的那种）摊平，便于按 data-testid 找节点 */
const walk = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, out)
    }
    return out
  }
  if (typeof node !== 'object') {
    return out
  }
  out.push(node)
  walk(node.props?.children, out)
  return out
}

/** 直接从组件函数拿元素树（纯函数组件、不依赖 hook，可直接调用） */
const tree = (over = {}) => walk(PurchaseRecordsView(viewProps(over)))

const byTestId = (nodes, testId) => nodes.find((node) => node.props?.['data-testid'] === testId)

/** 假 fetchPurchases：记录每次请求，按需返回或抛错 */
const fakeFetch = (result) => {
  const calls = []
  const fetchPurchases = async (params) => {
    calls.push(params)
    if (result instanceof Error) {
      throw result
    }
    return typeof result === 'function' ? result(params) : result
  }
  return { fetchPurchases, calls }
}

const API_KEY = 'sk-unit-test-000011112222333344445555'

// ------------------------------------------------------------------ [1] 有数据

test('[1] 有数据：套餐名 / 实付金额 / 后端 status_text / 本地时间 / 卡号后 4 位 都在，完整卡号不在', () => {
  const markup = html({ view: { status: 'ok', page: page() } })

  assert.match(markup, /体验套餐/u, '要显示套餐名')
  assert.match(markup, /进阶套餐/u, '两笔都要列出来')
  assert.ok(markup.includes(formatYuan(5.9)), `要显示实付金额 ${formatYuan(5.9)}`)
  assert.match(markup, /已完成/u, '状态文案必须用后端下发的 status_text')
  assert.ok(markup.includes(formatPurchaseTime(CREATED_AT)), '时间要按本地时区格式化')

  // 卡号只露后 4 位
  const tail = maskCardNo('MUSE-3CYP-5NA3-AHSE-A3SR')
  assert.ok(tail.includes('A3SR'), `后 4 位应保留，实际 ${tail}`)
  assert.ok(markup.includes(tail), `列表里要出现掩码卡号 ${tail}`)
  assert.ok(
    !markup.includes('MUSE-3CYP-5NA3-AHSE-A3SR'),
    '没点开之前，完整卡号绝不能出现在 DOM 里'
  )
})

// ------------------------------------------------------------------ [2] 空

test('[2] 空：给空态文案、不渲染列表，条数为 0', () => {
  const markup = html({
    view: { status: 'ok', page: page({ total: 0, orders: [], totalPaidYuan: 0 }) },
  })
  assert.match(markup, new RegExp(escapeRe(zh.oursPurchasesEmpty), 'u'))
  assert.ok(!markup.includes('data-testid="purchases-list"'), '空态不该渲染列表')
  assert.match(markup, /共 0 条/u)
  assert.ok(!markup.includes('data-testid="purchase-item"'))
})

test('[2b] 空（筛选态）：文案换成「换个筛选看看」，跟「还没买过」区分开', () => {
  const markup = html({
    tab: 'expired',
    view: { status: 'ok', page: page({ total: 0, orders: [] }) },
  })
  assert.match(markup, new RegExp(escapeRe(zh.oursPurchasesEmptyFiltered), 'u'))
  assert.ok(!markup.includes(zh.oursPurchasesEmpty))
})

// ------------------------------------------------------------------ [3] 错误

test('[3] 错误：可重试的 kind 给中文文案 + 重试按钮，界面里没有英文原文', async () => {
  // 用数据层真实的 PurchaseError（network 属于可重试）
  const { fetchPurchases } = fakeFetch(new PurchaseError('network', 'connect ECONNREFUSED'))
  const view = await loadPurchasePage({ fetchPurchases, apiKey: API_KEY, tab: 'all', offset: 0 })
  assert.equal(view.status, 'error')
  assert.equal(view.error.messageKey, 'oursPurchasesErrNetwork')
  assert.equal(view.error.retryable, true)
  assert.equal(view.error.needsKey, false)

  const nodes = tree({ view })
  const markup = renderToStaticMarkup(createElement(PurchaseRecordsView, viewProps({ view })))
  assert.ok(markup.includes(zh.oursPurchasesErrNetwork), '要显示本地化错误文案')
  assert.ok(
    !/ECONNREFUSED|network|Network|Error/u.test(markup.replace(/data-testid="[^"]*"/gu, '')),
    '不许把英文原文（或原始报错）铺到界面上'
  )
  const retry = byTestId(nodes, 'purchases-retry')
  assert.ok(retry !== undefined, '可重试的错误必须有重试按钮')

  let retried = 0
  const clicked = byTestId(tree({ view, onRetry: () => (retried += 1) }), 'purchases-retry')
  clicked.props.onClick()
  assert.equal(retried, 1, '点重试要触发重新拉取')
})

test('[3b] 错误：401 引导去填 Key，不给「重试」（重试没用）', async () => {
  const { fetchPurchases } = fakeFetch(new PurchaseError('unauthorized', 'unauthorized', { status: 401 }))
  const view = await loadPurchasePage({ fetchPurchases, apiKey: API_KEY, tab: 'all', offset: 0 })
  assert.equal(view.error.messageKey, 'oursPurchasesErrUnauthorized')
  assert.equal(view.error.needsKey, true)
  assert.equal(view.error.retryable, false)

  const markup = html({ view })
  assert.ok(markup.includes(zh.oursPurchasesErrUnauthorized))
  assert.ok(markup.includes(zh.oursPurchasesNeedKey), '要引导用户去填 Key')
  assert.ok(!markup.includes('data-testid="purchases-retry"'), '401 不该给重试按钮')
})

test('[3c] 错误：没有 API Key 时一条请求都不发', async () => {
  const { fetchPurchases, calls } = fakeFetch(page())
  const view = await loadPurchasePage({ fetchPurchases, apiKey: '   ', tab: 'all', offset: 0 })
  assert.equal(view.status, 'error')
  assert.equal(view.error.needsKey, true)
  assert.equal(view.error.messageKey, 'oursPurchasesErrKeyMissing')
  assert.deepEqual(calls, [], '没有 Key 时不许发请求')
})

test('[3d] 错误：未知 kind 也落到本地化兜底文案（不漏英文）', () => {
  const described = describePurchaseError(new Error('boom'))
  assert.equal(described.messageKey, 'oursPurchasesErrUnknown')
  assert.equal(described.retryable, false, '不是 PurchaseError 一律按不重试')
  assert.equal(described.needsKey, false)
})

// ------------------------------------------------------------------ [4] 分页

test('[4] 分页：limit=20 恒定，offset 透传，prev/next 可用态跟 hasNextPage 一致', async () => {
  const middle = page({ total: 45, offset: 20, orders: Array.from({ length: 20 }, (_, i) => order({ outTradeNo: `CP-mid-${i}` })) })
  const { fetchPurchases, calls } = fakeFetch(middle)
  const view = await loadPurchasePage({ fetchPurchases, apiKey: API_KEY, tab: 'all', offset: 20 })

  assert.deepEqual(calls, [
    { apiKey: API_KEY, limit: PURCHASE_PAGE_SIZE, offset: 20, status: null },
  ])
  assert.equal(PURCHASE_PAGE_SIZE, 20)
  assert.equal(hasNextPage(middle), true, '20 + 20 < 45，还有下一页')

  const nodes = tree({ view })
  const markup = renderToStaticMarkup(createElement(PurchaseRecordsView, viewProps({ view })))
  assert.match(markup, /共 45 条/u, '要显示总条数')
  assert.equal(byTestId(nodes, 'purchases-prev').props.disabled, false, '不是第一页，上一页可用')
  assert.equal(byTestId(nodes, 'purchases-next').props.disabled, false, '还有下一页，下一页可用')

  // 末页：40 + 20 = 60 >= 45 → 下一页禁用
  const last = page({ total: 45, offset: 40, orders: Array.from({ length: 5 }, (_, i) => order({ outTradeNo: `CP-last-${i}` })) })
  assert.equal(hasNextPage(last), false)
  const lastNodes = tree({ view: { status: 'ok', page: last } })
  assert.equal(byTestId(lastNodes, 'purchases-prev').props.disabled, false)
  assert.equal(byTestId(lastNodes, 'purchases-next').props.disabled, true, '末页要禁用下一页')

  // 第一页：上一页禁用
  const firstNodes = tree({ view: { status: 'ok', page: page({ total: 45, offset: 0 }) } })
  assert.equal(byTestId(firstNodes, 'purchases-prev').props.disabled, true)

  // 点「下一页」= offset += 20
  let nextOffset = null
  const clickable = byTestId(tree({ view, onNext: () => (nextOffset = 40) }), 'purchases-next')
  clickable.props.onClick()
  assert.equal(nextOffset, 40)
})

// ------------------------------------------------------------------ [5] tab 切换

test('[5] tab 切换：四个 tab 分别把 status 传成 fulfilled / pending / expired / 不带筛选', async () => {
  assert.equal(tabToStatus('all'), null)
  assert.equal(tabToStatus('fulfilled'), 'fulfilled')
  assert.equal(tabToStatus('pending'), 'pending')
  assert.equal(tabToStatus('expired'), 'expired')

  const expected = [
    ['all', null],
    ['fulfilled', 'fulfilled'],
    ['pending', 'pending'],
    ['expired', 'expired'],
  ]
  for (const [tab, status] of expected) {
    const { fetchPurchases, calls } = fakeFetch(page())
    await loadPurchasePage({ fetchPurchases, apiKey: API_KEY, tab, offset: 0 })
    assert.deepEqual(
      calls,
      [{ apiKey: API_KEY, limit: PURCHASE_PAGE_SIZE, offset: 0, status }],
      `tab=${tab} 应该发 status=${JSON.stringify(status)}`
    )
  }
})

test('[5b] tab 切换：只有当前 tab 带 aria-selected，点别的 tab 会回传该 tab（并回到第一页）', () => {
  const nodes = tree({ tab: 'fulfilled', view: { status: 'ok', page: page() } })
  const fulfilled = byTestId(nodes, 'purchases-tab-fulfilled')
  const all = byTestId(nodes, 'purchases-tab-all')
  assert.equal(fulfilled.props['aria-selected'], true)
  assert.equal(all.props['aria-selected'], false)

  const clickedTab = []
  const clickable = byTestId(
    tree({ tab: 'fulfilled', view: { status: 'ok', page: page() }, onTab: (value) => clickedTab.push(value) }),
    'purchases-tab-pending'
  )
  clickable.props.onClick()
  assert.deepEqual(clickedTab, ['pending'])
})

// ------------------------------------------------------------------ [6] issued 跳兑换 / pending 去支付

test('[6] issued → 有「去兑换」按钮，点了走兑换分支（不碰支付）', () => {
  const issued = order({ status: 'fulfilled', redeemState: 'issued', cardNo: 'MUSE-3CYP-5NA3-AHSE-A3SR' })
  assert.equal(cardActionFor(issued), 'redeem')

  const view = { status: 'ok', page: page({ orders: [issued] }) }
  const nodes = tree({ view })
  assert.ok(byTestId(nodes, 'purchase-redeem') !== undefined, 'issued 必须有「去兑换」')
  assert.ok(byTestId(nodes, 'purchase-pay') === undefined, 'issued 不该有「去支付」')

  const fired = []
  const clickable = byTestId(
    tree({ view, onCardAction: (o, action) => fired.push([o.outTradeNo, action]) }),
    'purchase-redeem'
  )
  clickable.props.onClick()
  assert.deepEqual(fired, [[issued.outTradeNo, 'redeem']], '点「去兑换」必须回传 redeem 动作')
})

test('[6b] pending → 有「去支付」（文案复用既有 oursBuyAction），点了走支付分支', () => {
  const pending = order({
    status: 'pending',
    statusText: '待支付',
    redeemState: null,
    cardNo: null,
    paidAt: null,
  })
  assert.equal(cardActionFor(pending), 'pay')

  const view = { status: 'ok', page: page({ orders: [pending] }) }
  const nodes = tree({ view })
  const pay = byTestId(nodes, 'purchase-pay')
  assert.ok(pay !== undefined, 'pending 必须有「去支付」')
  assert.ok(byTestId(nodes, 'purchase-redeem') === undefined)
  assert.equal(pay.props.children, zh.oursBuyAction, '文案复用既有购买入口的「去支付」')

  const fired = []
  const clickable = byTestId(
    tree({ view, onCardAction: (_o, action) => fired.push(action) }),
    'purchase-pay'
  )
  clickable.props.onClick()
  assert.deepEqual(fired, ['pay'])
})

test('[6c] redeemed → 显示「已兑换」，展开后才把完整卡号放进 DOM，收起后消失', () => {
  const redeemed = order({ redeemState: 'redeemed' })
  assert.equal(cardActionFor(redeemed), 'none', '已兑换没有主操作')

  const collapsed = tree({ view: { status: 'ok', page: page({ orders: [redeemed] }) } })
  const toggle = byTestId(collapsed, 'purchase-card-toggle')
  assert.ok(toggle !== undefined, '已兑换要有「查看完整卡号」')
  assert.equal(toggle.props.children, zh.oursPurchasesShowCard)
  assert.ok(byTestId(collapsed, 'purchase-card-no') === undefined, '没展开时不该有完整卡号节点')

  const expandedMarkup = html({
    view: { status: 'ok', page: page({ orders: [redeemed] }) },
    expandedCard: redeemed.outTradeNo,
  })
  assert.ok(expandedMarkup.includes(redeemed.cardNo), '展开后要显示完整卡号')
  assert.ok(expandedMarkup.includes(zh.oursPurchasesHideCard), '展开后按钮文案变成「收起卡号」')

  const toggled = []
  const clickable = byTestId(
    tree({
      view: { status: 'ok', page: page({ orders: [redeemed] }) },
      onToggleCard: (no) => toggled.push(no),
    }),
    'purchase-card-toggle'
  )
  clickable.props.onClick()
  assert.deepEqual(toggled, [redeemed.outTradeNo])
})

test('[6d] 已过期 / 失败 / 已支付未发卡 都没有主操作，也不给展开卡号', () => {
  for (const over of [
    { status: 'expired', statusText: '已过期', redeemState: null, cardNo: null },
    { status: 'failed', statusText: '失败', redeemState: null, cardNo: null },
    { status: 'paid', statusText: '已支付', redeemState: null, cardNo: null },
  ]) {
    const item = order(over)
    assert.equal(cardActionFor(item), 'none', `${over.status} 不该有主操作`)
    const nodes = tree({ view: { status: 'ok', page: page({ orders: [item] }) } })
    assert.ok(byTestId(nodes, 'purchase-redeem') === undefined)
    assert.ok(byTestId(nodes, 'purchase-pay') === undefined)
    assert.ok(byTestId(nodes, 'purchase-card-toggle') === undefined)
  }
})

// ------------------------------------------------------------------ 三态其它细节

test('[7] 加载中：只显示加载文案，不显示列表 / 分页 / 累计金额数字', () => {
  const markup = html({ view: { status: 'loading' } })
  assert.ok(markup.includes(zh.oursPurchasesLoading))
  assert.ok(!markup.includes('data-testid="purchases-list"'))
  assert.ok(!markup.includes('data-testid="purchases-count"'))
  assert.ok(markup.includes('—'), '金额未知时显示占位符而不是 ¥0.00')
})

test('[8] 时间格式化：秒 / 毫秒都能认，非法值给占位符，且用本地时区', () => {
  const expected = (seconds) => {
    const d = new Date(seconds * 1000)
    const pad = (v) => String(v).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  assert.equal(formatPurchaseTime(CREATED_AT), expected(CREATED_AT), '秒级时间戳')
  assert.equal(formatPurchaseTime(CREATED_AT * 1000), expected(CREATED_AT), '毫秒级时间戳')
  assert.equal(formatPurchaseTime(0), '—')
  assert.equal(formatPurchaseTime(Number.NaN), '—')
  assert.equal(formatPurchaseTime(-1), '—')
})

test('[9] 文案：新增 key 在 zh / en 都成对，占位符对齐，en 下不含中文', () => {
  const keys = Object.keys(zh).filter((key) => key.startsWith('oursPurchases'))
  assert.ok(keys.length >= 25, `新增文案应有 25+ 条，实际 ${keys.length}`)
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', `en 缺 key: ${key}`)
    assert.ok(en[key].trim() !== '', `en 的 ${key} 不能为空`)
    const placeholders = (value) => (value.match(/\{(\w+)\}/gu) ?? []).sort().join(',')
    assert.equal(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符要和 zh 对齐`)
    assert.ok(!/[\u4e00-\u9fff]/u.test(en[key]), `en 的 ${key} 不该含中文：${en[key]}`)
  }
  // 错误文案必须一条一句、各不相同，别都退化成同一句
  const errorKeys = keys.filter((key) => key.startsWith('oursPurchasesErr'))
  assert.equal(errorKeys.length, 9, '八种 kind + 一句兜底')
  const distinct = new Set(errorKeys.map((key) => zh[key]))
  assert.equal(distinct.size, errorKeys.length, '每种错误要能区分开')
})


// [layer: unit | 依赖: 无（纯 Node，renderToStaticMarkup） | Issue #326]
//
// 回归对象：支付记录时间线的**分页 + 状态筛选**（#326）。
//
// #189 把时间线的展示与判定搬进了 `PaymentTrailView.ts`（无 JSX、无 CSS），所以这里能在裸 Node 里
// 直接跑生产代码：`trailListReducer` 是列表状态的唯一写入口，`mergeTrailOrders` 是翻页去重的唯一实现点。
//
// #326 的四条关闭条件逐条盯住：
//   1. 造 25+ 笔 → 能翻到第 21 笔，`total` 与实际条数一致（服务端 total，不用 items.length 推算）；
//   2. 切「已关闭」只剩过期单；切回「全部」时请求里**没有** status 参数、offset 回到 0；
//   3. 加载更多失败：已有记录一条不少，只在底部给重试；
//   4. 末页：按钮消失换成「已经到底了」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'

installTsResolve({ stubs: { '@capacitor/core': fixtureUrl('domain03-04/ours-web-capacitor.mjs') } })

const {
  PaymentTrailView,
  TRAIL_STATUS_TABS,
  canLoadMore,
  hasWaitingCard,
  initialTrailListState,
  loadTrailPage,
  mergeTrailOrders,
  nextTrailOffset,
  normalizeTrailTab,
  tabToTrailStatus,
  trailListReducer,
} = await import('../../src/components/settings/PaymentTrailView.ts')
const { en } = await import('../../src/i18n/en.ts')
const { zh } = await import('../../src/i18n/zh.ts')

// ------------------------------------------------------------------ 最小装配

/** 与 i18n/index.ts 同一套占位符规则（不 import 那份带 zustand 的实现） */
const tr = (table) => (key, params) => {
  const text = table[key]
  assert.equal(typeof text, 'string', `文案表里没有键 ${String(key)}`)
  return text.replace(/\{(\w+)\}/gu, (whole, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole
  })
}
const t = tr(zh)

/** 设计系统 Button 的替身：testId → data-testid，其余透传 */
const Btn = ({ testId, children, onClick, ...rest }) =>
  createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

/** 一条订单（字段够渲染一条卡片即可，卡密/时间线留空以免干扰断言） */
const order = (no, status = 'fulfilled') => ({
  outTradeNo: no,
  planId: 'pro',
  amountYuan: 29.9,
  status,
  statusText: '',
  createdAt: 1750000000,
  paidAt: null,
  expireAt: null,
  card: null,
  timeline: [],
  nextStep: '',
})

/** 连续单号的一批订单：`batch(1, 20)` → NO-001 … NO-020 */
const batch = (from, count, status = 'fulfilled') =>
  Array.from({ length: count }, (_, index) => order(`NO-${String(from + index).padStart(3, '0')}`, status))

const page = (orders, extra = {}) => ({
  customerId: 7,
  total: orders.length,
  limit: 20,
  offset: 0,
  totalPaidYuan: 99.9,
  orders,
  ...extra,
})

/** 一个「ok」视图：`items` 是累积列表，`page` 是最近一页，`total` 来自响应 */
const okView = (orders, { items = orders, total = orders.length, offset = 0, more = 'idle' } = {}) => ({
  status: 'ok',
  page: page(orders, { total, offset }),
  items,
  total,
  more,
})

const draw = (props) =>
  renderToStaticMarkup(PaymentTrailView({ t, classNames: {}, button: Btn, view: okView([]), ...props }))

const testIds = (markup) => [...markup.matchAll(/data-testid="([^"]+)"/gu)].map((match) => match[1])
const orderNos = (markup) =>
  [...markup.matchAll(/data-out-trade-no="([^"]*)"/gu)].map((match) => match[1])

/** 静态 HTML 没有事件处理器：交互要回到元素树上直接调 onClick */
const find = (node, testId, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) find(child, testId, out)
    return out
  }
  const props = node.props ?? {}
  if (props['data-testid'] === testId) out.push(node)
  if (props.children !== undefined) find(props.children, testId, out)
  return out
}

// ------------------------------------------------------------------ 1. 翻页去重

test('#326 翻页去重：两页有重叠时同号只留一条，顺序按先到先得', () => {
  const first = batch(1, 20)
  // 服务端第二页从第 16 笔开始回（重叠 5 条），这是「offset 与 total 不一致」时的真实形状
  const second = batch(16, 10)
  const merged = mergeTrailOrders(first, second)
  assert.equal(merged.length, 25, '20 + 10 - 5 条重叠 = 25 条')
  assert.deepEqual(
    merged.map((item) => item.outTradeNo),
    [...new Set([...first, ...second].map((item) => item.outTradeNo))]
  )

  // 同号用新数据覆盖，位置不变（轮询回填 / 翻页重复都靠这一条）
  const refreshed = mergeTrailOrders([order('A', 'paid')], [order('A', 'fulfilled')])
  assert.equal(refreshed.length, 1)
  assert.equal(refreshed[0].status, 'fulfilled')

  // 空单号（服务端缺字段）不去重：并成一条比多显示一行更糟
  assert.equal(mergeTrailOrders([order(''), order('')], []).length, 2)

  // 端到端：DOM 里单号唯一，条数与去重后一致
  const markup = draw({ view: okView(second, { items: merged, total: 25, offset: 20 }) })
  const nos = orderNos(markup)
  assert.equal(nos.length, 25)
  assert.equal(new Set(nos).size, 25, '同一单号不能出现两次')
})

// ------------------------------------------------------------------ 2. offset 累加 / total 只认响应

test('#326 offset 按已加载条数累加（0 → 20 → 40），limit 恒为 20，total 只认响应', async () => {
  const sent = []
  // 45 笔：三页（20 / 20 / 5），第 4 页不该被请求
  const fetchStub = async (params) => {
    sent.push({ limit: params.limit, offset: params.offset, status: params.status })
    const start = params.offset + 1
    const count = Math.min(20, 45 - params.offset)
    return page(batch(start, count), { total: 45, offset: params.offset, limit: params.limit })
  }

  const first = await loadTrailPage({ fetchTrail: fetchStub, apiKey: 'sk-x', offset: 0 })
  assert.equal(first.status, 'ok')
  let state = trailListReducer(initialTrailListState, { type: 'loaded', page: first.page })

  for (let round = 0; round < 2; round += 1) {
    const view = state.view
    assert.equal(view.status, 'ok')
    const offset = nextTrailOffset(view.items)
    const next = await loadTrailPage({ fetchTrail: fetchStub, apiKey: 'sk-x', offset })
    assert.equal(next.status, 'ok')
    state = trailListReducer(state, { type: 'more-loaded', page: next.page })
  }

  assert.deepEqual(sent.map((item) => item.offset), [0, 20, 40], 'offset 是纯 skip 计数，不是页码')
  assert.deepEqual(sent.map((item) => item.limit), [20, 20, 20], 'limit 恒定 20（服务端上限 50，用不着）')
  assert.equal(sent.every((item) => item.status === undefined), true, '「全部」页签不带 status 参数')

  const final = state.view
  assert.equal(final.status, 'ok')
  assert.equal(final.items.length, 45, '能翻到最后一条（第 21 笔起都拿到了）')
  assert.equal(final.total, 45, 'total 来自服务端响应')
  // 末页：hasMoreTrail / canLoadMore 都为假 → 按钮消失，换「已经到底了」
  assert.equal(canLoadMore(final.page, final.items.length), false)

  const markup = draw({ view: final, onLoadMore: () => {} })
  const ids = testIds(markup)
  assert.equal(ids.includes('trail-load-more'), false, '末页不该还有「加载更多」')
  assert.equal(ids.filter((id) => id === 'trail-end').length, 1)
  assert.ok(markup.includes(zh.oursTrailEndOfList))
  assert.ok(markup.includes('共 45 笔'), '统计条用的是服务端 total')
})

test('#326 加载第 2 页时「共 N 条」不变（total 不是 items.length 推算出来的）', () => {
  const firstPage = batch(1, 20)
  const secondPage = batch(21, 20)
  const before = draw({ view: okView(firstPage, { total: 45 }) })
  const after = draw({
    view: okView(secondPage, { items: [...firstPage, ...secondPage], total: 45, offset: 20 }),
    onLoadMore: () => {},
  })
  assert.ok(before.includes('共 45 笔'))
  assert.ok(after.includes('共 45 笔'), '加载更多不能把「共 45 笔」改成 40')
  assert.ok(after.includes(zh.oursTrailLoadMore), '还有第 3 页时要给「加载更多」')
})

// ------------------------------------------------------------------ 3. 筛选重置

test('#326 切筛选整段重置：offset 回 0、旧页清空、切回「全部」不带 status', async () => {
  // 请求参数口径：只有非 all 的页签才发 status，且一律小写
  assert.equal(tabToTrailStatus('all'), null)
  assert.equal(tabToTrailStatus('expired'), 'expired')
  for (const def of TRAIL_STATUS_TABS) {
    const status = tabToTrailStatus(def.value)
    if (status !== null) {
      assert.equal(status, status.toLowerCase(), 'status 用小写契约值（服务端不校验大小写，发错是静默错）')
    }
  }

  // reducer 口径：切页签 = loading 且 items/total 整段消失（旧筛选的页绝不能拼到新筛选后面）
  const loaded = trailListReducer(initialTrailListState, {
    type: 'loaded',
    page: page(batch(1, 20), { total: 45 }),
  })
  assert.equal(loaded.view.items.length, 20)

  const switched = trailListReducer(loaded, { type: 'tab', tab: 'expired' })
  assert.equal(switched.tab, 'expired')
  assert.deepEqual(switched.view, { status: 'loading' }, '切筛选必须整段重置，不能留下上一筛选的列表')

  const expiredPage = page(batch(101, 3, 'expired'), { total: 3 })
  const afterFilter = trailListReducer(switched, { type: 'loaded', page: expiredPage })
  assert.equal(afterFilter.view.items.length, 3)
  assert.equal(afterFilter.view.total, 3, 'total 换成新筛选的响应值')
  assert.equal(afterFilter.view.items.every((item) => item.status === 'expired'), true)
  assert.equal(nextTrailOffset(afterFilter.view.items), 3, '新筛选的下一页 offset 从本筛选已加载条数算')

  // 切回「全部」：offset 重新从 0 开始，请求里一个 status 参数都没有
  const back = trailListReducer(afterFilter, { type: 'tab', tab: 'all' })
  assert.deepEqual(back.view, { status: 'loading' })
  const sent = []
  const result = await loadTrailPage({
    fetchTrail: async (params) => {
      sent.push(params)
      return page(batch(1, 20), { total: 45 })
    },
    apiKey: 'sk-x',
    offset: 0,
    status: tabToTrailStatus(back.tab),
  })
  assert.equal(result.status, 'ok')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0], { apiKey: 'sk-x', limit: 20, offset: 0 }, '「全部」不带 status 键')
  assert.equal(Object.hasOwn(sent[0], 'status'), false)

  // 未知页签值归 all（旧版本存下来的值不该让筛选条出现幽灵选中项）
  assert.equal(normalizeTrailTab('expired'), 'expired')
  assert.equal(normalizeTrailTab(''), 'all')
  assert.equal(normalizeTrailTab('EXPIRED'), 'all')
  assert.equal(normalizeTrailTab(undefined), 'all')
})

test('#326 页签条：六个页签、选中态 aria-selected、点击回调传值', () => {
  const calls = []
  const tree = PaymentTrailView({
    t,
    classNames: {},
    button: Btn,
    view: okView(batch(1, 2)),
    tab: 'expired',
    onTabChange: (value) => calls.push(value),
    onLoadMore: () => {},
  })
  const markup = renderToStaticMarkup(tree)
  const ids = testIds(markup)
  assert.equal(ids.filter((id) => id === 'trail-tabs').length, 1)
  for (const def of TRAIL_STATUS_TABS) {
    assert.equal(ids.filter((id) => id === `trail-tab-${def.value}`).length, 1, `缺页签 ${def.value}`)
  }
  assert.ok(markup.includes(zh.oursTrailTabAll))
  assert.ok(markup.includes('aria-selected="true"'))
  assert.ok(markup.includes('data-active="true"'))
  const [allTab] = find(tree, 'trail-tab-all')
  const [expiredTab] = find(tree, 'trail-tab-expired')
  assert.equal(allTab.props['aria-selected'], 'false')
  assert.equal(expiredTab.props['aria-selected'], 'true')
  expiredTab.props.onClick()
  allTab.props.onClick()
  assert.deepEqual(calls, ['expired', 'all'])
})

test('#326 筛选后是空列表：提示换个筛选，不说「还没有支付记录」', () => {
  const filtered = draw({ view: okView([]), tab: 'expired' })
  assert.ok(filtered.includes(zh.oursTrailEmptyFiltered))
  assert.equal(filtered.includes(zh.oursTrailEmpty), false, '筛选空 ≠ 一笔都没买过')
  const all = draw({ view: okView([]), tab: 'all' })
  assert.ok(all.includes(zh.oursTrailEmpty))
})

// ------------------------------------------------------------------ 4. 加载更多失败不清空

test('#326 加载更多失败：已渲染记录一条不少，底部给重试且不打整页错误', () => {
  const items = batch(1, 20)
  const loaded = okView(items, { total: 45 })
  const failed = trailListReducer(
    { tab: 'all', view: loaded },
    { type: 'more-failed', error: { messageKey: 'oursTrailErrTimeout', retryable: true, needsKey: false } }
  )
  assert.equal(failed.view.status, 'ok', '加载更多失败不能把整页换成 error')
  assert.equal(failed.view.items.length, 20, '已渲染的 20 条一条不少')
  assert.equal(failed.view.total, 45, 'total 也不能被失败清掉')
  assert.equal(failed.view.more, 'error')

  const calls = []
  const tree = PaymentTrailView({
    t,
    classNames: {},
    button: Btn,
    view: failed.view,
    tab: 'all',
    onLoadMore: () => calls.push('more'),
    onRetryMore: () => calls.push('retry'),
    onRetry: () => calls.push('page-retry'),
  })
  const markup = renderToStaticMarkup(tree)
  const ids = testIds(markup)
  assert.equal(orderNos(markup).length, 20, '失败后列表还在')
  assert.equal(ids.includes('trail-error'), false, '不能出现整页错误块')
  assert.equal(ids.filter((id) => id === 'trail-more-error').length, 1)
  assert.ok(markup.includes(zh.oursTrailLoadMoreFailed))
  const [retry] = find(tree, 'trail-more-retry')
  retry.props.onClick()
  assert.deepEqual(calls, ['retry'], '重试只重打同一页，不动整页')

  // 重试成功后恢复 idle，且 canLoadMore 仍为真（同一 offset 再打一次就有下一页）
  const recovered = trailListReducer(failed, { type: 'more-loaded', page: page(batch(21, 20), { total: 45, offset: 20 }) })
  assert.equal(recovered.view.more, 'idle')
  assert.equal(recovered.view.items.length, 40)
  assert.equal(recovered.view.total, 45, '追加不会把 total 变成 items.length')
})

test('#326 加载中不闪空态：more=loading 只换掉按钮那一行', () => {
  const markup = draw({ view: okView(batch(1, 20), { total: 45, more: 'loading' }), onLoadMore: () => {} })
  const ids = testIds(markup)
  assert.equal(orderNos(markup).length, 20)
  assert.equal(ids.filter((id) => id === 'trail-loading-more').length, 1)
  assert.equal(ids.includes('trail-load-more'), false)
  assert.equal(ids.includes('trail-end'), false, '还在加载时不能先说「已经到底了」')
  assert.ok(markup.includes(zh.oursTrailLoadingMore))
})

// ------------------------------------------------------------------ 5. 轮询看全部已加载项

test('#326 轮询判定看全部已加载记录：第 2 页里的 paid 单也要继续刷新', () => {
  assert.equal(hasWaitingCard(batch(1, 20, 'fulfilled')), false)
  assert.equal(hasWaitingCard([...batch(1, 20), order('NO-021', 'paid')]), true)

  // 静默轮询只并第一页：同号覆盖、追加页原地不动、顺序不变
  const items = [...batch(1, 20), order('NO-021', 'paid')]
  const merged = trailListReducer(
    { tab: 'all', view: okView(batch(1, 20), { items, total: 25, offset: 20 }) },
    { type: 'silent', page: page([...batch(1, 19), order('NO-020', 'fulfilled')], { total: 25 }) }
  )
  assert.equal(merged.view.items.length, 21, '第 2 页的记录不能因为轮询消失')
  assert.equal(merged.view.items[20].outTradeNo, 'NO-021')
  assert.equal(hasWaitingCard(merged.view.items), true, '第 2 页的 paid 单还在，轮询要继续')
})

// ------------------------------------------------------------------ 6. 文案

test('#326 新增文案中英成对，英文里不夹中文', () => {
  const keys = [
    'oursTrailTabAll',
    'oursTrailFilterLabel',
    'oursTrailLoadMore',
    'oursTrailLoadingMore',
    'oursTrailLoadMoreFailed',
    'oursTrailEndOfList',
    'oursTrailEmptyFiltered',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.notEqual(zh[key].trim(), '', `zh.${key} 是空值`)
    assert.notEqual(en[key].trim(), '', `en.${key} 是空值`)
    assert.notEqual(zh[key], en[key], `${key} 中英一模一样，八成是漏翻译`)
    assert.equal(/[一-鿿]/u.test(en[key]), false, `en.${key} 里混进了中文：${en[key]}`)
  }
  // 页签文案复用既有 oursTrailStatus*，不另造一套叫法
  const reused = TRAIL_STATUS_TABS.filter((def) => def.value !== 'all').map((def) => def.labelKey)
  assert.deepEqual(reused, [
    'oursTrailStatusCreated',
    'oursTrailStatusPaid',
    'oursTrailStatusFulfilled',
    'oursTrailStatusExpired',
    'oursTrailStatusFailed',
  ])
  const te = tr(en)
  const markup = renderToStaticMarkup(
    PaymentTrailView({
      t: te,
      classNames: {},
      button: Btn,
      view: okView(batch(1, 20), { total: 45, more: 'error' }),
      tab: 'all',
      onTabChange: () => {},
      onLoadMore: () => {},
      onRetryMore: () => {},
    })
  )
  // 静态 HTML 里单引号会被转义（Couldn&#x27;t），比较时按转义后的形态
  assert.ok(markup.includes(en.oursTrailLoadMoreFailed.replace(/'/gu, '&#x27;')))
  assert.equal(/[\u4e00-\u9fa5]/u.test(markup.replace(/•+/gu, '')), false, '英文界面不能出现中文')
})

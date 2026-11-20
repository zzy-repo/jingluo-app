// [layer: unit | 依赖: 无（纯 Node，零浏览器；Capacitor 用替身，网络用假 transport / 假 fetch） | 耗时: <1s]
// Issue #158（「我的购买」数据层）的单测，只测 src/services/ours/purchases.ts：
//   [1] 正常解析：直接用 #158 里的示例 JSON（金额 / 积分 / 状态 / 中文 / 卡号 / 时间 / 累计实付）
//   [2] 筛选：status=fulfilled|pending|expired 拼进 query；不传就不带这个参数
//   [3] 分页夹取：limit 0→20、1000→100；offset 负数→0
//   [4] 畸形数据不崩：orders 非数组 / 缺 total / amount_yuan 是字符串 / 元素不是对象
//   [5] 卡号脱敏：完整 → 后 4 位；短卡号不整条泄露；null → 空
//   [6] 分页边界：正好最后一页 → 没有下一页；空列表 → 没有下一页
//   [7] 错误映射：401（要重填 Key，不可重试）与超时（可重试）必须是**两种**错误
//   [8] 走真实传输层（transport.ts + 假 fetch）：Key 只在 Authorization 头，URL 里没有 Key
//
// 跑法：node --test tests/unit/ours-purchases.test.mjs（或 node tests/run-layer.mjs unit）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'


// 装配走公共入口（#408 收尾批）：原生桥替身收成 fixtures/domain03-04/ours-web-capacitor.mjs，
// `.js→.ts` 解析由 installTsResolve 统一处理，不再是本文件手抄的 ~25 行 registerHooks。
installTsResolve({
  stubs: { '@capacitor/core': fixtureUrl('domain03-04/ours-web-capacitor.mjs') },
})

const purchases = await import('../../src/services/ours/purchases.ts')
const {
  PurchaseError,
  PURCHASES_DEFAULT_LIMIT,
  PURCHASES_MAX_LIMIT,
  clampPurchasesLimit,
  clampPurchasesOffset,
  fetchPurchases,
  fetchPurchasesVia,
  hasNextPage,
  isRetryablePurchaseError,
  maskCardNo,
  parsePurchasePage,
  purchaseStatusOf,
} = purchases

const API_KEY = 'sk-live-DEADBEEFDEADBEEF1234'

/** #158 里的示例响应，一字不改（除了补一条未支付订单覆盖 null 分支） */
const sampleJson = () => ({
  customer_id: 7,
  total: 14,
  limit: 20,
  offset: 0,
  total_paid_yuan: 5.9,
  orders: [
    {
      out_trade_no: 'CP202611182359489D46C638',
      plan_id: 'newbie',
      plan_name: '新人特惠 1 元额度',
      plan_points: 500,
      amount_yuan: 1.0,
      status: 'FULFILLED',
      status_text: '已完成',
      card_no: 'MUSE-3CYP-5NA3-AHSE-A3SR',
      card_status: 'leased',
      redeem_state: 'issued',
      created_at: 1795015148,
      paid_at: 1795015210,
    },
    {
      out_trade_no: 'CP2026111900010077A1B2C3',
      plan_id: 'p1',
      plan_name: '标准 3 元',
      plan_points: 300,
      amount_yuan: 3.0,
      status: 'PENDING',
      status_text: '待支付',
      card_no: null,
      card_status: null,
      redeem_state: null,
      created_at: 1795100000,
      paid_at: null,
    },
  ],
})

const json = (body, status = 200) => ({ kind: 'response', status, text: JSON.stringify(body) })
const transportReturning = (result) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return typeof result === 'function' ? result(request) : result
  }
  return { calls, transport }
}

const kindOf = async (promise) => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof PurchaseError, `必须抛 PurchaseError，实际 ${String(error)}`)
    return error
  }
  assert.fail('本应抛错，实际成功了')
}

// ------------------------------------------------------------------ [1] 正常解析
test('#158 示例 JSON 完整解析（金额 / 积分 / 中文状态 / 卡号 / 时间 / 累计实付）', async () => {
  const { transport, calls } = transportReturning(json(sampleJson()))
  const page = await fetchPurchasesVia({ apiKey: API_KEY }, transport)

  assert.equal(calls.length, 1)
  assert.deepEqual(page, {
    customerId: 7,
    total: 14,
    limit: 20,
    offset: 0,
    totalPaidYuan: 5.9,
    orders: [
      {
        outTradeNo: 'CP202611182359489D46C638',
        planId: 'newbie',
        planName: '新人特惠 1 元额度',
        planPoints: 500,
        amountYuan: 1,
        status: 'fulfilled',
        statusText: '已完成',
        cardNo: 'MUSE-3CYP-5NA3-AHSE-A3SR',
        cardStatus: 'leased',
        redeemState: 'issued',
        createdAt: 1795015148,
        paidAt: 1795015210,
      },
      {
        outTradeNo: 'CP2026111900010077A1B2C3',
        planId: 'p1',
        planName: '标准 3 元',
        planPoints: 300,
        amountYuan: 3,
        status: 'pending',
        statusText: '待支付',
        cardNo: null,
        cardStatus: null,
        redeemState: null,
        createdAt: 1795100000,
        paidAt: null,
      },
    ],
  })
})

test('状态大小写无关；非法状态归 failed 且保留后端中文', () => {
  assert.equal(purchaseStatusOf('FULFILLED'), 'fulfilled')
  assert.equal(purchaseStatusOf(' paid '), 'paid')
  assert.equal(purchaseStatusOf('expired'), 'expired')
  assert.equal(purchaseStatusOf('REFUNDED'), 'failed')
  const order = purchases.parsePurchaseOrder({
    out_trade_no: 'CP1',
    status: 'REFUNDED',
    status_text: '退款处理中',
    amount_yuan: 2,
  })
  assert.equal(order.status, 'failed')
  assert.equal(order.statusText, '退款处理中')
})

// ------------------------------------------------------------------ [2] 状态筛选参数
test('status 过滤：fulfilled / pending / expired 拼进 query，不传则不带该参数', async () => {
  const cases = [
    ['fulfilled', 'status=fulfilled'],
    ['pending', 'status=pending'],
    ['expired', 'status=expired'],
  ]
  for (const [status, expected] of cases) {
    const { transport, calls } = transportReturning(json(sampleJson()))
    await fetchPurchasesVia({ apiKey: API_KEY, status }, transport)
    const url = new URL(calls[0].url)
    assert.equal(url.searchParams.get('status'), status, `${status} 必须作为 status 参数发出`)
    assert.equal(url.pathname, '/api/orders')
    assert.ok(url.href.includes(expected))
  }

  for (const params of [{}, { status: null }]) {
    const { transport, calls } = transportReturning(json(sampleJson()))
    await fetchPurchasesVia({ apiKey: API_KEY, ...params }, transport)
    const url = new URL(calls[0].url)
    assert.equal(url.searchParams.has('status'), false, '不带 status 时 URL 里不能出现 status=')
  }
})

// ------------------------------------------------------------------ [3] 分页夹取
test('limit 夹取：0 / 负数 / 非数字 → 20，1000 → 100；offset 负数 → 0', async () => {
  assert.equal(clampPurchasesLimit(0), PURCHASES_DEFAULT_LIMIT)
  assert.equal(clampPurchasesLimit(-5), PURCHASES_DEFAULT_LIMIT)
  assert.equal(clampPurchasesLimit(Number.NaN), PURCHASES_DEFAULT_LIMIT)
  assert.equal(clampPurchasesLimit(undefined), PURCHASES_DEFAULT_LIMIT)
  assert.equal(clampPurchasesLimit(1000), PURCHASES_MAX_LIMIT)
  assert.equal(clampPurchasesLimit(37.9), 37)
  assert.equal(clampPurchasesLimit(100), 100)
  assert.equal(clampPurchasesOffset(-1), 0)
  assert.equal(clampPurchasesOffset(Number.NaN), 0)
  assert.equal(clampPurchasesOffset(undefined), 0)
  assert.equal(clampPurchasesOffset(40.7), 40)

  const sent = []
  for (const [limit, offset, expected] of [
    [0, 0, { limit: '20', offset: '0' }],
    [1000, -3, { limit: '100', offset: '0' }],
    [5, 40, { limit: '5', offset: '40' }],
  ]) {
    const { transport, calls } = transportReturning(json(sampleJson()))
    await fetchPurchasesVia({ apiKey: API_KEY, limit, offset }, transport)
    const url = new URL(calls[0].url)
    assert.deepEqual(
      { limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') },
      expected
    )
    sent.push(calls[0].url)
  }
  assert.equal(sent.length, 3)
})

// ------------------------------------------------------------------ [4] 畸形数据
test('orders 不是数组 / 缺 total / 元素不是对象 → 不崩，给安全默认值', () => {
  const noArray = parsePurchasePage({ customer_id: 3, total: 9, limit: 20, offset: 0, orders: 'x' })
  assert.deepEqual(noArray.orders, [])
  assert.equal(noArray.total, 9)
  assert.equal(noArray.customerId, 3)

  const missingTotal = parsePurchasePage({ orders: [{ out_trade_no: 'A' }, { out_trade_no: 'B' }] })
  assert.equal(missingTotal.total, 2, '缺 total 时退化成当前页条数')
  assert.equal(missingTotal.orders.length, 2)
  assert.equal(missingTotal.totalPaidYuan, 0)
  assert.equal(missingTotal.customerId, null)

  const junk = parsePurchasePage({
    customer_id: 0,
    total: 'abc',
    orders: ['not-an-object', 42, null, { out_trade_no: 'OK' }],
  })
  assert.equal(junk.orders.length, 1, '非对象条目丢掉，剩下那条保留')
  assert.equal(junk.orders[0].outTradeNo, 'OK')
  assert.equal(junk.total, 1)
  assert.equal(junk.customerId, null, 'customer_id=0 视为不知道')

  // 根不是对象：交给调用方报 badResponse，这里只确认「解析函数本身不抛」
  assert.equal(parsePurchasePage('<!doctype html>'), null)
  assert.equal(parsePurchasePage(null), null)
})

test('amount_yuan / 时间是字符串或垃圾值 → 数字照解，垃圾给默认值', () => {
  const order = purchases.parsePurchaseOrder({
    out_trade_no: 'X1',
    amount_yuan: '1.50',
    plan_points: '500',
    status: 'PAID',
    created_at: '1795015148',
    paid_at: 'oops',
    card_status: 'weird',
    redeem_state: 'whatever',
  })
  assert.equal(order.amountYuan, 1.5, '纯数字串按数字解析（老后端会这么给）')
  assert.equal(order.planPoints, 500)
  assert.equal(order.status, 'paid')
  assert.equal(order.createdAt, 1795015148)
  assert.equal(order.paidAt, null, '认不出的时间 → null，不是 NaN')
  assert.equal(order.cardStatus, null, '未知 card_status → null')
  assert.equal(order.redeemState, null, '未知 redeem_state → null')

  const garbage = purchases.parsePurchaseOrder({ out_trade_no: 'X2', amount_yuan: 'abc', plan_points: null })
  assert.equal(garbage.amountYuan, 0)
  assert.equal(garbage.planPoints, 0)
  assert.equal(garbage.createdAt, 0)
  assert.equal(garbage.cardNo, null)
  assert.equal(garbage.status, 'failed', '没有 status 也算非法')
  assert.equal(Number.isNaN(garbage.amountYuan), false)
})

// ------------------------------------------------------------------ [5] 卡号脱敏
test('maskCardNo：完整卡号只留后 4 位，短卡号不整条泄露，null → 空', () => {
  assert.equal(maskCardNo('MUSE-3CYP-5NA3-AHSE-A3SR'), '••••A3SR')
  assert.equal(maskCardNo('1234'), '••••', '恰好 4 位时不能把整条卡号露出来')
  assert.equal(maskCardNo('12'), '••••')
  assert.equal(maskCardNo(''), '••••')
  assert.equal(maskCardNo(null), '')
  // 页面上任何一条订单的卡号都不允许以完整形态出现
  const page = parsePurchasePage(sampleJson())
  for (const order of page.orders) {
    if (order.cardNo === null) {
      assert.equal(maskCardNo(order.cardNo), '')
      continue
    }
    const masked = maskCardNo(order.cardNo)
    assert.equal(masked.endsWith(order.cardNo.slice(-4)), true)
    assert.equal(masked.includes(order.cardNo), false)
  }
})

// ------------------------------------------------------------------ [6] 分页边界
test('hasNextPage：offset + orders.length < total', () => {
  const page = (offset, count, total) => ({
    customerId: 1,
    total,
    limit: 20,
    offset,
    totalPaidYuan: 0,
    orders: Array.from({ length: count }, (_, index) => ({ outTradeNo: `N${index}` })),
  })
  assert.equal(hasNextPage(page(0, 20, 14)), false, '第一页就超过 total：没有下一页')
  assert.equal(hasNextPage(page(0, 20, 34)), true)
  assert.equal(hasNextPage(page(20, 14, 34)), false, 'offset+本页 = total：刚好最后一页')
  assert.equal(hasNextPage(page(20, 13, 34)), true)
  assert.equal(hasNextPage(page(0, 0, 0)), false, '空列表')
  assert.equal(hasNextPage(page(0, 0, 5)), true, '空页但服务端说有 5 条：仍可继续翻')
})

// ------------------------------------------------------------------ [7] 错误映射
test('401 与超时是两种可区分的错误：401 要重填 Key 且不可重试，超时可重试', async () => {
  const unauthorized = await kindOf(
    fetchPurchasesVia(
      { apiKey: API_KEY },
      transportReturning(json({ code: 'UNAUTHORIZED', message: 'invalid api key' }, 401)).transport
    )
  )
  assert.equal(unauthorized.kind, 'unauthorized')
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.needsKey, true)
  assert.equal(unauthorized.retryable, false)

  const timeout = await kindOf(
    fetchPurchasesVia({ apiKey: API_KEY }, transportReturning({ kind: 'timeout' }).transport)
  )
  assert.equal(timeout.kind, 'timeout')
  assert.equal(timeout.retryable, true)
  assert.equal(timeout.needsKey, false)
  assert.notEqual(timeout.kind, unauthorized.kind)

  const network = await kindOf(
    fetchPurchasesVia({ apiKey: API_KEY }, transportReturning({ kind: 'network' }).transport)
  )
  assert.equal(network.kind, 'network')
  assert.equal(network.retryable, true)

  const server = await kindOf(
    fetchPurchasesVia({ apiKey: API_KEY }, transportReturning(json({ code: 'BOOM' }, 503)).transport)
  )
  assert.equal(server.kind, 'server')
  assert.equal(server.status, 503)
  assert.equal(server.retryable, true)

  const limited = await kindOf(
    fetchPurchasesVia({ apiKey: API_KEY }, transportReturning(json({ code: 'RATE_LIMITED' }, 429)).transport)
  )
  assert.equal(limited.kind, 'rateLimited')
  assert.equal(limited.retryable, true)

  // 非 PurchaseError 一律不重试（别处 catch 到的未知错误不应该被当成「网络抖动」）
  assert.equal(isRetryablePurchaseError(new Error('boom')), false)
})

test('没填 Key 不发请求；2xx 但不是对象 → badResponse', async () => {
  const { transport, calls } = transportReturning(json(sampleJson()))
  const missing = await kindOf(fetchPurchasesVia({ apiKey: '   ' }, transport))
  assert.equal(missing.kind, 'keyMissing')
  assert.equal(missing.needsKey, true)
  assert.equal(calls.length, 0, '没有 Key 时不能发请求')

  const html = await kindOf(
    fetchPurchasesVia({ apiKey: API_KEY }, transportReturning({ kind: 'response', status: 200, text: '<html>' }).transport)
  )
  assert.equal(html.kind, 'badResponse')
  assert.equal(html.retryable, false)
})

// ------------------------------------------------------------------ [8] 真实传输层 + Key 位置
test('走真实 transport：Key 只在 Authorization 头，URL 里只有 limit/offset/status', async () => {
  const captured = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), init })
    return new Response(JSON.stringify(sampleJson()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const page = await fetchPurchases({ apiKey: API_KEY, limit: 10, offset: 20, status: 'fulfilled' })
    assert.equal(page.orders.length, 2)
    assert.equal(captured.length, 1)
    const { url, init } = captured[0]
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`)
    assert.equal(url.includes('sk-live'), false, 'URL 里绝不能出现 Key')
    assert.equal(url.includes('api_key'), false)
    assert.equal(new URL(url).pathname, '/api/orders')
    assert.equal(new URL(url).searchParams.get('status'), 'fulfilled')
    assert.equal(new URL(url).searchParams.get('limit'), '10')
    assert.equal(new URL(url).searchParams.get('offset'), '20')
    assert.equal(new URL(url).origin, 'https://apia.ecsafe.cn')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('真实 transport 的超时 / 断网被区分开，错误文案里没有 Key', async () => {
  const realFetch = globalThis.fetch
  const abort = new Error('The operation was aborted')
  abort.name = 'AbortError'
  globalThis.fetch = async () => {
    throw abort
  }
  try {
    const timedOut = await kindOf(fetchPurchases({ apiKey: API_KEY }))
    assert.equal(timedOut.kind, 'timeout')
    assert.equal(timedOut.retryable, true)
    const text = `${timedOut.message} ${timedOut.detail ?? ''}`
    assert.equal(text.includes(API_KEY), false, '错误文案里不能出现完整 Key')
    assert.equal(text.includes('DEADBEEF'), false)
  } finally {
    globalThis.fetch = realFetch
  }

  globalThis.fetch = async () => {
    throw new TypeError('fetch failed')
  }
  try {
    const offline = await kindOf(fetchPurchases({ apiKey: API_KEY }))
    assert.equal(offline.kind, 'network')
    assert.equal(offline.retryable, true)
  } finally {
    globalThis.fetch = realFetch
  }
})

// [layer: unit | 依赖: 无（纯 Node，假 transport） | Issue #189]
//
// 回归对象：支付记录时间线数据层 `src/services/ours/trail.ts`。
//
// 契约（issue #189 + 2026-11-19 实测错误形状）：
//   GET {base}/api/trail?limit&offset&status          → { customer_id, total, limit, offset, total_paid_yuan, orders:[…] }
//   GET {base}/api/order/trail?out_trade_no=          → 单个订单对象
//   GET {base}/api/card/trail?card_no=                → { card_no, purchase, redemption }
//   Key **只走 Authorization 头**，URL 里只有业务参数。
//
// 这些用例覆盖的是「真实响应形状」上的行为，不是实现细节：
//   五个状态各有 fixture、空列表、401 / 404 / 503、超时、坏 JSON、未知事件、跨用户 404。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'


// 装配走公共入口（#408 收尾批）：原生桥替身收成 fixtures/domain03-04/ours-web-capacitor.mjs，
// `.js→.ts` 解析由 installTsResolve 统一处理，不再是本文件手抄的 ~25 行 registerHooks。
installTsResolve({
  stubs: { '@capacitor/core': fixtureUrl('domain03-04/ours-web-capacitor.mjs') },
})

const SOURCE = readFileSync(new URL('../../src/services/ours/trail.ts', import.meta.url), 'utf8')

const {
  TRAIL_DEFAULT_LIMIT,
  TRAIL_MAX_LIMIT,
  TRAIL_ORDER_STATUSES,
  TrailError,
  clampTrailLimit,
  clampTrailOffset,
  eventToneOf,
  fetchCardTrailVia,
  fetchOrderTrailVia,
  fetchTrailVia,
  hasMoreTrail,
  parseCardTrail,
  parseTrailOrder,
  parseTrailPage,
  trailStatusOf,
  trailToneOf,
} = await import('../../src/services/ours/trail.ts')

const fixtures = await import('../fixtures/domain06-07/ours-trail.mjs')

const BASE = 'https://example.test'
const KEY = 'sk-trail-fixture-0000'

/** 假 transport：记录每次请求，按队列回放响应 */
const makeTransport = (...results) => {
  const calls = []
  const queue = [...results]
  const transport = async (request) => {
    calls.push(request)
    const next = queue.shift()
    if (next === undefined) {
      throw new Error(`transport 被多调了一次：${request.url}`)
    }
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}

const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

const assertTrailError = (error, kind) => {
  assert.ok(error instanceof Error, '必须抛 Error')
  assert.equal(error.kind, kind, `错误类型应为 ${kind}，实际 ${error.kind}：${error.message}`)
  assert.equal(error.name, 'TrailError')
}

// ------------------------------------------------------------------ 契约本身

test('#189 端点与参数名与契约一致（改名字等于把请求打到空气里）', () => {
  for (const endpoint of ['/api/trail', '/api/order/trail', '/api/card/trail']) {
    assert.ok(SOURCE.includes(endpoint), `数据层没有请求 ${endpoint}`)
  }
  for (const param of ['limit', 'offset', 'status', 'out_trade_no', 'card_no']) {
    assert.ok(SOURCE.includes(`'${param}'`), `缺少查询参数 ${param}`)
  }
  // Key 只在请求头出现，不许拼进 query（日志 / 代理都会留 URL）
  assert.ok(SOURCE.includes('Authorization'), '请求头里没有 Authorization')
  assert.ok(!/searchParams\.set\(\s*'?(api_?key|key|token)'?/iu.test(SOURCE), 'Key 被拼进了 query')
})

test('#189 上限 50（默认 20）：服务端对 >50 会拒绝，客户端先夹住', () => {
  assert.equal(TRAIL_DEFAULT_LIMIT, 20)
  assert.equal(TRAIL_MAX_LIMIT, 50)
  assert.equal(clampTrailLimit(undefined), 20)
  assert.equal(clampTrailLimit(0), 20, '0 当成没传')
  assert.equal(clampTrailLimit(-5), 20)
  assert.equal(clampTrailLimit(7), 7)
  assert.equal(clampTrailLimit(50), 50)
  assert.equal(clampTrailLimit(999), 50, '超上限要夹住，不能透传给服务端')
  assert.equal(clampTrailLimit(Number.NaN), 20)
  assert.equal(clampTrailOffset(undefined), 0)
  assert.equal(clampTrailOffset(-3), 0)
  assert.equal(clampTrailOffset(40), 40)
})

test('#189 五个状态都能识别，未知状态不丢单（落到 failed 且保留原文）', () => {
  assert.deepEqual([...TRAIL_ORDER_STATUSES], ['created', 'paid', 'fulfilled', 'expired', 'failed'])
  assert.equal(trailStatusOf('CREATED'), 'created')
  assert.equal(trailStatusOf('created'), 'created')
  assert.equal(trailStatusOf(' PAID '), 'paid')
  assert.equal(trailStatusOf('FULFILLED'), 'fulfilled')
  assert.equal(trailStatusOf('EXPIRED'), 'expired')
  assert.equal(trailStatusOf('FAILED'), 'failed')
  assert.equal(trailStatusOf('REFUNDED'), 'failed')
  assert.equal(trailStatusOf(''), 'failed')
})

test('#189 EXPIRED 不能当成「失败」展示：色调与文案都要与 failed 分开', () => {
  assert.equal(trailToneOf('paid'), 'pending')
  assert.equal(trailToneOf('created'), 'pending')
  assert.equal(trailToneOf('fulfilled'), 'success')
  assert.equal(trailToneOf('failed'), 'danger')
  // 超时关闭是可救回的中间态（24h 内付款会补发），不是失败
  assert.equal(trailToneOf('expired'), 'muted')
  assert.notEqual(trailToneOf('expired'), trailToneOf('failed'))
})

// ------------------------------------------------------------------ 解析真实形状

test('#189 解析一页：五个状态的订单全部保留，字段名 camelCase 化', () => {
  const page = parseTrailPage(fixtures.trailPage)
  assert.ok(page !== null)
  assert.equal(page.customerId, fixtures.TRAIL_CUSTOMER_ID)
  assert.equal(page.total, 6)
  assert.equal(page.limit, 20)
  assert.equal(page.offset, 0)
  assert.equal(page.totalPaidYuan, 72.7)
  assert.equal(page.orders.length, 6)
  assert.deepEqual(
    page.orders.slice(0, 5).map((order) => order.status),
    ['created', 'paid', 'fulfilled', 'expired', 'failed']
  )
  const created = page.orders[0]
  assert.equal(created.outTradeNo, fixtures.trailOrderCreated.out_trade_no)
  assert.equal(created.planId, 'newbie')
  assert.equal(created.amountYuan, 1)
  assert.equal(created.statusText, '待支付')
  assert.equal(created.createdAt, fixtures.trailOrderCreated.created_at)
  assert.equal(created.paidAt, null)
  assert.equal(created.expireAt, fixtures.trailOrderCreated.expire_at)
  assert.equal(created.card, null)
  assert.equal(created.timeline.length, 1)
  assert.equal(created.timeline[0].event, 'order_created')
  assert.equal(created.timeline[0].at, fixtures.trailOrderCreated.created_at)
  assert.equal(created.nextStep, '完成支付后卡密会立即发放')
})

test('#189 卡密段：状态 / 积分 / 兑换时间 / 兑换人 / Key 尾号逐字段解析', () => {
  const order = parseTrailOrder(fixtures.trailOrderFulfilled)
  assert.ok(order !== null)
  assert.equal(order.status, 'fulfilled')
  assert.equal(order.amountYuan, 29.9)
  assert.equal(order.paidAt, fixtures.trailOrderFulfilled.paid_at)
  assert.ok(order.card !== null)
  assert.equal(order.card.cardNo, 'MUSE-3CYP-5NA3-AHSE-A3SR')
  assert.equal(order.card.points, 3000)
  assert.equal(order.card.state, 'redeemed')
  assert.equal(order.card.redeemedAt, fixtures.trailOrderFulfilled.card.redeemed_at)
  assert.equal(order.card.redeemedByCustomerId, fixtures.TRAIL_CUSTOMER_ID)
  assert.equal(order.card.redeemedKeyTail, '013812')
  assert.equal(order.timeline.length, 5)
  assert.deepEqual(
    order.timeline.map((item) => item.event),
    ['order_created', 'notify_ok', 'paid_confirmed', 'card_issued', 'card_redeemed']
  )
})

test('#189 未兑换的卡：state=issued、redeemed_at 为 null 不报错', () => {
  const parsed = parseCardTrail(fixtures.cardTrailUnredeemed)
  assert.ok(parsed !== null)
  assert.equal(parsed.cardNo, 'MUSE-9TTM-1ZQK-4RBV-H7ND')
  assert.equal(parsed.redemption.redeemed, false)
  assert.ok(parsed.purchase !== null)
  assert.ok(parsed.purchase.card !== null)
  assert.equal(parsed.purchase.card.state, 'issued')
  assert.equal(parsed.purchase.card.redeemedAt, null)
})

test('#189 卡密溯源：兑换信息（时间 / 积分 / Key 尾号 / 是否本人）', () => {
  const parsed = parseCardTrail(fixtures.cardTrailRedeemed)
  assert.ok(parsed !== null)
  assert.equal(parsed.redemption.redeemed, true)
  assert.equal(parsed.redemption.at, fixtures.cardTrailRedeemed.redemption.at)
  assert.equal(parsed.redemption.points, 3000)
  assert.equal(parsed.redemption.keyTail, '013812')
  assert.equal(parsed.redemption.byMe, true)
  assert.equal(parsed.redemption.source, 'in_app')
  assert.ok(parsed.purchase !== null)
  assert.equal(parsed.purchase.outTradeNo, fixtures.trailOrderFulfilled.out_trade_no)
})

test('#189 未知事件不许被白名单丢掉：原样保留 event 与 text', () => {
  const order = parseTrailOrder(fixtures.trailOrderLong)
  assert.ok(order !== null)
  const names = order.timeline.map((item) => item.event)
  assert.equal(order.timeline.length, 9)
  assert.ok(names.includes('order_expired'))
  assert.ok(names.includes('late_paid_recovered'))
  assert.ok(names.includes('amount_reconciled'), 'App 不认识的新事件也必须展示')
  const unknown = order.timeline.find((item) => item.event === 'amount_reconciled')
  assert.equal(unknown.text, '对账完成，金额一致')
  // 未知事件的色调不能借用 success / danger 的强语义
  assert.equal(eventToneOf('amount_reconciled'), 'muted')
  assert.equal(eventToneOf('paid_confirmed'), 'success')
  assert.equal(eventToneOf('order_expired'), 'muted')
  assert.equal(eventToneOf('notify_bad_amount'), 'danger')
  assert.equal(eventToneOf('order_created'), 'pending')
})

test('#189 detail.backfilled=true 要标成「时间不精确」（历史补录）', () => {
  const order = parseTrailOrder(fixtures.trailOrderLong)
  assert.ok(order !== null)
  const backfilled = order.timeline.filter((item) => item.backfilled)
  assert.equal(backfilled.length, 3)
  assert.deepEqual(backfilled.map((item) => item.event), ['amount_reconciled', 'notify_ok', 'paid_confirmed'])
  const exact = order.timeline.filter((item) => !item.backfilled)
  assert.equal(exact.length, 6)
})

test('#189 空列表不是错误：total=0 且 orders=[]', () => {
  const page = parseTrailPage(fixtures.trailPageEmpty)
  assert.ok(page !== null)
  assert.equal(page.total, 0)
  assert.deepEqual(page.orders, [])
  assert.equal(hasMoreTrail(page), false)
})

test('#189 坏数据不崩：orders 不是数组按空页、非对象条目丢弃、字符串数字能读', () => {
  assert.equal(parseTrailPage({ orders: 'nope' }).orders.length, 0)
  const page = parseTrailPage({
    customer_id: 10,
    orders: [
      null,
      'x',
      { out_trade_no: 'A', status: 'FULFILLED', amount_yuan: '29.90', created_at: '1795051980' },
    ],
  })
  assert.equal(page.orders.length, 1, '非对象条目要丢掉而不是撑爆界面')
  assert.equal(page.orders[0].amountYuan, 29.9)
  assert.equal(page.orders[0].createdAt, 1795051980)
  assert.equal(page.orders[0].timeline.length, 0, '没有 timeline 字段时是空数组，不是 undefined')
  assert.equal(page.orders[0].statusText, '', 'status_text 缺失时留空，界面自己回落到 i18n 文案')
  assert.equal(page.total, 1, 'total 缺失时退化成这一页的条数')
})

test('#189 毫秒时间戳也能读（有的接口按毫秒给）', () => {
  const order = parseTrailOrder({ out_trade_no: 'A', status: 'PAID', created_at: 1795051980000, paid_at: 1795052040000 })
  assert.ok(order !== null)
  assert.equal(order.createdAt, 1795051980)
  assert.equal(order.paidAt, 1795052040)
})

test('#189 根不是对象 → null（调用方按坏响应报错，而不是显示空列表）', () => {
  assert.equal(parseTrailPage(null), null)
  assert.equal(parseTrailPage('[]'), null)
  assert.equal(parseTrailPage(42), null)
  assert.equal(parseTrailOrder([]), null)
  assert.equal(parseCardTrail(undefined), null)
})

test('#189 分页：offset + 本页条数 < total 才还有下一页', () => {
  assert.equal(hasMoreTrail({ total: 6, offset: 0, orders: new Array(6).fill({}) }), false)
  assert.equal(hasMoreTrail({ total: 21, offset: 0, orders: new Array(20).fill({}) }), true)
  assert.equal(hasMoreTrail({ total: 21, offset: 20, orders: new Array(1).fill({}) }), false)
})

// ------------------------------------------------------------------ 请求形状

test('#189 拉一页：URL 只有 limit/offset/status，Key 只在请求头', async () => {
  const { transport, calls } = makeTransport(json(200, fixtures.trailPage))
  const page = await fetchTrailVia({ apiKey: ` ${KEY} ` }, transport, BASE)
  assert.equal(page.orders.length, 6)
  assert.equal(calls.length, 1)
  const request = calls[0]
  assert.equal(request.method, 'GET')
  assert.equal(request.followRedirects, false)
  assert.ok(request.timeoutMs > 0)
  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, `${BASE}/api/trail`)
  assert.equal(url.searchParams.get('limit'), '20')
  assert.equal(url.searchParams.get('offset'), '0')
  assert.equal(url.searchParams.get('status'), null, '不筛选就不加 status 参数')
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`, '两头的空格要去掉')
  assert.ok(!request.url.includes(KEY), 'Key 不许出现在 URL 里')
})

test('#189 带 status 筛选 / 第二页时参数正确（status 用小写契约值）', async () => {
  const { transport, calls } = makeTransport(json(200, fixtures.trailPageEmpty))
  await fetchTrailVia({ apiKey: KEY, limit: 999, offset: 40, status: 'fulfilled' }, transport, BASE)
  const url = new URL(calls[0].url)
  assert.equal(url.searchParams.get('limit'), '50', '上限夹到 50')
  assert.equal(url.searchParams.get('offset'), '40')
  assert.equal(url.searchParams.get('status'), 'fulfilled')
})

test('#189 base 末尾多写斜杠也不能拼出双斜杠路径', async () => {
  const { transport, calls } = makeTransport(json(200, fixtures.trailPageEmpty))
  await fetchTrailVia({ apiKey: KEY }, transport, `${BASE}///`)
  assert.equal(new URL(calls[0].url).pathname, '/api/trail')
})

test('#189 单号查询：out_trade_no 进 query，返回单个订单', async () => {
  const { transport, calls } = makeTransport(json(200, fixtures.orderTrailResponse))
  const order = await fetchOrderTrailVia(
    { apiKey: KEY, outTradeNo: fixtures.trailOrderFulfilled.out_trade_no },
    transport,
    BASE
  )
  assert.equal(order.outTradeNo, fixtures.trailOrderFulfilled.out_trade_no)
  assert.equal(order.timeline.length, 5)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/order/trail')
  assert.equal(url.searchParams.get('out_trade_no'), fixtures.trailOrderFulfilled.out_trade_no)
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`)
})

test('#189 卡密溯源查询：card_no 进 query', async () => {
  const { transport, calls } = makeTransport(json(200, fixtures.cardTrailRedeemed))
  const trail = await fetchCardTrailVia(
    { apiKey: KEY, cardNo: fixtures.cardTrailRedeemed.card_no },
    transport,
    BASE
  )
  assert.equal(trail.cardNo, fixtures.cardTrailRedeemed.card_no)
  assert.equal(trail.redemption.redeemed, true)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/api/card/trail')
  assert.equal(url.searchParams.get('card_no'), fixtures.cardTrailRedeemed.card_no)
})

test('#189 没填 Key：一条请求都不发，直接报 keyMissing', async () => {
  const { transport, calls } = makeTransport()
  await assert.rejects(
    () => fetchTrailVia({ apiKey: '   ' }, transport, BASE),
    (error) => {
      assertTrailError(error, 'keyMissing')
      assert.equal(error.needsKey, true)
      assert.equal(error.retryable, false)
      return true
    }
  )
  assert.equal(calls.length, 0, '没 Key 还发请求 = 必然白跑一次往返')
})

// ------------------------------------------------------------------ 错误映射（2026-11-19 实测形状）

test('#189 401 → unauthorized：要重新填 Key，重试没有意义', async () => {
  const { transport, calls } = makeTransport(json(401, fixtures.errorBodies.unauthorized))
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, transport, BASE),
    (error) => {
      assertTrailError(error, 'unauthorized')
      assert.equal(error.needsKey, true)
      assert.equal(error.retryable, false)
      assert.equal(error.status, 401)
      return true
    }
  )
  assert.equal(calls.length, 1, '401 不重试')
})

test('#189 403 与 401 同样处理（都是「这把 Key 看不到」）', async () => {
  const { transport } = makeTransport(json(403, { code: 'FORBIDDEN' }))
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, transport, BASE),
    (error) => {
      assertTrailError(error, 'unauthorized')
      return true
    }
  )
})

test('#189 404 → notFound：不区分「单号不存在」与「不是你的单」', async () => {
  const { transport } = makeTransport(json(404, fixtures.errorBodies.orderNotFound))
  await assert.rejects(
    () => fetchOrderTrailVia({ apiKey: KEY, outTradeNo: 'CP20260101000000000' }, transport, BASE),
    (error) => {
      assertTrailError(error, 'notFound')
      assert.equal(error.status, 404)
      assert.equal(error.needsKey, false)
      return true
    }
  )
})

test('#189 503 UNAVAILABLE：自动重试 1 次，两次都失败才报 unavailable（不能显示成空列表）', async () => {
  const { transport, calls } = makeTransport(
    json(503, fixtures.unavailableBody),
    json(503, fixtures.unavailableBody)
  )
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, transport, BASE),
    (error) => {
      assertTrailError(error, 'unavailable')
      assert.equal(error.retryable, true)
      return true
    }
  )
  assert.equal(calls.length, 2, '503 属于「临时」，必须自己再试一次')
  assert.equal(calls[0].url, calls[1].url, '重试打的是同一个地址')
})

test('#189 503 第一次失败、重试成功 → 正常返回数据（用户看不到抖动）', async () => {
  const { transport, calls } = makeTransport(
    json(503, fixtures.unavailableBody),
    json(200, fixtures.trailPage)
  )
  const page = await fetchTrailVia({ apiKey: KEY }, transport, BASE)
  assert.equal(page.orders.length, 6)
  assert.equal(calls.length, 2)
})

test('#189 其它 5xx → server（可重试，但不是 unavailable 这种「服务在维护」口径）', async () => {
  const { transport, calls } = makeTransport(json(500, { code: 'INTERNAL' }))
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, transport, BASE),
    (error) => {
      assertTrailError(error, 'server')
      assert.equal(error.retryable, true)
      return true
    }
  )
  assert.equal(calls.length, 1, '5xx 只在界面上让用户手动重试，不自动重放')
})

test('#189 429 → rateLimited（可重试）', async () => {
  const { transport } = makeTransport(json(429, { code: 'RATE_LIMITED' }))
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, transport, BASE),
    (error) => {
      assertTrailError(error, 'rateLimited')
      assert.equal(error.retryable, true)
      return true
    }
  )
})

test('#189 超时 / 连不上分别映射（提示不一样：一个查网络，一个再等等）', async () => {
  const timeout = makeTransport({ kind: 'timeout' })
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, timeout.transport, BASE),
    (error) => {
      assertTrailError(error, 'timeout')
      assert.equal(error.retryable, true)
      return true
    }
  )
  const network = makeTransport({ kind: 'network' })
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, network.transport, BASE),
    (error) => {
      assertTrailError(error, 'network')
      assert.equal(error.retryable, true)
      return true
    }
  )
})

test('#189 2xx 但内容不是 JSON / 结构不对 → badResponse（不能当成空列表）', async () => {
  const broken = makeTransport({ kind: 'response', status: 200, text: '<html>502</html>' })
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, broken.transport, BASE),
    (error) => {
      assertTrailError(error, 'badResponse')
      return true
    }
  )
  const notObject = makeTransport(json(200, ['nope']))
  await assert.rejects(
    () => fetchTrailVia({ apiKey: KEY }, notObject.transport, BASE),
    (error) => {
      assertTrailError(error, 'badResponse')
      return true
    }
  )
})

test('#189 400 BAD_INPUT（缺参数）→ rejected，不是 Key 问题', async () => {
  const { transport } = makeTransport(json(400, fixtures.errorBodies.badInput))
  await assert.rejects(
    () => fetchOrderTrailVia({ apiKey: KEY, outTradeNo: '' }, transport, BASE),
    (error) => {
      assertTrailError(error, 'rejected')
      assert.equal(error.needsKey, false)
      return true
    }
  )
})

test('#189 错误对象不泄漏 Key 与卡号（日志里最常见的事故）', async () => {
  const { transport } = makeTransport(json(401, fixtures.errorBodies.unauthorized))
  await assert.rejects(
    () => fetchTrailVia({ apiKey: `${KEY}` }, transport, BASE),
    (error) => {
      const dump = `${error.message} ${error.code ?? ''} ${error.stack ?? ''}`
      assert.ok(!dump.includes(KEY), '错误信息里出现了完整 Key')
      assert.ok(!dump.includes('MUSE-3CYP-5NA3-AHSE-A3SR'), '错误信息里出现了完整卡号')
      return true
    }
  )
  assert.equal(typeof TrailError, 'function')
})

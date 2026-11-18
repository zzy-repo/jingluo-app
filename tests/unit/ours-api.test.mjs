// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 「我们的渠道」卡密服务契约层单测（Issue #7）：只 import src/services/ours/api.ts，
// 用假 transport 断言「发了什么请求、怎么解释响应」，完全不碰 DOM / Capacitor / 网络。
//
//   cd /root/deepseek-app && node tests/unit/ours-api.test.mjs
//
// 覆盖（对应任务书验收）：
//   [1] 余额查询：Authorization: Bearer，URL 里没有 Key、没有 query
//   [2] balance=0（无 Authorization 时服务端 200 + balance:0）不是错误，不提示额度不足
//   [3] 402/401 也只算「查不到额度」；非法 JSON / 超时 / 断网分别有状态
//   [4] 兑换：request_id 复用、IDEMPOTENT 按成功、synced/pending/no_downstream 文案
//   [5] 错误码映射 400/401/403/404/409/429
//   [6] 建单：禁跟随重定向、只认 https 的 Location/pay_url，pay_url=null → 购买不可用
//   [7] 查单：缺 order_token 一次都不发；fulfilled 只有卡密尾 4 位
//   [8] 轮询：2s 间隔、总时长 ≤60s、终态即停
//   [9] 任何返回值/文案里都不出现完整 Key 与完整卡密；整个流程不写 console
import {
  createOrder,
  createRequestId,
  fetchBalance,
  fetchPlans,
  formatPlanPrice,
  formatQuota,
  isOpenableCheckout,
  maskCard,
  maskKey,
  ORDER_STATUS_KEYS,
  pollOrder,
  queryOrder,
  redeemCard,
  REDEEM_SYNC_KEYS,
  OURS_API_BASE,
} from '../../src/services/ours/api.ts'
import { zh } from '../../src/i18n/zh.ts'

const KEY = 'sk-ours-unit-test-654321'
const KEY_TAIL = KEY.slice(-6)
const CARD = 'CARD-8f3a9b7c2d-4471'
const CARD_TAIL = CARD.slice(-4)

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${label} = ${a}`)
  } else {
    bad(`${label}：期望 ${b}，实际 ${a}`)
  }
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))

/** 顺序回放的假 transport：每次调用记下来，响应可以是对象，也可以是函数 */
const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}
const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })

// ---------------------------------------------------------------- [1][2][3] 余额
console.log('\n[1] 余额查询：Bearer 头、URL 无 Key 无 query')
{
  const { transport, calls } = fakeTransport([json(200, { api_key: KEY, balance: 2000000 })])
  const state = await fetchBalance(KEY, transport)
  eq(calls.length, 1, '请求次数')
  const request = calls[0]
  eq(request.method, 'GET', 'method')
  eq(request.url, `${OURS_API_BASE}/api/balance`, 'url（不带 query）')
  truthy(!request.url.includes(KEY), 'URL 里没有完整 Key')
  truthy(!request.url.includes('?'), 'URL 没有 query 串')
  eq(request.headers.Authorization, `Bearer ${KEY}`, 'Authorization 头')
  eq(state.status, 'success', '状态')
  eq(state.balance, 2000000, '余额')
  eq(state.keyTail, `••••${KEY_TAIL}`, 'Key 只露尾 6 位')
  truthy(!JSON.stringify(state).includes(KEY), '返回结果不含完整 Key（响应里的 api_key 被丢弃）')
  truthy(!('apiKey' in state), '返回结果没有 apiKey 字段')
}

console.log('\n[2] balance=0：不是错误、不提示额度不足')
{
  const { transport } = fakeTransport([json(200, { user_id: 0, balance: 0 })])
  const state = await fetchBalance(KEY, transport)
  eq(state.status, 'unknown-balance', '状态')
  eq(zh.oursBalanceUnknown, '暂未查询到该 Key 的兑换额度（或额度为 0）', '文案')
  truthy(!/不足/.test(zh.oursBalanceUnknown), '文案里没有「额度不足」')
  truthy(!/无效/.test(zh.oursBalanceUnknown), '文案里没有「无效」')
}

console.log('\n[3] 401/403/非法 JSON / 超时 / 断网')
{
  const unauthorized = await fetchBalance(KEY, fakeTransport([json(401, { code: 'UNAUTHORIZED' })]).transport)
  eq(unauthorized.status, 'unknown-balance', '401 → unknown-balance（不把 Key 判死）')
  const forbidden = await fetchBalance(KEY, fakeTransport([json(403, { code: 'FORBIDDEN' })]).transport)
  eq(forbidden.status, 'unknown-balance', '403 → unknown-balance')
  const invalid = await fetchBalance(KEY, fakeTransport([{ kind: 'response', status: 200, text: '<html>' }]).transport)
  eq(invalid.status, 'invalid-json', '非法 JSON → invalid-json')
  const timeout = await fetchBalance(KEY, fakeTransport([{ kind: 'timeout' }]).transport)
  eq(timeout.status, 'timeout', '超时 → timeout')
  const network = await fetchBalance(KEY, fakeTransport([{ kind: 'network' }]).transport)
  eq(network.status, 'network', '断网 → network')
  const empty = await fetchBalance('   ', fakeTransport([json(200, { balance: 1 })]).transport)
  eq(empty.status, 'idle', '没填 Key → idle（一次都不发）')
}

// ---------------------------------------------------------------- 套餐
console.log('\n[4] 套餐：价格/额度取服务端')
{
  const plansBody = {
    plans: [
      { id: 'p1', name: '入门包 100万 token', price: 9.9, quota: 1000000, currency: 'CNY', enabled: true },
      { id: 'p2', name: '标准包 500万 token', price: 39.0, quota: 5000000, currency: 'CNY', enabled: true },
      { id: 'p3', name: '停售', price: 1, quota: 1, currency: 'CNY', enabled: false },
    ],
  }
  const { transport, calls } = fakeTransport([json(200, plansBody)])
  const state = await fetchPlans(transport)
  eq(state.status, 'success', '状态')
  eq(state.plans.length, 2, 'enabled=false 的套餐被过滤')
  eq(formatPlanPrice(state.plans[0]), '¥9.90', '价格文案')
  eq(formatQuota(state.plans[0].quota), '100万', '额度文案（100 万）')
  eq(formatQuota(state.plans[1].quota), '500万', '额度文案（500 万）')
  eq(formatQuota(100000000), '1亿', '额度文案（亿）')
  eq(calls[0].url, `${OURS_API_BASE}/api/plans`, '套餐 URL')
  const broken = await fetchPlans(fakeTransport([{ kind: 'response', status: 200, text: 'nope' }]).transport)
  eq(broken.status, 'error', '非法 JSON → error')
}

// ---------------------------------------------------------------- 兑换
console.log('\n[5] 兑换：请求体、request_id 复用、IDEMPOTENT')
{
  const { transport, calls } = fakeTransport([
    json(200, { ok: true, card_no: CARD, quota: 1000000, api_key: KEY, balance_after: 3000000, sync: 'synced' }),
  ])
  const requestId = createRequestId(1700000000000, 0.5)
  const result = await redeemCard({ cardNo: CARD, apiKey: KEY, requestId }, transport)
  const request = calls[0]
  eq(request.method, 'POST', 'method')
  eq(request.url, `${OURS_API_BASE}/api/redeem`, 'URL（Key 不进 query）')
  const body = JSON.parse(request.body)
  eq(Object.keys(body).sort(), ['api_key', 'card_no', 'request_id'], '请求体字段')
  eq(body.request_id, requestId, 'request_id 原样带上')
  eq(result.kind, 'success', '成功')
  eq(zh[result.messageKey], '到账成功', 'synced 文案')
  eq(result.balanceAfter, 3000000, 'balance_after')
  truthy(!JSON.stringify(result).includes(KEY), '结果不含完整 Key')
  truthy(!JSON.stringify(result).includes(CARD), '结果不含完整卡密')

  // 幂等：同一 request_id 再提交，服务端 200 + IDEMPOTENT
  const idempotent = await redeemCard(
    { cardNo: CARD, apiKey: KEY, requestId },
    fakeTransport([json(200, { code: 'IDEMPOTENT', message: 'already', request_id: 'r1' })]).transport
  )
  eq(idempotent.kind, 'success', 'IDEMPOTENT 按成功处理')
  eq(idempotent.idempotent, true, 'idempotent 标记')
  eq(zh[idempotent.messageKey], '该卡密已兑换过，本次按成功处理', '幂等文案')
}

console.log('\n[6] 兑换：pending / no_downstream 文案')
{
  eq(
    zh[REDEEM_SYNC_KEYS.pending],
    '到账成功，稍后自动同步',
    'pending → 到账成功，稍后自动同步'
  )
  eq(zh[REDEEM_SYNC_KEYS.no_downstream], '已在本站登记额度', 'no_downstream 只写本站登记')
  truthy(!/到账/.test(zh[REDEEM_SYNC_KEYS.no_downstream]), 'no_downstream 不声称下游到账')
  const pending = await redeemCard(
    { cardNo: CARD, apiKey: KEY, requestId: 'r-p' },
    fakeTransport([json(200, { ok: true, sync: 'pending', balance_after: 1 })]).transport
  )
  eq(pending.sync, 'pending', 'sync=pending')
  eq(zh[pending.messageKey], '到账成功，稍后自动同步', 'pending 文案落地')
  const noDownstream = await redeemCard(
    { cardNo: CARD, apiKey: KEY, requestId: 'r-n' },
    fakeTransport([json(200, { ok: true, sync: 'no_downstream' })]).transport
  )
  eq(noDownstream.sync, 'no_downstream', 'sync=no_downstream')
  eq(zh[noDownstream.messageKey], '已在本站登记额度', 'no_downstream 文案落地')
}

console.log('\n[7] 兑换：错误码映射')
{
  const cases = [
    [{ status: 400, code: 'BAD_JSON' }, 400, '请求格式有误，请重试'],
    [{ status: 400, code: 'API_KEY_INVALID' }, 400, '服务 Key 无效，请重新填写'],
    [{ status: 401, code: 'UNAUTHORIZED' }, 401, '鉴权失败，请重新填写服务 Key 后再试'],
    [{ status: 403, code: 'FORBIDDEN' }, 403, '当前操作没有权限'],
    [{ status: 404, code: 'CARD_NOT_FOUND' }, 404, '卡密不存在，请核对后重试'],
    [{ status: 409, code: 'CARD_ALREADY_USED' }, 409, '该卡密已被使用'],
    [{ status: 429, code: 'RATE_LIMITED' }, 429, '请求过于频繁，请稍后重试'],
  ]
  for (const [spec, status, text] of cases) {
    const result = await redeemCard(
      { cardNo: CARD, apiKey: KEY, requestId: 'r-e' },
      fakeTransport([json(status, { code: spec.code, message: 'server', request_id: 'rid' })]).transport
    )
    eq(result.kind, 'error', `${spec.code} 仍是错误`)
    eq(zh[result.messageKey], text, `${spec.code} → ${text}`)
    truthy(!JSON.stringify(result).includes(CARD), `${spec.code} 结果不含完整卡密`)
    truthy(!JSON.stringify(result).includes('rid'), `${spec.code} 不暴露 request_id`)
  }
  const blankCard = await (async () => {
    const { transport, calls } = fakeTransport([json(200, { ok: true })])
    const result = await redeemCard({ cardNo: '  ', apiKey: KEY, requestId: 'r-b' }, transport)
    return { result, calls }
  })()
  eq(blankCard.result.messageKey, 'oursErrCardMissing', '空卡密直接拒绝')
  eq(blankCard.calls.length, 0, '空卡密一次请求都不发')
}

// ---------------------------------------------------------------- 建单 / 查单 / 轮询
console.log('\n[8] 建单：禁跟随重定向、只认 https、pay_url=null 不可支付')
{
  const redirect = await (async () => {
    const { transport, calls } = fakeTransport([
      { kind: 'response', status: 302, text: '', location: 'https://pay.example.com/checkout/abc' },
    ])
    const result = await createOrder('p1', transport)
    return { result, calls }
  })()
  eq(redirect.calls.length, 1, '302 只请求一次（没有跟随）')
  eq(redirect.calls[0].followRedirects, false, 'followRedirects=false')
  eq(redirect.result.payUrl, 'https://pay.example.com/checkout/abc', '只取 Location')
  truthy(!redirect.calls[0].url.includes(KEY), '建单 URL 不含 Key')

  const noGateway = await (async () => {
    const { transport } = fakeTransport([
      json(200, { out_trade_no: 'O20261118001', order_token: 'tok-abc', pay_url: null }),
    ])
    return createOrder('p1', transport)
  })()
  eq(noGateway.kind, 'ok', '网关未配置也返回 ok')
  eq(noGateway.orderToken, 'tok-abc', 'order_token 必须保留')
  eq(noGateway.payUrl, null, 'pay_url=null → 购买按钮不可用')
  eq(isOpenableCheckout('http://pay.example.com/x'), false, 'http 收银台一律不认')
  eq(isOpenableCheckout('https://pay.example.com/x'), true, 'https 收银台可用')
}

console.log('\n[9] 查单：缺 token 不发请求；fulfilled 只留卡密尾 4 位')
{
  const missing = await (async () => {
    const { transport, calls } = fakeTransport([json(200, {})])
    const result = await queryOrder({ outTradeNo: 'O1', orderToken: '' }, transport)
    return { result, calls }
  })()
  eq(missing.result.messageKey, 'oursErrOrderTokenMissing', '缺 order_token 直接报错')
  eq(missing.calls.length, 0, '缺 order_token 一次请求都不发')

  const { transport, calls } = fakeTransport([
    json(200, {
      out_trade_no: 'O20261118001',
      status: 'fulfilled',
      amount_fen: 990,
      card_no: CARD,
      expire_at: '2026-11-18T15:00:00+08:00',
      message: 'ok',
    }),
  ])
  const result = await queryOrder({ outTradeNo: 'O20261118001', orderToken: 'tok-abc' }, transport)
  eq(result.kind, 'ok', '查单成功')
  eq(result.order.status, 'fulfilled', '状态')
  eq(result.order.cardTail, `••••${CARD_TAIL}`, '卡密只留尾 4 位')
  truthy(!JSON.stringify(result).includes(CARD), '结果不含完整卡密')
  truthy(calls[0].url.includes('out_trade_no=O20261118001'), '查单带 out_trade_no')
  truthy(calls[0].url.includes('order_token=tok-abc'), '查单带 order_token')
  truthy(!calls[0].url.includes(KEY), '查单 URL 不含服务 Key')

  const notFound = await queryOrder(
    { outTradeNo: 'O1', orderToken: 'tok' },
    fakeTransport([json(404, { code: 'ORDER_NOT_FOUND', message: '订单不存在', request_id: 'r' })]).transport
  )
  eq(zh[notFound.messageKey], '订单不存在', 'ORDER_NOT_FOUND → 订单不存在')
  eq(zh[ORDER_STATUS_KEYS.pending], '待支付', 'pending 文案')
  eq(zh[ORDER_STATUS_KEYS.fulfilled], '已发放卡密，尾号 {tail}', 'fulfilled 文案模板')
}

console.log('\n[10] 轮询：2s 间隔、≤60s、终态即停、无 token 不轮询')
{
  const clock = { t: 0 }
  const intervals = []
  const sleep = async (ms) => {
    intervals.push(ms)
    clock.t += ms
  }
  const statuses = ['pending', 'pending', 'paid', 'fulfilled']
  const { transport, calls } = fakeTransport(
    statuses.map((status) =>
      json(200, { out_trade_no: 'O1', status, amount_fen: 990, card_no: status === 'fulfilled' ? CARD : '' })
    )
  )
  const result = await pollOrder({
    outTradeNo: 'O1',
    orderToken: 'tok',
    transport,
    sleep,
    now: () => clock.t,
  })
  eq(result.kind, 'ok', '轮询到终态')
  eq(result.attempts, 4, '轮询次数')
  eq(intervals, [2000, 2000, 2000], '每次间隔 2000ms')
  eq(calls.length, 4, '查单次数与间隔一致')
  eq(result.order.status, 'fulfilled', '终态状态')
  truthy(clock.t <= 60000, '总耗时 ≤60s')

  const stuckClock = { t: 0 }
  const stuckIntervals = []
  const stuck = await pollOrder({
    outTradeNo: 'O1',
    orderToken: 'tok',
    transport: fakeTransport([
      json(200, { out_trade_no: 'O1', status: 'pending', amount_fen: 990, card_no: '' }),
    ]).transport,
    sleep: async (ms) => {
      stuckIntervals.push(ms)
      stuckClock.t += ms
    },
    now: () => stuckClock.t,
  })
  eq(stuck.kind, 'timeout', '一直 pending → 到 60s 停')
  truthy(stuckClock.t <= 60000, '超时上限 ≤60s')
  eq(stuck.attempts, 31, '60s / 2s → 31 次（首查 + 30 次间隔）')
  truthy(stuckIntervals.every((ms) => ms === 2000), '间隔恒为 2000ms')

  const noToken = await (async () => {
    const { transport: t2, calls: c2 } = fakeTransport([json(200, {})])
    const out = await pollOrder({ outTradeNo: 'O1', orderToken: '', transport: t2 })
    return { out, calls: c2 }
  })()
  eq(noToken.out.kind, 'error', '无 token 直接失败')
  eq(noToken.calls.length, 0, '无 token 一次都不轮询')
}

// ---------------------------------------------------------------- 脱敏 / 不写日志
console.log('\n[11] 脱敏与「不写 console」')
{
  eq(maskKey(KEY), `••••${KEY_TAIL}`, 'maskKey 尾 6 位')
  eq(maskKey('short'), '••••', '太短的 Key 全部遮掉')
  eq(maskCard(CARD), `••••${CARD_TAIL}`, 'maskCard 尾 4 位')

  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  const leaked = []
  const spy = (...args) => leaked.push(args.map((arg) => String(arg)).join(' '))
  console.log = spy
  console.warn = spy
  console.error = spy
  console.info = spy
  try {
    await fetchBalance(KEY, fakeTransport([json(200, { api_key: KEY, balance: 7 })]).transport)
    await redeemCard(
      { cardNo: CARD, apiKey: KEY, requestId: 'r-log' },
      fakeTransport([json(200, { ok: true, sync: 'pending' })]).transport
    )
    await createOrder('p1', fakeTransport([json(200, { out_trade_no: 'O1', order_token: 'tok' })]).transport)
    await queryOrder(
      { outTradeNo: 'O1', orderToken: 'tok' },
      fakeTransport([json(200, { out_trade_no: 'O1', status: 'pending', amount_fen: 1, card_no: '' })]).transport
    )
  } finally {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
    console.info = originals.info
  }
  eq(leaked.length, 0, '整条链路一条 console 都没写')
  truthy(!leaked.join('\n').includes(KEY), '日志里没有完整 Key')
  truthy(!leaked.join('\n').includes(CARD), '日志里没有完整卡密')
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（共 ${checks.n} 项检查）`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
console.log(`✓ 全部通过（${checks.n} 项检查）`)

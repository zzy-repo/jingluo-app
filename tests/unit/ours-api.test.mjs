// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 「我们的渠道」卡密 / 支付服务（https://apia.ecsafe.cn）契约层单测（Issue #21）。
// 只 import src/services/ours/api.ts，用假 transport 断言「发了什么请求、怎么解释响应」，
// 完全不碰 DOM / Capacitor / 网络。
//
//   cd /root/worktrees/deepseek-pay-integration && node tests/unit/ours-api.test.mjs
//
// 覆盖（对应任务书验收）：
//   [1] 套餐：价格与积分全部取服务端（p1 = ¥3.00 / 300 积分），不硬编码；渲染模板可拼
//   [2] 积分只显示积分（#75）：额度文案不再做 points→人民币折算，zh/en 均无「约可消费 / about ¥」
//   [3] Key 校验：只回答有效/无效，不含任何额度；URL 不带 Key，走 Authorization 头
//   [4] /buy：GET、只发一次、followRedirects=false；从 302 的 Location（return_url）里取 order_token
//   [5] /buy 的失败面：http 收银台不认、缺令牌直接说清楚、网页版兜底（跟随后的最终 URL）
//   [6] 查单：fulfilled 才有卡密；展示只留尾 4 位，完整卡密只留内存字段 cardNo
//   [7] 轮询状态机：2s 间隔、≤60s、终态即停、paid 继续轮、超时不重复下单、可取消、无 token 不轮询
//   [8] 兑换：request_id 固定用卡密；202 CREDIT_PENDING 是「处理中」不是失败
//   [9] 兑换错误码：API_KEY_INVALID / CARD_ALREADY_USED / CARD_NOT_FOUND / VERIFY_UNAVAILABLE / RATE_LIMITED
//   [10] 隐私：整条链路一条 console 都没有；文案/错误里没有完整 Key 与完整卡密
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

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const oursApi = await import('../../src/services/ours/api.ts')
const {
  fetchPlans,
  formatPlanMeta,
  formatPlanPrice,
  formatPoints,
  isOpenableCheckout,
  maskCard,
  maskKey,
  ORDER_STATUS_KEYS,
  OURS_API_BASE,
  OURS_PAYMENT_OPEN,
  parseCheckoutTarget,
  pollOrder,
  probeApiKey,
  queryOrder,
  redeemCard,
  requestIdForCard,
  startCheckout,
} = await import('../../src/services/ours/api.ts')

/** 与 i18n/index.ts 的 createTranslate 同一套占位符替换（只取 zh 文案，避开浏览器 store） */
const translate = (key, params) =>
  zh[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
    params?.[name] === undefined ? placeholder : String(params[name])
  )

const KEY = 'sk-ours-unit-test-654321'
const KEY_TAIL = KEY.slice(-6)
const CARD = 'CARD-8f3a9b7c2d-4471'
const CARD_TAIL = CARD.slice(-4)
const OUT_TRADE_NO = 'CP2026111816102637F0F8AA'
const ORDER_TOKEN = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'
/** 实测的 /buy 302 Location（2026-11-18，真实收银台地址结构） */
const REAL_LOCATION = `https://pay.xiaodouap.cn/submit.php?pid=10268375&type=alipay&out_trade_no=${OUT_TRADE_NO}&notify_url=https%3A%2F%2Fapia.ecsafe.cn%2Fnotify&return_url=https%3A%2F%2Fapia.ecsafe.cn%2Freturn%3Fno%3D${OUT_TRADE_NO}%26order_token%3D${ORDER_TOKEN}&name=%E5%85%A5%E9%97%A8%E5%8C%85&money=3.00&sitename=muse2api&sign=da74773b105616c2eeed1821d788ab5b&sign_type=MD5`

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

// ---------------------------------------------------------------- [1] 套餐
console.log('\n[1] 套餐：价格与积分取服务端，渲染模板可拼')
{
  const plansBody = {
    plans: [
      { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true },
      { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
      { id: 'p3', name: '停售', price: 1, points: 100, currency: 'CNY', enabled: false },
    ],
  }
  const { transport, calls } = fakeTransport([json(200, plansBody)])
  const state = await fetchPlans(transport)
  eq(calls.length, 1, '只请求一次')
  eq(calls[0].method, 'GET', 'method')
  eq(calls[0].url, `${OURS_API_BASE}/api/plans`, '套餐 URL')
  eq(OURS_API_BASE, 'https://apia.ecsafe.cn', '卡密服务走 HTTPS')
  eq(state.status, 'success', '状态')
  eq(state.plans.length, 2, 'enabled=false 的套餐被过滤')
  eq(state.plans[0].price, 3, '价格来自服务端（p1 = 3）')
  eq(state.plans[0].points, 300, '积分来自服务端（p1 = 300）')
  eq(formatPlanPrice(state.plans[0]), '¥3.00', '价格文案')
  eq(formatPoints(state.plans[0].points, zh.oursPointsUnit), '300 积分', '积分文案')
  // 套餐行渲染就是这一个纯函数（界面直接用它，不再拼 i18n 模板）
  eq(formatPlanMeta(state.plans[0], zh.oursPointsUnit), '¥3.00 · 300 积分', '套餐行渲染文案')
  const broken = await fetchPlans(fakeTransport([{ kind: 'response', status: 200, text: 'nope' }]).transport)
  eq(broken.status, 'error', '非法 JSON → error')
  eq(broken.messageKey, 'oursPlansFailed', '非法 JSON 文案 key')
  const down = await fetchPlans(fakeTransport([{ kind: 'network' }]).transport)
  eq(zh[down.messageKey], '网络不可用，请稍后重试', '断网文案')
  eq(OURS_PAYMENT_OPEN, true, '购买入口已放开（服务端价格与套餐一致）')
}

// ---------------------------------------------------------------- [2] 额度只显示积分
console.log('\n[2] 额度只显示积分：不做 points → 人民币折算（#75）')
{
  eq(
    translate('oursQuotaValue', { points: formatPoints(300, zh.oursPointsUnit) }),
    '300 积分',
    '额度整行文案：只有积分'
  )
  eq(
    translate('oursQuotaValue', { points: formatPoints(100, zh.oursPointsUnit) }),
    '100 积分',
    '额度整行文案：100 积分不折算'
  )
  // 折算函数必须彻底消失：留着就会有人再按 1 元 = 100 积分拼回去（/api/plans 实际是 3000 积分/元）
  eq(typeof oursApi.pointsToYuan, 'undefined', '不再导出 pointsToYuan')
  eq(typeof oursApi.formatYuan, 'undefined', '不再导出 formatYuan')
  eq(typeof oursApi.POINTS_PER_YUAN, 'undefined', '不再导出 POINTS_PER_YUAN')
  // zh/en 都不许留死键与残留换算模板
  const residue = []
  for (const [locale, table] of [['zh', zh], ['en', en]]) {
    for (const [key, text] of Object.entries(table)) {
      if (!key.startsWith('ours')) continue
      if (typeof text !== 'string') continue
      if (/\{yuan\}|约可消费|approx|about \{|¥/.test(text)) residue.push(`${locale}.${key}=${text}`)
    }
  }
  eq(residue, [], 'zh/en 额度相关文案里没有 ¥ 折算残留')
  truthy(!/token/.test(zh.oursQuotaValue), '额度文案里没有 token')
  truthy(!/\$/.test(zh.oursQuotaValue), '额度文案里没有美元符号')
  truthy(!/USD/i.test(JSON.stringify(zh)), '文案里没有 USD')
}

// ---------------------------------------------------------------- [3] Key 校验
console.log('\n[3] Key 校验：只回答有效/无效，不碰额度')
{
  const { transport, calls } = fakeTransport([json(200, { api_key: '…0383f0', valid: true })])
  const state = await probeApiKey(KEY, transport)
  eq(state.status, 'valid', 'valid=true → valid')
  eq(state.keyTail, `••••${KEY_TAIL}`, 'Key 只露尾 6 位')
  eq(calls[0].url, `${OURS_API_BASE}/api/balance`, 'URL 不带 query')
  eq(calls[0].headers.Authorization, `Bearer ${KEY}`, 'Authorization 头')
  truthy(!calls[0].url.includes(KEY), 'URL 里没有完整 Key')
  truthy(!('points' in state) && !('balance' in state), '返回值里没有额度字段（额度只认邀请服务）')

  const invalid = await probeApiKey(KEY, fakeTransport([json(200, { api_key: '…0383f0', valid: false })]).transport)
  eq(invalid.status, 'invalid', 'valid=false → invalid')
  const timeout = await probeApiKey(KEY, fakeTransport([{ kind: 'timeout' }]).transport)
  eq(timeout.status, 'timeout', '超时')
  const network = await probeApiKey(KEY, fakeTransport([{ kind: 'network' }]).transport)
  eq(network.status, 'network', '断网')
  const html = await probeApiKey(KEY, fakeTransport([{ kind: 'response', status: 200, text: '<html>' }]).transport)
  eq(html.status, 'invalid-json', '非法 JSON')
  const empty = await (async () => {
    const { transport: t2, calls: c2 } = fakeTransport([json(200, { valid: true })])
    return { state: await probeApiKey('   ', t2), calls: c2 }
  })()
  eq(empty.calls.length, 0, '空 Key 一次请求都不发')
  eq(empty.state.status, 'invalid', '空 Key → invalid')
}

// ---------------------------------------------------------------- [4][5] /buy
console.log('\n[4] /buy：GET 一次、不跟随、从 Location 的 return_url 取 order_token')
{
  const { transport, calls } = fakeTransport([
    { kind: 'response', status: 302, text: '', location: REAL_LOCATION },
  ])
  const result = await startCheckout('p1', transport, { customerId: 10 })
  eq(calls.length, 1, '只发一次（每发一次就会新建订单）')
  eq(calls[0].method, 'GET', 'method 是 GET')
  eq(calls[0].url, `${OURS_API_BASE}/buy?plan=p1&cid=10`, '/buy?plan=p1&cid=10（Issue #115：下单带 cid）')
  eq(calls[0].followRedirects, false, 'followRedirects=false（禁跟随）')
  eq(result.kind, 'ok', '拿到收银台信息')
  eq(result.checkout.payUrl, REAL_LOCATION, 'payUrl 就是 302 的 Location')
  eq(result.checkout.outTradeNo, OUT_TRADE_NO, 'out_trade_no 从 Location 解析')
  eq(result.checkout.orderToken, ORDER_TOKEN, 'order_token 从 return_url 解析（查单必需）')
  eq(isOpenableCheckout(result.checkout.payUrl), true, '收银台是 https，可用系统浏览器打开')
}

// Issue #115：拿不到 cid 时**一次请求都不发** —— 宁可不卖，也不建「不知道属于谁」的单
{
  const { transport, calls } = fakeTransport([{ kind: 'response', status: 302, text: '', location: REAL_LOCATION }])
  const refused = await startCheckout('p1', transport, { customerId: null })
  eq(refused.kind, 'error', '没有 cid → 直接报错')
  eq(refused.kind === 'error' ? refused.code : '', 'CUSTOMER_ID_MISSING', '错误码 CUSTOMER_ID_MISSING')
  eq(zh[refused.kind === 'error' ? refused.messageKey : 'oursErrPlanMissing'], zh.oursErrCustomerMissing, '提示「缺少客户编号」')
  eq(calls.length, 0, '一次 /buy 都没发（没有 cid 的下单会把单建到别人名下）')
}

console.log('\n[5] /buy 的失败面：明文收银台 / 缺令牌 / 网页版拿不到 Location')
{
  const plain = await startCheckout(
    'p1',
    fakeTransport([{ kind: 'response', status: 302, text: '', location: 'http://pay.example.com/x' }]).transport,
    { customerId: 10 }
  )
  eq(plain.kind, 'error', 'http 收银台不认')
  eq(zh[plain.messageKey], '当前环境拿不到收银台地址，请在 App 内购买或改用卡密兑换', '明文收银台文案')

  const noToken = await startCheckout(
    'p1',
    fakeTransport([
      { kind: 'response', status: 302, text: '', location: 'https://pay.example.com/checkout/abc' },
    ]).transport,
    { customerId: 10 }
  )
  eq(noToken.kind, 'error', '只有 https 地址没有单号/令牌 → 直接报错')
  eq(zh[noToken.messageKey], '缺少订单令牌，无法查询', '缺令牌文案')

  const opaque = await startCheckout(
    'p1',
    fakeTransport([{ kind: 'response', status: 0, text: '' }]).transport,
    { customerId: 10 }
  )
  eq(opaque.kind, 'no-location', '网页版 opaqueredirect（status 0）→ no-location')

  // 网页版跟随重定向只会落到收银台 HTML 上（且真实环境被 CORS 拦）：
  // 拿不到 Location 就说 no-location，绝不拿 body/URL 去猜单号
  const followed = await startCheckout(
    'p1',
    fakeTransport([{ kind: 'response', status: 200, text: '<html>checkout</html>', location: '' }]).transport,
    { customerId: 10 }
  )
  eq(followed.kind, 'no-location', '跟随后的 200 页面不被当作收银台地址')

  const parseHttp = parseCheckoutTarget('http://pay.example.com/x?out_trade_no=1&order_token=2')
  eq(parseHttp, null, 'parseCheckoutTarget 拒绝 http')
  const parseMissing = parseCheckoutTarget(`https://pay.example.com/x?out_trade_no=${OUT_TRADE_NO}`)
  eq(parseMissing, null, '缺 order_token 时不当作可用收银台')
}

// ---------------------------------------------------------------- [6] 查单
console.log('\n[6] 查单：只有 fulfilled 有卡密，展示只留尾 4 位')
{
  const missing = await (async () => {
    const { transport, calls } = fakeTransport([json(200, {})])
    return { result: await queryOrder({ outTradeNo: OUT_TRADE_NO, orderToken: '' }, transport), calls }
  })()
  eq(missing.calls.length, 0, '缺 order_token 一次请求都不发')
  eq(missing.result.messageKey, 'oursErrOrderTokenMissing', '缺 order_token 报错')

  const { transport, calls } = fakeTransport([
    json(200, {
      out_trade_no: OUT_TRADE_NO,
      status: 'fulfilled',
      amount_fen: 300,
      card_no: CARD,
      expire_at: 1794990326,
      message: 'ok',
    }),
  ])
  const result = await queryOrder({ outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN }, transport)
  eq(result.kind, 'ok', '查单成功')
  eq(result.order.status, 'fulfilled', '状态')
  eq(result.order.amountFen, 300, 'amount_fen')
  eq(result.order.cardTail, `••••${CARD_TAIL}`, '展示用卡密只有尾 4 位')
  eq(result.order.cardNo, CARD, '完整卡密只在内存字段 cardNo（供一键兑换）')
  eq(result.order.expireAtSeconds, 1794990326, 'expire_at 是 Unix 秒')
  truthy(calls[0].url.includes(`out_trade_no=${OUT_TRADE_NO}`), '查单带 out_trade_no')
  truthy(calls[0].url.includes(`order_token=${ORDER_TOKEN}`), '查单带 order_token')
  truthy(!calls[0].url.includes(KEY), '查单 URL 不含服务 Key')
  eq(calls[0].followRedirects, false, '查单不跟随重定向')

  const pending = await queryOrder(
    { outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN },
    fakeTransport([
      json(200, { out_trade_no: OUT_TRADE_NO, status: 'pending', amount_fen: 300, card_no: null, expire_at: 1 }),
    ]).transport
  )
  eq(pending.order.cardTail, '', '未发卡时没有卡密尾号')
  eq(pending.order.cardNo, '', '未发卡时内存卡密为空')

  const forbidden = await queryOrder(
    { outTradeNo: OUT_TRADE_NO, orderToken: 'wrong' },
    fakeTransport([
      json(403, { code: 'UNAUTHORIZED', message: '订单凭证不匹配', request_id: 'rid' }),
    ]).transport
  )
  eq(zh[forbidden.messageKey], '鉴权失败，请重新领取或填写 Key 后再试', '403 文案')
  eq(zh[ORDER_STATUS_KEYS.pending], '待支付', 'pending 文案')
  eq(zh[ORDER_STATUS_KEYS.fulfilled], '已发卡', 'fulfilled 文案')
}

// ---------------------------------------------------------------- [7] 轮询
console.log('\n[7] 轮询状态机：2s、≤60s、终态即停、paid 继续轮、可取消')
{
  const clock = { t: 0 }
  const intervals = []
  const sleep = async (ms) => {
    intervals.push(ms)
    clock.t += ms
  }
  const statuses = ['pending', 'paid', 'fulfilled']
  const { transport, calls } = fakeTransport(
    statuses.map((status) =>
      json(200, {
        out_trade_no: OUT_TRADE_NO,
        status,
        amount_fen: 300,
        card_no: status === 'fulfilled' ? CARD : '',
        expire_at: 1794990326,
      })
    )
  )
  const updates = []
  const result = await pollOrder({
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
    transport,
    sleep,
    now: () => clock.t,
    onUpdate: (order) => updates.push(order.status),
  })
  eq(result.kind, 'ok', '轮询到终态')
  eq(result.attempts, 3, '轮询次数')
  eq(intervals, [2000, 2000], '每次间隔 2000ms')
  eq(updates, ['pending', 'paid', 'fulfilled'], 'onUpdate 每次都回调')
  eq(result.order.cardTail, `••••${CARD_TAIL}`, '终态卡密只留尾 4 位')
  truthy(clock.t <= 60000, '总耗时 ≤60s')

  const stuckClock = { t: 0 }
  const stuckIntervals = []
  const stuck = await pollOrder({
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
    transport: fakeTransport([
      json(200, { out_trade_no: OUT_TRADE_NO, status: 'pending', amount_fen: 300, card_no: '' }),
    ]).transport,
    sleep: async (ms) => {
      stuckIntervals.push(ms)
      stuckClock.t += ms
    },
    now: () => stuckClock.t,
  })
  eq(stuck.kind, 'timeout', '一直 pending → 60s 后停（超时不重复下单）')
  truthy(stuckClock.t <= 60000, '超时上限 ≤60s')
  eq(stuck.attempts, 31, '60s / 2s → 31 次（首查 + 30 次间隔）')
  truthy(stuckIntervals.every((ms) => ms === 2000), '间隔恒为 2000ms')

  const cancelled = await pollOrder({
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
    transport: fakeTransport([
      json(200, { out_trade_no: OUT_TRADE_NO, status: 'pending', amount_fen: 300, card_no: '' }),
    ]).transport,
    sleep: async () => {},
    now: () => 0,
    shouldStop: () => true,
  })
  eq(cancelled.kind, 'cancelled', 'shouldStop → 立刻取消（关弹层不再轮询）')

  const noToken = await (async () => {
    const { transport: t2, calls: c2 } = fakeTransport([json(200, {})])
    return { out: await pollOrder({ outTradeNo: OUT_TRADE_NO, orderToken: '', transport: t2 }), calls: c2 }
  })()
  eq(noToken.out.kind, 'error', '无 token 直接失败')
  eq(noToken.calls.length, 0, '无 token 一次都不轮询')
}

// ---------------------------------------------------------------- [8][9] 兑换
console.log('\n[8] 兑换：request_id 固定用卡密；202 是「处理中」不是失败')
{
  eq(requestIdForCard(`  ${CARD}  `), CARD, 'request_id = 卡密（去空格）')
  const { transport, calls } = fakeTransport([
    json(200, { ok: true, card_no: CARD, points: 300, api_key: KEY, sync: 'synced' }),
  ])
  const result = await redeemCard({ cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) }, transport)
  eq(result.kind, 'success', '成功')
  eq(result.points, 300, '到账积分')
  eq(result.cardTail, `••••${CARD_TAIL}`, '结果只带卡密尾 4 位')
  eq(calls[0].method, 'POST', 'method')
  eq(calls[0].url, `${OURS_API_BASE}/api/redeem`, 'URL（Key 不进 query）')
  const body = JSON.parse(calls[0].body)
  eq(Object.keys(body).sort(), ['api_key', 'card_no', 'request_id'], '请求体字段')
  eq(body.request_id, CARD, 'request_id 就是卡密')
  eq(
    translate('oursRedeemSuccess', { points: formatPoints(result.points, zh.oursPointsUnit) }),
    '兑换成功，+300 积分',
    '成功文案（不再带 ¥ 折算）'
  )
  truthy(!JSON.stringify({ ...result, card: '' }).includes(KEY), '结果不含完整 Key')

  // 超时重发：同一张卡 → 同一个 request_id（服务端按它去重）
  const retry = fakeTransport([{ kind: 'timeout' }, json(200, { ok: true, points: 300, sync: 'synced' })])
  const first = await redeemCard({ cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) }, retry.transport)
  const second = await redeemCard({ cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) }, retry.transport)
  eq(first.kind, 'error', '第一次超时')
  eq(first.retryable, true, '超时可重试')
  eq(second.kind, 'success', '重发成功')
  eq(JSON.parse(retry.calls[0].body).request_id, JSON.parse(retry.calls[1].body).request_id, '重发复用同一 request_id')

  const pending = await redeemCard(
    { cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) },
    fakeTransport([
      { kind: 'response', status: 202, text: JSON.stringify({ code: 'CREDIT_PENDING', message: '处理中', request_id: 'r' }) },
    ]).transport
  )
  eq(pending.kind, 'pending', '202 CREDIT_PENDING → pending（不是失败）')
  eq(zh.oursRedeemPending, '兑换处理中，请稍后刷新额度查看', '202 文案')
  truthy(!/失败/.test(zh.oursRedeemPending), '202 文案里没有「失败」')

  const pendingByCode = await redeemCard(
    { cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) },
    fakeTransport([json(200, { code: 'CREDIT_PENDING' })]).transport
  )
  eq(pendingByCode.kind, 'pending', 'code=CREDIT_PENDING 也说 pending')
}

console.log('\n[9] 兑换错误码：五类各有一句能看的文案')
{
  const cases = [
    ['API_KEY_INVALID', 400, 'Key 无效，请重新领取或填写', false],
    ['CARD_ALREADY_USED', 409, '该卡密已被使用，不要重复提交', false],
    ['CARD_NOT_FOUND', 404, '卡密不存在，请核对后重试', false],
    ['VERIFY_UNAVAILABLE', 503, '积分服务暂时不可用，请稍后重试', true],
    ['RATE_LIMITED', 429, '请求过于频繁，请稍后重试', false],
  ]
  for (const [code, status, text, retryable] of cases) {
    const result = await redeemCard(
      { cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) },
      fakeTransport([json(status, { code, message: 'server', request_id: 'rid' })]).transport
    )
    eq(result.kind, 'error', `${code} 仍是错误`)
    eq(zh[result.messageKey], text, `${code} → ${text}`)
    eq(result.retryable, retryable, `${code} retryable=${retryable}`)
    truthy(!JSON.stringify(result).includes(CARD), `${code} 结果不含完整卡密`)
    truthy(!JSON.stringify(result).includes('rid'), `${code} 不暴露服务端 request_id`)
  }

  const blankCard = await (async () => {
    const { transport, calls } = fakeTransport([json(200, { ok: true })])
    return { result: await redeemCard({ cardNo: '  ', apiKey: KEY, requestId: 'x' }, transport), calls }
  })()
  eq(blankCard.result.messageKey, 'oursErrCardMissing', '空卡密直接拒绝')
  eq(blankCard.calls.length, 0, '空卡密一次请求都不发')
  const noKey = await (async () => {
    const { transport, calls } = fakeTransport([json(200, { ok: true })])
    return { result: await redeemCard({ cardNo: CARD, apiKey: '  ', requestId: CARD }, transport), calls }
  })()
  eq(noKey.result.messageKey, 'oursErrKeyMissing', '没有 Key 直接拒绝')
  eq(noKey.calls.length, 0, '没有 Key 一次请求都不发')
}

// ---------------------------------------------------------------- [10] 隐私
console.log('\n[10] 脱敏与「不写 console」')
{
  eq(maskKey(KEY), `••••${KEY_TAIL}`, 'maskKey 尾 6 位')
  eq(maskKey('short'), '••••', '太短的 Key 全部遮掉')
  eq(maskCard(CARD), `••••${CARD_TAIL}`, 'maskCard 尾 4 位')

  // 文案表里不出现真实凭据形态（防止有人把 Key/卡密写进 i18n）
  const text = JSON.stringify(zh)
  truthy(!/sk-[A-Za-z0-9]{8,}/.test(text), 'i18n 文案里没有 Key 形态的串')
  truthy(!/CARD-[A-Za-z0-9]{6,}/.test(text), 'i18n 文案里没有卡密形态的串')
  truthy(Object.hasOwn(zh, 'oursOrderStatusPending'), '订单状态文案 key 存在')

  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  const leaked = []
  const spy = (...args) => leaked.push(args.map((arg) => String(arg)).join(' '))
  console.log = spy
  console.warn = spy
  console.error = spy
  console.info = spy
  try {
    await probeApiKey(KEY, fakeTransport([json(200, { api_key: KEY, valid: true })]).transport)
    await fetchPlans(fakeTransport([json(200, { plans: [{ id: 'p1', price: 3, points: 300 }] })]).transport)
    await startCheckout('p1', fakeTransport([{ kind: 'response', status: 302, text: '', location: REAL_LOCATION }]).transport, { customerId: 10 })
    await redeemCard(
      { cardNo: CARD, apiKey: KEY, requestId: requestIdForCard(CARD) },
      fakeTransport([{ kind: 'response', status: 202, text: '{"code":"CREDIT_PENDING"}' }]).transport
    )
    await pollOrder({
      outTradeNo: OUT_TRADE_NO,
      orderToken: ORDER_TOKEN,
      transport: fakeTransport([
        json(200, { out_trade_no: OUT_TRADE_NO, status: 'fulfilled', amount_fen: 300, card_no: CARD }),
      ]).transport,
      sleep: async () => {},
      now: () => 0,
    })
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

// [layer: unit | 依赖: 无（纯 Node，零浏览器 / 零 React；Capacitor 与 @capacitor/browser 用替身） | 耗时: <1s]
// Issue #235（App 里点「去支付」，付完款停在浏览器里回不来）的单测。
//
// 现状（修之前）：原生点「去支付」= 系统浏览器 ACTION_VIEW 打开收银台 + 立刻轮询 60s。
// 用户付完款停在支付宝收银台 / 浏览器里，App 在后台干等，60s 后轮询超时，
// 手动切回来只看到「等待支付」，必须点「再查一次」才拿到卡密。
//
// 目标：
//   [A] 源码体检：真的存在「App 内嵌浏览器 + browserFinished + /api/buy」这套回路
//   [B] httpTransport：/api/buy 走 JSON 传输（CapacitorHttp），老的 /buy 仍走 resolveLocation
//   [C] createBuyOrder：解析 /api/buy 契约；每个错误码各有专文案（不许落到通用文案）
//   [D] openCheckoutInApp：关掉收银台只回调一次；没插件 / 打开失败一律降级不崩
//   [E] startInAppPay：建单 → 内嵌打开 → 关闭后**立刻重查一次、且只查一次**
//   [F] 票根：同一张单不重复建单；换套餐必须换新的 pay_url（付费地址带金额，不能跨单复用）
//   [G] Web（非原生、没有 Browser）：降级到系统浏览器，不抛错、不白屏
//
// 跑法：node --test tests/unit/ours-inapp-buy.test.mjs（或 node tests/run-layer.mjs unit）
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------- 电容桥替身
// 必须在 import 业务代码**之前**挂上：transport.ts 在模块作用域就 registerPlugin('CheckoutBrowser')。
// 状态放在 globalThis 上，数据 URL 模块与测试文件共享同一个全局。
globalThis.__cap = {
  /** 是否原生环境（每个用例自己改） */
  native: true,
  /** CapacitorHttp.request 收到的请求 */
  http: [],
  /** CheckoutBrowser.resolveLocation 收到的请求 */
  locations: [],
  /** CheckoutBrowser.open（系统浏览器）收到的请求 */
  opened: [],
  /** @capacitor/browser 的替身状态 */
  browser: {
    opens: [],
    listeners: [],
    /** 打开就失败（模拟内嵌浏览器不可用） */
    rejectOpen: false,
    removeCount: 0,
    /** 模拟用户关掉收银台（回到 App） */
    finish() {
      for (const item of [...this.listeners]) {
        item.handler()
      }
    },
  },
  httpReply: () => ({ status: 200, data: '', headers: {} }),
  locationReply: () => ({ status: 302, location: '' }),
}

const capacitorStub = `data:text/javascript,${encodeURIComponent(`
export const Capacitor = { isNativePlatform: () => globalThis.__cap.native }
export const CapacitorHttp = {
  request: async (options) => {
    globalThis.__cap.http.push(options)
    return globalThis.__cap.httpReply(options)
  },
}
export const registerPlugin = (name) => ({
  open: async (options) => {
    globalThis.__cap.opened.push({ plugin: name, url: options.url })
    return { opened: true }
  },
  resolveLocation: async (options) => {
    globalThis.__cap.locations.push({ plugin: name, url: options.url })
    return globalThis.__cap.locationReply(options)
  },
})
`)}`

const browserStub = `data:text/javascript,${encodeURIComponent(`
export const Browser = {
  open: async (options) => {
    globalThis.__cap.browser.opens.push({ url: options.url })
    if (globalThis.__cap.browser.rejectOpen) {
      throw new Error('内嵌浏览器打不开')
    }
  },
  addListener: async (eventName, handler) => {
    globalThis.__cap.browser.listeners.push({ eventName, handler })
    return {
      remove: async () => {
        globalThis.__cap.browser.removeCount += 1
        const index = globalThis.__cap.browser.listeners.findIndex((item) => item.handler === handler)
        if (index >= 0) {
          globalThis.__cap.browser.listeners.splice(index, 1)
        }
      },
    }
  },
}
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: capacitorStub, shortCircuit: true }
    }
    if (specifier === '@capacitor/browser') {
      return { url: browserStub, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

// 红阶段（功能还没写）时这个 import 会失败：不抛到顶层，改成「能力缺失」一条条报出来，
// 输出读起来就是「缺哪一件事」，而不是一句 ERR_MODULE_NOT_FOUND。
const inApp = await import('../../src/services/ours/inAppPay.ts').catch(() => null)
const api = await import('../../src/services/ours/api.ts')
const transport = await import('../../src/services/ours/transport.ts')
const { CUSTOMER_ID_STORAGE_KEY } = await import('../../src/services/ours/customerId.ts')
const { readStoredOrder } = await import('../../src/services/ours/orderStore.ts')

const dialogSource = readFileSync(new URL('../../src/components/settings/OursServicesDialog.tsx', import.meta.url), 'utf8')
const transportSource = readFileSync(new URL('../../src/services/ours/transport.ts', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../../src/services/ours/api.ts', import.meta.url), 'utf8')
const zhSource = readFileSync(new URL('../../src/i18n/zh.ts', import.meta.url), 'utf8')
const enSource = readFileSync(new URL('../../src/i18n/en.ts', import.meta.url), 'utf8')

const OUT_TRADE_NO = 'CP2026111816102637F0F8AA'
const ORDER_TOKEN = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'
/** 收银台地址：金额与单号都在签名里，所以**不同订单绝不能用同一个地址** */
const PAY_URL = `https://pay.xiaodouap.cn/submit.php?pid=1&out_trade_no=${OUT_TRADE_NO}&money=3.00`
const OUT_TRADE_NO_2 = 'CP2026111816109999AA'
const PAY_URL_2 = `https://pay.xiaodouap.cn/submit.php?pid=1&out_trade_no=${OUT_TRADE_NO_2}&money=9.90`

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  checks.n += 1
  console.error(`  ✗   ${message}`)
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  a === b ? ok(`${label} = ${a}`) : bad(`${label}：期望 ${b}，实际 ${a}`)
}

const cap = () => globalThis.__cap
const resetStubs = () => {
  const stub = cap()
  stub.native = true
  stub.http.length = 0
  stub.locations.length = 0
  stub.opened.length = 0
  stub.browser.opens.length = 0
  stub.browser.listeners.length = 0
  stub.browser.rejectOpen = false
  stub.browser.removeCount = 0
  stub.httpReply = () => ({ status: 200, data: '', headers: {} })
  stub.locationReply = () => ({ status: 302, location: '' })
}

/** 假 localStorage：断言「票根 / 存档写了什么」 */
const fakeStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  }
}

/** 固定响应体的假 transport（只测解析，不碰网络） */
const replyOnce = (status, body) => {
  const seen = []
  const fake = async (request) => {
    seen.push(request)
    return { kind: 'response', status, text: typeof body === 'string' ? body : JSON.stringify(body), location: '' }
  }
  return { fake, seen }
}

const BUY_OK_BODY = {
  ok: true,
  out_trade_no: OUT_TRADE_NO,
  order_token: ORDER_TOKEN,
  pay_url: PAY_URL,
  amount_fen: 300,
  plan: 'p1',
  plan_name: '体验套餐',
  expire_at: 1795055405,
}

const ticketFor = (planId) => ({
  outTradeNo: planId === 'p2' ? OUT_TRADE_NO_2 : OUT_TRADE_NO,
  orderToken: ORDER_TOKEN,
  payUrl: planId === 'p2' ? PAY_URL_2 : PAY_URL,
  planId,
})

// ---------------------------------------------------------------- [A] 源码体检
console.log('\n[A] 源码体检：内嵌浏览器 + 关闭回跳 + /api/buy')
{
  truthy(/@capacitor\/browser/u.test(transportSource), '传输层引入了 @capacitor/browser（收银台在 App 内打开，不再踢去系统浏览器）')
  truthy(/browserFinished/u.test(transportSource), '传输层监听 browserFinished（用户关掉收银台 = 回到 App 的那一刻）')
  truthy(typeof transport.openCheckoutInApp === 'function', '传输层导出 openCheckoutInApp（能记一次「收银台关掉了」的回调）')
  truthy(typeof api.createBuyOrder === 'function', 'api.ts 导出 createBuyOrder（GET /api/buy 的 JSON 契约）')
  truthy(/\/api\/buy/u.test(apiSource), 'api.ts 里出现 /api/buy')

  const buyStart = dialogSource.indexOf('const buy = async () => {')
  const buyBody = buyStart === -1 ? '' : dialogSource.slice(buyStart, dialogSource.indexOf('\n  }', buyStart) + 4)
  truthy(buyBody !== '', '定位到「去支付」的实现（buy）')
  truthy(/startInAppPay\(/u.test(buyBody), '「去支付」走 App 内嵌浏览器的编排（startInAppPay）')
  truthy(/createBuyOrder/u.test(buyBody), '「去支付」用 /api/buy 建单（拿到 pay_url 才能内嵌打开）')
  truthy(!/await openCheckout\(/u.test(buyBody), '「去支付」不再直接把用户踢去系统浏览器（openCheckout 只能当降级）')
}

// ---------------------------------------------------------------- [B] 传输层
console.log('\n[B] 传输层：/api/buy 走 JSON，老 /buy 仍走 resolveLocation')
{
  resetStubs()
  cap().httpReply = () => ({ status: 200, data: JSON.stringify(BUY_OK_BODY), headers: {} })
  const result = await transport.httpTransport({
    method: 'GET',
    url: 'https://apia.ecsafe.cn/api/buy?cid=10&plan=p1',
    headers: { Accept: 'application/json' },
    timeoutMs: 12000,
    followRedirects: false,
  })
  eq(cap().http.length, 1, 'GET /api/buy 走了 CapacitorHttp（有正文可解析）')
  eq(cap().locations.length, 0, 'GET /api/buy 没被当成老的 /buy（resolveLocation 只回状态码，读不到 pay_url）')
  truthy(result.kind === 'response' && result.text.includes('pay_url'), '/api/buy 的正文原样回到调用方')

  resetStubs()
  const returnUrl = `https://apia.ecsafe.cn/return?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`
  cap().locationReply = () => ({ status: 302, location: `${PAY_URL}&return_url=${encodeURIComponent(returnUrl)}` })
  const legacy = await transport.httpTransport({
    method: 'GET',
    url: 'https://apia.ecsafe.cn/buy?cid=10&plan=p1',
    headers: { Accept: 'text/html' },
    timeoutMs: 12000,
    followRedirects: false,
  })
  eq(cap().locations.length, 1, '老的 GET /buy 仍然只走一次 resolveLocation')
  truthy(legacy.kind === 'response' && (legacy.location ?? '').includes('pay.xiaodouap.cn'), '/buy 的 302 Location 照旧回给调用方')
}

// ---------------------------------------------------------------- [C] createBuyOrder
console.log('\n[C] createBuyOrder：/api/buy 契约与错误码文案')
if (typeof api.createBuyOrder !== 'function') {
  bad('缺少 api.createBuyOrder：App 端拿不到 pay_url（JSON 契约没人实现）')
  bad('缺少 api.createBuyOrder：CID_REQUIRED / PLAN_NOT_FOUND / NEWBIE_USED / RATE_LIMITED / CID_UNKNOWN 无专属文案')
  bad('缺少 api.createBuyOrder：建单成功也不会写存档')
} else {
  const storage = fakeStorage({ [CUSTOMER_ID_STORAGE_KEY]: '10' })
  const { fake, seen } = replyOnce(200, BUY_OK_BODY)
  const created = await api.createBuyOrder('p1', fake, { storage })
  eq(created.kind, 'ok', '200 + 完整 JSON → 拿到票')
  const request = seen[0] ?? { url: '', headers: {} }
  truthy(
    request.url.startsWith('https://apia.ecsafe.cn/api/buy?') && request.url.includes('cid=10') && request.url.includes('plan=p1'),
    `/api/buy 带上 cid 与 plan（实际 ${request.url}）`
  )
  eq(request.headers.Accept, 'application/json', '请求要 JSON（不是 HTML 收银台）')
  if (created.kind === 'ok') {
    eq(created.ticket.outTradeNo, OUT_TRADE_NO, 'ticket.outTradeNo')
    eq(created.ticket.orderToken, ORDER_TOKEN, 'ticket.orderToken')
    eq(created.ticket.payUrl, PAY_URL, 'ticket.payUrl')
    eq(created.ticket.amountFen, 300, 'ticket.amountFen')
    eq(created.ticket.planId, 'p1', 'ticket.planId')
    eq(created.ticket.planName, '体验套餐', 'ticket.planName')
    const stored = readStoredOrder(storage)
    truthy(stored !== null && stored.outTradeNo === OUT_TRADE_NO, '建单成功即写存档（切后台 / 重开 App 还能续查）')
    truthy(stored !== null && stored.planId === 'p1', '存档记住套餐')
  } else {
    bad('拿到票但没有 ticket（后续没法内嵌打开）')
  }

  const cases = [
    { status: 400, code: 'CID_REQUIRED', key: 'oursErrCidRequired', label: '缺客户编号' },
    { status: 400, code: 'PLAN_NOT_FOUND', key: 'oursErrPlanNotFound', label: '套餐不存在' },
    { status: 409, code: 'NEWBIE_USED', key: 'oursErrNewbieUsed', label: '新人特惠已用过' },
    { status: 429, code: 'RATE_LIMITED', key: 'oursErrRateLimited', label: '被限流' },
    // 真服务端实测多出来的一个码（GET /api/buy?cid=1&plan=nope → CID_UNKNOWN）：
    // 「客户编号不存在」也必须有自己的说法，不能落到 400 兜底的「请求格式有误」
    { status: 400, code: 'CID_UNKNOWN', key: 'oursErrCustomerNeedsKey', label: '客户编号不存在' },
  ]
  for (const item of cases) {
    const reply = replyOnce(item.status, { code: item.code, message: 'server says', request_id: 'req-1' })
    const failed = await api.createBuyOrder('p1', reply.fake, { storage: fakeStorage({ [CUSTOMER_ID_STORAGE_KEY]: '10' }) })
    eq(failed.kind === 'error' ? failed.messageKey : failed.kind, item.key, `${item.status} ${item.code}（${item.label}）有专属文案`)
    if (item.code === 'NEWBIE_USED') {
      truthy(failed.kind === 'error' && failed.messageKey !== 'oursErrCardUsed', 'NEWBIE_USED 是 409，但不能落成「卡密已被使用」（code 优先于状态码）')
    }
  }

  const plainReply = replyOnce(200, { ok: true, out_trade_no: OUT_TRADE_NO, order_token: ORDER_TOKEN, pay_url: 'http://pay.example.com/x' })
  const plain = await api.createBuyOrder('p1', plainReply.fake, { storage: fakeStorage({ [CUSTOMER_ID_STORAGE_KEY]: '10' }) })
  eq(plain.kind, 'error', '明文 pay_url 一律不开（返回错误而不是把用户送去 http）')

  const noUrlReply = replyOnce(200, { ok: true, out_trade_no: OUT_TRADE_NO, order_token: ORDER_TOKEN })
  const noUrl = await api.createBuyOrder('p1', noUrlReply.fake, { storage: fakeStorage({ [CUSTOMER_ID_STORAGE_KEY]: '10' }) })
  eq(noUrl.kind, 'error', '200 但没有 pay_url → 报错，不猜地址')

  const offline = await api.createBuyOrder('p1', async () => ({ kind: 'timeout' }), { storage: fakeStorage({ [CUSTOMER_ID_STORAGE_KEY]: '10' }) })
  eq(offline.kind === 'error' ? offline.messageKey : offline.kind, 'oursErrTimeout', '超时给可重试文案')

  const noCid = await api.createBuyOrder('p1', replyOnce(200, BUY_OK_BODY).fake, { storage: fakeStorage() })
  eq(noCid.kind === 'error' ? noCid.messageKey : noCid.kind, 'oursErrCustomerNeedsKey', '拿不到 cid 就不建单（不建没人认领的单）')

  truthy(/oursErrCidRequired:/u.test(zhSource) && /oursErrCidRequired:/u.test(enSource), 'zh/en 都有 oursErrCidRequired')
  truthy(/oursErrNewbieUsed:/u.test(zhSource) && /oursErrNewbieUsed:/u.test(enSource), 'zh/en 都有 oursErrNewbieUsed')
}

// ---------------------------------------------------------------- [D] openCheckoutInApp
console.log('\n[D] openCheckoutInApp：关掉收银台回调一次，缺能力就降级')
if (typeof transport.openCheckoutInApp !== 'function') {
  bad('缺少 transport.openCheckoutInApp：App 里没有内嵌收银台，付完款只能留在浏览器')
  bad('缺少 browserFinished 回跳：关闭收银台不会触发查单')
  bad('缺少内嵌浏览器降级：打不开时没有回退路径')
} else {
  resetStubs()
  let closed = 0
  const opened = await transport.openCheckoutInApp(PAY_URL, () => {
    closed += 1
  })
  eq(opened, true, '原生环境下内嵌打开成功')
  eq(cap().browser.opens.length, 1, '调用了 @capacitor/browser 的 open（App 内打开）')
  eq(cap().browser.opens[0]?.url, PAY_URL, '打开的就是 pay_url')
  eq(cap().browser.listeners.filter((item) => item.eventName === 'browserFinished').length, 1, '注册了 browserFinished 监听')
  eq(cap().opened.length, 0, '没有再把用户踢去系统浏览器')
  cap().browser.finish()
  eq(closed, 1, '关掉收银台 → 回调一次（这是回跳查单的触发点）')
  cap().browser.finish()
  eq(closed, 1, 'browserFinished 重复触发也只回跳一次')
  truthy(cap().browser.removeCount >= 1, '回跳后立刻摘掉监听（不残留到下一次支付）')

  resetStubs()
  const refused = await transport.openCheckoutInApp('http://pay.example.com/x', () => {})
  eq(refused, false, '明文地址不打开')

  resetStubs()
  cap().browser.rejectOpen = true
  const broken = await transport.openCheckoutInApp(PAY_URL, () => {})
  eq(broken, false, '内嵌浏览器打不开 → 返回 false 让调用方降级（不抛错）')
  cap().browser.finish()
  truthy(cap().browser.removeCount >= 1, '打开失败后也摘掉监听（否则下次支付会多一次假回跳）')
  eq(closed, 1, '打开失败不会凭空回跳')
}

// ---------------------------------------------------------------- [E][F] startInAppPay
console.log('\n[E] startInAppPay：关闭即回跳，且只查一次')
if (typeof inApp?.startInAppPay !== 'function') {
  bad('缺少 services/ours/inAppPay.ts 的 startInAppPay：关闭收银台不会触发查单')
} else {
  const makeFlow = (overrides = {}) => {
    const log = { created: 0, opened: [], system: [], polls: [], remembered: [] }
    const flow = {
      ticket: overrides.ticket ?? null,
      remember: (next) => {
        log.remembered.push(next)
      },
      createOrder: async (id) => {
        log.created += 1
        return overrides.createResult ?? { kind: 'ok', ticket: ticketFor(id), replacedUnpaidOrder: false }
      },
      openInApp: async (url, onClosed) => {
        log.opened.push({ url })
        log.onClosed = onClosed
        return overrides.openInApp === undefined ? true : overrides.openInApp
      },
      openSystem: async (url) => {
        log.system.push({ url })
        return overrides.openSystem === undefined ? true : overrides.openSystem
      },
      poll: (order, options) => {
        log.polls.push({ order, force: options.force === true })
      },
    }
    return { flow, log }
  }

  resetStubs()
  const first = makeFlow()
  const outcome = await inApp.startInAppPay('p1', first.flow)
  eq(outcome.kind, 'ok', '点一次「去支付」拿到票')
  eq(first.log.created, 1, '只建一张单（GET /api/buy 一次）')
  eq(first.log.opened[0]?.url, PAY_URL, '用返回的 pay_url 在 App 内打开')
  eq(first.log.polls.length, 1, '打开后就先查一轮（用户可能一直不关浏览器）')
  eq(first.log.polls[0]?.force, false, '这一轮是「起轮询」，不是强制重来')
  truthy(typeof first.log.onClosed === 'function', '把「关掉收银台」的回调交给内嵌浏览器')
  first.log.onClosed()
  eq(first.log.polls.length, 2, '关掉收银台 → 立刻再查一次')
  eq(first.log.polls[1]?.force, true, '这一轮是强制重来（把后台那轮已经超时的轮询顶掉）')
  eq(first.log.polls[1]?.order.outTradeNo, OUT_TRADE_NO, '重查的是这一单')
  first.log.onClosed()
  first.log.onClosed()
  eq(first.log.polls.filter((item) => item.force).length, 1, '反复收到「关掉了」也只重查一次')
  eq(outcome.kind === 'ok' ? outcome.ticket.outTradeNo : '', OUT_TRADE_NO, '结果带回票根（界面要用单号查单）')

  const second = makeFlow({ ticket: { ...ticketFor('p1') } })
  await inApp.startInAppPay('p1', second.flow)
  eq(second.log.created, 0, '同一套餐再点一次不再建单（服务端会复用订单，但没必要多跑一次）')
  eq(second.log.opened[0]?.url, PAY_URL, '沿用同一张单的 pay_url')

  const third = makeFlow({ ticket: { ...ticketFor('p1') } })
  await inApp.startInAppPay('p2', third.flow)
  eq(third.log.created, 1, '换套餐必须重新建单')
  eq(third.log.opened[0]?.url, PAY_URL_2, '换套餐拿到新的 pay_url（上一单带金额的地址绝不能复用）')

  const rejected = makeFlow({ createResult: { kind: 'error', code: 'NEWBIE_USED', messageKey: 'oursErrNewbieUsed' } })
  const rejectedOutcome = await inApp.startInAppPay('newbie', rejected.flow)
  eq(rejectedOutcome.kind === 'error' ? rejectedOutcome.messageKey : rejectedOutcome.kind, 'oursErrNewbieUsed', '建单失败原样把文案交回界面')
  eq(rejected.log.opened.length, 0, '建单失败不开收银台')
  eq(rejected.log.polls.length, 0, '建单失败不轮询')
  eq(rejected.log.remembered.length, 0, '建单失败不留票根')

  const degraded = makeFlow({ openInApp: false })
  const degradedOutcome = await inApp.startInAppPay('p1', degraded.flow)
  eq(degraded.log.system[0]?.url, PAY_URL, '没有内嵌浏览器 → 退回系统浏览器（老行为还在）')
  eq(degradedOutcome.kind === 'ok' ? degradedOutcome.via : degradedOutcome.kind, 'system', '结果说明走的是系统浏览器')
  eq(degraded.log.polls.length, 1, '降级后照旧先起一轮轮询')

  const dead = makeFlow({ openInApp: false, openSystem: false })
  const deadOutcome = await inApp.startInAppPay('p1', dead.flow)
  eq(deadOutcome.kind === 'error' ? deadOutcome.messageKey : deadOutcome.kind, 'oursErrCheckoutUnsupported', '两条路都打不开 → 明确说「打开不了收银台」')
}

// ---------------------------------------------------------------- [G] Web 降级
console.log('\n[G] Web（非原生 / 没有 Browser 插件）：不崩、不碰不存在的桥')
if (typeof transport.openCheckoutInApp !== 'function') {
  bad('缺少 transport.openCheckoutInApp：Web 端无从验证降级')
} else {
  resetStubs()
  cap().native = false
  let closed = 0
  const opened = await transport.openCheckoutInApp(PAY_URL, () => {
    closed += 1
  })
  eq(opened, false, 'Web 端没有内嵌浏览器 → 返回 false')
  eq(cap().browser.opens.length, 0, 'Web 端不去碰 @capacitor/browser')
  eq(closed, 0, 'Web 端不会凭空触发回跳')
  resetStubs()
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

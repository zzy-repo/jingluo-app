// [layer: unit | 依赖: 无（纯 Node，零浏览器 / 零 React；@capacitor/browser 用替身） | 耗时: <1s]
// Issue #331（购买入口改为「App 内打开联动小铺收款页」）的单测。
//
// 服务端契约（实测 https://apia.ecsafe.cn/api/pay-link）：
//   200 → { "ok": true, "url": "https://wzyp.cn/shop/...", "note": "外部收款页：付款后由联动小铺直接发放卡密" }
//   503 → { "code": "PAY_LINK_NOT_CONFIGURED", "message": "收款页地址未配置" }
//
// 目标：
//   [A] fetchPayLink：只打 /api/pay-link（GET、JSON、不跟随跳转）；200 才回 url
//   [B] 拿不到可用地址时的每一条负向分支都落成「收款通道暂不可用」（网络 / 超时另给可重试文案）
//   [C] openPayLinkInApp：Browser.open 带 presentationStyle 'popover'，关页面只回调一次
//   [D] Web / 没有插件 / 打开失败：一律返回 false（不整页跳走、不崩）
//   [E] 源码体检：购买弹层不建单、不轮询、不写死地址、不出现「支付成功」
//
// 跑法：node tests/run-layer.mjs unit --case tests/unit/pay-link.test.mjs
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'
import { createSelfCheck } from '../helpers/ours-check.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 装配走公共入口（#408 收尾批）：原生桥 / 内嵌浏览器的替身收成 fixtures/domain03-04 下两份
// 状态驱动的 fixture（checkout-plugins.mjs / checkout-browser.mjs），`.js→.ts` 解析由
// installTsResolve 统一处理 —— 不再手抄 ~40 行内联 `data:` 模块 + registerHooks。
installTsResolve({
  stubs: {
    '@capacitor/core': fixtureUrl('domain03-04/checkout-plugins.mjs'),
    '@capacitor/browser': fixtureUrl('domain03-04/checkout-browser.mjs'),
  },
})

// ---------------------------------------------------------------- 电容桥替身
globalThis.__cap = {
  native: true,
  browser: {
    opens: [],
    listeners: [],
    rejectOpen: false,
    removeCount: 0,
    /** 模拟用户关掉收款页（回到 App） */
    finish() {
      for (const item of [...this.listeners]) {
        item.handler()
      }
    },
  },
}

const api = await import('../../src/services/ours/api.ts')
const transport = await import('../../src/services/ours/transport.ts')

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')
const dialogSource = read('src/components/settings/OursServicesDialog.tsx')
const apiSource = read('src/services/ours/api.ts')
const transportSource = read('src/services/ours/transport.ts')
const zhSource = read('src/i18n/zh.ts')
const enSource = read('src/i18n/en.ts')

const SHOP_URL = 'https://wzyp.cn/shop/DIWOOHLR'
const SHOP_NOTE = '外部收款页：付款后由联动小铺直接发放卡密'

// 自查断言骨架走公共入口（#408 收尾批）。注意 `countBad: true`：这一族的 `bad` 也计一次检查，
// 与 ours-api / ours-invite 那 4 个文件的口径不同，末尾「共 N 项检查」的数按原样保留。
const { failures, checks, ok, bad, eq, truthy } = createSelfCheck({ countBad: true })

const cap = () => globalThis.__cap
const resetStubs = () => {
  const stub = cap()
  stub.native = true
  stub.browser.opens.length = 0
  stub.browser.listeners.length = 0
  stub.browser.rejectOpen = false
  stub.browser.removeCount = 0
}

/** 一个只回一次固定结果的传输层替身（记下收到的请求） */
const fakeTransport = (results) => {
  const calls = []
  const queue = [...results]
  return {
    calls,
    transport: async (request) => {
      calls.push(request)
      return queue.length > 1 ? queue.shift() : queue[0]
    },
  }
}
const response = (status, body) => ({
  kind: 'response',
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})

// ---------------------------------------------------------------- [A] fetchPayLink 正向
console.log('\n[A] fetchPayLink：GET /api/pay-link，200 才回地址')
{
  truthy(typeof api.fetchPayLink === 'function', 'api.ts 导出 fetchPayLink')
  eq(api.payLinkUrl(), `${api.OURS_API_BASE}/api/pay-link`, 'payLinkUrl() 拼的是 /api/pay-link')

  const { calls, transport: fake } = fakeTransport([
    response(200, { ok: true, url: SHOP_URL, note: SHOP_NOTE }),
  ])
  const state = await api.fetchPayLink(fake)
  eq(state.status, 'ok', '200 + ok:true → 可用')
  eq(state.status === 'ok' ? state.url : '', SHOP_URL, '把服务端给的地址原样交回界面')
  eq(state.status === 'ok' ? state.note : '', SHOP_NOTE, 'note 一并带回（说明「付款后小铺直接发卡密」）')

  const request = calls[0] ?? {}
  eq(request.method, 'GET', '只读接口用 GET')
  eq(request.url, `${api.OURS_API_BASE}/api/pay-link`, '请求地址就是 /api/pay-link')
  eq(request.headers?.Accept, 'application/json', '要 JSON（HTML 收银台不是这个接口）')
  eq(request.followRedirects, false, '不跟随跳转（跟着 302 会被带去别处）')
  eq(request.timeoutMs, api.OURS_TIMEOUTS.payLink, '超时用 payLink 那一档')
  truthy(request.timeoutMs <= 15000, '只读小接口的超时不超过 15s（不让用户干等）')
}

// ---------------------------------------------------------------- [B] 负向分支
console.log('\n[B] 负向分支：一律「收款通道暂不可用」，网络 / 超时另给可重试文案')
{
  const cases = [
    { label: '503 PAY_LINK_NOT_CONFIGURED', reply: response(503, { code: 'PAY_LINK_NOT_CONFIGURED', message: '收款页地址未配置' }) },
    { label: '500', reply: response(500, { message: 'boom' }) },
    { label: '200 + ok:false', reply: response(200, { ok: false }) },
    { label: '200 + 非法 JSON', reply: response(200, '<html>not json</html>') },
    { label: '200 + 没有 url', reply: response(200, { ok: true }) },
    { label: '200 + 明文 http 地址', reply: response(200, { ok: true, url: 'http://wzyp.cn/shop/DIWOOHLR' }) },
    { label: '200 + url 不是字符串', reply: response(200, { ok: true, url: 42 }) },
    { label: '200 + 空 url', reply: response(200, { ok: true, url: '   ' }) },
  ]
  for (const item of cases) {
    const { transport: fake } = fakeTransport([item.reply])
    const state = await api.fetchPayLink(fake)
    eq(
      state.status === 'error' ? state.messageKey : state.status,
      'oursPayUnavailable',
      `${item.label} → oursPayUnavailable（收款通道暂不可用）`
    )
  }

  const network = await api.fetchPayLink(async () => ({ kind: 'network', message: 'ECONNREFUSED' }))
  eq(network.status === 'error' ? network.messageKey : network.status, 'oursErrNetwork', '连不上 → 网络文案')

  const timeout = await api.fetchPayLink(async () => ({ kind: 'timeout' }))
  eq(timeout.status === 'error' ? timeout.messageKey : timeout.status, 'oursErrTimeout', '超时 → 可重试文案')

  // 只读接口：失败重试不会在服务端留下任何东西（不存在「重试 = 建单」的副作用）
  const { calls, transport: fake } = fakeTransport([response(503, {})])
  await api.fetchPayLink(fake)
  await api.fetchPayLink(fake)
  eq(calls.length, 2, '失败后可以重试（每次都是一次 GET，不写任何状态）')
  truthy(
    calls.every((item) => item.method === 'GET' && item.url.endsWith('/api/pay-link')),
    '重试仍然是同一个只读 GET /api/pay-link'
  )
}

// ---------------------------------------------------------------- [C] openPayLinkInApp 正向
console.log('\n[C] openPayLinkInApp：Browser.open + presentationStyle popover，关页面只回调一次')
{
  truthy(typeof transport.openPayLinkInApp === 'function', 'transport 导出 openPayLinkInApp')

  resetStubs()
  let closed = 0
  const opened = await transport.openPayLinkInApp(SHOP_URL, () => {
    closed += 1
  })
  eq(opened, true, '原生环境下打开成功 → 返回 true')
  eq(cap().browser.opens.length, 1, '调用了一次 @capacitor/browser 的 open')
  eq(cap().browser.opens[0]?.url, SHOP_URL, '打开的就是 /api/pay-link 给的地址')
  eq(cap().browser.opens[0]?.presentationStyle, 'popover', "presentationStyle: 'popover'（Issue #331 指定的写法）")
  eq(
    cap().browser.listeners.filter((item) => item.eventName === 'browserFinished').length,
    1,
    '先注册 browserFinished，再打开页面'
  )
  eq(closed, 0, '还没关页面，不回调')

  cap().browser.finish()
  eq(closed, 1, '用户关掉收款页 → 回调一次（界面据此刷新额度显示）')
  cap().browser.finish()
  eq(closed, 1, '重复触发也只回调一次')
  truthy(cap().browser.removeCount >= 1, '回调后立刻摘掉监听（不残留到下一次）')
}

// ---------------------------------------------------------------- [D] 打不开 / Web
console.log('\n[D] 打不开 / Web：返回 false，不崩、不整页跳走')
{
  resetStubs()
  const refused = await transport.openPayLinkInApp('http://wzyp.cn/shop/DIWOOHLR', () => {})
  eq(refused, false, '明文地址不打开（收银台/收款页必须 HTTPS）')
  eq(cap().browser.opens.length, 0, '明文地址没碰 @capacitor/browser')

  resetStubs()
  cap().browser.rejectOpen = true
  const broken = await transport.openPayLinkInApp(SHOP_URL, () => {})
  eq(broken, false, '插件打不开 → 返回 false 让界面提示（不抛错）')
  truthy(cap().browser.removeCount >= 1, '打开失败也摘掉监听（否则下次会多一次假回跳）')

  resetStubs()
  cap().native = false
  let closed = 0
  const web = await transport.openPayLinkInApp(SHOP_URL, () => {
    closed += 1
  })
  eq(web, false, 'Web（非原生）→ 返回 false（界面显示「没能在 App 内打开收款页」）')
  eq(cap().browser.opens.length, 0, 'Web 端不去碰 @capacitor/browser')
  eq(closed, 0, 'Web 端不会凭空触发回调')
  resetStubs()
}

// ---------------------------------------------------------------- [E] 源码体检
console.log('\n[E] 源码体检：不建单、不轮询、不写死地址、不出现「支付成功」')
{
  truthy(/\/api\/pay-link/u.test(apiSource), 'api.ts 里拼 /api/pay-link')
  truthy(!/wzyp\.cn|DIWOOHLR/u.test(apiSource), 'api.ts 没有写死收款页地址')
  truthy(!/wzyp\.cn|DIWOOHLR/u.test(transportSource), 'transport 没有写死收款页地址')
  truthy(!/wzyp\.cn|DIWOOHLR/u.test(dialogSource), '弹层没有写死收款页地址')
  truthy(!/createBuyOrder|pollOrder|startInAppPay/u.test(dialogSource), '弹层不再建单、不再轮询')
  truthy(!/\/api\/buy/u.test(dialogSource), '弹层里连 /api/buy 的地址都不再出现')
  truthy(!/window\.location|window\.open\(|<a\s[^>]*href=/u.test(dialogSource), '弹层里没有整页跳转 / window.open / <a href>')
  /** 只留代码行：注释里解释「不显示支付成功」是允许的，真渲染出来才算违规 */
  const codeOnly = (text) =>
    text
      .split(String.fromCharCode(10))
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
      })
      .join(String.fromCharCode(10))
  truthy(!codeOnly(dialogSource).includes('支付成功'), '界面文案里没有「支付成功」（没有订单可查，不能替小铺宣布成功）')
  truthy(!enSource.includes('Payment successful'), '英文文案里也没有「Payment successful」')
  truthy(dialogSource.includes('refreshBalance'), '关掉收款页只刷新额度显示（refreshBalance）')

  const pairs = [
    'oursPayTitle',
    'oursPayAction',
    'oursPayBusy',
    'oursPayEmpty',
    'oursPayHint',
    'oursPayUnavailable',
    'oursPayOpenFailed',
  ]
  for (const key of pairs) {
    truthy(
      new RegExp(`${key}:`, 'u').test(zhSource) && new RegExp(`${key}:`, 'u').test(enSource),
      `zh/en 都有 ${key}`
    )
  }
  truthy(zhSource.includes('收款通道暂不可用，请稍后再试'), '中文「收款通道暂不可用，请稍后再试」按 Issue 原文')
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

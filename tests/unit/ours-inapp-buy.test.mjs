// [layer: unit | 依赖: 无（纯 Node，零浏览器 / 零 React；Capacitor 与 @capacitor/browser 用替身） | 耗时: <1s]
// 支付切到联动小铺（Issue #331）之后，「App 内打开付款页」这条链路的单测。
//
// 背景：#235 那套「/api/buy 建单 → 内嵌收银台 → 关闭后轮询发卡」已经整条停用 ——
// 付款在联动小铺自己的收款页完成、卡密由小铺直接发给买家，我们**不建单、不轮询**。
// 所以本文件保留「内嵌浏览器 + browserFinished」这半条能力，并钉住「购买入口只打 /api/pay-link」。
//
// 目标：
//   [A] 源码体检：购买入口 = /api/pay-link + Browser.open；弹层里没有整页跳转、不建单、不轮询
//   [B] httpTransport：JSON 接口走 CapacitorHttp（不跟随重定向）
//   [D] openPayLinkInApp：关掉页面只回调一次；没插件 / 打开失败一律返回 false 不崩
//   [E] 停用建单链路：src 里没有任何路径还会打 /api/buy 或调用 pollOrder
//       （#331 收尾：连 /api/buy 的 JSON 契约与 orderStore 存档都删了，只剩「App 内打开收款页」）
//   [G] Web（非原生、没有 Browser）：不抛错、不白屏
//
// 跑法：node --test tests/unit/ours-inapp-buy.test.mjs（或 node tests/run-layer.mjs unit）
import { registerHooks } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const api = await import('../../src/services/ours/api.ts')
const transport = await import('../../src/services/ours/transport.ts')
const { CUSTOMER_ID_STORAGE_KEY } = await import('../../src/services/ours/customerId.ts')

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

// ---------------------------------------------------------------- [A] 源码体检
console.log('\n[A] 源码体检：购买入口 = /api/pay-link + Browser.open（#331）')
{
  truthy(/@capacitor\/browser/u.test(transportSource), '传输层引入了 @capacitor/browser（收款页在 App 内打开）')
  truthy(/browserFinished/u.test(transportSource), '传输层监听 browserFinished（用户关掉收款页 = 回到 App）')
  truthy(typeof transport.openPayLinkInApp === 'function', '传输层导出 openPayLinkInApp（App 内打开收款页）')
  truthy(/presentationStyle/u.test(transportSource) && /popover/u.test(transportSource), '用 presentationStyle: popover 打开（iOS 卡片式 / Android 全屏都在 App 内）')
  truthy(/\/api\/pay-link/u.test(apiSource), 'api.ts 调 /api/pay-link 取地址（不写死收款页地址）')
  truthy(typeof api.fetchPayLink === 'function', 'api.ts 导出 fetchPayLink（503 / ok:false / 非法 JSON 都转成可读文案）')
  truthy(!/wzyp\.cn\/shop/u.test(apiSource) && !/wzyp\.cn\/shop/u.test(dialogSource), '源码里没有写死的收款页地址')

  truthy(dialogSource.includes('fetchPayLink('), '「前往购买」现取地址（fetchPayLink）')
  truthy(dialogSource.includes('openPayLinkInApp('), '「前往购买」用 Browser.open 在 App 内打开')
  truthy(!/window\.location\.(href|assign|replace)/u.test(dialogSource), '弹层里没有 window.location 整页跳转')
  truthy(!/window\.open\(/u.test(dialogSource), '弹层里没有 window.open')
  truthy(!/<a\s[^>]*href=/u.test(dialogSource), '弹层里没有 <a href> 式的购买入口')
  truthy(!/createBuyOrder|pollOrder|startInAppPay/u.test(dialogSource), '弹层不再建单、不再轮询订单（/api/buy 与 pollOrder 的调用点已移除）')
  truthy(!dialogSource.includes('fetchPlans'), '弹层不再渲染套餐卡片（也不取 /api/plans）')
  truthy(dialogSource.includes("t('oursPayAction')"), '按钮文案走 i18n（oursPayAction）')
  truthy(dialogSource.includes("t('oursPayEmpty')"), '空态说明走 i18n（oursPayEmpty：列表为空也有说明，不是白屏）')
  truthy(dialogSource.includes("t('oursPayHint')"), '入口说明走 i18n（oursPayHint）')
  truthy(dialogSource.includes('data-testid="ours-plans-empty"'), '套餐列表区有明确空态块')
  truthy(dialogSource.includes('data-testid="ours-buy"'), '「前往购买」按钮还在（同一个 testid）')
  truthy(dialogSource.includes('data-testid="ours-pay-notice"'), '通道不可用的提示是可读状态行（不是 alert / 不是白屏）')
  truthy(
    /oursPayAction:/u.test(zhSource) && /oursPayAction:/u.test(enSource) &&
      /oursPayUnavailable:/u.test(zhSource) && /oursPayUnavailable:/u.test(enSource) &&
      /oursPayEmpty:/u.test(zhSource) && /oursPayEmpty:/u.test(enSource),
    'zh/en 都有 oursPayAction / oursPayEmpty / oursPayUnavailable（成对）'
  )
}

console.log('\n[B] 传输层：JSON 接口走 CapacitorHttp，不跟随重定向')
{
  resetStubs()
  cap().httpReply = () => ({ status: 200, data: JSON.stringify({ ok: true, url: PAY_URL }), headers: {} })
  const result = await transport.httpTransport({
    method: 'GET',
    url: 'https://apia.ecsafe.cn/api/pay-link',
    headers: { Accept: 'application/json' },
    timeoutMs: 10000,
    followRedirects: false,
  })
  eq(cap().http.length, 1, 'GET /api/pay-link 走了 CapacitorHttp（有正文可解析）')
  truthy(result.kind === 'response' && result.text.includes('https://'), '正文原样回到调用方')
  eq(cap().locations.length, 0, '业务接口不再走 CheckoutBrowser.resolveLocation（那条通路已随 /buy 删除）')

  // 302 也不许被跟随：状态码与 Location 原样交给调用方自己解释
  resetStubs()
  cap().httpReply = () => ({ status: 302, data: '', headers: { Location: 'https://pay.example.com/x' } })
  const redirected = await transport.httpTransport({
    method: 'GET',
    url: 'https://apia.ecsafe.cn/api/pay-link',
    headers: { Accept: 'application/json' },
    timeoutMs: 10000,
    followRedirects: false,
  })
  eq(redirected.kind === 'response' ? redirected.status : -1, 302, '不跟随重定向（302 原样回来）')
}

// ---------------------------------------------------------------- [C] createBuyOrder
console.log('\n[C] openPayLinkInApp：关掉收款页回调一次，缺能力就降级')
if (typeof transport.openPayLinkInApp !== 'function') {
  bad('缺少 transport.openPayLinkInApp：购买页无法在 App 内打开收款页')
  bad('缺少 browserFinished 监听：用户关掉收款页后界面收不到「回来了」的信号')
  bad('缺少打不开时返回 false：界面只能给错误提示，不能整页跳走')
} else {
  resetStubs()
  let closed = 0
  const opened = await transport.openPayLinkInApp(PAY_URL, () => {
    closed += 1
  })
  eq(opened, true, '原生环境下在 App 内打开成功')
  eq(cap().browser.opens.length, 1, '调用了 @capacitor/browser 的 open（App 内打开）')
  eq(cap().browser.opens[0]?.url, PAY_URL, '打开的就是 pay_url')
  eq(cap().browser.listeners.filter((item) => item.eventName === 'browserFinished').length, 1, '注册了 browserFinished 监听')
  eq(cap().opened.length, 0, '没有再把用户踢去系统浏览器')
  cap().browser.finish()
  eq(closed, 1, '关掉收款页 → 回调一次（界面据此收起忙碌态）')
  cap().browser.finish()
  eq(closed, 1, 'browserFinished 重复触发也只回跳一次')
  truthy(cap().browser.removeCount >= 1, '回跳后立刻摘掉监听（不残留到下一次支付）')

  resetStubs()
  const refused = await transport.openPayLinkInApp('http://pay.example.com/x', () => {})
  eq(refused, false, '明文地址不打开')

  resetStubs()
  cap().browser.rejectOpen = true
  const broken = await transport.openPayLinkInApp(PAY_URL, () => {})
  eq(broken, false, '内嵌浏览器打不开 → 返回 false 让调用方降级（不抛错）')
  cap().browser.finish()
  truthy(cap().browser.removeCount >= 1, '打开失败后也摘掉监听（否则下次打开会多一次假回跳）')
  eq(closed, 1, '打开失败不会凭空回跳')
}

// ---------------------------------------------------------------- [E] 停用建单链路
console.log('\n[D] 停用建单链路：src 里没有任何路径还会打 /api/buy 或调用 pollOrder')
{
  const walk = (dir) => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (/\.(ts|tsx)$/u.test(entry.name)) out.push(full)
    }
    return out
  }
  const srcRoot = fileURLToPath(new URL('../../src', import.meta.url))
  const files = walk(srcRoot)
  const rel = (full) => path.relative(srcRoot, full).split(path.sep).join('/')
  const hits = (pattern) =>
    files
      .map((full) => ({ file: rel(full), text: readFileSync(full, 'utf8') }))
      .filter((item) => pattern.test(item.text))
      .map((item) => item.file)
      .sort()

  // 调用点：除 api.ts 自己的定义之外，谁都不许再建单 / 轮询
  /** 只留代码行：注释 / 文档串里提到某个地址不算「还在调」 */
  const codeOnly = (text) =>
    text
      .split(String.fromCharCode(10))
      .filter((line) => {
        const trimmed = line.trim()
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
      })
      .join(String.fromCharCode(10))
  const sources = files.map((full) => ({
    file: rel(full),
    code: codeOnly(readFileSync(full, 'utf8')),
  }))
  const callers = (name) =>
    sources
      .filter((item) => item.code.includes(`${name}(`))
      .map((item) => item.file)
      .filter((file) => file !== 'services/ours/api.ts')
  eq(callers('createBuyOrder'), [], '没有 src 路径再调用 createBuyOrder（/api/buy 的建单入口已断开）')
  eq(callers('pollOrder'), [], '没有 src 路径再调用 pollOrder（不再轮询订单）')
  eq(callers('startInAppPay'), [], '没有 src 路径再调用 startInAppPay（编排模块已删除）')
  eq(
  eq(
    callers('/api/buy'),
    [],
    'src 里已经没有任何一处写 /api/buy（连历史契约都删了）'
  )
  )
  truthy(
    !existsSync(path.join(srcRoot, 'services/ours/inAppPay.ts')),
    'services/ours/inAppPay.ts 已删除（建单 → 收银台 → 轮询的编排不再存在）'
  )
  eq(
    sources.filter((item) => item.code.includes('/api/pay-link')).map((item) => item.file),
    ['services/ours/api.ts'],
    '/api/pay-link 只在 api.ts 里拼（界面拿到的是现取的地址，不自己拼 URL）'
  )
  eq(
    sources.filter((item) => item.code.includes('apia.ecsafe.cn')).map((item) => item.file).filter((file) => file.startsWith('components/')),
    [],
    '组件里没有写死服务端地址（一律走 services 层）'
  )
}

// ---------------------------------------------------------------- [G] Web 降级
console.log('\n[E] Web（非原生 / 没有 Browser 插件）：不崩、不碰不存在的桥')
if (typeof transport.openPayLinkInApp !== 'function') {
  bad('缺少 transport.openPayLinkInApp：Web 端无从验证降级')
} else {
  resetStubs()
  cap().native = false
  let closed = 0
  const opened = await transport.openPayLinkInApp(PAY_URL, () => {
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

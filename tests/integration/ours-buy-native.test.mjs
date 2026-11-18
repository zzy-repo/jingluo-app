/**
 * Issue #142：App（原生）里点「去支付」提示「请求过于频繁，请稍后重试」。
 *
 * 这个用例只做一件事：把「App 点『去支付』这一下，到底是谁去敲 /buy、敲了几次、
 * 拿回来的状态码来自哪一跳」量出来。
 *
 * 三个场景（同一个构建产物、同一套打桩后端）：
 *   [W] 网页版：顶层导航到 /buy?plan=&cid= —— 页面自己不发任何 /buy 请求
 *   [N1] 原生 + 客户端跟随了 302（CapacitorHttp 的 web 实现不读 disableRedirects，
 *        @capacitor/core 8.6.2 dist/index.cjs.js 里 buildRequestInit 只透传 method/headers/body）
 *        → 拿回来的是**网关那一跳**的状态码；网关 429 就被渲染成「请求过于频繁」
 *   [N2] 原生 + 服务端真的返回 429（/buy 自己限流）→ 这条仍然必须显示频率提示
 *
 * 打桩说明（不许写成真机通过）：
 *  - `window.Capacitor` 是**在浏览器里模拟安卓桥**（androidBridge + PluginHeaders + nativePromise），
 *    用来复现「JS 侧走原生分支」的调用顺序；真机 Java 插件未参与。
 *  - 网关的 429 是桩数据，绝不打真实收银台/网关（不能建真单）。
 *  - [N1] 的「跟随 302」按 CapacitorHttp **web 实现**的行为建模（不读 disableRedirects），
 *    真机上是否跟随取决于设备，这一条属于未测边界，见 docs/ui/issue142/README.md。
 *
 * 用法（需要先构建标准产物）：
 *   DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
 *   node tests/integration/ours-buy-native.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const SHOT_DIR = path.join(ROOT, 'docs/ui/issue142')

const CARD_API = 'https://apia.ecsafe.cn'
const INVITE_API = 'http://140.210.13.146:60013'
const PAY_HOST = 'https://pay.xiaodouap.cn'
const CHECKOUT_URL =
  `${PAY_HOST}/submit.php?money=1.00&name=${encodeURIComponent('新人特惠 1 元额度')}` +
  '&out_trade_no=CP20261118231003NEWBIE&order_token=tok-142-native'
const CID = 1024
const CUSTOMER_KEY = 'chat-demo:ours-customer-id'
const PLAN_NAME = '新人特惠 1 元额度'
/** 未出错时 ours-pay-notice 显示的是默认说明（zh.ts:442 / 443），出错时被错误文案替换 */
const HINT_NATIVE = '支付在系统浏览器里完成（支付宝），回到 App 自动查单。价格与积分由服务端下发。'
const RATE_MSG = '请求过于频繁，请稍后重试'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
}

const failures = []
let passed = 0
const eq = (actual, expected, label) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`)
  }
}
const truthy = (value, label) => {
  if (value) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}`)
  }
}

const PLANS = {
  plans: [{ id: 'newbie', name: PLAN_NAME, price: 1.0, points: 500, currency: 'CNY', enabled: true }],
}

const json = (status, body) => ({
  status,
  headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
})

/**
 * 后端桩 + 原生桥桩。`mode` 决定「这一下 /buy 的 429 从哪来」：
 *  - 'web'     网页版：/buy 直接回一页收银台（顶层导航，不需要读 Location）
 *  - 'follow'  原生 + 客户端跟随 302 → 拿回网关那一跳的 429
 *  - 'server'  原生 + /buy 自己回 429（真正的服务端限流）
 *  - 'ok'      原生 + /buy 回 302 + Location（正常路径）
 */
const wire = async (page, mode) => {
  const calls = { buy: 0, plans: 0 }

  await page.route(`${CARD_API}/api/plans**`, async (route) => {
    calls.plans += 1
    await route.fulfill(json(200, PLANS))
  })
  await page.route(`${CARD_API}/buy**`, async (route) => {
    calls.buy += 1
    if (mode === 'web') {
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
        body: '<html><body><h1>支付宝收银台（桩页）</h1></body></html>',
      })
      return
    }
    if (mode === 'server') {
      await route.fulfill(json(429, { code: 'RATE_LIMITED', message: '请求过于频繁', request_id: 'rid-429' }))
      return
    }
    await route.fulfill({ status: 302, headers: { ...CORS, location: CHECKOUT_URL }, body: '' })
  })
  // 任何其它打到服务端的请求都当成「不该发生」记下来
  await page.route(`${CARD_API}/**`, async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/plans' || url.pathname === '/buy') {
      await route.fallback()
      return
    }
    await route.fulfill(json(404, { code: 'NOT_FOUND', message: 'no such path', request_id: 'rid' }))
  })
  await page.route(`${INVITE_API}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    await route.fulfill(json(404, { error: { code: 'not_found', message: 'no such path' } }))
  })
  await page.route(`${PAY_HOST}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>支付宝收银台（桩页）</h1></body></html>',
    })
  })

  return calls
}

/**
 * 在浏览器里搭一座安卓桥。
 *
 * `getPlatformId()` 只认 `window.androidBridge`（@capacitor/core 8.6.2 dist:975），
 * 有它 `isNativePlatform()` 才是 true；`PluginHeaders` 决定 registerPlugin 走
 * `cap.nativePromise`（内核 dist:4179）而不是 JS 实现。
 */
const nativeBridge = (mode) => {
  window.androidBridge = {}
  window.__nativeCalls = []
  window.__opened = []
  window.__fetches = []
  window.__checkoutUrl = window.__checkoutUrlStub
  const originalFetch = window.fetch
  window.fetch = function patched(input, init) {
    window.__fetches.push(String(input && input.url ? input.url : input))
    return originalFetch.call(this, input, init)
  }
  window.Capacitor = {
    PluginHeaders: [
      { name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] },
      {
        name: 'CheckoutBrowser',
        methods: [
          { name: 'open', rtype: 'promise' },
          { name: 'resolveLocation', rtype: 'promise' },
        ],
      },
    ],
    nativePromise(name, method, options = {}) {
      window.__nativeCalls.push({ name, method, url: String(options.url ?? ''), disableRedirects: options.disableRedirects })
      if (name === 'CapacitorHttp' && method === 'request') {
        const url = String(options.url ?? '')
        if (!/\/buy(?:\?|$)/u.test(url)) {
          // 其它业务请求（/api/plans 等）照旧真打桩后端，保持业务可用
          return fetch(url, { method: options.method ?? 'GET', headers: options.headers }).then(async (response) => ({
            status: response.status,
            headers: {},
            url: response.url,
            data: await response.text(),
          }))
        }
        if (window.__mode === 'follow') {
          // CapacitorHttp 的 web 实现不读 disableRedirects，用默认（跟随）语义 →
          // 拿回来的是**网关那一跳**的状态码，不是 /buy 的 302。
          return Promise.resolve({
            status: 429,
            headers: {},
            url: `${payHost}/submit.php?out_trade_no=CP20261118231003NEWBIE`,
            data: '{"code":"RATE_LIMITED","message":"请求过于频繁"}',
          })
        }
        return Promise.resolve({ status: 302, headers: { location: window.__checkoutUrl }, data: '', url: options.url })
      }
      if (name === 'CheckoutBrowser' && method === 'resolveLocation') {
        if (window.__mode === 'server-429') {
          return Promise.resolve({ status: 429, location: '' })
        }
        return Promise.resolve({ status: 302, location: window.__checkoutUrl })
      }
      if (name === 'CheckoutBrowser' && method === 'open') {
        window.__opened.push(String(options.url ?? ''))
        return Promise.resolve({ opened: true })
      }
      return Promise.resolve({})
    },
  }
}

const boot = async (page, baseUrl) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.localStorage.setItem('chat-demo:provider-kind', 'ours')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
}

const openBuyPanel = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    const settingsButton = page.getByRole('button', { name: /设置|Settings/ }).last()
    if (!(await settingsButton.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /打开边栏|Expand sidebar/ }).first().click()
      await page.waitForTimeout(500)
    }
    await settingsButton.click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByTestId('ours-services-open').click()
  await page.getByTestId('ours-services-dialog').waitFor({ state: 'visible' })
  await page.getByTestId('ours-plans').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(200)
}

const noticeText = async (page) => {
  const notice = page.getByTestId('ours-pay-notice')
  return (await notice.count()) === 0 ? '' : (await notice.innerText()).trim()
}

const newPage = async (context, mode) => {
  const page = await context.newPage()
  await page.addInitScript(([key, cid]) => window.localStorage.setItem(key, String(cid)), [CUSTOMER_KEY, CID])
  await page.addInitScript(`window.__checkoutUrlStub = ${JSON.stringify(CHECKOUT_URL)}; window.__mode = ${JSON.stringify(mode)}; window.payHost = ${JSON.stringify(PAY_HOST)}`)
  await page.addInitScript(nativeBridge, mode)
  return page
}

const run = async (browser, baseUrl) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  // ---------------- [W] 网页版：顶层导航，页面不发 /buy 请求 ----------------
  for (const width of [390, 360]) {
    console.log(`
[W${width}] 网页版点「去支付」= 浏览器顶层导航（${width}px）`)
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width, height: width === 390 ? 844 : 800 },
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    await wire(page, 'web')
    await page.addInitScript(([key, cid]) => window.localStorage.setItem(key, String(cid)), [CUSTOMER_KEY, CID])
    await boot(page, baseUrl)
    await openBuyPanel(page)

    eq(
      (await page.getByTestId('ours-plans').innerText()).includes(PLAN_NAME),
      true,
      `[${width}] 套餐名来自 /api/plans：${PLAN_NAME}`
    )
    await page.screenshot({ path: path.join(SHOT_DIR, `issue142-panel-${width}.png`) })

    const seen = []
    page.on('request', (request) => seen.push({ url: request.url(), type: request.resourceType() }))
    const nav = page.waitForURL(/\/buy\?/, { timeout: 15000 })
    await page.getByTestId('ours-buy').click()
    await nav
    await page.waitForLoadState('domcontentloaded')

    const buyHits = seen.filter((item) => item.url.includes('/buy'))
    const buyUrl = new URL(buyHits[0]?.url ?? 'https://x/buy')
    eq(buyHits.map((item) => item.type), ['document'], `[${width}] /buy 只有一次顶层导航（document），没有 fetch`)
    eq(
      buyHits.filter((item) => item.type !== 'document').length,
      0,
      `[${width}] 页面自己没对 /buy 发过 fetch/xhr`
    )
    eq(buyUrl.searchParams.get('plan'), 'newbie', `[${width}] /buy 带 plan=newbie`)
    eq(buyUrl.searchParams.get('cid'), String(CID), `[${width}] /buy 带 cid=1024`)
    truthy(
      (await page.getByText('支付宝收银台', { exact: false }).count()) > 0,
      `[${width}] 落在收银台桩页（能进入收银台）`
    )
    eq(
      await page.evaluate(() => document.body.innerText.includes('请求过于频繁')),
      false,
      `[${width}] 没有频率提示`
    )
    await page.screenshot({ path: path.join(SHOT_DIR, `issue142-cashier-${width}.png`) })
    await context.close()
  }

  // ---------------- [N1] 原生：客户端跟随 302 → 拿回网关 429 ----------------
  {
    console.log('\n[N1] 原生 + 客户端跟随 302（CapacitorHttp web 实现行为）→ 网关 429')
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
    const page = await newPage(context, 'follow')
    const calls = await wire(page, 'follow')
    await boot(page, baseUrl)
    await openBuyPanel(page)
    await page.getByTestId('ours-buy').click()
    await page.waitForTimeout(1200)
    const nativeCalls = await page.evaluate(() => window.__nativeCalls)
    const opened = await page.evaluate(() => window.__opened)
    const notice = await noticeText(page)
    console.log(`  · App 侧原生调用：${JSON.stringify(nativeCalls.map((item) => `${item.name}.${item.method}`))}`)
    console.log(`  · 提示文案：${JSON.stringify(notice)}`)
    console.log(`  · 已打开收银台：${JSON.stringify(opened)}`)
    eq(
      nativeCalls.filter((item) => item.name === 'CapacitorHttp' && /\/buy(?:\?|$)/u.test(item.url)).length,
      0,
      'App 不对 /buy 发程序化 HTTP 请求（拿不到第三跳的状态码）'
    )
    eq(notice.includes('请求过于频繁'), false, `提示里没有「请求过于频繁」（实际：${notice}）`)
    eq(notice, HINT_NATIVE, '提示仍是默认说明（没有把网关状态当成下单结果）')
    eq(opened, [CHECKOUT_URL], '系统浏览器打开了 /buy 下发的收银台地址')
    eq(
      nativeCalls.filter((item) => /\/buy(?:\?|$)/u.test(item.url)).length,
      1,
      '只对 /buy 发一次原生请求（每次 GET 都建单）'
    )
    await context.close()
  }

  // ---------------- [N2] 原生：/buy 自己回 429（真限流） ----------------
  {
    console.log('\n[N2] 原生 + /buy 自己回 429（服务端限流仍然要提示）')
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
    const page = await newPage(context, 'server-429')
    const calls = await wire(page, 'server')
    await boot(page, baseUrl)
    await openBuyPanel(page)
    await page.getByTestId('ours-buy').click()
    await page.waitForTimeout(1200)
    const notice = await noticeText(page)
    const opened = await page.evaluate(() => window.__opened)
    console.log(`  · 提示文案：${JSON.stringify(notice)}`)
    eq(notice, RATE_MSG, '真正的 429 仍然显示频率提示（不把限流吞成别的错误）')
    eq(opened, [], '不打开收银台')
    eq(
      (await page.evaluate(() => window.__nativeCalls)).filter((item) => /\/buy(?:\?|$)/u.test(item.url)).length,
      1,
      '只对 /buy 发一次原生请求（不重试、不连点放大）'
    )
    await context.close()
  }

  // ---------------- [N3] 原生：正常 302 → 一次请求、直接打开收银台 ----------------
  {
    console.log('\n[N3] 原生 + 正常 302 → 一次请求打开收银台')
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 })
    const page = await newPage(context, 'ok')
    const calls = await wire(page, 'ok')
    await boot(page, baseUrl)
    await openBuyPanel(page)
    await page.getByTestId('ours-buy').click()
    await page.waitForTimeout(1200)
    const nativeCalls = await page.evaluate(() => window.__nativeCalls)
    const opened = await page.evaluate(() => window.__opened)
    const notice = await noticeText(page)
    const resolve = nativeCalls.filter((item) => item.method === 'resolveLocation')
    console.log(`  · App 侧原生调用：${JSON.stringify(nativeCalls.map((item) => `${item.name}.${item.method}`))}`)
    eq(resolve.length, 1, '取 302 只发一次原生请求')
    truthy(resolve[0]?.url.includes('plan=newbie'), `取 302 的地址带 plan=newbie（${resolve[0]?.url}）`)
    truthy(resolve[0]?.url.includes(`cid=${CID}`), '取 302 的地址带 cid=1024')
    eq(opened, [CHECKOUT_URL], '系统浏览器打开收银台')
    eq(notice, HINT_NATIVE, `没有错误提示（实际：${notice}）`)
    eq(
      nativeCalls.filter((item) => /\/buy(?:\?|$)/u.test(item.url) && item.url.includes('cid=')).length,
      1,
      '只对 /buy 发一次带 cid 的原生请求（每次 GET 都会建单，绝不能多打）'
    )
    await context.close()
  }
}

const main = async () => {
  const server = await serveDist(DIST)
  const browser = await chromium.launch()
  try {
    await run(browser, server.url)
  } finally {
    await browser.close()
    await server.close()
  }
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    console.log('失败项：')
    for (const item of failures) console.log(` - ${item}`)
    process.exitCode = 1
  }
}

await main()

/**
 * Issue #157（P0）：重新下单没覆盖本地单号，付款成功后界面一直「等待支付」。
 *
 * 真实案例（Issue 原文，服务端两天的账）：
 *   CP202611182105334E806605   CREATED    ← App 一直轮询这一单（未支付）
 *   CP202611182359489D46C638   FULFILLED  ← 实际付款的是这单，卡已发出（MUSE-3CYP-5NA3-AHSE-A3SR）
 * 本文件就把这两笔单搬进桩后端：第一次「去支付」建 A（不付），第二次建 B（付）。
 *
 * 四个场景（同一套构建产物、同一套打桩后端）：
 *   [1] App 连下两单：存档必须被第二单**覆盖**；第二次点「去支付」之后 /api/order
 *       **一次都不许再问第一单**；界面显示第二单的卡密与单号尾号；并给出「上一笔未支付订单已失效」
 *   [2] 服务端兜底字段 latest_fulfilled：查的单还是 pending，但带了同 customer 最近一笔已完成订单
 *       → 界面直接展示那张卡 + 「你还有一笔已完成的订单」 + 一键兑换
 *   [3] 网页版回跳：顶层导航拿不到 Location，单号只能靠 ?no=&order_token= 回来时才拿到 →
 *       回跳参数到达时必须覆盖存档，并按新单号查单
 *   [4] 别的上下文（另一个标签页）写了新存档 → 正在轮询的弹层必须切到最新存档（不许守着旧闭包）
 *
 * 打桩说明（不许写成真机通过）：
 *  - `window.Capacitor` 是**在浏览器里模拟安卓桥**（androidBridge + PluginHeaders + nativePromise），
 *    用来复现「JS 侧走原生分支」的调用顺序；真机 Java 插件未参与。
 *  - 收银台、/api/order、/api/redeem、/redeem-card 全是桩数据，**绝不建真单、绝不打真收银台**。
 *
 * 用法（需要先构建标准产物）：
 *   DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
 *   node tests/integration/ours-order-overwrite.test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const SHOT_DIR = path.join(ROOT, 'docs/ui/issue157')

const CARD_API = 'https://apia.ecsafe.cn'
const INVITE_API = 'http://140.210.13.146:60013'
const PAY_HOST = 'https://pay.xiaodouap.cn'
const CID = 1024
const CUSTOMER_KEY = 'chat-demo:ours-customer-id'
const ORDER_KEY = 'chat-demo:ours-order'
const API_KEY_LOCAL = 'chat-demo:api-key'
const PLAN_NAME = '新人特惠 1 元额度'

/** Issue #157 的真实单号（前两笔）+ 案例二里的第 4 单 */
const FIRST_UNPAID = 'CP202611182105334E806605'
const PAID_ORDER = 'CP202611182359489D46C638'
const CASE2_UNPAID = 'CP2026111823581700C03415'
const OTHER_UNPAID = 'CP20261118235625EBB20C88'
const PAID_CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
const PAID_CARD_TAIL = 'A3SR'

const MSG_PENDING = '待支付'
const TEXT_REPLACED = '上一笔未支付订单已失效'
const TEXT_LATEST = '你还有一笔已完成的订单'
const TEXT_FULFILLED = '已发卡'

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
const note = (line) => console.log(`  ·  ${line}`)

const PLANS = {
  plans: [{ id: 'newbie', name: PLAN_NAME, price: 1.0, points: 500, currency: 'CNY', enabled: true }],
}
const json = (status, body) => ({
  status,
  headers: { ...CORS, 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
})

/** 收银台地址：真实格式（out_trade_no 在收银台地址上，order_token 在 return_url 里） */
const checkoutUrl = (no, token) =>
  `${PAY_HOST}/submit.php?pid=10268375&type=alipay&out_trade_no=${no}&money=1.00` +
  `&return_url=${encodeURIComponent(`${CARD_API}/return?no=${no}&order_token=${token}`)}`

const pendingBody = (no, extra = {}) => ({
  out_trade_no: no,
  status: 'pending',
  amount_fen: 100,
  customer_id: String(CID),
  card_no: null,
  expire_at: 1795019285,
  message: MSG_PENDING,
  ...extra,
})

const fulfilledBody = (no, extra = {}) => ({
  out_trade_no: no,
  status: 'fulfilled',
  amount_fen: 100,
  customer_id: String(CID),
  card_no: PAID_CARD,
  expire_at: 1795019285,
  message: '已发卡',
  ...extra,
})

/**
 * 桩后端。`answer(no, nth)` 决定第 nth 次查这一单回什么；`state.phase` 由用例侧手动推进，
 * 用来精确断言「第二次下单之后有没有再问第一单」。
 */
const wire = async (page, plan) => {
  const state = { queries: [], buyHits: 0, redeem: [], phase: 'idle', seen: {} }

  await page.route(`${CARD_API}/api/plans**`, async (route) => {
    await route.fulfill(json(200, PLANS))
  })
  await page.route(`${CARD_API}/api/order**`, async (route) => {
    const url = new URL(route.request().url())
    const no = url.searchParams.get('out_trade_no') ?? ''
    state.seen[no] = (state.seen[no] ?? 0) + 1
    state.queries.push({
      no,
      token: url.searchParams.get('order_token') ?? '',
      phase: state.phase,
      nth: state.seen[no],
    })
    await route.fulfill(json(200, plan.answer(no, state.seen[no])))
  })
  await page.route(`${CARD_API}/api/balance**`, async (route) => {
    await route.fulfill(json(200, { api_key: '…013812', valid: true }))
  })
  await page.route(`${CARD_API}/api/redeem**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    state.redeem.push({ via: 'legacy', body: route.request().postData() ?? '' })
    await route.fulfill(json(200, { ok: true, card_no: PAID_CARD, points: 500, sync: true }))
  })
  await page.route(`${CARD_API}/buy**`, async (route) => {
    state.buyHits += 1
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>支付宝收银台（桩页）</h1></body></html>',
    })
  })
  // 邀请服务的兜底 404 必须**先**注册：Playwright 里后注册的路由优先匹配
  await page.route(`${INVITE_API}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    await route.fulfill(json(404, { error: { code: 'not_found', message: 'no such path' } }))
  })
  await page.route(`${INVITE_API}/redeem-card**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (plan.poolMissing === true) {
      // 池这条路由不存在 → 兑换逻辑退回旧接口 /api/redeem（那里才带 request_id）
      await route.fulfill(json(404, {}))
      return
    }
    state.redeem.push({ via: 'pool', body: route.request().postData() ?? '' })
    await route.fulfill(json(200, { ok: true, points: 500, quota_points: 500, remaining_points: 500, duplicate: false }))
  })
  await page.route(`${PAY_HOST}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>支付宝收银台（桩页）</h1></body></html>',
    })
  })
  return state
}

/**
 * 浏览器里的安卓桥：`resolveLocation` 每次返回**下一张**收银台地址（= 每次 /buy 建一张新单）。
 */
const nativeBridge = (checkouts) => {
  window.androidBridge = {}
  window.__opened = []
  window.__resolved = []
  let index = 0
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
      if (name === 'CapacitorHttp' && method === 'request') {
        const url = String(options.url ?? '')
        return fetch(url, {
          method: options.method ?? 'GET',
          headers: options.headers,
          body: typeof options.data === 'string' ? options.data : undefined,
        }).then(async (response) => ({
          status: response.status,
          headers: {},
          url: response.url,
          data: await response.text(),
        }))
      }
      if (name === 'CheckoutBrowser' && method === 'resolveLocation') {
        const location = checkouts[index] ?? checkouts[checkouts.length - 1] ?? ''
        index += 1
        window.__resolved.push(location)
        return Promise.resolve({ status: 302, location })
      }
      if (name === 'CheckoutBrowser' && method === 'open') {
        window.__opened.push(String(options.url ?? ''))
        return Promise.resolve({ opened: true })
      }
      return Promise.resolve({})
    },
  }
}

const seed = ([keys]) => {
  window.localStorage.setItem('chat-demo:provider-kind', 'ours')
  window.localStorage.setItem(keys.customer, String(keys.cid))
  window.localStorage.setItem(keys.apiKey, 'sk-test-157-nobody-real')
  if (keys.order !== null) {
    window.localStorage.setItem(keys.orderKey, JSON.stringify(keys.order))
  }
}

const readStore = (page) =>
  page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (raw === null) {
      return null
    }
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }, ORDER_KEY)

const boot = async (page, baseUrl) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
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

const textOf = async (page, testId) => {
  const node = page.getByTestId(testId)
  return (await node.count()) === 0 ? '' : (await node.innerText()).trim()
}

const waitFor = async (page, testId, timeout = 25000) => {
  try {
    await page.getByTestId(testId).waitFor({ state: 'visible', timeout })
    return true
  } catch {
    return false
  }
}

const newContext = async (browser, width, height) =>
  browser.newContext({ locale: 'zh-CN', viewport: { width, height }, deviceScaleFactor: 2 })

const withBridge = async (page, checkouts, order = null) => {
  await page.addInitScript(nativeBridge, checkouts)
  await page.addInitScript(seed, [{ customer: CUSTOMER_KEY, cid: CID, apiKey: API_KEY_LOCAL, orderKey: ORDER_KEY, order }])
}

const shot = async (page, name, width) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const file = path.join(SHOT_DIR, `issue157-${name}-${width}.png`)
  await page.screenshot({ path: file })
  note(`截图 ${path.relative(ROOT, file)}`)
}

// ---------------------------------------------------------------- [1] App 连下两单

const scenarioOverwrite = async (browser, baseUrl, width, height) => {
  console.log(`\n[1] App 连下两单：第二单覆盖存档 + 轮询只跟第二单（${width}px）`)
  const context = await newContext(browser, width, height)
  const page = await context.newPage()
  await withBridge(page, [checkoutUrl(FIRST_UNPAID, 'tok-first-157'), checkoutUrl(PAID_ORDER, 'tok-paid-157')])
  const state = await wire(page, {
    answer: (no, nth) => {
      if (no === PAID_ORDER) {
        // 第二单：头几次查还是 pending（用户刚跳到收银台），第 4 次起已发卡
        return nth <= 3 ? pendingBody(no) : fulfilledBody(no)
      }
      return pendingBody(no)
    },
  })
  await boot(page, baseUrl)
  await openBuyPanel(page)

  // ---- 第一次「去支付」：建 A（不付）
  await page.getByTestId('ours-buy').click()
  await page.waitForTimeout(2600)
  const afterFirst = await readStore(page)
  eq(afterFirst?.outTradeNo, FIRST_UNPAID, `[${width}] 第一单建好后存档是 A：${afterFirst?.outTradeNo ?? '(空)'}`)
  eq(
    state.queries.every((item) => item.no === FIRST_UNPAID),
    true,
    `[${width}] 第一单期间只查 A（实际 ${JSON.stringify([...new Set(state.queries.map((q) => q.no))])}）`
  )
  await shot(page, '01-first-order-pending', width)

  // ---- 第二次「去支付」：建 B（付）
  state.phase = 'after-second-buy'
  await page.getByTestId('ours-buy').click()
  await page.waitForTimeout(500)
  const afterSecond = await readStore(page)
  eq(afterSecond?.outTradeNo, PAID_ORDER, `[${width}] 第二次下单后存档被覆盖成 B（不是追加）：${afterSecond?.outTradeNo ?? '(空)'}`)
  eq(afterSecond?.orderToken, 'tok-paid-157', `[${width}] 存档里的令牌也换成第二单的`)

  const sawCard = await waitFor(page, 'ours-order-card', 30000)
  const cardText = await textOf(page, 'ours-order-card')
  truthy(sawCard && cardText.includes(PAID_CARD_TAIL), `[${width}] 界面显示第二单的卡密（实际：${cardText || '(没有卡密区块)'}）`)
  eq(await textOf(page, 'ours-order-status'), TEXT_FULFILLED, `[${width}] 订单状态是「已发卡」`)
  const noText = await textOf(page, 'ours-order-no')
  truthy(noText.includes(PAID_ORDER.slice(-8)), `[${width}] 订单区显示的是第二单的单号（实际：${noText || '(没有单号)'}）`)
  truthy(!noText.includes(FIRST_UNPAID.slice(-8)), `[${width}] 订单区没有停在被付款的那单上`)
  const replacedText = await textOf(page, 'ours-order-replaced')
  truthy(replacedText.includes(TEXT_REPLACED), `[${width}] 覆盖时提示「${TEXT_REPLACED}」（实际：${replacedText || '(没有提示)'}）`)

  const lateQueries = state.queries.filter((item) => item.phase === 'after-second-buy')
  const stale = lateQueries.filter((item) => item.no === FIRST_UNPAID)
  truthy(
    lateQueries.length > 0,
    `[${width}] 第二单确实在轮询（${lateQueries.length} 次 /api/order）`
  )
  eq(
    stale.length,
    0,
    `[${width}] 第二次下单之后再没问过第一单（实际 ${stale.length} 次，共 ${JSON.stringify(
      [...new Set(lateQueries.map((item) => item.no))]
    )}）`
  )
  // 付款成功之后必须**保持**已发卡：旧轮询不许把它翻回「待支付」
  await page.waitForTimeout(5000)
  const cardAfter5s = await page.getByTestId('ours-order-card').count()
  eq(cardAfter5s, 1, `[${width}] 5 秒后卡密还在（旧轮询没把界面翻回「待支付」）`)
  eq(await textOf(page, 'ours-order-status'), TEXT_FULFILLED, `[${width}] 5 秒后状态仍是「已发卡」`)
  eq(await readStore(page), null, `[${width}] 已发卡后存档清空（存档只为未完成订单保留）`)
  await page
    .getByTestId('ours-order-status')
    .scrollIntoViewIfNeeded({ timeout: 3000 })
    .catch(() => note('订单区块滚不到的截图（修复前就是这样）'))
  await page.waitForTimeout(250)
  await shot(page, '02-second-order-fulfilled', width)
  await context.close()
  return state
}

// ---------------------------------------------------------------- [2] latest_fulfilled

const scenarioLatestFulfilled = async (browser, baseUrl, width, height) => {
  console.log(`\n[2] 服务端兜底 latest_fulfilled：查的单 pending，但已有另一笔完成单（${width}px）`)
  const context = await newContext(browser, width, height)
  const page = await context.newPage()
  await withBridge(page, [checkoutUrl(CASE2_UNPAID, 'tok-case2-157')])
  const state = await wire(page, {
    answer: (no) =>
      pendingBody(no, {
        latest_fulfilled: {
          out_trade_no: PAID_ORDER,
          plan_id: 'newbie',
          amount_yuan: 1.0,
          card_no: PAID_CARD,
          paid_at: 1795015210,
        },
      }),
  })
  await boot(page, baseUrl)
  await openBuyPanel(page)
  await page.getByTestId('ours-buy').click()

  const sawLatest = await waitFor(page, 'ours-order-latest', 25000)
  truthy(sawLatest, `[${width}] 界面给出「${TEXT_LATEST}」提示块`)
  const hint = await textOf(page, 'ours-order-latest')
  truthy(hint.includes(TEXT_LATEST), `[${width}] 提示文案是「${TEXT_LATEST}」（实际：${hint || '(空)'}）`)
  const latestCard = await textOf(page, 'ours-order-latest-card')
  truthy(latestCard.includes(PAID_CARD_TAIL), `[${width}] 直接展示那笔已完成订单的卡密（实际：${latestCard || '(没有)'}）`)
  truthy(
    latestCard.includes(PAID_ORDER.slice(-8)),
    `[${width}] 卡片上标明是哪笔订单（实际：${latestCard}）`
  )
  // 查的这一单仍是 pending：不能因此把兜底那张卡藏起来，也不能说成「已发卡」
  eq(await textOf(page, 'ours-order-status'), MSG_PENDING, `[${width}] 当前单状态照旧是「${MSG_PENDING}」`)

  await page
    .getByTestId('ours-order-latest')
    .scrollIntoViewIfNeeded({ timeout: 3000 })
    .catch(() => note('兜底区块不存在的截图（修复前就是这样）'))
  await page.waitForTimeout(250)
  await shot(page, '03-latest-fulfilled', width)

  const redeemButton = page.getByTestId('ours-order-latest-redeem')
  truthy((await redeemButton.count()) === 1, `[${width}] 有一键兑换按钮`)
  await redeemButton.click({ timeout: 5000 }).catch(() => note('一键兑换按钮点不动（见上面的失败项）'))
  await page.waitForTimeout(1500)
  const lastRedeem = state.redeem.at(-1)
  truthy(lastRedeem !== undefined, `[${width}] 点兑换后真的发了兑换请求`)
  const body = lastRedeem === undefined ? {} : JSON.parse(lastRedeem.body || '{}')
  eq(body.card_no, PAID_CARD, `[${width}] 兑换用的是那张卡的完整卡号（request_id 口径由兑换逻辑决定）`)
  truthy(
    (await textOf(page, 'ours-redeem-result')).length > 0,
    `[${width}] 兑换结果有回显（实际：${await textOf(page, 'ours-redeem-result')}）`
  )
  await context.close()
}

// ---------------------------------------------------------------- [3] 网页版回跳覆盖

const scenarioWebReturn = async (browser, baseUrl, width, height) => {
  console.log(`\n[3] 网页版回跳：单号只能靠 ?no=&order_token= 拿到，到达时必须覆盖旧存档（${width}px）`)
  const context = await newContext(browser, width, height)
  const page = await context.newPage()
  await page.addInitScript(seed, [
    {
      customer: CUSTOMER_KEY,
      cid: CID,
      apiKey: API_KEY_LOCAL,
      orderKey: ORDER_KEY,
      // 上一次下单留下的旧存档（未支付、还没回跳）
      order: { outTradeNo: FIRST_UNPAID, orderToken: 'tok-first-157', planId: 'newbie', startedAt: Date.now() },
    },
  ])
  const state = await wire(page, {
    // 头两次查还在等回调，之后才发卡：先断言「存档已被回跳参数覆盖」，再看界面
    answer: (no, nth) => (no === PAID_ORDER && nth > 2 ? fulfilledBody(no) : pendingBody(no)),
  })
  await page.goto(`${baseUrl}/?no=${PAID_ORDER}&order_token=tok-web-157`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  const stored = await readStore(page)
  eq(stored?.outTradeNo, PAID_ORDER, `[${width}] 回跳参数到达后存档被覆盖成新单号：${stored?.outTradeNo ?? '(空)'}`)
  eq(stored?.orderToken, 'tok-web-157', `[${width}] 令牌也是回跳带回来的那一份`)
  truthy(!page.url().includes('order_token'), `[${width}] 地址栏里的 order_token 已清掉（不留在历史记录里）`)

  const sawCard = await waitFor(page, 'ours-order-card', 25000)
  truthy(sawCard, `[${width}] 回跳后自动进查单并显示卡密`)
  eq(
    state.queries.filter((item) => item.no === FIRST_UNPAID).length,
    0,
    `[${width}] 一次都没查旧单（实际 ${JSON.stringify([...new Set(state.queries.map((q) => q.no))])}）`
  )
  await shot(page, '04-web-return', width)
  await context.close()
}

// ---------------------------------------------------------------- [4] 存档变了，轮询要跟上

const scenarioStoreChanged = async (browser, baseUrl, width, height) => {
  console.log(`\n[4] 另一个标签页写了新存档：正在轮询的弹层必须切过去（${width}px）`)
  const context = await newContext(browser, width, height)
  const page = await context.newPage()
  await withBridge(page, [checkoutUrl(OTHER_UNPAID, 'tok-other-157')])
  const state = await wire(page, {
    answer: (no) => (no === PAID_ORDER ? fulfilledBody(no) : pendingBody(no)),
  })
  await boot(page, baseUrl)
  await openBuyPanel(page)
  await page.getByTestId('ours-buy').click()
  await page.waitForTimeout(2600)
  eq((await readStore(page))?.outTradeNo, OTHER_UNPAID, `[${width}] 本页存档是这一页刚下的单`)

  // 另一个标签页（同源、同一份 localStorage）按回跳写了一份新存档
  const other = await context.newPage()
  await other.addInitScript(seed, [{ customer: CUSTOMER_KEY, cid: CID, apiKey: API_KEY_LOCAL, orderKey: ORDER_KEY, order: null }])
  await wire(other, { answer: (no) => pendingBody(no) })
  await boot(other, baseUrl)
  await other.evaluate(
    ([key, no]) =>
      window.localStorage.setItem(
        key,
        JSON.stringify({ outTradeNo: no, orderToken: 'tok-paid-157', planId: 'newbie', startedAt: Date.now() })
      ),
    [ORDER_KEY, PAID_ORDER]
  )
  await page.waitForTimeout(5000)

  const switched = state.queries.filter((item) => item.no === PAID_ORDER).length
  truthy(switched > 0, `[${width}] 轮询读到了新存档并开始查新单（${switched} 次）`)
  const sawCard = await waitFor(page, 'ours-order-card', 20000)
  truthy(sawCard, `[${width}] 新单付款成功后界面显示卡密（不是守着旧单等超时）`)
  await context.close()
}

// ---------------------------------------------------------------- [5] 兜底卡一键兑换走旧接口

const scenarioLatestRedeemLegacy = async (browser, baseUrl, width, height) => {
  console.log(`\n[5] 一键兑换退回旧接口时 request_id 必须是卡号（${width}px）`)
  const context = await newContext(browser, width, height)
  const page = await context.newPage()
  await withBridge(page, [checkoutUrl(CASE2_UNPAID, 'tok-case2-157')])
  const state = await wire(page, {
    poolMissing: true,
    answer: (no) =>
      pendingBody(no, {
        latest_fulfilled: {
          out_trade_no: PAID_ORDER,
          plan_id: 'newbie',
          amount_yuan: 1.0,
          card_no: PAID_CARD,
          paid_at: 1795015210,
        },
      }),
  })
  await boot(page, baseUrl)
  await openBuyPanel(page)
  await page.getByTestId('ours-buy').click()
  truthy(await waitFor(page, 'ours-order-latest-redeem', 25000), `[${width}] 兜底卡的一键兑换按钮出现`)
  await page
    .getByTestId('ours-order-latest-redeem')
    .click({ timeout: 5000 })
    .catch(() => note('兜底卡的一键兑换按钮点不动（修复前没有这个入口）'))
  await page.waitForTimeout(2000)
  const legacy = state.redeem.filter((item) => item.via === 'legacy').at(-1)
  truthy(legacy !== undefined, `[${width}] 池不可用时退回旧接口 /api/redeem`)
  const body = legacy === undefined ? {} : JSON.parse(legacy.body || '{}')
  eq(body.card_no, PAID_CARD, `[${width}] 旧接口的 card_no 是那张卡的完整卡号`)
  eq(body.request_id, PAID_CARD, `[${width}] 旧接口的 request_id 就是卡号（与既有兑换逻辑同一口径）`)
  await context.close()
}

const main = async () => {
  const server = await serveDist(DIST)
  const browser = await chromium.launch()
  try {
    for (const [width, height] of [
      [390, 844],
      [360, 800],
    ]) {
      await scenarioOverwrite(browser, server.url, width, height)
      await scenarioLatestFulfilled(browser, server.url, width, height)
    }
    await scenarioWebReturn(browser, server.url, 390, 844)
    await scenarioStoreChanged(browser, server.url, 390, 844)
    await scenarioLatestRedeemLegacy(browser, server.url, 390, 844)
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

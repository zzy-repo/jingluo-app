// [layer: integration | 依赖: playwright + chromium + 本地静态服务（支付后端全部 page.route 打桩）| 耗时: ~1 分钟]
// Issue #36：网页版购买 = **顶层导航**（不是 fetch 读 302）+ 回跳参数进「订单查询」。
//
//   cd /root/worktrees/deepseek-issue36-webpay
//   DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   PORT=5297 node tests/integration/ours-webpay.test.mjs
//
// 付费后端全部打桩（https://apia.ecsafe.cn + 收银台 pay.xiaodouap.cn），不产生真实订单/真实支付。
// 断言（对应 Issue #36 关闭条件）：
//   [A] 点「去支付」→ 浏览器发起 **document 顶层导航** 到 /buy?plan=p1；
//       同一次点击里 fetch/xhr 数量为 0（旧实现就是在这里 fetch(redirect:'manual') 拿到 opaqueredirect）
//   [B] 302 由浏览器自己跟随 → 落到收银台页（桩），证明「浏览器只要顶层导航就能到收银台」
//   [C] 回跳地址 ?no=<out_trade_no>&order_token=<token> → 自动进订单查询：2s 轮询 → fulfilled 显示卡密尾号
//       + 一键兑换可用；地址栏参数被清掉（order_token 等同凭据）
//   [D] 没有回跳参数（正常打开）→ 不查单、面板不自动弹
//   [E] 未 fulfilled 时不展示卡密
//   [F] 390 / 360 截图：点「去支付」后的中间态（本地 mock 收银台）+ 回跳后的订单查询界面
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { serveDist } from '../helpers/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
// 端口不再写死 5297：撞到别的任务遗留服务就整批假红（曾实测 5297 被占 → 收银台桩页 404）。
// serveDist 用 0 号端口原子分配，PORT 由实际监听端口回填。
let PORT = process.env.PORT || ''
let APP_URL = process.env.APP_URL || ''
const INVITE_API = 'http://140.210.13.146:60013'
const CARD_API = 'https://apia.ecsafe.cn'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

const KEY = 'sk-live-e2e-ours-8844220011aabbccddeeff'
/** Issue #115：下单归属客户（cid），由 /me 的 customer_id 提供；顶层导航目标带 cid */
const CUSTOMER_ID = 4210
const OUT_TRADE_NO = 'CP2026111816102637F0F8AA'
const ORDER_TOKEN = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'
const ORDER_CARD = 'CARD-FULFILLED-9f8e7d'
const ORDER_CARD_TAIL = ORDER_CARD.slice(-4)
const ORDER_KEY = 'chat-demo:ours-order'

const failures = []
const ok = (message) => console.log(`  ok  ${message}`)
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const note = (message) => console.log(`  ·   ${message}`)
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

// ---------- 0) 起静态服务 ----------
const children = []
const start = (command, args) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return child
}
const cleanup = () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 已退出
    }
  }
  try {
    staticServer.close().catch(() => {})
  } catch {
    // 服务还没起来
  }
}

const browser = await chromium.launch()

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
}
const json = (status, body) => ({ status, headers: CORS, body: JSON.stringify(body) })

/** 打桩状态 + 计数器（每个用例重置） */
const mock = { order: 'pending-then-fulfilled', orders: 0 }
const calls = { apply: 0, me: 0, balance: 0, plans: 0, order: 0, redeem: 0, redeemPool: 0 }

const profile = () => ({
  // Issue #115 / #135：没有 cid 时 navigateTopLevel 拒绝跳转（不发不带 cid 的 /buy），
  // 打桩的 /me 必须给 customer_id，否则「去支付」根本不会导航。
  customer_id: CUSTOMER_ID,
  invite_code: 'G7TA7UR3',
  invited_count: 0,
  max_invites: 20,
  bonus_points: 0,
  redeemed: false,
  quota_points: 100,
  used_points: 0,
  remaining_points: 100,
  key_status: 'active',
})

const PLANS = {
  plans: [
    { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true },
    { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
  ],
}

/** 收银台桩页（本地 mock，不含任何真实支付信息） */
const CHECKOUT_STUB = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>本地 mock 收银台</title>
<body style="font:16px/1.6 system-ui;padding:24px">
<h1>本地 mock 收银台</h1>
<p>支付宝收银台打桩页：/buy 的 302 已被浏览器跟随到这里（未产生真实订单，也不产生真实支付）。</p>
<p>单号 ${OUT_TRADE_NO}</p>
</body></html>`

/**
 * /buy 的 302 目标：单号在收银台地址上，order_token 在 return_url 里（2026-11-18 实测结构）。
 * 真实环境这里是 https://pay.xiaodouap.cn/submit.php?…
 * 本测试把它换成本地静态桩页 —— 因为 Playwright **拦不到「被 route 满足的 302 之后浏览器自动跟随的那一跳」**
 * （实测：跟随产生的第二个 document 请求不会进 route 处理器，会真的打到外网）。
 * 换成本地地址后，浏览器照样要自己跟随 302，机制不变，且全程不出网。
 */
const LOCAL_CHECKOUT_STUB = 'checkout-stub.html'
const LOCAL_CHECKOUT_URL = (port) => `http://127.0.0.1:${port}/${LOCAL_CHECKOUT_STUB}?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`

// 收银台桩页（浏览器跟随 302 后会落到这一页；本地文件，全程不出网）
mkdirSync(DIST, { recursive: true })
writeFileSync(path.join(DIST, LOCAL_CHECKOUT_STUB), CHECKOUT_STUB, 'utf8')

// 进程内静态服务（不再 spawn python3 http.server：Windows 上是 Store 占位符 / 不保证有 python）
const staticServer = await serveDist(DIST, { port: Number(process.env.PORT || 0) })
PORT = new URL(staticServer.url).port
if (!process.env.APP_URL) APP_URL = staticServer.url

/**
 * 全部后端打桩。`holdBuyMs` 用来把 /buy 的响应压一下，
 * 好让「点完去支付、页面还没跳走」的中间态可截图。
 */
const wireMock = async (page, options = {}) => {
  const holdBuyMs = options.holdBuyMs ?? 0
  const buyStarted = { value: false }

  await page.route(`${INVITE_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (url.pathname === '/apply') {
      calls.apply += 1
      await route.fulfill(json(201, { ...profile(), key: KEY }))
      return
    }
    if (url.pathname === '/me') {
      calls.me += 1
      await route.fulfill(json(200, profile()))
      return
    }
    if (url.pathname === '/redeem-card') {
      // Issue #72：卡密兑换先打本机池 /redeem-card；旧 /api/redeem 只在池链路本身不通时兜底
      calls.redeemPool += 1
      const body = JSON.parse(request.postData() ?? '{}')
      mock.remaining += 300
      await route.fulfill(
        json(200, {
          ok: true,
          card_no: body.card_no,
          points: 300,
          quota_points: 300,
          remaining_points: mock.remaining,
          duplicate: false,
        })
      )
      return
    }
    await route.fulfill(json(404, { error: { code: 'not_found', message: 'no such path' } }))
  })

  await page.route(`${CARD_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (url.pathname === '/api/plans') {
      calls.plans += 1
      await route.fulfill(json(200, PLANS))
      return
    }
    if (url.pathname === '/api/balance') {
      calls.balance += 1
      await route.fulfill(json(200, { api_key: `…${KEY.slice(-6)}`, valid: true }))
      return
    }
    if (url.pathname === '/buy') {
      // 网页版**不应该**用 fetch 打到这里：只允许 document 顶层导航
      buyStarted.value = true
      if (holdBuyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, holdBuyMs))
      }
      await route.fulfill({ status: 302, headers: { ...CORS, location: LOCAL_CHECKOUT_URL(PORT) }, body: '' })
      return
    }
    if (url.pathname === '/api/order') {
      calls.order += 1
      mock.orders += 1
      if (url.searchParams.get('order_token') !== ORDER_TOKEN) {
        await route.fulfill(json(403, { code: 'UNAUTHORIZED', message: '订单凭证不匹配', request_id: 'rid' }))
        return
      }
      const fulfilled = mock.order === 'fulfilled' || (mock.order === 'pending-then-fulfilled' && mock.orders > 1)
      await route.fulfill(
        json(200, {
          out_trade_no: OUT_TRADE_NO,
          status: fulfilled ? 'fulfilled' : 'pending',
          amount_fen: 300,
          card_no: fulfilled ? ORDER_CARD : null,
          expire_at: 1794990326,
          message: fulfilled ? '已发卡' : '等待支付',
        })
      )
      return
    }
    if (url.pathname === '/api/redeem') {
      calls.redeem += 1
      const body = JSON.parse(request.postData() ?? '{}')
      await route.fulfill(json(200, { ok: true, card_no: body.card_no, points: 300, api_key: KEY, sync: 'synced' }))
      return
    }
    await route.fulfill(json(404, { code: 'ORDER_NOT_FOUND', message: '路径不存在', request_id: 'rid-404' }))
  })

  return { buyStarted }
}

const openSettingsData = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    const settingsButton = page.getByRole('button', { name: /设置|Settings/ }).last()
    if (!(await settingsButton.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /打开边栏|Expand sidebar/ }).first().click()
      await page.waitForTimeout(500)
    }
    await settingsButton.click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(400)
}

const openPanel = async (page) => {
  await page.getByTestId('ours-services-open').click()
  const panel = page.getByTestId('ours-services-dialog')
  await panel.waitFor({ state: 'visible' })
  return panel
}

const resetMock = () => {
  mock.order = 'pending-then-fulfilled'
  mock.orders = 0
  for (const key of Object.keys(calls)) calls[key] = 0
}

const runViewport = async ({ width, height, label }) => {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width, height },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  await wireMock(page)
  const consoleErrors = []
  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'error' && !/^Failed to load resource:/.test(text)) {
      consoleErrors.push(text)
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

  const shots = []
  const shot = async (name, target = page) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    const file = path.join(SHOT_DIR, `issue36-webpay-${name}-${width}.png`)
    await target.screenshot({ path: file })
    shots.push(file)
    note(`截图 ${path.relative(ROOT, file)}`)
  }

  console.log(`\n=========== 视口 ${label} (${width}×${height}) ============`)
  resetMock()

  // ---------- 准备：切到「我们的渠道」 ----------
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.localStorage.clear()
    window.localStorage.setItem('chat-demo:provider-kind', 'ours')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  // ---------- [D] 正常打开（没有回跳参数）：不查单、不自动弹面板 ----------
  eq(calls.order, 0, `${width}px：没有 ?no=&order_token= 时一次 /api/order 都不发`)
  eq(await page.getByTestId('ours-services-dialog').count(), 0, `${width}px：没有回跳参数不自动弹面板`)
  truthy(!page.url().includes('order_token'), `${width}px：地址栏本来就干净`)

  await openSettingsData(page)
  const panel = await openPanel(page)
  await page.waitForTimeout(900)
  eq(await page.getByTestId('ours-iframe').count(), 0, `${width}px：页面里没有 iframe（不允许用 iframe 绕过）`)
  truthy(
    !(await page.getByTestId('ours-pay-notice').innerText()).includes('请在 App 内购买'),
    `${width}px：网页版不再提示「请在 App 内购买」`
  )

  // ---------- [A][B] 点「去支付」= 顶层导航，不是 fetch ----------
  const requests = []
  page.on('request', (request) => {
    requests.push({ url: request.url(), type: request.resourceType() })
  })
  await page.evaluate(() => {
    window.__fetches = []
    const original = window.fetch
    window.fetch = function patched(input, init) {
      window.__fetches.push(String(input))
      return original.call(this, input, init)
    }
  })

  const stubUrl = `http://127.0.0.1:${PORT}/${LOCAL_CHECKOUT_STUB}`
  const navigated = page.waitForURL(`${stubUrl}**`, { timeout: 15000 })
  // 点「去支付」前先留一张面板图（390/360 的「点之前」状态）
  await page.getByTestId('ours-plans').scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await shot('01-panel-before-click')
  await page.getByTestId('ours-buy').click()

  // 收银台桩页加载完（浏览器自己跟随了 /buy 的 302）：这就是「顶层导航能到收银台」的证据
  await navigated
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(300)
  const buyRequests = requests.filter((item) => item.url.startsWith(`${CARD_API}/buy`))
  eq(buyRequests.map((item) => item.type), ['document'], `${width}px：/buy 只被 document 导航请求过一次`)
  truthy(
    buyRequests[0]?.url === `${CARD_API}/buy?plan=p1&cid=${CUSTOMER_ID}`,
    `${width}px：顶层导航目标是 /buy?plan=p1&cid=（${buyRequests[0]?.url}）`
  )
  eq(
    requests.filter((item) => item.url.startsWith(`${CARD_API}/buy`) && (item.type === 'fetch' || item.type === 'xhr'))
      .length,
    0,
    `${width}px：点「去支付」不再 fetch /buy（旧实现正是在这里拿到 opaqueredirect）`
  )
  eq(
    await page.evaluate(() => (window.__fetches ?? []).length),
    0,
    `${width}px：整次点击没有调用过 window.fetch`
  )
  truthy(
    (await page.getByText('本地 mock 收银台', { exact: false }).count()) > 0,
    `${width}px：浏览器跟着 302 落到了收银台页（跨域顶层跳转不受 CORS 约束；桩页替代 pay.xiaodouap.cn）`
  )
  await shot('02-after-click-checkout-mock')

  // ---------- [C][E] 回跳：?no=&order_token= → 自动进订单查询 ----------
  await page.goto(`${APP_URL}/?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`, { waitUntil: 'domcontentloaded' })
  mock.order = 'pending-then-fulfilled'
  mock.orders = 0
  calls.order = 0
  await page.getByTestId('ours-services-dialog').waitFor({ state: 'visible', timeout: 15000 })
  ok(`${width}px：回跳带参数 → 自动打开「我们的渠道」面板`)
  const cleanedUrl = page.url()
  truthy(!cleanedUrl.includes('order_token'), `${width}px：地址栏已清掉 order_token（${cleanedUrl}）`)
  truthy(!cleanedUrl.includes('no='), `${width}px：地址栏已清掉 no`)

  await page.getByTestId('ours-order-status').waitFor({ state: 'visible', timeout: 15000 })
  const firstStatus = await page.getByTestId('ours-order-status').innerText()
  eq(firstStatus, '待支付', `${width}px：先渲染 pending 状态`)
  eq(await page.getByTestId('ours-order-card').count(), 0, `${width}px：未 fulfilled 时不展示卡密`)
  await page.getByTestId('ours-order').scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await shot('03-return-order-pending')

  await page.getByTestId('ours-order-card').waitFor({ state: 'visible', timeout: 20000 })
  eq(await page.getByTestId('ours-order-status').innerText(), '已发卡', `${width}px：轮询到 fulfilled`)
  const cardText = await page.getByTestId('ours-order-card').innerText()
  truthy(cardText.includes(ORDER_CARD_TAIL), `${width}px：显示卡密尾 4 位（${cardText}）`)
  truthy(!cardText.includes(ORDER_CARD), `${width}px：界面不展示完整卡密`)
  truthy(calls.order >= 2, `${width}px：2s 轮询至少两次（${calls.order}）`)
  truthy(
    (await page.getByTestId('ours-order-redeem').count()) === 1,
    `${width}px：已发卡后提供「一键兑换」`
  )
  await page.getByTestId('ours-order').scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
  await shot('04-return-order-fulfilled')

  // #100 / #86：网页版新设备要先显式「领取新 Key」，领到的 Key 才会写进当前渠道配置。
  // 「一键兑换」提交时要用这个 Key（src 里空 Key 直接拒绝，不发请求），所以这是必经步骤。
  if ((await page.getByTestId('ours-open-choice-claim').count()) > 0) {
    await page.getByTestId('ours-open-choice-claim').click()
    await page.waitForTimeout(900)
  }
  if ((await page.getByTestId('ours-claim-use').count()) > 0) {
    await page.getByTestId('ours-claim-use').click()
    await page.waitForTimeout(400)
  }
  eq(
    await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key')),
    KEY,
    `${width}px：领到 Key 后写进当前渠道（否则一键兑换发不出去）`
  )

  // 一键兑换（把回跳拿到的卡密直接换额度）
  const redeemBefore = calls.redeemPool
  await page.getByTestId('ours-order-redeem').click()
  await page.waitForTimeout(900)
  truthy(calls.redeemPool > redeemBefore, `${width}px：一键兑换打到本机池 /redeem-card（#72）`)
  eq(calls.redeem, 0, `${width}px：池正常时不兜底旧 /api/redeem`)
  const redeemText = await page.getByTestId('ours-redeem-result').innerText()
  truthy(/兑换成功/.test(redeemText), `${width}px：一键兑换成功（${redeemText}）`)

  // 终态后存档清掉：再打开同 URL 不会重复查单
  eq(
    await page.evaluate((keyName) => window.localStorage.getItem(keyName), ORDER_KEY),
    null,
    `${width}px：终态后清掉订单存档`
  )
  const ordersBeforeReload = calls.order
  await page.goto(`${APP_URL}/?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.getByTestId('ours-services-dialog').waitFor({ state: 'visible', timeout: 15000 })
  ok(`${width}px：再次用同一组参数回跳仍然进查单（凭据来自地址栏，不依赖存档）`)
  truthy(calls.order > ordersBeforeReload, `${width}px：又重新查了一次订单`)

  eq(consoleErrors.length, 0, `${width}px：console error = 0${consoleErrors.length > 0 ? `（${consoleErrors.join(' | ')}）` : ''}`)
  await context.close()
  return shots
}

let shots = []
try {
  shots = shots.concat(await runViewport({ width: 390, height: 844, label: '390' }))
  shots = shots.concat(await runViewport({ width: 360, height: 780, label: '360' }))
} catch (error) {
  bad(`用例执行异常：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await browser.close().catch(() => {})
  cleanup()
}

console.log('')
console.log(`截图：${shots.length} 张`)
for (const file of shots) {
  console.log(`  - ${path.relative(ROOT, file)}`)
}
if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 项失败`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
console.log('\n✓ 全部通过')

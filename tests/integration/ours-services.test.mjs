// [layer: integration | 依赖: playwright + chromium + 本地静态服务（两套后端全部 page.route 打桩） | 耗时: ~2 分钟]
// Issue #21：「我们的渠道」设备码 / 额度 / 邀请 / 套餐购买 / 订单 / 卡密兑换 UI 验收。
//
//   cd /root/worktrees/deepseek-pay-integration
//   DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   PORT=5296 node tests/integration/ours-services.test.mjs
//
// 被测页面：标准构建，手动切到「我们的渠道」。两套后端全部打桩：
//   - 邀请 / 额度服务 http://140.210.13.146:60013（明文 HTTP）
//   - 卡密 / 支付服务 https://apia.ecsafe.cn（HTTPS），含 /buy 的 302 与收银台页
// CORS 也用假响应头兜住（Web 端 CORS 失败一律按网络错误处理，不会被当成业务失败）。
//
// 断言（对应任务书验收 1~8）：
//   [A] 入口只在 ours 渠道出现：切到 DeepSeek 官方后一条 DOM 都没有
//   [B] 设备码：首次生成、可见、符合 8–128 / [A-Za-z0-9._:-]、重开不变（持久化）
//   [C] 打开弹层只读、**不自动 /apply**（#100）；用户显式点「领取新 Key」才 /apply；
//       已有 Key 时重开也不再自动 /apply（不覆盖用户已填的 Key）
//   [D] 额度只认邀请服务 /me 的 remaining_points，且只显示「N 积分」（#75：不做 ¥ 折算）
//   [E] 邀请码：展示自己的 + 已邀请人数；填别人的走 /redeem，六类错误码各有文案
//   [F] 套餐价格/积分来自 /api/plans；/buy 只点一次；order_token 必须落盘
//   [G] 订单轮询：待支付 → 已发卡；发卡后显示卡密尾 4 位并提供「一键兑换」
//   [H] 兑换：成功 → 刷新额度；202 CREDIT_PENDING 显示「处理中」而不是失败；409 提示不要重复提交
//   [I] 隐私：DOM / console 里没有完整 Key、完整卡密；request_id = 卡密
//   [J] 390 / 360 两个手机视口 × 9 个状态截图
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { selectProviderKind } from '../helpers/helpers.mjs'
import { serveDist } from '../helpers/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
// 端口不再写死 5296：撞到遗留服务就整批假红。serveDist 用 0 号端口原子分配后回填。
let PORT = process.env.PORT || ''
let APP_URL = process.env.APP_URL || ''
const INVITE_API = 'http://140.210.13.146:60013'
const CARD_API = 'https://apia.ecsafe.cn'
const PAY_HOST = 'https://pay.xiaodouap.cn'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

const KEY = 'sk-live-e2e-ours-8844220011aabbccddeeff'
// Issue #115 / #135：网页版「去支付」必须带上 cid（订单归属客户），没有 cid 就**不跳**
// （src/services/ours/transport.ts navigateTopLevel）。cid 由 /me 的 customer_id 提供，
// 所以打桩的 profile 里要给一个，否则浏览器永远不导航，用例只会等到超时。
const CUSTOMER_ID = 4210
const KEY_TAIL = KEY.slice(-6)
const OUT_TRADE_NO = 'CP2026111816102637F0F8AA'
const ORDER_TOKEN = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'
const ORDER_CARD = 'CARD-FULFILLED-9f8e7d'
const ORDER_CARD_TAIL = ORDER_CARD.slice(-4)
const CARD_PENDING = 'CARD-CREDIT-PENDING-4471'
const CARD_USED = 'CARD-USED-2222'
const DEVICE_KEY = 'chat-demo:ours-device-id'
const ORDER_KEY = 'chat-demo:ours-order'

/** 真实的 /buy 302 Location 结构（out_trade_no 在外层，order_token 在 return_url 里） */
const CHECKOUT_URL = `${PAY_HOST}/submit.php?pid=10268375&type=alipay&out_trade_no=${OUT_TRADE_NO}&notify_url=${encodeURIComponent('https://apia.ecsafe.cn/notify')}&return_url=${encodeURIComponent(`https://apia.ecsafe.cn/return?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`)}&money=3.00&sitename=muse2api&sign=deadbeef&sign_type=MD5`

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
// 进程内静态服务（不再 spawn python3 http.server：Windows 上是 Store 占位符 / 不保证有 python）
const staticServer = await serveDist(DIST, { port: Number(process.env.PORT || 0) })
PORT = new URL(staticServer.url).port
if (!process.env.APP_URL) APP_URL = staticServer.url

const browser = await chromium.launch()

/** 打桩状态：每个用例只改这几个开关 */
const mock = {
  /** 'ok' = /apply 正常；'fail' = 连不上（模拟首次领取失败） */
  apply: 'ok',
  /** 剩余积分（/apply 与 /me 都用它） */
  remaining: 100,
  /** 订单走法：先 pending 再 fulfilled，好把「待支付」也截下来 */
  order: 'pending-then-fulfilled',
  orderCalls: 0,
}
const calls = { apply: 0, me: 0, balance: 0, plans: 0, buy: 0, order: 0, redeem: 0, redeemPool: 0 }
const requestLog = []
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
}

const profile = () => ({
  customer_id: CUSTOMER_ID,
  invite_code: 'G7TA7UR3',
  invited_count: 1,
  max_invites: 20,
  bonus_points: 10,
  redeemed: true,
  quota_points: mock.remaining,
  used_points: 0,
  remaining_points: mock.remaining,
  key_status: 'active',
})

const PLANS = {
  plans: [
    { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true },
    { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
  ],
}

const json = (status, body, extraHeaders = {}) => ({
  status,
  headers: { ...CORS, ...extraHeaders },
  body: JSON.stringify(body),
})

const inviteErrors = {
  G7TA7UR3: [400, 'own_code'],
  BADCODE1: [404, 'invalid_code'],
  USEDCODE: [409, 'already_redeemed'],
  EXHAUST1: [409, 'code_exhausted'],
  RATE1234: [429, 'rate_limited'],
}

const wireMock = async (page) => {
  // ---------- 邀请 / 额度服务（明文 HTTP） ----------
  await page.route(`${INVITE_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requestLog.push({ host: 'invite', method: request.method(), path: url.pathname, search: url.search, postData: request.postData() ?? '' })
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (url.pathname === '/apply') {
      calls.apply += 1
      if (mock.apply === 'fail') {
        await route.abort('failed')
        return
      }
      const body = JSON.parse(request.postData() ?? '{}')
      const status = calls.apply === 1 ? 201 : 200
      await route.fulfill(json(status, { ...profile(), key: KEY }))
      note(`  /apply device_id=${String(body.device_id).slice(0, 4)}…（幂等重试安全）`)
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
      if (body.card_no === CARD_PENDING) {
        await route.fulfill(json(202, { code: 'CREDIT_PENDING', message: '处理中' }))
        return
      }
      if (body.card_no === CARD_USED) {
        await route.fulfill(json(409, { code: 'card_used', message: '卡密已被使用' }))
        return
      }
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
    if (url.pathname === '/redeem') {
      const body = JSON.parse(request.postData() ?? '{}')
      const code = String(body.invite_code ?? '')
      const mapped = inviteErrors[code]
      if (mapped !== undefined) {
        await route.fulfill(json(mapped[0], { error: { code: mapped[1], message: 'server says no' } }))
        return
      }
      await route.fulfill(json(200, { ...profile(), reward_points: 20, synced: true }))
      return
    }
    await route.fulfill(json(404, { error: { code: 'not_found', message: 'no such path' } }))
  })

  // ---------- 卡密 / 支付服务（HTTPS） ----------
  await page.route(`${CARD_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requestLog.push({ host: 'card', method: request.method(), path: url.pathname, search: url.search, postData: request.postData() ?? '' })
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
      // 只反映 Key 是否有效，不返回积分
      calls.balance += 1
      await route.fulfill(json(200, { api_key: `…${KEY_TAIL}`, valid: true }))
      return
    }
    if (url.pathname === '/buy') {
      calls.buy += 1
      // Issue #36：网页版「去支付」= 浏览器顶层导航到 /buy?plan=（不是 fetch 读 302）。
      // 顶层导航会真的跟随 302，而 Playwright 拦不到「被 route 满足的 302 之后自动跟随的那一跳」，
      // 所以这里直接回一页收银台桩页：导航机制不变，且不会打到真实收银台。
      await route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><meta charset="utf-8"><title>收银台（桩）</title><h1>支付宝收银台（桩页）</h1><p>${OUT_TRADE_NO}</p>`,
      })
      return
    }
    if (url.pathname === '/api/order') {
      calls.order += 1
      if (url.searchParams.get('order_token') !== ORDER_TOKEN) {
        await route.fulfill(json(403, { code: 'UNAUTHORIZED', message: '订单凭证不匹配', request_id: 'rid' }))
        return
      }
      const fulfilled = mock.order === 'fulfilled' || (mock.order === 'pending-then-fulfilled' && calls.order > 1)
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
      if (body.card_no === CARD_PENDING) {
        await route.fulfill(json(202, { code: 'CREDIT_PENDING', message: '处理中', request_id: 'rid-202' }))
        return
      }
      if (body.card_no === CARD_USED) {
        await route.fulfill(json(409, { code: 'CARD_ALREADY_USED', message: '卡密已被使用', request_id: 'rid-409' }))
        return
      }
      await route.fulfill(
        json(200, { ok: true, card_no: body.card_no, points: 300, api_key: KEY, sync: 'synced' })
      )
      return
    }
    await route.fulfill(json(404, { code: 'ORDER_NOT_FOUND', message: '路径不存在', request_id: 'rid-404' }))
  })

  // ---------- 收银台页（网页版兜底会跟随到这个地址） ----------
  await page.route(`${PAY_HOST}/**`, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body>支付宝收银台（测试桩，不产生真实支付）</body></html>',
    })
  })
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

/** 让某个区块滚进视口再截图（弹层内容自己滚动） */
const scrollTo = async (page, testId) => {
  await page.getByTestId(testId).scrollIntoViewIfNeeded()
  await page.waitForTimeout(250)
}

const runViewport = async ({ width, height, label }) => {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width, height },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const consoleMessages = []
  const consoleErrors = []
  page.on('console', (message) => {
    consoleMessages.push(message.text())
    const text = message.text()
    const resourceFailure = /^Failed to load resource:/.test(text)
    if (message.type() === 'error' && !resourceFailure) {
      consoleErrors.push(text)
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  // 收银台弹窗（window.open）收好尾，不影响后续断言
  const popups = []
  context.on('page', (opened) => popups.push(opened))
  await wireMock(page)

  // 重置打桩状态
  mock.apply = 'fail'
  mock.remaining = 100
  mock.order = 'pending-then-fulfilled'
  mock.orderCalls = 0
  for (const key of Object.keys(calls)) calls[key] = 0
  requestLog.length = 0

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    window.localStorage.clear()
    window.localStorage.setItem('chat-demo:provider-kind', 'ours')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  const shots = []
  const shot = async (name) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    const file = path.join(SHOT_DIR, `1.4.0-beta.8-ours-pay-${name}-${width}.png`)
    await page.screenshot({ path: file })
    shots.push(file)
    note(`截图 ${path.relative(ROOT, file)}`)
  }

  console.log(`\n=========== 视口 ${label} (${width}×${height}) ===========`)
  ok(`视口 ${width}：页面已加载`)

  // ---------- [A] 入口只在 ours 渠道出现 ----------
  await openSettingsData(page)
  eq(await page.getByTestId('ours-services-row').count(), 1, `${width}px：ours 渠道下入口行存在`)
  await selectProviderKind(page, /DeepSeek 官方|DeepSeek Official/)
  await page.waitForTimeout(300)
  eq(await page.getByTestId('ours-services-row').count(), 0, `${width}px：DeepSeek 官方下没有入口行`)
  eq(await page.getByTestId('ours-services-dialog').count(), 0, `${width}px：DeepSeek 官方下没有弹层`)
  const deepseekText = await page.getByRole('dialog').first().innerText()
  truthy(!/设备码|邀请码|卡密/.test(deepseekText), `${width}px：DeepSeek 官方设置页没有我们的渠道文案`)
  await selectProviderKind(page, /我们的渠道|Our Channel/)
  await page.waitForTimeout(300)
  eq(await page.getByTestId('ours-services-row').count(), 1, `${width}px：切回我们的渠道后入口恢复`)

  // ---------- [B][C] 首次使用：打开弹层**不发** /apply（#100），点「领取新 Key」才发 ----------
  const panel = await openPanel(page)
  await page.waitForTimeout(900)
  const deviceCode = await page.getByTestId('ours-device-code').innerText()
  truthy(/^[A-Za-z0-9._:-]{8,128}$/.test(deviceCode.trim()), `${width}px：设备码符合服务端字符集（${deviceCode.slice(0, 6)}…）`)
  eq(calls.apply, 0, `${width}px：打开弹层不发 POST /apply（#100：只读，绝不建绑定）`)
  eq(await page.getByTestId('ours-open-choice').count(), 1, `${width}px：给「领取新 Key」/「我已有 Key」两个入口`)
  await page.getByTestId('ours-open-choice-claim').click()
  await page.waitForTimeout(900)
  eq(calls.apply, 1, `${width}px：显式点「领取新 Key」才 POST /apply 一次`)
  const claimFailed = await page.getByTestId('ours-claim-status').innerText()
  truthy(/网络不可用/.test(claimFailed), `${width}px：领取失败给出可读错误（${claimFailed}）`)
  const keyBefore = await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key'))
  eq(keyBefore, null, `${width}px：领取失败不写 Key`)
  await scrollTo(page, 'ours-device')
  await shot('01-claim-needed')

  // 重试领取（幂等，安全）→ 已领取：积分 + 邀请码
  mock.apply = 'ok'
  calls.apply = 0
  await page.getByTestId('ours-claim').click()
  await page.waitForTimeout(900)
  eq(calls.apply, 1, `${width}px：点「领取」再发一次 /apply（幂等）`)
  const claimOk = await page.getByTestId('ours-claim-status').innerText()
  truthy(/已领取/.test(claimOk), `${width}px：领取成功文案（${claimOk}）`)
  const keyAfter = await page.evaluate(() => window.localStorage.getItem('chat-demo:api-key'))
  eq(keyAfter, KEY, `${width}px：自动写入该渠道 API Key`)
  const deviceCode2 = await page.getByTestId('ours-device-code').innerText()
  eq(deviceCode2, deviceCode, `${width}px：设备码不变（持久化，不因切渠道/改 Key 变化）`)
  eq(await page.evaluate((keyName) => window.localStorage.getItem(keyName), DEVICE_KEY), deviceCode, `${width}px：设备码落在固定存储键`)
  const quotaText = await page.getByTestId('ours-quota-value').innerText()
  eq(quotaText, '100 积分', `${width}px：额度来自 /me remaining_points，只显示积分（#75）`)
  const quotaBlockText = await page.getByTestId('ours-quota').innerText()
  truthy(!/¥|约可消费|approx/.test(quotaBlockText), `${width}px：额度区块里没有 ¥ 折算残留（#75）`)
  const inviteText = await page.getByTestId('ours-invite-code').innerText()
  truthy(inviteText.includes('G7TA7UR3'), `${width}px：展示自己的邀请码`)
  const inviteCount = await page.getByTestId('ours-invite-count').innerText()
  truthy(/已邀请 1 \/ 20 人/.test(inviteCount), `${width}px：展示已邀请人数/上限（${inviteCount}）`)
  await scrollTo(page, 'ours-device')
  await shot('02-claim-ok')

  // 额度查询走 /me，不走 /api/balance；重开弹层也不再自动 /apply
  const meBefore = calls.me
  const applyBefore = calls.apply
  truthy(calls.balance >= 1, `${width}px：Key 校验用了一次 /api/balance（只判有效性）`)
  calls.me = meBefore
  await page.getByTestId('ours-quota-refresh').click()
  await page.waitForTimeout(600)
  truthy(calls.me > meBefore, `${width}px：刷新额度走邀请服务 /me`)
  // Esc 只关最上层（我们的渠道弹层），设置页仍开着
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await openPanel(page)
  await page.waitForTimeout(800)
  eq(calls.apply, applyBefore, `${width}px：已有 Key 时重开弹层不再自动 /apply（不覆盖用户 Key）`)

  // ---------- [D] 额度为零 ----------
  mock.remaining = 0
  await page.getByTestId('ours-quota-refresh').click()
  await page.waitForTimeout(700)
  eq(await page.getByTestId('ours-quota-value').innerText(), '0 积分', `${width}px：额度为零文案（只显示积分）`)
  const zeroHint = await page.getByTestId('ours-quota-hint').innerText()
  truthy(/额度已用完/.test(zeroHint), `${width}px：额度为零给下一步建议（${zeroHint}）`)
  await scrollTo(page, 'ours-quota')
  await shot('03-quota-zero')
  mock.remaining = 100
  await page.getByTestId('ours-quota-refresh').click()
  await page.waitForTimeout(600)

  // ---------- [E] 邀请码：六类错误码 ----------
  const inviteCases = [
    ['G7TA7UR3', '不能填自己的邀请码'],
    ['BADCODE1', '邀请码无效'],
    ['USEDCODE', '已经绑定过邀请码'],
    ['EXHAUST1', '奖励名额已用完'],
    ['RATE1234', '操作太频繁'],
  ]
  for (const [code, expected] of inviteCases) {
    await page.getByTestId('ours-invite-input').fill(code)
    await page.getByTestId('ours-invite-submit').click()
    await page.waitForTimeout(450)
    const text = await page.getByTestId('ours-invite-result').innerText()
    truthy(text.includes(expected), `${width}px：邀请码 ${code} → ${expected}（${text}）`)
  }
  await scrollTo(page, 'ours-invite')
  await shot('04-invite-error')
  // 成功路径
  await page.getByTestId('ours-invite-input').fill('OK123456')
  await page.getByTestId('ours-invite-submit').click()
  await page.waitForTimeout(600)
  const inviteOk = await page.getByTestId('ours-invite-result').innerText()
  truthy(/绑定成功/.test(inviteOk), `${width}px：邀请码绑定成功（${inviteOk}）`)
  eq(await page.getByTestId('ours-invite-input').inputValue(), '', `${width}px：成功后清空输入`)

  // ---------- [F] 套餐来自 /api/plans ----------
  const plansText = await page.getByTestId('ours-plans').innerText()
  truthy(/入门包 100万 token/.test(plansText), `${width}px：套餐名来自 /api/plans`)
  truthy(/¥3\.00 · 300 积分/.test(plansText), `${width}px：价格与积分来自 /api/plans（¥3.00 · 300 积分）`)
  truthy(/¥39\.00 · 3,900 积分/.test(plansText), `${width}px：第二个套餐同样来自服务端`)
  await scrollTo(page, 'ours-plans')
  await shot('05-plans')

  // ---------- [F] 去支付：网页版 = 浏览器顶层导航到 /buy?plan=（不再 fetch 读 302） ----------
  // 顶层导航会把页面带走，所以另开一张临时页面做这一步，主页面继续跑后面的用例。
  // Issue #36 的完整验收（含回跳参数、390/360 截图）见 tests/integration/ours-webpay.test.mjs。
  {
    const probe = await context.newPage()
    await wireMock(probe)
    await probe.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await probe.waitForTimeout(900)
    await openSettingsData(probe)
    await openPanel(probe)
    await probe.waitForTimeout(600)
    const seen = []
    probe.on('request', (request) => seen.push({ url: request.url(), type: request.resourceType() }))
    await probe.evaluate(() => {
      window.__fetches = []
      const original = window.fetch
      window.fetch = function patched(input, init) {
        window.__fetches.push(String(input))
        return original.call(this, input, init)
      }
    })
    // #115：目标地址带 cid（cid 来自 /me 的 customer_id），所以按整条 href 精确比对
    const expectedBuy = `${CARD_API}/buy?plan=p1&cid=${CUSTOMER_ID}`
    const navigated = probe.waitForURL((url) => url.href === expectedBuy, { timeout: 15000 })
    await probe.getByTestId('ours-buy').click()
    await navigated
    await probe.waitForLoadState('domcontentloaded')
    const buyHits = seen.filter((item) => item.url === expectedBuy)
    eq(buyHits.map((item) => item.type), ['document'], `${width}px：/buy 由 document 顶层导航请求一次（不再 fetch）`)
    eq(
      await probe.evaluate(() => (window.__fetches ?? []).filter((url) => String(url).includes('/buy'))),
      [],
      `${width}px：点「去支付」没有用 fetch 打 /buy`
    )
    truthy(
      (await probe.getByText('支付宝收银台', { exact: false }).count()) > 0,
      `${width}px：浏览器顶层导航后落在收银台页（跨域顶层跳转不受 CORS 约束）`
    )
    eq(calls.order, 0, `${width}px：网页版跳转前不建单查单（单号由收银台回跳带回）`)
    truthy(
      (await probe.evaluate((keyName) => window.localStorage.getItem(keyName), ORDER_KEY)) === null,
      `${width}px：网页版跳转前不写订单存档`
    )
    await probe.close()
  }

  // ---------- [G] 回跳续查：订单令牌存档 → 轮询 待支付 → 已发卡 ----------
  // 「付款 → 回来 → 续查」这条链路的存档路径：读存档、按 no + order_token 每 2s 查单（原生就是这样）。
  // 网页版走的是另一条入口（地址栏 ?no=&order_token= → returnParams 解析 → 落同样的存档），
  // 见 tests/integration/ours-webpay.test.mjs。
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await page.evaluate(
    ([keyName, payload]) => window.localStorage.setItem(keyName, payload),
    [ORDER_KEY, JSON.stringify({ outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN, planId: 'p1', startedAt: Date.now() })]
  )
  calls.order = 0
  mock.order = 'pending-then-fulfilled'
  await openPanel(page)
  await page.getByTestId('ours-order-status').waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForTimeout(300)
  const pendingStatus = await page.getByTestId('ours-order-status').innerText()
  eq(pendingStatus, '待支付', `${width}px：订单待支付`)
  const orderRequest = requestLog.filter((item) => item.path === '/api/order').at(-1)
  truthy(orderRequest.search.includes(`out_trade_no=${OUT_TRADE_NO}`), `${width}px：查单带 out_trade_no`)
  truthy(orderRequest.search.includes(`order_token=${ORDER_TOKEN}`), `${width}px：查单带 order_token（否则 403）`)
  await scrollTo(page, 'ours-order')
  await shot('06-order-pending')

  await page.getByTestId('ours-order-card').waitFor({ state: 'visible', timeout: 15000 })
  const fulfilledStatus = await page.getByTestId('ours-order-status').innerText()
  eq(fulfilledStatus, '已发卡', `${width}px：轮询到已发卡`)
  const cardText = await page.getByTestId('ours-order-card').innerText()
  truthy(cardText.includes(ORDER_CARD_TAIL), `${width}px：显示卡密尾号（${cardText}）`)
  truthy(!cardText.includes(ORDER_CARD), `${width}px：界面不展示完整卡密`)
  await scrollTo(page, 'ours-order')
  await shot('07-order-fulfilled')

  // 轮询间隔 ≈2s：两次查单之间至少 2s
  truthy(calls.order >= 2, `${width}px：轮询至少两次（${calls.order}）`)
  eq(
    await page.evaluate((keyName) => window.localStorage.getItem(keyName), ORDER_KEY),
    null,
    `${width}px：终态后清掉订单存档`
  )

  // ---------- [H] 一键兑换成功 ----------
  const meBeforeRedeem = calls.me
  await page.getByTestId('ours-order-redeem').click()
  await page.waitForTimeout(900)
  const redeemOk = await page.getByTestId('ours-redeem-result').innerText()
  truthy(/兑换成功/.test(redeemOk), `${width}px：一键兑换成功（${redeemOk}）`)
  // #75：只显示积分，不做 ¥ 折算（旧契约里的「¥3.00」已随 #75 移除，这里反过来钉住）
  truthy(/\+300 积分/.test(redeemOk), `${width}px：兑换结果显示积分数（${redeemOk}）`)
  truthy(!/¥/.test(redeemOk), `${width}px：兑换结果不做 ¥ 折算（#75）`)
  truthy(calls.me > meBeforeRedeem, `${width}px：兑换成功后刷新额度`)
  // Issue #72：走本机池 /redeem-card；池正常返回时旧 /api/redeem 一次都不该被兜底打到
  eq(calls.redeemPool, 1, `${width}px：一键兑换打本机池 /redeem-card 一次`)
  eq(calls.redeem, 0, `${width}px：池链路正常时不兜底旧 /api/redeem`)
  const redeemBody = JSON.parse(requestLog.filter((item) => item.path === '/redeem-card').at(-1).postData)
  eq(redeemBody.card_no, ORDER_CARD, `${width}px：一键兑换提交的是完整卡密`)
  eq(redeemBody.api_key, KEY, `${width}px：一键兑换带上当前 Key`)
  await scrollTo(page, 'ours-redeem')
  await shot('08-redeem-ok')

  // ---------- [H] 202 CREDIT_PENDING = 处理中 ----------
  await page.getByTestId('ours-redeem-input').fill(CARD_PENDING)
  await page.getByTestId('ours-redeem-submit').click()
  await page.waitForTimeout(700)
  const pendingRedeem = await page.getByTestId('ours-redeem-result').innerText()
  truthy(/处理中/.test(pendingRedeem), `${width}px：202 显示处理中（${pendingRedeem}）`)
  truthy(!/失败/.test(pendingRedeem), `${width}px：202 不说失败`)
  await shot('09-credit-pending')

  // 409：提示不要重复提交
  await page.getByTestId('ours-redeem-input').fill(CARD_USED)
  await page.getByTestId('ours-redeem-submit').click()
  await page.waitForTimeout(600)
  const usedText = await page.getByTestId('ours-redeem-result').innerText()
  truthy(/已被使用/.test(usedText), `${width}px：409 提示已被使用（${usedText}）`)
  truthy(!usedText.includes(CARD_USED), `${width}px：409 文案不含完整卡密`)

  // ---------- [I] 秘密不外泄 ----------
  const panelText = await panel.innerText()
  truthy(!panelText.includes(KEY), `${width}px：DOM 不含完整 Key`)
  truthy(!panelText.includes(ORDER_CARD), `${width}px：DOM 不含完整卡密`)
  truthy(!panelText.includes(CARD_PENDING), `${width}px：DOM 不含输入框里的完整卡密`)
  const consoleText = consoleMessages.join('\n')
  truthy(!consoleText.includes(KEY), `${width}px：console 不含完整 Key`)
  truthy(!consoleText.includes(ORDER_CARD), `${width}px：console 不含完整卡密`)
  truthy(!consoleText.includes(deviceCode), `${width}px：console 不含完整设备码`)
  eq(consoleErrors.length, 0, `${width}px：console error = 0${consoleErrors.length > 0 ? `（${consoleErrors.join(' | ')}）` : ''}`)

  for (const popup of popups) {
    await popup.close().catch(() => {})
  }
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
  await browser.close()
  cleanup()
}

console.log('\n截图：')
for (const file of shots) {
  console.log(`  ${file}`)
}
console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
console.log(`✓ 全部通过（截图 ${shots.length} 张）`)

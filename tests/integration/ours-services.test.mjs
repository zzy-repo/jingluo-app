// [layer: integration | 依赖: playwright + chromium + 本地静态服务（卡密服务用 page.route 打桩） | 耗时: ~2 分钟]
// Issue #7：「我们的渠道」额度与卡密 UI 验收（标准构建 + 全 mock 的 60012 卡密服务）。
//
//   cd /root/deepseek-app && DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   PORT=5295 node tests/integration/ours-services.test.mjs
//
// 被测页面：标准构建，手动切到「我们的渠道」。卡密服务 http://123.207.199.196:60012/**
// 全部由 page.route 打桩（CORS 也用假响应头兜住：Web 端 CORS 失败一律按网络错误处理，
// 不会被当成业务失败）。
//
// 断言（对应任务书验收 1~6）：
//   [A] 入口只在 ours 渠道出现：DeepSeek 官方下一条 DOM 都没有
//   [B] 打开弹层不自动查额度（0 次 /api/balance）；套餐来自 /api/plans 真实字段
//   [C] 查询额度：Authorization: Bearer，URL 无 query、无 Key；展示余量与 Key 尾 6 位
//   [D] balance=0(200, 无 auth 生效值) → 「暂未查询到该 Key 的兑换额度（或额度为 0）」，不报错、不提额度不足
//   [E] 网络失败 → 网络不可用文案（CORS/断网都走这条）
//   [F] 兑换 pending → 「到账成功，稍后自动同步」且自动刷新额度；409 → 已被使用；IDEMPOTENT → 按成功
//   [G] 支付未开放：购买按钮禁用 + 只留一行说明；界面上没有建单/查单入口，一次 /buy 请求都不发
//   [H] 无 interval 轮询：静置 4.5s 后请求数不变
//   [I] Key / 卡密不出现在 console 与 DOM（只出现脱敏尾号）
//   [J] 390 / 360 两个手机视口 × 6 个状态截图
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { selectProviderKind } from '../helpers/helpers.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const PORT = process.env.PORT || '5295'
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${PORT}`
const CARD_API = 'http://123.207.199.196:60012'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui')

const KEY = 'sk-ours-e2e-test-884422'
const KEY_TAIL = KEY.slice(-6)
const CARD_PENDING = 'CARD-PENDING-4471'
const CARD_USED = 'CARD-USED-2222'
const CARD_IDEM = 'CARD-IDEM-3333'
const CARD_TAIL = '9876'
const OUT_TRADE_NO = 'O20261118001'
const ORDER_TOKEN = 'tok-ours-e2e-abc123'

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
}
start('python3', ['-m', 'http.server', PORT, '--bind', '127.0.0.1', '--directory', DIST])
await new Promise((resolve) => setTimeout(resolve, 800))

const browser = await chromium.launch()

/** mock 状态：success / zero / network —— 每个用例只改这一个开关 */
const mock = { balance: 'success' }
const calls = []
const requestLog = []
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
}
const PLANS = {
  plans: [
    { id: 'p1', name: '入门包 100万 token', price: 9.9, quota: 1000000, currency: 'CNY', enabled: true },
    { id: 'p2', name: '标准包 500万 token', price: 39.0, quota: 5000000, currency: 'CNY', enabled: true },
  ],
}

const json = (status, body, extraHeaders = {}) => ({
  status,
  headers: { ...CORS, ...extraHeaders },
  body: JSON.stringify(body),
})

const wireMock = async (page) => {
  await page.route(`${CARD_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const authorization = request.headers()['authorization'] ?? ''
    requestLog.push({
      method: request.method(),
      path: url.pathname,
      search: url.search,
      url: request.url(),
      authorization,
      postData: request.postData() ?? '',
    })
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (url.pathname === '/api/plans') {
      await route.fulfill(json(200, PLANS))
      return
    }
    if (url.pathname === '/api/balance') {
      calls.balance += 1
      if (mock.balance === 'network') {
        await route.abort('failed')
        return
      }
      if (mock.balance === 'zero') {
        // 服务端在没有携带 Authorization 时就是 200 + balance:0（不是 401）
        await route.fulfill(json(200, authorization ? { api_key: KEY, balance: 0 } : { user_id: 0, balance: 0 }))
        return
      }
      await route.fulfill(json(200, { api_key: KEY, balance: 2000000 }))
      return
    }
    if (url.pathname === '/api/redeem' && request.method() === 'POST') {
      calls.redeem += 1
      const body = JSON.parse(request.postData() ?? '{}')
      if (body.card_no === CARD_USED) {
        await route.fulfill(json(409, { code: 'CARD_ALREADY_USED', message: '卡密已被使用', request_id: 'rid-409' }))
        return
      }
      if (body.card_no === CARD_IDEM) {
        await route.fulfill(json(200, { code: 'IDEMPOTENT', message: 'already redeemed', request_id: 'rid-idem' }))
        return
      }
      await route.fulfill(
        json(200, {
          ok: true,
          card_no: body.card_no,
          quota: 1000000,
          api_key: KEY,
          balance_after: 3000000,
          sync: 'pending',
        })
      )
      return
    }
    if (url.pathname === '/buy' && request.method() === 'POST') {
      calls.buy += 1
      // 当前网关未配置：pay_url 明确为 null
      await route.fulfill(json(200, { out_trade_no: OUT_TRADE_NO, order_token: ORDER_TOKEN, pay_url: null }))
      return
    }
    if (url.pathname === '/api/order') {
      calls.order += 1
      if (url.searchParams.get('order_token') !== ORDER_TOKEN) {
        await route.fulfill(json(401, { code: 'UNAUTHORIZED', message: 'bad token', request_id: 'rid-401' }))
        return
      }
      await route.fulfill(
        json(200, {
          out_trade_no: OUT_TRADE_NO,
          status: 'fulfilled',
          amount_fen: 990,
          card_no: `CARD-FULFILLED-${CARD_TAIL}`,
          expire_at: '2026-11-18T15:00:00+08:00',
          message: 'ok',
        })
      )
      return
    }
    await route.fulfill(json(404, { code: 'ORDER_NOT_FOUND', message: '订单不存在', request_id: 'rid-404' }))
  })
}

const openSettingsData = async (page) => {
  if ((await page.getByRole('dialog').count()) === 0) {
    const settingsButton = page.getByRole('button', { name: /设置|Settings/ }).last()
    // 移动端设置按钮在抽屉里：先点顶栏「打开边栏」
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

/** 每个视口跑一遍完整状态机并把截图存到 docs/ui（返回相对路径列表） */
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
    // 用例会故意制造断网 / 409：浏览器把这些记成 resource error，不算应用报错
    const text = message.text()
    const resourceFailure = /^Failed to load resource:/.test(text)
    if (message.type() === 'error' && !resourceFailure) {
      consoleErrors.push(text)
    }
  })
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await wireMock(page)

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  // 直接落盘 Key 与渠道，避开「填 Key」这一步的移动端确认按钮差异（Key 输入本身另有验收用例）
  await page.evaluate(
    ([key]) => {
      window.localStorage.clear()
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:provider-kind', 'ours')
    },
    [KEY]
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  const shots = []
  const shot = async (name) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    const file = path.join(SHOT_DIR, `1.4.0-beta.8-ours-${name}-${width}.png`)
    // 弹层是 fixed 遮罩，直接截视口（不是 fullPage），手机视口下看起来就是整屏
    await page.screenshot({ path: file })
    shots.push(file)
    note(`截图 ${path.relative(ROOT, file)}`)
  }

  console.log(`\n=========== 视口 ${label} (${width}×${height}) ===========`)
  ok(`视口 ${width}：页面已加载`)

  // ---------- [A] 入口只在 ours 渠道出现 ----------
  await openSettingsData(page)
  const rowCount = await page.getByTestId('ours-services-row').count()
  eq(rowCount, 1, `${width}px：ours 渠道下入口行存在`)

  // 先切到 DeepSeek 官方：入口必须消失，且没有卡片密相关的 DOM
  await selectProviderKind(page, /DeepSeek 官方|DeepSeek Official/)
  await page.waitForTimeout(300)
  eq(await page.getByTestId('ours-services-row').count(), 0, `${width}px：DeepSeek 官方下没有入口行`)
  eq(await page.getByTestId('ours-services-dialog').count(), 0, `${width}px：DeepSeek 官方下没有弹层`)
  const deepseekText = await page.getByRole('dialog').first().innerText()
  truthy(!/额度与卡密|卡密兑换/.test(deepseekText), `${width}px：DeepSeek 官方设置页没有卡密文案`)
  await selectProviderKind(page, /我们的渠道|Our Channel/)
  await page.waitForTimeout(300)
  eq(await page.getByTestId('ours-services-row').count(), 1, `${width}px：切回我们的渠道后入口恢复`)

  // ---------- [B] 打开弹层：不自动查额度 ----------
  calls.balance = 0
  calls.redeem = 0
  calls.buy = 0
  calls.order = 0
  const panel = await openPanel(page)
  await page.waitForTimeout(1500)
  eq(calls.balance, 0, `${width}px：打开弹层不自动查额度（0 次）`)
  const plansText = await page.getByTestId('ours-plans').innerText()
  truthy(/入门包 100万 token/.test(plansText), `${width}px：套餐名来自 /api/plans`)
  truthy(/¥9\.90/.test(plansText), `${width}px：套餐价格来自 /api/plans（¥9.90）`)
  truthy(/100万/.test(plansText), `${width}px：套餐额度来自 /api/plans（100万）`)

  // ---------- [C] 额度成功 ----------
  mock.balance = 'success'
  await page.getByTestId('ours-balance-refresh').click()
  await page.waitForTimeout(700)
  const balanceValue = await page.getByTestId('ours-balance-value').innerText()
  truthy(balanceValue.includes('2,000,000 token'), `${width}px：展示 token 余额（${balanceValue}）`)
  truthy(!/失败|暂未查询到/.test(balanceValue), `${width}px：余额值不是错误文案`)
  const balanceCalls = requestLog.filter((item) => item.path === '/api/balance')
  const lastBalance = balanceCalls.at(-1)
  eq(lastBalance.method, 'GET', `${width}px：额度查询用 GET`)
  eq(lastBalance.search, '', `${width}px：额度查询 URL 没有 query（Key 不进 URL）`)
  truthy(lastBalance.authorization === `Bearer ${KEY}`, `${width}px：额度查询带 Authorization: Bearer`)
  truthy(!lastBalance.url.includes(KEY), `${width}px：额度查询 URL 不含 Key`)
  const tailText = await panel.innerText()
  truthy(tailText.includes(KEY_TAIL), `${width}px：展示 Key 尾号 ${KEY_TAIL}`)
  truthy(!tailText.includes(KEY), `${width}px：不展示完整 Key`)
  await shot('quota-success')

  // ---------- [D] 额度为 0 ----------
  mock.balance = 'zero'
  await page.getByTestId('ours-balance-refresh').click()
  await page.waitForTimeout(700)
  const zeroValue = await page.getByTestId('ours-balance-value').innerText()
  eq(zeroValue, '暂未查询到该 Key 的兑换额度（或额度为 0）', `${width}px：balance=0 文案`)
  const zeroPanel = await panel.innerText()
  truthy(!/不足/.test(zeroPanel), `${width}px：balance=0 不提示额度不足`)
  truthy(!/失败/.test(zeroValue), `${width}px：balance=0 不报错`)
  await shot('quota-zero')

  // ---------- [E] 网络失败 ----------
  mock.balance = 'network'
  await page.getByTestId('ours-balance-refresh').click()
  await page.waitForTimeout(900)
  const networkValue = await page.getByTestId('ours-balance-value').innerText()
  truthy(/网络不可用/.test(networkValue), `${width}px：网络失败文案（${networkValue}）`)
  await shot('quota-network')

  // ---------- [F] 兑换表单 + pending ----------
  mock.balance = 'success'
  await page.getByTestId('ours-redeem-input').fill(CARD_PENDING)
  await shot('redeem-form')
  const balanceBeforeRedeem = calls.balance
  await page.getByTestId('ours-redeem-submit').click()
  await page.waitForTimeout(900)
  const redeemText = await page.getByTestId('ours-redeem-result').innerText()
  truthy(
    redeemText.includes('到账成功，稍后自动同步'),
    `${width}px：pending 文案（${redeemText}）`
  )
  truthy(/••••4471/.test(redeemText), `${width}px：兑换结果只显示卡密尾 4 位`)
  truthy(!redeemText.includes(CARD_PENDING), `${width}px：兑换结果不含完整卡密`)
  truthy(calls.balance > balanceBeforeRedeem, `${width}px：兑换成功后自动刷新额度`)
  const redeemBody = JSON.parse(requestLog.filter((item) => item.path === '/api/redeem').at(-1).postData)
  truthy(typeof redeemBody.request_id === 'string' && redeemBody.request_id.length > 0, `${width}px：请求带 request_id`)
  truthy(redeemBody.card_no === CARD_PENDING, `${width}px：请求卡密原样提交`)
  truthy(!JSON.stringify(redeemBody).includes('user_id'), `${width}px：不提交 user_id`)
  await shot('redeem-pending')

  // 409 与 IDEMPOTENT
  await page.getByTestId('ours-redeem-input').fill(CARD_USED)
  await page.getByTestId('ours-redeem-submit').click()
  await page.waitForTimeout(700)
  const usedText = await page.getByTestId('ours-redeem-result').innerText()
  truthy(usedText.includes('该卡密已被使用'), `${width}px：409 文案（${usedText}）`)
  truthy(!usedText.includes(CARD_USED), `${width}px：409 文案不含完整卡密`)
  await page.getByTestId('ours-redeem-input').fill(CARD_IDEM)
  await page.getByTestId('ours-redeem-submit').click()
  await page.waitForTimeout(700)
  const idemText = await page.getByTestId('ours-redeem-result').innerText()
  truthy(idemText.includes('该卡密已兑换过'), `${width}px：IDEMPOTENT 按成功处理（${idemText}）`)

  // ---------- [G] 支付未开放：只有一行说明，没有建单/查单入口 ----------
  const buyButton = page.getByTestId('ours-buy')
  eq(await buyButton.innerText(), '支付暂未开放', `${width}px：购买按钮文案`)
  eq(await buyButton.isDisabled(), true, `${width}px：购买按钮禁用`)
  const payNotice = await page.getByTestId('ours-pay-notice').innerText()
  truthy(payNotice.includes('支付暂未开放'), `${width}px：支付区说明（${payNotice}）`)
  eq(await page.getByTestId('ours-order-create').count(), 0, `${width}px：没有「生成订单号」入口`)
  eq(await page.getByTestId('ours-order-query').count(), 0, `${width}px：没有「查询状态」入口`)
  eq(calls.buy, 0, `${width}px：一次建单请求都没发（不产生付不了的订单）`)
  eq(calls.order, 0, `${width}px：一次查单请求都没发`)
  await shot('pay-closed')

  // ---------- [H] 无轮询 ----------
  const idleCounts = { ...calls }
  await page.waitForTimeout(4500)
  eq(calls.balance, idleCounts.balance, `${width}px：静置 4.5s 额度查询次数不变（无轮询）`)
  eq(calls.order, idleCounts.order, `${width}px：静置 4.5s 查单次数不变（无轮询）`)

  // ---------- [I] 秘密不外泄 ----------
  const panelText = await panel.innerText()
  truthy(!panelText.includes(KEY), `${width}px：DOM 不含完整 Key`)
  truthy(!panelText.includes(CARD_PENDING), `${width}px：DOM 不含完整卡密`)
  const inputValue = await page.getByTestId('ours-redeem-input').inputValue()
  truthy(!inputValue.includes(KEY), `${width}px：输入框不含 Key`)
  const consoleText = consoleMessages.join('\n')
  truthy(!consoleText.includes(KEY), `${width}px：console 不含完整 Key`)
  truthy(!consoleText.includes(CARD_PENDING), `${width}px：console 不含完整卡密`)
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

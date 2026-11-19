// [repro | Issue #75] 「额度与卡密」面板：剩余额度只显示「N 积分」，无 ¥ 折算。
// 用 Playwright Chromium 打开 **dev 产物**（rspack serve，http://127.0.0.1:8090）截图，
// 390 / 360 两个视口 × zh / en 两种语言；两套后端全部 page.route 打桩，不打真实服务。
//
//   pnpm dev                       # 另一个终端
//   node repro/quota-no-cny-shots.mjs
//
// 产物：docs/ui/quota-no-cny/（PNG + 一份 text.json 记录实际渲染文本）
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

import { inviteBaseUrl } from '../scripts/lib/endpoints.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:8090'
const OUT_DIR = path.join(ROOT, 'docs', 'ui', 'quota-no-cny')

const INVITE_API = inviteBaseUrl
const CARD_API = 'https://apia.ecsafe.cn'
const PAY_HOST = 'https://pay.xiaodouap.cn'

const KEY = 'sk-live-repro-ours-8844220011aabbccddeeff'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
}
const json = (status, body) => ({ status, headers: CORS, body: JSON.stringify(body) })

const REMAINING = 100
const profile = () => ({
  invite_code: 'G7TA7UR3',
  invited_count: 1,
  max_invites: 20,
  bonus_points: 10,
  redeemed: true,
  quota_points: REMAINING,
  used_points: 0,
  remaining_points: REMAINING,
  key_status: 'active',
})
const PLANS = {
  plans: [
    { id: 'p1', name: '入门包 100万 token', price: 3.0, points: 300, currency: 'CNY', enabled: true },
    { id: 'p2', name: '标准包 500万 token', price: 39.0, points: 3900, currency: 'CNY', enabled: true },
  ],
}

const wireMock = async (page) => {
  await page.route(`${INVITE_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' })
    if (url.pathname === '/apply') return route.fulfill(json(200, { ...profile(), key: KEY }))
    if (url.pathname === '/me') return route.fulfill(json(200, profile()))
    return route.fulfill(json(404, { error: { code: 'not_found', message: 'no such path' } }))
  })
  await page.route(`${CARD_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' })
    if (url.pathname === '/api/plans') return route.fulfill(json(200, PLANS))
    if (url.pathname === '/api/balance') {
      return route.fulfill(json(200, { api_key: `…${KEY.slice(-6)}`, valid: true }))
    }
    return route.fulfill(json(404, { code: 'ORDER_NOT_FOUND', message: 'no such path' }))
  })
  await page.route(`${PAY_HOST}/**`, async (route) =>
    route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body>支付宝收银台（打桩，不产生真实支付）</body></html>',
    })
  )
}

/** 打开设置 → 数据管理；没弹就点设置按钮（窄屏可能要先展开边栏） */
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

const selectProviderKind = async (page, nameRe) => {
  await page.getByRole('button', { name: /渠道|Channel|服务类型|Service type/ }).first().click()
  await page.getByRole('option', { name: nameRe }).first().click()
  await page.waitForTimeout(400)
}

const openPanel = async (page) => {
  await page.getByTestId('ours-services-open').click()
  const panel = page.getByTestId('ours-services-dialog')
  await panel.waitFor({ state: 'visible' })
  return panel
}

const scrollTo = async (page, testId) => {
  await page.getByTestId(testId).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
}

const CASES = [
  { width: 390, height: 844, locale: 'zh-CN', lang: 'zh' },
  { width: 390, height: 844, locale: 'en-US', lang: 'en' },
  { width: 360, height: 780, locale: 'zh-CN', lang: 'zh' },
  { width: 360, height: 780, locale: 'en-US', lang: 'en' },
]

const evidence = { appUrl: APP_URL, mode: 'Playwright Chromium + rspack dev 产物（非真机）', cases: [] }
const browser = await chromium.launch()
mkdirSync(OUT_DIR, { recursive: true })

for (const testCase of CASES) {
  const { width, height, locale, lang } = testCase
  const context = await browser.newContext({
    locale,
    viewport: { width, height },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  await wireMock(page)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate((value) => {
    window.localStorage.clear()
    window.localStorage.setItem('chat-demo:locale', value)
  }, locale)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)

  await openSettingsData(page)
  await selectProviderKind(page, /我们的渠道|Our Channel/)
  const panel = await openPanel(page)
  await page.waitForTimeout(1500)

  const quotaText = await page.getByTestId('ours-quota-value').innerText()
  const panelText = await panel.innerText()
  // 整个面板（设备码 / 额度 / 邀请 / 套餐）一屏能截全，一张图同时给出额度与套餐价格的对照
  await scrollTo(page, 'ours-quota')
  const panelShot = path.join(OUT_DIR, `panel-${width}x${height}-${lang}.png`)
  await panel.screenshot({ path: panelShot })

  const plansText = await page.getByTestId('ours-plans').innerText()

  evidence.cases.push({
    viewport: `${width}x${height}`,
    locale,
    quotaText,
    planText: plansText.split('\n').slice(0, 8).join(' | '),
    panelHasYen: /¥/.test(panelText),
    panelHasApproxWord: /约可消费|approx/.test(panelText),
    shot: path.relative(ROOT, panelShot).split(path.sep).join('/'),
  })
  console.log(
    `${width}x${height} ${lang}: quota="${quotaText}" ¥=${/¥/.test(panelText)} approx=${/约可消费|approx/.test(panelText)}`
  )
  await context.close()
}

await browser.close()
writeFileSync(path.join(OUT_DIR, 'text.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log(`\n产物目录：${path.relative(ROOT, OUT_DIR).split(path.sep).join('/')}`)

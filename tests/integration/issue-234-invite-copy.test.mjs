// [layer: integration | 依赖: playwright + chromium + 本地静态服务（邀请服务打桩） | 耗时: ~40 秒]
// Issue #234：邀请奖励改版后的 UI 验收（真浏览器，不碰真服务端）。
//
//   第一步先构建标准包（不隐式构建）：
//     DIST_OUT=dist-standard NODE_ENV=production npx rspack build -c rspack.config.ts
//   然后：
//     node tests/run-layer.mjs integration --only issue-234
//
// 背景：2026-11-19 起线上规则改成「只给邀请人发积分」，被邀请人填码 reward_points 就是 0。
// 旧的 `绑定成功，+{points}` 于是渲染成「绑定成功，+0 积分」，看起来像失败。
//
// 断言：
//   [1] 被邀请人成功态（reward_points: 0）→ 「邀请关系已绑定」，不含「积分」也不含「+0」
//   [2] 邀请人态（reward_points: 100）→ 「绑定成功，+100 积分」逐字不变（不能把两边一起改坏）
//   [3] 规则说明来自 /me 的 invite_rules（邀请人 100 / 返现 100），不写死金额、不出现 ¥4.9
//   [4] invite_rules 缺失（老服务端）→ 规则行整行隐藏，且不出现「各得 1 元」这类历史话术
//   [5] 409 circular_invite → 专属文案（互填邀请码），不落到「已经绑定过邀请码」
//   [6] 390 / 360 两个手机视口各存一组截图到 docs/ui/234-invite-copy/
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
import { selectProviderKind } from '../helpers/helpers.mjs'
import { serveDist } from '../helpers/runtime.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const INVITE_API = 'http://140.210.13.146:60013'
const CARD_API = 'https://apia.ecsafe.cn'
const SHOT_DIR = path.join(ROOT, 'docs', 'ui', '234-invite-copy')
const KEY = 'sk-live-e2e-issue234-0011aabbccddeeff'

/** 线上规则（#234）：邀请人 100、被邀请人 0、好友首付后返现 100（门槛 490 分 = ¥4.9） */
const RULES = {
  reward_inviter_points: 100,
  reward_invitee_points: 0,
  cashback_points: 100,
  cashback_min_fen: 490,
}

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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
}
const json = (status, body) => ({ status, headers: CORS, body: JSON.stringify(body) })

const mock = {
  /** 'full' = 服务端下发 invite_rules；'legacy' = 老服务端，没有这个字段 */
  rules: 'full',
  /** /redeem 成功后回的 reward_points（0 = 被邀请人态，100 = 邀请人态） */
  redeemReward: 0,
}
const calls = { apply: 0, me: 0, redeem: 0 }

const profile = () => ({
  customer_id: 4210,
  invite_code: 'G7TA7UR3',
  invited_count: 1,
  max_invites: 30,
  bonus_points: 0,
  redeemed: true,
  quota_points: 200,
  used_points: 20,
  remaining_points: 180,
  key_status: 'active',
  cashback_points: 0,
  ...(mock.rules === 'full' ? { invite_rules: RULES } : {}),
})

const wireMock = async (page) => {
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
    if (url.pathname === '/redeem') {
      calls.redeem += 1
      const body = JSON.parse(request.postData() ?? '{}')
      const code = String(body.invite_code ?? '')
      if (code === 'CIRC1234') {
        // #234：互填邀请码 —— A 邀请了 B，B 又填 A 的码
        await route.fulfill(json(409, { error: { code: 'circular_invite', message: 'circular invite' } }))
        return
      }
      const reward = mock.redeemReward
      await route.fulfill(
        json(200, {
          ...profile(),
          reward_points: reward,
          reward_points_inviter: 100,
          cashback_points: 0,
          synced: true,
        })
      )
      return
    }
    await route.fulfill(json(404, { error: { code: 'not_found', message: 'no such path' } }))
  })

  // 卡密服务：弹层会校验 Key 并拉套餐，给最小桩即可（本用例不验它们）
  await page.route(`${CARD_API}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS, body: '' })
      return
    }
    if (url.pathname === '/api/balance') {
      await route.fulfill(json(200, { api_key: `…${KEY.slice(-6)}`, valid: true }))
      return
    }
    if (url.pathname === '/api/plans') {
      await route.fulfill(json(200, { plans: [] }))
      return
    }
    await route.fulfill(json(404, { code: 'ORDER_NOT_FOUND', message: '路径不存在' }))
  })
}

const server = await serveDist(DIST, { port: Number(process.env.PORT || 0) })
const APP_URL = server.url
const browser = await chromium.launch()
const browserVersion = browser.version()
note(`Chromium ${browserVersion}（Playwright，非 WebView 实机）`)

const runViewport = async ({ width, height }) => {
  console.log(`\n=========== 视口 ${width}×${height} ===========`)
  mock.rules = 'full'
  mock.redeemReward = 0
  for (const key of Object.keys(calls)) calls[key] = 0

  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width, height },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
  await wireMock(page)

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => window.localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await selectProviderKind(page, /我们的渠道|Our Channel/)

  // 打开设置 → 数据管理 → 我们的渠道弹层
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
  await page.getByTestId('ours-services-open').click()
  await page.getByTestId('ours-services-dialog').waitFor({ state: 'visible' })
  // 显式领取（只读弹层不会自动 /apply），换出带 invite_rules 的档案
  await page.getByTestId('ours-open-choice-claim').click()
  await page.waitForTimeout(900)
  eq(calls.apply, 1, `${width}px：点「领取新 Key」才 /apply 一次`)

  const shot = async (name) => {
    mkdirSync(SHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(SHOT_DIR, `234-${name}-${width}.png`) })
    note(`截图 docs/ui/234-invite-copy/234-${name}-${width}.png`)
  }
  const scrollTo = async (testId) => {
    await page.getByTestId(testId).scrollIntoViewIfNeeded()
    await page.waitForTimeout(250)
  }
  const resultText = () => page.getByTestId('ours-invite-result').innerText()
  const submit = async (code) => {
    await page.getByTestId('ours-invite-input').fill(code)
    await page.getByTestId('ours-invite-submit').click()
    await page.waitForTimeout(500)
  }

  // ---------- [3] 规则说明来自 invite_rules ----------
  const rulesBlock = page.getByTestId('ours-invite-rules')
  eq(await rulesBlock.count(), 1, `${width}px：有 invite_rules 时显示规则行`)
  const rulesText = await rulesBlock.innerText()
  truthy(/邀请人得 100 积分/.test(rulesText), `${width}px：邀请人奖励来自服务端（${rulesText.replace(/\n/g, ' / ')}）`)
  truthy(
    /好友首次付款后，邀请人再得 100 积分/.test(rulesText),
    `${width}px：返现奖励来自服务端（不写死金额）`
  )
  truthy(!/被邀请人得 0 积分/.test(rulesText), `${width}px：规则行不出现「被邀请人得 0 积分」`)
  truthy(!/¥|4\.9|各得/.test(rulesText), `${width}px：规则行没有 ¥ 折算，也没有「各得」历史话术`)
  await scrollTo('ours-invite')
  await shot('01-rules-from-server')

  // ---------- [1] 被邀请人成功态：reward_points 0 ----------
  await submit('FRIEND01')
  const inviteeText = await resultText()
  eq(inviteeText, '邀请关系已绑定', `${width}px：被邀请人成功文案（不再显示获得 0 积分）`)
  truthy(!/积分/.test(inviteeText), `${width}px：被邀请人成功文案不含「积分」`)
  truthy(!/\+?\s*0\b/.test(inviteeText), `${width}px：被邀请人成功文案不含 0`)
  eq(await page.getByTestId('ours-invite-input').inputValue(), '', `${width}px：成功后清空输入`)
  await scrollTo('ours-invite')
  await shot('02-invitee-bound')

  // ---------- [2] 邀请人态：reward_points 100，文案逐字不变 ----------
  mock.redeemReward = 100
  await submit('FRIEND02')
  eq(await resultText(), '绑定成功，+100 积分', `${width}px：邀请人态文案保持原样（不能被一起改掉）`)
  await scrollTo('ours-invite')
  await shot('03-inviter-ok')

  // ---------- [5] 409 circular_invite 专属文案 ----------
  await submit('CIRC1234')
  const circularText = await resultText()
  truthy(/互相邀请/.test(circularText), `${width}px：circular_invite 有专属文案（${circularText}）`)
  truthy(
    !/已经绑定过邀请码/.test(circularText),
    `${width}px：circular_invite 不落到「已经绑定过邀请码」`
  )
  await scrollTo('ours-invite')
  await shot('04-circular-invite')

  // ---------- [4] invite_rules 缺失（老服务端）→ 整行隐藏 ----------
  mock.rules = 'legacy'
  await page.getByTestId('ours-quota-refresh').click()
  await page.waitForTimeout(700)
  eq(await page.getByTestId('ours-invite-rules').count(), 0, `${width}px：没有 invite_rules 时不显示规则行`)
  const sectionText = await page.getByTestId('ours-invite').innerText()
  truthy(!/各得|1 元|each get/i.test(sectionText), `${width}px：降级态也没有「双方各得 1 元」这类写死文案`)
  truthy(/已邀请 1 \/ 30 人/.test(sectionText), `${width}px：降级态其余信息照常（邀请码/计数不受影响）`)
  await scrollTo('ours-invite')
  await shot('05-rules-missing')

  eq(consoleErrors, [], `${width}px：没有 pageerror`)
  await context.close()
}

try {
  await runViewport({ width: 390, height: 844 })
  await runViewport({ width: 360, height: 780 })
} finally {
  await browser.close()
  await server.close().catch(() => {})
}

console.log(`\nChromium ${browserVersion}（Playwright 无头，非 WebView 实机）`)
if (failures.length > 0) {
  console.error(`\n✗ 失败 ${failures.length} 项`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过')
}

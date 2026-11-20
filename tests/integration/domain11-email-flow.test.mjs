// [layer: integration | 依赖: playwright + chromium + 标准产物 dist-standard（邀请服务全部 page.route 打桩） | 耗时: ~12s]
//
// 域 11（邮箱账号，Issue #421）的 L1 回归基准 —— Issue #438 按五层落位的第二层。
//
// 为什么这一层不能省：L0（`tests/unit/domain11-email-*.test.mjs`）用的是迷你 React + 假 transport，
// 它证明的是「组件的判断对不对」；这里跑的是**真产物 + 真浏览器 + 真 DOM + 真 localStorage**，
// 证明的是「用户点下去，本地账号是不是真的换了」。三件事只有这一层能钉住：
//   F1 绑定主路径：未绑定 → 发码（`resend_after` 起真实逐秒倒计时）→ 提交验证码 →
//      `action:"bound"` → 显示脱敏邮箱、绑定入口消失、**「复制设备码备份」提示同时消失**
//      （#421 第 5 点：绑上邮箱之后那条提示的前提没了；仍提示就是**错的前提 + 多余的一次催办**）。
//   F2 登录后 device_id 与 Key 必须真的覆盖：`action:"login"` 的响应里带回原账号凭据，
//      界面必须走 `adoptServerDeviceId` 写回本地设备码、并把 Key 落盘。**只显示「已登录」而
//      本地还挂在旧设备码上，是最坏的一种绿** —— 之后每次 /me、兑换都查错账号，用户额度直接看不到。
//   F3 `device_has_account` 冲突选择：409 → 弹窗把「本机原账号额度 / 要换上的邮箱 / 切换后果」
//      摆在用户面前 → 选「用邮箱账号」后用**同一个验证码 + choice** 重发 → 本地账号切换。
//
// 后端全桩（服务端邮箱功能在生产未启用，#421 正文）：`{inviteBaseUrl}` 上四个路径由 page.route 应答，
// 其余一律 404 `not_found` —— 宁可红，也不许悄悄打到真服务。
//
// 与其它层分工（别重复）：错误码逐条映射 / 探测判定的纯函数在 L0；
// 冲突弹窗与倒计时的**秒级**断言（假定时器逐秒 tick）在 L0 的 `domain11-email-conflict`；
// 黄金层只守「未绑定 → 绑定成功 → 显示 masked」这四条主路径里的一条哨兵。
//
//   DIST_OUT=dist-standard node scripts/build.mjs
//   node --test tests/integration/domain11-email-flow.test.mjs
//
// 关联：#421（被测功能）、#438（本基准）、#261（device_id 采用）、docs/testing/coverage/domain-11.md
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { chromium } from 'playwright'
import { ROOT, verifyDist } from '../helpers/env.mjs'
import { serveDist } from '../helpers/runtime.mjs'
import { inviteBaseUrl } from '../../scripts/lib/endpoints.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIST = process.env.DIST_DIR_STANDARD || path.join(ROOT, 'dist-standard')
const INVITE_ORIGIN = new URL(inviteBaseUrl).origin

const DEVICE = 'd-11111111111111111111111111111111'
const OTHER_DEVICE = 'd-22222222222222222222222222222222'
const KEY = 'sk-l1-domain11-device-0000000000000011'
const OTHER_KEY = 'sk-l1-domain11-account-0000000000022'
const EMAIL = 'user@example.com'
const MASKED = 'e***@example.com'
const CODE = '123456'

const DEVICE_KEY = 'chat-demo:ours-device-id'
const API_KEY = 'chat-demo:api-key'
const BACKUP_HINT_KEY = 'chat-demo:ours-device-backup-hint-seen'

/** 产物对不上就 SKIP(env)（不是假红）；对得上才起服务与浏览器 */
verifyDist(DIST, { variant: 'standard' })
const app = await serveDist(DIST, { port: 0 })
const browser = await chromium.launch()

after(async () => {
  await browser.close().catch(() => {})
  await app.close().catch(() => {})
})

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type,accept,x-device-fp',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
}

/** /me 的档案（**不带** has_email：老服务端口径，三态由 /email/status 说） */
const profile = (deviceId) => ({
  invite_code: 'K3M9QW2P',
  invited_count: 0,
  max_invites: 3,
  bonus_points: 0,
  redeemed: false,
  quota_points: 300,
  used_points: 0,
  remaining_points: 300,
  key_status: 'active',
  device_id: deviceId,
})

/**
 * 一套桩：`emailStatus` 是 /email/status 的响应体，`verify` 是「第几次 /email/verify」的响应。
 * 其余路径一律 404 not_found（等价于线上未启用邮箱功能的部署）。
 */
const stubBackend = async (page, { emailStatus, send, verify }) => {
  const calls = { send: [], verify: [], status: 0 }
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== INVITE_ORIGIN) {
      return route.continue()
    }
    const method = request.method()
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' })
    }
    const body = (() => {
      try {
        return request.postData() ? JSON.parse(request.postData()) : null
      } catch {
        return null
      }
    })()
    const reply = (status, payload) =>
      route.fulfill({ status, headers: CORS, body: JSON.stringify(payload) })

    if (url.pathname === '/me') {
      return reply(200, profile(url.searchParams.get('device_id') ?? DEVICE))
    }
    if (url.pathname === '/email/status') {
      calls.status += 1
      return reply(200, emailStatus)
    }
    if (url.pathname === '/email/send-code' && method === 'POST') {
      calls.send.push(body)
      return reply(200, send)
    }
    if (url.pathname === '/email/verify' && method === 'POST') {
      calls.verify.push(body)
      return reply(...verify(calls.verify.length))
    }
    return reply(404, { error: { code: 'not_found', message: `no route ${url.pathname}` } })
  })
  return calls
}

/** 开一个干净上下文：预置渠道 / Key / 设备码，**不**预置备份提示已读标记（要断言它消失） */
const openPanel = async (t, options) => {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  t.after(() => context.close().catch(() => {}))
  const calls = await stubBackend(page, options)
  await page.goto(app.url, { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ deviceKey, apiKey, device, key }) => {
      window.localStorage.clear()
      window.localStorage.setItem('chat-demo:provider-kind', 'ours')
      window.localStorage.setItem(apiKey, key)
      window.localStorage.setItem(deviceKey, device)
    },
    { deviceKey: DEVICE_KEY, apiKey: API_KEY, device: DEVICE, key: KEY }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  if ((await page.getByRole('dialog').count()) === 0) {
    const settings = page.getByRole('button', { name: /设置|Settings/ }).last()
    if (!(await settings.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /打开边栏|Expand sidebar/ }).first().click()
      await page.waitForTimeout(400)
    }
    await settings.click()
  }
  await page.getByRole('tab', { name: /数据管理|Data/ }).first().click()
  await page.waitForTimeout(300)
  await page.getByTestId('ours-services-open').click()
  await page.getByTestId('ours-services-dialog').waitFor({ state: 'visible' })
  // 邮箱入口是弹层打开后才探测的：等它出现（未绑定 → 给「绑定邮箱」）
  await page.getByTestId('ours-email-bind').waitFor({ state: 'visible', timeout: 8000 })
  return { page, calls }
}

const fillEmailForm = async (page) => {
  await page.getByTestId('ours-email-bind').click()
  await page.getByTestId('ours-email-input').fill(EMAIL)
}

const textOf = (page, testId) => page.getByTestId(testId).innerText()

// ---------------------------------------------------------------- F1 绑定主路径

test('F1 绑定：未绑定 → 发码（真实倒计时）→ 提交 → 显示 masked、绑定入口与备份提示同时消失', async (t) => {
  const { page, calls } = await openPanel(t, {
    emailStatus: { has_email: false },
    send: { resend_after: 3 },
    verify: () => [200, { action: 'bound', has_email: true, email_masked: MASKED }],
  })

  // 未绑定：只给「绑定邮箱」，没有脱敏邮箱；备份提示在（#72：没绑的人设备码仍是唯一凭据）
  assert.equal(await page.getByTestId('ours-email-masked').count(), 0, '未绑定时不许出现脱敏邮箱')
  assert.equal(await page.getByTestId('ours-device-backup-hint').count(), 1, '未绑定时备份提示照旧')

  await fillEmailForm(page)
  await page.getByTestId('ours-email-send').click()
  await page.getByTestId('ours-email-sent').waitFor({ state: 'visible' })

  // 发码请求形态：只有 device_id + email（多带字段 = 私自扩契约）
  assert.equal(calls.send.length, 1)
  assert.deepEqual(Object.keys(calls.send[0]).sort(), ['device_id', 'email'])
  assert.equal(calls.send[0].device_id, DEVICE)
  assert.equal(calls.send[0].email, EMAIL)

  // 真实逐秒倒计时：按钮当场禁用并显示剩余秒数，1.2 秒后数字必须变小（不是静态文案）
  const sendButton = page.getByTestId('ours-email-send')
  assert.equal(await sendButton.isDisabled(), true, '倒计时期间发送按钮必须禁用（否则用户会连点撞频控）')
  assert.match(await sendButton.innerText(), /3 秒后可重发/)
  await page.waitForTimeout(1200)
  assert.match(await sendButton.innerText(), /2 秒后可重发/, '倒计时要真的在走，不能是一句静态文案')

  // 提交验证码（倒计时不该拦住「提交」这颗按钮）
  await page.getByTestId('ours-email-code').fill(CODE)
  await page.getByTestId('ours-email-verify').click()
  await page.getByTestId('ours-email-masked').waitFor({ state: 'visible', timeout: 8000 })

  assert.equal(calls.verify.length, 1)
  assert.deepEqual(Object.keys(calls.verify[0]).sort(), ['code', 'device_id', 'email'], '第一次提交不许带 choice')
  assert.equal(calls.verify[0].code, CODE)

  assert.equal(await textOf(page, 'ours-email-masked'), MASKED, '绑定成功要显示服务端给的脱敏邮箱')
  assert.equal(await page.getByTestId('ours-email-bind').count(), 0, '已绑之后不再给绑定入口')
  assert.equal(await textOf(page, 'ours-email-result'), '绑定成功，Key 已保存到本机')
  // #421 第 5 点：绑上邮箱之后「复制设备码备份」的前提没了 —— 仍提示就是错的前提 + 多余的一次催办
  assert.equal(await page.getByTestId('ours-device-backup-hint').count(), 0, '绑定成功后必须收起备份提示')
  // 绑定分支不动凭据
  const stored = await page.evaluate(
    ({ deviceKey, apiKey }) => ({
      device: window.localStorage.getItem(deviceKey),
      key: window.localStorage.getItem(apiKey),
    }),
    { deviceKey: DEVICE_KEY, apiKey: API_KEY }
  )
  assert.deepEqual(stored, { device: DEVICE, key: KEY }, '绑定就是把邮箱挂到当前设备码上，凭据一个字不动')
})

// ---------------------------------------------------------------- F2 登录后覆盖本地账号

test('F2 登录：action:"login" 的 device_id 与 Key 必须真的覆盖到本地（不是只显示「已登录」）', async (t) => {
  const { page, calls } = await openPanel(t, {
    emailStatus: { has_email: false },
    send: { resend_after: 60 },
    verify: () => [200, { action: 'login', device_id: OTHER_DEVICE, key: OTHER_KEY, email_masked: MASKED }],
  })

  await fillEmailForm(page)
  await page.getByTestId('ours-email-send').click()
  await page.getByTestId('ours-email-sent').waitFor({ state: 'visible' })
  await page.getByTestId('ours-email-code').fill(CODE)
  await page.getByTestId('ours-email-verify').click()
  await page.getByTestId('ours-email-result').waitFor({ state: 'visible', timeout: 8000 })

  assert.equal(calls.verify.length, 1)
  assert.equal(calls.verify[0].device_id, DEVICE, '提交时用的仍是本机原来的设备码')

  // 核心断言：本地设备码与 Key 都被换成原账号的（走 adoptServerDeviceId / saveKey，不是另写一套）
  const stored = await page.evaluate(
    ({ deviceKey, apiKey }) => ({
      device: window.localStorage.getItem(deviceKey),
      key: window.localStorage.getItem(apiKey),
    }),
    { deviceKey: DEVICE_KEY, apiKey: API_KEY }
  )
  assert.equal(stored.device, OTHER_DEVICE, '登录成功必须把原账号的 device_id 写回本地')
  assert.equal(stored.key, OTHER_KEY, '原账号的 Key 必须落盘（否则「已登录」是一句空话）')
  assert.equal(await textOf(page, 'ours-email-result'), '已用邮箱登录，本机设备码与 Key 已切换到原账号')
  assert.equal(await page.getByTestId('ours-email-masked').count(), 1, '登录成功后同样要显示脱敏邮箱')
})

// ---------------------------------------------------------------- F3 冲突选择

test('F3 冲突：device_has_account → 弹窗给额度与后果 → 选「用邮箱账号」带同一验证码+choice 重发 → 账号切换', async (t) => {
  const { page, calls } = await openPanel(t, {
    emailStatus: { has_email: false },
    send: { resend_after: 60 },
    verify: (count) =>
      count === 1
        ? [
            409,
            {
              error: {
                code: 'device_has_account',
                device_remaining_points: 100,
                options: ['use_email', 'keep_device'],
                email_masked: MASKED,
              },
            },
          ]
        : [200, { action: 'login', device_id: OTHER_DEVICE, key: OTHER_KEY, email_masked: MASKED }],
  })

  await fillEmailForm(page)
  await page.getByTestId('ours-email-send').click()
  await page.getByTestId('ours-email-sent').waitFor({ state: 'visible' })
  await page.getByTestId('ours-email-code').fill(CODE)
  await page.getByTestId('ours-email-verify').click()

  const conflict = page.getByTestId('ours-email-conflict')
  await conflict.waitFor({ state: 'visible', timeout: 8000 })
  assert.match(await textOf(page, 'ours-email-conflict-points'), /100/, '本机原账号剩余额度必须显示出来')
  assert.match(await textOf(page, 'ours-email-conflict-masked'), /e\*\*\*@example\.com/)
  const warning = await textOf(page, 'ours-email-conflict-warning')
  assert.match(warning, /暂时无法使用/)
  assert.match(warning, /客服/)
  // 冲突不是失败，也不许动凭据
  assert.equal(await page.getByTestId('ours-email-result').count(), 0, '冲突不许落成「操作失败」的错误行')
  assert.equal(
    await page.evaluate((deviceKey) => window.localStorage.getItem(deviceKey), DEVICE_KEY),
    DEVICE,
    '冲突时本地设备码一个字都不动（还没选）'
  )

  await page.getByTestId('ours-email-conflict-use-email').click()
  await page.getByTestId('ours-email-result').waitFor({ state: 'visible', timeout: 8000 })

  assert.equal(calls.verify.length, 2)
  assert.equal(calls.verify[1].choice, 'use_email')
  assert.equal(calls.verify[1].code, calls.verify[0].code, '必须带**同一个**验证码（冲突那次服务端没消耗它）')
  assert.equal(calls.verify[1].email, calls.verify[0].email)
  assert.equal(await conflict.count(), 0, '选完弹窗收起')
  assert.equal(
    await page.evaluate((deviceKey) => window.localStorage.getItem(deviceKey), DEVICE_KEY),
    OTHER_DEVICE,
    '选「用邮箱账号」后本地账号切换'
  )
})

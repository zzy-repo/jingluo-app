// [layer: golden | 依赖: playwright + chromium + 标准产物 dist + 原生桥桩 | 预算: ≤60s]
//
// 黄金回归 · 域 11「邮箱账号」（Issue #438，被测功能 #421）：
//   未绑定 → 点「绑定邮箱」→ 发码 → 提交验证码 → **显示脱敏邮箱**
//
// 为什么只守这一条：黄金层是「用户主路径还在不在」的哨兵，不是分支矩阵。域 11 的分支细节
// （发码频控倒计时、登录覆盖 device_id、`device_has_account` 冲突选择、13 条错误码）分别在
// L0（`tests/unit/domain11-email-*.test.mjs`）与 L1（`tests/integration/domain11-email-flow.test.mjs`），
// 这里**不重复**那些断言 —— 一条断言如果删掉它别处还有用例会因同一处坏掉而红，它就不该出现在这里。
//
// 后端全桩（服务端邮箱功能在生产未启用，#421 正文）：邀请服务（{inviteBaseUrl}）由 CapacitorHttp
// 原生桥替身按路径应答，其余路径一律 404 `not_found`（= 线上未启用邮箱功能时的样子）。
//
// 跑法（仓库根目录）：pnpm run build && node tests/golden/g11-email.test.mjs
import { brief, openGoldenPage, runGolden, serveGoldenApp, waitFor, waitForBoot } from '../helpers/golden.mjs'

const KEY = 'sk-golden-domain11-0000000000000011'
const DEVICE = 'd-33333333333333333333333333333333'
const EMAIL = 'user@example.com'
const MASKED = 'e***@example.com'
const CODE = '123456'

/**
 * 原生桥桩：`/me` 给档案、`/email/status` 说「没绑」、`/email/verify` 回 `action:"bound"`。
 * 四步之外的路径一律 404 —— 主路径若悄悄打了别的接口，会当场红而不是被兜住。
 */
const emailBridgeStub = ({ key, device, masked }) => {
  window.androidBridge = { postMessage: () => {} }
  const state = { calls: [], emailBound: false }
  window.__goldenEmail = state
  const json = (status, body) => ({
    status,
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify(body),
    url: '',
  })
  const profile = () => ({
    invite_code: 'GOLDEN11',
    invited_count: 0,
    max_invites: 20,
    bonus_points: 0,
    redeemed: false,
    quota_points: 300,
    used_points: 0,
    remaining_points: 300,
    key_status: 'active',
    device_id: device,
  })
  const route = (options) => {
    const { pathname } = new URL(String(options?.url ?? ''))
    const method = String(options?.method ?? 'GET').toUpperCase()
    let body = null
    try {
      body = options?.data ? JSON.parse(options.data) : null
    } catch {
      body = null
    }
    state.calls.push({ method, path: pathname, body })
    if (pathname === '/me') {
      return json(200, profile())
    }
    if (pathname === '/email/status') {
      return json(200, state.emailBound ? { has_email: true, email_masked: masked } : { has_email: false })
    }
    if (pathname === '/email/send-code') {
      return json(200, { resend_after: 60 })
    }
    if (pathname === '/email/verify') {
      state.emailBound = true
      return json(200, { action: 'bound', has_email: true, email_masked: masked })
    }
    if (pathname === '/api/balance') {
      return json(200, { api_key: '…0011', valid: true })
    }
    return json(404, { error: { code: 'not_found', message: `no route ${pathname}` } })
  }
  window.Capacitor = {
    PluginHeaders: [{ name: 'CapacitorHttp', methods: [{ name: 'request', rtype: 'promise' }] }],
    nativePromise: async (plugin, method, options) => (plugin === 'CapacitorHttp' ? route(options) : {}),
    nativeCallback: async () => null,
  }
}

const result = await runGolden(
  { id: 'G11', domain: '邮箱账号', title: '未绑定 → 绑定邮箱 → 发码 → 提交 → 显示脱敏邮箱' },
  async (ctx) => {
    const app = await serveGoldenApp()
    const { page, close } = await openGoldenPage(app.url, {
      initScripts: [{ fn: emailBridgeStub, arg: { key: KEY, device: DEVICE, masked: MASKED } }],
      storage: { 'chat-demo:provider-kind': 'ours', 'chat-demo:api-key': KEY, 'chat-demo:ours-device-id': DEVICE },
    })
    try {
      await waitForBoot(page)

      // ── 1. 打开「我们的服务」弹层：邮箱入口出现且处于**未绑定**态 ────────────────
      ctx.begin('打开弹层')
      if ((await page.getByRole('dialog').count()) === 0) {
        await page
          .getByRole('button', { name: /设置|Settings/ })
          .last()
          .click()
      }
      await page
        .getByRole('tab', { name: /数据管理|Data/ })
        .first()
        .click()
      const openButton = page.getByTestId('ours-services-open')
      if (!(await waitFor(page, async () => (await openButton.count()) > 0))) {
        ctx.abort('设置 → 数据管理有「我们的服务」入口', '入口按钮存在', `body=${brief(await bodyTextOf(page))}`)
      }
      await openButton.click()
      const bindReady = await waitFor(page, async () => (await page.getByTestId('ours-email-bind').count()) > 0)
      ctx.expect('未绑定邮箱时给出「绑定邮箱」入口', bindReady, {
        expected: 'ours-email-bind 出现',
        actual: bindReady ? '出现' : '（没有绑定入口）',
      })

      // ── 2. 发码 + 提交验证码 ────────────────────────────────────────────────
      ctx.begin('绑定邮箱')
      await page.getByTestId('ours-email-bind').click()
      await page.getByTestId('ours-email-input').fill(EMAIL)
      await page.getByTestId('ours-email-send').click()
      const sent = await waitFor(page, async () => (await page.getByTestId('ours-email-sent').count()) > 0)
      ctx.expect('发码成功给出「验证码已发送」', sent, {
        expected: 'ours-email-sent 出现',
        actual: sent ? '出现' : '（没有发送提示）',
      })
      await page.getByTestId('ours-email-code').fill(CODE)
      await page.getByTestId('ours-email-verify').click()

      // ── 3. 主路径终点：显示脱敏邮箱，绑定入口收掉 ───────────────────────────
      ctx.begin('显示脱敏邮箱')
      const maskedReady = await waitFor(
        page,
        async () => (await page.getByTestId('ours-email-masked').count()) > 0
      )
      const maskedText = maskedReady ? await page.getByTestId('ours-email-masked').innerText() : ''
      ctx.expect('绑定成功后显示服务端给的脱敏邮箱', maskedText === MASKED, {
        expected: MASKED,
        actual: maskedText || '（没有脱敏邮箱）',
      })
      ctx.expect('已绑定后不再给「绑定邮箱」按钮', (await page.getByTestId('ours-email-bind').count()) === 0, {
        expected: '0 个绑定入口',
        actual: `${await page.getByTestId('ours-email-bind').count()} 个`,
      })
      const resultText = (await page.getByTestId('ours-email-result').count()) > 0
        ? await page.getByTestId('ours-email-result').innerText()
        : ''
      ctx.expect('结果行是绑定成功（不是「操作失败」）', resultText.includes('绑定成功'), {
        expected: '含「绑定成功」',
        actual: brief(resultText),
      })
    } finally {
      await close()
      await app.close()
    }
  }
)

/** `bodyText` 的极简用法包装（abort 消息里要给出页面摘要） */
async function bodyTextOf(page) {
  return page.evaluate(() => document.body?.innerText ?? '')
}

export default result

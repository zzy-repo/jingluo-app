// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 settings/aff/email 源 + renderToStaticMarkup） | Issue #487 阶段③]
//
// **邀请面板 + 邮箱绑定面板主路径**（L1-5 / L1-6 的界面侧）：
//   · 邀请码可复制、已邀请人数、返利 `¥` ——且文案**没有**「填码立刻得积分」这类旧语义残留；
//   · 未绑定 → 绑定流程（发码 → 倒计时逐秒递减 → 提交 → 显示脱敏邮箱）；
//   · 发码 429 按服务端 `Retry-After` 起倒计时（客户端不自造频控窗口）；
//   · `retryable=false` 的失败**不给重试按钮**（重试只会更糟），`retryable=true` 才给。
//
// 旧语义红线（#484 §3.1b / 契约 §3.7）：邀请关系只能在注册时一次填定、返利按比例结算进返利余额；
// 界面上任何「领奖 / 立刻到账 / 积分」的措辞都算回归，所以这里直接对渲染文本断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, zh, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { InvitePanelView, loadInvite } = await import('../../src/components/consume/invitePanel.ts')
const {
  EmailBindPanelView,
  initialEmailBindState,
  reduceEmailBind,
  runBindEmail,
  runLoadEmailBind,
  runSendCode,
  runUnbindEmail,
} = await import('../../src/components/consume/emailBindPanel.ts')
const { emailCooldownRemaining } = await import('../../src/services/invite/emailCooldown.ts')

const ok = (data) => ({ ok: true, status: 200, raw: {}, data })

const fail = ({ status, code, kind, i18nKey, retryable, retryAfterMs }) => ({
  ok: false,
  status,
  raw: {},
  error: {
    kind,
    code,
    message: 'server said something in english',
    status,
    retryable,
    envelope: 'panel',
    i18nKey,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  },
})

const inviteRender = (state) =>
  markupOf(
    InvitePanelView({ t: translate, c: classNames, Button: ButtonStub, state, copied: false, onCopy() {}, onRetry() {} })
  )

const emailRender = (state, remaining) =>
  markupOf(
    EmailBindPanelView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      state,
      remaining,
      onStartBind() {},
      onCancelForm() {},
      onDraftEmail() {},
      onDraftCode() {},
      onSendCode() {},
      onSubmit() {},
      onAskUnbind() {},
      onCancelUnbind() {},
      onUnbind() {},
      onRetry() {},
    })
  )

/** 邮箱源替身：`profile` 决定已绑定/未绑定，`sendCode` / `bind` / `unbind` 记调用 */
const emailSourceOf = ({ bound = false, email = 'ui@mock.local', sendCode, bind } = {}) => {
  const calls = { sendCode: [], bind: [], unbind: [] }
  const source = {
    settings: { get: async () => ok({ emailVerifyEnabled: true, invitationCodeEnabled: true }) },
    auth: {
      profile: async () =>
        ok({ id: 2, email, emailBound: bound, identities: { email: { provider: 'email', bound, canUnbind: true } } }),
    },
    email: {
      sendCode: async (value) => {
        calls.sendCode.push(value)
        return sendCode ?? ok(undefined)
      },
      bind: async (input) => {
        calls.bind.push(input)
        return bind ?? ok({ id: 2, email: input.email, emailBound: true, identities: { email: { provider: 'email', bound: true } } })
      },
      unbind: async () => ok({ id: 2, email: '', emailBound: false, identities: { email: { provider: 'email', bound: false } } }),
    },
  }
  return { source, calls }
}

test('L1 邀请面板：邀请码可复制 + 人数 + 返利 ¥，且没有「填码立刻得积分」的旧语义', async () => {
  const source = {
    settings: { get: async () => ok({ invitationCodeEnabled: true }) },
    aff: {
      detail: async () =>
        ok({
          affCode: 'MOCK-INVITE-9f2c',
          affCount: 3,
          affQuota: 2.5,
          affFrozenQuota: 0,
          effectiveRebateRatePercent: 10,
        }),
    },
  }
  const state = await loadInvite(source)
  assert.equal(state.phase, 'ready')
  const markup = inviteRender(state)

  // ① 邀请码本身 + 「复制」按钮（文案是既有的 `inviteCopyCode`，不是「领取」）
  assert.equal(textOf(markup, 'invite-code-value').includes('MOCK-INVITE-9f2c'), true)
  assert.equal(hasTestId(markup, 'invite-code-copy'), true)
  assert.equal(markup.includes(translate('inviteCopyCode')), true)

  // ② 人数与返利（返利是**元**，符号来自面板唯一的金额格式化口）
  assert.equal(textOf(markup, 'invite-count').includes('3'), true)
  assert.equal(textOf(markup, 'invite-rebate').includes('¥2.50'), true, `返利应显示 ¥2.50，实际 ${textOf(markup, 'invite-rebate')}`)
  assert.equal(markup.includes('$'), false, '返利不许出现美元符号（口径统一为 CNY）')

  // ③ 语义：邀请码只在注册时填，返利按比例结算 —— 没有「立刻到账 / 积分」
  assert.equal(markup.includes(translate('inviteCodeAtRegister')), true)
  assert.equal(zh.inviteCodeAtRegister, '注册时填写邀请码（可选）')
  for (const banned of ['积分', '立刻', '马上到账', '立即领取', '领取奖励']) {
    assert.equal(markup.includes(banned), false, `邀请面板不许出现旧语义「${banned}」`)
  }
  // 也没有「领取 / 兑换」这类客户端做不了的按钮
  assert.equal(/data-testid="invite-(claim|redeem)/u.test(markup), false)
})

test('L1 邮箱绑定：未绑定 → 发码（倒计时逐秒递减）→ 提交 → 显示脱敏邮箱', async () => {
  const { source, calls } = emailSourceOf({ bound: false })
  let state = initialEmailBindState()
  for (const event of await runLoadEmailBind(source)) {
    state = reduceEmailBind(state, event)
  }

  // ① 未绑定：给「绑定邮箱」入口，状态行说「尚未绑定邮箱」
  const view = emailRender(state, 0)
  assert.equal(hasTestId(view, 'email-bind-start'), true)
  assert.equal(textOf(view, 'email-bind-current').includes(translate('emailBindNotBound')), true)

  // ② 进表单 → 发码 → 起倒计时
  state = reduceEmailBind(state, { type: 'mode', mode: 'form' })
  state = reduceEmailBind(state, { type: 'draftEmail', email: 'new@mock.local' })
  const form = emailRender(state, 0)
  assert.equal(hasTestId(form, 'email-bind-form'), true)

  const sentAt = 1_000_000
  for (const event of await runSendCode(source, state.draftEmail, sentAt)) {
    state = reduceEmailBind(state, event)
  }
  assert.deepEqual(calls.sendCode, ['new@mock.local'])
  assert.equal(state.notice, 'codeSent')
  assert.equal(state.cooldown.totalSeconds, 60, '服务端没给秒数时用界面自保的 60s')

  // ③ 逐秒递减：60 → 59 → 58（用截止时刻算，不在组件里累加）
  assert.deepEqual(
    [0, 1000, 2000].map((delta) => emailCooldownRemaining(state.cooldown, sentAt + delta)),
    [60, 59, 58]
  )
  const cooling = emailRender(state, emailCooldownRemaining(state.cooldown, sentAt + 1000))
  assert.equal(hasTestId(cooling, 'email-bind-send-code'), true)
  assert.equal(/data-testid="email-bind-send-code"[^>]*disabled/u.test(cooling), true, '倒计时期间发码按钮要置灰')
  assert.equal(cooling.includes(translate('sub2authCodeSent', { seconds: 59 })), true)
  assert.equal(emailCooldownRemaining(state.cooldown, sentAt + 60_000), 0, '归零就能再发')

  // ④ 提交验证码 → 以服务端返回的账号主体为准（邮箱 + 已绑定），回到展示态
  state = reduceEmailBind(state, { type: 'draftCode', code: '123456' })
  for (const event of await runBindEmail(source, state.draftEmail, state.draftCode)) {
    state = reduceEmailBind(state, event)
  }
  assert.deepEqual(calls.bind, [{ email: 'new@mock.local', code: '123456' }])
  assert.equal(state.mode, 'view')
  assert.equal(state.notice, 'bound')
  const bound = emailRender(state, 0)
  assert.equal(textOf(bound, 'email-bind-current').includes('n•••@mock.local'), true, '已绑定要显示脱敏邮箱')
  assert.equal(hasTestId(bound, 'email-bind-start'), false)

  // ⑤ 解绑（同样二次确认后才是 DELETE）
  assert.equal(hasTestId(bound, 'email-bind-unbind'), true)
  state = reduceEmailBind(state, { type: 'confirmUnbind', value: true })
  assert.equal(hasTestId(emailRender(state, 0), 'email-bind-unbind-confirm'), true)
  for (const event of await runUnbindEmail(source)) {
    state = reduceEmailBind(state, event)
  }
  assert.equal(state.notice, 'unbound')
  assert.equal(textOf(emailRender(state, 0), 'email-bind-current').includes(translate('emailBindNotBound')), true)
})

const RETRY_ROWS = [
  {
    label: 'retryable=false（400 业务拒绝）→ 只给文案，不给重试按钮',
    reply: fail({ status: 400, code: 'BAD_REQUEST', kind: 'bad_request', i18nKey: 'consumeErrBadRequest', retryable: false }),
    expectRetry: false,
  },
  {
    label: 'retryable=true（5xx）→ 给重试按钮（用户自己点，不自动重发）',
    reply: fail({ status: 500, code: 'INTERNAL_ERROR', kind: 'server', i18nKey: 'consumeErrServerUnavailable', retryable: true }),
    expectRetry: true,
  },
]

test('L1 邮箱面板失败态：只有 retryable 才出现「重试」（表驱动）', async (t) => {
  for (const row of RETRY_ROWS) {
    await t.test(row.label, async () => {
      const source = {
        settings: { get: async () => row.reply },
        auth: { profile: async () => ok({ id: 2, email: 'ui@mock.local' }) },
        email: { sendCode: async () => ok(undefined), bind: async () => ok({}), unbind: async () => ok({}) },
      }
      let state = initialEmailBindState()
      for (const event of await runLoadEmailBind(source)) {
        state = reduceEmailBind(state, event)
      }
      assert.equal(state.info.phase, 'failed')
      const markup = emailRender(state, 0)
      assert.equal(hasTestId(markup, 'email-bind-error'), true)
      assert.equal(hasTestId(markup, 'panel-retry'), row.expectRetry)
      // 服务端英文 message 一律不上屏
      assert.equal(markup.includes('server said something in english'), false)
    })
  }
})

test('L1 发码 429：按服务端 Retry-After 起倒计时（不是客户端自造的 60s）', async () => {
  const { source } = emailSourceOf({
    bound: false,
    sendCode: fail({
      status: 429,
      code: 'HTTP_429',
      kind: 'rate_limit',
      i18nKey: 'consumeErrRateLimited',
      retryable: true,
      retryAfterMs: 42_000,
    }),
  })
  let state = initialEmailBindState()
  for (const event of await runLoadEmailBind(source)) {
    state = reduceEmailBind(state, event)
  }
  state = reduceEmailBind(state, { type: 'mode', mode: 'form' })

  const now = 5_000_000
  for (const event of await runSendCode(source, 'new@mock.local', now)) {
    state = reduceEmailBind(state, event)
  }
  assert.equal(state.cooldown.totalSeconds, 42, '秒数来自 Retry-After')
  assert.equal(emailCooldownRemaining(state.cooldown, now), 42)
  assert.equal(state.actionError.i18nKey, 'consumeErrRateLimited', '既要灰按钮，也要说清「太频繁」')
  // 429 可重试，但按钮仍被倒计时挡住 —— 用户看得见「为什么灰着」
  const markup = emailRender(state, emailCooldownRemaining(state.cooldown, now))
  assert.equal(hasTestId(markup, 'email-bind-action-error'), true)
  assert.equal(/data-testid="email-bind-send-code"[^>]*disabled/u.test(markup), true)
})

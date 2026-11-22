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
//
// 文件尾部四张 **D11-B1…B4 边界表**（Issue #448）补的是「服务端没说清」的输入：已绑但不知道邮箱 /
// 形状判定 / 表外状态码与空体 / 附加字段是垃圾值。四张表合计 12 行 —— 正常路径不在这里重测。
// 第五张 **D11-B5**（Issue #660）钉「绑定成功的判据」：200 + 空体不算成功，必须有脱敏邮箱
// （响应体里有，或回查 `/user/profile` 拿得到），否则一律失败且界面不许出现「绑定成功」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, zh, ButtonStub, classNames, markupOf, hasTestId, textOf } = await setupAuthPanels()

const { InvitePanelView, loadInvite } = await import('../../src/components/consume/invitePanelModel.ts')
const {
  EmailBindPanelView,
  initialEmailBindState,
  looksLikeEmail,
  reduceEmailBind,
  runBindEmail,
  runLoadEmailBind,
  runSendCode,
  runUnbindEmail,
  toEmailBindInfo,
} = await import('../../src/components/consume/emailBindPanelModel.ts')
const { emailCooldownRemaining } = await import('../../src/services/invite/emailCooldown.ts')
const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { bindEmail, sendBindEmailCode, unbindProvider } = await import('../../src/services/consume/email.ts')
const { getProfile } = await import('../../src/services/consume/auth.ts')

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
    // #819-v2：`loadInvite` 只读 `aff.detail()`（可见性 = 已登录 + aff 给了邀请码），不再传 settings
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

// ====================================================== #448 边界补集（D11-B1 … D11-B4）
//
// Issue #448：域 11 上四类「确实还没覆盖」的边界，并进本文件（不新建目录 / runner）。
// 四张表一是**服务端没说清**的输入，二是每张表都带反面行 —— 正常路径已经在上面四条用例里，
// 这里一份也不重测（`check:test-duplication` 会抓逐字重复）。

/**
 * 假 transport + 真 `createConsumeHttp` 装配。
 *
 * 为什么要真的传输层：B3/B4 钉的是「`/email/*` 三个端点上的兜底归宿」，
 * 手搓一个 `ConsumeCallResult` 只能证明「面板拿到错误会渲染」，证明不了「错误真的这么分类」。
 * 地址与超时仍然来自 `__ENDPOINTS__.consume`（`setupAuthPanels()` 已注入），零真请求。
 */
const emailHttpWith = (reply) => {
  const calls = []
  const http = createConsumeHttp({
    accessToken: () => 'jwt-448-test',
    transport: async (request) => {
      calls.push(request)
      return typeof reply === 'function' ? reply(request) : reply
    },
  })
  return { http, calls }
}

const readyState = (info) => reduceEmailBind(initialEmailBindState(), { type: 'info', state: { phase: 'ready', data: info } })

// ---------------------------------------------------------------- B1 已绑但缺脱敏邮箱

/**
 * `bound: true` + 邮箱空 = **已绑但不知道是哪个邮箱**。
 *
 * 这是三态里最容易塌成两态的一格：缺字段被读成 `false`，界面就会在老部署上渲染一个点必报错的
 * 「绑定邮箱」入口；反过来拿 id / 用户名凑一个假的脱敏值，比不显示更坏。
 */
const BOUND_WITHOUT_MASKED_ROWS = [
  { what: 'email_bound:true 但没有 email 字段 → bound true + 邮箱空', user: { id: 2, emailBound: true } },
  {
    what: '只有 identities.email.bound（没有便捷投影）→ 与上一行完全同口径',
    user: { id: 2, identities: { email: { provider: 'email', bound: true } } },
  },
]

test('D11-B1 已绑但缺脱敏邮箱：true + 空（不是 false，也不编造邮箱）', async (t) => {
  for (const row of BOUND_WITHOUT_MASKED_ROWS) {
    await t.test(row.what, () => {
      const info = toEmailBindInfo(row.user, { emailVerifyEnabled: false })
      assert.equal(info.bound, true, '服务端说绑了就是绑了：缺 email 不许退化成「未绑定」')
      assert.equal(info.email, '', '邮箱不知道就是空串 —— 不编造，也不拿 id / 用户名凑')
      const view = emailRender(readyState(info), 0)
      assert.equal(hasTestId(view, 'email-bind-unbind'), true, '已绑定 → 给「解绑」入口')
      assert.equal(hasTestId(view, 'email-bind-start'), false, '已绑定 → 不给「绑定邮箱」入口')
      assert.equal(hasTestId(view, 'email-bind-change'), true, '已绑定 → 给「更换」入口')
      const line = textOf(view, 'email-bind-current')
      assert.equal(line.includes(translate('emailBindNotBound')), false, '不许显示「尚未绑定邮箱」')
      assert.equal(line.includes('@'), false, '没有脱敏值时不许凭空出现 @（不许编造）')
    })
  }

  // 同一张表的反面：一条绑定证据都没有 → false（不能一律当成「已绑但不知道」）
  const none = toEmailBindInfo({ id: 2, email: '' }, { emailVerifyEnabled: false })
  assert.equal(none.bound, false)
  assert.equal(none.email, '')
  assert.equal(textOf(emailRender(readyState(none), 0), 'email-bind-current').includes(translate('emailBindNotBound')), true)
})

// ---------------------------------------------------------------- B2 形状判定

/** `looksLikeEmail` 是「发码 / 提交」两处本地拦截的**唯一**来源（界面按钮禁用条件同源） */
const EMAIL_SHAPE_ROWS = [
  { value: 'a@b.co', ok: true, what: '正常邮箱' },
  { value: '  a@b.co  ', ok: true, what: '前后空格 → trim 后再判（粘贴来的常见形态）' },
  { value: 'a@b', ok: false, what: '没有点 → 服务端必然拒，别先发一次请求' },
  { value: 'a b@c.com', ok: false, what: '中间有空格 → 不是邮箱' },
]

test('D11-B2 形状判定表：邮箱形状 + 验证码形状（本地拦 vs 交给服务端）', async (t) => {
  for (const row of EMAIL_SHAPE_ROWS) {
    await t.test(`${row.what}（${JSON.stringify(row.value)}）`, () => {
      assert.equal(looksLikeEmail(row.value), row.ok)
    })
  }
  // 额外反例（不进表，保持四张表合计 12 行）
  for (const junk of ['', '@c.com', 'a@.com', 'a@@c.com']) {
    assert.equal(looksLikeEmail(junk), false, `${JSON.stringify(junk)} 不是邮箱`)
  }

  // 行为面：形状不合格 → **一条请求都不发**，本地文案，且不起倒计时
  const { source, calls } = emailSourceOf({ bound: false })
  let state = reduceEmailBind(initialEmailBindState(), { type: 'mode', mode: 'form' })
  for (const event of await runSendCode(source, 'a@b', 1_000)) {
    state = reduceEmailBind(state, event)
  }
  assert.deepEqual(calls.sendCode, [], '形状不合格时不许发码请求')
  assert.equal(state.actionError.i18nKey, 'sub2authEmailInvalid')
  assert.equal(state.cooldown, null, '本地拒绝不起倒计时（不假装服务端限流）')

  // 验证码：本地只拦「全空白」——**没有** 6 位数字的形状判定，码形状交给服务端 `INVALID_VERIFY_CODE`
  const blank = await runBindEmail(source, 'a@b.co', '   ')
  assert.deepEqual(calls.bind, [], '全空白的验证码在本地就拦，不发请求')
  assert.equal(blank[0].error.i18nKey, 'sub2authCodeInvalid')
  for (const code of ['12', 'abcdef']) {
    const before = calls.bind.length
    await runBindEmail(source, 'a@b.co', code)
    assert.deepEqual(calls.bind[before], { email: 'a@b.co', code }, `非 6 位验证码「${code}」不本地拦：原样交给服务端判`)
  }
})

// ---------------------------------------------------------------- B3 表外状态码 / 空体 / 非 JSON

/** `/email/*` 三个端点的真实调用（走 `services/consume/email.ts`，不手搓结果） */
const EMAIL_ENDPOINT_CALLS = {
  'send-code': (http) => sendBindEmailCode(http, 'a@b.co'),
  bind: (http) => bindEmail(http, { email: 'a@b.co', code: '123456' }),
  unbind: (http) => unbindProvider(http, 'email'),
}

const EMAIL_ENDPOINT_SHAPES = {
  'send-code': { method: 'POST', path: '/api/v1/user/account-bindings/email/send-code' },
  bind: { method: 'POST', path: '/api/v1/user/account-bindings/email' },
  unbind: { method: 'DELETE', path: '/api/v1/user/account-bindings/email' },
}

const OFF_TABLE_STATUS_ROWS = [
  {
    what: '404 + text/plain（反代 / 未知路径）→ unknown，不可重试',
    endpoint: 'send-code',
    reply: { kind: 'response', status: 404, text: '404 page not found', headers: { 'content-type': 'text/plain' } },
    expect: { kind: 'unknown', code: 'HTTP_404', retryable: false, envelope: 'text', i18nKey: 'consumeErrUnknown' },
  },
  {
    what: '500 + 空响应体 → server，仍可重试（5xx 是故障，不是用户错）',
    endpoint: 'bind',
    reply: { kind: 'response', status: 500, text: '', headers: {} },
    expect: { kind: 'server', code: 'HTTP_500', retryable: true, envelope: 'text', i18nKey: 'consumeErrServerUnavailable' },
  },
  {
    what: '418 + 认不出的 JSON（表外状态码 + 表外信封）→ unknown，不可重试，不崩',
    endpoint: 'unbind',
    reply: {
      kind: 'response',
      status: 418,
      text: '{"teapot":"short and stout"}',
      headers: { 'content-type': 'application/json' },
    },
    expect: { kind: 'unknown', code: 'HTTP_418', retryable: false, envelope: 'none', i18nKey: 'consumeErrUnknown' },
  },
  {
    what: '200 + 空响应体（发码）→ 成功：空体 ≠ 失败',
    endpoint: 'send-code',
    reply: { kind: 'response', status: 200, text: '', headers: {} },
    expect: { ok: true },
  },
]

test('D11-B3 表外状态码 / 空响应体 / 非 JSON：每个端点都落到明确分类（不崩、不静默成功）', async (t) => {
  for (const row of OFF_TABLE_STATUS_ROWS) {
    await t.test(row.what, async () => {
      const { http, calls } = emailHttpWith(row.reply)
      // 不 try/catch 包着：真崩了就该红（「不崩」这句断言就是这个意思）
      const result = await EMAIL_ENDPOINT_CALLS[row.endpoint](http)

      const shape = EMAIL_ENDPOINT_SHAPES[row.endpoint]
      assert.equal(calls.length, 1, '一次调用只发一次请求（这一层不做重试）')
      assert.equal(calls[0].method, shape.method)
      assert.equal(calls[0].url.endsWith(shape.path), true, `落点必须是 ${shape.path}，实际 ${calls[0].url}`)
      assert.equal(calls[0].url.startsWith(http.endpoints.baseUrl), true, '地址仍来自 __ENDPOINTS__.consume')

      if (row.expect.ok === true) {
        assert.equal(result.ok, true, '空响应体（204 / 只有头）是成功，不许当失败')
        assert.equal(result.data, undefined)
        return
      }
      assert.equal(result.ok, false, '表外状态码不许静默成功')
      for (const key of ['kind', 'code', 'retryable', 'envelope', 'i18nKey']) {
        assert.equal(result.error[key], row.expect[key], `${row.endpoint} / ${row.what} 的 ${key}`)
      }
      assert.equal(result.raw.status, calls[0] === undefined ? undefined : row.reply.status, '原始状态码原样留着（排查用）')
    })
  }
})

// ---------------------------------------------------------------- B4 附加字段是垃圾值

/**
 * `Retry-After` 不像秒数时 → `retryAfterMs` **不存在**，不是 `0`。
 *
 * 编造 `0` 的后果是「面板以为服务端说现在就能发」，把频控提示和倒计时一起吞掉；
 * `null` 的后果只是「这一次没有秒数」，界面仍照常说「太频繁」。
 * 顺带钉住 `retry_after` / `attempts_left` 这类**旧链路**附加字段在新链路上不存在（没有可编造的值）。
 */
const RETRY_AFTER_ROWS = [
  {
    what: 'Retry-After: abc（不是秒数）→ 不给 retryAfterMs，面板不倒计时',
    header: 'abc',
    retryAfterMs: undefined,
    cooldown: null,
  },
  {
    what: 'Retry-After: 42（正例）→ 42000ms，面板按服务端秒数倒计时',
    header: '42',
    retryAfterMs: 42_000,
    cooldown: 42,
  },
]

test('D11-B4 附加字段垃圾值 → 全 null（绝不编造 0）', async (t) => {
  const rateLimited = (retryAfter) => ({
    kind: 'response',
    status: 429,
    text: '{"error":"rate limit exceeded","message":"slow down"}',
    headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
  })

  for (const row of RETRY_AFTER_ROWS) {
    await t.test(row.what, async () => {
      const { http } = emailHttpWith(rateLimited(row.header))
      const sent = await sendBindEmailCode(http, 'a@b.co')
      assert.equal(sent.ok, false)
      assert.equal(sent.error.kind, 'rate_limit')
      assert.equal(sent.error.i18nKey, 'consumeErrRateLimited', '文案不依赖秒数：没有秒数也照样说「太频繁」')
      assert.equal('retryAfterMs' in sent.error, row.retryAfterMs !== undefined, '垃圾值不许落到 0：字段要么是正确毫秒数，要么干脆不存在')
      assert.equal(sent.error.retryAfterMs, row.retryAfterMs)

      // 面板面：垃圾值 → 不倒计时（不假装频控）；正例 → 按服务端秒数倒计时
      const now = 7_000_000
      // 面板源直接接真服务（`emailSourceOf` 只接受「固定结果」，这里要的是每次真发一次）
      const source = {
        settings: { get: async () => ok({ emailVerifyEnabled: false }) },
        auth: { profile: async () => ok({ id: 2, email: '', emailBound: false }) },
        email: {
          sendCode: (email) => sendBindEmailCode(http, email),
          bind: (input) => bindEmail(http, input),
          unbind: () => unbindProvider(http, 'email'),
        },
      }
      let state = reduceEmailBind(initialEmailBindState(), { type: 'mode', mode: 'form' })
      for (const event of await runSendCode(source, 'a@b.co', now)) {
        state = reduceEmailBind(state, event)
      }
      assert.equal(state.actionError.i18nKey, 'consumeErrRateLimited')
      if (row.cooldown === null) {
        assert.equal(state.cooldown, null, '没有秒数就不倒计时 —— 但要靠文案说清「太频繁」')
      } else {
        assert.equal(state.cooldown.totalSeconds, row.cooldown)
        assert.equal(emailCooldownRemaining(state.cooldown, now), row.cooldown)
      }
    })
  }

  // 另外两种「看起来像个数但不是秒数」：0（= 没给）与 HTTP-date（HTTP 允许，但客户端不猜）
  for (const junk of ['0', '-5', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    const { http } = emailHttpWith(rateLimited(junk))
    const sent = await sendBindEmailCode(http, 'a@b.co')
    assert.equal('retryAfterMs' in sent.error, false, `Retry-After「${junk}」不许被折成 0`)
  }
})

// ====================================================== #660 绑定成功判据（D11-B5）
//
// 病灶（#660）：`POST /user/account-bindings/email` 回 **200 + 空响应体**时，客户端只看 200 就判成功，
// 界面显示「已绑定」而脱敏邮箱是空的 —— 用户以为绑好了，换机时取不回账号（那正是邮箱绑定的唯一价值）。
//
// 这张表钉的是**成功判据**：必须拿到可显示的脱敏邮箱 ——
//   ① 响应体里有 `email_masked`（实测形态只有 `email`，两种都认）；或
//   ② 回查一次 `GET /user/profile` 拿得到；两者都没有 → **必须是失败**，且界面不许出现「绑定成功」。
// 断言全部走真 `createConsumeHttp` + 假 transport（真 service / 真面板 / 零真请求），
// 所以「回查只发 1 次」是**数请求**数出来的，不是靠读代码。

/** 面板信封的成功体（`{code:0,message,data}`，`data` 缺省 = 200 + 空体的等价形态） */
const panelOk = (data) => JSON.stringify(data === undefined ? { code: 0, message: 'success' } : { code: 0, message: 'success', data })

const jsonReply = (status, body) => ({
  kind: 'response',
  status,
  text: body,
  headers: { 'content-type': 'application/json' },
})

const emptyReply = (status) => ({ kind: 'response', status, text: '', headers: {} })

/**
 * 一条「绑定 + 回查」链：`bind` 与 `profile` 各自给一个假响应，按 URL 分派。
 * 计数口径：`profileCalls` 只数 `/api/v1/user/profile`（回查），`bindCalls` 数 POST。
 */
const bindChainOf = ({ bind, profile }) => {
  const calls = []
  const http = createConsumeHttp({
    accessToken: () => 'jwt-660-test',
    transport: async (request) => {
      calls.push(request)
      return request.url.includes('/api/v1/user/profile') ? profile : bind
    },
  })
  const source = {
    settings: { get: async () => ok({ emailVerifyEnabled: false }) },
    auth: { profile: () => getProfile(http) },
    email: {
      sendCode: (email) => sendBindEmailCode(http, email),
      bind: (input) => bindEmail(http, input),
      unbind: () => unbindProvider(http, 'email'),
    },
  }
  return {
    source,
    http,
    calls,
    bindCalls: () => calls.filter((item) => item.url.endsWith('/api/v1/user/account-bindings/email')).length,
    profileCalls: () => calls.filter((item) => item.url.includes('/api/v1/user/profile')).length,
  }
}

const BIND_VERDICT_ROWS = [
  {
    what: '200 + 响应体里有 email_masked → 判成功，显示服务端脱敏值（省一次请求）',
    bind: jsonReply(200, panelOk({ id: 2, email: '', email_masked: 'a***@b.co' })),
    profile: jsonReply(200, panelOk({ id: 2, email: '' })),
    expect: { ok: true, shown: 'a***@b.co', profileCalls: 0 },
  },
  {
    what: '200 + 只有 email（实测下发形态）→ 判成功，本地脱敏',
    bind: jsonReply(200, panelOk({ id: 2, email: 'a@b.co', identities: { email: { provider: 'email', bound: true } } })),
    profile: jsonReply(200, panelOk({ id: 2, email: '' })),
    expect: { ok: true, shown: 'a•••@b.co', profileCalls: 0 },
  },
  {
    what: '200 + 空响应体 + 回查 profile 有 email_masked → 判成功（回查兜住）',
    bind: emptyReply(200),
    profile: jsonReply(200, panelOk({ id: 2, email: '', email_masked: 'a***@b.co' })),
    expect: { ok: true, shown: 'a***@b.co', profileCalls: 1 },
  },
  {
    what: '200 + 空响应体 + 回查 profile 没有脱敏邮箱（只有 bound:true）→ 判失败，不显示「已绑定」',
    bind: emptyReply(200),
    profile: jsonReply(200, panelOk({ id: 2, email: '', identities: { email: { provider: 'email', bound: true } } })),
    expect: { ok: false, unconfirmed: true, i18nKey: 'consumeErrBindUnconfirmed', profileCalls: 1 },
  },
  {
    what: '200 + 空响应体 + 回查本身失败（500）→ 仍是「结果未确认」，不判成功',
    bind: emptyReply(200),
    profile: jsonReply(500, '{"code":500,"message":"internal error"}'),
    expect: { ok: false, unconfirmed: true, i18nKey: 'consumeErrBindUnconfirmed', profileCalls: 1 },
  },
  {
    what: '400 + INVALID_VERIFY_CODE → 走既有文案（不回归），附 HTTP 码 + 脱敏原文',
    bind: jsonReply(400, '{"code":400,"message":"verify code is incorrect","reason":"INVALID_VERIFY_CODE"}'),
    profile: jsonReply(200, panelOk({ id: 2, email: '' })),
    expect: { ok: false, i18nKey: 'consumeErrEmailCodeInvalid', profileCalls: 0, detail: ['HTTP 400', 'INVALID_VERIFY_CODE', 'verify code is incorrect'] },
  },
  {
    what: '409 + EMAIL_ALREADY_BOUND → 既有兜底文案不变，附 HTTP 码 + 脱敏原文',
    bind: jsonReply(409, '{"code":409,"message":"email already bound","reason":"EMAIL_ALREADY_BOUND"}'),
    profile: jsonReply(200, panelOk({ id: 2, email: '' })),
    expect: { ok: false, i18nKey: 'consumeErrUnknown', profileCalls: 0, detail: ['HTTP 409', 'EMAIL_ALREADY_BOUND', 'email already bound'] },
  },
]

test('D11-B5 绑定成功判据：没有脱敏邮箱就不算成功（空体回查兜底，只查一次）', async (t) => {
  for (const row of BIND_VERDICT_ROWS) {
    await t.test(row.what, async () => {
      const { source, bindCalls, profileCalls } = bindChainOf(row)

      // 起点：面板已加载、未绑定、处于填写态（`runBindEmail` 只负责「提交 → 结果」这一段）
      let state = reduceEmailBind(initialEmailBindState(), {
        type: 'info',
        state: { phase: 'ready', data: toEmailBindInfo({ id: 2, email: '' }, { emailVerifyEnabled: false }) },
      })
      state = reduceEmailBind(state, { type: 'mode', mode: 'form' })
      for (const event of await runBindEmail(source, 'a@b.co', '123456')) {
        state = reduceEmailBind(state, event)
      }

      // 先判「用户看到什么」（负向对照改回只看 200 时，红的应该是这一句，不是计数）
      const markup = emailRender(state, 0)
      if (row.expect.ok === true) {
        assert.equal(state.actionError, null, '成功时不该有错误')
        assert.equal(state.notice, 'bound')
        assert.equal(state.mode, 'view', '成功回到展示态')
        assert.equal(hasTestId(markup, 'email-bind-notice'), true)
        assert.equal(markup.includes(translate('emailBindSuccess')), true)
        const line = textOf(markup, 'email-bind-current')
        assert.equal(line.includes(row.expect.shown), true, `脱敏邮箱必须是「${row.expect.shown}」，实际「${line}」`)
        assert.equal(hasTestId(markup, 'email-bind-start'), false, '已绑定后不再给「绑定邮箱」入口')
      } else {
      // 失败面：既不许说「绑定成功」，也不许把状态改成已绑定
      assert.equal(state.notice, null, '失败 / 未确认时不许显示「绑定成功」')
      assert.equal(state.actionError.i18nKey, row.expect.i18nKey)
      assert.equal(markup.includes(translate('emailBindSuccess')), false, 'UI 不许出现「绑定成功」')
      assert.equal(textOf(markup, 'email-bind-current').includes(translate('emailBindNotBound')), true, '状态仍是未绑定（不自称已绑定）')
      assert.equal(state.mode, 'form', '失败后留在填写态，用户可以直接重试')

      if (row.expect.unconfirmed === true) {
        const copy = textOf(markup, 'email-bind-action-error')
        assert.equal(copy.includes(translate('consumeErrBindUnconfirmed')), true, '文案必须说清「结果未确认」')
        assert.equal(copy.includes('重试'), true, '文案必须给下一步：重试')
        assert.equal(copy.includes('账号页'), true, '文案必须给下一步：到账号页查看')
        assert.equal(hasTestId(markup, 'email-bind-action-error-detail'), false, '结果未知时不贴上游细节（服务端没有可信结论）')
      }
      if (row.expect.detail !== undefined) {
        const detail = textOf(markup, 'email-bind-action-error-detail')
        for (const part of row.expect.detail) {
          assert.equal(detail.includes(part), true, `上游细节里必须有「${part}」，实际「${detail}」`)
        }
      }
      }

      // 计数断言：绑定只发一次；回查（若需要）**恰好一次** —— 一次失败不许放大成多次写后查询
      assert.equal(bindCalls(), 1, '绑定请求只发一次（这一层不做重试）')
      assert.equal(profileCalls(), row.expect.profileCalls, `回查 /user/profile 的请求数必须是 ${row.expect.profileCalls}`)
    })
  }
})

/**
 * 同一张表的**服务层**反面：判据住在 `bindEmail` 里，绕过面板直接调也必须是失败。
 *
 * （面板只是渲染 `ok:false`；如果判据只在视图里，任何别的调用方都会重新踩回 #660。）
 */
test('D11-B5b 服务层：200 + 空体且回查没有脱敏邮箱 → bindEmail 自己就得是 ok:false', async () => {
  const { http, profileCalls } = bindChainOf({
    bind: emptyReply(200),
    profile: jsonReply(200, panelOk({ id: 2, email: '' })),
  })
  const result = await bindEmail(http, { email: 'a@b.co', code: '123456' })
  assert.equal(result.ok, false, '只看 200 的判据必须已经不在了')
  assert.equal(result.error.i18nKey, 'consumeErrBindUnconfirmed')
  assert.equal(result.error.retryable, true, '结果未知可以重试')
  assert.equal(result.raw.status, 200, '原始状态码留着（排查用）')
  assert.equal(profileCalls(), 1, '回查只发 1 次')
})

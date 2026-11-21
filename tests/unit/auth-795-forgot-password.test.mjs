// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 source + renderToStaticMarkup） | Issue #795]
//
// **忘记密码**（`settingsAuthCardModel.ts` 的 `submitForgotPassword` / `forgotOutcomeOf` + 卡内小页）。
//
// 单子上的病灶是「忘了密码就只能弃号」，所以这条流程的态度很关键：**不许假装成功**。
// staging 上 `POST /api/v1/auth/forgot-password` 现在真的回
// `{"code":500,"message":"Password reset is not configured"}`（服务端没配 `frontend_url` / SMTP），
// 界面必须把这句话**原样**端给用户，再补一句「请联系客服」—— 既不能说「已发送」，也不能吞成
// 「未知错误」（用户拿着「未知错误」既不知道自己该干什么，也没法向客服描述）。
//
// 三条验收（对应 #795 要求里的第 1–3 步）：
//   ① 空邮箱：本地提示「请先填写邮箱」，**一条请求都不发**
//   ② 后端 500：原样展示后端 message + 「密码重置暂未开通，请联系客服」，**不显示成功**
//   ③ 后端成功：显示「重置邮件已发送，请查收邮箱」
//
// 另加两条边界：
//   · 传输层失败（`status === 0`：超时 / 连不上）没有后端原话可抄 → 退回归一化文案，且**不**追
//     「暂未开通」（网络问题不等于功能没开）；
//   · 入口与返回：点「忘记密码？」进小页、点「返回登录」回表单（卡内小页，不叠第二层 dialog）。
//
// 未覆盖（本期不做，见交付说明）：重置页（`?token=...` 深链）。Capacitor 没有 app-link 配置、
// 仓库里也没有既有深链约定，链接指向的是 sub2api 面板的 `/reset-password`，本 App 收不到。
//
//   node tests/unit/auth-795-forgot-password.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf, zh } = await setupAuthPanels()

const { createElement } = await import('react')
const { parseSub2ApiError } = await import('../../src/services/consume/errors.ts')
const { forgotOutcomeOf, initialAuthCardState, reduceAuthCard, SettingsAuthCardView, submitForgotPassword } = await import(
  '../../src/components/consume/settingsAuthCardModel.ts'
)

const EyeOpen = () => createElement('svg', { 'data-icon': 'eye-open' })
const EyeClosed = () => createElement('svg', { 'data-icon': 'eye-closed' })

/**
 * 一次归一化失败（形状照 `Sub2ApiError` 抄：`status > 0` = 真的拿到了后端响应，`message` 是后端原话）。
 *
 * 两个真实样本：
 *  · staging `POST /auth/forgot-password` → 500 `Password reset is not configured`（服务端没配重置链接）
 *  · 关掉开关时 → 403 `password reset is not enabled`（`PASSWORD_RESET_DISABLED`）
 */
const failure = ({ status = 500, message = 'Password reset is not configured', i18nKey = 'consumeErrServerUnavailable' } = {}) => ({
  ok: false,
  status,
  raw: {},
  error: { kind: status >= 500 ? 'server' : 'auth', code: `HTTP_${status}`, message, status: 0 === status ? 0 : status, retryable: status >= 500, envelope: 'panel', i18nKey },
})

/** 假后端：`forgotPassword` 只记调用，按 `reply` 应答 */
const fakeSource = (reply = { ok: true, status: 200, raw: {}, data: undefined }) => {
  const calls = { signIn: [], signUp: [], forgotPassword: [] }
  return {
    calls,
    source: {
      signIn: async (input) => {
        calls.signIn.push(input)
        return { ok: true }
      },
      signUp: async (input) => {
        calls.signUp.push(input)
        return { ok: true }
      },
      forgotPassword: async (input) => {
        calls.forgotPassword.push(input)
        return reply
      },
    },
  }
}

/** 只渲染「忘记密码」那一页（其余回调留空：本文件断言的是文案与是否发请求） */
const renderForgot = (state) =>
  markupOf(
    SettingsAuthCardView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      EyeIcon: EyeOpen,
      EyeOffIcon: EyeClosed,
      state,
      submitting: false,
      sendingCode: false,
      countdown: 0,
      errorKey: null,
      registrationLoaded: true,
      registrationEnabled: true,
      onEvent() {},
      onSubmit() {},
      onSendCode() {},
      onForgotSubmit() {},
      onSkip() {},
    })
  )

/** 取某个 `<p data-testid=...>` 的**整段**文本（`textOf` 会带上后面的兄弟节点，逐字断言要用这个） */
const exactTextOf = (markup, testId) => {
  const matched = markup.match(new RegExp(`<p[^>]*data-testid="${testId}"[^>]*>([^<]*)</p>`))
  return matched === null ? '' : matched[1]
}

/** 走一遍「打开小页 → 填邮箱 → 提交」的状态推进，返回最终状态 */
const runForgot = async (source, { email = 'ui@mock.local' } = {}) => {
  let state = reduceAuthCard(initialAuthCardState('login'), { type: 'step', step: 'forgot' })
  if (email !== '') {
    state = reduceAuthCard(state, { type: 'email', value: email })
  }
  state = reduceAuthCard(state, { type: 'forgot-sending' })
  const events = await submitForgotPassword(source, state)
  return events.reduce((current, event) => reduceAuthCard(current, event), state)
}

test('① 空邮箱：本地提示先填邮箱，一条请求都不发', async () => {
  const { calls, source } = fakeSource()
  const state = await runForgot(source, { email: '' })

  assert.equal(calls.forgotPassword.length, 0, '**空邮箱不许发请求**（白跑一趟网络没有意义）')
  assert.deepEqual(state.forgot.outcome, { status: 'needs-email' })
  assert.equal(state.forgot.sending, false)

  const markup = renderForgot(state)
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-status'), zh.settingsAuthForgotNeedsEmail)
  assert.equal(markup.includes(zh.settingsAuthForgotSent), false, '空邮箱绝不能显示「已发送」')
})

test('② 后端 500：原样展示后端 message + 「密码重置暂未开通，请联系客服」，不显示成功', async () => {
  const { calls, source } = fakeSource(failure())
  const state = await runForgot(source)

  assert.deepEqual(calls.forgotPassword, [{ email: 'ui@mock.local' }], '请求体只有 email')
  assert.equal(state.forgot.outcome.status, 'failed')
  assert.equal(state.forgot.outcome.serverMessage, 'Password reset is not configured', '后端原话要原样留住')
  assert.equal(state.forgot.outcome.hintKey, 'settingsAuthForgotNotReady')

  const markup = renderForgot(state)
  const messageText = exactTextOf(markup, 'settings-auth-forgot-error-message')
  const hintText = exactTextOf(markup, 'settings-auth-forgot-error-hint')
  assert.equal(messageText, 'Password reset is not configured', '必须**原样**展示后端 message，不做替换')
  assert.equal(hintText, zh.settingsAuthForgotNotReady)
  assert.equal(hintText, '密码重置暂未开通，请联系客服')

  // 三条「不许」：不许假装成功、不许吞错、不许显示「未知错误」
  assert.equal(markup.includes(zh.settingsAuthForgotSent), false, '失败不许显示「已发送」')
  assert.equal(hasTestId(markup, 'settings-auth-forgot-status'), true, '失败必须有可见的错误块')
  assert.equal(markup.includes('未知错误'), false)
  assert.equal(markup.includes(zh.consumeErrUnknown), false, '失败信息不能被兜底文案吃掉')
})

test('②-补 403「重置功能未开」与 500「未配置」同一套展示口径（都按后端原话 + 可操作提示）', async () => {
  const { source } = fakeSource(failure({ status: 403, message: 'password reset is not enabled', i18nKey: 'consumeErrForbidden' }))
  const state = await runForgot(source)

  const markup = renderForgot(state)
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-error-message'), 'password reset is not enabled')
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-error-hint'), zh.settingsAuthForgotNotReady)
  assert.equal(markup.includes(zh.settingsAuthForgotSent), false)
})

test('②-补2 真实 staging 响应体（HTTP 500 `{"code":500,"message":"Password reset is not configured"}`）→ 归一化 → 上屏就是那句原话', () => {
  // 2026-11-21 实测：`curl -X POST https://apia.ecsafe.cn/staging/api/v1/auth/forgot-password`
  // → HTTP 500，体就是这两行。这里把它**原样**喂给 `errors.ts` 的归一化，再喂给本卡，
  // 证明「后端原话」不是我在测试里编的字符串，而是一路带过来的（中间没被换成兜底文案）。
  const raw = {
    status: 500,
    ok: false,
    text: '{"code":500,"message":"Password reset is not configured"}',
    json: { code: 500, message: 'Password reset is not configured' },
    headers: { 'content-type': 'application/json' },
    contentType: 'application/json',
  }
  const error = parseSub2ApiError(raw)
  assert.equal(error.status, 500)
  assert.equal(error.message, 'Password reset is not configured', '归一化层不许改写服务端 message')

  const outcome = forgotOutcomeOf({ ok: false, status: 500, raw, error })
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.serverMessage, 'Password reset is not configured')
  assert.equal(outcome.hintKey, 'settingsAuthForgotNotReady')

  let state = reduceAuthCard(initialAuthCardState('login'), { type: 'step', step: 'forgot' })
  state = reduceAuthCard(state, { type: 'email', value: 'ui@mock.local' })
  state = reduceAuthCard(state, { type: 'forgot-outcome', outcome })
  const markup = renderForgot(state)
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-error-message'), 'Password reset is not configured')
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-error-hint'), '密码重置暂未开通，请联系客服')
  assert.equal(markup.includes(zh.settingsAuthForgotSent), false, '真实 500 下绝不显示「已发送」')
})

test('③ 后端成功：显示「重置邮件已发送，请查收邮箱」', async () => {
  const { calls, source } = fakeSource()
  const state = await runForgot(source)

  assert.equal(calls.forgotPassword.length, 1)
  assert.deepEqual(state.forgot.outcome, { status: 'sent' })
  const markup = renderForgot(state)
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-status'), zh.settingsAuthForgotSent)
  assert.equal(hasTestId(markup, 'settings-auth-forgot-error-hint'), false, '成功时不该出现失败提示')
})

test('边界：传输层失败（没拿到响应）退回归一化文案，且**不**说「暂未开通」', async () => {
  const { source } = fakeSource({
    ok: false,
    status: 0,
    raw: {},
    error: {
      kind: 'network',
      code: 'NETWORK',
      message: '连不上服务端（没拿到响应）',
      status: 0,
      retryable: true,
      envelope: 'none',
      i18nKey: 'consumeErrNetwork',
    },
  })
  const state = await runForgot(source)
  const outcome = state.forgot.outcome

  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.serverMessage, null, '没拿到响应就没有「后端原话」')
  assert.equal(outcome.fallbackKey, 'consumeErrNetwork')
  assert.equal(outcome.hintKey, null, '网络问题不是「功能没开」，不许误导用户去找客服')

  const markup = renderForgot(state)
  assert.equal(exactTextOf(markup, 'settings-auth-forgot-error-message'), zh.consumeErrNetwork)
  assert.equal(hasTestId(markup, 'settings-auth-forgot-error-hint'), false)

  // 纯函数口径再钉一次（视图就是照它渲染的）
  assert.deepEqual(forgotOutcomeOf({ ok: true, status: 200, raw: {}, data: undefined }), { status: 'sent' })
})

test('入口与返回：点「忘记密码？」进小页，点「返回登录」回表单（卡内小页，不叠第二层）', () => {
  const form = initialAuthCardState('login')
  const markupForm = renderForgot(form)
  assert.equal(hasTestId(markupForm, 'settings-auth-forgot'), true, '登录卡底部必须有「忘记密码？」入口')
  assert.equal(hasTestId(markupForm, 'settings-auth-forgot-form'), false, '表单页不该同时渲染小页')

  const forgot = reduceAuthCard(form, { type: 'step', step: 'forgot' })
  const markupForgot = renderForgot(forgot)
  assert.equal(hasTestId(markupForgot, 'settings-auth-forgot-form'), true)
  assert.equal(hasTestId(markupForgot, 'settings-auth-forgot-email'), true)
  assert.equal(hasTestId(markupForgot, 'settings-auth-forgot-submit'), true)
  // 小页里没有遮罩 / 二级 dialog（本卡的老规矩：它本身就是设置弹层的内容）
  assert.equal(markupForgot.includes('role="dialog"'), false)
  assert.equal(textOf(markupForgot, 'settings-auth-forgot-form').includes(zh.settingsAuthForgotTitle), true)

  // 返回表单，并且上一次的结局被清掉（再进来不会看到旧红字）
  const back = reduceAuthCard(forgot, { type: 'step', step: 'form' })
  assert.equal(back.step, 'form')
  assert.deepEqual(back.forgot.outcome, null)
  assert.equal(hasTestId(renderForgot(back), 'settings-auth-forgot-form'), false)
})

// [layer: unit | L1 流程级 | 依赖: 无（纯 Node + 假 source + renderToStaticMarkup） | Issue #797]
//
// **注册的「确认密码」与密码可见切换**（`settingsAuthCardModel.ts` + `passwordInput.ts`）。
//
// 被测的是真代码：状态机 / 提交判定 / 视图全在 `.ts` 里（见 model 文件头为什么不用 `.tsx`），
// 所以「有没有发请求」「按钮的 type 变没变」都能在裸 Node 里钉住，不需要 dev server、不需要 DOM。
//
// 五条验收（对应 #797 的 checklist）：
//   ① 两次一致 → 提交，且真的发出一条注册请求（`signUp` 被调 1 次）
//   ② 两次不一致 → 提交前就拦下，**一个注册请求都不发**（`calls.signUp.length === 0`）+ 屏幕上有
//     「两次输入的密码不一致」+ 确认密码带 `aria-invalid`
//   ③ 改任一框后重新校验：改密码或改确认密码，错误都会跟着现算（同一个判据 `confirmErrorKeyOf`）
//   ④ 点眼睛按钮：`type` 在 password / text 之间切换、**值一个字符都不丢**、`aria-pressed` 与
//     `aria-label`（显示密码 / 隐藏密码）跟着状态走；两个框各自独立
//   ⑤ 登录 tab **没有**确认密码字段，但同样复用了带眼睛的密码框
//
//   node tests/unit/auth-797-confirm-password.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { setupAuthPanels } from '../helpers/auth-panels-env.mjs'

const { translate, ButtonStub, classNames, markupOf, hasTestId, textOf, zh } = await setupAuthPanels()

const { createElement } = await import('react')
const {
  authCardCanSubmit,
  confirmErrorKeyOf,
  initialAuthCardState,
  reduceAuthCard,
  SettingsAuthCardView,
  submitAuthCard,
} = await import('../../src/components/consume/settingsAuthCardModel.ts')
const { nextPasswordVisibility, passwordInputType, passwordToggleLabelKey } = await import(
  '../../src/components/consume/passwordInput.ts'
)

/** 两枚眼睛图标的替身：真机是 `base/icons.tsx` 的 SVG，单测只需要「渲染不炸 + 可辨认」 */
const EyeOpen = () => createElement('svg', { 'data-icon': 'eye-open' })
const EyeClosed = () => createElement('svg', { 'data-icon': 'eye-closed' })

/** 假后端：三个口子只记调用，全部答成功（失败路径在 #795 的文件里覆盖） */
const fakeSource = () => {
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
        return { ok: true, data: undefined }
      },
    },
  }
}

/** 把视图真渲染一次（表单一页；默认注册 tab、开关全开） */
const render = (over = {}) =>
  markupOf(
    SettingsAuthCardView({
      t: translate,
      c: classNames,
      Button: ButtonStub,
      EyeIcon: EyeOpen,
      EyeOffIcon: EyeClosed,
      state: initialAuthCardState('register'),
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
      ...over,
    })
  )

/** 取某个 `data-testid` 的 `<input>` 原始标签（静态标记里属性顺序 = props 顺序，够用） */
const inputTagOf = (markup, testId) => {
  const matched = markup.match(new RegExp(`<input[^>]*data-testid="${testId}"[^>]*>`))
  return matched === null ? '' : matched[0]
}

/** 从标签里读一个属性值（读不到给空串，让断言信息说人话） */
const attrOf = (tag, name) => {
  const matched = tag.match(new RegExp(` ${name}="([^"]*)"`))
  return matched === null ? '' : matched[1]
}

/** 批量派事件（模拟用户操作序列） */
const dispatchAll = (state, events) => events.reduce((current, event) => reduceAuthCard(current, event), state)

/** 注册 tab + 邮箱 + 两次密码（`confirm` 为 undefined 时不动确认密码） */
const filled = ({ password = 'abcd1234', confirm = 'abcd1234', mode = 'register' } = {}) =>
  dispatchAll(initialAuthCardState(mode), [
    { type: 'email', value: 'ui@mock.local' },
    { type: 'password', value: password },
    ...(confirm === undefined ? [] : [{ type: 'confirm', value: confirm }]),
  ])

test('① 两次一致：允许提交，且真的发出注册请求（请求体里没有 confirmPassword）', async () => {
  const { calls, source } = fakeSource()
  const state = filled()

  assert.equal(authCardCanSubmit(state, false), true, '两次一致时主按钮必须可用')
  assert.equal(confirmErrorKeyOf(state), null, '一致时不该有错误文案')

  const events = await submitAuthCard(source, state, {
    submitting: false,
    registrationLoaded: true,
    registrationEnabled: true,
  })

  assert.equal(calls.signUp.length, 1, '一致 → 必须发出一次注册请求')
  assert.deepEqual(calls.signUp[0], { email: 'ui@mock.local', password: 'abcd1234' })
  // #797：确认密码**只在客户端校验**，不进请求体
  assert.equal('confirmPassword' in calls.signUp[0], false, '确认密码不许传给服务端')
  assert.deepEqual(events, [{ type: 'form-submitted' }], '请求发出后要派「已提交」（界面据此恢复隐藏）')
  assert.equal(calls.signIn.length, 0, '注册 tab 不该走登录')
})

test('② 两次不一致：提交前拦下，一个注册请求都不发，屏幕上有「两次输入的密码不一致」', async () => {
  const { calls, source } = fakeSource()
  const state = filled({ password: 'abcd1234', confirm: 'abcd12345' })

  assert.equal(authCardCanSubmit(state, false), false, '不一致时主按钮必须禁用（提交前就提示，不是提交后才报）')
  assert.equal(confirmErrorKeyOf(state), 'settingsAuthPasswordMismatch')

  const events = await submitAuthCard(source, state, {
    submitting: false,
    registrationLoaded: true,
    registrationEnabled: true,
  })

  assert.equal(calls.signUp.length, 0, '**不一致不许发注册请求**（按钮状态可能落后一帧，判定在 submitAuthCard 里）')
  assert.deepEqual(events, [{ type: 'submit-blocked' }])

  // 拦下之后界面要说话：错误行 + 输入框 aria-invalid
  const markup = render({ state: dispatchAll(state, events) })
  assert.equal(hasTestId(markup, 'settings-auth-confirm-error'), true)
  assert.equal(textOf(markup, 'settings-auth-confirm-error').includes(zh.settingsAuthPasswordMismatch), true)
  assert.equal(attrOf(inputTagOf(markup, 'settings-auth-confirm'), 'aria-invalid'), 'true')
  assert.equal(hasTestId(markup, 'settings-auth-error'), false, '这是本地校验，不该复用服务端错误条')
})

test('③ 改任一框后重新校验：改密码 / 改确认密码都能让错误消失或再次出现', () => {
  const mismatch = dispatchAll(filled({ password: 'abcd1234', confirm: 'abcd12345' }), [{ type: 'submit-blocked' }])
  assert.equal(confirmErrorKeyOf(mismatch), 'settingsAuthPasswordMismatch')

  // (a) 改**密码**框，让两边重新对上
  const fixedByPassword = reduceAuthCard(mismatch, { type: 'password', value: 'abcd12345' })
  assert.equal(confirmErrorKeyOf(fixedByPassword), null, '改密码框后必须重新校验（不能停在旧结论上）')

  // (b) 再改**确认密码**框，重新错开
  const brokenByConfirm = reduceAuthCard(fixedByPassword, { type: 'confirm', value: 'abcd1234' })
  assert.equal(confirmErrorKeyOf(brokenByConfirm), 'settingsAuthPasswordMismatch')

  // (c) 改回一致 → 错误消失，且视图里的错误行同步消失
  const fixedByConfirm = reduceAuthCard(brokenByConfirm, { type: 'confirm', value: 'abcd12345' })
  assert.equal(confirmErrorKeyOf(fixedByConfirm), null)
  assert.equal(hasTestId(render({ state: fixedByConfirm }), 'settings-auth-confirm-error'), false)

  // (d) 失焦也算「碰过」：刚输入就失焦也要给出判定（输入时 / 失焦 / 提交前三处同一判据）
  const blurred = reduceAuthCard(
    dispatchAll(initialAuthCardState('register'), [
      { type: 'email', value: 'ui@mock.local' },
      { type: 'password', value: 'abcd1234' },
      { type: 'confirm', value: 'abcd' },
      { type: 'confirm-blur' },
    ]),
    { type: 'confirm-blur' }
  )
  assert.equal(confirmErrorKeyOf(blurred), 'settingsAuthPasswordMismatch')
})

test('④ 眼睛按钮：type 在 password / text 之间切换，输入内容不丢，aria 跟着状态走', () => {
  const state = filled({ password: 'sk-9f2c-secret', confirm: 'sk-9f2c-secret' })

  // 默认隐藏
  const hidden = render({ state })
  const hiddenTag = inputTagOf(hidden, 'settings-auth-password')
  assert.equal(attrOf(hiddenTag, 'type'), 'password', '默认必须是 type=password')
  assert.equal(attrOf(hiddenTag, 'value'), 'sk-9f2c-secret', '受控值原样在')
  assert.match(hidden, /data-testid="settings-auth-password-toggle"[^>]*aria-label="显示密码"/u)
  assert.match(hidden, /data-testid="settings-auth-password-toggle"[^>]*aria-pressed="false"/u)
  assert.match(hidden, /data-icon="eye-closed"/u, '隐藏时是闭眼图标')

  // 点一下 → 明文，值不变
  const visibleState = reduceAuthCard(state, { type: 'toggle', field: 'password' })
  const visible = render({ state: visibleState })
  const visibleTag = inputTagOf(visible, 'settings-auth-password')
  assert.equal(attrOf(visibleTag, 'type'), 'text', '点一次眼睛必须变明文')
  assert.equal(attrOf(visibleTag, 'value'), 'sk-9f2c-secret', '**切换不许丢输入内容**')
  assert.equal(visibleState.password, state.password, '状态里的值也不许被切换改掉')
  assert.match(visible, /data-testid="settings-auth-password-toggle"[^>]*aria-label="隐藏密码"/u)
  assert.match(visible, /data-testid="settings-auth-password-toggle"[^>]*aria-pressed="true"/u)
  assert.match(visible, /data-icon="eye-open"/u, '显示时是睁眼图标')

  // 再点一下 → 回到隐藏（同一个输入框节点，仍然带值）
  const hiddenAgain = render({ state: reduceAuthCard(visibleState, { type: 'toggle', field: 'password' }) })
  assert.equal(attrOf(inputTagOf(hiddenAgain, 'settings-auth-password'), 'type'), 'password')
  assert.equal(attrOf(inputTagOf(hiddenAgain, 'settings-auth-password'), 'value'), 'sk-9f2c-secret')

  // 两个框各自独立：切确认密码不影响密码框
  const confirmOnly = reduceAuthCard(state, { type: 'toggle', field: 'confirm' })
  assert.equal(attrOf(inputTagOf(render({ state: confirmOnly }), 'settings-auth-confirm'), 'type'), 'text')
  assert.equal(attrOf(inputTagOf(render({ state: confirmOnly }), 'settings-auth-password'), 'type'), 'password')

  // 纯函数口径（视图背后就这几行）
  assert.equal(passwordInputType(false), 'password')
  assert.equal(passwordInputType(true), 'text')
  assert.equal(nextPasswordVisibility(false), true)
  assert.equal(passwordToggleLabelKey(false), 'settingsAuthShowPassword')
  assert.equal(passwordToggleLabelKey(true), 'settingsAuthHidePassword')
})

test('④-补 提交后 / 切 tab 后恢复隐藏（不持久化）', () => {
  const visible = dispatchAll(filled(), [
    { type: 'toggle', field: 'password' },
    { type: 'toggle', field: 'confirm' },
  ])
  assert.equal(visible.passwordVisible, true)
  assert.equal(visible.confirmVisible, true)

  // 提交 → 两个框都回隐藏
  const submitted = reduceAuthCard(visible, { type: 'form-submitted' })
  assert.equal(submitted.passwordVisible, false, '提交后密码框必须恢复隐藏')
  assert.equal(submitted.confirmVisible, false, '提交后确认框必须恢复隐藏')
  assert.equal(attrOf(inputTagOf(render({ state: submitted }), 'settings-auth-password'), 'type'), 'password')

  // 切到登录 tab → 确认密码整栏清掉，可见性也回默认
  const switched = reduceAuthCard(submitted, { type: 'mode', mode: 'login' })
  assert.equal(switched.confirmPassword, '', '换 tab 不带确认密码过去')
  assert.equal(switched.confirmTouched, false)
  assert.equal(switched.passwordVisible, false)
})

test('⑤ 登录 tab：没有确认密码字段，但密码框复用同一个带眼睛的组件', () => {
  const markup = render({ state: initialAuthCardState('login') })

  assert.equal(hasTestId(markup, 'settings-auth-card'), true)
  assert.equal(hasTestId(markup, 'settings-auth-confirm'), false, '登录 tab 不许有确认密码字段')
  assert.equal(hasTestId(markup, 'settings-auth-confirm-toggle'), false)
  assert.equal(hasTestId(markup, 'settings-auth-confirm-error'), false)
  assert.equal(markup.includes(zh.sub2authConfirmPassword), false, '登录 tab 连「确认密码」这四个字都不该出现')

  // 复用：密码框与它的眼睛按钮都在，且默认隐藏
  assert.equal(hasTestId(markup, 'settings-auth-password'), true)
  assert.equal(hasTestId(markup, 'settings-auth-password-toggle'), true)
  assert.equal(attrOf(inputTagOf(markup, 'settings-auth-password'), 'type'), 'password')

  // 登录 tab 也不做确认密码校验：即便状态里留着不一致的确认值（例如刚从注册 tab 过来）也不影响提交
  const loginState = dispatchAll(initialAuthCardState('login'), [
    { type: 'email', value: 'ui@mock.local' },
    { type: 'password', value: 'abcd1234' },
    { type: 'confirm', value: 'different' },
  ])
  assert.equal(confirmErrorKeyOf(loginState), null, '登录 tab 不做两次一致校验')
  assert.equal(authCardCanSubmit(loginState, false), true)
})

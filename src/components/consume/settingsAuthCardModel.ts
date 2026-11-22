/**
 * 「登录 / 注册卡」的状态与视图（Issue #797 + #795）—— 没有 hooks、没有请求，纯判定 + 纯渲染。
 *
 * 为什么把逻辑从 `SettingsAuthCard.tsx` 里抽出来：`#797` 的验收项里有一半是「**有没有发请求**」
 * （确认密码不一致时不许发注册请求）、另一半是「点了之后框变不变」（眼睛按钮）。这两类断言都需要
 * 在**裸 Node** 里跑（本仓库 L1 用 `renderToStaticMarkup` 真渲染，`.tsx` 进不来），所以：
 *
 *  · {@link reduceAuthCard}：一个事件一个状态，界面只负责派事件；
 *  · {@link submitAuthCard} / {@link submitForgotPassword}：**唯一**两处可能发请求的判定，
 *    返回「要派给 reducer 的事件」而不是自己 setState —— 于是「不一致 → 一个请求都不发」这句话
 *    可以被一条 `assert.equal(calls.register.length, 0)` 钉住，而不是靠读代码相信；
 *  · {@link SettingsAuthCardView}：`createElement` 视图（`Button` / 眼睛图标由容器注入）。
 *
 * 三个语义口径（都有对应的 issue 条文）：
 *
 *  1. **确认密码只在客户端校验**（#797）：`signUp` 的入参里没有 `confirmPassword`，不一致时
 *     {@link submitAuthCard} 直接返回「拦下」事件。校验时机 = 输入时（`confirmTouched`）+
 *     失焦（`confirm-blur`）+ 提交前（`submit-blocked` / `authCardCanSubmit`），三个入口共用
 *     {@link confirmErrorKeyOf} 这一个判据。
 *  2. **忘记密码不许假装成功**（#795）：{@link forgotOutcomeOf} 把后端的 `message` **原样**带出来，
 *     并追加一句「重置暂未开通，请联系客服」；只有真的 `ok:true` 才说「已发送」。
 *     传输层失败（超时 / 连不上）**没有**后端原话可抄，此时退回归一化文案（`consumeErrNetwork`
 *     这类具体的话，仍然不是「未知错误」），也**不**追加重置未开通 —— 网络问题不等于功能没开。
 *  3. **不弹第二层**（本卡文件头的老规矩）：忘记密码是**卡内的一个小页**（`step: 'forgot'`），
 *     不是盖在设置弹层上的第二层 dialog。
 */

import { createElement, type ReactNode } from 'react'

import type { TranslationKey } from '../../i18n/index.js'
import type { ConsumeCallResult } from '../../services/consume/index.js'
import { PasswordField, passwordToggleLabelKey } from './passwordInput.js'
import type { ConsumeTranslate, PanelButton, PanelClassNames } from './panels.js'

/** 分段控件的两个 tab */
export type AuthCardMode = 'login' | 'register'

/** 卡内两个小页：表单 / 忘记密码（不是第二层 dialog，见文件头第 3 条） */
export type AuthCardStep = 'form' | 'forgot'

/** 表单级提示：要么是可翻译的文案 key，要么不显示（后端原话走 `forgot.outcome`，不混进来） */
export type AuthCardNotice = TranslationKey | null

/** 忘记密码的结局（`needs-email` = 本地就拦下了，没发请求） */
export type ForgotOutcome =
  | { status: 'needs-email' }
  | { status: 'sent' }
  | {
      status: 'failed'
      /** 后端原话（`Sub2ApiError.message`）；只在这一条上屏，见文件头第 2 条 */
      serverMessage: string | null
      /** 没有后端原话时的退路（归一化文案 key） */
      fallbackKey: TranslationKey | null
      /** 追加的可操作文案：**只在真的收到了后端响应时**给 */
      hintKey: TranslationKey | null
    }

export type ForgotState = {
  /** 请求在飞（按钮置灰 + `aria-busy`） */
  sending: boolean
  outcome: ForgotOutcome | null
}

export type AuthCardState = {
  mode: AuthCardMode
  step: AuthCardStep
  email: string
  password: string
  /** 确认密码：**只在客户端**，永远不进请求体（#797） */
  confirmPassword: string
  verifyCode: string
  /** 邀请码（#819）：**只在注册分段、且 `invitation_code_enabled === true`** 时才有这一栏；可留空 */
  invitationCode: string
  /** 密码框是否明文（两个框各自独立；不持久化，提交 / 切 tab / 离开卡片即回隐藏） */
  passwordVisible: boolean
  confirmVisible: boolean
  /** 确认密码被用户碰过（输入 / 失焦）—— 没碰过就不提前飘红 */
  confirmTouched: boolean
  /** 提交过至少一次：提交前的校验结果必须显示出来 */
  submitAttempted: boolean
  /** 表单级提示（如「注册暂未开放」） */
  notice: AuthCardNotice
  forgot: ForgotState
}

export type AuthCardEvent =
  | { type: 'mode'; mode: AuthCardMode }
  | { type: 'step'; step: AuthCardStep }
  | { type: 'email'; value: string }
  | { type: 'password'; value: string }
  | { type: 'confirm'; value: string }
  | { type: 'verify-code'; value: string }
  /** 邀请码（#819）：与验证码同一条通路，只是它只在开关开着时才渲染 */
  | { type: 'invitation-code'; value: string }
  /** 点眼睛：`field` 决定切哪个框（两个框各自独立，#797 允许二选一，这里选独立） */
  | { type: 'toggle'; field: 'password' | 'confirm' }
  | { type: 'confirm-blur' }
  /** 提交被本地拦下（空字段 / 确认密码不一致）：只让界面把错误显示出来，**不发请求** */
  | { type: 'submit-blocked' }
  /** 请求已发出：恢复隐藏（#797「提交后恢复隐藏」） */
  | { type: 'form-submitted' }
  | { type: 'notice'; notice: AuthCardNotice }
  | { type: 'forgot-sending' }
  | { type: 'forgot-outcome'; outcome: ForgotOutcome }

export const initialForgotState = (): ForgotState => ({ sending: false, outcome: null })

export const initialAuthCardState = (mode: AuthCardMode = 'login'): AuthCardState => ({
  mode,
  step: 'form',
  email: '',
  password: '',
  confirmPassword: '',
  verifyCode: '',
  invitationCode: '',
  passwordVisible: false,
  confirmVisible: false,
  confirmTouched: false,
  submitAttempted: false,
  notice: null,
  forgot: initialForgotState(),
})

export const reduceAuthCard = (state: AuthCardState, event: AuthCardEvent): AuthCardState => {
  switch (event.type) {
    case 'mode':
      if (state.mode === event.mode) {
        return state
      }
      // 换 tab = 换一张表单：确认密码 / 可见性 / 校验痕迹都不带过去，免得串味
      return {
        ...initialAuthCardState(event.mode),
        email: state.email,
        password: state.password,
        verifyCode: state.verifyCode,
        // 邀请码也带过去：注册 → 误点登录 → 再点回注册，不该让用户重敲一遍
        invitationCode: state.invitationCode,
      }
    case 'step':
      if (state.step === event.step) {
        return state
      }
      return {
        ...state,
        step: event.step,
        notice: null,
        // 进出「忘记密码」页时把上一次的结局清掉（否则再进来会看到上一次的红字）
        forgot: initialForgotState(),
      }
    case 'email':
      return { ...state, email: event.value }
    case 'password':
      // 密码改了也要重新校验确认密码：错误由 `confirmErrorKeyOf` 现算，所以这里只换值
      return { ...state, password: event.value }
    case 'confirm':
      return { ...state, confirmPassword: event.value, confirmTouched: true }
    case 'verify-code':
      return { ...state, verifyCode: event.value }
    case 'invitation-code':
      return { ...state, invitationCode: event.value }
    case 'toggle':
      return event.field === 'password'
        ? { ...state, passwordVisible: !state.passwordVisible }
        : { ...state, confirmVisible: !state.confirmVisible }
    case 'confirm-blur':
      return { ...state, confirmTouched: true }
    case 'submit-blocked':
      return { ...state, submitAttempted: true, confirmTouched: true }
    case 'form-submitted':
      return {
        ...state,
        submitAttempted: true,
        // #797：提交后恢复隐藏，**不**持久化
        passwordVisible: false,
        confirmVisible: false,
        notice: null,
      }
    case 'notice':
      return { ...state, notice: event.notice }
    case 'forgot-sending':
      return { ...state, forgot: { sending: true, outcome: null } }
    case 'forgot-outcome':
      return { ...state, forgot: { sending: false, outcome: event.outcome } }
    default:
      return state
  }
}

/**
 * 「两次输入的密码不一致」该不该上屏（`null` = 不显示）。
 *
 * 三个调用点（输入 / 失焦 / 提交前）都用它，避免出现「失焦时报红、输入时又消失」这种两套判据。
 * 只有**注册** tab 才有这一栏；登录 tab 没有确认密码字段（#797 明确要求）。
 */
export const confirmErrorKeyOf = (state: AuthCardState): 'settingsAuthPasswordMismatch' | null => {
  if (state.mode !== 'register' || state.step !== 'form') {
    return null
  }
  if (!state.confirmTouched && !state.submitAttempted) {
    return null
  }
  if (state.confirmPassword === '' && !state.submitAttempted) {
    return null
  }
  return state.password === state.confirmPassword ? null : 'settingsAuthPasswordMismatch'
}

/** 主按钮能不能点：注册 tab 额外要求「确认密码非空且与密码一致」 */
export const authCardCanSubmit = (state: AuthCardState, submitting: boolean): boolean => {
  if (submitting || state.step !== 'form') {
    return false
  }
  if (state.email.trim() === '' || state.password === '') {
    return false
  }
  if (state.mode === 'login') {
    return true
  }
  return state.confirmPassword !== '' && state.password === state.confirmPassword
}

/** 卡里唯一会发请求的四个口子（真机是 `useAuthStore` 的三个动作 + `consume.auth.forgotPassword`） */
export type AuthCardSource = {
  signIn: (input: { email: string; password: string }) => Promise<unknown>
  /**
   * 注册。`invitationCode` 是 #819 补回来的可选字段：`AuthRegisterInput` / `toRegisterBody`
   * 早就认识它（落成请求体的 `invitation_code`），缺的一直是「表单里没有这一栏、调用方也不传」。
   */
  signUp: (input: { email: string; password: string; verifyCode?: string; invitationCode?: string }) => Promise<unknown>
  forgotPassword: (input: { email: string }) => Promise<ConsumeCallResult<unknown>>
}

export type AuthCardSubmitContext = {
  submitting: boolean
  /** `settings/public` 是否已经拉到（没拉到时不做本地拦截，交给服务端判 —— #484 §3.1d） */
  registrationLoaded: boolean
  registrationEnabled: boolean
  /**
   * `settings/public.invitation_code_enabled`（#819）。**只有严格 true 才把邀请码放进请求体**：
   * 关着的时候这一栏根本不渲染，这里再挡一次是为了「填表期间开关被改 / 其它入口塞了值」这种情况
   * 也不越过开关（与 `flags.ts` 的保守默认同一口径）。
   */
  invitationCodeEnabled: boolean
}

/**
 * 提交表单。**发不发请求全看这里**，界面按钮的 `disabled` 只是顺手（按钮状态可能落后一帧，
 * 所以真正的不发请求必须由本函数保证）。
 */
export const submitAuthCard = async (
  source: AuthCardSource,
  state: AuthCardState,
  ctx: AuthCardSubmitContext
): Promise<AuthCardEvent[]> => {
  if (ctx.submitting) {
    return []
  }
  const email = state.email.trim()
  if (email === '' || state.password === '') {
    return [{ type: 'submit-blocked' }]
  }
  if (state.mode === 'register') {
    // #797 的核心一条：不一致 → 提交前就返回，`source.signUp` 一次都不调
    if (state.password !== state.confirmPassword) {
      return [{ type: 'submit-blocked' }]
    }
    if (ctx.registrationLoaded && !ctx.registrationEnabled) {
      return [{ type: 'notice', notice: 'sub2authRegistrationDisabled' }]
    }
    const verifyCode = state.verifyCode.trim()
    // 确认密码**不进请求体**：服务端要的只有 email / password / verify_code / invitation_code
    const input: { email: string; password: string; verifyCode?: string; invitationCode?: string } = {
      email,
      password: state.password,
    }
    if (verifyCode !== '') {
      input.verifyCode = verifyCode
    }
    // #819：邀请码只在开关开着时才进请求体（关着时这一栏不渲染，值是空的也一并省略）
    const invitationCode = state.invitationCode.trim()
    if (ctx.invitationCodeEnabled && invitationCode !== '') {
      input.invitationCode = invitationCode
    }
    await source.signUp(input)
    return [{ type: 'form-submitted' }]
  }
  await source.signIn({ email, password: state.password })
  return [{ type: 'form-submitted' }]
}

/**
 * `POST /api/v1/auth/forgot-password` 的结局 → 上屏用的事件（#795 第 2 / 3 条）。
 *
 * 失败分支的顺序很关键：**先看有没有真的拿到后端响应**（`status > 0`）。拿到了就原样展示
 * `message`（这就是 staging 上那句 `Password reset is not configured`）+ 「请联系客服」；
 * 没拿到（`status === 0`：超时 / 连不上 / 非原生平台）就没有原话可抄，退回归一化文案。
 */
export const forgotOutcomeOf = (result: ConsumeCallResult<unknown>): ForgotOutcome => {
  if (result.ok) {
    return { status: 'sent' }
  }
  const message = result.error.message.trim()
  if (result.error.status > 0) {
    return {
      status: 'failed',
      serverMessage: message === '' ? null : message,
      fallbackKey: message === '' ? result.error.i18nKey : null,
      hintKey: 'settingsAuthForgotNotReady',
    }
  }
  return { status: 'failed', serverMessage: null, fallbackKey: result.error.i18nKey, hintKey: null }
}

/**
 * 忘记密码：空邮箱**本地拦下**（一条请求都不发），非空才真的发。
 *
 * 「发码 / 发重置邮件」这类纯通知接口的成功判据只看 2xx（`consume/auth.ts` 的
 * `CONSUME_EFFECT_POLICIES.forgotPassword`）：没有可回查的证据，所以文案也只说「已发送」，
 * 不承诺「邮件一定到了」。
 */
export const submitForgotPassword = async (
  source: AuthCardSource,
  state: AuthCardState
): Promise<AuthCardEvent[]> => {
  const email = state.email.trim()
  if (email === '') {
    return [{ type: 'forgot-outcome', outcome: { status: 'needs-email' } }]
  }
  const result = await source.forgotPassword({ email })
  return [{ type: 'forgot-outcome', outcome: forgotOutcomeOf(result) }]
}

// --------------------------------------------------------------------------- 视图

export type SettingsAuthCardViewProps = {
  t: ConsumeTranslate
  c: PanelClassNames
  Button: PanelButton
  /** 睁眼 / 闭眼图标（`.tsx` 进来的，见 `passwordInput.ts` 文件头第 3 段） */
  EyeIcon: () => ReactNode
  EyeOffIcon: () => ReactNode
  state: AuthCardState
  submitting: boolean
  sendingCode: boolean
  /** 验证码倒计时剩余秒数（0 = 没在冷却；计时器在容器里） */
  countdown: number
  /** 登录 / 注册失败的文案 key（来自 store 的 `error.messageKey`） */
  errorKey: TranslationKey | null
  registrationLoaded: boolean
  registrationEnabled: boolean
  /** #819：`settings/public.invitation_code_enabled` —— 只有 true 才多渲染一行「邀请码（可选）」 */
  invitationCodeEnabled: boolean
  onEvent: (event: AuthCardEvent) => void
  onSubmit: () => void
  onSendCode: () => void
  onForgotSubmit: () => void
  onSkip: () => void
}

/** 忘记密码那一页：一句说明 + 邮箱 + 发送 + 结局（成功 / 后端原话 + 可操作提示） */
const ForgotView = (props: SettingsAuthCardViewProps): ReactNode => {
  const { t, c, Button, state } = props
  const outcome = state.forgot.outcome
  const emailFilled = state.email.trim() !== ''

  const status: ReactNode[] = []
  if (outcome !== null && outcome.status === 'needs-email') {
    status.push(
      createElement(
        'p',
        { className: c.authError, role: 'alert', 'data-testid': 'settings-auth-forgot-status' },
        t('settingsAuthForgotNeedsEmail')
      )
    )
  }
  if (outcome !== null && outcome.status === 'sent') {
    status.push(
      createElement(
        'p',
        { className: c.authNotice, role: 'status', 'data-testid': 'settings-auth-forgot-status' },
        t('settingsAuthForgotSent')
      )
    )
  }
  if (outcome !== null && outcome.status === 'failed') {
    // 失败：**后端原话照抄**（不替换成「未知错误」），再补一句能做的
    status.push(
      createElement(
        'div',
        {
          className: c.authError,
          role: 'alert',
          'data-testid': 'settings-auth-forgot-status',
        },
        createElement(
          'p',
          { 'data-testid': 'settings-auth-forgot-error-message' },
          outcome.serverMessage ?? (outcome.fallbackKey === null ? '' : t(outcome.fallbackKey))
        ),
        outcome.hintKey === null
          ? null
          : createElement('p', { 'data-testid': 'settings-auth-forgot-error-hint' }, t(outcome.hintKey))
      )
    )
  }

  return createElement(
    'div',
    { className: c.authCard, 'data-testid': 'settings-auth-forgot-form' },
    createElement('h2', { className: c.authForgotTitle }, t('settingsAuthForgotTitle')),
    createElement('input', {
      className: c.authInput,
      type: 'email',
      inputMode: 'email',
      autoComplete: 'email',
      spellCheck: false,
      placeholder: t('settingsAuthEmailPlaceholder'),
      'aria-label': t('sub2authEmail'),
      'data-testid': 'settings-auth-forgot-email',
      value: state.email,
      onChange: (event: { currentTarget: HTMLInputElement }) =>
        props.onEvent({ type: 'email', value: event.currentTarget.value }),
    }),
    createElement(
      Button,
      {
        variant: 'primary',
        size: 'l',
        block: true,
        className: c.authPrimary,
        disabled: !emailFilled || state.forgot.sending,
        testId: 'settings-auth-forgot-submit',
        onClick: props.onForgotSubmit,
      },
      t('settingsAuthForgotSend')
    ),
    ...status,
    createElement(
      'button',
      {
        type: 'button',
        className: c.authLink,
        'data-testid': 'settings-auth-forgot-back',
        onClick: () => props.onEvent({ type: 'step', step: 'form' }),
      },
      t('settingsAuthForgotBack')
    )
  )
}

export const SettingsAuthCardView = (props: SettingsAuthCardViewProps): ReactNode => {
  const { t, c, Button, state } = props
  if (state.step === 'forgot') {
    return ForgotView(props)
  }

  const registering = state.mode === 'register'
  const confirmErrorKey = confirmErrorKeyOf(state)
  const codeLoading = props.sendingCode || props.countdown > 0
  const canSubmit = authCardCanSubmit(state, props.submitting)

  const segmented = createElement(
    'div',
    { className: c.authSegmented, role: 'group', 'aria-label': t('sub2authAccount') },
    createElement(
      'button',
      {
        type: 'button',
        className: state.mode === 'login' ? `${c.authSeg ?? ''} ${c.authSegOn ?? ''}` : c.authSeg,
        'aria-pressed': state.mode === 'login',
        'data-testid': 'auth-segmented-login',
        onClick: () => props.onEvent({ type: 'mode', mode: 'login' }),
      },
      t('sub2authLogin')
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: state.mode === 'register' ? `${c.authSeg ?? ''} ${c.authSegOn ?? ''}` : c.authSeg,
        'aria-pressed': state.mode === 'register',
        'data-testid': 'auth-segmented-register',
        onClick: () => props.onEvent({ type: 'mode', mode: 'register' }),
      },
      t('sub2authRegister')
    )
  )

  const emailInput = createElement('input', {
    className: c.authInput,
    type: 'email',
    inputMode: 'email',
    autoComplete: 'email',
    spellCheck: false,
    placeholder: t('settingsAuthEmailPlaceholder'),
    'aria-label': t('sub2authEmail'),
    'data-testid': 'settings-auth-email',
    value: state.email,
    onChange: (event: { currentTarget: HTMLInputElement }) =>
      props.onEvent({ type: 'email', value: event.currentTarget.value }),
  })

  const codeRow = registering
    ? createElement(
        'div',
        { className: c.authCodeRow },
        createElement('input', {
          className: `${c.authInput ?? ''} ${c.authCodeInput ?? ''}`,
          type: 'text',
          inputMode: 'numeric',
          autoComplete: 'one-time-code',
          spellCheck: false,
          placeholder: t('settingsAuthCodePlaceholder'),
          'aria-label': t('settingsAuthCodePlaceholder'),
          'data-testid': 'settings-auth-code',
          value: state.verifyCode,
          onChange: (event: { currentTarget: HTMLInputElement }) =>
            props.onEvent({ type: 'verify-code', value: event.currentTarget.value }),
        }),
        createElement(
          'button',
          {
            type: 'button',
            className: c.authCodeButton,
            'data-testid': 'settings-auth-send-code',
            disabled: codeLoading || state.email.trim() === '',
            onClick: props.onSendCode,
          },
          props.countdown > 0
            ? t('settingsAuthCountdown', { seconds: props.countdown })
            : t('settingsAuthSendCode')
        )
      )
    : null

  // 密码框：登录 tab 复用同一个组件，但**没有**确认密码那一栏（#797）
  const passwordField = createElement(PasswordField, {
    value: state.password,
    visible: state.passwordVisible,
    placeholder: t('settingsAuthPasswordPlaceholder'),
    ariaLabel: t('sub2authPassword'),
    toggleLabel: t(passwordToggleLabelKey(state.passwordVisible)),
    autoComplete: registering ? 'new-password' : 'current-password',
    testId: 'settings-auth-password',
    c: { row: c.authPasswordRow, input: `${c.authInput ?? ''} ${c.authPasswordInput ?? ''}`, toggle: c.authPasswordToggle, error: c.authFieldError },
    EyeIcon: props.EyeIcon,
    EyeOffIcon: props.EyeOffIcon,
    onChange: (value: string) => props.onEvent({ type: 'password', value }),
    onToggle: () => props.onEvent({ type: 'toggle', field: 'password' }),
    onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean } }) => {
      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
        props.onSubmit()
      }
    },
  })

  const confirmField = registering
    ? createElement(PasswordField, {
        value: state.confirmPassword,
        visible: state.confirmVisible,
        placeholder: t('settingsAuthConfirmPlaceholder'),
        ariaLabel: t('sub2authConfirmPassword'),
        toggleLabel: t(passwordToggleLabelKey(state.confirmVisible)),
        autoComplete: 'new-password',
        testId: 'settings-auth-confirm',
        c: { row: c.authPasswordRow, input: `${c.authInput ?? ''} ${c.authPasswordInput ?? ''}`, toggle: c.authPasswordToggle, error: c.authFieldError },
        EyeIcon: props.EyeIcon,
        EyeOffIcon: props.EyeOffIcon,
        errorText: confirmErrorKey === null ? undefined : t(confirmErrorKey),
        errorTestId: 'settings-auth-confirm-error',
        onChange: (value: string) => props.onEvent({ type: 'confirm', value }),
        onToggle: () => props.onEvent({ type: 'toggle', field: 'confirm' }),
        onBlur: () => props.onEvent({ type: 'confirm-blur' }),
        onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean } }) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            props.onSubmit()
          }
        },
      })
    : null

  /**
   * 邀请码（#819）：**只在注册分段、且服务端开关为真时**渲染，与 `RegisterPage.tsx` 那一行同一口径
   * （开关 false → 连一行都不出现，而不是置灰）。它是**可选**的：留空就不进请求体。
   */
  const invitationRow =
    registering && props.invitationCodeEnabled
      ? createElement('input', {
          className: c.authInput,
          type: 'text',
          autoComplete: 'off',
          autoCapitalize: 'characters',
          spellCheck: false,
          placeholder: t('settingsAuthInvitePlaceholder'),
          'aria-label': t('inviteCode'),
          'data-testid': 'settings-auth-invitation',
          value: state.invitationCode,
          onChange: (event: { currentTarget: HTMLInputElement }) =>
            props.onEvent({ type: 'invitation-code', value: event.currentTarget.value }),
        })
      : null

  return createElement(
    'div',
    { className: c.authCard, 'data-testid': 'settings-auth-card' },
    segmented,
    emailInput,
    codeRow,
    passwordField,
    confirmField,
    invitationRow,
    createElement(
      Button,
      {
        variant: 'primary',
        size: 'l',
        block: true,
        className: c.authPrimary,
        disabled: !canSubmit,
        testId: 'settings-auth-submit',
        onClick: props.onSubmit,
      },
      registering ? t('sub2authRegister') : t('sub2authLogin')
    ),
    props.errorKey === null
      ? null
      : createElement(
          'div',
          { className: c.authError, role: 'alert', 'data-testid': 'settings-auth-error' },
          t(props.errorKey)
        ),
    state.notice === null
      ? null
      : createElement(
          'div',
          { className: c.authNotice, role: 'status', 'data-testid': 'settings-auth-notice' },
          t(state.notice)
        ),
    // #608 的口子：不登录也能用，直接去填 API Key
    createElement(
      'button',
      {
        type: 'button',
        className: c.authLink,
        'data-testid': 'account-consume-skip-login',
        onClick: props.onSkip,
      },
      t('settingsAuthSkip')
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: c.authLink,
        'data-testid': 'settings-auth-forgot',
        onClick: () => props.onEvent({ type: 'step', step: 'forgot' }),
      },
      `${t('sub2authForgotPassword')}？`
    ),
    registering
      ? createElement(
          'button',
          {
            type: 'button',
            className: c.authLinkDim,
            'data-testid': 'settings-auth-switch-login',
            onClick: () => props.onEvent({ type: 'mode', mode: 'login' }),
          },
          t('settingsAuthHaveAccount')
        )
      : null
  )
}

/**
 * 「邮箱绑定」面板（W1-C2 #487 / 契约 §3.1c）。
 *
 * 已绑定 → 脱敏邮箱 + 「更换」「解绑」；未绑定 → 「绑定邮箱」。
 * 发码走 `POST /user/account-bindings/email/send-code`，提交走 `POST /user/account-bindings/email`，
 * 解绑走 `DELETE /user/account-bindings/:provider`（provider 固定 `email`）。
 *
 * 频控**不在这里自己算**：倒计时直接复用 `services/invite/emailCooldown.ts` 的两个纯函数
 * （`startEmailCooldown` 把「秒数」变成一个截止时刻，`emailCooldownRemaining` 按当前时刻算剩余），
 * 容器只负责每秒 tick 一次并把 `remaining` 传下来。429 的秒数取服务端的 `Retry-After`
 * （`error.retryAfterMs`）；服务端没给秒数时（成功响应没有 `resend_after`，见 #484 §4.4）
 * 用 {@link EMAIL_RESEND_FALLBACK_SECONDS} 这个**界面自保**间隔，不假装是服务端频控。
 *
 * `settings/public.email_verify_enabled === false` 时不再强调「必须先验证邮箱」——
 * 部署方没开这个要求，界面就不该给一条做不到的指令。
 */

import { createElement, type ChangeEvent, type ReactNode } from 'react'

import type { ConsumeCallResult, ConsumePublicSettings, ConsumeUser } from '../../services/consume/index.js'
import { startEmailCooldown, type EmailCooldown } from '../../services/invite/emailCooldown.js'
import {
  errorBlock,
  firstStr,
  loadingBlock,
  localPanelError,
  maskedEmail,
  panelReady,
  panelShell,
  statRow,
  toPanelError,
  type PanelAsync,
  type PanelBlockProps,
  type PanelError,
} from './panels.js'

/**
 * 服务端没说「多久能再发」时界面自保的间隔（秒）。
 *
 * sub2api 的发码成功体里没有旧服务的 `resend_after` 字段（#484 §4.4），所以这个数**只是**
 * 「别让用户连点」的界面节奏，不是频控窗口；真频控以服务端 429 + `Retry-After` 为准。
 */
export const EMAIL_RESEND_FALLBACK_SECONDS = 60

/** 面板要用到的客户端子集（结构化取子集 → 单测不必造整个 client） */
export type EmailBindSource = {
  settings: { get: () => Promise<ConsumeCallResult<ConsumePublicSettings>> }
  auth: { profile: () => Promise<ConsumeCallResult<ConsumeUser>> }
  email: {
    sendCode: (email: string) => Promise<ConsumeCallResult<undefined>>
    bind: (input: { email: string; code: string }) => Promise<ConsumeCallResult<ConsumeUser>>
    unbind: (provider: string) => Promise<ConsumeCallResult<ConsumeUser>>
  }
}

export type EmailBindInfo = {
  /** 已绑定的邮箱（未绑定为空串） */
  email: string
  bound: boolean
  /** 服务端 `identities.email.can_unbind === false` 时不给解绑（唯一登录方式） */
  canUnbind: boolean
  /** 部署方是否要求验证邮箱（`settings/public.email_verify_enabled`） */
  emailVerifyEnabled: boolean
}

export type EmailBindState = {
  info: PanelAsync<EmailBindInfo>
  /** `view` = 展示态；`form` = 填写邮箱 + 验证码 */
  mode: 'view' | 'form'
  draftEmail: string
  draftCode: string
  /** 发码倒计时（`null` = 现在就能发） */
  cooldown: EmailCooldown | null
  busy: 'send' | 'bind' | 'unbind' | null
  confirmUnbind: boolean
  actionError: PanelError | null
  notice: 'codeSent' | 'bound' | 'unbound' | null
}

export type EmailBindEvent =
  | { type: 'info'; state: PanelAsync<EmailBindInfo> }
  | { type: 'mode'; mode: EmailBindState['mode'] }
  | { type: 'draftEmail'; email: string }
  | { type: 'draftCode'; code: string }
  | { type: 'cooldown'; cooldown: EmailCooldown | null }
  | { type: 'busy'; token: EmailBindState['busy'] }
  | { type: 'confirmUnbind'; value: boolean }
  | { type: 'actionError'; error: PanelError | null }
  | { type: 'notice'; notice: EmailBindState['notice'] }
  /** 绑定 / 解绑成功后服务端回来的账号主体：只更新「邮箱 + 是否绑定」，开关状态不动 */
  | { type: 'rebound'; user: ConsumeUser; bound: boolean }

export const initialEmailBindState = (): EmailBindState => ({
  info: { phase: 'loading' },
  mode: 'view',
  draftEmail: '',
  draftCode: '',
  cooldown: null,
  busy: null,
  confirmUnbind: false,
  actionError: null,
  notice: null,
})

/** 纯 reducer：状态迁移只在这里（容器按顺序 dispatch） */
export const reduceEmailBind = (state: EmailBindState, event: EmailBindEvent): EmailBindState => {
  switch (event.type) {
    case 'info':
      return { ...state, info: event.state }
    case 'mode':
      return { ...state, mode: event.mode, actionError: null, notice: null }
    case 'draftEmail':
      return { ...state, draftEmail: event.email }
    case 'draftCode':
      return { ...state, draftCode: event.code }
    case 'cooldown':
      return { ...state, cooldown: event.cooldown }
    case 'busy':
      return { ...state, busy: event.token }
    case 'confirmUnbind':
      return { ...state, confirmUnbind: event.value }
    case 'actionError':
      return { ...state, actionError: event.error }
    case 'notice':
      return { ...state, notice: event.notice }
    case 'rebound': {
      if (state.info.phase !== 'ready') {
        return state
      }
      const identity = event.user.identities === undefined ? undefined : event.user.identities.email
      return {
        ...state,
        info: panelReady({
          ...state.info.data,
          email: event.bound ? event.user.email : '',
          bound: event.bound,
          canUnbind: identity === undefined || identity.canUnbind !== false,
        }),
      }
    }
    default:
      return state
  }
}

/** 是否是「看起来像邮箱」：只做形状校验，真伪由服务端发码决定 */
export const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

export const toEmailBindInfo = (user: ConsumeUser, settings: ConsumePublicSettings): EmailBindInfo => {
  const identity = user.identities === undefined ? undefined : user.identities.email
  const bound = user.emailBound === true || (identity !== undefined && identity.bound)
  return {
    email: bound ? firstStr(user.email) : '',
    bound,
    // 服务端说不许解绑就是不许（例如邮箱是唯一登录方式）；没给就按「可以」处理
    canUnbind: identity === undefined || identity.canUnbind !== false,
    emailVerifyEnabled: settings.emailVerifyEnabled,
  }
}

/** 首屏：开关 + 资料并行（开关决定「要不要强调必须先验证」，资料决定已绑定状态） */
export const runLoadEmailBind = async (source: EmailBindSource): Promise<EmailBindEvent[]> => {
  const [settings, profile] = await Promise.all([source.settings.get(), source.auth.profile()])
  if (!settings.ok) {
    return [{ type: 'info', state: { phase: 'failed', error: toPanelError(settings.error) } }]
  }
  if (!profile.ok) {
    return [{ type: 'info', state: { phase: 'failed', error: toPanelError(profile.error) } }]
  }
  return [{ type: 'info', state: panelReady(toEmailBindInfo(profile.data, settings.data)) }]
}

/**
 * 发码。成功 → 起倒计时（`notice: 'codeSent'`）；429 → 按服务端的 `Retry-After` 起倒计时，
 * 同时把「太频繁」的文案上屏（两个都要，否则用户看不出为什么按钮灰了 42 秒）。
 */
export const runSendCode = async (
  source: EmailBindSource,
  email: string,
  nowMs: number = Date.now()
): Promise<EmailBindEvent[]> => {
  if (!looksLikeEmail(email)) {
    return [{ type: 'actionError', error: localPanelError('sub2authEmailInvalid') }]
  }
  const result = await source.email.sendCode(email.trim())
  if (result.ok) {
    return [
      { type: 'cooldown', cooldown: startEmailCooldown(EMAIL_RESEND_FALLBACK_SECONDS, nowMs) },
      { type: 'actionError', error: null },
      { type: 'notice', notice: 'codeSent' },
    ]
  }
  const events: EmailBindEvent[] = [{ type: 'actionError', error: toPanelError(result.error) }]
  const retryAfterSeconds = result.error.retryAfterMs === undefined ? undefined : result.error.retryAfterMs / 1000
  const cooldown = startEmailCooldown(retryAfterSeconds, nowMs)
  if (cooldown !== null) {
    events.push({ type: 'cooldown', cooldown })
  }
  return events
}

/** 提交绑定：成功后资料以服务端返回的账号主体为准（不要自己把邮箱拼进状态） */
export const runBindEmail = async (
  source: EmailBindSource,
  email: string,
  code: string
): Promise<EmailBindEvent[]> => {
  if (!looksLikeEmail(email)) {
    return [{ type: 'actionError', error: localPanelError('sub2authEmailInvalid') }]
  }
  if (code.trim() === '') {
    return [{ type: 'actionError', error: localPanelError('sub2authCodeInvalid') }]
  }
  const result = await source.email.bind({ email: email.trim(), code: code.trim() })
  if (!result.ok) {
    return [{ type: 'actionError', error: toPanelError(result.error) }]
  }
  return [
    { type: 'rebound', user: result.data, bound: true },
    { type: 'mode', mode: 'view' },
    { type: 'draftCode', code: '' },
    { type: 'notice', notice: 'bound' },
  ]
}

/** 解绑（只解 `email` 这一项；其它 provider 由各自的入口负责） */
export const runUnbindEmail = async (source: EmailBindSource): Promise<EmailBindEvent[]> => {
  const result = await source.email.unbind('email')
  if (!result.ok) {
    return [{ type: 'actionError', error: toPanelError(result.error) }, { type: 'confirmUnbind', value: false }]
  }
  return [
    { type: 'rebound', user: result.data, bound: false },
    { type: 'confirmUnbind', value: false },
    { type: 'notice', notice: 'unbound' },
  ]
}

export type EmailBindPanelViewProps = PanelBlockProps & {
  state: EmailBindState
  /** 容器每秒算出来的剩余秒数（0 = 可以再发） */
  remaining: number
  onStartBind: () => void
  onCancelForm: () => void
  onDraftEmail: (email: string) => void
  onDraftCode: (code: string) => void
  onSendCode: () => void
  onSubmit: () => void
  onAskUnbind: () => void
  onCancelUnbind: () => void
  onUnbind: () => void
  onRetry: () => void
}

/** 邮箱绑定面板（纯渲染） */
export const EmailBindPanelView = (props: EmailBindPanelViewProps): ReactNode => {
  const { t, c, Button, state, remaining } = props
  const body: ReactNode[] = []

  if (state.info.phase === 'loading') {
    body.push(loadingBlock(props))
  } else if (state.info.phase === 'failed') {
    body.push(errorBlock(props, state.info.error, props.onRetry, 'email-bind-error'))
  } else {
    const info = state.info.data
    body.push(
      createElement(
        'div',
        { className: c.stats, 'data-testid': 'email-bind-status' },
        statRow(
          c,
          t('sub2authEmail'),
          info.bound ? maskedEmail(info.email) : t('emailBindNotBound'),
          'email-bind-current'
        )
      )
    )
    // 「必须先验证」只在部署方真的要求验证时才说
    if (info.emailVerifyEnabled) {
      body.push(
        createElement('p', { className: c.hint, 'data-testid': 'email-bind-verify-hint' }, t('sub2authEmailVerifyRequired'))
      )
    }

    if (state.mode === 'view') {
      if (info.bound) {
        body.push(
          createElement(
            'div',
            { className: c.actions },
            createElement(
              Button,
              { size: 's', variant: 'outlined', testId: 'email-bind-change', onClick: props.onStartBind },
              t('emailBindChange')
            ),
            info.canUnbind
              ? state.confirmUnbind
                ? createElement(
                    'div',
                    { className: c.confirm, 'data-testid': 'email-bind-unbind-confirm' },
                    createElement('p', { className: c.confirmText }, t('emailBindUnbindConfirm')),
                    createElement(
                      Button,
                      {
                        size: 's',
                        variant: 'danger',
                        disabled: state.busy !== null,
                        testId: 'email-bind-unbind-yes',
                        onClick: props.onUnbind,
                      },
                      t('emailBindUnbind')
                    ),
                    createElement(
                      Button,
                      { size: 's', variant: 'outlined', testId: 'email-bind-unbind-no', onClick: props.onCancelUnbind },
                      t('cancel')
                    )
                  )
                : createElement(
                    Button,
                    { size: 's', variant: 'dangerOutlined', testId: 'email-bind-unbind', onClick: props.onAskUnbind },
                    t('emailBindUnbind')
                  )
              : createElement('p', { className: c.hint, 'data-testid': 'email-bind-cannot-unbind' }, t('emailBindCannotUnbind'))
          )
        )
      } else {
        body.push(
          createElement(
            Button,
            { size: 'm', variant: 'primary', testId: 'email-bind-start', onClick: props.onStartBind },
            t('emailBindBind')
          )
        )
      }
    } else {
      body.push(
        createElement(
          'div',
          { className: c.form, 'data-testid': 'email-bind-form' },
          createElement('input', {
            className: c.input,
            type: 'email',
            value: state.draftEmail,
            placeholder: t('sub2authEmail'),
            'aria-label': t('sub2authEmail'),
            'data-testid': 'email-bind-email',
            onChange: (event: ChangeEvent<HTMLInputElement>) => props.onDraftEmail(event.currentTarget.value),
          }),
          createElement(
            'div',
            { className: c.createRow },
            createElement('input', {
              className: c.input,
              type: 'text',
              inputMode: 'numeric',
              value: state.draftCode,
              placeholder: t('emailBindCodeLabel'),
              'aria-label': t('emailBindCodeLabel'),
              'data-testid': 'email-bind-code',
              onChange: (event: ChangeEvent<HTMLInputElement>) => props.onDraftCode(event.currentTarget.value),
            }),
            createElement(
              Button,
              {
                size: 's',
                variant: 'outlined',
                disabled: remaining > 0 || state.busy !== null,
                testId: 'email-bind-send-code',
                onClick: props.onSendCode,
              },
              t('emailBindSendCode')
            )
          ),
          createElement(
            'div',
            { className: c.actions },
            createElement(
              Button,
              { size: 'm', variant: 'primary', disabled: state.busy !== null, testId: 'email-bind-submit', onClick: props.onSubmit },
              t('emailBindBind')
            ),
            createElement(
              Button,
              { size: 'm', variant: 'outlined', testId: 'email-bind-cancel', onClick: props.onCancelForm },
              t('cancel')
            )
          )
        )
      )
    }
  }

  if (state.actionError !== null) {
    body.push(errorBlock(props, state.actionError, undefined, 'email-bind-action-error'))
  }
  if (state.notice !== null) {
    body.push(
      createElement(
        'p',
        { className: c.notice, 'data-testid': 'email-bind-notice' },
        state.notice === 'bound'
          ? t('emailBindSuccess')
          : state.notice === 'unbound'
            ? t('emailBindUnbindSuccess')
            : remaining > 0
              ? // 发码成功的确认 + 剩余秒数合成一行：按钮只管「能不能点」，倒计时只在这里出现
                t('sub2authCodeSent', { seconds: remaining })
              : t('emailBindCodeSent')
      )
    )
  }

  return panelShell(c, t('emailBindBind'), body, 'email-bind-panel')
}

/**
 * 设置里「账户与消费 → 账号」未登录时的那张登录卡（#727 阶段 1 布局；#797 / #795 扩了注册与找回密码）。
 *
 * 版式照维护者给的原型，1:1（`注册` 分段多一行「确认密码」，登录分段没有）：
 *
 *   ┌─────────────────────────────┐
 *   │ [ 登录 ✓ ][  注册  ]        │  ← 分段控件（选中项白底 + 轻阴影）
 *   │ [ 请输入邮箱            ]    │
 *   │ [ 请输入验证码 │ 获取验证码 ]│  ← 只在「注册」分段出现；按钮**定宽右贴**，倒计时 59s 不换行
 *   │ [ 请输入密码（≥6 位）   👁 ]│  ← 眼睛按钮：默认隐藏，点一下明文（#797）
 *   │ [ 请再次输入密码        👁 ]│  ← 只在「注册」分段出现；两次不一致就地飘红、**不发请求**
 *   │      两次输入的密码不一致     │
 *   │ [        登 录         ]     │  ← 主按钮整宽 48px；不满足条件时降透明度禁用（不是灰底黑字）
 *   │         暂不登录             │  ← #608 的口子：直接去填 API Key
 *   │        忘记密码？            │  ← 打开卡内的「找回密码」小页（#795，真实接口）
 *   │  未注册的邮箱将自动创建账号   │
 *   └─────────────────────────────┘
 *
 * 三条纪律：
 *  1. **不弹第二层**：它就是设置弹层内容区里的一张卡（没有自己的遮罩 / `role=dialog`）——
 *     所以 #795 的「忘记密码」做成**卡内小页**（`step: 'forgot'`），不再叠一个 dialog；
 *  2. **状态与表单逻辑不另写一套**：动作全部走既有的 `useAuthStore`（`login` / `register` /
 *     `sendCode`），失败文案用 store 给的 `error.messageKey`，不写「未知错误」。
 *     表单状态机与视图在 `settingsAuthCardModel.ts`（裸 Node 可渲染，见那边的文件头）；
 *  3. **开关只认服务端**：`registration_enabled !== true` 时提交注册会被拦下并给一句文案（#484 §3.1d），
 *     不在这里本地兜一个「注册中不可用」的假成功。
 *
 * 本文件只做三件事：订阅 store、跑计时器、把「事件 → reducer」「点击 → 发请求」接上。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useTranslate } from '../../i18n/index.js'
import { loadAuthFlags, useAuthFlags } from '../../services/auth/flags.js'
import { useAuthStore } from '../../services/auth/store.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { Button } from '../base/Button.js'
import { IconEyeOffOutline16, IconEyeOutline16 } from '../base/icons.js'
import {
  initialAuthCardState,
  reduceAuthCard,
  SettingsAuthCardView,
  submitAuthCard,
  submitForgotPassword,
  type AuthCardEvent,
  type AuthCardSource,
} from './settingsAuthCardModel.js'
import styles from './AccountConsume.module.css'

/** 验证码倒计时秒数（与原型一致：60 → 0） */
const CODE_COUNTDOWN = 60

export type SettingsAuthCardProps = {
  consume: ConsumeClient
  /** #608 的口子：不登录也能用 —— 直接去填 API Key */
  onSkip: () => void
}

export const SettingsAuthCard = ({ consume, onSkip }: SettingsAuthCardProps) => {
  const t = useTranslate()
  const flags = useAuthFlags()
  const signIn = useAuthStore((state) => state.signIn)
  const signUp = useAuthStore((state) => state.signUp)
  const sendCode = useAuthStore((state) => state.sendCode)
  const submitting = useAuthStore((state) => state.submitting)
  const sendingCode = useAuthStore((state) => state.sendingCode)
  const error = useAuthStore((state) => state.error)

  const [state, dispatch] = useReducer(reduceAuthCard, undefined, () => initialAuthCardState())
  const [countdown, setCountdown] = useState(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    // 注册入口的显隐只看服务端开关（`settings/public`）。`main.tsx` 启动时已经拉过一次，
    // 这里再拉一次只是让这张卡「自己也能独立成立」（幂等，失败落保守默认：只显示登录）。
    void loadAuthFlags()
    return () => {
      alive.current = false
    }
  }, [])

  // 倒计时：每秒减一，到 0 自动停（组件卸载后不再 setState）
  useEffect(() => {
    if (countdown <= 0) {
      return
    }
    const timer = window.setTimeout(() => {
      if (alive.current) {
        setCountdown((left) => (left > 0 ? left - 1 : 0))
      }
    }, 1000)
    return () => {
      window.clearTimeout(timer)
    }
  }, [countdown])

  /** 卡里四个网络口子（真机实现；判定在 `settingsAuthCardModel.ts`，这里只是接线） */
  const source = useMemo<AuthCardSource>(
    () => ({
      signIn: (input) => signIn(input),
      signUp: (input) => signUp(input),
      forgotPassword: (input) => consume.auth.forgotPassword(input),
    }),
    [signIn, signUp, consume]
  )

  /** 跑一次「判定 → 请求 → 事件」并派发。请求结果由 store / 结果对象承载，不在这里吞 */
  const run = useCallback((work: () => Promise<AuthCardEvent[]>) => {
    void work().then((events) => {
      if (alive.current) {
        events.forEach(dispatch)
      }
    })
  }, [])

  const submit = useCallback(() => {
    run(() =>
      submitAuthCard(source, state, {
        submitting,
        registrationLoaded: flags.loaded,
        registrationEnabled: flags.registrationEnabled,
      })
    )
  }, [run, source, state, submitting, flags.loaded, flags.registrationEnabled])

  const requestCode = useCallback(() => {
    if (sendingCode || countdown > 0 || state.email.trim() === '') {
      return
    }
    void sendCode({ email: state.email.trim() })
    setCountdown(CODE_COUNTDOWN)
  }, [sendingCode, countdown, state.email, sendCode])

  const forgotSubmit = useCallback(() => {
    if (state.forgot.sending) {
      return
    }
    dispatch({ type: 'forgot-sending' })
    run(() => submitForgotPassword(source, state))
  }, [run, source, state])

  return (
    <SettingsAuthCardView
      t={t}
      c={styles}
      Button={Button}
      EyeIcon={IconEyeOutline16}
      EyeOffIcon={IconEyeOffOutline16}
      state={state}
      submitting={submitting}
      sendingCode={sendingCode}
      countdown={countdown}
      errorKey={error === null ? null : error.messageKey}
      registrationLoaded={flags.loaded}
      registrationEnabled={flags.registrationEnabled}
      onEvent={dispatch}
      onSubmit={submit}
      onSendCode={requestCode}
      onForgotSubmit={forgotSubmit}
      onSkip={onSkip}
    />
  )
}

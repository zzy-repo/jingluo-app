/**
 * 设置里「账户与消费 → 账号」未登录时的那张登录卡（#727 阶段 1 布局）。
 *
 * 版式照维护者给的原型，1:1：
 *
 *   ┌─────────────────────────────┐
 *   │ [ 登录 ✓ ][  注册  ]        │  ← 分段控件（选中项白底 + 轻阴影）
 *   │ [ 请输入邮箱            ]    │
 *   │ [ 请输入验证码 │ 获取验证码 ]│  ← 只在「注册」分段出现；按钮**定宽右贴**，倒计时 59s 不换行
 *   │ [ 请输入密码（≥6 位）    ]   │
 *   │ [        登 录         ]     │  ← 主按钮整宽 48px；空表单时降透明度禁用（不是灰底黑字）
 *   │         暂不登录             │  ← #608 的口子：直接去填 API Key
 *   │        忘记密码？            │  ← 走真实接口 `/api/v1/auth/forgot-password`
 *   │  未注册的邮箱将自动创建账号   │
 *   └─────────────────────────────┘
 *
 * 三条纪律：
 *  1. **不弹第二层**：它就是设置弹层内容区里的一张卡（没有自己的遮罩 / `role=dialog`）；
 *  2. **状态与表单逻辑不另写一套**：动作全部走既有的 `useAuthStore`（`login` / `register` /
 *     `sendCode`），失败文案用后端给的 `message`，不写「未知错误」；
 *  3. **开关只认服务端**：`registration_enabled !== true` 时分段里不出现「注册」（#484 §3.1d），
 *     不在这里本地兜一个入口。
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { loadAuthFlags, useAuthFlags } from '../../services/auth/flags.js'
import { useAuthStore } from '../../services/auth/store.js'
import type { ConsumeClient } from '../../services/consume/index.js'
import { Button } from '../base/Button.js'
import styles from './AccountConsume.module.css'

type AuthMode = 'login' | 'register'

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

  const [mode, setMode] = useState<AuthMode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
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

  const emailFilled = email.trim() !== ''
  const canSubmit = emailFilled && password !== '' && !submitting
  const codeLoading = sendingCode || countdown > 0

  const switchTo = (next: AuthMode) => {
    setMode(next)
    setNotice(null)
  }

  const submit = () => {
    if (!canSubmit) {
      return
    }
    setNotice(null)
    if (mode === 'login') {
      void signIn({ email: email.trim(), password })
      return
    }
    // 原型没有「确认密码」一行，所以只递服务端要的两项（+ 可选验证码）
    void signUp({
      email: email.trim(),
      password,
      verifyCode: code.trim() === '' ? undefined : code.trim(),
    })
  }

  const requestCode = () => {
    if (codeLoading || !emailFilled) {
      return
    }
    void sendCode({ email: email.trim() })
    setCountdown(CODE_COUNTDOWN)
  }

  /**
   * 忘记密码：接口是有的（`POST /api/v1/auth/forgot-password`），所以**走真接口**：
   * 成功 → 一句「重置邮件已发送」；失败 → 后端 `message`。邮箱没填就先提示填邮箱，
   * 不做死链、也不假装成功。
   */
  const forgot = async () => {
    if (!emailFilled) {
      setNotice(t('settingsAuthForgotNeedsEmail'))
      return
    }
    const result = await consume.auth.forgotPassword({ email: email.trim() })
    if (!alive.current) {
      return
    }
    if (result.ok) {
      setNotice(t('settingsAuthForgotSent'))
      return
    }
    setNotice(result.error.message)
  }

  return (
    <div className={styles.authCard} data-testid="settings-auth-card">
      {flags.registrationEnabled ? (
      <div className={styles.authSegmented} role="group" aria-label={t('sub2authAccount')}>
        <button
          type="button"
          className={mode === 'login' ? `${styles.authSeg} ${styles.authSegOn}` : styles.authSeg}
          aria-pressed={mode === 'login'}
          data-testid="auth-segmented-login"
          onClick={() => switchTo('login')}
        >
          {t('sub2authLogin')}
        </button>
        <button
          type="button"
          className={mode === 'register' ? `${styles.authSeg} ${styles.authSegOn}` : styles.authSeg}
          aria-pressed={mode === 'register'}
          data-testid="auth-segmented-register"
          onClick={() => switchTo('register')}
        >
          {t('sub2authRegister')}
        </button>
      </div>
      ) : null}

      <input
        className={styles.authInput}
        type="email"
        inputMode="email"
        autoComplete="email"
        spellCheck={false}
        placeholder={t('settingsAuthEmailPlaceholder')}
        aria-label={t('sub2authEmail')}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />

      {mode === 'register' ? (
        <div className={styles.authCodeRow}>
          <input
            className={`${styles.authInput} ${styles.authCodeInput}`}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder={t('settingsAuthCodePlaceholder')}
            aria-label={t('settingsAuthCodePlaceholder')}
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button
            type="button"
            className={styles.authCodeButton}
            data-testid="settings-auth-send-code"
            disabled={codeLoading || !emailFilled}
            onClick={requestCode}
          >
            {countdown > 0
              ? t('settingsAuthCountdown', { seconds: countdown })
              : t('settingsAuthSendCode')}
          </button>
        </div>
      ) : null}

      <input
        className={styles.authInput}
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        placeholder={t('settingsAuthPasswordPlaceholder')}
        aria-label={t('sub2authPassword')}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            submit()
          }
        }}
      />

      <Button
        block
        variant="primary"
        size="l"
        className={styles.authPrimary}
        disabled={!canSubmit}
        data-testid="settings-auth-submit"
        onClick={submit}
      >
        {mode === 'login' ? t('sub2authLogin') : t('sub2authRegister')}
      </Button>

      {error ? (
        <div className={styles.authError} role="alert" data-testid="settings-auth-error">
          {t(error.messageKey)}
        </div>
      ) : null}
      {notice ? (
        <div className={styles.authNotice} role="status" data-testid="settings-auth-notice">
          {notice}
        </div>
      ) : null}

      {/* #608 的口子：不登录也能用，直接去填 API Key */}
      <button type="button" className={styles.authLink} data-testid="account-consume-skip-login" onClick={onSkip}>
        {t('settingsAuthSkip')}
      </button>
      <button type="button" className={styles.authLink} data-testid="settings-auth-forgot" onClick={() => void forgot()}>
        {t('sub2authForgotPassword')}？
      </button>
      {mode === 'register' ? (
        <button
          type="button"
          className={styles.authLinkDim}
          data-testid="settings-auth-switch-login"
          onClick={() => switchTo('login')}
        >
          {t('settingsAuthHaveAccount')}
        </button>
      ) : (
        <div className={styles.authHint}>{t('settingsAuthAutoCreateHint')}</div>
      )}
    </div>
  )
}

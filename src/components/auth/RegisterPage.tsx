/**
 * 注册页（W1-B 前半，Issue #487）—— 纯展示 + 本地校验，**不认识 store、不发请求**。
 *
 * 两个字段由服务端开关决定出不出现（#484 §3.1c / §3.1d：「客户端所有『入口是否显示』都由
 * `settings/public` 决定，本地不写死」）：
 *  - `emailVerifyEnabled` → 验证码行 + 「发送验证码」按钮（服务端 `/auth/send-verify-code`，5/min）；
 *  - `invitationCodeEnabled` → 邀请码行（**可选**：邀请关系只能在注册时填一次，#484 §3.1b）。
 *
 * 冷却秒数「不写死文案里的数字」：提示句是 `sub2authCodeSent`，`{seconds}` 由这里的倒计时注入。
 * 服务端限流是 5/min，所以本地冷却取 60s（服务端仍然说了算 —— 早发只会拿回 rate_limited）。
 */

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AuthFlags } from '../../services/auth/flags.js'
import type { AuthError } from '../../services/auth/types.js'
import { Button } from '../base/Button.js'
import { IconToastError16 } from '../base/icons.js'
import {
  isValidEmail,
  issueMessageKey,
  validateRegister,
  type AuthIssue,
  type RegisterValues,
} from './authForm.js'
import styles from './AuthPages.module.css'

/** 服务端发码限流 5/min → 本地冷却 60s（只影响按钮可用时间，不改服务端判定） */
const CODE_COOLDOWN_SECONDS = 60

export type RegisterPageProps = {
  /** 嵌进「账号」面板时的形态（#608）：与 `LoginPage` 的 `embedded` 同一口径 */
  embedded?: boolean
  /** `settings/public` 的三开关：邮箱验证 / 邀请码两行由它控制显隐 */
  flags: AuthFlags
  busy: boolean
  sendingCode: boolean
  error: AuthError | null
  onSubmit: (values: RegisterValues) => void
  /** 返回 true = 发码成功（页面据此开始倒计时）；失败原因走 `error` 显示 */
  onSendCode: (email: string) => Promise<boolean>
  onSwitchToLogin: () => void
}

export const RegisterPage = ({
  embedded = false,
  flags,
  busy,
  sendingCode,
  error,
  onSubmit,
  onSendCode,
  onSwitchToLogin,
}: RegisterPageProps) => {
  const t = useTranslate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [invitationCode, setInvitationCode] = useState('')
  const [issues, setIssues] = useState<AuthIssue[]>([])
  const [cooldown, setCooldown] = useState(0)

  // 倒计时：只用 setTimeout 逐秒减，组件卸载即清；不做 setInterval（避免前后台切换后的漂移）
  useEffect(() => {
    if (cooldown <= 0) {
      return
    }
    const timer = window.setTimeout(() => setCooldown((seconds) => seconds - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const issueOf = (field: AuthIssue['field']): AuthIssue | undefined =>
    issues.find((item) => item.field === field)
  const clearIssue = () => {
    if (issues.length > 0) {
      setIssues([])
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) {
      return
    }
    const found = validateRegister({ email, password, confirmPassword, verifyCode, invitationCode })
    setIssues(found)
    if (found.length > 0) {
      return
    }
    onSubmit({
      email: email.trim(),
      password,
      confirmPassword,
      verifyCode: flags.emailVerifyEnabled ? verifyCode.trim() : undefined,
      // 邀请码是可选的：空串不传，免得服务端把 "" 当成一个无效邀请码
      invitationCode:
        flags.invitationCodeEnabled && invitationCode.trim() !== ''
          ? invitationCode.trim()
          : undefined,
    })
  }

  const sendCode = async () => {
    if (sendingCode || cooldown > 0) {
      return
    }
    if (!isValidEmail(email)) {
      setIssues([{ field: 'email', reason: email.trim() === '' ? 'required' : 'email_format' }])
      return
    }
    if (await onSendCode(email.trim())) {
      setCooldown(CODE_COOLDOWN_SECONDS)
    }
  }

  const emailIssue = issueOf('email')
  const emailMessageKey = emailIssue ? issueMessageKey(emailIssue) : null
  const passwordIssue = issueOf('password')
  const confirmIssue = issueOf('confirmPassword')
  const codeIssue = issueOf('verifyCode')
  const codeButtonDisabled = busy || sendingCode || cooldown > 0

  return (
    <div className={embedded ? styles.embedded : styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t('sub2authRegister')}</h1>

        {error ? (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              <IconToastError16 />
            </span>
            <span>{t(error.messageKey)}</span>
          </div>
        ) : null}

        <form className={styles.form} onSubmit={submit} noValidate>
          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authEmail')}</span>
            <input
              className={emailIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="email"
              name="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="off"
              spellCheck={false}
              value={email}
              aria-invalid={emailIssue ? true : undefined}
              onChange={(event) => {
                setEmail(event.target.value)
                clearIssue()
              }}
            />
            {emailMessageKey ? (
              <span className={styles.fieldError} role="alert">
                {t(emailMessageKey)}
              </span>
            ) : null}
          </label>

          {flags.emailVerifyEnabled ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="auth-verify-code">
                {t('oursEmailCodePlaceholder')}
              </label>
              <div className={styles.codeRow}>
                <input
                  id="auth-verify-code"
                  className={codeIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
                  type="text"
                  name="verifyCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={verifyCode}
                  aria-invalid={codeIssue ? true : undefined}
                  onChange={(event) => {
                    setVerifyCode(event.target.value)
                    clearIssue()
                  }}
                />
                <Button
                  variant="outlined"
                  size="l"
                  className={styles.codeButton}
                  disabled={codeButtonDisabled}
                  aria-busy={sendingCode}
                  onClick={() => {
                    void sendCode()
                  }}
                >
                  {t('sub2authSendCode')}
                </Button>
              </div>
              {cooldown > 0 ? (
                <span className={styles.hint} role="status">
                  {t('sub2authCodeSent', { seconds: cooldown })}
                </span>
              ) : null}
            </div>
          ) : null}

          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authPassword')}</span>
            <input
              className={passwordIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              aria-invalid={passwordIssue ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value)
                clearIssue()
              }}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authConfirmPassword')}</span>
            <input
              className={confirmIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              aria-invalid={confirmIssue ? true : undefined}
              onChange={(event) => {
                setConfirmPassword(event.target.value)
                clearIssue()
              }}
            />
          </label>

          {flags.invitationCodeEnabled ? (
            <label className={styles.field}>
              <span className={styles.label}>{t('inviteCode')}</span>
              <input
                className={styles.input}
                type="text"
                name="invitationCode"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                value={invitationCode}
                onChange={(event) => setInvitationCode(event.target.value)}
              />
              <span className={styles.hint}>{t('inviteCodeAtRegister')}</span>
            </label>
          ) : null}

          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="l" block disabled={busy} aria-busy={busy}>
              <span className={styles.submit}>
                {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
                {t('sub2authRegister')}
              </span>
            </Button>
          </div>
        </form>

        <div className={styles.switchRow}>
          <button
            type="button"
            className={styles.linkButton}
            onClick={onSwitchToLogin}
            disabled={busy}
          >
            {t('sub2authLogin')}
          </button>
        </div>
      </div>
    </div>
  )
}

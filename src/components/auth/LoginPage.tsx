/**
 * 登录页（W1-B 前半，Issue #487）—— 纯展示 + 本地校验，**不认识 store、不发请求**。
 *
 * 为什么把它做成受控组件：AuthGate 负责把 store 的动作接上来，截图脚本 / 后续「换账号」弹层
 * 也能单独渲染这一页并摆出「提交中 / 错误」两种状态（#487 的 390/360 两档截图就是这么来的）。
 *
 * 文案全部走 i18n（已合并的 `sub2auth*`）：标题、字段名、按钮、错误条都取 key，本文件里
 * 没有一句手写中文；错误条的 key 来自 `error.messageKey`（传输层归一结果），页面不自己判断错误类型。
 */

import { useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import type { AuthError } from '../../services/auth/types.js'
import { Button } from '../base/Button.js'
import { IconToastError16 } from '../base/icons.js'
import { issueMessageKey, validateLogin, type AuthIssue, type LoginValues } from './authForm.js'
import styles from './AuthPages.module.css'

export type LoginPageProps = {
  /** 注册入口是否显示：由 `settings/public` 的 `registration_enabled` 决定（false 时整块隐藏，#484 §3.1d） */
  showRegisterEntry: boolean
  /** 提交中：按钮置灰 + aria-busy，表单其余部分保持可见（不要闪成另一种布局） */
  busy: boolean
  /** 上一次提交的失败（归一结果，`messageKey` 就是上屏文案） */
  error: AuthError | null
  onSubmit: (values: LoginValues) => void
  onSwitchToRegister: () => void
}

export const LoginPage = ({
  showRegisterEntry,
  busy,
  error,
  onSubmit,
  onSwitchToRegister,
}: LoginPageProps) => {
  const t = useTranslate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [issues, setIssues] = useState<AuthIssue[]>([])

  const issueOf = (field: AuthIssue['field']): AuthIssue | undefined =>
    issues.find((issue) => issue.field === field)

  // 本地校验只拦「明显发不出去」的：邮箱格式 / 空密码（密码长度交给服务端，老账号短密码也要能登进来）
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) {
      return
    }
    const found = validateLogin({ email, password })
    setIssues(found)
    if (found.length > 0) {
      return
    }
    onSubmit({ email: email.trim(), password })
  }

  const emailIssue = issueOf('email')
  const emailMessageKey = emailIssue ? issueMessageKey(emailIssue) : null
  const passwordIssue = issueOf('password')

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>{t('sub2authLogin')}</h1>

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
                if (issues.length > 0) {
                  setIssues([])
                }
              }}
            />
            {emailMessageKey ? (
              <span className={styles.fieldError} role="alert">
                {t(emailMessageKey)}
              </span>
            ) : null}
          </label>

          <label className={styles.field}>
            <span className={styles.label}>{t('sub2authPassword')}</span>
            <input
              className={passwordIssue ? `${styles.input} ${styles.inputInvalid}` : styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              aria-invalid={passwordIssue ? true : undefined}
              onChange={(event) => {
                setPassword(event.target.value)
                if (issues.length > 0) {
                  setIssues([])
                }
              }}
            />
          </label>

          <div className={styles.actions}>
            <Button type="submit" variant="primary" size="l" block disabled={busy} aria-busy={busy}>
              <span className={styles.submit}>
                {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
                {t('sub2authLogin')}
              </span>
            </Button>
          </div>
        </form>

        {showRegisterEntry ? (
          <div className={styles.switchRow}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={onSwitchToRegister}
              disabled={busy}
            >
              {t('sub2authRegister')}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

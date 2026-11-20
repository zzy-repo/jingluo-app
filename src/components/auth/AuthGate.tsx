/**
 * 登录墙（W1-B 前半，Issue #487）—— 未登录挡住主界面，已登录放行 children。
 *
 * 三件事，全部是「接线」而不是「实现」：
 *  1. 启动时并行做两件事：读 `settings/public` 的开关（`loadAuthFlags`）、恢复登录态（`restoreAuth`）。
 *     两件事互不阻塞 —— 开关读失败只影响「注册入口显不显示」，不该让登录也跟着转圈。
 *  2. 按登录态决定渲染：`restored=false` → 加载中；`authenticated` → 主界面；
 *     其余（`unauthenticated` / `expired` / `authenticating`）→ 登录页或注册页。
 *  3. 把 store 的动作接到页面回调上：页面本身不认识 store（见 LoginPage / RegisterPage 的文件头）。
 *
 * 注册入口的显隐口径（#484 §3.1d）：`registration_enabled !== true` → **整块隐藏**，不是置灰。
 * 用户已经停在注册页时开关被关掉（服务端随时可能改），这里主动送回登录页。
 *
 * TODO(W1-B 后半)：首启流程整体换成 AuthGate（`src/main.tsx` 的占位接线已留好），并把
 * `expired` 状态配上「登录已过期」文案（当前 i18n 骨架没有对应 key，本轮不硬编）。
 */

import { useEffect, useState, type ReactNode } from 'react'
import { loadAuthFlags, useAuthFlags } from '../../services/auth/flags.js'
import { restoreAuth, useAuthStore } from '../../services/auth/store.js'
import type { LoginValues, RegisterValues } from './authForm.js'
import { LoginPage } from './LoginPage.js'
import { RegisterPage } from './RegisterPage.js'
import styles from './AuthPages.module.css'

type AuthMode = 'login' | 'register'

export type AuthGateProps = {
  /** 已登录时渲染的内容（W1-B 后半接的是整个 App） */
  children?: ReactNode
}

export const AuthGate = ({ children }: AuthGateProps) => {
  const authState = useAuthStore((state) => state.state)
  const restored = useAuthStore((state) => state.restored)
  const busy = useAuthStore((state) => state.submitting)
  const sendingCode = useAuthStore((state) => state.sendingCode)
  const error = useAuthStore((state) => state.error)
  const signIn = useAuthStore((state) => state.signIn)
  const signUp = useAuthStore((state) => state.signUp)
  const sendCode = useAuthStore((state) => state.sendCode)
  const dismissError = useAuthStore((state) => state.dismissError)
  const flags = useAuthFlags()
  const [mode, setMode] = useState<AuthMode>('login')

  useEffect(() => {
    void loadAuthFlags()
    void restoreAuth()
  }, [])

  // 开关一关，注册页就不能再停在那儿（隐藏入口 ≠ 拦住已经在页面上的人）
  useEffect(() => {
    if (!flags.registrationEnabled && mode === 'register') {
      setMode('login')
    }
  }, [flags.registrationEnabled, mode])

  const switchTo = (next: AuthMode) => {
    dismissError()
    setMode(next)
  }

  const handleLogin = (values: LoginValues) => {
    void signIn(values)
  }

  const handleRegister = (values: RegisterValues) => {
    void signUp({
      email: values.email,
      password: values.password,
      verifyCode: values.verifyCode,
      invitationCode: values.invitationCode,
    })
  }

  const handleSendCode = async (email: string): Promise<boolean> => {
    const result = await sendCode({ email })
    return result.ok
  }

  // 启动恢复没跑完：只转圈，不闪登录页（否则每次冷启动都会看到登录页一闪而过）
  if (!restored) {
    return (
      <div className={styles.gateLoading} role="status" aria-busy="true">
        <span className={styles.gateSpinner} aria-hidden="true" />
      </div>
    )
  }

  if (authState === 'authenticated') {
    return <>{children}</>
  }

  if (mode === 'register') {
    return (
      <RegisterPage
        flags={flags}
        busy={busy}
        sendingCode={sendingCode}
        error={error}
        onSubmit={handleRegister}
        onSendCode={handleSendCode}
        onSwitchToLogin={() => switchTo('login')}
      />
    )
  }

  return (
    <LoginPage
      showRegisterEntry={flags.registrationEnabled}
      busy={busy}
      error={error}
      onSubmit={handleLogin}
      onSwitchToRegister={() => switchTo('register')}
    />
  )
}

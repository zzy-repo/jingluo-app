/**
 * 登录墙（W1-B，Issue #487）—— 未登录挡住主界面，已登录放行 children。
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
 * 恢复期间**不闪白屏、也不先渲染主界面再跳走**：只画一个极简 loading（`gateLoading`），
 * 等 `restored` 变成 true 才决定渲染哪一边。弱网 / 离线时另有一道超时兜底
 * （`GATE_RESTORE_TIMEOUT_MS`）：到点就放弃等待、回登录页并挂一句「网络错误，请检查网络后重试」——
 * 登录表单本身就是那条重试路径，不弹错误框、也不再转圈。
 *
 * 「登录已过期」（`expired`：续期失败 / JWT 不被认）同样落在登录页，额外挂一句 `sub2authSessionExpired`，
 * 让用户知道不是他填错了密码。
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { TranslationKey } from '../../i18n/index.js'
import { loadAuthFlags, useAuthFlags } from '../../services/auth/flags.js'
import { restoreAuth, useAuthStore } from '../../services/auth/store.js'
import type { LoginValues, RegisterValues } from './authForm.js'
import { LoginPage } from './LoginPage.js'
import { RegisterPage } from './RegisterPage.js'
import styles from './AuthPages.module.css'

type AuthMode = 'login' | 'register'

/**
 * 启动恢复的等待上限：超过就放弃等待（见文件头）。
 *
 * 取 12s：消费层只读请求的超时是 10s（`config/endpoints.json` 的 `consume.timeoutMs.read`），
 * 恢复最多串行两条（续期 + `me()`），正常网络下远小于这个数；到点还没结果就一定是卡住了。
 */
const GATE_RESTORE_TIMEOUT_MS = 12_000

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
  const abandonRestore = useAuthStore((state) => state.abandonRestore)
  const flags = useAuthFlags()
  const [mode, setMode] = useState<AuthMode>('login')

  useEffect(() => {
    void loadAuthFlags()
    void restoreAuth()
  }, [])

  // 恢复迟迟不回（离线 / 代理卡住）：到点放弃等待，把界面交给登录页
  useEffect(() => {
    if (restored) {
      return
    }
    const timer = setTimeout(() => {
      abandonRestore()
    }, GATE_RESTORE_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [restored, abandonRestore])

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

  // 「登录已过期」要说清楚原因：不然用户会以为是自己密码填错了
  const noticeKey: TranslationKey | null = authState === 'expired' ? 'sub2authSessionExpired' : null

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
      noticeKey={noticeKey}
      busy={busy}
      error={error}
      onSubmit={handleLogin}
      onSwitchToRegister={() => switchTo('register')}
    />
  )
}

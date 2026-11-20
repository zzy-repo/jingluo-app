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
import type { AuthUser } from '../../services/auth/types.js'
import type { LoginValues, RegisterValues } from './authForm.js'
import { LoginPage } from './LoginPage.js'
import { RegisterPage } from './RegisterPage.js'
import styles from './AuthPages.module.css'

type AuthMode = 'login' | 'register'

/**
 * 登录接缝（Issue #487 W1-B 后半，#510）—— **构建期常量**，不是运行期开关。
 *
 * 背景：`src/main.tsx` 把整个 `<App/>` 包在 `<AuthGate>` 里之后，未登录冷启动只画登录页，
 * 于是所有「启动即进主界面」的浏览器用例（黄金回归 G2~G11、L1 的 feedback-scroll…）拿不到侧栏
 * 与输入框。测试需要一种「这台机器上的这份产物，启动就是已登录」的方式，而**不能**是
 * URL 参数 / localStorage 标记 / `diag-debug` 这类运行期旁路：那种分支会原样留在线上 bundle 里，
 * 任何人拿到就能绕过登录墙。
 *
 * 所以做成构建期常量：`rspack.config.ts` 的 DefinePlugin 在**生产构建**里把它内联成 `undefined`
 * （本例的取值折叠成 `undefined`，下面的守卫整段被死代码消除，产物里连这个标识符都不出现）；
 * 只有 `TEST_AUTH_SEAM=1` 的**测试构建**注入一个假会话。取值 / 标记 / 安全论证的出处是
 * `scripts/lib/testAuthSeam.mjs`，产物扫描守卫见 `scripts/check-test-seam.mjs`。
 *
 * `typeof` 写法是为了**没有打包器的场合**（`node --test` 直接 import）：未声明标识符上写 `typeof`
 * 不会抛 ReferenceError，求值为 `'undefined'` → 正常路径。它**不是**运行期兜底：
 * 构建产物里这里已经是 `typeof undefined`，没有任何代码去读全局变量。
 */
declare const __TEST_AUTH_STATE__: TestAuthState | undefined

/** 假会话的形状（由构建期注入；`scripts/lib/testAuthSeam.mjs` 的 `SEAM_SESSION` 是同一份） */
type TestAuthState = {
  accessToken: string
  user: AuthUser
}

const TEST_AUTH_STATE: TestAuthState | undefined =
  typeof __TEST_AUTH_STATE__ !== 'undefined' ? __TEST_AUTH_STATE__ : undefined

// 接缝生效时（**只可能是测试构建**）在首帧之前就把会话灌进 store：界面里读 `useAuthStore` 的地方
// （账号行、额度面板…）因此与「真的登录过」一致，而不是只把登录页挡掉。生产构建里上面那一行已经
// 折叠成 `undefined`，这个 `if` 恒假 → 整段被死代码消除。
if (TEST_AUTH_STATE !== undefined) {
  useAuthStore.setState({
    state: 'authenticated',
    token: { accessToken: TEST_AUTH_STATE.accessToken, tokenType: 'Bearer', expiresAt: null },
    user: TEST_AUTH_STATE.user,
    error: null,
    submitting: false,
    restored: true,
  })
}

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
    // 接缝生效时恢复已经被「直接进已登录态」取代（生产构建里恒真，没有第二条路）
    if (TEST_AUTH_STATE === undefined) {
      void restoreAuth()
    }
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

  // 接缝生效（仅测试构建）：直接放行主界面 —— 放在所有登录态判定之前短路。
  if (TEST_AUTH_STATE !== undefined) {
    return <>{children}</>
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

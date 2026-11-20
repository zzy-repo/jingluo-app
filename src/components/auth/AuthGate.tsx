/**
 * 账号区的登录 / 注册卡（W1-B 引入，**#608 拆掉登录墙后降级为局部组件**）。
 *
 * ## 现在它是什么（#608）
 *
 * 它**不再是登录墙**：`src/main.tsx` 已经不再用它包住整个 `<App/>`，首屏直接进聊天，没账号、
 * 只填了 API Key 的用户照样能用（维护者定调：「账户体系只是一小部分，不是主体」）。它现在只有
 * 一个用法 —— **「我们的渠道 → 账户与消费 → 账号」tab 里的局部卡片**（`variant="inline"`，
 * 由 `AccountPanel` 在未登录时挂载）。旧的整屏形态（`variant="page"`，默认值）保留给
 * 「需要一个独立登录页」的场合（截图脚本 / 将来的换账号弹层），不再有任何启动路径走它。
 *
 * ## 它做的三件事（全是接线，不是实现）
 *  1. 读 `settings/public` 的开关（`loadAuthFlags`）、恢复登录态（`restoreAuth`）。启动时
 *     `main.tsx` 已经在后台跑过一次（幂等，重复调用共用同一个 promise），这里再调一次只是为了
 *     「这一块自己能独立成立」，不承担首屏时序。
 *  2. 按登录态决定渲染：`restored=false` → 转圈；`authenticated` → `children`（整屏形态下是主界面；
 *     局部形态下没人传 children，登录态由 `AccountPanel` 自己判）；其余 → 登录或注册卡。
 *  3. 把 store 的动作接到页面回调上：页面本身不认识 store（见 LoginPage / RegisterPage 的文件头）。
 *
 * 注册入口的显隐口径（#484 §3.1d）：`registration_enabled !== true` → **整块隐藏**，不是置灰。
 * 用户已经停在注册页时开关被关掉（服务端随时可能改），这里主动送回登录页。
 *
 * 恢复期间不闪白屏：只画一个极简 loading（`gateLoading` / 局部形态的 `inlineLoading`）。
 * 弱网 / 离线时另有一道超时兜底（`GATE_RESTORE_TIMEOUT_MS`）：到点就放弃等待、把界面交给
 * 登录表单 —— 表单本身就是那条重试路径，不弹错误框、也不再转圈。
 *
 * 「登录已过期」（`expired`：续期失败 / JWT 不被认）同样落在表单上，额外挂一句 `sub2authSessionExpired`，
 * 让用户知道不是他填错了密码。
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
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
 * 背景：W1-B 把整个 `<App/>` 包在 `<AuthGate>` 里之后，未登录冷启动只画登录页，
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
  /** 已登录时渲染的内容（整屏形态下接的是整个 App；#608 之后入口不再这么用） */
  children?: ReactNode
  /**
   * 形态（#608）：
   *  - `'page'`（默认）：整屏一张卡 —— 独立的登录 / 注册页；
   *  - `'inline'`：嵌进「账号」面板里的局部卡片 —— 桌面/手机都在设置弹层内部，不占满屏。
   * 两种形态的**表单与接线完全同一份**（`LoginPage` / `RegisterPage` 只换外层容器），
   * 差别仅在于「占满一屏」还是「跟着宿主排版」。
   */
  variant?: 'page' | 'inline'
}

export const AuthGate = ({ children, variant = 'page' }: AuthGateProps) => {
  const inline = variant === 'inline'
  const t = useTranslate()
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
      <div className={inline ? styles.inlineLoading : styles.gateLoading} role="status" aria-busy="true">
        <span className={styles.gateSpinner} aria-hidden="true" />
        {/* 局部形态必须有一句人话：面板里单转一个圈，用户不知道在等什么 */}
        {inline ? <span className={styles.inlineLoadingText}>{t('accountOptionalChecking')}</span> : null}
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
        embedded={inline}
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
      embedded={inline}
      showRegisterEntry={flags.registrationEnabled}
      noticeKey={noticeKey}
      busy={busy}
      error={error}
      onSubmit={handleLogin}
      onSwitchToRegister={() => switchTo('register')}
    />
  )
}

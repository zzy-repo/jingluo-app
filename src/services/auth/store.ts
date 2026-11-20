/**
 * 登录态存储 —— W1-B 前半，Issue #487（#482 定调 / #484 §二「JWT 只进 header、刷新失败就清态回登录」）。
 *
 * 这个文件是身份层唯一有副作用的地方，做四件事：
 *  1. **凭据落盘**（`AuthTokenStorage`）：默认写 localStorage 单键，**与 API Key 同级**
 *     （`chat-demo:api-key` 也是 localStorage，见 `src/services/api/apiConfig.ts`）。
 *     硬约束：**不许把 JWT 写进 IndexedDB 明文**（#484 §二）—— 所以这里连 `chat/db.ts` 都不 import。
 *  2. **启动恢复**（`restoreAuth`）：读盘 → 过期就先续（`refreshToken`）→ 用 `me()` 验一次。
 *  3. **续期**（`refreshSession`）：**失败即清态回登录**，不静默重试（#484 §二）。
 *  4. **订阅**（`subscribeAuth` / `useAuthStore`）：React 组件用 hook，非组件代码用 `subscribeAuth`。
 *
 * 与 W1-A 的接线点（两条，都是单行）：
 *  - `setAuthTransport(createAuthTransport(http))` —— 把 `src/services/consume/auth.ts` 的实现挂上来；
 *  - `createConsumeHttp({ accessToken: getAccessToken })` —— 反过来让消费层每次请求能取到最新的 JWT。
 *    传输层没挂上时所有动作返回 `kind:'unavailable'`，界面照常渲染，不会崩也不会假登录。
 *
 * 顺带两条「不许」：token 不许进日志 / 埋点 / DOM 文本；`AuthSnapshot.token` 只给传输层用，
 * 界面要展示账号就展示 `user.email`。
 *
 * 声明顺序有意为之：动作函数先声明、`useAuthStore` 后创建 —— store 的初值里直接引用动作，
 * 反过来写会在模块求值时踩 TDZ。
 */

import { create } from 'zustand'
import { claimLegacyMigration } from '../../legacy/migration/index.js'
import type {
  AuthLoginInput,
  AuthRegisterInput,
  AuthSendCodeInput,
  AuthTransport,
} from './transport.js'
import type {
  AccessToken,
  AuthDone,
  AuthError,
  AuthResult,
  AuthSession,
  AuthState,
  AuthUser,
} from './types.js'

/** 内存里的登录态快照：界面的全部输入都从这里来（含「加载中 / 提交中 / 错误」三个 UI 状态） */
export type AuthSnapshot = {
  state: AuthState
  user: AuthUser | null
  /**
   * 当前凭据。**只给传输层拼 header 用**：界面、日志、埋点一律不许读它（渲染前先问「你要展示什么」）。
   */
  token: AccessToken | null
  /** 最近一次失败的归一结果（`messageKey` 就是界面要显示的文案 key） */
  error: AuthError | null
  /** 启动恢复是否已经跑过：false 时界面显示「加载中」，别急着弹登录页 */
  restored: boolean
  /** 登录 / 注册请求进行中（按钮置灰 + aria-busy） */
  submitting: boolean
  /** 发验证码进行中（与 `submitting` 分开：发码时表单其余部分仍然可用） */
  sendingCode: boolean
}

/** store 同时挂动作：界面只调动作，状态只经 `setState` 改（别在别处写状态） */
export type AuthStore = AuthSnapshot & {
  signIn: (input: AuthLoginInput) => Promise<AuthResult<AuthUser>>
  signUp: (input: AuthRegisterInput) => Promise<AuthResult<AuthUser>>
  signOut: () => Promise<void>
  /** 发注册验证码：只影响 `sendingCode`，不动登录态 */
  sendCode: (input: AuthSendCodeInput) => Promise<AuthResult<AuthDone>>
  refreshSession: () => Promise<boolean>
  restore: () => Promise<void>
  /**
   * 启动恢复迟迟不回（离线 / 服务端不应答）时**放弃等待**：把界面放回登录页，
   * 并挂一句可重试的提示。由 `AuthGate` 的超时兜底调用（见 `GATE_RESTORE_TIMEOUT_MS`）。
   */
  abandonRestore: () => void
  /** 用户手动关掉错误条 / 重新输入时清掉上一次的失败 */
  dismissError: () => void
}

// --------------------------------------------------------------------------- 凭据落盘

/**
 * 凭据存储口子：默认 localStorage，**留给原生安全存储替换**（Capacitor Preferences / Android Keystore）。
 *
 * TODO(W1-B 后半)：接原生安全存储时只替换这一个对象（`setAuthTokenStorage`），
 * 上层 store 与 UI 一行都不用改；在那之前 localStorage 已经是「与 API Key 同级」，
 * 满足 #484 §二的最低要求（不许 IndexedDB 明文）。
 */
export type AuthTokenStorage = {
  read: () => string | null
  write: (value: string | null) => void
}

/** 与 API Key（`chat-demo:api-key`）同一个命名空间、同样的读写异常吞掉策略；**JWT 与 Key 分开存、分别清理** */
const TOKEN_KEY = 'chat-demo:auth-token'

const localTokenStorage: AuthTokenStorage = {
  read: () => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      // 存储不可用（隐私模式 / 配额满）：当没登录过，不抛错
      return null
    }
  },
  write: (value) => {
    try {
      if (value === null) {
        localStorage.removeItem(TOKEN_KEY)
      } else {
        localStorage.setItem(TOKEN_KEY, value)
      }
    } catch {
      // 写不进去只影响「下次启动要不要重新登录」，不影响本次会话
    }
  },
}

let tokenStorage: AuthTokenStorage = localTokenStorage

/** 替换凭据存储（原生安全存储 / 测试）；传 null 恢复默认 localStorage */
export const setAuthTokenStorage = (next: AuthTokenStorage | null): void => {
  tokenStorage = next ?? localTokenStorage
}

/** 落盘的载荷：**版本号 + token + user**。user 只用来让「离线启动」也能显示邮箱，不含敏感字段 */
type PersistedAuth = {
  v: 1
  token: AccessToken
  user: AuthUser | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readPersisted = (): PersistedAuth | null => {
  const raw = tokenStorage.read()
  if (!raw) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.v !== 1 || !isRecord(parsed.token)) {
      tokenStorage.write(null)
      return null
    }
    const token = parsed.token
    if (typeof token.accessToken !== 'string' || token.accessToken === '') {
      tokenStorage.write(null)
      return null
    }
    return {
      v: 1,
      token: {
        accessToken: token.accessToken,
        refreshToken: typeof token.refreshToken === 'string' ? token.refreshToken : undefined,
        tokenType: typeof token.tokenType === 'string' ? token.tokenType : 'Bearer',
        expiresAt: typeof token.expiresAt === 'number' ? token.expiresAt : null,
      },
      user: isRecord(parsed.user) ? (parsed.user as AuthUser) : null,
    }
  } catch {
    // 损坏 / 旧版本格式：直接清掉，宁可让用户重登一次，也不要把半截状态带上线
    tokenStorage.write(null)
    return null
  }
}

const writePersisted = (token: AccessToken, user: AuthUser | null): void => {
  try {
    tokenStorage.write(JSON.stringify({ v: 1, token, user } satisfies PersistedAuth))
  } catch {
    tokenStorage.write(null)
  }
}

// --------------------------------------------------------------------------- 传输层接线

let transport: AuthTransport | null = null

/**
 * 挂上传输层实现（W1-A 的 `src/services/consume/auth.ts`）。
 *
 * TODO(W1-A)：在启动处加一行（W1-B 后半接 AuthGate 时一起落）：
 *   `setAuthTransport(createAuthTransport(createConsumeHttp({ accessToken: getAccessToken })))`
 * 本单不写这一行 —— HTTP 归 W1-A，本单只保证「没挂上时界面不崩、动作返回 unavailable」。
 */
export const setAuthTransport = (next: AuthTransport | null): void => {
  transport = next
}

/** 有没有挂上传输层（界面据此区分「还没接线」与「真的失败了」） */
export const hasAuthTransport = (): boolean => transport !== null

// --------------------------------------------------------------------------- 错误与时间

const errorFor = (code: string, messageKey: AuthError['messageKey'], message = ''): AuthError => ({
  kind: 'unavailable',
  code,
  message,
  status: 0,
  retryable: false,
  messageKey,
})

/** 传输层没接上：**不是**用户的错，文案不能说「账号或密码错误」（那是 `sub2authCredentialInvalid`） */
const transportMissing = (): AuthError => errorFor('AUTH_TRANSPORT_MISSING', 'sub2authNetworkError')

/** 传输层违约（抛了异常 / 没按 `AuthResult` 返回）：兜底成「稍后重试」，原始文本留给日志排查 */
const unexpected = (thrown: unknown): AuthError =>
  errorFor(
    'AUTH_TRANSPORT_THREW',
    'sub2authLoginFailed',
    thrown instanceof Error ? thrown.message : ''
  )

/** 提前一分钟续期，避免「刚好在路上过期」 */
const REFRESH_LEEWAY_MS = 60 * 1000

const needsRefresh = (token: AccessToken): boolean =>
  token.expiresAt !== null && token.expiresAt - REFRESH_LEEWAY_MS <= Date.now()

// --------------------------------------------------------------------------- 动作

const applySession = (session: AuthSession): void => {
  writePersisted(session.token, session.user)
  useAuthStore.setState({
    state: 'authenticated',
    token: session.token,
    user: session.user,
    error: null,
    submitting: false,
    restored: true,
  })
  // 老账号额度迁移（#498 的临时尾巴，@remove-after 1.6.0）：登录 / 注册成功后**只发一次**。
  // 失败静默 —— `claimLegacyMigration` 自己保证不抛，`void` 掉不阻塞登录、也不产生未处理 rejection；
  // 开关关着时它在读任何本地槽位之前就返回（见 src/legacy/migration/README.md）。
  try { void claimLegacyMigration(session.token.accessToken) } catch { /* 迁移永不影响登录 */ }
}

/** 清态回登录页：落盘一起清（#484 §二「刷新失败就清登录态」） */
const clearSession = (
  next: Extract<AuthState, 'unauthenticated' | 'expired'>,
  error: AuthError | null = null
): void => {
  tokenStorage.write(null)
  useAuthStore.setState({
    state: next,
    token: null,
    user: null,
    error,
    submitting: false,
    restored: true,
  })
}

/** 登录：成功即 authenticated；失败停在 unauthenticated 并把 `error` 交给界面（文案由 `messageKey` 决定） */
const signIn = async (input: AuthLoginInput): Promise<AuthResult<AuthUser>> => {
  if (!transport) {
    const error = transportMissing()
    useAuthStore.setState({ error, submitting: false })
    return { ok: false, error }
  }
  useAuthStore.setState({ state: 'authenticating', submitting: true, error: null })
  let result: AuthResult<AuthSession>
  try {
    result = await transport.login(input)
  } catch (thrown) {
    const error = unexpected(thrown)
    useAuthStore.setState({ state: 'unauthenticated', submitting: false, error })
    return { ok: false, error }
  }
  if (!result.ok) {
    useAuthStore.setState({ state: 'unauthenticated', submitting: false, error: result.error })
    return result
  }
  applySession(result.data)
  return { ok: true, data: result.data.user }
}

/** 注册：sub2api 注册即登录，成功体与 login 同形 —— 所以直接复用同一个落地逻辑 */
const signUp = async (input: AuthRegisterInput): Promise<AuthResult<AuthUser>> => {
  if (!transport) {
    const error = transportMissing()
    useAuthStore.setState({ error, submitting: false })
    return { ok: false, error }
  }
  useAuthStore.setState({ state: 'authenticating', submitting: true, error: null })
  let result: AuthResult<AuthSession>
  try {
    result = await transport.register(input)
  } catch (thrown) {
    const error = unexpected(thrown)
    useAuthStore.setState({ state: 'unauthenticated', submitting: false, error })
    return { ok: false, error }
  }
  if (!result.ok) {
    useAuthStore.setState({ state: 'unauthenticated', submitting: false, error: result.error })
    return result
  }
  applySession(result.data)
  return { ok: true, data: result.data.user }
}

/**
 * 续期：**失败就清态回登录，绝不静默重试**（#484 §二）。
 * 返回 true = 现在又有一颗可用 token；false = 已经回到登录页。
 */
const refreshSession = async (): Promise<boolean> => {
  const current = useAuthStore.getState().token
  const refreshToken = current?.refreshToken
  if (!transport || !refreshToken) {
    clearSession('expired')
    return false
  }
  let result: AuthResult<AccessToken>
  try {
    result = await transport.refreshToken({ refreshToken })
  } catch (thrown) {
    clearSession('expired', unexpected(thrown))
    return false
  }
  if (!result.ok) {
    clearSession('expired', result.error)
    return false
  }
  // 服务端这次没回 refresh_token 时沿用旧的（实测会轮换，但别把「没回」当成「作废」）
  const next: AccessToken = {
    ...result.data,
    refreshToken: result.data.refreshToken ?? refreshToken,
  }
  writePersisted(next, useAuthStore.getState().user)
  useAuthStore.setState({ state: 'authenticated', token: next, error: null, submitting: false })
  return true
}

/**
 * 退出登录：先尽力让服务端把该账号的会话全部作废（`revoke-all-sessions`），**再**清本地。
 * 顺序不能反 —— 反了就没有 JWT 可发了，服务端会话会留在那儿。
 */
const signOut = async (): Promise<void> => {
  if (transport) {
    try {
      await transport.logout()
    } catch {
      // 退出这件事不能因为网络失败而退不掉：服务端没作废成功也照样清本地
    }
  }
  clearSession('unauthenticated')
}

/**
 * 发注册验证码（`POST /api/v1/auth/send-verify-code`）。
 *
 * 刻意**不动登录态**：成功 / 失败都只回结果，冷却秒数由界面自己算（服务端限流 5/min）。
 * 失败时把 `error` 写进快照，界面按 `messageKey` 显示（`sub2authNetworkError` / `sub2authCodeInvalid`）。
 */
const sendCode = async (input: AuthSendCodeInput): Promise<AuthResult<AuthDone>> => {
  if (!transport) {
    const error = transportMissing()
    useAuthStore.setState({ error, sendingCode: false })
    return { ok: false, error }
  }
  useAuthStore.setState({ sendingCode: true, error: null })
  let result: AuthResult<AuthDone>
  try {
    result = await transport.sendCode(input)
  } catch (thrown) {
    const error = unexpected(thrown)
    useAuthStore.setState({ sendingCode: false, error })
    return { ok: false, error }
  }
  useAuthStore.setState({ sendingCode: false, error: result.ok ? null : result.error })
  return result
}

let restoring: Promise<void> | null = null

/**
 * 启动恢复：读盘 → 需要就续期 → `me()` 校验一次。
 *
 * 三处刻意的取舍：
 *  - **传输层没挂上时保留本地会话**（`state:'authenticated'`）：W1-A 合并前不能把人无端登出；
 *  - `me()` 失败只在 `kind === 'auth'` 时清态，网络错误保留会话（离线启动不该被当成「密码错了」）；
 *  - 幂等：`restored` 为 true 直接返回，并发调用共用同一个 promise（启动接线与 AuthGate 都会调）。
 */
export const restoreAuth = async (): Promise<void> => {
  if (useAuthStore.getState().restored) {
    return
  }
  if (restoring) {
    return restoring
  }
  restoring = (async () => {
    const persisted = readPersisted()
    if (!persisted) {
      clearSession('unauthenticated')
      return
    }
    useAuthStore.setState({
      state: 'authenticating',
      token: persisted.token,
      user: persisted.user,
      error: null,
    })
    if (needsRefresh(persisted.token) && !(await refreshSession())) {
      // refreshSession 内部已经清态回登录（expired），这里不用再补动作
      return
    }
    if (!transport) {
      useAuthStore.setState({ state: 'authenticated', restored: true })
      return
    }
    let me: AuthResult<AuthUser>
    try {
      me = await transport.me()
    } catch (thrown) {
      // 网络类异常：保留会话，只是这次没刷新到用户画像
      useAuthStore.setState({ state: 'authenticated', restored: true, error: unexpected(thrown) })
      return
    }
    if (me.ok) {
      writePersisted(useAuthStore.getState().token ?? persisted.token, me.data)
      useAuthStore.setState({ state: 'authenticated', user: me.data, restored: true })
      return
    }
    // 只有「JWT 不认」才清态（`auth`）；网络 / 限流这类保留本地会话，别把人误踢下线
    if (me.error.kind === 'auth') {
      clearSession('expired', me.error)
      return
    }
    useAuthStore.setState({ state: 'authenticated', restored: true, error: me.error })
  })().finally(() => {
    restoring = null
  })
  return restoring
}

/**
 * 启动恢复超时（离线 / 服务端一直不应答）时**放弃等待**：回登录页。
 *
 * 为什么需要它：`restoreAuth` 等的是「续期 + me()」两条网络请求，传输层虽然带超时，
 * 但在弱网 / 代理卡住的场景里用户可能盯着转圈十几秒什么都做不了。登录墙（`AuthGate`）
 * 到点就调这里，把界面交给登录表单 —— **登录本身就是那条「重试」**，不再额外弹错误框。
 *
 * 两处刻意的取舍：
 *  - **不动落盘凭据**（不调 `tokenStorage.write(null)`）：网络恢复后下次启动仍然能自动恢复，
 *    不能因为一次离线就把人登出；
 *  - 只改内存态（`restored: true`）—— 之后 `restoreAuth` 的迟到结果最多把「已经确认自己是谁的
 *    用户」再确认一次，不会把未登录的人放进去。
 */
const abandonRestore = (): void => {
  if (useAuthStore.getState().restored) {
    return
  }
  useAuthStore.setState({
    state: 'unauthenticated',
    token: null,
    user: null,
    error: errorFor('AUTH_RESTORE_TIMEOUT', 'sub2authNetworkError'),
    submitting: false,
    restored: true,
  })
}

// --------------------------------------------------------------------------- store

/** 登录态 store：快照 + 动作（动作在上面，初值里直接引用，避免 TDZ） */
export const useAuthStore = create<AuthStore>(() => ({
  state: 'unauthenticated',
  user: null,
  token: null,
  error: null,
  restored: false,
  submitting: false,
  sendingCode: false,
  signIn,
  signUp,
  signOut,
  sendCode,
  refreshSession,
  restore: restoreAuth,
  abandonRestore,
  dismissError: () => useAuthStore.setState({ error: null }),
}))

// --------------------------------------------------------------------------- 对外只读口

/** React 组件用：`const busy = useAuthStore((s) => s.submitting)` */
export const useAuth = (): AuthStore => useAuthStore()

/** 非组件代码用：订阅登录态变化（返回取消订阅函数）。订阅时先同步推一次当前快照 */
export const subscribeAuth = (listener: (snapshot: AuthSnapshot) => void): (() => void) => {
  listener(useAuthStore.getState())
  return useAuthStore.subscribe((snapshot) => {
    listener(snapshot)
  })
}

/** 当前快照（不要在渲染期缓存它，直接订阅） */
export const getAuthSnapshot = (): AuthSnapshot => useAuthStore.getState()

/**
 * 给消费层用的 JWT 提供者：`createConsumeHttp({ accessToken: getAccessToken })`。
 * 每次请求取一次，所以续期之后立刻生效（W1-A 的 `ConsumeHttpOptions.accessToken` 就是这个签名）。
 */
export const getAccessToken = (): string | undefined => useAuthStore.getState().token?.accessToken

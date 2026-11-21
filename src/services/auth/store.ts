/**
 * 登录态存储 —— W1-B 前半，Issue #487（#482 定调 / #484 §二「JWT 只进 header、刷新失败就清态回登录」）。
 * 第一步的行为层由 Issue #740 补齐（401 单飞刷新 + 重放 + 切号清理），见下面第 5 条。
 *
 * 这个文件是身份层唯一有副作用的地方，做五件事：
 *  1. **凭据落盘**（`AuthTokenStorage`）：默认写 localStorage 单键，**与 API Key 同级**
 *     （`chat-demo:api-key` 也是 localStorage，见 `src/services/api/apiConfig.ts`）。
 *     硬约束：**不许把 JWT 写进 IndexedDB 明文**（#484 §二）—— 所以这里连 `chat/db.ts` 都不 import。
 *     **安全存储待 #740-②**：接 Keychain / Keystore 需要新增原生依赖，维护者还没放行，
 *     所以当前暴露面**等价于 API Key**（同一条 XSS / 本地调试路径就能读走 30 天有效的 refresh_token）。
 *  2. **启动恢复**（`restoreAuth`）：读盘 → 快过期才先续（`refreshSessionOnce`）→ 用 `me()` 验一次。
 *     **不强制登录**：有 refresh_token 就静默换，换不到再说（#740 §五 第 1 条）。
 *  3. **续期**（`refreshSessionOnce`）：**单飞**（并发 401 只发一次 `/auth/refresh`），
 *     结果分三种（成功 / 会话失效 / 网络失败），只有「会话失效」才清态（#740 ①②⑤）。
 *  4. **401 换凭据入口**（`handleUnauthorized`）：消费层 `http.ts` 的 `onUnauthorized` 钩子挂在这里 ——
 *     业务请求 401 → 刷新一次 → 重放（重放由 http 层做，本文件只回答「换了没」）。
 *  5. **清态与切号**（`clearSession`）：清 access + refresh + 账号级缓存（`purgeSessionCaches()`），
 *     保证 A 退出后 B 登录看不到 A 的余额 / 卡密 / 消费记录（#740 ③④）。
 *
 * 与 W1-A 的接线点（两条，都是单行）：
 *  - `setAuthTransport(createAuthTransport(http))` —— 把 `src/services/consume/auth.ts` 的实现挂上来；
 *  - `createConsumeHttp({ accessToken: getAccessToken, onUnauthorized: handleUnauthorized })`
 *    —— 反过来让消费层每次请求能取到最新的 JWT，并在 401 时回来问「要不要刷新」。
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
import type { ConsumeRefreshDecision, ConsumeUnauthorizedInfo } from '../consume/http.js'
import { registerAccountScopedCaches } from './accountCaches.js'
import { purgeSessionCaches } from './sessionCache.js'
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
  /**
   * 续期（布尔视图，为老调用点保留）：true = 现在又有一颗可用 token；false = 没换成
   * （会话失效**或**网络失败 —— 想知道是哪一种请用导出的 `refreshSessionOnce()` 拿三态）。
   * 走的是**单飞**：并发调用只会发一次 `/auth/refresh`（#740 ②）。
   */
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
 * **安全存储待 #740-②**：接 Keychain / Keystore 要新增原生依赖（`@capacitor/preferences` 的 secure
 * 选项 / 自写插件），维护者还没放行，所以本单（#740 第一步）**不动存储介质** —— 仍然是这个 seam，
 * 默认实现仍是 localStorage。⚠️ 当前暴露面**等价于 API Key**（`chat-demo:api-key` 也是明文
 * localStorage）：WebView 里的 XSS 或本地调试都能读走 30 天有效的 refresh_token，等于长期账号接管。
 * 换存储时只替换这一个对象（`setAuthTokenStorage`），上层 store 与 UI 一行都不用改。
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
  // 新会话开始：代次 +1，正在飞的旧刷新从此不再有资格落地（见 `sessionEpoch`）
  sessionEpoch += 1
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

/**
 * 清态回登录页：落盘一起清（#484 §二「刷新失败就清登录态」）。
 *
 * 一共清三样（#740 ④）：**access + refresh**（同一个落盘键）+ **账号级缓存**
 * （`purgeSessionCaches()`：余额 / 卡密 / 消费记录 / cid … 见 `accountCaches.ts`）。
 * 少了最后一样，A 退出、B 登录之后 B 就会看到 A 的数据 —— 这是「切号串数据」的唯一来源。
 */
const clearSession = (
  next: Extract<AuthState, 'unauthenticated' | 'expired'>,
  error: AuthError | null = null
): void => {
  // 代次 +1：这一代之后的刷新结果一律作废（迟到的刷新不许把刚清掉的凭据写回去）
  sessionEpoch += 1
  tokenStorage.write(null)
  purgeSessionCaches()
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

// --------------------------------------------------------------------------- 续期（单飞）

/**
 * 一次续期的**结局**（#740 ①）：
 *  - `refreshed`：换到了新的一对 token，可以重放；
 *  - `expired`  ：会话真的没了（刷新被 401 拒 / 没有 refresh_token / 传输层没挂）→ 已清态回登录；
 *  - `retryable`：**这次**没换成，但套 token 仍然保留（网络 / 超时 / 5xx / 429）→ 稍后重试有意义。
 *
 * 为什么不折成 boolean：这三种结局对应的界面行为完全不同（重放 / 回登录页 / 提示重试），
 * 而「网络抖动」折成 false 就是把人白踢下线 —— 那是 #484 之后最容易被写回来的一处回归。
 */
export type SessionRefreshOutcome = 'refreshed' | 'expired' | 'retryable'

/**
 * 单飞槽（single-flight，#740 ②）：**同一时刻只允许一次 `/auth/refresh`**。
 *
 * 场景：页面一开就并发 5 个业务请求，token 恰好过期 → 5 个 401 → 若各刷各的，会打 5 次
 * `/auth/refresh`；服务端**轮换 refresh_token** 时，后发的那次会把先发的那对顶掉，表现成
 * 「莫名其妙掉登录」。所以这里让它们**等同一个 promise**，拿到的都是同一份新 token，然后各自重放。
 */
let refreshInFlight: Promise<SessionRefreshOutcome> | null = null

/**
 * 会话代次（#740 ④「退出后不能还能进」）：每次**建立**会话（登录 / 注册）或**清掉**会话都 +1。
 *
 * 为什么单飞还需要它：刷新是一条**在飞**的网络请求，用户完全可能在它回来之前就点了退出
 * （或者在这期间登了另一个号）。没有代次校验的话，迟到的刷新结果会 `writePersisted()` 把
 * 刚清掉的凭据又写回去 —— 表现为「点了退出，重开还是在登录态」，或更糟：A 的 token 盖掉 B 的。
 * 所以刷新**只在自己开始时那一代仍然是当前代**时才落地。
 */
let sessionEpoch = 0

/**
 * 刷新失败的性质判定：**只有「凭据本身不认」才清态**（#740 ①）。
 *
 * 清态判据（任一成立）：HTTP 401、`REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_INVALID` 这类码、
 * 或归一化后的 `kind === 'auth'`（凭据类，含账号被停用）。
 * 其余（网络 / 超时 / 5xx / 429）一律**保留 token**：让用户重试，而不是重登。
 */
const REFRESH_SESSION_CODES = [
  'REFRESH_TOKEN_EXPIRED',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_REVOKED',
  'TOKEN_EXPIRED',
  'TOKEN_REVOKED',
  'UNAUTHORIZED',
  'INVALID_TOKEN',
]

const isRefreshCredentialLost = (error: AuthError): boolean =>
  error.status === 401 || error.kind === 'auth' || REFRESH_SESSION_CODES.includes(error.code)

/**
 * 刷新成功后的落盘（#740 ③「整体覆盖」）。
 *
 * `/auth/refresh` 回的是**完整的一对 token**（可能顺手轮换了 refresh_token），所以这里**整体替换**
 * 本地会话，而不是只改 access_token —— 只改一半的话，一旦后端轮换，本地留着的旧 refresh_token
 * 下一秒就失效，表现同样是「莫名其妙掉登录」。
 *
 * 唯一的例外：这次响应**没带** refresh_token 时才沿用旧的。把「没回」当成「作废」会把人误踢下线
 * （实测会轮换，但「没回」与「作废」是两件事）。
 */
const applyRefreshedToken = (fresh: AccessToken, previousRefreshToken: string): void => {
  const next: AccessToken = { ...fresh, refreshToken: fresh.refreshToken ?? previousRefreshToken }
  writePersisted(next, useAuthStore.getState().user)
  useAuthStore.setState({ state: 'authenticated', token: next, error: null, submitting: false })
}

/** 真发一次刷新（**只从 `refreshSessionOnce` 进**，否则单飞就漏了） */
const performRefresh = async (): Promise<SessionRefreshOutcome> => {
  const startedAtEpoch = sessionEpoch
  const current = useAuthStore.getState().token
  const refreshToken = current?.refreshToken
  if (!transport || !refreshToken) {
    // 没有 refresh_token（老数据 / 传输层没挂）：会话无法续，只能回登录页
    clearSession('expired')
    return 'expired'
  }
  let result: AuthResult<AccessToken>
  try {
    result = await transport.refreshToken({ refreshToken })
  } catch (thrown) {
    // 传输层违约（抛异常）≠ 会话失效：**保留 token**，把「稍后重试」交给界面
    useAuthStore.setState({ error: unexpected(thrown) })
    return 'retryable'
  }
  if (!result.ok) {
    if (isRefreshCredentialLost(result.error)) {
      clearSession('expired', result.error)
      return 'expired'
    }
    // 网络 / 5xx / 429：保留 token（**不清态**），只把错误挂到快照上给界面提示重试
    useAuthStore.setState({ error: result.error })
    return 'retryable'
  }
  if (startedAtEpoch !== sessionEpoch) {
    // 刷新期间会话被清掉（用户退出）或被换掉（登了另一个号）：**结果作废**，不许写回本地。
    // 按「会话已经没了」返回 —— 调用方不需要重放，也不需要再清一次（`clearSession` 已经清过了）。
    return 'expired'
  }
  applyRefreshedToken(result.data, refreshToken)
  return 'refreshed'
}

/**
 * 续期入口（单飞）：并发调用共用同一个 promise，**只发一次** `/auth/refresh`。
 * 结束后立刻放槽（`finally`），下一次真 401 会重新发起 —— 但同一个请求不会因为「重放后仍 401」
 * 再进来一次（那次重放不再问钩子，见 `consume/http.ts` 的 `request()`）。
 */
export const refreshSessionOnce = (): Promise<SessionRefreshOutcome> => {
  if (refreshInFlight !== null) {
    return refreshInFlight
  }
  refreshInFlight = performRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

/**
 * 「续期成功了吗」的布尔视图：给 `AuthStore.refreshSession` 与启动恢复用（老调用点不用改）。
 * 新代码想知道「为什么没成」请用 `refreshSessionOnce()` 拿三态。
 */
const refreshSession = async (): Promise<boolean> => (await refreshSessionOnce()) === 'refreshed'

/**
 * 消费层 401 钩子（#740 ①②）：`createConsumeHttp({ onUnauthorized: handleUnauthorized })`。
 *
 * 这是**唯一**把「业务请求 401」翻译成「刷新 / 放弃」的地方：`http.ts` 只管状态码与重放，
 * 策略（什么时候清态、什么错误保留 token）全在这里。参数只含路由与动作，**不进日志、不进埋点**。
 */
export const handleUnauthorized = async (info: ConsumeUnauthorizedInfo): Promise<ConsumeRefreshDecision> => {
  // 刻意**不**记录 path / method：这条路径每次 token 过期都会走，写进诊断日志只是噪音，
  // 而且 #387 的红线是「凭据类与可识别信息不进日志」—— 一个「哪个接口 401 了」的埋点很容易
  // 顺手把 header 一起带进去。只回答「换没换成」。
  void info
  const outcome = await refreshSessionOnce()
  if (outcome === 'refreshed') {
    return 'retry'
  }
  return outcome === 'expired' ? 'expired' : 'retryable'
}

/**
 * 退出登录：先尽力让服务端把该账号的会话全部作废（`revoke-all-sessions`），**再**清本地。
 * 顺序不能反 —— 反了就没有 JWT 可发了，服务端会话会留在那儿。
 *
 * 端点说明（#740 ④ 写的是 `POST /api/v1/auth/logout`）：客户端**刻意**调
 * `POST /api/v1/auth/revoke-all-sessions`，理由与实测见 `docs/consume-676-contract-audit.md` §D-676-2
 * —— staging 上 `/auth/logout` 是 **502**，`revoke-all-sessions` 回 200；换成契约里那条只会把
 * 「能跑 + 会如实报未确认」换成 502。语义上它就是「退出（这台设备之外的会话也一并作废）」。
 *
 * 本地清三样（#740 ④）：access + refresh（`clearSession` 的落盘清空）+ **账号级缓存**
 * （同一处调 `purgeSessionCaches()`）—— 少了最后一样，B 登录就会看到 A 的余额 / 卡密 / 消费记录。
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
 * 启动恢复：读盘 → 需要就续期 → `me()` 校验一次。**不强制登录**（#740 §五 第 1 条）：
 * 盘上有 refresh_token 就静默续，续不上再按下面的规则「清态 / 保留」。
 *
 * 四处刻意的取舍：
 *  - **传输层没挂上时保留本地会话**（`state:'authenticated'`）：W1-A 合并前不能把人无端登出；
 *  - 续期只在**快过期**时做（`needsRefresh`），不是每次启动都换 —— 多一次网络往返换不来什么，
 *    而「401 再刷」已经由 `handleUnauthorized` 兜住了；
 *  - 续期失败分两种（#740 ①）：凭据不认 → 清态回登录；网络 / 5xx → **保留会话**、不打 `me()`；
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
    if (needsRefresh(persisted.token)) {
      const outcome = await refreshSessionOnce()
      if (outcome === 'expired') {
        // `performRefresh` 内部已经清态回登录（expired），这里不用再补动作
        return
      }
      if (outcome === 'retryable') {
        // 网络 / 超时 / 5xx：**保留本地会话**（#740 ①⑤）—— 一次离线不该把人登出。
        // 也不打 `me()`：token 已经过期，这时候打它只会再拿一个 401 回来，把人误判成「凭据失效」。
        // 真过期的话，下一条业务请求自己会 401 → `handleUnauthorized` → 再刷一次（那时可能就有网了）。
        useAuthStore.setState({ state: 'authenticated', restored: true })
        return
      }
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

/**
 * 账号级缓存清单登记（#740 ④）：放在**模块初始化**而不是 `main.tsx`，是因为
 * 「少一行接线 = 切号串数据」，而这条链上任何入口（界面 / 单测 / 传输层）只要 import 到 store，
 * 清态时就一定能把业务缓存一起清掉（清单内容见 `accountCaches.ts`，幂等）。
 */
registerAccountScopedCaches()

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

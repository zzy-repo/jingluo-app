/**
 * 身份层传输接口 —— **只有签名，没有实现**（W1-B 前半，Issue #487；端点依据 #484 §3.1 / §3.1b / §3.1c）。
 *
 * 为什么只定接口：HTTP 传输层归 W1-A（`src/services/consume/**`，含 `consume/auth.ts` 与 `consume/http.ts`），
 * 本单只做「不依赖真实 HTTP 的部分」—— 身份状态机 + 登录/注册 UI。两边并行，靠这份接口对齐：
 *
 *   本文件（W1-B）              →  W1-A 的 `src/services/consume/auth.ts`
 *   ─────────────────────────────────────────────────────────────────────────────
 *   login(input)                →  `login(http, {email, password})`
 *   register(input)             →  `register(http, {email, password, verifyCode?, invitationCode?})`
 *   sendCode(input)             →  `sendVerifyCode(http, {email})`
 *   refresh(input)              →  `refresh(http, {refreshToken})`
 *   refreshToken(input)         →  同上，窄口（只要 token 对，不要 user）
 *   me()                        →  `getProfile(http)`（#676 §二：**没有** `/auth/me` 这条路）
 *   logout()                    →  `revokeAllSessions(http)`（+ 本地清态，见 store.ts）
 *
 * **已接线**（W1-A PR #494 的 `createConsumeClient`）：本文件末尾的 `createAuthTransport(consume)`
 * 就是唯一实现 —— 它只做三件事，**没有任何 HTTP 代码**：
 *  1. 调 `consume.auth.*` / `consume.settings.get()`；
 *  2. 把 `ConsumeCallResult<T>` 解包成 `AuthResult<T>`（`expires_in` 秒 → `expiresAt` 毫秒）；
 *  3. 把 `Sub2ApiError.i18nKey`（`consumeErr*`，词条由 W1-C 补）映射成**现在就能上屏的 key**
 *     （`sub2auth*` / `inviteCode*`）：网络/超时 → `sub2authNetworkError`，凭据类 →
 *     `sub2authCredentialInvalid`，邮箱验证码 → `sub2authCodeInvalid`，邀请码 → `inviteCodeInvalid`，
 *     其余 → `sub2authLoginFailed`。
 * **不要**在 UI 里碰 `Sub2ApiError`，界面只认 `AuthError.messageKey`。
 *
 * 硬约束（照抄 #484 §二，别在实现里放宽）：
 *  - JWT 只进 `Authorization` 头，**不放 query、不靠 cookie**（实测 CORS 回包没有 `Allow-Credentials`，
 *    cookie 方案在本客户端的原生 WebView 里根本不可用）；
 *  - 刷新失败**不静默重试**（`refresh` 只回错误，清态回登录是 `store.ts` 的策略）；
 *  - 本层不落盘、不日志、不碰 DOM —— token 存哪儿是 `store.ts` 的事。
 *
 * 端点（白名单原文，实现时只许出现这些字面量，`check:consume-api` 会扫）：
 *   POST /api/v1/auth/login            `{email, password}` → `{access_token, refresh_token?, expires_in, token_type, user}`
 *   POST /api/v1/auth/register         `{email, password, verify_code?, invitation_code?}` → 同 login
 *   POST /api/v1/auth/send-verify-code `{email}` → 无返回体
 *   POST /api/v1/auth/refresh          `{refresh_token}` → `{access_token, refresh_token, expires_in, token_type}`（**无 user**）
 *   GET  /api/v1/user/profile          JWT → 用户对象 + `identities.email`
 *                                      （「当前用户」**只走这条**：#676 §二 明写 `/auth/me` 不存在）
 *   POST /api/v1/auth/revoke-all-sessions JWT → 退出所有设备
 *
 * 实测补充（2026-11-20，本地实例 0.2.22）：登录成功体是**面板信封** `{code:0,message:"success",data:{…}}`；
 * 失败体是 `{code:401,message:"…",reason:"REFRESH_TOKEN_INVALID"}`。字段名与下文类型一致，无差异。
 * 另有两条**白名单里没有**、本层刻意不做的能力（别顺手加）：`login/2fa`、`forgot/reset-password`。
 */

import type { TranslationKey } from '../../i18n/index.js'
import type { ConsumeMessageKey, Sub2ApiError } from '../consume/errors.js'
import type { ConsumeCallResult } from '../consume/http.js'
import type {
  ConsumeAuthSession,
  ConsumePublicSettings,
  ConsumeUser,
  createConsumeClient,
} from '../consume/index.js'
import type { AccessToken, AuthDone, AuthError, AuthResult, AuthSession, AuthUser } from './types.js'

/** 登录入参：只有邮箱 + 密码（2FA 属于后半，白名单端点 `/auth/login/2fa` 暂不接） */
export type AuthLoginInput = {
  email: string
  password: string
}

/**
 * 注册入参。
 *
 * 两条服务端开关决定这两个可选字段出不出现（都由 `flags.ts` 读 `settings/public` 决定，本地不写死）：
 *  - `verifyCode`：`email_verify_enabled`（且用户点了「发送验证码」）
 *  - `invitationCode`：`invitation_code_enabled`
 * **邀请关系只能在注册时一次填定**（#484 §3.1b：sub2api 没有「登录后补填邀请码」的端点）。
 */
export type AuthRegisterInput = {
  email: string
  password: string
  verifyCode?: string
  invitationCode?: string
}

/** 发邮箱验证码（注册用，无鉴权，服务端 5/min） */
export type AuthSendCodeInput = {
  email: string
}

/** 刷新入参：服务端的字段名就是 `refresh_token`，转换在传输层做 */
export type AuthRefreshInput = {
  refreshToken: string
}

/** `refresh` 的回包：实测**没有 `user`**，所以类型里也不给 —— 要用户对象走 `me()` */
export type AuthTokenPair = {
  token: AccessToken
}

/**
 * 身份层传输接口。**7 个方法，覆盖本单用到的全部白名单端点**。
 *
 * 实现方（W1-A）只需保证：方法不抛异常（失败一律走 `AuthResult` 的 `ok:false`），
 * 且 `AuthError.messageKey` 是已合并的 i18n key。
 */
export interface AuthTransport {
  /** `POST /api/v1/auth/login`：邮箱 + 密码 → 会话（token + user） */
  login: (input: AuthLoginInput) => Promise<AuthResult<AuthSession>>
  /** `POST /api/v1/auth/register`：注册即登录（成功体与 login 同形） */
  register: (input: AuthRegisterInput) => Promise<AuthResult<AuthSession>>
  /** `POST /api/v1/auth/send-verify-code`：发注册验证码；冷却秒数由调用方按服务端限流展示 */
  sendCode: (input: AuthSendCodeInput) => Promise<AuthResult<AuthDone>>
  /** `POST /api/v1/auth/refresh`：完整回包（token 对 + 有效期），store 的续期走这个 */
  refresh: (input: AuthRefreshInput) => Promise<AuthResult<AuthTokenPair>>
  /**
   * `POST /api/v1/auth/refresh` 的窄口：只要新 token 对。
   * 与 `refresh` 打的是同一个白名单端点，实现可以直接复用 —— 分开是为了让「续期」这条路径
   * 不顺手带上 user 解析（实测回包本来也没有 user，多解析一次只会多一处失败点）。
   */
  refreshToken: (input: AuthRefreshInput) => Promise<AuthResult<AccessToken>>
  /** `GET /api/v1/user/profile`：当前用户（启动恢复时用它校验 token 还活着） */
  me: () => Promise<AuthResult<AuthUser>>
  /**
   * 退出：`POST /api/v1/auth/revoke-all-sessions`（服务端把该账号所有设备的会话作废）。
   * **本地清态由 `store.ts` 负责**，本方法失败也不该拦住用户退出 —— 所以调用方对它只做尽力而为。
   */
  logout: () => Promise<AuthResult<AuthDone>>
}

// --------------------------------------------------------------------------- 实现（接 W1-A 的消费层）

/**
 * W1-A 的消费层客户端（`src/services/consume/index.ts` 的 `createConsumeClient(...)`）。
 * 用 `ReturnType` 取形状，而不是把十几个导出名抄一遍 —— 那边加个方法，这里不用改。
 */
type ConsumeClient = ReturnType<typeof createConsumeClient>

/**
 * `Sub2ApiError.i18nKey`（`consumeErr*`）→ 现在就能上屏的 key。
 *
 * 为什么需要这张表：`consumeErr*` 由 W1-C 补词条，本单合并时它们还不在 `src/i18n/zh.ts` 里；
 * 而界面这一轮就要能显示错误。所以这里做一次**临时映射**，取值只从已合并的 `sub2auth*` /
 * `inviteCode*` 里挑。
 *
 * TODO(W1-C)：`consumeErr*` 落地后，把这张表换成「同名 key 直传」（`messageKeyFor` 保留只是为了
 * 兼容 inviteCode / emailVerify 这两个语义更细的分支）。
 */
const AUTH_MESSAGE_KEY: Partial<Record<ConsumeMessageKey, TranslationKey>> = {
  consumeErrNetwork: 'sub2authNetworkError',
  consumeErrTimeout: 'sub2authNetworkError',
  consumeErrUnsupported: 'sub2authNetworkError',
  consumeErrUnauthorized: 'sub2authCredentialInvalid',
  consumeErrForbidden: 'sub2authCredentialInvalid',
  consumeErrAccountDisabled: 'sub2authLoginFailed',
  consumeErrRateLimited: 'sub2authLoginFailed',
  consumeErrBadRequest: 'sub2authLoginFailed',
  consumeErrInvalidResponse: 'sub2authLoginFailed',
  consumeErrServerUnavailable: 'sub2authLoginFailed',
  consumeErrNotFound: 'sub2authLoginFailed',
  consumeErrNotEnabled: 'sub2authLoginFailed',
  consumeErrInvitationInvalid: 'inviteCodeInvalid',
  consumeErrEmailCodeInvalid: 'sub2authCodeInvalid',
  consumeErrUnknown: 'sub2authLoginFailed',
}

/** 服务端码比 i18n key 更细的两处特例：邀请码无效、邮箱还没验证 */
const messageKeyFor = (error: Sub2ApiError): TranslationKey => {
  if (error.code === 'INVITATION_CODE_INVALID' || error.reason === 'INVITATION_CODE_INVALID') {
    return 'inviteCodeInvalid'
  }
  if (error.code === 'EMAIL_NOT_VERIFIED' || error.code === 'EMAIL_VERIFY_REQUIRED') {
    return 'sub2authEmailVerifyRequired'
  }
  return AUTH_MESSAGE_KEY[error.i18nKey] ?? 'sub2authLoginFailed'
}

/**
 * `Sub2ApiError` → `AuthError`。
 *
 * 只搬字段，不改判定：`kind` 原样保留（所以 `auth` 一律意味着「JWT 不认」→ 清态回登录），
 * `retryable` 也只表达「重试有意义」，真正要不要重试由调用点决定（#484 §二 不许静默重试）。
 */
const toAuthError = (error: Sub2ApiError): AuthError => ({
  kind: error.kind,
  code: error.code,
  message: error.message,
  status: error.status,
  retryable: error.retryable,
  messageKey: messageKeyFor(error),
})

/** `expires_in`（**秒**）→ 绝对到期时刻；没给就 null（不主动预刷新，只在 401 后按过期处理） */
export const toExpiresAt = (expiresInSeconds: number | undefined): number | null =>
  typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? Date.now() + expiresInSeconds * 1000
    : null

/** 服务端会话 → 本层的 token（`expires_in` 在这里换成绝对时间，别把「相对秒数」带到存储层） */
const toAccessToken = (session: ConsumeAuthSession): AccessToken => ({
  accessToken: session.accessToken,
  refreshToken: session.refreshToken,
  tokenType: session.tokenType || 'Bearer',
  expiresAt: toExpiresAt(session.expiresIn),
})

/**
 * 服务端用户 → `AuthUser`。
 *
 * `emailVerified` 只在服务端给了 `emailBound` / `identities.email.bound` 时才有值，否则 `null`
 * ——「不知道」不能用 `false` 冒充（会让 UI 报「需要先验证邮箱」）。
 */
const toAuthUser = (user: ConsumeUser): AuthUser => {
  const bound = user.emailBound ?? user.identities?.email?.bound
  return {
    id: user.id,
    email: user.email,
    username: user.username === '' ? undefined : user.username,
    role: user.role,
    emailVerified: typeof bound === 'boolean' ? bound : null,
    // `ConsumeUser` 目前没投影 `created_at`（W1-A 只挑界面要用的字段）：有就带，没有就不带，
    // 别为了一个展示字段去改消费层的类型（TODO：W1-C 需要注册时间时由 W1-A 补投影）
    createdAt: (user as { createdAt?: string }).createdAt,
  }
}

/** 解包 + 映射：`ok:true` 只搬 `data`，`ok:false` 只搬归一后的错误（`status` / `raw` 留给排查日志） */
const unwrap = <T, U>(result: ConsumeCallResult<T>, map: (data: T) => U): AuthResult<U> =>
  result.ok ? { ok: true, data: map(result.data) } : { ok: false, error: toAuthError(result.error) }

/**
 * 把消费层客户端包成身份层传输实现 —— **`src/main.tsx` 一行接线的地方**：
 *
 * ```ts
 * const consume = createConsumeClient({ accessToken: getAccessToken, apiKey: getApiKey })
 * setAuthTransport(createAuthTransport(consume))
 * setPublicSettingsReader(async () => (await consume.settings.get()).ok ? … : null)
 * ```
 *
 * 注意 `accessToken` 提供者传的是 `store.ts` 的 `getAccessToken`：每次请求现取，续期之后立刻生效。
 */
export const createAuthTransport = (consume: ConsumeClient): AuthTransport => ({
  login: async (input) => unwrap(await consume.auth.login(input), (session) => ({
    token: toAccessToken(session),
    user: toAuthUser(session.user),
  })),
  register: async (input) => unwrap(await consume.auth.register(input), (session) => ({
    token: toAccessToken(session),
    user: toAuthUser(session.user),
  })),
  sendCode: async (input) => unwrap(await consume.auth.sendVerifyCode({ email: input.email }), () => undefined),
  refresh: async (input) => unwrap(await consume.auth.refresh(input), (session) => ({ token: toAccessToken(session) })),
  refreshToken: async (input) => unwrap(await consume.auth.refresh(input), toAccessToken),
  // 「当前用户」= `/api/v1/user/profile`（#676 §二：契约里没有 `/auth/me`，`consume.auth.me` 已删）
  me: async () => unwrap(await consume.auth.profile(), toAuthUser),
  logout: async () => unwrap(await consume.auth.revokeAllSessions(), () => undefined),
})

/** `settings/public` 的读取口子（`flags.ts` 的 `PublicSettingsReader` 形状）：失败给 null = 保守默认 */
export const createPublicSettingsReader = (consume: ConsumeClient) => async (): Promise<ConsumePublicSettings | null> => {
  const result = await consume.settings.get()
  return result.ok ? result.data : null
}

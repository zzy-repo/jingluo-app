/**
 * 账号与身份（JWT 通道，`/api/v1/**`）—— Issue #484 §3.1 / §3.1b / §3.1c，W1-A。
 *
 * 覆盖的端点（**只能用这些**，白名单外一律不许调，`pnpm check:consume-api` 会拦）：
 *
 *   GET  /api/v1/settings/public            启动时读功能开关（注册/邮箱验证/邀请码/验证码）
 *   POST /api/v1/auth/register              注册（可带 verify_code / invitation_code / aff_code）
 *   POST /api/v1/auth/login                 登录
 *   POST /api/v1/auth/login/2fa             两步验证
 *   POST /api/v1/auth/send-verify-code      发邮箱验证码（注册用，5/min）
 *   POST /api/v1/auth/refresh               刷新 token（30/min）
 *   POST /api/v1/auth/forgot-password       忘记密码
 *   POST /api/v1/auth/reset-password        重置密码
 *   GET  /api/v1/auth/me                    当前用户
 *   POST /api/v1/auth/revoke-all-sessions   退出所有设备
 *   GET  /api/v1/user/profile               账号资料 / 邮箱绑定 / 余额（元）
 *
 * 两条硬约束：
 *  1. JWT **只进 header**（`Authorization: Bearer <access_token>`，cookie 无效）；本层不落盘、不日志 ——
 *     存哪儿由 W1-B 决定（与 Key 同一安全等级，**不许**明文进 IndexedDB）。
 *  2. `refresh` 失败就清登录态回登录页，**不许静默重试**（#484 §二）。本层只回错误，
 *     是否重试 / 何时清态是 W1-B 的调用策略；`isSessionError()` 就是给那个判断用的。
 *
 * 语义变化（#484 §3.1b「UI 要跟着改」）：
 *  - 邀请关系只能在**注册时一次填定**（sub2api 没有「登录后补填邀请码」）；
 *  - 返利按比例结算（比例由服务端下发），旧文案 `circular_invite` / `already_redeemed` 全部不再适用。
 */

import type { ConsumeCallResult, ConsumeEmpty, ConsumeHttp } from './http.js'

/**
 * sub2api 的用户对象（金额单位一律 **元**：1 元 = 1 额度，后端 8b12ab2 明确，无 USD 概念）。
 *
 * 字段来自**本地联调实例的真实 200**（`GET /api/v1/auth/me`、`GET /api/v1/user/profile`，实例 0.2.20）：
 * `{id,email,username,role,balance,frozen_balance,concurrency,status,allowed_groups,last_active_at,
 *   created_at,updated_at,balance_notify_*,total_recharged,rpm_limit,identities:{provider:{...}}}`
 * `/user/profile` 比 `/auth/me` 多一层身份绑定明细（`identities`），两者都能喂这个类型。
 */
export type ConsumeUser = {
  id: number
  email: string
  username?: string
  role?: string
  /** 余额，单位元（float，1 元 = 1 额度）。**禁止**在客户端缓存 / 推导额度（#484 §4.5 第 10 条） */
  balance?: number
  frozenBalance?: number
  concurrency?: number
  status?: string
  /** 允许的分组（`null` = 不限） */
  allowedGroups?: number[] | null
  /** 每分钟请求上限（0 = 不限） */
  rpmLimit?: number
  totalRecharged?: number
  lastActiveAt?: string
  /**
   * 身份绑定明细（`email` / `github` / `linuxdo` …）：邮箱入口显隐与「能不能解绑」都看它
   * （每个 provider 用 `bound` / `can_bind` / `can_unbind` 自述，客户端不要自己推）。
   */
  identities?: Record<string, ConsumeIdentity>
  /** 账户邮箱是否已绑定（`identities.email.bound` 的便捷投影） */
  emailBound?: boolean
}

/** 一个身份绑定项（字段名保持服务端原样，界面只读不写） */
export type ConsumeIdentity = {
  provider: string
  bound: boolean
  boundCount?: number
  displayName?: string
  canBind?: boolean
  canUnbind?: boolean
}

/**
 * 登录 / 注册 / 刷新的成功体。**本地实例实测**（`POST /api/v1/auth/login` 200）：
 * `{access_token, refresh_token, expires_in: 86400, token_type: "Bearer", user:{...}}`，
 * 套在 `{code:0,message:"success",data:...}` 面板信封里。
 * 注册与刷新的成功体未实测（形状按同一 `AuthResponse` 处理；本地实例允许注册，但为验字段建账号没必要）。
 */
export type ConsumeAuthSession = {
  accessToken: string
  refreshToken?: string
  /** 有效期（秒）；到期前用 `refresh` 续，过期后不静默重试 */
  expiresIn?: number
  tokenType: string
  user: ConsumeUser
}
/**
 * `GET /api/v1/settings/public`：客户端所有「入口是否显示」的**唯一**来源（本地不维护第二份开关）。
 *
 * 实测（实例 0.2.22）这个响应有 **74 个字段**，这里只挑「界面要不要显示某个入口」需要的那批；
 * 需要更多字段时读 `result.raw.json.data`（原始体一直留着），不要往这个类型里顺手加。
 * 硬规则（#484 §3.1d / §七 第 7 条）：路由存在 ≠ 功能开启 —— 例如实测 `registration_enabled=false`、
 * `payment_enabled=false`、`affiliate_enabled=false`、`model_plaza_enabled=false`，这些入口就必须整块不显示。
 */
export type ConsumePublicSettings = {
  registrationEnabled: boolean
  emailVerifyEnabled: boolean
  invitationCodeEnabled: boolean
  turnstileEnabled: boolean
  turnstileSiteKey?: string
  tencentCaptchaEnabled: boolean
  siteName?: string
  apiBaseUrl?: string
  /** 服务端版本（实测 `data.version`，例如 `0.2.22`）：排查「字段为什么对不上」的第一手线索 */
  version?: string
  passwordResetEnabled: boolean
  promoCodeEnabled: boolean
  totpEnabled: boolean
  paymentEnabled: boolean
  affiliateEnabled: boolean
  subscriptionEnabled: boolean
  modelPlazaEnabled: boolean
  mcpEnabled: boolean
  availableChannelsEnabled: boolean
  forceEmailOnThirdPartySignup: boolean
  loginAgreementEnabled: boolean
  channelMonitorEnabled: boolean
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const bool = (value: unknown): boolean => value === true
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** 服务端 `User` → `ConsumeUser`（snake_case 的只在出入口转换一次） */
export const toConsumeUser = (value: unknown): ConsumeUser => {
  const user = asRecord(value)
  const out: ConsumeUser = { id: num(user.id) ?? 0, email: str(user.email) }
  if (typeof user.username === 'string') {
    out.username = user.username
  }
  if (typeof user.role === 'string') {
    out.role = user.role
  }
  const balance = num(user.balance)
  if (balance !== undefined) {
    out.balance = balance
  }
  const frozen = num(user.frozen_balance)
  if (frozen !== undefined) {
    out.frozenBalance = frozen
  }
  const concurrency = num(user.concurrency)
  if (concurrency !== undefined) {
    out.concurrency = concurrency
  }
  if (typeof user.status === 'string') {
    out.status = user.status
  }
  // 实测 `allowed_groups: null`（= 不限）—— 只有数组才当白名单
  if (Array.isArray(user.allowed_groups)) {
    out.allowedGroups = user.allowed_groups.filter((item) => typeof item === 'number')
  } else if (user.allowed_groups === null) {
    out.allowedGroups = null
  }
  const rpm = num(user.rpm_limit)
  if (rpm !== undefined) {
    out.rpmLimit = rpm
  }
  const recharged = num(user.total_recharged)
  if (recharged !== undefined) {
    out.totalRecharged = recharged
  }
  if (typeof user.last_active_at === 'string') {
    out.lastActiveAt = user.last_active_at
  }
  const identities = toIdentities(user.identities)
  if (identities) {
    out.identities = identities
    out.emailBound = identities.email?.bound === true
  }
  return out
}

/** `identities` 映射：`{email:{provider,bound,bound_count,display_name,can_bind,can_unbind}}` */
const toIdentities = (value: unknown): Record<string, ConsumeIdentity> | undefined => {
  const record = asRecord(value)
  const keys = Object.keys(record)
  if (keys.length === 0) {
    return undefined
  }
  const out: Record<string, ConsumeIdentity> = {}
  for (const key of keys) {
    const item = asRecord(record[key])
    const identity: ConsumeIdentity = { provider: str(item.provider) || key, bound: item.bound === true }
    const boundCount = num(item.bound_count)
    if (boundCount !== undefined) {
      identity.boundCount = boundCount
    }
    if (typeof item.display_name === 'string') {
      identity.displayName = item.display_name
    }
    if (typeof item.can_bind === 'boolean') {
      identity.canBind = item.can_bind
    }
    if (typeof item.can_unbind === 'boolean') {
      identity.canUnbind = item.can_unbind
    }
    out[key] = identity
  }
  return out
}
/** `AuthResponse` → `ConsumeAuthSession`（缺 `access_token` 视为响应异常，由调用方按 ok:false 处理） */
export const toAuthSession = (value: unknown): ConsumeAuthSession => {
  const body = asRecord(value)
  const session: ConsumeAuthSession = {
    accessToken: str(body.access_token),
    tokenType: str(body.token_type) || 'Bearer',
    user: toConsumeUser(body.user),
  }
  if (typeof body.refresh_token === 'string' && body.refresh_token !== '') {session.refreshToken = body.refresh_token}
  const expiresIn = num(body.expires_in)
  if (expiresIn !== undefined) {session.expiresIn = expiresIn}
  return session
}

/** 注册入参（`verify_code` / `invitation_code` / `aff_code` 是可选的三条独立通道） */
export type ConsumeRegisterInput = {
  email: string
  password: string
  /** 邮箱验证码：`settings.public.email_verify_enabled` 为 true 时必填 */
  verifyCode?: string
  /** 邀请码：**只在注册时**能被服务端接受（#484 §3.1b） */
  invitationCode?: string
  /** 返利码（与 invitation_code 二选一，服务端自己判断） */
  affCode?: string
  promoCode?: string
  /** Turnstile / 腾讯验证码：由 `settings.public` 的开关决定是否需要 */
  turnstileToken?: string
  tencentCaptchaTicket?: string
  tencentCaptchaRandstr?: string
}

/** 登录入参（`captcha` 是服务端可选的图形/人机校验票据） */
export type ConsumeLoginInput = { email: string; password: string; captcha?: string }

/** 2FA 入参：`ticket` 来自 `POST /auth/login` 的 pending 响应（字段名以服务端为准，这里全量透传） */
export type ConsumeTwoFactorInput = { ticket: string; code: string }

/** 读功能开关：启动时取一次，决定注册 / 验证码 / 邀请码入口是否显示 */
export const getPublicSettings = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumePublicSettings>> =>
  http
    .call<Record<string, unknown>>({ method: 'GET', path: '/api/v1/settings/public', timeout: 'read', auth: null })
    .then((result) => {
      if (!result.ok) {return result}
      const raw = asRecord(result.data)
      const settings: ConsumePublicSettings = {
        registrationEnabled: bool(raw.registration_enabled),
        emailVerifyEnabled: bool(raw.email_verify_enabled),
        invitationCodeEnabled: bool(raw.invitation_code_enabled),
        turnstileEnabled: bool(raw.turnstile_enabled),
        tencentCaptchaEnabled: bool(raw.tencent_captcha_enabled),
        passwordResetEnabled: bool(raw.password_reset_enabled),
        promoCodeEnabled: bool(raw.promo_code_enabled),
        totpEnabled: bool(raw.totp_enabled),
        paymentEnabled: bool(raw.payment_enabled),
        affiliateEnabled: bool(raw.affiliate_enabled),
        subscriptionEnabled: bool(raw.subscription_enabled),
        modelPlazaEnabled: bool(raw.model_plaza_enabled),
        mcpEnabled: bool(raw.mcp_enabled),
        availableChannelsEnabled: bool(raw.available_channels_enabled),
        forceEmailOnThirdPartySignup: bool(raw.force_email_on_third_party_signup),
        loginAgreementEnabled: bool(raw.login_agreement_enabled),
        channelMonitorEnabled: bool(raw.channel_monitor_enabled),
      }
      const optional: [keyof ConsumePublicSettings, unknown][] = [
        ['turnstileSiteKey', raw.turnstile_site_key],
        ['siteName', raw.site_name],
        ['apiBaseUrl', raw.api_base_url],
        ['version', raw.version],
      ]
      for (const [field, value] of optional) {
        if (typeof value === 'string' && value !== '') {
          ;(settings as Record<string, unknown>)[field] = value
        }
      }
      return { ...result, data: settings }
    })

/** 注册（**不可重试**：没有幂等键，重发只会得到「邮箱已存在」，#484 §4.3） */
export const register = (http: ConsumeHttp, input: ConsumeRegisterInput): Promise<ConsumeCallResult<ConsumeAuthSession>> =>
  http
    .call<unknown>({ method: 'POST', path: '/api/v1/auth/register', body: toRegisterBody(input), timeout: 'write', auth: null })
    .then((result) => (result.ok ? { ...result, data: toAuthSession(result.data) } : result))

const toRegisterBody = (input: ConsumeRegisterInput): Record<string, unknown> => {
  const body: Record<string, unknown> = { email: input.email, password: input.password }
  if (input.verifyCode) {body.verify_code = input.verifyCode}
  if (input.invitationCode) {body.invitation_code = input.invitationCode}
  if (input.affCode) {body.aff_code = input.affCode}
  if (input.promoCode) {body.promo_code = input.promoCode}
  if (input.turnstileToken) {body.turnstile_token = input.turnstileToken}
  if (input.tencentCaptchaTicket) {body.tencent_captcha_ticket = input.tencentCaptchaTicket}
  if (input.tencentCaptchaRandstr) {body.tencent_captcha_randstr = input.tencentCaptchaRandstr}
  return body
}

/** 登录（业务失败 401/403 **绝不重试**，否则触发 `INVALID_AUTH_RATE_LIMITED`） */
export const login = (http: ConsumeHttp, input: ConsumeLoginInput): Promise<ConsumeCallResult<ConsumeAuthSession>> =>
  http
    .call<unknown>({
      method: 'POST',
      path: '/api/v1/auth/login',
      body: input.captcha ? { email: input.email, password: input.password, captcha: input.captcha } : { email: input.email, password: input.password },
      timeout: 'write',
      auth: null,
    })
    .then((result) => (result.ok ? { ...result, data: toAuthSession(result.data) } : result))

/** 两步验证（同登录：业务失败不重试） */
export const loginWithTwoFactor = (
  http: ConsumeHttp,
  input: ConsumeTwoFactorInput
): Promise<ConsumeCallResult<ConsumeAuthSession>> =>
  http
    .call<unknown>({ method: 'POST', path: '/api/v1/auth/login/2fa', body: { ...input }, timeout: 'write', auth: null })
    .then((result) => (result.ok ? { ...result, data: toAuthSession(result.data) } : result))

/** 发注册验证码（服务端限流 5/min：429 时按 `Retry-After` 倒计时，**不要**自己另算间隔） */
export const sendVerifyCode = (http: ConsumeHttp, input: { email: string; captcha?: string }): Promise<ConsumeCallResult<ConsumeEmpty>> =>
  http.call<ConsumeEmpty>({ method: 'POST', path: '/api/v1/auth/send-verify-code', body: { ...input }, timeout: 'write', auth: null })

/** 刷新 token（30/min）：刷新失败必须清登录态回登录页，不许静默重试 */
export const refresh = (http: ConsumeHttp, input: { refreshToken: string }): Promise<ConsumeCallResult<ConsumeAuthSession>> =>
  http
    .call<unknown>({
      method: 'POST',
      path: '/api/v1/auth/refresh',
      body: { refresh_token: input.refreshToken },
      timeout: 'write',
      // refresh 是公共接口：**不带** Authorization（带旧 token 只会让人误以为它参与鉴权）
      auth: null,
    })
    .then((result) => (result.ok ? { ...result, data: toAuthSession(result.data) } : result))

/** 忘记密码（发重置邮件 / 验证码，5/min） */
export const forgotPassword = (http: ConsumeHttp, input: { email: string }): Promise<ConsumeCallResult<ConsumeEmpty>> =>
  http.call<ConsumeEmpty>({ method: 'POST', path: '/api/v1/auth/forgot-password', body: { ...input }, timeout: 'write', auth: null })

/** 重置密码（10/min）：`token` 与 `code` 两种形态由服务端版本决定，原样透传 */
export const resetPassword = (
  http: ConsumeHttp,
  input: { password: string; token?: string; code?: string }
): Promise<ConsumeCallResult<ConsumeEmpty>> => {
  const body: Record<string, unknown> = { password: input.password }
  if (input.token) {body.token = input.token}
  if (input.code) {body.code = input.code}
  return http.call<ConsumeEmpty>({ method: 'POST', path: '/api/v1/auth/reset-password', body, timeout: 'write', auth: null })
}

/** 当前用户（JWT） */
export const me = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeUser>> =>
  http
    .call<unknown>({ method: 'GET', path: '/api/v1/auth/me', timeout: 'read' })
    .then((result) => (result.ok ? { ...result, data: toConsumeUser(result.data) } : result))

/** 账号资料：余额（元）/ 邮箱绑定 / 身份。**额度只以它和 `/v1/usage` 为准**，客户端不推导 */
export const getProfile = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeUser>> =>
  http
    .call<unknown>({ method: 'GET', path: '/api/v1/user/profile', timeout: 'read' })
    .then((result) => (result.ok ? { ...result, data: toConsumeUser(result.data) } : result))

/** 退出所有设备（成功后本地必须清 token：服务端已经把它全撤了） */
export const revokeAllSessions = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeEmpty>> =>
  http.call<ConsumeEmpty>({ method: 'POST', path: '/api/v1/auth/revoke-all-sessions', timeout: 'write' })

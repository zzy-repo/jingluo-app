/**
 * 账号与身份（JWT 通道，`/api/v1/**`）—— Issue #484 §3.1 / §3.1b / §3.1c，W1-A。
 *
 * 覆盖的端点（**只能用这些**，白名单外一律不许调，`pnpm check:consume-api` 会拦）：
 *
 *   GET  /api/v1/settings/public            启动时读功能开关（注册/邮箱验证/邀请码/验证码）
 *   POST /api/v1/auth/register              注册（可带 verify_code / invitation_code / aff_code / deviceId）
 *   POST /api/v1/auth/login                 登录
 *   POST /api/v1/auth/login/2fa             两步验证
 *   POST /api/v1/auth/send-verify-code      发邮箱验证码（注册用，5/min）
 *   POST /api/v1/auth/refresh               刷新 token（30/min）
 *   POST /api/v1/auth/forgot-password       忘记密码
 *   POST /api/v1/auth/reset-password        重置密码
 *   POST /api/v1/auth/revoke-all-sessions   退出所有设备
 *   GET  /api/v1/user/profile               账号资料 / 邮箱绑定 / 余额（元）—— **「当前用户」只走它**
 *
 * 「当前用户」**没有**第二个入口（#676 §二）：契约明写「`/api/v1/auth/me` 不存在，请用
 * `/api/v1/user/profile`」。实测（staging `0.2.20`，2026-11-21）该路由**仍然在**、带有效 JWT 回 200、
 * 字段与 `/user/profile` 同形 —— 所以这里删掉它不是「修线上故障」，而是**不再依赖契约外的路径**：
 * 一旦服务端按契约把它摘掉，`restoreAuth()` 会变成「一启动就掉线」。两种体的差异只有
 * `/user/profile` 多一层 `identities`（邮箱绑定明细），`toConsumeUser` 两边都吃得下。
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

import { ensureDeviceId, isDeviceId } from '../invite/device.js'

import { confirmEffect, unconfirmedEffectError } from './confirmEffect.js'
import { isSessionError } from './errors.js'
import type { ConsumeCallResult, ConsumeEmpty, ConsumeHttp } from './http.js'

/**
 * sub2api 的用户对象（金额单位一律 **元**：1 元 = 1 额度，后端 8b12ab2 明确，无 USD 概念）。
 *
 * 字段来自**联调实例的真实 200**（`GET /api/v1/user/profile`，实例 0.2.20 / staging 0.2.20）：
 * `{id,email,username,role,balance,frozen_balance,concurrency,status,allowed_groups,last_active_at,
 *   created_at,updated_at,balance_notify_*,total_recharged,rpm_limit,identities:{provider:{...}}}`
 * 登录 / 注册成功体里的 `user` 是它的子集（没有 `identities`），所以同一个 `toConsumeUser` 两处都能用。
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
  /**
   * 服务端下发的**脱敏**邮箱（`email_masked`，如 `a***@b.co`）。
   *
   * 存在时界面直接显示它，**不再**在客户端二次打码（`a***@b.co` 再过一遍 `maskedEmail`
   * 会变成 `a•••***@b.co`）。没有这个字段时仍按 `email` 在本地脱敏 —— 两种下发形态都认。
   * 绑定成功的判据也读它（见 `services/consume/email.ts` 的 `bindEmail`，#660）。
   */
  emailMasked?: string
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
  // `email_masked` 原样带出去（是**已经脱敏**的值，界面不能再打一次码）
  const emailMasked = str(user.email_masked)
  if (emailMasked.trim() !== '') {
    out.emailMasked = emailMasked
  }
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
  /**
   * 设备码（**可选**，Issue #717 契约）：只用于老账号额度迁移时做一致性校验 / 风控统计。
   *
   * 契约（`#717` 原文）：
   *  - 格式 `^[A-Za-z0-9._:-]{8,128}$`；**缺省或非法 → 整个字段省略**，不传空串、不传占位值
   *    （后端对缺省 / 非法一律「忽略该字段」，不会因此返回错误、**不阻断注册**）；
   *  - **不是凭据**：不能单独认领老额度，也不能替代密码 / 免验证登录。真正决定迁移的是
   *    `oldApiKey`（持有证明），deviceId 只是配角（老系统「知道设备码就能顶号」的毛病不延续）；
   *  - **只进请求体**：不进 URL query（`check:consume-api` 的 R7 也拦），不进日志 / 埋点 / 诊断
   *    （凭据类，真要出现在日志里最多尾 4 位 —— 本层一处都不打印）；
   *  - 后端当前（`RegisterRequest`）**还没有**这个字段：传过去会被直接忽略，注册照常成功；
   *    后端上线后同一份代码自动生效，客户端不用再改。
   *
   * 不传时本层自己取一次（`resolveRegisterDeviceId` → `services/invite/device.ts` 的
   * `ensureDeviceId()`，首次生成并持久化、之后复用）；取不到 / 不支持就**不传**，绝不阻断注册。
   */
  deviceId?: string
}

/** 设备码采集口（返回 `undefined` = 没有 / 不支持，直接省略该字段） */
export type RegisterDeviceIdSource = () => string | undefined

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

/**
 * 注册（**不可重试**：没有幂等键，重发只会得到「邮箱已存在」，#484 §4.3）。
 *
 * 第三个参数是设备码采集口，**只给测试替换用**（默认实现见 `loadRegisterDeviceId`）；
 * 生产调用点（`createConsumeClient` / `createAuthTransport`）不传它，走默认的
 * 「取一次 `ensureDeviceId()`，取不到就不传」。
 */
export const register = (
  http: ConsumeHttp,
  input: ConsumeRegisterInput,
  deviceIdSource: RegisterDeviceIdSource = loadRegisterDeviceId
): Promise<ConsumeCallResult<ConsumeAuthSession>> =>
  http
    .call<unknown>({ method: 'POST', path: '/api/v1/auth/register', body: toRegisterBody(input, deviceIdSource), timeout: 'write', auth: null })
    .then((result) => (result.ok ? { ...result, data: toAuthSession(result.data) } : result))

/**
 * 默认采集实现 —— **全仓唯一一处**「注册时取设备码」的实现，复用 `services/invite/device.ts`：
 * `ensureDeviceId()` 就是 `loadOrCreateDeviceId(localStorageDeviceIdStorage()).deviceId`
 * （首次生成并落盘，之后复用同一个值），这里**不重写**生成 / 校验 / 存储逻辑，只加一层兜底。
 *
 * 为什么用「读取或新建」而不是 `legacy/migration/collect.ts` 的只读采集：迁移采集的口径是
 * 「只认真的存在过的东西」（只读不建，缺失就没线索），注册时则相反 —— 新设备本来就该有设备码，
 * 注册是它第一次落盘的时机。两处口径不同，所以这里不共用那个只读函数。
 *
 * 任何异常（`node --test` 没有 `localStorage`、隐私模式写不进去、老 WebView 没有 WebCrypto……）
 * 都当「没有」：注册是主流程，设备码只是迁移时的可选关联（#717「缺省 / 非法 → 后端忽略，
 * 不阻断注册」）。
 */
const loadRegisterDeviceId: RegisterDeviceIdSource = () => {
  try {
    return ensureDeviceId()
  } catch {
    return undefined
  }
}

/**
 * 决定这次注册带不带 `deviceId`（返回 `undefined` = **整个字段省略**）。
 *
 *  1. 调用方**显式**给了（哪怕空串 / 非法值）→ 只按格式判定，**不再去采集**。传了非法值就当
 *     没有（省略），绝不偷偷换成「本机的设备码」：那会把用户想关联的那台设备和当前设备搞混，
 *     而且调用方会以为自己传的值被用了。
 *  2. 没给 → 取**一次**采集值；采集本身抛错 / 返回非字符串也当没有（`#717`：不阻断注册）。
 *  3. 两种情况都复用 `isDeviceId()`（`services/invite/device.ts` 的**唯一一份**格式校验，
 *     `^[A-Za-z0-9._:-]{8,128}$`），不在这里另抄一个正则 —— 两份正则迟早会分叉。
 */
const resolveRegisterDeviceId = (
  explicit: string | undefined,
  source: RegisterDeviceIdSource
): string | undefined => {
  const pick = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {return undefined}
    const trimmed = value.trim()
    return isDeviceId(trimmed) ? trimmed : undefined
  }
  if (explicit !== undefined) {
    return pick(explicit)
  }
  let collected: unknown
  try {
    collected = source()
  } catch {
    return undefined
  }
  return pick(collected)
}

/**
 * 注册请求体。`deviceId` 是**可选**字段（#717）：只有「存在且格式合法」才放进去，
 * 否则整个键不出现（缺省 / 空串 / 非法 / 采集失败都一样 —— 服务端按可选处理）。
 * 键名保持契约里的 camelCase `deviceId`，本层不做 snake_case 转换。
 */
const toRegisterBody = (
  input: ConsumeRegisterInput,
  deviceIdSource: RegisterDeviceIdSource
): Record<string, unknown> => {
  const body: Record<string, unknown> = { email: input.email, password: input.password }
  if (input.verifyCode) {body.verify_code = input.verifyCode}
  if (input.invitationCode) {body.invitation_code = input.invitationCode}
  if (input.affCode) {body.aff_code = input.affCode}
  if (input.promoCode) {body.promo_code = input.promoCode}
  if (input.turnstileToken) {body.turnstile_token = input.turnstileToken}
  if (input.tencentCaptchaTicket) {body.tencent_captcha_ticket = input.tencentCaptchaTicket}
  if (input.tencentCaptchaRandstr) {body.tencent_captcha_randstr = input.tencentCaptchaRandstr}
  const deviceId = resolveRegisterDeviceId(input.deviceId, deviceIdSource)
  if (deviceId !== undefined) {body.deviceId = deviceId}
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

/**
 * 发注册验证码（服务端限流 5/min：429 时按 `Retry-After` 倒计时，**不要**自己另算间隔）。
 *
 * 成功判据（#679 第 6 处的「发码」类）：**例外，只信 2xx** ——
 * 依据见 `confirmEffect.ts` 的 `CONSUME_EFFECT_POLICIES.sendVerifyCode`：纯通知类，服务端没有
 * 「这个码发出去没有」的查询端点（`/user/profile` 里没有待发验证码），回查无从谈起；
 * 重发无副作用（只是再发一封），频控 5/min + 429 的 `retry_after` 本身就是受理证据。
 * 所以这里**不发明一次假回查**；界面文案也不许写「验证码已发出」以外更硬的承诺（没收到就再发）。
 */
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

/**
 * 忘记密码（发重置邮件 / 验证码，5/min）。
 *
 * 成功判据：**例外，只信 2xx** —— 依据见 `CONSUME_EFFECT_POLICIES.forgotPassword`：
 * 纯通知类、匿名接口无会话可回查；而且**刻意不回查**（服务端不区分「邮箱存不存在」正是为了
 * 不泄漏账号是否存在，客户端自己回查一遍等于把这个探测口开回来）。重发无副作用。
 */
export const forgotPassword = (http: ConsumeHttp, input: { email: string }): Promise<ConsumeCallResult<ConsumeEmpty>> =>
  http.call<ConsumeEmpty>({ method: 'POST', path: '/api/v1/auth/forgot-password', body: { ...input }, timeout: 'write', auth: null })

/**
 * 重置密码（10/min）：`token` 与 `code` 两种形态由服务端版本决定，原样透传。
 *
 * 成功判据：**例外，只信 2xx** —— 依据见 `CONSUME_EFFECT_POLICIES.resetPassword`：
 * 匿名流程没有会话（`GET /user/profile` 打不了）、接口也不回实体，**没有可回查的证据**。
 * 唯一真正的确认是「用新密码登录一次」，那是登录流程的事（见 `login`），不是本接口能给的东西。
 * 因此调用方**不许**把 `ok: true` 说成「密码已改」，只能说「重置请求已提交，请用新密码登录验证」。
 */
export const resetPassword = (
  http: ConsumeHttp,
  input: { password: string; token?: string; code?: string }
): Promise<ConsumeCallResult<ConsumeEmpty>> => {
  const body: Record<string, unknown> = { password: input.password }
  if (input.token) {body.token = input.token}
  if (input.code) {body.code = input.code}
  return http.call<ConsumeEmpty>({ method: 'POST', path: '/api/v1/auth/reset-password', body, timeout: 'write', auth: null })
}

/**
 * 「当前用户」= `getProfile()`，**不再有 `me()`**（#676 §二）。
 *
 * 原来的 `me()` 打的是 `/api/v1/auth/me`：实测（staging 0.2.20）能回 200，但契约明确说那条路径
 * 「**不存在**，请用 `/api/v1/user/profile`」。保留两条等价路径等于给「启动恢复」埋一个
 * 只在服务端删路由那天才爆的雷，所以这里直接删掉 —— 要用户对象就调下面这一个。
 */

/** 账号资料：余额（元）/ 邮箱绑定 / 身份。**额度只以它和 `/v1/usage` 为准**，客户端不推导 */
export const getProfile = (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeUser>> =>
  http
    .call<unknown>({ method: 'GET', path: '/api/v1/user/profile', timeout: 'read' })
    .then((result) => (result.ok ? { ...result, data: toConsumeUser(result.data) } : result))

/**
 * 退出所有设备 —— **本单（#679）第一优先修的安全语义点**。
 *
 * 病灶：原来 `POST /revoke-all-sessions` 拿到 2xx 就 `ok: true`，界面于是显示「已退出所有设备」。
 * 撤销其实没生效时，这句话是**最坏的一类谎**：用户以为公用设备 / 丢失设备上的会话已经没了，
 * 于是不再改密码、不再检查。
 *
 * 判据（#660 的模式，`confirmEffect` 固化）：服务端**不给实体**（实测形态是空体 / `{code:0,data:{message}}`），
 * 唯一能自证撤销生效的手段是「**旧凭据还能不能用**」：用**同一个** JWT 回查一次 `GET /user/profile`。
 *   - 401/403（会话类错误）→ 凭据确实失效了 → **confirmed**（`via: 'probe'`）；
 *   - 200（还能读到自己）→ **反证**：会话没被撤销 → `confirmed: false`（`probe-negative`）；
 *   - 回查本身失败（网络 / 5xx）→ 结论**未知** → `confirmed: false`（`probe-failed`）。
 *
 * 「未确认」**不是失败也不是成功**：返回 `ok: false` + `consumeErrRevokeUnconfirmed`，
 * 文案专门说「已提交撤销请求，但结果未确认」并给出下一步（重新登录验证 / 稍后检查其他设备），
 * **界面不许出现「已退出所有设备」**。本地 token 该清仍然要清（那是调用方的事：`store.ts` 的
 * `signOut` 无论服务端结果如何都会清本地 —— 继续留着一个「可能还有效」的凭据才是更糟的选择）。
 *
 * 回查**只做一次**、不循环：撤销类写操作后的查询放大，等于把「一次网络抖动」变成「一串请求」。
 */
export const revokeAllSessions = async (http: ConsumeHttp): Promise<ConsumeCallResult<ConsumeEmpty>> => {
  const result = await http.call<ConsumeEmpty>({
    method: 'POST',
    path: '/api/v1/auth/revoke-all-sessions',
    timeout: 'write',
  })
  if (!result.ok) {
    return result
  }
  const outcome = await confirmEffect<ConsumeEmpty>({
    response: { data: result.data, raw: result.raw },
    // 响应体里没有任何能自证的字段（不给回显「撤销了几个会话」这种契约），所以 accept 恒无证据
    accept: () => undefined,
    probe: async () => {
      const probed = await getProfile(http)
      if (probed.ok) {
        // 旧 JWT 还能读到自己的资料 = 会话仍然有效 = **反证**
        return { verdict: 'negative' }
      }
      if (isSessionError(probed.error)) {
        // 会话类错误是**唯一**能证明「撤销生效」的证据：凭据已经不能用了
        return { verdict: 'confirmed', value: undefined }
      }
      // 429 / 5xx / 网络：既不能证明撤了，也不能证明没撤
      return { verdict: 'unknown', error: probed.error }
    },
  })
  if (outcome.confirmed) {
    return { ok: true, data: undefined, status: result.status, raw: result.raw }
  }
  return {
    ok: false,
    error: unconfirmedEffectError({
      i18nKey: 'consumeErrRevokeUnconfirmed',
      code: 'REVOKE_UNCONFIRMED',
      message:
        outcome.reason === 'probe-negative'
          ? '撤销接口回了 2xx，但用同一个 JWT 回查 /user/profile 仍然 200：会话没有被撤销'
          : '撤销接口回了 2xx，但没能确认会话已经失效（回查 /user/profile 的结果不可判定）',
      status: result.status,
      outcome,
    }),
    raw: result.raw,
  }
}

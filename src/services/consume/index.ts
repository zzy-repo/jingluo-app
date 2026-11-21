/**
 * `src/services/consume/**` 的**唯一入口**（Issue #487 W1-A）。
 *
 * 这一层是「消费侧后端（sub2api）+ 支付侧后端（apia）地址」在客户端的全部落地：
 *
 * ```ts
 * import { createConsumeClient } from '../services/consume/index.js'
 *
 * const consume = createConsumeClient({
 *   accessToken: () => session.accessToken,   // W1-B：登录态在哪儿存由你决定
 *   apiKey: () => localKey,                   // 只给 /v1/** 用
 * })
 *
 * const settings = await consume.settings.get()          // 功能开关（启动时读一次）
 * const login = await consume.auth.login({ email, password })
 * const keys = await consume.keys.list({ page: 1 })
 * const usage = await consume.usage.gateway()             // sk- Key → /v1/usage
 * const redeem = await consume.redeem.redeem({ code })    // 幂等补偿版
 * ```
 *
 * 分层（谁负责什么，别互相穿透）：
 *   - `http.ts`   拼 URL + 原生 CapacitorHttp + 原始响应（**不含**业务语义、不做重试）
 *   - `errors.ts` 三套错误信封 → `{kind, code, message, retryable}` + 错误码 → i18n key
 *   - `auth/keys/usage/redeem/aff/email.ts` 每个模块只碰白名单内的端点，重试策略写在各自文件头
 *   - 本文件只做「组装 + 导出」，不放逻辑
 *
 * 三条不许在这里破的约定：
 *   1. Key / JWT 只进 `Authorization` 头 —— 不进 query、不进日志、不进 DOM 全文；
 *   2. 额度只以服务端为准 —— 本层不缓存、不推导、不做本地账本；
 *   3. 卡密兑换**绝不盲目重试** —— 先查历史核对到账，再决定要不要让用户重试。
 */

import { getAffiliate, validateInvitationCode } from './aff.js'
import {
  forgotPassword,
  getProfile,
  getPublicSettings,
  login,
  loginWithTwoFactor,
  me,
  refresh,
  register,
  resetPassword,
  revokeAllSessions,
  sendVerifyCode,
} from './auth.js'
import { bindEmail, sendBindEmailCode, unbindProvider } from './email.js'
import { createConsumeHttp, type ConsumeHttp, type ConsumeHttpOptions } from './http.js'
import { createKey, deleteKey, getKey, listKeys, updateKey } from './keys.js'
import { getRedeemHistory, redeemCode } from './redeem.js'
import { getGatewayUsage, getKeyDailyUsage, getUsageDashboard, getUsageStats, listUsage } from './usage.js'

// ── 传输层 ───────────────────────────────────────────────────────────────
export {
  capacitorTransport,
  ConsumeConfigError,
  createConsumeHttp,
  emptyRawResponse,
  readConsumeEndpoints,
  type ConsumeAuth,
  type ConsumeCallResult,
  type ConsumeChannel,
  type ConsumeEmpty,
  type ConsumeEndpoints,
  type ConsumeHttp,
  type ConsumeHttpOptions,
  type ConsumeMethod,
  type ConsumeRawResponse,
  type ConsumeRequest,
  type ConsumeTimeoutClass,
  type ConsumeTransport,
  type ConsumeTransportRequest,
  type ConsumeTransportResult,
} from './http.js'

// ── 错误 ─────────────────────────────────────────────────────────────────
export {
  CONSUME_ERROR_KEYS,
  isRedeemLocked,
  isRedeemUsed,
  isSessionError,
  parseSub2ApiError,
  resetConsumeGaps,
  setConsumeGapReporter,
  unmappedConsumeCodes,
  type ConsumeErrorEnvelope,
  type ConsumeErrorGap,
  type ConsumeErrorKind,
  type ConsumeMessageKey,
  type Sub2ApiError,
} from './errors.js'

// ── 各业务模块（也可以单独 import，不强制走 client）─────────────────────
export {
  forgotPassword,
  getProfile,
  getPublicSettings,
  login,
  loginWithTwoFactor,
  me,
  refresh,
  register,
  resetPassword,
  revokeAllSessions,
  sendVerifyCode,
  toAuthSession,
  toConsumeUser,
  type ConsumeAuthSession,
  type ConsumeIdentity,
  type ConsumeLoginInput,
  type ConsumePublicSettings,
  type ConsumeRegisterInput,
  type ConsumeTwoFactorInput,
  type ConsumeUser,
} from './auth.js'
export {
  createKey,
  deleteKey,
  getKey,
  listKeys,
  toConsumeApiKey,
  updateKey,
  type ConsumeApiKey,
  type ConsumeKeyCreateInput,
  type ConsumeKeyQuery,
  type ConsumeKeyUpdateInput,
  type ConsumePage,
} from './keys.js'
export {
  getGatewayUsage,
  getKeyDailyUsage,
  getUsageDashboard,
  getUsageStats,
  listUsage,
  type ConsumeGatewayUsage,
  type ConsumeUsageQuery,
} from './usage.js'
export {
  getRedeemHistory,
  matchesRedeemCode,
  redeemCode,
  verifyCredited,
  type ConsumeCreditedCheck,
  type ConsumeRedeemHistory,
  type ConsumeRedeemHistoryItem,
  type ConsumeRedeemOutcome,
  type ConsumeRedeemResult,
} from './redeem.js'
export {
  getAffiliate,
  validateInvitationCode,
  type ConsumeAffiliate,
  type ConsumeInvitationCheck,
} from './aff.js'
export { bindEmail, sendBindEmailCode, unbindProvider } from './email.js'
// ── 效果确认（#679：「2xx ≠ 生效」的唯一落点，见 confirmEffect.ts 文件头）─────────
export {
  confirmEffect,
  CONSUME_EFFECT_POLICIES,
  effectPolicyOf,
  probeOnce,
  unconfirmedEffectError,
  type ConfirmEffectInput,
  type ConfirmEffectOutcome,
  type ConfirmFailureReason,
  type ConfirmProbe,
  type ConfirmProbeResult,
  type ConsumeEffectPolicy,
} from './confirmEffect.js'

/** `createConsumeClient` 的入参：与传输层一致（token 提供者 + 可选 transport 注入） */
export type ConsumeClientOptions = ConsumeHttpOptions

/**
 * 组装一个「按名字空间调用」的客户端。
 *
 * 为什么还要一层名字空间：W1-B / W1-C 的调用点大多是「页面里点一下 → 打一个接口」，
 * `consume.keys.create(...)` / `consume.redeem.redeem(...)` 比逐个 import 十几个函数更适合界面；
 * 但每个函数仍然可以单独 import（测试 / 特殊流程想精确控制时用得到）。
 */
export const createConsumeClient = (options: ConsumeClientOptions = {}) => {
  const http: ConsumeHttp = createConsumeHttp(options)
  return {
    http,
    settings: {
      /** 启动时读一次：注册 / 邮箱验证 / 邀请码 / 人机校验入口是否显示（本地不维护第二份开关） */
      get: () => getPublicSettings(http),
    },
    auth: {
      register: (input: Parameters<typeof register>[1]) => register(http, input),
      login: (input: Parameters<typeof login>[1]) => login(http, input),
      login2fa: (input: Parameters<typeof loginWithTwoFactor>[1]) => loginWithTwoFactor(http, input),
      sendVerifyCode: (input: Parameters<typeof sendVerifyCode>[1]) => sendVerifyCode(http, input),
      refresh: (input: Parameters<typeof refresh>[1]) => refresh(http, input),
      forgotPassword: (input: Parameters<typeof forgotPassword>[1]) => forgotPassword(http, input),
      resetPassword: (input: Parameters<typeof resetPassword>[1]) => resetPassword(http, input),
      me: () => me(http),
      profile: () => getProfile(http),
      revokeAllSessions: () => revokeAllSessions(http),
    },
    keys: {
      list: (query?: Parameters<typeof listKeys>[1]) => listKeys(http, query),
      get: (id: number) => getKey(http, id),
      create: (input: Parameters<typeof createKey>[1], options?: Parameters<typeof createKey>[2]) => createKey(http, input, options),
      update: (id: number, input: Parameters<typeof updateKey>[2]) => updateKey(http, id, input),
      remove: (id: number) => deleteKey(http, id),
    },
    usage: {
      /** sk- Key 通道：当前 Key 的额度 / 余额（唯一的额度入口） */
      gateway: () => getGatewayUsage(http),
      list: (query?: Parameters<typeof listUsage>[1]) => listUsage(http, query),
      stats: (query?: Parameters<typeof getUsageStats>[1]) => getUsageStats(http, query),
      dashboard: (view: string, query?: Parameters<typeof getUsageDashboard>[2]) => getUsageDashboard(http, view, query),
      keyDaily: (keyId: number, query?: Parameters<typeof getKeyDailyUsage>[2]) => getKeyDailyUsage(http, keyId, query),
    },
    redeem: {
      /** 兑换（幂等补偿版）：返回 `redeemed` / `pending` / `processing` / `failed` 四态 */
      redeem: (input: Parameters<typeof redeemCode>[1]) => redeemCode(http, input),
      history: (query?: Parameters<typeof getRedeemHistory>[1]) => getRedeemHistory(http, query),
    },
    aff: {
      validateInvitationCode: (code: string) => validateInvitationCode(http, code),
      detail: () => getAffiliate(http),
    },
    email: {
      sendCode: (email: string) => sendBindEmailCode(http, email),
      bind: (input: Parameters<typeof bindEmail>[1]) => bindEmail(http, input),
      unbind: (provider: string) => unbindProvider(http, provider),
    },
  }
}

/** 客户端类型（界面里拿它当参数类型，避免每个组件各写一份推断） */
export type ConsumeClient = ReturnType<typeof createConsumeClient>

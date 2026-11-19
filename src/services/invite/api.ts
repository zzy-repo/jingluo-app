/**
 * 邀请 / 额度服务的客户端契约层（纯逻辑，网络通过注入的 transport 发出）。
 *
 * 服务端：http://140.210.13.146:60013 —— **明文 HTTP**（同一台机器上的对话上游也是 http，
 * 见 providers.ts 的 ours.defaults）。只承载设备码、邀请码、积分账本，不承载支付凭据：
 * 卡密与支付一律走 https://apia.ecsafe.cn（见 services/ours/api.ts）。
 *
 * 契约（2026-11-18 实测）：
 *   POST /apply   {device_id}
 *        → 201 首次绑定 / 200 已申请（同一 device_id 幂等，可安全重试）
 *        → { key, invite_code, invited_count, max_invites, bonus_points, redeemed,
 *            quota_points, used_points, remaining_points, key_status }
 *   GET  /me?device_id=…
 *        → 同上但**不含 key**
 *   POST /redeem  {device_id, invite_code}
 *        → 200 { …, reward_points, reward_points_inviter, cashback_points, synced }
 *        → 错误码：device_not_found(404) invalid_code(404) own_code(400)
 *                  already_redeemed(409) code_exhausted(409) circular_invite(409)
 *                  rate_limited(429)
 *   错误格式统一为 { "error": { "code": "...", "message": "..." } }
 *
 * Issue #234（2026-11-19 起线上生效）的奖励规则：
 *   填码时**被邀请人不再得积分**（reward_points: 0），只有邀请人得 100；
 *   好友首次付款 ≥ ¥4.9 时邀请人再得 100 返现；互填邀请码返回 409 circular_invite。
 *   规则数值一律读服务端（/me 与 /redeem 的 `invite_rules`，以及 `cashback_points`），
 *   前端不写死金额/积分数；字段缺失（老服务端）解析成 null，界面整行隐藏。
 *
 * 额度口径：**remaining_points 就是可消费积分**，1 元 = 100 积分。
 * 不要用卡密服务的 /api/balance 当余额（它只回答 Key 是否有效）。
 */

import type { OursHttpResult, OursMessageKey, OursTransport } from '../ours/api.js'
import { redeemCard as redeemCardLegacy } from '../ours/api.js'
import { createDeviceId, isDeviceId } from './device.js'
import { DEVICE_FP_HEADER, normalizeDeviceFp } from './fingerprint.js'

/**
 * 邀请 / 额度服务地址：明文 HTTP，见文件头的安全说明。
 * 唯一来源是 config/endpoints.json 的 inviteBaseUrl（#274），构建期注入 __ENDPOINTS__ ——
 * 「同一台机器上的对话上游也是 http」这件事现在由配置文件表达，不再靠注释同步。
 */
export const INVITE_API_BASE = __ENDPOINTS__.inviteBaseUrl

/**
 * 需要上报设备指纹的请求头上挂 `X-Device-Fp`（Issue #243）。
 *
 * 三条约束：
 *   - 指纹必须过 {@link normalizeDeviceFp}：不是 64 位十六进制、或形状对但是常量（全零 / 全 F /
 *     空 ANDROID_ID 的固定哈希，见 #395）就当没有 —— 明文 ANDROID_ID 万一被上游误传，
 *     也会在这里被丢掉，不可能出现在请求里；
 *   - 没有指纹就**原样返回入参对象**，请求与此前完全一致 —— 降级不留痕、不阻塞。
 *     「没有可信指纹」这个状态只靠**头缺席**表达，绝不上报一个全零/常量占位值（#395 第 2 条）；
 *   - 只加一个头，不改 body、不改 URL：服务端认不认都影响不到本次语义。
 */
const withDeviceFp = (headers: Record<string, string>, deviceFp: string): Record<string, string> => {
  const fp = normalizeDeviceFp(deviceFp)
  return fp === '' ? headers : { ...headers, [DEVICE_FP_HEADER]: fp }
}

export const INVITE_TIMEOUTS = {
  apply: 15000,
  profile: 10000,
  redeem: 15000,
  /** #421：发验证码（服务端要落库 + 发信，与 /apply 同档） */
  emailSend: 15000,
  /** #421：提交验证码（登录分支会做账号接管，与 /apply 同档） */
  emailVerify: 15000,
  /** #421：只读探测，与 /me 同档 */
  emailStatus: 10000,
} as const

/** 界面文案 key（与 i18n/zh.ts 一致；服务层只回 key，不拼文案） */
export type InviteMessageKey =
  | 'oursInviteErrDeviceNotFound'
  | 'oursInviteErrInvalidCode'
  | 'oursInviteErrOwnCode'
  | 'oursInviteErrAlreadyRedeemed'
  | 'oursInviteErrCodeExhausted'
  | 'oursInviteErrRateLimited'
  | 'oursInviteErrCircularInvite'
  | 'oursInviteErrCodeMissing'
  | 'oursInviteErrDeviceMissing'
  | 'oursInviteErrNetwork'
  | 'oursInviteErrTimeout'
  | 'oursInviteErrInvalidResponse'
  | 'oursInviteErrKeyMissing'
  | 'oursInviteErrUnknown'
  | 'oursInviteErrApplyRateLimited'
  | 'oursInviteErrAlreadyClaimed'
  | 'oursErrInvalidResponse'

/** 服务端错误码 → 文案 key（code 优先，其次按状态码兜底） */
export const INVITE_ERROR_KEYS: Record<string, InviteMessageKey> = {
  device_not_found: 'oursInviteErrDeviceNotFound',
  invalid_code: 'oursInviteErrInvalidCode',
  own_code: 'oursInviteErrOwnCode',
  already_redeemed: 'oursInviteErrAlreadyRedeemed',
  code_exhausted: 'oursInviteErrCodeExhausted',
  // #234：互填邀请码（A 邀请了 B，B 又填 A 的码）服务端返回 409 circular_invite；
  // 不映射就会落到状态码兜底的「已经绑定过邀请码」，对用户是纯误导。
  circular_invite: 'oursInviteErrCircularInvite',
  rate_limited: 'oursInviteErrRateLimited',
  device_id_invalid: 'oursInviteErrDeviceMissing',
  invalid_device: 'oursInviteErrDeviceMissing',
  no_key: 'oursInviteErrKeyMissing',
}

export const INVITE_STATUS_KEYS: Record<number, InviteMessageKey> = {
  400: 'oursInviteErrUnknown',
  404: 'oursInviteErrDeviceNotFound',
  409: 'oursInviteErrAlreadyRedeemed',
  429: 'oursInviteErrRateLimited',
}

/**
 * 邀请规则（Issue #234）：金额与积分数只在服务端配置，前端一个字都不许写死。
 * 老服务端 / 降级部署没有 `invite_rules` → 解析成 null，界面把规则行整行隐藏，
 * **不能**回落到「双方各得 1 元」这类历史文案（线上规则早就变了）。
 */
export type InviteRules = {
  /** 邀请人得多少积分（填码即到账） */
  rewardInviterPoints: number
  /** 被邀请人得多少积分（线上现为 0：只剩关系绑定） */
  rewardInviteePoints: number
  /** 好友首次付款后邀请人再得多少返现积分 */
  cashbackPoints: number
  /** 返现门槛（分）；照原样带出来，界面不做金额换算 */
  cashbackMinFen: number
}

/** 账户档案（/apply 与 /me 的公共部分；/me 没有 key） */
export type InviteProfile = {
  inviteCode: string
  invitedCount: number
  maxInvites: number
  bonusPoints: number
  redeemed: boolean
  quotaPoints: number
  usedPoints: number
  /** 可消费积分（额度展示只认它） */
  remainingPoints: number
  keyStatus: string
  /** 邀请规则；服务端没发 → null（界面隐藏规则行，不编造数值） */
  inviteRules: InviteRules | null
  /** 本人已获得的返现积分；服务端没发 → null */
  cashbackPoints: number | null
  /**
   * #421：本账号是否已绑邮箱（服务端 `has_email`）。
   *
   * 三态，与 `newUserGranted` / `alreadyClaimed` 同一套写法：
   *  - `true`  = 服务端明确说「绑了」；
   *  - `false` = 服务端明确说「没绑」（邮箱功能已开启，这台还没绑）；
   *  - `null`  = **没有这个字段** —— 邮箱功能未开启 / 老服务端。界面必须按「未开启」处理
   *    （入口不出、备份提示照旧），绝不能当成 `false` 去催用户绑邮箱。
   */
  hasEmail: boolean | null
  /** 脱敏邮箱（仅已绑定时服务端才发）；没绑 / 没这个字段 → null，界面不显示 */
  emailMasked: string | null
}

export const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
  if (text.trim() === '') {
    return { ok: false }
  }
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' ? { ok: true, value } : { ok: false }
  } catch {
    return { ok: false }
  }
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const readString = (record: Record<string, unknown> | null, field: string): string => {
  const value = record?.[field]
  return typeof value === 'string' ? value : ''
}

export const readNumber = (record: Record<string, unknown> | null, field: string): number => {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export const readBoolean = (record: Record<string, unknown> | null, field: string): boolean =>
  record?.[field] === true

/**
 * 可选数字：字段不存在 / 不是有限数字 → null。
 * 新字段（invite_rules、cashback_points）必须用它：0 与「根本没有这个字段」是两件事，
 * 前者是服务端说「这次 0 积分」，后者是老服务端的降级态。
 */
export const readOptionalNumber = (
  record: Record<string, unknown> | null,
  field: string
): number | null => {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 可选布尔：字段不存在 / 不是 true/false → null。
 *
 * 与 {@link readOptionalNumber} 同一个理由（#261）：`false`（服务端明确说「这次没发」）
 * 和「根本没有这个字段」（老服务端）必须分得开，否则客户端会把「已领过」渲染成「领取成功」。
 */
export const readOptionalBoolean = (
  record: Record<string, unknown> | null,
  field: string
): boolean | null => {
  const value = record?.[field]
  return typeof value === 'boolean' ? value : null
}

/**
 * 可选字符串：字段不存在 / 不是字符串 / 空串 → null。
 * 与 {@link readOptionalBoolean} 同一个理由：「服务端说这里什么都没有」和「服务端压根没这个字段」
 * 对界面是两回事（前者该显示空，后者该整行隐藏）。
 */
export const readOptionalString = (
  record: Record<string, unknown> | null,
  field: string
): string | null => {
  const value = record?.[field]
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** 解析服务端下发的邀请规则；两条主线奖励都读不出来就当作没有规则（→ null） */
export const parseInviteRules = (value: unknown): InviteRules | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const inviter = readOptionalNumber(record, 'reward_inviter_points')
  const invitee = readOptionalNumber(record, 'reward_invitee_points')
  if (inviter === null && invitee === null) {
    return null
  }
  return {
    rewardInviterPoints: inviter ?? 0,
    rewardInviteePoints: invitee ?? 0,
    cashbackPoints: readOptionalNumber(record, 'cashback_points') ?? 0,
    cashbackMinFen: readOptionalNumber(record, 'cashback_min_fen') ?? 0,
  }
}

export const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300

/** 解析档案；字段缺失不编造默认值，只剩完全无法解释的响应才返回 null */
export const parseInviteProfile = (value: unknown): InviteProfile | null => {
  const record = asRecord(value)
  if (record === null) {
    return null
  }
  const inviteCode = readString(record, 'invite_code')
  const remainingRaw = record.remaining_points
  // 额度字段必须真的存在且是数字：缺它就等于「查不到额度」，不能默默当 0（0 是「用完了」）
  if (inviteCode === '' || typeof remainingRaw !== 'number' || !Number.isFinite(remainingRaw)) {
    return null
  }
  const remaining = remainingRaw
  return {
    inviteCode,
    invitedCount: readNumber(record, 'invited_count'),
    maxInvites: readNumber(record, 'max_invites'),
    bonusPoints: readNumber(record, 'bonus_points'),
    redeemed: readBoolean(record, 'redeemed'),
    quotaPoints: readNumber(record, 'quota_points'),
    usedPoints: readNumber(record, 'used_points'),
    remainingPoints: remaining,
    keyStatus: readString(record, 'key_status'),
    // #234：规则与返现都只认服务端；缺失即 null（降级态），绝不补默认金额
    inviteRules: parseInviteRules(record.invite_rules),
    cashbackPoints: readOptionalNumber(record, 'cashback_points'),
    // #421：缺字段 → null（邮箱功能未开启），不是 false
    hasEmail: readOptionalBoolean(record, 'has_email'),
    emailMasked: readOptionalString(record, 'email_masked'),
  }
}

/** 错误体解析：{ error: { code, message } }（兼容顶层 { code }） */
export const readErrorCode = (value: unknown): string => {
  const record = asRecord(value)
  const nested = asRecord(record?.error)
  return readString(nested, 'code') || readString(record, 'code')
}

type Failure = { code: string; messageKey: InviteMessageKey; retryable: boolean }

const transportFailure = (result: Exclude<OursHttpResult, { kind: 'response' }>): Failure =>
  result.kind === 'timeout'
    ? { code: 'TIMEOUT', messageKey: 'oursInviteErrTimeout', retryable: true }
    : { code: 'NETWORK', messageKey: 'oursInviteErrNetwork', retryable: true }

const failureFor = (code: string, status: number): Failure => ({
  code: code || `HTTP_${status}`,
  messageKey: INVITE_ERROR_KEYS[code] ?? INVITE_STATUS_KEYS[status] ?? 'oursInviteErrUnknown',
  // 只有限流 / 5xx / 网络值得原样重试；语义错误（无效码、自己的码…）重试没意义
  retryable: code === 'rate_limited' || status >= 500,
})

export type InviteApplyResult =
  | {
      kind: 'ok'
      profile: InviteProfile
      /** 服务端下发的 Key：只写进当前渠道配置，绝不记录 */
      apiKey: string
      /** true = 本次首次绑定（201）；false = 已申请过（200，幂等返回同一把 Key） */
      firstTime: boolean
      /**
       * 服务端在响应里回填的 device_id（Issue #261）。`''` = 老服务端 / 本次没回。
       *
       * 与本地手里的不同时必须写回（见 `adoptServerDeviceId`）：服务端认的是它，
       * 继续用本地那个会让后续 `/me`、兑换、下单全部查错设备。
       */
      serverDeviceId: string
      /**
       * 服务端明确说「这次有没有发新人额度」。`null` = 没有这个字段（老服务端，不可判定）。
       * `false` 是**行为信号**：这台设备/指纹此前领过，本次没给新额度 —— 界面不许显示「领取成功」。
       */
      newUserGranted: boolean | null
      /** 服务端明确说「该设备指纹已绑定过账号」。`null` = 没这个字段 */
      deviceFpBound: boolean | null
      /**
       * 服务端明确说「这次是**把原账号交还给你**」（`already_claimed:true`，HTTP 200）。
       * `null` = 没这个字段（老 build / 同一 device_id 的幂等重放）。
       *
       * 这是 #261 唯一权威的「已领取」信号 —— 服务端在 restore 分支里
       * `new_user_granted` 仍回 true（实测 2026-11-19），所以不能只看那个字段。
       */
      alreadyClaimed: boolean | null
      /** 本次的界面语义（{#classifyClaim} 的结论）：只有 `granted` 才允许显示「领取成功」 */
      outcome: ClaimOutcome
    }
  | ({ kind: 'error' } & Failure)

/**
 * 领取结果的三种界面语义（Issue #261）。纯函数判定，界面只负责把它翻成文案。
 *
 * 判定顺序**有讲究**（2026-11-19 实测的 restore 分支为据）：
 *   1. `already_claimed:true`（HTTP 200 + 原账号原额度）→ 已领过、同一把 Key；
 *   2. 否则 `new_user_granted:false` → 这台设备/指纹领过了；服务端有没有给回**另一个**
 *      device_id 决定是「同一把 Key」还是「这台设备已领过新人额度」（老 build 的静默新号）；
 *   3. 否则（`new_user_granted:true` 或老服务端没有该字段）→ 201 算新领取，200 算已申请过。
 *
 * `device_fp_bound` 只在两个新字段都没有时兜底：首次发放后它同样是 true，不能单独当「已领过」。
 */
export type ClaimOutcome = 'granted' | 'already-same-account' | 'already-other-account'

export const classifyClaim = (input: {
  firstTime: boolean
  newUserGranted: boolean | null
  deviceFpBound?: boolean | null
  alreadyClaimed?: boolean | null
  serverDeviceId: string
  localDeviceId: string
}): ClaimOutcome => {
  const server = input.serverDeviceId.trim()
  const local = input.localDeviceId.trim()
  const otherAccount = server !== '' && server !== local
  // 1. 服务端明确「原账号交还」：device_id 与本地不同也是**同一个账号**（原账号的 ID）
  if (input.alreadyClaimed === true) {
    return 'already-same-account'
  }
  // 2. 服务端说「这次没发新人额度」
  if (input.newUserGranted === false) {
    return otherAccount ? 'already-other-account' : 'already-same-account'
  }
  // 3. 指纹已绑定但两个新字段都缺 → 也算已领过
  if (input.newUserGranted === null && input.deviceFpBound === true && !input.firstTime) {
    return otherAccount ? 'already-other-account' : 'already-same-account'
  }
  // 4. 老服务端：200 = 同一 device_id 已申请过（#261 之前的判定，保持不回归）
  if (input.newUserGranted === null && !input.firstTime) {
    return otherAccount ? 'already-other-account' : 'already-same-account'
  }
  return 'granted'
}

/** 界面文案 key：三种语义各一句，绝不含 device_id / Key */
export type ClaimMessageKey = 'oursClaimOk' | 'oursClaimOkExisting' | 'oursClaimAlreadyGranted'

export const claimMessageKeyFor = (outcome: ClaimOutcome): ClaimMessageKey =>
  outcome === 'granted'
    ? 'oursClaimOk'
    : outcome === 'already-other-account'
      ? 'oursClaimAlreadyGranted'
      : 'oursClaimOkExisting'

/**
 * 领取 Key：POST /apply。
 * 同一 device_id 幂等（201 首次 / 200 已申请），所以失败后可以直接重试同一请求。
 *
 * `deviceFp`（Issue #243）是可选的设备指纹哈希：有就多带一个 `X-Device-Fp` 头，没有就照旧发。
 * **客户端只上报，不判定** —— 参数为空绝不影响请求，也绝不在这里做任何「领过了」的判断。
 * 判「这台设备领没领过」的结论**只从响应字段来**（#261：`new_user_granted` / `device_fp_bound`）。
 */
export const applyForKey = async (
  deviceId: string,
  transport: OursTransport,
  deviceFp = ''
): Promise<InviteApplyResult> => {
  const id = deviceId.trim()
  if (id === '') {
    return { kind: 'error', code: 'DEVICE_MISSING', messageKey: 'oursInviteErrDeviceMissing', retryable: false }
  }
  const result = await transport({
    method: 'POST',
    url: `${INVITE_API_BASE}/apply`,
    headers: withDeviceFp({ 'Content-Type': 'application/json', Accept: 'application/json' }, deviceFp),
    body: JSON.stringify({ device_id: id }),
    timeoutMs: INVITE_TIMEOUTS.apply,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { kind: 'error', ...transportFailure(result) }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  if (!isSuccessStatus(result.status)) {
    return { kind: 'error', ...failureFor(readErrorCode(body), result.status) }
  }
  const profile = parseInviteProfile(body)
  if (profile === null) {
    return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursInviteErrInvalidResponse', retryable: false }
  }
  const apiKey = readString(asRecord(body), 'key').trim()
  if (apiKey === '') {
    return { kind: 'error', code: 'KEY_MISSING', messageKey: 'oursInviteErrKeyMissing', retryable: true }
  }
  const record = asRecord(body)
  const serverDeviceId = readString(record, 'device_id').trim()
  const newUserGranted = readOptionalBoolean(record, 'new_user_granted')
  const deviceFpBound = readOptionalBoolean(record, 'device_fp_bound')
  const alreadyClaimed = readOptionalBoolean(record, 'already_claimed')
  const firstTime = result.status === 201
  return {
    kind: 'ok',
    profile,
    apiKey,
    firstTime,
    serverDeviceId,
    newUserGranted,
    deviceFpBound,
    alreadyClaimed,
    outcome: classifyClaim({
      firstTime,
      newUserGranted,
      deviceFpBound,
      alreadyClaimed,
      serverDeviceId,
      localDeviceId: id,
    }),
  }
}

export type InviteProfileResult =
  | {
      kind: 'ok'
      profile: InviteProfile
      /** 服务端回填的 device_id（#261，/me 现在也返回）；`''` = 老服务端没给 */
      serverDeviceId: string
    }
  | ({ kind: 'error' } & Failure)

/** 查档案与额度：GET /me?device_id=…（不含 key）。`deviceFp` 同上：有就带，没有就照旧。 */
export const fetchInviteProfile = async (
  deviceId: string,
  transport: OursTransport,
  deviceFp = ''
): Promise<InviteProfileResult> => {
  const id = deviceId.trim()
  if (id === '') {
    return { kind: 'error', code: 'DEVICE_MISSING', messageKey: 'oursInviteErrDeviceMissing', retryable: false }
  }
  const result = await transport({
    method: 'GET',
    url: `${INVITE_API_BASE}/me?device_id=${encodeURIComponent(id)}`,
    headers: withDeviceFp({ Accept: 'application/json' }, deviceFp),
    timeoutMs: INVITE_TIMEOUTS.profile,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { kind: 'error', ...transportFailure(result) }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  if (!isSuccessStatus(result.status)) {
    return { kind: 'error', ...failureFor(readErrorCode(body), result.status) }
  }
  const profile = parseInviteProfile(body)
  const serverDeviceId = readString(asRecord(body), 'device_id').trim()
  return profile === null
    ? { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursInviteErrInvalidResponse', retryable: false }
    : { kind: 'ok', profile, serverDeviceId }
}

export type InviteRedeemResult =
  | {
      kind: 'ok'
      rewardPoints: number
      /**
       * #234 新增字段：服务端没发就是 null（老服务端），界面按降级态处理。
       * 注意 rewardPoints === 0 在线上是**成功**（被邀请人不再得积分），不是失败。
       */
      rewardPointsInviter: number | null
      invitedCount: number | null
      maxInvites: number | null
      cashbackPoints: number | null
      inviteRules: InviteRules | null
      synced: boolean
      /** 响应里若直接带回档案就用它，否则由界面再查一次 /me */
      profile: InviteProfile | null
    }
  | ({ kind: 'error' } & Failure)

/** 邀请码规范化：用户可能贴小写/带空格；服务端的码是大写字母数字 */
export const normalizeInviteCode = (value: string): string => value.trim().toUpperCase()

/** 填别人的邀请码：POST /redeem（自己填自己的会被服务端 own_code 拒） */
export const redeemInviteCode = async (
  input: { deviceId: string; inviteCode: string },
  transport: OursTransport
): Promise<InviteRedeemResult> => {
  const id = input.deviceId.trim()
  const code = normalizeInviteCode(input.inviteCode)
  if (id === '') {
    return { kind: 'error', code: 'DEVICE_MISSING', messageKey: 'oursInviteErrDeviceMissing', retryable: false }
  }
  if (code === '') {
    return { kind: 'error', code: 'CODE_MISSING', messageKey: 'oursInviteErrCodeMissing', retryable: false }
  }
  const result = await transport({
    method: 'POST',
    url: `${INVITE_API_BASE}/redeem`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ device_id: id, invite_code: code }),
    timeoutMs: INVITE_TIMEOUTS.redeem,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return { kind: 'error', ...transportFailure(result) }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  if (!isSuccessStatus(result.status)) {
    return { kind: 'error', ...failureFor(readErrorCode(body), result.status) }
  }
  const record = asRecord(body)
  return {
    kind: 'ok',
    rewardPoints: readNumber(record, 'reward_points'),
    rewardPointsInviter: readOptionalNumber(record, 'reward_points_inviter'),
    invitedCount: readOptionalNumber(record, 'invited_count'),
    maxInvites: readOptionalNumber(record, 'max_invites'),
    cashbackPoints: readOptionalNumber(record, 'cashback_points'),
    inviteRules: parseInviteRules(record?.invite_rules),
    synced: readBoolean(record, 'synced'),
    profile: parseInviteProfile(body),
  }
}

/** 邀请码展示：保留原样（大写下按服务端），太短的当无效 */
export const isInviteCodeShape = (value: string): boolean => /^[A-Z0-9]{4,16}$/.test(normalizeInviteCode(value))

// ------------------------------------------------------------------ 卡密兑换迁本机池（Issue #72）

/**
 * 卡密兑换改打本机池：POST http://140.210.13.146:60013/redeem-card
 *
 * 为什么搬：旧链路 https://apia.ecsafe.cn/api/redeem 要走公网 + 跨机校验，实测直接超时
 * （curl: (28) timed out after 8015 ms, http_code=000）；本机池实测 0.98s 就能返回
 * 真实的业务错误码。旧接口保留为兜底，池不可达（网络层失败 / 路由不存在）时退回它。
 *
 * 请求体只有 {card_no, api_key}（池按卡号幂等，不需要 request_id）；
 * 旧接口仍要 request_id，且**固定传卡密本身**。
 */
export const REDEEM_POOL_URL = `${INVITE_API_BASE}/redeem-card`

export type RedeemVia = 'pool' | 'legacy'

export type RedeemCardResult =
  | {
      kind: 'success'
      points: number
      quotaPoints: number
      remainingPoints: number
      /** true = 这张卡之前已经兑换过（服务端幂等返回），按成功处理，不是错误 */
      duplicate: boolean
      cardTail: string
      via: RedeemVia
      messageKey?: 'oursRedeemDuplicate'
    }
  | {
      /** 202：服务端收下了，稍后自动到账。界面只显示「处理中」，不当错误、不提示换卡 */
      kind: 'pending'
      code: string
      cardTail: string
      via: RedeemVia
      messageKey?: 'oursRedeemProcessing'
    }
  | {
      kind: 'error'
      code: string
      messageKey: OursMessageKey
      cardTail: string
      retryable: boolean
      via: RedeemVia
    }

/** 池的错误码（小写 snake_case）→ 文案 key */
export const POOL_ERROR_KEYS: Record<string, OursMessageKey> = {
  card_not_found: 'oursErrCardNotFoundOrExpired',
  card_used: 'oursErrCardUsed',
  api_key_invalid: 'oursErrApiKeyNotIssued',
  card_missing: 'oursErrCardMissing',
  api_key_missing: 'oursErrKeyMissing',
  rate_limited: 'oursErrRateLimited',
}

const POOL_RETRYABLE = new Set(['rate_limited', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504'])

const cardTailOf = (cardNo: string): string => cardNo.trim().slice(-4)

/** 202 / CREDIT_PENDING / VERIFY_PENDING 都只有一种对外状态：处理中 */
const PENDING_CODES = new Set(['CREDIT_PENDING', 'VERIFY_PENDING'])

const poolFailure = (code: string, status: number): RedeemCardResult & { kind: 'error' } => ({
  kind: 'error',
  code: code || `HTTP_${status}`,
  messageKey: POOL_ERROR_KEYS[code] ?? 'oursErrUnknown',
  cardTail: '',
  retryable: POOL_RETRYABLE.has(code) || status >= 500,
  via: 'pool',
})

/**
 * 只打本机池：POST /redeem-card（baseUrl 可注入，供本地 stub 服务器验证报文）。
 * 不做任何兜底，兜底在 {@link redeemCardMigrated} 里。
 */
export const redeemCardAtPool = async (
  input: { cardNo: string; apiKey: string; baseUrl?: string },
  transport: OursTransport
): Promise<RedeemCardResult> => {
  const cardNo = input.cardNo.trim()
  const apiKey = input.apiKey.trim()
  const cardTail = cardTailOf(cardNo)
  if (cardNo === '') {
    return { kind: 'error', code: 'card_missing', messageKey: 'oursErrCardMissing', cardTail, retryable: false, via: 'pool' }
  }
  if (apiKey === '') {
    return { kind: 'error', code: 'api_key_missing', messageKey: 'oursErrKeyMissing', cardTail, retryable: false, via: 'pool' }
  }
  const result = await transport({
    method: 'POST',
    url: `${input.baseUrl ?? INVITE_API_BASE}/redeem-card`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ card_no: cardNo, api_key: apiKey }),
    timeoutMs: INVITE_TIMEOUTS.redeem,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return {
      kind: 'error',
      code: result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK',
      messageKey: result.kind === 'timeout' ? 'oursErrTimeout' : 'oursErrNetwork',
      cardTail,
      retryable: true,
      via: 'pool',
    }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  const code = readErrorCode(body)

  if (PENDING_CODES.has(code.toUpperCase()) || result.status === 202) {
    return { kind: 'pending', code: code || 'CREDIT_PENDING', cardTail, via: 'pool', messageKey: 'oursRedeemProcessing' }
  }
  if (!isSuccessStatus(result.status)) {
    // 404 但没有业务码 = 这条路由不存在（老部署 / 反代没配），交给调用方兜底旧接口
    if ((result.status === 404 || result.status === 405) && code === '') {
      return { kind: 'error', code: 'ROUTE_MISSING', messageKey: 'oursErrNotFound', cardTail, retryable: false, via: 'pool' }
    }
    return { ...poolFailure(code, result.status), cardTail }
  }
  const record = asRecord(body)
  if (record === null) {
    return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursErrInvalidResponse', cardTail, retryable: false, via: 'pool' }
  }
  const duplicate = readBoolean(record, 'duplicate')
  const points = readNumber(record, 'points')
  return {
    kind: 'success',
    points,
    quotaPoints: readNumber(record, 'quota_points'),
    remainingPoints: readNumber(record, 'remaining_points'),
    duplicate,
    cardTail,
    via: 'pool',
    ...(duplicate ? { messageKey: 'oursRedeemDuplicate' as const } : {}),
  }
}

/** 旧接口结果 → 新结构（兜底时用；request_id 固定用卡密） */
const fromLegacyResult = (result: Awaited<ReturnType<typeof redeemCardLegacy>>, cardNo: string): RedeemCardResult => {
  const cardTail = cardTailOf(cardNo)
  if (result.kind === 'success') {
    return {
      kind: 'success',
      points: result.points,
      quotaPoints: 0,
      remainingPoints: 0,
      duplicate: false,
      cardTail,
      via: 'legacy',
    }
  }
  if (result.kind === 'pending') {
    return { kind: 'pending', code: 'CREDIT_PENDING', cardTail, via: 'legacy', messageKey: 'oursRedeemProcessing' }
  }
  return {
    kind: 'error',
    code: result.code,
    messageKey: result.messageKey,
    cardTail,
    retryable: result.retryable,
    via: 'legacy',
  }
}

/**
 * 兑换卡密：先打本机池，只在**池这条链路本身不通**时兜底旧 /api/redeem。
 *
 * 业务错误（卡密不存在 / 已使用 / Key 无效 / 202 处理中）一律直接返回，不兜底：
 * 那说明请求已经到达服务端并被处理，再打一遍旧接口只会重复提交 + 等 8 秒超时。
 */
export const redeemCardMigrated = async (
  input: { cardNo: string; apiKey: string },
  transport: OursTransport
): Promise<RedeemCardResult> => {
  const pool = await redeemCardAtPool(input, transport)
  const unreachable =
    pool.kind === 'error' && (pool.code === 'NETWORK' || pool.code === 'TIMEOUT' || pool.code === 'ROUTE_MISSING')
  if (!unreachable) {
    return pool
  }
  const legacy = await redeemCardLegacy(
    {
      cardNo: input.cardNo.trim(),
      apiKey: input.apiKey.trim(),
      // 旧接口要求 request_id，且**固定用卡密本身**，重复提交也还是同一张单
      requestId: input.cardNo.trim(),
    },
    transport
  )
  return fromLegacyResult(legacy, input.cardNo)
}

// ------------------------------------------------------------------ device 自愈（Issue #72）

/**
 * 服务端「这个 device_id 我这儿没有」的两个码：
 *  - device_not_found（404）：这台设备的记录没了 → POST /apply 重新领取（幂等）并保存 key，再重试原请求
 *  - invalid_device（400）：本地存的 device_id 服务端不认 → 重新生成一个再重试
 *    实测（2026-11-19 curl 探针）：格式不合法的 device_id 服务端回的是 `bad_device_id`（400），
 *    不是文档/issue 里写的 `invalid_device`；两个码都认，处理与文案一致。
 *
 * 重试**只做一次**：第二次还失败就如实报错交给用户，绝不循环（避免把账号打爆 / 死循环）。
 * /me 本身是只读的、服务端不会自动建账，所以自愈只能在客户端做。
 */
const DEVICE_HEAL_NO_RETRY: Record<string, InviteMessageKey> = {
  rate_limited: 'oursInviteErrApplyRateLimited',
  already_redeemed: 'oursInviteErrAlreadyClaimed',
}

export type DeviceHealDeps = {
  deviceId: string
  transport: OursTransport
  /** 设备指纹哈希（Issue #243）：只上报，拿不到就空着，流程一字不改 */
  deviceFp?: string
  /** 自愈拿到的新 Key 存到哪里（界面注入：写进当前渠道配置） */
  saveKey?: (apiKey: string) => void
  /** 重新生成 + 持久化 device_id（界面注入；缺省用 createDeviceId 生成但不落盘） */
  regenerate?: (current: string) => string
  /** 服务端回填的 device_id 写回本地（界面注入：写 localStorage；缺省不落盘。Issue #261） */
  persistDeviceId?: (deviceId: string) => void
}

/** 成功那一支（把 {kind:'error'} 从联合里剔掉，界面直接拿 value.kind 收窄） */
type OkOf<T> = Exclude<T, { kind: 'error' }>

export type DeviceHealOutcome<T> =
  | { kind: 'ok'; value: OkOf<T>; deviceId: string; healed: boolean }
  | {
      kind: 'error'
      code: string
      messageKey: InviteMessageKey | OursMessageKey
      deviceId: string
      healed: boolean
    }

const asInviteKey = (value: string | undefined): InviteMessageKey | OursMessageKey =>
  (value ?? 'oursInviteErrUnknown') as InviteMessageKey

/**
 * 带自愈地执行一次设备相关请求。
 *
 * 成功 / 处理中 → 原样返回；device_not_found / invalid_device → 自愈一次再试；
 * 429、409 等语义错误 → 直接报错，不重试。
 */
export const runWithDeviceSelfHeal = async <T extends { kind: string; code?: string; messageKey?: string }>(
  deps: DeviceHealDeps,
  run: (deviceId: string) => Promise<T>
): Promise<DeviceHealOutcome<T>> => {
  const first = await run(deps.deviceId)
  if (first.kind !== 'error') {
    return { kind: 'ok', value: first as OkOf<T>, deviceId: deps.deviceId, healed: false }
  }
  const code = (first.code ?? '').trim()

  const noRetryKey = DEVICE_HEAL_NO_RETRY[code]
  if (noRetryKey !== undefined) {
    return { kind: 'error', code, messageKey: noRetryKey, deviceId: deps.deviceId, healed: false }
  }
  if (code !== 'device_not_found' && code !== 'invalid_device') {
    return { kind: 'error', code, messageKey: asInviteKey(first.messageKey), deviceId: deps.deviceId, healed: false }
  }

  let deviceId = deps.deviceId
  if (code === 'device_not_found') {
    const applied = await applyForKey(deviceId, deps.transport, deps.deviceFp ?? '')
    if (applied.kind === 'error') {
      return {
        kind: 'error',
        code: applied.code,
        messageKey: DEVICE_HEAL_NO_RETRY[applied.code] ?? applied.messageKey,
        deviceId,
        healed: false,
      }
    }
    // 自愈拿到的 Key 就是这个 device_id 的凭据，直接落盘（界面决定写哪儿）
    deps.saveKey?.(applied.apiKey)
    // #261：服务端可能给回另一个 device_id（原账号的），接着用它重试并写回本地
    const healed = applied.serverDeviceId.trim()
    if (healed !== '' && isDeviceId(healed) && healed !== deviceId) {
      deviceId = healed
      deps.persistDeviceId?.(healed)
    }
  } else {
    deviceId = (deps.regenerate?.(deviceId) ?? createDeviceId()).trim()
  }

  const retried = await run(deviceId)
  if (retried.kind !== 'error') {
    return { kind: 'ok', value: retried as OkOf<T>, deviceId, healed: true }
  }
  return {
    kind: 'error',
    code: retried.code ?? '',
    messageKey: DEVICE_HEAL_NO_RETRY[retried.code ?? ''] ?? asInviteKey(retried.messageKey),
    deviceId,
    healed: true,
  }
}
// ------------------------------------------------------------------ 邮箱账号（Issue #421）

/**
 * 邮箱账号层：绑定邮箱 / 换机用邮箱登录。
 *
 * 服务端契约见 #421 与后端仓库 `docs/email-api.md`（分支 `feat/email-signup`）。
 * **生产尚未启用**：功能未开启时三个路径都返回 `404 not_found`，客户端据此隐藏入口。
 * 别把它和同是 404 的 `device_not_found` 混了 —— 后者是「这台设备服务端没记录」（该走自愈），
 * 前者是「这台服务器没有邮箱功能」（该隐藏入口）。
 *
 * 这一层只做三件事：
 *  1. 发请求：沿用手上这套（INVITE_API_BASE / withDeviceFp / INVITE_TIMEOUTS），不另起请求栈，
 *     头、超时、错误分类与 /apply、/me 完全一致；
 *  2. 把 error 体里的 code 与附加字段翻成文案 key；
 *  3. 把 action / device_id / key 原样交出去 —— **采用**（写回本地设备码、落 Key）在
 *     `services/invite/email.ts` 里走 `adoptServerDeviceId` / `bindSuccessKey` 那条既有路径，
 *     这里绝不自己写一套覆盖逻辑。
 *
 * 登录冲突（`device_has_account`）在这里被翻成 {@link EmailConflict} 而不是普通错误：
 * 弹窗与「带 choice 重发」的交互在界面层，本层只负责把 `email_masked` /
 * `device_remaining_points` / `options` 如实交出去（验证码此时尚未消耗）。
 *
 * 明确不做（#421 范围外）：**自动合并账号**（服务端不合并，数据保留、需客服处理）、支付链路改动。
 */

/** 邮箱接口的文案 key：错误码表 + 复用既有的网络 / 超时 / 响应异常文案 */
export type EmailMessageKey =
  | InviteMessageKey
  | 'oursInviteErrEmailInvalid'
  | 'oursInviteErrEmailDomainBlocked'
  | 'oursInviteErrEmailCodeInvalid'
  | 'oursInviteErrEmailCodeExpired'
  | 'oursInviteErrEmailCodeLocked'
  | 'oursInviteErrEmailTooFrequent'
  | 'oursInviteErrEmailHourLimit'
  | 'oursInviteErrIpHourLimit'
  | 'oursInviteErrDeviceHourLimit'
  | 'oursInviteErrEmailDailyCap'
  | 'oursInviteErrEmailSendFailed'
  | 'oursInviteErrCustomerHasEmail'
  | 'oursInviteErrAccountFrozen'
  // #421 第 3 点：本机已有账号、又要用邮箱登录已有账号 —— 交给冲突弹窗处理（见 EmailConflict），
  // 这条 key 只在它意外出现在别的路径时兜底，别让用户看到中性的「操作失败」。
  | 'oursInviteErrEmailDeviceHasAccount'

/**
 * 服务端错误码 → 文案 key（#421 表格逐条对应）。
 *
 * **必须先用这张表匹配 error.code，匹配不到才退回 EMAIL_STATUS_KEYS。**
 * 原因是 409 在两条链路里语义完全不同：
 *  - /redeem 的 409 → 「已绑定过邀请码」（oursInviteErrAlreadyRedeemed，见 INVITE_STATUS_KEYS）；
 *  - /email/* 的 409 customer_has_email → 「本账号已绑过邮箱」。
 * 先按状态码查就会把后者显示成前者，用户看到的是「邀请码已绑定」，纯误导。
 */
export const EMAIL_ERROR_KEYS: Record<string, EmailMessageKey> = {
  bad_email: 'oursInviteErrEmailInvalid',
  email_domain_blocked: 'oursInviteErrEmailDomainBlocked',
  code_invalid: 'oursInviteErrEmailCodeInvalid',
  code_expired: 'oursInviteErrEmailCodeExpired',
  code_locked: 'oursInviteErrEmailCodeLocked',
  too_frequent: 'oursInviteErrEmailTooFrequent',
  email_hour_limit: 'oursInviteErrEmailHourLimit',
  ip_hour_limit: 'oursInviteErrIpHourLimit',
  device_hour_limit: 'oursInviteErrDeviceHourLimit',
  email_daily_cap: 'oursInviteErrEmailDailyCap',
  send_failed: 'oursInviteErrEmailSendFailed',
  customer_has_email: 'oursInviteErrCustomerHasEmail',
  account_frozen: 'oursInviteErrAccountFrozen',
  // #421 第 3 点：正常路径由 verifyEmailCode 翻成 EmailConflict（弹窗让用户选），
  // 这里留着只为「别的路径意外回了它」时别落到中性的「操作失败」。
  device_has_account: 'oursInviteErrEmailDeviceHasAccount',
  // 同一台服务上的既有码：/email/* 也会回它们（尤其 /email/status 的 404 device_not_found）。
  // 不映射就会落到中性的「操作失败」，对用户没有任何下一步指引 —— 复用既有文案，不新造。
  device_not_found: 'oursInviteErrDeviceNotFound',
  bad_device_id: 'oursInviteErrDeviceMissing',
  invalid_device: 'oursInviteErrDeviceMissing',
  rate_limited: 'oursInviteErrRateLimited',
}

/**
 * 只有状态码、没有可识别 code 时的兜底。
 *
 * 刻意**不挂** INVITE_STATUS_KEYS：那张表的 409 是「已绑定过邀请码」，
 * 邮箱这条链路用它会误报（见 EMAIL_ERROR_KEYS 的说明）。400 / 409 一律给中性文案。
 */
export const EMAIL_STATUS_KEYS: Record<number, EmailMessageKey> = {
  400: 'oursInviteErrUnknown',
  403: 'oursInviteErrAccountFrozen',
  409: 'oursInviteErrUnknown',
  429: 'oursInviteErrEmailTooFrequent',
  502: 'oursInviteErrEmailSendFailed',
  503: 'oursInviteErrEmailDailyCap',
}

/** 错误体里的附加字段（#421 表格最后一列）：有就展示，没有就是 null */
export type EmailErrorExtras = {
  /** code_invalid / code_locked：这个验证码还剩几次机会 */
  attemptsLeft: number | null
  /** too_frequent / *_hour_limit：多少秒后可以再发 */
  retryAfter: number | null
  /** customer_has_email：本账号已绑的那个脱敏邮箱 */
  boundEmailMasked: string | null
  /**
   * device_has_account：本机原账号还剩多少积分（#421 第 3 点要求**必须展示**）。
   * 冲突弹窗用它告诉用户「切换后这部分额度暂时用不了」；非冲突路径一律 null。
   */
  deviceRemainingPoints: number | null
  /** device_has_account：这次要换上的那个脱敏邮箱（与 bound_email_masked 是两个字段，别混） */
  conflictEmailMasked: string | null
}

export type EmailError = {
  kind: 'error'
  code: string
  messageKey: EmailMessageKey
  retryable: boolean
} & EmailErrorExtras

const NO_EMAIL_EXTRAS: EmailErrorExtras = {
  attemptsLeft: null,
  retryAfter: null,
  boundEmailMasked: null,
  deviceRemainingPoints: null,
  conflictEmailMasked: null,
}

/**
 * 附加字段的位置：优先 error 里面（契约写法），其次顶层（服务端换位置时不至于丢）。
 * 只读字段，不做任何推断。
 */
const emailFieldSources = (body: unknown): Record<string, unknown>[] => {
  const record = asRecord(body)
  if (record === null) {
    return []
  }
  const nested = asRecord(record.error)
  return nested === null ? [record] : [nested, record]
}

const emailExtras = (body: unknown): EmailErrorExtras => {
  const sources = emailFieldSources(body)
  const pick = <T>(read: (record: Record<string, unknown>) => T | null): T | null => {
    for (const source of sources) {
      const value = read(source)
      if (value !== null) {
        return value
      }
    }
    return null
  }
  return {
    attemptsLeft: pick((record) => readOptionalNumber(record, 'attempts_left')),
    retryAfter: pick((record) => readOptionalNumber(record, 'retry_after')),
    boundEmailMasked: pick((record) => readOptionalString(record, 'bound_email_masked')),
    deviceRemainingPoints: pick((record) => readOptionalNumber(record, 'device_remaining_points')),
    conflictEmailMasked: pick((record) => readOptionalString(record, 'email_masked')),
  }
}

/** 频控 / 发信失败可以原样重试；语义错误（格式、验证码、已绑过）重试没意义 */
const EMAIL_RETRYABLE_CODES = new Set([
  'too_frequent',
  'email_hour_limit',
  'ip_hour_limit',
  'device_hour_limit',
  'email_daily_cap',
  'send_failed',
  'rate_limited',
])

const emailFailure = (code: string, status: number, body: unknown): EmailError => ({
  kind: 'error',
  code: code === '' ? `HTTP_${status}` : code,
  // code 优先，状态码兜底（#421 对 409 的硬要求）
  messageKey: EMAIL_ERROR_KEYS[code] ?? EMAIL_STATUS_KEYS[status] ?? 'oursInviteErrUnknown',
  retryable: EMAIL_RETRYABLE_CODES.has(code) || status >= 500,
  ...emailExtras(body),
})

const emailTransportFailure = (
  result: Exclude<OursHttpResult, { kind: 'response' }>
): EmailError => ({ kind: 'error', ...transportFailure(result), ...NO_EMAIL_EXTRAS })

/** 6 位数字验证码（纯形状判断，界面用来禁用按钮；服务端仍会再判一次） */
export const isEmailCodeShape = (value: string): boolean => /^\d{6}$/.test(value.trim())

/** 邮箱形状：只做「像不像」的判断，真实校验在服务端（bad_email / email_domain_blocked） */
export const isEmailShape = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

export type EmailSendCodeResult = { kind: 'ok'; resendAfter: number | null } | EmailError

/**
 * 发验证码：POST /email/send-code，入参 device_id、email，可带 X-Device-Fp。
 * 频控不在这里算：服务端回 too_frequent + retry_after，界面照那个数字倒计时。
 */
export const sendEmailCode = async (
  input: { deviceId: string; email: string },
  transport: OursTransport,
  deviceFp = ''
): Promise<EmailSendCodeResult> => {
  const id = input.deviceId.trim()
  const email = input.email.trim()
  if (id === '') {
    return {
      kind: 'error',
      code: 'DEVICE_MISSING',
      messageKey: 'oursInviteErrDeviceMissing',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  if (email === '') {
    return {
      kind: 'error',
      code: 'EMAIL_MISSING',
      messageKey: 'oursInviteErrEmailInvalid',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  const result = await transport({
    method: 'POST',
    url: `${INVITE_API_BASE}/email/send-code`,
    headers: withDeviceFp(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      deviceFp
    ),
    body: JSON.stringify({ device_id: id, email }),
    timeoutMs: INVITE_TIMEOUTS.emailSend,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return emailTransportFailure(result)
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  if (!isSuccessStatus(result.status)) {
    return emailFailure(readErrorCode(body), result.status, body)
  }
  return { kind: 'ok', resendAfter: readOptionalNumber(asRecord(body), 'resend_after') }
}

/** 服务端告诉客户端这次是「绑定」还是「登录」（/email/verify 的 action） */
export type EmailVerifyAction = 'bound' | 'login'

/** #421 第 3 点：冲突时用户可以选的两个方向（就是服务端 `options` 里的字面量） */
export type EmailChoice = 'use_email' | 'keep_device'

/** 契约里只定义了这两个选项；顺序即界面按钮顺序（`use_email` 在前） */
export const EMAIL_CHOICES: readonly EmailChoice[] = ['use_email', 'keep_device']

/**
 * 登录冲突（`device_has_account`，HTTP 409）。
 *
 * 关键事实：此时**验证码尚未被消耗** —— 服务端等客户端带同一个验证码 + `choice` 再请求一次。
 * 所以这里既不是「绑定成功」也不是「失败」，必须让用户显式选一个方向：
 *  - `use_email`   用邮箱账号（本机原账号的额度暂时用不了，服务端不自动合并）；
 *  - `keep_device` 保留本机账号（放弃这次邮箱登录）。
 */
export type EmailConflict = {
  kind: 'conflict'
  /** 这次要换上的那个脱敏邮箱（服务端 `email_masked`）；没回就是 null */
  emailMasked: string | null
  /** 本机原账号剩余额度（服务端 `device_remaining_points`）：**必须展示** */
  deviceRemainingPoints: number | null
  /** 服务端允许的选项；没给 / 给坏时按契约的两个都给 */
  options: EmailChoice[]
}

/** 冲突响应里的 `options`：只认契约里的两个字面量，其余一律忽略 */
const parseEmailChoices = (body: unknown): EmailChoice[] => {
  for (const source of emailFieldSources(body)) {
    const raw = source.options
    if (!Array.isArray(raw)) {
      continue
    }
    const picked = EMAIL_CHOICES.filter((choice) => raw.includes(choice))
    if (picked.length > 0) {
      return picked
    }
  }
  return [...EMAIL_CHOICES]
}

const emailConflict = (body: unknown): EmailConflict => {
  const extras = emailExtras(body)
  return {
    kind: 'conflict',
    emailMasked: extras.conflictEmailMasked,
    deviceRemainingPoints: extras.deviceRemainingPoints,
    options: parseEmailChoices(body),
  }
}

export type EmailVerifyResult =
  | {
      kind: 'ok'
      action: EmailVerifyAction
      /**
       * 服务端在响应里回填的 device_id（'' = 没回）。
       * action: 'login' 时它就是**原账号**的设备码 —— 采用动作在 services/invite/email.ts，
       * 走 adoptServerDeviceId（合法才写、相同不写），本函数不碰存储。
       */
      serverDeviceId: string
      /** action: 'login' 时是新凭据；bound 时通常没有。绝不记录、绝不进文案 */
      apiKey: string
      /** 服务端 email_masked；没有就退回档案里的同名字段 */
      emailMasked: string | null
      /** 服务端 has_email（同三态）；没有就退回档案里的同名字段 */
      hasEmail: boolean | null
      /** 响应里若顺带回了档案就用它，否则 null（界面再查一次 /me） */
      profile: InviteProfile | null
    }
  /** #421 第 3 点：本机已有账号 → 弹窗让用户选，验证码留着没消耗 */
  | EmailConflict
  | EmailError

/**
 * 提交验证码：POST /email/verify，入参 device_id、email、code（冲突确认时再加 `choice`）。
 * 绑定还是登录**由服务端判定**，客户端只看 action（#421：不要自己猜）。
 *
 * `choice` 只在「用户已经在那张冲突弹窗上点过按钮」时才带：同一个验证码重发一次，
 * 服务端据此决定到底换不换账号。第一次提交（`choice` 不给）绝不能带 —— 那是替用户先选了。
 *
 * action 缺失 / 不是 bound|login 一律按响应异常处理：那是契约变了，
 * 猜一个的后果是「该换设备码却没换」或反之，两种都比报错难查。
 */
export const verifyEmailCode = async (
  input: { deviceId: string; email: string; code: string; choice?: EmailChoice },
  transport: OursTransport,
  deviceFp = ''
): Promise<EmailVerifyResult> => {
  const id = input.deviceId.trim()
  const email = input.email.trim()
  const code = input.code.trim()
  if (id === '') {
    return {
      kind: 'error',
      code: 'DEVICE_MISSING',
      messageKey: 'oursInviteErrDeviceMissing',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  if (email === '') {
    return {
      kind: 'error',
      code: 'EMAIL_MISSING',
      messageKey: 'oursInviteErrEmailInvalid',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  if (code === '') {
    return {
      kind: 'error',
      code: 'CODE_MISSING',
      messageKey: 'oursInviteErrEmailCodeInvalid',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  const result = await transport({
    method: 'POST',
    url: `${INVITE_API_BASE}/email/verify`,
    headers: withDeviceFp(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      deviceFp
    ),
    // `choice` 只在冲突弹窗上点过按钮后才有；第一次提交不带（不替用户先做决定）
    body: JSON.stringify(
      input.choice === undefined
        ? { device_id: id, email, code }
        : { device_id: id, email, code, choice: input.choice }
    ),
    timeoutMs: INVITE_TIMEOUTS.emailVerify,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return emailTransportFailure(result)
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  const bodyRecord = asRecord(body)
  if (!isSuccessStatus(result.status)) {
    const code = readErrorCode(body)
    // #421 第 3 点：本机已有账号 + 邮箱是已有账号 = 冲突，**不是失败**
    // （验证码此时没被消耗，界面弹窗让用户选，然后带同一个验证码 + choice 再来一次）
    if (code === 'device_has_account') {
      return emailConflict(body)
    }
    return emailFailure(code, result.status, body)
  }
  const action = readString(bodyRecord, 'action').trim()
  if (action !== 'bound' && action !== 'login') {
    return {
      kind: 'error',
      code: 'INVALID_RESPONSE',
      messageKey: 'oursInviteErrInvalidResponse',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  const profile = parseInviteProfile(body)
  return {
    kind: 'ok',
    action,
    serverDeviceId: readString(bodyRecord, 'device_id').trim(),
    apiKey: readString(bodyRecord, 'key').trim(),
    emailMasked: readOptionalString(bodyRecord, 'email_masked') ?? profile?.emailMasked ?? null,
    hasEmail: readOptionalBoolean(bodyRecord, 'has_email') ?? profile?.hasEmail ?? null,
    profile,
  }
}

export type EmailStatusResult =
  | {
      kind: 'ok'
      /** 三态：true 已绑 / false 明确没绑 / null 服务端没发这个字段 */
      hasEmail: boolean | null
      emailMasked: string | null
    }
  /** 服务端没有邮箱功能（404 + not_found）→ 界面隐藏入口，旧流程一字不动 */
  | { kind: 'disabled' }
  | EmailError

/**
 * 查本机账号是否已绑邮箱：GET /email/status?device_id=（只读，不返回 Key）。
 *
 * 入口探测的唯一判据（#421 第 4 点）：
 *  - 404 + error.code === 'not_found' → disabled（隐藏入口）；
 *  - 404 + device_not_found → 普通错误（那是「这台设备没记录」，该走自愈 / 提示领取），
 *    **绝不能**当成「功能没开」把入口藏掉。
 */
export const fetchEmailStatus = async (
  deviceId: string,
  transport: OursTransport,
  deviceFp = ''
): Promise<EmailStatusResult> => {
  const id = deviceId.trim()
  if (id === '') {
    return {
      kind: 'error',
      code: 'DEVICE_MISSING',
      messageKey: 'oursInviteErrDeviceMissing',
      retryable: false,
      ...NO_EMAIL_EXTRAS,
    }
  }
  const result = await transport({
    method: 'GET',
    url: `${INVITE_API_BASE}/email/status?device_id=${encodeURIComponent(id)}`,
    headers: withDeviceFp({ Accept: 'application/json' }, deviceFp),
    timeoutMs: INVITE_TIMEOUTS.emailStatus,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    return emailTransportFailure(result)
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? parsed.value : null
  const code = readErrorCode(body)
  if (result.status === 404 && code === 'not_found') {
    return { kind: 'disabled' }
  }
  if (!isSuccessStatus(result.status)) {
    return emailFailure(code, result.status, body)
  }
  const record = asRecord(body)
  return {
    kind: 'ok',
    hasEmail: readOptionalBoolean(record, 'has_email'),
    emailMasked: readOptionalString(record, 'email_masked'),
  }
}

/**
 * 入口要不要出现：只有「探测成功」才显示。
 *
 * disabled（服务端没开）与探测失败（网络 / 超时 / 老部署 404 没业务码）一律不显示 ——
 * 宁可不出现入口，也不能给一个点了就报错的按钮。
 */
export const shouldShowEmailEntry = (result: EmailStatusResult): boolean => result.kind === 'ok'

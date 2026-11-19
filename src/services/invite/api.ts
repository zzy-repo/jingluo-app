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

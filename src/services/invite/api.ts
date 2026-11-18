/**
 * 邀请 / 额度服务的客户端契约层（纯逻辑，网络通过注入的 transport 发出）。
 *
 * 服务端：http://62.106.70.167:60013 —— **明文 HTTP**（同一台机器上的对话上游也是 http，
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
 *        → 200 { …, reward_points, synced }
 *        → 错误码：device_not_found(404) invalid_code(404) own_code(400)
 *                  already_redeemed(409) code_exhausted(409) rate_limited(429)
 *   错误格式统一为 { "error": { "code": "...", "message": "..." } }
 *
 * 额度口径：**remaining_points 就是可消费积分**，1 元 = 100 积分。
 * 不要用卡密服务的 /api/balance 当余额（它只回答 Key 是否有效）。
 */

import type { OursHttpResult, OursTransport } from '../ours/api.js'

/**
 * 邀请 / 额度服务地址：明文 HTTP，见文件头的安全说明。
 * ⚠️ 测试构建（TEST_INVITE_API_BASE）可覆盖为本地 mock；正式构建该常量为空串，行为不变。
 */
export const INVITE_API_BASE: string =
  (typeof __TEST_INVITE_API_BASE__ === 'undefined' ? '' : __TEST_INVITE_API_BASE__).trim() ||
  'http://62.106.70.167:60013'

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
  | 'oursInviteErrCodeMissing'
  | 'oursInviteErrDeviceMissing'
  | 'oursInviteErrNetwork'
  | 'oursInviteErrTimeout'
  | 'oursInviteErrInvalidResponse'
  | 'oursInviteErrKeyMissing'
  | 'oursInviteErrUnknown'
  | 'oursErrInvalidResponse'

/** 服务端错误码 → 文案 key（code 优先，其次按状态码兜底） */
export const INVITE_ERROR_KEYS: Record<string, InviteMessageKey> = {
  device_not_found: 'oursInviteErrDeviceNotFound',
  invalid_code: 'oursInviteErrInvalidCode',
  own_code: 'oursInviteErrOwnCode',
  already_redeemed: 'oursInviteErrAlreadyRedeemed',
  code_exhausted: 'oursInviteErrCodeExhausted',
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
}

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false } => {
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const readString = (record: Record<string, unknown> | null, field: string): string => {
  const value = record?.[field]
  return typeof value === 'string' ? value : ''
}

const readNumber = (record: Record<string, unknown> | null, field: string): number => {
  const value = record?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const readBoolean = (record: Record<string, unknown> | null, field: string): boolean =>
  record?.[field] === true

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300

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
  }
}

/** 错误体解析：{ error: { code, message } }（兼容顶层 { code }） */
const readErrorCode = (value: unknown): string => {
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
    }
  | ({ kind: 'error' } & Failure)

/**
 * 领取 Key：POST /apply。
 * 同一 device_id 幂等（201 首次 / 200 已申请），所以失败后可以直接重试同一请求。
 */
export const applyForKey = async (
  deviceId: string,
  transport: OursTransport
): Promise<InviteApplyResult> => {
  const id = deviceId.trim()
  if (id === '') {
    return { kind: 'error', code: 'DEVICE_MISSING', messageKey: 'oursInviteErrDeviceMissing', retryable: false }
  }
  const result = await transport({
    method: 'POST',
    url: `${INVITE_API_BASE}/apply`,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
  return { kind: 'ok', profile, apiKey, firstTime: result.status === 201 }
}

export type InviteProfileResult = ({ kind: 'ok'; profile: InviteProfile } | { kind: 'error' } & Failure)

/** 查档案与额度：GET /me?device_id=…（不含 key） */
export const fetchInviteProfile = async (
  deviceId: string,
  transport: OursTransport
): Promise<InviteProfileResult> => {
  const id = deviceId.trim()
  if (id === '') {
    return { kind: 'error', code: 'DEVICE_MISSING', messageKey: 'oursInviteErrDeviceMissing', retryable: false }
  }
  const result = await transport({
    method: 'GET',
    url: `${INVITE_API_BASE}/me?device_id=${encodeURIComponent(id)}`,
    headers: { Accept: 'application/json' },
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
  return profile === null
    ? { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursInviteErrInvalidResponse', retryable: false }
    : { kind: 'ok', profile }
}

export type InviteRedeemResult =
  | {
      kind: 'ok'
      rewardPoints: number
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
    synced: readBoolean(record, 'synced'),
    profile: parseInviteProfile(body),
  }
}

/** 邀请码展示：保留原样（大写下按服务端），太短的当无效 */
export const isInviteCodeShape = (value: string): boolean => /^[A-Z0-9]{4,16}$/.test(normalizeInviteCode(value))

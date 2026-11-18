/**
 * 「我已经有 Key」——把**已有的** Key 绑定到本机设备码（Issue #86）。
 *
 * 与 /apply（服务端给你的设备**发**一把 Key）是两条不同的链路：
 *   POST http://140.210.13.146:60013/bind   Content-Type: application/json
 *        { "device_id": "d-xxxxxxxxxxxxxxxx", "api_key": "sk-live-..." }
 *     → 200 { customer_id, invite_code, key, already_bound, adopted_points, bonus_points,
 *             invited_count, max_invites, quota_points, used_points, remaining_points, key_status }
 *     → 400 invalid_device / 400 invalid_api_key / 409 key_already_bound / 409 device_already_bound
 *   错误格式与邀请服务一致：{ "error": { "code": "...", "message": "..." } }
 *
 * 三条不能踩的线（都是 issue 的关闭条件）：
 *  1. **already_bound:true 是成功**，不是错误：同一把 Key 再绑一次，服务端只是重复确认。
 *     所以对外只有一条成功文案（{@link bindSuccessKey}），文案里不出现「已绑定过」。
 *  2. **adopted_points 不给用户看**：它是服务端内部的折算/迁移值，本文件连解析都不解析，
 *     界面上也就没有可显示的入口。额度一律只看 remaining_points（与 #75 的口径一致）。
 *  3. **兜底只兜链路不通**：只在 NETWORK / TIMEOUT / ROUTE_MISSING 时换 https 备用域名；
 *     业务错误（400/409）说明请求已经到服务端并被处理，绝不重发。
 *
 * 网络一律走注入的 transport（原生 CapacitorHttp / Web fetch，见 ours/transport.ts），
 * 因此本文件是纯逻辑，可在 Node 单测里用假 transport 断言「发了什么、怎么解释响应」。
 * 设备码与 Key 不进日志、不进错误文案（文案里最多出现 Key 末几位，见调用方）。
 */

import type { OursTransport } from '../ours/api.js'
import {
  INVITE_API_BASE,
  asRecord,
  isSuccessStatus,
  parseJson,
  readBoolean,
  readErrorCode,
  readNumber,
  readString,
} from './api.js'
import { loadOrCreateDeviceId, type DeviceIdState, type DeviceIdStorage, type RandomBytes } from './device.js'

/** 主链路：与设备码 / 邀请 / 额度同一台机器（明文 HTTP） */
export const BIND_URL = `${INVITE_API_BASE}/bind`

/** 备用域名：主链路整条不通（DNS / 反代没配 / 超时）时用，HTTPS */
export const BIND_FALLBACK_URL = 'https://apia.ecsafe.cn/invite/bind'

export const BIND_TIMEOUTS = {
  bind: 15000,
} as const

/** 界面文案 key（与 i18n/zh.ts 一致；服务层只回 key，不拼文案） */
export type BindMessageKey =
  | 'oursBindErrInvalidDevice'
  | 'oursBindErrInvalidApiKey'
  | 'oursBindErrKeyAlreadyBound'
  | 'oursBindErrDeviceAlreadyBound'
  | 'oursBindErrDeviceMissing'
  | 'oursBindErrKeyMissing'
  | 'oursBindErrNoKeyInResponse'
  | 'oursBindErrRateLimited'
  | 'oursBindErrNetwork'
  | 'oursBindErrTimeout'
  | 'oursBindErrInvalidResponse'
  | 'oursBindErrUnknown'

/**
 * 服务端错误码 → 文案 key。
 *
 * 四个主码逐字对应 issue 的表格；其余是防御性兜底（服务端换拼写时不至于显示英文码）。
 */
export const BIND_ERROR_KEYS: Record<string, BindMessageKey> = {
  invalid_device: 'oursBindErrInvalidDevice',
  // 实测（2026-11-19 curl 探针）：格式不合法的 device_id 返回的是 bad_device_id，不是 issue 写的
  // invalid_device。两种都认，文案一致。
  bad_device_id: 'oursBindErrInvalidDevice',
  invalid_api_key: 'oursBindErrInvalidApiKey',
  api_key_invalid: 'oursBindErrInvalidApiKey',
  key_already_bound: 'oursBindErrKeyAlreadyBound',
  device_already_bound: 'oursBindErrDeviceAlreadyBound',
  key_missing: 'oursBindErrKeyMissing',
  device_missing: 'oursBindErrDeviceMissing',
  rate_limited: 'oursBindErrRateLimited',
}

/**
 * 只有状态码、没有 code 时的兜底文案。
 *
 * 400 / 409 在 /bind 上是二义的（设备异常还是 Key 异常？Key 已被占用还是本机已占用？），
 * 猜错会让用户按错误的指引操作，所以一律给「绑定失败，请重试」+ 可重试。
 */
export const BIND_STATUS_KEYS: Record<number, BindMessageKey> = {
  429: 'oursBindErrRateLimited',
  400: 'oursBindErrUnknown',
  409: 'oursBindErrUnknown',
  500: 'oursBindErrUnknown',
}

export type BindVia = 'primary' | 'fallback'

/** 一次绑定的结果：成功只有一种形状，already_bound 也在里面（不是错误） */
export type BindResult =
  | {
      kind: 'ok'
      /** 服务端返回的 Key：与用户粘贴的是同一把，直接覆盖本地即可 */
      apiKey: string
      customerId: number
      inviteCode: string
      /** true = 这把 Key 之前就绑在这台设备上（重复提交），照样是成功 */
      alreadyBound: boolean
      keyStatus: string
      quotaPoints: number
      usedPoints: number
      remainingPoints: number
      via: BindVia
      /** 走了兜底时，主链路的失败原因（NETWORK/TIMEOUT/ROUTE_MISSING），只用于排查，不展示 */
      primaryFailure?: string
    }
  | {
      kind: 'error'
      code: string
      messageKey: BindMessageKey
      retryable: boolean
      via: BindVia
    }

/**
 * 成功文案只有一条。
 *
 * `already_bound:true` 是同一件事的重复确认，必须与首次绑定一模一样地显示「绑定成功」——
 * 提示「已绑定过」会让用户以为这次没生效，进而反复点击（issue 关闭条件 4）。
 */
export const bindSuccessKey = (outcome: { alreadyBound: boolean }): 'oursBindOk' => {
  if (outcome.alreadyBound) {
    // 重复提交：绑定早就生效了，说的还是「绑定成功」（不是「已绑定过」，那会让用户以为没生效）
    return 'oursBindOk'
  }
  return 'oursBindOk'
}

/** 只有这三种能换域名重试；其余（含业务错误）说明请求已经到服务端，不重发 */
const FALLBACK_CODES = new Set(['NETWORK', 'TIMEOUT', 'ROUTE_MISSING'])

const bindFailure = (code: string, status: number, via: BindVia): BindResult => ({
  kind: 'error',
  code: code === '' ? `HTTP_${status}` : code,
  messageKey: BIND_ERROR_KEYS[code] ?? BIND_STATUS_KEYS[status] ?? 'oursBindErrUnknown',
  retryable: code === 'NETWORK' || code === 'TIMEOUT' || status >= 500,
  via,
})

/** 只打一个地址，不做兜底（兜底在 {@link bindExistingKey} 里） */
const bindAt = async (
  input: { deviceId: string; apiKey: string; url: string; via: BindVia },
  transport: OursTransport
): Promise<BindResult> => {
  const result = await transport({
    method: 'POST',
    url: input.url,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ device_id: input.deviceId, api_key: input.apiKey }),
    timeoutMs: BIND_TIMEOUTS.bind,
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    const code = result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK'
    return {
      kind: 'error',
      code,
      messageKey: result.kind === 'timeout' ? 'oursBindErrTimeout' : 'oursBindErrNetwork',
      retryable: true,
      via: input.via,
    }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const code = readErrorCode(body)

  if (!isSuccessStatus(result.status)) {
    // 404/405 且没有业务码 = 这条路由不存在（老部署 / 反代没配），交给调用方换域名
    if ((result.status === 404 || result.status === 405) && code === '') {
      return { kind: 'error', code: 'ROUTE_MISSING', messageKey: 'oursBindErrUnknown', retryable: false, via: input.via }
    }
    return bindFailure(code, result.status, input.via)
  }
  if (body === null) {
    return { kind: 'error', code: 'INVALID_RESPONSE', messageKey: 'oursBindErrInvalidResponse', retryable: false, via: input.via }
  }
  const apiKey = readString(body, 'key')
  if (apiKey === '') {
    // 200 却没给 Key：绑定等于没发生，必须当失败（否则本地保存一把空 Key）
    return {
      kind: 'error',
      code: 'KEY_MISSING',
      messageKey: 'oursBindErrNoKeyInResponse',
      retryable: false,
      via: input.via,
    }
  }
  return {
    kind: 'ok',
    apiKey,
    customerId: readNumber(body, 'customer_id'),
    inviteCode: readString(body, 'invite_code'),
    alreadyBound: readBoolean(body, 'already_bound'),
    keyStatus: readString(body, 'key_status'),
    quotaPoints: readNumber(body, 'quota_points'),
    usedPoints: readNumber(body, 'used_points'),
    remainingPoints: readNumber(body, 'remaining_points'),
    via: input.via,
  }
}

/**
 * 把已有 Key 绑到本机设备码。
 *
 * 本地能判断的错（没设备码 / 没粘贴 Key）先拦下，一个请求都不发。
 * 主链路只在「链路本身不通」时换备用域名重打一次，最多两次请求。
 */
export const bindExistingKey = async (
  input: { deviceId: string; apiKey: string },
  transport: OursTransport
): Promise<BindResult> => {
  const deviceId = input.deviceId.trim()
  const apiKey = input.apiKey.trim()
  if (deviceId === '') {
    return { kind: 'error', code: 'DEVICE_MISSING', messageKey: 'oursBindErrDeviceMissing', retryable: false, via: 'primary' }
  }
  if (apiKey === '') {
    return { kind: 'error', code: 'API_KEY_MISSING', messageKey: 'oursBindErrKeyMissing', retryable: false, via: 'primary' }
  }
  const primary = await bindAt({ deviceId, apiKey, url: BIND_URL, via: 'primary' }, transport)
  if (primary.kind === 'ok' || !FALLBACK_CODES.has(primary.code)) {
    return primary
  }
  const fallback = await bindAt({ deviceId, apiKey, url: BIND_FALLBACK_URL, via: 'fallback' }, transport)
  if (fallback.kind === 'ok') {
    return { ...fallback, primaryFailure: primary.code }
  }
  return fallback
}

/**
 * 绑定时要用的设备码：本地持久化的那个；没有 / 非法则按 #72 的规则生成并落盘。
 *
 * 与 /apply、/me 共用同一个存储 key，所以「申请过 Key 的设备」重新绑定绑的还是同一台设备。
 */
export const resolveBindDeviceId = (storage: DeviceIdStorage, randomBytes?: RandomBytes): DeviceIdState =>
  loadOrCreateDeviceId(storage, randomBytes)

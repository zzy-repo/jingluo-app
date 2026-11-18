/**
 * 换一把 Key —— `POST /rotate`（Issue #90）。
 *
 *   POST http://140.210.13.146:60013/rotate   Content-Type: application/json
 *        { "device_id": "d-xxxxxxxxxxxxxxxx" }        ← **只要设备码，不要旧 Key**
 *     → 200 { customer_id, invite_code, key, rotated, previous_key_id, carried_used_points,
 *             total_points, quota_points, remaining_points, key_status, bonus_points,
 *             invited_count, max_invites }
 *     → 404 device_not_found / 400 invalid_device / 500 internal
 *   错误格式与邀请服务一致：{ "error": { "code": "...", "message": "..." } }
 *
 * 传输层与错误码约定**照抄** {@link import('./api.js').runWithDeviceSelfHeal} 那一套
 * （同一个注入的 `OursTransport`、同一组 `parseJson / asRecord / readErrorCode / isSuccessStatus`
 * 解析助手、code 优先再按状态码兜底的文案表、以及 bind.ts 的「主链路不通才换域名」兜底），
 * 不另造请求逻辑。**但自愈策略故意不同**，见下。
 *
 * 三条不能踩的线（都是 issue 的关闭条件 / 任务书硬约束）：
 *
 *  1. **失败绝不清掉本地旧 Key。** `saveKey` 只在 `kind === 'ok'` 且服务端真的给了非空 Key 时
 *     调用一次；所有错误分支一个字节都不写。用户最怕的不是换失败，是换失败之后连原来那把也没了。
 *  2. **不做 apply 自愈。** `runWithDeviceSelfHeal` 的 `device_not_found` 支路会 POST /apply
 *     **静默发一把新 Key 并落盘**——对 /rotate 是另一件事（等于「领取」而不是「更换」），
 *     既违反 #100「打开弹层绝不自动领」，也和 issue 表格给 404 的文案「本机还没有领取过 Key，
 *     请先领取」冲突。`invalid_device` 同理：issue 要求的是让用户重启 App，不是重生设备码
 *     （重生设备码会把换 Key 打到另一台设备上，把用户的 Key 换丢）。所以 /rotate **只重试一次、
 *     只在链路本身不通时重试**，业务错误一律原样交给用户。
 *  3. **重试是安全的。** /rotate 只认设备码，同一台设备反复换，服务端永远只留最新那一把，
 *     所以「超时了要不要再点一次」不是两难：再点一次拿到的就是当前可用的 Key。
 *     代价是最坏情况下服务端多发了一把死 Key（不影响用户）。
 *
 * 排查字段 `previous_key_id` / `carried_used_points` **连解析都不做**（issue 要求不展示），
 * 所以界面上也没有可显示的入口。额度一律只看 `remaining_points`（与 #75 的口径一致）。
 *
 * Key 与设备码不进日志、不进错误文案：本文件一条 console 都没有，返回值里也没有设备码。
 */

import type { OursTransport } from '../ours/api.js'
import {
  INVITE_API_BASE,
  asRecord,
  isSuccessStatus,
  parseInviteProfile,
  parseJson,
  readBoolean,
  readErrorCode,
  readNumber,
  readString,
  type InviteProfile,
} from './api.js'

/** 主链路：与设备码 / 邀请 / 额度同一台机器（明文 HTTP） */
export const ROTATE_URL = `${INVITE_API_BASE}/rotate`

/** 备用域名：主链路整条不通（DNS / 反代没配 / 超时）时用，HTTPS，会绕跨机链路但能通 */
export const ROTATE_FALLBACK_URL = 'https://apia.ecsafe.cn/invite/rotate'

export const ROTATE_TIMEOUTS = {
  rotate: 15000,
} as const

/** 界面文案 key（与 i18n/zh.ts 一致；服务层只回 key，不拼文案） */
export type RotateMessageKey =
  | 'oursRotateErrDeviceNotFound'
  | 'oursRotateErrInvalidDevice'
  | 'oursRotateErrInternal'
  | 'oursRotateErrDeviceMissing'
  | 'oursRotateErrNoKeyInResponse'
  | 'oursRotateErrRateLimited'
  | 'oursRotateErrNetwork'
  | 'oursRotateErrTimeout'
  | 'oursRotateErrInvalidResponse'
  | 'oursRotateErrUnknown'

/**
 * 服务端错误码 → 文案 key。
 *
 * 前三个逐字对应 issue 的表格；其余是防御性兜底（服务端换拼写时不至于显示英文码）。
 */
export const ROTATE_ERROR_KEYS: Record<string, RotateMessageKey> = {
  device_not_found: 'oursRotateErrDeviceNotFound',
  invalid_device: 'oursRotateErrInvalidDevice',
  // 实测（2026-11-19 curl 探针）：格式不合法的 device_id 返回 bad_device_id，不是 issue 写的
  // invalid_device。两种都认，文案一致（与 bind.ts / runWithDeviceSelfHeal 的处理相同）。
  bad_device_id: 'oursRotateErrInvalidDevice',
  internal: 'oursRotateErrInternal',
  device_missing: 'oursRotateErrDeviceMissing',
  rate_limited: 'oursRotateErrRateLimited',
}

/**
 * 只有状态码、没有 code 时的兜底文案。
 *
 * 500 在 /rotate 上就是 issue 表格里的 `internal`（「更换失败，请稍后重试」）；
 * 400 / 404 二义（设备异常还是路由不存在？），猜错会把用户引向错误的操作，一律给通用文案。
 */
export const ROTATE_STATUS_KEYS: Record<number, RotateMessageKey> = {
  400: 'oursRotateErrUnknown',
  404: 'oursRotateErrUnknown',
  429: 'oursRotateErrRateLimited',
  500: 'oursRotateErrInternal',
  502: 'oursRotateErrInternal',
  503: 'oursRotateErrInternal',
  504: 'oursRotateErrInternal',
}

export type RotateVia = 'primary' | 'fallback'

/** 一次换 Key 的结果：成功后本地该持有什么，错误分支什么都不该动 */
export type RotateResult =
  | {
      kind: 'ok'
      /** 服务端下发的新 Key：**必须立刻落盘**，旧 Key 已被服务端作废 */
      apiKey: string
      /** 响应里的额度档案（`/apply`、`/me` 同款字段），界面直接拿去刷新余额，不必再查 /me */
      profile: InviteProfile | null
      /** 服务端自己说的 `rotated`（true = 真的换了一把） */
      rotated: boolean
      /** 走的哪条链路 */
      via: RotateVia
      /** 走了兜底时主链路的失败原因（NETWORK / TIMEOUT / ROUTE_MISSING），只用于排查，不展示 */
      primaryFailure?: string
    }
  | {
      kind: 'error'
      code: string
      messageKey: RotateMessageKey
      retryable: boolean
      via: RotateVia
    }

/** 只有这三种能换域名重试；其余（含业务错误）说明请求已经到服务端，不重发 */
const FALLBACK_CODES = new Set(['NETWORK', 'TIMEOUT', 'ROUTE_MISSING'])

const rotateFailure = (code: string, status: number, via: RotateVia): RotateResult => ({
  kind: 'error',
  code: code === '' ? `HTTP_${status}` : code,
  messageKey: ROTATE_ERROR_KEYS[code] ?? ROTATE_STATUS_KEYS[status] ?? 'oursRotateErrUnknown',
  // 换 Key 可以安全重试（只认设备码），所以网络类 / 5xx 都算可重试
  retryable: code === 'NETWORK' || code === 'TIMEOUT' || code === 'rate_limited' || status >= 500,
  via,
})

/**
 * 把 /rotate 的 200 响应解析成与 `/apply`、`/me` 同款的额度档案。
 *
 * 与 `parseInviteProfile` 的唯一差别：/rotate **没有 `used_points` 字段**，只给
 * `carried_used_points`（「旧 Key 的已用量原样带到新 Key 上」——所以它天然就是新 Key 的已用量）。
 * 直接套 `parseInviteProfile` 会把已用量读成 0（=「一分没用过」），界面显示就错了。
 * 这里只在 `used_points` 缺席时用 `carried_used_points` 补，字段名本身不外泄（issue 要求不展示）。
 */
const readRotatedProfile = (body: Record<string, unknown>): InviteProfile | null => {
  const profile = parseInviteProfile(body)
  if (profile === null) {
    return null
  }
  const usedRaw = body.used_points
  if (typeof usedRaw === 'number' && Number.isFinite(usedRaw)) {
    return profile
  }
  const carried = readNumber(body, 'carried_used_points')
  return carried === profile.usedPoints ? profile : { ...profile, usedPoints: carried }
}

/**
 * 只打一个地址，不做兜底（兜底在 {@link requestRotate} 里）。
 * 导出成单独函数是为了让单测能精确断言「发了哪条、怎么解释响应」。
 */
export const rotateAt = async (
  input: { deviceId: string; url?: string; via?: RotateVia },
  transport: OursTransport
): Promise<RotateResult> => {
  const via = input.via ?? 'primary'
  const result = await transport({
    method: 'POST',
    url: input.url ?? ROTATE_URL,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // 只要设备码：Key 已经丢了也照样能换（issue 正文）
    body: JSON.stringify({ device_id: input.deviceId }),
    timeoutMs: ROTATE_TIMEOUTS.rotate,
    // 破坏性操作：绝不跟随 3xx 把这条请求重放到别处
    followRedirects: false,
  })
  if (result.kind !== 'response') {
    const code = result.kind === 'timeout' ? 'TIMEOUT' : 'NETWORK'
    return {
      kind: 'error',
      code,
      messageKey: result.kind === 'timeout' ? 'oursRotateErrTimeout' : 'oursRotateErrNetwork',
      retryable: true,
      via,
    }
  }
  const parsed = parseJson(result.text)
  const body = parsed.ok ? asRecord(parsed.value) : null
  const code = readErrorCode(body)

  if (!isSuccessStatus(result.status)) {
    // 404/405 且没有业务码 = 这条路由不存在（老部署 / 反代没配），交给调用方换域名；
    // 有业务码的 404 是 device_not_found，属于业务错误，绝不换域名重放。
    if ((result.status === 404 || result.status === 405) && code === '') {
      return { kind: 'error', code: 'ROUTE_MISSING', messageKey: 'oursRotateErrUnknown', retryable: false, via }
    }
    return rotateFailure(code, result.status, via)
  }
  if (body === null) {
    return {
      kind: 'error',
      code: 'INVALID_RESPONSE',
      messageKey: 'oursRotateErrInvalidResponse',
      retryable: false,
      via,
    }
  }
  const apiKey = readString(body, 'key').trim()
  if (apiKey === '') {
    // 200 却没给 Key：换 Key 等于没发生。**必须当失败**，否则本地会存一把空 Key（比旧 Key 更糟）。
    return {
      kind: 'error',
      code: 'KEY_MISSING',
      messageKey: 'oursRotateErrNoKeyInResponse',
      retryable: true,
      via,
    }
  }
  return {
    kind: 'ok',
    apiKey,
    profile: readRotatedProfile(body),
    rotated: readBoolean(body, 'rotated'),
    via,
  }
}

/**
 * 主链路 → 备用域名。
 *
 * 只在**链路本身不通**（NETWORK / TIMEOUT / ROUTE_MISSING）时换域名再打一次，最多两次请求；
 * 业务错误（404 device_not_found、400 invalid_device、500 internal）说明请求已经到服务端并被处理，
 * 重发只会让用户多等一轮，绝不重放。
 */
export const requestRotate = async (deviceId: string, transport: OursTransport): Promise<RotateResult> => {
  const primary = await rotateAt({ deviceId, url: ROTATE_URL, via: 'primary' }, transport)
  if (primary.kind === 'ok' || !FALLBACK_CODES.has(primary.code)) {
    return primary
  }
  const fallback = await rotateAt({ deviceId, url: ROTATE_FALLBACK_URL, via: 'fallback' }, transport)
  if (fallback.kind === 'ok') {
    return { ...fallback, primaryFailure: primary.code }
  }
  return fallback
}

export type RotateDeps = {
  deviceId: string
  transport: OursTransport
  /**
   * 本地当前的 Key（只读，只用来判断「这次到底换没换」）。
   * 服务端不校验旧 Key，但界面要知道「返回的还是原 Key」这种情况，别对用户说「已换成新 Key」。
   */
  currentKey?: string
  /**
   * 落盘新 Key（界面注入：写进当前渠道配置 → localStorage，见 `services/api/apiConfig.ts`）。
   * **只在成功时调用一次**；错误分支一次都不调 —— 这条就是「失败绝不清本地旧 Key」的实现点。
   */
  saveKey: (apiKey: string) => void
}

export type RotateOutcome =
  | {
      kind: 'ok'
      apiKey: string
      profile: InviteProfile | null
      /** 服务端的 `rotated` */
      rotated: boolean
      /** 落盘的这把确实和换之前不是同一把（false = 服务端把原 Key 又还回来了） */
      replaced: boolean
      /** 是否真的落盘了（正常成功必为 true；留给界面断言与排障） */
      saved: boolean
      via: RotateVia
      primaryFailure?: string
    }
  | {
      kind: 'error'
      code: string
      messageKey: RotateMessageKey
      retryable: boolean
      via: RotateVia
      /** 错误分支里永远是 true：本地旧 Key 一个字节都没动 */
      keptOldKey: true
    }

/**
 * 换 Key（界面点「确认更换」后调它）。
 *
 * 顺序：本地能判断的错先拦下（没设备码 → 一条请求都不发）→ 打 /rotate →
 * **只有成功且 Key 非空**才落盘一次并返回响应里的额度档案。
 *
 * 失败一律返回 `keptOldKey: true`，`saveKey` 从不被调用 —— 用户不会因为一次失败就失去服务。
 */
export const rotateKey = async (deps: RotateDeps): Promise<RotateOutcome> => {
  const deviceId = deps.deviceId.trim()
  if (deviceId === '') {
    return {
      kind: 'error',
      code: 'DEVICE_MISSING',
      messageKey: 'oursRotateErrDeviceMissing',
      retryable: false,
      via: 'primary',
      keptOldKey: true,
    }
  }
  const result = await requestRotate(deviceId, deps.transport)
  if (result.kind === 'error') {
    // 换失败 = 什么都没发生：旧 Key 继续可用（服务端只有真的换成功才会作废旧 Key）
    return {
      kind: 'error',
      code: result.code,
      messageKey: result.messageKey,
      retryable: result.retryable,
      via: result.via,
      keptOldKey: true,
    }
  }
  const apiKey = result.apiKey.trim()
  if (apiKey === '') {
    // 双保险：rotateAt 已经拦过一次，这里再拦一次，绝不让空 Key 覆盖本地
    return {
      kind: 'error',
      code: 'KEY_MISSING',
      messageKey: 'oursRotateErrNoKeyInResponse',
      retryable: true,
      via: result.via,
      keptOldKey: true,
    }
  }
  // 唯一的落盘点：到这里才允许写本地
  deps.saveKey(apiKey)
  const current = (deps.currentKey ?? '').trim()
  return {
    kind: 'ok',
    apiKey,
    profile: result.profile,
    rotated: result.rotated,
    replaced: current === '' || current !== apiKey,
    saved: true,
    via: result.via,
    ...(result.primaryFailure === undefined ? {} : { primaryFailure: result.primaryFailure }),
  }
}

/**
 * 成功后的提示文案：真换了 → 「已更换」；服务端把原 Key 又还回来了 → 别骗用户说换了。
 * （`replaced=false` 不是错误：本地存档仍是可用的一把 Key，但用户该知道这次没换成。）
 */
export const rotateSuccessKey = (outcome: { replaced: boolean }): 'oursRotateOk' | 'oursRotateOkUnchanged' =>
  outcome.replaced ? 'oursRotateOk' : 'oursRotateOkUnchanged'

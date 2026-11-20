/**
 * 换一把 Key —— `POST /rotate`（Issue #90；云端语义变更见 #357）。
 *
 *   POST http://140.210.13.146:60013/rotate   Content-Type: application/json
 *        { "device_id": "d-xxxxxxxxxxxxxxxx" }        ← **只要设备码，不要旧 Key**
 *     → 200 { key, rotated, key_id, note, total_points,
 *             customer_id, invite_code, quota_points, remaining_points, key_status, ... }
 *     → 404 device_not_found / 400 invalid_device / 500 internal
 *   错误格式与邀请服务一致：{ "error": { "code": "...", "message": "..." } }
 *
 * ## 云端语义已经是「原地重置额度」，不再换 Key 字符串（#357）
 *
 * 服务端不再分配新的 Key，而是把**当前这把 Key 的额度**按「新人赠送 + 累计奖励」重算一遍：
 *
 *   - 响应里的 `key` 与原来**完全相同**；`rotated: false` 就是**常态**（= 没有新发 Key），
 *     不是「没换成功」；
 *   - 旧 Key 不会失效（因为这还是同一把），所以 #90 时代「旧 Key 立即失效、换出无法找回」
 *     的文案也已经和实际不符，随本单一并改掉；
 *   - 重置后的总额度看 `total_points` / `remaining_points`（额度口径仍只认 `remaining_points`）。
 *
 * ## 判定口径（本文件的核心，#357）
 *
 * **成败只看 HTTP 层**：2xx + 响应里有非空 `key` = 成功（本地存的就是服务端认可的那一把）。
 * `rotated` 与「Key 字符串变没变」**都不参与成败判定**，它们只决定**怎么对用户说** ——
 * 具体分档见 {@link classifyRotateSuccess}，文案映射见 {@link ROTATE_SUCCESS_KEYS}。
 * 旧实现拿 `key !== 旧key` 当成功条件，于是每一次正常的原地重置都被报成
 * 「服务端没有更换，请稍后重试」，还引导用户去重试一个**永远不会变**的结果（#357 误报根因）。
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
 *  3. **重试是安全的。** /rotate 只认设备码，同一台设备反复调，服务端只是在重算同一把 Key
 *     的额度（#357 之后连 Key 都不会变），所以「超时了要不要再点一次」不是两难：
 *     再点一次拿到的就是当前可用的那把 Key，额度按同一套规则重算。
 *
 * 排查字段 `previous_key_id` / `carried_used_points` **连解析都不做**（issue 要求不展示），
 * 所以界面上也没有可显示的入口。额度一律只看 `remaining_points`（与 #75 的口径一致）；
 * 判断「这次响应里到底有没有额度信息」另有一个只看字段是否存在的探针
 * `hasQuotaFields`（#357），它不解析、不外泄字段名。
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
 * 成功文案 key（#357）：**成功只有一种成败结论**，但「这次到底做了什么」有四种说法。
 *
 *   `oursRotateOk`           换发了新 Key（+ 响应里有额度 = 额度也重置了）
 *   `oursRotateOkNoQuota`    换发了新 Key，但响应没带额度字段
 *   `oursRotateOkQuotaReset` Key 字符串没变 = **原地重置额度**（#357 之后这是常态）
 *   `oursRotateOkUnverified` Key 没变、也没额度字段：只能说「请求已完成，去刷新额度确认」
 *
 * 这四个 key 里**没有一句**「没换成功 / 请重试」——原地重置就是成功，不是待重试的异常。
 */
export type RotateOkMessageKey =
  | 'oursRotateOk'
  | 'oursRotateOkNoQuota'
  | 'oursRotateOkQuotaReset'
  | 'oursRotateOkUnverified'

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

/**
 * 「这次响应里到底有没有额度信息」的探针（#357）。
 *
 * 只看字段存在且是有限数字：**不读值、不解析、不把字段名带给界面或日志**，
 * 唯一用途是决定成功文案说「额度已重置」还是「服务端没给额度」。
 *
 * 为什么不能只看 `parseInviteProfile` 的结果：#357 正文的样例响应是
 * `{ key, rotated: false, key_id, note, total_points: 300 }` —— 既没有 `invite_code`
 * 也没有 `remaining_points`，`profile` 会是 null，但额度信息**确实有**。
 */
const QUOTA_FIELDS = ['total_points', 'quota_points', 'remaining_points', 'carried_used_points'] as const

export const hasQuotaFields = (body: Record<string, unknown> | null): boolean =>
  QUOTA_FIELDS.some((field) => {
    const value = body?.[field]
    return typeof value === 'number' && Number.isFinite(value)
  })

/**
 * 成功文案的四种语义（#357）。**四种都是成功**，区别只在「怎么对用户说」。
 */
export type RotateSuccessMode =
  /** 换发了新 Key 字符串，且响应里有额度 → 「已重置额度并换发新 Key」 */
  | 'newKey'
  /** 换发了新 Key 字符串，但响应没带额度字段 */
  | 'newKeyNoQuota'
  /** Key 字符串没变 = 服务端原地重置了额度（#357 之后的**常态**） */
  | 'quotaReset'
  /** Key 没变、响应也没有额度字段：只能说「请求已完成，去刷新额度确认」 */
  | 'unverified'

export type RotateSuccessInput = {
  /** 服务端这次返回的 Key（非空；空 Key 在传输层就已经判失败了） */
  apiKey: string
  /** 本地换之前那把（'' = 本机本来没有 Key，或读不到） */
  currentKey?: string
  /** 服务端的 `rotated`：true = 它分配了新 Key。**#357 之后常态是 false** */
  rotated: boolean
  /** 响应里有没有额度字段（见 {@link hasQuotaFields}） */
  quotaInResponse: boolean
}

/**
 * 成功后的界面语义（纯函数，界面只负责把结论翻成文案）。
 *
 * 判定顺序**不是**「Key 变没变决定成败」，而是：
 *   1. 先确认「Key 字符串这次有没有变」——
 *      本机有旧 Key 就直接比字符串；本机没有旧 Key 时退回服务端的 `rotated`；
 *   2. 变了 → 换发了新 Key；没变 → **原地重置额度**（#357 的常态，绝不能报成失败）；
 *   3. 再叠一层「响应里有没有额度字段」，决定要不要提示用户自己刷新额度。
 *
 * 旧实现只看 `replaced`（= `key !== 旧key`），把每一次正常的原地重置都说成
 * 「服务端没有更换，请稍后重试」——用户被引导去重试一个永远不会变的结果（#357）。
 */
export const classifyRotateSuccess = (input: RotateSuccessInput): RotateSuccessMode => {
  const local = (input.currentKey ?? '').trim()
  const returned = input.apiKey.trim()
  const keyUnchanged = local === '' ? !input.rotated : local === returned
  if (keyUnchanged) {
    return input.quotaInResponse ? 'quotaReset' : 'unverified'
  }
  return input.quotaInResponse ? 'newKey' : 'newKeyNoQuota'
}

/** 判定结果 → 文案 key（一一对应，界面只查这张表） */
export const ROTATE_SUCCESS_KEYS: Record<RotateSuccessMode, RotateOkMessageKey> = {
  newKey: 'oursRotateOk',
  newKeyNoQuota: 'oursRotateOkNoQuota',
  quotaReset: 'oursRotateOkQuotaReset',
  unverified: 'oursRotateOkUnverified',
}

/** 一次换 Key 的结果：成功后本地该持有什么，错误分支什么都不该动 */
export type RotateResult =
  | {
      kind: 'ok'
      /**
       * 服务端回的 Key：**必须立刻落盘**（#357：即使字符串和原来一样也要落盘，
       * 免得本地和服务端出现「看上去不一致」的偏差）。
       */
      apiKey: string
      /** 响应里的额度档案（`/apply`、`/me` 同款字段），界面直接拿去刷新余额，不必再查 /me */
      profile: InviteProfile | null
      /** 服务端的 `rotated`：true = 分配了新 Key。**#357 之后常态是 false（原地重置额度）** */
      rotated: boolean
      /** 响应里有没有额度字段（成功文案要用，见 {@link hasQuotaFields}） */
      quotaInResponse: boolean
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
    quotaInResponse: hasQuotaFields(body),
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
   * 本地当前的 Key（只读）。
   *
   * #357 起它**只用来选文案**（这次换发了新 Key，还是原地重置了同一把），
   * **绝不参与成败判定** —— 服务端现在常态就是返回同一把 Key。
   */
  currentKey?: string
  /**
   * 落盘服务端回的 Key（界面注入：写进当前渠道配置 → localStorage，见 `services/api/apiConfig.ts`）。
   * **只在成功时调用一次**；错误分支一次都不调 —— 这条就是「失败绝不清本地旧 Key」的实现点。
   */
  saveKey: (apiKey: string) => void
}

export type RotateOutcome =
  | {
      kind: 'ok'
      apiKey: string
      profile: InviteProfile | null
      /** 服务端的 `rotated`（true = 分配了新 Key；#357 之后常态是 false） */
      rotated: boolean
      /** 响应里有没有额度字段（成功文案用） */
      quotaInResponse: boolean
      /** 这次成功的界面语义（{@link classifyRotateSuccess} 的结论）：决定文案，不决定成败 */
      mode: RotateSuccessMode
      /**
       * 落盘的这把和本地换之前**不是同一把**（false = 服务端把原 Key 又还回来了）。
       *
       * 这只是**事实记录**（`mode === 'newKey*'` 的另一种表述），#357 之后
       * `false` 是常态、**不是失败信号**；界面的成败与文案一律走 `mode`。
       */
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
    // 请求没成功 = 什么都没发生：本地旧 Key 一个字节没动，继续可用
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
  // 唯一的落盘点：到这里才允许写本地（#357：字符串相同也照样落盘，保持与服务端一致）
  deps.saveKey(apiKey)
  const current = (deps.currentKey ?? '').trim()
  const mode = classifyRotateSuccess({
    apiKey,
    currentKey: current,
    rotated: result.rotated,
    quotaInResponse: result.quotaInResponse,
  })
  return {
    kind: 'ok',
    apiKey,
    profile: result.profile,
    rotated: result.rotated,
    quotaInResponse: result.quotaInResponse,
    mode,
    // 只是事实记录（= mode 是否换发新 Key）；#357 之后 false 是常态，不是失败
    replaced: mode === 'newKey' || mode === 'newKeyNoQuota',
    saved: true,
    via: result.via,
    ...(result.primaryFailure === undefined ? {} : { primaryFailure: result.primaryFailure }),
  }
}

/**
 * 成功后的提示文案（#357）：一切以 {@link classifyRotateSuccess} 的结论为准。
 *
 * 四种结论都是成功，只是说法不同：
 *   - `newKey`          → 已重置额度并换发新 Key
 *   - `newKeyNoQuota`   → 已换发新 Key（服务端没回额度，提示去刷新）
 *   - `quotaReset`      → 额度已重置（Key 未变，仍是本机这把）
 *   - `unverified`      → 请求已完成（Key 未变、也没额度信息），去刷新额度确认
 *
 * 旧实现按 `key !== 旧key` 分流，把 `quotaReset` 说成「服务端没有更换，请稍后重试」——
 * 那是 #357 里用户看到的误报，已经删掉（连文案 key 一起）。
 */
export const rotateSuccessKey = (outcome: { mode: RotateSuccessMode }): RotateOkMessageKey =>
  ROTATE_SUCCESS_KEYS[outcome.mode]

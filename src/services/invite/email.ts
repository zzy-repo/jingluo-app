/**
 * 邮箱验证码「提交」之后的**采用**动作（Issue #421 第 1、2 点）。
 *
 * 为什么单独一个文件：采用必须复用现有两条实现，不能另起一套覆盖逻辑 ——
 *  - `adoptServerDeviceId`（device.ts，Issue #261）：服务端回填的 device_id **形状合法才写**、
 *    与本地相同就不写；邮箱登录与「用指纹还原原账号」走的是同一条路。
 *  - `bindSuccessKey`（bind.ts，Issue #86）：成功文案只有一条，不区分「首次 / 重复」。
 *
 * 分工：
 *  - `services/invite/api.ts` 只管发请求 + 把响应 / 错误码翻成结构化结果，**不碰存储**；
 *  - 本文件把「登录成功」的 device_id 与 Key 采用到本地（写回设备码、落 Key）；
 *  - 界面只调 {@link verifyEmailAndAdopt}，拿到结果渲染。
 *
 * 登录冲突（`device_has_account`）也走这里：`verifyEmailAndAdopt` 把服务端给的
 * {@link EmailConflict}（`email_masked` / `device_remaining_points` / `options`）原样交给界面，
 * 用户选完再带同一个验证码 + `choice` 重发一次 —— 验证码在冲突那次没有被消耗。
 *
 * 范围外（#421 明确不做）：**自动合并账号**（服务端不合并，本机原账号额度保留但要客服处理）、
 * 支付链路。**邮箱不会让其他设备失效**：同一邮箱在多台设备登录共用同一把 Key
 * 与同一份额度，文案里不许写成「账号更安全」。
 */

import type { OursTransport } from '../ours/api.js'
import {
  verifyEmailCode,
  type EmailChoice,
  type EmailConflict,
  type EmailError,
  type EmailVerifyAction,
  type EmailVerifyResult,
  type InviteProfile,
} from './api.js'
import { bindSuccessKey } from './bind.js'
import { adoptServerDeviceId, type DeviceIdStorage } from './device.js'

/** 成功那一支（把 {kind:'error'} / {kind:'conflict'} 从联合里剔掉） */
type OkOf<T> = Exclude<T, { kind: 'error' } | { kind: 'conflict' }>

/** 采用动作需要的最小依赖：设备码存储 + 当前设备码 + Key 落盘口（全由界面注入） */
export type EmailAdoptDeps = {
  storage: DeviceIdStorage
  /** 本地当前的 device_id（采用前） */
  currentDeviceId: string
  /** Key 存到哪里（界面注入：写进当前渠道配置；与 /apply、/bind 同一个落盘口） */
  saveKey: (apiKey: string) => void
  /** 设备指纹哈希（#243）：有就带 `X-Device-Fp`，没有就照旧 */
  deviceFp?: string
}

/** 采用之后的界面语义（不含 Key：Key 只在 saveKey 里过一手，绝不进返回值） */
export type EmailLoginOutcome = {
  action: EmailVerifyAction
  /** 采用后本地**应当使用**的 device_id */
  deviceId: string
  /** true = 本次走了 adoptServerDeviceId（本地设备码被写回） */
  deviceIdAdopted: boolean
  /** true = 本次把响应里的 Key 落了盘 */
  keyAdopted: boolean
  /** 成功文案：与「绑定已有 Key」同一条（bindSuccessKey），不另写一套 */
  successKey: 'oursBindOk'
  hasEmail: boolean | null
  emailMasked: string | null
  /** 响应里若顺带回了档案就用它，否则 null（界面再查一次 /me） */
  profile: InviteProfile | null
}

/**
 * 纯采用函数：不返回 Key，只负责把它交给 `deps.saveKey`。
 *
 * - `action: 'bound'`：邮箱挂到**当前** device_id 上，设备码一个字都不动；
 * - `action: 'login'`：响应里的 device_id / key 就是原账号的凭据，走
 *   `adoptServerDeviceId`（#261）写回本地，再 `saveKey` 落盘。
 */
export const adoptEmailVerify = (
  result: OkOf<EmailVerifyResult>,
  deps: EmailAdoptDeps
): EmailLoginOutcome => {
  const current = deps.currentDeviceId.trim()
  if (result.action !== 'login') {
    return {
      action: 'bound',
      deviceId: current,
      deviceIdAdopted: false,
      keyAdopted: false,
      successKey: bindSuccessKey({ alreadyBound: result.hasEmail === true }),
      // 绑定成功之后服务端一定说 has_email:true；老服务端没这个字段时才维持中性
      hasEmail: result.hasEmail ?? true,
      emailMasked: result.emailMasked,
      profile: result.profile,
    }
  }
  // 与「还原原账号」共用同一条采用路径：坏值当没回、相同不写（见 device.ts）
  const deviceId = adoptServerDeviceId(deps.storage, current, result.serverDeviceId)
  const keyAdopted = result.apiKey !== ''
  if (keyAdopted) {
    deps.saveKey(result.apiKey)
  }
  return {
    action: 'login',
    deviceId,
    deviceIdAdopted: deviceId !== current,
    keyAdopted,
    successKey: bindSuccessKey({ alreadyBound: false }),
    hasEmail: result.hasEmail ?? true,
    emailMasked: result.emailMasked,
    profile: result.profile,
  }
}

export type EmailVerifyAndAdoptResult =
  | { kind: 'ok'; value: EmailLoginOutcome }
  /** 登录冲突：没采用任何东西，界面弹窗等用户选（验证码仍在） */
  | EmailConflict
  | EmailError

/**
 * 界面唯一入口：提交验证码 + 采用。
 *
 * `action: 'login'` 却没给 Key = 没办法接管原账号，必须当失败：
 * 否则界面会显示「已登录」而本地留着一把空 Key（与 /bind 里 `KEY_MISSING` 的判定同一个理由）。
 */
export const verifyEmailAndAdopt = async (
  /** `choice`：冲突弹窗上用户点过按钮才有；第一次提交不给（不替用户先做决定） */
  input: { deviceId: string; email: string; code: string; choice?: EmailChoice },
  transport: OursTransport,
  deps: EmailAdoptDeps
): Promise<EmailVerifyAndAdoptResult> => {
  const result = await verifyEmailCode(input, transport, deps.deviceFp ?? '')
  if (result.kind === 'conflict') {
    // 验证码没被消耗、本地一个字都不动：交给界面弹窗
    return result
  }
  if (result.kind === 'error') {
    return result
  }
  if (result.action === 'login' && result.apiKey === '') {
    return {
      kind: 'error',
      code: 'KEY_MISSING',
      messageKey: 'oursInviteErrKeyMissing',
      retryable: true,
      attemptsLeft: null,
      retryAfter: null,
      boundEmailMasked: null,
      deviceRemainingPoints: null,
      conflictEmailMasked: null,
    }
  }
  return { kind: 'ok', value: adoptEmailVerify(result, deps) }
}

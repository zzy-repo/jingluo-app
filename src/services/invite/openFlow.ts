// 弹层打开时的初始化流程（纯逻辑 + 注入 transport）：单测可断言「打开时到底发了哪些请求」。
//
// 拆出来的原因见 Issue #100：`OursServicesDialog` 挂载时的副作用藏在组件里，无法用假 transport
// 断言请求序列，才让「打开弹层就自动 /apply」这种 bug 一路漏到真机上。
//
// 铁律（Issue #100）：**打开弹层只做只读查询，绝不建立绑定。**
//   - 本地没有 Key → 一条请求都不发，交回界面让用户选「领取新 Key」/「我已有 Key」；
//   - 本地有 Key   → 只发 GET /me；
//   - /me 返回 404 device_not_found → 服务端认为这台设备码没有绑定记录，
//     **不补 POST /apply**（一台设备一把 Key：补了就把用户的「绑定已有 Key」堵死），
//     改成提示「本机未绑定，请领取或绑定」。
import { fetchInviteProfile, type InviteMessageKey, type InviteProfile } from './api.js'
import type { OursMessageKey, OursTransport } from '../ours/api.js'
import { createDeviceId } from './device.js'

export type DialogOpenDeps = {
  deviceId: string
  transport: OursTransport
  /** 设备指纹哈希（Issue #243）：只上报，拿不到就是空串，只读查询照发 */
  deviceFp?: string
  /** 本地是否已有 Key：没有就只能等用户选「领取新 Key」/「我已有 Key」 */
  hasLocalKey: boolean
  /** 重新生成 + 持久化 device_id（界面注入；缺省用 createDeviceId 生成但**不**落盘） */
  regenerate?: (current: string) => string
}

export type DialogOpenOutcome =
  /** 等用户选：本机既没有 Key（reason=nokey）也没有绑定记录（reason=unbound） */
  | { kind: 'choose'; deviceId: string; reason: 'nokey' | 'unbound' }
  /** /me 读到了已有档案 */
  | { kind: 'profile'; deviceId: string; profile: InviteProfile }
  | { kind: 'error'; deviceId: string; messageKey: InviteMessageKey | OursMessageKey }

/** 只读查档案（GET /me）：device_not_found 不自愈、不 /apply；设备码本身非法才重建一次再查 */
const readOnlyProfile = async (deps: DialogOpenDeps): Promise<DialogOpenOutcome> => {
  const first = await fetchInviteProfile(deps.deviceId, deps.transport, deps.deviceFp ?? '')
  if (first.kind !== 'error') {
    return { kind: 'profile', deviceId: deps.deviceId, profile: first.profile }
  }
  if (first.code === 'device_not_found') {
    return { kind: 'choose', deviceId: deps.deviceId, reason: 'unbound' }
  }
  // 设备码本身不合法：服务端实测返回 bad_device_id（400）；老文档/issue 里写作 invalid_device。
  // 两种码都按同一处理：重新生成一次设备码，然后**只读**再查一遍（绝不 /apply）。
  if (first.code === 'bad_device_id' || first.code === 'invalid_device') {
    const nextId = (deps.regenerate?.(deps.deviceId) ?? createDeviceId()).trim()
    if (nextId !== '' && nextId !== deps.deviceId) {
      const retried = await fetchInviteProfile(nextId, deps.transport, deps.deviceFp ?? '')
      if (retried.kind !== 'error') {
        return { kind: 'profile', deviceId: nextId, profile: retried.profile }
      }
      if (retried.code === 'device_not_found') {
        return { kind: 'choose', deviceId: nextId, reason: 'unbound' }
      }
      return { kind: 'error', deviceId: nextId, messageKey: retried.messageKey }
    }
  }
  return { kind: 'error', deviceId: deps.deviceId, messageKey: first.messageKey }
}

/** 弹层打开时该做什么：只读，不建立绑定 */
export const prepareDialogOpen = async (deps: DialogOpenDeps): Promise<DialogOpenOutcome> =>
  deps.hasLocalKey ? readOnlyProfile(deps) : { kind: 'choose', deviceId: deps.deviceId, reason: 'nokey' }

/** 「刷新额度」也走同一套只读逻辑：只读 /me，不会因为 device_not_found 悄悄补一把 Key */
export const refreshProfile = readOnlyProfile

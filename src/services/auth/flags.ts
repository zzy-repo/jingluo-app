/**
 * 功能开关 —— W1-B 前半，Issue #487（依据 #484 §3.1d：「客户端所有『入口是否显示』都由
 * `GET /api/v1/settings/public` 决定，本地不维护第二份开关」）。
 *
 * 三条规则：
 *  1. **一份真值**：本文件只是 `settings/public` 的本地镜像，字段名换成 camelCase，语义一个字不改；
 *     代码里不许再出现 `registrationEnabled = true` 这类写死的默认值（门禁口径见 #484 §七 第 7 条）。
 *  2. **拿不到就保守**：读取失败 / 还没读 / 字段缺失 → 全部按「关闭」处理（注册入口、邀请码、验证码都不显示）。
 *     宁可让用户看见一个只能登录的界面，也不要让他填完一整套表单再被服务端拒绝。
 *  3. **不自己发请求**：读 `settings/public` 的 HTTP 在 W1-A 的 `src/services/consume/auth.ts`
 *     （`getPublicSettings(http)`，白名单 §3.1 第一行）。这里只留一个 `PublicSettingsReader` 口子，
 *     由接线方注入 —— 这样本文件在传输层不存在时也能被安全 import。
 *
 * 实测（2026-11-20，本地实例 0.2.22）：`{"code":0,"message":"success","data":{
 *   "registration_enabled":true,"email_verify_enabled":false,"invitation_code_enabled":false,…}}`
 * —— 面板信封，开关在 `data` 下面；`parseAuthFlags` 同时容忍裸对象（测试 / 其他实现会给裸的）。
 */

import { create } from 'zustand'

/** 本单用到的三个开关（§3.1d 里还有 turnstile / 验证码站点 key 等，W1-C 需要时再加） */
export type AuthFlags = {
  /** 是否允许注册：false → **注册入口整块隐藏**（不是置灰） */
  registrationEnabled: boolean
  /** 注册是否必须邮箱验证码：true → 注册表单要显示「验证码」行与「发送验证码」按钮 */
  emailVerifyEnabled: boolean
  /** 是否启用邀请码：true → 注册表单显示「邀请码（可选）」 */
  invitationCodeEnabled: boolean
}

/**
 * 保守默认：**全部隐藏**。读取失败、还没读到、字段缺失都落在这里。
 *
 * 唯一允许「乐观」的是 `emailVerifyEnabled`：它只影响注册表单里多不多一行验证码；
 * 而注册入口本身已经被 `registrationEnabled=false` 挡住了，所以误判不会放出任何多余入口。
 */
export const CONSERVATIVE_AUTH_FLAGS: AuthFlags = Object.freeze({
  registrationEnabled: false,
  emailVerifyEnabled: false,
  invitationCodeEnabled: false,
})

/**
 * `settings/public` 的读取口子。返回值**不做类型承诺**（服务端字段随版本长），由 `parseAuthFlags` 归一。
 * 实现方（W1-A）直接返回 `consume.settings.get()` 的 `data`（`ConsumePublicSettings`），
 * 或者整个 `{code,message,data}` 信封都行 —— 两种形状都认；读不到给 `null` 即落保守默认。
 */
export type PublicSettingsReader = () => Promise<unknown>

let reader: PublicSettingsReader | null = null

/**
 * 注入读取实现。
 *
 * 接线处在 `src/main.tsx`（与 `setAuthTransport` 同一处）：
 *   `setPublicSettingsReader(createPublicSettingsReader(consume))`
 * 没挂之前 `loadAuthFlags()` 会立刻落到保守默认，界面只显示登录，不显示注册 —— 这是有意的降级。
 */
export const setPublicSettingsReader = (next: PublicSettingsReader | null): void => {
  reader = next
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 把服务端开关归一成 `AuthFlags`：
 *  - 认 `{code,message,data:{…}}` 面板信封，也认裸对象；
 *  - 认 **snake_case**（`settings/public` 的原文）与 **camelCase**（W1-A 的 `ConsumePublicSettings`
 *    已经把字段名转过一次）两种写法 —— 两种都见过，本地只做「或」，不做字段名假设；
 *  - **只认严格 `true`**（`"true"` / `1` 都当关闭），口径与 #484 §3.1d「服务端说关就是关」一致。
 */
export const parseAuthFlags = (raw: unknown): AuthFlags => {
  if (!isRecord(raw)) {
    return { ...CONSERVATIVE_AUTH_FLAGS }
  }
  const source = isRecord(raw.data) ? raw.data : raw
  return {
    registrationEnabled: source.registration_enabled === true || source.registrationEnabled === true,
    emailVerifyEnabled: source.email_verify_enabled === true || source.emailVerifyEnabled === true,
    invitationCodeEnabled: source.invitation_code_enabled === true || source.invitationCodeEnabled === true,
  }
}

/** store 里的开关：`loaded` 区分「读到了但全是 false」与「还没读到 / 读失败」 */
export type AuthFlagsState = AuthFlags & { loaded: boolean }

export const useAuthFlags = create<AuthFlagsState>(() => ({
  ...CONSERVATIVE_AUTH_FLAGS,
  loaded: false,
}))

/**
 * 读一次开关。**永不抛错**：失败 → 保守默认（`loaded` 保持 false）。
 *
 * 为什么不重试 / 不缓存到磁盘：开关是「启动时读一次、由服务端说了算」的短时效信息（#484 §3.1d），
 * 落盘缓存一份就等于在本地维护第二份开关，正是该条要禁的东西。
 */
export const loadAuthFlags = async (): Promise<AuthFlags> => {
  if (!reader) {
    useAuthFlags.setState({ ...CONSERVATIVE_AUTH_FLAGS, loaded: false })
    return { ...CONSERVATIVE_AUTH_FLAGS }
  }
  try {
    const flags = parseAuthFlags(await reader())
    useAuthFlags.setState({ ...flags, loaded: true })
    return flags
  } catch {
    useAuthFlags.setState({ ...CONSERVATIVE_AUTH_FLAGS, loaded: false })
    return { ...CONSERVATIVE_AUTH_FLAGS }
  }
}

/** 当前开关（非组件代码用；组件请 `useAuthFlags()`） */
export const getAuthFlags = (): AuthFlagsState => useAuthFlags.getState()

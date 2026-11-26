/**
 * 功能开关 —— W1-B 前半，Issue #487（依据 #484 §3.1d：「客户端所有『入口是否显示』都由
 * `GET /api/v1/settings/public` 决定，本地不维护第二份开关」）。
 *
 * 三条规则（第三条是 2026-11-24 线上事故后补的）：
 *  1. **一份真值**：本文件只是 `settings/public` 的本地镜像，字段名换成 camelCase，语义一个字不改；
 *     代码里不许再出现 `registrationEnabled = true` 这类写死的默认值（门禁口径见 #484 §七 第 7 条）。
 *  2. **不自己发请求**：读 `settings/public` 的 HTTP 在 W1-A 的 `src/services/consume/auth.ts`
 *     （`getPublicSettings(http)`，白名单 §3.1 第一行）。这里只留一个 `PublicSettingsReader` 口子，
 *     由接线方注入 —— 这样本文件在传输层不存在时也能被安全 import。
 *  3. **「没读到」≠「服务端说关」**（线上事故复盘）：`registration` 是三态 `unknown / enabled / disabled`。
 *     旧版本把「一次没读成功」直接当成 `registrationEnabled = false`，于是 502 / 超时 / 只回了个空壳的那一次
 *     就等价于「服务端关了注册」：注册被**本地**静默拦掉，屏幕上还写着「注册暂未开放，请稍后或联系管理员」——
 *     用户以为是我们把注册关了。现在只有**服务端真的给了布尔**才敢说 `disabled`；`unknown` 一律把判定
 *     交给服务端（真关了它会回 `403 REGISTRATION_DISABLED`，文案走 `sub2authRegistrationDisabled`），
 *     界面上只给一行「功能开关读取失败，点此重试」。
 *
 * 实测（2026-11-20，本地实例 0.2.22）：`{"code":0,"message":"success","data":{
 *   "registration_enabled":true,"email_verify_enabled":false,"invitation_code_enabled":false,…}}`
 * —— 面板信封，开关在 `data` 下面；`parseAuthFlagsSnapshot` 同时容忍裸对象（测试 / 其他实现会给裸的）。
 */

import { create } from 'zustand'
import { failureOfStatus, retryableFailure } from '../net/requestPolicy.js'

/** 本单用到的三个开关（§3.1d 里还有 turnstile / 验证码站点 key 等，W1-C 需要时再加） */
export type AuthFlags = {
  /** 是否允许注册：false → **注册入口整块隐藏**（不是置灰）。注意它只是 `registration === 'enabled'` 的布尔镜像 */
  registrationEnabled: boolean
  /** 注册是否必须邮箱验证码：true → 注册表单要显示「验证码」行与「发送验证码」按钮 */
  emailVerifyEnabled: boolean
  /** 是否启用邀请码：true → 注册表单显示「邀请码（可选）」 */
  invitationCodeEnabled: boolean
  /**
   * 服务端**明确写了** `affiliate_enabled: false`（#860）。**只**用来决定邀请面板里「填写邀请人」入口显不显示
   * （关闭时 `aff/bind` 必然 400 `AFFILIATE_DISABLED`）。**不是**面板可见性开关：面板可见性只看 `GET /user/aff`（#838 / #819-v2）。
   *
   * 为什么不是 `!affiliateEnabled`：读取失败时生产 reader 返回 `null`（不抛错），这里落 `unknown` + 全 false ——
   * 若按「不是 true 就关闭」，`settings/public` 偶发超时就会把填写入口误藏。所以这里**只认明确的 false**：
   * 没读到 / 字段缺失 / 非布尔，一律 `false`（= 不关闭，表单照常，后端才是权威）。
   */
  affiliateDisabled: boolean
}

/**
 * 保守默认：**全部隐藏**。读取失败、还没读到、字段缺失都落在这里。
 *
 * 这张表只描述「布尔镜像长什么样」（界面显隐），**不**表达「服务端到底说了什么」——
 * 后者由 {@link RegistrationGate} 三态承担。两者**不许**互相替代：把 `registrationEnabled: false`
 * 当成「服务端关了注册」正是线上事故的根因。
 *
 * 唯一允许「乐观」的是 `emailVerifyEnabled`：它只影响注册表单里多不多一行验证码。
 */
export const CONSERVATIVE_AUTH_FLAGS: AuthFlags = Object.freeze({
  registrationEnabled: false,
  emailVerifyEnabled: false,
  invitationCodeEnabled: false,
  affiliateDisabled: false,
})

/**
 * **注册闸门三态** —— 本文件唯一有资格回答「能不能本地拦注册」的东西。
 *
 *  · `'enabled'`  —— 服务端**真的给了** `registration_enabled: true`；
 *  · `'disabled'` —— 服务端**真的给了** `registration_enabled: false`（这才是「注册暂未开放」的唯一出处）；
 *  · `'unknown'`  —— 没读到：还没接线 / 传输失败重试耗尽 / 字段缺失 / 形状不认识 / 错误信封。
 *                   此时**不许本地拦截**，交给服务端判（它真关了会回 `403 REGISTRATION_DISABLED`）。
 */
export type RegistrationGate = 'unknown' | 'enabled' | 'disabled'

/** 一次读取的完整结论：三态 + 布尔镜像（镜像只用来画界面，判据只看三态） */
export type AuthFlagsSnapshot = {
  registration: RegistrationGate
  flags: AuthFlags
}

/**
 * `settings/public` 的读取口子。返回值**不做类型承诺**（服务端字段随版本长），由 `parseAuthFlagsSnapshot` 归一。
 * 实现方（W1-A）直接返回 `consume.settings.get()` 的 `data`（`ConsumePublicSettings`），
 * 或者整个 `{code,message,data}` 信封都行 —— 两种形状都认；读不到给 `null` 或抛错都行（两种都当失败重试）。
 */
export type PublicSettingsReader = () => Promise<unknown>

let reader: PublicSettingsReader | null = null

/**
 * 注入读取实现。
 *
 * 接线处在 `src/main.tsx`（与 `setAuthTransport` 同一处）：
 *   `setPublicSettingsReader(createPublicSettingsReader(consume))`
 * 没挂之前 `loadAuthFlags()` 会立刻落到 `unknown`（界面只显示登录，注册按钮照常可点、交给服务端判）。
 */
export const setPublicSettingsReader = (next: PublicSettingsReader | null): void => {
  reader = next
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 错误信封：`{code:'REGISTRATION_DISABLED'}` / `{code:500}` / `{success:false}` / `{ok:false}`。
 *
 * 成功信封是 `code: 0`（面板口径），所以「`code` 存在且不是 0 / 不是成功词」就算错误信封 ——
 * 这种回包里**没有**开关字段，必须落 `unknown`，绝不能因为「没读到 false」就当成关闭。
 */
const isErrorEnvelope = (raw: Record<string, unknown>): boolean => {
  if (raw.success === false || raw.ok === false) {
    return true
  }
  const code = raw.code
  if (typeof code === 'number') {
    return code !== 0
  }
  if (typeof code === 'string' && code !== '') {
    const normalized = code.trim().toUpperCase()
    return normalized !== '0' && normalized !== 'OK' && normalized !== 'SUCCESS'
  }
  return false
}

/**
 * 读一个开关字段：**只有真的拿到布尔才算读到了**（`null` = 这个字段没读到）。
 *
 * `"true"` / `1` / `undefined` / 缺字段全都给 `null` —— 与 #484 §3.1d「服务端说关就是关」同口径：
 * 说「关」得是明确的 `false`，不是「我们没看见 true」。
 */
const booleanFieldOf = (source: Record<string, unknown>, snake: string, camel: string): boolean | null => {
  const snakeValue = source[snake]
  if (typeof snakeValue === 'boolean') {
    return snakeValue
  }
  const camelValue = source[camel]
  if (typeof camelValue === 'boolean') {
    return camelValue
  }
  return null
}

/** 「什么都没读到」的快照（每次给新对象，调用方可以随便改） */
export const unknownAuthFlagsSnapshot = (): AuthFlagsSnapshot => ({
  registration: 'unknown',
  flags: { ...CONSERVATIVE_AUTH_FLAGS },
})

/**
 * 把服务端回包归一成 {@link AuthFlagsSnapshot}：
 *  - 认 `{code,message,data:{…}}` 面板信封，也认裸对象；
 *  - 认 **snake_case**（`settings/public` 的原文）与 **camelCase**（W1-A 的 `ConsumePublicSettings`
 *    已经把字段名转过一次）两种写法 —— 两种都见过，本地只做「或」，不做字段名假设；
 *  - `registration` 只有在拿到**布尔**时才不是 `unknown`：字段缺失 / 非布尔 / `data` 不是对象 / 错误信封
 *    一律 `unknown`（**不许**当成 `disabled`，见文件头第 3 条）。
 */
export const parseAuthFlagsSnapshot = (raw: unknown): AuthFlagsSnapshot => {
  if (!isRecord(raw) || isErrorEnvelope(raw)) {
    return unknownAuthFlagsSnapshot()
  }
  const source = 'data' in raw ? raw.data : raw
  if (!isRecord(source)) {
    return unknownAuthFlagsSnapshot()
  }
  const registration = booleanFieldOf(source, 'registration_enabled', 'registrationEnabled')
  return {
    registration: registration === null ? 'unknown' : registration ? 'enabled' : 'disabled',
    flags: {
      registrationEnabled: registration === true,
      emailVerifyEnabled: booleanFieldOf(source, 'email_verify_enabled', 'emailVerifyEnabled') === true,
      invitationCodeEnabled: booleanFieldOf(source, 'invitation_code_enabled', 'invitationCodeEnabled') === true,
      affiliateDisabled: booleanFieldOf(source, 'affiliate_enabled', 'affiliateEnabled') === false,
    },
  }
}

/**
 * 布尔镜像（老口子，语义 = 「界面该不该显示这个入口」，`unknown` 时全 `false`）。
 *
 * **不要**用它判断「服务端是不是关了注册」—— 那是 {@link RegistrationGate} 的事。
 */
export const parseAuthFlags = (raw: unknown): AuthFlags => ({ ...parseAuthFlagsSnapshot(raw).flags })

/**
 * store 里的开关。
 *
 * 三件事分开存，是因为它们回答的是三个不同的问题：
 *  · `registration` —— 服务端到底说了什么（三态，**唯一**的注册拦截判据）；
 *  · `loaded`       —— 有没有真的读到（`registration !== 'unknown'`；兼容老调用点的布尔口径）；
 *  · `readFailed`   —— 最近一次读取「试过了但没拿到」（传输失败 / 5xx 重试耗尽 / 形状不认识）。
 *                     界面据此给一行「功能开关读取失败，点此重试」；没接线（`reader === null`）时它是 false。
 */
export type AuthFlagsState = AuthFlags & {
  loaded: boolean
  registration: RegistrationGate
  readFailed: boolean
}

export const useAuthFlags = create<AuthFlagsState>(() => ({
  ...CONSERVATIVE_AUTH_FLAGS,
  loaded: false,
  registration: 'unknown',
  readFailed: false,
}))

/** 把一次读取的结论写进 store（唯一写点：三态与布尔镜像永远同批落，不会出现「镜像说 false、三态说 enabled」） */
const applySnapshot = (snapshot: AuthFlagsSnapshot, readFailed: boolean): void => {
  useAuthFlags.setState({
    ...snapshot.flags,
    loaded: snapshot.registration !== 'unknown',
    registration: snapshot.registration,
    readFailed,
  })
}

/**
 * 重试口径（线上事故的修复项）：
 *  · 网络错误 / 超时 / 5xx  → **值得再试**（那一次 502 正是事故现场）；
 *  · 4xx                    → **不重试**（服务端明说你不对，重试也白搭）；
 *  · 200 但形状不认识       → **不重试**（同一份回包再来一次还是那个形状），当 `unknown` 处理。
 */
export const FLAGS_RETRY = Object.freeze({
  /** 最多再试 2 次（合计最多 3 次请求） */
  retries: 2,
  /** 第 1 次退避 300ms 起，按 2 的幂递增 */
  baseDelayMs: 300,
  /** 单次退避上限（含抖动前） */
  maxDelayMs: 800,
  /** 抖动上限：避免同一批客户端卡在同一毫秒一起重试 */
  jitterMs: 100,
})

export type AuthFlagsLoadOptions = {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterMs?: number
  /** 注入等待实现（单测用：不真等 300~800ms） */
  sleep?: (ms: number) => Promise<void>
  /** 注入随机源（单测用：抖动量可预期） */
  random?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/** 从抛出的错误里读 HTTP 状态码（不同实现的字段名都认；读不到就是 `null` = 当作网络/超时） */
const statusOfThrown = (error: unknown): number | null => {
  if (!isRecord(error)) {
    return null
  }
  for (const source of [error, isRecord(error.cause) ? error.cause : null, isRecord(error.response) ? error.response : null]) {
    if (source === null) {
      continue
    }
    for (const key of ['status', 'statusCode', 'httpStatus']) {
      const value = source[key]
      if (typeof value === 'number' && value >= 400) {
        return value
      }
    }
  }
  return null
}

/**
 * 这次读失败要不要再试一次（#896：**不再自己写一份 4xx 判据**）。
 *
 * 改前这里是 `!(status >= 400 && status < 500)` —— 一句话把 **429 也算进了「服务端说你不对」**，
 * 于是同一个 429 在设置页不重试、在聊天层重试（`api/errors` 判它可重试）。限流是**临时**的，
 * 等一会儿真有额度；「其余 4xx 不重试」与它分开，判据统一在 `net/requestPolicy.ts`。
 *
 * 类取 `data`：读开关是幂等只读请求，重发不会造成任何副作用（重试次数与退避仍由本文件的
 * `FLAGS_RETRY` 决定：300~800ms 带抖动，那是「怎么等」，不是「等多久」）。
 */
export const isRetryableStatus = (status: number | null): boolean =>
  retryableFailure(failureOfStatus(status))

/** 一次「调用 reader」的结局（抛错不进控制流，统一归一成数据） */
type ReadOutcome = { ok: true; raw: unknown } | { ok: false; status: number | null }

const readOnce = async (source: PublicSettingsReader): Promise<ReadOutcome> => {
  try {
    return { ok: true, raw: await source() }
  } catch (error) {
    return { ok: false, status: statusOfThrown(error) }
  }
}

/**
 * 读取实现在**不抛错**的前提下交回的失败信号（生产 reader 就是这种：`result.ok ? data : null`）。
 * 返回 `{failed, status}`：`status` 为 `null` 时按「没有状态码的失败」= 值得重试。
 */
const failureOfValue = (raw: unknown): { failed: boolean; status: number | null } => {
  if (raw === null || raw === undefined) {
    return { failed: true, status: null }
  }
  if (!isRecord(raw)) {
    return { failed: false, status: null }
  }
  if (raw.ok === false) {
    const nested = isRecord(raw.error) ? statusOfThrown(raw.error) : null
    return { failed: true, status: nested ?? statusOfThrown(raw) }
  }
  const code = raw.code
  if (typeof code === 'number' && code >= 400) {
    return { failed: true, status: code }
  }
  return { failed: false, status: null }
}

/** 第 `attempt` 次（0 起）重试前等多久：`min(maxDelay, base * 2^attempt) + jitter`，落在 300~800ms 区间 */
export const backoffDelayOf = (
  attempt: number,
  config: { baseDelayMs: number; maxDelayMs: number; jitterMs: number; random: () => number }
): number => {
  const backoff = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** Math.max(0, attempt))
  const jitter = Math.round(config.random() * config.jitterMs)
  return backoff + jitter
}

/**
 * 读一次开关，**永不抛错**，失败会重试。
 *
 * 重试策略见 {@link FLAGS_RETRY}：网络 / 超时 / 5xx 最多再试 2 次（300~800ms 带抖动），4xx 与
 * 「200 但形状不认识」不重试。全失败 → `registration: 'unknown'` + `readFailed: true`：
 * **不本地拦注册**，返回的布尔镜像只是保守的 `false`。
 *
 * 为什么不落盘缓存：开关是「启动时读一次、由服务端说了算」的短时效信息（#484 §3.1d），
 * 落盘缓存一份就等于在本地维护第二份开关，正是该条要禁的东西。
 */
export const loadAuthFlags = async (options: AuthFlagsLoadOptions = {}): Promise<AuthFlags> => {
  const retries = Math.max(0, Math.floor(options.retries ?? FLAGS_RETRY.retries))
  const sleep = options.sleep ?? defaultSleep
  const config = {
    baseDelayMs: options.baseDelayMs ?? FLAGS_RETRY.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? FLAGS_RETRY.maxDelayMs,
    jitterMs: options.jitterMs ?? FLAGS_RETRY.jitterMs,
    random: options.random ?? Math.random,
  }
  const source = reader
  if (source === null) {
    // 还没接线：这不是「读失败」（一个请求都没发过），只是「还不知道」—— 不给重试提示
    applySnapshot(unknownAuthFlagsSnapshot(), false)
    return { ...CONSERVATIVE_AUTH_FLAGS }
  }

  for (let attempt = 0; ; attempt += 1) {
    const outcome = await readOnce(source)
    let snapshot: AuthFlagsSnapshot
    let retryable: boolean
    if (outcome.ok) {
      const failure = failureOfValue(outcome.raw)
      if (failure.failed) {
        snapshot = unknownAuthFlagsSnapshot()
        retryable = isRetryableStatus(failure.status)
      } else {
        snapshot = parseAuthFlagsSnapshot(outcome.raw)
        // 200 但拿不到布尔（空壳 / 形状不认识 / 错误信封）：同一份回包重试还是它，直接认 unknown
        retryable = false
      }
    } else {
      snapshot = unknownAuthFlagsSnapshot()
      retryable = isRetryableStatus(outcome.status)
    }

    if (retryable && attempt < retries) {
      await sleep(backoffDelayOf(attempt, config))
      continue
    }

    applySnapshot(snapshot, snapshot.registration === 'unknown')
    return { ...snapshot.flags }
  }
}

/** 当前开关（非组件代码用；组件请 `useAuthFlags()`） */
export const getAuthFlags = (): AuthFlagsState => useAuthFlags.getState()

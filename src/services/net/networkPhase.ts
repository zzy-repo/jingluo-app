/**
 * 网络失败的**分段归因**（Issue #895 / 母单 #894）：一次失败到底断在 DNS、TCP、TLS、
 * 还是「连上了但一个字都没来」。
 *
 * 为什么必须有它：改前 `ApiError` 只有 `kind`（http / network / timeout / idle / …），
 * DNS 解析失败与 TLS 握手失败**都是 `network`**，界面上同一句「连不上」。于是线上只能
 * 靠人 SSH 去试——「用户打不通」和「对面挂了」分不开，弱网优化也没有可用的分母。
 *
 * ## 八档，而不是原单列的七档
 *
 * 原单写的是 `dns | tcp | tls | http | first_byte | idle | abort`。本模块在**前面**加了
 * `offline`，理由不是口味：
 *  - **出路不同**：`offline`（系统说没网）要提示「检查网络 / 开关飞行模式」，
 *    `dns` 要提示「换个网络 / 检查域名」——把没网的手机说成「域名解析失败」，
 *    用户会去改 DNS，改完还是连不上；
 *  - **耗时不同**：`offline` 是 0ms 就判死，`dns` 要等解析超时（秒级）。混成一档，
 *    分阶段耗时就没法对账；
 *  - 同理 `abort` 不是失败（用户自己点的停止），它必须在最前面被摘掉，不能被归成任何一种传输失败。
 *
 * ## 「判不出」是合法结论
 *
 * `phase` 是**可选的**。浏览器的 `fetch` 失败时只给一个 `TypeError: Failed to fetch`，
 * 没有 DNS/TCP/TLS 的原话；`PerformanceResourceTiming` 对失败请求也不一定给 entry。
 * 这时候写 `tcp` 就是编——下一轮排查会被它误导。判不出就 `undefined`，并且
 * `evidence: 'none' | 'timeout-code'` 把「凭什么这么判」一起交出去。
 *
 * 平台可判性（实测口径，写在这里免得下一个人重复试）：
 *
 * | phase        | 原生（APK / CapacitorHttp） | Web（浏览器 fetch）                        |
 * | ------------ | --------------------------- | ------------------------------------------ |
 * | `offline`    | ✅ `navigator.onLine`        | ✅ 同左                                     |
 * | `dns`        | ✅ `UnknownHostException`    | ⚠️ 需要 resource timing（`domainLookupEnd=0`） |
 * | `tcp`        | ✅ `ConnectException`        | ⚠️ 同上（`connectStart>0 && connectEnd=0`）   |
 * | `tls`        | ✅ `SSLHandshakeException`   | ⚠️ 同上（`secureConnectionStart>0 && connectEnd=0`） |
 * | `first_byte` | ✅ 首字预算                  | ✅ 首字预算                                |
 * | `idle`       | ✅ 空闲预算                  | ✅ 空闲预算                                |
 * | `http`       | ✅ 有状态码                  | ✅ 有状态码                                |
 * | `abort`      | ✅ 调用方 signal             | ✅ 调用方 signal                           |
 *
 * ## 两份口径必须一致
 *
 * 三段超时的**能不能重试**已经有一张表（`chat/timeoutPolicy.ts`，#568），本模块不另立一套：
 * `connect_timeout / first_token_timeout / idle_timeout` 的 `retryable` 必须与那张表逐条相等，
 * 由 `tests/unit/net-failure-phase-895.test.mjs` 的 [6] 钉住（改一边不改另一边会红）。
 *
 * 零依赖纯模块：不认识 store / client / i18n，L0 用例直接跑真代码。
 */

/**
 * 分段枚举（前后端同名同值，#895 必做 1）。
 *
 * 顺序 = 归类时的优先级顺序，也是「一次请求走过的顺序」：没网 → 解析 → 建连 → 握手 →
 * 拿到响应 → 首字节 → 正文流动 → 用户取消（`abort` 不在这条时间轴上的固定位置，排最后）。
 */
export const NET_FAILURE_PHASES = [
  'offline',
  'dns',
  'tcp',
  'tls',
  'http',
  'first_byte',
  'idle',
  'abort',
] as const

export type NetFailurePhase = (typeof NET_FAILURE_PHASES)[number]

/**
 * 这个结论是**凭什么**判出来的（进诊断，让人能复核，也能看出「这一段其实没有证据」）。
 *  - `abort`           调用方 signal / AbortError（不是失败）
 *  - `offline`         `navigator.onLine === false`
 *  - `http-status`     拿到了 HTTP 状态码（网络这一段是通的）
 *  - `timeout-code`    三段超时的 `ApiError.code`
 *  - `native-message`  原生栈异常文本（`UnknownHostException` 一类）
 *  - `resource-timing` `PerformanceResourceTiming` 显示走到了哪一段
 *  - `none`            判不出
 */
export type NetPhaseEvidence =
  | 'abort'
  | 'offline'
  | 'http-status'
  | 'timeout-code'
  | 'native-message'
  | 'resource-timing'
  | 'none'

/**
 * 给用户的**下一步**（诊断里写一句，界面文案仍由 `chat/errorNotice.ts` 的表决定）。
 *  - `check-network`  先看手机有没有网 / 换个网络
 *  - `check-endpoint` 网络是通的，是「这个地址打不开」——检查地址、代理、证书
 *  - `retry`          同一条请求再发一次可能就成
 *  - `none`           没有可执行动作（取消、纯 HTTP 业务失败）
 */
export type NetUserAction = 'check-network' | 'check-endpoint' | 'retry' | 'none'

/**
 * 分段耗时（毫秒）。**取不到的写 `null`，不许写 0 冒充**（0 是「这一段没花时间」的意思，
 * 与「拿不到」是两件事）。
 */
export type NetTimings = {
  /** DNS 解析 */
  dnsMs?: number | null
  /** TCP 建连（到 TLS 开始为止；明文就是建连全程） */
  tcpMs?: number | null
  /** TLS 握手 */
  tlsMs?: number | null
  /** 请求发出 → 响应头（上游排队 + 网关） */
  waitMs?: number | null
  /** 请求发出 → 首个内容（与 `diagnostics/timing.ts` 的 `firstTokenMs` 同一口径） */
  firstByteMs?: number | null
  /** 点发送 → 这一次失败 */
  totalMs?: number | null
}

/** 挂到错误对象上的那一坨（`ApiError.net`） */
export type NetFailureMeta = {
  /** 卡在哪一段；`undefined` = 判不出（见文件头「判不出是合法结论」） */
  phase?: NetFailurePhase
  evidence: NetPhaseEvidence
  /** 原则上值不值得再发一次（「已经出过内容」这条判据由调用方叠加，见 `timeoutPolicy`） */
  retryable: boolean
  userAction: NetUserAction
  timings?: NetTimings
}

/**
 * `PerformanceResourceTiming` 里我们用得上的那几段（毫秒，相对 `startTime`）。
 * 只声明用到的字段：不 import DOM 类型，Node 单测里能直接构造。
 */
export type ResourcePhases = {
  domainLookupStart?: number
  domainLookupEnd?: number
  connectStart?: number
  connectEnd?: number
  secureConnectionStart?: number
  requestStart?: number
  responseStart?: number
}

export type NetFailureInput = {
  /** 调用方取消（用户点了停止 / 组件卸载） */
  aborted?: boolean
  /** `navigator.onLine === false`；拿不到就别传（默认按在线处理） */
  offline?: boolean
  /** `ApiError.code`（三段超时等） */
  code?: string
  /** HTTP 状态码；有值就说明网络这一段是通的 */
  status?: number
  /** 原生栈 / fetch 的异常原文：**只用于归因，不上屏**（与 #484 §7 同一条红线） */
  nativeMessage?: string
  /** `PerformanceResourceTiming` 的分段（拿不到就不传） */
  timing?: ResourcePhases
}

/** 原生栈异常文本 → phase 的三组特征（大小写不敏感） */
const DNS_TEXT =
  /unknownhost|unable to resolve host|no address associated with hostname|nodename nor servname|getaddrinfo|enotfound|eai_again/i
const TLS_TEXT =
  /sslhandshake|sslpeerunverified|sslhandshakeexception|certpath|certpathvalidator|certificate|trust anchor|err_cert|err_ssl|tls handshake|handshake failed/i
const TCP_TEXT =
  /connectexception|econnrefused|connection refused|ehostunreach|enetunreach|ehunreach|etimedout|econnreset|connection reset|broken pipe|err_connection_refused|err_connection_reset|err_address_unreachable/i

const asMs = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0

/** 三段超时的 code → phase（与 `chat/timeoutPolicy.ts` 的 code 是同一批字符串） */
const TIMEOUT_CODE_PHASE: Record<string, NetFailurePhase> = {
  connect_timeout: 'tcp',
  first_token_timeout: 'first_byte',
  idle_timeout: 'idle',
}

/** 按 `ApiError.status` 判「重发有没有意义」（429 / 5xx 有，其余 4xx 没有） */
const retryableStatus = (status: number): boolean => status === 429 || status >= 500

/** 传输档（网络本身没通）的可重试性：只有「用户取消」不算可重试 */
const isTransportPhase = (phase: NetFailurePhase | undefined): boolean =>
  phase === 'offline' || phase === 'dns' || phase === 'tcp' || phase === 'tls'

/** phase → 给用户的下一步 */
const actionOf = (phase: NetFailurePhase | undefined): NetUserAction => {
  if (phase === 'offline' || phase === 'dns') {
    return 'check-network'
  }
  if (phase === 'tcp' || phase === 'tls') {
    return 'check-endpoint'
  }
  if (phase === 'first_byte' || phase === 'idle') {
    return 'retry'
  }
  return 'none'
}

/**
 * 从 `PerformanceResourceTiming` 推「走到了哪一段」。
 *
 * 判据只看「哪一段**开始了但没结束**」：
 *  - 解析开始、没结束 → `dns`
 *  - 解析完了、握手开始、没握完 → `tls`
 *  - 解析完了、连也没连上 → `tcp`
 *  - 连上了但没有响应头 → `first_byte`
 *  - 有响应头 → `http`（但真拿到状态码时调用方已经先判了 http，这里只是兜底）
 */
const phaseFromTiming = (timing: ResourcePhases | undefined): NetFailurePhase | undefined => {
  if (!timing) {
    return undefined
  }
  const lookupStart = asMs(timing.domainLookupStart)
  const lookupEnd = asMs(timing.domainLookupEnd)
  const connectStart = asMs(timing.connectStart)
  const connectEnd = asMs(timing.connectEnd)
  const secureStart = asMs(timing.secureConnectionStart)
  const responseStart = asMs(timing.responseStart)

  if (responseStart > 0) {
    return 'http'
  }
  if (connectEnd > 0) {
    // 浏览器在 TLS 失败时会让 connectEnd 停在 secureConnectionStart（Chromium 口径）
    if (secureStart > 0 && connectEnd === secureStart) {
      return 'tls'
    }
    // 连上了、请求发出去了、响应头没来
    return 'first_byte'
  }
  if (secureStart > 0) {
    return 'tls'
  }
  if (connectStart > 0 || lookupEnd > 0) {
    return 'tcp'
  }
  if (lookupStart > 0) {
    return 'dns'
  }
  return undefined
}

/**
 * 分段耗时归一：只写「算得出来」的段，算不出来就是 `null`。
 *
 * `tcpMs` 的口径是「建连这一段」，有 TLS 时到握手开始为止、没有 TLS 时到连接完成；
 * `waitMs` 是「请求发出 → 响应头」，与 `ttfbMs` 的差别只在于起点（这里用 `requestStart`）。
 */
export const netTimingsOf = (timing: ResourcePhases | undefined): NetTimings => {
  if (!timing) {
    return { dnsMs: null, tcpMs: null, tlsMs: null, waitMs: null }
  }
  const lookupStart = asMs(timing.domainLookupStart)
  const lookupEnd = asMs(timing.domainLookupEnd)
  const connectStart = asMs(timing.connectStart)
  const connectEnd = asMs(timing.connectEnd)
  const secureStart = asMs(timing.secureConnectionStart)
  const requestStart = asMs(timing.requestStart)
  const responseStart = asMs(timing.responseStart)

  const dnsMs = lookupEnd > 0 ? Math.max(0, lookupEnd - lookupStart) : null
  const tcpEnd = secureStart > 0 ? secureStart : connectEnd
  const tcpMs = connectStart > 0 && tcpEnd > 0 ? Math.max(0, tcpEnd - connectStart) : null
  const tlsMs = secureStart > 0 && connectEnd > 0 ? Math.max(0, connectEnd - secureStart) : null
  const waitMs =
    requestStart > 0 && responseStart > 0 ? Math.max(0, responseStart - requestStart) : null
  return { dnsMs, tcpMs, tlsMs, waitMs }
}

/**
 * **唯一判定处**：把「调用方知道的现场」（取消 / 离线 / 状态码 / 超时码 / 原生异常 / 已测到的分段）
 * 折成一个 `phase + evidence + retryable + userAction`。
 *
 * 判定顺序（先判「确定的事」，最后才靠证据推）：
 * 1. 取消 → `abort`（不是失败，绝不重试）；
 * 2. 系统说没网 → `offline`（0ms 就能判死，别等 60s 建连预算）；
 * 3. 有状态码 → `http`（网络这一段是通的，剩下的按状态码判）；
 * 4. 首字 / 空闲两段超时 → `first_byte` / `idle`（这两段是确定的，不需要再猜）；
 * 5. 原生异常文本 → `dns` / `tls` / `tcp`；
 * 6. `PerformanceResourceTiming` → 按「开始了没结束」的那一段；
 * 7. `connect_timeout` → 只到这步才用它，且**没有任何 timing 证据时判不出**（不硬塞 tcp）。
 */
export const classifyNetFailure = (input: NetFailureInput = {}): NetFailureMeta => {
  if (input.aborted === true) {
    return { phase: 'abort', evidence: 'abort', retryable: false, userAction: 'none' }
  }
  if (input.offline === true) {
    return {
      phase: 'offline',
      evidence: 'offline',
      retryable: true,
      userAction: 'check-network',
      ...(input.timing ? { timings: netTimingsOf(input.timing) } : {}),
    }
  }
  if (typeof input.status === 'number' && Number.isFinite(input.status) && input.status > 0) {
    return {
      phase: 'http',
      evidence: 'http-status',
      retryable: retryableStatus(input.status),
      userAction: 'none',
      ...(input.timing ? { timings: netTimingsOf(input.timing) } : {}),
    }
  }

  const code = typeof input.code === 'string' ? input.code : ''
  if (code === 'first_token_timeout' || code === 'idle_timeout') {
    const phase = TIMEOUT_CODE_PHASE[code] as NetFailurePhase
    return {
      phase,
      evidence: 'timeout-code',
      retryable: true,
      userAction: actionOf(phase),
      ...(input.timing ? { timings: netTimingsOf(input.timing) } : {}),
    }
  }

  const native = typeof input.nativeMessage === 'string' ? input.nativeMessage : ''
  if (native !== '') {
    if (DNS_TEXT.test(native)) {
      return {
        phase: 'dns',
        evidence: 'native-message',
        retryable: true,
        userAction: 'check-network',
        ...(input.timing ? { timings: netTimingsOf(input.timing) } : {}),
      }
    }
    if (TLS_TEXT.test(native)) {
      return {
        phase: 'tls',
        evidence: 'native-message',
        retryable: true,
        userAction: 'check-endpoint',
        ...(input.timing ? { timings: netTimingsOf(input.timing) } : {}),
      }
    }
    if (TCP_TEXT.test(native)) {
      return {
        phase: 'tcp',
        evidence: 'native-message',
        retryable: true,
        userAction: 'check-endpoint',
        ...(input.timing ? { timings: netTimingsOf(input.timing) } : {}),
      }
    }
  }

  const fromTiming = phaseFromTiming(input.timing)
  if (fromTiming !== undefined) {
    return {
      phase: fromTiming,
      evidence: 'resource-timing',
      retryable: true,
      userAction: actionOf(fromTiming),
      timings: netTimingsOf(input.timing),
    }
  }

  if (code === 'connect_timeout') {
    // 到这一步还没有任何「走到哪」的证据：可能是 DNS、TCP 或 TLS，**判不出**。
    return { phase: undefined, evidence: 'timeout-code', retryable: true, userAction: 'none' }
  }

  // 什么证据都没有：按「临时故障、可以再试」处理（与改前 `network` 档一致），但 phase 不编
  return { phase: undefined, evidence: 'none', retryable: true, userAction: 'none' }
}

/** 这个 meta 说的是不是「网络本身没通」（传输档）：`api/errors.ts` 据此决定要不要读它 */
export const isTransportFailure = (meta: NetFailureMeta | undefined): boolean =>
  meta !== undefined && isTransportPhase(meta.phase)

/** 从异常文本判离线：拿不到 `navigator`（Node / 单测）时一律按「在线」处理 */
export const isOfflineNow = (): boolean => {
  try {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator
    return nav?.onLine === false
  } catch {
    return false
  }
}

/**
 * 失败之后的**一次**「只判路」主动探测（Issue #899，母单 #894）。
 *
 * ## 它要解决的问题
 *
 * #895 让失败带上了「卡在哪一段」（`NetFailurePhase`），但 web 侧实测只能判出
 * `offline / http / first_byte / idle / abort` —— `dns / tcp / tls` **判不出来**：
 * `fetch` 失败只给一句 `Failed to fetch`，Chromium 把 `net::ERR_NAME_NOT_RESOLVED` 与证书错误
 * 只打印到 console，失败请求的 `PerformanceResourceTiming` 分段全为 0（#899 复测：真 DNS 失败 /
 * 真 connection refused / 真自签证书握手失败三种，Chromium 与 Firefox 都是 0）。
 * 于是诊断里只能写「失败分段: 判不出（依据 none）」，读的人分不清**「没试过」**和
 * **「试过了、平台给不出」**。
 *
 * 本模块补的就是这一句话：失败且 `phase === undefined` 时，在后台重走一次**只有判路意义**的
 * 最小请求（`HEAD` + `no-cors` 打同源根路径），把结论分成四档：
 *
 *  - `reached`     —— 探测通了：刚才那一下是**瞬时抖动**，不是某一段坏了；
 *  - `failed`      —— 探测也失败了：**如果宿主给了分段证据**就据此细分 dns / tcp / tls，
 *                     没给就老实写「平台限制」（web 上是常态）；
 *  - `timeout`     —— 探测自己撞上盖子：**没有任何证据 → 判不出**（绝不猜成 tcp）；
 *  - `unsupported` —— 这个环境没有 `fetch` / 地址根本不是绝对 URL：连试都试不了。
 *
 * ## 三条纪律（改之前先读）
 *
 * 1. **不许推翻既有判定**。探测结论只在「已经什么都没判出来」时被采信，且在
 *    `classifyNetFailure` 里排**最后**一步；探测只能把「判不出」细分成 `dns / tcp / tls`，
 *    不许改 `offline / abort / http / first_byte / idle`，也不许把 `phase` 从 A 改到 B。
 * 2. **不许瞎猜**。平台没给分段就写没给，探测超时就写超时 —— 「判不出」是合法结论
 *    （#895 文件头同一条纪律），编一个 `tcp` 只会让下一轮排查被误导。
 * 3. **代价必须极便宜**：单次上限 `LIMITS.netPhaseProbeMs`（2s）、**失败后最多一次**、
 *    后台跑（`startNetProbe` 不返回 promise、不 await），绝不阻塞用户的主要动作。
 *
 * ## 为什么传输是可注入的
 *
 * 单测与 390/360 取证都要在**不发真实网络请求**的前提下验「探测说得对会怎样」。
 * 生产用 `defaultTransport`（真 `fetch`）；测试用 `setNetProbeTransport()` 换桩，
 * 桩也负责模拟「平台给了分段」这种 web 实测拿不到、但原生桥 / 未来 API 能给的情形。
 */

import { LIMITS } from '../limits.js'
import type { NetProbeEvidence, NetProbeOutcome, ResourcePhases } from './networkPhase.js'

/** 探测单次上限（毫秒）。数字只在 `LIMITS` 里写一次（`check:bare-const` 也守这条） */
export const NET_PROBE_TIMEOUT_MS = LIMITS.netPhaseProbeMs

/** 探测的四种结论；`reached` 之外的三种都**不构成**「卡在哪一段」的证据（词表在 `networkPhase.ts`，只有一份） */
export type { NetProbeOutcome }

export type NetProbeResult = NetProbeEvidence & {
  /** 探测目标（诊断里写出来：读的人知道我们打的是哪台机器的最小路径） */
  url?: string
  /** 失败时的异常原文：**只用于归因，不上屏**（与 #484 §7 同一条红线） */
  message?: string
}

/** 传输层原始结论：只回答「通没通」，分段证据是附带的（可能没有） */
export type NetProbeTransportResult =
  | { kind: 'reached' }
  | { kind: 'failed'; timing?: ResourcePhases; message?: string }

/** 可注入的探测传输：**不许抛**（异常由本模块折成 `failed`），必须尊重 `signal` */
export type NetProbeTransport = (url: string, signal: AbortSignal) => Promise<NetProbeTransportResult>

/**
 * 探测目标：**同源最小路径**（`origin + '/'`）。
 *
 * 为什么不是重发原请求：原请求可能带 body / 鉴权 / 计费副作用，而探测只想知道「这台机器
 * 的解析、建连、握手能不能走通」。`HEAD` + 根路径是最便宜的一枪。
 * 相对路径 / 非法地址返回 `undefined` —— 判不出就说判不出，不猜一个地址去打。
 */
export const probeUrlOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return undefined
    }
    return `${parsed.origin}/`
  } catch {
    return undefined
  }
}

/**
 * 读 `PerformanceResourceTiming` 里我们用得上的几段（毫秒）。
 *
 * 与 #895 失败路径读的是同一份数据 —— 所以本函数是**唯一实现**，`api/client.ts` 也从这里 import
 * （两份实现迟早分叉，而分叉的那天已经发过版）。拿不到就 `undefined`：判不出就写判不出。
 */
export const resourcePhasesOf = (url: string): ResourcePhases | undefined => {
  try {
    const perf = (globalThis as { performance?: Performance }).performance
    if (perf === undefined || typeof perf.getEntriesByName !== 'function') {
      return undefined
    }
    const entries = perf.getEntriesByName(url, 'resource')
    const entry = entries[entries.length - 1] as PerformanceResourceTiming | undefined
    if (entry === undefined) {
      return undefined
    }
    return {
      domainLookupStart: entry.domainLookupStart,
      domainLookupEnd: entry.domainLookupEnd,
      connectStart: entry.connectStart,
      connectEnd: entry.connectEnd,
      secureConnectionStart: entry.secureConnectionStart,
      requestStart: entry.requestStart,
      responseStart: entry.responseStart,
    }
  } catch {
    // 老 WebView 没有 resource timing / 调用被安全策略拒：按「没有证据」处理
    return undefined
  }
}

/**
 * 生产传输：一次 `HEAD` + `no-cors`，**任何响应都算「通了」**。
 *
 * `no-cors` 是关键：跨域探测不需要读响应体，而 `cors` 模式下的预检失败会把「路是通的、
 * 只是不许跨域」误判成「连不上」。opaque 响应（`status === 0`）同样证明解析、建连、
 * 握手全程走通了 —— 那正是我们要的那一比特。
 */
const defaultTransport: NetProbeTransport = async (url, signal) => {
  const response = await fetch(url, {
    method: 'HEAD',
    mode: 'no-cors',
    cache: 'no-store',
    redirect: 'follow',
    credentials: 'omit',
    signal,
  })
  void response
  // 失败请求在 web 上拿不到分段（实测全 0），照实交出去：由 classifier 判「有没有证据」
  return { kind: 'reached' }
}

let transport: NetProbeTransport = defaultTransport

/**
 * 换探测传输（单测 / 取证用）。传 `null` / 不传 = 恢复生产实现。
 *
 * 这是**测试注入口**，不是运行开关：生产代码路径里没有任何调用点。
 */
export const setNetProbeTransport = (next?: NetProbeTransport | null): void => {
  transport = next ?? defaultTransport
}

/**
 * 跑一次探测。**只跑一次，不重试**（重试会让「失败后最多一次」失去意义）。
 *
 * 超时盖子在本函数里：`AbortController` + `Promise.race`，所以即使传输桩不认 `signal`
 * 也照样按时收口。传输抛错一律折成 `failed`（带上能拿到的分段证据）。
 */
export const runNetProbe = async (
  url: string,
  options: { timeoutMs?: number } = {}
): Promise<NetProbeResult> => {
  const target = probeUrlOf(url)
  if (target === undefined) {
    return { outcome: 'unsupported' }
  }
  if (typeof fetch !== 'function') {
    return { outcome: 'unsupported', url: target }
  }
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0
      ? options.timeoutMs
      : NET_PROBE_TIMEOUT_MS
  const started = Date.now()
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const timeout = new Promise<NetProbeTransportResult>((resolve) => {
    // 与上面同一个盖子：桩不认 signal 时由这一支兜住（不是第二套超时口径）
    setTimeout(() => resolve({ kind: 'failed', message: `probe timeout ${timeoutMs}ms` }), timeoutMs)
  })
  try {
    const result = await Promise.race([transport(target, controller.signal), timeout])
    const elapsedMs = Date.now() - started
    if (timedOut) {
      return { outcome: 'timeout', url: target, elapsedMs }
    }
    if (result.kind === 'reached') {
      return { outcome: 'reached', url: target, elapsedMs }
    }
    return {
      outcome: 'failed',
      url: target,
      elapsedMs,
      // 分段证据只认「宿主真的给了」的那一份：拿不到就是 undefined，不补 0
      ...(result.timing === undefined ? {} : { timing: result.timing }),
      ...(result.message === undefined ? {} : { message: result.message }),
    }
  } catch (error) {
    const elapsedMs = Date.now() - started
    if (timedOut) {
      return { outcome: 'timeout', url: target, elapsedMs }
    }
    return {
      outcome: 'failed',
      url: target,
      elapsedMs,
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ...(() => {
        const timing = resourcePhasesOf(target)
        return timing === undefined ? {} : { timing }
      })(),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * **后台**跑一次探测，结论晚到就交给 `onDone`。
 *
 * 为什么不是 `await`：探测的调用点是「用户已经失败、正要看到错误提示」的那一刻，
 * 让错误提示等 2s 就是拿主流程给诊断垫背（#899 必做 1 的「不许阻塞用户主要动作」）。
 * 返回值是 `undefined`（不是 promise）—— 想等结果的人请直接用 `runNetProbe`。
 */
export const startNetProbe = (url: string, onDone: (result: NetProbeResult) => void): void => {
  void runNetProbe(url).then(
    (result) => {
      try {
        onDone(result)
      } catch {
        // 诊断补写失败不许影响主流程：探测只是旁证
      }
    },
    () => {
      // runNetProbe 自己已经把所有失败折成结果；这里只兜「连折都没折成」的极端情况
      try {
        onDone({ outcome: 'unsupported' })
      } catch {
        /* 同上：旁证不许影响主流程 */
      }
    }
  )
}

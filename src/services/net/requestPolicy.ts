/**
 * **一张表**决定「这类请求在失败后怎么重试」（Issue #896 的主体，母单 #894）。
 *
 * ## 为什么要这张表
 *
 * 改前，重试判定散在十处，各写各的：
 *   `api/errors`（isRetryableApiError / isRetryableStatus）、`chat/timeoutPolicy`（三段超时矩阵）、
 *   `chat/streamBreakout`（断流 5 次 / 半截 1 次 / 60s 预算）、`chat/store`（decideStreamRetry 的上限）、
 *   `auth/flags`（自己一份 isRetryableStatus）、`api/managedKey`、`ours/purchases`、
 *   `consume/errors`（retryable 字段）、`diagnostics/reasons`、`chat/history/urlImport`。
 *
 * 后果不是「代码丑」，而是**同一件事在四层有四种答案**。最刺眼的一条是 429：
 *   · `api/errors`：429 **可**重试（限流是临时的，等一会儿真有额度）；
 *   · `auth/flags:264`：`!(status >= 400 && status < 500)` → 429 **不可**重试（它落在 4xx 区间）；
 *   · `consume/errors`：标 `retryable: true`，但消费链路**从不自动重发**（那一层没有重试循环）。
 * 于是「同一个 429，设置页不重试、聊天重试、消费层标了可重试却没人重试」——
 * 用户看到的差别，来自三个文件里的三个 if，而不是来自产品决定。
 *
 * ## 这张表怎么读
 *
 * **三个类**（按请求的语义分，不按接口分）：
 *  - `control`：有**副作用且不可撤销**的控制类（卡密兑换、创建 Key、登录 / 注册、扣费）。
 *    失败了要**人**决定要不要再来一次 —— 自动重发可能兑换两次、建两把 Key。
 *  - `data`：**幂等**的数据请求（上传补传、自动标题、设置 / 公告 / 额度查询、导入下载）。
 *    重发最多多花一点流量，不会多扣一次钱。
 *  - `stream`：**流式生成**。重发的前提是「用户还什么都没看到」，否则会答两遍、重复计费。
 *
 * 每类七件事：`connectMs / firstByteMs / idleMs / totalMs / retry / backoff / idempotent`。
 *
 * ## 与 `timeoutBudget`（3a）的分工
 *
 * 3a 把「一次请求允许等多久」沉到运行期可读的地方（`timeoutBudget.ts`）；
 * 本文件回答「等不到之后怎么办」。表格里的毫秒值**全部指向既有来源**
 * （`LIMITS.requestTimeouts` / `LIMITS.streamRetryLimit` / `LIMITS.retryBaseDelayMs`），
 * 不在这里新写数字 —— `check:limits` 的口径是「运行期阈值只在 limits.ts 写数字」，本文件不破例。
 *
 * ## 429：唯一口径
 *
 * **429 = 可重试（临时）**，理由是限流是「等一会儿真的有额度」，与 5xx 同类；
 * 两个必须一起写死的边界：
 *  1. 上游用 429 / 400 表达**额度用完**（`insufficient_quota` 一类）时不是限流，
 *     那一档归 `api/errors` 的 `insufficientBalance`（终态）——本表不认识业务码，
 *     调用方必须在问本表**之前**判掉额度；
 *  2. 服务端给了 `Retry-After` 就按它退避（`backoffOf` 的 `retryAfterMs` 优先），
 *     客户端不自己猜节奏。
 */

import { retryableFailure, type RequestFailureKind } from './failureKind.js'
import { LIMITS } from '../limits.js'

/** 请求语义分类（不是接口分类）：`control` 有不可撤销的副作用，`data` 幂等，`stream` 是生成流 */
export const REQUEST_CLASSES = ['control', 'data', 'stream'] as const

export type RequestClass = (typeof REQUEST_CLASSES)[number]

export type RequestRetryPolicy = {
  /** 自动重发上限（**不含**首发）；`0` = 只标记「可重试」，一次都不自动发 */
  maxAttempts: number
  /** 退避基数（毫秒）：第 n 次重发等 `backoffMs × backoffFactor^n` */
  backoffMs: number
  backoffFactor: number
  /** 这一类请求重发是否安全（幂等）。false 的类**永不**自动重发，`retryable` 只给界面用 */
  idempotent: boolean
  /** 重发前是否要求「用户还什么都没看到」（流式：出过字就不许重发） */
  requiresNoContent: boolean
}

export type RequestPolicy = {
  connectMs: number
  /** 响应头 → 首个字节 / 首个 SSE 事件；`0` = 这一类不单独计这一段 */
  firstByteMs: number
  /** 相邻两次数据之间（流式专用）；`0` = 不适用 */
  idleMs: number
  /** 整轮上限；`0` = 不设（由各段预算兜底，不叠加第二个总超时） */
  totalMs: number
  retry: RequestRetryPolicy
}

/**
 * 单一策略表（**唯一判定处**）。
 *
 * 每个毫秒值都指向既有来源，没有一处是新数字；`0` 表示「这一类没有这一段预算」，
 * 不是「0 毫秒超时」——判据在 `budgetOf`（`0` 一律当「不计时」）。
 */
export const REQUEST_POLICY: Record<RequestClass, RequestPolicy> = {
  /**
   * 控制类：卡密兑换 / 创建 Key / 登录 / 扣费。
   *
   * `maxAttempts: 0` 是**产品决定**，不是保守：#484 §4.3 的教训是「卡密重复兑换、Key 重复创建
   * 都是重试重出来的」。所以这一类只回答「这次失败值不值得让用户再点一次」（`retryable`），
   * 绝不自己发第二枪。`idempotent: false` 把这条决定写在表里，而不是散在各调用点的 if 里。
   */
  control: {
    connectMs: LIMITS.requestTimeouts.connectMs,
    firstByteMs: 0,
    idleMs: 0,
    totalMs: 0,
    retry: {
      maxAttempts: 0,
      backoffMs: LIMITS.retryBaseDelayMs,
      backoffFactor: 2,
      idempotent: false,
      requiresNoContent: false,
    },
  },
  /**
   * 数据类：上传补传 / 自动标题 / 设置与公告 / 额度查询 / 导入下载。
   *
   * 与流式共用 `streamRetryLimit`（#105 的「附件补传、断网、5xx、超时共用这一个上限」），
   * 但**没有** firstByte / idle 这两段预算 —— 非流式请求读到的是一次完整响应体。
   */
  data: {
    connectMs: LIMITS.requestTimeouts.connectMs,
    firstByteMs: 0,
    idleMs: 0,
    totalMs: 0,
    retry: {
      maxAttempts: LIMITS.streamRetryLimit,
      backoffMs: LIMITS.retryBaseDelayMs,
      backoffFactor: 2,
      idempotent: true,
      requiresNoContent: true,
    },
  },
  /**
   * 流式类：三段预算（连接 / 首字 / 空闲）各管一段（#568），重发上限沿用 #105 的通用档。
   *
   * `requiresNoContent: true` 是硬纪律：已经吐出字再重发 = 答两遍 + 重复计费（#105 / #150）。
   */
  stream: {
    connectMs: LIMITS.requestTimeouts.connectMs,
    firstByteMs: LIMITS.requestTimeouts.firstTokenMs,
    idleMs: LIMITS.requestTimeouts.idleMs,
    totalMs: 0,
    retry: {
      maxAttempts: LIMITS.streamRetryLimit,
      backoffMs: LIMITS.retryBaseDelayMs,
      backoffFactor: 2,
      idempotent: true,
      requiresNoContent: true,
    },
  },
}

/**
 * 失败分类与「值不值得再试」的判据不在这里：它们在 `net/failureKind.ts`（零依赖纯模块）。
 * 本文件只回答「哪一类请求、多少毫秒、几次、怎么退避」。
 */
export {
  RATE_LIMIT_RETRYABLE,
  failureOfStatus,
  retryableFailure,
  type RequestFailureKind,
} from './failureKind.js'


/**
 * 这一类在这条失败上「能不能自动再发一次」——**次数与内容两条判据一起给**。
 *
 * 调用方只需要把「已经试过几次」「用户看到内容了吗」交给它，不必各自去比 `attempt < 上限`
 * 或各写一遍 `receivedContent && ...`（改前这两条散在 `chat/store` 与 `chat/streamBreakout`）。
 */
export const canAutoRetry = (input: {
  cls: RequestClass
  failure: RequestFailureKind
  /** 已经重试过几次（首发 = 0） */
  attempt: number
  /** 这一轮是否已经向用户输出过内容（流式专用；非流式传 false） */
  receivedContent?: boolean
}): boolean => {
  const policy = REQUEST_POLICY[input.cls]
  if (!policy.retry.idempotent) {
    return false
  }
  if (!retryableFailure(input.failure)) {
    return false
  }
  if (policy.retry.requiresNoContent && input.receivedContent === true) {
    return false
  }
  return input.attempt < policy.retry.maxAttempts
}

/**
 * 重发前的等待（毫秒）。
 *
 * `retryAfterMs` 优先（服务端说了算，429 的 `Retry-After` 就是从这里进来的）；
 * 没给就按本类的 `backoffMs × backoffFactor^attempt` 指数退避。
 * **不在这里加随机抖动**：抖动的形状各调用点不同（设置页要 300~800ms 带抖动、
 * 聊天要可中断的 sleep），那是「怎么等」而不是「等多久」，混进来会让两边都不好用。
 */
export const backoffOf = (
  cls: RequestClass,
  attempt: number,
  retryAfterMs?: number | null
): number => {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.round(retryAfterMs)
  }
  const { backoffMs, backoffFactor } = REQUEST_POLICY[cls].retry
  return backoffMs * backoffFactor ** Math.max(0, Math.round(attempt))
}

/** 取某一类的策略（只读；要改请改表本身，别在调用点写局部特例） */
export const requestPolicyOf = (cls: RequestClass): RequestPolicy => REQUEST_POLICY[cls]

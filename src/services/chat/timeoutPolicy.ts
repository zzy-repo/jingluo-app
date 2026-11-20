/**
 * 三段超时的**重试矩阵**（#568）。
 *
 * 请求超时被拆成三段之后（连接 / 首字 / 空闲），「哪一段可以自动重试」不能靠读代码猜，
 * 必须是一张能单测、能逐行 review 的表：
 *
 * | code                 | 阶段        | 自动重试 | 条件                     |
 * | -------------------- | ----------- | -------- | ------------------------ |
 * | `connect_timeout`    | 连接        | ✅       | 必须还没向用户输出任何内容 |
 * | `first_token_timeout`| 首字        | ✅       | 必须还没向用户输出任何内容 |
 * | `idle_timeout`       | 空闲        | ⚠️       | 只有**还没出过字**时才重试 |
 *
 * 为什么空闲超时这一行是「有条件」的：空闲超时**可能发生在正文中途**（最常见的形态就是
 * 吐了半句然后不动了）。这时候重发会从头再生成一遍 —— 用户看到重复内容、上游重复计费，
 * 而 #105 的重试退避完全不知道这回事。所以判定必须是
 * `code 的 retryable && !(requiresNoContent && 已经出过内容)`，两条缺一不可。
 *
 * 本文件**故意不 import 任何东西**（不 import client / limits / i18n）：
 * 判据要能在 L0 用例里直接跑真代码，也要能被「负向对照」拿去做源码级变异
 * （`tests/unit/chat-staged-timeout-568.test.mjs` 把这条表改成「空闲超时无条件重试」再跑一遍，
 * 断言生产用例的期望必须被打破）。引入任何依赖都会让那次变异导入失败，对照就成了摆设。
 */

/** 三段超时的机器可读错误码：与 `ApiError.code` 是同一批字符串（`api/client.ts`） */
export type StreamTimeoutCode = 'connect_timeout' | 'first_token_timeout' | 'idle_timeout'

/** 卡在哪一段：给诊断日志与文案用 */
export type StreamTimeoutStage = 'connect' | 'first_token' | 'idle'

export type StreamTimeoutPolicy = {
  code: StreamTimeoutCode
  stage: StreamTimeoutStage
  /** 这一段超时**原则上**是否值得自动重试 */
  retryable: boolean
  /** 是否要求「还没向用户输出过任何内容」（重发不会重复输出 / 重复计费） */
  requiresNoContent: boolean
}

/**
 * 重试矩阵（唯一判定处）。顺序无关，逐行独立。
 *
 * 三段都是 `requiresNoContent: true`：连接段与首字段天然没有内容，写出来是为了让
 * 「重发是安全的」这件事在表里可读，而不是靠调用方记得「那时候还没出字」。
 */
export const STREAM_TIMEOUT_POLICIES: readonly StreamTimeoutPolicy[] = [
  { code: 'connect_timeout', stage: 'connect', retryable: true, requiresNoContent: true },
  { code: 'first_token_timeout', stage: 'first_token', retryable: true, requiresNoContent: true },
  { code: 'idle_timeout', stage: 'idle', retryable: true, requiresNoContent: true },
]

/** 未知 / 非超时错误码一律 null（调用方按原有分类走，不在这里扩权） */
export const streamTimeoutCodeOf = (value: unknown): StreamTimeoutCode | null =>
  typeof value === 'string' &&
  STREAM_TIMEOUT_POLICIES.some((policy) => policy.code === (value as StreamTimeoutCode))
    ? (value as StreamTimeoutCode)
    : null

export const streamTimeoutPolicyOf = (value: unknown): StreamTimeoutPolicy | null => {
  const code = streamTimeoutCodeOf(value)
  return code === null
    ? null
    : (STREAM_TIMEOUT_POLICIES.find((policy) => policy.code === code) as StreamTimeoutPolicy)
}

/** 卡在哪一段（诊断字段用）；不是三段超时就是 null */
export const streamTimeoutStageOf = (value: unknown): StreamTimeoutStage | null =>
  streamTimeoutPolicyOf(value)?.stage ?? null

/**
 * 这一次超时**能不能自动重试**。
 *
 * @param code 三段超时的错误码（`ApiError.code`）
 * @param receivedContent 这一轮是否已经向用户输出过内容（内容块 / 正文增量）
 * @returns 不是三段超时 → null（由调用方按原有分类判定）；是 → 明确的 true / false
 */
export const shouldRetryStreamTimeout = (
  code: unknown,
  receivedContent: boolean
): boolean | null => {
  const policy = streamTimeoutPolicyOf(code)
  if (!policy) {
    return null
  }
  if (!policy.retryable) {
    return false
  }
  return policy.requiresNoContent ? !receivedContent : true
}

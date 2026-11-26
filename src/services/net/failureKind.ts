/**
 * 「这次失败是什么性质」以及「值不值得再试」——**零依赖纯模块**（Issue #896）。
 *
 * 为什么要单独一个文件：这张判据既被 `net/requestPolicy.ts`（重试策略表）用，也被
 * `diagnostics/reasons.ts` 用。后者在文件头写着「零依赖纯模块：不认识 collector / transport /
 * 业务代码」，不能为了让 429 口径统一就去 import 一张带 `LIMITS` 的表 —— 那会把
 * `diagnostics` 这个被各处 import 的底层模块拖进一层新的依赖。
 *
 * 所以：**判据与数字分家**。本文件只有「状态码 / 现象 → 可不可重试」这一件事，
 * 一个数字都没有；毫秒预算、重试次数、退避曲线都在 `requestPolicy.ts` 的表里。
 *
 * ## 429：唯一口径
 *
 * **429 = 可重试（临时）**，理由是限流是「等一会儿真的有额度」，与 5xx 同类；
 * 两个必须一起写死的边界：
 *  1. 上游用 429 / 400 表达**额度用完**（`insufficient_quota` 一类）时不是限流，
 *     那一档归 `api/errors` 的 `insufficientBalance`（终态）——本文件不认识业务码，
 *     调用方必须在问本文件**之前**判掉额度；
 *  2. 服务端给了 `Retry-After` 就按它退避（`requestPolicy.ts` 的 `backoffOf` 的
 *     `retryAfterMs` 优先），客户端不自己猜节奏。
 *
 * 另有一条容易混的：本文件的 `retryableFailure('cancelled') === false` 说的是
 * 「**我们**绝不自动再发」，而 `diagnostics/reasons.ts` 的 `cancelled: true` 说的是
 * 「界面可以劝**用户**自己再点一次」—— 两个问题，两个答案，不冲突。
 */

/**
 * 失败类型（**只表达「为什么失败」，不表达「怎么处置」**）：
 *  - `cancelled`  用户 / 调用方主动取消（不是失败）；
 *  - `offline`    系统层没网；
 *  - `timeout`    等超时（连接 / 首字 / 空闲都算，本身不区分）；
 *  - `rateLimited` HTTP 429；
 *  - `server5xx`  HTTP 5xx；
 *  - `client4xx`  其余 4xx（参数 / 鉴权 / 路径 —— 重发是同一份结果）；
 *  - `empty`      200 但没内容（空流 / 空响应）；
 *  - `unknown`    判不出来（按「临时故障」处理，与改前 `network` 档一致）。
 */
export type RequestFailureKind =
  | 'cancelled'
  | 'offline'
  | 'timeout'
  | 'rateLimited'
  | 'server5xx'
  | 'client4xx'
  | 'empty'
  | 'unknown'

/**
 * **429 的唯一口径**：可重试。
 *
 * 三条一起读才完整：① 限流是临时的（等一会儿真有额度）；② 上游用 429 表达「额度用完」时
 * 不是限流，那一档必须在问本表之前判成终态（`api/errors` 的 `insufficientBalance`）；
 * ③ 服务端给了 `Retry-After` 就按它退避，不自己猜节奏。
 */
export const RATE_LIMIT_RETRYABLE = true

/** 这个失败「原则上」值不值得再发一次（**不含**次数与内容判据） */
export const retryableFailure = (kind: RequestFailureKind): boolean => {
  switch (kind) {
    case 'cancelled':
      // 用户点了停止：不是失败，任何类都不许自动再发（母单 #894 第 4 条纪律）
      return false
    case 'offline':
    case 'timeout':
    case 'server5xx':
    case 'empty':
    case 'unknown':
      return true
    case 'rateLimited':
      return RATE_LIMIT_RETRYABLE
    case 'client4xx':
      // 参数 / 鉴权 / 路径：重发是同一份结果（#303：2059 次 404 刷满网关日志）
      return false
  }
}

/** `ApiError.status` / 任一层的 HTTP 状态码 → 失败类型（唯一的映射处） */
export const failureOfStatus = (status: number | undefined | null): RequestFailureKind => {
  if (typeof status !== 'number' || !Number.isFinite(status) || status <= 0) {
    // 没有状态码 = 请求没成行（断网 / 超时 / 判不出）：临时故障
    return 'unknown'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  if (status >= 500) {
    return 'server5xx'
  }
  if (status >= 400) {
    return 'client4xx'
  }
  if (status >= 200 && status < 300) {
    // 2xx 却走到失败分类 = 上游给了成功壳子但没内容
    return 'empty'
  }
  return 'unknown'
}

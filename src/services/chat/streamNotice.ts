import type { TranslationKey } from '../../i18n/index.js'

/**
 * 首字等待的分级提示：请求发出后按等待时长逐级升级，收到第一个 token 或本轮结束就撤下。
 * 5s「正在等待响应」→ 30s「服务响应较慢，仍在等待」→ 60s「等待过久，可停止后重新生成」。
 *
 * 这里只描述「等多久该说什么」，定时器挂在 chat/store 的 streamReply 里，
 * 消息组件只按 key 取文案，所以分档规则可以脱离 UI 单测。
 *
 * **#771：最高档（判死 / 给停止出口）不再只看时长，还要看「当前阶段自己的预算」。**
 *
 * 为什么必须这样：#771 把连接段（`connectMs`）从 15s 放宽到 60s。改前最高档固定在第 60 秒
 * 出现，而连接段正好也是 60s —— 于是第 60 秒用户会看到「等待时间过长，可以停止后重新生成」，
 * 可那一刻 connect 请求**还活着**（它要等到 60s 才超时）。提示说「已经判死」、请求却说「我还在跑」，
 * 用户会以为 App 卡死，客服也会照着错的前提排障。
 *
 * 判据改成阶段化的：某一档只有在**它判死的那一段真的已经过了预算**之后才允许出现，
 * 有效门槛 = max(档位固定阈值, 该阶段预算 + `STALL_NOTICE_GRACE_MS`)。
 * 于是：
 * - 连接段（预算 60s）→ 停止出口最早在 75s 出现，而请求 60s 就已经收口；
 * - 等首字（预算 30s，深度思考档 45~120s）→ 仍按各渠道/思考态自己的预算算，不会被提前判死；
 * - 上传附件 / 正在重试这类「没有上游预算」的阶段 → 退回原固定阈值（停止本来就是安全的）。
 */

export type StreamNoticeTier = {
  /** 从请求发出算起，等待超过这个时长就升到这一档 */
  afterMs: number
  key: TranslationKey
  /** 最高档要给用户可点的出口（停止 / 重新生成） */
  actions: boolean
}

export const STREAM_NOTICE_TIERS: readonly StreamNoticeTier[] = [
  { afterMs: 5_000, key: 'replyWaitingFirstToken', actions: false },
  { afterMs: 30_000, key: 'replyWaitingSlow', actions: false },
  { afterMs: 60_000, key: 'replyWaitingStalled', actions: true },
]

/** 每档要挂的定时器延时（毫秒），与 STREAM_NOTICE_TIERS 一一对应 */
export const STREAM_NOTICE_DELAYS: readonly number[] = STREAM_NOTICE_TIERS.map(
  (tier) => tier.afterMs
)

/** 最高档（给停止出口的那一档）的固定阈值：60s，阶段预算更长时会被抬到预算之后 */
export const STALL_NOTICE_AFTER_MS = STREAM_NOTICE_TIERS[STREAM_NOTICE_TIERS.length - 1].afterMs

/**
 * 判死档的守卫余量（#771）：`该阶段预算 + 15s` 才是最早可以给「停止」出口的时刻。
 *
 * 为什么留余量：定时器与请求收口会在同一秒竞争（第 60 秒既可能是 connect 超时触发的时刻，
 * 也可能是提示定时器触发的时刻），15s 保证「先判死、再给停止按钮」的先后顺序不会颠倒。
 * 数字与上面三档阈值放同一处（本文件就是这组阈值的唯一来源，check-limits 不另扫它）。
 */
export const STALL_NOTICE_GRACE_MS = 15_000

/**
 * 「判死 / 停止出口」那一档的**有效门槛**（#771）。
 *
 * @param stageBudgetMs 当前阶段自己的超时预算（连接段 / 首字段 / 思考档首字）；
 *   没有上游预算的阶段（上传附件、正在重试、阶段未知）传 undefined → 退回固定 60s。
 * @returns 从请求发出算起，最早可以给「可以停止」出口的时刻（毫秒）
 */
export const stallNoticeAfterMs = (stageBudgetMs?: number): number =>
  stageBudgetMs === undefined || !Number.isFinite(stageBudgetMs) || stageBudgetMs <= 0
    ? STALL_NOTICE_AFTER_MS
    : Math.max(STALL_NOTICE_AFTER_MS, stageBudgetMs + STALL_NOTICE_GRACE_MS)

/**
 * 当前等待时长该显示哪一档；连第一档都没到就是 null（还在正常出字时间内，不打扰）。
 *
 * @param stageBudgetMs 当前阶段的超时预算（#771）；不传 = 只看时长（改前的行为，给不关心阶段
 *   的调用方 / 历史用例用）。**判死档会被这个预算挡住**，保证「提示判死时请求一定已经收口」。
 */
export const streamNoticeTier = (
  elapsedMs: number,
  stageBudgetMs?: number
): StreamNoticeTier | null => {
  const stallAfter = stallNoticeAfterMs(stageBudgetMs)
  return STREAM_NOTICE_TIERS.reduce<StreamNoticeTier | null>((current, tier) => {
    if (elapsedMs < tier.afterMs) {
      return current
    }
    // 判死档：预算没走完就还是「还在等」，绝不提前说「可以停止」
    if (tier.actions && elapsedMs < stallAfter) {
      return current
    }
    return tier
  }, null)
}

/** 当前这条提示是否要带停止/重新生成入口 */
export const hasStreamNoticeActions = (key: TranslationKey | undefined): boolean =>
  key !== undefined && STREAM_NOTICE_TIERS.some((tier) => tier.key === key && tier.actions)

import type { TranslationKey, TranslationMessage } from '../../i18n/index.js'
import {
  STALL_NOTICE_AFTER_MS,
  STREAM_NOTICE_TIERS,
  stallNoticeAfterMs,
  streamNoticeTier,
  type StreamNoticeTier,
} from './streamNotice.js'

/**
 * 首字等待的**阶段**（#328）。
 *
 * `streamNotice` 只回答「等了多久、该说什么」（#41 的 5s / 30s / 60s 三档），
 * 这里补的是「卡在哪个阶段」：上传附件、建连、等首个 token、模型思考、失败重试。
 * 两者是**乘起来**用的：阶段给主行，分档只决定「要不要追加一行、要不要给停止出口」，
 * 计时器与阈值完全复用 `STREAM_NOTICE_TIERS`，不另起一套。
 *
 * 纯模块（不 import React / store）：阶段流转能脱离界面与真实网络单测。
 */
export type WaitStage =
  /** 构造请求体、上下文裁剪（同步，通常看不到） */
  | 'preparing'
  /** 附件补齐：历史图片串行补传，或 file_id 失效后的重传 */
  | 'uploading'
  /** 请求已发出 → 响应头到达（ttfb 未到） */
  | 'connecting'
  /** 响应头已到 → 第一个内容块 */
  | 'awaitingFirstToken'
  /** 首个内容块是思考块，正文还没开始 */
  | 'thinking'
  /** 失败后退避，等下一次尝试 */
  | 'retrying'

/** 阶段 → 主行文案 key；`retrying` 复用 #105 的 `chatRetrying`（带 {attempt}/{limit} 契约不变） */
export const WAIT_STAGE_KEYS: Record<WaitStage, TranslationKey> = {
  preparing: 'waitStagePreparing',
  uploading: 'waitStageUploading',
  connecting: 'waitStageConnecting',
  awaitingFirstToken: 'waitStageAwaitingFirstToken',
  thinking: 'waitStageThinking',
  retrying: 'chatRetrying',
}

/**
 * 只有「在等上游」的阶段才归因成「服务响应较慢」（30s 档）；
 * 上传期说服务慢是错误归因，所以那种阶段 30s 档只显示主行。
 */
const UPSTREAM_STAGES: ReadonlySet<WaitStage> = new Set<WaitStage>([
  'connecting',
  'awaitingFirstToken',
  'thinking',
])

/** 30s 档的门槛：低于它的档位只有主行（5s 档的主行文案本身就已经够了） */
const SLOW_TIER_AFTER_MS = STREAM_NOTICE_TIERS[1].afterMs

/** 首字等待提示的完整状态：主行 + 分档附加行 + 出口 */
export type WaitHint = TranslationMessage & {
  /** 当前阶段；null 时主行回落到分档文案（调用点忘设阶段也不会退化成没提示） */
  stage: WaitStage | null
  /** 本轮开始等待的时刻（点发送），跨阶段累计，重试不重置 */
  startedAt: number
  /** 当前分档（5s / 30s / 60s），没到第一档为 null */
  tier: StreamNoticeTier | null
  /** 与 tier.actions 同源：UI 不用靠 key 反查该不该给停止按钮 */
  actions: boolean
}

/** 已等待秒数（向下取整，不出现负数） */
export const waitSeconds = (startedAt: number, now: number): number =>
  Math.max(0, Math.floor((now - startedAt) / 1000))

/**
 * 三档到点的绝对时刻：定时器按「离 startedAt 还剩多久」挂，跨阶段不会重新计时。
 *
 * 传入 `stageBudgetMs`（#771）时，若该阶段的预算比最高档更晚，会**多返回一个判死档的到点时刻**
 * —— 否则界面在第 60 秒就会判死，而 connect 请求其实还要跑到 60s / 重试后才收口。
 */
export const waitDeadlines = (startedAt: number, stageBudgetMs?: number): number[] => {
  const base = STREAM_NOTICE_TIERS.map((tier) => startedAt + tier.afterMs)
  const stallAfter = stallNoticeAfterMs(stageBudgetMs)
  return stallAfter > STALL_NOTICE_AFTER_MS ? [...base, startedAt + stallAfter] : base
}

/** 本轮请求会用到的附件里还有没有没上到服务端的（要显示「正在上传附件」） */
export const needsUpload = (files: readonly { serverId?: string | null }[]): boolean =>
  files.some((file) => !file.serverId)

/**
 * 组装当前该显示的提示。
 * - 5s 之前不打扰（返回 null），只有重试例外：已经出错、正在等下一次尝试，必须立刻可见；
 * - 主行 = 阶段名（阶段未知时回落到分档文案）；
 * - `actions` 只在最高档（60s）为真，停止按钮的出口仍留在消息组件里。
 */
export const composeWaitNotice = ({
  stage,
  startedAt,
  now,
  retry,
  stageBudgetMs,
}: {
  stage: WaitStage | null
  startedAt: number
  now: number
  retry?: { attempt: number; limit: number }
  /**
   * 当前阶段自己的超时预算（#771）：连接段 = connectMs，等首字 = 该渠道/思考态的首字预算。
   * 传了它，「可以停止」那一档就不会出现在「请求其实还活着」的时刻；不传 = 只看时长。
   */
  stageBudgetMs?: number
}): WaitHint | null => {
  const tier = streamNoticeTier(Math.max(0, now - startedAt), stageBudgetMs)
  if (stage === 'retrying') {
    return {
      key: WAIT_STAGE_KEYS.retrying,
      params: retry ? { attempt: retry.attempt, limit: retry.limit } : undefined,
      stage,
      startedAt,
      tier,
      actions: tier?.actions ?? false,
    }
  }
  if (!tier) {
    return null
  }
  return {
    key: stage ? WAIT_STAGE_KEYS[stage] : tier.key,
    stage,
    startedAt,
    tier,
    actions: tier.actions,
  }
}

/**
 * 分档要追加的那一行：5s 档不追加（主行已经说明阶段）；
 * 30s 只在等上游的阶段追加（避免上传期被说成「服务响应较慢」）；
 * 60s 全阶段追加（等太久就该给停止的出口）。
 */
export const waitTierLine = (
  stage: WaitStage | null,
  tier: StreamNoticeTier | null
): TranslationKey | null => {
  if (!tier || tier.afterMs < SLOW_TIER_AFTER_MS) {
    return null
  }
  if (tier.actions) {
    return tier.key
  }
  return stage && UPSTREAM_STAGES.has(stage) ? tier.key : null
}

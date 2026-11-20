/**
 * 运行期阈值总表（Issue #275）：超时 / 限量 / 阈值只在**这一处**写数字。
 *
 * 为什么要这张表：这些数字是线上行为的分界线（#38 合法大包被预算判死、#41 首字 75s 却判失败、
 * #122 无上下文预算、#150 流式响应体无空闲超时、#152 预算与上限不自洽）。改动前它们散在 9 个
 * 文件里，改一个数要全仓 grep，而且没有任何地方能回答「当前线上生效的停滞阈值是多少秒」。
 *
 * 三条纪律（#275 的边界，改之前先读）：
 * 1. **只搬位置，不改数值。** 表里每个数字都是迁移前的原值（对照表见
 *    `tests/unit/limits-config.test.mjs` 的逐项断言）。改默认值属于行为变更，要单独拍板；
 * 2. **各单位看后缀**：`*Ms` 是毫秒、`*Mb` 是兆字节、`*Bytes` 是字节、纯净数量不带后缀（次数 / 个数）；
 * 3. **本文件是唯一允许出现 4 位以上阈值字面量的地方**，其余文件一律引用这里
 *    （`pnpm check:limits` 会扫 `scripts/check-limits.mjs` 里的 WATCHED 清单并逐条报 `文件:行`）。
 *
 * 三个「可配置 setter」（`setRequestTimeout` / `setStreamIdleTimeout` / `setContextBudget`）
 * 目前**没有任何生产调用点**，只被测试用到：本单不删（删掉是行为变更），在 PR 里记「疑似死代码，
 * 建议另开单」。它们的默认值就是下面表里的对应项。
 */

import { DEFAULT_MAX_IMPORT_BYTES } from './chat/history/importLimit.js'

export const LIMITS = {
  /** 建连预算：只约束「拿到响应头」这一段，不限制流式正文（#41） */
  requestTimeoutMs: 15000,
  /** 流式正文的空闲超时：响应头到手后连多久没新数据算卡死（#150）。这是空闲口径，不是总时长 */
  streamIdleTimeoutMs: 45000,
  /** 自动重试的最多次数（不含首次请求）：附件补传、断网、5xx、超时共用这一个上限（#105） */
  streamRetryLimit: 2,
  /** 退避基数，第 n 次重试等待 2^n 倍 */
  retryBaseDelayMs: 1000,
  /** 请求侧上下文预算双闸：token 估算上限 + 轮次上限（#122） */
  contextBudget: { maxTokens: 120_000, maxRounds: 200 },
  /**
   * 单个导入包大小上限。**单一来源仍是 `chat/history/importLimit.ts`**（#34 的纪律：
   * 一个数字两条导入链路共用、改默认值要有人拍板），这里只做转出，不另写一遍数字。
   */
  importMaxBytes: DEFAULT_MAX_IMPORT_BYTES,
  /** 直链导入：连接超时 */
  importConnectMs: 10_000,
  /** 直链导入：单块读超时（断网最多等一块） */
  importChunkReadMs: 12_000,
  /** 直链导入：停滞判定窗口 —— 连续这么久没有任何新字节才判 stalled（#38：唯一的失败判据） */
  importStallMs: 40_000,
  /** 直链导入：防御性总上限，只防「一直在爬但永远下不完」。与 importMaxBytes 有可校验关系（#152） */
  importMaxTotalMs: 30 * 60_000,
  /** 直链导入：心跳日志间隔（在推进 / 已停滞的在线证据） */
  importHeartbeatMs: 5_000,
  /** 墙钟跳变判定阈值：超过它的一次读数跳变按「校时」处理，不计入耗时（#151） */
  clockJumpMs: 2 * 60_000,
  /** 会话自动标题（#112 的背压也在这组里） */
  autoTitle: {
    timeoutMs: 8000,
    maxOutputTokens: 32,
    maxInputBytes: 2048,
    concurrency: 2,
    maxQueue: 6,
  },
  /** 附件上传限制 */
  attachments: {
    maxSizeMb: 64,
    maxUserDataSizeMb: 32,
    maxCount: 50,
    maxConcurrent: 3,
  },
  /**
   * 启动兜底：内联脚本（`src/index.html`）在 bundle 之前执行，没法 import 这个模块，
   * 所以那边保留字面量，由 `tests/unit/limits-config.test.mjs` 断言两处相等。
   */
  bootDeadlineMs: 12000,
} as const

/**
 * 导入链路的**可校验关系**（#152 / #275）：按现行上限与总时限，链路至少要稳定跑到这个速率
 * 才可能下完。现值 200MB ÷ 1800s ≈ 114KB/s ≈ 0.9Mbps，常见移动网络都够，所以两者自洽。
 *
 * 之所以留一条门槛而不是只写注释：这两个数字谁被单独调整、另一个没跟着动，这条不等式立刻不成立，
 * 而「不自洽」在线上表现为「合法的大包被预算判死」（#38 / #152 就是这么来的）。
 * 判定由 `tests/unit/limits-config.test.mjs` 承担（不放在运行期：加载即 assert 是行为变更）。
 */
export const MIN_ACCEPTABLE_BYTES_PER_SEC = 100_000

/** 现行上限 + 总时限是否仍能满足上面那条最低带宽门槛 */
export const isImportBudgetConsistent = (
  maxBytes: number = LIMITS.importMaxBytes,
  maxTotalMs: number = LIMITS.importMaxTotalMs
): boolean => maxBytes / (maxTotalMs / 1000) >= MIN_ACCEPTABLE_BYTES_PER_SEC

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
  /** 附件上传限制（走 Files API 上传这条通路的约束） */
  attachments: {
    maxSizeMb: 64,
    maxUserDataSizeMb: 32,
    maxCount: 50,
    maxConcurrent: 3,
    /**
     * #480 文档附件（TXT / DOCX / PDF）的**本地解析与注入**限制。
     *
     * 这些数字原先写在 `attachments/limits.ts` 的 `ATTACHMENT_LIMITS` 里（#480 建立），
     * 与上面 `attachments.*` 的「上传」口径不是一回事：那一组管的是「能不能传上去」，
     * 这一组管的是「解析出来多少、注入多少」。**#562 定了「附件/内容限制全仓只有一份」**，
     * 所以整体搬到这里，`attachments/limits.ts` 改为逐字段转出（数值一个没动）。
     *
     * `tests/unit/limits-config.test.mjs` 的 `ORIGINAL_VALUES` 手抄了一份同样的值：
     * 搬位置不改值的证据在那里，改阈值要两边一起改。
     */
    doc: {
      /** 单文件大小上限（字节） */
      txtMaxBytes: 5 * 1024 * 1024,
      docxMaxBytes: 20 * 1024 * 1024,
      pdfMaxBytes: 50 * 1024 * 1024,

      /** 注入上下文前的字符硬上限（超出必须显式标注截断，禁止静默） */
      maxExtractedChars: 400_000,

      /**
       * 单次请求的文档注入预算（token，#480 §9 表里的默认值）。
       * 与单附件上限的关系：一个 40 万字符的文件进不了 3.2 万 token 的预算，
       * 所以「单附件上限」不是实际生效值 —— 实际生效的是 min(单附件上限, 本轮剩余预算)，
       * 见 `attachments/contextBuilder.ts`，超出的部分必须显式标注截断。
       */
      docBudgetTokens: 32_000,

      /**
       * 注入时「还值得注入」的最小余量（字符）：剩余预算低于它就不再注入那一个附件，
       * 改为在 skipped / warnings 里明确告知「未注入」，避免往消息里塞一个几十字的碎片。
       */
      minInjectableChars: 200,

      /**
       * 单条消息最多带几个文档附件（#527 接线时追加，只追加不改既有值）。
       *
       * 为什么要有这个数：UI 的 `maxFiles` 原先缺省是 `undefined`（= 不限），用户一次选 50 个
       * 文件就会同时起 50 路解析；超出时必须**明确拒绝并提示**（`attachPickTooMany`），不许静默丢弃。
       * 10 是「输入区一屏放得下、单轮注入预算还够分摊」的量级，不是协议上限。
       */
      maxFilesPerMessage: 10,

      /** DOCX 解压防护 */
      maxZipEntries: 2000,
      maxZipUncompressedBytes: 100 * 1024 * 1024,

      /** PDF 无文本层判定：平均每页可提取字符数低于此值视为无文本层 */
      pdfMinCharsPerPage: 20,
    },
  },
  /**
   * 图片内联（base64）通路的限制（#551 / 母单 #548 的 vision-2；取值依据 `ref-vision.md` 5.3）。
   *
   * 与上面 `attachments` 那组**不是同一口径**：那一组是「上传到 Files API」的约束（原图直传 64MB），
   * 而走 base64 的渠道（anthropic / openai / ours）图片正文直接进请求体，原图会把请求撑爆。
   * 这里全部是**编码前 / 编码后**的口径：
   * - `passThroughBytes` + `maxEdge` + `maxPixels`：**直发阈值**。三者都不超就原图一个字节不改
   *   （Anthropic 官方推荐 1568px / 1.15MP；3.5MB 让 base64 后 ≈4.7MB，留在常见请求体限制内）；
   * - `webpQuality` / `jpegFallbackQuality`：超阈值才降级，统一出 webp 0.85；webp 编码不可用时
   *   回落 jpeg 0.9。**绝不输出 PNG**（PNG q1.0 会把截图撑到 2–4MB，base64 再 ×4/3）；
   * - `maxSourceBytes`：原图硬上限，超过**直接拒绝、不解码**（100MP 的图在 Chromium 83 上会先 OOM）；
   * - `maxEncodedBytes`：编码产物上限，压缩后仍超就明确拒绝，不截断不静默丢；
   * - `maxCanvasArea`：canvas 面积闸门（iOS 老 WebKit 超面积会静默返回 `data:,`），超了先等比缩小再画；
   * - `maxCount` / `maxTotalBytes`：单条消息的图片张数与总字节（base64 前）上限；
   * - `cacheEntries`：本地编码结果的内存缓存条数（key = 附件 id + 编码参数）。
   */
  images: {
    maxEdge: 1568,
    maxPixels: 1_150_000,
    passThroughBytes: Math.round(3.5 * 1024 * 1024),
    webpQuality: 0.85,
    jpegFallbackQuality: 0.9,
    maxSourceBytes: 16 * 1024 * 1024,
    maxEncodedBytes: 5 * 1024 * 1024,
    maxCanvasArea: 4096 * 4096,
    maxCount: 20,
    maxTotalBytes: 20 * 1024 * 1024,
    cacheEntries: 24,
    /** 编码前读的头部字节：要覆盖 JPEG 的 APP1(EXIF) + SOF（尺寸），相机原图也在这个范围内 */
    maxHeadBytes: 262_144,
  },
  /**
   * 启动兜底：内联脚本（`src/index.html`）在 bundle 之前执行，没法 import 这个模块，
   * 所以那边保留字面量，由 `tests/unit/limits-config.test.mjs` 断言两处相等。
   */
  bootDeadlineMs: 12000,
} as const

/** 字节 → MB（四舍五入的整数），只用于文案提示；换算集中在这里，别处不再写 1024 */
export const mbOf = (bytes: number): number => Math.round(bytes / (1024 * 1024))

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

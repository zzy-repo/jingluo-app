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

/**
 * 三段超时的**渠道覆盖**形状（#568）：只写与默认值不同的项。
 * 声明在这里而不是 providers.ts：数字表在 limits.ts，形状跟着数字走，避免类型文件反向依赖。
 */
export type RequestTimeoutOverride = {
  connectMs?: number
  firstTokenMs?: number
  thinkingFirstTokenMs?: number
  idleMs?: number
}

export const LIMITS = {
  /**
   * **三段超时**（#568）：请求分三段各自计时，不再用一个总超时兜到底。
   *
   * 为什么必须拆开：原先只有「到响应头」的 15s 与「正文空闲」的 45s 两段，
   * 「连上了但一直不出字」和「出几个字后卡住」共用同一口径，用户看到的都是
   * 长时间无反馈 + 一次性失败，也无法分别重试（只有前者是安全的）。
   *
   * - `connectMs`：发起到**拿到响应头**。这段超时说明「连不上/上游没接」，重发是安全的；
   * - `firstTokenMs`：响应头到手 → **第一个 SSE 事件**。深度思考模型这段明显更慢，
   *   所以渠道表（`api/providers.ts` 的 `timeouts`）可以逐渠道/逐思考态覆盖这一项；
   * - `idleMs`：**相邻两次数据之间**（#150 的口径，是「空闲」不是总时长）。
   *   已经出过字之后再超时不能重试 —— 重发会答两遍、重复计费。
   *
   * 三个数字怎么定的（改动要连同依据一起改）：
   * - `connectMs` 沿用原来的 15s（与 probeProvider 的连通性探测同一口径，值未变）；
   * - `firstTokenMs` 是**新增的一段**：原先没有它，「连上了但一直不出字」只能等 45s 空闲兜底，
   *   既说不清卡在哪，也没法安全重试。30s 是「比空闲短、又要容下冷启动/排队」的折中；
   *   深度思考等慢场景走 `channels` 表的长档（最长 120s）；
   * - `idleMs` 从 45s **放宽到 60s**：45s 只是与仓库里 `importStallMs`（下载停滞 40s）同一量级
   *   拍出来的（#150），而 #568 的诉求正是「弱网/长回答别被误杀」；60s 仍早于界面 60s 档的
   *   「要不要停止」提示收口，用户不会看到一句提示却永远等不到结论。
   */
  requestTimeouts: {
    connectMs: 15_000,
    firstTokenMs: 30_000,
    idleMs: 60_000,
    /**
     * **首字预算的渠道覆盖表**（#568 第 3 条）：一个渠道一行，只写与上面默认值不同的项。
     *
     * 为什么是表而不是 if：首字耗时取决于「上游排不排队、模型要不要先想一大段」，
     * 与我们的网络关系不大。深度思考模型在官方端点上 30s 才吐第一个字是常态；
     * 用一个数字管四个渠道只有两种结局 —— 要么误杀深度思考，要么全渠道一起放到很松。
     * 深度思考档（`thinkingFirstTokenMs`）单独一列，因为它比普通档慢一个量级。
     *
     * 新增渠道时不必改这里（缺项自动继承默认值），但**慢的渠道要在这里登记**。
     */
    channels: {
      /** DeepSeek 官方：深度思考起步慢，但上游体感稳定 */
      deepseek: { thinkingFirstTokenMs: 90_000 },
      /** Anthropic 协议（用户自填中转）：真 Anthropic 开 thinking 时可等更久 */
      anthropic: { thinkingFirstTokenMs: 120_000 },
      /** 我们的渠道（sub2api，reasoning_effort=high）：自家网关建连快，首字给中档 */
      ours: { firstTokenMs: 20_000, thinkingFirstTokenMs: 60_000 },
      /** OpenAI 兼容第三方中转：思考实现各家不一，给一档折中值 */
      openai: { thinkingFirstTokenMs: 45_000 },
    },
  },
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

      /**
       * PDF 页数上限（#571 关闭条件的「支持页数上限」）。
       *
       * 为什么是 500：解析开销基本线性在页数上，500 页 ≈ 一份 400 页技术手册 / 一份年报带附件，
       * 是「正常用户会真的传上来」的上界；再往上是扫描合订本 / 打印流，本来就该走 OCR 或桌面工具。
       * 取值与 #480 spike、旧分支 `feat/doc-pdf-571` 的 `DEFAULT_MAX_PAGES` 同一档，不另造数字。
       *
       * 超限**必须显式报错**（`PdfParseError.code = 'tooManyPages'`），不许静默截断前 N 页 ——
       * 那会让用户以为整份文档都进上下文了。
       */
      pdfMaxPages: 500,

      /**
       * PDF 解析时间预算（默认 10 分钟）：**最后一道保险**，不是性能目标。
       *
       * 取值依据：spike 实测单页 0.14–0.75 s，页数上限 500 页 → 最慢一档约 375 s，留 1.6 倍冗余。
       * 正常文档几百毫秒到几秒就结束，永远碰不到它；它会触发的场景是「某一页卡死」。
       * 因为 pdfjs 单页 `getTextContent()` 不可中断，超时按**页**生效（`Promise.race` 抢跑 +
       * `document.destroy()` 终止 worker），与取消同一粒度；超时不抛错，已提取的页照常交付并
       * 在 warnings 写明，`extractedPages < pages` 让调用方落 `status: 'partial'`。
       */
      pdfTimeoutMs: 10 * 60 * 1000,
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

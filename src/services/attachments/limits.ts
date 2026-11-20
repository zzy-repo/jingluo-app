/**
 * #480 文档附件：集中配置（基线文件，由 lead 维护）
 * 所有限制值只在这里定义，parser / manager / UI 一律引用，不许就地硬编码。
 */
export const ATTACHMENT_LIMITS = {
  /** 单文件大小上限（字节） */
  txtMaxBytes: 5 * 1024 * 1024,
  docxMaxBytes: 20 * 1024 * 1024,
  pdfMaxBytes: 50 * 1024 * 1024,

  /** 注入上下文前的字符硬上限（超出必须显式标注截断，禁止静默） */
  maxExtractedChars: 400_000,

  /**
   * 单次请求的文档注入预算（token，issue §9 表里的默认值）。
   * 与单附件上限的关系：一个 40 万字符的文件进不了 3.2 万 token 的预算，
   * 所以「单附件上限」不是实际生效值 —— 实际生效的是 min(单附件上限, 本轮剩余预算)，
   * 见 contextBuilder.ts，超出的部分必须显式标注截断（§3.7 禁止静默截断）。
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
} as const

export const SUPPORTED_EXTENSIONS = ['.txt', '.docx', '.pdf'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

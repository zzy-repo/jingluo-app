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

  /** DOCX 解压防护 */
  maxZipEntries: 2000,
  maxZipUncompressedBytes: 100 * 1024 * 1024,

  /** PDF 无文本层判定：平均每页可提取字符数低于此值视为无文本层 */
  pdfMinCharsPerPage: 20,
} as const

export const SUPPORTED_EXTENSIONS = ['.txt', '.docx', '.pdf'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

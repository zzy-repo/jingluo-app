/**
 * #480 文档附件：统一数据结构（基线文件，由 lead 维护，其它模块只读）
 *
 * 归属约定：
 *  - 本文件与 limits.ts 是**共享契约**，任何人不得在别处另建同名类型。
 *  - 新增字段请在这里加，并在 PR 里说明影响面。
 */

/** 解析状态机：pending → parsing → success | partial | failed */
export type AttachmentStatus = 'pending' | 'parsing' | 'success' | 'partial' | 'failed'

/** 附件元数据（与聊天消息分表存储，消息只保存 id 引用） */
export interface DocumentAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  /** 内容指纹，与 parserVersion 一起构成缓存去重键 */
  sha256: string

  /** 原始文件在本地的存放标识（IndexedDB blob key） */
  localPath: string
  /** 解析全文的存放标识（IndexedDB key，缺省表示未解析） */
  parsedTextPath?: string

  status: AttachmentStatus

  characterCount?: number
  estimatedTokens?: number

  totalPages?: number
  extractedPages?: number

  /** 解析过程中的非致命问题（忽略图片、部分页失败、截断等），UI 需要展示 */
  warnings?: string[]
  errorMessage?: string

  parserVersion?: string
  createdAt: number
}

/** 各 parser 的统一返回结构 */
export interface ParsedDocument {
  /**
   * 注入文本（可能为展示/阅读顺序插入结构标记，见 `rawLength`）。
   * PDF 的 `text` 里带 `[第N页]` 页标记与页间分隔换行；txt / docx 没有标记。
   */
  text: string
  /**
   * **正文字符数**，三种解析器**同一口径**（#544）：
   * 只统计文档正文本身 —— 不含 PDF 的 `[第N页]` 页标记、也不含标记之间的分隔换行。
   *
   * 因此「同一段文字」分别走 txt 与 pdf 两个解析器，这个数必须**相等**
   * （`tests/unit/attachment-character-count-480.test.mjs` 就是这条断言）。
   * 想拿「注入文本本身有多长」（截断 / 预算 / 展示）请用 `rawLength`，别用这个字段。
   */
  characterCount: number
  /**
   * 注入文本的总长度（= `text.length`），**含**解析器自己插入的结构标记：
   * PDF 的 `[第N页]` 与页间分隔换行；txt / docx 没有标记，所以与 `characterCount` 相等。
   *
   * 与 `characterCount` 分成两个字段是 #544 的结论：一个数不能既当「正文多长」又当
   * 「注入文本多长」——PDF 上两者天然不等（每页多 6 个字符的标记 + 分隔换行），
   * 混用的结果就是同一份文档走不同 parser 得到不可比的字数。
   */
  rawLength: number
  pages?: number
  extractedPages?: number
  warnings?: string[]
  parserVersion: string
}

/** 解析选项：进度与取消 */
export interface ParseOptions {
  onProgress?: (progress: { page?: number; totalPages?: number; stage: string }) => void
  signal?: AbortSignal
}

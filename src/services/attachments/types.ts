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
  text: string
  characterCount: number
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

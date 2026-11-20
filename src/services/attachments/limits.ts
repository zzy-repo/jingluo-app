/**
 * #480 文档附件的**域视图**（parsers / manager / UI 的入口名）。
 *
 * ## 这里不是第二份真相源（#562 的硬约束）
 *
 * 数字只有一处：`src/services/limits.ts` 的 `LIMITS`（#275 定的唯一阈值表，`pnpm check:limits`
 * 会扫；本文件已登记进 `scripts/check-limits.mjs` 的 WATCHED 清单，**里面出现任何 4 位以上
 * 数字就算红**）。本文件只做三件事：把 `LIMITS.attachments.doc` 逐字段转出成附件域惯用的
 * 名字、声明受支持的扩展名、给出扩展名的联合类型。
 *
 * 为什么保留这一层而不是让 40 个调用点都写 `LIMITS.attachments.doc.xxx`：
 * 1. 附件域内部的称呼是 `ATTACHMENT_LIMITS.pdfMaxBytes`，比四段点号短，且与「上传」那组
 *    （`LIMITS.attachments.maxSizeMb`，Files API 口径）在阅读上分得开 —— 两者口径不同，
 *    混成一层名字反而更容易拿错（拿 64MB 的上传上限去卡 20MB 的 DOCX 解析）；
 * 2. 逐字段写死（而不是 `= LIMITS.attachments.doc`）是有意的：`limits-config.test.mjs`
 *    有一条「每个 LIMITS 叶子都必须被生产代码以 `LIMITS.xxx` 形式引用」的断言，
 *    整体转出会让这 10 个叶子在源码里"看不见"，那条断言就失效了。
 *
 * 取值一个都没改（#562：只搬位置）。改阈值只手改 `LIMITS.attachments.doc` 与
 * `tests/unit/limits-config.test.mjs` 的 `ORIGINAL_VALUES`，本文件不动。
 */
import { LIMITS } from '../limits.js'

/** #480 文档附件的解析 / 注入限制（唯一来源：`LIMITS.attachments.doc`） */
export const ATTACHMENT_LIMITS = {
  txtMaxBytes: LIMITS.attachments.doc.txtMaxBytes,
  docxMaxBytes: LIMITS.attachments.doc.docxMaxBytes,
  pdfMaxBytes: LIMITS.attachments.doc.pdfMaxBytes,
  maxExtractedChars: LIMITS.attachments.doc.maxExtractedChars,
  docBudgetTokens: LIMITS.attachments.doc.docBudgetTokens,
  minInjectableChars: LIMITS.attachments.doc.minInjectableChars,
  maxFilesPerMessage: LIMITS.attachments.doc.maxFilesPerMessage,
  maxZipEntries: LIMITS.attachments.doc.maxZipEntries,
  maxZipUncompressedBytes: LIMITS.attachments.doc.maxZipUncompressedBytes,
  pdfMinCharsPerPage: LIMITS.attachments.doc.pdfMinCharsPerPage,
  /** #571 关闭条件「支持页数上限」；超限抛 `tooManyPages`，不许截断前 N 页当成功 */
  pdfMaxPages: LIMITS.attachments.doc.pdfMaxPages,
  /** #571 关闭条件「支持超时」；按页抢跑（pdfjs 单页不可中断），超时走 partial，见 parsers/pdf.ts */
  pdfTimeoutMs: LIMITS.attachments.doc.pdfTimeoutMs,
} as const

export const SUPPORTED_EXTENSIONS = ['.txt', '.docx', '.pdf'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

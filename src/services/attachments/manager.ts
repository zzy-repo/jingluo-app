/**
 * #480 文档附件：AttachmentManager。
 *
 * 职责边界（issue §4）：**只管附件的本地生命周期** —— 校验、指纹、落库、解析调度、状态机、清理；
 * 不做上下文预算、不改请求体、不认识任何模型供应商。解析器的具体实现由
 * `parsers/txt.ts` / `parsers/docx.ts` / `parsers/pdf.ts` 提供（统一签名见下方 `AttachmentParser`），
 * 本文件只负责按扩展名分派。
 *
 * 三条硬约定：
 *  1. **拒绝要明确**：格式、大小不合格一律抛 `AttachmentError`（带 `reason`），不静默忽略；
 *  2. **异常不吞**：解析过程中的任何异常都会落成 `failed` + `errorMessage` 并返回给调用方
 *     （不抛出去打断批量解析，但也绝不留一个假的 `success`）；
 *  3. **缓存去重键是 `sha256 + parserVersion`**：同一份文件、同一个解析器版本只解析一次。
 *     解析器实现改变输出时必须递增 `PARSER_VERSIONS` 里的版本号，否则会命中旧缓存。
 */
import { createId } from '../../utils/id.js'
import { readBlobBuffer } from '../../utils/readBlob.js'
import { estimateTokens } from '../chat/contextBudget.js'
import { openChatTransaction, reportStorageError } from '../chat/db.js'
import { recordError } from '../diagnostics/collector.js'
import { AttachmentAddError, type AttachmentAddStage } from './addError.js'
import {
  ATTACHMENT_LIMITS,
  MIME_BY_EXTENSION,
  SIZE_LIMIT_BYTES,
  SUPPORTED_EXTENSIONS,
  UNKNOWN_MIME_TYPES,
  type SupportedExtension,
} from './limits.js'
import { parseDocxFile } from './parsers/docx.js'
import { isPdfParseError, parsePdfFile } from './parsers/pdf.js'
import { parseTxtFile } from './parsers/txt.js'
import { sha256Hex } from './sha256.js'
import {
  attachmentTextKey,
  getAttachment,
  listAttachments,
  putAttachment,
  readAttachmentBlob,
  readAttachmentTextRecord,
  removeAttachment,
  removeUnreferencedAttachments,
  saveNewAttachment,
  sweepOrphanStorage,
  writeAttachmentTextRecord,
} from './store.js'
import type { DocumentAttachment, ParseOptions, ParsedDocument } from './types.js'

/** 附件 id 前缀：消息里只存 id，带前缀才能在历史数据里一眼认出「这是文档附件引用」 */
const ATTACHMENT_ID_PREFIX = 'att-'

export const isAttachmentId = (value: string): boolean => value.startsWith(ATTACHMENT_ID_PREFIX)

const nextAttachmentId = (): string => `${ATTACHMENT_ID_PREFIX}${createId()}`

/** 拒绝 / 失败的原因码：调用方按码出文案，不去解析英文 message */
export type AttachmentErrorReason =
  | 'unsupported-format'
  | 'mime-mismatch'
  | 'empty-file'
  | 'too-large'
  | 'not-found'
  | 'source-missing'
  | 'no-parser'

export class AttachmentError extends Error {
  readonly reason: AttachmentErrorReason

  constructor(reason: AttachmentErrorReason, message: string) {
    super(message)
    this.name = 'AttachmentError'
    this.reason = reason
  }
}

/**
 * 各格式允许的 MIME / 单文件上限 / 「系统没给 MIME」的取值：**都在 `./limits.ts`**（唯一来源）。
 * 本文件从那里 import，不再自己维护第二份 —— 外部应用导入（`services/externalImport.ts`）
 * 读的是同一张表，两边不会漂移。
 */

/**
 * 解析器版本：与 `sha256` 一起构成缓存去重键。
 * **解析器实现改变输出文本时必须递增对应版本号**（例如修了 PDF 换行、换了 DOCX 表格展开方式），
 * 否则老用户会一直命中旧缓存、看不到修复效果。
 */
export const PARSER_VERSIONS: Record<SupportedExtension, string> = {
  '.txt': 'txt-1',
  '.docx': 'docx-1',
  '.pdf': 'pdf-1',
}

/** 三个 parser 的统一签名：入参是 Blob（原始文件），返回统一解析结果 */
export type AttachmentParser = (file: Blob, options?: ParseOptions) => Promise<ParsedDocument>

const parsers: Partial<Record<SupportedExtension, AttachmentParser>> = {}

/**
 * 注册某个格式的解析器。解析器尚未就绪时 `parse()` 会明确失败（`no-parser`），
 * 不会静默产出空正文。
 */
export const registerAttachmentParser = (
  extension: SupportedExtension,
  parser: AttachmentParser
): void => {
  parsers[extension] = parser
}

/**
 * 接线：把三个 parser 挂到扩展名上（#480 集成）。
 *
 * 三个解析器都已在 `feat/480-doc-attachments` 落地：TXT（#522）、DOCX（#532）、PDF（#534）。
 * 依赖方向是单向的（parser → limits/types），parser 不反向 import 本模块，因此静态 import 不会成环。
 *
 * PDF 走 `parsers/pdf.ts` 的 `parsePdfFile`：pdfjs 的版本与加载方式由 `parsers/pdfLoader.ts`
 * 单点负责（`PDFJS_VERSION` / `loadPdfJs()`，构建期注入 `__PDFJS_ASSET__`），
 * **这里不设 `workerSrc`、不认识 pdfjs**，只做扩展名分派。
 */
export const wireParsers = (): void => {
  registerAttachmentParser('.txt', parseTxtFile)
  registerAttachmentParser('.docx', parseDocxFile)
  registerAttachmentParser('.pdf', parsePdfFile)
}

wireParsers()

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot).toLowerCase() : ''
}

const isSupportedExtension = (extension: string): extension is SupportedExtension =>
  (SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)

/** 扩展名 + MIME 双判；不合格直接抛 `unsupported-format` / `mime-mismatch` */
const resolveExtension = (filename: string, mimeType: string): SupportedExtension => {
  const extension = extensionOf(filename)
  if (!isSupportedExtension(extension)) {
    throw new AttachmentError(
      'unsupported-format',
      `unsupported attachment format: ${extension === '' ? '(no extension)' : extension}`
    )
  }
  const mime = mimeType.trim().toLowerCase()
  if (!UNKNOWN_MIME_TYPES.has(mime) && !MIME_BY_EXTENSION[extension].includes(mime)) {
    throw new AttachmentError(
      'mime-mismatch',
      `attachment mime ${mime} does not match ${extension}`
    )
  }
  return extension
}

/**
 * 失败原文的统一出口：`<码>: <人话>`。
 *
 * **码必须留在字符串里**（#574）：UI 的失败面板按 `码 → 文案` 查表给标题，取不到码就只
 * 剩下「未知问题」兜底。解析器抛的 `PdfParseError` 早就带着 `code`（`noTextLayer` /
 * `tooManyPages` / `encryptedPdf` …），以前这里只留 `error.message`，码在这一行丢掉，
 * 「扫描版 PDF」「页数超限」在界面上就变成了「解析过程中出现了未知问题」。
 *
 * 导出（而不是文件内私有）：这是「码不丢」的唯一落点，用例要能直接钉住它 —— 见
 * `tests/unit/attachment-failure-copy-574.test.mjs`。
 */
export const describeAttachmentError = (error: unknown): string => {
  if (error instanceof AttachmentError) {
    return `${error.reason}: ${error.message}`
  }
  if (isPdfParseError(error)) {
    return `${error.code}: ${error.message}`
  }
  if (error instanceof Error) {
    return error.message === '' ? error.name : error.message
  }
  return String(error)
}

/**
 * 解析结果 → 附件的解析结论。
 *
 * `status` 只反映**解析完整性**：缺页 / 解析器给出 warnings → `partial`。
 * 「正文超过注入预算」不降级 status（文档本身是完整的），而是作为一条 warning 交给注入侧，
 * 因为 §9 要求超限时**显式提示、禁止静默截断**，那件事发生在 ContextBuilder，不在这里做。
 *
 * 导出原因（与 `bodyCharacterCount` 同一条理由）：这是 #571 关闭条件「部分页失败要如实落
 * `status: 'partial'`、不当作完整文档」的**唯一落点**，而它是个纯函数 —— 不导出就只能靠
 * 「起一个真 IndexedDB 的 manager」间接测，那种测试既慢又验不到判定本身。
 * 用例见 `tests/unit/pdf-parser-partial-480.test.mjs`。
 */
export const outcomeOf = (
  result: ParsedDocument
): {
  status: Extract<DocumentAttachment['status'], 'success' | 'partial'>
  warnings: string[]
  totalPages?: number
  extractedPages?: number
} => {
  const warnings = [...(result.warnings ?? [])]
  const totalPages = result.pages
  const extractedPages = result.extractedPages
  const pageGap =
    extractedPages !== undefined && totalPages !== undefined && extractedPages < totalPages
  return {
    status: pageGap || warnings.length > 0 ? 'partial' : 'success',
    warnings,
    totalPages,
    extractedPages,
  }
}

/**
 * 解析结果 → 落库用的**正文字符数**（#544 的唯一口径，manager 与缓存记录都走这里）。
 *
 * 为什么不能直接用 `result.text.length`：PDF 的 `text` 里带 `[第N页]` 标记与页间分隔换行，
 * 每页多 6 个字符 + 每页一个换行 —— 于是同一份内容走 txt 与 pdf 落库的字数不可比，
 * UI「已注入 x」、`estimatedTokens`、缓存全文记录会跟着一起飘（同一份文档、不同 parser、两个数）。
 * 正文口径只认解析器给的 `characterCount`（三个解析器同一口径，见 types.ts）。
 *
 * 兜底 `text.length` 只覆盖「外部注册的解析器没实现这个字段」（`registerAttachmentParser`
 * 允许运行期注册），不是给内置解析器留的后门。
 */
export const bodyCharacterCount = (
  parsed: Pick<ParsedDocument, 'text' | 'characterCount'>
): number => (typeof parsed.characterCount === 'number' ? parsed.characterCount : parsed.text.length)

/** 正文超注入预算：照实记一条 warning，全文仍然完整保存（截断留给注入侧显式做） */
const OVERFLOW_WARNING = (characterCount: number): string =>
  `正文 ${characterCount} 字符超过单份注入预算 ${ATTACHMENT_LIMITS.maxExtractedChars} 字符：` +
  '全文已完整保存，注入上下文时必须显式截断并向用户说明（#480 §9，禁止静默截断）'

/** 用缓存全文还原附件记录：字段与首次解析结果一致，不是「只有正文」的半份数据 */
const recordFromCache = (
  record: DocumentAttachment,
  cached: NonNullable<Awaited<ReturnType<typeof readAttachmentTextRecord>>>,
  parserVersion: string
): DocumentAttachment => {
  const next: DocumentAttachment = {
    ...record,
    status: cached.status,
    parsedTextPath: cached.key,
    characterCount: cached.characterCount,
    estimatedTokens: estimateTokens(cached.characterCount),
    parserVersion,
  }
  delete next.errorMessage
  if (cached.totalPages !== undefined) {
    next.totalPages = cached.totalPages
  }
  if (cached.extractedPages !== undefined) {
    next.extractedPages = cached.extractedPages
  }
  if (cached.warnings !== undefined && cached.warnings.length > 0) {
    next.warnings = [...cached.warnings]
  }
  return next
}

/**
 * 正在解析的缓存键 → 占位 Promise。
 *
 * 两个用途：同一个附件被连点两次、或同一份文件被添加成两个附件时，**不重复解析**；
 * 后到的一方等前者落库后直接走「缓存命中」分支 —— 拿到的是它自己那条记录的结论，
 * 不是把别人记录的对象原样返回（否则 id / filename 会串）。
 */
const inFlightParses = new Map<string, Promise<void>>()

/** 缓存未命中时的真正解析：读原件 → 调 parser → 落全文 → 落结论；异常一律落 `failed` */
const runParse = async (
  record: DocumentAttachment,
  extension: SupportedExtension,
  parserVersion: string,
  options?: ParseOptions
): Promise<DocumentAttachment> => {
  const blob = await readAttachmentBlob(record.localPath)
  if (blob === undefined) {
    // 原件不见了（存储被清理 / 库被外部改动；#531 之后**不再是**整包导入的结果：
    // `commitStaging()` 替换 `files` 时会保留 `attachment-` 前缀的原件）。
    // 不静默跳过：落 failed 让 UI 能提示「请重新上传」。
    const lost: DocumentAttachment = {
      ...record,
      status: 'failed',
      errorMessage: 'source-missing: attachment source is no longer in local storage',
      parserVersion,
    }
    delete lost.parsedTextPath
    await putAttachment(lost)
    reportStorageError('parse attachment source')(new Error(lost.errorMessage))
    return lost
  }

  // 状态机中间态落库：页面刷新 / 崩溃后能看出这条卡在解析中，可以重试
  await putAttachment({ ...record, status: 'parsing', parserVersion })

  try {
    const parser = parsers[extension]
    if (parser === undefined) {
      throw new AttachmentError('no-parser', `no parser registered for ${extension}`)
    }
    const result = await parser(blob, options)
    if (typeof result.text !== 'string') {
      throw new Error('parser returned no text')
    }
    const outcome = outcomeOf(result)
    // #544：落库字数走统一口径（正文，不含 PDF 的 `[第N页]` 标记与分隔换行）
    const characterCount = bodyCharacterCount(result)
    if (characterCount > ATTACHMENT_LIMITS.maxExtractedChars) {
      outcome.warnings.push(OVERFLOW_WARNING(characterCount))
    }
    const stored = await writeAttachmentTextRecord({
      sha256: record.sha256,
      parserVersion,
      text: result.text,
      // 缓存的全文记录必须与首次解析用同一个字数口径，否则 recordFromCache 与这里会打架
      characterCount,
      status: outcome.status,
      totalPages: outcome.totalPages,
      extractedPages: outcome.extractedPages,
      warnings: outcome.warnings,
    })
    const next: DocumentAttachment = {
      ...record,
      status: outcome.status,
      parsedTextPath: stored.key,
      characterCount,
      estimatedTokens: estimateTokens(characterCount),
      parserVersion,
    }
    delete next.errorMessage
    if (outcome.totalPages !== undefined) {
      next.totalPages = outcome.totalPages
    }
    if (outcome.extractedPages !== undefined) {
      next.extractedPages = outcome.extractedPages
    }
    if (outcome.warnings.length > 0) {
      next.warnings = outcome.warnings
    }
    await putAttachment(next)
    return next
  } catch (error) {
    const failed: DocumentAttachment = {
      ...record,
      status: 'failed',
      errorMessage: describeAttachmentError(error),
      parserVersion,
    }
    delete failed.parsedTextPath
    await putAttachment(failed)
    reportStorageError('parse attachment')(error)
    return failed
  }
}

/** 解析一条已落库的附件：缓存命中 → 直接还原结论；否则调对应 parser，异常落 failed */
const parseRecord = async (
  record: DocumentAttachment,
  options?: ParseOptions
): Promise<DocumentAttachment> => {
  const extension = resolveExtension(record.filename, record.mimeType)
  const parserVersion = PARSER_VERSIONS[extension]
  const cacheKey = attachmentTextKey(record.sha256, parserVersion)

  // 同内容已在解析：等它把头一次的结果落库，随后按缓存命中处理（不重复解析，也不串记录）
  const running = inFlightParses.get(cacheKey)
  if (running !== undefined) {
    await running
  }

  // 去重：同一文件 + 同一解析器版本只解析一次（重名/改名的同内容文件共用这一份）
  const cached = await readAttachmentTextRecord(cacheKey)
  if (cached !== undefined) {
    const next = recordFromCache(record, cached, parserVersion)
    await putAttachment(next)
    return next
  }

  const task = runParse(record, extension, parserVersion, options)
  const slot = task.then(
    () => undefined,
    () => undefined
  )
  inFlightParses.set(cacheKey, slot)
  try {
    return await task
  } finally {
    if (inFlightParses.get(cacheKey) === slot) {
      inFlightParses.delete(cacheKey)
    }
  }
}

export class AttachmentManager {
  /**
   * 校验文件，读取原件并计算指纹，然后在一个事务里保存原件和 pending 附件记录。
   * 不合格的输入**抛 `AttachmentError`**（格式 / MIME / 空文件 / 超限），由调用方提示用户；
   * 不返回「被悄悄忽略」的空结果。
   */
  async addFile(file: File): Promise<DocumentAttachment> {
    const extension = resolveExtension(file.name, file.type)
    if (file.size === 0) {
      throw new AttachmentError('empty-file', `attachment ${file.name} is empty`)
    }
    const limit = SIZE_LIMIT_BYTES[extension]
    if (file.size > limit) {
      throw new AttachmentError(
        'too-large',
        `attachment ${file.name} is ${file.size} bytes, over the ${extension} limit of ${limit}`
      )
    }
    let stage: AttachmentAddStage = 'attachment.read'
    try {
      const bytes = await readBlobBuffer(file)
      stage = 'attachment.prepare'
      const sha256 = await sha256Hex(bytes)
      // 哈希和入库原件来自同一次读取，之后解析也只访问这份本地副本。
      const source = new File([bytes], file.name, {
        type: file.type,
        lastModified: file.lastModified,
      })
      const draft: Omit<DocumentAttachment, 'localPath'> = {
        id: nextAttachmentId(),
        filename: file.name,
        mimeType:
          file.type === '' ? (MIME_BY_EXTENSION[extension][0] ?? '') : file.type.toLowerCase(),
        size: file.size,
        sha256,
        status: 'pending',
        createdAt: Date.now(),
      }
      stage = 'attachment.store'
      return await saveNewAttachment(draft, source)
    } catch (cause) {
      const error = new AttachmentAddError(stage, cause)
      recordError('document attachment add failed', { stage, 'error.name': error.causeName })
      throw error
    }
  }

  /** 解析：`pending → parsing → success | partial | failed`，异常一律落 `failed` + `errorMessage` */
  async parse(id: string, options?: ParseOptions): Promise<DocumentAttachment> {
    const record = await getAttachment(id)
    if (record === undefined) {
      throw new AttachmentError('not-found', `attachment not found: ${id}`)
    }
    return parseRecord(record, options)
  }

  /** 删元数据 + 全文 + 原件（后两者在引用计数归零时才删） */
  async remove(id: string): Promise<void> {
    await removeAttachment(id)
  }

  /** 取值入口（ContextBuilder / 注入侧用）：未解析、失败、正文缺失都返回 undefined，不抛错 */
  async getText(id: string): Promise<string | undefined> {
    const record = await getAttachment(id)
    const cached = await readAttachmentTextRecord(record?.parsedTextPath)
    return cached?.text
  }

  /** 元数据入口：去重（sha256）、展示（filename / size）、状态与告警都从这里取 */
  async getMeta(id: string): Promise<DocumentAttachment | undefined> {
    return getAttachment(id)
  }

  async list(): Promise<DocumentAttachment[]> {
    return listAttachments()
  }

  /**
   * 清理孤儿：
   *  1. 传了 `referenced`（当前仍被会话/消息引用的附件 id）→ 先删掉不在其中的附件元数据，
   *     连带按引用计数回收全文与原件；
   *  2. 无论如何都再扫一遍存储层孤儿（没人指向的全文、没人引用的原件）。
   *
   * 不传 `referenced` 时**不会**删任何元数据 —— 消息模型还没接上附件引用时，
   * 「没有引用」不等于「用户不要了」，宁可不删。
   */
  async sweepOrphans(referenced?: ReadonlySet<string>): Promise<number> {
    let removed = 0
    if (referenced !== undefined) {
      removed += await removeUnreferencedAttachments(referenced)
    }
    removed += await sweepOrphanStorage()
    return removed
  }
}

/** 单例：界面与注入侧共用一份（无状态，只是省掉调用方各自 new） */
export const attachmentManager = new AttachmentManager()

export const addAttachmentFile = (file: File): Promise<DocumentAttachment> =>
  attachmentManager.addFile(file)

export const parseAttachment = (id: string, options?: ParseOptions): Promise<DocumentAttachment> =>
  attachmentManager.parse(id, options)

export const removeAttachmentById = (id: string): Promise<void> => attachmentManager.remove(id)

export const getText = (id: string): Promise<string | undefined> => attachmentManager.getText(id)

export const getMeta = (id: string): Promise<DocumentAttachment | undefined> =>
  attachmentManager.getMeta(id)

/**
 * 当前仍被会话/消息引用的附件 id 集合。
 *
 * 消息里的文档附件以 `UserMessage.files[].id` 的形式被引用（`att-` 前缀即本模块的附件 id），
 * 这里用游标一条一条读会话，不把整库历史读进内存；`sweepOrphans(await collectReferencedAttachmentIds())`
 * 是删除会话后的标准收尾调用。
 */
export const collectReferencedAttachmentIds = async (): Promise<Set<string>> => {
  const referenced = new Set<string>()
  const tx = await openChatTransaction(['sessions'])
  for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
    for (const message of cursor.value.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (isAttachmentId(file.id)) {
          referenced.add(file.id)
        }
      }
    }
  }
  await tx.done
  return referenced
}

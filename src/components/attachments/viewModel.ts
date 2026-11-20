/**
 * #527 附件卡片的**视图模型**：把 manager 的 `DocumentAttachment` 折成卡片要用的一份数据，
 * 再提供几个纯函数（进度百分比 / 阶段文案 / 失败原因码 / 告警归并）。
 *
 * 这里不持有任何状态，也不改服务层记录 —— 五态状态机的权威在 manager（`pending → parsing →
 * success | partial | failed`），本文件只做「读出来怎么显示」。
 */
import type { TranslationKey, TranslationParams } from '../../i18n/index.js'
import { ATTACHMENT_LIMITS } from '../../services/attachments/limits.js'
import type { AttachmentStatus, DocumentAttachment } from '../../services/attachments/types.js'
import type { AttachmentErrorReason } from './attachmentService.js'

/**
 * 卡片上的状态 = 服务层五态 + UI 独有的 `cancelled`。
 *
 * `cancelled` 不是第六种服务状态：用户点「取消」后 parser 抛 abort，manager 照规矩落 `failed`
 * （它不认识「用户主动取消」和「真的解析崩了」的区别）。红色「解析失败」+ 一句 abort 的内部
 * 报错给用户看是没有意义的，所以视图层按本地标记显示成中性的「已取消」，并只给「重新解析」。
 */
export type AttachmentViewStatus = AttachmentStatus | 'cancelled'

/** manager `ParseOptions.onProgress` 的载荷形状 */
export type AttachmentProgress = { page?: number; totalPages?: number; stage: string }

export type AttachmentView = {
  id: string
  filename: string
  size: number
  status: AttachmentViewStatus
  /** 仅在 `parsing` 时有值 */
  progress: AttachmentProgress | null
  /** 解析告警**原文**（parser / manager 给的可读句子），不做二次翻译 */
  warnings: string[]
  /** 注入侧的额外告警（ContextBuilder 的 `BuildResult.warnings`），本轮由调用方传入 */
  injectionWarnings: string[]
  /** 注入时被截断、没发送出去的字符数（#480 §9「必须显式说明」） */
  truncatedCharacters?: number
  /** manager 记的失败原文（形如 `no-parser: …`），面板里作为「技术信息」原样展示 */
  errorMessage?: string
  characterCount?: number
  estimatedTokens?: number
  totalPages?: number
  extractedPages?: number
}

const present = <T>(value: T | undefined): value is T => value !== undefined

/**
 * 服务层记录 → 视图模型。`status` 可被显式覆盖成 `cancelled`（见上面的说明）。
 */
export const toAttachmentView = (
  attachment: DocumentAttachment,
  extra?: {
    status?: AttachmentViewStatus
    progress?: AttachmentProgress | null
    injectionWarnings?: string[]
    truncatedCharacters?: number
  }
): AttachmentView => {
  const view: AttachmentView = {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    status: extra?.status ?? attachment.status,
    progress: extra?.progress ?? null,
    warnings: attachment.warnings === undefined ? [] : [...attachment.warnings],
    injectionWarnings: extra?.injectionWarnings === undefined ? [] : [...extra.injectionWarnings],
  }
  if (extra?.truncatedCharacters !== undefined && extra.truncatedCharacters > 0) {
    view.truncatedCharacters = extra.truncatedCharacters
  }
  if (present(attachment.errorMessage)) {
    view.errorMessage = attachment.errorMessage
  }
  if (present(attachment.characterCount)) {
    view.characterCount = attachment.characterCount
  }
  if (present(attachment.estimatedTokens)) {
    view.estimatedTokens = attachment.estimatedTokens
  }
  if (present(attachment.totalPages)) {
    view.totalPages = attachment.totalPages
  }
  if (present(attachment.extractedPages)) {
    view.extractedPages = attachment.extractedPages
  }
  return view
}

type Translate = (key: TranslationKey, params?: TranslationParams) => string

/**
 * 卡片与面板共用的告警列表（**顺序即展示顺序**）：
 *  1. 解析器给的原文（「已忽略 3 张图片」「第 3、7 页提取失败」…）；
 *  2. 注入侧给的（「内容过长…」之类，由 ContextBuilder 产出）；
 *  3. 兜底：`partial` 但一条告警都没有时，用页数差补一条 —— 状态是 partial 却什么都不说，
 *     等于静默降级，§3.5/§9 都不允许。
 */
export const attachmentWarnings = (view: AttachmentView, t: Translate): string[] => {
  const list = [...view.warnings, ...view.injectionWarnings]
  const truncated = view.truncatedCharacters
  if (truncated !== undefined) {
    // 注入侧通常已经自己写了一条「剩余 N 字符未发送」：同一条信息说两遍只会让用户以为
    // 丢了两次内容，所以只要已有告警里出现过这个数字就不再补。
    const mentioned = list.some((warning) => warning.indexOf(String(truncated)) >= 0)
    if (!mentioned) {
      list.push(t('attachDetailTruncated', { rest: truncated }))
    }
  }
  if (list.length > 0) {
    return list
  }
  const total = view.totalPages
  const extracted = view.extractedPages
  if (view.status === 'partial' && total !== undefined && extracted !== undefined) {
    return [t('attachWarnPageGap', { total, extracted })]
  }
  return []
}

/** 进度百分比：没有页数信息（TXT/DOCX 的阶段性进度）时返回 `null`，卡片走不确定态 */
export const parsePercent = (progress: AttachmentProgress | null): number | null => {
  if (progress === null) {
    return null
  }
  const total = progress.totalPages
  const page = progress.page
  if (total === undefined || page === undefined || total <= 0) {
    return null
  }
  const ratio = Math.round((page / total) * 100)
  return Math.max(0, Math.min(100, ratio))
}

const STAGE_KEYS: Record<string, TranslationKey> = {
  validate: 'attachStageValidate',
  unzip: 'attachStageUnzip',
  parse: 'attachStageParse',
  render: 'attachStageRender',
  open: 'attachStageOpen',
  page: 'attachStagePage',
  read: 'attachStageRead',
  decode: 'attachStageDecode',
  done: 'attachStageDone',
}

/** 阶段文案；不认识的新阶段（解析器以后加的 stage）回退成通用的「解析中…」，不把英文 stage 名端给用户 */
export const stageLabel = (progress: AttachmentProgress | null, t: Translate): string => {
  if (progress === null) {
    return t('attachStatusParsingPlain')
  }
  const key = STAGE_KEYS[progress.stage]
  if (key === undefined) {
    return t('attachStatusParsingPlain')
  }
  if (key === 'attachStagePage' && progress.page !== undefined) {
    return t('attachStatusParsingStage', { stage: t(key, { page: progress.page }) })
  }
  return t('attachStatusParsingStage', { stage: t(key) })
}

/**
 * 原因码 → 标题文案的**唯一**映射表。
 *
 * 类型是 `Record<AttachmentErrorReason, TranslationKey>`：`AttachmentErrorReason` 里加一个码
 * 而这里不补，`npx tsc` 立刻红 —— 这正是 #574 的缺口所在（`PdfParseError.code` 到了界面上
 * 没有对应条目，只能落 `attachFailUnknown`「解析过程中出现了未知问题」）。
 *
 * `attachFailUnknown` **只留给真正不认识的码**（没有任何已知码能映射到它）。
 *
 * 导出（而不是文件内私有）：这是「码 → 文案」的唯一真相源，用例要能逐行拿它跟
 * `AttachmentErrorReason` / `PdfParseErrorCode` 对表 —— 见
 * `tests/unit/attachment-failure-copy-574.test.mjs`。
 */
export const ATTACHMENT_FAILURE_KEYS: Record<AttachmentErrorReason, TranslationKey> = {
  'unsupported-format': 'attachFailUnsupportedFormat',
  'mime-mismatch': 'attachFailMimeMismatch',
  'empty-file': 'attachFailEmpty',
  'too-large': 'attachFailTooLarge',
  'not-found': 'attachFailNotFound',
  'source-missing': 'attachFailSourceMissing',
  'no-parser': 'attachFailNoParser',
  // PDF 解析器的硬失败码（#574）：每种成因一句人话 + 下一步怎么做，不再是「未知问题」
  fileTooLarge: 'attachPdfErrFileTooLarge',
  notPdfFile: 'attachPdfErrNotPdf',
  encryptedPdf: 'attachPdfErrEncrypted',
  tooManyPages: 'attachPdfErrTooManyPages',
  noTextLayer: 'attachPdfErrNoTextLayer',
  libUnavailable: 'attachPdfErrLibUnavailable',
  openFailed: 'attachPdfErrOpenFailed',
  unknown: 'attachFailUnknown',
}

/**
 * 页数超限时把「共 N 页」也说出来（`PDF 共 800 页，超过上限 500 页，请拆分后再上传`）。
 *
 * 页数不在任何结构化字段里 —— 失败记录只剩 `errorMessage`，而解析器已经把这个数字写在自己
 * 那句人话里（`该 PDF 有 800 页，超过 500 页上限，请拆分后再上传`）。所以这里只从**技术信息**
 * 里取第一个 `<数字> 页`：取到就带上（用户不用展开技术信息才知道差多少），取不到就不带数字
 * （`attachPdfErrTooManyPagesPlain`），不猜、不用默认值。
 */
const pagesInFailureText = (raw: string | undefined): number | undefined => {
  if (raw === undefined) {
    return undefined
  }
  const matched = /(\d+)\s*页/u.exec(raw)
  if (matched === null) {
    return undefined
  }
  const pages = Number(matched[1])
  return Number.isFinite(pages) && pages > 0 ? pages : undefined
}

/** 需要额外参数的原因码：目前只有页数超限（上限来自 limits，页数从上文的文案里取） */
const failureParams = (
  reason: AttachmentErrorReason,
  raw: string | undefined
): TranslationParams | undefined => {
  if (reason !== 'tooManyPages') {
    return undefined
  }
  const limit = ATTACHMENT_LIMITS.pdfMaxPages
  const pages = pagesInFailureText(raw)
  return pages === undefined ? { limit } : { pages, limit }
}

/**
 * manager 的 `errorMessage` 形如 `no-parser: no parser registered for .pdf`（`reason: message`）。
 * 面板上半句给人看（按码翻译），下半句「技术信息」原样保留 —— 排查时它才是线索。
 */
export const failureOf = (view: AttachmentView, t: Translate): { title: string; raw?: string } => {
  const message = view.errorMessage
  if (message === undefined) {
    return { title: t(ATTACHMENT_FAILURE_KEYS.unknown) }
  }
  const separator = message.indexOf(':')
  const code = separator > 0 ? message.slice(0, separator).trim() : ''
  const raw = separator > 0 ? message.slice(separator + 1).trim() : message
  const reason = code === '' ? 'unknown' : (code as AttachmentErrorReason)
  const key = ATTACHMENT_FAILURE_KEYS[reason]
  if (key === undefined) {
    // 真正不认识的码（解析器/管理器的更新版本写进来的）：兜底标题 + 原文进「技术信息」，
    // 不假装知道原因。已知码一律不会走到这里（`ATTACHMENT_FAILURE_KEYS` 的 Record 类型 + 用例双重保证）。
    const fallback: { title: string; raw?: string } = { title: t(ATTACHMENT_FAILURE_KEYS.unknown) }
    if (raw !== '') {
      fallback.raw = raw
    }
    return fallback
  }
  const params = failureParams(reason, raw)
  const usePlainPages = reason === 'tooManyPages' && params !== undefined && params.pages === undefined
  const title = usePlainPages ? t('attachPdfErrTooManyPagesPlain', params) : t(key, params)
  const result: { title: string; raw?: string } = { title }
  if (raw !== '') {
    result.raw = raw
  }
  return result
}

/** 状态文案（卡片第二行）：五态 + 取消，逐态不同 */
export const statusLine = (view: AttachmentView, t: Translate): string => {
  switch (view.status) {
    case 'parsing': {
      const percent = parsePercent(view.progress)
      return percent === null ? stageLabel(view.progress, t) : t('attachStatusParsing', { percent })
    }
    case 'pending':
      return t('attachStatusPending')
    case 'success':
      return t('attachStatusSuccess')
    case 'partial':
      return t('attachStatusPartial', { count: attachmentWarnings(view, t).length })
    case 'failed':
      return t('attachStatusFailed')
    default:
      return t('attachStatusCancelled')
  }
}

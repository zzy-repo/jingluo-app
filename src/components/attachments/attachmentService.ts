/**
 * #527 文档附件 UI ↔ `AttachmentManager` 的接线缝。
 *
 * 为什么是「注入」而不是直接 import：`manager.ts`（#523 / PR #529）还没合入 base
 * `feat/480-doc-attachments`，此刻写静态 import 会让 `npx tsc` 直接红；而 UI 侧也不允许
 * 自己再造一套状态管理（附件的权威状态在 manager：IndexedDB 里的记录 + 五态状态机）。
 * 所以这一层只做三件事：
 *
 *  1. **声明 manager 的公开签名**（与 PR #529 的 `AttachmentManager` 逐字一致）；
 *  2. 提供一个注册点 `setAttachmentService()`，manager 合入后调用一次即可；
 *  3. 没注册时**不崩、也不假装成功**：添加/解析一律给出明确提示（`attachUnavailable`）。
 *
 * TODO(480-D)：manager.ts 合入 base 后，在应用入口（`src/main.tsx`）加这几行，然后本文件的
 * 注入逻辑保持不变：
 *
 * ```ts
 * import {
 *   attachmentManager,
 *   collectReferencedAttachmentIds,
 * } from './services/attachments/manager.js'
 * import { setAttachmentService } from './components/attachments/attachmentService.js'
 *
 * setAttachmentService({
 *   addFile: (file) => attachmentManager.addFile(file),
 *   parse: (id, options) => attachmentManager.parse(id, options),
 *   remove: (id) => attachmentManager.remove(id),
 *   getMeta: (id) => attachmentManager.getMeta(id),
 *   sweepOrphans: (referenced) => attachmentManager.sweepOrphans(referenced),
 *   collectReferencedAttachmentIds,
 * })
 * ```
 */
import { ATTACHMENT_LIMITS, SUPPORTED_EXTENSIONS } from '../../services/attachments/limits.js'
import type { SupportedExtension } from '../../services/attachments/limits.js'
import type { DocumentAttachment, ParseOptions } from '../../services/attachments/types.js'
import { showToast } from '../base/toastState.js'

/** manager 抛的 `AttachmentError.reason` 的码集合（PR #529 的 `AttachmentErrorReason`） */
export type AttachmentErrorReason =
  | 'unsupported-format'
  | 'mime-mismatch'
  | 'empty-file'
  | 'too-large'
  | 'not-found'
  | 'source-missing'
  | 'no-parser'
  | 'unknown'

/** 拒绝原因：manager 的码 + UI 侧自己判的「超出单条消息数量上限」 */
export type AttachmentRejectReason = AttachmentErrorReason | 'too-many'

export type AttachmentReject = {
  file: File
  reason: AttachmentRejectReason
  /** 仅 `too-large` 有：该扩展名的字节上限 */
  limitBytes?: number
}

/** `AttachmentManager` 的公开面（UI 只用这几个入口，`getText` 属于注入侧，见 #480-F） */
export type AttachmentService = {
  addFile: (file: File) => Promise<DocumentAttachment>
  parse: (id: string, options?: ParseOptions) => Promise<DocumentAttachment>
  remove: (id: string) => Promise<void>
  getMeta: (id: string) => Promise<DocumentAttachment | undefined>
  sweepOrphans: (referenced?: ReadonlySet<string>) => Promise<number>
  /** manager 的 `collectReferencedAttachmentIds()`，有就一起注册，删除会话后的收尾会用到 */
  collectReferencedAttachmentIds?: () => Promise<Set<string>>
}

let service: AttachmentService | null = null

/** 注册 / 注销 manager。传 `null` 用于测试与热更新时复位 */
export const setAttachmentService = (next: AttachmentService | null): void => {
  service = next
}

export const getAttachmentService = (): AttachmentService | null => service

/**
 * 附件 id 前缀。消息里的文档附件以 `UserMessage.files[].id` 的形式被引用，带 `att-` 前缀
 * 才能在历史数据里与图片上传（Files API 那套 `serverId`）区分开。
 *
 * TODO(480-D)：manager 已导出 `isAttachmentId()`，合入后改成从那里取，别在这里再维护一份。
 */
export const ATTACHMENT_ID_PREFIX = 'att-'

export const isAttachmentRefId = (id: string): boolean => id.startsWith(ATTACHMENT_ID_PREFIX)

/** 从 manager 抛出的 `AttachmentError` 里取 `reason`；不是它抛的就归 `unknown` */
export const rejectReasonOf = (error: unknown): AttachmentErrorReason => {
  if (typeof error === 'object' && error !== null && 'reason' in error) {
    const reason = (error as { reason?: unknown }).reason
    if (typeof reason === 'string' && KNOWN_REASONS.indexOf(reason as AttachmentErrorReason) >= 0) {
      return reason as AttachmentErrorReason
    }
  }
  return 'unknown'
}

const KNOWN_REASONS: readonly AttachmentErrorReason[] = [
  'unsupported-format',
  'mime-mismatch',
  'empty-file',
  'too-large',
  'not-found',
  'source-missing',
  'no-parser',
]

/** 各扩展名的单文件上限，全部来自 `limits.ts`（不在 UI 里另写数字） */
const SIZE_LIMIT_BYTES: Record<SupportedExtension, number> = {
  '.txt': ATTACHMENT_LIMITS.txtMaxBytes,
  '.docx': ATTACHMENT_LIMITS.docxMaxBytes,
  '.pdf': ATTACHMENT_LIMITS.pdfMaxBytes,
}

/** 文件对话框与拖入/粘贴共用的扩展名过滤串：`.txt,.docx,.pdf` */
export const ACCEPT_DOCUMENTS = SUPPORTED_EXTENSIONS.join(',')

export const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot).toLowerCase() : ''
}

const isSupportedExtension = (extension: string): extension is SupportedExtension =>
  (SUPPORTED_EXTENSIONS as readonly string[]).indexOf(extension) >= 0

export const sizeLimitOf = (filename: string): number | undefined => {
  const extension = extensionOf(filename)
  return isSupportedExtension(extension) ? SIZE_LIMIT_BYTES[extension] : undefined
}

/**
 * 选择/拖入的文件先在这里分拣：**不合格的一条也不静默吞掉**，全部作为 `rejected` 返回，
 * 由调用方逐条提示（issue #527 第 1 条：明确拒绝并提示，不是静默过滤）。
 *
 * 这里只做「一眼能看出来」的初筛（扩展名 / 空文件 / 体积 / 数量），真正的权威校验仍在
 * manager.addFile()——它还会做扩展名与 MIME 双判并抛 `AttachmentError`，所以初筛放行的文件
 * 仍可能被 manager 拒绝，那条路径的提示在 `useAttachmentDrafts` 里。
 */
export const classifyAttachmentFiles = (
  files: File[],
  options?: { limit?: number; existing?: number }
): { accepted: File[]; rejected: AttachmentReject[] } => {
  const limit = options?.limit
  const existing = options?.existing ?? 0
  let room = limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit - existing)
  const accepted: File[] = []
  const rejected: AttachmentReject[] = []
  for (const file of files) {
    const extension = extensionOf(file.name)
    if (!isSupportedExtension(extension)) {
      rejected.push({ file, reason: 'unsupported-format' })
      continue
    }
    if (file.size === 0) {
      rejected.push({ file, reason: 'empty-file' })
      continue
    }
    const limitBytes = SIZE_LIMIT_BYTES[extension]
    if (file.size > limitBytes) {
      rejected.push({ file, reason: 'too-large', limitBytes })
      continue
    }
    if (room <= 0) {
      rejected.push({ file, reason: 'too-many' })
      continue
    }
    room -= 1
    accepted.push(file)
  }
  return { accepted, rejected }
}

/**
 * 删除消息 / 会话后收尾：先收集「当前仍被引用的附件 id」，再把没人引用的清掉。
 *
 * 说明（issue #527 第 4 条）：
 *  - 不传 `referenced` 时 manager 也**不会**删元数据（「没有引用」不等于「用户不要了」），
 *    只清存储层孤儿，所以收集不到引用表时调用也是安全的；
 *  - 调用点（`services/chat/store.ts` 的删除会话 / 删除消息）属于 `src/services/**`，
 *    本轮按分工不动，接线留给 #480-F：
 *    `void sweepOrphanAttachmentsAfterDelete()` 放在删除事务提交之后即可。
 */
export const sweepOrphanAttachments = async (referenced?: ReadonlySet<string>): Promise<number> => {
  const current = getAttachmentService()
  if (current === null) {
    return 0
  }
  return current.sweepOrphans(referenced)
}

export const sweepOrphanAttachmentsAfterDelete = async (): Promise<number> => {
  const current = getAttachmentService()
  if (current === null) {
    return 0
  }
  try {
    const collect = current.collectReferencedAttachmentIds
    const referenced = collect === undefined ? undefined : await collect()
    return await current.sweepOrphans(referenced)
  } catch {
    // 清理失败不该让「删除会话」这条主流程看起来失败：明说一句就好，不吞
    showToast({ key: 'attachSweepFailed' })
    return 0
  }
}

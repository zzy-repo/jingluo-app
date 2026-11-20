import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

/**
 * 已就绪的**文档附件引用**（#480 / #527 接线）。
 *
 * 文档附件不走上传：原件与解析全文都在 `AttachmentManager`（IndexedDB），消息里只需要
 * 一个 id 引用。所以它不是 `DraftAttachment`（那个类型带 `File` + 上传任务），单独一个数组，
 * 发送时由 `prepareDraftMessage()` 折成 `FileAttachment`（`serverId: null`、`isImage: false`）——
 * 与 `attachments/manager.ts` 的 `collectReferencedAttachmentIds()`
 * （「消息里的文档附件以 `UserMessage.files[].id` 的形式被引用」）和请求侧
 * （`attachments/requestDocs.ts` 把非图片 `files[].id` 转成 `ChatAttachmentRef`）同一口径。
 */
export type DraftDocument = {
  /** `DocumentAttachment.id`（`att-` 前缀），消息里存的就是它 */
  id: string
  name: string
  size: number
  mimeType: string
}

type Draft = { text: string; attachments: DraftAttachment[]; documents: DraftDocument[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [], documents: [] }

/** 草稿只保存在本次页面的内存中，独立于会话详情缓存；null 是新对话的草稿。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0 || draft.documents.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, apiKey: string) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage
  ).catch(() => {})
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = (
  sessionId: string | null,
  files: File[],
  apiKey: string
): TranslationMessage | null => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const added = files.map((file): DraftAttachment => {
    const image = isImage(resolveMimeType(file))
    return {
      id: createId(),
      file,
      isImage: image,
      previewUrl: image ? URL.createObjectURL(file) : null,
    }
  })
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...added] }))
  added.forEach((attachment) => upload(attachment, apiKey))
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment) {
    upload(attachment, apiKey)
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0 && draft.documents.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    if (task?.status !== 'done' || !task.serverId) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task.serverId,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  /**
   * 文档附件引用（#480）：`serverId: null` + 无 blob。
   * - 不给 `serverId` → `reply.ts` 的 `toFileBlocks()` 自然排除它，不会拼出 `file_id` 块；
   * - 不进 `pendingFiles`（发送处只收 `files` 里带 blob 的那些）→ 永远不会被当成图片补传；
   * - 但仍挂在 `UserMessage.files` 上：请求侧与孤儿清扫都按这个字段认出「这条消息引用了哪份文档」。
   */
  const documents: FileAttachment[] = draft.documents.map((item) => ({
    id: item.id,
    serverId: null,
    name: item.name,
    size: item.size,
    isImage: false,
    mimeType: item.mimeType,
  }))
  return { text, files, documents }
}

const releaseAttachment = (attachment: DraftAttachment, cancel: boolean) => {
  if (cancel) {
    cancelUpload(attachment.id)
  }
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  releaseAttachment(attachment, true)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/**
 * 输入区已就绪的文档附件列表整体同步（#527）。
 *
 * 由 `ChatInput` 在 `useAttachmentDrafts().attachments` 变化时调用：只有 `success` / `partial`
 * 的附件才进这里（解析中 / 失败 / 取消的卡片留在输入区，但不进消息）。
 * 整体覆盖而不是增量：输入区的卡片列表本来就是唯一权威，增量同步迟早对不上。
 */
export const setDraftDocuments = (sessionId: string | null, documents: DraftDocument[]) => {
  const current = getDraft(sessionId).documents
  const same =
    current.length === documents.length &&
    current.every((item, index) => item.id === documents[index].id)
  if (same) {
    return
  }
  updateDraft(sessionId, (draft) => ({ ...draft, documents }))
}

/** 发送成功后原件与 serverId 已交给会话，释放预览但保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, false))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => releaseAttachment(attachment, true))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => releaseAttachment(attachment, true))
  }
  useDrafts.setState({ drafts: new Map() })
}

import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { getCurrentSpec } from '../api/apiConfig.js'
import { visionFor } from '../api/providers.js'
import {
  cancelUpload,
  getFileExt,
  isImage,
  markInlineRejected,
  markInlineUpload,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import { IMAGE_EXTS, sniffImage } from '../attachments/imageSource.js'
import { LIMITS, mbOf } from '../limits.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  previewUrl: string | null
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

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
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

/**
 * base64 渠道图片的「准备」：**不发上传请求**，只按 magic bytes 验一遍字节。
 *
 * 为什么验：真格式只能靠字节认（iPhone 的 HEIC 常带 `image/jpeg` 之外的各种 MIME，
 * 甚至没有 MIME），在这里判死能立刻把原因写在卡片上，而不是等发送失败后再猜。
 * 编码本身不在这里做 —— 那是 async 且吃 canvas 的活，放在发送前一次性做。
 */
const prepareInline = (attachment: DraftAttachment) => {
  void attachment.file
    .slice(0, LIMITS.images.sniffHeadBytes)
    .arrayBuffer()
    .then((buffer) => {
      const sniffed = sniffImage(new Uint8Array(buffer))
      if (!sniffed) {
        markInlineRejected(attachment.id, { key: 'imageUnsupportedFormat' })
        return
      }
      if (attachment.file.size > LIMITS.images.maxSourceBytes) {
        markInlineRejected(attachment.id, {
          key: 'imageTooLarge',
          params: { size: mbOf(LIMITS.images.maxSourceBytes) },
        })
        return
      }
      markInlineUpload(attachment.id)
    })
    .catch(() => {
      markInlineRejected(attachment.id, { key: 'imageEncodeFailed' })
    })
}

const upload = (attachment: DraftAttachment, apiKey: string) => {
  /**
   * base64 渠道（anthropic / openai / ours）的图片**不上传**（#551）：
   * 这三家没有 `paths.files`，发出上传请求只会是 #360 那种 404，而且 base64 通路
   * 根本不需要 file_id。落成「内联就绪」，真正的编码在发送前做。
   */
  if (attachment.isImage && visionFor(getCurrentSpec().kind).base64) {
    prepareInline(attachment)
    return
  }
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
  /**
   * base64 渠道的额外两道门（#551）：这类渠道**只发图片**（文档要 #480 的文本注入，
   * 那是另一条链路），而且图片格式必须在白名单里 —— heic 之类在这里就明确拒绝，
   * 不等到发送时才失败，更不静默丢图。
   */
  if (visionFor(getCurrentSpec().kind).base64) {
    for (const file of files) {
      const mimeType = resolveMimeType(file)
      // 扩展名也可能缺（无扩展名的相册导出），两样都不像图片就是「这类渠道根本发不了」
      const looksImage = isImage(mimeType) || IMAGE_EXTS.includes(getFileExt(file.name))
      if (!looksImage) {
        return { key: 'uploadImageOnly' }
      }
      // MIME 说了是图片但不在白名单（heic / avif / bmp / svg…）：在这里就明确拒绝，
      // 权威判定随后由 prepareInline 的 magic bytes 再做一次（MIME 可以撒谎）
      if (isImage(mimeType) && !IMAGE_EXTS.includes(getFileExt(file.name))) {
        return { key: 'imageUnsupportedFormat' }
      }
    }
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

/**
 * 发送按钮和实际提交共用规则：有内容，且全部附件都已就绪
 * （上传成功拿 `serverId`，或 base64 渠道的图片已落成 `inline`）。
 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    // `inline` = base64 渠道的图片已就绪（没有 serverId，发送前本地编码）；其余情况必须上传完成
    const inline = task?.status === 'inline'
    if (!inline && (task?.status !== 'done' || !task.serverId)) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task?.status === 'done' ? task.serverId : null,
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      blob: attachment.file,
    })
  }
  return { text, files }
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

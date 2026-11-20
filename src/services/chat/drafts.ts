import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { getCurrentSpec } from '../api/apiConfig.js'
import { visionFor } from '../attachments/providerCapability.js'
import {
  cancelUpload,
  getFileExt,
  isImage,
  markInlineEncoding,
  markInlineReady,
  markInlineRejected,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import {
  HEIF_EXTS,
  IMAGE_EXTS,
  ImageSourceError,
  imagePartBytes,
  imagePartOf,
  putImagePart,
  toImagePart,
  unsupportedImageFormatMessage,
} from '../attachments/imageSource.js'
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

/**
 * 编码串行链：canvas 重编码会**占主线程 + 撑内存**（一张 5MB 的图 base64 后约 6.7MB 常驻），
 * 而一次选图可以很多张 —— 全并发在 83 档的 Android WebView 上足以让输入框卡死。
 * 上传通路那边有 `MAX_CONCURRENT` 队列，这里用最简单的串行链：编码是低频动作（选图一次一批），
 * 串行的代价只是「后几张的蒙层多转一会儿」，换来的是任何机型都不会被一口气压垮。
 */
let inlineQueue: Promise<void> = Promise.resolve()

/** 把一次编码排到队尾；`encodeInlineImage` 内部已经吞掉全部异常，链不会断 */
const queueInline = (job: () => Promise<void>) => {
  inlineQueue = inlineQueue.then(job)
}

/** 真正做编码：成功写缓存 + 就绪态，失败按可读原因 + 可重试位落到卡片上 */
const encodeInlineImage = async (attachment: DraftAttachment) => {
  try {
    const part = await toImagePart(attachment.file)
    putImagePart(attachment.id, part)
    markInlineReady(attachment.id, { mediaType: part.mediaType, bytes: imagePartBytes(part) })
  } catch (error: unknown) {
    // `ImageSourceError` 自带「给用户看的文案」和「重试有没有意义」：照搬，不重新归纳
    if (error instanceof ImageSourceError) {
      markInlineRejected(attachment.id, error.localMessage, error.retryable)
      return
    }
    markInlineRejected(attachment.id, { key: 'imageEncodeFailed' }, true)
  }
}

/**
 * base64 渠道图片的「准备」：**不发上传请求**，直接在本地编码（#551 的通路，#552 的时机）。
 *
 * 为什么把编码提到选图阶段（#552）：
 * 1. 只有编完才知道**真正发出去的字节**——超过阈值会被压成 webp、体积也变了，
 *    卡片要如实标出来（`describeSentImage`），让用户在点发送前就知道发的是 webp；
 * 2. 格式不支持 / 太大 / 编码失败当场给可读原因，`retryable` 决定要不要给重试入口，
 *    而不是等点发送才失败（**绝不静默丢图**）。
 *
 * 编码结果按「附件 id + 参数」写进 `imageSource` 的缓存，发送前 `store.prepareInlineImages`
 * 直接命中：同一张图不会压第二遍，字节也只可能是同一份（#345 前缀稳定照旧）。
 */
const prepareInline = (attachment: DraftAttachment) => {
  const cached = imagePartOf(attachment.id)
  if (cached) {
    // 重试 / 切回本渠道时复用已有产物（缓存签名里含全部压缩参数，参数变了 key 就变）
    markInlineReady(attachment.id, {
      mediaType: cached.mediaType,
      bytes: imagePartBytes(cached),
    })
    return
  }
  markInlineEncoding(attachment.id)
  queueInline(() => encodeInlineImage(attachment))
}

const upload = (attachment: DraftAttachment, apiKey: string) => {
  /**
   * base64 渠道（anthropic / openai / ours）的图片**不上传**（#551）：
   * 这三家没有 `paths.files`，发出上传请求只会是 #360 那种 404，而且 base64 通路
   * 根本不需要 file_id。落成「内联就绪」，编码在选图时做（见 `prepareInline`）。
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

/**
 * base64 渠道的**格式门**（#551 的第二道门 / #580 缺口 2）：只回答「这张图，这条通路编得了吗」。
 *
 * 为什么要单独提到 `validateFiles()` **前面**：`heic/heif` 不在 `ACCEPT_FILE_EXTS`（那是
 * 「哪些文件能上传」的白名单）里，先跑 `validateFiles()` 的话，iPhone 用户（相册默认 HEIC）
 * 拿到的是泛化的 `uploadUnsupportedFormat`——「暂未支持的文件格式……支持 PDF、DOC、图片、文本」
 * 既没说这条渠道只发图片，也没给出唯一有效的动作（转成 JPEG）；而真正 actionable 的
 * `imageUnsupportedFormat` 反过来**不可达**（只有「文件名装成 png、字节是 HEIC」那条少见路径
 * 才会落到编码层，见 #553 的用例）。
 *
 * 大小 / 数量 / 上传能力仍归 `validateFiles()`；这里只管格式一维（**格式 → 大小 → 数量**的顺序不变）。
 * 判定仍以「像不像图片」为界：`IMAGE_EXTS` 里的直接放行，`HEIF_EXTS` 或 MIME 是 `image/*` 的
 * 一律给「格式不支持 + 转成 JPEG」。权威判定随后仍在 `toImagePart()` 的 magic bytes（MIME 会撒谎）。
 */
const imageGateMessage = (files: File[]): TranslationMessage | null => {
  for (const file of files) {
    const ext = getFileExt(file.name)
    if (IMAGE_EXTS.includes(ext)) {
      continue
    }
    if (HEIF_EXTS.includes(ext) || isImage(resolveMimeType(file))) {
      return unsupportedImageFormatMessage()
    }
  }
  return null
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
  /**
   * base64 渠道的两道门（#551 / #580）：
   * 1. 图片格式必须在白名单里 → **先于** `validateFiles()` 的扩展名白名单（`imageGateMessage`）；
   * 2. 这条通路**只发图片**（文档走 #480 的文本注入，不经过这里；其余文件类型这条渠道
   *    一个字节都发不出去 —— 没有 `paths.files`），所以非图片要**明说**而不是上传后 404。
   */
  const base64Channel = visionFor(getCurrentSpec().kind).base64
  if (base64Channel) {
    const imageError = imageGateMessage(files)
    if (imageError) {
      return imageError
    }
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  if (base64Channel) {
    for (const file of files) {
      // 扩展名也可能缺（无扩展名的相册导出），两样都不像图片就是「这类渠道根本发不了」
      const looksImage = isImage(resolveMimeType(file)) || IMAGE_EXTS.includes(getFileExt(file.name))
      if (!looksImage) {
        return { key: 'uploadImageOnly' }
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
 * （上传成功拿到 `serverId`，或 base64 渠道的图片已落成 `inline`）。
 *
 * **不许静默丢图**：上传中 / 编码中 / 失败一律返回 null（按钮按不动），而不是「跳过这张图把
 * 文字发出去」—— 卡片上有原因和重试入口，用户自己决定（母单 #548 的硬约束）。
 */
export const prepareDraftMessage = (draft: Draft, tasks: Record<string, UploadTask>) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0 && draft.documents.length === 0) {
    return null
  }
  const files: (FileAttachment & { blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    // `inline` = base64 渠道的图片已就绪（没有 serverId，编码产物在 imageSource 缓存里）
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

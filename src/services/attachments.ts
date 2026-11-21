import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { ApiError, uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableApiError } from './api/errors.js'
import type { FilePurpose } from './api/types.js'
import { errorMeta, record, recordAction } from './diagnostics/collector.js'
import { buildMeta, endpointKeyFromUrl } from './diagnostics/fields.js'
import { REASON, type LogReason } from './diagnostics/reasons.js'
import { bytesPerSecond } from './diagnostics/timing.js'
import { getBaseUrl } from './api/apiConfig.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'
import { LIMITS } from './limits.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = LIMITS.attachments.maxSizeMb
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = LIMITS.attachments.maxUserDataSizeMb
export const MAX_COUNT = LIMITS.attachments.maxCount
/** 同时上传的文件数 */
const MAX_CONCURRENT = LIMITS.attachments.maxConcurrent

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
export const describeUploadError = (error: unknown): TranslationMessage => {
  // 本地判定的失败（例如「该渠道没有文件上传能力」）自带文案：照原样展示，
  // 不能吞成泛化的「上传失败」，否则用户点不出原因（#303 / #37 的关闭条件）
  if (error instanceof ApiError && error.localMessage) {
    return error.localMessage
  }
  if (classifyApiError(error) === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (getUploadErrorInfo(error)?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  return { key: 'uploadFileStatusFailed' }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/**
 * 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求。
 * `onStart` 在任务**真正开始**时回调一次（此时才知道排队等了多久），#313 的 `queueMs` 从这里来。
 */
const enqueueUpload = (
  apiKey: string,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal,
  onStart: (queueMs: number) => void
) => {
  const enqueuedAt = Date.now()
  return new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      // 队列等待结束：并发上限（MAX_CONCURRENT）造成的等待只能在这里量出来
      onStart(Math.max(0, Date.now() - enqueuedAt))
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      try {
        const body = file instanceof File ? file : new File([file], name, { type: file.type })
        resolve((await uploadFile(apiKey, body, getUploadPurpose(name, isImage), signal)).id)
      } catch (error) {
        reject(error)
      }
    })
    next()
  })
}

/**
 * 内联编码的产物摘要（#552）：卡片要如实告诉用户「真正发出去的是什么」——
 * 超过阈值的图会被压成 **webp**，字节数和原件也不一样（`attachments/imageSource.ts`
 * 的 `toImagePart()` 是唯一产出方）。完整字节留在那边的缓存里（`imagePartOf()`），
 * 这里只放展示要用的两样，避免为了显示体积去解一遍 base64。
 */
export type InlineImageInfo = {
  /** 编码产物的媒体类型（`image/webp` 等），**不是**文件名的扩展名 */
  mediaType: string
  /** 编码产物的真实字节数（由 base64 长度换算） */
  bytes: number
}

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  /**
   * 内联就绪（#551 的通路 / #552 的时机）：base64 渠道的图片**不进 Files API**
   * （这些渠道没有 `paths.files`，发了就是 #360 那类 404），选中即在本地编码，
   * 成功落成这个终态并带上编码产物的格式与体积。
   * 它和 `done` 一样代表「可以发送」，差别只是没有 `serverId`。
   */
  | ({ status: 'inline' } & InlineImageInfo)
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

/**
 * 每个附件本地 id 已经试过几次（#313）：用户点「重试」是一次**新的调用**，
 * 没有这个计数，日志里两条记录毫无关联，看不出「第一次就失败」和「重试完还是失败」。
 * 成功即清（下一条日志从 1 开始），失败保留（重试接着 +1）。
 */
const attempts = new Map<string, number>()

/** 渠道没有 Files API 时，#303 在本地就判失败（0 请求）：这是能力缺失，不是上传出错 */
const isChannelUnsupported = (error: unknown): boolean =>
  error instanceof ApiError && error.localMessage?.key === 'uploadChannelUnsupported'

/**
 * 额度类失败的机器可读原因（与 `describeUploadQuota` 的两档一致，不写文案原文）。
 *
 * 返回值用 `LogReason`（#301 维度 3）：取值来自 `reasons.ts` 的字典而不是就地写的裸字符串，
 * 拼错 / 自造词编译期就红；下游 `REASON_RETRYABLE` 也才能给出统一的默认可重试性。
 */
const quotaReason = (error: unknown): LogReason | undefined => {
  const code = getUploadErrorInfo(error)?.code
  if (code === 'fileCountLimit') {
    return REASON.quotaFiles
  }
  if (code === 'storageLimit') {
    return REASON.quotaStorage
  }
  return undefined
}

/**
 * 开始（或复用进行中的）上传，返回服务端 file_id；失败时任务记为 error 并抛出原错误。
 *
 * 埋点（#313）：每条文件三态齐全，文件名与内容都不进日志，只留体积 / 类型 / 耗时 / 端点：
 * - 开始：`upload-attachment`（带 `attempt`、`queueMs`）—— 排了多久的队在这里能看到；
 * - 成功：`file upload done`（`status:'ok'` + `durationMs` + `speedBps`）；
 * - 失败：`file upload failed`（`status:'error'` + `retryable` + `reason`）；
 * - 取消：`file upload aborted`（`status:'aborted'`，warn 级 —— 用户取消不是失败）；
 * - 渠道不支持：`file upload unavailable`（`status:'rejected'` + `reason:'channel-unsupported'`，
 *   warn 级 + `retryable:false`：重试没用，要让用户去换渠道，而不是对着卡片反复点）。
 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  const current = pending.get(id)
  if (current) {
    return current.promise
  }
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const attempt = (attempts.get(id) ?? 0) + 1
  attempts.set(id, attempt)
  const startedAt = Date.now()
  const endpointKey = endpointKeyFromUrl(getBaseUrl())
  /** 排队等待时长（任务真正开始时才有值）：上传耗时 = durationMs − queueMs */
  let queueMs = 0
  /** 本条文件三态共用的结构化字段（体积 / 类型不进文案，只进 meta） */
  const chatUploadMeta = (extra: Parameters<typeof buildMeta>[0]) =>
    buildMeta({
      flow: 'chat',
      stage: 'chat.upload',
      attempt,
      endpointKey,
      queueMs,
      bytes: blob.size,
      totalBytes: blob.size,
      ...extra,
    })
  const promise = enqueueUpload(apiKey, blob, name, isImage, controller.signal, (waited) => {
    queueMs = waited
    recordAction('nav', 'upload-attachment', {
      image: isImage,
      ...chatUploadMeta({}),
    })
  })
    .then((serverId) => {
      setTask(id, { status: 'done', serverId })
      attempts.delete(id)
      const duration = Date.now() - startedAt
      const speed = bytesPerSecond(blob.size, Math.max(0, duration - queueMs))
      record('nav', 'info', 'file upload done', {
        image: isImage,
        ...chatUploadMeta({ durationMs: duration, speedBps: speed, status: 'ok', retryable: false }),
      })
      return serverId
    })
    .catch((error: unknown) => {
      const aborted = controller.signal.aborted
      if (aborted) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: isRetryableApiError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      const duration = Date.now() - startedAt
      const speed = bytesPerSecond(blob.size, Math.max(0, duration - queueMs))
      // 三类「非网络故障」的失败要能一眼分开（#313 负向用例）：取消 / 渠道不支持 / 额度不足
      const unsupported = isChannelUnsupported(error)
      const quota = quotaReason(error)
      // `aborted` 是改造前的历史取值（用户取消），字典里对应的是 `cancelled`；换值会让老日志的
      // 筛选口径断裂，本批只把新写的取值常量化，历史取值统一在 LEGACY_REASONS 里登记。
      const reason = aborted ? 'aborted' : unsupported ? REASON.channelUnsupported : quota
      const meta = {
        image: isImage,
        ...(aborted ? { aborted: true } : {}),
        ...(reason === undefined ? {} : { reason }),
        ...chatUploadMeta({
          durationMs: duration,
          speedBps: speed,
          status: aborted ? 'aborted' : unsupported ? 'rejected' : 'error',
          retryable: aborted ? true : unsupported ? false : !quota && isRetryableApiError(error),
        }),
        ...errorMeta(error),
      }
      if (aborted) {
        record('warning', 'warn', 'file upload aborted', meta)
      } else if (unsupported) {
        record('warning', 'warn', 'file upload unavailable: channel has no files endpoint', meta)
      } else if (reason !== undefined) {
        record('error', 'error', `file upload failed: ${reason}`, meta)
      } else {
        record('error', 'error', 'file upload failed', meta)
      }
      throw error
    })
    .finally(() => pending.delete(id))
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  setTask(id, null)
}

/**
 * 开始本地编码（base64 渠道的图片，#552）：卡片回到「进行中」态（与上传中的蒙层同一套），
 * 首轮和「重试」都从这里进 —— 重试要先把上一次的错误态清掉。
 * 不在这里编码：编码是 async + 吃 canvas 的活，由 `chat/drafts.ts` 的 `prepareInline` 发起。
 */
export const markInlineEncoding = (id: string) => {
  setTask(id, { status: 'uploading' })
}

/**
 * 标记某个附件「内联就绪」（#551）。顺带记下编码产物的格式与体积（#552），
 * 卡片据此显示「发出去的是 webp · 218 KB」。
 */
export const markInlineReady = (id: string, info: InlineImageInfo) => {
  setTask(id, { status: 'inline', ...info })
}

/**
 * base64 渠道的图片被判死（magic bytes 不是图片 / 原始体积超硬上限 / 编码失败）：
 * 卡片上直接给原因，`retryable` 决定要不要给重试入口（#551 的「明确拒绝」）。
 */
export const markInlineRejected = (id: string, error: TranslationMessage, retryable: boolean) => {
  setTask(id, { status: 'error', error, retryable })
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * 图片格式的展示名，**只从字节判定得出的 mediaType 取**（`image/webp` → `WEBP`）。
 * 不能拿文件名的扩展名：`photo.png` 被压缩后发出去的是 `image/webp`，
 * 拿扩展名显示会把用户看到的东西写反。
 */
export const formatOfImageMediaType = (mediaType: string) =>
  (mediaType.split('/')[1] ?? '').toUpperCase()

/**
 * 「真正发出去的是什么」的卡片标签（#552）：用户有权知道压缩后的格式与体积。
 *
 * 判定只有一条：**字节和原件一样就是原图直发**（`toImagePart()` 的 passthrough 分支），
 * 卡片上什么都不加；字节变了说明过了 canvas 重编码（阈值触发，输出 webp，或 jpeg 回落），
 * 这时给出 `WEBP · 218 KB` —— 格式来自编码产物，体积是 base64 换算出来的真实字节数。
 *
 * 为什么用字节而不是「格式是否相同」来判断：浏览器的 `file.type` 可能为空或撒谎
 * （相册导出的 HEIC 常报 `image/jpeg`），拿它比较会既漏报又误报。
 */
export const describeSentImage = (sent: InlineImageInfo, originalBytes: number): string | null => {
  if (sent.bytes === originalBytes) {
    return null
  }
  return [formatOfImageMediaType(sent.mediaType), formatSize(sent.bytes)]
    .filter(Boolean)
    .join(' · ')
}

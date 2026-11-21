/**
 * #379：**上传失败的文案要能点名** —— 哪个附件、为什么。
 *
 * 改造前，发送前的附件补齐一旦失败，界面只剩一句「上传失败」（`uploadFileStatusFailed`）：
 * 用户既不知道是哪一张图 / 哪个文件，也不知道该重试、换格式、还是干脆删掉这条附件。
 * 而这条链路上的失败原因本来就在手上（HTTP 状态、错误分类、源缺失），只是没人往下传 ——
 * `prepareFiles` 把异常原样抛给 `streamReply`，那边只知道「补齐阶段出错」，文件名在那一步已经丢了。
 *
 * 本模块做三件事：
 *  1. `AttachmentUploadError`：把「哪个附件」和原始错误捆在一起往上抛（原始错误留在 `cause`，
 *     重试判定仍然读它 —— 别在这里重新判一次可重试性）；
 *  2. `uploadFailureReasonOf()`：把任意错误收敛成**封闭的 5 个原因**（界面文案按它取，
 *     不解析英文 message）；
 *  3. `describeUploadFailure()`：出可翻译的一句「附件「xxx」上传失败：<原因>」。
 *
 * 原因码刻意**不**复用 `AttachmentErrorReason`（那是解析期拒绝原因）也不复用
 * `UploadErrorCode`（那是配额 / 解析两类上游 400）：这里的分类口径是「用户下一步该做什么」。
 */
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { getUploadErrorInfo } from '../api/errors.js'
import { ImageSourceError } from './imageSource.js'

/** 上传失败的原因：文件缺失 / 端点 404 / 大小超限 / 网络 / 其它（界面各有文案） */
export type UploadFailureReason =
  | 'source-missing'
  | 'endpoint-not-found'
  | 'too-large'
  | 'network'
  | 'other'

/**
 * 「哪个附件上传失败了」：把文件名带上，避免上层只剩一句「上传失败」。
 *
 * 用独立类而不是给错误挂字段：`ApiError` 是协议层的类型，让它认识「第几个附件」会把
 * 两层职责搅在一起；`cause` 保留原始错误，重试判定（`isRetryableApiError`）照旧读它。
 */
export class AttachmentUploadError extends Error {
  readonly fileId: string
  readonly fileName: string
  override readonly cause: unknown

  constructor(file: { id: string; name: string }, cause: unknown) {
    super(`attachment upload failed: ${file.name}`)
    this.name = 'AttachmentUploadError'
    this.fileId = file.id
    this.fileName = file.name
    this.cause = cause
  }
}

/** 从任意错误里认出「这个附件在本机没有原件」（base64 渠道抛的是 `imageSourceMissing`） */
const isSourceMissing = (error: unknown): boolean =>
  error instanceof ImageSourceError && error.localMessage?.key === 'imageSourceMissing'

/**
 * 错误 → 原因码。判定顺序即优先级：
 * 源缺失（本地就能判死，重试没用）→ 端点不存在（换渠道才行）→ 超限（要压缩 / 删旧文件）
 * → 网络（重试有用）→ 其它（交给折叠区里的上游原文）。
 */
export const uploadFailureReasonOf = (error: unknown): UploadFailureReason => {
  if (isSourceMissing(error)) {
    return 'source-missing'
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'endpoint-not-found'
    }
    if (error.status === 413 || getUploadErrorInfo(error) !== null) {
      // 413 是体积；fileCountLimit / storageLimit 也是「空间不够」，下一步都是压缩或删旧文件
      return 'too-large'
    }
    if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'idle') {
      return 'network'
    }
  }
  return 'other'
}

/** 原因码 → 文案 key（每个 key 都带 `{name}`，界面上永远说得出是哪个附件） */
const FAILURE_KEYS: Record<UploadFailureReason, TranslationMessage['key']> = {
  'source-missing': 'uploadFailedSourceMissing',
  'endpoint-not-found': 'uploadFailedEndpointMissing',
  'too-large': 'uploadFailedTooLarge',
  network: 'uploadFailedNetwork',
  other: 'uploadFailedUnknown',
}

/** 一句点名的话：附件「report.pdf」上传失败：<原因> */
export const describeUploadFailure = (fileName: string, error: unknown): TranslationMessage => ({
  key: FAILURE_KEYS[uploadFailureReasonOf(error)],
  params: { name: fileName },
})

/**
 * 把「哪个附件」从抛出的错误里取回来（不是附件错误就返回 undefined，走原来的兜底文案）。
 * 供 `streamReply` 的失败分支使用：那里只拿到一个 error，没有文件上下文。
 */
export const attachmentUploadFailureOf = (
  error: unknown
): { fileName: string; cause: unknown } | undefined =>
  error instanceof AttachmentUploadError
    ? { fileName: error.fileName, cause: error.cause }
    : undefined

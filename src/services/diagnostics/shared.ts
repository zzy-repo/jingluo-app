import type { FeedbackErrorCode } from './types.js'

/**
 * 上传层的公共小工具：错误码映射 + 字节数计算。
 * 两套 transport（transport.http.ts 走 v1 契约、transport.legacy.ts 走后端实际接口）共用，
 * 但它**不认识 collector**，也不掺业务逻辑。
 */

/** 中文可读提示：错误码 → 一句话原因（UI 另有一套 i18n 文案，这里用于兜底与日志） */
const ERROR_MESSAGE: Record<FeedbackErrorCode, string> = {
  network: '网络连接失败，请检查网络后重试',
  timeout: '请求超时（15 秒），请稍后重试',
  too_large: '截图、描述或关键日志超过上传预算（180 KiB）或服务端上限，请缩小截图或减少描述后重试；截图不会被自动移除',
  unauthorized: '上传凭证无效或已过期（401），请联系维护者确认 CLIENT_TOKEN',
  rate_limited: '提交过于频繁（429），请稍后重试',
  server: '反馈服务异常（服务端错误），请稍后重试',
  rejected: '反馈被服务端拒绝，请检查内容后重试',
  unknown: '上传失败，请稍后重试',
}

export const describeFeedbackError = (code: FeedbackErrorCode): string => ERROR_MESSAGE[code]

/** 把任意字符串收敛到已知错误码（未知一律 unknown），UI 用它决定提示文案 */
export const toFeedbackErrorCode = (value: string): FeedbackErrorCode =>
  Object.hasOwn(ERROR_MESSAGE, value) ? (value as FeedbackErrorCode) : 'unknown'

/** UTF-8 字节数（和 Content-Length 同口径） */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** 序列化后的字节数 */
export const payloadBytes = (payload: unknown): number => {
  try {
    return utf8Bytes(JSON.stringify(payload))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** HTTP 状态码 → 错误码：401/413/429/5xx 分别对应凭证 / 体积 / 限流 / 服务端 */
export const statusToErrorCode = (status: number): FeedbackErrorCode => {
  if (status === 401 || status === 403) {
    return 'unauthorized'
  }
  if (status === 413) {
    return 'too_large'
  }
  if (status === 429) {
    return 'rate_limited'
  }
  if (status >= 500) {
    return 'server'
  }
  if (status >= 400) {
    return 'rejected'
  }
  return 'unknown'
}

/** 按响应体里的关键字再校正一次错误码（后端可能 200 + {ok:false,error:"payload too large"}） */
export const refineErrorCode = (code: FeedbackErrorCode, message: string): FeedbackErrorCode => {
  const text = message.toLowerCase()
  if (code === 'unknown' && text.includes('too large')) {
    return 'too_large'
  }
  if (code === 'unknown' && /timeout|timed out/.test(text)) {
    return 'timeout'
  }
  return code
}

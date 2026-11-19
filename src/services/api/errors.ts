import { ApiError } from './client.js'

/**
 * 接口失败的统一分类。各调用方按自己的场景给同一种情况配不同文案，
 * 例如余额不足在回答、上传、朗读里措辞不同，所以这里只归类，不生成文案。
 */
export type ApiErrorCondition =
  | 'unauthorized'
  | 'insufficientBalance'
  | 'tooLarge'
  /**
   * 上下文太长（#122）：413 或上游明说「超出上下文上限」。
   * 它和「参数错 / 服务端故障」不是一回事：重试解决不了，用户要么开新会话，要么删几条早期消息。
   */
  | 'contextLimit'
  | 'rateLimited'
  | 'serverBusy'
  | 'network'
  /** 流已开始但没收到 message_stop：连接中断，和「请求没发出去」要分开 */
  | 'interrupted'
  /**
   * 正文阶段连续一段时间没有新数据（#150）：连接没断，只是不动。
   * 和 interrupted（断了）分开归类，上层才能各自给文案与重试策略。
   */
  | 'idle'
  | 'other'

/**
 * 上游说「上下文太长」的原文特征：各家措辞不同，命中任意一条就归到 contextLimit。
 * 只用来认「确实超长」，不含泛泛的报错词，避免把无关 400 也引到「开新会话」那条路上。
 */
export const CONTEXT_LIMIT_PATTERNS: RegExp[] = [
  /context_length_exceeded/i,
  /maximum context length/i,
  /context window/i,
  /context length/i,
  /prompt is too long/i,
  /input is too long/i,
  /too many tokens/i,
  /exceeds? the (?:maximum )?(?:context|token)/i,
  /上下文(?:长度)?[^。]{0,10}超/,
  /超出[^。]{0,10}上下文/,
]

/** 这段文字是不是「上下文太长」（上游原文、日志、归档里的 message 都能喂进来） */
export const isContextLimitMessage = (text: string | undefined): boolean =>
  typeof text === 'string' && text.length > 0
    ? CONTEXT_LIMIT_PATTERNS.some((pattern) => pattern.test(text))
    : false

/** 按 HTTP 状态码归类；没有状态码（请求没到达服务端）时按网络问题处理 */
export const classifyStatus = (status: number | undefined): ApiErrorCondition => {
  if (status === 401) {
    return 'unauthorized'
  }
  if (status === 402) {
    return 'insufficientBalance'
  }
  if (status === 413) {
    return 'tooLarge'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  if ((status ?? 0) >= 500) {
    return 'serverBusy'
  }
  return 'other'
}

export const classifyApiError = (error: unknown): ApiErrorCondition => {
  if (!(error instanceof ApiError)) {
    return 'other'
  }
  // 断流优先：它可能带着底层报错（network error / aborted），不能并进网络问题
  if (error.kind === 'interrupted') {
    return 'interrupted'
  }
  // 空闲超时同理：它没有状态码，但语义明确，不能落到下面的 other 里
  if (error.kind === 'idle') {
    return 'idle'
  }
  // 413 本身就是请求体超限；上游用文字说「上下文太长」时状态码常是 400，也要认出来
  if (error.status === 413 || isContextLimitMessage([error.message, error.detail ?? ''].join('\n'))) {
    return 'contextLimit'
  }
  if (error.status === undefined) {
    return error.kind === 'network' ? 'network' : 'other'
  }
  return classifyStatus(error.status)
}

/**
 * 只对「重发有可能成功」的状态码退避重试（#303）：
 * - 429 限流：等一会儿确实可能有额度；
 * - 5xx：上游临时故障；
 * - 其余 4xx（400 / 401 / 403 / 404 / 413 …）一律不重试——参数、鉴权、路径类错误重发只会
 *   原样再失败一次，而它们在线上的形态就是日志被同一条请求刷屏（#303：`/v1/chat/completions/files`
 *   在两小时里打了 2059 次 404，占网关日志 86%）。
 */
export const isRetryableStatus = (status: number | undefined): boolean =>
  status === 429 || (status ?? 0) >= 500

/** 重试可能成功的情况：网络、超时、断流、限流、服务端繁忙；参数或鉴权类错误重试无用 */
export const isRetryableApiError = (error: unknown): boolean => {
  // 还没成型的错误（非 ApiError）按「未知故障」处理，与改造前一致
  if (!(error instanceof ApiError)) {
    return true
  }
  // 超时等价于「这一轮没等到响应」：重试是有效的，不能因为没状态码就归到 other
  // 空闲超时（#150）同理：换一条连接通常就好了，用户不必自己点重试
  if (error.kind === 'timeout' || error.kind === 'idle') {
    return true
  }
  // 有状态码就只按状态码判：4xx（429 除外）不重试，这条是硬规则，不再经过分类兜底
  if (typeof error.status === 'number') {
    return isRetryableStatus(error.status)
  }
  const condition = classifyApiError(error)
  return condition === 'network' || condition === 'interrupted'
}

/** 服务端判定附件失效的情况：本地有原件时重新上传即可自愈 */
export type FileErrorCode = 'fileIdMissing' | 'fileDataMissing' | 'invalidFileId'

/** 400 只带 message 文本，按文案前缀区分；顺序无关，互不重叠 */
const FILE_ERROR_PATTERNS: ReadonlyArray<readonly [FileErrorCode, RegExp]> = [
  ['fileIdMissing', /file_ids do not exist or are not created under your account/i],
  ['fileDataMissing', /file data not found for file_id/i],
  ['invalidFileId', /\.source\.file_id: invalid file_id/i],
]

/**
 * 只识别「附件 file_id 失效」这一类 400：服务端查不到文件、文件数据丢失、file_id 格式非法。
 * 其余错误（限流、余额、purpose 不合规等）不在这里处理，保持原有失败提示。
 */
export const getFileErrorCode = (error: unknown): FileErrorCode | null => {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return null
  }
  return FILE_ERROR_PATTERNS.find(([, pattern]) => pattern.test(error.message))?.[0] ?? null
}

/** 从报错文案里取出服务端 file_id，用于只重置真正失效的附件 */
export const extractFileIds = (message: string): string[] => [
  ...new Set(message.match(/file-api-[\w-]+/g) ?? []),
]

/** 上传失败里能识别出具体原因的情况；其余统一按「上传失败」处理 */
export type UploadErrorCode = 'fileCountLimit' | 'storageLimit' | 'parseFailed'

export type UploadErrorInfo = { code: UploadErrorCode; limit?: string }

/** 服务端无法解析文件内容：图片损坏或尺寸过大、格式不受支持、加密、文档解析失败 */
const PARSE_FAILED_PATTERNS = [
  /You have uploaded an (unsupported|invalid) (file|image)/i,
  /The image is too large to process/i,
  /password-protected/i,
  /Failed to recognize the file/i,
]

/**
 * 识别 Files API 上传的 400。配额类文案带上限数值，单个 Key 与账号合计（across all sub keys）共用同一提示。
 */
export const getUploadErrorInfo = (error: unknown): UploadErrorInfo | null => {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return null
  }
  const { message } = error
  const count = /User file count limit exceeded.*?limit (\d+)/i.exec(message)
  if (count) {
    return { code: 'fileCountLimit', limit: count[1] }
  }
  const storage = /User storage quota exceeded.*?limit ([\d.]+) GB/i.exec(message)
  if (storage) {
    return { code: 'storageLimit', limit: storage[1] }
  }
  if (PARSE_FAILED_PATTERNS.some((pattern) => pattern.test(message))) {
    return { code: 'parseFailed' }
  }
  return null
}

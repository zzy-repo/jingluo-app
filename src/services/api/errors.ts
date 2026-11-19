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

/**
 * 上游用**机器可读的 code / type** 表示「额度用完」的写法（#299）。
 *
 * 只有 402 一个状态码是不够的：真实网关更常见的是 400 / 429 / 403 配一个 code，
 * 例如 OpenAI 官方的 `insufficient_quota`、中转常见的 `insufficient_balance` /
 * `quota_exhausted`、`billing_hard_limit_reached`，中文服务直接写「余额不足」。
 * 这些响应不带 402，改前分别落到「请求过于频繁」（429 还会被退避重试）和
 * 「回答没有完成，出现了未知错误」，用户只会以为 App 坏了。
 *
 * 只收「明确就是额度」的写法：限流（rate_limit_exceeded）、鉴权、参数错误、
 * 文件/存储配额（User storage quota exceeded、file count limit）都不在此列。
 */
export const QUOTA_EXHAUSTED_PATTERNS: RegExp[] = [
  /insufficient[_\s-]?(?:quota|balance|credit|funds)/i,
  /quota[_\s-]?(?:exhausted|depleted)/i,
  /exceeded[_\s-]?your[_\s-]?current[_\s-]?quota/i,
  /billing[_\s-]?hard[_\s-]?limit[_\s-]?reached/i,
  /credit[\s_-]?balance[\s_]*(?:is[\s_]*)?too[\s_-]?low/i,
  /out[_\s-]?of[_\s-]?(?:credits|quota)/i,
  /余额不足|额度不足|积分不足|余额已用完|额度已用完/,
]

/** 这段文字是不是「额度用完」（上游 code / type / message 都能喂进来，#299） */
export const isQuotaExhaustedText = (text: string | undefined): boolean =>
  typeof text === 'string' && text.length > 0
    ? QUOTA_EXHAUSTED_PATTERNS.some((pattern) => pattern.test(text))
    : false

/**
 * 判定用的最小输入：请求层按 ApiError 判、界面按保存下来的 error 判，
 * 两边走**同一份**口径，避免「日志说额度不足、界面说网络异常」这种自相矛盾（#299）。
 */
export type ErrorSignature = {
  status?: number
  /** 上游响应体里的机器可读错误码（error.code / error.type / 顶层 code） */
  code?: string
  message?: string
}

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

/**
 * 统一判定（#299）：状态码 + 上游 code + 文案，三者任一能确定就算数。
 *
 * 判定顺序是有讲究的：
 * 1. 上下文超长先判：它也可能是 400/413，但用户能做的动作（开新会话 / 删早期消息）
 *    和额度不足（去充值）完全不同，错判会把人引到没用的路上（#122）；
 * 2. 额度用完再判：402 是标准写法，`insufficient_quota` 一类 code 是网关的常见写法，
 *    都必须在 429（限流）与 400（泛化业务错误）之前认出来——否则额度问题会被说成
 *    「请求过于频繁」并进入退避重试，或者干脆变成「未知错误」（#299）；
 * 3. 其余按状态码走原有的网络 / 业务分类，行为不变。
 */
export const classifyErrorSignature = ({
  status,
  code,
  message,
}: ErrorSignature): ApiErrorCondition => {
  if (status === 413 || isContextLimitMessage(message)) {
    return 'contextLimit'
  }
  if (status === 402 || isQuotaExhaustedText(code) || isQuotaExhaustedText(message)) {
    return 'insufficientBalance'
  }
  if (status === undefined) {
    return 'other'
  }
  return classifyStatus(status)
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
  const condition = classifyErrorSignature({
    status: error.status,
    code: error.upstreamCode,
    message: [error.message, error.detail ?? ''].join('\n'),
  })
  // 没有状态码（请求没到达服务端）：签名判不出东西时仍按 kind 分开网络与其他
  if (condition === 'other' && error.status === undefined) {
    return error.kind === 'network' ? 'network' : 'other'
  }
  return condition
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

/** 重试可能成功的情况：网络、超时、断流、限流、服务端繁忙；参数、鉴权、额度不足重试无用 */
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
  const condition = classifyApiError(error)
  // 额度/余额用完是终态（#299）：网关常用 429 / 400 表达额度不足，充值之前重发多少次
  // 都是同一个结果，必须一次就收尾——否则会撞上退避重试（#105），用户白等几轮才收到
  // 一句「请求过于频繁」。这一条必须排在「有状态码就按状态码判」之前。
  if (condition === 'insufficientBalance') {
    return false
  }
  // 有状态码就只按状态码判：4xx（429 除外）不重试，这条是硬规则，不再经过分类兜底
  if (typeof error.status === 'number') {
    return isRetryableStatus(error.status)
  }
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

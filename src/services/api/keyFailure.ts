/**
 * 「这把 API Key 为什么不行」的细分（#374）。
 *
 * 改前所有 401 都被压成一句「API Key 无效或已被删除」：Key 不存在、被服务端删除、
 * 被轮换后旧 Key 失效、粘贴时多了一个换行 —— 这些在用户那边要做的动作完全不同
 * （重新粘贴 / 重新绑定 / 用新 Key 覆盖 / 干脆是换错账号），界面上却是同一句话，
 * 用户和我们都判断不出该走哪条路。
 *
 * 这里只做**归类**，不生成文案（与本仓 api/errors.ts 的分工一致）：
 * 文案在 `chat/describe.ts` 里按 kind 选 i18n key，界面只认 kind + tail。
 *
 * 判定口径（能确定就确定，确定不了就说「没确定」，不猜）：
 *   1. 本地格式（`format`）：空、首尾/中间带空白、长度明显不像一把 Key —— 不用等上游，
 *      本地就能判，而且**最容易被误报成「无效」**（粘贴时多带了一个换行）。
 *   2. 上游 code / 文案里明说是「轮换 / 吊销 / 被替换」（`rotated`）：这是 #90 的 /rotate
 *      语义，旧 Key 立即失效、额度不丢。
 *   3. 上游 code / 文案里明说是「不存在 / 已删除 / 认不出」（`notFound`）。
 *   4. 剩下的一律 `rejected`：上游只说了「不行」，没说为什么 —— 这时候**不编原因**，
 *      文案里写清「上游没说清」并把 Key 尾号摆出来，让用户自己核对。
 *
 * 顺序不能反：`rotated` 必须排在 `notFound` 之前 —— 「旧 Key 已失效」这类原文里
 * 同时含有 invalid / not found 字样，先判 notFound 就会把「被轮换」说成「被删除」。
 */

/** Key 失败的四种原因；`rejected` = 上游拒绝了但没给出可细分的原因 */
export type KeyFailureKind = 'format' | 'notFound' | 'rotated' | 'rejected'

/** 结论是从哪儿来的：本地校验 / 上游机器可读 code / 上游原文 / 只有状态码 */
export type KeyFailureSource = 'local' | 'upstream-code' | 'upstream-text' | 'status'

export type KeyFailure = {
  kind: KeyFailureKind
  source: KeyFailureSource
  /** Key 尾 4 位（脱敏展示用）；拿不到 / 太短时为空串 —— 界面据此决定要不要显示 */
  tail: string
}

/** 尾号最多留几位；也用作「太短的 Key 一律不回显」的下限（防止把整把 Key 当尾号显示） */
const TAIL_DIGITS = 4
/** 一把正常 Key 至少这么长（DeepSeek 官方 ≈ 35+，中转也远长于这个数）；更短的不当 Key 看 */
const MIN_KEY_CHARS = 12

/**
 * Key 尾 4 位：**只回显尾部**，前后都不带前缀猜测（`sk-…a1b2` 的 `sk-` 由 i18n 文案决定）。
 * 太短（< 8 位）的 Key 一律返回空串：那种「Key」本身就不合法，回显等于把它整个贴出来。
 */
export const keyTail = (apiKey: string | undefined | null): string => {
  const value = (apiKey ?? '').trim()
  return value.length < MIN_KEY_CHARS ? '' : value.slice(-TAIL_DIGITS)
}

/**
 * 本地就能判死的格式问题：空 / 带空白（空格、换行、制表符）/ 长度不像一把 Key。
 *
 * 这三类在真实反馈里出现过（复制时多带换行、从聊天窗口粘到不可见字符），
 * 而且**上游也只会回 401** —— 与其让用户以为是 Key 被删了，不如说清「格式不对」。
 */
export const isKeyFormatInvalid = (apiKey: string | undefined | null): boolean => {
  const value = apiKey ?? ''
  if (!value.trim()) {
    return true
  }
  if (/\s/.test(value)) {
    return true
  }
  return value.length < MIN_KEY_CHARS || value.length > 512
}

/**
 * 「被轮换 / 被吊销 / 被替换」的写法。放在 notFound 之前判（见文件头的顺序说明）。
 * 收得窄：只认明确在说轮换/吊销/替换的词，不认泛泛的 invalid。
 */
const ROTATED_PATTERNS: RegExp[] = [
  /(?:api[_\s-]?)?key[\s_-]{0,3}(?:has[\s_-]{0,3}been[\s_-]{0,3})?(?:rotated|revoked|superseded|deactivated)/i,
  /(?:rotated|revoked|superseded)[\s_-]{0,3}(?:api[_\s-]?)?key/i,
  /(?:old|previous|legacy)[\s_-]{0,3}(?:api[\s_-]?)?key[\s_-]{0,3}(?:is[\s_-]{0,3})?(?:expired|invalid|disabled|no longer)/i,
  /replaced[\s_-]{0,3}by[\s_-]{0,3}a[\s_-]{0,3}new[\s_-]{0,3}(?:api[\s_-]?)?key/i,
  /密钥[^\n]{0,12}(?:已|被)?(?:轮换|吊销|作废|替换)/,
  /Key[^\n]{0,12}(?:已被|已经)(?:轮换|替换|吊销|停用)/,
]

/**
 * 「不存在 / 已被删除 / 上游认不出这把 Key」的写法。
 * `invalid_api_key` 放这一档：网关用它同时表达「没有这把 Key」和「Key 已删除」，
 * 分不开就不要硬分（文案里两种可能都写出来）。
 */
const NOT_FOUND_PATTERNS: RegExp[] = [
  /api[_\s-]?key[\s_-]{0,3}not[\s_-]{0,3}(?:found|exist)/i,
  /no[\s_-]{0,3}such[\s_-]{0,3}(?:api[\s_-]?)?key/i,
  /unknown[\s_-]{0,3}(?:api[\s_-]?)?key/i,
  /(?:api[\s_-]?key|key)[^\n]{0,24}(?:deleted|does[\s_-]{0,3}not[\s_-]{0,3}exist|not[\s_-]{0,3}recognized|has[\s_-]{0,3}been[\s_-]{0,3}deleted)/i,
  // 官方端点 401 的原文形状：`Authentication Fails, Your api key: ****2305 is invalid`
  // （主谓倒过来，所以单独的 `invalid api key` 认不出它）
  /(?:api[\s_-]?key|密钥)[^\n]{0,32}(?:is|was)[\s_-]{0,3}(?:invalid|not[\s_-]{0,3}valid)/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /incorrect[_\s-]?api[_\s-]?key/i,
  /密钥[^\n]{0,12}(?:不存在|已删除|无效)/,
]

const matches = (patterns: RegExp[], text?: string): boolean =>
  typeof text === 'string' && text.length > 0 ? patterns.some((pattern) => pattern.test(text)) : false

export type KeyFailureInput = {
  status?: number
  /** 上游响应体里的机器可读 code（error.code / error.type / 顶层 code） */
  code?: string
  /** 上游原文（含 detail） */
  message?: string
  /**
   * 当前本地 Key。**只有请求层知道**它，所以聊天失败时由 store 传进来并落盘；
   * 回看历史（导入的旧记录）时没有它 → 传 undefined，此时跳过本地格式判定
   * （否则「没有 Key 字符串」会被误判成 format）。
   */
  apiKey?: string
}

/**
 * 归类一条 Key 失效（#374）。
 * 入参允许缺项：只有 status（最常见的 401）也会给出 `rejected` + `source: 'status'`，
 * 界面照样能显示 Key 尾号与下一步，只是文案里会写清「上游没说具体原因」。
 */
export const classifyKeyFailure = (input: KeyFailureInput): KeyFailure => {
  const tail = keyTail(input.apiKey)
  // 本地能判的先判（只有真的拿到了 Key 字符串才判，见 apiKey 的注释）。
  // 格式错的这一档**不回显尾号**：那串东西本身不是一把 Key，报一个「尾号」只会让人
  // 以为它是有效身份，从而去核对错的对象。
  if (input.apiKey !== undefined && isKeyFormatInvalid(input.apiKey)) {
    return { kind: 'format', source: 'local', tail: '' }
  }
  if (matches(ROTATED_PATTERNS, input.code)) {
    return { kind: 'rotated', source: 'upstream-code', tail }
  }
  if (matches(NOT_FOUND_PATTERNS, input.code)) {
    return { kind: 'notFound', source: 'upstream-code', tail }
  }
  const text = [input.message, input.code].filter(Boolean).join('\n')
  if (matches(ROTATED_PATTERNS, text)) {
    return { kind: 'rotated', source: 'upstream-text', tail }
  }
  if (matches(NOT_FOUND_PATTERNS, text)) {
    return { kind: 'notFound', source: 'upstream-text', tail }
  }
  return { kind: 'rejected', source: 'status', tail }
}

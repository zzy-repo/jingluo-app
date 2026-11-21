import { shouldRetryStreamTimeout } from '../chat/timeoutPolicy.js'
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
  /**
   * 内容 / 安全审核拦截（#324）：上游判定这段内容不合规。
   * 原文重发一定还是被拦，所以**不可重试**，文案要让人改内容而不是点重新生成。
   * 与 unauthorized / insufficientBalance 一样是终态，不能并进 serverBusy（那是临时故障）。
   */
  | 'contentFilter'
  /**
   * 模型不存在 / 已下线（#324）：官方端点 400 + `The supported API model names are …`。
   * 用户唯一出路是换模型，重试同一个请求毫无意义 → **不可重试**。
   */
  | 'modelInvalid'
  /**
   * 其它被上游拒绝的请求（#324）：400 / 422 一类参数错误。
   * 以前这类会落到「未知错误」，用户既不知道是参数问题也不知道该不该重试。
   */
  | 'badRequest'
  /**
   * 其余「上游明确拒绝」的 4xx（#347）：403 权限 / 404 路径 / 405 方法 / 409 冲突 / 415 媒体类型。
   * 它们既不是参数问题（说「检查模型与接口配置」是误导），也不是临时故障（重发一样被拒），
   * 文案只说「上游拒绝了请求」并把上游原文放进折叠区。
   */
  | 'upstreamRejected'
  /**
   * 空响应 / 流里一个数据帧都没有（#324）：200 却给了非 SSE 的正文，或 SSE 头到了但零帧。
   * 上游这次什么也没说，换一条连接通常就好 → **可重试**。
   */
  | 'emptyStream'
  /**
   * 上游返回的是网页而不是数据（#434）：200 + `text/html`（网关首页 / 报错页），
   * 或请求层已经按 `upstream_returned_html` 判死的那种响应。
   *
   * 它和 emptyStream 是**两件事**：空响应是「上游这次什么都没说、换条连接就好」，
   * 网页则是「请求打到了一个不是接口的地方」，重发多少次都是同一份 HTML →
   * **不可重试**。改前它落进 emptyStream，`upstreamReturnedHtml` 这条文案永远走不到。
   */
  | 'upstreamReturnedHtml'
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
 * 上游用机器可读的 code / 文案表示「内容被安全审核拦截」（#324）。
 *
 * 实测（2026-11-19，官方端点）：正常内容不会触发；一旦触发，各家网关的写法是
 * `content_filter` / `content_policy_violation` / `safety_system` 或中文「内容不合规」。
 * 收得很窄：只认「明确在说内容/审核」的写法，`moderation` 这类泛词也要求与 policy / flag 同现，
 * 避免把一份正常报错里的普通英文词认成内容拦截（正是 #299 那类错判的反面）。
 */
export const CONTENT_FILTER_PATTERNS: RegExp[] = [
  /content[_\s-]?filter/i,
  /content[_\s-]?policy/i,
  /content[_\s-]?management[_\s-]?policy/i,
  /safety[_\s-]?(?:policy|violation|filter|system|triggered)/i,
  /(?:moderation|flagged)[\s_-]{0,3}(?:policy|violation|unfiltered|flagged)/i,
  /flagged as (?:harmful|unsafe|inappropriate)/i,
  /responsible[\s_-]?ai[\s_-]?policy/i,
  /违规内容|内容违规|内容不合规|内容安全|安全审核|审核未通过|敏感内容/,
]

/** 这段文字是不是「内容被审核拦截」 */
export const isContentFilterText = (text: string | undefined): boolean =>
  typeof text === 'string' && text.length > 0
    ? CONTENT_FILTER_PATTERNS.some((pattern) => pattern.test(text))
    : false

/**
 * 上游用机器可读的 code / 文案表示「模型不存在 / 已下线」（#324）。
 *
 * 实测官方端点（2026-11-19）：400 + `error.type = invalid_request_error` +
 * `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed no-such-model.`
 * ——注意它和「空 messages」「max_tokens 非法」用的是**同一个** `error.type`，
 * 所以只能靠 message 区分，不能靠 code。
 */
export const MODEL_INVALID_PATTERNS: RegExp[] = [
  /model[_\s-]?not[_\s-]?found/i,
  /model[_\s-]?not[_\s-]?exist/i,
  /the supported api model names are/i,
  /no such model/i,
  /unknown model/i,
  /invalid model/i,
  /model[\s\S]{0,40}?(?:is )?not (?:supported|available|found|valid)/i,
  // 「不支持」不放进来：它常常是「这个模型不支持图片/工具」这类能力差异，属于参数级拒绝，
  // 而且上游写了中文时我们本来就照原话展示（describeReply），不该被抢成「模型已下线」
  /模型[\s\S]{0,10}?(?:不存在|不可用|已下线|已被下线)/,
]

/** 这段文字是不是「模型不存在 / 已下线」 */
export const isModelInvalidText = (text: string | undefined): boolean =>
  typeof text === 'string' && text.length > 0
    ? MODEL_INVALID_PATTERNS.some((pattern) => pattern.test(text))
    : false

/**
 * 上游「可用模型列表」那句话（#339）。
 *
 * 官方端点原文：`The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed X.`
 * 列表在后半句之前结束，所以只截到行尾、再按逗号/and 切片段，遇到第一个「带空格的片段」
 * （= `but you passed X` 这类人话）就停：模型名本身不含空格，逗号与句点都可能出现在名字里
 * （`deepseek-v4.1-flash`），所以不能用「逗号或句点」直接把列表切掉。
 */
export const SUPPORTED_MODELS_PATTERN = /supported API model names are\s+([^\n]+)/i

/**
 * 从上游原文里取出可用模型名；取不到（脏文本 / 本地文案 / 上游没列）时返回空数组。
 * 返回值只用于**展示**（`replyModelInvalid` 文案），不参与任何白名单判定：
 * 上游的模型名单会变，客户端不做硬编码拦截。
 */
export const parseSupportedModels = (text?: string): string[] => {
  const listed = SUPPORTED_MODELS_PATTERN.exec(text ?? '')?.[1] ?? ''
  const names: string[] = []
  for (const piece of listed.split(/\s*,\s*|\s+and\s+/i)) {
    const name = piece.trim().replace(/^["'`]|["'`]$/g, '').replace(/\.$/, '')
    // 空片段 / 带空格的人话（`, but you passed X`）都到列表末尾了
    if (!name || /\s/.test(name)) {
      break
    }
    names.push(name)
  }
  return [...new Set(names)]
}

/**
 * 参数 / 字段不合法（#324 / #347）：400 / 422。
 * 它们重发只会原样再失败一次，所以单独归到 badRequest（不可重试），不再落到「未知错误」。
 * 401 / 402 / 403 / 413 有自己的档，不在此列。
 */
const PARAM_STATUSES: readonly number[] = [400, 422]

/**
 * 其余「上游明确拒绝」的 4xx（#347）：403 权限 / 404 路径 / 405 方法 / 409 冲突 / 415 媒体类型。
 *
 * 它们以前和 400 一起归到 badRequest，界面说「请检查模型与接口配置」——对一条
 * `POST /files` 打到不存在的路径（#303 里 404 刷屏的那类）来说完全是误导。现在单独一档，
 * 文案只说「上游拒绝了请求（HTTP 404）」，上游原文放进折叠区。
 * 429 / 413 / 401 / 402 各有自己的档；更冷门的 4xx（418 / 451 …）仍走未识别兜底
 * ——那一档同样会摆出状态码与上游短码，不会退回「未知错误」。
 */
const REJECTED_STATUSES: readonly number[] = [403, 404, 405, 409, 415]

/**
 * 上游用机器可读的 code 表示「请求参数 / 字段不合法」（#347）。
 *
 * 官方端点（2026-11-19 实测）：所有 400 / 422 的 `error.type` 都是 `invalid_request_error`；
 * 中转网关常见的写法是 `invalid_parameter` / `param_invalid` / `missing_required_parameter`。
 * **只看 code，不看 message**：英文正文里出现 “parameter” 太常见，按文案判会把别的失败
 * 认成参数错误（#299 那类错判的反面）。
 */
export const PARAM_INVALID_PATTERNS: RegExp[] = [
  /^invalid_request_error$/i,
  /invalid[_\s-]?param(?:eter)?/i,
  /param(?:eter)?s?[_\s-]?(?:invalid|missing|required|error)/i,
  /missing[_\s-]?(?:required[_\s-]?)?param(?:eter)?/i,
  /参数(?:错误|不合法|缺失|无效)/,
]

/** 这段文字是不是「参数 / 字段不合法」的机器可读写法 */
export const isParamInvalidText = (text: string | undefined): boolean =>
  typeof text === 'string' && text.length > 0 ? PARAM_INVALID_PATTERNS.some((p) => p.test(text)) : false

/**
 * 上游用机器可读的 code 表示「API Key 无效 / 过期」（#347）。
 *
 * 以前只认 401 状态码。但中转与自建网关常用的写法是 403 + `invalid_api_key` /
 * `authentication_error`（甚至 400），这类请求界面以前落到「未知错误」，
 * 用户看不出问题出在自己填的 Key 上 —— 本该点一下就换 Key，却只能去翻日志。
 * 同样只认 code，不收泛词（避免把「invalid_request_error」误认成 Key 问题）。
 */
export const API_KEY_INVALID_PATTERNS: RegExp[] = [
  /^authentication[_\s-]?error$/i,
  /invalid[_\s-]?api[_\s-]?key/i,
  /api[_\s-]?key[_\s-]?(?:is[_\s-]?)?(?:invalid|incorrect|expired|not[_\s-]?valid|missing)/i,
  // 「Key 不存在 / 已被删除」（#374）：网关会写成 `api_key_not_found` / `api_key_not_exist`。
  // 它和「无效」是同一件事的两面（那把 Key 现在确实没用了），出路也相同（换 Key），
  // 所以归进鉴权档；具体是哪一种由 keyFailure.ts 再细分文案。
  /api[_\s-]?key[_\s-]?(?:is[_\s-]?)?(?:not[\s_-]?(?:found|exist)|deleted|revoked|rotated)/i,
  /(?:invalid|incorrect|expired)[_\s-]?(?:api[_\s-]?)?key$/i,
  /key[_\s-]?(?:无效|不正确|已过期|已失效)/,
]

/** 这段文字是不是「Key 无效」的机器可读写法 */
export const isApiKeyInvalidText = (text: string | undefined): boolean =>
  typeof text === 'string' && text.length > 0
    ? API_KEY_INVALID_PATTERNS.some((pattern) => pattern.test(text))
    : false

/**
 * 上游消息里「是哪个字段不合法」的解析（#347 / #353）——**只用于展示**，不参与任何拦截判定。
 *
 * 真实样本（官方端点，2026-11-19）：
 *   `Invalid 'messages.0.content': latest_reminder must have at least 5 comma-separated fields, got 4.`
 *   `messages: at least one message is required`
 *   `Failed to deserialize the JSON body into the target type: max_tokens: invalid value: integer -1 …`
 *
 * 三种写法分别对应三条规则：引号里的字段 → 行首的 `字段:` → 已知请求字段里最早出现的一个。
 * 取不到（脏文本 / 上游只给了一句人话 / 中文原文）时返回空串，界面退回不带字段的文案。
 */
const QUOTED_FIELD_PATTERN = /['"`]([A-Za-z_][A-Za-z0-9_.]*(?:\[\d+\])*)['"`]/
const LEADING_FIELD_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*[:：]/
/** 报文里「带冒号的 token」太多（`Failed to deserialize …`），只按已知请求字段兜底匹配 */
const KNOWN_PARAM_FIELDS: readonly string[] = [
  'messages',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'response_format',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'thinking',
  'metadata',
  'system',
  'content',
  'role',
  'input',
  'input_schema',
  'anthropic_version',
  'file_ids',
]

/** 字段名长得像字段名才展示（防上游把一整句人话塞进引号里） */
const looksLikeField = (token: string): boolean =>
  token.length > 0 && token.length <= 64 && !/\s/.test(token)

/** 在原文里按给定句式找**最早出现**的已知请求字段（同上：只用于展示） */
const earliestField = (source: string, patternOf: (field: string) => RegExp): string => {
  let best = ''
  let bestAt = Number.POSITIVE_INFINITY
  for (const field of KNOWN_PARAM_FIELDS) {
    const at = source.search(patternOf(field))
    if (at >= 0 && at < bestAt) {
      best = field
      bestAt = at
    }
  }
  return best
}

/** 从上游原文里取出不合法的字段名；取不到返回空串 */
export const parseErrorField = (text?: string): string => {
  const source = typeof text === 'string' ? text : ''
  if (!source) {
    return ''
  }
  const quoted = QUOTED_FIELD_PATTERN.exec(source)?.[1] ?? ''
  if (looksLikeField(quoted)) {
    return quoted
  }
  const leading = LEADING_FIELD_PATTERN.exec(source)?.[1] ?? ''
  // 行首那段可能是 `Failed:` 这类人话前缀，只有含点（`messages.0`）时才当字段
  if (looksLikeField(leading) && leading.includes('.')) {
    return leading
  }
  // 字段后面直接跟冒号：`marks … max_tokens: invalid value`
  const colon = earliestField(source, (field) => new RegExp(`\\b${field}\\b\\s*[:=：]`))
  if (colon) {
    return colon
  }
  // 没有冒号的说法：`max_tokens must be a positive integer` / `temperature must be <= 2`。
  // 只认「字段 + 必须/非法」这种句式，不认单纯出现的词（`system error` 里的 system 不是字段）
  return earliestField(
    source,
    (field) =>
      new RegExp(
        `\\b${field}\\b\\s+(?:must|should|is|are|was|cannot|can[' ]?t|has|needs?|required|invalid)\\b`
      )
  )
}

/**
 * 判定用的最小输入：请求层按 ApiError 判、界面按保存下来的 error 判，
 * 两边走**同一份**口径，避免「日志说额度不足、界面说网络异常」这种自相矛盾（#299）。
 */
export type ErrorSignature = {
  status?: number
  /** 上游响应体里的机器可读错误码（error.code / error.type / 顶层 code） */
  code?: string
  message?: string
  /**
   * 响应头的 content-type（#434）。判定「上游给了个网页」只需要这一个字段：
   * `200 + text/html` 是网关首页 / 报错页的典型形态，和「空响应」不是一回事。
   * 流式接口正常时这里是 `text/event-stream`（= SSE），非流式接口是 `application/json`。
   */
  contentType?: string
}

/**
 * 请求层判死「上游返回网页」时写进 `ApiError.code` 的客户端错误码（#434）。
 * 分类层必须认得它，否则这条已经明确分类过的失败会被 2xx 兜底改写成「空响应」。
 */
export const UPSTREAM_HTML_CODE = 'upstream_returned_html'

/** `text/html` 与它的 XML 变体：网关首页 / 报错页最常见的两种写法 */
const HTML_CONTENT_TYPE_PATTERN = /(?:^|\/|;|\s)(?:text\/html|application\/xhtml\+xml)(?:;|\s|$)/i

/** 这个 content-type 是不是「网页」（#434）：看类型本身，不看参数（charset 之类） */
export const isHtmlContentType = (contentType?: string): boolean =>
  typeof contentType === 'string' && HTML_CONTENT_TYPE_PATTERN.test(contentType.toLowerCase())

/**
 * 「上游返回网页」只对 2xx / 3xx（以及没有状态码）生效（#434）。
 *
 * 为什么限定状态范围：401 + 网页、502 + 网页同样常见，但那种情况下**状态码本身更可操作**
 * ——401 该去换 Key、5xx 该重试，说成「返回的是网页」反而把出路说没了。
 * 只有「状态码说成功、正文却是网页」这一种才是纯粹的配置 / 网关地址问题，
 * 也正是 #434 里被误判成「空响应」的那条路。
 */
export const isHtmlLikeStatus = (status?: number): boolean =>
  status === undefined || (status >= 200 && status < 400)

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
 * 统一判定（#299 / #324 / #347）：状态码 + 上游 code + 文案，三者任一能确定就算数。
 *
 * 判定顺序是有讲究的：
 * 0. 上游返回网页（#434）先判：`200 + text/html` 与「空响应」在用户那边是两件事
 *    （前者 = 打到了网关 / 路径不对，后者 = 上游这次没说话），而 2xx 兜底那条规则会把它
 *    改写成 emptyStream，导致 `upstreamReturnedHtml` 永远不可达；
 * 1. 上下文超长先判：它也可能是 400/413，但用户能做的动作（开新会话 / 删早期消息）
 *    和额度不足（去充值）完全不同，错判会把人引到没用的路上（#122）；
 * 2. 额度用完再判：402 是标准写法，`insufficient_quota` 一类 code 是网关的常见写法，
 *    都必须在 429（限流）与 400（泛化业务错误）之前认出来——否则额度问题会被说成
 *    「请求过于频繁」并进入退避重试，或者干脆变成「未知错误」（#299）；
 * 3. 内容拦截 / 模型不存在只按**文案**判，且只在「没有状态码或 4xx」时看（#324）：
 *    官方端点这两类的 `error.type` 都是 `invalid_request_error`，code 分不开，只能看 message；
 *    限定状态范围是为了让 502 / 503 这类网关故障**永远不会**被认成内容拦截；
 * 4. Key 无效 / 参数不合法按**状态码或 code** 判（#347）：401 之外，网关还会用 403 / 400
 *    配 `invalid_api_key` / `authentication_error` / `invalid_parameter`，这两种都能让用户
 *    点一下入口就处理掉（换 Key / 打开设置），不该掉进泛化档；
 * 5. 2xx 却走到错误分类 = 上游给了「成功」的壳子却没有内容 → emptyStream（#324）；
 * 6. 400 / 422 归 badRequest（参数档），其余被拒绝的 4xx 归 upstreamRejected（#347），
 *    最后才按状态码走原有的网络 / 业务分类。
 */
export const classifyErrorSignature = ({
  status,
  code,
  message,
  contentType,
}: ErrorSignature): ApiErrorCondition => {
  // 上游返回的是网页而不是数据（#434）：请求层已判死（code）或 2xx + HTML content-type。
  // 必须排在 2xx → emptyStream 的兜底之前，否则「打到了网关 / 路径不对」会被说成「空响应」，
  // 并按可重试处理（同一份 HTML 重发几次都一样）。
  if (
    isHtmlLikeStatus(status) &&
    (code?.trim() === UPSTREAM_HTML_CODE || isHtmlContentType(contentType))
  ) {
    return 'upstreamReturnedHtml'
  }
  if (status === 413 || isContextLimitMessage(message)) {
    return 'contextLimit'
  }
  if (status === 402 || isQuotaExhaustedText(code) || isQuotaExhaustedText(message)) {
    return 'insufficientBalance'
  }
  // 文案类判定只在「可能来自上游拒绝」的状态范围内做：5xx / 2xx 不参与，
  // 免得上游随便一句英文把故障认成内容问题（#324 的负向口径）
  const textScoped = status === undefined || (status >= 400 && status < 500)
  if (textScoped) {
    if (isContentFilterText(code) || isContentFilterText(message)) {
      return 'contentFilter'
    }
    if (isModelInvalidText(code) || isModelInvalidText(message)) {
      return 'modelInvalid'
    }
    // Key 无效（#347）：401 是标准写法，网关也常用 403 / 400 + 这类 code
    if (status === 401 || isApiKeyInvalidText(code)) {
      return 'unauthorized'
    }
    // 参数 / 字段不合法（#347）：官方端点 400 / 422 的 code 恒为 invalid_request_error。
    // 状态码优先：404 + invalid_request_error（网关对不存在的路径也这么写）是路径问题，
    // 不该被说成「参数错误」，所以只在**没有状态码**的流内错误帧上按 code 认参数档。
    if (PARAM_STATUSES.includes(status ?? -1) || (status === undefined && isParamInvalidText(code))) {
      return 'badRequest'
    }
  }
  if (status === undefined) {
    return 'other'
  }
  // 2xx + 错误对象 = 没有内容的「空响应」（#324）：不是业务错误，重试通常就好
  if (status >= 200 && status < 300) {
    return 'emptyStream'
  }
  if (REJECTED_STATUSES.includes(status)) {
    return 'upstreamRejected'
  }
  return classifyStatus(status)
}

export const classifyApiError = (error: unknown): ApiErrorCondition => {
  if (!(error instanceof ApiError)) {
    return 'other'
  }
  // 空流（#324）先判：它借 interrupted 这个 kind 表达「流没收到东西」，
  // 但语义是「上游什么都没给」，要说得比「连接中断」更具体，也必须可重试
  if (error.code === 'stream_empty') {
    return 'emptyStream'
  }
  // 上游返回网页（#434）：请求层用这个客户端 code 判死，分类必须与之一致 ——
  // 否则 2xx 兜底会把它改写成「空响应」（可重试），`upstreamReturnedHtml` 文案不可达。
  // 非 2xx 的 HTML 报错页仍走状态码档（401 换 Key / 5xx 可重试），口径见 isHtmlLikeStatus。
  if (error.code === UPSTREAM_HTML_CODE && isHtmlLikeStatus(error.status)) {
    return 'upstreamReturnedHtml'
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
  /**
   * #568：三段超时先查重试矩阵（`chat/timeoutPolicy.ts`），**不在两处各写一遍口径**。
   * 这里回答的是「原则上可重试吗」，即假设还没向用户输出任何内容；
   * 「已经出过字就不许重发」那条判据需要 `receivedContent`，由发起重试的
   * `store.ts decideStreamRetry` 用同一个函数带进去。
   */
  const stagedTimeout = shouldRetryStreamTimeout(error.code, false)
  if (stagedTimeout !== null) {
    return stagedTimeout
  }
  // 其它超时等价于「这一轮没等到响应」：重试是有效的，不能因为没状态码就归到 other。
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
  // 内容拦截 / 模型不存在 / 参数错误（#324）/ 其余被拒 4xx（#347）：都是「同一条请求再发一次
  // 也是同样结果」，自动重试只会让用户多等几轮再看到同一句话。文案里也明说「不要重试」。
  if (
    condition === 'contentFilter' ||
    condition === 'modelInvalid' ||
    condition === 'badRequest' ||
    condition === 'upstreamRejected'
  ) {
    return false
  }
  // 空响应（#324）：上游这次什么都没有给，换条连接通常就好 —— 可重试
  if (condition === 'emptyStream') {
    return true
  }
  // 上游返回网页（#434）：请求打到了网关 / 路径不对，重发多少次都是同一份 HTML —— 不重试。
  // 改前它落进 emptyStream，于是每次失败都白重试 3 次（#434 的失败日志里就是 3 个 POST）。
  if (condition === 'upstreamReturnedHtml') {
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

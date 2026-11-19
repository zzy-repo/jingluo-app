/**
 * 回答失败时「复制诊断信息」的文本（#324）：**纯函数**，可以直接单测。
 *
 * 为什么必须有它：改前未识别的失败只给一句「回答没有完成，出现了未知错误」，
 * 用户把这句话贴进反馈，我们连「上游到底回了什么」都判断不出来（#324 原文）。
 * 这里只把**上游自己给的、能自证的信息**摆出来：HTTP 状态码、上游 code、失败发生在
 * 流里还是请求阶段、上游原文（截断）。用户点「复制诊断信息」拿到的就是这段。
 *
 * 复用 #104 已经落地的能力，不另造一套：
 * - 文本生成走 `buildErrorReport` 的同一条口径（固定字段顺序，便于人工比对与单测断言）；
 * - 最后一道关口 `scrubReportText` 原样复用：密钥 / 签名 / 完整 URL 全部抹掉。
 *
 * **绝不**包含聊天正文与 API Key：这份文本会被用户直接贴进 Issue。
 * （服务层的日志（diagnostics）另有更细的结构化字段，见 store.ts 的失败记录。）
 */
import { scrubReportText } from '../../app/errorReport.js'
import { truncate } from '../diagnostics/redact.js'

/** 单行最长字符数：与 #104 的 errorReport 同一量级，够看清又不刷屏 */
const MAX_LINE_CHARS = 240

/**
 * 上游给的 `request_id`（#347 的关闭条件点名要它）：这是把用户报错对上服务端日志的**唯一钥匙**，
 * 各家写法不同 —— OpenAI 风格 `"request_id": "req_xxx"`、网关日志风格 `request-id=xxx`、
 * 也有塞在原文句尾的 `(request id: xxx)`。捞不到就不写这一行，不编造。
 */
const REQUEST_ID_PATTERN =
  /(?:request[_\s-]?id|req[_\s-]?id)["'\s:=]*([A-Za-z0-9][A-Za-z0-9._-]{3,})/i

/** 从上游原文里捞 request_id；捞不到返回空串 */
export const parseUpstreamRequestId = (text?: string): string =>
  REQUEST_ID_PATTERN.exec(text ?? '')?.[1] ?? ''

export type ReplyErrorReportInput = {
  /** HTTP 状态码；请求没到达服务端 / 流内错误帧时为 undefined */
  status?: number
  /** 上游响应体里的机器可读错误码（error.code / error.type） */
  upstreamCode?: string
  /** 失败环节：ApiErrorKind（stream / interrupted / idle / http / protocol / network / timeout） */
  kind: string
  /** 上游原文（只进这段诊断，不上界面主文案） */
  message?: string
  /** 出错时间（ms），默认取当前时刻 */
  at?: number
}

/**
 * 上游是否已经开始响应流：true = 断在流里（有 SSE 帧交互后才失败），
 * false = 连响应都没开始就失败了。这是排查时第一个要分清的事：
 * 「流里出问题」和「请求没发出去」的处置完全不同。
 */
export const isStreamingFailure = (kind: string): boolean =>
  kind === 'stream' || kind === 'interrupted' || kind === 'idle'

/**
 * 生成「复制诊断信息」的文本。字段顺序固定，便于人工比对与单测断言。
 */
export const buildReplyErrorReport = (input: ReplyErrorReportInput): string => {
  const at = input.at ?? Date.now()
  const status =
    typeof input.status === 'number' && Number.isFinite(input.status)
      ? String(Math.round(input.status))
      : 'unknown'
  const code = input.upstreamCode?.trim() || 'unknown'
  const detail = input.message?.trim()
  const requestId = parseUpstreamRequestId(detail)
  const lines = [
    'DeepSeek 回答失败诊断',
    `时间: ${new Date(at).toISOString()}`,
    `环节: ${input.kind}（${isStreamingFailure(input.kind) ? '响应流内' : '流开始前'}）`,
    `HTTP 状态: ${status}`,
    `上游 code: ${code}`,
  ]
  // 上游给了 request_id 就单列一行（#347）：对服务端日志时不用再让用户手工截取
  if (requestId) {
    lines.push(`上游 request_id: ${requestId}`)
  }
  if (detail) {
    lines.push(`上游原文: ${truncate(detail, MAX_LINE_CHARS)}`)
  }
  return scrubReportText(lines.join('\n'))
}

/** 折叠区里最多多少字符：够看清「是哪一项不匹配」，又不至于把整段英文糊满屏幕 */
const MAX_SNIPPET_CHARS = 200

/**
 * 折叠区「上游原文」的文本（#347 / #353）。
 *
 * 与主文案的分工：
 * - 主文案只在**上游写了中文**时照抄原话（#324 的 `isReadableForUser` 口径），
 *   英文一律不直接丢给用户；
 * - 但「看不到上游到底说了什么」本身就是 #347 的问题，所以英文原文放进**折叠区**：
 *   用户主动展开才看到（默认收起，不糊屏），字段名 / 约束说明 / `request_id` 都在里面，
 *   反馈群里能直接照着判断是模型名不被支持还是渠道不兼容 OpenAI 协议格式。
 *
 * 与「复制诊断信息」同一份脱敏口径（`scrubReportText`）：Key / 卡密 / 手机号 / 设备码
 * 在折叠区里也必须打码 —— 折叠内容随时会被截图发出去。
 * 没有原文（断流 / 空响应）时返回 undefined：折叠区不占版面。
 */
export const buildUpstreamSnippet = (
  input: Pick<ReplyErrorReportInput, 'status' | 'upstreamCode' | 'message'>
): string | undefined => {
  // 空白折叠成单空格：上游有的响应把整段报错塞进一行带换行的 JSON 里
  const detail = input.message?.replace(/\s+/g, ' ').trim() ?? ''
  if (!detail) {
    return undefined
  }
  const head = [
    typeof input.status === 'number' && Number.isFinite(input.status)
      ? `HTTP ${Math.round(input.status)}`
      : '',
    input.upstreamCode?.trim() ? `code=${input.upstreamCode.trim()}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const body = truncate(detail, MAX_SNIPPET_CHARS)
  return scrubReportText(head ? `${head}\n${body}` : body)
}

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
  const lines = [
    'DeepSeek 回答失败诊断',
    `时间: ${new Date(at).toISOString()}`,
    `环节: ${input.kind}（${isStreamingFailure(input.kind) ? '响应流内' : '流开始前'}）`,
    `HTTP 状态: ${status}`,
    `上游 code: ${code}`,
  ]
  if (detail) {
    lines.push(`上游原文: ${truncate(detail, MAX_LINE_CHARS)}`)
  }
  return scrubReportText(lines.join('\n'))
}

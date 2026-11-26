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
import { redactUpstreamText, truncate } from '../diagnostics/redact.js'
import type { NetTimings } from '../net/networkPhase.js'

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
  /**
   * 当前渠道（#353 第 2 点）：**同一个模型名在不同渠道的支持列表不一样**，
   * 「模型名不被支持」这件事只有把渠道一起贴出来才判得清。传 `label（kind）` 形态。
   */
  provider?: string
  /**
   * 本次请求实际发出的模型名（#353 第 2 点）。
   *
   * 与「用户以为的模型」可能不是同一个：内置渠道的残留值、导入的历史回复都见过这种情况，
   * 所以这里记的是**请求里那个字符串**，不是设置页显示的那个。
   */
  model?: string
  /** 接口地址（#353 第 2 点）；完整 URL 由 `scrubReportText` 收敛成「协议//host/***」 */
  endpoint?: string
  /**
   * 触发这次失败的**参数快照**（超时的 `{seconds}`、文件上限的 `{size}/{limit}`、
   * 支持的 `{formats}` 等）。
   *
   * 为什么要塞进诊断：2026-11-24 文案定稿后界面走「软文案」，句子不再引用这些占位符，
   * 用户看到的是「敲了好久的门都没人开」。这些数字对**排查**仍然关键（超时几秒？上限多大？），
   * 所以从界面上撤下来，但要在诊断里留一份——界面软、排查硬。
   */
  params?: Record<string, unknown>
  /**
   * **分段归因**（#895 / 母单 #894）：卡在哪一段、凭什么判出来、建议下一步。
   *
   * 为什么必须进这份文本：用户把「连不上」贴进 Issue 时，我们以前无法区分
   * 「他没网」「域名解析不了」「证书不对」「上游接了但不吐字」——四种情况的修法完全不同，
   * 而这四个结论**只有失败当次**能拿到（事后重放不复现）。
   */
  phase?: string
  /** 判据（`NetPhaseEvidence`）：诊断里写出来，读的人才知道这个结论有多硬 */
  evidence?: string
  /** 建议的下一步（`NetUserAction`）；`none` / 缺省不写这一句 */
  userAction?: string
  /** 各段耗时（毫秒）；取不到的段在文本里写「—」，不写 0 */
  timings?: NetTimings
  /**
   * 失败后那次「只判路」探测的结论摘要（#899）：`outcome` / 花掉多少毫秒 / 是否与原始证据冲突。
   *
   * 为什么要单独一行而不是塞进「失败分段」：这两件事说的不是一回事 ——
   * 「失败分段」是**这次失败的结论**（**可能判不出**），「探测」是**我们为了能判出来额外做的一件事**。
   * 混成一句，读的人就分不清「判不出（平台限制）」和「探测后判定为 tls」的区别（#899 必做 3）。
   */
  probe?: { outcome?: string; elapsedMs?: number; conflict?: boolean }
  /** 出错时间（ms），默认取当前时刻 */
  at?: number
}

/**
 * 探测**真的拿到了分段证据**时，那句话怎么说（#899）。
 * 只有这三个 phase 会走这里：探测只允许细分 dns / tcp / tls，其余一律回来仍是「判不出」。
 */
const PROBE_SEGMENT_COPY: Record<string, string> = {
  dns: '名字没解开',
  tcp: '名字解开了、连接没建起来',
  tls: '连上了、TLS 握手没过',
}

/**
 * 「探测」那一行的文本（#899 必做 3）。
 *
 * 四种「没有结论」的理由必须写成四句不同的话 —— 尤其是
 * **「平台限制拿不到证据」**与**「探测也超时」**：前者是我们没能力，后者是那一枪没打准，
 * 下一轮排查该做的事完全不同（换宿主的桥 / 换个时间段复现）。
 */
const probeReportLine = (input: ReplyErrorReportInput): string | undefined => {
  const probe = input.probe
  if (probe === undefined || typeof probe.outcome !== 'string' || probe.outcome === '') {
    return undefined
  }
  const elapsed =
    typeof probe.elapsedMs === 'number' && Number.isFinite(probe.elapsedMs)
      ? `（${Math.round(probe.elapsedMs)}ms）`
      : ''
  const segment = input.evidence === 'probe' ? PROBE_SEGMENT_COPY[input.phase ?? ''] : undefined
  const conflict = probe.conflict === true ? '；与原始证据不一致，以原始证据为准' : ''
  if (segment !== undefined) {
    return (
      `探测: 失败，但分段证据显示「${segment}」${elapsed} → 据此判定为 ${input.phase}` +
      '（分段耗时里的 dns / tcp / tls 三段取自这一枪）'
    )
  }
  if (probe.outcome === 'reached') {
    return `探测: 已通${elapsed} → 刚才那一下是瞬时抖动，不是某一段坏了`
  }
  if (probe.outcome === 'timeout') {
    return `探测: 也超时${elapsed} → 判不出（不猜某一段）`
  }
  if (probe.outcome === 'unsupported') {
    return '探测: 本环境不支持（没有 fetch / 地址不是绝对 URL）→ 判不出'
  }
  return `探测: 失败，但平台限制拿不到分段证据（失败请求的 resource timing 全为 0）${elapsed} → 判不出${conflict}`
}

/**
 * 分段耗时的**一行文本**（#895）。取不到的段写「—」，**绝不写 0** ——
 * 0 的意思是「这一段没花时间」，与「拿不到这个数」是两件事；写 0 会让读诊断的人
 * 误判成「DNS 是瞬间完成的」。字段顺序固定，便于人工比对与单测断言。
 */
const timingsReportLine = (timings?: NetTimings): string | undefined => {
  if (timings === undefined) {
    return undefined
  }
  const ms = (value: number | null | undefined): string =>
    typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : '—'
  const parts = [
    `dns=${ms(timings.dnsMs)}`,
    `tcp=${ms(timings.tcpMs)}`,
    `tls=${ms(timings.tlsMs)}`,
    `等待响应头=${ms(timings.waitMs)}`,
    `首字节=${ms(timings.firstByteMs)}`,
    `合计=${ms(timings.totalMs)}`,
  ]
  return `分段耗时: ${parts.join(' ')}`
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
  /**
   * 可执行的核对项（#353 第 2 点）：渠道 / 模型 / 接口。
   *
   * 以前这段诊断只有「上游回了什么」，没有「我们发的是什么」—— 反馈群里看到 400 原文
   * 之后还得反问用户「你用的是哪个渠道、模型填的什么」。这三行把它们补齐，
   * 三者的值一律来自**当次请求的真实配置**，不做二次概括。
   */
  const provider = input.provider?.trim()
  const model = input.model?.trim()
  const endpoint = input.endpoint?.trim()
  if (provider) {
    lines.push(`渠道: ${provider}`)
  }
  if (model) {
    lines.push(`模型: ${model}`)
  }
  if (endpoint) {
    lines.push(`接口: ${endpoint}`)
  }
  /**
   * 分段归因（#895）：**判不出也要写「判不出」**。
   *
   * 只在请求层给了 `phase` / `evidence` 时才写这两行 —— 业务失败（401 / 额度 / 参数）
   * 没有「网络卡在哪」这回事，硬写一行「失败分段: —」只会让诊断变成噪音。
   */
  const phase = input.phase?.trim()
  const evidence = input.evidence?.trim()
  if (phase !== undefined || evidence !== undefined) {
    const action = input.userAction?.trim()
    const suffix = action !== undefined && action !== '' && action !== 'none' ? `；建议 ${action}` : ''
    const judge = evidence !== undefined && evidence !== '' ? `依据 ${evidence}` : '依据 none'
    lines.push(`失败分段: ${phase !== undefined && phase !== '' ? phase : '判不出'}（${judge}${suffix}）`)
  }
  const timingsLine = timingsReportLine(input.timings)
  if (timingsLine !== undefined) {
    lines.push(timingsLine)
  }
  /**
   * 探测那一行（#899）：**只有真探测过才写**。没探测（业务失败 / 老记录 / 非请求层失败）
   * 就不占版面 —— 诊断里多一行「没做的事」只会让读的人以为我们试过。
   */
  const probeLine = probeReportLine(input)
  if (probeLine !== undefined) {
    lines.push(probeLine)
  }
  // 参数快照：只列「有值的原始标量」，不猜语义、不做单位换算（换算留给读的人）
  const paramLine = Object.entries(input.params ?? {})
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([key, value]) => `${key}=${String(value)}`)
    .filter((pair) => !pair.endsWith('='))
    .sort()
    .join(', ')
  if (paramLine) {
    lines.push(`参数: ${paramLine}`)
  }
  if (detail) {
    /**
     * #490：「上游原文」必须是**先脱敏、后截断**。
     * 以前是 `truncate(detail, 240)` 再靠最后那道 `scrubReportText` —— 一把跨过 240 边界的 Key
     * 会先被截成半截，半截既不再是密钥形状（规则认不出来），又还是可用的凭证片段。
     * 这里不换呈现（仍是 `sk-***`，与 #104 的断言一致），只把顺序摆正。
     */
    lines.push(`上游原文: ${truncate(scrubReportText(detail), MAX_LINE_CHARS)}`)
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
  /**
   * 折叠区这段「上游原文」走 #490 的独立工具（`redactUpstreamText`）：
   * 压成一行 → 脱敏（Key **留尾 6 位**，用户要能认出是哪一把被上游拒了）→ 截断。
   * 顺序写死在工具里，调用方不再各排一遍（以前这里同样是先截断再脱敏）。
   */
  const body = truncate(redactUpstreamText(detail), MAX_SNIPPET_CHARS)
  return scrubReportText(head ? `${head}\n${body}` : body)
}

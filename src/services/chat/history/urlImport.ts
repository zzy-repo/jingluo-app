import { Capacitor, CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { errorMeta, record, recordAction, recordEvent, redactUrl } from '../../diagnostics/collector.js'
import { importHistory } from '../backup.js'
import { BackupError, fail } from './errors.js'
import { classifyImportFailure, isBrowserOnline } from './importFailure.js'
import { maxImportMegabytes, resolveMaxImportBytes, DEFAULT_MAX_IMPORT_BYTES } from './importLimit.js'

/**
 * 直链导入：用原生 HTTP 下载 ZIP 后交给既有的文件导入链路（importHistory）。
 *
 * 为什么只能在原生（APK）里做：DeepSeek 导出的 ZIP 放在官方 OBS 桶上，桶没有开 CORS
 * （预检 OPTIONS 返回 403、响应无 Access-Control-Allow-Origin），浏览器 fetch 必被拦。
 * CapacitorHttp 走的是原生网络栈（Android 的 HttpURLConnection），不受 CORS 限制。
 *
 * 为什么分段下载：CapacitorHttp 是一次性调用，**没有进度事件**——整包 20MB 在网络差时
 * 界面只能转圈（实测弱网 35s、断流 183s 后才知道失败）。这里改成带 Range 的分块 GET：
 * 每块到手就知道「已下载多少字节」，块超时只有 20s（断网最多等一块），块与块之间检查取消。
 */

/**
 * 单个导出包的大小上限：**就是 importLimit 里那一个数字**（默认 200MB）。
 * 这里只做转出，别的地方不要再抄一遍 200MB——本地文件导入用的是同一个上限（issue #34）。
 */
export const MAX_ARCHIVE_BYTES = DEFAULT_MAX_IMPORT_BYTES

/** 交给 importHistory 的文件名，只用于提示与暂存，不写盘。 */
const ARCHIVE_NAME = 'deepseek_data.zip'

/** ZIP 本地文件头 PK\x03\x04，与 zipReader.isZipFile 保持一致。 */
const ZIP_MAGIC = [0x50, 0x4b, 3, 4]

/**
 * 首块大小：慢网（模拟器 gsm 14.4kbps）下也要几秒内就出第一条「已下载 xx KB」，
 * 之后按实测速率自适应放大，快网 20MB 只发 6~10 个请求，几乎不增加开销。
 */
const FIRST_CHUNK_BYTES = 4 * 1024
const MIN_CHUNK_BYTES = 4 * 1024
const MAX_CHUNK_BYTES = 4 * 1024 * 1024

/** 每块的目标耗时：按速率换算块大小，让进度大约每秒刷新一次。 */
const CHUNK_TARGET_MS = 1200

/** 单块失败重试次数：弱网（实测模拟器 gsm 14.4kbps）会在块中途丢流，重试同一起点即可续上。 */
const CHUNK_RETRIES = 1

/** 连接超时；读超时按块，断网/丢包最多等一块就报错，而不是等到 183 秒。 */
const CONNECT_TIMEOUT_MS = 10_000
const CHUNK_READ_TIMEOUT_MS = 12_000

/**
 * 停滞判定窗口：**唯一**的失败判定依据——连续这么久「没有任何新字节」才判 stalled。
 *
 * 为什么按「无进度」而不是「总墙钟」判：上一版用的是 120s 绝对总预算，结果 164.5MB 的
 * **合法**导出包在约 0.5MB/s 的真实网络下必然超时（#38：三次分别在 47.4/54.3/65.4MB 处被误杀），
 * 而字节其实一直在增长。慢但在推进的链路只能续期，不能判死；真正挂死（CapacitorHttp
 * 原生 Promise 永久 pending、对端不再吐数据）的共同特征是「字节停住」，那才是要判的东西。
 */
const DOWNLOAD_STALL_MS = 40_000

/**
 * 防御性总上限：只防「一直在爬但永远下不完」的病态链路，不参与日常判定。
 * 30 分钟对 200MB 上限的包意味着 ≥110KB/s 就能下完；164.5MB 实测约 5 分钟，余量充足。
 */
const DOWNLOAD_MAX_TOTAL_MS = 30 * 60_000

/**
 * 周期性心跳间隔：每 5s 一条「这一段新增了多少字节 + 已经多久没有新字节」，
 * 日志里能直接区分「在推进」和「停滞」，也是原生请求挂住时唯一的在线证据。
 */
const HEARTBEAT_INTERVAL_MS = 5_000

/** 403 响应体里带 OBS 错误码；只解前面一小段足够判定。 */
const ERROR_BODY_CHARS = 4096

/** 取消后丢弃结果：CapacitorHttp 不支持 abort，取消保证「不再发新块、不再写入任何数据」。 */
export class UrlImportCancelled extends Error {
  constructor() {
    super('URL import cancelled')
    this.name = 'UrlImportCancelled'
  }
}

/** 停滞终态：连续 stallMs 没有收到任何新字节（可续传重试）。 */
class DownloadStalled extends Error {
  constructor() {
    super('download stalled')
    this.name = 'DownloadStalled'
  }
}

/** 防御性总上限耗尽：字节还在推进，但总时长超过 DOWNLOAD_MAX_TOTAL_MS。 */
class DownloadDeadlineExceeded extends Error {
  constructor() {
    super('download deadline exceeded')
    this.name = 'DownloadDeadlineExceeded'
  }
}

/** 分阶段进度：下载（字节）→ 解析（ZIP/清单）→ 导入（会话条数）。 */
export type UrlImportProgress =
  | { phase: 'downloading'; downloadedBytes: number; totalBytes?: number }
  | { phase: 'decoding' }
  | { phase: 'importing'; processed: number; totalSessions?: number }

/**
 * 用户可见的「导入详情」条目：和 diagnostics 的 record() 在同一处产生（单一事实源），
 * 不给 UI 另开一条日志管道，也不从 console 抓。at 是相对本次导入开始的毫秒数。
 * 注意：这里永远不含完整导出链接与会话正文，只带脱敏后的路径片段。
 */
export type ImportTraceKind =
  | 'start'
  | 'download'
  /** 周期心跳：这一段没有任何新字节时的「还活着」标记（下载停滞的唯一在线证据） */
  | 'heartbeat'
  /** 续传：上一轮失败后从已下载字节继续（不清零） */
  | 'resume'
  /** 服务端忽略 Range（回 200 整包）：已丢弃本地字节、从头重新下载 */
  | 'restart'
  | 'check'
  | 'session'
  | 'image'
  | 'done'
  | 'cancel'
  | 'error'

export type ImportTraceEntry = {
  at: number
  kind: ImportTraceKind
  /** 真实已下载字节；totalBytes 可能缺失（服务端没给 Content-Length/CONTENT-RANGE） */
  bytes?: number
  totalBytes?: number
  /** 距上一次「字节增长」过去了多久（心跳/停滞条目用，毫秒） */
  idleMs?: number
  sessions?: number
  totalSessions?: number
  images?: number
  /** HTTP 状态（失败时） */
  status?: number
  /** 一句人话的原因（已脱敏、已截断） */
  message?: string
}

export type UrlImportOptions = {
  signal?: AbortSignal
  onProgress?: (progress: UrlImportProgress) => void
  /** 导入详情回调：节流与条数上限由 UI 负责，这里只按事实发生点上报。 */
  onTrace?: (entry: ImportTraceEntry) => void
  /**
   * 停滞判定窗口（毫秒）：连续这么久没有新字节才判 stalled。
   * 默认 DOWNLOAD_STALL_MS（40s），UI 不传，只在诊断/测试里调小。
   */
  downloadStallMs?: number
  /** 防御性总上限（毫秒）；默认 DOWNLOAD_MAX_TOTAL_MS（30 分钟），同样只给诊断/测试用。 */
  downloadMaxTotalMs?: number
  /** 心跳周期（毫秒）；默认 HEARTBEAT_INTERVAL_MS，同样只给诊断/测试用。 */
  heartbeatIntervalMs?: number
  /** 大小上限（字节）；默认 DEFAULT_MAX_IMPORT_BYTES，与本地文件导入同一个数字。UI 不传。 */
  maxBytes?: number
}

/** 原生（APK）才具备绕过 CORS 的原生 HTTP；网页版不提供该能力。 */
export const canImportFromUrl = (): boolean => Capacitor.isNativePlatform()

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new UrlImportCancelled()
  }
}

/** 响应头大小写不固定（Android 侧原样返回服务端头），按小写名字取。 */
const headerValue = (
  headers: Record<string, string> | undefined,
  name: string
): string | undefined => {
  if (!headers) {
    return undefined
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name)
  return key === undefined ? undefined : String(headers[key])
}

/** 响应头里的 Content-Length；拿不到（chunked / 被网关去掉）时返回 undefined。 */
const contentLength = (headers: Record<string, string> | undefined): number | undefined => {
  const raw = headerValue(headers, 'content-length')
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** `Content-Range: bytes 0-16383/21195845` 里的总大小；分段响应的权威来源。 */
const contentRangeTotal = (headers: Record<string, string> | undefined): number | undefined => {
  const raw = headerValue(headers, 'content-range')
  const match = raw === undefined ? null : /\/(\d+)\s*$/.exec(raw)
  if (!match) {
    return undefined
  }
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

const tooLarge = (limitBytes: number): never =>
  fail('historyImportUrlTooLarge', { size: maxImportMegabytes(limitBytes) })

/**
 * 403 的错误页文本。
 * 实测（Android CapacitorHttp，arraybuffer 模式）非 2xx 时 data 可能为空，
 * 拿不到 OBS 的 <Code> 就分不出「链接过期」和「签名错误」——这时补发一个小 Range 的 text 请求读错误页。
 */
const fetchErrorBodyText = async (url: string): Promise<string> => {
  try {
    const response = await CapacitorHttp.get({
      url,
      responseType: 'text',
      connectTimeout: CONNECT_TIMEOUT_MS,
      readTimeout: CHUNK_READ_TIMEOUT_MS,
      headers: { Accept: 'application/xml,text/xml,*/*', Range: 'bytes=0-2047' },
    })
    const data = response.data
    return typeof data === 'string' ? data.slice(0, ERROR_BODY_CHARS) : ''
  } catch {
    return ''
  }
}

/** 每批解码的 base64 字符数：约 3MB 输出，避免一次性生成几十 MB 的二进制字符串。 */
const DECODE_CHUNK_CHARS = 4 * 1024 * 1024

/**
 * base64 → 字节。实测（Android CapacitorHttp，见 tests/test.url-import-device.spec.mjs）
 * arraybuffer 的 data 是 base64 字符串，Web 实现的 CapacitorHttp 也一样。
 *
 * 分块解码：20MB 的包 base64 后约 28MB，一次性 atob 会再生成一个 ~21MB 的二进制字符串，
 * 低内存手机上容易把 WebView 渲染进程挤爆（模拟器上实测会崩），所以按块解码并只保留结果字节。
 */
const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  // 输出长度上限按 3/4 估（比实际略大，最后按写入量截断）；Android 的 Base64.DEFAULT 每 76 字符插 \n。
  const bytes = new Uint8Array(Math.floor((value.length * 3) / 4) + 3)
  let written = 0
  let carry = ''
  for (let start = 0; start < value.length; start += DECODE_CHUNK_CHARS) {
    const chunk = (carry + value.slice(start, start + DECODE_CHUNK_CHARS)).replace(/\s/g, '')
    // 只解码完整的 4 字符组，剩下的留给下一批，避免 atob 报错。
    const usable = chunk.length - (chunk.length % 4)
    carry = chunk.slice(usable)
    if (usable === 0) {
      continue
    }
    const binary = atob(chunk.slice(0, usable))
    for (let index = 0; index < binary.length; index += 1) {
      bytes[written + index] = binary.charCodeAt(index)
    }
    written += binary.length
  }
  // 用 subarray 而不是 slice：多出的几十 KB 空闲字节不值得再复制一份 20MB 数据。
  return written === bytes.length ? bytes : bytes.subarray(0, written)
}

/** 统一 data → 字节，并在解码前先按 base64 长度估算一次大小。 */
const toBytes = (data: unknown, maxBytes: number): Uint8Array<ArrayBuffer> => {
  if (typeof data === 'string') {
    // 每个 base64 字符约 3/4 字节：超限的包不必解码，避免几十 MB 的字符串再膨胀一倍。
    if (Math.floor((data.length * 3) / 4) > maxBytes) {
      tooLarge(maxBytes)
    }
    return fromBase64(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
  }
  return fail('historyImportUrlBadResponse')
}

/** 错误响应体（OBS 的 XML 错误页）→ 文本；只解前 4KB，失败返回空串。 */
const errorBodyText = (data: unknown): string => {
  try {
    let bytes: Uint8Array<ArrayBuffer>
    if (typeof data === 'string') {
      const head = data.slice(0, ERROR_BODY_CHARS)
      const usable = head.slice(0, head.length - (head.length % 4))
      bytes = fromBase64(usable)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data).subarray(0, ERROR_BODY_CHARS)
    } else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView
      bytes = new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).subarray(
        0,
        ERROR_BODY_CHARS
      )
    } else {
      return ''
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/** 服务端原文压成一行人话，最多 100 字（放进提示里不会撑爆弹窗）。 */
const serverDetail = (text: string): string => {
  const flat = text
    .replace(/<\?xml[^>]*\?>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat
}

const isTimeout = (error: unknown): boolean =>
  /timeout|timed out|time out/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error))

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name} ${error.message}` : String(error)

/**
 * 明确的「够不到网络」：DNS 解析失败 / 网络不可达 / 连接被拒 / 浏览器离线。
 * 只有这些才敢说「网络已断开」——用户主动断网、飞行模式、DNS 挂了都属于这类。
 */
const isUnreachable = (error: unknown): boolean =>
  /unable to resolve host|unknownhost|network is unreachable|no address associated|connection refused|failed to connect|econnrefused|enotfound|ehostunreach|enetunreach|net::err_internet_disconnected|net::err_name_not_resolved|net::err_network_changed|net_error/i.test(
    errorText(error)
  )

/**
 * 传输被中断：流被对端/中间设备丢掉（unexpected end of stream、连接重置、读超时后的半截连接…）。
 * 这只证明「这条连接断了」，**不能**断言是物理断网（实测 14.4kbps 限速下 OBS 也会主动断流），
 * 所以文案单独一档，并带上已下载比例，避免把责任错判给用户网络。
 */
const isStreamBroken = (error: unknown): boolean =>
  /unexpected end of stream|connection reset|connection aborted|connection closed|connection shutdown|eof reached|broken pipe|socket closed|ioexception|stream|handshake|ssl/i.test(
    errorText(error)
  )

/** 下载失败必录：阶段 + 已下载字节 + 耗时 + 错误原文（回查「导入没反应」靠这条）。 */
const recordDownloadFailure = (
  reason: string,
  url: string,
  startedAt: number,
  extra: Record<string, string | number> = {},
  error?: unknown
) =>
  record('import_error', 'error', `import download failed: ${reason}`, {
    stage: 'download',
    durationMs: Date.now() - startedAt,
    reason,
    // 只留 path（签名与 token 都在 query 里），否则事后无法把一条失败对上具体文件（#19）
    'url.path': redactUrl(url),
    ...extra,
    // error.msg 一律给：没有异常对象时用失败原因兜底，日志里不留空字段（#19）
    ...(error === undefined ? { 'error.msg': reason } : errorMeta(error)),
  })

/**
 * 整段下载的共享状态：停滞看门狗与心跳都读它（只读来记录/判定，不直接改业务结果）。
 * downloaded 是「已确认到手并计入 chunks」的字节，from/span/attempt 说明当前卡在哪一块；
 * lastProgressAt 是**停滞判定的唯一依据**——它只在真的收到新字节时前移。
 */
type DownloadState = {
  startedAt: number
  downloaded: number
  total: number | undefined
  from: number
  span: number
  attempt: number
  /** 最近一次「字节增长」的时刻：连续 stallMs 没有前移才判 stalled */
  lastProgressAt: number
  /** 停滞窗口（毫秒） */
  stallMs: number
  /** 防御性总上限的绝对截止时刻（= startedAt + 总上限） */
  deadline: number
}

/**
 * 跨调用的续传点：上一次下载失败时已经到手的字节。
 * 同一个链接再点「重试」时从这里续传（`Range: bytes=<downloaded>-…`），不再从 0 开始。
 * 只有一份、只在「失败且已下到一部分」时保留；成功/取消/换链接都会清掉。
 */
type DownloadResumePoint = {
  url: string
  chunks: Uint8Array<ArrayBuffer>[]
  downloaded: number
  total: number | undefined
}

let resumePoint: DownloadResumePoint | null = null

/**
 * 值得续传的失败族：链路断/停，但已到手的字节仍然有效
 * （超时、连接中断、网络错误/不可达）。包本身有问题的不在名单里（续也白续）。
 */
const RESUMABLE_ERROR_KEYS = new Set([
  'historyImportUrlTimeout',
  'historyImportUrlTimeoutPartial',
  'historyImportUrlInterrupted',
  'historyImportUrlNetwork',
  'historyImportUrlOffline',
])

/** 主动丢弃续传点（成功、取消、换链接时调用），避免几十上百 MB 的块白占内存。 */
const dropResumePoint = (): void => {
  resumePoint = null
}

/** 字节 → 人话（与界面 formatBytes 同档：KB 之前不换算成小数）。 */
const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 停滞判定：现在就该判死吗？返回原因或 null。
 *
 * 只看两件事：
 * - 防御性总上限（DOWNLOAD_MAX_TOTAL_MS，默认 30 分钟）→ DownloadDeadlineExceeded
 * - 连续 stallMs 没有新字节（state.lastProgressAt 不前移）→ DownloadStalled
 *
 * 这里**没有**「总时长超过 N 秒就判死」这一条：#38 的合法大包就是被那条误杀的。
 */
const stallVerdict = (state: DownloadState): Error | null => {
  const now = Date.now()
  if (now >= state.deadline) {
    recordEvent('import_stage', 'import: download deadline exceeded', {
      stage: 'download',
      'download.bytes': state.downloaded,
      ...(state.total === undefined ? {} : { 'download.total': state.total }),
      'request.from': state.from,
      'request.span': state.span,
      attempt: state.attempt,
      'max.total.ms': state.deadline - state.startedAt,
    })
    return new DownloadDeadlineExceeded()
  }
  const idleMs = now - state.lastProgressAt
  if (idleMs < state.stallMs) {
    return null
  }
  recordEvent('import_stage', 'import: download stalled', {
    stage: 'download',
    'download.bytes': state.downloaded,
    ...(state.total === undefined ? {} : { 'download.total': state.total }),
    'request.from': state.from,
    'request.span': state.span,
    attempt: state.attempt,
    'idle.ms': idleMs,
    'stall.ms': state.stallMs,
  })
  return new DownloadStalled()
}

/**
 * 给一次原生请求套上「停滞看门狗」与取消：
 * - 连续 stallMs 没有新字节 → DownloadStalled（由 downloadArchive 统一记失败终态）
 * - 总时长超过防御性上限 → DownloadDeadlineExceeded
 * - 用户取消 → UrlImportCancelled（取消优先于失败，不误报「下载失败」）
 *
 * 与上一版的差别（#38）：计时起点是 `state.lastProgressAt`，只要期间拿到新字节就重新计时，
 * 慢但在推进的链路永远不会被这里判死；只有「字节真的停住」才会到点收口。
 * 原生 Promise 可能永不 settle，所以每次请求都必须由这里给出终态，而不是等原生超时。
 *
 * 提前结束时把底层 Promise 的 rejection 吞掉：CapacitorHttp 不能 abort，
 * 迟到的原生响应必须彻底丢弃——不写入任何数据、不上报进度、也不变成未处理拒绝。
 */
const guardRequest = <T>(work: Promise<T>, state: DownloadState, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    /** 上一次看到（并确认过）的字节数：用来判断这一轮窗口内是否真的有推进 */
    let seen = state.downloaded
    const onAbort = () => finish(() => reject(new UrlImportCancelled()))
    const finish = (apply: () => void) => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      signal?.removeEventListener('abort', onAbort)
      apply()
    }
    const discard = () => {
      work.catch(() => {})
    }
    /** 到下一次「该看一眼」的时刻：停滞窗口与总上限取较早的那个 */
    const arm = () => {
      const now = Date.now()
      const stallAt = state.lastProgressAt + state.stallMs
      timer = setTimeout(onWake, Math.max(0, Math.min(stallAt, state.deadline) - now))
    }
    const onWake = () => {
      timer = undefined
      // 防御性总上限优先：它是「不管有没有进度都要收口」的硬线，不会被续期推翻
      if (Date.now() >= state.deadline) {
        discard()
        finish(() => reject(stallVerdict(state) ?? new DownloadDeadlineExceeded()))
        return
      }
      // 这一轮窗口内字节有增长 → 续期，绝不因为「总时长变长」判死（#38 的核心）
      if (state.downloaded > seen) {
        seen = state.downloaded
        arm()
        return
      }
      const verdict = stallVerdict(state)
      if (verdict === null) {
        arm()
        return
      }
      discard()
      finish(() => reject(verdict))
    }
    if (signal?.aborted) {
      discard()
      finish(() => reject(new UrlImportCancelled()))
      return
    }
    // 进来就已经该判死（上一块已经把窗口耗光）：不用再等一轮定时器
    const verdict = stallVerdict(state)
    if (verdict !== null) {
      discard()
      finish(() => reject(verdict))
      return
    }
    arm()
    signal?.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })

/**
 * 周期心跳：带「最近这一段新增了多少字节」，日志能直接区分「在推进」还是「停滞」。
 * 原生请求被永久挂起时，这是唯一的在线证据（卡在哪一块 + 已下载多少 + 已经多久没新字节）。
 * 只记录，不中止业务；调用方必须在 finally 里停（成功/失败/取消/卸载都不能留 interval）。
 */
const startDownloadHeartbeat = (
  state: DownloadState,
  trace: ((entry: ImportTraceEntry) => void) | undefined,
  intervalMs: number
): (() => void) => {
  let lastBytes = state.downloaded
  const timer = setInterval(() => {
    const now = Date.now()
    const elapsed = now - state.startedAt
    const delta = state.downloaded - lastBytes
    const idleMs = now - state.lastProgressAt
    recordEvent('import_stage', 'import: download heartbeat', {
      stage: 'download',
      'download.bytes': state.downloaded,
      ...(state.total === undefined ? {} : { 'download.total': state.total }),
      // 最近这一段的新增字节：>0 = 在推进；=0 且 idle.ms 一直涨 = 停滞
      'progress.bytes': delta,
      'progress.state': delta > 0 ? 'advancing' : 'stalled',
      'idle.ms': idleMs,
      'stall.leftMs': Math.max(0, state.lastProgressAt + state.stallMs - now),
      'request.from': state.from,
      'request.span': state.span,
      attempt: state.attempt,
      elapsedMs: elapsed,
    })
    // 详情只在「这一段时间没有新字节」时补一条：有进展时块级采样已经记过，
    // 心跳的作用是证明还活着、以及停滞了多久，不是刷进度。
    if (delta <= 0) {
      trace?.({ at: elapsed, kind: 'heartbeat', bytes: state.downloaded, totalBytes: state.total, idleMs })
    }
    lastBytes = state.downloaded
  }, intervalMs)
  return () => clearInterval(timer)
}

/**
 * 一次带 Range 的 GET；超时/断网在这里抛出，由调用方分类。
 * readTimeout 是「两次读到字节之间的空转上限」，慢而稳的链路不受影响，
 * 断网 / 服务端不再吐数据时最多等一块（12s）就报错。
 */
const requestRange = async (url: string, from: number, to: number): Promise<HttpResponse> =>
  CapacitorHttp.get({
    url,
    responseType: 'arraybuffer',
    connectTimeout: CONNECT_TIMEOUT_MS,
    readTimeout: CHUNK_READ_TIMEOUT_MS,
    headers: {
      Accept: 'application/zip,application/octet-stream,*/*',
      Range: `bytes=${from}-${to}`,
    },
  })

/** 非 2xx：403 按 OBS 错误码细分（链接过期 / 签名错误 / 其他），其余按状态码。 */
const failForStatus = async (
  response: HttpResponse,
  url: string,
  startedAt: number,
  downloaded: number,
  total: number | undefined,
  trace?: (entry: ImportTraceEntry) => void
): Promise<never> => {
  const status = response.status
  // 403：优先用响应体里的 OBS 错误码；body 为空时补发一次 text 请求再判定。
  const rawDetail = serverDetail(errorBodyText(response.data))
  const detail = status === 403 && rawDetail === '' ? serverDetail(await fetchErrorBodyText(url)) : rawDetail
  const meta = {
    'http.status': status,
    'download.bytes': downloaded,
    ...(total === undefined ? {} : { 'download.total': total }),
    ...(detail === '' ? {} : { 'server.detail': detail }),
  }
  if (status === 403) {
    // 链接过期与签名被改在服务端是两个完全不同的错误码（RequestTimeTooSkewed / SignatureDoesNotMatch），
    // 文案必须区分——用户看到「过期」才知道要回 DeepSeek 重新导出，看到「签名错误」才知道是链接被截断。
    if (/SignatureDoesNotMatch/i.test(detail)) {
      recordDownloadFailure('signature', url, startedAt, meta)
      trace?.({ at: Date.now() - startedAt, kind: 'error', status, bytes: downloaded, totalBytes: total, message: 'signature' })
      return fail('historyImportUrlBadSignature')
    }
    if (/RequestTimeTooSkewed|Expired/i.test(detail)) {
      recordDownloadFailure('expired', url, startedAt, meta)
      trace?.({ at: Date.now() - startedAt, kind: 'error', status, bytes: downloaded, totalBytes: total, message: 'expired' })
      return fail('historyImportUrlExpired')
    }
    recordDownloadFailure('forbidden', url, startedAt, meta)
    trace?.({ at: Date.now() - startedAt, kind: 'error', status, bytes: downloaded, totalBytes: total, message: 'forbidden' })
    return fail('historyImportUrlForbidden', { detail: detail === '' ? `HTTP ${status}` : detail })
  }
  recordDownloadFailure(`http-${status}`, url, startedAt, meta)
  trace?.({ at: Date.now() - startedAt, kind: 'error', status, bytes: downloaded, totalBytes: total, message: `http-${status}` })
  return fail('historyImportUrlHttp', { status })
}

/**
 * 只按首块的前 4 字节判 ZIP 头：整包拼一遍只为看 4 个字节，
 * 等于把已经到手的几十 MB 再复制一份（#34 的内存三份拷贝之一），没必要。
 */
const isZipHead = (chunks: Uint8Array<ArrayBuffer>[]): boolean => {
  const first = chunks[0]
  return (
    first !== undefined &&
    first.byteLength >= ZIP_MAGIC.length &&
    ZIP_MAGIC.every((byte, index) => first[index] === byte)
  )
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)))

/**
 * 发一块请求；失败在这一层分类成 断网 / 超时（区分「已下载 >0」）/ 其他网络错误。
 * 断网必须立刻报「网络已断开」：实测电容桥的单发整包会一路等到 183 秒才说「超时」。
 */
const fetchChunk = async (
  url: string,
  from: number,
  to: number,
  state: DownloadState,
  trace: ((entry: ImportTraceEntry) => void) | undefined,
  signal?: AbortSignal
): Promise<{ response: HttpResponse; requested: number }> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt += 1) {
    // 重试时指数缩小块（4KB → 2KB → 1KB）：极差链路上也能一点点往前推，而不是整包重来
    const span = Math.max(MIN_CHUNK_BYTES / 4, Math.floor((to - from + 1) / 2 ** attempt))
    const attemptStartedAt = Date.now()
    // 心跳据此说明「卡在哪一块、第几次尝试」（只读这份状态，不参与业务判断）
    state.from = from
    state.span = span
    state.attempt = attempt
    // 阶段埋点（只记录，不改行为）：把「原生请求是否返回」与「主线程是否停摆」分开。
    recordEvent('import_stage', 'import: native request begin', {
      stage: 'download',
      'request.from': from,
      'request.span': span,
      attempt,
    })
    try {
      // 兜底只看这一层：原生 Promise 可能永不 settle，所以每次请求都同时受
      // 「整段下载剩余预算」和「用户取消」约束，到期立刻结束而不是等原生超时。
      const response = await guardRequest(requestRange(url, from, from + span - 1), state, signal)
      recordEvent('import_stage', 'import: native response', {
        stage: 'download',
        'request.from': from,
        'request.span': span,
        attempt,
        'http.status': response.status,
        elapsedMs: Date.now() - attemptStartedAt,
      })
      return { response, requested: span }
    } catch (error) {
      recordEvent('import_stage', 'import: native request error', {
        stage: 'download',
        'request.from': from,
        'request.span': span,
        attempt,
        elapsedMs: Date.now() - attemptStartedAt,
        ...errorMeta(error),
      })
      // 停滞 / 总上限 / 取消都是终态：不再重试，也不当成网络错误去分类。
      if (
        error instanceof DownloadStalled ||
        error instanceof DownloadDeadlineExceeded ||
        error instanceof UrlImportCancelled
      ) {
        throw error
      }
      lastError = error
      // 弱网会在块中途丢流：同一起点更小的块重试即可续上
      if (attempt < CHUNK_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
  }
  {
    const error = lastError
    const { startedAt, downloaded, total } = state
    const percent = total === undefined || total === 0 ? 0 : Math.round((downloaded / total) * 100)
    if (isTimeout(error)) {
      // 超时且已经下到一半：说明链路慢，不是链接坏了。
      recordDownloadFailure('timeout', url, startedAt, { 'download.bytes': downloaded, percent }, error)
      trace?.({ at: Date.now() - startedAt, kind: 'error', bytes: downloaded, totalBytes: total, message: 'timeout' })
      return downloaded > 0
        ? fail('historyImportUrlTimeoutPartial', { percent })
        : fail('historyImportUrlTimeout')
    }
    if (isUnreachable(error)) {
      // 「够不到网络」不再一律说成断网（#111）：ECONNREFUSED 说明链路通、对面没在监听，
      // 与真的没网（DNS 失败 / navigator.onLine === false）是两回事，文案必须分开。
      const refused = classifyImportFailure({ error, online: isBrowserOnline() }) === 'refused'
      const reason = refused ? 'refused' : 'unreachable'
      recordDownloadFailure(reason, url, startedAt, { 'download.bytes': downloaded }, error)
      trace?.({ at: Date.now() - startedAt, kind: 'error', bytes: downloaded, totalBytes: total, message: reason })
      return fail(refused ? 'historyImportUrlRefused' : 'historyImportUrlOffline')
    }
    if (isStreamBroken(error)) {
      recordDownloadFailure('interrupted', url, startedAt, { 'download.bytes': downloaded, percent }, error)
      trace?.({ at: Date.now() - startedAt, kind: 'error', bytes: downloaded, totalBytes: total, message: 'interrupted', status: 0 })
      return fail('historyImportUrlInterrupted', { percent })
    }
    recordDownloadFailure('network', url, startedAt, { 'download.bytes': downloaded }, error)
    trace?.({ at: Date.now() - startedAt, kind: 'error', bytes: downloaded, totalBytes: total, message: 'network' })
    return fail('historyImportUrlNetwork')
  }
}

/**
 * 分块下载并校验 ZIP。
 * 进度按字节实时上报；取消在块边界生效；失败按 断网 / 超时 / 403（过期·签名·其他）/ 超限 / 非 ZIP 分类。
 *
 * 终态判定（#38 重写，核心是「按无进度判死」而不是「按总时长判死」）：
 * - 停滞（DownloadStalled）：连续 DOWNLOAD_STALL_MS 没有新字节才判死；
 *   慢但在推进的链路每拿到一块就会重新计时，因此不会被误杀（164.5MB 慢包不再被判死）。
 * - 总上限（DownloadDeadlineExceeded）：防御性 30 分钟，只防「永远慢慢爬、永远下不完」。
 * - 续传：失败时把已到手的块留在 resumePoint，同链接重试从 `state.downloaded` 续；
 *   服务端忽略 Range（回 200 整包）时丢弃本地字节、从头重下并在详情里写明「已重新开始」。
 * - 全程每 HEARTBEAT_INTERVAL_MS 一条心跳（带最近一段新增字节与 idle 时长），
 *   日志/详情里能直接区分「在推进」和「停滞」。
 * - 心跳 interval 在成功/失败/取消/卸载的每条分支上都由 finally 停掉，不留残留。
 */
const downloadArchive = async (
  url: string,
  options: UrlImportOptions,
  trace?: (entry: ImportTraceEntry) => void
): Promise<File> => {
  const startedAt = Date.now()
  const maxBytes = resolveMaxImportBytes(options.maxBytes)
  const stallMs = Math.max(1, options.downloadStallMs ?? DOWNLOAD_STALL_MS)
  const maxTotalMs = Math.max(1, options.downloadMaxTotalMs ?? DOWNLOAD_MAX_TOTAL_MS)
  // 续传点只对同一个链接有效；换链接立刻丢掉旧字节（否则会把两份包拼在一起）。
  const resumed = resumePoint !== null && resumePoint.url === url ? resumePoint : null
  if (resumed === null && resumePoint !== null) {
    dropResumePoint()
  }
  const state: DownloadState = {
    startedAt,
    downloaded: resumed?.downloaded ?? 0,
    total: resumed?.total,
    from: resumed?.downloaded ?? 0,
    span: 0,
    attempt: 0,
    lastProgressAt: startedAt,
    stallMs,
    deadline: startedAt + maxTotalMs,
  }
  recordEvent('import_stage', 'import: download archive', {
    stage: 'download',
    'stall.ms': stallMs,
    'max.total.ms': maxTotalMs,
    'download.bytes': state.downloaded,
    ...(state.total === undefined ? {} : { 'download.total': state.total }),
    resume: resumed === null ? 'no' : 'yes',
  })
  if (resumed !== null) {
    // 续传：明确告知「从已下载的哪里继续」，重试不再从 0 开始（#38）
    trace?.({ at: 0, kind: 'resume', bytes: resumed.downloaded, totalBytes: resumed.total })
    options.onProgress?.({
      phase: 'downloading',
      downloadedBytes: resumed.downloaded,
      totalBytes: resumed.total,
    })
  }
  const stopHeartbeat = startDownloadHeartbeat(
    state,
    trace,
    Math.max(1, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  )
  const chunks: Uint8Array<ArrayBuffer>[] = resumed === null ? [] : [...resumed.chunks]
  /** 是否真的产出了可导入的文件：决定 finally 里要不要保留续传点 */
  let delivered = false
  /** 失败是否属于「字节没问题、只是链路断了」：只有这类才值得留着续传 */
  let resumableFailure = false
  let chunkSize = FIRST_CHUNK_BYTES
  let lastTraceBytes = 0
  let lastTracePercent = -1
  let lastTraceAt = 0
  try {
    for (;;) {
      throwIfCancelled(options.signal)
      const from = state.downloaded
      const to = from + chunkSize - 1
      const chunkStartedAt = Date.now()
      const { response, requested } = await fetchChunk(url, from, to, state, trace, options.signal)
      const status = response.status
      // 416：请求范围越界 = 上一块正好是最后一块（服务端更严格时走这里）。
      if (status === 416 && from > 0) {
        response.data = null
        break
      }
      if (status !== 200 && status !== 206) {
        await failForStatus(response, url, startedAt, state.downloaded, state.total, trace)
      }
      if (status === 200 && from > 0) {
        // 服务端忽略了 Range，直接回整包：不能把整包接在已下载的字节后面（会拼错、包体翻倍），
        // 只能丢掉本地已下载的部分从头算，并把「已重新开始」写进详情（#38 要求明确告知）。
        recordEvent('import_stage', 'import: range ignored, restart from zero', {
          stage: 'download',
          'download.bytes': state.downloaded,
          'request.from': from,
          'request.span': requested,
        })
        trace?.({
          at: Date.now() - startedAt,
          kind: 'restart',
          bytes: 0,
          totalBytes: state.total,
          message: 'range-ignored',
        })
        chunks.length = 0
        state.downloaded = 0
        // 200 的 Content-Length 就是整包大小，下面按新响应重新取（旧的 Range 总数可能过期）
        state.total = undefined
        state.lastProgressAt = Date.now()
        lastTraceBytes = 0
        lastTracePercent = -1
      }
      let data: unknown = response.data
      response.data = null
      const bytes = toBytes(data, maxBytes)
      data = null
      if (state.total === undefined) {
        // 总长度只认可信来源：
        // - 206 的 `Content-Range: bytes a-b/total`（total 为 `*` 时代码按未知处理）；
        // - 首次整包 200（服务端忽略 Range）的 `Content-Length`。
        // 206 缺 Content-Range 时响应里的 Content-Length 只是**这一块**的长度，
        // 拿它当总长会让 4KB 被判成「已下完」，并让 200MB 上限拿 4KB 去比（#24）。
        const declared =
          contentRangeTotal(response.headers) ??
          (status === 200 ? contentLength(response.headers) : undefined)
        if (declared !== undefined) {
          state.total = declared
          if (declared > maxBytes) {
            tooLarge(maxBytes)
          }
        }
      }
      if (bytes.byteLength > 0) {
        chunks.push(bytes)
        state.downloaded += bytes.byteLength
        // 停滞判定的唯一依据：真的收到新字节才重新计时（#38）
        state.lastProgressAt = Date.now()
        if (state.downloaded > maxBytes) {
          tooLarge(maxBytes)
        }
        options.onProgress?.({
          phase: 'downloading',
          downloadedBytes: state.downloaded,
          totalBytes: state.total,
        })
        {
          // 详情里只留少量「人话」采样：首个、每跨 10%、以及至少 1s 间隔
          const percent = state.total ? Math.floor((state.downloaded / state.total) * 10) : undefined
          const checkpoint =
            lastTraceBytes === 0 ||
            (percent !== undefined && percent !== lastTracePercent) ||
            Date.now() - lastTraceAt >= 1000
          if (checkpoint) {
            lastTraceBytes = state.downloaded
            lastTracePercent = percent ?? 0
            lastTraceAt = Date.now()
            trace?.({
              at: Date.now() - startedAt,
              kind: 'download',
              bytes: state.downloaded,
              totalBytes: state.total,
            })
          }
        }
      }
      // 200 = 服务端忽略了 Range，整包已经到手；不足请求的那一块（含空块）= 服务端已收敛。
      // total 未知时这是唯一的完成信号，所以不能只看「已下到的字节数够不够 total」。
      if (status === 200 || bytes.byteLength === 0 || bytes.byteLength < requested) {
        break
      }
      // 自适应块大小：慢网小块、快网大块，进度大致每秒一次。
      const elapsed = Math.max(1, Date.now() - chunkStartedAt)
      chunkSize = clamp((bytes.byteLength / elapsed) * CHUNK_TARGET_MS, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)
    }
    throwIfCancelled(options.signal)
    if (state.downloaded === 0) {
      recordDownloadFailure('empty', url, startedAt, { 'download.bytes': 0 })
      fail('historyImportUrlBadResponse')
    }
    if (state.total !== undefined && state.downloaded < state.total) {
      // 链路中途断掉：块级别已经拿到结果但字节不足，绝不能当成功导入。
      recordDownloadFailure('incomplete', url, startedAt, {
        'download.bytes': state.downloaded,
        'download.total': state.total,
      })
      fail('historyImportUrlInterrupted', {
        percent: Math.round((state.downloaded / state.total) * 100),
      })
    }
    // 三份拷贝 → 两份：过去是「分块数组 + concat 出的整包 + Blob 自己的副本」，
    // 峰值内存约 3×包大小；现在直接把分块交给 Blob（它只需要一份），
    // 再丢掉分块数组的引用，让 JS 侧那份尽快被回收。没有引入流式改写（#34 明确不做）。
    if (!isZipHead(chunks)) {
      fail('historyImportUrlNotZip')
    }
    delivered = true
    const file = new File(chunks, ARCHIVE_NAME, { type: 'application/zip' })
    chunks.length = 0
    return file
  } catch (error) {
    // 只有「字节本身没问题、只是链路断了/停了」才留续传点；
    // 包坏了（非 ZIP）、超限、403（过期/签名）继续从字节中间续也永远好不了，直接丢。
    resumableFailure =
      error instanceof DownloadStalled ||
      error instanceof DownloadDeadlineExceeded ||
      (error instanceof BackupError && RESUMABLE_ERROR_KEYS.has(error.key))
    // 取消优先：用户点了取消时，看门狗只是把挂起的原生请求解开，不能算成「下载失败」。
    if (error instanceof DownloadStalled || error instanceof DownloadDeadlineExceeded) {
      throwIfCancelled(options.signal)
    }
    const { downloaded, total } = state
    const meta = {
      'download.bytes': downloaded,
      ...(total === undefined ? {} : { 'download.total': total }),
      'request.from': state.from,
      'request.span': state.span,
      attempt: state.attempt,
      retryable: 'yes',
      // 已到手一部分就能续传：重试不会再从 0 开始（#38）
      resume: downloaded > 0 ? 'yes' : 'no',
    }
    if (error instanceof DownloadStalled) {
      const idleMs = Math.max(0, Date.now() - state.lastProgressAt)
      const seconds = Math.max(1, Math.round(state.stallMs / 1000))
      recordDownloadFailure('stalled', url, startedAt, {
        ...meta,
        'idle.ms': idleMs,
        'stall.ms': state.stallMs,
      })
      trace?.({
        at: Date.now() - startedAt,
        kind: 'error',
        bytes: downloaded,
        totalBytes: total,
        idleMs,
        message: 'stalled',
      })
      // 终态必须可读：卡住多久 + 已下载/总量 + 可重试（不再只说「长时间无响应」）
      return total === undefined
        ? fail('historyImportUrlStalledUnknownTotal', { done: formatSize(downloaded), seconds })
        : fail('historyImportUrlStalled', {
            done: formatSize(downloaded),
            total: formatSize(total),
            seconds,
          })
    }
    if (error instanceof DownloadDeadlineExceeded) {
      const minutes = Math.max(1, Math.round(maxTotalMs / 60_000))
      recordDownloadFailure('deadline', url, startedAt, { ...meta, 'max.total.ms': maxTotalMs })
      trace?.({
        at: Date.now() - startedAt,
        kind: 'error',
        bytes: downloaded,
        totalBytes: total,
        message: 'deadline',
      })
      return total === undefined
        ? fail('historyImportUrlDeadlineUnknownTotal', { done: formatSize(downloaded), minutes })
        : fail('historyImportUrlDeadline', {
            done: formatSize(downloaded),
            total: formatSize(total),
            minutes,
          })
    }
    throw error
  } finally {
    stopHeartbeat()
    // 续传点只在「可续的失败且已到手一部分」时保留；成功、取消、零字节、坏包都立刻丢掉。
    if (delivered || !resumableFailure || options.signal?.aborted || state.downloaded === 0) {
      dropResumePoint()
    } else {
      resumePoint = { url, chunks, downloaded: state.downloaded, total: state.total }
    }
  }
}

/**
 * 直链导入：校验 URL → 分块下载（实时进度，可取消）→ 校验 ZIP → 解析 → 逐会话导入（进度 n/总数）。
 * 取消：下载期间不发新块并丢弃已下载内容；导入期间在条目边界中断，暂存被清空、正式数据不变。
 */
/** 埋点关联 id：短随机串，不含任何用户内容 */
const newCorrelationId = (): string => {
  try {
    return crypto.randomUUID().slice(0, 12)
  } catch {
    return Math.random().toString(36).slice(2, 14)
  }
}

export const importHistoryFromUrl = async (
  url: string,
  options: UrlImportOptions = {}
): Promise<number> => {
  if (!Capacitor.isNativePlatform()) {
    record('import_error', 'error', 'import rejected: not native', {
      stage: 'validate',
      'error.msg': 'native platform required',
    })
    fail('historyImportUrlNativeOnly')
  }
  const link = url.trim()
  if (!/^https?:\/\/\S+$/i.test(link)) {
    record('import_error', 'error', 'import rejected: invalid url', {
      stage: 'validate',
      'error.msg': 'invalid http(s) url',
    })
    fail('historyImportUrlInvalid')
  }
  // 关联 id：导入链路的埋点靠它串起来（来自 coverage 分支的 correlation 埋点）
  const correlationId = newCorrelationId()
  recordAction('import_start', 'import-history-url', { correlationId, source: 'url' })
  const startedAt = Date.now()
  const trace = options.onTrace
  const emit = (entry: Omit<ImportTraceEntry, 'at'>) => trace?.({ at: Date.now() - startedAt, ...entry })
  emit({ kind: 'start' })
  let lastSessionTraceAt = 0
  let lastImageTraceAt = 0
  let lastImages = 0
  let checkReported = false
  try {
    const file = await downloadArchive(link, options, trace)
    // 下载期间点了取消：结果直接丢弃，不进入暂存与替换事务。
    throwIfCancelled(options.signal)
    options.onProgress?.({ phase: 'decoding' })
    emit({ kind: 'check', bytes: file.size })
    return await importHistory(file, {
      signal: options.signal,
      onProgress: (progress) => {
        options.onProgress?.({
          phase: 'importing',
          processed: progress.sessions,
          totalSessions: progress.totalSessions,
        })
        const now = Date.now()
        // 会话总数是校验阶段算出来的：拿到就补一条「校验归档结束，共 N 个会话」
        if (!checkReported && progress.totalSessions !== undefined) {
          checkReported = true
          emit({ kind: 'check', totalSessions: progress.totalSessions })
        }
        // 会话进度：首个 + 每 1s 一条，避免把 329 条刷进详情
        if (lastSessionTraceAt === 0 || now - lastSessionTraceAt >= 1000) {
          lastSessionTraceAt = now
          emit({
            kind: 'session',
            sessions: progress.sessions,
            totalSessions: progress.totalSessions,
          })
        }
        // 图片：数量变化且间隔 >= 1s 才记
        if (progress.images !== undefined && progress.images !== lastImages && now - lastImageTraceAt >= 1000) {
          lastImages = progress.images
          lastImageTraceAt = now
          emit({ kind: 'image', images: progress.images })
        }
      },
    }).then((count) => {
      emit({ kind: 'done', sessions: count })
      return count
    })
  } catch (error) {
    if (options.signal?.aborted || error instanceof UrlImportCancelled) {
      // 取消不是失败：单独记一条，便于区分「用户取消」与「链路失败」。
      record('warning', 'warn', 'import cancelled by user', {
        stage: 'url-import',
      })
      emit({ kind: 'cancel' })
      throw error instanceof UrlImportCancelled ? error : new UrlImportCancelled()
    }
    // 下载阶段的失败已经在原处带过状态与原因；这里补「校验/导入阶段」的失败事实。
    const isDownloadFailure = error instanceof BackupError && error.key.startsWith('historyImportUrl')
    if (!isDownloadFailure) {
      emit({ kind: 'error', message: error instanceof BackupError ? error.key : 'unknown' })
    }
    throw error
  }
}

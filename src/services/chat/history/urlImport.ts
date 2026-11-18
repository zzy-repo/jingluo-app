import { Capacitor, CapacitorHttp, type HttpResponse } from '@capacitor/core'
import { errorMeta, record, recordAction, recordEvent, redactUrl } from '../../diagnostics/collector.js'
import { importHistory } from '../backup.js'
import { BackupError, fail } from './errors.js'

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

/** 单个导出包的大小上限。官方包约 20MB、467 条目，留十倍余量，同时避免整包读进内存。 */
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

/** 上限的 MB 数，用于提示文案。 */
const maxMegabytes = MAX_ARCHIVE_BYTES / 1024 / 1024

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

/** 403 响应体里带 OBS 错误码；只解前面一小段足够判定。 */
const ERROR_BODY_CHARS = 4096

/** 取消后丢弃结果：CapacitorHttp 不支持 abort，取消保证「不再发新块、不再写入任何数据」。 */
export class UrlImportCancelled extends Error {
  constructor() {
    super('URL import cancelled')
    this.name = 'UrlImportCancelled'
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
}

/** 原生（APK）才具备绕过 CORS 的原生 HTTP；网页版不提供该能力。 */
export const canImportFromUrl = (): boolean => Capacitor.isNativePlatform()

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= ZIP_MAGIC.length && ZIP_MAGIC.every((byte, index) => bytes[index] === byte)

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

const tooLarge = (): never => fail('historyImportUrlTooLarge', { size: maxMegabytes })

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
const toBytes = (data: unknown): Uint8Array<ArrayBuffer> => {
  if (typeof data === 'string') {
    // 每个 base64 字符约 3/4 字节：超限的包不必解码，避免几十 MB 的字符串再膨胀一倍。
    if (Math.floor((data.length * 3) / 4) > MAX_ARCHIVE_BYTES) {
      tooLarge()
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
    'url.path': redactUrl(url),
    durationMs: Date.now() - startedAt,
    reason,
    ...extra,
    ...(error === undefined ? {} : errorMeta(error)),
  })

/**
 * 一次带 Range 的 GET；超时/断网在这里抛出，由调用方分类。
 * readTimeout 是「两次读到字节之间的空转上限」，慢而稳的链路不受影响，
 * 断网 / 服务端不再吐数据时最多等一块（20s）就报错。
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

/** 把已下载的块拼成一个连续字节数组（20MB 一次拷贝，比逐块 Blob 快）。 */
const concatChunks = (chunks: Uint8Array<ArrayBuffer>[], length: number): Uint8Array<ArrayBuffer> => {
  if (chunks.length === 1) {
    return chunks[0]
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
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
  state: {
    startedAt: number
    downloaded: number
    total: number | undefined
    trace?: (entry: ImportTraceEntry) => void
  }
): Promise<{ response: HttpResponse; requested: number }> => {
  let lastError: unknown
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt += 1) {
    // 重试时指数缩小块（4KB → 2KB → 1KB）：极差链路上也能一点点往前推，而不是整包重来
    const span = Math.max(MIN_CHUNK_BYTES / 4, Math.floor((to - from + 1) / 2 ** attempt))
    try {
      const response = await requestRange(url, from, from + span - 1)
      return { response, requested: span }
    } catch (error) {
      lastError = error
      // 弱网会在块中途丢流：同一起点更小的块重试即可续上
      if (attempt < CHUNK_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
  }
  {
    const error = lastError
    const { startedAt, downloaded, total, trace } = state
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
      recordDownloadFailure('unreachable', url, startedAt, { 'download.bytes': downloaded }, error)
      trace?.({ at: Date.now() - startedAt, kind: 'error', bytes: downloaded, totalBytes: total, message: 'unreachable' })
      return fail('historyImportUrlOffline')
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
 */
const downloadArchive = async (
  url: string,
  options: UrlImportOptions,
  trace?: (entry: ImportTraceEntry) => void
): Promise<File> => {
  const startedAt = Date.now()
  recordEvent('import_stage', 'import: download archive', {
    stage: 'download',
    'url.path': redactUrl(url),
  })
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let downloaded = 0
  let total: number | undefined
  let chunkSize = FIRST_CHUNK_BYTES
  let lastTraceBytes = 0
  let lastTracePercent = -1
  let lastTraceAt = 0
  for (;;) {
    throwIfCancelled(options.signal)
    const from = downloaded
    const to = from + chunkSize - 1
    const chunkStartedAt = Date.now()
    const { response, requested } = await fetchChunk(url, from, to, {
      startedAt,
      downloaded,
      total,
      trace,
    })
    const status = response.status
    // 416：请求范围越界 = 上一块正好是最后一块（服务端更严格时走这里）。
    if (status === 416 && from > 0) {
      response.data = null
      break
    }
    if (status !== 200 && status !== 206) {
      await failForStatus(response, url, startedAt, downloaded, total, trace)
    }
    if (status === 200 && from > 0) {
      // 中途不再支持分段：继续拼会拼错，直接按失败处理（包体不完整）。
      response.data = null
      recordDownloadFailure('range-lost', url, startedAt, { 'download.bytes': downloaded })
      fail('historyImportUrlBadResponse')
    }
    let data: unknown = response.data
    response.data = null
    const bytes = toBytes(data)
    data = null
    if (total === undefined) {
      total = contentRangeTotal(response.headers) ?? contentLength(response.headers)
      if (total !== undefined && total > MAX_ARCHIVE_BYTES) {
        tooLarge()
      }
    }
    if (bytes.byteLength > 0) {
      chunks.push(bytes)
      downloaded += bytes.byteLength
      if (downloaded > MAX_ARCHIVE_BYTES) {
        tooLarge()
      }
      options.onProgress?.({ phase: 'downloading', downloadedBytes: downloaded, totalBytes: total })
      {
        // 详情里只留少量「人话」采样：首个、每跨 10%、以及至少 1s 间隔
        const percent = total ? Math.floor((downloaded / total) * 10) : undefined
        const checkpoint = lastTraceBytes === 0 || (percent !== undefined && percent !== lastTracePercent) || Date.now() - lastTraceAt >= 1000
        if (checkpoint) {
          lastTraceBytes = downloaded
          lastTracePercent = percent ?? 0
          lastTraceAt = Date.now()
          trace?.({ at: Date.now() - startedAt, kind: 'download', bytes: downloaded, totalBytes: total })
        }
      }
    }
    // 200 = 服务端忽略了 Range，整包已经到手；不足请求的那一块 = 已经是最后一块。
    if (status === 200 || bytes.byteLength < requested) {
      break
    }
    // 自适应块大小：慢网小块、快网大块，进度大致每秒一次。
    const elapsed = Math.max(1, Date.now() - chunkStartedAt)
    chunkSize = clamp((bytes.byteLength / elapsed) * CHUNK_TARGET_MS, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES)
  }
  throwIfCancelled(options.signal)
  if (downloaded === 0) {
    recordDownloadFailure('empty', url, startedAt, { 'download.bytes': 0 })
    fail('historyImportUrlBadResponse')
  }
  if (total !== undefined && downloaded < total) {
    // 链路中途断掉：块级别已经拿到结果但字节不足，绝不能当成功导入。
    recordDownloadFailure('incomplete', url, startedAt, {
      'download.bytes': downloaded,
      'download.total': total,
    })
    fail('historyImportUrlInterrupted', {
      percent: Math.round((downloaded / total) * 100),
    })
  }
  const bytes = concatChunks(chunks, downloaded)
  if (!isZip(bytes)) {
    fail('historyImportUrlNotZip')
  }
  return new File([bytes], ARCHIVE_NAME, { type: 'application/zip' })
}

/**
 * 直链导入：校验 URL → 分块下载（实时进度，可取消）→ 校验 ZIP → 解析 → 逐会话导入（进度 n/总数）。
 * 取消：下载期间不发新块并丢弃已下载内容；导入期间在条目边界中断，暂存被清空、正式数据不变。
 */
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
      'url.path': redactUrl(link),
      'error.msg': 'invalid http(s) url',
    })
    fail('historyImportUrlInvalid')
  }
  recordAction('import_start', 'import-history-url', { source: 'url', 'url.path': redactUrl(link) })
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
        'url.path': redactUrl(link),
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

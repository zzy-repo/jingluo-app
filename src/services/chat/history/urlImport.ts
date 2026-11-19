import { Capacitor } from '@capacitor/core'
import { errorMeta, record, recordAction, recordEvent, redactUrl } from '../../diagnostics/collector.js'
import { LIMITS } from '../../limits.js'
import { importHistory } from '../backup.js'
import { BackupError, fail } from './errors.js'
import {
  ARCHIVE_READ_FAILURE_KEY,
  classifyImportFailure,
  IMPORT_FAILURE_KEYS,
  isArchiveReadFailure,
  isBrowserOnline,
  type ImportFailureReason,
} from './importFailure.js'
import {
  formatImportBytes as formatSize,
  maxImportMegabytes,
  resolveMaxImportBytes,
  DEFAULT_MAX_IMPORT_BYTES,
} from './importLimit.js'
import { nativeArchive, type NativeArchiveHandle } from './nativeArchive.js'

/**
 * 直链导入：原生侧流式下载 ZIP 到 App 私有目录，再交给既有的文件导入链路（importHistory）按区间读。
 *
 * 为什么只能在原生（APK）里做：DeepSeek 导出的 ZIP 放在官方 OBS 桶上，桶没有开 CORS
 * （预检 OPTIONS 返回 403、响应无 Access-Control-Allow-Origin），浏览器 fetch 必被拦。
 *
 * 为什么下载改成原生流式落盘（#34）：旧实现用 `CapacitorHttp.get` 分块取回，再在 JS 里攒成
 * `chunks: Uint8Array[]` → `new File(chunks)`。那条路的内存**随包体线性增长**（同一份数据在
 * WebView 堆里至少两份：分块数组 + File 的副本），200MB 的合法导出包必然撞天花板，
 * 把 4.5MB / 20MB / 48MB / 200MB 四档跑一遍就能看到净 PSS 一路涨到几十 MB。现在网络读与写盘
 * 都在原生（{@link HistoryArchivePlugin}），JS 只轮询「已下载多少字节」，内存由块大小决定。
 */

/**
 * 单个导出包的大小上限：**就是 importLimit 里那一个数字**（默认 200MB）。
 * 这里只做转出，别的地方不要再抄一遍 200MB——本地文件导入用的是同一个上限（issue #34）。
 */
export const MAX_ARCHIVE_BYTES = DEFAULT_MAX_IMPORT_BYTES

/** ZIP 本地文件头 PK\x03\x04，与 zipReader.isZipFile 保持一致。 */
const ZIP_MAGIC = [0x50, 0x4b, 3, 4]

/** 建连超时：原生侧用，和旧的 CapacitorHttp 同一档（10s）。 */
const CONNECT_TIMEOUT_MS = LIMITS.importConnectMs

/**
 * 停滞判定窗口：**唯一**的失败判定依据——连续这么久「没有任何新字节」才判 stalled。
 *
 * 为什么按「无进度」而不是「总墙钟」判：上一版用的是 120s 绝对总预算，结果 164.5MB 的
 * **合法**导出包在约 0.5MB/s 的真实网络下必然超时（#38：三次分别在 47.4/54.3/65.4MB 处被误杀），
 * 而字节其实一直在增长。慢但在推进的链路只能续期，不能判死；真正挂死（对端不再吐数据、
 * 原生读永久阻塞）的共同特征是「字节停住」，那才是要判的东西。
 *
 * 这一条在流式落盘之后仍然成立：判定看的是**文件增长**（原生侧 `bytes` 计数），
 * 与「怎么下载的」无关。删掉的只有「120s 总墙钟」这种形式（#38 的结论）。
 */
const DOWNLOAD_STALL_MS = LIMITS.importStallMs

/**
 * 防御性总上限：只防「一直在爬但永远下不完」的病态链路，不参与日常判定。
 * 30 分钟对 200MB 上限的包意味着 ≥110KB/s 就能下完；164.5MB 实测约 5 分钟，余量充足。
 */
const DOWNLOAD_MAX_TOTAL_MS = LIMITS.importMaxTotalMs

/**
 * 上面两个常量之间的**可校验关系**（#152）：按现行上限与总时限，链路至少要稳定跑这么快才可能下完。
 *
 * 现值 = DEFAULT_MAX_IMPORT_BYTES（200MB）÷ DOWNLOAD_MAX_TOTAL_MS（1800s）≈ 114KB/s ≈ 0.9Mbps，
 * 常见移动网络都够，所以两者目前是自洽的。要点是它**推导**而来、不是手写的数：
 * 谁把上限调大（或把总时限调短）而另一个不跟着动，这个"所需最低带宽"就会立刻变化，
 * 并随每一次预算耗尽写进诊断（`min.bytes.per.sec`）——「常量不自洽」于是变成一次失败里看得见的事实，
 * 而不是要等人拿计算器算一遍才发现。
 *
 * 数值口径已定（#152 第 3 条，口径 A）：**维持 200MB + 30min**。理由是 200MB 归档要求 ≥0.9Mbps
 * 在常见 4G 之上仍有余量，属合理门槛；降上限（口径 C）是对用户可见的功能回退，放宽总时限（口径 B）
 * 让导入能挂近一小时反而更糟，自适应（口径 D）实现最重。所以这里不引入任何产品行为变更，
 * 只把「链接太慢」从无法解释的失败变成可解释的失败。
 *
 * 写成函数 + 调用一次，而不是把 114 这个数写进诊断：关系是**推导**的，调常量时不用回来改代码。
 */
export const minRequiredBytesPerSec = (maxBytes: number, maxTotalMs: number): number => maxBytes / (maxTotalMs / 1000)

/** 现行两个常量的组合及其推导出的所需最低带宽（预算耗尽的诊断里带的就是这一份）。 */
export const importBudget = (): { maxBytes: number; maxTotalMs: number; minBytesPerSec: number } => {
  const maxBytes = DEFAULT_MAX_IMPORT_BYTES
  const maxTotalMs = DOWNLOAD_MAX_TOTAL_MS
  return { maxBytes, maxTotalMs, minBytesPerSec: minRequiredBytesPerSec(maxBytes, maxTotalMs) }
}

const MIN_REQUIRED_BYTES_PER_SEC = importBudget().minBytesPerSec

/**
 * 周期性心跳间隔：每 5s 一条「这一段新增了多少字节 + 已经多久没有新字节」，
 * 日志里能直接区分「在推进」和「停滞」，也是原生读挂住时唯一的在线证据。
 */
const HEARTBEAT_INTERVAL_MS = LIMITS.importHeartbeatMs

/**
 * 进度轮询间隔：原生侧只维护计数器，JS 按这个节拍问一次「到哪儿了」。
 * 500ms 是为了让「已下载 xx MB」看起来是连续跳的，同时也是取消与停滞判定的响应粒度。
 */
const POLL_MS = 500

/** 取消：不再轮询、不再接受任何字节，临时文件由原生侧同步删除。 */
export class UrlImportCancelled extends Error {
  constructor() {
    super('URL import cancelled')
    this.name = 'UrlImportCancelled'
  }
}

/** 停滞终态：连续 stallMs 没有收到任何新字节。 */
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

/** 原生（APK）才具备绕过 CORS 的原生下载；网页版不提供该能力。 */
export const canImportFromUrl = (): boolean => Capacitor.isNativePlatform()

const throwIfCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new UrlImportCancelled()
  }
}

/**
 * 超限拒绝（#195）：上限与**实测体积**都要说出来。
 * 只给「文件过大（200MB）」时用户不知道是哪个包、也看不出差多少；两个数一起给，
 * 才不会把「应用算错」和「我这个包确实太大」混在一起。
 */
const tooLarge = (limitBytes: number, measuredBytes: number): never => {
  // 拒绝也要留痕：只给用户一句提示、日志里却什么都没有，事后就查不出「到底是哪个包、差多少」。
  record('import_error', 'error', 'import rejected: archive too large', {
    stage: 'size',
    'limit.bytes': limitBytes,
    'download.bytes': measuredBytes,
  })
  return fail('historyImportUrlTooLarge', {
    size: maxImportMegabytes(limitBytes),
    actual: formatSize(measuredBytes),
  })
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
 * 原生侧抛的是 Java 异常原文（`UnknownHostException: Unable to resolve host …`、
 * `ConnectException: Connection refused`），所以这里同时认 Java 与 WebView 两种写法。
 */
const isUnreachable = (error: unknown): boolean =>
  /unable to resolve host|unknownhost|network is unreachable|no address associated|connection refused|failed to connect|econnrefused|enotfound|ehostunreach|enetunreach|net::err_internet_disconnected|net::err_name_not_resolved|net::err_network_changed|net_error/i.test(
    errorText(error)
  )

/**
 * 传输被中断：流被对端/中间设备丢掉（unexpected end of stream、连接重置、socket 关闭…）。
 * 这只证明「这条连接断了」，**不能**断言是物理断网（实测 14.4kbps 限速下 OBS 也会主动断流），
 * 所以文案单独一档，并带上已下载比例，避免把责任错判给用户网络。
 */
const isStreamBroken = (error: unknown): boolean =>
  /unexpected end of stream|connection reset|connection aborted|connection closed|connection shutdown|eof reached|broken pipe|socket closed|socketexception|ioexception|stream|handshake|ssl/i.test(
    errorText(error)
  )

/**
 * 永久性失败：**地址本身**不可用，重试多少次都是同一个结果（#154）。
 *
 * - WHATWG 禁用端口：`net::ERR_UNSAFE_PORT`（1、7、6667 这类），Chromium 连试都不试就拒；
 * - 协议/地址非法：`ERR_UNKNOWN_URL_SCHEME`、`ERR_DISALLOWED_URL_SCHEME`、`ERR_INVALID_URL`、
 *   `ERR_ADDRESS_INVALID`。
 *
 * 刻意**不含** DNS 的 `ENOTFOUND` / `EAI_AGAIN`：DNS 抖动是瞬时的，宽带刚起、切换 Wi-Fi 时很常见，
 * 必须留在可重试那一类；也不含任何超时/连接重置的形态（那是 #154 明确要求保留的重试）。
 */
const isPermanentFailure = (error: unknown): boolean =>
  /err_unsafe_port|err_unknown_url_scheme|err_disallowed_url_scheme|err_invalid_url|err_invalid_url_scheme|err_address_invalid|err_unsupported_scheme/i.test(
    errorText(error)
  )

/**
 * 「过了多久」的单调计时（#151）：把墙钟读数换算成一个**只增不减**的累计毫秒值。
 *
 * 为什么不直接读 Date.now()：它不单调。系统校时、用户改时间、NTP 跳变、休眠唤醒都会让
 * 它整段跳——前跳让健康链路凭空「耗完」总上限（被误判成超时/停滞），回拨让耗时报成负数
 * （详情里出现「−3600000ms」）。耗时与停滞判定只能读这里的累计值。
 *
 * 为什么不用 performance.now()：本仓库的停滞/总上限用例用 node:test 的假时钟驱动时间
 * （`t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })`），它只假 Date；
 * 换成 performance.now() 会让这些用例彻底失去时间控制——判定逻辑没变，却再也测不出来。
 *
 * 规则（每次读取时按「与上次读数的差」累计）：
 * - 0 < delta <= CLOCK_JUMP_MS：正常流逝 → 计入
 * - delta <= 0：回拨 → 当作「时间没走」，绝不让耗时倒退
 * - delta > CLOCK_JUMP_MS：前跳 → 同样不计入，绝不让一次跳变凭空耗完总上限
 *
 * 阈值取 2 分钟：一次下载里真正的等待都被原生的连接/读超时（10s）、轮询间隔（500ms）与
 * 停滞窗口（40s）压在 ~40s 以内，正常读数到不了 2 分钟；而校时/改时间的跳变通常是分钟级往上。
 * 已知代价（未测边界）：应用在后台被挂起超过 2 分钟的空档不计入总耗时——宁可少报，也不误杀。
 */
const CLOCK_JUMP_MS = LIMITS.clockJumpMs
let clockWallAt = Date.now()
let clockElapsed = 0

const monotonicNow = (): number => {
  const wall = Date.now()
  const delta = wall - clockWallAt
  if (delta > 0 && delta <= CLOCK_JUMP_MS) {
    clockElapsed += delta
  }
  clockWallAt = wall
  return clockElapsed
}

/**
 * 「从 startedAt 到现在过了多少毫秒」：对外报出的耗时一律走这里。
 * 单调源理论上不会倒退，仍再夹一次 0——详情里的耗时永远不许是负数。
 */
const elapsedSince = (startedAt: number): number => Math.max(0, Math.round(monotonicNow() - startedAt))

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
    durationMs: elapsedSince(startedAt),
    reason,
    // 只留 path（签名与 token 都在 query 里），否则事后无法把一条失败对上具体文件（#19）
    'url.path': redactUrl(url),
    ...extra,
    // error.msg 一律给：没有异常对象时用失败原因兜底，日志里不留空字段（#19）
    ...(error === undefined ? { 'error.msg': reason } : errorMeta(error)),
  })

/**
 * 整段下载的共享状态：停滞看门狗与心跳都读它（只读来记录/判定，不直接改业务结果）。
 *
 * `downloaded` 是原生侧确认已写入文件的字节数——它只会增长；`lastProgressAt` 是**停滞判定的
 * 唯一依据**，只在真的看到新字节时前移。
 */
type DownloadState = {
  startedAt: number
  downloaded: number
  total: number | undefined
  /** 最近一次「字节增长」的时刻：连续 stallMs 没有前移才判 stalled */
  lastProgressAt: number
  /** 停滞窗口（毫秒） */
  stallMs: number
  /** 防御性总上限的绝对截止时刻（= startedAt + 总上限） */
  deadline: number
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
  const now = monotonicNow()
  if (now >= state.deadline) {
    recordEvent('import_stage', 'import: download deadline exceeded', {
      stage: 'download',
      'download.bytes': state.downloaded,
      ...(state.total === undefined ? {} : { 'download.total': state.total }),
      'idle.ms': elapsedSince(state.lastProgressAt),
      'max.total.ms': state.deadline - state.startedAt,
    })
    return new DownloadDeadlineExceeded()
  }
  const idleMs = elapsedSince(state.lastProgressAt)
  if (idleMs < state.stallMs) {
    return null
  }
  recordEvent('import_stage', 'import: download stalled', {
    stage: 'download',
    'download.bytes': state.downloaded,
    ...(state.total === undefined ? {} : { 'download.total': state.total }),
    'idle.ms': idleMs,
    'stall.ms': state.stallMs,
  })
  return new DownloadStalled()
}

/**
 * 周期心跳：带「最近这一段新增了多少字节」，日志能直接区分「在推进」还是「停滞」。
 * 原生读被永久挂住时，这是唯一的在线证据（已下载多少 + 已经多久没新字节）。
 * 只记录，不中止业务；调用方必须在 finally 里停（成功/失败/取消/卸载都不能留 interval）。
 */
const startDownloadHeartbeat = (
  state: DownloadState,
  trace: ((entry: ImportTraceEntry) => void) | undefined,
  intervalMs: number
): (() => void) => {
  let lastBytes = state.downloaded
  const timer = setInterval(() => {
    const now = monotonicNow()
    const elapsed = elapsedSince(state.startedAt)
    const delta = state.downloaded - lastBytes
    const idleMs = elapsedSince(state.lastProgressAt)
    recordEvent('import_stage', 'import: download heartbeat', {
      stage: 'download',
      'download.bytes': state.downloaded,
      ...(state.total === undefined ? {} : { 'download.total': state.total }),
      // 最近这一段的新增字节：>0 = 在推进；=0 且 idle.ms 一直涨 = 停滞
      'progress.bytes': delta,
      'progress.state': delta > 0 ? 'advancing' : 'stalled',
      'idle.ms': idleMs,
      'stall.leftMs': Math.max(0, state.lastProgressAt + state.stallMs - now),
      elapsedMs: elapsed,
    })
    // 详情只在「这一段时间没有新字节」时补一条：有进展时采样已经记过，
    // 心跳的作用是证明还活着、以及停滞了多久，不是刷进度。
    if (delta <= 0) {
      trace?.({ at: elapsed, kind: 'heartbeat', bytes: state.downloaded, totalBytes: state.total, idleMs })
    }
    lastBytes = state.downloaded
  }, intervalMs)
  return () => clearInterval(timer)
}

/** 非 2xx：403 按 OBS 错误码细分（链接过期 / 签名错误 / 其他），其余按状态码。 */
const failForStatus = (
  status: number,
  body: string,
  url: string,
  startedAt: number,
  downloaded: number,
  total: number | undefined,
  trace?: (entry: ImportTraceEntry) => void
): never => {
  // 错误体由原生侧读回（前 4KB）：403 的 OBS 错误码在里面，靠它区分「链接过期」与「签名被改」。
  const detail = serverDetail(body)
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
      trace?.({ at: elapsedSince(startedAt), kind: 'error', status, bytes: downloaded, totalBytes: total, message: 'signature' })
      return fail('historyImportUrlBadSignature')
    }
    if (/RequestTimeTooSkewed|Expired/i.test(detail)) {
      recordDownloadFailure('expired', url, startedAt, meta)
      trace?.({ at: elapsedSince(startedAt), kind: 'error', status, bytes: downloaded, totalBytes: total, message: 'expired' })
      return fail('historyImportUrlExpired')
    }
    recordDownloadFailure('forbidden', url, startedAt, meta)
    trace?.({ at: elapsedSince(startedAt), kind: 'error', status, bytes: downloaded, totalBytes: total, message: 'forbidden' })
    return fail('historyImportUrlForbidden', { detail: detail === '' ? `HTTP ${status}` : detail })
  }
  recordDownloadFailure(`http-${status}`, url, startedAt, meta)
  trace?.({ at: elapsedSince(startedAt), kind: 'error', status, bytes: downloaded, totalBytes: total, message: `http-${status}` })
  return fail('historyImportUrlHttp', { status })
}

/**
 * 原生侧的失败原文 → 用户文案。
 *
 * 分档与旧的分块实现完全一致（离线 → 永久性错误 → 超时 → 够不到 → 传输中断 → 其他），
 * 因为依据一直是**错误原文 + `navigator.onLine`**，与「怎么下载的」无关。
 */
const failDownloadError = (
  error: unknown,
  url: string,
  state: DownloadState,
  trace?: (entry: ImportTraceEntry) => void
): never => {
  const { startedAt, downloaded, total } = state
  const percent = total === undefined || total === 0 ? 0 : Math.round((downloaded / total) * 100)
  // 离线优先（#154）：`navigator.onLine === false` 是最权威的信号，不必等错误串匹配。
  if (!isBrowserOnline()) {
    recordDownloadFailure('offline', url, startedAt, { 'download.bytes': downloaded }, error)
    trace?.({ at: elapsedSince(startedAt), kind: 'error', bytes: downloaded, totalBytes: total, message: 'offline' })
    return fail('historyImportUrlOffline')
  }
  // 永久性错误（#154）：地址本身不可用（禁用端口 / 非法协议），再试多少次都一样。
  // 离线时**不**套用这条：手机只是暂时没网，错误串却常常与「端口被禁」长得一样。
  if (isPermanentFailure(error)) {
    recordDownloadFailure('permanent', url, startedAt, { 'download.bytes': downloaded }, error)
    trace?.({ at: elapsedSince(startedAt), kind: 'error', bytes: downloaded, totalBytes: total, message: 'permanent' })
    // 专属文案（historyImportUrlBlocked）留作 follow-up：复用「请输入以 http(s):// 开头的链接」——
    // 它指向**地址本身**有问题，不会诱导用户反复重试。
    return fail('historyImportUrlInvalid')
  }
  if (isTimeout(error)) {
    // 超时且已经下到一半：说明链路慢，不是链接坏了。
    recordDownloadFailure('timeout', url, startedAt, { 'download.bytes': downloaded, percent }, error)
    trace?.({ at: elapsedSince(startedAt), kind: 'error', bytes: downloaded, totalBytes: total, message: 'timeout' })
    return downloaded > 0
      ? fail('historyImportUrlTimeoutPartial', { percent })
      : fail('historyImportUrlTimeout')
  }
  if (isUnreachable(error)) {
    // 「够不到网络」再分成两档（#111 / #18）：ECONNREFUSED / Connection refused 说明链路通、
    // 对面没在监听 → refused；其余（DNS 解析不到 / 路由不可达 / 切网瞬间断链）是
    // 「有网但连不上服务」→ unreachable，文案指向导入服务本身。
    const classified = classifyImportFailure({ error, online: isBrowserOnline() })
    const tier: ImportFailureReason =
      classified === 'refused' ? 'refused' : classified === 'offline' ? 'offline' : 'unreachable'
    recordDownloadFailure(tier, url, startedAt, { 'download.bytes': downloaded }, error)
    trace?.({ at: elapsedSince(startedAt), kind: 'error', bytes: downloaded, totalBytes: total, message: tier })
    return fail(IMPORT_FAILURE_KEYS[tier])
  }
  if (isStreamBroken(error)) {
    recordDownloadFailure('interrupted', url, startedAt, { 'download.bytes': downloaded, percent }, error)
    trace?.({ at: elapsedSince(startedAt), kind: 'error', bytes: downloaded, totalBytes: total, message: 'interrupted', status: 0 })
    return fail('historyImportUrlInterrupted', { percent })
  }
  recordDownloadFailure('network', url, startedAt, { 'download.bytes': downloaded }, error)
  trace?.({ at: elapsedSince(startedAt), kind: 'error', bytes: downloaded, totalBytes: total, message: 'network' })
  return fail('historyImportUrlNetwork')
}

const isZipHead = (bytes: Uint8Array): boolean =>
  bytes.length >= ZIP_MAGIC.length && ZIP_MAGIC.every((byte, index) => bytes[index] === byte)

/**
 * 原生侧把下载判了「失败」时抛这个：**不在这里决定用户看到什么**，因为还不确定这是
 * 「抖了一下」还是「真连不上」——先按现行分类看能不能再试一次（#105 / #154 的承诺：
 * 瞬时可重试、永久性错误不重试），试完仍是失败才翻译成人话。
 */
class NativeFailure extends Error {
  /** 原生给的原文（异常类名 / `INCOMPLETE: got X of Y`），分类全靠它 */
  readonly reason: Error
  /** 这一轮的落点：重试要接着这个文件续传，收口时它会被 discard 删掉 */
  readonly path?: string

  constructor(reason: Error, path?: string) {
    super(reason.message)
    this.name = 'NativeFailure'
    this.reason = reason
    this.path = path
  }
}

/**
 * 一次下载尝试：起原生下载 → 轮询到 done → 按区间校验 ZIP 头，成功返回临时文件句柄。
 *
 * 只做「这一轮」的事：失败就抛 {@link NativeFailure}，由 {@link downloadArchive} 决定
 * 是否再来一轮。这样重试逻辑只有一处，停滞/总上限这类**不可重试**的判定也不会被误当成网络抖动。
 */
const attemptDownload = async (
  url: string,
  options: UrlImportOptions,
  state: DownloadState,
  trace: ((entry: ImportTraceEntry) => void) | undefined,
  maxBytes: number,
  resume: { path: string; from: number } | undefined,
  report: (bytes: number) => void
): Promise<NativeArchiveHandle> => {
  throwIfCancelled(options.signal)
  const start = await nativeArchive.start({
    url,
    maxBytes,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    readTimeoutMs: Math.max(state.stallMs * 2, LIMITS.importChunkReadMs),
    // 只有「同一次导入里的重试」才会带续传点：跨导入的续传已按 #34 目标 3 移除
    ...(resume === undefined ? {} : { path: resume.path, resumeFrom: resume.from }),
  })
  // 关闭条件 3：声明总量超限 —— 原生侧在写第一个字节前就断开了，这里只是把结论翻成人话
  if (start.state === 'tooLarge') {
    return tooLarge(maxBytes, start.declared)
  }
  if (start.state === 'http') {
    return failForStatus(start.status, start.body, url, state.startedAt, 0, undefined, trace)
  }
  if (start.state === 'failed') {
    throw new NativeFailure(new Error(start.error))
  }
  // 服务端不认 Range 时原生侧已经把文件截断重来：计数必须跟着归零，否则进度会凭空跳涨
  if (start.restarted) {
    state.downloaded = 0
  }
  state.total = start.total
  if (state.total !== undefined && state.total > maxBytes) {
    tooLarge(maxBytes, state.total)
  }
  if (start.bytes > 0) {
    report(start.bytes)
  }
  for (;;) {
    const progress = await nativeArchive.progress()
    if (progress.total !== undefined && state.total === undefined) {
      state.total = progress.total
      if (state.total > maxBytes) {
        tooLarge(maxBytes, state.total)
      }
    }
    // 只认「字节真的增长」：这是停滞判定的唯一依据（#38）。
    if (progress.bytes > state.downloaded) {
      report(progress.bytes)
    }
    if (progress.state === 'done') {
      break
    }
    if (progress.state === 'failed') {
      throw new NativeFailure(new Error(progress.error ?? 'native download failed'), start.path)
    }
    if (progress.state === 'idle') {
      // 原生侧丢了状态（理论上不该发生）：当成链路中断，绝不静默当成成功。
      throw new NativeFailure(new Error('native download state lost: EOF'), start.path)
    }
    throwIfCancelled(options.signal)
    const verdict = stallVerdict(state)
    if (verdict !== null) {
      throw verdict
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throwIfCancelled(options.signal)
  if (state.downloaded === 0) {
    recordDownloadFailure('empty', url, state.startedAt, { 'download.bytes': 0 })
    return fail('historyImportUrlBadResponse')
  }
  if (state.total !== undefined && state.downloaded < state.total) {
    // 声明了总量却没到：绝不能当成功导入（原生侧也会回 failed，这里是第二道闸）。
    recordDownloadFailure('incomplete', url, state.startedAt, {
      'download.bytes': state.downloaded,
      'download.total': state.total,
    })
    return fail('historyImportUrlInterrupted', {
      percent: Math.round((state.downloaded / state.total) * 100),
    })
  }
  // ZIP 头：只读 4 个字节（按区间），不需要把整包读回来判格式。
  let head: Uint8Array
  try {
    head = await nativeArchive.read(start.path, 0, Math.min(ZIP_MAGIC.length, state.downloaded))
  } catch (error) {
    recordDownloadFailure('read-head', url, state.startedAt, { 'download.bytes': state.downloaded }, error)
    trace?.({ at: elapsedSince(state.startedAt), kind: 'error', message: 'read-failed' })
    return fail('historyImportUrlBadResponse')
  }
  if (!isZipHead(head)) {
    recordDownloadFailure('not-zip', url, state.startedAt, { 'download.bytes': state.downloaded })
    trace?.({ at: elapsedSince(state.startedAt), kind: 'error', message: 'not-zip' })
    return fail('historyImportUrlNotZip')
  }
  return { kind: 'native', path: start.path, size: state.downloaded }
}

/**
 * 流式下载（含同一次导入内的重试）并校验 ZIP 头。产出的是**临时文件句柄**（路径 + 长度），
 * 不是内存里的整包。
 *
 * 终态判定（#38 的纪律，流式化之后照旧）：
 * - 停滞（DownloadStalled）：连续 DOWNLOAD_STALL_MS 没有新字节才判死；
 *   慢但在推进的链路每次看到新字节就会重新计时，因此不会被误杀。
 * - 总上限（DownloadDeadlineExceeded）：防御性 30 分钟，只防「永远慢慢爬、永远下不完」。
 * - 全程每 HEARTBEAT_INTERVAL_MS 一条心跳，日志/详情里能直接区分「在推进」和「停滞」。
 *
 * 重试（#105 / #154 的既有承诺，搬实现时不许悄悄删掉）：原生侧报错时，只要分类结果
 * **可重试**（不是「地址本身不可用」）就带着已写入的字节再来一轮，总共
 * `LIMITS.importAttempts` 轮。续传点只在同一次导入内有效：导入一结束（成功/失败/取消），
 * 临时文件一律删掉，所以它不构成跨导入的续传缓存（#34 目标 3）。
 *
 * 临时文件的生命周期（目标 3）：**成功、失败、取消都收干净**——失败/取消走
 * `nativeArchive.discard()`（原生侧同步删完再返回），成功则交回句柄、由调用方在
 * 导入结束后 `remove()`。所以失败之后不会留下半截包（关闭条件 4）。
 */
const downloadArchive = async (
  url: string,
  options: UrlImportOptions,
  trace?: (entry: ImportTraceEntry) => void
): Promise<NativeArchiveHandle> => {
  const startedAt = monotonicNow()
  const maxBytes = resolveMaxImportBytes(options.maxBytes)
  const stallMs = Math.max(1, options.downloadStallMs ?? DOWNLOAD_STALL_MS)
  const maxTotalMs = Math.max(1, options.downloadMaxTotalMs ?? DOWNLOAD_MAX_TOTAL_MS)
  const state: DownloadState = {
    startedAt,
    downloaded: 0,
    total: undefined,
    lastProgressAt: startedAt,
    stallMs,
    deadline: startedAt + maxTotalMs,
  }
  recordEvent('import_stage', 'import: download archive', {
    stage: 'download',
    'stall.ms': stallMs,
    'max.total.ms': maxTotalMs,
    'limit.bytes': maxBytes,
    // 落点：原生流式写 App 私有目录，过桥的只有计数
    sink: 'native-cache-file',
    attempts: LIMITS.importAttempts,
  })
  const stopHeartbeat = startDownloadHeartbeat(
    state,
    trace,
    Math.max(1, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  )
  /** 是否真的产出了可导入的文件：决定 finally 里保留还是丢弃临时文件 */
  let delivered = false
  let lastTraceBytes = 0
  let lastTracePercent = -1
  let lastTraceAt = 0
  /** 每次「字节增长」都报进度，并把「首个 / 每 10% / ≥1s」采样写进详情。 */
  const reportBytes = (bytes: number) => {
    state.downloaded = bytes
    state.lastProgressAt = monotonicNow()
    if (state.downloaded > maxBytes) {
      tooLarge(maxBytes, state.downloaded)
    }
    options.onProgress?.({
      phase: 'downloading',
      downloadedBytes: state.downloaded,
      totalBytes: state.total,
    })
    const percent = state.total ? Math.floor((state.downloaded / state.total) * 10) : undefined
    const checkpoint =
      lastTraceBytes === 0 ||
      (percent !== undefined && percent !== lastTracePercent) ||
      monotonicNow() - lastTraceAt >= 1000
    if (checkpoint) {
      lastTraceBytes = state.downloaded
      lastTracePercent = percent ?? 0
      lastTraceAt = monotonicNow()
      trace?.({
        at: elapsedSince(startedAt),
        kind: 'download',
        bytes: state.downloaded,
        totalBytes: state.total,
      })
    }
  }
  /** 上一轮尝试的落点：续传时接着写，收口时交给 discard 删 */
  let retryPath: string | undefined
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const handle = await attemptDownload(
          url,
          options,
          state,
          trace,
          maxBytes,
          retryPath === undefined ? undefined : { path: retryPath, from: state.downloaded },
          reportBytes
        )
        delivered = true
        return handle
      } catch (error) {
        if (!(error instanceof NativeFailure)) {
          throw error
        }
        // 取消优先：用户点了取消时，原生侧报的「失败」只是被 disconnect 打断的结果。
        throwIfCancelled(options.signal)
        // 可重试 = 还没到轮数上限，且分类结果不是「地址本身不可用」（#154）。
        const canRetry = attempt < Math.max(1, LIMITS.importAttempts) && !isPermanentFailure(error.reason)
        if (!canRetry) {
          return failDownloadError(error.reason, url, state, trace)
        }
        retryPath = error.path
        // 重试不改总上限（它约束的是整次导入），但停滞窗口要从这一轮重新计时：
        // 「停住 40s」指的是这轮读不动，不是把上一轮的空转累加进来。
        state.lastProgressAt = monotonicNow()
        record('warning', 'warn', 'import: download retry', {
          stage: 'download',
          attempt,
          'download.bytes': state.downloaded,
          // 续不续得上取决于服务端是否认 Range；这里只记下打算从哪儿继续
          'resume.from': retryPath === undefined ? 0 : state.downloaded,
          ...errorMeta(error.reason),
        })
      }
    }
  } catch (error) {
    // 取消优先：用户点了取消时，看门狗只是把挂起的下载解开，不能算成「下载失败」。
    if (error instanceof DownloadStalled || error instanceof DownloadDeadlineExceeded) {
      throwIfCancelled(options.signal)
    }
    const { downloaded, total } = state
    const meta = {
      'download.bytes': downloaded,
      ...(total === undefined ? {} : { 'download.total': total }),
      retryable: 'yes',
    }
    if (error instanceof DownloadStalled) {
      const idleMs = elapsedSince(state.lastProgressAt)
      const seconds = Math.max(1, Math.round(state.stallMs / 1000))
      recordDownloadFailure('stalled', url, startedAt, {
        ...meta,
        'idle.ms': idleMs,
        'stall.ms': state.stallMs,
      })
      trace?.({
        at: elapsedSince(startedAt),
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
      // 预算耗尽 ≠ 无响应：字节其实一直在涨，只是没在下限内跑完（#152）。
      // 把「按当前常量至少要多快」一起记进诊断，常量之间一旦不自洽，这里当场就看得出来。
      recordDownloadFailure('deadline', url, startedAt, {
        ...meta,
        'max.total.ms': maxTotalMs,
        'min.bytes.per.sec': MIN_REQUIRED_BYTES_PER_SEC,
        // 与 stalled 那条对齐：不看这个数，日志里分不清「一直在推进但太慢」和「根本没动静」
        'idle.ms': elapsedSince(state.lastProgressAt),
      })
      trace?.({
        at: elapsedSince(startedAt),
        kind: 'error',
        bytes: downloaded,
        totalBytes: total,
        idleMs: elapsedSince(state.lastProgressAt),
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
    // 目标 3：成功时把文件**留给**解析阶段（导入结束后删），失败/取消时立刻删干净。
    // 原生侧 `discard()` 是在返回前同步删完的，所以这里 await 之后磁盘上已经没有这个文件了。
    try {
      await (delivered ? nativeArchive.release() : nativeArchive.discard())
    } catch (error) {
      // 清理失败不能盖住真实失败原因：只记一条，让调用方的错误照原样冒出去。
      record('warning', 'warn', 'import: native download cleanup failed', {
        stage: 'download',
        delivered,
        ...errorMeta(error),
      })
    }
  }
}

/**
 * 直链导入：校验 URL → 原生流式下载落盘（实时进度，可取消）→ 按区间校验 ZIP → 解析 →
 * 逐会话导入（进度 n/总数）→ 删临时文件。
 * 取消：下载期间不再接受字节、临时文件当场删除；导入期间在条目边界中断，暂存被清空、正式数据不变。
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
  const startedAt = monotonicNow()
  const trace = options.onTrace
  const emit = (entry: Omit<ImportTraceEntry, 'at'>) => trace?.({ at: elapsedSince(startedAt), ...entry })
  emit({ kind: 'start' })
  let lastSessionTraceAt = 0
  let lastImageTraceAt = 0
  let lastImages = 0
  let checkReported = false
  /** 下载落盘的临时文件：无论成功、失败还是取消，都在 finally 里删掉（目标 3）。 */
  let archivePath: string | undefined
  try {
    const archive = await downloadArchive(link, options, trace)
    archivePath = archive.path
    // 下载期间点了取消：结果直接丢弃，不进入暂存与替换事务。
    throwIfCancelled(options.signal)
    options.onProgress?.({ phase: 'decoding' })
    emit({ kind: 'check', bytes: archive.size })
    // 解析链路拿到的不是 `File`，而是「按区间读这个临时文件」的读口（内存与包体解耦）。
    return await importHistory(nativeArchive.reader(archive), {
      signal: options.signal,
      onProgress: (progress) => {
        options.onProgress?.({
          phase: 'importing',
          processed: progress.sessions,
          totalSessions: progress.totalSessions,
        })
        const now = monotonicNow()
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
    // 归档已经下完，卡在**读取**（文件 / 原生区间读）这一层（#195）：
    // WebView 只会抛英文原文，直接冒到界面上用户既不知道包其实下完了，也不知道该做什么。
    // 原始 name / message 只留在诊断与 console，界面换成能照着做的本地化文案。
    if (isArchiveReadFailure(error)) {
      record('import_error', 'error', 'import failed: archive unreadable after download', {
        stage: 'import',
        ...errorMeta(error),
      })
      // 用户文案已经本地化了，原始英文只在这里和诊断里留一份，方便支持人员定位
      // eslint-disable-next-line no-console
      console.error('[import] archive could not be read on this device', error)
      emit({ kind: 'error', message: 'read-failed' })
      fail(ARCHIVE_READ_FAILURE_KEY)
    }
    // 下载阶段的失败已经在原处带过状态与原因；这里补「校验/导入阶段」的失败事实。
    const isDownloadFailure = error instanceof BackupError && error.key.startsWith('historyImportUrl')
    if (!isDownloadFailure) {
      emit({ kind: 'error', message: error instanceof BackupError ? error.key : 'unknown' })
    }
    throw error
  } finally {
    // 目标 3 的最后一道：成功导入完、或任何一条失败/取消路径，临时文件都不留在设备上。
    if (archivePath !== undefined) {
      try {
        await nativeArchive.remove(archivePath)
      } catch (error) {
        record('warning', 'warn', 'import: temp archive cleanup failed', {
          stage: 'import',
          ...errorMeta(error),
        })
      }
    }
  }
}

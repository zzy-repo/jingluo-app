import type { TranslationKey } from '../../../i18n/index.js'

/**
 * 导入失败的可读原因（#111）。
 *
 * 过去 `historyImportUrlOffline`（「网络已断开，请检查网络后重试」）一句同时背了三种完全不同的原因：
 * 真的没网、连接被拒绝（服务没在监听）、服务可达但返回错误。用户看到「网络已断开」时网络往往好好的，
 * 于是只能怀疑是自己手机的问题。这里把「判断原因」抽成一个不碰浏览器 / 网络 / i18n 运行时的纯函数，
 * 让三档原因可以被普通 Node 单测钉住。
 */
export type ImportFailureReason = 'offline' | 'unreachable' | 'refused' | 'server'

/** 分档需要的全部信号：原始异常、HTTP 状态码、浏览器的在线读数。 */
export type ImportFailureSignals = {
  /** 原生桥 / fetch 抛出的原始异常；原生层的失败原因几乎只剩 message。 */
  error?: unknown
  /** 拿到响应时的 HTTP 状态码（4xx / 5xx 属「服务可达但返回错误」）。 */
  status?: number
  /** `navigator.onLine` 的读数；拿不到时不要传，默认按「在线」处理。 */
  online?: boolean
}

/**
 * 浏览器/系统**明确说自己没网**：只有这一句算「真的断网」。
 * 其余「够不到」的写法（DNS 解析失败、路由不可达）都可能是网络通的、只是到不了服务，
 * 那些归 unreachable 档（#18：过去它们全被说成「网络已断开」，用户照着改网络怎么都修不好）。
 */
const OFFLINE_PATTERN = /net::err_internet_disconnected/i

/**
 * 有网但够不到服务：DNS 解析不到、路由不可达、切网瞬间链路失效。
 * 与 offline 的区别是**用户的网络多半是好的**，所以文案要指向「导入服务」而不是「检查你的网络」；
 * 与 refused 的区别是链路本身没通（refused 是链路通了、对面没在监听）。
 */
const UNREACHABLE_PATTERN =
  /unable to resolve host|unknownhost|no address associated with hostname|network is unreachable|ehostunreach|enetunreach|enetdown|no route to host|net::err_name_not_resolved|net::err_network_changed|net::err_network_access_denied|net::err_address_unreachable|net::err_timed_out/i

/**
 * 连接被拒绝 / 服务未监听：链路是通的，是服务器那端没接。
 * 这条最容易和「真的断网」混在一起，所以单独一档，文案里要指向「服务端」而不是「你的网络」。
 */
const REFUSED_PATTERN = /econnrefused|connection refused|failed to connect|net::err_connection_refused/i

/** 超时：请求发出去了但对面没在规定时间内回话（原生层与 WebView 的两种写法）。 */
const TIMEOUT_PATTERN = /timeout|timed out|time out/i

/** 服务端明确回了错误：状态码已经在错误原文里（WebView 下 fetch 只给这一句）。 */
const SERVER_PATTERN =
  /net::err_http_response_code_failure|net::err_empty_response|net::err_content_length_mismatch|http \d{3}|bad gateway|service unavailable|internal server error|gateway timeout/i

const errorText = (error: unknown): string =>
  error instanceof Error ? `${error.name} ${error.message}` : String(error)

/**
 * 把一次导入失败归到三档之一；认不出来就返回 null ——
 * 宁可让调用方走原有的通用文案，也不要把无关的失败硬说成「断网」。
 */
export const classifyImportFailure = (signals: ImportFailureSignals = {}): ImportFailureReason | null => {
  const { error, status, online } = signals
  // 浏览器自己说没网：这是最权威的信号，优先于任何错误码。
  if (online === false) {
    return 'offline'
  }
  // 已经拿到响应（状态码）说明服务是可达的，问题是它回了错误。
  if (status !== undefined && status >= 400) {
    return 'server'
  }
  const text = error === undefined ? '' : errorText(error)
  // 顺序要紧：refused 与 timeout 的原文里常含 offline 关键词的近义写法，先判更具体的。
  if (REFUSED_PATTERN.test(text)) {
    return 'refused'
  }
  if (TIMEOUT_PATTERN.test(text)) {
    return 'server'
  }
  // 顺序：offline（系统明说没网）→ unreachable（有网够不到服务），两者文案不同，不能合并。
  if (OFFLINE_PATTERN.test(text)) {
    return 'offline'
  }
  if (UNREACHABLE_PATTERN.test(text)) {
    return 'unreachable'
  }
  if (SERVER_PATTERN.test(text)) {
    return 'server'
  }
  return null
}

/**
 * 每档原因对应的人话文案 key。
 * offline 沿用用户已经习惯的那句；unreachable 是 #18 新增的一档（过去它和 offline 共用一句，
 * 于是「网络是通的、只是连不上导入服务」被说成「网络已断开」）；
 * server 直接复用既有的「链接返回了异常状态（HTTP {status})」，
 * 超时另有更精确的 historyImportUrlTimeout / historyImportUrlTimeoutPartial，两者都不说「断网」。
 */
export const IMPORT_FAILURE_KEYS: Record<ImportFailureReason, TranslationKey> = {
  offline: 'historyImportUrlOffline',
  unreachable: 'historyImportUrlUnreachable',
  refused: 'historyImportUrlRefused',
  server: 'historyImportUrlHttp',
}

/**
 * 归档**读取**失败的识别（#195）。
 *
 * 包已经完整下到本地、准备解析时，WebView 读 `File` / `Blob` 失败只会给一个纯英文 DOMException：
 * 「The requested file could not be read, typically due to permission problems that have occurred
 *   after a reference to a file was acquired.」——用户既不知道该干什么，也看不到「其实已经下完了」。
 * 这里只负责认出「这是读取失败」，文案由调用方换成本地化 key，原始 name / message 只进诊断与 console。
 *
 * 认名字优先（WebView 稳定给出 DOMException.name），名字丢了才退回文本匹配。
 * `AbortError` 属于用户取消，不在此列；网络类（UnknownHost / ConnectException）也不能被当成读取失败。
 */
const READ_FAILURE_NAMES = new Set([
  'NotReadableError',
  'NotFoundError',
  'NotAllowedError',
  'SecurityError',
  'InvalidStateError',
  'EncodingError',
  'TypeMismatchError',
])

/** 名字之外的最后一道保险：WebView 偶尔只把原文塞进 message。 */
const READ_FAILURE_PATTERN =
  /could not be read|could not be loaded|not been read|has been closed|the requested file|readasarraybuffer|filereader/i

/** 这个异常是不是「归档在本机读不出来」（File / FileReader / Blob 的读取类 DOMException）。 */
export const isArchiveReadFailure = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') {
    return false
  }
  const { name, message } = error as { name?: unknown; message?: unknown }
  if (typeof name === 'string' && READ_FAILURE_NAMES.has(name)) {
    return true
  }
  const text = `${typeof name === 'string' ? name : ''} ${typeof message === 'string' ? message : ''}`
  return READ_FAILURE_PATTERN.test(text)
}

/** 读取失败只给一档人话：「归档已经下完，但本机读不出来」，具体原文只进诊断。 */
export const ARCHIVE_READ_FAILURE_KEY: TranslationKey = 'historyImportReadFailed'

/** 浏览器 / WebView 的在线读数；读不到就当在线，不替用户下结论。 */
export const isBrowserOnline = (): boolean => {
  try {
    return navigator.onLine !== false
  } catch {
    return true
  }
}

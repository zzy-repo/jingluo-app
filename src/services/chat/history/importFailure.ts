import type { TranslationKey } from '../../../i18n/index.js'

/**
 * 导入失败的可读原因（#111）。
 *
 * 过去 `historyImportUrlOffline`（「网络已断开，请检查网络后重试」）一句同时背了三种完全不同的原因：
 * 真的没网、连接被拒绝（服务没在监听）、服务可达但返回错误。用户看到「网络已断开」时网络往往好好的，
 * 于是只能怀疑是自己手机的问题。这里把「判断原因」抽成一个不碰浏览器 / 网络 / i18n 运行时的纯函数，
 * 让三档原因可以被普通 Node 单测钉住。
 */
export type ImportFailureReason = 'offline' | 'refused' | 'server'

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
 * 真的够不到网络：DNS 解析失败、网络不可达、浏览器自己说离线。
 * 注意这里**不含** `connection refused` —— 那是网络通、对面没监听，属于 refused 档。
 */
const OFFLINE_PATTERN =
  /unable to resolve host|unknownhost|no address associated with hostname|network is unreachable|ehostunreach|enetunreach|net::err_internet_disconnected|net::err_name_not_resolved|net::err_network_changed|net::err_network_access_denied/i

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
  if (OFFLINE_PATTERN.test(text)) {
    return 'offline'
  }
  if (SERVER_PATTERN.test(text)) {
    return 'server'
  }
  return null
}

/**
 * 每档原因对应的人话文案 key。
 * offline 沿用用户已经习惯的那句；server 直接复用既有的「链接返回了异常状态（HTTP {status}）」，
 * 超时另有更精确的 historyImportUrlTimeout / historyImportUrlTimeoutPartial，两者都不说「断网」。
 */
export const IMPORT_FAILURE_KEYS: Record<ImportFailureReason, TranslationKey> = {
  offline: 'historyImportUrlOffline',
  refused: 'historyImportUrlRefused',
  server: 'historyImportUrlHttp',
}

/** 浏览器 / WebView 的在线读数；读不到就当在线，不替用户下结论。 */
export const isBrowserOnline = (): boolean => {
  try {
    return navigator.onLine !== false
  } catch {
    return true
  }
}

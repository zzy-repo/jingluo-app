/**
 * 「我们的渠道」卡密服务的传输层：原生走 CapacitorHttp，Web 走 fetch。
 *
 * 为什么放在单独文件：api.ts 是纯逻辑（Node 单测直接 import），
 * 而 @capacitor/core 只在这里出现，Web 端 fetch 也可以被 Playwright 的 page.route 打桩，
 * CORS 失败只当作「网络不可用」，不影响业务逻辑本身。
 *
 * 共同约束：**不跟随重定向**（原生 disableRedirects、Web redirect:'manual'），
 * /buy 需要读 302 的 Location；超时与连不上分开上报，文案也不同。
 */
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { isOpenableCheckout, type OursHttpRequest, type OursHttpResult } from './api.js'

/** 原生「用系统浏览器打开收银台」插件（ACTION_VIEW，只放行 https） */
type CheckoutBrowserPlugin = { open: (options: { url: string }) => Promise<{ opened?: boolean }> }
const CheckoutBrowser = registerPlugin<CheckoutBrowserPlugin>('CheckoutBrowser')

export const isNativePlatform = (): boolean => Capacitor.isNativePlatform()

const TIMEOUT_HINTS = ['timeout', 'timed out', 'time out']

const reasonOf = (error: unknown): 'timeout' | 'network' => {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  const lower = text.toLowerCase()
  return lower.includes('abort') || TIMEOUT_HINTS.some((hint) => lower.includes(hint))
    ? 'timeout'
    : 'network'
}

const nativeRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  const headers = request.headers
  try {
    const response = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      headers,
      // CapacitorHttp 会把对象序列化成 JSON；字符串原样发出，content-type 由 headers 决定
      data: request.body,
      responseType: 'text',
      connectTimeout: request.timeoutMs,
      readTimeout: request.timeoutMs,
      // 关键：不跟随 302，让 /buy 能把 Location 带回来
      disableRedirects: true,
    })
    const rawHeaders = (response.headers ?? {}) as Record<string, string>
    const location = rawHeaders.location ?? rawHeaders.Location ?? ''
    const text =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null)
    return { kind: 'response', status: response.status, text, location }
  } catch (error) {
    return { kind: reasonOf(error) }
  }
}

const webRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 关键：不跟随重定向（跨域 302 在浏览器里是 opaqueredirect，读不到 body，
      // 但 Location 也拿不到 —— 这正是「不许跟随」的代价，Web 端不靠它取收银台地址）
      redirect: 'manual',
      signal: controller.signal,
    })
    const location = response.headers.get('location') ?? ''
    const text = await response.text()
    return { kind: 'response', status: response.status, text, location }
  } catch (error) {
    return { kind: reasonOf(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** 默认传输：原生 CapacitorHttp / Web fetch */
export const httpTransport = (request: OursHttpRequest): Promise<OursHttpResult> =>
  isNativePlatform() ? nativeRequest(request) : webRequest(request)

/**
 * 用系统浏览器打开收银台（ACTION_VIEW）。
 * 非 https 的地址一律拒绝：支付页必须是加密连接，明文地址既不安全也可能被劫持。
 */
export const openCheckout = async (url: string): Promise<boolean> => {
  if (!isOpenableCheckout(url)) {
    return false
  }
  if (isNativePlatform()) {
    try {
      await CheckoutBrowser.open({ url })
      return true
    } catch {
      return false
    }
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  return opened !== null
}

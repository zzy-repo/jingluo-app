/**
 * 「我们的渠道」的传输层：原生走 CapacitorHttp，Web 走 fetch。
 *
 * 为什么放在单独文件：api.ts / invite/api.ts 是纯逻辑（Node 单测直接 import），
 * 而 @capacitor/core 只在这里出现，Web 端 fetch 也可以被 Playwright 的 page.route 打桩，
 * CORS 失败只当作「网络不可用」，不影响业务逻辑本身。
 *
 * 三个导出：
 *  - `httpTransport`     业务默认传输：**不跟随重定向**（原生 disableRedirects、
 *                        Web redirect:'manual'）。原生 /buy 要读 302 的 Location。
 *  - `openCheckout`      用系统浏览器打开收银台（ACTION_VIEW，只放行 https）
 *  - `navigateTopLevel`  网页版购买：让浏览器自己跳过去（Issue #36）
 *
 * 网页版购买是**顶层导航**，不是 fetch：
 * 浏览器里 fetch(redirect:'manual') 按规范只能拿到 opaqueredirect（status 0、读不到 Location），
 * 而 `window.location.assign('/buy?plan=…')` 是跨域顶层跳转，不受 CORS 约束，也不需要读 Location ——
 * 302 目标里的签名、单号、金额后端已经全部拼好，浏览器照着跳就行。
 * 付款完成后收银台按 return_url 回跳，地址栏带 ?no=<out_trade_no>&order_token=<token>，
 * 由 services/ours/returnParams.ts 在启动时解析 → 进「订单查询」。
 *
 * 原生的兜底：CapacitorHttp 的 disableRedirects 理论上会带回 302 + location 头，
 * 但这一条在真机上还没验证过；读不到 location 时再走 CheckoutBrowser.resolveLocation
 * （原生 HttpURLConnection，instanceFollowRedirects=false）取一次 Location。
 */
import type { LinkedMessage } from '../../i18n/index.js'
import { ensureCustomerId, readCachedCustomerId } from './customerId.js'
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'
import { isOpenableCheckout, type OursHttpRequest, type OursHttpResult } from './api.js'

/** 原生「用系统浏览器打开收银台」插件（ACTION_VIEW，只放行 https） */
type CheckoutBrowserPlugin = {
  open: (options: { url: string }) => Promise<{ opened?: boolean }>
  /** 只取 302 的 Location（不跟随、不下载正文） */
  resolveLocation: (options: { url: string }) => Promise<{ status?: number; location?: string }>
}
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

/** 3xx 但响应头里没有 location（部分实现会把它丢掉）：问一次原生插件 */
const nativeLocationFallback = async (
  request: OursHttpRequest,
  status: number
): Promise<string> => {
  if (status < 300 || status >= 400 || request.method !== 'GET') {
    return ''
  }
  try {
    const resolved = await CheckoutBrowser.resolveLocation({ url: request.url })
    return (resolved.location ?? '').trim()
  } catch {
    return ''
  }
}

const nativeRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  try {
    const response = await CapacitorHttp.request({
      url: request.url,
      method: request.method,
      headers: request.headers,
      // CapacitorHttp 会把对象序列化成 JSON；字符串原样发出，content-type 由 headers 决定
      data: request.body,
      responseType: 'text',
      connectTimeout: request.timeoutMs,
      readTimeout: request.timeoutMs,
      // 关键：不跟随 302，让 /buy 能把 Location 带回来
      disableRedirects: true,
    })
    const rawHeaders = (response.headers ?? {}) as Record<string, string>
    const headerLocation = (rawHeaders.location ?? rawHeaders.Location ?? '').trim()
    const location =
      headerLocation !== '' ? headerLocation : await nativeLocationFallback(request, response.status)
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
      // 关键：不跟随重定向。跨域 302 在浏览器里是 opaqueredirect（status 0、没有 header），
      // 所以网页版**不靠 fetch 取收银台地址**，而是让浏览器顶层跳转到 buyUrl()（见 navigateTopLevel）
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

/** 默认传输：原生 CapacitorHttp / Web fetch，两者都不跟随重定向 */
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
  // 不用 'noopener' 特性串：带它时 window.open 一律返回 null，就分不清「打开了」和「被拦截」了。
  // 改成打开后把 opener 置空（同样断掉 opener 引用，但能判断是否真的打开了）。
  const opened = window.open(url, '_blank')
  if (opened === null) {
    return false
  }
  try {
    opened.opener = null
  } catch {
    // 跨域窗口设不了 opener 也没关系
  }
  return true
}

/**
 * 给我们的购买地址补上 cid 参数（Issue #115：下单一律带 cid）。
 *
 * 返回 null 表示「这条地址不能跳」：
 *  - 是我们的购买入口、但拿不到 cid → 不跳（建单必须知道订单属于谁）；
 *  - 地址解析不了 / 不是购买入口 → 原样返回，不干扰别的导航。
 */
export const withBuyCustomerId = (url: string, customerId: number | null): string | null => {
  const raw = url.trim()
  if (raw === '') {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw
  }
  if (!/\/buy$/u.test(parsed.pathname)) {
    return raw
  }
  const existing = (parsed.searchParams.get('cid') ?? '').trim()
  if (existing !== '') {
    return parsed.href
  }
  if (customerId === null) {
    return null
  }
  parsed.searchParams.set('cid', String(customerId))
  return parsed.href
}

/**
 * 网页版购买：让浏览器做**顶层导航**到 /buy?plan=<id>（Issue #36 的技术订正）。
 *
 * 为什么不是 fetch：`fetch(url, { redirect: 'manual' })` 在跨域时按规范只能拿到
 * `opaqueredirect`（status 0、没有任何 header），永远读不到 `Location`；
 * 而顶层导航是浏览器自己跳过去 —— 跨域顶层跳转不受 CORS 约束，也不需要读 Location。
 *
 * 为什么不用 window.open：回跳要落在**同一个标签页**，才能把 ?no=&order_token= 带回我们的页面。
 */
export const navigateTopLevel = (url: string): void => {
  const ready = withBuyCustomerId(url, readCachedCustomerId())
  if (ready !== null) {
    window.location.assign(ready)
    return
  }
  // 缓存里还没有 cid：先解析一次再跳。解析不出来就**不跳**——宁可什么都不发生，
  // 也不要建一张不带 cid 的单（Issue #115 那次付款后一直「等待支付」的成因）。
  void ensureCustomerId()
    .then((customerId) => {
      const target = withBuyCustomerId(url, customerId)
      if (target !== null) {
        window.location.assign(target)
      } else {
        warnMissingCustomerId()
      }
      return target
    })
    .catch(() => null)
}

/**
 * 兜底的用户提示：网页版才走这条同步路径（原生那边 startCheckout 会返回明确错误码给界面）。
 * 提示通道由 main.tsx 注入（`showToast`），服务层不 import 组件，也不弹原生 alert。
 */
type CustomerMissingNotice = (message: LinkedMessage) => void

let customerMissingNotice: CustomerMissingNotice | null = null

export const setCustomerMissingNotice = (next: CustomerMissingNotice | null): void => {
  customerMissingNotice = next
}

const warnMissingCustomerId = (): void => {
  customerMissingNotice?.({ key: 'oursErrCustomerMissing' })
}

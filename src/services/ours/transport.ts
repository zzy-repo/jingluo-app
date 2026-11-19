/**
 * 「我们的渠道」的传输层：原生走 CapacitorHttp，Web 走 fetch。
 *
 * 为什么放在单独文件：api.ts / invite/api.ts 是纯逻辑（Node 单测直接 import），
 * 而 @capacitor/core 只在这里出现，Web 端 fetch 也可以被 Playwright 的 page.route 打桩，
 * CORS 失败只当作「网络不可用」，不影响业务逻辑本身。
 *
 * 两个导出：
 *  - `httpTransport`     业务默认传输：**不跟随重定向**（原生 disableRedirects、Web redirect:'manual'）
 *  - `openPayLinkInApp`  在 App 内浏览器打开联动小铺收款页（Issue #331）
 *
 * Issue #331：支付切到联动小铺后我们**不再建单、也不再读收银台的 302 Location**，
 * 所以原来的 `openCheckout`（系统浏览器）/ `navigateTopLevel`（网页版顶层跳 `/buy`）/
 * `withBuyCustomerId`（给 `/buy` 补 cid）连同 `CheckoutBrowser.resolveLocation` 一起删除。
 * 收款页地址由 `/api/pay-link` 下发，App 内打开即可；付款后卡密由小铺直接发给买家。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { isOpenableCheckout, type OursHttpRequest, type OursHttpResult } from './api.js'

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
      // 关键：不跟随重定向（业务接口自己解释 3xx，见文件头）
      disableRedirects: true,
    })
    const rawHeaders = (response.headers ?? {}) as Record<string, string>
    const location = (rawHeaders.location ?? rawHeaders.Location ?? '').trim()
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
      // 关键：不跟随重定向，状态码与 Location 由调用方自己解释
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
 * Issue #331：在 App 内打开**联动小铺收款页**。
 *
 * `presentationStyle: 'popover'` —— iOS 卡片式内嵌、Android 全屏 WebView，**都在 App 内**，
 * 不会整页跳走（用户明确要求「页面内打开」）。所以这里**没有**系统浏览器降级：
 * 打不开就直接回 false，由界面给可读提示（绝不 `window.location` / `window.open` 兜底）。
 *
 * 约定：
 *  - 只放行 https；非原生（Web / 没有插件）一律返回 false
 *  - `onClosed` **最多回调一次**（重复触发、关闭与打开失败并存都只算一次）
 *  - 监听在 `open` **之前**注册：页面打开得极快时也不会漏掉第一次关闭
 *  - 返回 false 时监听已经摘掉，不会给下一次打开留下一个假回跳
 *  - `onClosed` 只代表「用户回来了」，**不代表付款成功**（卡密由小铺直接发给买家）
 */
export const openPayLinkInApp = async (url: string, onClosed: () => void): Promise<boolean> => {
  if (!isNativePlatform() || !isOpenableCheckout(url)) {
    return false
  }
  // `@capacitor/browser` 用**动态**引入：网页构建和单测里根本没有这个插件，
  // 静态 import 会让它们连模块都加载不起来（真实症状：tests/unit 里 ENOENT data:…）。
  // 只有原生端真要点「去支付」时才需要它。
  let browser: typeof import('@capacitor/browser').Browser
  try {
    const mod = await import('@capacitor/browser')
    browser = mod.Browser
  } catch {
    return false
  }
  let handle: { remove: () => Promise<void> } | null = null
  let fired = false
  const detach = async (): Promise<void> => {
    const target = handle
    handle = null
    if (target === null) {
      return
    }
    try {
      await target.remove()
    } catch {
      // 摘不掉也不影响：fired 已经保证回调只跑一次
    }
  }
  const finish = (): void => {
    if (fired) {
      return
    }
    fired = true
    void detach()
    onClosed()
  }
  try {
    handle = await browser.addListener('browserFinished', () => finish())
  } catch {
    // 插件没装（老 APK / Web）→ 当作「没有内嵌浏览器」
    return false
  }
  try {
    await browser.open({ url, presentationStyle: 'popover' })
    return true
  } catch {
    // 打不开就摘掉监听再返回 false：否则下一次支付的 browserFinished
    // 会在这里凭空触发一次「用户回来了」，查一张没付过的单。
    await detach()
    return false
  }
}

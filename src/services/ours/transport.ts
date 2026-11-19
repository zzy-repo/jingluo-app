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
 * 原生的建单（Issue #142）：/buy **只**走 `CheckoutBrowser.resolveLocation` 一次 ——
 * CapacitorHttp 的 disableRedirects 在 web 实现里根本不生效（302 会被跟随，状态码变成下一跳的，
 * 网关 429 就被当成本次下单失败），所以「取 Location」这件事只交给我们自己的 Java 实现
 * （HttpURLConnection + setInstanceFollowRedirects(false)）。其它业务请求照旧走 CapacitorHttp。
 */
import type { LinkedMessage } from '../../i18n/index.js'
import { ensureCustomerId, parseCustomerId, readCachedCustomerId } from './customerId.js'
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

/** 原生建单请求：只有 /buy 这一个 GET 需要读 3xx 的 Location */
const isBuyRequest = (request: OursHttpRequest): boolean => {
  if (request.method !== 'GET') {
    return false
  }
  try {
    const path = new URL(request.url).pathname
    // Issue #235：`/api/buy` 也以 `/buy` 结尾，但它是**返回 JSON 的建单接口**。
    // 交给 resolveLocation 只能拿到「状态码 + Location」，正文里的 pay_url 就丢了。
    return /\/buy$/u.test(path) && !/^\/api\//u.test(path)
  } catch {
    return false
  }
}

/**
 * 原生 /buy：**只**走 CheckoutBrowser.resolveLocation 一次（Issue #142）。
 *
 * 为什么不用 CapacitorHttp：
 *  - CapacitorHttp 的 web 实现根本不读 disableRedirects（@capacitor/core 只透传
 *    method/headers/body），302 会被跟随到收银台/网关那一跳，`status` 也就变成了**那一跳**的
 *    状态码；网关一限流（429），客户端就把别人的状态码当成本次下单的结果，界面出「请求过于频繁」，
 *    而真正的收银台地址已经在跟随中被丢掉了 —— 用户点一次「去支付」，什么也打不开。
 *  - resolveLocation 是我们自己的 Java 实现：
 *    `setInstanceFollowRedirects(false)` + 10s 超时，只回 `{status, location}`，
 *    拿到的状态码一定属于 /buy 这一跳。
 *  - 顺带把「一次点击打两次 /buy」也去掉了：老实现 302 但没带回 location 头时会**再问一次**
 *    插件，而 /buy 每 GET 一次就新建一张单。
 */
const nativeBuyRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), request.timeoutMs)
    })
    const resolved = await Promise.race([CheckoutBrowser.resolveLocation({ url: request.url }), timeout])
    const status = typeof resolved.status === 'number' ? resolved.status : 0
    const raw = (resolved.location ?? '').trim()
    // Location 允许是相对地址：按 /buy 的源补全，后面 parseCheckoutTarget 才认得出 https
    const location = raw.startsWith('/') ? `${new URL(request.url).origin}${raw}` : raw
    // 正文没用（302 没有正文，429 的正文只是给日志看的），状态码由 messageKeyFor 映射
    return { kind: 'response', status, text: '', location }
  } catch (error) {
    return { kind: reasonOf(error) }
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

const nativeRequest = async (request: OursHttpRequest): Promise<OursHttpResult> => {
  if (isBuyRequest(request)) {
    return nativeBuyRequest(request)
  }
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
 * 用 **App 内嵌浏览器** 打开收银台，并在用户关掉它（回到 App）的那一刻回调一次（Issue #235）。
 *
 * 为什么不再把人踢去系统浏览器：支付宝收银台在系统浏览器里付完款后，除非用户自己点
 * 「返回商家」，否则**不会**走 return_url —— 用户就停在浏览器里，App 在后台干等 60s 超时，
 * 切回来还是「等待支付」，得手动点「再查一次」才看到卡密。
 *
 * 内嵌浏览器（`@capacitor/browser`）把「关掉收银台」变成一个 App 内事件
 * （`browserFinished`），于是「用户回来了」可以被当成一次明确信号：立刻重查一单。
 *
 * 约定：
 *  - 只放行 https；非原生（Web / 没有插件）一律返回 false，由调用方降级到 `openCheckout`
 *  - `onClosed` **最多回调一次**（重复触发、关闭与打开失败并存都只算一次）
 *  - 监听在 `open` **之前**注册：收银台打开得极快时也不会漏掉第一次关闭
 *  - 返回 false 时监听已经摘掉，不会给下一次支付留下一个假回跳
 */
export const openCheckoutInApp = async (
  url: string,
  onClosed: () => void
): Promise<boolean> => {
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
    await browser.open({ url })
    return true
  } catch {
    // 打不开就摘掉监听再返回 false：否则下一次支付的 browserFinished
    // 会在这里凭空触发一次「用户回来了」，查一张没付过的单。
    await detach()
    return false
  }
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
  // Issue #135：`cid=` / `cid=NaN` / `cid=0` 在后端看来等于「没带 cid」，必须是正整数才算数。
  const existing = parseCustomerId(parsed.searchParams.get('cid'))
  if (existing !== null) {
    return parsed.href
  }
  const cid = parseCustomerId(customerId)
  if (cid === null) {
    return null
  }
  parsed.searchParams.set('cid', String(cid))
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
  customerMissingNotice?.({ key: 'oursErrCustomerNeedsKey' })
}

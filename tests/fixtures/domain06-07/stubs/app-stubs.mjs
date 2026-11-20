/**
 * 域 6+7 用例的**全部替身**（一个文件装齐，靠 harness 的 resolve 钩子按需映射）。
 *
 * 只替身「边界」，不替身被测逻辑：
 *   - 替身：设计系统组件（Button / Modal / toast）、i18n 绑定、渠道配置 store、剪贴板、
 *     传输层（`httpTransport`）与 App 内浏览器（`openPayLinkInApp`）—— 它们要么依赖 DOM / 原生插件，
 *     要么本身就是「外部世界」。
 *   - 保持真代码：`services/ours/*`、`services/invite/*`、两个弹层的 `.tsx`。
 *     所以用例断言的是真组件在假传输上**真发出去**的请求序列与真实文案。
 */

import { useStoreValue, markDirty } from '../mini-react.mjs'

const env = () => globalThis.__domain0607

// ------------------------------------------------------------------ 设计系统

export const Button = ({ children, ...props }) => {
  const { variant, size, className, testId, ...rest } = props
  return {
    type: 'button',
    key: null,
    props: {
      ...rest,
      type: 'button',
      'data-testid': testId ?? rest['data-testid'],
      className: className ?? undefined,
      children,
    },
  }
}

export const Modal = ({ children, footer, title, ...props }) => ({
  type: 'section',
  key: null,
  props: {
    'data-testid': props['data-testid'] ?? 'modal',
    'aria-label': typeof title === 'string' ? title : undefined,
    children: [children, footer],
  },
})

export const showToast = (message) => {
  env().toasts.push(String(message))
}

// ------------------------------------------------------------------ 渠道配置 store（替换 apiConfig）

export const useApiConfig = (selector) => useStoreValue(() => (selector ? selector(env()) : env()))

useApiConfig.getState = () => env()

export const setApiKey = (key) => {
  const context = env()
  context.apiKey = String(key)
  context.keyWrites.push(String(key))
  markDirty()
}

export const useIsOursChannel = () => true

/**
 * #451：Key 身份（绑定时间 / 最近一次确认可用时间），真实现见 `services/invite/keyIdentity.ts`
 * 与 `apiConfig.getCurrentKeyIdentity / recordKeySuccess`。
 *
 * 这里给**空态替身**而不是编一个假时间戳：域 6/7 的用例断言的是「打开弹层发了几条请求、
 * 界面说了哪句话」，时间戳不在断言范围内；给一个确切可信的「本机没有记录」比给假时间安全
 * （假时间会让「界面上的时间来自本机记录」这条变得无法核对）。
 */
export const getKeyIdentity = () => null

export const getCurrentKeyIdentity = () => ({ kind: 'none' })

/** 与真实现同一契约：没有 Key 时什么都不记（返回 false） */
export const recordKeySuccess = () => env().apiKey !== ''

/** 发送前拦截的三态（#451）；本替身只用来让「有 Key」的用例照常往下走 */
export const checkApiKeyBeforeSend = () => (env().apiKey === '' ? 'missing' : 'ok')

// ------------------------------------------------------------------ 设置页弹层开合（替换 settingsDialogState）

export const useSettingsDialog = (selector) =>
  useStoreValue(() => (selector ? selector(env()) : env()))

export const closeSettings = () => {
  env().settingsClosed += 1
  markDirty()
}

export const setOursServicesOpen = (open) => {
  env().oursOpen = open === true
  markDirty()
}

// ------------------------------------------------------------------ 剪贴板

export const copyText = async (text) => {
  const context = env()
  context.copied.push(String(text))
  return context.copyFails !== true
}

// ------------------------------------------------------------------ 传输层 / App 内浏览器（替换 services/ours/transport）

export const isNativePlatform = () => true

export const httpTransport = async (request) => {
  const context = env()
  const record = {
    method: request.method,
    url: request.url,
    path: new URL(request.url).pathname,
    headers: request.headers,
    body: request.body,
    json: request.body ? JSON.parse(request.body) : null,
  }
  context.requests.push(record)
  const responder = context.responder
  if (typeof responder !== 'function') {
    throw new Error(
      `域 6+7 用例：没有为 ${record.method} ${record.path} 准备响应（ctx.responder 未设置）`
    )
  }
  const reply = await responder(record)
  if (reply === undefined) {
    throw new Error(`域 6+7 用例：responder 没有返回 ${record.method} ${record.path} 的响应`)
  }
  return reply
}

/**
 * App 内打开收款页的替身。
 *
 * 守住被替身者的**对外契约**：只放行 https、打不开就返回 false、
 * 并且 `onClosed` **最多回调一次**（真实现见 services/ours/transport.ts 的 fired 标记；
 * 「只回调一次」本身由 tests/unit/pay-link.test.mjs[C] 在真 transport 上验）。
 * 用例拿 `ctx.browser.onClosed()` 模拟「用户关掉收款页回到 App」。
 */
export const openPayLinkInApp = async (url, onClosed) => {
  const context = env()
  if (!/^https:\/\//iu.test(String(url))) {
    return false
  }
  context.browser.opens.push(url)
  if (context.browser.rejectOpen) {
    return false
  }
  let fired = false
  context.browser.onClosed = () => {
    if (fired) {
      return
    }
    fired = true
    onClosed()
  }
  return true
}

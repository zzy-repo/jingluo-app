/**
 * REPRO ONLY（Issue #373）：把 @capacitor/core 替换成可编排的桥，用于在浏览器里跑真实
 * AppUpdateField（真实 React 组件 + 真实 downloadUpdate 服务），只把原生 AppUpdate 插件换掉。
 *
 * 不是产品代码，不参与构建产物；只在 tests/tools/repro-373 的 harness 构建里通过 rspack alias 生效。
 *
 * 行为由页面里的 `window.__bridge` 决定：
 *   window.__bridge.platform            平台字符串（'android' → isAndroidUpdate() === true）
 *   window.__bridge.handlers[method]    对应原生方法的实现，参数原样透传，返回 Promise 亦可
 */
type AnyHandler = (...args: unknown[]) => unknown

const bridge = () => (globalThis as unknown as { __bridge?: { platform?: string; handlers?: Record<string, AnyHandler> } }).__bridge

const method = (plugin: string, name: string) =>
  (...args: unknown[]): unknown => {
    const handler = bridge()?.handlers?.[name]
    if (typeof handler !== 'function') {
      throw new Error(`MOCK_METHOD_MISSING:${plugin}.${name}`)
    }
    return handler(...args)
  }

/** 没有实现的方法也要能拿到一个函数，避免组件在别处探测插件能力时直接崩掉 */
const proxyOf = (plugin: string) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, property) =>
      typeof property === 'string' ? method(plugin, property) : undefined,
  })

export const Capacitor = {
  getPlatform: () => bridge()?.platform ?? 'web',
  isNativePlatform: () => (bridge()?.platform ?? 'web') !== 'web',
  registerPlugin: (name: string) => proxyOf(name),
  nativePromise: (plugin: string, name: string, options?: unknown) => method(plugin, name)(options),
  convertFileSrc: (value: string) => value,
  Plugins: {},
}

export const registerPlugin = (name: string) => proxyOf(name)

/** collector.ts 会探测 CapacitorHttp 的代理形态；这里给一个稳定的假对象即可 */
export const CapacitorHttp = { get: async () => ({}) }

export type PluginListenerHandle = { remove(): Promise<void> }

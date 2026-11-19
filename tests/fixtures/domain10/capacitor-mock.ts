/**
 * `@capacitor/core` 的替身（域10 N5 专用）：把原生 `AppUpdate` 插件换成**可编排的桥**。
 *
 * 只影响 `tests/fixtures/domain10` 这份 harness 构建（rspack alias），不进任何发布产物。
 * 行为全部由页面里的 `window.__bridge` 决定（用例用 `context.addInitScript` 注入）：
 *
 *   window.__bridge.platform            平台字符串（'android' → isAndroidUpdate() === true）
 *   window.__bridge.handlers[method]    对应原生方法的实现，参数原样透传，可返回 Promise
 *
 * 也就是说：组件看到的是「Capacitor 说有原生插件」，插件方法背后是测试剧本。
 * 进度事件、取消、缓存命中、权限缺失这些分支只有真按钮才走得到，所以必须这么做。
 */
type AnyHandler = (...args: unknown[]) => unknown
type Bridge = { platform?: string; handlers?: Record<string, AnyHandler> }

const bridge = () => (globalThis as unknown as { __bridge?: Bridge }).__bridge

const method =
  (plugin: string, name: string) =>
  (...args: unknown[]): unknown => {
    const handler = bridge()?.handlers?.[name]
    if (typeof handler !== 'function') {
      throw new Error(`MOCK_METHOD_MISSING:${plugin}.${name}`)
    }
    return handler(...args)
  }

/** 未实现的方法也要拿到函数：组件可能探测插件能力，不能在这里崩 */
const proxyOf = (plugin: string, name: string) =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => (typeof property === 'string' ? method(plugin, property) : undefined),
  })

export const Capacitor = {
  getPlatform: () => bridge()?.platform ?? 'web',
  isNativePlatform: () => (bridge()?.platform ?? 'web') !== 'web',
  registerPlugin: (name: string) => proxyOf(name, name),
  nativePromise: (plugin: string, name: string, options?: unknown) => method(plugin, name)(options),
  convertFileSrc: (value: string) => value,
  Plugins: {},
}

export const registerPlugin = (name: string) => proxyOf(name, name)

/** 采集层会探测 CapacitorHttp 的代理形态；给一个稳定的假对象即可 */
export const CapacitorHttp = { get: async () => ({}) }

export type PluginListenerHandle = { remove(): Promise<void> }

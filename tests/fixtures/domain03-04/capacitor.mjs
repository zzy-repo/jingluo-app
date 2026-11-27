// 测试替身：可切换的原生桥（N3-B 需要覆盖 probeProvider 的 native 传输分支）。
//
// 真实现里 `Capacitor.isNativePlatform()` 为 true 时探测走 `CapacitorHttp.get`（WebView 里没有 CORS、
// 拿不到 response.headers），否则走 `fetch`。单测默认跑 Web 分支；要跑 native 分支就把
// `globalThis.__nativePlatform` 置 true 并装一个 `globalThis.__nativeGet`。
//
// 这**不是**在断言测试自己的映射：断言对象是真源码 `probeProvider` 的返回值与状态码分类。
export const Capacitor = {
  isNativePlatform: () => globalThis.__nativePlatform === true,
}

export const CapacitorHttp = {
  get: async (options) => {
    globalThis.__nativeCalls.push({ method: 'GET', url: options.url, headers: options.headers })
    const handler = globalThis.__nativeGet
    if (typeof handler !== 'function') {
      throw new Error('native 替身未安装：请先设置 globalThis.__nativeGet')
    }
    return handler(options)
  },
  post: async () => {
    throw new Error('连通性探测不该走 POST')
  },
  request: async () => {
    throw new Error('连通性探测不该走 CapacitorHttp.request')
  },
}

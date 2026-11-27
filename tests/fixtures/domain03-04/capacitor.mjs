// 测试替身：可切换的原生桥（N3-B 需要覆盖 probeProvider 的 native 传输分支）。
//
// 真实现里 `Capacitor.isNativePlatform()` 为 true 时探测走 `CapacitorHttp.get`（WebView 里没有 CORS、
// 拿不到 response.headers），否则走 `fetch`。单测默认跑 Web 分支；要跑 native 分支就把
// `globalThis.__nativePlatform` 置 true 并装一个 `globalThis.__nativeGet`。
//
// 这**不是**在断言测试自己的映射：断言对象是真源码 `probeProvider` 的返回值与状态码分类。
//
// ⚠ 这个替身是**整族共用**的 `@capacitor/core`（`installSessionMatrixEnv` /
// `store-storage-env` 都把它按正则装上），而解析 hook 是**进程级**的：谁先装，整批同进程的
// 文件都跟着用它。所以这里的导出必须是「比任何 import 方要的都不少」的最小超集 ——
// 少一个导出，后面某个文件（例如 `update-gate.test.mjs` → `appUpdate.ts`）会直接
// `<加载失败>：does not provide an export named 'registerPlugin'`（批内红、单跑绿）。
export const Capacitor = {
  isNativePlatform: () => globalThis.__nativePlatform === true,
  /** 真桥在网页上返回 `'web'`；替身给同一档，避免「没注入平台」时读到 `undefined` 抛错。 */
  getPlatform: () => (globalThis.__nativePlatform === true ? 'android' : 'web'),
}

/**
 * `registerPlugin('X')` 的替身：只需要「被 import 时不炸」。
 * 真实现返回一个代理，用到某个方法时才报 `Unimplemented`；这里给同样「惰性」的形状。
 */
export const registerPlugin = (name) => ({
  name,
  addListener: async () => ({ remove: async () => {} }),
})

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

// 测试替身：`@capacitor/core`（原生桥）+ `registerPlugin`，状态挂在 `globalThis.__cap` 上。
//
// 为什么会有一份共享的：ours-inapp-buy 与 pay-link 各抄了一份 18~22 行的内联 `data:` 模块，
// 两个文件的差别只有「记不记 HTTP 请求 / 用不用 httpReply」，`check:test-duplication` 把它们判成
// 同一段（#408 收尾批）。这里合成一份**按 `globalThis.__cap` 上的状态决定行为**的替身：
//
//   __cap.native            是否原生环境（用例自己改）
//   __cap.http / opened / locations                  记录数组（首次写入时自动建）
//   __cap.httpReply / locationReply                  可选：自定义返回值（不装则用下面的默认）
//   __cap.browser           @capacitor/browser 的状态（见 checkout-browser.mjs）
//
// 默认返回值与两个文件原来逐字相同：request → 200 空体，open → { opened: true }，
// resolveLocation → 302 空 location。断言打在真源码（api.ts / transport.ts）的调用与返回值上。
export const Capacitor = { isNativePlatform: () => globalThis.__cap.native }

export const CapacitorHttp = {
  request: async (options) => {
    globalThis.__cap.http ??= []
    globalThis.__cap.http.push(options)
    return globalThis.__cap.httpReply
      ? globalThis.__cap.httpReply(options)
      : { status: 200, data: '', headers: {} }
  },
}

export const registerPlugin = (name) => ({
  open: async (options) => {
    globalThis.__cap.opened ??= []
    globalThis.__cap.opened.push({ plugin: name, url: options.url })
    return { opened: true }
  },
  resolveLocation: async (options) => {
    globalThis.__cap.locations ??= []
    globalThis.__cap.locations.push({ plugin: name, url: options.url })
    return globalThis.__cap.locationReply
      ? globalThis.__cap.locationReply(options)
      : { status: 302, location: '' }
  },
})

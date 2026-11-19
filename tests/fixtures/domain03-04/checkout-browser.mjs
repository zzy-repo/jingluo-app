// 测试替身：`@capacitor/browser`（内嵌浏览器），状态挂在 `globalThis.__cap.browser` 上。
//
// 为什么共享：ours-inapp-buy 与 pay-link 的内联 `data:` 模块在这段上逐字相同（连
// `removeCount` 的记账、`listeners` 的摘除顺序都一样），差别只有 open 记录几个字段。
// 这里统一记 `{ url, presentationStyle }`：两个文件都只读 `.url` / `.length`，
// pay-link 额外读 `.presentationStyle`，谁也没整对象深比较，所以合并不改任何断言。
//
//   __cap.browser.opens        每次 open 的记录
//   __cap.browser.listeners    addListener 的回调（finish() 依次触发，模拟用户关掉页面）
//   __cap.browser.rejectOpen   true → open 抛错（内嵌浏览器打不开）
//   __cap.browser.removeCount  被 remove 的次数
export const Browser = {
  open: async (options) => {
    globalThis.__cap.browser.opens.push({
      url: options.url,
      presentationStyle: options.presentationStyle,
    })
    if (globalThis.__cap.browser.rejectOpen) {
      throw new Error('内嵌浏览器打不开')
    }
  },
  addListener: async (eventName, handler) => {
    globalThis.__cap.browser.listeners.push({ eventName, handler })
    return {
      remove: async () => {
        globalThis.__cap.browser.removeCount += 1
        const index = globalThis.__cap.browser.listeners.findIndex((item) => item.handler === handler)
        if (index >= 0) {
          globalThis.__cap.browser.listeners.splice(index, 1)
        }
      },
    }
  },
}

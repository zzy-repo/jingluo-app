// 测试替身：ours 数据层（`src/services/ours/transport.ts`）在 Web 分支上只需要这三个名字。
//
// `isNativePlatform()` 恒 false → 单测永远走 Web 的 fetch 分支；原生桥被调到就抛错，
// 保证「原生路径没被意外触发」这件事本身也能被看见。
//
// 原先这段是 3 个文件各自写一份内联 `data:` 模块（ours-purchases / ours-trail /
// payment-trail-ui），`check:test-duplication` 抓到 2 组；抽成 fixture 后逐字保留内容，
// 装配走 `installTsResolve({ stubs: { '@capacitor/core': fixtureUrl('domain03-04/ours-web-capacitor.mjs') } })`。
export const Capacitor = { isNativePlatform: () => false }
export const CapacitorHttp = {
  request: () => {
    throw new Error('单测不应该走原生桥')
  },
}
export const registerPlugin = () => ({
  open: async () => ({}),
  resolveLocation: async () => ({}),
})

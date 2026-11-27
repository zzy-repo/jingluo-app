// 测试替身：只用来把 Capacitor 原生桥挡在单测之外（单测永远跑 Web 路径）。
// 真实代码里 isNativePlatform() 为 true 才会走 CapacitorHttp，这里恒为 false。
export const Capacitor = {
  isNativePlatform: () => false,
}

export const CapacitorHttp = {
  get: () => {
    throw new Error('单测不应该走原生桥')
  },
  post: () => {
    throw new Error('单测不应该走原生桥')
  },
  request: () => {
    throw new Error('单测不应该走原生桥')
  },
}

// 测试替身：只替换 Capacitor 的原生桥，urlImport 的真实代码原样运行。
// 原生请求由用例通过 globalThis.__native.get 控制（可返回永不 settle 的 Promise）。
export const Capacitor = {
  isNativePlatform: () => globalThis.__native?.native === true,
}

export const CapacitorHttp = {
  get: (options) => {
    const native = globalThis.__native
    native.calls.push(options)
    return native.get(options)
  },
}

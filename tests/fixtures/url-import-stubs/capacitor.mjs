// 测试替身：只替换 Capacitor 的原生桥，urlImport 的真实代码原样运行。
//
// #34 之后「从链接导入」不再走 CapacitorHttp，而是走自研插件 HistoryArchive
// （`src/services/chat/history/nativeArchive.ts` 里的 `registerPlugin('HistoryArchive')`）。
// 这里把它接到 `nativeArchive.mjs` 那个转发层，再由用例用
// `tests/fixtures/url-import-stubs/download-simulator.mjs` 提供下载行为
// （`globalThis.__download`）——JS 侧看到的仍然只有「已写入多少字节 + 状态」。
import { nativeArchive } from './nativeArchive.mjs'

export const Capacitor = {
  isNativePlatform: () => globalThis.__native?.native === true,
}

export const registerPlugin = (name) => {
  if (name !== 'HistoryArchive') {
    throw new Error(`测试替身未提供插件 ${name}（只有 HistoryArchive，见 issue #34）`)
  }
  return nativeArchive
}

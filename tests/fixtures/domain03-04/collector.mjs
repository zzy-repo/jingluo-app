// 测试替身：诊断采集层（真实现依赖 DOM / IndexedDB）。
//
// 复用 `tests/fixtures/chat-stubs/collector.mjs` 的内存写入器，再补上 store.ts 额外用到的
// `recordError`（真实现会带上设备信息，单测只需要「写了哪条错误」）。
export * from '../chat-stubs/collector.mjs'

export const recordError = (message, fields = {}) => {
  globalThis.__log.records.push({ kind: 'error', level: 'error', message, fields })
}

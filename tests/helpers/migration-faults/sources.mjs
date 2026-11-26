// [helper | 无依赖 | 无全局副作用]
//
// #910 / #921：`RawStoreSource` / `RawStoreSink` 的内存实现，只给审计测试用。
// 不 import `src/**`（store 名清单在本文件自己写一份，与 `migration/types.ts` 的 `RAW_STORE_NAMES` 逐字相同；
// 两份漂移时 `migration-oracle-selftest` 的「store 清单」用例会红）。

export const STORE_NAMES = Object.freeze([
  'sessions',
  'sessionSummaries',
  'files',
  'sessionsStaging',
  'filesStaging',
  'appAssets',
  'attachments',
  'attachmentTexts',
  'sessionMemory',
])

/** 每个 store 的主键字段（keyPath）。与 `chat/db.ts` 的 `upgradeChatDB` 一致。 */
export const KEY_PATH = Object.freeze({
  sessions: 'id',
  sessionSummaries: 'id',
  files: 'id',
  sessionsStaging: 'id',
  filesStaging: 'id',
  appAssets: 'key',
  attachments: 'id',
  attachmentTexts: 'key',
  sessionMemory: 'id',
})

/** 空数据集：`{ store: Map<key, value> }`。 */
export const emptyData = () => Object.fromEntries(STORE_NAMES.map((s) => [s, new Map()]))

/** JS 默认（UTF-16 码元）序，与 IndexedDB 对字符串键的排序一致。 */
export const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * 内存源。`data[store]` 是 `Map<string, value>`（或 `[key, value]` 数组）。
 * 行为与契约一致：主键升序分页，`after` 不含，`next` 仅在还有更多时给出。
 * `options.pageCap`：不管调用方要多少，每页最多给这么多（用来验证消费方不假设「一页读完」）。
 */
export const memorySource = (data, options = {}) => {
  const view = (store) => {
    const m = data[store]
    if (m === undefined) return []
    const entries = m instanceof Map ? [...m.entries()] : [...m]
    return entries.sort((x, y) => compareKeys(x[0], y[0]))
  }
  return {
    async count(store) {
      return view(store).length
    },
    async readBatch(store, after, limit) {
      const cap = options.pageCap === undefined ? limit : Math.min(limit, options.pageCap)
      const all = view(store)
      const rows = []
      let more = false
      for (const [key, value] of all) {
        if (after !== undefined && !(key > after)) continue
        if (rows.length >= cap) {
          more = true
          break
        }
        rows.push({ key, value })
      }
      return more ? { rows, next: rows[rows.length - 1].key } : { rows }
    },
    async estimateBytes() {
      return 0
    },
  }
}

/** 内存写入口：`writeBatch` 幂等 upsert，`clearAll` 清空。`data` 即被写入的 Map 集合。 */
export const memorySink = (data = emptyData()) => ({
  data,
  async writeBatch(store, rows) {
    const m = data[store]
    for (const row of rows) m.set(row.key, row.value)
  },
  async clearAll() {
    for (const s of STORE_NAMES) data[s].clear()
  },
})

/** 深拷贝一份数据集（Blob 共享引用：Blob 不可变，比较按字节，共享无碍）。 */
export const cloneData = (data) => {
  const out = emptyData()
  for (const s of STORE_NAMES) {
    for (const [k, v] of data[s] ?? []) out[s].set(k, structuredClone(v))
  }
  return out
}

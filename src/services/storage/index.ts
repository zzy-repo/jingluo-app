/**
 * 存储引擎入口（Issue #906）：`getStorage()` 进程内单例 + 测试替身注入。
 *
 * 后端选择只做最小：默认 IndexedDB，不引入 SQLite（见 `docs/storage-abstraction.md` 第 6 节开放问题 5）。
 * 本文件不碰 window / document / localStorage。
 */
import { openIndexedDbStorage } from './idb/backend.js'
import type { StorageBackend } from './types.js'

export { openIndexedDbStorage }
export type * from './types.js'
export type { OpenStorage, StorageBackendKind, StorageOpener } from './openStorage.js'

let current: Promise<StorageBackend> | null = null
let override: StorageBackend | null = null

/**
 * 取进程内唯一的存储后端，首次调用时才打开。
 *
 * 重连语义沿用 `db.ts` 的 `getChatDB()`：打开失败**不缓存**那次 rejection（下次调用重新尝试）；
 * 调用 `close()` 之后缓存失效，下次 `getStorage()` 重新打开。
 */
export const getStorage = (): Promise<StorageBackend> => {
  if (override !== null) {
    return Promise.resolve(override)
  }
  if (current !== null) {
    return current
  }
  const opening: Promise<StorageBackend> = openIndexedDbStorage().then(
    (backend) => ({
      ...backend,
      close: async () => {
        await backend.close()
        if (current === opening) {
          current = null
        }
      },
    }),
    (error: unknown) => {
      if (current === opening) {
        current = null
      }
      throw error
    }
  )
  current = opening
  return opening
}

/** 测试用：注入替身后端；传 `null` 恢复默认并丢弃缓存的单例（不关闭它）。 */
export const setStorageForTests = (backend: StorageBackend | null): void => {
  override = backend
  current = null
}

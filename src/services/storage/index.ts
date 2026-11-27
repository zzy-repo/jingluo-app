/**
 * 存储引擎入口（Issue #906 / #910）：`getStorage()` 进程内单例 + 测试替身注入。
 *
 * 后端选择（#910）：没有注册 `StorageRuntime`（合并后的默认状态）= 恒为 IndexedDB，与此前行为一致。
 * 注册之后按 `router.ts` 的结论：sqlite → SQLite 后端；indexeddb → IDB 后端；blocked → 抛
 * `StorageEngineBlockedError`；迁移进行中 → 抛 `StorageMigratingError`。**任何路径都不返回内存实现**，
 * `committed` 后也不会回退到旧 IDB。本文件不碰 window / document / localStorage。
 */
import { openIndexedDbStorage } from './idb/backend.js'
import { buildRouterDeps } from './migration/deps.js'
import { StorageEngineBlockedError, StorageMigratingError } from './migration/errors.js'
import { getEngineChoice, getStorageRuntime, isMigrationRunning, setEngineChoice } from './migration/runtime.js'
import { resolveStorageEngine } from './router.js'
import type { StorageBackend } from './types.js'

export { openIndexedDbStorage }
export { StorageEngineBlockedError, StorageMigratingError } from './migration/errors.js'
export type * from './types.js'
export type { OpenStorage, StorageBackendKind, StorageOpener } from './openStorage.js'

let current: Promise<StorageBackend> | null = null
/** `current` 成功打开后的已解析后端；`close()` / 注入替身 / 打开失败时清空。仅供 `peekStorage` 同步读取。 */
let resolved: StorageBackend | null = null
let override: StorageBackend | null = null

const openRouted = async (): Promise<StorageBackend> => {
  const runtime = getStorageRuntime()
  if (runtime === undefined) {
    return openIndexedDbStorage()
  }
  const choice = getEngineChoice() ?? (await resolveStorageEngine(buildRouterDeps(runtime)))
  if (choice.engine === 'blocked') {
    if (choice.reason === 'migrating') {
      throw new StorageMigratingError()
    }
    throw new StorageEngineBlockedError(choice.reason, choice.detail)
  }
  return choice.engine === 'sqlite' ? runtime.openSqliteBackend() : openIndexedDbStorage()
}

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
  if (isMigrationRunning()) {
    // 迁移期间任何业务访问都拒绝（D1 的第二道防线；第一道是启动闸门）。不缓存、不降级。
    return Promise.reject(new StorageMigratingError())
  }
  if (current !== null) {
    return current
  }
  const opening: Promise<StorageBackend> = openRouted().then(
    (backend) => {
      const wrapped: StorageBackend = {
        ...backend,
        close: async () => {
          await backend.close()
          if (current === opening) {
            current = null
            resolved = null
          }
        },
      }
      if (current === opening) {
        resolved = wrapped
      }
      return wrapped
    },
    (error: unknown) => {
      if (current === opening) {
        current = null
        resolved = null
      }
      throw error
    }
  )
  current = opening
  return opening
}

/**
 * 同步取已打开的后端；还没打开（或已 `close()`）返回 `undefined`。
 *
 * 为什么有它：迁移前调用方是**同步**调用 `db.saveSession` / `pinSession` / `renameSession`，
 * 写请求在同一个 tick 里就已发出（pagehide / 切后台 flush、「先 pin 再立即读」依赖这个顺序）。
 * `getStorage()` 返回 Promise，哪怕已打开也要晚一个微任务。调用方在 `peekStorage()` 有值时同步调用，
 * 没值时退回 `getStorage().then(...)`。不触发打开，不改变 `getStorage()` 的任何语义。
 */
export const peekStorage = (): StorageBackend | undefined => override ?? resolved ?? undefined

/**
 * 同步判断「当前宿主有没有可用的持久化存储后端」（能力探测，不触发打开）。
 * 默认后端是 IndexedDB，所以看 `indexedDB` 是否存在；注入了替身后端时视为可用。
 * 业务与 protection 层用它代替自己 `typeof indexedDB`，SQLite 后端落地后只改这一处。
 */
export const isStorageAvailable = (): boolean => override !== null || typeof indexedDB !== 'undefined'

/** 测试用：注入替身后端；传 `null` 恢复默认并丢弃缓存的单例（不关闭它）。 */
export const setStorageForTests = (backend: StorageBackend | null): void => {
  override = backend
  current = null
  resolved = null
  setEngineChoice(undefined)
}

/** 启动闸门改变路由结论后调用：丢弃已缓存的后端引用（不关闭），下次 `getStorage()` 按新结论打开。 */
export const resetStorageRouting = (): void => {
  current = null
}

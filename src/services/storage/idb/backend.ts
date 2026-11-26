/**
 * IndexedDB 后端：把 `StorageBackend` 薄适配到现有实现（Issue #906）。
 *
 * 原则：有现成函数的方法直接转调（`chat/db.ts`、`attachments/store.ts`），不复制逻辑；
 * 现有函数没有对应物的方法（`listReferencing` / `listBranchesOf` / `listFull` / `listKeys` /
 * `clearExcept` / 记忆全部方法）在 `txRepos.ts` 里用 `openChatTransaction` 新写。
 *
 * 记忆为什么不转调 `memory/sessionMemory.ts`：它返回的是去掉了 `id` / `sessionId` 的 `MemoryEntry`，
 * 而 `MemoryRepo` 约定返回 `StoredSessionMemory`；且它顶层 import 了 diagnostics 与 embedding 门，
 * 存储层不该背这条依赖。主键口径、排序、事务边界与 `sessionMemory.ts` 的存储操作一致。
 *
 * 不 import react / zustand / components / app / i18n（运行时）/ diagnostics。
 */
import {
  StorageBlockedError,
  StorageUnavailableError,
  StorageVersionTooNewError,
  addStagingSession,
  clearStaging,
  commitStaging,
  deleteAppAsset,
  deleteSession,
  getChatDB,
  isIndexedDBAvailable,
  isStoragePersisted,
  loadAppAsset,
  loadFile,
  loadSession,
  loadSessionSummaries,
  mergeStaging,
  openChatTransaction,
  pinSession,
  renameSession,
  saveAppAsset,
  saveFiles,
  saveSession,
  saveStagingFiles,
  updateStagingFileTypes,
} from '../../chat/db.js'
import {
  getAttachment,
  listAttachments,
  putAttachment,
  readAttachmentTextRecord,
  removeAttachment,
  removeUnreferencedAttachments,
  saveNewAttachment,
  sweepOrphanStorage,
  writeAttachmentTextRecord,
} from '../../attachments/store.js'
import type {
  AssetRepo,
  AttachmentRepo,
  BlobRepo,
  MemoryRepo,
  SessionRepo,
  StagingRepo,
  StorageBackend,
  StorageHealth,
  StorageProbe,
  StorageRepos,
} from '../types.js'
import { ALL_STORES, asAllTx, runInTransaction } from './txRepos.js'

/** 只含所需 store 的小事务里跑一段仓储调用（单个原子单元）。 */
const withTx = async <const Names extends readonly (typeof ALL_STORES)[number][], T>(
  stores: Names,
  mode: 'readonly' | 'readwrite',
  work: (repos: StorageRepos) => Promise<T>
): Promise<T> => runInTransaction(asAllTx(await openChatTransaction(stores, mode)), work)

const sessions: SessionRepo = {
  listSummaries: () => loadSessionSummaries(),
  get: (id) => loadSession(id),
  save: (session, files = [], options) => saveSession(session, [...files], options),
  pin: (id, pinnedAt) => pinSession(id, pinnedAt),
  rename: (id, title) => renameSession(id, title),
  delete: (id) => deleteSession(id),
  listReferencing: (fileId) =>
    withTx(['sessionSummaries'], 'readonly', (repos) => repos.sessions.listReferencing(fileId)),
  listBranchesOf: (parentId) =>
    withTx(['sessionSummaries'], 'readonly', (repos) => repos.sessions.listBranchesOf(parentId)),
  listFull: (query) => withTx(['sessions'], 'readonly', (repos) => repos.sessions.listFull(query)),
}

const blobs: BlobRepo = {
  get: (id) => loadFile(id),
  putMany: (files) => saveFiles([...files]),
  listKeys: (query) => withTx(['files'], 'readonly', (repos) => repos.blobs.listKeys(query)),
  delete: (id) => withTx(['files'], 'readwrite', (repos) => repos.blobs.delete(id)),
  clearExcept: (keep) => withTx(['files'], 'readwrite', (repos) => repos.blobs.clearExcept(keep)),
}

const assets: AssetRepo = {
  get: (key) => loadAppAsset(key),
  put: (key, blob) => saveAppAsset(key, blob),
  delete: (key) => deleteAppAsset(key),
}

const attachments: AttachmentRepo = {
  add: (draft, blob) => saveNewAttachment(draft, blob),
  put: (record) => putAttachment(record),
  get: (id) => getAttachment(id),
  list: () => listAttachments(),
  readText: (key) => readAttachmentTextRecord(key),
  writeText: (draft) => writeAttachmentTextRecord(draft),
  remove: (id) => removeAttachment(id),
  sweepOrphans: () => sweepOrphanStorage(),
  removeUnreferenced: (referenced) => removeUnreferencedAttachments(referenced),
}

const memory: MemoryRepo = {
  get: (sessionId, key) =>
    withTx(['sessionMemory'], 'readonly', (repos) => repos.memory.get(sessionId, key)),
  listBySession: (sessionId) =>
    withTx(['sessionMemory'], 'readonly', (repos) => repos.memory.listBySession(sessionId)),
  put: (entry, evictIds) =>
    withTx(['sessionMemory'], 'readwrite', (repos) => repos.memory.put(entry, evictIds)),
  delete: (sessionId, key) =>
    withTx(['sessionMemory'], 'readwrite', (repos) => repos.memory.delete(sessionId, key)),
  clearSession: (sessionId) =>
    withTx(['sessionMemory'], 'readwrite', (repos) => repos.memory.clearSession(sessionId)),
}

const staging: StagingRepo = {
  clear: () => clearStaging(),
  addSession: (session) => addStagingSession(session),
  putFiles: (files) => saveStagingFiles([...files]),
  updateFileTypes: (types) => updateStagingFileTypes(types),
  commit: () => commitStaging(),
  merge: (policy) => mergeStaging(policy),
}

/** 给仓储的每个方法套一层「已关闭则抛 `StorageUnavailableError`」。 */
const guarded = <R extends object>(repo: R, assertOpen: () => void): R =>
  Object.fromEntries(
    Object.entries(repo).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        assertOpen()
        return (method as (...rest: unknown[]) => unknown)(...args)
      },
    ])
  ) as R

const healthOfError = (error: unknown): StorageHealth => ({
  ok: false,
  initFailure:
    error instanceof StorageBlockedError
      ? 'blocked'
      : error instanceof StorageVersionTooNewError
        ? 'version'
        : 'unavailable',
})

/**
 * 打开 IndexedDB 后端。失败 reject 的类型与 `getChatDB()` 一致：
 * `StorageUnavailableError` / `StorageBlockedError` / `StorageVersionTooNewError`。
 * 连接仍由 `db.ts` 的模块级单例持有（沿用它的 `blocked` 超时、`terminated` 与 InvalidStateError 重连语义），
 * 所以同一进程里多次 open 得到的是同一条连接，旧的直调函数与本后端互不冲突。
 */
export const openIndexedDbStorage = async (): Promise<StorageBackend> => {
  if (!isIndexedDBAvailable()) {
    throw new StorageUnavailableError()
  }
  await getChatDB()

  let closed = false
  const assertOpen = () => {
    if (closed) {
      throw new StorageUnavailableError()
    }
  }

  const health = async (): Promise<StorageHealth> => {
    if (closed || !isIndexedDBAvailable()) {
      return { ok: false, initFailure: 'unavailable' }
    }
    try {
      await getChatDB()
      return { ok: true }
    } catch (error) {
      return healthOfError(error)
    }
  }

  return {
    sessions: guarded(sessions, assertOpen),
    blobs: guarded(blobs, assertOpen),
    assets: guarded(assets, assertOpen),
    attachments: guarded(attachments, assertOpen),
    memory: guarded(memory, assertOpen),
    staging: guarded(staging, assertOpen),
    // `immediate` 对 IDB 无意义（见 `AtomicOptions`）；事务覆盖全部 9 个 store，
    // 因为 IDB 的 store 范围必须在开事务时定死，无法按「回调实际写到的仓储」惰性收窄。
    runAtomic: async (work) => {
      assertOpen()
      return runInTransaction(asAllTx(await openChatTransaction(ALL_STORES, 'readwrite')), work)
    },
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      try {
        // 关闭 `db.ts` 的共享连接；`openChatTransaction` 遇到 InvalidStateError 会忘掉它并重连，
        // 所以仍在用旧直调函数的代码不受影响，只是多一次重连。本后端自身由 `closed` 守卫拦住。
        ;(await getChatDB()).close()
      } catch {
        // 打不开 = 本来就没有连接可关
      }
    },
    health,
    probe: async (): Promise<StorageProbe> => {
      const result = await health()
      let versionTooNew = false
      if (!closed && isIndexedDBAvailable()) {
        try {
          await getChatDB()
        } catch (error) {
          versionTooNew = error instanceof StorageVersionTooNewError
        }
      }
      return { health: result, versionTooNew, persisted: await isStoragePersisted() }
    },
  }
}

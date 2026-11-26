/**
 * 绑定在**一个已打开事务**上的仓储实现（IDB 后端内部）。
 *
 * 两个用途共用同一份代码：
 *  1. `runAtomic`：开一个覆盖全部 store 的 readwrite 事务，回调里拿到的就是这里造出的仓储；
 *  2. 现有函数没有对应物的方法（`listReferencing` / `listBranchesOf` / `listFull` / `listKeys` /
 *     `clearExcept` / 记忆的 CRUD）：`repos.ts` 开一个只含所需 store 的小事务，调这里的同名方法。
 *
 * 有现成函数的方法（`saveSession` / `commitStaging` / `removeAttachment` …）在 `repos.ts` 里直接转调，
 * 不在这里重写；它们在 `runAtomic` 里**不支持**（见 `unsupportedInAtomic`）。原因：这些函数各自开事务，
 * 无法挂到调用方的事务上，而重写一遍就是复制逻辑、让两份实现漂移。
 *
 * 不 import 任何 UI / 状态库 / diagnostics。
 */
import { openChatTransaction, storedSummary } from '../../chat/db.js'
import { attachmentTextKey } from '../../attachments/store.js'
import { toSessionSummary } from '../../chat/types.js'
import type { StoredAttachmentText, StoredSessionMemory } from '../../chat/db.js'
import type {
  AssetRepo,
  AttachmentRepo,
  BlobRepo,
  MemoryRepo,
  SessionRepo,
  StagingRepo,
  StorageRepos,
} from '../types.js'
import { fetchCount, rangeAfter, toPage } from './util.js'

/** `runAtomic` 的事务覆盖的全部 store（库里的 9 个）。 */
export const ALL_STORES = [
  'sessions',
  'sessionSummaries',
  'files',
  'sessionsStaging',
  'filesStaging',
  'appAssets',
  'attachments',
  'attachmentTexts',
  'sessionMemory',
] as const

const openAllStores = () => openChatTransaction(ALL_STORES, 'readwrite')

/** 覆盖全部 store 的 readwrite 事务（类型上的「全集」；子集事务通过 `asAllTx` 收窄使用）。 */
export type AllTx = Awaited<ReturnType<typeof openAllStores>>

/**
 * 把只含部分 store 的事务当作 `AllTx` 用。运行时安全的前提：调用方只调用只碰这些 store 的方法
 * （`repos.ts` 里每处调用都逐一核对过）；碰到没声明的 store，IDB 会抛 `NotFoundError`，不会静默错写。
 */
export const asAllTx = (tx: unknown): AllTx => tx as AllTx

const unsupportedInAtomic = (name: string) => async (): Promise<never> => {
  throw new Error(
    `IndexedDB 后端：${name} 不能在 runAtomic 里调用（它自带原子边界，且现有实现自己开事务；请在 runAtomic 之外单独调用）`
  )
}

/** 记忆主键 `${sessionId}:${key}`；会话 ID 不许含 `:`（与 `memory/sessionMemory.ts` 的 `assertSessionId` 同口径）。 */
const memoryId = (sessionId: string, key: string): string => {
  if (sessionId === '' || sessionId.includes(':')) {
    throw new Error(`会话 ID 非法：${JSON.stringify(sessionId)}（记忆键必须能唯一归属到一个会话）`)
  }
  return `${sessionId}:${key}`
}

const sessionsOf = (tx: AllTx): SessionRepo => ({
  listSummaries: async () => (await tx.objectStore('sessionSummaries').getAll()).map(toSessionSummary),
  get: (id) => tx.objectStore('sessions').get(id),
  // 在 runAtomic 里没有「事务 A / B 拆开」这回事：全部写进同一事务，任一失败整体回滚，不做自愈。
  save: async (session, files = []) => {
    await tx.objectStore('sessions').put(session)
    await tx.objectStore('sessionSummaries').put(storedSummary(session))
    for (const file of files) {
      await tx.objectStore('files').put(file)
    }
    return { failure: null, degradedFiles: [], strippedFields: [] }
  },
  pin: async (id, pinnedAt) => {
    const sessions = tx.objectStore('sessions')
    const session = await sessions.get(id)
    if (session === undefined) {
      return
    }
    if (pinnedAt === undefined) {
      delete session.pinnedAt
    } else {
      session.pinnedAt = pinnedAt
    }
    await sessions.put(session)
    await tx.objectStore('sessionSummaries').put(storedSummary(session))
  },
  rename: async (id, title) => {
    const sessions = tx.objectStore('sessions')
    const session = await sessions.get(id)
    if (session === undefined) {
      return
    }
    session.title = title
    await sessions.put(session)
    await tx.objectStore('sessionSummaries').put(storedSummary(session))
  },
  delete: async (sessionId) => {
    const summaries = tx.objectStore('sessionSummaries')
    const summary = await summaries.get(sessionId)
    await tx.objectStore('sessions').delete(sessionId)
    await summaries.delete(sessionId)
    for (const id of summary?.fileIds ?? []) {
      if ((await summaries.index('fileIds').count(id)) === 0) {
        await tx.objectStore('files').delete(id)
      }
    }
    const memory = tx.objectStore('sessionMemory')
    const keys = await memory.index('sessionId').getAllKeys(sessionId)
    for (const key of keys) {
      await memory.delete(key)
    }
  },
  listReferencing: async (fileId) =>
    (await tx.objectStore('sessionSummaries').index('fileIds').getAllKeys(fileId)).map(String),
  listBranchesOf: async (parentSessionId) =>
    (await tx.objectStore('sessionSummaries').index('branchOf').getAll(parentSessionId)).map(toSessionSummary),
  listFull: async (query) => {
    const rows = await tx
      .objectStore('sessions')
      .getAll(rangeAfter(query?.after) ?? null, fetchCount(query))
    return toPage(rows, (row) => row.id, query)
  },
})

const blobsOf = (tx: AllTx): BlobRepo => ({
  get: async (id) => (await tx.objectStore('files').get(id))?.blob,
  putMany: async (files) => {
    const store = tx.objectStore('files')
    for (const file of files) {
      await store.put(file)
    }
  },
  listKeys: async (query) => {
    const keys = await tx
      .objectStore('files')
      .getAllKeys(rangeAfter(query?.after) ?? null, fetchCount(query))
    return toPage(keys.map(String), (key) => key, query)
  },
  delete: async (id) => {
    await tx.objectStore('files').delete(id)
  },
  clearExcept: async (keep) => {
    const files = tx.objectStore('files')
    const doomed: string[] = []
    // 与 `commitStaging` 的 clearFilesKeepingAttachmentBlobs 同做法：只读键，先收齐再删
    for (let cursor = await files.openKeyCursor(); cursor; cursor = await cursor.continue()) {
      if (typeof cursor.key === 'string' && keep(cursor.key)) {
        continue
      }
      doomed.push(cursor.key)
    }
    for (const key of doomed) {
      await files.delete(key)
    }
  },
})

const assetsOf = (tx: AllTx): AssetRepo => ({
  get: (key) => tx.objectStore('appAssets').get(key),
  put: async (key, blob) => {
    await tx.objectStore('appAssets').put({ key, blob, updatedAt: Date.now() })
  },
  delete: async (key) => {
    await tx.objectStore('appAssets').delete(key)
  },
})

const attachmentsOf = (tx: AllTx): AttachmentRepo => ({
  add: unsupportedInAtomic('attachments.add'),
  put: async (record) => {
    await tx.objectStore('attachments').put(record)
  },
  get: (id) => tx.objectStore('attachments').get(id),
  list: () => tx.objectStore('attachments').getAll(),
  readText: async (key) => (key === undefined ? undefined : tx.objectStore('attachmentTexts').get(key)),
  // 与 `attachments/store.ts` 的 writeAttachmentTextRecord 同字段口径
  writeText: async (draft) => {
    const record: StoredAttachmentText = {
      key: attachmentTextKey(draft.sha256, draft.parserVersion),
      sha256: draft.sha256,
      parserVersion: draft.parserVersion,
      text: draft.text,
      characterCount: draft.characterCount === undefined ? draft.text.length : draft.characterCount,
      status: draft.status,
      createdAt: Date.now(),
    }
    if (draft.totalPages !== undefined) {
      record.totalPages = draft.totalPages
    }
    if (draft.extractedPages !== undefined) {
      record.extractedPages = draft.extractedPages
    }
    if (draft.warnings !== undefined && draft.warnings.length > 0) {
      record.warnings = draft.warnings
    }
    await tx.objectStore('attachmentTexts').put(record)
    return record
  },
  remove: unsupportedInAtomic('attachments.remove'),
  sweepOrphans: unsupportedInAtomic('attachments.sweepOrphans'),
  removeUnreferenced: unsupportedInAtomic('attachments.removeUnreferenced'),
})

const memoryOf = (tx: AllTx): MemoryRepo => ({
  get: (sessionId, key) => tx.objectStore('sessionMemory').get(memoryId(sessionId, key)),
  listBySession: async (sessionId) => {
    memoryId(sessionId, '')
    const rows: StoredSessionMemory[] = await tx
      .objectStore('sessionMemory')
      .index('sessionId')
      .getAll(sessionId)
    return rows.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt
    )
  },
  put: async (entry, evictIds) => {
    const store = tx.objectStore('sessionMemory')
    await store.put(entry)
    for (const id of evictIds) {
      await store.delete(id)
    }
  },
  delete: async (sessionId, key) => {
    const store = tx.objectStore('sessionMemory')
    const id = memoryId(sessionId, key)
    if ((await store.count(id)) === 0) {
      return false
    }
    await store.delete(id)
    return true
  },
  clearSession: async (sessionId) => {
    memoryId(sessionId, '')
    const store = tx.objectStore('sessionMemory')
    const keys = await store.index('sessionId').getAllKeys(sessionId)
    for (const key of keys) {
      await store.delete(key)
    }
    return keys.length
  },
})

const stagingOf = (tx: AllTx): StagingRepo => ({
  clear: async () => {
    await tx.objectStore('sessionsStaging').clear()
    await tx.objectStore('filesStaging').clear()
  },
  addSession: async (session) => {
    await tx.objectStore('sessionsStaging').add(session)
  },
  putFiles: async (files) => {
    const store = tx.objectStore('filesStaging')
    for (const file of files) {
      await store.put(file)
    }
  },
  updateFileTypes: unsupportedInAtomic('staging.updateFileTypes'),
  commit: unsupportedInAtomic('staging.commit'),
  merge: unsupportedInAtomic('staging.merge'),
})

/** 在给定事务上造出一整套仓储。 */
export const createTxRepos = (tx: AllTx): StorageRepos => ({
  sessions: sessionsOf(tx),
  blobs: blobsOf(tx),
  assets: assetsOf(tx),
  attachments: attachmentsOf(tx),
  memory: memoryOf(tx),
  staging: stagingOf(tx),
})

/**
 * 在事务上跑 `work`：成功则等事务提交后返回；抛错则 `abort()` 并**原样**抛出 `work` 的错误
 * （而不是随后到来的 `AbortError`）。`work` 里不要 await 非 IDB 的 promise，否则事务会自动提交。
 */
export const runInTransaction = async <T>(
  tx: AllTx,
  work: (repos: StorageRepos) => Promise<T>
): Promise<T> => {
  // 提前监听事务终态，避免 abort 后 `tx.done` 的拒绝变成未处理的 rejection
  const settled = tx.done.then(
    () => null,
    (error: unknown) => ({ error })
  )
  let result: T
  try {
    result = await work(createTxRepos(tx))
  } catch (error) {
    try {
      tx.abort()
    } catch {
      // 事务已因请求失败中止。
    }
    await settled
    throw error
  }
  const outcome = await settled
  if (outcome !== null) {
    throw outcome.error
  }
  return result
}

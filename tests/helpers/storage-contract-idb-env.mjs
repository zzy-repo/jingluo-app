// IDB 后端 runner 的环境搭建（fake-indexeddb）。**只有 IDB runner 可以 import 本文件**，它故意放在
// `storage-contract/` 目录之外：物理 store 名、IDBObjectStore 补丁、旧版 schema 都在这里，
// 契约套件本体（`storage-contract/**`）只依赖 Node 与 StorageBackend 接口，看不到它们。
import * as fake from 'fake-indexeddb'
import { openDB } from 'idb'
import { attKey, blobOf, chatOf, SHA_A, T0 } from './storage-contract/fixtures.mjs'

const ALL_STORES = ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'appAssets', 'attachments', 'attachmentTexts', 'sessionMemory']

/** 逻辑写点 → 物理 store（契约里的 `at`）。 */
const STORES_OF = {
  session: ['sessions'],
  summary: ['sessionSummaries'],
  blob: ['files'],
  asset: ['appAssets'],
  attachment: ['attachments', 'attachmentTexts'],
  memory: ['sessionMemory'],
  staging: ['sessionsStaging', 'filesStaging'],
  any: ALL_STORES,
}

/** 契约的四档 → 注入的 DOMException 名（映射表见 docs/storage-abstraction.md §4）。 */
const ERROR_NAME = { quota: 'QuotaExceededError', clone: 'DataCloneError', unavailable: 'UnknownError', unknown: 'InvalidStateError' }

const keyOf = (args) => {
  const first = args[0]
  if (first !== null && typeof first === 'object' && !(first instanceof fake.IDBKeyRange)) return first.id ?? first.key
  return first
}

/** 故障注入：补丁 `IDBObjectStore.prototype` 的写方法；读不受影响。 */
export const createInject = () => ({
  failNextWrite(kind, { at = 'any', nth = 1, times = 1, id } = {}) {
    const stores = new Set(STORES_OF[at] ?? [])
    if (stores.size === 0) throw new Error(`未知写点 ${at}`)
    const name = ERROR_NAME[kind]
    if (name === undefined) throw new Error(`未知失败档位 ${kind}`)
    const proto = fake.IDBObjectStore.prototype
    const originals = new Map()
    const state = { hits: 0, failed: 0, restored: false }
    for (const method of ['put', 'add', 'delete', 'clear']) {
      const original = proto[method]
      originals.set(method, original)
      proto[method] = function patched(...args) {
        if (stores.has(this.name) && (id === undefined || keyOf(args) === id)) {
          state.hits += 1
          if (state.hits >= nth && state.failed < times) {
            state.failed += 1
            throw new DOMException('injected failure', name)
          }
        }
        return original.apply(this, args)
      }
    }
    return {
      errorName: name,
      hits: () => state.hits,
      restore() {
        if (state.restored) return
        state.restored = true
        for (const [method, original] of originals) proto[method] = original
      },
    }
  },
})

const deleteDatabase = (name) =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`删除 ${name} 被阻塞：还有连接没关`))
  })

/** v13（#399 之前最后一次 schema）的 store / 索引清单：冻结的历史事实，不跟着 DB_VERSION 走（与 memory-session-scope-399 同口径）。 */
const LEGACY_VERSION = 13
const LEGACY_SCHEMA = [
  ['sessions', { keyPath: 'id' }, []],
  ['sessionSummaries', { keyPath: 'id' }, [['fileIds', 'fileIds', { multiEntry: true }]]],
  ['files', { keyPath: 'id' }, []],
  ['sessionsStaging', { keyPath: 'id' }, []],
  ['filesStaging', { keyPath: 'id' }, []],
  ['appAssets', { keyPath: 'key' }, []],
  ['attachments', { keyPath: 'id' }, [['sha256', 'sha256', {}], ['parsedTextPath', 'parsedTextPath', {}]]],
  ['attachmentTexts', { keyPath: 'key' }, [['sha256', 'sha256', {}]]],
]

const fold = async (blob) => ({ type: blob.type, size: blob.size, text: await blob.text() })

/** 旧库里的数据：行形状是旧代码写进去的样子（摘要带 fileIds），期望值是接口层读出来该有的样子。 */
const legacyData = () => {
  const pinned = chatOf('legacy-1', { files: ['img-legacy'], pinnedAt: T0 + 9, title: '旧会话一' })
  const plain = chatOf('legacy-2', { title: '旧会话二' })
  const textKey = `${SHA_A}:txt-1`
  const attachment = { id: 'att-legacy', filename: 'old.txt', mimeType: 'text/plain', size: 4, sha256: SHA_A, localPath: attKey(SHA_A), parsedTextPath: textKey, status: 'ready', createdAt: 5 }
  const text = { key: textKey, sha256: SHA_A, parserVersion: 'txt-1', text: '旧全文', characterCount: 3, status: 'success', createdAt: 6 }
  const summaryOf = ({ messages, ...summary }) => summary
  return {
    sessions: [pinned, plain],
    attachment,
    text,
    summaryRows: [pinned, plain].map((session) => ({
      ...summaryOf(session),
      fileIds: session.messages.filter((m) => m.role === 'user').flatMap((m) => m.files.map((f) => f.id)),
    })),
    files: [{ id: 'img-legacy', blob: blobOf('legacy-bytes', 'image/png') }, { id: attKey(SHA_A), blob: blobOf('旧原件', 'text/plain') }],
    asset: { key: 'bg', blob: blobOf('旧背景', 'image/jpeg'), updatedAt: 7 },
  }
}

/** 造 IDB 后端 runner 要的全部钩子。`db` = 真 chat/db.ts，`storage` = idb/backend.ts 的模块。 */
export const createIdbHooks = ({ db, storage }) => {
  const open = () => storage.openIndexedDbStorage()
  /** 清空所有 store（不删库、不换连接）：`db.ts` 缓存一条连接，没有导出重置口。 */
  const clearAll = async () => {
    const tx = await db.openChatTransaction(ALL_STORES, 'readwrite')
    for (const name of ALL_STORES) tx.objectStore(name).clear()
    await tx.done
  }
  const settle = (promise) => promise.then(() => undefined, (error) => error)
  /**
   * 关掉 `db.ts` 缓存的连接、让它忘掉、并删库。`db.ts` 只在「打开失败」时才忘记缓存，所以先造一次瞬时的
   * `VersionError`（库比代码新）逼它忘掉，再删库。
   */
  const resetDb = async () => {
    try {
      ;(await db.getChatDB()).close()
    } catch {
      // 打不开 = 没有连接可关
    }
    const tooNew = await openDB(db.DB_NAME, db.DB_VERSION + 1)
    tooNew.close()
    await settle(db.openChatTransaction(['sessions'], 'readonly'))
    await deleteDatabase(db.DB_NAME)
  }

  return {
    create: async () => {
      await clearAll()
      return open()
    },
    teardown: async (backend) => {
      await backend.close()
    },
    reopen: async (backend) => {
      await backend.close()
      return open()
    },
    inject: createInject(),
    capabilities: { rejectsNonCloneable: true },
    errorClasses: {
      StorageUnavailableError: db.StorageUnavailableError,
      StorageBlockedError: db.StorageBlockedError,
      StorageVersionTooNewError: db.StorageVersionTooNewError,
      classify: db.classifyStorageFailure,
    },
    seedLegacy: async () => {
      await resetDb()
      const data = legacyData()
      const legacy = await openDB(db.DB_NAME, LEGACY_VERSION, {
        upgrade(handle) {
          for (const [name, options, indexes] of LEGACY_SCHEMA) {
            const store = handle.createObjectStore(name, options)
            for (const [indexName, keyPath, indexOptions] of indexes) store.createIndex(indexName, keyPath, indexOptions)
          }
        },
      })
      const tx = legacy.transaction(['sessions', 'sessionSummaries', 'files', 'appAssets', 'attachments', 'attachmentTexts'], 'readwrite')
      for (const session of data.sessions) tx.objectStore('sessions').put(session)
      for (const row of data.summaryRows) tx.objectStore('sessionSummaries').put(row)
      for (const file of data.files) tx.objectStore('files').put(file)
      tx.objectStore('appAssets').put(data.asset)
      tx.objectStore('attachments').put(data.attachment)
      tx.objectStore('attachmentTexts').put(data.text)
      await tx.done
      legacy.close()
      const blobs = {}
      for (const file of data.files) blobs[file.id] = await fold(file.blob)
      return {
        open,
        expected: {
          sessions: data.sessions,
          summaries: data.summaryRows.map(({ fileIds, ...summary }) => summary),
          blobs,
          assets: { bg: { type: data.asset.blob.type, text: '旧背景' } },
          attachments: [data.attachment],
          texts: { [data.text.key]: data.text },
          memory: {},
        },
      }
    },
    openErrors: {
      blocked: async () => {
        await resetDb()
        // 另一条连接攥着旧版本且不响应 versionchange：升级会被挡住，db.ts 在 BLOCKED_TIMEOUT_MS 后判负。
        const holder = await openDB(db.DB_NAME, db.DB_VERSION - 1)
        try {
          return await settle(open())
        } finally {
          holder.close()
          await new Promise((resolve) => setTimeout(resolve, 20))
          await resetDb()
        }
      },
      unavailable: async () => {
        const saved = globalThis.indexedDB
        globalThis.indexedDB = undefined
        try {
          return await settle(open())
        } finally {
          globalThis.indexedDB = saved
        }
      },
      versionTooNew: async () => {
        // db.ts 缓存的连接先关掉（否则它会挡住 v+1 的建库），再造一个比代码新的库。
        ;(await db.getChatDB()).close()
        const tooNew = await openDB(db.DB_NAME, db.DB_VERSION + 1)
        tooNew.close()
        try {
          // 缓存里是已关闭的连接：先让 db.ts 在 InvalidStateError 上忘掉它，下一次 open 才会真的连库。
          await settle(db.openChatTransaction(['sessions'], 'readonly'))
          return await settle(open())
        } finally {
          await deleteDatabase(db.DB_NAME)
        }
      },
    },
  }
}

export { deleteDatabase }

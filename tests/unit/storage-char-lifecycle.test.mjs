// [layer: unit | 依赖: fake-indexeddb | 耗时: <2s]
//
// #906 特征化测试（零行为变化的证据）——库生命周期：升级 / 打开流程 / 持久化申请 / 事务入口。
// 被钉物：`src/services/chat/db.ts` 的 upgradeChatDB、getChatDB（含 openWithBlockedGuard）、
// ensurePersistentStorage、isStoragePersisted、openChatTransaction、runChatStoreRequest。
// （错误分类真值表在姊妹文件 `storage-char-error-table.test.mjs`。）
//
// 与既有用例的分工（本文件**不重复**它们）：
//   · chat-db-reconnect：显式 close() / terminated 后并发共享一次重连、创建事务连续 InvalidStateError、
//     DataCloneError 兜底剔除 —— 本文件只补「非 DOMException 的 InvalidStateError 不重试」「重连一次后成功」等边角；
//   · storage-capability-probe：没有 indexedDB → StorageUnavailableError —— 本文件只补「不缓存 / 不碰 persist」；
//   · memory-session-scope-399 T8 / session-branch-831 ⑦：v13→v15、v14→v15 的升级不变量 —— 本文件补 v1 / 中间版本 /
//     v12 / 经 getChatDB 真路径升级、最终 schema 的 keyPath 与索引属性全表、各起点殊途同归。
//
// 每个用例**自带一份全新的 db.ts 模块实例**（`?inst=N` 查询串绕开模块级的 dbPromise / persistRequest 单例）
// 和一个全新的 `IDBFactory`，用完还原 `indexedDB` / `navigator` 全局：不依赖用例顺序，也不串扰同批文件。
// 不使用 `installImportEnv`（它靠 registerHooks 的假存储、先注册者胜），所以**不需要登记 UNIT_SOLO**。
//
// 关于「v1…v11」：仓库只有一次 Initial commit，老版本的 `upgrade` 回调已不可考；`db.ts` 里**没有任何按
// oldVersion 分支的数据变换迁移**（`upgradeChatDB` 的 `_oldVersion` 形参未使用，全程 `contains()` 守卫、只新增）。
// 所以这里用「合成起点」（标注为 synthetic）证明：任何起点都收敛到同一个 v15 schema，且旧记录逐字节不变。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fake from 'fake-indexeddb'
import { openDB } from 'idb'

import { installTsResolve, moduleUrl } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, snapshotDatabase } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installTsResolve()

// ------------------------------------------------------------------ 装配

let instance = 0
/** 全新的 db.ts 模块实例（模块级单例各自独立） */
const freshDb = () => import(`${moduleUrl('src/services/chat/db.ts')}?inst=${++instance}`)

/** 换一个全新的 IDBFactory 当 `indexedDB`；用例结束还原（含「原来没有」的情形） */
const useFreshIndexedDB = (t) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  globalThis.indexedDB = new fake.IDBFactory()
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'indexedDB', had)
    else delete globalThis.indexedDB
  })
  return globalThis.indexedDB
}

/** `navigator` 在 Node 22 是只读 getter：用 defineProperty 覆盖，结束还原 */
const useNavigator = (t, value) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'navigator', had)
    else delete globalThis.navigator
  })
}

/** 让 fake-indexeddb 的 setImmediate 链与 promise 微任务排空（不依赖被 mock 的 setTimeout） */
const flush = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** 观察一个 promise 的状态而不吞掉它 */
const track = (promise) => {
  const state = { status: 'pending', value: undefined, error: undefined }
  promise.then(
    (value) => Object.assign(state, { status: 'resolved', value }),
    (error) => Object.assign(state, { status: 'rejected', error })
  )
  return state
}

const NOW = 1_700_000_000_000
const sessionRow = (id) => ({ id, title: `旧会话 ${id}`, createdAt: NOW, updatedAt: NOW, messages: [] })

// ------------------------------------------------------------------ 旧版本库的构造函数（冻结的历史 schema）
//
// 每个条目 = [store, 选项, [[索引名, keyPath, 索引选项]…]]。
// 依据（`src/services/chat/db.ts` 的 upgradeChatDB 逐段 + `tests/helpers/chat-db.mjs` 的 seedLegacyV12）：
const S_BASE = [
  // upgradeChatDB 第一段：sessions / files / sessionsStaging / filesStaging（keyPath id）
  ['sessions', { keyPath: 'id' }, []],
  ['files', { keyPath: 'id' }, []],
  ['sessionsStaging', { keyPath: 'id' }, []],
  ['filesStaging', { keyPath: 'id' }, []],
  // sessionSummaries + fileIds 索引（multiEntry）；branchOf 是 v15 才加（#831），旧版没有
  ['sessionSummaries', { keyPath: 'id' }, [['fileIds', 'fileIds', { multiEntry: true }]]],
  // appAssets（keyPath key）
  ['appAssets', { keyPath: 'key' }, []],
]
// v13（#480）：upgradeChatDB 的 `attachments`（sha256 / parsedTextPath）与 `attachmentTexts`（sha256）段
const S_ATTACH = [
  ['attachments', { keyPath: 'id' }, [['sha256', 'sha256', {}], ['parsedTextPath', 'parsedTextPath', {}]]],
  ['attachmentTexts', { keyPath: 'key' }, [['sha256', 'sha256', {}]]],
]
// v14（#399）：upgradeChatDB 的 `sessionMemory`（sessionId 索引）段
const S_MEMORY = [['sessionMemory', { keyPath: 'id' }, [['sessionId', 'sessionId', {}]]]]

/**
 * 起点表。`kind`：real = 与历史真实 schema 对应（v12/v13/v14，来源如上）；
 * synthetic = 合成起点（仓库无 v1~v11 历史，只用来证明升级回调不依赖起点）。
 */
const LEGACY_STARTS = [
  { label: 'v1 空库（synthetic：库存在但没有任何 store）', kind: 'synthetic', version: 1, schema: [] },
  { label: 'v1 只有 sessions（synthetic）', kind: 'synthetic', version: 1, schema: [['sessions', { keyPath: 'id' }, []]] },
  {
    label: 'v6 摘要没有 fileIds 索引（synthetic）',
    kind: 'synthetic',
    version: 6,
    schema: [
      ['sessions', { keyPath: 'id' }, []],
      ['files', { keyPath: 'id' }, []],
      ['sessionSummaries', { keyPath: 'id' }, []],
    ],
  },
  { label: 'v12（real：附件两表之前）', kind: 'real', version: 12, schema: S_BASE },
  { label: 'v13（real：+attachments / attachmentTexts）', kind: 'real', version: 13, schema: [...S_BASE, ...S_ATTACH] },
  { label: 'v14（real：+sessionMemory）', kind: 'real', version: 14, schema: [...S_BASE, ...S_ATTACH, ...S_MEMORY] },
]

/** 在 `factory` 上建一个旧版本 `chat-demo` 库，并按「存在的 store」写入旧数据 */
const seedLegacy = async ({ version, schema }) => {
  const handle = await openDB('chat-demo', version, {
    upgrade(upgrading) {
      for (const [name, options, indexes] of schema) {
        const store = upgrading.createObjectStore(name, options)
        for (const [indexName, keyPath, indexOptions] of indexes) {
          store.createIndex(indexName, keyPath, indexOptions)
        }
      }
    },
  })
  const names = new Set(schema.map(([name]) => name))
  const put = async (store, value) => names.has(store) && handle.put(store, value)
  await put('sessions', { ...sessionRow('legacy-1'), pinnedAt: NOW + 1, someFutureField: { nested: [1, 2] } })
  await put('sessionSummaries', { id: 'legacy-1', title: '旧会话 legacy-1', createdAt: NOW, updatedAt: NOW, fileIds: ['f1', 'f2'] })
  await put('files', { id: 'f1', blob: new Blob(['OLD-BYTES'], { type: 'image/png' }) })
  await put('appAssets', { key: 'chat-background', blob: new Blob(['BG'], { type: 'image/png' }), updatedAt: NOW })
  await put('attachments', { id: 'att-1', sha256: 'a'.repeat(64), parsedTextPath: `${'a'.repeat(64)}:v1`, status: 'success' })
  await put('attachmentTexts', { key: `${'a'.repeat(64)}:v1`, sha256: 'a'.repeat(64), text: 'abc' })
  await put('sessionMemory', { id: 'legacy-1:k', sessionId: 'legacy-1', key: 'k', text: '旧记忆', bytes: 9 })
  handle.close()
  return names
}

/** v15 的完整 schema（含 keyPath / multiEntry / unique）：将来换存储实现时这就是「库长什么样」的口径 */
const V15_SCHEMA = {
  sessions: { keyPath: 'id', indexes: {} },
  files: { keyPath: 'id', indexes: {} },
  sessionsStaging: { keyPath: 'id', indexes: {} },
  filesStaging: { keyPath: 'id', indexes: {} },
  sessionSummaries: {
    keyPath: 'id',
    indexes: {
      fileIds: { keyPath: 'fileIds', multiEntry: true, unique: false },
      branchOf: { keyPath: 'branchOf.sessionId', multiEntry: false, unique: false },
    },
  },
  appAssets: { keyPath: 'key', indexes: {} },
  attachments: {
    keyPath: 'id',
    indexes: {
      sha256: { keyPath: 'sha256', multiEntry: false, unique: false },
      parsedTextPath: { keyPath: 'parsedTextPath', multiEntry: false, unique: false },
    },
  },
  attachmentTexts: {
    keyPath: 'key',
    indexes: { sha256: { keyPath: 'sha256', multiEntry: false, unique: false } },
  },
  sessionMemory: {
    keyPath: 'id',
    indexes: { sessionId: { keyPath: 'sessionId', multiEntry: false, unique: false } },
  },
}

/** 读出整库 schema（不经被测模块） */
const schemaOf = async (name = 'chat-demo') => {
  const handle = await openDB(name)
  try {
    const out = {}
    for (const storeName of [...handle.objectStoreNames].sort()) {
      const store = handle.transaction(storeName, 'readonly').store
      const indexes = {}
      for (const indexName of [...store.indexNames].sort()) {
        const index = store.index(indexName)
        indexes[indexName] = { keyPath: index.keyPath, multiEntry: index.multiEntry, unique: index.unique }
      }
      out[storeName] = { keyPath: store.keyPath, indexes }
    }
    return { version: handle.version, stores: out }
  } finally {
    handle.close()
  }
}

// ------------------------------------------------------------------ 迁移

test('迁移：全新库（oldVersion=0）→ v15 的完整 schema（store / keyPath / 索引属性全表）', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  assert.equal(db.DB_VERSION, 15)
  assert.equal(db.DB_NAME, 'chat-demo')
  const handle = await db.getChatDB()
  t.after(() => handle.close())
  assert.deepEqual(await schemaOf(), { version: 15, stores: V15_SCHEMA })
})

for (const start of LEGACY_STARTS) {
  test(`迁移：${start.label} → v15：schema 收敛、旧记录逐字不变、新索引对旧记录的可见性`, async (t) => {
    useFreshIndexedDB(t)
    const present = await seedLegacy(start)
    const before = await snapshotDatabase('chat-demo')
    assert.equal(before.version, start.version)
    assert.deepEqual(before.stores, [...present].sort(), '前置：旧库只有该版本该有的 store')

    const db = await freshDb()
    const handle = await db.getChatDB()
    t.after(() => handle.close())

    // ① 不论起点，最终 schema 完全相同（upgradeChatDB 不看 oldVersion）
    assert.deepEqual(await schemaOf(), { version: 15, stores: V15_SCHEMA })

    // ② 旧 store 里的旧记录逐字不变（升级没有数据变换：没有回填、没有改写、没有清空）
    const after = await snapshotDatabase('chat-demo')
    for (const store of before.stores) {
      assert.deepEqual(after.data[store], before.data[store], `${store} 的旧记录被升级改动了`)
    }
    // 旧 store 上「旧索引」一个不少
    for (const store of before.stores) {
      for (const index of before.indexes[store]) {
        assert.ok(after.indexes[store].includes(index), `${store}.${index} 旧索引丢了`)
      }
    }

    // ③ 新建的索引会**对已有记录建项**（IndexedDB 语义）；branchOf 对没有该字段的旧记录天然不收录
    if (present.has('sessionSummaries')) {
      assert.deepEqual(
        (await handle.getAllFromIndex('sessionSummaries', 'fileIds', 'f1')).map((row) => row.id),
        ['legacy-1'],
        'fileIds 索引（含起点没有该索引的 v6）必须覆盖升级前就存在的摘要'
      )
      assert.equal(await handle.countFromIndex('sessionSummaries', 'branchOf'), 0, '老记录没有 branchOf，不进索引')
    }
    // ④ Blob 字节没变（snapshot 里 Blob 只折 type/size，这里再读一次真实字节）
    if (present.has('files')) {
      assert.equal(await (await handle.get('files', 'f1')).blob.text(), 'OLD-BYTES')
    }
    // ⑤ 升级后新 store 立刻可写（新 store 不是只读摆设）
    await handle.put('sessionMemory', { id: 'x:y', sessionId: 'x', key: 'y', text: 't', bytes: 1 })
    assert.equal((await handle.getAllFromIndex('sessionMemory', 'sessionId', 'x')).length, 1)
  })
}

test('迁移：经产品入口读到升级后的旧会话（loadSession / loadSessionSummaries 与升级前同值）', async (t) => {
  useFreshIndexedDB(t)
  await seedLegacy(LEGACY_STARTS.find((s) => s.version === 12))
  const db = await freshDb()
  t.after(async () => (await db.getChatDB()).close())
  const session = await db.loadSession('legacy-1')
  assert.deepEqual(session, { ...sessionRow('legacy-1'), pinnedAt: NOW + 1, someFutureField: { nested: [1, 2] } },
    '未知字段（someFutureField）也原样带出：升级与读取都不裁剪字段')
  const summaries = await db.loadSessionSummaries()
  assert.deepEqual(summaries.map((s) => s.id), ['legacy-1'])
  assert.equal('fileIds' in summaries[0], false, 'loadSessionSummaries 经 toSessionSummary 去掉内部字段 fileIds')
})

test('迁移：已经是 v15 的库再打开不触发升级（数据与 schema 不动）', async (t) => {
  useFreshIndexedDB(t)
  const first = await freshDb()
  const handle = await first.getChatDB()
  await handle.put('sessions', sessionRow('keep'))
  handle.close()
  const second = await freshDb()
  const reopened = await second.getChatDB()
  t.after(() => reopened.close())
  assert.equal(reopened.version, 15)
  assert.deepEqual(await reopened.get('sessions', 'keep'), sessionRow('keep'))
})

/**
 * 临时接管 `unhandledRejection`：idb 为 versionchange 事务建了一个无人订阅的 `done` promise，
 * 升级事务中止时它会以 AbortError 变成「未处理的 rejection」（现状如此，见文件末尾「看似 bug」清单）。
 * node:test 会把它算到用例头上判红，所以用例内先摘掉别人的监听、自己收集、结束后原样还原。
 */
const captureUnhandledRejections = (t) => {
  const saved = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  const seen = []
  const listener = (reason) => seen.push(reason)
  process.on('unhandledRejection', listener)
  t.after(() => {
    process.off('unhandledRejection', listener)
    for (const fn of saved) process.on('unhandledRejection', fn)
  })
  return seen
}

test('迁移失败：升级回调抛错 → getChatDB 以 AbortError 拒绝、库不被创建、下一次能重新建成', async (t) => {
  useFreshIndexedDB(t)
  const unhandled = captureUnhandledRejections(t)
  const db = await freshDb()
  const original = IDBDatabase.prototype.createObjectStore
  let broken = true
  t.mock.method(IDBDatabase.prototype, 'createObjectStore', function (...args) {
    if (broken) throw new DOMException('模拟升级失败', 'ConstraintError')
    return original.apply(this, args)
  })
  await assert.rejects(db.getChatDB(), (error) => error.name === 'AbortError', '升级事务被中止，错误名是 AbortError（不是回调抛的 ConstraintError）')
  assert.equal(db.classifyStorageFailure({ name: 'AbortError' }), 'unknown', '该失败走可重试档')
  await flush()
  assert.deepEqual(unhandled.map((reason) => reason?.name), ['AbortError'], '现状：idb 的升级事务 done 另产生一条无人处理的 AbortError rejection')
  assert.deepEqual(await indexedDB.databases(), [], '升级失败后不留半成品库')
  broken = false
  const handle = await db.getChatDB()
  t.after(() => handle.close())
  assert.equal(handle.version, 15, '失败没有被缓存：故障解除后下一次就能建成')
})

// ------------------------------------------------------------------ 打开流程：单例 / blocked / 版本过新 / 缺能力

/** 先在同一个 IDBFactory 里占住一个旧版本连接（不响应 versionchange），制造「另一标签页攥着旧连接」 */
const holdOldConnection = (version = 14) =>
  openDB('chat-demo', version, { upgrade: (upgrading) => upgrading.createObjectStore('sessions', { keyPath: 'id' }) })

test('单例：并发 getChatDB 共享同一个 promise 与同一个连接，只调一次 indexedDB.open', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const opens = t.mock.method(indexedDB, 'open')
  const first = db.getChatDB()
  const second = db.getChatDB()
  assert.equal(first, second, '同一个 promise 对象')
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b)
  assert.equal(await db.getChatDB(), a, '已解决后仍是缓存的那个连接')
  assert.equal(opens.mock.callCount(), 1)
  a.close()
})

test('isIndexedDBAvailable：只看 typeof indexedDB，每次调用都重新探测', async (t) => {
  const db = await freshDb()
  useFreshIndexedDB(t)
  assert.equal(db.isIndexedDBAvailable(), true)
  delete globalThis.indexedDB
  assert.equal(db.isIndexedDBAvailable(), false)
  globalThis.indexedDB = null
  assert.equal(db.isIndexedDBAvailable(), true, '现状：只判 typeof !== "undefined"，null 也算「有」')
})

test('缺能力：每次都给新的 StorageUnavailableError（不缓存）、不申请持久化、openChatTransaction / loadSession 同样拒绝', async (t) => {
  const db = await freshDb()
  let persistCalls = 0
  useNavigator(t, { storage: { persisted: async () => false, persist: async () => (persistCalls++, true) } })
  useFreshIndexedDB(t)
  delete globalThis.indexedDB
  const first = db.getChatDB()
  const second = db.getChatDB()
  assert.notEqual(first, second, '失败不进缓存：每次是新的 rejected promise')
  for (const promise of [first, second]) {
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof db.StorageUnavailableError)
      assert.equal(error.name, 'StorageUnavailableError')
      assert.equal(error.message, 'IndexedDB is not available in this environment')
      assert.equal(error.initFailure, undefined, '它没有 initFailure 档位（只有 blocked / version 两种换文案）')
      return true
    })
  }
  await assert.rejects(db.openChatTransaction(['sessions']), (error) => error.name === 'StorageUnavailableError')
  await assert.rejects(db.runChatStoreRequest('sessions', 'readonly', (store) => store.getAll()), (error) => error.name === 'StorageUnavailableError')
  await flush()
  assert.equal(persistCalls, 0, '没有 IndexedDB 就不去申请持久化')
  // 能力出现后同一模块实例立刻可用（缺能力没有留下任何缓存）
  globalThis.indexedDB = new fake.IDBFactory()
  const handle = await db.getChatDB()
  assert.equal(handle.version, 15)
  handle.close()
})

test('getChatDB 真要碰库之前申请一次持久化存储（多次调用只问一次）', async (t) => {
  let persistCalls = 0
  useNavigator(t, { storage: { persisted: async () => false, persist: async () => (persistCalls++, true) } })
  useFreshIndexedDB(t)
  const db = await freshDb()
  const handle = await db.getChatDB()
  await db.getChatDB()
  await db.ensurePersistentStorage()
  assert.equal(persistCalls, 1)
  handle.close()
})

test('版本过新：库 v16 > 代码 v15 → StorageVersionTooNewError（initFailure=version，保留引擎原文），不降级、不缓存', async (t) => {
  useFreshIndexedDB(t)
  const newer = await holdOldConnection(16)
  newer.close()
  const db = await freshDb()
  const reject = async () => {
    try {
      await db.getChatDB()
    } catch (error) {
      return error
    }
    assert.fail('应当拒绝')
  }
  const error = await reject()
  assert.ok(error instanceof db.StorageVersionTooNewError)
  assert.equal(error.name, 'StorageVersionTooNewError')
  assert.equal(error.initFailure, 'version')
  assert.match(error.message, /lower version than the existing version/, 'message 沿用引擎的 VersionError 原文')
  assert.equal(new db.StorageVersionTooNewError().message, 'The stored database version is newer than this app expects', '无参构造的默认文案')
  assert.equal(db.classifyStorageFailure(error), 'unavailable')
  const again = await reject()
  assert.notEqual(again, error, '失败不缓存：第二次是重新打开后的新错误')
  assert.deepEqual(await indexedDB.databases(), [{ name: 'chat-demo', version: 16 }], '不降级、不改库')
})

test('blocked：5000ms 内没人放手 → StorageBlockedError（initFailure=blocked）；4999ms 仍 pending；失败不缓存', async (t) => {
  useFreshIndexedDB(t)
  const blocker = await holdOldConnection()
  const db = await freshDb()
  assert.equal(db.BLOCKED_TIMEOUT_MS, 5000)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = db.getChatDB()
  const state = track(first)
  await flush()
  assert.equal(state.status, 'pending', 'blocked 一触发就开始计时，但没到点前不判')
  t.mock.timers.tick(4999)
  await flush()
  assert.equal(state.status, 'pending')
  t.mock.timers.tick(1)
  await flush()
  assert.equal(state.status, 'rejected')
  assert.ok(state.error instanceof db.StorageBlockedError)
  assert.equal(state.error.name, 'StorageBlockedError')
  assert.equal(state.error.initFailure, 'blocked')
  assert.equal(state.error.message, 'Another tab holds an older database connection')
  assert.equal(db.classifyStorageFailure(state.error), 'unknown', '另一标签页占着：可重试档，不是环境缺能力')
  assert.notEqual(db.getChatDB(), first, '失败已被忘掉：再调用会重新发起打开')
  blocker.close()
  await flush()
})

test('blocked 超时之后对方才放手：迟到的连接被立刻 close()（不会继续占升级锁堵下一个标签页）', async (t) => {
  useFreshIndexedDB(t)
  const blocker = await holdOldConnection()
  const db = await freshDb()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = track(db.getChatDB())
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(state.status, 'rejected')
  blocker.close()
  await flush()
  assert.equal(state.status, 'rejected', '已判负的 promise 不会翻案')
  assert.deepEqual(await indexedDB.databases(), [{ name: 'chat-demo', version: db.DB_VERSION }], '升级其实在对方放手后完成了')
  // 若迟到连接没被关掉，下面这次再升一版会收到 blocked（版本号从 DB_VERSION 推，不写死）
  let blockedAgain = false
  const next = await openDB('chat-demo', db.DB_VERSION + 1, { blocked: () => { blockedAgain = true } })
  next.close()
  assert.equal(blockedAgain, false, '迟到连接已被 close()')
})

test('blocked 超时后重试：对方放手后下一次 getChatDB 成功（库已是 v15）', async (t) => {
  useFreshIndexedDB(t)
  const blocker = await holdOldConnection()
  const db = await freshDb()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = track(db.getChatDB())
  await flush()
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(state.error?.name, 'StorageBlockedError')
  blocker.close()
  await flush()
  const handle = await db.getChatDB()
  assert.equal(handle.version, 15)
  handle.close()
})

test('blocked 之后对方在超时前放手：正常解决，计时器被清掉（再过 10s 也不会翻成失败）', async (t) => {
  useFreshIndexedDB(t)
  const blocker = await holdOldConnection()
  const db = await freshDb()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const state = track(db.getChatDB())
  await flush()
  t.mock.timers.tick(4999)
  blocker.close()
  await flush()
  assert.equal(state.status, 'resolved')
  assert.equal(state.value.version, 15)
  t.mock.timers.tick(10_000)
  await flush()
  assert.equal(state.status, 'resolved')
  state.value.close()
})

test('其它打开失败：upgrade 回调抛错的 AbortError 原样抛出（不包装成专用错误）；open 同步抛 TypeError 时 getChatDB 同步抛、不进缓存', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const original = indexedDB.open.bind(indexedDB)
  t.mock.method(indexedDB, 'open', () => {
    throw new TypeError('open boom')
  })
  // 现状：openDB 在 Promise 构造器之外同步调用 indexedDB.open，所以这里是同步异常而不是 rejected promise
  assert.throws(() => db.getChatDB(), (error) => error instanceof TypeError && error.message === 'open boom')
  indexedDB.open.mock.restore()
  assert.equal(typeof original, 'function')
  const handle = await db.getChatDB()
  assert.equal(handle.version, 15, '同步抛错没有污染缓存，下一次能正常打开')
  handle.close()
})

// ------------------------------------------------------------------ 持久化存储

const PERSIST_ROWS = [
  // [行名, navigator 值, ensurePersistentStorage 结果, persist 调用次数, isStoragePersisted 结果]
  ['没有 navigator', undefined, false, 0, undefined],
  ['navigator 没有 storage', {}, false, 0, undefined],
  ['storage 为 null', { storage: null }, false, 0, undefined],
  ['storage 不是对象（字符串）', { storage: 'x' }, false, 0, undefined],
  ['有 storage 但没有 persist / persisted', { storage: {} }, false, 0, undefined],
  ['只有 persisted（没有 persist）→ ensure=false、persisted 如实', { storage: { persisted: async () => true } }, false, 0, true],
  ['persist 不是函数', { storage: { persist: true, persisted: async () => false } }, false, 0, false],
  ['已持久化：不再调用 persist', { storage: { persisted: async () => true, persist: async () => false } }, true, 0, true],
  ['未持久化、persist 批准', { storage: { persisted: async () => false, persist: async () => true } }, true, 1, false],
  ['未持久化、persist 拒绝', { storage: { persisted: async () => false, persist: async () => false } }, false, 1, false],
  ['没有 persisted 函数、persist 批准', { storage: { persist: async () => true } }, true, 1, undefined],
  ['persist 抛错（reject）→ false，不抛', { storage: { persisted: async () => false, persist: async () => { throw new Error('denied') } } }, false, 1, false],
  ['persist 同步抛错 → false，不抛', { storage: { persisted: async () => false, persist: () => { throw new Error('sync') } } }, false, 1, false],
  ['persisted 抛错 → ensure=false（且不再调 persist）、isStoragePersisted=undefined', { storage: { persisted: async () => { throw new Error('x') }, persist: async () => true } }, false, 0, undefined],
]

for (const [label, navigatorValue, ensured, persistCalls, persisted] of PERSIST_ROWS) {
  test(`持久化：${label}`, async (t) => {
    let calls = 0
    if (navigatorValue?.storage && typeof navigatorValue.storage === 'object' && typeof navigatorValue.storage.persist === 'function') {
      const inner = navigatorValue.storage.persist
      navigatorValue.storage.persist = (...args) => (calls++, inner(...args))
    }
    useNavigator(t, navigatorValue)
    const db = await freshDb()
    assert.equal(await db.ensurePersistentStorage(), ensured)
    assert.equal(calls, persistCalls)
    assert.equal(await db.isStoragePersisted(), persisted)
  })
}

test('持久化：幂等——同一个 promise、只问一次；结果（含 false）被缓存，之后 API 变化也不重问', async (t) => {
  let calls = 0
  const storage = { persisted: async () => false, persist: async () => (calls++, false) }
  useNavigator(t, { storage })
  const db = await freshDb()
  const first = db.ensurePersistentStorage()
  assert.equal(db.ensurePersistentStorage(), first)
  assert.equal(await first, false)
  storage.persist = async () => (calls++, true)
  assert.equal(await db.ensurePersistentStorage(), false, '现状：拒绝的结果也缓存到进程结束')
  assert.equal(calls, 1)
})

test('持久化：isStoragePersisted 不缓存，每次现问', async (t) => {
  let value = false
  useNavigator(t, { storage: { persisted: async () => value } })
  const db = await freshDb()
  assert.equal(await db.isStoragePersisted(), false)
  value = true
  assert.equal(await db.isStoragePersisted(), true)
})

// ------------------------------------------------------------------ openChatTransaction / runChatStoreRequest

test('openChatTransaction：mode 缺省为 readonly；多 store 事务可同开', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const single = await db.openChatTransaction(['sessions'])
  assert.equal(single.mode, 'readonly')
  await single.done
  const multi = await db.openChatTransaction(['sessions', 'sessionSummaries'], 'readwrite')
  assert.equal(multi.mode, 'readwrite')
  assert.deepEqual([...multi.objectStoreNames].sort(), ['sessionSummaries', 'sessions'])
  await multi.done
  ;(await db.getChatDB()).close()
})

test('openChatTransaction：创建事务抛 InvalidStateError → 忘掉连接重开一次；仍失败则把错误抛出（共 2 次尝试）', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const first = await db.getChatDB()
  const opens = t.mock.method(indexedDB, 'open')
  const original = IDBDatabase.prototype.transaction
  let attempts = 0
  t.mock.method(IDBDatabase.prototype, 'transaction', function () {
    attempts++
    throw new DOMException('closing', 'InvalidStateError')
  })
  await assert.rejects(db.openChatTransaction(['sessions']), (error) => error instanceof DOMException && error.name === 'InvalidStateError')
  assert.equal(attempts, 2)
  assert.equal(opens.mock.callCount(), 1, '第一次失败后重连一次；第二次失败直接抛，不再重连')
  IDBDatabase.prototype.transaction.mock.restore()
  assert.equal(typeof original, 'function')
  assert.notEqual(await db.getChatDB(), first, '缓存里已经是重开后的新连接')
})

test('openChatTransaction：第一次 InvalidStateError、重连后成功 → 返回事务（只重开一次）', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  await db.getChatDB()
  const opens = t.mock.method(indexedDB, 'open')
  const original = IDBDatabase.prototype.transaction
  let attempts = 0
  t.mock.method(IDBDatabase.prototype, 'transaction', function (...args) {
    if (++attempts === 1) throw new DOMException('closing', 'InvalidStateError')
    return original.apply(this, args)
  })
  const tx = await db.openChatTransaction(['sessions'], 'readwrite')
  assert.equal(tx.mode, 'readwrite')
  assert.equal(attempts, 2)
  assert.equal(opens.mock.callCount(), 1)
  await tx.done
})

const NO_RETRY_ROWS = [
  ['DOMException NotFoundError（store 不存在）', () => new DOMException('x', 'NotFoundError'), 'NotFoundError'],
  ['DOMException TransactionInactiveError', () => new DOMException('x', 'TransactionInactiveError'), 'TransactionInactiveError'],
  ['普通 Error 但 name=InvalidStateError（不是 DOMException 实例）', () => Object.assign(new Error('x'), { name: 'InvalidStateError' }), 'InvalidStateError'],
  ['普通 TypeError', () => new TypeError('x'), 'TypeError'],
]
for (const [label, make, name] of NO_RETRY_ROWS) {
  test(`openChatTransaction：${label} 不重连、直接抛`, async (t) => {
    useFreshIndexedDB(t)
    const db = await freshDb()
    await db.getChatDB()
    const opens = t.mock.method(indexedDB, 'open')
    let attempts = 0
    t.mock.method(IDBDatabase.prototype, 'transaction', () => {
      attempts++
      throw make()
    })
    await assert.rejects(db.openChatTransaction(['sessions']), (error) => error.name === name)
    assert.equal(attempts, 1)
    assert.equal(opens.mock.callCount(), 0)
  })
}

test('runChatStoreRequest：返回 request 的结果；readwrite 提交后他处可见', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const put = await db.runChatStoreRequest('sessions', 'readwrite', async (store) => {
    await store.put(sessionRow('r1'))
    return 'done'
  })
  assert.equal(put, 'done')
  assert.deepEqual(await db.runChatStoreRequest('sessions', 'readonly', (store) => store.get('r1')), sessionRow('r1'))
})

test('runChatStoreRequest：request 自己抛错 → 原样传出；事务不被 abort，已 put 的写入照常提交', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const boom = new Error('req boom')
  await assert.rejects(
    db.runChatStoreRequest('sessions', 'readwrite', async (store) => {
      await store.put(sessionRow('half'))
      throw boom
    }),
    (error) => error === boom
  )
  await flush()
  // 现状：request 抛错时并没有显式 abort，事务会照常提交 —— 先写进去的 put 是落盘的（见「看似 bug」清单）
  assert.deepEqual(await db.runChatStoreRequest('sessions', 'readonly', (store) => store.get('half')), sessionRow('half'))
})

test('runChatStoreRequest：事务提交失败（request 已成功返回，tx.done 以 AbortError 拒绝）→ 把提交失败传给调用方', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  await assert.rejects(
    db.runChatStoreRequest('sessions', 'readwrite', async (store) => {
      await store.put(sessionRow('aborted'))
      store.transaction.abort()
      return 'request-was-fine'
    }),
    (error) => error.name === 'AbortError'
  )
  assert.equal(await db.runChatStoreRequest('sessions', 'readonly', (store) => store.get('aborted')), undefined)
})

test('runChatStoreRequest：store 名不存在 → NotFoundError（来自 transaction()，不重连）', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  const opens = t.mock.method(indexedDB, 'open')
  await assert.rejects(db.runChatStoreRequest('nope', 'readonly', (store) => store.getAll()), (error) => error.name === 'NotFoundError')
  assert.equal(opens.mock.callCount(), 1, '只有首次建库那一次 open')
})

test('runChatStoreRequest：只读事务里写 → ReadOnlyError 传出', async (t) => {
  useFreshIndexedDB(t)
  const db = await freshDb()
  await assert.rejects(
    db.runChatStoreRequest('sessions', 'readonly', (store) => store.put(sessionRow('ro'))),
    (error) => error.name === 'ReadOnlyError'
  )
})

// ------------------------------------------------------------------ 「看似 bug 但先钉死」清单（#906：重构要不要保留，由后续 Issue 决定，别在重构里顺手改）
//
//  1. getChatDB() 在 `indexedDB.open` 同步抛错（TypeError）时是**同步抛**，而不是返回 rejected promise
//     （idb 的 openDB 在 Promise 构造器外调用 open）；调用方 `await getChatDB()` 看不出差别，`.catch()` 链会漏。
//  2. upgrade 回调抛错：getChatDB 拒绝 AbortError，同时 idb 的升级事务 `done` 产生一条**无人处理**的
//     AbortError unhandledRejection（浏览器里只是控制台报错，Node 里会炸进程）。
//  3. upgradeChatDB 的 `_oldVersion` 完全不用：没有任何按版本分支的「数据变换」迁移，只有 contains() 守卫的只增迁移。
//  4. runChatStoreRequest 里 request 抛错**不会 abort 事务**：此前已 put 的写入照常提交（部分写入落盘）。
//  5. openChatTransaction 只对 `instanceof DOMException` 的 InvalidStateError 重连；同名普通 Error 不重连。
//  6. ensurePersistentStorage 把「被拒绝(false)」也永久缓存，整个进程生命周期不再重问。
//  7. isIndexedDBAvailable 只判 `typeof indexedDB !== 'undefined'`：null 也算有能力。
//  8. 分类：StorageBlockedError → unknown（可重试），而 StorageVersionTooNewError / SecurityError / UnknownError → unavailable（无重试按钮）；
//     原始 VersionError 本身是 unknown，只有经 openWithBlockedGuard 包装后才是 unavailable。
//  9. normalizeStorageFailure([]) 得到 { kind: 'unknown' }（数组也是 object）；非法 kind 静默改写成 unknown，其它字段透传。

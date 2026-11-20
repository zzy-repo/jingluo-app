// L1 集成层的 IndexedDB 夹具（Issue #547）：库名 / 版本号 / 建库方式都只有一个来源。
//
// 为什么要有它：`copy-limit.test.mjs` 与 `domain04-session-list-flow.test.mjs` 原来各自手写一份
// 「应用库的 schema + 版本号 12」，#529 把库升到 v13 后两份 fixture 都用**低版本打开已存在的库**：
//
//   VersionError: The requested version (12) is less than the existing version (13)
//
// 于是两个 L1 文件在建库那一步就中断（CI run 44723070855 / job 136243482814 真红，重跑仍红）。
// 写死的版本号不是「一次笔误」，是同一个 bug 的复制品 —— 以后每次加 store 都要有人记得改两处。
// 所以这里定三件事：
//
//   1. **版本号与库名只有一个来源**：`src/services/chat/db.ts` 导出的 `DB_VERSION` / `DB_NAME`。
//      本文件用 `tests/helpers/dom-env.mjs` 的 `installTsResolve()`（`.js→.ts` 解析）**真加载源码**取值，
//      不是从源码文本里抠数字 —— 源码改写法（换引号 / 拆常量）不会被这条夹具误伤；
//   2. **夹具不手写当前 schema**：库由被测产物自己建（应用启动 `initChat()` → `openDB(name, DB_VERSION)`），
//      夹具只等它建好、核对版本、然后往里写数据。第三份 schema 实现（fixture 版）必然再次漂移，
//      而且它漂移时**不会报错**，只会让用例在「库长得和真机不一样」的前提下变绿；
//   3. **只写死迁移起点** `LEGACY_DB_VERSION = 12`：它描述的是历史 v12 的 schema，不是当前版本，
//      永远不会跟着 `DB_VERSION` 走 —— 这是唯一应该写死的那一个数字。
//
// 用法（L1 用例）：
//
//   import { DB_NAME, DB_VERSION, ensureChatDb, clearChatDb, seedSessions } from '../helpers/chat-db.mjs'
//
//   await ensureChatDb(page)            // 应用自己建库；等它就绪并核对版本 = DB_VERSION
//   await clearChatDb(page)             // 清空业务数据（不删库：应用自己还连着）
//   await seedSessions(page, sessions)  // 直接写 IndexedDB，deterministic 造数据
//
// 迁移用例额外用 `seedLegacyV12()`（建 v12 库 + 写旧数据）与 `readAllStores()`（整库快照）。
import { installTsResolve, loadTsModule } from './dom-env.mjs'

// `.js→.ts` 解析：源码里 `import './history/mergeSessions.js'` 实际文件是 `.ts`，
// 裸 node 不会自己换后缀（见 dom-env.mjs 的 resolveTypescript）。必须在动态 import 之前装好。
installTsResolve()
const chatDb = await loadTsModule('src/services/chat/db.ts')

/** 应用库名（`chat-demo`），来自 `src/services/chat/db.ts` 的 `DB_NAME` —— 用例里不许再写字面量。 */
export const DB_NAME = chatDb.DB_NAME

/** 应用当前库版本（v13），来自 `src/services/chat/db.ts` 的 `DB_VERSION` —— 用例里不许再写字面量。 */
export const DB_VERSION = chatDb.DB_VERSION

/**
 * 迁移起点：v12（#480 之前的最后一次 schema）。**故意写死**：这是历史事实，不是当前版本。
 * 改了 `DB_VERSION` 之后它会作为「旧库」被 `seedLegacyV12()` 建出来，用来验升级路径。
 */
export const LEGACY_DB_VERSION = 12

/** L1 fixture 会写数据的两个 store（列表 + 详情）；其它 store 由应用建，夹具不碰。 */
export const SEEDED_STORES = ['sessions', 'sessionSummaries']

/**
 * 同源空白文档：用 `page.route()` 把页面文档换成它，拿一个**同源但没跑应用脚本**的页面，
 * 这样就能在应用启动之前把 v12 旧库建好（否则应用一启动就把库建到 v13，没有「升级」可验）。
 */
export const PROBE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>chat-db probe</title></head><body></body></html>'

/**
 * 页内：打开已存在的应用库（**不带版本号** → 拿到当前版本，绝不会触发降级 VersionError）。
 * 库不存在时直接报错，而不是「以 v1 建一个空库」—— 空库会让后续断言以一种莫名其妙的方式失败。
 */
export const openExistingDb = async ({ name, stores = [] }) => {
  const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null
  if (databases && !databases.some((info) => info.name === name)) {
    throw new Error(`库 ${name} 还不存在：应用还没建它（夹具不会替你建库，见 #547）`)
  }
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const missing = stores.filter((store) => !db.objectStoreNames.contains(store))
  if (missing.length > 0) {
    const actual = [...db.objectStoreNames].join(' / ')
    db.close()
    throw new Error(`库 ${name} 缺 store：${missing.join(' / ')}（实际只有 ${actual}）`)
  }
  return db
}

/** 页内：整库快照（store → 全部记录）。Blob 折成 { type, size, text }，才能跨 evaluate 比对。 */
export const readAllStores = async ({ name }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const blobInfo = async (blob) => ({ type: blob.type, size: blob.size, text: await blob.text() })
  const stores = [...db.objectStoreNames].sort()
  const snapshot = { version: db.version, stores, data: {}, indexes: {} }
  for (const store of stores) {
    const tx = db.transaction(store, 'readonly')
    const objectStore = tx.objectStore(store)
    snapshot.indexes[store] = [...objectStore.indexNames].sort()
    const rows = await new Promise((resolve, reject) => {
      const request = objectStore.getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    // 记录里可能嵌 Blob（files / appAssets 存的就是 { id, blob }）
    snapshot.data[store] = await Promise.all(
      rows.map(async (row) => {
        if (!row || typeof row !== 'object') {
          return row
        }
        const copy = { ...row }
        for (const [key, value] of Object.entries(copy)) {
          if (value instanceof Blob) {
            copy[key] = { __blob: await blobInfo(value) }
          }
        }
        return copy
      })
    )
  }
  db.close()
  return snapshot
}

/**
 * 页内：建 **v12 旧库**（冻结的历史 schema，见 `LEGACY_DB_VERSION`）并写入旧数据。
 * v12 的 store/索引清单来自 `src/services/chat/db.ts` 在 v13 之前的 upgrade 回调；
 * 它不会跟着当前 schema 变 —— 这正是「升级路径」要测的起点。
 *
 * payload 里带二进制的数据用 `{ text, type }` 描述，由页内自己 `new Blob([text], { type })`：
 * Blob 过不了 Playwright 的 evaluate 序列化，但「原件字节有没有被升级改掉」恰恰是要断言的东西。
 */
export const seedLegacyV12 = async ({ name, version, payload }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => {
      const opened = request.result
      for (const store of ['sessions', 'files', 'sessionsStaging', 'filesStaging']) {
        opened.createObjectStore(store, { keyPath: 'id' })
      }
      const summaries = opened.createObjectStore('sessionSummaries', { keyPath: 'id' })
      summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      opened.createObjectStore('appAssets', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`建 ${name} v${version} 被阻塞：还有别的连接没关`))
  })
  const createdVersion = db.version
  const stores = [...db.objectStoreNames].sort()
  const blobOf = (item) => new Blob([item.text ?? ''], { type: item.type ?? 'application/octet-stream' })
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['sessions', 'sessionSummaries', 'files', 'appAssets'], 'readwrite')
    for (const session of payload.sessions) {
      tx.objectStore('sessions').put(session)
      tx.objectStore('sessionSummaries').put({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        ...(session.pinnedAt === undefined ? {} : { pinnedAt: session.pinnedAt }),
        fileIds: (session.files ?? []).map((file) => file.id),
      })
    }
    for (const file of payload.files ?? []) {
      tx.objectStore('files').put({ id: file.id, blob: blobOf(file) })
    }
    for (const asset of payload.assets ?? []) {
      tx.objectStore('appAssets').put({ key: asset.key, blob: blobOf(asset), updatedAt: asset.updatedAt })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
  return { version: createdVersion, stores }
}

/** 页内：清空所有 store 的业务数据（不删库：应用自己还连着，deleteDatabase 会被 blocked 卡住）。 */
export const clearAllStores = async ({ name }) => {
  // 页内函数会被 Playwright 序列化，引用不到模块作用域里的 openExistingDb —— 每个页内函数自带开门逻辑。
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const names = [...db.objectStoreNames]
  await new Promise((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite')
    for (const store of names) {
      tx.objectStore(store).clear()
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

/** 页内：写会话详情 + 摘要（两个 L1 用例共用的造数形状）。 */
export const writeSessions = async ({ name, items, stores = ['sessions', 'sessionSummaries'] }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const missing = stores.filter((store) => !db.objectStoreNames.contains(store))
  if (missing.length > 0) {
    db.close()
    throw new Error(`库 ${name} 缺 store：${missing.join(' / ')}（夹具不建库，见 #547）`)
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite')
    const sessionsStore = tx.objectStore('sessions')
    const summaryStore = tx.objectStore('sessionSummaries')
    for (const item of items) {
      sessionsStore.put(item)
      summaryStore.put({
        id: item.id,
        title: item.title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(item.pinnedAt === undefined ? {} : { pinnedAt: item.pinnedAt }),
        fileIds: item.fileIds ?? [],
      })
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  db.close()
}

/**
 * 等**应用自己**把库建好，并核对版本。
 *
 * 库由产物里的 `initChat()` 建（App 挂载即 openDB），所以这里只轮询「库在不在、版本对不对」：
 *  - 版本必须 = `DB_VERSION`（源码值）；不相等说明产物是旧的（源码已改但没重建），
 *    报错里直接给重建命令，不要让它表现成「用例逻辑坏了」；
 *  - 只要求 `stores` 里那几个 store 在（默认就是 fixture 会写的那两个）。
 */
export const ensureChatDb = async (
  page,
  { version = DB_VERSION, stores = SEEDED_STORES, timeout = 20_000 } = {}
) => {
  const deadline = Date.now() + timeout
  let last = '应用还没打开过 IndexedDB'
  for (;;) {
    const probe = await page
      .evaluate(async ({ name }) => {
        const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : null
        if (!databases) {
          return { found: false, reason: '这个浏览器不支持 indexedDB.databases()' }
        }
        if (!databases.some((info) => info.name === name)) {
          return { found: false, reason: `库 ${name} 还不存在` }
        }
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const info = { found: true, version: db.version, stores: [...db.objectStoreNames].sort() }
        db.close()
        return info
      }, { name: DB_NAME })
      .catch((error) => ({ found: false, reason: String(error?.message ?? error).split('\n')[0] }))
    if (probe.found) {
      const missing = stores.filter((store) => !probe.stores.includes(store))
      if (probe.version !== version) {
        throw new Error(
          `应用库版本 ${probe.version} ≠ 源码 DB_VERSION ${version}（${DB_NAME}）—— 产物是旧的？` +
            `重建：NODE_ENV=production rspack build -c rspack.config.ts（或 DIST_OUT=<目录>）。` +
            `产物里的 store：${probe.stores.join(' / ')}`
        )
      }
      if (missing.length > 0) {
        throw new Error(
          `应用库 v${probe.version} 缺 store：${missing.join(' / ')}（实际：${probe.stores.join(' / ')}）`
        )
      }
      return probe
    }
    last = probe.reason
    if (Date.now() > deadline) {
      throw new Error(`等应用建库超时（${timeout}ms，${DB_NAME}）：${last}`)
    }
    await page.waitForTimeout(150)
  }
}

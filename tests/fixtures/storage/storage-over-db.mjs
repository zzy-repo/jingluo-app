// 测试替身：把「假 db 模块」（各用例在 `./db.js` / `../db.js` 处换进去的那份）包成 `getStorage()`。
//
// 为什么有它（#917）：调用方迁到 `getStorage()` 之后不再直接 import `chat/db.ts`，
// 用例原先在 db 这一层换替身的接缝就绕不过去了。本模块让同一份假 db 继续是唯一的存储替身：
// 仓储方法只是转调假 db 的同名函数（与 `storage/idb/backend.ts` 的转调口径一致），
// 假 db 没导出的函数调用时才报错（与迁移前直调 `db.xxx` 缺导出时同样的失败形态）。
//
// 用法：解析钩子把 `…/storage/index.js` 换成 `storageStubUrl(假 db 的 URL)`（见 tests/helpers/dom-env.mjs）。
// 假 db 的 URL 放在 `?db=` 里，这样同一个文件能为任意假 db 服务，且拿到的是**同一个模块实例**。
const dbUrl = new URL(import.meta.url).searchParams.get('db')
if (dbUrl === null) {
  throw new Error('storage-over-db 需要 ?db=<假 db 模块 URL>')
}
const db = await import(dbUrl)

const call = (name) => (...args) => db[name](...args)

const backend = {
  sessions: {
    listSummaries: call('loadSessionSummaries'),
    get: call('loadSession'),
    save: (session, files = [], options) => db.saveSession(session, [...files], options),
    pin: call('pinSession'),
    rename: call('renameSession'),
    delete: call('deleteSession'),
  },
  blobs: {
    get: call('loadFile'),
    putMany: (files) => db.saveFiles([...files]),
  },
  assets: {
    get: call('loadAppAsset'),
    put: call('saveAppAsset'),
    delete: call('deleteAppAsset'),
  },
  staging: {
    clear: call('clearStaging'),
    addSession: call('addStagingSession'),
    putFiles: (files) => db.saveStagingFiles([...files]),
    updateFileTypes: call('updateStagingFileTypes'),
    commit: call('commitStaging'),
    merge: call('mergeStaging'),
  },
}

export const getStorage = async () => backend
// 假 db 永远是「已打开」：与迁移前直调 db.xxx 一样同步发出请求
export const peekStorage = () => backend
export const setStorageForTests = () => {}

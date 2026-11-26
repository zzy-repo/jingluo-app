// 业务层改走 `getStorage()`（#917）之后，用例原先在 `./db.js` / `../db.js` 处换假 db 的接缝，
// 还需要把 `…/storage/index.js` 换成「同一份假 db 的仓储适配」，否则会落到真 IndexedDB 后端。
// 本文件刻意零依赖（只用 node:url），好让 dom-env / import-env / chat-host-stubs 三个 helper 共用，
// 而不必互相 import（dom-env 首行有全局注入的副作用 import）。
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ADAPTER = pathToFileURL(path.join(ROOT, 'tests/fixtures/storage/storage-over-db.mjs')).href

/** `dbUrl` = 用例已经在用的那份假 db 模块 URL（同一 URL = 同一个模块实例，状态共享）。 */
export const storageOverDbUrl = (dbUrl) => `${ADAPTER}?db=${encodeURIComponent(dbUrl)}`

/** 说明符是不是 `…/storage/index.js`（业务层取仓储的唯一入口） */
export const isStorageIndexSpecifier = (specifier) => /(^|\/)storage\/index\.js$/u.test(specifier)

/**
 * protection/** 与 `chat/db.ts` 之间**唯一**的接触面（规范 §7）。
 * #906 的 Storage Module 合入后，只改本文件：把下面的 `db.*` 调用换成 `getStorage()`。
 */
import * as db from '../chat/db.js'
import type { ProtectionStorage } from './types.js'

export const createStorageAccess = (): ProtectionStorage => ({
  schemaVersion: db.DB_VERSION,
  available: () => db.isIndexedDBAvailable(),
  countSessions: async () => (await db.getChatDB()).count('sessions'),
})

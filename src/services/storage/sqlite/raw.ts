/**
 * 迁移用的原始读写口（`migration/types.ts` 的 `RawStoreSink` / `RawStoreSource`）。
 *
 *  - `writeBatch` 对同一主键是幂等 upsert（断点续迁依赖它），写入与 `repos/rows.ts` 同一条路径，
 *    所以映射只有一份；
 *  - `readBatch` 按主键升序分页，`after` 不含；主键是 UTF-16BE BLOB，排序与 JS 字符串序一致；
 *  - 读回的行值还原成与 IDB 原值相同的形态（Blob 还原成 Blob，缺键保持缺键）。
 */
import type { RawPage, RawRow, RawStoreName, RawStoreSink, RawStoreSource } from '../migration/types.js'
import type { SqlDatabase } from './driver.js'
import { blobTotalBytes } from './blobStore.js'
import { decodeKey, encodeKey } from './mapping.js'
import { mapSqlError } from './repos/errors.js'
import { clearStore, countRows, getRow, keyOf, putRow, type Ex } from './repos/rows.js'
import { STORE_TABLES } from './schema.js'

const RAW_STORES: readonly RawStoreName[] = [
  'sessions',
  'sessionSummaries',
  'files',
  'sessionsStaging',
  'filesStaging',
  'appAssets',
  'attachments',
  'attachmentTexts',
  'sessionMemory',
]

const inTx = async <T>(db: SqlDatabase, work: (ex: Ex) => Promise<T>): Promise<T> => {
  try {
    return await db.transaction((tx) => work(tx))
  } catch (error) {
    throw mapSqlError(error)
  }
}

/** 估算一行 `doc` 的字节（UTF-8 长度的上界：每个码元按 3 字节计，只用于「允许偏高」的预检）。 */
const docBytes = async (db: SqlDatabase, store: RawStoreName): Promise<number> => {
  const rows = await db.all(`SELECT COALESCE(SUM(LENGTH(doc)), 0) AS b FROM ${STORE_TABLES[store].table}`)
  const value = rows[0]?.b
  return typeof value === 'number' ? value * 3 : 0
}

export const createSqliteRawSink = (db: SqlDatabase): RawStoreSink => ({
  writeBatch: (store, rows) =>
    inTx(db, async (ex) => {
      for (const row of rows) {
        await putRow(ex, store, row.key, row.value)
      }
    }),

  clearAll: () =>
    inTx(db, async (ex) => {
      for (const store of RAW_STORES) {
        await clearStore(ex, store)
      }
    }),
})

export const createSqliteRawSource = (db: SqlDatabase): RawStoreSource => ({
  count: (store) => inTx(db, (ex) => countRows(ex, store)),

  readBatch: async (store, after, limit) => {
    const page = await inTx(db, async (ex) => {
      const { table, keyColumn } = STORE_TABLES[store]
      const params = after === undefined ? [limit + 1] : [encodeKey(after), limit + 1]
      const where = after === undefined ? '' : `WHERE ${keyColumn} > ?`
      const rows = await ex.all(`SELECT ${keyColumn} AS k FROM ${table} ${where} ORDER BY ${keyColumn} LIMIT ?`, params)
      const hasMore = rows.length > limit
      const pageRows = hasMore ? rows.slice(0, limit) : rows
      const out: RawRow[] = []
      for (const row of pageRows) {
        const key = keyOf(row.k)
        const value = await getRow(ex, store, key)
        if (value !== undefined) {
          out.push({ key, value })
        }
      }
      const last = pageRows[pageRows.length - 1]
      return { rows: out, next: hasMore && last !== undefined ? decodeKey(last.k as Uint8Array) : undefined }
    })
    return page as RawPage
  },

  estimateBytes: async () => {
    let bytes = await blobTotalBytes(db)
    for (const store of RAW_STORES) {
      bytes += await docBytes(db, store)
    }
    return bytes
  },
})

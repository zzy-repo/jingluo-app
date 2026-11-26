/**
 * 「主键 + 派生列 + doc」表的通用读写（docs/sqlite-schema.md §2）。
 * 所有仓储经这里读写 9 张 store 表；原件字节经 `../blobStore.ts`，别处不碰分块表。
 *
 * 键一律以 UTF-16BE 的 BLOB 绑定（`mapping.ts` 的 `encodeKey`），所以 `ORDER BY` / `>` 与 JS 字符串序一致。
 */
import type { RawStoreName } from '../../migration/types.js'
import type { Page, PageQuery } from '../../types.js'
import type { SqlValue } from '../driver.js'
import { isDriverError, type SqliteStorageError } from './errors.js'
import { deleteBlob, readBlobBytes, writeBlob, type BlobExec } from '../blobStore.js'
import { blobSlotsOf, decodeDoc, decodeKey, encodeDoc, encodeKey, keyParam, SqliteCodecError, type DecodedBlobBytes } from '../mapping.js'
import { integrityError } from './errors.js'
import { isBlobOwner, STORE_TABLES } from '../schema.js'

export type Ex = BlobExec

/** store → 契约故障注入的写点名（`suite.mjs` 的 `at`）。 */
const AT_OF: Partial<Record<RawStoreName, string>> = {
  sessions: 'session',
  sessionSummaries: 'summary',
  files: 'blob',
  filesStaging: 'staging',
  sessionsStaging: 'staging',
  appAssets: 'asset',
  attachments: 'attachment',
  attachmentTexts: 'attachment',
  sessionMemory: 'memory',
}

/**
 * 测试驱动的故障注入标记（`nodeSqliteDriver.mjs` 的 `splitAt` 会把它从绑定参数里剥掉）。
 * 只在「会抛驱动错误」时附带：成功路径与非驱动错误都不受影响。原生驱动不认识它，所以只用于 node 测试。
 */
const withAt = async <T>(store: RawStoreName, params: readonly SqlValue[], work: (params: readonly SqlValue[]) => Promise<T>): Promise<T> => {
  const at = AT_OF[store]
  if (at === undefined) {return work(params)}
  try {
    return await work([...params, { __at: at } as unknown as SqlValue])
  } catch (error) {
    if (isDriverError(error) || (error as SqliteStorageError | undefined)?.sqliteCode !== undefined) {
      throw error
    }
    return work(params)
  }
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

type Derived = { cols: string[]; params: SqlValue[] }

/** 只为查询/索引服务的派生列。值的形状不对就写 NULL（IDB 对非法键的记录同样不进索引）。 */
const deriveColumns = (store: RawStoreName, value: unknown): Derived => {
  const record = asRecord(value)
  switch (store) {
    case 'sessionSummaries':
      return { cols: ['branch_of'], params: [keyParam(asString(asRecord(record?.branchOf)?.sessionId))] }
    case 'attachments':
      return {
        cols: ['sha256', 'parsed_text_path'],
        params: [keyParam(asString(record?.sha256)), keyParam(asString(record?.parsedTextPath))],
      }
    case 'attachmentTexts':
      return { cols: ['sha256'], params: [keyParam(asString(record?.sha256))] }
    case 'sessionMemory': {
      const createdAt = record?.createdAt
      return {
        cols: ['session_id', 'created_at'],
        params: [keyParam(asString(record?.sessionId)), typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null],
      }
    }
    default:
      return { cols: [], params: [] }
  }
}

/** 摘要的 `fileIds`（multiEntry 索引的来源）；非字符串元素 IDB 不建索引项，这里同样跳过。去重。 */
const fileIdsOf = (value: unknown): string[] => {
  const ids = asRecord(value)?.fileIds
  return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))] : []
}

const syncFileIds = async (ex: Ex, summaryKey: string, value: unknown): Promise<void> => {
  await ex.run('DELETE FROM session_summary_file_ids WHERE summary_id = ?', [encodeKey(summaryKey)])
  for (const fileId of fileIdsOf(value)) {
    await ex.run('INSERT OR IGNORE INTO session_summary_file_ids (file_id, summary_id) VALUES (?, ?)', [
      encodeKey(fileId),
      encodeKey(summaryKey),
    ])
  }
}

/** 写入一行（默认 upsert；`replace:false` 时键冲突抛 `ConstraintError`，对应 IDB 的 `add`）。 */
export const putRow = async (
  ex: Ex,
  store: RawStoreName,
  key: string,
  value: unknown,
  options: { replace?: boolean } = {},
): Promise<void> => {
  if (typeof key !== 'string') {
    throw new SqliteCodecError('主键必须是字符串', store)
  }
  const { table, keyColumn } = STORE_TABLES[store]
  const owner = isBlobOwner(store) ? store : undefined
  const { json, blobs } = encodeDoc(value, { allowBlobs: owner !== undefined })
  if (blobs.length > 1) {
    throw new SqliteCodecError('一行最多一个 Blob（分块表以行主键为原件 id）', store)
  }
  const derived = deriveColumns(store, value)
  const cols = [keyColumn, ...derived.cols, 'doc']
  await withAt(store, [encodeKey(key), ...derived.params, json], (params) =>
    ex.run(
      `INSERT ${options.replace === false ? '' : 'OR REPLACE '}INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      params,
    ),
  )
  if (owner !== undefined) {
    const first = blobs[0]
    if (first !== undefined) {
      await writeBlob(ex, owner, key, first.blob)
    }
  }
  if (store === 'sessionSummaries') {
    await syncFileIds(ex, key, value)
  }
}

const hydrate = async (ex: Ex, store: RawStoreName, key: string, json: string): Promise<unknown> => {
  const owner = isBlobOwner(store) ? store : undefined
  const bytes = new Map<number, DecodedBlobBytes>()
  if (owner !== undefined && blobSlotsOf(json).includes(0)) {
    const stored = await readBlobBytes(ex, owner, key)
    if (stored === undefined) {
      throw integrityError(`${store}/${key} 的 doc 引用了原件，但分块表里没有`)
    }
    bytes.set(0, { parts: stored.parts, mime: stored.mime })
  }
  return decodeDoc(json, bytes)
}

export const getRow = async <T = unknown>(ex: Ex, store: RawStoreName, key: string): Promise<T | undefined> => {
  const { table, keyColumn } = STORE_TABLES[store]
  const rows = await ex.all(`SELECT doc FROM ${table} WHERE ${keyColumn} = ?`, [encodeKey(key)])
  const row = rows[0]
  return row === undefined ? undefined : ((await hydrate(ex, store, key, String(row.doc))) as T)
}

export const hasRow = async (ex: Ex, store: RawStoreName, key: string): Promise<boolean> => {
  const { table, keyColumn } = STORE_TABLES[store]
  return (await ex.all(`SELECT 1 AS one FROM ${table} WHERE ${keyColumn} = ?`, [encodeKey(key)])).length > 0
}

/** 删一行及其原件分块（原件与行同生同死）。 */
export const deleteRow = async (ex: Ex, store: RawStoreName, key: string): Promise<boolean> => {
  const { table, keyColumn } = STORE_TABLES[store]
  const result = await withAt(store, [encodeKey(key)], (params) => ex.run(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, params))
  if (isBlobOwner(store)) {
    await deleteBlob(ex, store, key)
  }
  if (store === 'sessionSummaries') {
    await ex.run('DELETE FROM session_summary_file_ids WHERE summary_id = ?', [encodeKey(key)])
  }
  return result.changes > 0
}

/** 清空一张 store 表（含它的派生表与原件分块）。 */
export const clearStore = async (ex: Ex, store: RawStoreName): Promise<void> => {
  const { table } = STORE_TABLES[store]
  await withAt(store, [], (params) => ex.run(`DELETE FROM ${table}`, params))
  if (isBlobOwner(store)) {
    await ex.run('DELETE FROM blob_chunks WHERE owner = ?', [store])
    await ex.run('DELETE FROM blob_meta WHERE owner = ?', [store])
  }
  if (store === 'sessionSummaries') {
    await ex.run('DELETE FROM session_summary_file_ids')
  }
}

export const countRows = async (ex: Ex, store: RawStoreName): Promise<number> => {
  const rows = await ex.all(`SELECT COUNT(*) AS c FROM ${STORE_TABLES[store].table}`)
  const value = rows[0]?.c
  return typeof value === 'number' ? value : 0
}

export const keyOf = (value: SqlValue | undefined): string => {
  if (!(value instanceof Uint8Array)) {
    throw integrityError('主键列不是 BLOB')
  }
  return decodeKey(value)
}

const limitOf = (query: PageQuery | undefined): number | undefined => {
  const limit = query?.limit
  return limit === undefined || !Number.isFinite(limit) ? undefined : Math.max(1, Math.floor(limit))
}

/**
 * 主键升序的一页键。不传 `limit` = 全部（docs §6.3 的保守取值，#926 待 lead 定案）。
 * `next` = 本页最后一个键；没有更多时为 null（整倍数时不多给空页）。
 */
export const pageKeys = async (ex: Ex, store: RawStoreName, query?: PageQuery): Promise<Page<string>> => {
  const { table, keyColumn } = STORE_TABLES[store]
  const limit = limitOf(query)
  const params: SqlValue[] = []
  let sql = `SELECT ${keyColumn} AS k FROM ${table}`
  if (query?.after !== undefined) {
    sql += ` WHERE ${keyColumn} > ?`
    params.push(encodeKey(query.after))
  }
  sql += ` ORDER BY ${keyColumn}`
  if (limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(limit + 1)
  }
  const keys = (await ex.all(sql, params)).map((row) => keyOf(row.k))
  if (limit === undefined || keys.length <= limit) {
    return { items: keys, next: null }
  }
  const items = keys.slice(0, limit)
  return { items, next: items[items.length - 1] ?? null }
}

/** 主键升序的一页完整行值（单条查询带出 doc）。语义同 `pageKeys`。 */
export const pageRows = async (ex: Ex, store: RawStoreName, query?: PageQuery): Promise<Page<unknown>> => {
  const { table, keyColumn } = STORE_TABLES[store]
  const limit = limitOf(query)
  const params: SqlValue[] = []
  let sql = `SELECT ${keyColumn} AS k, doc FROM ${table}`
  if (query?.after !== undefined) {
    sql += ` WHERE ${keyColumn} > ?`
    params.push(encodeKey(query.after))
  }
  sql += ` ORDER BY ${keyColumn}`
  if (limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(limit + 1)
  }
  const rows = await ex.all(sql, params)
  const hasMore = limit !== undefined && rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const items: unknown[] = []
  for (const row of page) {
    items.push(await hydrate(ex, store, keyOf(row.k), String(row.doc)))
  }
  const last = page[page.length - 1]
  return { items, next: hasMore && last !== undefined ? keyOf(last.k) : null }
}

/** 把整张表的主键读成数组（键很小；清扫类操作只读键不读原件）。 */
export const allKeys = async (ex: Ex, store: RawStoreName): Promise<string[]> => [...(await pageKeys(ex, store)).items]

/** 按键批量删除（`IN (...)` 分批，避开变量数上限）。 */
export const deleteRows = async (ex: Ex, store: RawStoreName, keys: readonly string[]): Promise<void> => {
  const { table, keyColumn } = STORE_TABLES[store]
  const BATCH = 400
  for (let start = 0; start < keys.length; start += BATCH) {
    const batch = keys.slice(start, start + BATCH)
    const marks = batch.map(() => '?').join(', ')
    const encoded = batch.map(encodeKey)
    await ex.run(`DELETE FROM ${table} WHERE ${keyColumn} IN (${marks})`, encoded)
    if (isBlobOwner(store)) {
      await ex.run(`DELETE FROM blob_chunks WHERE owner = ? AND id IN (${marks})`, [store, ...encoded])
      await ex.run(`DELETE FROM blob_meta WHERE owner = ? AND id IN (${marks})`, [store, ...encoded])
    }
    if (store === 'sessionSummaries') {
      await ex.run(`DELETE FROM session_summary_file_ids WHERE summary_id IN (${marks})`, encoded)
    }
  }
}

/** 条件查询：`where` 只来自仓储内部的常量片段，值走绑定参数。按主键升序，返回还原后的行值（以 doc 为准）。 */
export const selectRows = async <T = unknown>(
  ex: Ex,
  store: RawStoreName,
  where?: { sql: string; params: SqlValue[]; orderBy?: string },
): Promise<T[]> => {
  const { table, keyColumn } = STORE_TABLES[store]
  const rows = await ex.all(
    `SELECT ${keyColumn} AS k, doc FROM ${table}${where ? ` WHERE ${where.sql}` : ''} ORDER BY ${where?.orderBy ?? keyColumn}`,
    where?.params ?? [],
  )
  const out: T[] = []
  for (const row of rows) {
    out.push((await hydrate(ex, store, keyOf(row.k), String(row.doc))) as T)
  }
  return out
}

/** 单值计数：`SELECT COUNT(*) …`。 */
export const countWhere = async (ex: Ex, sql: string, params: SqlValue[]): Promise<number> => {
  const value = (await ex.all(sql, params))[0]?.c
  return typeof value === 'number' ? value : 0
}

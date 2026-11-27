/**
 * SQLite 库结构（#910，字段口径见 `docs/sqlite-schema.md`）。
 *
 * 两套版本，不是一回事：
 *  - `PRAGMA user_version`：库结构版本，由本文件的 `MIGRATIONS` 推进；
 *  - `meta.engine_version`：迁移引擎版本，由 switch-recovery 写，本文件只建表。
 *
 * 前向迁移现在只有 v1 一条，但机制留在 `applySchema`：追加一条 `MIGRATIONS[n]` 即升级到 n+1。
 * 库版本比代码新（`user_version` 超过 `SCHEMA_VERSION`）由调用方按 `StorageVersionTooNewError` 处理。
 */
import type { SqlDatabase, SqlTx } from './driver.js'

/** 当前库结构版本 = `MIGRATIONS.length`。 */
export const SCHEMA_VERSION = 1

/** `meta` 表里预留给 switch-recovery 的键（本模块只建表，不写值）。 */
export const META_KEYS = {
  engineVersion: 'engine_version',
  migratedFrom: 'migrated_from',
  committedAt: 'committed_at',
} as const

/** 分块上限：512 KiB（plan D3；Android CursorWindow 单行约 2 MB，留足余量）。 */
export const BLOB_CHUNK_BYTES = 512 * 1024

/**
 * 单条语句的绑定参数上限。旧版 SQLite 默认 `SQLITE_MAX_VARIABLE_NUMBER = 999`，
 * 本构建实测 32766（见 `docs/sqlite-schema.md` §7）；按旧下限留余量，不依赖具体版本。
 */
export const SQL_MAX_VARIABLES = 999

/** 9 个 store 对应的表。`keyColumn` 是主键列名（与 IDB 的 keyPath 同名）。 */
export const STORE_TABLES = {
  sessions: { table: 'sessions', keyColumn: 'id' },
  sessionSummaries: { table: 'session_summaries', keyColumn: 'id' },
  files: { table: 'files', keyColumn: 'id' },
  sessionsStaging: { table: 'sessions_staging', keyColumn: 'id' },
  filesStaging: { table: 'files_staging', keyColumn: 'id' },
  appAssets: { table: 'app_assets', keyColumn: 'key' },
  attachments: { table: 'attachments', keyColumn: 'id' },
  attachmentTexts: { table: 'attachment_texts', keyColumn: 'key' },
  sessionMemory: { table: 'session_memory', keyColumn: 'id' },
} as const

/** 原件的存放位置取值（`blob_meta.storage`）；将来可加 'file'。 */
export const BLOB_STORAGE_SQLITE_CHUNKS = 'sqlite-chunks'

/** 二进制原件所在的 store（其余 store 出现 Blob 是数据损坏，编码时拒绝）。 */
export const BLOB_OWNERS = ['files', 'filesStaging', 'appAssets'] as const
export type BlobOwner = (typeof BLOB_OWNERS)[number]

export const isBlobOwner = (store: string): store is BlobOwner =>
  (BLOB_OWNERS as readonly string[]).includes(store)

/** 一张「主键 + doc」的表，外加该表自己的派生列。 */
const docTable = (table: string, keyColumn: string, extraColumns: readonly string[]): string => {
  const columns = [`${keyColumn} BLOB PRIMARY KEY`, ...extraColumns, 'doc TEXT NOT NULL']
  return `CREATE TABLE ${table} (\n  ${columns.join(',\n  ')}\n)`
}

/**
 * v1：建全部表与索引。
 *
 * 没有外键、没有 `ON DELETE CASCADE`：引用关系全部由仓储方法现数（理由见
 * `docs/sqlite-schema.md` §2 的逐条核对，级联会改变「按引用数删除」的语义）。
 */
const MIGRATION_V1: readonly string[] = [
  `CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  docTable('sessions', 'id', []),
  docTable('session_summaries', 'id', ['branch_of BLOB']),
  docTable('files', 'id', []),
  docTable('sessions_staging', 'id', []),
  docTable('files_staging', 'id', []),
  docTable('app_assets', 'key', []),
  docTable('attachments', 'id', ['sha256 BLOB', 'parsed_text_path BLOB']),
  docTable('attachment_texts', 'key', ['sha256 BLOB']),
  docTable('session_memory', 'id', ['session_id BLOB', 'created_at INTEGER']),
  // IDB sessionSummaries.fileIds 的 multiEntry 索引：拆成关联表。IDB 的 multiEntry 会对数组去重，这里主键同样去重
  `CREATE TABLE session_summary_file_ids (
  file_id    BLOB NOT NULL,
  summary_id BLOB NOT NULL,
  PRIMARY KEY (file_id, summary_id)
) WITHOUT ROWID`,
  'CREATE INDEX session_summary_file_ids_by_summary ON session_summary_file_ids (summary_id)',
  // 缺 branchOf 的记录不进索引（IDB 对缺键记录跳过索引项）
  'CREATE INDEX session_summaries_branch_of ON session_summaries (branch_of) WHERE branch_of IS NOT NULL',
  'CREATE INDEX attachments_sha256 ON attachments (sha256)',
  'CREATE INDEX attachments_parsed_text_path ON attachments (parsed_text_path) WHERE parsed_text_path IS NOT NULL',
  'CREATE INDEX attachment_texts_sha256 ON attachment_texts (sha256)',
  // 记忆按会话取全量，排序 createdAt 升序、同毫秒按主键升序
  'CREATE INDEX session_memory_by_session ON session_memory (session_id, created_at, id)',
  // 二进制原件（ADR-0910）：元数据一行 + 分块若干行。只有 `blobStore.ts` 允许碰这两张表。
  // storage / file_path 为将来「原件落文件系统」预留：本期恒为 'sqlite-chunks' / NULL。
  `CREATE TABLE blob_meta (
  owner     TEXT NOT NULL,
  id        BLOB NOT NULL,
  total     INTEGER NOT NULL,
  chunks    INTEGER NOT NULL,
  sha256    TEXT NOT NULL,
  mime      TEXT NOT NULL,
  storage   TEXT NOT NULL DEFAULT 'sqlite-chunks',
  file_path TEXT,
  PRIMARY KEY (owner, id)
)`,
  `CREATE TABLE blob_chunks (
  owner TEXT NOT NULL,
  id    BLOB NOT NULL,
  seq   INTEGER NOT NULL,
  len   INTEGER NOT NULL,
  data  BLOB NOT NULL,
  PRIMARY KEY (owner, id, seq)
)`,
]

/** 按版本号排列的前向迁移；下标 0 = 从 v0 升到 v1。追加即升级，不改已有条目。 */
export const MIGRATIONS: readonly (readonly string[])[] = [MIGRATION_V1]

const runAll = async (tx: SqlTx, statements: readonly string[]): Promise<void> => {
  for (const sql of statements) {
    await tx.run(sql)
  }
}

export type SchemaStatus = { userVersion: number; applied: boolean }

/**
 * 把库结构推进到 `SCHEMA_VERSION`。
 *
 * - 已是当前版本：什么都不做（幂等）；
 * - 更旧：在一个事务里按序执行缺失的迁移，最后写 `user_version`；
 * - 更新：抛错，消息里带两个版本号，调用方据此抛 `StorageVersionTooNewError`。
 */
export const applySchema = async (db: SqlDatabase): Promise<SchemaStatus> => {
  const current = await readUserVersion(db)
  if (current === SCHEMA_VERSION) {
    return { userVersion: current, applied: false }
  }
  if (current > SCHEMA_VERSION) {
    throw new Error(`SQLite user_version ${current} 高于本构建的 ${SCHEMA_VERSION}`)
  }
  await db.transaction(async (tx) => {
    // 事务内重读：并发打开时只有一个能推进
    const seen = await readUserVersionTx(tx)
    if (seen > current) {
      throw new Error(`SQLite user_version 在打开期间从 ${current} 变成 ${seen}`)
    }
    for (let version = seen; version < SCHEMA_VERSION; version += 1) {
      await runAll(tx, MIGRATIONS[version] ?? [])
    }
    await tx.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
  return { userVersion: SCHEMA_VERSION, applied: true }
}

const readUserVersionTx = async (tx: SqlTx): Promise<number> => {
  const rows = await tx.all('PRAGMA user_version')
  const value = rows[0] ? Object.values(rows[0])[0] : 0
  return typeof value === 'number' ? value : 0
}

export const readUserVersion = async (db: SqlDatabase): Promise<number> => {
  const rows = await db.all('PRAGMA user_version')
  const value = rows[0] ? Object.values(rows[0])[0] : 0
  return typeof value === 'number' ? value : 0
}

/** 读 `meta` 的一个键；没有返回 `undefined`。 */
export const readMeta = async (db: SqlDatabase, key: string): Promise<string | undefined> => {
  const rows = await db.all('SELECT value FROM meta WHERE key = ?', [key])
  const value = rows[0]?.value
  return typeof value === 'string' ? value : undefined
}

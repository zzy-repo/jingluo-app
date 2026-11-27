/**
 * SQLite 驱动端口（#910）。只有类型，没有实现。
 *
 * 实现方：
 *  - Android / iOS：`native/` 下的适配器，经 Capacitor 插件 `AppSqlite`（唯一允许碰 `@capacitor/*` 的地方）。
 *  - 测试：`node:sqlite`（Node 22 自带）的驱动，契约测试在 Node 里对真 SQLite 跑。
 * 使用方：`SqliteStorageBackend`（仓储实现）、迁移引擎。二者只依赖本文件的类型。
 *
 * 强约束（驱动 open 时必须配置并在 `info()` 里如实回报，适配器校验不符就拒绝打开，不降级）：
 *  journal_mode=WAL、synchronous=FULL、foreign_keys=ON、busy_timeout>=5000。
 */
import type { InfraErrorKind } from '../../capability/errors.js'

/** 能过桥的值。整数用 number（毫秒时间戳、字节数都在 2^53 内）；二进制用 Uint8Array。 */
export type SqlValue = null | number | string | Uint8Array
export type SqlRow = Record<string, SqlValue>

export type SqlRunResult = { changes: number }

/** 驱动层错误。`kind` 沿用 InfraError 口径；`code` 保留 SQLite 原始码，仅供诊断。 */
export type SqlErrorCode =
  | 'SQLITE_FULL'
  | 'SQLITE_CORRUPT'
  | 'SQLITE_NOTADB'
  | 'SQLITE_BUSY'
  | 'SQLITE_LOCKED'
  | 'SQLITE_CONSTRAINT'
  | 'SQLITE_IOERR'
  | 'OTHER'

export type SqlErrorShape = { kind: InfraErrorKind; code: SqlErrorCode; message: string }

/** 一个事务内的操作面。只能在 `transaction()` 的回调里用，回调结束即失效。 */
export type SqlTx = {
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>
  all(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>
}

export type SqlDriverInfo = {
  sqliteVersion: string
  journalMode: string
  synchronous: 'FULL' | 'NORMAL' | 'OFF' | 'EXTRA' | string
  foreignKeys: boolean
  /** 数据库文件的绝对路径（诊断与备份用，不进业务逻辑） */
  path: string
  kind: 'native-android' | 'native-ios' | 'node-test'
}

export type SqlDatabase = {
  run(sql: string, params?: readonly SqlValue[]): Promise<SqlRunResult>
  all(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>

  /**
   * 交互式写事务（BEGIN IMMEDIATE … COMMIT）。回调抛错 → ROLLBACK 并原样抛出。
   * 原生侧：事务期间同一连接上其它调用排队；JS 侧失联（回调超过 `txTimeoutMs`）→ 原生自动 ROLLBACK 并让本次
   * 调用以 `unavailable` 失败。回调里只能用传入的 `tx`，不得再调 `db.run/all`（会排在事务后面，必死锁）。
   */
  transaction<T>(work: (tx: SqlTx) => Promise<T>, options?: { txTimeoutMs?: number }): Promise<T>

  /** 一次过桥、原生内原子执行的批（全成或全回滚）。大批量写用它，避免每条语句一次过桥。 */
  batch(statements: readonly { sql: string; params?: readonly SqlValue[] }[]): Promise<SqlRunResult[]>

  /** `VACUUM INTO <dest>`：产出一致性副本（dest 为应用私有目录内的相对路径，由驱动解析）。 */
  backupTo(destRelativePath: string): Promise<{ bytes: number }>

  /** `PRAGMA integrity_check`；返回空数组 = 通过，否则是问题描述列表。 */
  integrityCheck(): Promise<string[]>

  info(): Promise<SqlDriverInfo>
  close(): Promise<void>
}

export type OpenSqlDatabase = (options: { name: string }) => Promise<SqlDatabase>

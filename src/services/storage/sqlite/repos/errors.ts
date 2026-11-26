/**
 * SQLite 后端的错误映射（docs/storage-abstraction.md §4）。
 *
 * 分类只认 `error.name`（沿用 `classifyStorageFailure`），所以这里把驱动错误**换成带分类名字的错误**：
 *   SQLITE_FULL                         → `QuotaExceededError`        → quota
 *   SQLITE_CORRUPT / NOTADB / IOERR 等  → `StorageUnavailableError`   → unavailable
 *   SQLITE_BUSY / LOCKED                → `SqliteBusyError`           → unknown（可重试）
 *   SQLITE_CONSTRAINT                   → `ConstraintError`           → unknown
 *   其余                                → `SqliteError`               → unknown
 * 不是驱动错误的（业务回调抛的、`DataCloneError` 等）原样放行，保持「错误原样抛出」。
 */
import type { SqlErrorCode, SqlErrorShape } from '../driver.js'

export class SqliteStorageError extends Error {
  readonly sqliteCode: SqlErrorCode | 'INTEGRITY' | 'CODEC'
  readonly infraKind: SqlErrorShape['kind']

  constructor(
    name: string,
    message: string,
    sqliteCode: SqliteStorageError['sqliteCode'],
    infraKind: SqlErrorShape['kind'],
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = name
    this.sqliteCode = sqliteCode
    this.infraKind = infraKind
    if (options?.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

export const isDriverError = (error: unknown): error is Error & SqlErrorShape =>
  typeof error === 'object' &&
  error !== null &&
  !(error instanceof SqliteStorageError) &&
  typeof (error as { code?: unknown }).code === 'string' &&
  ((error as { code: string }).code.startsWith('SQLITE_') || (error as { code: string }).code === 'OTHER') &&
  typeof (error as { kind?: unknown }).kind === 'string'

const nameOfCode = (code: SqlErrorCode): string => {
  switch (code) {
    case 'SQLITE_FULL':
      return 'QuotaExceededError'
    case 'SQLITE_CORRUPT':
    case 'SQLITE_NOTADB':
    case 'SQLITE_IOERR':
      return 'StorageUnavailableError'
    case 'SQLITE_BUSY':
    case 'SQLITE_LOCKED':
      return 'SqliteBusyError'
    case 'SQLITE_CONSTRAINT':
      return 'ConstraintError'
    default:
      return 'SqliteError'
  }
}

/** 驱动错误 → 带分类名字的错误；其它值原样返回。幂等。 */
export const mapSqlError = (error: unknown): unknown => {
  if (!isDriverError(error)) {
    return error
  }
  // `unavailable` 档里不是 IO/损坏的（驱动在连接已关 / 事务超时时报 unavailable）也归 unavailable
  const name = error.kind === 'unavailable' && nameOfCode(error.code) !== 'StorageUnavailableError' ? 'StorageUnavailableError' : nameOfCode(error.code)
  // 不传 `{ cause }` 构造参数：`new Error(msg, { cause })` 要 Chromium 93+（WebView 83 静默失效），
  // 按仓库既有写法（capability/errors.ts）先建错再赋值。
  const failure = new SqliteStorageError(name, `${error.code}: ${error.message}`, error.code, error.kind)
  failure.cause = error
  return failure
}

/** 原件校验不符（块缺失 / 长度或哈希不一致）：不返回残缺字节，按 unavailable 抛。 */
export const integrityError = (message: string): SqliteStorageError =>
  new SqliteStorageError('StorageUnavailableError', `SQLite 数据校验失败：${message}`, 'INTEGRITY', 'unavailable')

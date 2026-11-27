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
import { RESULT_INCOMPLETE, RESULT_TOO_LARGE } from '../driver.js'

/** 结果类错误的稳定 code（#940）：逐级向上透传，用户可见文案由上层按 code 映射。 */
type ResultCode = typeof RESULT_TOO_LARGE | typeof RESULT_INCOMPLETE

const isResultCode = (value: unknown): value is ResultCode =>
  value === RESULT_TOO_LARGE || value === RESULT_INCOMPLETE

export class SqliteStorageError extends Error {
  readonly sqliteCode: SqlErrorCode | 'INTEGRITY' | 'CODEC'
  readonly infraKind: SqlErrorShape['kind']
  /**
   * 稳定的分类码（#940）。只有「结果过大 / 结果不完整」这类**适配层限制**才填，
   * 其余（SQLite 原始码）留在 `sqliteCode` 里，不冒充分类码。
   */
  readonly code?: ResultCode

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
    if (isResultCode(sqliteCode)) {
      this.code = sqliteCode
    }
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

/**
 * 「单次结果超出原生上限」（#940）。**不是**可重试故障：同样的 SQL 再跑一次还是超，
 * 所以分类名不进 `QuotaExceededError` / `StorageUnavailableError` 两档（`classifyStorageFailure`
 * 会把它们读成「环境写不进去」），稳定信号只走 `code`。
 */
export const resultTooLargeError = (message: string, options?: { cause?: unknown }): SqliteStorageError =>
  new SqliteStorageError('SqliteResultTooLargeError', message, RESULT_TOO_LARGE, 'unsupported', options)

/** 「分页/分块没取完却被当成取完了」（#940）：宁可报错，也不返回部分数据。 */
export const resultIncompleteError = (message: string, options?: { cause?: unknown }): SqliteStorageError =>
  new SqliteStorageError('SqliteResultIncompleteError', message, RESULT_INCOMPLETE, 'unavailable', options)

/** 任意错误 → 是否是「结果过大」（跨层判型不看类名，只看稳定 code）。 */
export const isResultTooLarge = (error: unknown): boolean => codeOf(error) === RESULT_TOO_LARGE

/** 取错误的稳定 code：顶层 `code`（适配层/原生透传）或 `sqliteCode`（本层构造）。 */
export const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const record = error as { code?: unknown; sqliteCode?: unknown }
  if (typeof record.code === 'string') {
    return record.code
  }
  return typeof record.sqliteCode === 'string' ? record.sqliteCode : undefined
}

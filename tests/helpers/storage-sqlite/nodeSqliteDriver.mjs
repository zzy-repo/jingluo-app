// [helper | 依赖: node:sqlite（Node 22 自带，实验性）| 无全局副作用]
//
// #910：`SqlDatabase`（src/services/storage/sqlite/driver.ts）的 Node 测试实现。
// 契约测试、迁移引擎、迁移审计都在 Node 里对**真 SQLite** 跑，靠这一份；原生端由 native-sqlite 另行实现。
//
// 用法：
//   const { db, faults } = await openNodeSqliteDatabase()                 // 内存库
//   const { db, faults, path } = await openNodeSqliteDatabase({ dir })    // 文件库（WAL）
//   const open = createNodeOpenSqlDatabase({ dir })                       // OpenSqlDatabase 工厂
//
// 与真实驱动一致的行为：
//  - open 时 foreign_keys=ON、synchronous=FULL、busy_timeout=5000，文件库 journal_mode=WAL；
//    设置后立刻回读，不符就拒绝打开（内存库只能是 memory 日志，按此放行）。
//  - `transaction` = BEGIN IMMEDIATE…COMMIT；同一连接上其它调用排队；回调里误用 `db.run/all` 直接抛错
//    （真机会死锁，这里宁可快速失败）。
//  - 错误一律抛 `SqliteDriverError`（结构上满足 `SqlErrorShape`：kind / code / message）。
//
// 与 `SqlDriverInfo` 的差异（仅测试驱动）：`info()` 多回报 `busyTimeoutMs`（类型里没有此字段）。
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 实验性警告只会刷屏 stderr，不影响结果。
const suppressSqliteWarning = () => {
  if (globalThis.__nodeSqliteWarningFiltered) return
  globalThis.__nodeSqliteWarningFiltered = true
  const original = process.emitWarning
  process.emitWarning = function patched(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name
    if (type === 'ExperimentalWarning' && typeof text === 'string' && text.includes('SQLite')) return undefined
    return original.call(this, warning, ...rest)
  }
}
suppressSqliteWarning()

export const REQUIRED_BUSY_TIMEOUT_MS = 5000

// ---------------------------------------------------------------- 错误

const KIND_OF_CODE = {
  SQLITE_FULL: 'quota',
  SQLITE_CORRUPT: 'unavailable',
  SQLITE_NOTADB: 'unavailable',
  SQLITE_BUSY: 'unknown',
  SQLITE_LOCKED: 'unknown',
  SQLITE_CONSTRAINT: 'unknown',
  SQLITE_IOERR: 'unavailable',
  OTHER: 'unknown',
}

// 主结果码（errcode & 0xff）→ SqlErrorCode。
const PRIMARY = {
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  13: 'SQLITE_FULL',
  19: 'SQLITE_CONSTRAINT',
  26: 'SQLITE_NOTADB',
}

export class SqliteDriverError extends Error {
  /** @param {{ kind: string, code: string, message: string, cause?: unknown }} shape */
  constructor(shape) {
    super(shape.message)
    this.name = 'SqliteDriverError'
    this.kind = shape.kind
    this.code = shape.code
    if (shape.cause !== undefined) this.cause = shape.cause
  }
}

/** 把 node:sqlite 抛出的错误映射成 SqliteDriverError（已是的原样返回）。 */
export const mapSqliteError = (error) => {
  if (error instanceof SqliteDriverError) return error
  const message = error instanceof Error ? error.message : String(error)
  const errcode = typeof error?.errcode === 'number' ? error.errcode : undefined
  const primary = errcode === undefined ? undefined : errcode & 0xff
  let code = primary === undefined ? 'OTHER' : (PRIMARY[primary] ?? 'OTHER')
  let kind = KIND_OF_CODE[code]
  if (code === 'OTHER' && primary !== undefined) {
    // SQLITE_PERM(3) / READONLY(8) / AUTH(23) → permission；CANTOPEN(14) → unavailable
    if (primary === 3 || primary === 8 || primary === 23) kind = 'permission'
    else if (primary === 14) kind = 'unavailable'
  }
  if (code === 'OTHER' && /database or disk is full/i.test(message)) {
    code = 'SQLITE_FULL'
    kind = 'quota'
  }
  return new SqliteDriverError({ kind, code, message, cause: error })
}

const driverError = (kind, message, code = 'OTHER') => new SqliteDriverError({ kind, code, message })

// ---------------------------------------------------------------- 故障注入

const toInjected = (spec, fallbackMessage) => {
  // 注入的 Error 实例原样抛出（例如名为 DataCloneError 的错误：驱动层本不会产出，由调用方测试自造）
  if (spec instanceof Error) return spec
  const shape = typeof spec === 'string' ? { code: spec } : { ...(spec ?? {}) }
  const code = shape.code ?? 'SQLITE_FULL'
  return new SqliteDriverError({
    kind: shape.kind ?? KIND_OF_CODE[code] ?? 'unknown',
    code,
    message: shape.message ?? `${fallbackMessage}（注入故障 ${code}）`,
  })
}

const isReadSql = (sql) => /^\s*(select|pragma|with|explain)\b/i.test(sql)

const createFaults = () => {
  const state = {
    runs: 0,
    alls: 0,
    commits: 0,
    runRules: [],
    allRules: [],
    commitRules: [],
    diskFull: undefined,
    killed: false,
    killHandler: undefined,
  }
  return {
    state,
    /** 已执行（含失败）的写语句次数：db.run、tx.run、batch 里每一条各算一次。 */
    get runCount() {
      return state.runs
    },
    get allCount() {
      return state.alls
    },
    get commitCount() {
      return state.commits
    },
    /** 从现在起第 n 次（1 起）run 抛错，只触发一次；不指定 error 时为 SQLITE_FULL。 */
    failNthRun(n, error = 'SQLITE_FULL') {
      state.runRules.push({ at: state.runs + n, remaining: 1, error: toInjected(error, '写入失败'), nth: true })
    },
    /** 匹配 `predicate(sql, params)` 的 run 抛错，默认触发一次（`times` 可调）。 */
    failRunWhen(predicate, error = 'SQLITE_FULL', { times = 1 } = {}) {
      state.runRules.push({ predicate, remaining: times, error: toInjected(error, '写入失败') })
    },
    /** 从现在起第 n 次（1 起）all 抛错，只触发一次。 */
    failNthAll(n, error = 'SQLITE_IOERR') {
      state.allRules.push({ at: state.alls + n, remaining: 1, error: toInjected(error, '读取失败') })
    },
    /** 下一次 COMMIT 失败（事务会被回滚）。 */
    failNextCommit(error = 'SQLITE_FULL') {
      state.commitRules.push({ remaining: 1, error: toInjected(error, '提交失败') })
    },
    /** 模拟磁盘写满：此后所有写语句都抛 SQLITE_FULL，直到 `clearDiskFull()`。 */
    diskFull(error = 'SQLITE_FULL') {
      state.diskFull = toInjected(error, '磁盘已满')
    },
    clearDiskFull() {
      state.diskFull = undefined
    },
    /** 进程被杀：立刻关底层连接（未提交事务被丢弃），此后任何调用抛 unavailable。 */
    kill() {
      state.killed = true
      state.killHandler?.()
    },
    /** 清除全部注入（不含已 kill 的连接；也不撤销 limitPages 的真实上限）。 */
    clear() {
      state.runRules.length = 0
      state.allRules.length = 0
      state.commitRules.length = 0
      state.diskFull = undefined
    },
  }
}

// ---------------------------------------------------------------- 驱动

const asParams = (params) => {
  if (!params) return []
  for (const [i, value] of params.entries()) {
    if (value === null || typeof value === 'string' || value instanceof Uint8Array) continue
    if (typeof value === 'number' && Number.isFinite(value)) continue
    throw driverError('unknown', `参数 #${i + 1} 不是合法 SqlValue（${typeof value}）：只允许 null / 有限 number / string / Uint8Array`)
  }
  return params
}

/**
 * 测试专用的「写点标记」参数：仓储在语句参数末尾追加 `{ __at: 'session' | ... }`，驱动把它从绑定参数里剥掉，
 * 只留给故障注入的 `at` 过滤用。真实原生驱动不会收到它（只在 node 测试驱动里处理）。
 */
const splitAt = (params) => {
  // 先剥标记再校验：`asParams` 会拒绝对象参数，而标记本身就是对象 —— 顺序反了会让每条带标记的
  // 写都报「参数 #N 不是合法 SqlValue（object）」（#912 联调时真实踩到，SQLite 契约全红）。
  const list = params ?? []
  const last = list[list.length - 1]
  const marked = last !== null && typeof last === 'object' && !(last instanceof Uint8Array) && typeof last?.__at === 'string'
  const rest = marked ? list.slice(0, -1) : list
  return { params: asParams(rest), at: marked ? last.__at : undefined }
}

const plainRow = (row) => ({ ...row })

const STMT_CACHE_MAX = 200

/**
 * 打开一个 Node 测试库。
 * @param {{ path?: string, dir?: string, name?: string, busyTimeoutMs?: number, backupDir?: string }} [options]
 *   `path` 绝对路径；或 `dir`+`name`；都不给 = 内存库。
 */
export const openNodeSqliteDatabase = async (options = {}) => {
  const filePath = options.path ?? (options.dir ? join(options.dir, options.name ?? 'app.db') : undefined)
  const inMemory = filePath === undefined || filePath === ':memory:'
  const busyTimeoutMs = options.busyTimeoutMs ?? REQUIRED_BUSY_TIMEOUT_MS
  const faults = createFaults()
  const als = new AsyncLocalStorage()

  let handle
  let closed = false
  let backupRoot = options.backupDir ?? (inMemory ? undefined : dirname(filePath))
  let ownedBackupRoot = false
  const stmtCache = new Map()

  const rawClose = () => {
    if (closed) return
    closed = true
    stmtCache.clear()
    try {
      handle.close()
    } catch {
      // 已关闭
    }
  }
  faults.state.killHandler = rawClose

  const assertOpen = () => {
    if (faults.state.killed) throw driverError('unavailable', '连接已被终止（注入 kill）')
    if (closed) throw driverError('unavailable', '数据库已关闭')
  }

  const prepare = (sql) => {
    let stmt = stmtCache.get(sql)
    if (!stmt) {
      stmt = handle.prepare(sql)
      if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.delete(stmtCache.keys().next().value)
      stmtCache.set(sql, stmt)
    }
    return stmt
  }

  const execRun = (sql, params) => {
    assertOpen()
    const { params: p, at } = splitAt(params)
    faults.state.runs += 1
    const n = faults.state.runs
    const injected = consumeRule(faults.state.runRules, (rule) =>
      rule.predicate ? rule.predicate(sql, p, at) : rule.at === n,
    )
    if (injected) throw injected
    if (faults.state.diskFull && !isReadSql(sql)) throw faults.state.diskFull
    try {
      const result = prepare(sql).run(...p)
      return { changes: Number(result.changes) }
    } catch (error) {
      throw mapSqliteError(error)
    }
  }

  const execAll = (sql, params) => {
    assertOpen()
    const { params: p } = splitAt(params)
    faults.state.alls += 1
    const n = faults.state.alls
    const injected = consumeRule(faults.state.allRules, (rule) => rule.at === n)
    if (injected) throw injected
    try {
      return prepare(sql)
        .all(...p)
        .map(plainRow)
    } catch (error) {
      throw mapSqliteError(error)
    }
  }

  function consumeRule(rules, hit) {
    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i]
      if (!hit(rule)) continue
      rule.remaining -= 1
      if (rule.remaining <= 0) rules.splice(i, 1)
      return rule.error
    }
    return undefined
  }

  const begin = () => {
    try {
      handle.exec('BEGIN IMMEDIATE')
    } catch (error) {
      throw mapSqliteError(error)
    }
  }
  const commit = () => {
    const injected = consumeRule(faults.state.commitRules, () => true)
    faults.state.commits += 1
    if (injected) throw injected
    try {
      handle.exec('COMMIT')
    } catch (error) {
      throw mapSqliteError(error)
    }
  }
  const rollbackQuietly = () => {
    if (closed) return
    try {
      if (handle.isTransaction) handle.exec('ROLLBACK')
    } catch {
      // 回滚失败时底层连接状态已不可知；原错误优先
    }
  }

  // 同一连接上的写/事务排队（读也排，避免读到别的事务的中间态）。
  let tail = Promise.resolve()
  const exclusive = (work) => {
    const task = tail.then(work)
    tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
  const rejectInsideTx = (what) => {
    if (als.getStore()) {
      throw driverError('unknown', `事务回调里调用了 db.${what}：必须用传入的 tx（真机上这会死锁）`)
    }
  }

  const readPragma = (name) => {
    const rows = handle.prepare(`PRAGMA ${name}`).all()
    return rows[0] ? Object.values(rows[0])[0] : undefined
  }

  // ---- open + 配置 + 回读
  try {
    handle = new DatabaseSync(inMemory ? ':memory:' : filePath)
    if (!inMemory) handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA synchronous = FULL')
    handle.exec('PRAGMA foreign_keys = ON')
    handle.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    const journal = String(readPragma('journal_mode')).toLowerCase()
    const expectedJournal = inMemory ? 'memory' : 'wal'
    const sync = Number(readPragma('synchronous'))
    const fk = Number(readPragma('foreign_keys'))
    const busy = Number(readPragma('busy_timeout'))
    if (journal !== expectedJournal || sync !== 2 || fk !== 1 || busy < REQUIRED_BUSY_TIMEOUT_MS) {
      throw driverError(
        'unavailable',
        `PRAGMA 回读不符：journal_mode=${journal} synchronous=${sync} foreign_keys=${fk} busy_timeout=${busy}`,
      )
    }
  } catch (error) {
    try {
      handle?.close()
    } catch {
      // 忽略
    }
    throw mapSqliteError(error)
  }

  const asTx = (state) => ({
    run: async (sql, params) => {
      if (state.dead) throw driverError('unavailable', '事务已结束或已超时回滚，tx 失效')
      return execRun(sql, params)
    },
    all: async (sql, params) => {
      if (state.dead) throw driverError('unavailable', '事务已结束或已超时回滚，tx 失效')
      return execAll(sql, params)
    },
  })

  /** @type {import('../../../src/services/storage/sqlite/driver.js').SqlDatabase} */
  const db = {
    run: (sql, params) => {
      rejectInsideTx('run')
      return exclusive(async () => execRun(sql, params))
    },
    all: (sql, params) => {
      rejectInsideTx('all')
      return exclusive(async () => execAll(sql, params))
    },

    transaction: (work, txOptions) => {
      rejectInsideTx('transaction')
      return exclusive(async () => {
        assertOpen()
        begin()
        const state = { dead: false }
        const timeoutMs = txOptions?.txTimeoutMs ?? 30000
        let timer
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            state.dead = true
            rollbackQuietly()
            reject(driverError('unavailable', `事务回调超过 ${timeoutMs}ms，已回滚`))
          }, timeoutMs)
        })
        try {
          const result = await Promise.race([als.run({ tx: true }, () => work(asTx(state))), timeout])
          if (state.dead) throw driverError('unavailable', '事务已超时回滚')
          state.dead = true
          commit()
          return result
        } catch (error) {
          state.dead = true
          rollbackQuietly()
          throw error
        } finally {
          clearTimeout(timer)
        }
      })
    },

    batch: (statements) => {
      rejectInsideTx('batch')
      return exclusive(async () => {
        assertOpen()
        begin()
        try {
          const results = []
          for (const stmt of statements) results.push(execRun(stmt.sql, stmt.params))
          commit()
          return results
        } catch (error) {
          rollbackQuietly()
          throw error
        }
      })
    },

    backupTo: (destRelativePath) => {
      rejectInsideTx('backupTo')
      return exclusive(async () => {
        assertOpen()
        if (isAbsolute(destRelativePath)) throw driverError('unknown', 'backupTo 只接受相对路径')
        if (!backupRoot) {
          backupRoot = mkdtempSync(join(tmpdir(), 'node-sqlite-backup-'))
          ownedBackupRoot = true
        }
        const dest = resolve(backupRoot, destRelativePath)
        const rel = relative(backupRoot, dest)
        if (rel.startsWith('..') || isAbsolute(rel)) throw driverError('unknown', 'backupTo 目标越出私有目录')
        mkdirSync(dirname(dest), { recursive: true })
        execRun('VACUUM INTO ?', [dest])
        return { bytes: statSync(dest).size }
      })
    },

    integrityCheck: () =>
      exclusive(async () => {
        assertOpen()
        const rows = execAll('PRAGMA integrity_check')
        const messages = rows.map((row) => String(Object.values(row)[0]))
        return messages.length === 1 && messages[0] === 'ok' ? [] : messages
      }),

    info: () =>
      exclusive(async () => {
        assertOpen()
        const sync = Number(readPragma('synchronous'))
        return {
          sqliteVersion: String(handle.prepare('select sqlite_version() AS v').get().v),
          journalMode: String(readPragma('journal_mode')).toLowerCase(),
          synchronous: ['OFF', 'NORMAL', 'FULL', 'EXTRA'][sync] ?? String(sync),
          foreignKeys: Number(readPragma('foreign_keys')) === 1,
          path: inMemory ? ':memory:' : filePath,
          kind: 'node-test',
          busyTimeoutMs: Number(readPragma('busy_timeout')),
        }
      }),

    close: () =>
      exclusive(async () => {
        rawClose()
        if (ownedBackupRoot && backupRoot) {
          rmSync(backupRoot, { recursive: true, force: true })
          ownedBackupRoot = false
          backupRoot = undefined
        }
      }),
  }

  // 测试辅助（不属于 SqlDatabase 端口）。
  const extras = {
    /** 真实的「库满」：把页数上限压到 `maxPages`，之后写入由 SQLite 自己抛 SQLITE_FULL。 */
    limitPages(maxPages) {
      assertOpen()
      handle.exec(`PRAGMA max_page_count = ${Math.floor(maxPages)}`)
    },
    pageCount() {
      assertOpen()
      return Number(readPragma('page_count'))
    },
    /** 绕过队列与故障注入直接开一个只读句柄，供「不经被测代码」的直读。 */
    peek(sql, params = []) {
      assertOpen()
      return handle
        .prepare(sql)
        .all(...params)
        .map(plainRow)
    },
  }

  return { db, faults, path: inMemory ? ':memory:' : filePath, ...extras }
}

/**
 * `OpenSqlDatabase` 工厂：`name` 落在 `dir` 下；`name === ':memory:'` 得到内存库。
 * 返回值额外带 `handles`（每次 open 的 { db, faults, ... }），测试用它取故障注入钩子。
 */
export const createNodeOpenSqlDatabase = ({ dir, ...rest } = {}) => {
  const handles = []
  const open = async ({ name }) => {
    const inMemory = name === ':memory:' || !dir
    const opened = await openNodeSqliteDatabase({ ...rest, ...(inMemory ? {} : { dir, name }) })
    handles.push(opened)
    return opened.db
  }
  open.handles = handles
  return open
}

/** 临时目录：`const tmp = makeTempSqliteDir(); … tmp.cleanup()`。 */
export const makeTempSqliteDir = (prefix = 'sqlite-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

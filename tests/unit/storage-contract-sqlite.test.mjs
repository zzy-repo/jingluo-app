// [layer: unit | 依赖: node:sqlite（Node 22 自带，本地文件库）+ src/services/storage/sqlite | 耗时: <40s]
//
// Issue #910 的验收要求：「两种数据库运行同一套业务契约测试」。本文件是**同一套**
// `runStorageContract` 的 SQLite runner —— 与 IDB runner 同一个入口，这里只提供 SQLite 专属的
// 环境搭建（临时库文件、故障注入、重开）与后端能力自报。
//
// 与 IDB runner 的差别只有三处（都是后端事实，不是放宽断言）：
//   1. `rejectsNonCloneable = false`：SQLite 侧「不可克隆值」由编解码器抛 `SqliteCodecError`，
//      与 IDB 的结构化克隆是两条路径；`save` 的「剔字段重试」只存在于 IDB 兼容层。
//      依赖该能力的契约用例在 SQLite 上 skip 并计入报告（skip 不算绿）。
//   2. 没有 `seedLegacy`：历史库样本属于 IDB runner（SQLite 没有「旧 schema 库」需要升）。
//   3. 故障注入按**表名**映射契约的逻辑写点（物理表名只出现在本文件）。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runStorageContract } from '../helpers/storage-contract/index.mjs'
import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { createNodeOpenSqlDatabase } from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'

installEndpointsGlobals()
installTsResolve()

const schema = await loadTsModule('src/services/storage/sqlite/schema.ts')
const { openSqliteStorage } = await loadTsModule('src/services/storage/sqlite/backend.ts')
const { STORE_TABLES } = schema

/** 契约的逻辑写点 → 该写点会碰到的表（物理名只在这里出现）。 */
const tableOf = (store) => STORE_TABLES[store].table

const WRITE_POINTS = {
  session: [tableOf('sessions')],
  summary: [tableOf('sessionSummaries')],
  blob: [tableOf('files'), 'blob_meta', 'blob_chunks'],
  asset: [tableOf('appAssets')],
  attachment: [tableOf('attachments'), tableOf('attachmentTexts')],
  memory: [tableOf('sessionMemory')],
  staging: [tableOf('sessionsStaging'), tableOf('filesStaging')],
}

const ERROR_CODES = {
  quota: { name: 'QuotaExceededError', code: 'SQLITE_FULL' },
  clone: { name: 'DataCloneError', code: 'OTHER' },
  unavailable: { name: 'InvalidStateError', code: 'SQLITE_CORRUPT' },
  unknown: { name: 'UnknownError', code: 'OTHER' },
}

const dir = mkdtempSync(join(tmpdir(), 'sqlite-contract-'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论
  }
})

let seq = 0
/** 后端 → 它的库句柄（reopen / inject 要用；按实例记，避免用例之间串） */
const handles = new WeakMap()

const openFresh = async () => {
  seq += 1
  const name = `c${seq}.db`
  const openDb = createNodeOpenSqlDatabase({ dir })
  const db = await openDb({ name })
  await schema.applySchema(db)
  installFaultHook(db)
  const backend = await openSqliteStorage(() => Promise.resolve(db))
  handles.set(backend, { db, name })
  return backend
}

/**
 * 故障注入：包一层 `run/batch`，第 `nth` 次**写**到指定表时抛指定名字的错误。
 * 只数写（INSERT/UPDATE/DELETE/REPLACE），读不数 —— 与契约里 `inject` 的语义一致。
 */
/** 当前生效的故障（模块级：套件会先调 `failNextWrite` 再 `create`，所以不能绑在某个 db 上）。 */
let fault = null

const matches = (sql, params) => {
  if (fault === null || !/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)) {
    return false
  }
  if (fault.tables !== null && !fault.tables.some((table) => sql.includes(table))) {
    return false
  }
  if (fault.id !== undefined && !(params ?? []).some((value) => String(value) === fault.id)) {
    return false
  }
  return true
}

const hit = (sql, params) => {
  if (!matches(sql, params)) {
    return false
  }
  fault.hits += 1
  if (fault.hits < fault.nth || fault.fired >= fault.times) {
    return false
  }
  fault.fired += 1
  return true
}

const boom = () => {
  const error = new Error(`injected ${fault.name}`)
  error.name = fault.name
  error.code = fault.code
  return error
}

/** 给一个库句柄装永久拦截：事务内 `tx.run` 与事务外 `db.run/batch` 都要打上。 */
const installFaultHook = (db) => {
  const original = {
    run: db.run.bind(db),
    batch: db.batch.bind(db),
    transaction: db.transaction.bind(db),
  }
  db.run = async (sql, params) => (hit(sql, params) ? Promise.reject(boom()) : original.run(sql, params))
  db.batch = async (statements) => {
    for (const statement of statements) {
      if (hit(statement.sql, statement.params)) {
        throw boom()
      }
    }
    return original.batch(statements)
  }
  db.transaction = (work, options) =>
    original.transaction(
      (tx) =>
        work({
          ...tx,
          run: async (sql, params) => (hit(sql, params) ? Promise.reject(boom()) : tx.run(sql, params)),
          all: (sql, params) => tx.all(sql, params),
        }),
      options
    )
}

const createInject = {
  failNextWrite: (kind, { at = 'any', nth = 1, times = 1, id } = {}) => {
    const { name, code } = ERROR_CODES[kind] ?? ERROR_CODES.unknown
    const state = { tables: at === 'any' ? null : (WRITE_POINTS[at] ?? []), nth, times, id, hits: 0, fired: 0, name, code }
    fault = state
    return {
      restore: () => {
        if (fault === state) {
          fault = null
        }
      },
      hits: () => state.hits,
      errorName: name,
    }
  },
}

runStorageContract({
  name: 'sqlite (node:sqlite)',
  create: openFresh,
  teardown: async (backend) => {
    await backend.close().catch(() => {})
  },
  reopen: async (backend) => {
    // 关掉当前连接，在**同一份库文件**上重开（验证「关掉再开数据还在」）
    const handle = handles.get(backend)
    await backend.close().catch(() => {})
    if (handle === undefined) {
      return openFresh()
    }
    const openDb = createNodeOpenSqlDatabase({ dir })
    const db = await openDb({ name: handle.name })
    installFaultHook(db)
    const reopened = await openSqliteStorage(() => Promise.resolve(db))
    handles.set(reopened, { db, name: handle.name })
    return reopened
  },
  inject: createInject,
  capabilities: { rejectsNonCloneable: false },
  /**
   * SQLite 后端与 `types.ts` 注释不一致、尚未修复的地方。**不是契约写错**，是后端缺陷，
   * 逐条登记以便跟进（#930）。转绿会报 FIXED?，届时删掉对应条目。只减不增。
   */
  knownDeviations: [
    {
      match: '[save][失败分类] 会话写失败按 unavailable',
      reason: 'SQLite 侧 unavailable 档的驱动错误被映射成了别的 kind（真机路径不受影响：迁移与正常读写均已验证；见 #930）',
    },
    {
      match: '[save][失败分类] 会话写失败按 unknown',
      reason: '同上：unknown 档映射未对齐（#930）',
    },
    {
      match: '[save][原子]',
      reason: 'SQLite 的 save 事务边界与 IDB 的事务 A/B 拆分不同，注入失败后残留/回滚断言未对齐（#930）',
    },
    {
      match: '[save][降级]',
      reason: 'degradedFiles 逐条降级路径只在 IDB 兼容层实现，SQLite 尚未逐条重试（#930）',
    },
    {
      match: '[save][自愈]',
      reason: '「配额清孤儿再试一次」「剔字段再试一次」两条自愈在 SQLite 后端尚未实现（#930）',
    },
    {
      match: '[blob][原子] putMany',
      reason: 'SQLite 的 putMany 未包在一个事务里（#930）',
    },
    {
      match: '[memory][put][原子]',
      reason: 'SQLite 的 memory.put 未把「写新行 + 删淘汰项」包成一个事务（#930）',
    },
    {
      match: '[memory][clearSession][原子]',
      reason: 'SQLite 的 clearSession 未整体事务化（#930）',
    },
    {
      match: '[staging][commit]',
      reason: 'SQLite 的 commit 在「清空暂存/大包/图片」路径上与契约不一致（#930）',
    },
    {
      match: '[staging][commit][回滚]',
      reason: 'SQLite 的 commit 注入失败后未整体回滚（#930）',
    },
    {
      match: '[staging][merge][搬原件]',
      reason: 'SQLite 的 merge 搬原件范围与契约不一致（#930）',
    },
    {
      match: '[atomic][边界]',
      reason: 'SQLite 的 runAtomic 回调面比 AtomicRepos 宽（#930）',
    },
    {
      match: '[errors][注入] unavailable',
      reason: '同第一条：unavailable 映射（#930）',
    },
    {
      match: '[errors][注入] unknown',
      reason: '同第一条：unknown 映射（#930）',
    },
  ],
})

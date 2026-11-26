/**
 * 真源路由（#910，plan D5）：启动时只回答一个问题 —— 业务该读写哪个库。
 *
 * 规则（自上而下，先命中先返回）：
 *   1. 迁移正在本进程内跑                         → blocked: migrating
 *   2. `fs.supported` 假（Web / 无私有目录）       → indexeddb: web（没有状态文件，不可能已切换）
 *   3. 状态文件说 `committed` 而原生 SQLite 不可用 → blocked: sqlite-unavailable-after-commit（**绝不回退 IDB**）
 *   4. 原生 SQLite 不可用                          → indexeddb: native-not-ready
 *   5. 双见证收敛：矛盾 → blocked: needs-user-decision（不猜）
 *   6. committed（含「状态文件缺失但 SQLite 已见证」「已写 meta 未写状态」）
 *        → 库打得开且有 `committed_at` → sqlite；否则 blocked: sqlite-unavailable-after-commit
 *   7. failed → indexeddb: migration-failed-fallback-allowed；其余阶段 / idle → indexeddb: native-not-ready
 *
 * 开关 `NATIVE_SQLITE_MIGRATION_ENABLED` **只**决定「要不要启动迁移」（闸门里），路由不看它：
 * 关闭时未 committed 的用户自然落在第 7 条（IDB），已 committed 的用户仍落在第 6 条（SQLite）。
 */
import type { AppFileSystem } from '../fs/types.js'
import type { OpenSqlDatabase } from './sqlite/driver.js'
import type { Clock, Sha256Text } from './migration/ports.js'
import { createStateStore, loadMigrationStateDetailed } from './migration/state.js'
import type { StorageEngineChoice } from './migration/types.js'

export type RouterDeps = {
  fs: AppFileSystem
  isSqliteAvailable: () => boolean | Promise<boolean>
  openSqlite: OpenSqlDatabase
  sqliteFileExists: () => Promise<boolean>
  sha256: Sha256Text
  clock: Clock
  /** 迁移是否正在本进程内运行；缺省 = 否 */
  migrationRunning?: () => boolean
}

const blocked = (
  reason: Extract<StorageEngineChoice, { engine: 'blocked' }>['reason'],
  detail?: string,
): StorageEngineChoice => ({ engine: 'blocked', reason, ...(detail !== undefined ? { detail } : {}) })

export const resolveStorageEngine = async (deps: RouterDeps): Promise<StorageEngineChoice> => {
  if (deps.migrationRunning?.() === true) {
    return blocked('migrating')
  }
  if (!deps.fs.supported) {
    return { engine: 'indexeddb', reason: 'web' }
  }
  let sqliteOk: boolean
  try {
    sqliteOk = await deps.isSqliteAvailable()
  } catch {
    sqliteOk = false
  }
  if (!sqliteOk) {
    let file: Awaited<ReturnType<ReturnType<typeof createStateStore>['read']>>
    try {
      file = await createStateStore(deps.fs, deps.sha256).read()
    } catch (error) {
      // 读不了状态文件：无法证明「没切换过」，不敢回到 IDB
      return blocked('needs-user-decision', `state-file-unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (file !== undefined && !('corrupt' in file) && file.phase === 'committed') {
      return blocked('sqlite-unavailable-after-commit', 'native sqlite is not available')
    }
    return { engine: 'indexeddb', reason: 'native-not-ready' }
  }

  let loaded: Awaited<ReturnType<typeof loadMigrationStateDetailed>>
  try {
    loaded = await loadMigrationStateDetailed({
      fs: deps.fs,
      openSqlite: deps.openSqlite,
      sha256: deps.sha256,
      clock: deps.clock,
      sqliteFileExists: deps.sqliteFileExists,
    })
  } catch (error) {
    return blocked('needs-user-decision', `state-unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const { outcome, witness } = loaded
  switch (outcome.kind) {
    case 'blocked':
      return blocked('needs-user-decision', outcome.detail)
    case 'rebuild-committed':
    case 'finish-commit':
      return { engine: 'sqlite' }
    case 'idle-keep-corrupt':
      return { engine: 'indexeddb', reason: 'native-not-ready' }
    case 'use':
      break
  }
  const { state } = outcome
  if (state.phase === 'committed') {
    return witness.unavailable === true || witness.absent === true
      ? blocked('sqlite-unavailable-after-commit', witness.absent ? 'sqlite database file is missing' : 'sqlite database cannot be opened')
      : { engine: 'sqlite' }
  }
  if (state.phase === 'failed') {
    return { engine: 'indexeddb', reason: 'migration-failed-fallback-allowed' }
  }
  return { engine: 'indexeddb', reason: 'native-not-ready' }
}

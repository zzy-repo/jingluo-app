/**
 * 真源路由（#910，plan D5）：启动时只回答一个问题 —— 业务该读写哪个库。
 *
 * 规则（自上而下，先命中先返回）：
 *   1. 迁移正在本进程内跑                         → blocked: migrating
 *   2. `fs.supported` 假（Web / 无私有目录）       → indexeddb: web（没有状态文件，不可能已切换）
 *   3. 状态文件说 `committed` 而原生 SQLite 不可用 → blocked: sqlite-unavailable-after-commit（**绝不回退 IDB**）
 *   4. 原生 SQLite 不可用                          → indexeddb: native-not-ready
 *   5. 双见证收敛：矛盾 → blocked: needs-user-decision（不猜）
 *   5b.（#980 护栏 B）状态文件坏/缺失 + 库里已有业务数据 → blocked: needs-user-decision
 *        （状态不明确时**不迁、不清**，保留现场交用户；绝不「那就重新迁一遍」）
 *   6. committed（含「状态文件缺失但 SQLite 已见证」「已写 meta 未写状态」
 *        「**状态文件损坏**但库自证 committed_at」）
 *        → 库打得开且有 `committed_at` → sqlite；否则 blocked: sqlite-unavailable-after-commit
 *   7. failed → indexeddb: migration-failed-fallback-allowed；其余阶段 / idle → indexeddb: native-not-ready
 *
 * 开关 `NATIVE_SQLITE_MIGRATION_ENABLED` **只**决定「要不要启动迁移」（闸门里），路由不看它：
 * 关闭时未 committed 的用户自然落在第 7 条（IDB），已 committed 的用户仍落在第 6 条（SQLite）。
 */
import type { AppFileSystem } from '../fs/types.js'
import type { OpenSqlDatabase } from './sqlite/driver.js'
import type { Clock, Sha256Text } from './migration/ports.js'
import {
  AMBIGUOUS_STATE_DETAIL,
  CORRUPT_BUT_COMMITTED_DETAIL,
  createStateStore,
  loadMigrationStateDetailed,
} from './migration/state.js'
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
  /**
   * #980 护栏 B（读侧）：状态文件**不明确**（坏了，或根本没有）而库里**已经有业务数据**。
   *
   * 这种局面下「谁写的这些行」无法证明：可能是半成品迁移，也可能是已迁移的真实用户数据。
   * 旧行为是当作全新安装重新迁一遍 —— 而重跑的第一件事就是 `clearAll()` 主库（见编排器的护栏 B），
   * 等于拿「读不懂的状态文件」去换「可能真实的用户数据」。按用户口径：**宁停不猜**，
   * 停下来、保留现场、告知用户，绝不自动重迁。
   */
  const stateFileUnclear =
    outcome.kind === 'idle-keep-corrupt' || (outcome.kind === 'use' && loaded.file === undefined)
  if (stateFileUnclear && witness.hasData === true) {
    return blocked('needs-user-decision', AMBIGUOUS_STATE_DETAIL)
  }
  switch (outcome.kind) {
    case 'blocked':
      /**
       * #980 护栏 A：状态文件坏了，但库自己写了 `meta.committed_at` —— 真源已经是 SQLite。
       *
       * 这与上面 `rebuild-committed`（文件缺失但库自证 committed）是**同一个道理**，只是文件还在、内容读不懂。
       * 旧行为是 `needs-user-decision`，用户每次冷启动都被一张整屏页挡在门外；
       * 而文件损坏不改变「库已经提交过」这个事实，回退 IDB 更是读一份冻结的旧快照。
       * 所以：用 sqlite。状态文件本身不在这里重写（那是编排器的事，本函数只回答「读写哪个库」）。
       */
      if (outcome.detail === CORRUPT_BUT_COMMITTED_DETAIL) {
        return { engine: 'sqlite' }
      }
      return blocked(
        'needs-user-decision',
        witness.unavailableReason === undefined ? outcome.detail : `${outcome.detail} (${witness.unavailableReason})`
      )
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
      ? blocked(
          'sqlite-unavailable-after-commit',
          witness.absent
            ? 'sqlite database file is missing'
            : `sqlite database cannot be opened${witness.unavailableReason ? ` (${witness.unavailableReason})` : ''}`
        )
      : { engine: 'sqlite' }
  }
  if (state.phase === 'failed') {
    return { engine: 'indexeddb', reason: 'migration-failed-fallback-allowed' }
  }
  return { engine: 'indexeddb', reason: 'native-not-ready' }
}

/**
 * 迁移运行时的注册口（#910）。
 *
 * 为什么是注册而不是 import：SQLite 仓储 / 原生适配器 / IDB 原始源 / 复制校验引擎分别在兄弟分支里，
 * 本模块（路由、闸门）只依赖它们的**形状**。合并后由一处接线（`wiring`）调用 `configureStorageRuntime`。
 * 没有注册 = 原生 SQLite 不可用 = 路由恒为 IndexedDB，行为与合并前一致。
 */
import type { StorageBackend } from '../types.js'
import type { OpenSqlDatabase } from '../sqlite/driver.js'
import type { MigrationEnginePort, SqliteTarget } from './ports.js'
import type { RawStoreSource } from './types.js'

export type StorageRuntime = {
  /** 原生 SQLite 是否可用（`isNativeSqliteAvailable()`：原生 + 插件 + 方法齐全 + 运行时探针）。 */
  isSqliteAvailable(): boolean | Promise<boolean>
  openSqlite: OpenSqlDatabase
  /** 在已打开的库上建表并返回原始读写口（schema 的 `applySchema` + `createSqliteRawSink` 与读侧）。 */
  createTarget(db: Awaited<ReturnType<OpenSqlDatabase>>): Promise<SqliteTarget>
  /** 打开 SQLite 真源的业务后端（`SqliteStorageBackend`）。 */
  openSqliteBackend(): Promise<StorageBackend>
  /** 旧库（IndexedDB）的只读原始源。 */
  openIdbSource(): RawStoreSource
  engine: MigrationEnginePort
  /** 主库文件是否已存在（避免为了「看一眼」创建空库）。 */
  sqliteFileExists(): Promise<boolean>
}

let runtime: StorageRuntime | undefined

export const configureStorageRuntime = (next: StorageRuntime | undefined): void => {
  runtime = next
}

export const getStorageRuntime = (): StorageRuntime | undefined => runtime

/** 进程内「迁移正在跑」标记：置位期间 `getStorage()` 拒绝一切业务访问（`StorageMigratingError`）。 */
let migrationRunning = false
export const setMigrationRunning = (running: boolean): void => {
  migrationRunning = running
}
export const isMigrationRunning = (): boolean => migrationRunning

/**
 * 本次启动的路由结论缓存。由启动闸门写入（迁移完成 / 用户选择继续用旧库），`getStorage()` 读取。
 * 没有缓存时 `getStorage()` 自己调用路由解析一次。
 */
import type { StorageEngineChoice } from './types.js'

let engineChoice: StorageEngineChoice | undefined
export const setEngineChoice = (choice: StorageEngineChoice | undefined): void => {
  engineChoice = choice
}
export const getEngineChoice = (): StorageEngineChoice | undefined => engineChoice

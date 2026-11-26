/**
 * 状态机/备份/编排依赖的端口（#910）。
 *
 * `MigrationEnginePort` 是 `migration-engine`（`copyAll` / `verifyAll` / `fingerprintSource`）的**适配口**：
 * 本模块只认这三个函数，真实引擎就绪后在 `wiring.ts` 里把它适配成这个形状。
 */
import type {
  MigrationCheckpoint,
  MigrationPhase,
  RawStoreSink,
  RawStoreSource,
  VerifyReport,
} from './types.js'
import type { AppFileSystem } from '../../fs/types.js'
import type { OpenSqlDatabase, SqlDatabase } from '../sqlite/driver.js'

export type EngineCopyOptions = {
  source: RawStoreSource
  sink: RawStoreSink
  /** 续迁起点；缺省 = 从头 */
  checkpoints?: readonly MigrationCheckpoint[]
  /** 每批写入并读回计数一致后调用；返回后才算检查点落盘 */
  onCheckpoint?: (checkpoints: MigrationCheckpoint[]) => Promise<void>
  signal?: AbortSignal
}

export type MigrationEnginePort = {
  copyAll(options: EngineCopyOptions): Promise<MigrationCheckpoint[]>
  /** 对**源**校验目标：`source` 是真相，`target` 是被检对象。 */
  verifyAll(options: { source: RawStoreSource; target: RawStoreSource }): Promise<VerifyReport>
  fingerprintSource(source: RawStoreSource): Promise<string>
}

/** 一个 SQLite 目标库的原始读写口（由 `sqlite-schema` 的 `createSqliteRawSink` 及其读侧提供）。 */
export type SqliteTarget = { sink: RawStoreSink; source: RawStoreSource }

export type Clock = { now(): number }
/** 对 UTF-8 文本取 sha256（hex）。生产实现用 `attachments/sha256`，测试用 node:crypto。 */
export type Sha256Text = (text: string) => Promise<string>

export type MigrationProgress = {
  phase: MigrationPhase
  /** 0–100，粗略：按阶段加权，复制阶段按已完成 store 数 */
  percent: number
}

/** 编排器的全部依赖。全部注入：生产接线在 `runtime.ts`，测试直接传内存实现。 */
export type MigrationDeps = {
  fs: AppFileSystem
  /** 打开（必要时创建）一个 SQLite 库；`name` 相对应用私有库目录。 */
  openSqlite: OpenSqlDatabase
  /** 在已打开的库上建表并返回其原始读写口（sqlite-schema 的 `applySchema` + `createSqliteRawSink` 及读侧）。 */
  createTarget: (db: SqlDatabase) => Promise<SqliteTarget>
  /** 只读的旧库（IndexedDB）原始源。**永不写入。** */
  source: RawStoreSource
  engine: MigrationEnginePort
  clock: Clock
  sha256: Sha256Text
  signal?: AbortSignal
  onProgress?: (progress: MigrationProgress) => void
  /** SQLite 主库文件是否已存在；缺省视为存在。用于「没迁移过就不顺手创建一个空库」。 */
  sqliteFileExists?: () => Promise<boolean>
  /** 仅测试：每个阶段边界调用；抛出带 `killed: true` 的对象即模拟进程被杀（编排器不处理、不落 failed）。 */
  hooks?: { boundary?: (name: string) => void | Promise<void> }
}

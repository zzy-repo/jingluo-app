/**
 * IndexedDB → SQLite 迁移的共享契约（#910）。只有类型。
 *
 * 分工：
 *  - 原始读写口（本文件 `RawStoreSource/Sink`）：由两个后端各自实现。
 *  - 复制与校验引擎：只依赖这两个口，不依赖具体后端。
 *  - 状态机、备份、路由、启动闸门：只依赖这里的状态类型与 `AppFileSystem`。
 */

/** 现有库里的 9 个 store（与 `chat/db.ts` 的 `ChatDB` 一一对应，`DB_VERSION=15`）。 */
export const RAW_STORE_NAMES = [
  'sessions',
  'sessionSummaries',
  'files',
  'sessionsStaging',
  'filesStaging',
  'appAssets',
  'attachments',
  'attachmentTexts',
  'sessionMemory',
] as const
export type RawStoreName = (typeof RAW_STORE_NAMES)[number]

/** `key` 是该 store 的主键（字符串）。`value` 是 IndexedDB 里存的**原值**，Blob 字段保持 Blob，不预先序列化。 */
export type RawRow = { key: string; value: unknown }
export type RawPage = { rows: RawRow[]; next?: string }

/** 只读源。主键升序分页，`after` 为上一页的 `next`（不含）。 */
export type RawStoreSource = {
  count(store: RawStoreName): Promise<number>
  readBatch(store: RawStoreName, after: string | undefined, limit: number): Promise<RawPage>
  /** 估算全部数据的字节数（含 Blob），用于磁盘空间预检；允许偏高，不许偏低。 */
  estimateBytes(): Promise<number>
}

/**
 * 写入口。`writeBatch` 对同一主键是幂等的 upsert（断点续迁依赖它）。
 * 实现负责字段映射；映射必须无损，丢字段 = 缺陷（见 `docs/sqlite-schema.md`）。
 */
export type RawStoreSink = {
  writeBatch(store: RawStoreName, rows: readonly RawRow[]): Promise<void>
  /** 仅清空本迁移自己创建的目标库，**永远不得**用于旧库（IndexedDB）。 */
  clearAll(): Promise<void>
}

/** 校验口径：计数、主键集合、内容哈希。哈希对「字段语义」而不是对序列化字节，见校验器。 */
export type StoreVerification = {
  store: RawStoreName
  sourceCount: number
  targetCount: number
  keysMatch: boolean
  missingKeys: string[]
  extraKeys: string[]
  contentMismatchKeys: string[]
  /** 抽样/全量标记：本期要求全量 */
  full: boolean
}
export type VerifyReport = { ok: boolean; stores: StoreVerification[]; semanticIssues: string[] }

// ---------------------------------------------------------------- 状态机

/**
 * 持久化状态机。**权威副本在原生私有目录**（`storage-engine/state.json`，经 `AppFileSystem.writeAtomic`），
 * 不放 WebView 存储。真源规则只有一条：
 *   `committed` 之前真源 = IndexedDB；`committed` 之后真源 = SQLite，永远不回退。
 */
export type MigrationPhase =
  | 'idle' //             从未开始（或未启用）
  | 'preflight' //        空间预检 + 源指纹
  | 'backing-up' //       写独立备份
  | 'backup-verified' //  备份已校验
  | 'copying' //          复制中（带检查点）
  | 'verifying' //        全量校验
  | 'verified' //         校验通过，尚未切换
  | 'committed' //        已切换：SQLite 为真源（终态）
  | 'failed' //           失败：仍以 IndexedDB 为真源，带原因，可重试

export type MigrationFailure = {
  code:
    | 'insufficient-space'
    | 'backup-failed'
    | 'copy-failed'
    | 'verify-failed'
    | 'source-changed'
    | 'sqlite-unavailable'
    | 'unsupported'
    | 'interrupted'
    | 'unknown'
  message: string
  at: number
}

export type MigrationCheckpoint = {
  store: RawStoreName
  /** 已确认写入并读回计数一致的最后主键 */
  lastKey: string | undefined
  done: boolean
}

export type MigrationState = {
  schema: 1
  phase: MigrationPhase
  /** 每次状态变更 +1，用于诊断与防乱序覆盖 */
  seq: number
  startedAt?: number
  updatedAt: number
  /** 开始时的源指纹（各 store 计数 + 主键集合哈希）；断点续迁时重算比对，变了就判 `source-changed` 重来 */
  sourceFingerprint?: string
  checkpoints?: MigrationCheckpoint[]
  backup?: { dir: string; manifestSha256: string; bytes: number; verifiedAt?: number }
  failure?: MigrationFailure
  /** 迁移引擎/库结构版本，升级后可识别旧状态 */
  engineVersion: number
}

/** 路由对业务层暴露的启动结论。业务层只认这个，不认状态机细节。 */
export type StorageEngineChoice =
  | { engine: 'indexeddb'; reason: 'web' | 'native-not-ready' | 'migration-failed-fallback-allowed' }
  | { engine: 'sqlite' }
  | { engine: 'blocked'; reason: 'migrating' | 'sqlite-unavailable-after-commit' | 'needs-user-decision'; detail?: string }

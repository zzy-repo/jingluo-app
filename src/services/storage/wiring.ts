/**
 * 存储运行时接线（#910）：把兄弟模块适配成 `StorageRuntime` 并注册。
 *
 * 为什么单独一个文件：`migration/runtime.ts` 只声明形状（路由与闸门不 import 具体实现），
 * 真实实现分散在 `sqlite/native`（原生驱动）、`sqlite/backend`（SQLite 仓储）、
 * `sqlite/schema` + `sqlite/raw`（目标库结构 + 原始读写口）、`idb/raw`（旧库只读源）、
 * `migration/{copy,verify,hash}`（复制/校验引擎）、`idb/legacyBarrier`（防降级屏障）。
 * 这里只做「组装 + 形状适配」，不含任何业务判断。
 *
 * 注册时机：应用入口（`src/main.tsx`）在渲染之前调用 `installStorageRuntime()`。
 * **没有注册 = 原生 SQLite 视为不可用 = 路由恒为 IndexedDB**（行为与合并前一致）。
 *
 * 纪律：本文件不得 import react / zustand / components / app，也不得直接 `typeof indexedDB`。
 */
import { sha256Hex } from '../attachments/sha256.js'
import { getFs } from '../fs/index.js'
import { bumpLegacyIdbVersion } from './idb/legacyBarrier.js'
import { createIdbRawSource } from './idb/raw.js'
import { MAIN_DB_NAME } from './migration/config.js'
import { copyAll } from './migration/copy.js'
import { fingerprintSource } from './migration/hash.js'
import type { MigrationEnginePort, SqliteTarget } from './migration/ports.js'
import { configureStorageRuntime, type StorageRuntime } from './migration/runtime.js'
import type { MigrationCheckpoint, RawStoreSource } from './migration/types.js'
import { openSqliteStorage } from './sqlite/backend.js'
import type { SqlDatabase } from './sqlite/driver.js'
import { isNativeSqliteAvailable, openNativeSqlite } from './sqlite/native/driver.js'
import { createSqliteRawSink, createSqliteRawSource } from './sqlite/raw.js'
import { applySchema } from './sqlite/schema.js'

/** UTF-8 文本 → sha256 hex（状态文件校验和用；与 `attachments/sha256` 同一实现，不另写一份）。 */
const sha256Text = async (text: string): Promise<string> =>
  sha256Hex(new TextEncoder().encode(text).buffer as ArrayBuffer)

/**
 * 迁移引擎适配：`copyAll` 的真实返回值是统计对象，编排器要的是**检查点数组**
 * （它把数组落进状态文件，用于断点续迁）。这里顺手把两者的形状对上，不改引擎本身。
 */
const engine: MigrationEnginePort = {
  copyAll: async (options) => {
    let latest: MigrationCheckpoint[] = [...(options.checkpoints ?? [])]
    const result = await copyAll({
      source: options.source,
      sink: options.sink,
      ...(options.checkpoints === undefined ? {} : { checkpoints: options.checkpoints }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      // 引擎的检查点是**单个** store 的最新游标；编排器要的是整组（每个 store 一条）。
      onCheckpoint: async (checkpoint) => {
        latest = [...latest.filter((entry) => entry.store !== checkpoint.store), checkpoint]
        await options.onCheckpoint?.(latest)
      },
    })
    if (!result.completed) {
      // 被中止：把已落盘的检查点交回去，编排器按「中断」处理（不当作完成）
      throw Object.assign(new Error('copy interrupted'), { interrupted: true })
    }
    return latest
  },
  verifyAll: (options) => import('./migration/verify.js').then((m) => m.verifyAll(options)),
  fingerprintSource: (source: RawStoreSource) => fingerprintSource(source),
}

/** 在已打开的库上建表，并给出该库的原始读写口。 */
const createTarget = async (db: SqlDatabase): Promise<SqliteTarget> => {
  await applySchema(db)
  return { sink: createSqliteRawSink(db), source: createSqliteRawSource(db) }
}

const runtime: StorageRuntime = {
  isSqliteAvailable: () => isNativeSqliteAvailable(),
  openSqlite: (options) => openNativeSqlite({ name: options.name }),
  createTarget,
  openSqliteBackend: () => openSqliteStorage(() => openNativeSqlite({ name: MAIN_DB_NAME })),
  openIdbSource: () => createIdbRawSource(),
  engine,
  // 用户已确认（#910 评论）：committed 的同一步把旧 IDB 版本升一级，挡住「装回旧 APK 静默读过期库」。
  // 只在编排器的 verified 之后、committed 之前被调用；普通启动不会触发。
  bumpLegacyIdbVersion: () => bumpLegacyIdbVersion(),
  /**
   * 主库是否已存在。原生插件没有 `exists` 方法，这里**保守返回 true**：
   * 该判断只用于「状态文件丢了、可能有上次的半成品，先把**自己的**目标清干净再复制」，
   * 清空一个刚创建的空库是无副作用的，而复制本身是幂等 upsert。
   * 已知简化，记在 `docs/sqlite-native-checklist.md`。
   */
  sqliteFileExists: async () => true,
}

/** 进程内只装一次；重复调用是幂等的。 */
let installed = false

export const installStorageRuntime = (): void => {
  if (installed) {
    return
  }
  installed = true
  // `getFs()` 在 Web 上是 unsupported 实现，路由据此直接判 web → 不迁移（不需要额外判断）。
  void getFs()
  configureStorageRuntime(runtime)
}

export const uninstallStorageRuntimeForTests = (): void => {
  installed = false
  configureStorageRuntime(undefined)
}

export { sha256Text }

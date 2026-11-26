/**
 * SQLite 存储后端（#912）。`openSqliteStorage(openDb)` 返回 `StorageBackend`。
 *
 * 语义对照 `storage/types.ts` 的注释与 IDB 后端（`idb/backend.ts` + `idb/txRepos.ts`），
 * 差异与保守取值见 `docs/sqlite-schema.md` 第 9 节（#926 七条未定语义里本实现的选择）。
 *
 * 失败模型与 `getChatDB()` 一致：`StorageUnavailableError` / `StorageBlockedError` /
 * `StorageVersionTooNewError`。运行期错误经 `repos/errors.ts` 映射进 `StorageFailure` 四档。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  StorageBlockedError,
  StorageUnavailableError,
  StorageVersionTooNewError,
  type StorageInitFailure,
} from '../../chat/db.js'
import type { SqlDatabase } from './driver.js'
import { applySchema, readUserVersion, SCHEMA_VERSION } from './schema.js'
import { joinedRunner, topRunner, type Runner } from './repos/context.js'
import { guarded } from './repos/shared.js'
import { createSessionRepo } from './repos/sessions.js'
import { createBlobRepo } from './repos/blobs.js'
import { createAssetRepo } from './repos/assets.js'
import { createAttachmentRepo } from './repos/attachments.js'
import { createMemoryRepo } from './repos/memory.js'
import { createStagingRepo } from './repos/staging.js'
import type { AtomicOptions, AtomicRepos, StorageBackend, StorageHealth, StorageProbe } from '../types.js'

/** 标记「当前正处在某个 runAtomic 的回调里」，用来拒绝嵌套。 */
const nested = new AsyncLocalStorage<boolean>()

export type OpenSqlite = () => Promise<SqlDatabase>

const closedError = (): StorageUnavailableError => new StorageUnavailableError()

const healthOfError = (error: unknown): StorageHealth => ({
  ok: false,
  initFailure:
    error instanceof StorageBlockedError
      ? 'blocked'
      : error instanceof StorageVersionTooNewError
        ? 'version'
        : 'unavailable',
})

const buildRepos = (runner: Runner, mode: 'top' | 'atomic') => ({
  sessions: createSessionRepo(runner, mode),
  blobs: createBlobRepo(runner),
  assets: createAssetRepo(runner),
  attachments: createAttachmentRepo(runner),
  memory: createMemoryRepo(runner),
  staging: createStagingRepo(runner),
})

/**
 * 打开 SQLite 后端。
 * `openDb` 负责打开连接（含 WAL / synchronous=FULL / foreign_keys=ON / busy_timeout 的配置与回读，
 * 那是驱动的职责，见 `driver.ts`）；本函数负责建库结构与仓储。
 */
export const openSqliteStorage = async (openDb: OpenSqlite): Promise<StorageBackend> => {
  let db: SqlDatabase
  try {
    db = await openDb()
    await applySchema(db)
  } catch (error) {
    if (error instanceof StorageBlockedError || error instanceof StorageVersionTooNewError) {
      throw error
    }
    if (error instanceof Error && /user_version .* 高于本构建/.test(error.message)) {
      throw new StorageVersionTooNewError()
    }
    // 驱动层的 unavailable（打不开、PRAGMA 回读不符、损坏）与其它打开失败一律是「没有可用存储」
    throw new StorageUnavailableError()
  }

  let closed = false
  const assertOpen = () => {
    if (closed) {
      throw closedError()
    }
  }
  const runner = topRunner(db)

  const health = async (): Promise<StorageHealth> => {
    if (closed) {
      return { ok: false, initFailure: 'unavailable' }
    }
    try {
      const info = await db.info()
      if (info.journalMode !== 'wal' && info.journalMode !== 'memory') {
        return { ok: false, initFailure: 'unavailable' }
      }
      if (info.synchronous !== 'FULL' || !info.foreignKeys) {
        return { ok: false, initFailure: 'unavailable' }
      }
      return { ok: true }
    } catch (error) {
      return healthOfError(error)
    }
  }

  const repos = buildRepos(runner, 'top')

  return {
    sessions: guarded(repos.sessions, assertOpen),
    blobs: guarded(repos.blobs, assertOpen),
    assets: guarded(repos.assets, assertOpen),
    attachments: guarded(repos.attachments, assertOpen),
    memory: guarded(repos.memory, assertOpen),
    staging: guarded(repos.staging, assertOpen),

    runAtomic: async (work, _options?: AtomicOptions) => {
      assertOpen()
      // 不允许嵌套：回调里再调 runAtomic 直接拒绝（types.ts「实现必须拒绝」），外层事务随之回滚。
      if (nested.getStore() === true) {
        throw new Error('runAtomic 不允许嵌套')
      }
      return db.transaction((tx) => nested.run(true, () => work(buildRepos(joinedRunner(tx), 'atomic') as AtomicRepos)))
    },

    close: async () => {
      if (closed) {
        return
      }
      closed = true
      await db.close()
    },

    health,

    probe: async (): Promise<StorageProbe> => {
      const result = await health()
      let versionTooNew = false
      if (!closed) {
        try {
          versionTooNew = (await readUserVersion(db)) > SCHEMA_VERSION
        } catch (error) {
          versionTooNew = error instanceof StorageVersionTooNewError
        }
      }
      return { health: result, versionTooNew, persisted: undefined }
    },
  }
}

/** 打开失败的分类（供测试与诊断复用）。 */
export const openFailureKind = (error: unknown): StorageInitFailure | 'unavailable' =>
  healthOfError(error).ok ? 'unavailable' : (healthOfError(error) as { initFailure: StorageInitFailure | 'unavailable' }).initFailure

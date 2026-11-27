/**
 * 迁移前独立备份与恢复（#910，plan §4 backup；#924 恢复纪律）。
 *
 * 备份 = IDB 源经 `engine.copyAll` 复制进**独立文件**的 SQLite 库 `storage-engine/backup-<ts>.db`，
 * 再用 `engine.verifyAll` **对源**校验（源是真相，备份是被检对象）。通过才算 `backup-verified`。
 * 清单（manifest）写在 `storage-engine/backup-<ts>.manifest.json`：逐 store 计数、源指纹、库内 `integrity_check` 结论。
 * （文件 sha256 经 `AppFileSystem` 取不到库文件字节，所以用「库内完整性检查 + 逐 store 计数 + 指纹」作校验口径。）
 *
 * **备份永不自动删除**：本文件没有任何 `remove` 调用。失败/重试一律换新文件名，半成品留在原地。
 */
import type { AppFileSystem } from '../../fs/types.js'
import type { SqlDatabase } from '../sqlite/driver.js'
import { META_KEYS } from '../sqlite/schema.js'
import { BACKUP_PREFIX, MAIN_DB_NAME, MIGRATION_ENGINE_VERSION, STATE_DIR } from './config.js'
import { MigrationStepError } from './errors.js'
import type { MigrationDeps, MigrationEnginePort, SqliteTarget } from './ports.js'
import { canonicalJson } from './state.js'
import { RAW_STORE_NAMES, type MigrationState, type RawStoreName } from './types.js'

export type BackupManifest = {
  version: 1
  file: string
  createdAt: number
  sourceFingerprint: string
  integrity: 'ok'
  sourceBytesEstimate: number
  stores: { store: RawStoreName; count: number }[]
}

export type BackupRecord = NonNullable<MigrationState['backup']>

export const backupFileOf = (createdAt: number): string => `${STATE_DIR}/${BACKUP_PREFIX}${createdAt}.db`
export const manifestPathOf = (file: string): string => `${file.replace(/\.db$/u, '')}.manifest.json`

const withDb = async <T>(deps: Pick<MigrationDeps, 'openSqlite'>, name: string, work: (db: SqlDatabase) => Promise<T>): Promise<T> => {
  const db = await deps.openSqlite({ name })
  try {
    return await work(db)
  } finally {
    await db.close().catch(() => {})
  }
}

const countsOf = async (target: SqliteTarget): Promise<{ store: RawStoreName; count: number }[]> => {
  const out: { store: RawStoreName; count: number }[] = []
  for (const store of RAW_STORE_NAMES) {
    out.push({ store, count: await target.source.count(store) })
  }
  return out
}

/** 校验一个库作为「某份源的完整副本」：完整性 + 逐 store 计数 + 指纹，且 `verifyAll` 对**源**通过。 */
const verifyCopyAgainstSource = async (
  engine: MigrationEnginePort,
  source: MigrationDeps['source'],
  db: SqlDatabase,
  target: SqliteTarget,
  expectFingerprint: string,
  fail: (message: string) => never,
): Promise<void> => {
  const issues = await db.integrityCheck()
  if (issues.length > 0) {
    fail(`integrity_check: ${issues.slice(0, 3).join('; ')}`)
  }
  const report = await engine.verifyAll({ source, target: target.source })
  if (!report.ok) {
    const bad = report.stores.filter((entry) => entry.sourceCount !== entry.targetCount || !entry.keysMatch || entry.contentMismatchKeys.length > 0)
    fail(`verify: ${bad.map((entry) => entry.store).join(',') || report.semanticIssues.slice(0, 2).join(';')}`)
  }
  for (const store of RAW_STORE_NAMES) {
    const [left, right] = [await source.count(store), await target.source.count(store)]
    if (left !== right) {
      fail(`count ${store}: source ${left} backup ${right}`)
    }
  }
  const fingerprint = await engine.fingerprintSource(target.source)
  if (fingerprint !== expectFingerprint) {
    fail('fingerprint differs from source')
  }
}

/**
 * 创建并校验一份备份。成功返回要写进状态的 `backup`；任何一步失败抛 `backup-failed`（已写的半成品文件不删）。
 */
export const createBackup = async (deps: MigrationDeps, sourceFingerprint: string): Promise<BackupRecord> => {
  const createdAt = deps.clock.now()
  const file = backupFileOf(createdAt)
  const fail = (message: string): never => {
    throw new MigrationStepError('backup-failed', message)
  }
  try {
    const manifest = await withDb(deps, file, async (db) => {
      const target = await deps.createTarget(db)
      await deps.engine.copyAll({ source: deps.source, sink: target.sink, ...(deps.signal ? { signal: deps.signal } : {}) })
      await verifyCopyAgainstSource(deps.engine, deps.source, db, target, sourceFingerprint, fail)
      const built: BackupManifest = {
        version: 1,
        file,
        createdAt,
        sourceFingerprint,
        integrity: 'ok',
        sourceBytesEstimate: await deps.source.estimateBytes(),
        stores: await countsOf(target),
      }
      return built
    })
    const text = canonicalJson(manifest)
    await deps.fs.writeAtomic(manifestPathOf(file), text)
    return {
      dir: file,
      manifestSha256: await deps.sha256(text),
      bytes: manifest.sourceBytesEstimate,
      verifiedAt: deps.clock.now(),
    }
  } catch (error) {
    if (error instanceof MigrationStepError || (typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true)) {
      throw error
    }
    // `new Error(msg, { cause })` 要 Chromium 93+（WebView 83 静默不生效），按仓库既有写法直接赋值
    const failure = new MigrationStepError('backup-failed', error instanceof Error ? error.message : String(error))
    failure.cause = error
    throw failure
  }
}

/** 读回并核对清单文件（断点续迁时信任 `backup-verified` 之前先看清单还在、没被改）。 */
export const readBackupManifest = async (
  fs: AppFileSystem,
  sha256: MigrationDeps['sha256'],
  backup: BackupRecord,
): Promise<BackupManifest | undefined> => {
  const text = await fs.readText(manifestPathOf(backup.dir))
  if (text === undefined || (await sha256(text)) !== backup.manifestSha256) {
    return undefined
  }
  try {
    return JSON.parse(text) as BackupManifest
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- 恢复（#924：用户确认 + 先备份当前 + 校验不过拒绝）

export type RestoreResult =
  | { ok: true; preRestoreBackup: string | undefined; restoredFrom: string }
  | { ok: false; reason: 'not-confirmed' | 'no-backup' | 'backup-invalid' | 'current-unbackupable' | 'main-unopenable' | 'copy-failed'; detail?: string }

/**
 * 从迁移前备份恢复 SQLite 真源。**只在用户明确确认后**调用（`confirmed: true`），不碰 IDB、不删任何文件。
 *
 *  1. 校验备份：清单校验和、库完整性、逐 store 计数、指纹与清单一致；不过 → 拒绝。
 *  2. 先备份当前 SQLite 主库（`backupTo` → `storage-engine/pre-restore-<ts>.db`）；做不到 → 拒绝，不动当前库。
 *     主库根本打不开 → 拒绝（`main-unopenable`），原文件原样留给人工处理，不就地改写一个坏库。
 *  3. 把备份内容经引擎复制进主库（upsert，不先清空），再对备份校验；通过后补写 `meta`。
 */
export const restoreFromBackup = async (
  deps: MigrationDeps,
  options: { confirmed: boolean; backup: BackupRecord | undefined },
): Promise<RestoreResult> => {
  if (options.confirmed !== true) {
    return { ok: false, reason: 'not-confirmed' }
  }
  const { backup } = options
  if (!backup) {
    return { ok: false, reason: 'no-backup' }
  }
  const manifest = await readBackupManifest(deps.fs, deps.sha256, backup)
  if (!manifest) {
    return { ok: false, reason: 'backup-invalid', detail: 'manifest missing or checksum mismatch' }
  }
  // 1. 校验候选备份自身（它是一份复制品：对照清单里的计数与指纹）
  try {
    const invalid = await withDb(deps, backup.dir, async (db): Promise<string | undefined> => {
      const issues = await db.integrityCheck()
      if (issues.length > 0) {
        return `integrity_check: ${issues[0]}`
      }
      const target = await deps.createTarget(db)
      for (const entry of manifest.stores) {
        const count = await target.source.count(entry.store)
        if (count !== entry.count) {
          return `count ${entry.store}: manifest ${entry.count} backup ${count}`
        }
      }
      if ((await deps.engine.fingerprintSource(target.source)) !== manifest.sourceFingerprint) {
        return 'fingerprint differs from manifest'
      }
      return undefined
    })
    if (invalid !== undefined) {
      return { ok: false, reason: 'backup-invalid', detail: invalid }
    }
  } catch (error) {
    return { ok: false, reason: 'backup-invalid', detail: error instanceof Error ? error.message : String(error) }
  }
  // 2. 先备份当前状态
  const at = deps.clock.now()
  const preRestore = `${STATE_DIR}/pre-restore-${at}.db`
  let mainOpened: SqlDatabase
  try {
    mainOpened = await deps.openSqlite({ name: MAIN_DB_NAME })
  } catch (error) {
    return { ok: false, reason: 'main-unopenable', detail: error instanceof Error ? error.message : String(error) }
  }
  try {
    const issues = await mainOpened.integrityCheck().catch((error: unknown) => [String(error)])
    if (issues.length > 0) {
      return { ok: false, reason: 'main-unopenable', detail: `integrity_check: ${issues[0]}` }
    }
    try {
      await mainOpened.backupTo(preRestore)
    } catch (error) {
      return { ok: false, reason: 'current-unbackupable', detail: error instanceof Error ? error.message : String(error) }
    }
    // 3. 把备份复制进主库
    try {
      const mainTarget = await deps.createTarget(mainOpened)
      await withDb(deps, backup.dir, async (backupDb) => {
        const backupTarget = await deps.createTarget(backupDb)
        // 恢复语义 = 主库内容等于备份。主库是我们自己的 SQLite（不是 IDB），且已在上面先备份到 pre-restore；
        // 只清行、不删文件。
        await mainTarget.sink.clearAll()
        await deps.engine.copyAll({ source: backupTarget.source, sink: mainTarget.sink })
        const report = await deps.engine.verifyAll({ source: backupTarget.source, target: mainTarget.source })
        if (!report.ok) {
          throw new Error('verify after restore failed')
        }
      })
      await mainOpened.transaction(async (tx) => {
        for (const [key, value] of [
          [META_KEYS.engineVersion, String(MIGRATION_ENGINE_VERSION)],
          [META_KEYS.migratedFrom, manifest.sourceFingerprint],
          [META_KEYS.committedAt, String(deps.clock.now())],
        ] as const) {
          await tx.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
        }
      })
    } catch (error) {
      return {
        ok: false,
        reason: 'copy-failed',
        detail: `${error instanceof Error ? error.message : String(error)}; current state was saved to ${preRestore}`,
      }
    }
  } finally {
    await mainOpened.close().catch(() => {})
  }
  return { ok: true, preRestoreBackup: preRestore, restoredFrom: backup.dir }
}

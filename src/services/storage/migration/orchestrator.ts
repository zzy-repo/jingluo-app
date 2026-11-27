/**
 * 迁移编排器（#910，plan §4）。
 *
 *   idle → preflight → backing-up → backup-verified → copying → verifying → verified → committed
 *                 ╰──────────── 任一步失败 ───────────→ failed（真源仍是 IDB）
 *
 * 纪律：
 *  - 每个阶段**先写状态再推进**；任意边界被杀，用同一份持久状态重入得到同一终态（幂等、可重入）。
 *  - 本函数**只跑一遍**，不自带重试循环。「同一启动内最多自动重试一次」由 `ensureStorageReady` 控制。
 *  - 只清**自己创建的** SQLite 目标（`sink.clearAll()`）；对 IDB 源只读，对备份与损坏的状态文件**永不删除**。
 *  - `committed` 的写入顺序：先 SQLite `meta`，再状态文件；写之前再做一次 integrityCheck 与逐 store 计数复核。
 *  - 全部依赖注入（`MigrationDeps`）；本文件不碰平台、不 import `@capacitor/*`。
 */
import { META_KEYS } from '../sqlite/schema.js'
import type { SqlDatabase } from '../sqlite/driver.js'
import { createBackup, readBackupManifest } from './backup.js'
import { LIMITS } from '../../limits.js'
import { MAIN_DB_NAME, MIGRATION_ENGINE_VERSION } from './config.js'
import { MigrationStepError, isKilled } from './errors.js'
import type { MigrationDeps, SqliteTarget } from './ports.js'
import { createStateStore, loadMigrationState, preserveCorruptState, type MigrationStateX } from './state.js'
import {
  RAW_STORE_NAMES,
  type MigrationCheckpoint,
  type MigrationFailure,
  type MigrationPhase,
} from './types.js'

export type MigrationOutcome =
  | { status: 'committed'; state: MigrationStateX; restarted?: boolean }
  | { status: 'failed'; state: MigrationStateX; failure: MigrationFailure }
  /** 两处见证矛盾：不猜，需要用户决定。 */
  | { status: 'blocked'; detail: string }

/** 各阶段进度区间的起点（百分比）；复制阶段按已完成 store 数插值。 */
const PERCENT: Record<MigrationPhase, number> = {
  idle: 0,
  preflight: 2,
  'backing-up': 5,
  'backup-verified': 30,
  copying: 35,
  verifying: 85,
  verified: 95,
  committed: 100,
  failed: 0,
}

const failureCodeOf = (error: unknown): MigrationFailure['code'] => {
  if (error instanceof MigrationStepError) {
    return error.code
  }
  const kind = typeof error === 'object' && error !== null ? (error as { kind?: unknown }).kind : undefined
  if (kind === 'quota') {
    return 'insufficient-space'
  }
  if (kind === 'unavailable' || kind === 'unsupported') {
    return 'sqlite-unavailable'
  }
  return 'unknown'
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/**
 * 空间需求（lead 采纳的预检阈值，数字只在 `LIMITS.storageMigration`）：
 * `2×S + 备份(≈S) + 余量`，S = `estimateBytes()`（只许偏高）。迁移期磁盘 = 源 + 备份 + 目标（ADR-0910）。
 */
export const requiredFreeBytes = (sourceEstimate: number): number =>
  sourceEstimate * 2 + sourceEstimate + LIMITS.storageMigration.reserveBytes

/**
 * `insufficient-space` 的失败说明：**这里生成、这里解析**（`parseSpaceMessage` 紧跟其后）。
 *
 * 为什么保留原始字节数而不直接写成人话：这条 message 会落进 `state.json` 供诊断，机器可读比好看重要。
 * 迁移页要的是「可用 / 所需 / 建议清理」三个数，它通过 `parseSpaceMessage` 拿到**判定那一刻**的 need/have ——
 * 比失败后再读一次磁盘可靠（那时候用户可能已经清过、或者正在清）。
 */
export const spaceFailureMessage = (requiredBytes: number, freeBytes: number): string =>
  `need ${requiredBytes} bytes free, have ${freeBytes}`

const SPACE_MESSAGE_PATTERN = /need (\d+) bytes free, have (\d+)/u

/** `spaceFailureMessage` 的逆运算；不是这条说明（例如复制中途磁盘写满的 quota 错误）就返回 undefined。 */
export const parseSpaceMessage = (message: string): { requiredBytes: number; freeBytes: number } | undefined => {
  const matched = SPACE_MESSAGE_PATTERN.exec(message)
  if (matched === null) {
    return undefined
  }
  const requiredBytes = Number(matched[1])
  const freeBytes = Number(matched[2])
  return Number.isSafeInteger(requiredBytes) && Number.isSafeInteger(freeBytes) ? { requiredBytes, freeBytes } : undefined
}

/** 预检的纯判定，供单测钉边界：返回 undefined = 通过，否则是失败码与说明。 */
export const judgePreflight = (
  estimate: number,
  free: number | undefined,
): { code: MigrationFailure['code']; message: string } | undefined => {
  if (estimate > LIMITS.storageMigration.maxBytes) {
    return { code: 'unsupported', message: `source-too-large: ${estimate} bytes exceeds ${LIMITS.storageMigration.maxBytes}; export your data first` }
  }
  if (free === undefined) {
    return { code: 'unsupported', message: 'free disk space is unknown; refusing to migrate' }
  }
  const required = requiredFreeBytes(estimate)
  if (free < required) {
    return { code: 'insufficient-space', message: spaceFailureMessage(required, free) }
  }
  return undefined
}

export const runMigration = async (deps: MigrationDeps): Promise<MigrationOutcome> => {
  const store = createStateStore(deps.fs, deps.sha256)
  const boundary = async (name: string): Promise<void> => {
    await deps.hooks?.boundary?.(name)
  }

  // ---- 读两个见证人并收敛（与路由共用同一份规则）
  const loaded = await loadMigrationState({
    fs: deps.fs,
    openSqlite: deps.openSqlite,
    sha256: deps.sha256,
    clock: deps.clock,
    ...(deps.sqliteFileExists ? { sqliteFileExists: deps.sqliteFileExists } : {}),
  })
  if (loaded.kind === 'blocked') {
    return { status: 'blocked', detail: loaded.detail }
  }
  let state: MigrationStateX
  if (loaded.kind === 'idle-keep-corrupt') {
    await preserveCorruptState(deps.fs, deps.clock.now())
    state = { schema: 1, phase: 'idle', seq: 0, updatedAt: deps.clock.now(), engineVersion: MIGRATION_ENGINE_VERSION }
  } else {
    state = loaded.state
  }

  const save = async (patch: Partial<MigrationStateX>): Promise<void> => {
    const next: MigrationStateX = {
      ...state,
      ...patch,
      failure: patch.phase === 'failed' ? patch.failure : undefined,
      legacyBarrier: 'legacyBarrier' in patch ? patch.legacyBarrier : state.legacyBarrier,
      seq: state.seq + 1,
      updatedAt: deps.clock.now(),
      engineVersion: MIGRATION_ENGINE_VERSION,
    }
    if (next.startedAt === undefined) {
      next.startedAt = next.updatedAt
    }
    await store.write(next)
    state = next
    const done = (next.checkpoints ?? []).filter((entry) => entry.done).length
    const percent =
      next.phase === 'copying'
        ? Math.floor(PERCENT.copying + ((PERCENT.verifying - PERCENT.copying) * done) / RAW_STORE_NAMES.length)
        : PERCENT[next.phase]
    deps.onProgress?.({ phase: next.phase, percent })
    await boundary(`written:${next.phase}`)
  }

  if (loaded.kind === 'rebuild-committed' || loaded.kind === 'finish-commit') {
    await save({ phase: 'committed' })
    return { status: 'committed', state }
  }
  if (state.phase === 'committed') {
    return { status: 'committed', state }
  }

  let main: SqlDatabase | undefined
  let metaWritten = false
  let legacyBumped = false
  // 重入时状态里已有屏障子步骤 = 上次升版可能已生效，失败处置与「刚升过」相同
  if (state.legacyBarrier !== undefined) {
    legacyBumped = true
  }
  let target: SqliteTarget | undefined
  const openMain = async (): Promise<SqliteTarget> => {
    if (!target) {
      main = await deps.openSqlite({ name: MAIN_DB_NAME })
      target = await deps.createTarget(main)
    }
    return target
  }
  const aborted = (): void => {
    if (deps.signal?.aborted) {
      throw new MigrationStepError('interrupted', 'aborted')
    }
  }

  try {
    // ================================================ preflight
    aborted()
    const resumingFromFailure = state.phase === 'failed'
    const preCopy = ['idle', 'failed', 'preflight', 'backing-up'].includes(state.phase)
    const priorCode = state.failure?.code
    if (state.phase === 'idle' || state.phase === 'failed' || state.phase === 'preflight') {
      await save({ phase: 'preflight', checkpoints: state.checkpoints })
    }
    await boundary('enter:preflight')
    // 空间预检只在「还没开始占用目标空间」的阶段做；已进入复制/校验的重入不再要求整套空间
    // （目标与备份已经占着了，再按整套要求会把本可完成的迁移误判为空间不足）
    if (preCopy) {
      const estimate = await deps.source.estimateBytes()
      const free = await deps.fs.freeBytes()
      deps.onProgress?.({
        phase: 'preflight',
        percent: PERCENT.preflight,
        preflight: {
          estimateBytes: estimate,
          requiredBytes: requiredFreeBytes(estimate),
          warn: estimate > LIMITS.storageMigration.warnBytes,
        },
      })
      const rejected = judgePreflight(estimate, free)
      if (rejected) {
        throw new MigrationStepError(rejected.code, rejected.message)
      }
    }
    const fingerprint = await deps.engine.fingerprintSource(deps.source)
    let restarted = false
    if (state.sourceFingerprint !== undefined && state.sourceFingerprint !== fingerprint) {
      // 源在两次运行之间变了：清掉**自己创建的**目标，从头来（备份文件留着，不删）
      const own = await openMain()
      await own.sink.clearAll()
      restarted = true
      await save({
        phase: 'preflight',
        sourceFingerprint: fingerprint,
        checkpoints: undefined,
        backup: undefined,
      })
    } else if (state.sourceFingerprint === undefined) {
      // 全新开始（含「状态文件丢了、但上次留下半个主库」）：没有 committed 见证的主库只可能是我们自己的半成品，清行重来
      if ((await deps.sqliteFileExists?.()) === true) {
        await (await openMain()).sink.clearAll()
      }
      await save({ phase: 'preflight', sourceFingerprint: fingerprint })
    }
    if (resumingFromFailure && (priorCode === 'verify-failed' || priorCode === 'sqlite-unavailable')) {
      // 目标被判不可信：清掉自己的目标，复制从头
      const own = await openMain()
      await own.sink.clearAll()
      await save({ phase: 'preflight', checkpoints: undefined })
    }

    // ================================================ backing-up
    aborted()
    let backupOk = false
    if (state.backup?.verifiedAt !== undefined) {
      const manifest = await readBackupManifest(deps.fs, deps.sha256, state.backup)
      backupOk = manifest !== undefined && manifest.sourceFingerprint === fingerprint
    }
    if (!backupOk) {
      await save({ phase: 'backing-up', backup: undefined })
      await boundary('enter:backing-up')
      const backup = await createBackup(deps, fingerprint)
      await save({ phase: 'backup-verified', backup })
    } else if (state.phase === 'preflight' || state.phase === 'backing-up') {
      await save({ phase: 'backup-verified' })
    }

    // ================================================ copying
    aborted()
    const own = await openMain()
    if (state.phase === 'backup-verified' || state.phase === 'copying' || state.phase === 'preflight') {
      await save({ phase: 'copying' })
      await boundary('enter:copying')
      const done = await deps.engine.copyAll({
        source: deps.source,
        sink: own.sink,
        ...(state.checkpoints ? { checkpoints: state.checkpoints } : {}),
        onCheckpoint: async (checkpoints: MigrationCheckpoint[]) => {
          aborted()
          await save({ phase: 'copying', checkpoints })
          await boundary('checkpoint')
        },
        ...(deps.signal ? { signal: deps.signal } : {}),
      }).catch((error: unknown) => {
        if (isKilled(error) || error instanceof MigrationStepError) {
          throw error
        }
        const failure = new MigrationStepError('copy-failed', messageOf(error))
        failure.cause = error
        throw failure
      })
      await save({ phase: 'verifying', checkpoints: done })
    }

    // ================================================ verifying
    aborted()
    if (state.phase === 'verifying') {
      await boundary('enter:verifying')
      const report = await deps.engine.verifyAll({ source: deps.source, target: own.source }).catch((error: unknown) => {
        if (isKilled(error)) {
          throw error
        }
        const failure = new MigrationStepError('verify-failed', messageOf(error))
        failure.cause = error
        throw failure
      })
      if (!report.ok) {
        const bad = report.stores
          .filter((entry) => !entry.keysMatch || entry.contentMismatchKeys.length > 0 || entry.sourceCount !== entry.targetCount)
          .map((entry) => entry.store)
        throw new MigrationStepError('verify-failed', `mismatch in: ${bad.join(',') || report.semanticIssues.slice(0, 2).join(';')}`)
      }
      await save({ phase: 'verified' })
    }

    // ================================================ commit
    aborted()
    if (state.phase === 'verified') {
      await boundary('enter:commit')
      const db = main
      if (!db) {
        throw new MigrationStepError('sqlite-unavailable', 'target database is not open')
      }
      // 写 committed 前的最后复核：库完整 + 逐 store 计数 + 源指纹未变
      const issues = await db.integrityCheck()
      if (issues.length > 0) {
        throw new MigrationStepError('verify-failed', `integrity_check: ${issues[0]}`)
      }
      for (const name of RAW_STORE_NAMES) {
        const [left, right] = [await deps.source.count(name), await own.source.count(name)]
        if (left !== right) {
          throw new MigrationStepError('verify-failed', `count ${name}: source ${left} sqlite ${right}`)
        }
      }
      if ((await deps.engine.fingerprintSource(deps.source)) !== state.sourceFingerprint) {
        throw new MigrationStepError('source-changed', 'source changed before commit')
      }
      // 0) 防降级屏障（仅当注入了 bump 且正式迁移条件满足：走到这里 = 开关开 + 校验通过）。
      //    子步骤写入状态：started（升版前）→ 升版并确认可打开 → done。重入看到 started/done 直接继续，不回复制、不回 idle。
      if (deps.bumpLegacyIdbVersion && state.legacyBarrier !== 'done') {
        // 一旦写入 started 就视为「升版可能已生效」（升版成功但确认失败也算）：此后失败不写 failed、不回头重做
        await save({ phase: 'verified', legacyBarrier: 'started' })
        legacyBumped = true
        await boundary('legacy-started')
        await deps.bumpLegacyIdbVersion()
        await save({ phase: 'verified', legacyBarrier: 'done' })
        await boundary('legacy-done')
      }
            // 1) SQLite meta（第二见证人）
      const committedAt = String(deps.clock.now())
      await db.transaction(async (tx) => {
        for (const [key, value] of [
          [META_KEYS.engineVersion, String(MIGRATION_ENGINE_VERSION)],
          [META_KEYS.migratedFrom, state.sourceFingerprint ?? ''],
          [META_KEYS.committedAt, committedAt],
        ] as const) {
          await tx.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, value])
        }
      })
      metaWritten = true
      await boundary('meta-written')
      // 2) 状态文件（权威副本）。meta 已写：这里瞬时失败就重试一次，免得留下「meta 已切换、状态文件没跟上」
      //    （即便仍失败，下次启动按 `finish-commit` 规则补写，不会被当作矛盾）
      await save({ phase: 'committed' }).catch(async (error: unknown) => {
        if (isKilled(error)) {
          throw error
        }
        await save({ phase: 'committed' })
      })
    }
    return { status: 'committed', state, ...(restarted ? { restarted } : {}) }
  } catch (error) {
    if (isKilled(error)) {
      throw error
    }
    const failure: MigrationFailure = {
      code: failureCodeOf(error),
      message: messageOf(error),
      at: deps.clock.now(),
    }
    // 失败写状态；写不进去也不能掩盖原因（真源本来就还是 IDB）。
    // 例外：SQLite meta 已写入 committed 时，真源已经是 SQLite，**不得**把状态文件写成 failed（那会制造矛盾）；
    // 状态文件停在 verified，下次路由按 `finish-commit` 收敛。
    // 同理，旧 IDB 版本已升时也不写 failed：状态停在 verified，重入直接从提交步继续（不回到复制、不回到 idle）。
    if (!metaWritten && !legacyBumped) {
      await save({ phase: 'failed', failure }).catch(() => {})
    }
    return { status: 'failed', state, failure }
  } finally {
    await main?.close().catch(() => {})
  }
}

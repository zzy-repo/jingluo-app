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
import { META_KEYS, readMeta } from '../sqlite/schema.js'
import type { SqlDatabase } from '../sqlite/driver.js'
import { createBackup, readBackupManifest } from './backup.js'
import { LIMITS } from '../../limits.js'
import { MAIN_DB_NAME, MIGRATION_ENGINE_VERSION } from './config.js'
import { MigrationStepError, isKilled } from './errors.js'
import { MAIN_DB_PRESENCE_UNKNOWN_DETAIL, assertNever, resolveMainDbTouch } from './presence.js'
import type { MigrationDeps, SqliteTarget } from './ports.js'
import { createStateStore, hasBusinessData, loadMigrationState, preserveCorruptState, type MigrationStateX } from './state.js'
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

/** #980 护栏 B 的 blocked 详情：状态不明确，拒绝动主库。 */
export const MAIN_DB_AMBIGUOUS_DETAIL = 'state-ambiguous-refuse-to-clear-main-db'
/** #980 护栏 B 最后一道的 blocked 详情：清空前发现主库已提交，停止覆盖。 */
export const MAIN_DB_COMMITTED_DETAIL = 'main-db-committed-refuse-to-overwrite'
/** #980 护栏 B：状态不明确且主库读不出来 → 停下来，绝不当作「空库」清掉。 */
export const MAIN_DB_UNREADABLE_DETAIL = 'state-ambiguous-main-db-unreadable'

/**
 * 「拿不准，拒绝动主库」的专用错误类型。
 *
 * 为什么不是普通 `MigrationStepError`：那是「迁移失败」的载体，会被分类器翻成
 * `sqlite-unavailable` →「原生数据库不可用」，与真实原因（我们主动保护数据）完全相反。
 * 它只在本文件内部用于跳过后面的清空逻辑，由 `catch` 转成 `blocked`，并把 `detail` 原样带上面。
 */
class MainDbRefusalError extends Error {
  readonly detail: string

  constructor(detail: string) {
    super(detail)
    this.name = 'MainDbRefusalError'
    this.detail = detail
  }
}

/**
 * 主库探针的**三态**结论（#980）。
 *
 * 关键点：`absent`（文件不存在 = 全新安装，安全）与 `unreadable`（文件在、但读不出来 = **拿不准**）
 * 绝不能混成同一个值。上一版两者都返回 `undefined`，调用方于是把「读不出来」当成「没有 committed」，
 * 继续往下清库 —— 那正是这道防线最不该犯的错（拿不准时必须偏向**不动手**）。
 */
type MainDbProbe =
  | { state: 'absent' }
  | { state: 'ok'; committedAt?: string; hasData: boolean }
  | { state: 'unreadable' }
  /**
   * #986：连「主库文件在不在」都没查出来（`sqliteFileExists()` 自己抛错）。
   * 与 `unreadable`（文件在、读不出来）分开记：两者都**不允许**动手，但现场的修法完全不同
   * （一个是查不到文件系统，一个是库打不开），混成一个值会让诊断说不清。
   */
  | { state: 'unknown' }

/**
 * #980 护栏 B（写侧）的第一步：**只读**探一次主库。
 *
 * 库文件不存在就不去打开它（打开一个不存在的库会创建空库，而空库不是证据）。
 * 打不开 / 读失败一律返回 undefined —— 调用方据此「不猜」，不会拿到一个乐观结论。
 */
const inspectMainDb = async (deps: MigrationDeps): Promise<MainDbProbe> => {
  /**
   * #986：存在性判定改走 `presence.ts` 的三态唯一入口。
   *
   * 旧写法 `deps.sqliteFileExists().catch(() => true)` 是 fail-open：检查自己失败 → 当成「文件在」
   * → 仍然 `openSqlite()` → 驱动为不存在的库**创建一个空库** → 探针读到「没有 committed_at、
   * 没有业务数据」，下游据此放行清库。也就是说「查不出来」这件事本身被翻译成了「干净、可以清」。
   * 现在 `unknown` 不 open，直接返回 `{ state: 'unknown' }`，调用方一律停下来。
   */
  const touch = await resolveMainDbTouch(deps.sqliteFileExists, 'clear')
  if (!touch.allow) {
    return { state: 'unknown' }
  }
  if (touch.presence === 'absent') {
    // 文件不存在 = 全新安装。**这条必须放行**，否则新用户永远迁不了
    return { state: 'absent' }
  }
  let db: SqlDatabase | undefined
  try {
    db = await deps.openSqlite({ name: MAIN_DB_NAME })
    const committedAt = await readMeta(db, META_KEYS.committedAt)
    // 「有没有业务数据」只有一处实现（state.ts 的 hasBusinessData，覆盖全部九张 store 表）：
    // 迁移侧的拦截与见证人的判定必须用同一个口径，否则两边会各说各话。
    const hasData = await hasBusinessData(db)
    return { state: 'ok', ...(committedAt === undefined ? {} : { committedAt }), hasData }
  } catch {
    // 文件在、但打不开/读不出来：可能是别人的库、可能是瞬时锁 —— 都**拿不准**，不当作可清
    return { state: 'unreadable' }
  } finally {
    await db?.close().catch(() => {})
  }
}

/**
 * 预检的纯判定，供单测钉边界：返回 undefined = 通过，否则是失败码与说明。
 */
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

  /**
   * ---- #980 护栏 B（写侧）：状态不明确时**禁止清空主库、禁止重跑**，保留现场交用户。----
   *
   * 「状态不明确」= 我们无法证明主库里那些行是谁写的。落在这里的两种局面：
   *   1. 状态文件损坏且没有 `committed_at` 见证（`idle-keep-corrupt`）——上面已把状态换成全新的 idle，
   *      但库里的行就无从解释了；
   *   2. 状态文件缺失 / 全新状态（没有 `sourceFingerprint`）。
   * 这两种局面在旧代码里都会走到 `clearAll()` 再从头复制一遍 —— 那等于用「读不懂的状态文件」
   * 换「可能真实的用户数据」，而且 `clearAll` 只清主库、备份只覆盖 IDB 源（`backup.ts`），
   * 被清掉的行没有任何副本。按用户口径：状态不明确就**停下来**，不迁、不清、不覆盖。
   *
   * 「主库是全新的」不受影响：库文件不存在 → 探不到事实；库是空的 → 没有 committed、没有业务行。
   */
  const mainProbe = await inspectMainDb(deps)
  if (mainProbe.state === 'unreadable') {
    // 读不出来 ≠ 空的。这条以前会被跳过（undefined 直接被 `!== undefined` 放行）
    return { status: 'blocked', detail: MAIN_DB_UNREADABLE_DETAIL }
  }
  if (mainProbe.state === 'unknown') {
    // #986：连文件在不在都没查出来 —— 与「读不出来」同等处置（不动手），但详情分开写，便于归因
    return { status: 'blocked', detail: MAIN_DB_PRESENCE_UNKNOWN_DETAIL }
  }
  if (
    mainProbe.state === 'ok' &&
    state.sourceFingerprint === undefined &&
    (mainProbe.committedAt !== undefined || mainProbe.hasData)
  ) {
    return { status: 'blocked', detail: MAIN_DB_AMBIGUOUS_DETAIL }
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
  /**
   * #980 护栏 B（写侧）的最后一道：**清空主库之前**再核一次见证。
   *
   * 入口那道判定用的是启动那一刻的事实；走到这里说明中途要「清掉自己的半成品重来」。
   * 万一这期间库里出现了 `committed_at`（另一个进程 / 上一次运行刚提交完），那就不是半成品：
   * 拒绝清空，让这次迁移失败并报错 —— 宁可失败，也不覆盖一份已提交的库。
   */
  const clearOwnTarget = async (): Promise<void> => {
    const live = await inspectMainDb(deps)
    // 三态都要显式落到一个分支上：只有「文件不存在」和「读到了、且没有 committed_at」才允许清。
    // #986：分支穷尽交给编译器（`assertNever`）—— 以后给探针加第四种结论却漏判，这里编不过。
    switch (live.state) {
      case 'unreadable':
        throw new MainDbRefusalError(MAIN_DB_UNREADABLE_DETAIL)
      case 'unknown':
        // 查不出来 ≠ 可以清。`openSqlite` 会为不存在的库创建空库，绝不能在「不知道」时走到那儿。
        throw new MainDbRefusalError(MAIN_DB_PRESENCE_UNKNOWN_DETAIL)
      case 'ok':
        if (live.committedAt !== undefined) {
          // 不抛 `sqlite-unavailable`：那会被分类器翻成「原生数据库不可用」，用户照着去查存储权限，
          // 而真实原因是「我们检测到已提交的数据、主动停止覆盖」。
          throw new MainDbRefusalError(MAIN_DB_COMMITTED_DETAIL)
        }
        break
      case 'absent':
        break
      default:
        assertNever(live)
    }
    await (await openMain()).sink.clearAll()
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
      await clearOwnTarget()
      restarted = true
      await save({
        phase: 'preflight',
        sourceFingerprint: fingerprint,
        checkpoints: undefined,
        backup: undefined,
      })
    } else if (state.sourceFingerprint === undefined) {
      // 全新开始（含「状态文件丢了、但上次留下半个主库」）：没有 committed 见证的主库只可能是我们自己的半成品，清行重来
      // #980：库里有业务行的那种「丢档」上面已经 return blocked 了，能走到这里的库是空的或不存在。
      // #986：这里原来直接读 `sqliteFileExists()` 的布尔值 —— 检查失败（抛错）会让判断整个跳过，
      // 「可能有半成品目标」被静默放过。改走同一处三态判定：absent 才跳过，present 先清，unknown 停下来。
      const touch = await resolveMainDbTouch(deps.sqliteFileExists, 'clear')
      if (!touch.allow) {
        throw new MainDbRefusalError(touch.detail)
      }
      if (touch.presence === 'present') {
        await clearOwnTarget()
      }
      await save({ phase: 'preflight', sourceFingerprint: fingerprint })
    }
    if (resumingFromFailure && (priorCode === 'verify-failed' || priorCode === 'sqlite-unavailable')) {
      // 目标被判不可信：清掉自己的目标，复制从头
      await clearOwnTarget()
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
      /**
       * #986「切换」：这也是破坏性动作 —— 真源一旦切到 SQLite 就没有回退路径（IDB 从此只做只读
       * 旧源，见 `idb/legacyBarrier.ts`）。所以切换前和清库前用**同一个**判定：主库文件在不在
       * 查不出来（`unknown`）就不切。旧代码在切换这一步没有存在性前置，直接写 `meta.committed_at`。
       */
      const switchTouch = await resolveMainDbTouch(deps.sqliteFileExists, 'switch')
      if (!switchTouch.allow) {
        throw new MainDbRefusalError(switchTouch.detail)
      }
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
    // 护栏 B 的最后一道拦下的不是「迁移失败」，是「拒绝覆盖已提交的库」：转成 blocked，别写 failed 状态，
    // 也别让用户看到「原生数据库不可用」那种会把人带偏的文案。
    if (error instanceof MainDbRefusalError) {
      return { status: 'blocked', detail: error.detail }
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

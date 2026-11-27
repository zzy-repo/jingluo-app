/**
 * 迁移状态机的持久化与双见证收敛（#910，plan D4/D5）。
 *
 * 权威副本：应用私有目录 `storage-engine/state.json`，只经 `AppFileSystem.writeAtomic` 写。
 * 第二见证人：SQLite `meta` 表的 `committed_at`（有值 = 见证人说「已切换」）。
 *
 * 收敛规则（纯函数 `reconcileWitnesses`，三种情况都有单测钉住）：
 *   1. 状态文件缺失，但 SQLite 有 `committed_at` → 以 SQLite 为真源，重建状态（committed）。
 *   2. 状态文件损坏，且 SQLite 没有 `committed_at` → 当作 `idle`（仍是 IDB），损坏文件原样保留。
 *   3. 两处见证矛盾（状态文件说没切、SQLite 说已切，或反过来）→ `blocked: needs-user-decision`，不猜。
 */
import type { SqlDatabase } from '../sqlite/driver.js'
import { META_KEYS, STORE_TABLES, readMeta } from '../sqlite/schema.js'
import type { AppFileSystem } from '../../fs/types.js'
import { STATE_DIR, STATE_PATH, MIGRATION_ENGINE_VERSION, MAIN_DB_NAME } from './config.js'
import { MAIN_DB_PRESENCE_UNKNOWN_DETAIL, resolveMainDbTouch } from './presence.js'
import type { Clock, Sha256Text } from './ports.js'
import type { OpenSqlDatabase } from '../sqlite/driver.js'
import type { MigrationCheckpoint, MigrationFailure, MigrationPhase, MigrationState } from './types.js'

const PHASES: readonly MigrationPhase[] = [
  'idle',
  'preflight',
  'backing-up',
  'backup-verified',
  'copying',
  'verifying',
  'verified',
  'committed',
  'failed',
]

const FAILURE_CODES: readonly MigrationFailure['code'][] = [
  'insufficient-space',
  'backup-failed',
  'copy-failed',
  'verify-failed',
  'source-changed',
  'sqlite-unavailable',
  'unsupported',
  'interrupted',
  'unknown',
]

const RAW_STORES = [
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

/** SQLite 见证人读到的东西。`unavailable` = 库打不开（不等于「没有 committed」）。 */
export type SqliteWitness = {
  committedAt?: string
  migratedFrom?: string
  /** 库文件存在但打不开/读不了（不等于「没有 committed」）。 */
  unavailable?: boolean
  /** 库文件根本不存在。 */
  absent?: boolean
  /**
   * #986：**连「库文件在不在」都没查出来**（`sqliteFileExists()` 自己抛错）。
   *
   * 与 `absent`（确认没有）、`unavailable`（文件在、打不开）是三个不同的事实，不能互相折算：
   *  - 折成 `absent` → 把「可能存在的已提交库」当成全新安装，正是「已提交却回退 IndexedDB」的入口；
   *  - 折成「存在」→ 会去 `openSqlite`，而打开一个不存在的库**会创建空库**，凭空造出一个见证。
   * 收敛时见到它一律 `blocked`（不猜、不动手）。
   */
  presenceUnknown?: boolean
  /** 打不开的原因（诊断用；只进 blocked 详情，不参与判定）。 */
  unavailableReason?: string
  /**
   * 库里**有没有已迁移的业务数据**（读 `sessions` 的条数）。
   *
   * 为什么需要：迁移备份是在 `committed` **之前**拍的，里面还没有 `meta.committed_at`。
   * 用户用这份备份覆盖主库来恢复时，状态文件说 committed、见证人说没有 —— 旧逻辑判「矛盾」并 block，
   * 于是**没有一个可用的恢复路径**（真机复现，见 #924）。库里真有数据这件事本身比一行元数据更强，
   * 所以把「有数据」记为独立事实，交给下面的收敛规则用。
   */
  hasData?: boolean
}

/**
 * `MigrationState`（共享契约，不改）的结构兼容扩展：`verified → committed` 之间显式记录屏障子步骤。
 *  - `legacyBarrier: 'started'`：已决定并开始升旧 IDB 版本（可能已生效，也可能没有）；
 *  - `legacyBarrier: 'done'`：升版完成并确认可打开。
 * 它不是阶段（阶段仍是 `verified`），重入看到它就**直接继续提交步**，不回 idle、不回复制。
 */
export type LegacyBarrierStep = 'started' | 'done'
export type MigrationStateX = MigrationState & { legacyBarrier?: LegacyBarrierStep }

export type WitnessOutcome =
  | { kind: 'use'; state: MigrationStateX }
  /** 状态文件缺失但 SQLite 见证已切换：以 SQLite 为真源，须把重建的状态写回去。 */
  | { kind: 'rebuild-committed'; state: MigrationStateX }
  /**
   * 状态文件停在 `verified`，但 SQLite 已写入 `committed_at` 且 `migrated_from` 与状态里的源指纹一致：
   * 这正是「先写 meta、再写状态文件」之间被杀的窗口，不是矛盾。补写 `committed` 即可。
   */
  | { kind: 'finish-commit'; state: MigrationStateX }
  /** 状态文件损坏且 SQLite 未见证切换：当作 idle，损坏文件保留。 */
  | { kind: 'idle-keep-corrupt' }
  /** 两处见证互相矛盾：不得猜，交给用户。 */
  | { kind: 'blocked'; detail: string }

/** 状态文件内容的校验和覆盖范围：除 `checksum` 自身外的全部字段，按键名排序。 */
export type StateFile = MigrationState & { checksum: string }

export type StateStore = {
  /** 读盘上的状态文件。缺失 → undefined；内容损坏 → `{ corrupt: true }`（文件不动）。 */
  read(): Promise<MigrationStateX | { corrupt: true } | undefined>
  /** 原子写：`seq` 由调用方在状态里维护，这里只补校验和。 */
  write(state: MigrationStateX): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isPhase = (value: unknown): value is MigrationPhase =>
  typeof value === 'string' && (PHASES as readonly string[]).includes(value)

const parseFailure = (value: unknown): MigrationFailure | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const { code, message, at } = value
  if (
    typeof code === 'string' &&
    (FAILURE_CODES as readonly string[]).includes(code) &&
    typeof message === 'string' &&
    typeof at === 'number' &&
    Number.isFinite(at)
  ) {
    return { code: code as MigrationFailure['code'], message, at }
  }
  return undefined
}

const parseCheckpoints = (value: unknown): MigrationCheckpoint[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined
  }
  const out: MigrationCheckpoint[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      return undefined
    }
    if (
      typeof item.store !== 'string' ||
      !(RAW_STORES as readonly string[]).includes(item.store) ||
      !(item.lastKey === undefined || typeof item.lastKey === 'string') ||
      typeof item.done !== 'boolean'
    ) {
      return undefined
    }
    out.push({ store: item.store as MigrationCheckpoint['store'], lastKey: item.lastKey, done: item.done })
  }
  return out
}

const parseBackup = (value: unknown): MigrationState['backup'] => {
  if (!isRecord(value)) {
    return undefined
  }
  const { dir, manifestSha256, bytes, verifiedAt } = value
  if (
    typeof dir !== 'string' ||
    typeof manifestSha256 !== 'string' ||
    typeof bytes !== 'number' ||
    !Number.isFinite(bytes) ||
    !(verifiedAt === undefined || (typeof verifiedAt === 'number' && Number.isFinite(verifiedAt)))
  ) {
    return undefined
  }
  return { dir, manifestSha256, bytes, verifiedAt }
}

/**
 * 校验一份解码后的状态。校验失败返回 undefined —— 调用方据此判定「损坏」，不得猜测修复。
 */
export const parseMigrationState = (value: unknown): MigrationStateX | undefined => {
  if (!isRecord(value)) {
    return undefined
  }
  const { schema, phase, seq, updatedAt, engineVersion } = value
  if (
    schema !== 1 ||
    !isPhase(phase) ||
    typeof seq !== 'number' ||
    !Number.isInteger(seq) ||
    seq < 0 ||
    typeof updatedAt !== 'number' ||
    !Number.isFinite(updatedAt) ||
    typeof engineVersion !== 'number' ||
    !Number.isInteger(engineVersion)
  ) {
    return undefined
  }
  const state: MigrationStateX = { schema: 1, phase, seq, updatedAt, engineVersion }
  if (value.legacyBarrier !== undefined) {
    if (value.legacyBarrier !== 'started' && value.legacyBarrier !== 'done') {
      return undefined
    }
    state.legacyBarrier = value.legacyBarrier
  }
  if (value.startedAt !== undefined) {
    if (typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)) {
      return undefined
    }
    state.startedAt = value.startedAt
  }
  if (value.sourceFingerprint !== undefined) {
    if (typeof value.sourceFingerprint !== 'string') {
      return undefined
    }
    state.sourceFingerprint = value.sourceFingerprint
  }
  if (value.checkpoints !== undefined) {
    const checkpoints = parseCheckpoints(value.checkpoints)
    if (!checkpoints) {
      return undefined
    }
    state.checkpoints = checkpoints
  }
  if (value.backup !== undefined) {
    const backup = parseBackup(value.backup)
    if (!backup) {
      return undefined
    }
    state.backup = backup
  }
  if (value.failure !== undefined) {
    const failure = parseFailure(value.failure)
    if (!failure) {
      return undefined
    }
    state.failure = failure
  }
  return state
}

/** 规范化 JSON：键名排序、无空白，校验和与写出都用它，避免字段顺序影响校验。 */
export const canonicalJson = (value: unknown): string => {
  return canonical(value)
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`
  }
  if (isRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 校验和覆盖的正文：去掉 checksum 字段后的规范化 JSON。 */
export const stateChecksumBody = (file: Record<string, unknown>): string => {
  const rest: Record<string, unknown> = { ...file }
  delete rest.checksum
  return canonical(rest)
}

/** 一份初始状态（idle）。 */
export const freshState = (now: number): MigrationState => ({
  schema: 1,
  phase: 'idle',
  seq: 0,
  updatedAt: now,
  engineVersion: MIGRATION_ENGINE_VERSION,
})

/**
 * `blocked` 详情的两个具名常量（#980）：路由要按**含义**分流，不能靠字符串散落在两处各写一遍。
 *
 * - `CORRUPT_BUT_COMMITTED_DETAIL`：状态文件坏了，但库自证 `committed_at` 在 → 读侧护栏 A 的依据
 * - `AMBIGUOUS_STATE_DETAIL`：状态文件坏/缺失而库里已有业务数据 → 读侧护栏 B（宁可停下也不猜）
 */
export const CORRUPT_BUT_COMMITTED_DETAIL = 'state-file-corrupt-and-sqlite-meta-committed'
export const AMBIGUOUS_STATE_DETAIL = 'state-file-ambiguous-but-sqlite-has-data'

/**
 * 双见证收敛。纯函数：不读盘、不写盘、不猜。
 *
 * @param file 状态文件的读取结果：正常状态 / 损坏 / 缺失
 * @param witness SQLite `meta` 的读取结果
 */
export const reconcileWitnesses = (
  file: MigrationStateX | { corrupt: true } | undefined,
  witness: SqliteWitness,
  now: number,
): WitnessOutcome => {
  const sqliteSaysCommitted = witness.committedAt !== undefined && witness.committedAt.length > 0
  const fileCorrupt = file !== undefined && 'corrupt' in file
  const fileState = file === undefined || 'corrupt' in file ? undefined : file

  /**
   * #986：主库文件在不在都没查出来 → 不猜。
   *
   * 四个分支（文件缺失 / 损坏 / committed / 其它阶段）在这里全都不能放行：任何一条放行都会落到
   * 「拿未知去换用户数据」（重迁、清库、或把已提交用户送回冻结的旧 IDB 快照）。
   * 这也是 `readFilePresence` 里那句「不打开可能不存在的库」的执行侧：`unknown` 连 open 都不会发生。
   */
  if (witness.presenceUnknown === true) {
    return { kind: 'blocked', detail: MAIN_DB_PRESENCE_UNKNOWN_DETAIL }
  }

  if (file === undefined) {
    if (sqliteSaysCommitted) {
      return {
        kind: 'rebuild-committed',
        state: {
          ...freshState(now),
          phase: 'committed',
          seq: 1,
          startedAt: Number(witness.committedAt) || now,
        },
      }
    }
    // 状态文件没了，库文件在却读不了：可能是已切换用户，不能当作全新安装去覆盖它
    return witness.unavailable === true
      ? { kind: 'blocked', detail: 'state-file-missing-and-sqlite-unreadable' }
      : { kind: 'use', state: freshState(now) }
  }
  if (fileCorrupt) {
    if (sqliteSaysCommitted) {
      return { kind: 'blocked', detail: CORRUPT_BUT_COMMITTED_DETAIL }
    }
    return witness.unavailable === true
      ? { kind: 'blocked', detail: 'state-file-corrupt-and-sqlite-unreadable' }
      : { kind: 'idle-keep-corrupt' }
  }
  if (!fileState) {
    return { kind: 'idle-keep-corrupt' }
  }
  if (fileState.phase === 'committed') {
    // 库不存在/打不开不是矛盾：留给路由判 sqlite-unavailable-after-commit。
    if (witness.unavailable === true || witness.absent === true || sqliteSaysCommitted) {
      return { kind: 'use', state: fileState }
    }
    /**
     * 状态说 committed、见证人却没有 `committed_at`，但**库里有业务数据**：这是「用户用迁移备份
     * 覆盖主库恢复」或「commit 写完 meta 前掉电」的结果。库里真有数据比一行元数据更强，
     * 判为已切换并补写见证（`finish-commit`），否则用户被永久 block、没有任何恢复路径（#924）。
     * 库里没有数据时仍然是矛盾 → block（不猜、不覆盖）。
     */
    if (witness.hasData === true) {
      return { kind: 'finish-commit', state: fileState }
    }
    return { kind: 'blocked', detail: 'state-file-committed-but-sqlite-meta-missing' }
  }
  if (sqliteSaysCommitted) {
    if (
      fileState.phase === 'verified' &&
      fileState.sourceFingerprint !== undefined &&
      witness.migratedFrom === fileState.sourceFingerprint
    ) {
      return { kind: 'finish-commit', state: fileState }
    }
    return { kind: 'blocked', detail: `state-file-${fileState.phase}-but-sqlite-meta-committed` }
  }
  return { kind: 'use', state: fileState }
}

/**
 * 读 SQLite 见证人。库打不开 → `unavailable: true`；库能开但没有 `meta` 表/行 → 空见证。
 * 注意：打开一个不存在的库文件会创建一个空库（驱动行为），空库没有 `meta`，不构成见证。
 */
export const readSqliteWitness = async (open: () => Promise<SqlDatabase>): Promise<SqliteWitness> => {
  let db: SqlDatabase
  try {
    db = await open()
  } catch (error) {
    // 把原因带出来：闸门的 blocked 详情会显示它，否则「库打不开」在真机上完全无法归因
    return {
      unavailable: true,
      ...(error instanceof Error ? { unavailableReason: `${error.name}: ${error.message}` } : {}),
    }
  }
  try {
    const committedAt = await readMeta(db, META_KEYS.committedAt)
    const migratedFrom = await readMeta(db, META_KEYS.migratedFrom)
    const hasData = await hasBusinessData(db)
    return { committedAt, migratedFrom, hasData }
  } catch {
    return {}
  } finally {
    await db.close().catch(() => {})
  }
}

/** 「表不存在」= 库结构还没建（空库/半成品库的正常表现），不等于读失败。 */
const isMissingTable = (error: unknown): boolean =>
  /no such table/iu.test(error instanceof Error ? error.message : String(error))

/**
 * 库里有业务数据吗 —— **九张 store 表任意一张有行**即算有。
 *
 * 为什么不再只看 `sessions`：`chat/db.ts` 的引用计数保证「删会话不等于删文件」，
 * 孤儿原件（`files` / `attachments` / `attachmentTexts`）本来就可能单独存在。
 * 只数会话会把这类库判成「空库」，而「空库」在下游意味着「可以清空重来」——
 * 这正是 #980 要堵的那一类（会话删了、附件原件还在的库会被清掉）。
 *
 * 读失败一律当作**有数据**（保守）：这个判断唯一的用途是「要不要动手清库/要不要拦」，
 * 拿不准时必须偏向不动手。唯独「表不存在」例外 —— 那不是读失败，是结构还没建，按空处理。
 */
export const hasBusinessData = async (db: SqlDatabase): Promise<boolean> => {
  for (const store of Object.values(STORE_TABLES)) {
    try {
      const rows = await db.all(`SELECT count(*) AS c FROM ${store.table}`)
      const value = rows[0]?.c
      if ((typeof value === 'number' ? value : Number(value ?? 0)) > 0) {
        return true
      }
    } catch (error) {
      if (!isMissingTable(error)) {
        return true
      }
    }
  }
  return false
}

export const createStateStore = (fs: AppFileSystem, sha256: Sha256Text): StateStore => {
  const read = async (): Promise<MigrationStateX | { corrupt: true } | undefined> => {
    const text = await fs.readText(STATE_PATH)
    if (text === undefined) {
      return undefined
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(text)
    } catch {
      return { corrupt: true }
    }
    if (!isRecord(decoded) || typeof decoded.checksum !== 'string') {
      return { corrupt: true }
    }
    const expected = await sha256(stateChecksumBody(decoded))
    if (expected !== decoded.checksum) {
      return { corrupt: true }
    }
    const parsed = parseMigrationState(decoded)
    return parsed ?? { corrupt: true }
  }

  const write = async (state: MigrationStateX): Promise<void> => {
    const body = canonical(state)
    const checksum = await sha256(body)
    const file: Record<string, unknown> = { ...state, checksum }
    await fs.writeAtomic(STATE_PATH, canonical(file))
  }

  return { read, write }
}

export type LoadDeps = {
  fs: AppFileSystem
  openSqlite: OpenSqlDatabase
  sha256: Sha256Text
  clock: Clock
  sqliteFileExists?: () => Promise<boolean>
}

export type LoadedState = {
  outcome: WitnessOutcome
  witness: SqliteWitness
  /** 状态文件的读取原值（#980：路由要区分「文件在但坏了」与「文件就没有」，两者失效条件不同） */
  file: MigrationStateX | { corrupt: true } | undefined
}

/** 读两个见证人并收敛。路由与编排器共用，保证两边对「现在是什么状态」只有一个答案。 */
export const loadMigrationStateDetailed = async (deps: LoadDeps): Promise<LoadedState> => {
  const file = await createStateStore(deps.fs, deps.sha256).read()
  /**
   * 主库文件不存在就不去打开它：打开一个不存在的库会创建空库，而空库不是见证。
   *
   * #986：这条理由要成立，「文件在不在」就必须是三态（`presence.ts`）。旧写法是
   * `await deps.sqliteFileExists().catch(() => true)` —— 检查自己失败时按「文件在」处理，
   * 于是照样 `openSqlite`，上面这句话当场失效：一次失败的检查会**造出一个空库**，
   * 而空库读回来的见证是「没有 committed_at、没有业务数据」，下游据此把可能已提交的用户
   * 当成全新安装（回退 IDB）或当成可清空的半成品。
   * 现在 `unknown` 直接不 open，见证人记为 `presenceUnknown`，`reconcileWitnesses` 见它就 `blocked`。
   */
  const touch = await resolveMainDbTouch(deps.sqliteFileExists, 'migrate')
  const witness: SqliteWitness = !touch.allow
    ? { presenceUnknown: true }
    : touch.presence === 'present'
      ? await readSqliteWitness(() => deps.openSqlite({ name: MAIN_DB_NAME }))
      : { absent: true }
  return { outcome: reconcileWitnesses(file, witness, deps.clock.now()), witness, file }
}

export const loadMigrationState = async (deps: LoadDeps): Promise<WitnessOutcome> =>
  (await loadMigrationStateDetailed(deps)).outcome

/** 状态文件损坏时，改写它之前先把原文件原样另存（永不删除）。返回另存的路径；原文件不存在返回 undefined。 */
export const preserveCorruptState = async (fs: AppFileSystem, now: number): Promise<string | undefined> => {
  const raw = await fs.read(STATE_PATH)
  if (raw === undefined) {
    return undefined
  }
  const target = `${STATE_DIR}/state.corrupt-${now}.json`
  await fs.writeAtomic(target, raw)
  return target
}

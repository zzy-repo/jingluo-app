/**
 * 备份的**纯逻辑**（Issue #993 任务 2）：文件名约定、清单读写用的结构与校验、失败分类、保留策略、
 * 下一份备份的体积预估。
 *
 * 这一层不碰 Capacitor、不碰 IndexedDB、不碰 DOM —— 全是可以直接单测的函数。文件读写在
 * `nativeBackupFs.ts`，编排在 `backupApi.ts`。
 *
 * 目录里一共四种文件，全部平铺在 App 私有目录 `backups/` 下（`BackupFilePlugin` 只接受
 * `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` 的名字，所以 id 里不能用 `:`）：
 *
 * ```
 * b-20261127T100500123Z.zip                 归档本体（历史导出格式，可被本 App 导入）
 * b-20261127T100500123Z.attachments.zip     附件原件 + attachments 元数据（可选）
 * b-20261127T100500123Z.manifest.json       清单：时间 / 大小 / 版本 / 校验值 / 数据概况
 * status.json                               上次成功时间与上次失败分类（跨重启保留）
 * ```
 *
 * **清单最后写**：它的存在就是「这份备份完整」的提交标记 —— 没有清单的归档一律不当成备份
 * （半截产物不会对外宣称「已受保护」）。
 */
import {
  judgeWriteSpace,
  WRITE_AMPLIFICATION_FACTOR,
  type WriteSpaceVerdict,
} from '../storage.js'

import { LIMITS } from '../limits.js'

/** 清单格式版本；恢复前用它判「这份备份是不是这个版本写的」。 */
export const BACKUP_FORMAT_VERSION = 1

/** 保留份数上限（含本次新写的那一份）：超出才清理，且只在新备份写入并校验成功后。 */
export const RETENTION_KEEP = 3

export const BACKUP_ID_PREFIX = 'b-'
export const MANIFEST_SUFFIX = '.manifest.json'
export const ARCHIVE_SUFFIX = '.zip'
export const ATTACHMENTS_SUFFIX = '.attachments.zip'
/** 状态文件：不是备份，不参与保留策略，也不会被当成可恢复项。 */
export const STATUS_FILE_NAME = 'status.json'

/**
 * 失败分类（面向 UI 的**唯一**出口）。上层把原始 message / 路径 / 校验值写诊断日志，
 * 返回值只给这几个词，界面据此选人话。
 *
 * - `space`：空间不足（写前预判或原生 ENOSPC）。已有备份未受影响；
 * - `interrupted`：写入被中断（进程被杀 / 会话冲突 / 取消）。临时文件已丢弃，已有备份未受影响；
 * - `corrupt`：备份损坏或校验不通过（内容与清单不符 / 文件截断 / 清单读不出来）；
 * - `empty`：本地库是空的（异常空库保护：不写、也不清理任何旧份）；
 * - `unsupported`：本设备没有原生私有目录（Web / 老壳）；
 * - `unknown`：其余。
 */
export type BackupFailureKind =
  | 'space'
  | 'interrupted'
  | 'corrupt'
  | 'empty'
  | 'unsupported'
  | 'unknown'

/** 恢复失败的对外错误码：安全备份失败单独一档，UI 才敢说「先保护现有数据这一步没成功」。 */
export type BackupErrorCode =
  | 'safety-backup-failed'
  | 'corrupt'
  | 'space'
  /** 读不到剩余空间（原生 `freeBytes` 不可用）、负载又大到不能拿试错换：**不是**空间不足 */
  | 'space-unverifiable'
  | 'interrupted'
  | 'unknown'
  | 'empty'
  | 'unsupported'

/**
 * 这份备份是**谁触发的**（#1005）：`safety` = 恢复前自动为「当前数据」写下的那一份。
 *
 * 为什么必须落进清单，而不是靠调用方传个布尔值记住：改这一版之前，安全备份在盘上与常规备份
 * **完全无法区分**（同一命名规则、同一归档格式、清单里没有任何字段），「安全备份不参与常规保留
 * 清理」这件事只存在于 `runBackupOnce(…, { prune: false })` 这一次调用的栈帧里。进程一重启、
 * 或者换一条调用路径扫目录，盘上那些安全备份就再没人认得 —— 它们于是**无上限堆积**
 * （设备实测：两次恢复，3 份 → 5 份 zip / 约 226MB，而磁盘写满正是本版整库丢失事故的根因）。
 *
 * 写进清单之后，它是**落盘的、随时可重建的事实**：任何一次扫目录都能分出哪几份是安全备份，
 * 清理也就不再依赖「当时那次调用记不记得」。
 */
export type BackupOrigin = 'auto' | 'manual' | 'safety'

const BACKUP_ORIGINS: readonly BackupOrigin[] = ['auto', 'manual', 'safety']

/** 清单里的来源标记：只认这三个词，其余（含老清单的「没有这个字段」）一律 null = 常规备份。 */
const parseOrigin = (value: unknown): BackupOrigin | null =>
  typeof value === 'string' && (BACKUP_ORIGINS as readonly string[]).includes(value)
    ? (value as BackupOrigin)
    : null

/** 一份备份里的文件引用：名字 + 字节数 + 整档 sha256（`sizeBytes` 用于「便宜的一致性检查」）。 */
export type BackupFileRef = { name: string; sizeBytes: number; sha256: string }

/** 清单里的数据概况：UI 的恢复确认页显示「这份备份里有多少会话」。 */
export type BackupSummary = { sessions: number; attachments: number }

/**
 * 清单文件（`<id>.manifest.json`）的结构。
 *
 * `verified: true` 表示：归档与附件都经过「原生侧重读校验 + rename」落盘。恢复前还会再算一遍
 * 整档摘要与 `archive.sha256` 比对，那一层不依赖这个字段 —— 它只是让「列表里的这条能不能点恢复」
 * 有一个便宜的判据。
 */
export type BackupManifest = {
  backup_format_version: number
  id: string
  created_at_utc: string
  archive: BackupFileRef
  attachments: BackupFileRef | null
  data_summary: BackupSummary
  verified: boolean
  /**
   * 谁触发的这份备份；**老清单没有这个字段**（那时不分安全 / 常规）。
   * 缺省 = 按常规备份对待：既不加倍保护，也不额外豁免清理。
   */
  origin?: BackupOrigin
}

/**
 * `status.json`：跨重启保留的「上次**备份**成功 / 上次失败分类」，不含任何原始异常信息。
 *
 * `last_restore_at_utc` 是**独立字段**：恢复过一次不代表「刚做过备份」，界面上的「最近备份时间」
 * 只能由真正写完并校验的备份推进 —— 恢复不许篡改它。
 */
export type BackupStatusFile = {
  last_success_at_utc: string | null
  last_restore_at_utc: string | null
  last_error: string | null
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/**
 * 备份 id：`b-YYYYMMDDTHHMMSSmmmZ`（UTC）。
 *
 * 用「秒 + 毫秒」而不是随机串，是为了**文件名排序 = 时间排序**（保留策略与列表都不用另存时间）；
 * 带上毫秒是因为「手动备份刚成功、紧接着恢复触发的安全备份」会落在同一秒里。
 */
export const backupIdOf = (date: Date): string =>
  `${BACKUP_ID_PREFIX}${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}T` +
  `${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}` +
  `${pad(date.getUTCMilliseconds(), 3)}Z`

export const archiveFileName = (id: string): string => `${id}${ARCHIVE_SUFFIX}`
export const attachmentsFileName = (id: string): string => `${id}${ATTACHMENTS_SUFFIX}`
export const manifestFileName = (id: string): string => `${id}${MANIFEST_SUFFIX}`

/** `<id>.manifest.json` → id；其他文件名（含 `status.json`）返回 null。 */
export const parseManifestFileName = (name: string): string | null => {
  if (!name.endsWith(MANIFEST_SUFFIX)) {
    return null
  }
  const id = name.slice(0, -MANIFEST_SUFFIX.length)
  return id.startsWith(BACKUP_ID_PREFIX) && id.length > BACKUP_ID_PREFIX.length ? id : null
}

/** 保留策略 / 列表用的最小结构（避免让纯逻辑依赖契约层的类型）。 */
export type BackupFacts = {
  id: string
  createdAtUtc: string
  sizeBytes: number
  checksumOk: boolean
  /** 见 {@link BackupOrigin}；缺省（老清单 / 清单读不出来）= 常规备份 */
  origin?: BackupOrigin
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

const parseFileRef = (value: unknown): BackupFileRef | null => {
  if (!isRecord(value)) {
    return null
  }
  const { name, size_bytes: sizeBytes, sha256 } = value
  if (typeof name !== 'string' || name.length === 0) {
    return null
  }
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null
  }
  if (typeof sha256 !== 'string' || sha256.length !== 64) {
    return null
  }
  return { name, sizeBytes, sha256 }
}

const parseSummary = (value: unknown): BackupSummary | null => {
  if (!isRecord(value)) {
    return null
  }
  const sessions = value.sessions
  const attachments = value.attachments
  if (!isCount(sessions) || !isCount(attachments)) {
    return null
  }
  return { sessions, attachments }
}

/**
 * 清单解析（严格）：任何一项不合格都返回 null —— 一份读不懂的清单不是「大概能用」，
 * 它在恢复前就该被判成 `corrupt`，而不是等导入到一半才发现。
 */
export const parseManifest = (value: unknown): BackupManifest | null => {
  if (!isRecord(value)) {
    return null
  }
  if (value.backup_format_version !== BACKUP_FORMAT_VERSION) {
    return null
  }
  const { id, created_at_utc: createdAtUtc } = value
  if (typeof id !== 'string' || !id.startsWith(BACKUP_ID_PREFIX)) {
    return null
  }
  if (typeof createdAtUtc !== 'string' || Number.isNaN(Date.parse(createdAtUtc))) {
    return null
  }
  const archive = parseFileRef(value.archive)
  const summary = parseSummary(value.data_summary)
  if (!archive || !summary) {
    return null
  }
  const attachments =
    value.attachments === null || value.attachments === undefined
      ? null
      : parseFileRef(value.attachments)
  if (value.attachments !== null && value.attachments !== undefined && !attachments) {
    return null
  }
  const origin = parseOrigin(value.origin)
  return {
    backup_format_version: BACKUP_FORMAT_VERSION,
    id,
    created_at_utc: createdAtUtc,
    archive,
    attachments,
    data_summary: summary,
    verified: value.verified === true,
    // 只在**真的有标记**时才把键放进去：老清单解析回来必须还是它原来的样子
    // （`tests/unit/backup-core-993.test.mjs` 的往返断言就是钉这一点的）
    ...(origin === null ? {} : { origin }),
  }
}

/** 清单落盘用的 JSON（`snake_case`，与归档格式的命名习惯一致）。 */
export const manifestToJson = (manifest: BackupManifest): string =>
  JSON.stringify({
    backup_format_version: manifest.backup_format_version,
    id: manifest.id,
    created_at_utc: manifest.created_at_utc,
    archive: {
      name: manifest.archive.name,
      size_bytes: manifest.archive.sizeBytes,
      sha256: manifest.archive.sha256,
    },
    attachments:
      manifest.attachments === null
        ? null
        : {
            name: manifest.attachments.name,
            size_bytes: manifest.attachments.sizeBytes,
            sha256: manifest.attachments.sha256,
          },
    data_summary: {
      sessions: manifest.data_summary.sessions,
      attachments: manifest.data_summary.attachments,
    },
    verified: manifest.verified,
    // 同上：老清单（没有来源标记）序列化回来也不许多出一个 `origin`
    ...(manifest.origin === undefined ? {} : { origin: manifest.origin }),
  })

/** `status.json` 解析：读不出来就当「没有历史」，不因此阻断备份。 */
export const parseStatusFile = (text: string | null): BackupStatusFile => {
  const empty: BackupStatusFile = { last_success_at_utc: null, last_restore_at_utc: null, last_error: null }
  if (!text) {
    return empty
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return empty
  }
  if (!isRecord(parsed)) {
    return empty
  }
  return {
    last_success_at_utc:
      typeof parsed.last_success_at_utc === 'string' ? parsed.last_success_at_utc : null,
    last_restore_at_utc:
      typeof parsed.last_restore_at_utc === 'string' ? parsed.last_restore_at_utc : null,
    last_error: typeof parsed.last_error === 'string' ? parsed.last_error : null,
  }
}

export const statusFileToJson = (status: BackupStatusFile): string =>
  JSON.stringify({
    last_success_at_utc: status.last_success_at_utc,
    last_restore_at_utc: status.last_restore_at_utc,
    last_error: status.last_error,
  })

const FAILURE_BY_CODE: Record<string, BackupFailureKind> = {
  NO_SPACE: 'space',
  ENOSPC: 'space',
  CHECKSUM_MISMATCH: 'corrupt',
  VERIFY_FAILED: 'corrupt',
  SHORT_READ: 'corrupt',
  BAD_CHUNK: 'corrupt',
  NOT_FOUND: 'corrupt',
  BUSY: 'interrupted',
  NO_WRITE: 'interrupted',
  ABORTED: 'interrupted',
  // 写到一半失败（含磁盘满在写块时才暴露的情况）：临时文件已丢弃，已有备份不受影响。
  // 磁盘满由上层再用「剩余空间是否已经见底」二次判定成 `space`，见 backupApi 的失败收口。
  WRITE_FAILED: 'interrupted',
  RENAME_FAILED: 'interrupted',
  UNSUPPORTED: 'unsupported',
}

/**
 * `error` → 失败分类（**只认 code，不认 message**；message 一律进诊断日志）。
 * 判不出来的落 `unknown` —— 宁可让人话含糊，也不许把异常原文透给界面。
 */
export const classifyFailure = (error: unknown): BackupFailureKind => {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      const known = FAILURE_BY_CODE[code]
      if (known) {
        return known
      }
    }
    const kind = (error as { kind?: unknown }).kind
    if (typeof kind === 'string' && isBackupFailureKind(kind)) {
      return kind
    }
  }
  return 'unknown'
}

export const isBackupFailureKind = (value: string): value is BackupFailureKind =>
  value === 'space' ||
  value === 'interrupted' ||
  value === 'corrupt' ||
  value === 'empty' ||
  value === 'unsupported' ||
  value === 'unknown'

const createdDesc = (a: BackupFacts, b: BackupFacts): number =>
  Date.parse(b.createdAtUtc) - Date.parse(a.createdAtUtc)

/**
 * 时间戳的**可信来源**：清单里的 `created_at_utc`。解析不出来就返回 null。
 *
 * 为什么不拿 `readdir` 顺序或原生 `mtime`：目录顺序在真机上不稳定（排序不是契约），而 `mtime`
 * 会被复制 / 搬家改写。**判不出时间的东西一律不参与清理**（见 `selectPrunableSafety`）——
 * 把「不知道多老」当成「最老」来删，正是数据安全最不该犯的错。
 */
const trustedCreatedAt = (item: BackupFacts): number | null => {
  const parsed = Date.parse(item.createdAtUtc)
  return Number.isNaN(parsed) ? null : parsed
}

/** 按可信时间倒序（新的在前）；时间不可信的排在最后（调用方另行决定要不要动它）。 */
const newestFirst = (items: readonly BackupFacts[]): BackupFacts[] =>
  [...items].sort((a, b) => (trustedCreatedAt(b) ?? Number.NEGATIVE_INFINITY) - (trustedCreatedAt(a) ?? Number.NEGATIVE_INFINITY))

/**
 * 保留策略：按时间倒序保留最新的 `keep` 份**常规备份**，返回**可以删**的 id。
 *
 * 三条硬约束：
 *  1. **最新的一份永不删**（它就是刚写成功的那份，也是恢复前的安全备份）；
 *  2. 删完之后必须**至少还剩一份校验通过的备份** —— 「唯一有效备份」不许被静默删掉；
 *  3. 只返回 id，删不删由调用方在「新备份已写入并校验」之后才执行（顺序不能反）。
 *
 * #1005 起：`origin === 'safety'` 的备份**不数进这个名额**。它们原先也算在 `RETENTION_KEEP`
 * 里 —— 于是「恢复两次」会让常规备份被安全备份挤掉，而安全备份自己又完全不受上限约束
 * （`prune: false`），两头都不对。现在两组各按各的上限（常规 `RETENTION_KEEP`、
 * 安全 `SAFETY_RETENTION_KEEP`），总数第一次有了上界。
 */
export const selectPrunable = (items: readonly BackupFacts[], keep: number): string[] => {
  const limit = Math.max(1, Math.floor(keep))
  const sorted = [...items].filter((item) => item.origin !== 'safety').sort(createdDesc)
  if (sorted.length <= limit) {
    return []
  }
  const newest = sorted[0]
  if (!newest) {
    return []
  }
  const deletable = sorted.slice(limit).filter((item) => item.id !== newest.id)
  if (deletable.length === 0) {
    return []
  }
  const keptValid = sorted.filter(
    (item) => item.checksumOk && !deletable.some((doomed) => doomed.id === item.id)
  )
  if (keptValid.length === 0) {
    // 删完就没有任何可恢复的备份了：留下最新的一份校验通过的
    const rescue = deletable.find((item) => item.checksumOk)
    if (rescue) {
      return deletable.filter((item) => item.id !== rescue.id).map((item) => item.id)
    }
  }
  return deletable.map((item) => item.id)
}

/**
 * 两条**任何清理都不许破**的底线（#1005）：
 *  1. **最新的一份校验通过的备份永不删** —— 它可能就是用户此刻唯一能回去的地方，
 *     哪怕它自己被排到了「超出上限」的那一档（时间戳并列 / 时钟倒退 / 上限被改小）；
 *  2. 删完之后必须**至少还剩一份校验通过的备份**。算下来一份都不剩就**一份都别删**
 *     （这里刻意比常规组更保守：常规组会「救回一份」，安全组选择「干脆不动」——
 *     安全备份是恢复失败时的退路，宁可多占一份空间，也不要在退路问题上赌）。
 *
 * 「校验通过」用 `checksumOk`：清单能解析 + 声明的每个文件都在 + 字节数与清单一致。
 */
const guardLastUsable = (items: readonly BackupFacts[], ids: readonly string[]): string[] => {
  if (ids.length === 0) {
    return []
  }
  const planned = new Set(ids)
  const newestUsable = newestFirst(items.filter((item) => item.checksumOk))[0]
  if (newestUsable) {
    planned.delete(newestUsable.id)
  }
  const survivors = items.filter((item) => item.checksumOk && !planned.has(item.id))
  if (survivors.length === 0) {
    return []
  }
  return ids.filter((id) => planned.has(id))
}

/**
 * **安全备份**的清理候选（#1005）：按清单里的时间倒序保留最近 `keep` 份，其余给出去。
 *
 * 与常规组的区别（每一条都是「宁多留」）：
 *  - 只看 `origin === 'safety'` 的项，绝不顺手删常规备份；
 *  - 时间读不出来的项**不参与清理**（判不出新旧就别删）；
 *  - 底线冲突时**一份都不删**，不像常规组那样「救回一份、其余照删」。
 */
export const selectPrunableSafety = (items: readonly BackupFacts[], keep: number): string[] => {
  const limit = Math.max(1, Math.floor(keep))
  const dated = items.filter((item) => item.origin === 'safety' && trustedCreatedAt(item) !== null)
  const candidates = newestFirst(dated).slice(limit)
  return guardLastUsable(
    items,
    candidates.map((item) => item.id)
  )
}

/** 一次清理要删哪些 id（两组分开给：调用方按场景决定动不动常规组）。 */
export type RetentionPlan = { regular: string[]; safety: string[] }

/**
 * 一次完整的保留计划（唯一入口；`backupApi` 只调用这一个函数）。
 *
 * `regular` 与 `safety` 各自算，但两条底线的判定都看**全量**（不只是自己那一组）——
 * 「至少剩一份可用的备份」是整台设备级别的事实，不是分组级别的事实。
 */
export const planRetention = (
  items: readonly BackupFacts[],
  options: { regularKeep: number; safetyKeep: number }
): RetentionPlan => ({
  regular: selectPrunable(items, options.regularKeep),
  safety: selectPrunableSafety(items, options.safetyKeep),
})

/**
 * 下一份备份的体积预估下限（**有历史时**用）：最近一份 × 1.2（余量），再兜一个 8MiB 地板。
 *
 * 下限的**唯一来源**是 `LIMITS.backup.nextEstimateBytes`（#275 的纪律：阈值字面量只许写在
 * `services/limits.ts`）。这里原来有两份来源、数值还对不上 —— 一份是本文的
 * `8 * 1024 * 1024` 字面量，另一份是 `LIMITS` 里没人读的 32 MiB；#993 收敛成一处，
 * 取当时**真正生效**的 8 MiB，行为中性。
 *
 * 数值上它必须仍然等于 `storage.ts` 的 `SMALL_WRITE_BYTES`（#1002 的小负载分级线）：
 * 空间未知时「预估 ≤ 分级线才允许试」这条口径依赖两者相等，
 * `tests/unit/storage-estimate-dirty.test.mjs` 用 `hasRoomForNext(null, MIN_ESTIMATE_BYTES)`
 * 正反两例钉住了这个等式；`limits-config` 的冻结表则钉住了 LIMITS 这一项不许悄悄漂。
 * 「一份历史都没有」的那一档同样走 `LIMITS.backup.nextEstimateBytes`。
 */
export const MIN_ESTIMATE_BYTES = LIMITS.backup.nextEstimateBytes

export const estimateNextBytes = (items: readonly BackupFacts[]): number => {
  const latest = [...items].sort(createdDesc)[0]
  if (!latest || latest.sizeBytes <= 0) {
    return LIMITS.backup.nextEstimateBytes
  }
  return Math.max(MIN_ESTIMATE_BYTES, Math.ceil(latest.sizeBytes * 1.2))
}

/**
 * 空间判据（#1002）：**未知不再一律按「够」处理**。
 *
 * 旧口径「读不到空间就放行」在设备上炸过：`estimate()` 报着漂亮数字、真实只剩 6MB，
 * 20MB 包一路写到底，LevelDB 半条记录 → Chromium 判损坏 → 整库重建，48 个会话没了。
 * 所以现在按负载分级（判据全在 `storage.judgeWriteSpace`，这里只决定「要不要写」）：
 *
 * - 原生 `freeBytes` 可信 → 由它定生死；
 * - 读不到 / 脏值 → 预估 ≤ `MIN_ESTIMATE_BYTES`（8MiB）才允许尝试，超过就**拒绝**（说「读不到空间」，
 *   不说「空间不足」）；
 * - 真失败再按**真实原因**分类（原生 `NO_SPACE` → `space`）；可信的「0 字节」照拦，不吞真话。
 *
 * 需要区分「不够」与「读不到」的调用方用 {@link spaceForWrite} 拿完整结论，
 * 只想知道能不能写的用本函数。
 */
export const hasRoomForNext = (freeBytes: number | null, neededBytes: number): boolean =>
  judgeWriteSpace(neededBytes, { nativeFree: freeBytes }).ok

/** 完整结论（调用方据此选文案：`insufficient` 说空间不足，`unverifiable` 说读不到空间）。 */
export const spaceForWrite = (freeBytes: number | null, neededBytes: number): WriteSpaceVerdict =>
  judgeWriteSpace(neededBytes, { nativeFree: freeBytes })

/**
 * 恢复一份备份要落多少字节（含写放大）：归档 + 附件都要先解出来再写回库，
 * 所以按 `(archive + attachments) × WRITE_AMPLIFICATION_FACTOR` 估。
 *
 * 旧实现在恢复路径上**只**用了「安全备份」那一份的预估（`estimateNextBytes`），
 * 等于把恢复自己要写的那 43MB 附件算成 0 —— 那次事故正是附件写到底。
 */
export const restoreNeedBytes = (manifest: BackupManifest): number => {
  const archive = manifest.archive.sizeBytes
  const attachments = manifest.attachments?.sizeBytes ?? 0
  const kept = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)
  return Math.ceil((kept(archive) + kept(attachments)) * WRITE_AMPLIFICATION_FACTOR)
}

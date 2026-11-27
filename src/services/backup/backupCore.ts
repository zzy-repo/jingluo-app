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
  | 'interrupted'
  | 'unknown'
  | 'empty'
  | 'unsupported'

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
export type BackupFacts = { id: string; createdAtUtc: string; sizeBytes: number; checksumOk: boolean }

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
  return {
    backup_format_version: BACKUP_FORMAT_VERSION,
    id,
    created_at_utc: createdAtUtc,
    archive,
    attachments,
    data_summary: summary,
    verified: value.verified === true,
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
 * 保留策略：按时间倒序保留最新的 `keep` 份，返回**可以删**的 id。
 *
 * 三条硬约束：
 *  1. **最新的一份永不删**（它就是刚写成功的那份，也是恢复前的安全备份）；
 *  2. 删完之后必须**至少还剩一份校验通过的备份** —— 「唯一有效备份」不许被静默删掉；
 *  3. 只返回 id，删不删由调用方在「新备份已写入并校验」之后才执行（顺序不能反）。
 */
export const selectPrunable = (items: readonly BackupFacts[], keep: number): string[] => {
  const limit = Math.max(1, Math.floor(keep))
  const sorted = [...items].sort(createdDesc)
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
 * 下一份备份的体积预估下限（有历史时用）：最近一份 × 1.2（余量），再兜一个 8MB 地板。
 *
 * 「一份历史都没有」的那一档**不走这个数**，走 `LIMITS.backup.nextEstimateBytes`
 * （配置里的保守值，见 `services/limits.ts` 该组注释）——那个阈值原先只写在配置里、
 * 没有任何消费方，`tests/unit/limits-config.test.mjs` 的「每个叶子都被引用」正是用来抓这类
 * 「看起来可配、其实没人读」的漏接（本轮 #993 就是被它抓到的）。
 */
export const MIN_ESTIMATE_BYTES = 8 * 1024 * 1024

export const estimateNextBytes = (items: readonly BackupFacts[]): number => {
  const latest = [...items].sort(createdDesc)[0]
  if (!latest || latest.sizeBytes <= 0) {
    return LIMITS.backup.nextEstimateBytes
  }
  return Math.max(MIN_ESTIMATE_BYTES, Math.ceil(latest.sizeBytes * 1.2))
}

/** 空间是否够写下一份：`null`（未知）按「够」处理，避免因为读不到空间就阻断备份。 */
export const hasRoomForNext = (freeBytes: number | null, neededBytes: number): boolean =>
  freeBytes === null ? true : freeBytes >= neededBytes

/**
 * 原生备份与恢复的**对外契约**（Issue #993 任务 2）。UI 只 import 这一个文件。
 *
 * ```
 * listBackups()  → 备份列表（能不能点恢复看 checksumOk / sessionCount 用于确认页）
 * getStatus()    → 设置页那一行的状态
 * runBackup()    → 手动 / 自动触发
 * restoreBackup()→ 恢复（先自动做一份安全备份，再做原子替换）
 * ```
 *
 * 三条纪律（违反其中任何一条都是「数据看着受保护、其实没有」）：
 *
 * 1. **未完成/未校验的备份不对外宣称受保护**：写入走「临时文件 → 原生侧重读校验 → rename」，
 *    清单文件最后写 —— 列表里出现一条，就意味着它的字节已经在盘上校验过一遍。
 * 2. **失败不破坏已有备份**：临时文件失败只删 `.part`；保留策略只在新备份写入并校验**之后**执行，
 *    且永不删最新的一份、永不删到「一份可恢复的都不剩」。
 * 3. **失败提示匹配真实状态**：抛 {@link BackupError}，`code` 是人话分类，`currentDataIntact`
 *    是**真实判定**（只有确实没动过现有数据才是 true）。原始 message / 路径 / 校验值一律只进诊断日志。
 *
 * 串行化：自动与手动共用同一实现，`runBackup` / `restoreBackup` 都排在同一条 promise 链上 ——
 * 同一时刻只有一次读写在进行，`getStatus().running` 就是这条链的状态。
 */
import {
  BACKUP_FORMAT_VERSION,
  RETENTION_KEEP,
  STATUS_FILE_NAME,
  archiveFileName,
  attachmentsFileName,
  backupIdOf,
  classifyFailure,
  MIN_ESTIMATE_BYTES,
  estimateNextBytes,
  hasRoomForNext,
  manifestFileName,
  manifestToJson,
  parseManifest,
  parseManifestFileName,
  parseStatusFile,
  selectPrunable,
  statusFileToJson,
  type BackupErrorCode,
  type BackupFailureKind,
  type BackupManifest,
  type BackupStatusFile,
} from './backupCore.js'
import {
  BackupStorageUnavailableError,
  availableBytes,
  hashFile,
  isBackupStorageAvailable,
  listFiles,
  readFileBlob,
  readTextFile,
  removeFile,
  writeFileAtomically,
  type NativeFileEntry,
} from './nativeBackupFs.js'
import type { DocumentAttachment } from '../attachments/types.js'

/** 列表里的一条备份：**只有界面需要的四个业务字段 + 会话数**，不含路径与校验值。 */
export type BackupItem = {
  id: string
  createdAtUtc: string
  sizeBytes: number
  /** 这份备份的内容是否与清单一致：false 表示不可恢复（UI 应置灰） */
  checksumOk: boolean
  /** 清单里的数据概况：确认页显示「这份备份里有多少会话」 */
  sessionCount: number
}

export type BackupStatus = {
  enabled: boolean
  running: boolean
  lastSuccessAtUtc: string | null
  /** 失败分类（`space` / `interrupted` / `corrupt` / `empty` / `unsupported` / `unknown`），不是异常原文 */
  lastError: string | null
  totalBytes: number
  count: number
  /** 原生私有目录的可用字节；读不到时为 0（`enoughForNext` 仍按未知处理） */
  freeBytes: number
  enoughForNext: boolean
}

export type Progress = (done: number, total: number, stage: string) => void

export type { BackupErrorCode, BackupFailureKind }

/**
 * 备份 / 恢复失败：带**分类码**与**真实的数据状态**。
 *
 * - `code`：UI 据此选人话（`safety-backup-failed` 表示「保护现有数据这一步没成功，所以没敢动你的数据」）；
 * - `currentDataIntact`：现有数据是否**确实**没被改动过 —— UI 只有在 true 时才能说「原有数据仍然在设备上」；
 * - `stage`：失败发生在哪一步（`preflight` / `export` / `write` / `verify` / `safety` / `read` /
 *   `restore`），只进诊断日志，不进界面。
 */
export class BackupError extends Error {
  readonly code: BackupErrorCode
  readonly currentDataIntact: boolean
  readonly stage: string

  constructor(code: BackupErrorCode, stage: string, currentDataIntact: boolean) {
    super(code)
    this.name = 'BackupError'
    this.code = code
    this.stage = stage
    this.currentDataIntact = currentDataIntact
  }
}

// ---------------------------------------------------------------- 串行化（一个 promise 锁）

let chain: Promise<unknown> = Promise.resolve()
let running = false

/** 自动 / 手动 / 恢复共用一条链：前一次结束（成功或失败）才轮到下一次。 */
const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
  const result = chain.then(async () => {
    running = true
    try {
      return await task()
    } finally {
      running = false
    }
  })
  chain = result.catch(() => {})
  return result
}

// ---------------------------------------------------------------- 诊断日志（原始信息只到这里）

type DiagMeta = Record<string, string | number | boolean>

/**
 * 诊断留痕：**路径 / 校验值 / 原始异常只写这里**，不进契约返回值。
 *
 * 用动态 import：备份列表 / 状态是设置页首屏路径，不该把诊断采集层（连带 idb）拉进静态依赖；
 * 采集层失败也绝不能影响备份本身 —— 所以整体 catch 掉。
 */
const logDiagnostic = (level: 'info' | 'error', message: string, meta: DiagMeta, error?: unknown): void => {
  void import('../diagnostics/collector.js')
    .then((collector) => {
      if (level === 'error') {
        collector.recordError(message, meta, error)
        return
      }
      collector.record('import_stage', 'info', message, meta)
    })
    .catch(() => {})
}

// ---------------------------------------------------------------- 目录 → 备份列表

type ScannedBackup = {
  item: BackupItem
  manifest: BackupManifest | null
  /** 这份备份当前占用的全部文件名（删它的时候一起删） */
  fileNames: string[]
}

const byNameOf = (files: readonly NativeFileEntry[]): Map<string, NativeFileEntry> =>
  new Map(files.map((file) => [file.name, file]))

/**
 * 扫目录得出「有哪些备份、各自能不能恢复」。
 *
 * `checksumOk` 是**便宜的一致性检查**：清单可解析 + 清单声明的每个文件都在 + 字节数与清单一致。
 * 整档摘要（sha256）在恢复前才算 —— 每次列设置页都把整档重读一遍是不可接受的成本。
 */
const scanBackups = async (): Promise<{ backups: ScannedBackup[]; files: NativeFileEntry[] }> => {
  const files = await listFiles()
  const byName = byNameOf(files)
  const backups: ScannedBackup[] = []
  for (const entry of files) {
    const id = parseManifestFileName(entry.name)
    if (!id) {
      continue
    }
    const text = await readTextFile(entry.name).catch(() => null)
    let parsed: unknown = null
    try {
      parsed = text === null ? null : JSON.parse(text)
    } catch {
      parsed = null
    }
    const manifest = parseManifest(parsed)
    const fileNames = [entry.name]
    let sizeBytes = entry.sizeBytes
    let checksumOk = manifest !== null && manifest.verified && manifest.id === id
    for (const ref of [manifest?.archive, manifest?.attachments]) {
      if (!ref) {
        continue
      }
      const found = byName.get(ref.name)
      fileNames.push(ref.name)
      if (!found) {
        checksumOk = false
        continue
      }
      sizeBytes += found.sizeBytes
      if (found.sizeBytes !== ref.sizeBytes) {
        checksumOk = false
      }
    }
    backups.push({
      item: {
        id,
        createdAtUtc: manifest?.created_at_utc ?? new Date(entry.mtimeMs).toISOString(),
        sizeBytes,
        checksumOk,
        sessionCount: manifest?.data_summary.sessions ?? 0,
      },
      manifest,
      fileNames: [...new Set(fileNames)],
    })
  }
  backups.sort((a, b) => Date.parse(b.item.createdAtUtc) - Date.parse(a.item.createdAtUtc))
  return { backups, files }
}

/** 备份列表（最新的在前）。没有原生私有目录（Web）时返回空列表，不抛错。 */
export const listBackups = async (): Promise<BackupItem[]> => {
  if (!isBackupStorageAvailable()) {
    return []
  }
  const { backups } = await scanBackups()
  return backups.map((backup) => backup.item)
}

/** 设置页状态。任何一步读不到都退化成「未知 / 0」，不抛错 —— 状态行不该把设置页拖崩。 */
export const getStatus = async (): Promise<BackupStatus> => {
  const statusFile = await readStatusFile()
  if (!isBackupStorageAvailable()) {
    return {
      enabled: false,
      running,
      lastSuccessAtUtc: statusFile.last_success_at_utc,
      lastError: statusFile.last_error,
      totalBytes: 0,
      count: 0,
      freeBytes: 0,
      enoughForNext: false,
    }
  }
  const [{ backups }, free] = await Promise.all([
    scanBackups().catch(() => ({ backups: [] as ScannedBackup[], files: [] })),
    availableBytes(),
  ])
  const items = backups.map((backup) => backup.item)
  return {
    enabled: true,
    running,
    lastSuccessAtUtc: statusFile.last_success_at_utc,
    lastError: statusFile.last_error,
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    count: items.length,
    freeBytes: free ?? 0,
    enoughForNext: hasRoomForNext(free, estimateNextBytes(items)),
  }
}

/**
 * 状态的内存镜像：`status.json` 写不进去时（例如磁盘满，写状态本身也会失败）依然能报告
 * 「上次失败是哪一类」—— 失败提示不该因为盘满而变成「一切正常」。
 */
let memoryStatus: BackupStatusFile = { last_success_at_utc: null, last_error: null }

const readStatusFile = async (): Promise<BackupStatusFile> => {
  if (!isBackupStorageAvailable()) {
    return parseStatusFile(null)
  }
  const text = await readTextFile(STATUS_FILE_NAME).catch(() => null)
  const parsed = parseStatusFile(text)
  return {
    last_success_at_utc: parsed.last_success_at_utc ?? memoryStatus.last_success_at_utc,
    last_error: parsed.last_error ?? memoryStatus.last_error,
  }
}

/** 写状态文件（小文件，一次块就够）；失败只留痕 —— 状态是观察数据，不该把备份判负。 */
const writeStatusFile = async (status: BackupStatusFile): Promise<void> => {
  memoryStatus = status
  try {
    await replaceFileAtomically(STATUS_FILE_NAME, statusFileToJson(status))
  } catch (error) {
    logDiagnostic('error', 'backup: status write failed', { action: 'backup-status' }, error)
  }
}

/**
 * 状态文件是**唯一允许覆盖**的文件：它是可变状态而不是备份（备份文件一律不覆盖，见原生插件）。
 * 覆盖方式仍然是「临时文件 → 校验 → rename」：先删旧名再写，半截状态不会被读到。
 */
const replaceFileAtomically = async (name: string, text: string): Promise<void> => {
  await removeFile(name).catch(() => {})
  await writeFileAtomically({ name, blob: new Blob([text], { type: 'application/json' }) })
}

// ---------------------------------------------------------------- 备份

/** 打包结果：归档本体 + 附件原件包 + 清单要写的数据概况。 */
type Payload = {
  archive: Blob
  sessions: number
  attachments: Blob | null
  attachmentCount: number
}

/**
 * 生成备份内容：**复用历史导出的 ZIP**（`exportHistory` → `exportArchive`），
 * 因此产物仍是本 App 可导入的那套格式（会话 JSON + 图片原件 + 附件元数据）。
 *
 * 文档附件的**原件**不在历史导出格式里，所以单独打一个 `attachments.zip`（见 `packAttachments`）——
 * 不改编排归档格式，也就不会影响「导出 → 导入」这条既有链路。
 */
const buildPayload = async (onProgress?: Progress): Promise<Payload> => {
  const { exportHistory } = await import('../chat/backup.js')
  const exported = await exportHistory({
    onProgress: ({ exported: done, total }) => onProgress?.(done, total, 'export'),
  })
  const packed = await packAttachments(onProgress)
  return {
    archive: exported.blob,
    sessions: exported.sessions,
    attachments: packed?.blob ?? null,
    attachmentCount: packed?.count ?? 0,
  }
}

/**
 * 附件原件包：`attachments.json`（`attachments` 表的元数据行）+ 每份原件的 `<blobKey>.bin`。
 *
 * 只打**原件还在**的那些附件（原件可能已被外部清理）；`attachmentTexts`（解析全文）是派生数据，
 * 恢复后按需重新解析，不进包。
 */
const packAttachments = async (
  onProgress?: Progress
): Promise<{ blob: Blob; count: number } | null> => {
  const store = await import('../attachments/store.js')
  const rows = await store.listAttachments()
  if (rows.length === 0) {
    return null
  }
  const entries: { name: string; blob: Blob }[] = [
    {
      name: 'attachments.json',
      blob: new Blob([JSON.stringify(rows)], { type: 'application/json' }),
    },
  ]
  let count = 0
  for (const [index, row] of rows.entries()) {
    const blob = await store.readAttachmentBlob(row.localPath).catch(() => undefined)
    if (blob) {
      entries.push({ name: `${row.localPath}.bin`, blob })
      count += 1
    }
    onProgress?.(index + 1, rows.length, 'attachments')
  }
  const { writeArchive } = await import('../chat/history/zipWriter.js')
  return { blob: await writeArchive(entries), count }
}

/** 目标 id 已被占用时（同一毫秒内的第二次备份）往后挪 1ms，直到空出来。 */
const uniqueBackupId = (taken: ReadonlySet<string>, now: Date): string => {
  let candidate = now
  for (;;) {
    const id = backupIdOf(candidate)
    if (!taken.has(id)) {
      return id
    }
    candidate = new Date(candidate.getTime() + 1)
  }
}

type BackupOptions = {
  /** 是否执行保留清理（恢复前那份安全备份**不清理**任何旧份，见 `restoreBackup`） */
  prune: boolean
}

const writeBackupFiles = async (
  id: string,
  payload: Payload,
  onProgress?: Progress
): Promise<BackupManifest> => {
  const createdAt = new Date()
  const archive = await writeFileAtomically({
    name: archiveFileName(id),
    blob: payload.archive,
    onProgress: (done, total, stage) => onProgress?.(done, total, stage),
  })
  let attachmentRef: BackupManifest['attachments'] = null
  if (payload.attachments) {
    const written = await writeFileAtomically({
      name: attachmentsFileName(id),
      blob: payload.attachments,
      onProgress: (done, total) => onProgress?.(done, total, 'attachments-write'),
    })
    attachmentRef = { name: written.name, sizeBytes: written.sizeBytes, sha256: written.sha256 }
  }
  const manifest: BackupManifest = {
    backup_format_version: BACKUP_FORMAT_VERSION,
    id,
    created_at_utc: createdAt.toISOString(),
    archive: { name: archive.name, sizeBytes: archive.sizeBytes, sha256: archive.sha256 },
    attachments: attachmentRef,
    data_summary: { sessions: payload.sessions, attachments: payload.attachmentCount },
    verified: true,
  }
  // 清单**最后写**：它的存在 = 「这份备份完整」的提交标记
  onProgress?.(1, 1, 'verify')
  await writeFileAtomically({
    name: manifestFileName(id),
    blob: new Blob([manifestToJson(manifest)], { type: 'application/json' }),
  })
  return manifest
}

/** 写完后按保留策略清理旧份（只在新备份写入并校验成功之后才会走到这里）。 */
const pruneOldBackups = async (): Promise<void> => {
  const { backups } = await scanBackups()
  const doomed = selectPrunable(
    backups.map((backup) => backup.item),
    RETENTION_KEEP
  )
  if (doomed.length === 0) {
    return
  }
  for (const id of doomed) {
    const target = backups.find((backup) => backup.item.id === id)
    if (!target) {
      continue
    }
    for (const name of target.fileNames) {
      await removeFile(name).catch((error: unknown) => {
        logDiagnostic('error', 'backup: prune failed', { action: 'backup-prune' }, error)
      })
    }
    logDiagnostic('info', 'backup: pruned old backup', { action: 'backup-prune' })
  }
}

const backupFailure = (error: unknown, stage: string): BackupError => {
  const currentDataIntact = true
  const kind = classifyFailure(error)
  if (error instanceof BackupError) {
    return error
  }
  return new BackupError(kind === 'unknown' ? 'unknown' : (kind as BackupErrorCode), stage, currentDataIntact)
}

/**
 * 一次备份（内部实现）：预检空间 → 打包 → 原子写归档 / 附件 → 清单 → 清理旧份 → 记状态。
 *
 * `trigger` 只影响诊断日志里的字段（自动 / 手动 / 恢复前的安全备份共用这一份实现）。
 */
const runBackupOnce = async (
  trigger: 'auto' | 'manual' | 'safety',
  onProgress: Progress | undefined,
  options: BackupOptions
): Promise<BackupItem> => {
  if (!isBackupStorageAvailable()) {
    throw new BackupError('unsupported', 'preflight', true)
  }
  const { backups } = await scanBackups()
  const existing = backups.map((backup) => backup.item)
  const free = await availableBytes()
  if (!hasRoomForNext(free, estimateNextBytes(existing))) {
    logDiagnostic('error', 'backup: not enough space', {
      action: 'backup-preflight',
      trigger,
      freeBytes: free ?? -1,
    })
    await writeStatusFile({ ...(await readStatusFile()), last_error: 'space' })
    throw new BackupError('space', 'preflight', true)
  }
  onProgress?.(0, 1, 'export')
  const payload = await buildPayload(onProgress)
  if (payload.sessions === 0) {
    // 异常空库保护：空库的「备份」保护不了任何东西；更不能让它挤掉历史有效备份
    logDiagnostic('error', 'backup: empty library, refused', {
      action: 'backup-snapshot',
      trigger,
      sessions: 0,
      existingCount: existing.length,
    })
    await writeStatusFile({ ...(await readStatusFile()), last_error: 'empty' })
    throw new BackupError('empty', 'export', true)
  }
  const taken = new Set(existing.map((item) => item.id))
  const id = uniqueBackupId(taken, new Date())
  try {
    const manifest = await writeBackupFiles(id, payload, onProgress)
    logDiagnostic('info', 'backup: written', {
      action: 'backup-write',
      trigger,
      sessions: payload.sessions,
      sizeBytes: manifest.archive.sizeBytes,
    })
    if (options.prune) {
      onProgress?.(1, 1, 'cleanup')
      await pruneOldBackups()
    }
    await writeStatusFile({ last_success_at_utc: manifest.created_at_utc, last_error: null })
    return {
      id,
      createdAtUtc: manifest.created_at_utc,
      sizeBytes: manifest.archive.sizeBytes + (manifest.attachments?.sizeBytes ?? 0),
      checksumOk: true,
      sessionCount: manifest.data_summary.sessions,
    }
  } catch (error) {
    // 失败：只清掉本次这个 id 可能已经落盘的文件（没有清单，本来也不是可恢复项），
    // **绝不碰其它 id** —— 上一份有效备份一个字节都不动。
    for (const name of [archiveFileName(id), attachmentsFileName(id), manifestFileName(id)]) {
      await removeFile(name).catch(() => {})
    }
    let failure = backupFailure(error, 'write')
    if (failure.code === 'interrupted') {
      // 写块失败可能是磁盘满：空间已经见底就按 `space` 报，UI 才好给「清点空间」的提示
      const free = await availableBytes()
      if (free !== null && !hasRoomForNext(free, MIN_ESTIMATE_BYTES)) {
        failure = new BackupError('space', 'write', true)
      }
    }
    logDiagnostic('error', 'backup: failed', { action: 'backup-write', trigger }, error)
    await writeStatusFile({ ...(await readStatusFile()), last_error: failure.code })
    throw failure
  }
}

/** 手动 / 自动备份（共用实现，串行执行）。 */
export const runBackup = (trigger: 'auto' | 'manual', onProgress?: Progress): Promise<BackupItem> =>
  runExclusive(() => runBackupOnce(trigger, onProgress, { prune: true }))

// ---------------------------------------------------------------- 恢复

/** 校验一份备份：清单声明的每个文件都在、字节数一致、整档 sha256 与清单一致。 */
const verifyBackup = async (manifest: BackupManifest): Promise<void> => {
  for (const ref of [manifest.archive, manifest.attachments]) {
    if (!ref) {
      continue
    }
    const actual = await hashFile(ref.name).catch(() => {
      throw new BackupError('corrupt', 'verify', true)
    })
    if (actual.sizeBytes !== ref.sizeBytes || actual.sha256 !== ref.sha256) {
      throw new BackupError('corrupt', 'verify', true)
    }
  }
}

/** 把 `<id>.attachments.zip` 里的原件与元数据写回库（尽力而为：失败只留痕）。 */
const restoreAttachments = async (blob: Blob, name: string): Promise<void> => {
  const [{ readArchive, readEntry }, store, db] = await Promise.all([
    import('../chat/history/zipReader.js'),
    import('../attachments/store.js'),
    import('../chat/db.js'),
  ])
  const file = new File([blob], name, { type: 'application/zip' })
  const blobs: { id: string; blob: Blob }[] = []
  let rows: DocumentAttachment[] = []
  for await (const entry of readArchive(file)) {
    if (entry.path === 'attachments.json') {
      const parsed: unknown = JSON.parse(await (await readEntry(entry)).text())
      if (Array.isArray(parsed)) {
        rows = parsed as DocumentAttachment[]
      }
      continue
    }
    if (entry.path.endsWith('.bin')) {
      blobs.push({ id: entry.path.slice(0, -'.bin'.length), blob: await readEntry(entry) })
    }
  }
  if (blobs.length > 0) {
    await db.saveFiles(blobs)
  }
  for (const row of rows) {
    await store.putAttachment(row)
  }
}

/**
 * 恢复一份备份。
 *
 * 顺序（**不能颠倒**）：
 *  1. `verify` —— 先把目标备份校验一遍（决定它配不配被用来覆盖本机数据）；
 *  2. `safety` —— 给**当前数据**做一份安全备份（与普通备份同一实现、同一原子写入与校验流程），
 *     再做一次整档校验；**这一步失败就以 `safety-backup-failed` 中止，一个字节都不动现有数据**；
 *  3. `read` —— 把归档读回来（分块，边读边让出事件循环）；
 *  4. `attachments` —— 附件原件与元数据写回（尽力而为，失败只留痕，不影响会话恢复）；
 *  5. `restore` —— 走既有导入链路（暂存 + 一次性提交），失败时正式数据不变。
 */
export const restoreBackup = (id: string, onProgress?: Progress): Promise<void> =>
  runExclusive(async () => {
    if (!isBackupStorageAvailable()) {
      throw new BackupError('unsupported', 'verify', true)
    }
    const { backups } = await scanBackups()
    const target = backups.find((backup) => backup.item.id === id)
    if (!target || !target.manifest) {
      logDiagnostic('error', 'restore: backup not found or manifest unreadable', {
        action: 'backup-restore',
      })
      throw new BackupError('corrupt', 'verify', true)
    }
    const manifest = target.manifest
    onProgress?.(0, 1, 'verify')
    await verifyBackup(manifest)

    // ① 先保护现有数据：安全备份失败 ⇒ 立即中止，不动任何现有数据
    onProgress?.(0, 1, 'safety')
    let safety: BackupItem
    try {
      safety = await runBackupOnce('safety', onProgress, { prune: false })
    } catch (error) {
      logDiagnostic('error', 'restore: safety backup failed', { action: 'backup-restore' }, error)
      throw new BackupError('safety-backup-failed', 'safety', true)
    }
    const safetyFiles = await scanBackups()
    const safetyEntry = safetyFiles.backups.find((backup) => backup.item.id === safety.id)
    if (!safetyEntry?.manifest) {
      logDiagnostic('error', 'restore: safety backup missing after write', { action: 'backup-restore' })
      throw new BackupError('safety-backup-failed', 'safety', true)
    }
    await verifyBackup(safetyEntry.manifest).catch((error: unknown) => {
      logDiagnostic('error', 'restore: safety backup verify failed', { action: 'backup-restore' }, error)
      throw new BackupError('safety-backup-failed', 'safety', true)
    })

    // ② 读回归档（分块）
    onProgress?.(0, manifest.archive.sizeBytes, 'read')
    const archive = await readFileBlob({
      name: manifest.archive.name,
      sizeBytes: manifest.archive.sizeBytes,
      onProgress: (done, total, stage) => onProgress?.(done, total, stage),
    })

    // ③ 附件原件（尽力而为）
    if (manifest.attachments) {
      try {
        const packed = await readFileBlob({
          name: manifest.attachments.name,
          sizeBytes: manifest.attachments.sizeBytes,
          onProgress: (done, total, stage) => onProgress?.(done, total, stage),
        })
        await restoreAttachments(packed, manifest.attachments.name)
        logDiagnostic('info', 'restore: attachments restored', { action: 'backup-restore' })
      } catch (error) {
        logDiagnostic('error', 'restore: attachments failed (sessions still restored)', {
          action: 'backup-restore',
        }, error)
      }
    }

    // ④ 会话数据：走既有导入链路（暂存 + 一次性提交），失败时正式数据不变
    const { importHistory } = await import('../chat/backup.js')
    const file = new File([archive], manifest.archive.name, { type: 'application/zip' })
    try {
      await importHistory(file, {
        mode: 'overwrite',
        onProgress: ({ sessions, totalSessions }) =>
          onProgress?.(sessions, totalSessions ?? manifest.data_summary.sessions, 'restore'),
      })
    } catch (error) {
      const failure = backupFailure(error, 'restore')
      logDiagnostic('error', 'restore: import failed', { action: 'backup-restore' }, error)
      throw new BackupError(failure.code, 'restore', true)
    }
    await writeStatusFile({ last_success_at_utc: new Date().toISOString(), last_error: null })
    onProgress?.(1, 1, 'done')
  })

export const isBackupSupported = (): boolean => isBackupStorageAvailable()

/** 原生不可用时的错误类型（`code === 'UNSUPPORTED'`）。 */
export { BackupStorageUnavailableError }

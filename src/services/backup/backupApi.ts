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
  estimateNextBytes,
  hasRoomForNext,
  manifestFileName,
  manifestToJson,
  MIN_ESTIMATE_BYTES,
  parseManifest,
  parseManifestFileName,
  parseStatusFile,
  planRetention,
  restoreNeedBytes,
  spaceForWrite,
  statusFileToJson,
  type BackupErrorCode,
  type BackupFailureKind,
  type BackupManifest,
  type BackupOrigin,
  type BackupStatusFile,
} from './backupCore.js'
import { SAFETY_RETENTION_KEEP } from './limits.js'
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
import type { StoredAttachmentText } from '../chat/db.js'

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
  /** 原生私有目录的可用字节；读不到时为 0（真值 `null` 已由 `enoughForNext` 的分级吃掉） */
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
/**
 * 历史遗留的「过时结论」：`empty`（上一轮空库拒绝）和空串（脏数据）都不是当前状态。
 * 留着它们会让状态行播报一件早就不是事实的事（设备实测：用户后来写了对话，仍显示
 * 「当前没有可备份的聊天记录」）。
 *
 * `space` 也是过时结论，但它的时效要靠**当前实际空间**复核：`status.json` 只记「那一刻
 * 盘不够」，用户把盘清干净之后这句话就不再成立（设备实测：腾出空间后状态行仍显示
 * 「存储空间不足，暂时无法备份」，直到下一次备份成功才消失）。所以 `space` 只在
 * `enoughForNext === false`（现在仍然不够）时才作为当前状态播报 —— 盘真的不够时照报，
 * 不吞真话。
 */
const isStaleErrorCode = (code: string | null, enoughForNext: boolean): boolean =>
  code === 'empty' || code === '' || (code === 'space' && enoughForNext)

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
  const enoughForNext = hasRoomForNext(free, estimateNextBytes(items))
  return {
    enabled: true,
    running,
    lastSuccessAtUtc: statusFile.last_success_at_utc,
    // `empty` 不是错误，是「当时没有记录可备」这个**过时**的历史结论。把它当当前状态播报，
    // 会在用户后来已经写了对话时仍然显示「当前没有可备份的聊天记录」（实测踩到）。
    // 真正按「空」处理的地方是用户按「立即备份」时抛出的 `empty`，界面在那一刻才说这句话。
    // `space` 同理：拿「现在的空间」复核，够用了就不再播报（盘上 `status.json` 不改写 ——
    // 那次失败确实发生过，归零只发生在播报层）。
    lastError: isStaleErrorCode(statusFile.last_error, enoughForNext) ? null : statusFile.last_error,
    totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
    count: items.length,
    freeBytes: free ?? 0,
    enoughForNext,
  }
}

/**
 * 状态的内存镜像：`status.json` 写不进去时（例如磁盘满，写状态本身也会失败）依然能报告
 * 「上次失败是哪一类」—— 失败提示不该因为盘满而变成「一切正常」。
 */
let memoryStatus: BackupStatusFile = {
  last_success_at_utc: null,
  last_restore_at_utc: null,
  last_error: null,
}

const readStatusFile = async (): Promise<BackupStatusFile> => {
  if (!isBackupStorageAvailable()) {
    return parseStatusFile(null)
  }
  const text = await readTextFile(STATUS_FILE_NAME).catch(() => null)
  const parsed = parseStatusFile(text)
  return {
    last_success_at_utc: parsed.last_success_at_utc ?? memoryStatus.last_success_at_utc,
    last_restore_at_utc: parsed.last_restore_at_utc ?? memoryStatus.last_restore_at_utc,
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
 *
 * 覆盖方式仍然是「临时文件 → 校验 → rename」：**不预删旧文件**，靠 `rename(2)` 原子替换 ——
 * 旧状态在 rename 成功前一秒都还在盘上。历史上的写法是「先 `removeFile` 再写」，一旦写入在
 * 中间失败（磁盘满 / 校验不符），状态文件就整份消失，剩下一台「什么都不知道」的机器。
 */
const replaceFileAtomically = async (name: string, text: string): Promise<void> => {
  await writeFileAtomically({
    name,
    blob: new Blob([text], { type: 'application/json' }),
    // 只有状态文件走白名单覆盖；别的名字在原生侧仍会被 TARGET_EXISTS 拒掉
    allowOverwrite: name === STATUS_FILE_NAME,
  })
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
  // 原件是**内容寻址**的（`attachment-<sha256>`）：同一个文件被添加两次就是两条元数据、同一个
  // `localPath`。按 `localPath` 去重，否则归档里会出现同名的两个条目，`writeArchive` 直接以
  // 「Invalid history archive entry」拒绝整次备份（设备实测：同一份 docx 加两次后备份全挂）。
  const packed = new Set<string>()
  for (const [index, row] of rows.entries()) {
    if (!packed.has(row.localPath)) {
      const blob = await store.readAttachmentBlob(row.localPath).catch(() => undefined)
      if (blob) {
        entries.push({ name: `${row.localPath}.bin`, blob })
        packed.add(row.localPath)
        count += 1
      }
    }
    onProgress?.(index + 1, rows.length, 'attachments')
  }
  // 解析全文是**派生缓存**，但 `manager.getText()` 只读缓存、**不会重解析**（见其实现），
  // 所以不带走它，恢复后文档原件虽然在、正文却再也读不到 —— 模型那边等于没有这份文档。
  // 它是内容寻址的幂等记录（`sha256:parserVersion`），一起打包不会让包变大太多。
  const texts: StoredAttachmentText[] = []
  const seenText = new Set<string>()
  for (const row of rows) {
    const record = await store.readAttachmentTextRecord(row.parsedTextPath)
    if (record && !seenText.has(record.key)) {
      seenText.add(record.key)
      texts.push(record)
    }
  }
  if (texts.length > 0) {
    entries.push({
      name: 'texts.json',
      blob: new Blob([JSON.stringify(texts)], { type: 'application/json' }),
    })
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
  origin: BackupOrigin,
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
    // 来源标记落进清单（#1005）：扫目录时能重新认出「哪几份是恢复前的安全备份」，
    // 不依赖写下它们的那次调用还记不记得
    origin,
  }
  // 清单**最后写**：它的存在 = 「这份备份完整」的提交标记
  onProgress?.(1, 1, 'verify')
  await writeFileAtomically({
    name: manifestFileName(id),
    blob: new Blob([manifestToJson(manifest)], { type: 'application/json' }),
  })
  return manifest
}

/**
 * 保留清理（#1005）。**永不抛错**。
 *
 * 为什么必须吞掉异常：清理是**收尾动作**。旧实现在 `runBackupOnce` 的 try 里 `await` 它，
 * 一旦清理（扫描 / 删除）抛错就掉进失败分支，而那条分支会把**刚写好并校验通过的那份备份**
 * 连同清单一起删掉 —— 用户看到的是「备份失败」，实际是「备份成功后被清理逻辑自己删了」。
 *
 * `scope`：
 *  - `all`    —— 常规备份成功之后，以及**恢复成功之后**（#1006）：常规组按 `RETENTION_KEEP`、
 *               安全组按 `SAFETY_RETENTION_KEEP`。恢复也必须走这一档：老清单没有 `origin` 字段、
 *               一律按常规备份处理，只清安全组的话「恢复完」的总量收不到 3+2（设备实测 5 → 6 → 7）；
 *  - `safety` —— 恢复流程**前半段**：新安全备份刚写完并整档校验通过、还没开始恢复时先压安全组上限。
 *               **只动安全组**：这条路上还什么都没恢复，绝不能顺手删常规备份（可能是这次的恢复目标）。
 *
 * 每个文件名**最多删一次**（去重 + 每份备份只留一条失败记录）：删不掉的文件不该在一次清理里
 * 被反复尝试，也不该把诊断日志刷成一串同样的异常。
 *
 * `exemptIds`（#1006）：**这次操作必须留住的那几份**（恢复路径 = 用户选中的那份备份）。
 * 恢复流程的两个清理触发点**都必须传**：① 前半段的 `safety` 一档在 ② 读归档**之前**跑，
 * 不传豁免就可能「用户点了恢复 X、代码在读 X 之前把 X 删了」；② 末尾的 `all` 一档同理
 * （用户要回到的就是那份）。有没有第三个触发点？加一处就传一次 —— 唯一入口
 * `planRetention` 的签名把 `exemptIds` 放在必读位置，忘了传时读起来就是「这里允许删掉恢复目标」。
 */
const applyRetention = async (scope: 'all' | 'safety', exemptIds?: readonly string[]): Promise<void> => {
  let backups: ScannedBackup[]
  try {
    backups = (await scanBackups()).backups
  } catch (error) {
    logDiagnostic('error', 'backup: prune scan failed', { action: 'backup-prune', scope }, error)
    return
  }
  const byId = new Map(backups.map((backup) => [backup.item.id, backup]))
  const facts = backups.map((backup) => ({
    id: backup.item.id,
    createdAtUtc: backup.item.createdAtUtc,
    sizeBytes: backup.item.sizeBytes,
    checksumOk: backup.item.checksumOk,
    // 清单里的来源标记：读不到清单时按常规备份对待（见 `BackupOrigin` 的注释）
    origin: backup.manifest?.origin,
  }))
  const plan = planRetention(facts, {
    regularKeep: RETENTION_KEEP,
    safetyKeep: SAFETY_RETENTION_KEEP,
    ...(exemptIds === undefined ? {} : { exemptIds }),
  })
  const exempt = new Set(exemptIds ?? [])
  const ids = new Set(
    (scope === 'all' ? [...plan.regular, ...plan.safety] : plan.safety).filter((id) => !exempt.has(id))
  )
  const attempted = new Set<string>()
  for (const id of ids) {
    const target = byId.get(id)
    if (!target) {
      continue
    }
    let failed = 0
    let firstError: unknown = null
    for (const name of target.fileNames) {
      if (attempted.has(name)) {
        continue
      }
      attempted.add(name)
      const error = await removeFile(name).then(
        () => null,
        (cause: unknown) => cause
      )
      if (error !== null) {
        failed += 1
        firstError ??= error
      }
    }
    if (failed === 0) {
      logDiagnostic('info', 'backup: pruned old backup', {
        action: 'backup-prune',
        scope,
        origin: target.manifest?.origin ?? 'unknown',
      })
      continue
    }
    logDiagnostic(
      'error',
      'backup: prune failed',
      { action: 'backup-prune', scope, failedFiles: failed },
      firstError
    )
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
 * 预检 / 打包阶段的失败收口（写第一份文件之前的任何异常）。
 *
 * 这两步原先**完全裸奔**：异常原样抛给 UI，既没有 `code` 也没有 `stage`，`failureOf()` 只能归成
 * `unknown`，界面于是播报「暂时读不到备份情况」—— 它想说的其实是「这次备份失败、原因分不出来」。
 * 更要命的是此时 `status.json` 一个字节都不写、诊断日志里也没有一条，点完「立即备份」什么痕迹都不留。
 *
 * 归到 `interrupted` 是真的：这一阶段一份备份文件都没写，已有备份逐字节未变。
 */
const preflightFailure = (error: unknown, trigger: string, step: string): BackupError => {
  logDiagnostic('error', `backup: ${step} failed`, { action: 'backup-preflight', trigger }, error)
  const kind = classifyFailure(error)
  return new BackupError(kind === 'unknown' ? 'interrupted' : (kind as BackupErrorCode), step, true)
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
  const { backups } = await scanBackups().catch(async (error: unknown) => {
    const failure = preflightFailure(error, trigger, 'scan')
    await writeStatusFile({ ...(await readStatusFile()), last_error: failure.code })
    throw failure
  })
  const existing = backups.map((backup) => backup.item)
  const free = await availableBytes()
  const needed = estimateNextBytes(existing)
  // 判据见 `backupCore.hasRoomForNext` / `storage.judgeWriteSpace`：原生 `freeBytes` 是唯一可信来源，
  // 读不到时**按负载分级**（小负载放行、大负载拒绝），拒绝也要分「空间不足」与「读不到空间」两档文案。
  const gate = spaceForWrite(free, needed)
  if (!gate.ok) {
    logDiagnostic('error', 'backup: space check failed', {
      action: 'backup-preflight',
      trigger,
      freeBytes: free ?? -1,
      needBytes: needed,
      verdict: gate.reason,
    })
    const code = gate.reason === 'insufficient' ? 'space' : 'space-unverifiable'
    await writeStatusFile({ ...(await readStatusFile()), last_error: code })
    throw new BackupError(code, 'preflight', true)
  }
  onProgress?.(0, 1, 'export')
  const payload = await buildPayload(onProgress).catch(async (error: unknown) => {
    const failure = preflightFailure(error, trigger, 'export')
    await writeStatusFile({ ...(await readStatusFile()), last_error: failure.code })
    throw failure
  })
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
    const manifest = await writeBackupFiles(id, payload, trigger, onProgress)
    logDiagnostic('info', 'backup: written', {
      action: 'backup-write',
      trigger,
      sessions: payload.sessions,
      sizeBytes: manifest.archive.sizeBytes,
    })
    if (options.prune) {
      onProgress?.(1, 1, 'cleanup')
      // 常规备份成功后的清理只在这里发生（恢复成功后的总量收口见 `restoreBackup` 的 ⑤）：
      // **新备份已经落盘且清单已写**（= 提交标记）之后。
      // `applyRetention` 自己吞异常，删不掉旧份也绝不把这次成功改判成失败。
      await applyRetention('all')
    }
    await writeStatusFile({
      ...(await readStatusFile()),
      last_success_at_utc: manifest.created_at_utc,
      last_error: null,
    })
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

/** 把 `<id>.attachments.zip` 里的原件与元数据写回库；返回实际写回的原件数。 */
const restoreAttachments = async (blob: Blob, name: string): Promise<number> => {
  const [{ readArchive, readEntry }, store, db] = await Promise.all([
    import('../chat/history/zipReader.js'),
    import('../attachments/store.js'),
    import('../chat/db.js'),
  ])
  const file = new File([blob], name, { type: 'application/zip' })
  const blobs: { id: string; blob: Blob }[] = []
  let rows: DocumentAttachment[] = []
  let texts: StoredAttachmentText[] = []
  for await (const entry of readArchive(file)) {
    if (entry.path === 'attachments.json') {
      const parsed: unknown = JSON.parse(await (await readEntry(entry)).text())
      if (Array.isArray(parsed)) {
        rows = parsed as DocumentAttachment[]
      }
      continue
    }
    // 老备份没有 texts.json：恢复原件与元数据即可，正文缺失与「解析缓存被清」等价
    if (entry.path === 'texts.json') {
      const parsed: unknown = JSON.parse(await (await readEntry(entry)).text())
      if (Array.isArray(parsed)) {
        texts = parsed as StoredAttachmentText[]
      }
      continue
    }
    if (entry.path.endsWith('.bin')) {
      blobs.push({ id: entry.path.slice(0, -'.bin'.length), blob: await readEntry(entry) })
    }
  }
  // 归档里的 blob 不带 MIME（zip 条目不存类型），这里按元数据里的 mimeType 补回去，
  // 否则恢复出来的原件是 `type: ''`，缩略图 / 打开查看会按未知类型处理
  const mimeOf = new Map(rows.map((row) => [row.localPath, row.mimeType]))
  if (blobs.length > 0) {
    await db.saveFiles(
      blobs.map(({ id, blob: raw }) => {
        const type = mimeOf.get(id)
        return { id, blob: type ? new Blob([raw], { type }) : raw }
      })
    )
  }
  for (const row of rows) {
    await store.putAttachment(row)
  }
  for (const record of texts) {
    await store.writeAttachmentTextRecord({
      sha256: record.sha256,
      parserVersion: record.parserVersion,
      text: record.text,
      characterCount: record.characterCount,
      status: record.status,
      totalPages: record.totalPages,
      extractedPages: record.extractedPages,
      warnings: record.warnings,
    })
  }
  return blobs.length
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
export type RestoreResult = {
  /** 附件（图片 / 文档原件）是否真的写回来了；false 时 UI 必须提示「会话回来了、附件没回来」 */
  attachmentsRestored: boolean
  /** 这份备份里应有的附件件数（来自清单 `data_summary.attachments`） */
  attachmentCount: number
}

export const restoreBackup = (id: string, onProgress?: Progress): Promise<RestoreResult> =>
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

    // ①' 空间判据（#1002 第二轮）：恢复自己也要落盘 —— 归档解出来 + 附件写回库，
    //     按 `restoreNeedBytes`（含写放大 2×）判，**不能**只依赖下面「安全备份」那一份的预估：
    //     设备事故里正是安全备份过了，恢复要写的 43MB 附件把盘写到底 → LevelDB 半条记录 → 整库重建。
    //     判据与导入同一条线（`storage.judgeWriteSpace`）：原生 `freeBytes` 可信就用它，
    //     读不到时小负载放行、大负载拒绝，并且「读不到空间」与「空间不足」是两档文案。
    const needForRestore = restoreNeedBytes(manifest)
    const freeForRestore = await availableBytes()
    const restoreGate = spaceForWrite(freeForRestore, needForRestore)
    if (!restoreGate.ok) {
      logDiagnostic('error', 'restore: space check failed', {
        action: 'backup-restore',
        needBytes: needForRestore,
        freeBytes: freeForRestore ?? -1,
        verdict: restoreGate.reason,
      })
      // 还什么都没动（校验只读），所以 currentDataIntact = true
      throw new BackupError(
        restoreGate.reason === 'insufficient' ? 'space' : 'space-unverifiable',
        'preflight',
        true
      )
    }

    // ① 先保护现有数据：安全备份失败 ⇒ 立即中止，不动任何现有数据
    onProgress?.(0, 1, 'safety')
    //    ⚠️ 「本机没有任何记录」不算安全备份失败：丢库、新装、被清空时正是**最需要恢复**的场景，
    //    那时没有数据可保护，硬按「安全备份失败」中止会让恢复功能在最该工作的时候拒绝工作
    //    （设备实测：IndexedDB 被清空后点恢复，只得到「为了不影响当前数据，本次恢复没有开始」，
    //    数据仍然是 0）。反过来，真有数据却备份不出来，仍然一律中止。
    let safety: BackupItem | null = null
    try {
      safety = await runBackupOnce('safety', onProgress, { prune: false })
    } catch (error) {
      if (backupFailure(error, 'backup').code === 'empty') {
        logDiagnostic('info', 'restore: nothing to protect, skip safety backup', {
          action: 'backup-restore',
        })
      } else {
        logDiagnostic('error', 'restore: safety backup failed', { action: 'backup-restore' }, error)
        throw new BackupError('safety-backup-failed', 'safety', true)
      }
    }
    if (safety !== null) {
      const safetyFiles = await scanBackups()
      const safetyEntry = safetyFiles.backups.find((backup) => backup.item.id === safety?.id)
      if (!safetyEntry?.manifest) {
        logDiagnostic('error', 'restore: safety backup missing after write', { action: 'backup-restore' })
        throw new BackupError('safety-backup-failed', 'safety', true)
      }
      await verifyBackup(safetyEntry.manifest).catch((error: unknown) => {
        logDiagnostic('error', 'restore: safety backup verify failed', { action: 'backup-restore' }, error)
        throw new BackupError('safety-backup-failed', 'safety', true)
      })
      // #1005：安全备份的容量上限。**必须放在这里**——新安全备份已经落盘、已经整档校验通过，
      // 这时才允许清掉更早的安全备份（先删后写会让「这次恢复中途失败」变成无路可退）。
      // 只动安全组：恢复不该顺手把用户的常规备份删掉（能少删就少删）。
      // #1006：`id` = **用户这次选中的那份备份**，必须豁免 —— 它可能正好是最老的安全备份，
      // 而它的归档要到 ② 才读：不豁免就会出现「点了恢复 X，程序在读 X 之前把 X 删了」。
      await applyRetention('safety', [id])
    }

    // ② 读回归档（分块）
    onProgress?.(0, manifest.archive.sizeBytes, 'read')
    const archive = await readFileBlob({
      name: manifest.archive.name,
      sizeBytes: manifest.archive.sizeBytes,
      onProgress: (done, total, stage) => onProgress?.(done, total, stage),
    })

    // ③ **先恢复会话**：走既有导入链路（暂存 + 一次性提交），失败时正式数据不变。
    //    顺序不能反过来 —— 先写附件再导入会话，一旦导入失败就会留下一批没有归属的附件块。
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

    // ④ 附件原件与元数据（会话之后，尽力而为）：失败**不抛错**（会话已经恢复，抛错是错的状态），
    //    但必须对外可见 —— `attachmentsRestored: false` 就是 UI 提示「附件没回来」的依据。
    let attachmentsRestored = manifest.attachments === null
    if (manifest.attachments) {
      try {
        const packed = await readFileBlob({
          name: manifest.attachments.name,
          sizeBytes: manifest.attachments.sizeBytes,
          onProgress: (done, total, stage) => onProgress?.(done, total, stage),
        })
        const restored = await restoreAttachments(packed, manifest.attachments.name)
        attachmentsRestored = true
        logDiagnostic('info', 'restore: attachments restored', { action: 'backup-restore', restored })
      } catch (error) {
        attachmentsRestored = false
        logDiagnostic('error', 'restore: attachments failed (sessions restored)', {
          action: 'backup-restore',
        }, error)
      }
    }
    // 只推进 `last_restore_at_utc`：恢复不是备份，「最近备份时间」不许被一次恢复改写成现在
    await writeStatusFile({ ...(await readStatusFile()), last_restore_at_utc: new Date().toISOString() })

    // ⑤ 总量收口（#1006）：**两组都清**，让「恢复完立刻看设置页」就是 3 常规 + 2 安全 = 5 份。
    //
    // 为什么必须两组都清：清理常规组原本**只在「常规备份成功」时**发生（`runBackup` → `prune: true`），
    // 而盘上老版本的清单没有 `origin` 字段、按约定一律算常规备份 —— 于是老用户升级后只要不点
    // 「立即备份」，连着恢复几次就得到 5 → 6 → 7 份（设备实测），而设置页显示的是真实份数，
    // 用户看到的就是「清理没生效」。
    //
    // 为什么必须放在这里（恢复 ②③④ 全部成功之后）：常规组里就有**这次正在恢复的那份备份**，
    // 先清后恢复会把它删掉（「恢复失败」+ 用户失去唯一能回去的那份）。安全组的上限仍由前半段
    // 那次 `applyRetention('safety')` 提前压住：恢复中途失败时总量也不会无上限地涨。
    //
    // 清理失败**不得**把这次恢复改判成失败：恢复已经成功了就是成功，`applyRetention` 自己吞异常，
    // 这里再兜一层（防止将来有人往里加会抛错的逻辑）。
    // 同样豁免 `id`：用户要回到的就是那份，恢复路径任何一个清理触发点都不许把它列为候选。
    try {
      await applyRetention('all', [id])
    } catch (error) {
      logDiagnostic('error', 'restore: prune after restore failed', { action: 'backup-prune' }, error)
    }
    onProgress?.(1, 1, 'done')
    return { attachmentsRestored, attachmentCount: manifest.data_summary.attachments }
  })

export const isBackupSupported = (): boolean => isBackupStorageAvailable()

/** 原生不可用时的错误类型（`code === 'UNSUPPORTED'`）。 */
export { BackupStorageUnavailableError }

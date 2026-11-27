import { createId } from '../../utils/id.js'
import { exportHistory, importHistory } from '../chat/backup.js'
import { LIMITS } from '../limits.js'
import { useSettings } from '../settings.js'
import {
  listBackupMeta,
  markBackupUnusable,
  readBackupBytes,
  readBackupKv,
  saveBackup,
  sha256Hex,
  writeBackupKv,
  type BackupMeta,
} from './backupStore.js'

/**
 * 备份服务的对外契约（#993）。**界面只依赖这一份文件。**
 *
 * 数据形状与函数签名与 issue 里定下的契约逐字一致，只按产品口径补了 `BackupItem.sessionCount`
 * （恢复确认要告诉用户「这份备份里有几个对话」）。集成时若核心侧签名不同，改这里一处即可，
 * 界面与视图层不用动。
 *
 * ## 这一版是**本地实现**，不是桩
 *
 * 产品口径（2026-11-27）要求「备份状态 / 占用空间 / 立即备份 / 恢复备份」四个东西必须真实可用，
 * 不能是灰的占位。所以这一版把备份做成真的能跑的最小实现：
 *   · 打包 / 解包复用**既有**的历史导出导入链路（`services/chat/backup.ts` 的
 *     `exportHistory` / `importHistory`，即设置页「导出所有历史对话 / 导入历史对话」那条已经
 *     有回归覆盖的路径），本文件不产出第二套归档格式；
 *   · 本文件负责的只是「存到哪、怎么列、能不能用、恢复前先兜一份」。
 *
 * 恢复的顺序按产品承诺固定为：**先给当前数据做一份安全备份 → 再整包覆盖**。
 * 安全备份失败就整单中止（`safety-backup-failed`），绝不在没有退路的情况下动用户数据。
 *
 * 异常一律抛 `BackupError`：`code` 是界面用来选文案的分类，`currentDataIntact` 是
 * **能不能说「原有数据还在」的唯一依据**（只有 true 才允许这么讲）。
 */

export type BackupItem = {
  id: string
  createdAtUtc: string
  sizeBytes: number
  checksumOk: boolean
  /** 这份备份里有几个会话；核心侧给不出时为 0，界面就不显示条数 */
  sessionCount: number
}

export type BackupStatus = {
  enabled: boolean
  running: boolean
  lastSuccessAtUtc: string | null
  lastError: string | null
  totalBytes: number
  count: number
  freeBytes: number
  enoughForNext: boolean
}

export type Progress = (done: number, total: number, stage: string) => void

/** 失败分类（界面只按这个选人话，原始错误文本一律不进界面） */
export type BackupErrorCode =
  | 'safety-backup-failed'
  | 'corrupt'
  | 'space'
  | 'interrupted'
  /** 没有可备份的记录：正常状态，不是失败（界面不标红） */
  | 'empty'
  /** 当前环境不支持备份到本机存储：界面据此把「立即备份」置灰并给原因 */
  | 'unsupported'
  | 'unknown'

export class BackupError extends Error {
  constructor(
    readonly code: BackupErrorCode,
    /** 当前数据是否完好到可以说「还在设备上」：只有明确 true 时界面才会那么讲 */
    readonly currentDataIntact: boolean
  ) {
    super(code)
    this.name = 'BackupError'
  }
}

/** 进程内「正在跑」的标记：界面按钮锁之外的第二道门（自动备份与手动点击可能撞车） */
let running = false

const toItem = (meta: BackupMeta): BackupItem => ({
  id: meta.id,
  createdAtUtc: meta.createdAtUtc,
  sizeBytes: meta.sizeBytes,
  checksumOk: meta.checksumOk,
  sessionCount: meta.sessionCount ?? 0,
})

/**
 * 设备剩余空间。读不到就给 `Infinity`：宁可**不提醒**，也不要因为「读不出配额」就吓用户
 * 「空间不足」（真实的不足会在导出那一步以 `space` 失败暴露出来）。
 */
const estimateFreeBytes = async (): Promise<number> => {
  try {
    const storage = typeof navigator === 'undefined' ? null : navigator.storage
    if (!storage || typeof storage.estimate !== 'function') {
      return Number.POSITIVE_INFINITY
    }
    const { quota, usage } = await storage.estimate()
    if (typeof quota !== 'number' || typeof usage !== 'number') {
      return Number.POSITIVE_INFINITY
    }
    return Math.max(0, quota - usage)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** 下一次备份大概要多少：有历史备份就按最近一份估，没有就给保守值 */
const estimateNextBytes = (items: readonly BackupMeta[]): number =>
  items.length === 0 ? LIMITS.backup.nextEstimateBytes : items[0].sizeBytes

/** 原始异常 → 分类。**只在内部用**，界面永远看不到 message。 */
const classifyFailure = (error: unknown): BackupErrorCode => {
  if (error instanceof BackupError) {
    return error.code
  }
  // 既有导出链路的「没有可导出的对话」：这是正常状态，不该走到失败文案
  if ((error as { key?: unknown } | null)?.key === 'historyExportEmptyNoSessions') {
    return 'empty'
  }
  const raw = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  if (/quota|ENOSPC|storage.*full|out of space/i.test(raw)) {
    return 'space'
  }
  if (/abort|cancel|interrupt|terminated/i.test(raw)) {
    return 'interrupted'
  }
  if (/corrupt|invalid|checksum|unexpected end|format/i.test(raw)) {
    return 'corrupt'
  }
  return 'unknown'
}

const asBackupError = (error: unknown, currentDataIntact: boolean): BackupError =>
  error instanceof BackupError ? error : new BackupError(classifyFailure(error), currentDataIntact)

const itemsOf = async (): Promise<BackupItem[]> => (await listBackupMeta()).map(toItem)

export const listBackups = async (): Promise<BackupItem[]> => itemsOf()

export const getStatus = async (): Promise<BackupStatus> => {
  const metas = await listBackupMeta()
  const [lastSuccessAtUtc, lastError, freeBytes] = await Promise.all([
    readBackupKv('lastSuccess'),
    readBackupKv('lastError'),
    estimateFreeBytes(),
  ])
  return {
    enabled: useSettings.getState().autoBackup,
    running,
    lastSuccessAtUtc,
    lastError,
    totalBytes: metas.reduce((sum, meta) => sum + meta.sizeBytes, 0),
    count: metas.length,
    freeBytes,
    enoughForNext: freeBytes >= estimateNextBytes(metas),
  }
}

/**
 * 跑一次备份并保存。
 *
 * `trigger` 只影响记录的来源标记（自动 / 手动 / 恢复前的安全备份），不影响产物。
 */
export const runBackup = async (
  trigger: 'auto' | 'manual',
  onProgress?: Progress
): Promise<BackupItem> => {
  if (running) {
    throw new BackupError('unknown', true)
  }
  running = true
  try {
    const freeBytes = await estimateFreeBytes()
    const metas = await listBackupMeta()
    if (freeBytes < estimateNextBytes(metas)) {
      throw new BackupError('space', true)
    }
    onProgress?.(0, 1, 'exporting')
    const { blob, sessions } = await exportHistory({
      onProgress: ({ exported, total }) =>
        onProgress?.(exported, Math.max(total, 1), 'exporting'),
    })
    const bytes = await blob.arrayBuffer()
    if (bytes.byteLength === 0) {
      // 空包不能当备份存下来：它会让「有备份」这件事变成假的
      throw new BackupError('interrupted', true)
    }
    const meta: BackupMeta = {
      id: createId(),
      createdAtUtc: new Date().toISOString(),
      sizeBytes: bytes.byteLength,
      sessionCount: sessions,
      trigger,
      digest: await sha256Hex(bytes),
      checksumOk: true,
    }
    await saveBackup(meta, bytes)
    await writeBackupKv('lastSuccess', meta.createdAtUtc)
    await writeBackupKv('lastError', null)
    onProgress?.(1, 1, 'done')
    return toItem(meta)
  } catch (error) {
    const failure = asBackupError(error, true)
    try {
      await writeBackupKv('lastError', failure.code)
    } catch {
      // 状态记不下来也不能盖住真正的失败
    }
    throw failure
  } finally {
    running = false
  }
}

/**
 * 用某一份备份覆盖本机数据。
 *
 * 三步，顺序不能换（见文件头）：自检 → 安全备份 → 整包覆盖。
 * 任何一步失败都抛 `BackupError`，由界面按 `code` / `currentDataIntact` 选文案。
 */
export const restoreBackup = async (id: string, onProgress?: Progress): Promise<void> => {
  if (running) {
    throw new BackupError('unknown', true)
  }
  running = true
  try {
    const meta = (await listBackupMeta()).find((item) => item.id === id)
    const bytes = meta ? await readBackupBytes(id) : null
    if (!meta || !bytes) {
      throw new BackupError('corrupt', true)
    }
    // ① 自检：摘要对不上就**一个字节都不动**，当前数据当然完好
    const digest = await sha256Hex(bytes)
    if (meta.digest !== null && digest !== null && digest !== meta.digest) {
      await markBackupUnusable(meta)
      throw new BackupError('corrupt', true)
    }
    // ② 安全备份：恢复前先把「现在」存一份，失败就不往下走
    onProgress?.(0, 3, 'safety')
    try {
      const current = await exportHistory({})
      const currentBytes = await current.blob.arrayBuffer()
      const safety: BackupMeta = {
        id: createId(),
        createdAtUtc: new Date().toISOString(),
        sizeBytes: currentBytes.byteLength,
        sessionCount: current.sessions,
        trigger: 'safety',
        digest: await sha256Hex(currentBytes),
        checksumOk: true,
      }
      if (currentBytes.byteLength > 0) {
        await saveBackup(safety, currentBytes)
      }
    } catch (error) {
      // 现在本来就是零条数据（丢库后从备份恢复的常见场景）：没有任何东西需要保护，
      // 跳过安全备份继续走，别把它当「安全备份失败」把整单中止掉
      if ((error as { key?: unknown } | null)?.key !== 'historyExportEmptyNoSessions') {
        // 当前数据一个字节都没被动过，所以这里可以说「还在设备上」
        throw new BackupError('safety-backup-failed', true)
      }
    }
    // ③ 整包覆盖（复用导入链路自己的暂存 / 回滚语义）
    onProgress?.(2, 3, 'restoring')
    try {
      await importHistory(new File([bytes], 'backup.zip', { type: 'application/zip' }), {
        mode: 'overwrite',
        onProgress: () => onProgress?.(2, 3, 'restoring'),
      })
    } catch {
      // 覆盖过程中的失败**不能**声称数据完好：暂存可能已提交一部分
      throw new BackupError('interrupted', false)
    }
    await writeBackupKv('lastSuccess', new Date().toISOString())
    await writeBackupKv('lastError', null)
    onProgress?.(3, 3, 'done')
  } finally {
    running = false
  }
}

/**
 * 自动备份的入口：启动时调一次，满足条件才真跑。
 *
 * 条件（缺一不可）：开关是开的、没有正在跑的备份、剩余空间够下一份、
 * 距上次成功已超过 `LIMITS.backup.autoIntervalMs`（或从来没成功过）。
 * **永不抛错**：自动备份失败只把分类写进 `lastError`，绝不让启动路径崩。
 */
export const maybeAutoBackup = async (onProgress?: Progress): Promise<void> => {
  try {
    if (!useSettings.getState().autoBackup || running) {
      return
    }
    const status = await getStatus()
    if (!status.enoughForNext) {
      return
    }
    if (status.lastSuccessAtUtc !== null) {
      const last = Date.parse(status.lastSuccessAtUtc)
      if (Number.isFinite(last) && Date.now() - last < LIMITS.backup.autoIntervalMs) {
        return
      }
    }
    await runBackup('auto', onProgress)
  } catch {
    // 分类已经记进 lastError，界面会显示成一句人话
  }
}

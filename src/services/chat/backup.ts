import { formatDate } from '../../utils/format.js'
import { captureStateSnapshot, errorMeta, record, recordAction, recordEvent } from '../diagnostics/collector.js'
import { buildMeta, type Stage } from '../diagnostics/fields.js'
import { createStageTimer } from '../diagnostics/timing.js'
import * as db from './db.js'
import { fail } from './history/errors.js'
import { formatImportBytes, maxImportMegabytes, resolveMaxImportBytes } from './history/importLimit.js'
import { parseSessionPath } from './history/paths.js'
import { listArchivePaths } from './history/zipReader.js'
import { replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/** 导入进度：已处理会话数 / 会话总数（拿不到总数时不传）。 */
export type ImportProgress = { sessions: number; totalSessions?: number; images?: number }

export type ImportHistoryOptions = {
  /** 取消：条目边界中断，暂存被清空，正式数据不变。 */
  signal?: AbortSignal
  /** 有回调时才会多解析一次中央目录拿会话总数（n/总数 进度），本地文件导入不需要。 */
  onProgress?: (progress: ImportProgress) => void
  /** 大小上限（字节）；默认 DEFAULT_MAX_IMPORT_BYTES，与「从链接导入」同一个数字。UI 不传。 */
  maxBytes?: number
}

/** 与「从链接导入」复用同一条提示文案：都是「这个包太大，先别导」，都要说清上限与实测体积（#195）。 */
const tooLarge = (limitBytes: number, measuredBytes: number): never =>
  fail('historyImportUrlTooLarge', {
    size: maxImportMegabytes(limitBytes),
    actual: formatImportBytes(measuredBytes),
  })

/** 会话总数：只读中央目录的条目名，不读条目内容；目录异常时返回 undefined（退化为只显示已处理数）。 */
const countSessions = async (file: File): Promise<number | undefined> => {
  const total = (await listArchivePaths(file)).filter((path) => parseSessionPath(path) !== null).length
  return total > 0 ? total : undefined
}

/**
 * 确认覆盖后调用：先查大小上限，再检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File, options: ImportHistoryOptions = {}): Promise<number> =>
  enqueueBackup(async () => {
    const startedAt = Date.now()
    // 分阶段计时（#306）：每个 import_stage 都带自己那一段的 durationMs，卡在哪个阶段不用再靠时间戳相减
    const timer = createStageTimer()
    // 关键业务动作：只记字节数、阶段与耗时，归档内容不进日志
    let stage: Stage = 'import.check'
    recordAction('import_start', 'import-history', {
      bytes: file.size,
      totalBytes: file.size,
      source: 'file',
      ...buildMeta({ flow: 'import', stage: 'import.check', attempt: 1, status: 'ok' }),
    })
    try {
      // 上限检查放在最前：超限的包不看格式、不写暂存，直接给一句人话（issue #34）
      const maxBytes = resolveMaxImportBytes(options.maxBytes)
      if (file.size > maxBytes) {
        stage = 'import.size'
        tooLarge(maxBytes, file.size)
      }
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      recordEvent('import_stage', 'import: check archive format', {
        bytes: file.size,
        ...buildMeta({
          flow: 'import',
          stage: 'import.check',
          attempt: 1,
          status: 'ok',
          durationMs: timer.lap(),
          bytes: file.size,
        }),
      })
      await checkArchiveFormat(file)
      stage = 'import.stage'
      const totalSessions = options.onProgress ? await countSessions(file) : undefined
      recordEvent('import_stage', 'import: write staging stores', {
        ...buildMeta({
          flow: 'import',
          stage: 'import.stage',
          attempt: 1,
          status: 'ok',
          durationMs: timer.lap(),
          bytes: file.size,
        }),
      })
      const count = await replaceHistory(() =>
        importArchive(file, {
          signal: options.signal,
          totalSessions,
          onProgress: options.onProgress,
        })
      )
      recordAction('import_done', 'import-history', {
        count,
        ...buildMeta({
          flow: 'import',
          stage: 'import.commit',
          attempt: 1,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          totalBytes: file.size,
          // 平均写入速率：同样 200MB，3MB/s 和 20MB/s 是两种问题
          speedBps: file.size > 0 && Date.now() > startedAt
            ? Math.round((file.size / Math.max(1, Date.now() - startedAt)) * 1000)
            : undefined,
        }),
      })
      void captureStateSnapshot('after-import')
      return count
    } catch (error) {
      // 失败必录：error 级 + 阶段 + 耗时 + 错误原文（BackupError 的 message 就是中文原因）
      record('import_error', 'error', `import failed at ${stage}`, {
        ...buildMeta({
          flow: 'import',
          stage,
          attempt: 1,
          status: 'error',
          durationMs: Date.now() - startedAt,
          bytes: file.size,
        }),
        ...errorMeta(error),
      })
      throw error
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })

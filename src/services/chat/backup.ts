import { formatDate } from '../../utils/format.js'
import { captureStateSnapshot, errorMeta, record, recordAction, recordEvent } from '../diagnostics/collector.js'
import * as db from './db.js'
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
export type ImportProgress = { sessions: number; totalSessions?: number }

export type ImportHistoryOptions = {
  /** 取消：条目边界中断，暂存被清空，正式数据不变。 */
  signal?: AbortSignal
  /** 有回调时才会多解析一次中央目录拿会话总数（n/总数 进度），本地文件导入不需要。 */
  onProgress?: (progress: ImportProgress) => void
}

/** 会话总数：只读中央目录的条目名，不读条目内容；目录异常时返回 undefined（退化为只显示已处理数）。 */
const countSessions = async (file: File): Promise<number | undefined> => {
  const total = (await listArchivePaths(file)).filter((path) => parseSessionPath(path) !== null).length
  return total > 0 ? total : undefined
}

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export const importHistory = (file: File, options: ImportHistoryOptions = {}): Promise<number> =>
  enqueueBackup(async () => {
    const startedAt = Date.now()
    // 关键业务动作：只记字节数、阶段与耗时，归档内容不进日志
    let stage = 'check'
    recordAction('import_start', 'import-history', { bytes: file.size, source: 'file' })
    try {
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      recordEvent('import_stage', 'import: check archive format', { stage, bytes: file.size })
      await checkArchiveFormat(file)
      stage = 'staging'
      const totalSessions = options.onProgress ? await countSessions(file) : undefined
      recordEvent('import_stage', 'import: write staging stores', { stage })
      const count = await replaceHistory(() =>
        importArchive(file, {
          signal: options.signal,
          totalSessions,
          onProgress: options.onProgress,
        })
      )
      recordAction('import_done', 'import-history', {
        count,
        durationMs: Date.now() - startedAt,
      })
      void captureStateSnapshot('after-import')
      return count
    } catch (error) {
      // 失败必录：error 级 + 阶段 + 耗时 + 错误原文（BackupError 的 message 就是中文原因）
      record('import_error', 'error', `import failed at ${stage}`, {
        stage,
        durationMs: Date.now() - startedAt,
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

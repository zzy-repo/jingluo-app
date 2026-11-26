/**
 * StagingRepo 的 SQLite 实现。
 *
 * 语义对照 `chat/db.ts` 的 `commitStaging` / `mergeStaging`：
 *  - `commit` 整包替换：清会话/摘要/记忆、清聊天原件但保留 `attachment-` 前缀、搬入暂存、清暂存，一个事务；
 *  - `merge` 增量合并：按 `planMerge` 判定，只搬被写入会话引用的原件，不碰记忆，一个事务；
 *  - 空暂存的 `commit` / `merge` 是合法操作（types.ts 未禁止），按上述定义执行：
 *    空包 commit = 清空正式会话/摘要/记忆与聊天原件（保留 attachment- 前缀），空包 merge = 空计划 + 清暂存。
 *    这条与 IDB 现状一致，#926 第 6 条待 lead 定案。
 */
import { planMerge, type MergePlan, type MergePolicy } from '../../../chat/history/mergeSessions.js'
import type { Session, SessionSummary } from '../../../chat/types.js'
import type { StagingRepo } from '../../types.js'
import { copyBlob } from '../blobStore.js'
import type { Runner } from './context.js'
import { allKeys, clearStore, deleteRow, deleteRows, getRow, putRow, type Ex } from './rows.js'
import { isAttachmentBlobKey, publicSummary, referencedFileIds, storedSummary } from './shared.js'

const moveFiles = async (ex: Ex, ids: readonly string[]): Promise<void> => {
  for (const id of ids) {
    await copyBlob(ex, 'filesStaging', 'files', id)
  }
}

export const createStagingRepo = (runner: Runner): StagingRepo => ({
  clear: () =>
    runner.tx(async (ex) => {
      await clearStore(ex, 'sessionsStaging')
      await clearStore(ex, 'filesStaging')
    }),

  addSession: (session) =>
    runner.tx(async (ex) => {
      await putRow(ex, 'sessionsStaging', session.id, session, { replace: false })
    }),

  putFiles: (files) =>
    runner.tx(async (ex) => {
      for (const file of files) {
        await putRow(ex, 'filesStaging', file.id, file)
      }
    }),

  updateFileTypes: (types) =>
    runner.tx(async (ex) => {
      for (const key of await allKeys(ex, 'sessionsStaging')) {
        const session = await getRow<Session>(ex, 'sessionsStaging', key)
        if (session === undefined) {
          continue
        }
        session.messages = session.messages.map((message) =>
          message.role === 'user'
            ? { ...message, files: message.files.map((file) => ({ ...file, mimeType: types.get(file.id) ?? '' })) }
            : message,
        )
        await putRow(ex, 'sessionsStaging', key, session)
      }
    }),

  commit: () =>
    runner.tx(async (ex) => {
      await clearStore(ex, 'sessions')
      await clearStore(ex, 'sessionSummaries')
      await clearStore(ex, 'sessionMemory')
      const kept = (await allKeys(ex, 'files')).filter(isAttachmentBlobKey)
      await deleteRows(ex, 'files', (await allKeys(ex, 'files')).filter((key) => !kept.includes(key)))
      const summaries: SessionSummary[] = []
      for (const key of await allKeys(ex, 'sessionsStaging')) {
        const session = await getRow<Session>(ex, 'sessionsStaging', key)
        if (session === undefined) {
          continue
        }
        await putRow(ex, 'sessions', session.id, session)
        const summary = storedSummary(session)
        await putRow(ex, 'sessionSummaries', session.id, summary)
        summaries.push(publicSummary(summary))
      }
      await moveFiles(ex, await allKeys(ex, 'filesStaging'))
      await clearStore(ex, 'sessionsStaging')
      await clearStore(ex, 'filesStaging')
      return summaries
    }),

  merge: (policy: MergePolicy) =>
    runner.tx(async (ex) => {
      const staged: { id: string; title: string; updatedAt: number; files: string[] }[] = []
      for (const key of await allKeys(ex, 'sessionsStaging')) {
        const session = await getRow<Session>(ex, 'sessionsStaging', key)
        if (session === undefined) {
          continue
        }
        staged.push({ id: session.id, title: session.title, updatedAt: session.updatedAt, files: referencedFileIds(session) })
      }
      const localUpdatedAt = new Map<string, number>()
      for (const item of staged) {
        const local = await getRow<Session>(ex, 'sessions', item.id)
        if (local !== undefined) {
          localUpdatedAt.set(item.id, local.updatedAt)
        }
      }
      const plan: MergePlan = planMerge(staged, (id) => localUpdatedAt.get(id), policy)
      const written = new Set(plan.written)
      const filesToMove = new Set(staged.filter((item) => written.has(item.id)).flatMap((item) => item.files))
      for (const key of await allKeys(ex, 'sessionsStaging')) {
        const session = await getRow<Session>(ex, 'sessionsStaging', key)
        if (session === undefined || !written.has(session.id)) {
          continue
        }
        await putRow(ex, 'sessions', session.id, session)
        await putRow(ex, 'sessionSummaries', session.id, storedSummary(session))
      }
      await moveFiles(ex, (await allKeys(ex, 'filesStaging')).filter((id) => filesToMove.has(id)))
      await clearStore(ex, 'sessionsStaging')
      await clearStore(ex, 'filesStaging')
      return plan
    }),
})

/** 供仓储内部复用的「删一行」导出（其它模块用 `deleteRow` 即可）。 */
export const deleteOne = deleteRow

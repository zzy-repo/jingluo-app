/**
 * SessionRepo 的 SQLite 实现（语义逐条对照 `chat/db.ts` 的 `saveSession` / `pinSession` / `renameSession` /
 * `deleteSession` 与 `storage/idb/txRepos.ts`）。
 */
import {
  classifyStorageFailure,
  storageFailureOf,
  stripNonCloneableFields,
  type FileDegradation,
  type StorageFailure,
  type StoredFile,
} from '../../../chat/db.js'
import type { Session, SessionSummary } from '../../../chat/types.js'
import type { SessionRepo } from '../../types.js'
import { encodeKey } from '../mapping.js'
import type { Runner } from './context.js'
import {
  allKeys,
  countWhere,
  deleteRow,
  deleteRows,
  getRow,
  keyOf,
  pageRows,
  putRow,
  selectRows,
  type Ex,
} from './rows.js'
import { isAttachmentBlobKey, publicSummary, storedSummary } from './shared.js'

const STORES_SESSION = 'sessions,sessionSummaries'
const STORES_FILES = 'files'

class SessionWriteError extends Error {
  readonly failure: StorageFailure
  readonly strippedFields: readonly string[]

  constructor(failure: StorageFailure, strippedFields: readonly string[] = []) {
    super(failure.message ?? failure.name ?? failure.kind)
    this.name = 'SessionWriteError'
    this.failure = failure
    this.strippedFields = strippedFields
  }
}

const blobBytesOf = (file: StoredFile): number =>
  typeof file.blob === 'object' && file.blob !== null && typeof file.blob.size === 'number' ? file.blob.size : 0

const writeSession = async (ex: Ex, session: Session): Promise<void> => {
  await putRow(ex, 'sessions', session.id, session)
  await putRow(ex, 'sessionSummaries', session.id, storedSummary(session))
}

/** 清掉没有任何会话引用的孤儿原件（尽力而为，失败不抛）。避开 `keep` 与 `attachment-` 前缀。 */
const sweepOrphanFiles = (runner: Runner, keep: ReadonlySet<string>): Promise<number> =>
  runner.tx(async (ex) => {
    const referenced = new Set((await ex.all('SELECT DISTINCT file_id AS f FROM session_summary_file_ids')).map((row) => keyOf(row.f)))
    const doomed = (await allKeys(ex, 'files')).filter(
      (key) => !referenced.has(key) && !keep.has(key) && !isAttachmentBlobKey(key),
    )
    await deleteRows(ex, 'files', doomed)
    return doomed.length
  })

const reclaimQuotaSpace = async (runner: Runner, keep: readonly string[] = []): Promise<void> => {
  await sweepOrphanFiles(runner, new Set(keep)).catch(() => 0)
}

/** 事务 A（必须成功）：会话 + 摘要。两条自愈各一次：clone 剔字段、quota 清孤儿。 */
const writeSessionRecord = async (runner: Runner, session: Session): Promise<string[]> => {
  const once = (value: Session) => runner.tx((ex) => writeSession(ex, value))
  try {
    await once(session)
    return []
  } catch (error) {
    const kind = classifyStorageFailure(error)
    if (kind === 'clone') {
      const { value, removed } = stripNonCloneableFields(session)
      if (removed.length > 0) {
        try {
          await once(value)
          return removed
        } catch (retryError) {
          throw new SessionWriteError(storageFailureOf(retryError, STORES_SESSION), removed)
        }
      }
    }
    if (kind === 'quota') {
      await reclaimQuotaSpace(runner)
      try {
        await once(session)
        return []
      } catch (retryError) {
        throw new SessionWriteError(storageFailureOf(retryError, STORES_SESSION))
      }
    }
    throw new SessionWriteError(storageFailureOf(error, STORES_SESSION))
  }
}

const putFilesOnce = (runner: Runner, files: readonly StoredFile[]): Promise<void> =>
  runner.tx(async (ex) => {
    for (const file of files) {
      await putRow(ex, 'files', file.id, file)
    }
  })

/** 事务 B（可以失败）：只写原件，失败只降级这些附件。 */
const writeAttachmentBlobs = async (
  runner: Runner,
  files: readonly StoredFile[],
  keep: readonly string[],
): Promise<FileDegradation[]> => {
  if (files.length === 0) {
    return []
  }
  let failure: StorageFailure
  try {
    await putFilesOnce(runner, files)
    return []
  } catch (error) {
    failure = storageFailureOf(error, STORES_FILES)
    if (failure.kind === 'quota') {
      await reclaimQuotaSpace(runner, keep)
      try {
        await putFilesOnce(runner, files)
        return []
      } catch (retryError) {
        failure = storageFailureOf(retryError, STORES_FILES)
      }
    }
  }
  if (files.length > 1 && failure.kind !== 'quota') {
    const degraded: FileDegradation[] = []
    for (const file of files) {
      try {
        await putFilesOnce(runner, [file])
      } catch (error) {
        degraded.push({ id: file.id, bytes: blobBytesOf(file), failure: storageFailureOf(error, STORES_FILES) })
      }
    }
    return degraded
  }
  return files.map((file) => ({ id: file.id, bytes: blobBytesOf(file), failure }))
}

export const createSessionRepo = (runner: Runner, mode: 'top' | 'atomic'): SessionRepo => ({
  listSummaries: () =>
    runner.direct(async (ex) => (await selectRows<SessionSummary>(ex, 'sessionSummaries')).map(publicSummary)),

  get: (id) => runner.direct((ex) => getRow<Session>(ex, 'sessions', id)),

  save: async (session, files = [], options) => {
    if (mode === 'atomic') {
      // runAtomic 里没有「事务 A / B 拆开」：全部写进同一事务，任一失败整体回滚、错误原样抛出，不做自愈。
      await runner.tx(async (ex) => {
        await writeSession(ex, session)
        for (const file of files) {
          await putRow(ex, 'files', file.id, file)
        }
      })
      return { failure: null, degradedFiles: [], strippedFields: [] }
    }
    let strippedFields: string[] = []
    try {
      strippedFields = await writeSessionRecord(runner, session)
    } catch (error) {
      const failure = error instanceof SessionWriteError ? error.failure : storageFailureOf(error, STORES_SESSION)
      const stripped = error instanceof SessionWriteError ? [...error.strippedFields] : []
      return { failure, degradedFiles: [], strippedFields: stripped }
    }
    const degradedFiles = await writeAttachmentBlobs(runner, files, options?.keepFileIds ?? [])
    return { failure: null, degradedFiles, strippedFields }
  },

  pin: (id, pinnedAt) =>
    runner.tx(async (ex) => {
      const session = await getRow<Session>(ex, 'sessions', id)
      if (session === undefined) {
        return
      }
      if (pinnedAt === undefined) {
        delete session.pinnedAt
      } else {
        session.pinnedAt = pinnedAt
      }
      await writeSession(ex, session)
    }),

  rename: (id, title) =>
    runner.tx(async (ex) => {
      const session = await getRow<Session>(ex, 'sessions', id)
      if (session === undefined) {
        return
      }
      session.title = title
      await writeSession(ex, session)
    }),

  delete: (sessionId) =>
    runner.tx(async (ex) => {
      const summary = await getRow<{ fileIds?: string[] }>(ex, 'sessionSummaries', sessionId)
      await deleteRow(ex, 'sessions', sessionId)
      await deleteRow(ex, 'sessionSummaries', sessionId)
      for (const id of summary?.fileIds ?? []) {
        const refs = await countWhere(ex, 'SELECT COUNT(*) AS c FROM session_summary_file_ids WHERE file_id = ?', [encodeKey(id)])
        if (refs === 0) {
          await deleteRow(ex, 'files', id)
        }
      }
      const memoryKeys = (await ex.all('SELECT id FROM session_memory WHERE session_id = ?', [encodeKey(sessionId)])).map((row) =>
        keyOf(row.id),
      )
      await deleteRows(ex, 'sessionMemory', memoryKeys)
    }),

  listReferencing: (fileId) =>
    runner.direct(async (ex) =>
      (
        await ex.all('SELECT summary_id AS s FROM session_summary_file_ids WHERE file_id = ? ORDER BY summary_id', [encodeKey(fileId)])
      ).map((row) => keyOf(row.s)),
    ),

  listBranchesOf: (parentSessionId) =>
    runner.direct(async (ex) =>
      (
        await selectRows<SessionSummary>(ex, 'sessionSummaries', {
          sql: 'branch_of = ?',
          params: [encodeKey(parentSessionId)],
        })
      ).map(publicSummary),
    ),

  listFull: (query) => runner.direct(async (ex) => (await pageRows(ex, 'sessions', query)) as never),
})

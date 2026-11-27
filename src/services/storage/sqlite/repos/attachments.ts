/**
 * AttachmentRepo 的 SQLite 实现。引用计数口径与 `attachments/store.ts` 一致：
 * 删完元数据再按 `sha256` / `parsedTextPath` 现数，归零才删原件与全文；不维护冗余计数。
 * 旧版 WebCrypto 字节序兼容（`legacyHash`）同样保留。
 */
import { ATTACHMENT_BLOB_PREFIX, attachmentBlobKey, attachmentTextKey, isAttachmentBlobKey } from '../../../attachments/store.js'
import type { DocumentAttachment } from '../../../attachments/types.js'
import type { StoredAttachmentText } from '../../../chat/db.js'
import type { AttachmentRepo, AttachmentTextDraft } from '../../types.js'
import { encodeKey } from '../mapping.js'
import type { Runner } from './context.js'
import { allKeys, countWhere, deleteRow, getRow, hasRow, putRow, selectRows, type Ex } from './rows.js'

const legacyHash = (sha256: string): string => sha256.replace(/(..)(..)(..)(..)/g, '$4$3$2$1')

const shaRefs = (ex: Ex, sha256: string) =>
  countWhere(ex, 'SELECT COUNT(*) AS c FROM attachments WHERE sha256 = ?', [encodeKey(sha256)])

const textRefs = (ex: Ex, path: string) =>
  countWhere(ex, 'SELECT COUNT(*) AS c FROM attachments WHERE parsed_text_path = ?', [encodeKey(path)])

/** 删除一个附件的核心（供 `remove` 与 `removeUnreferenced` 在同一个事务里复用）。 */
export const removeAttachmentIn = async (ex: Ex, id: string): Promise<number> => {
  const record = await getRow<DocumentAttachment>(ex, 'attachments', id)
  if (record === undefined) {
    return 0
  }
  await deleteRow(ex, 'attachments', id)
  let removed = 1
  if (isAttachmentBlobKey(record.localPath) && (await shaRefs(ex, record.sha256)) === 0) {
    await deleteRow(ex, 'files', record.localPath)
    removed += 1
  }
  if (record.parsedTextPath !== undefined && (await textRefs(ex, record.parsedTextPath)) === 0) {
    await deleteRow(ex, 'attachmentTexts', record.parsedTextPath)
    removed += 1
  }
  return removed
}

export const createAttachmentRepo = (runner: Runner): AttachmentRepo => ({
  add: (draft, blob) =>
    runner.tx(async (ex) => {
      let sha256 = draft.sha256
      let localPath = attachmentBlobKey(sha256)
      if (!(await hasRow(ex, 'files', localPath))) {
        const legacy = legacyHash(sha256)
        const legacyPath = attachmentBlobKey(legacy)
        const legacyBlobExists = await hasRow(ex, 'files', legacyPath)
        if (legacyBlobExists || (await shaRefs(ex, legacy)) > 0) {
          sha256 = legacy
          localPath = legacyPath
        }
        if (!legacyBlobExists) {
          await putRow(ex, 'files', localPath, { id: localPath, blob })
        }
      }
      const record: DocumentAttachment = { ...draft, sha256, localPath }
      await putRow(ex, 'attachments', record.id, record, { replace: false })
      return record
    }),

  put: (record) =>
    runner.tx(async (ex) => {
      await putRow(ex, 'attachments', record.id, record)
    }),

  get: (id) => runner.direct((ex) => getRow<DocumentAttachment>(ex, 'attachments', id)),

  list: () => runner.direct((ex) => selectRows<DocumentAttachment>(ex, 'attachments')),

  readText: (key) =>
    key === undefined ? Promise.resolve(undefined) : runner.direct((ex) => getRow<StoredAttachmentText>(ex, 'attachmentTexts', key)),

  writeText: (draft: AttachmentTextDraft) =>
    runner.tx(async (ex) => {
      const record: StoredAttachmentText = {
        key: attachmentTextKey(draft.sha256, draft.parserVersion),
        sha256: draft.sha256,
        parserVersion: draft.parserVersion,
        text: draft.text,
        characterCount: draft.characterCount === undefined ? draft.text.length : draft.characterCount,
        status: draft.status,
        createdAt: Date.now(),
      }
      if (draft.totalPages !== undefined) {record.totalPages = draft.totalPages}
      if (draft.extractedPages !== undefined) {record.extractedPages = draft.extractedPages}
      if (draft.warnings !== undefined && draft.warnings.length > 0) {record.warnings = draft.warnings}
      await putRow(ex, 'attachmentTexts', record.key, record)
      return record
    }),

  remove: (id) => runner.tx((ex) => removeAttachmentIn(ex, id)),

  sweepOrphans: () =>
    runner.tx(async (ex) => {
      let removed = 0
      for (const key of await allKeys(ex, 'attachmentTexts')) {
        if ((await textRefs(ex, key)) === 0) {
          await deleteRow(ex, 'attachmentTexts', key)
          removed += 1
        }
      }
      for (const key of await allKeys(ex, 'files')) {
        if (isAttachmentBlobKey(key) && (await shaRefs(ex, key.slice(ATTACHMENT_BLOB_PREFIX.length))) === 0) {
          await deleteRow(ex, 'files', key)
          removed += 1
        }
      }
      return removed
    }),

  removeUnreferenced: async (referenced) => {
    const ids = (await runner.direct((ex) => allKeys(ex, 'attachments'))).filter((id) => !referenced.has(id))
    let removed = 0
    for (const id of ids) {
      removed += await runner.tx((ex) => removeAttachmentIn(ex, id))
    }
    return removed
  },
})

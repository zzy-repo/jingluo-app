/** 仓储共用的小工具：摘要计算、守卫、前缀判定。口径与 `chat/db.ts` / `attachments/store.ts` 一致。 */
import { isAttachmentBlobKey } from '../../../attachments/blobKeys.js'
import { toSessionSummary, type Session, type SessionSummary } from '../../../chat/types.js'

export { isAttachmentBlobKey }

/** 会话引用的本地原件 id（去重，只数 user 消息）：与 `db.ts` 的 `referencedFileIds` 同口径。 */
export const referencedFileIds = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) => (message.role === 'user' ? message.files.map((file) => file.id) : [])),
  ),
]

/** 与 `db.ts` 的 `storedSummary` 同口径：摘要字段 + `fileIds`。 */
export const storedSummary = (session: Session): SessionSummary & { fileIds: string[] } => ({
  ...toSessionSummary(session),
  fileIds: referencedFileIds(session),
})

/** 去掉存储专用的 `fileIds`，得到对外的摘要。 */
export const publicSummary = (row: SessionSummary): SessionSummary => toSessionSummary(row)

/** 给仓储的每个方法套一层「已关闭则抛」。 */
export const guarded = <R extends object>(repo: R, assertOpen: () => void): R =>
  Object.fromEntries(
    Object.entries(repo).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        assertOpen()
        return (method as (...rest: unknown[]) => unknown)(...args)
      },
    ]),
  ) as R

/** 记忆主键 `${sessionId}:${key}`；会话 ID 不许含 `:`（与 `sessionMemory.ts` 的 `assertSessionId` 同口径）。 */
export const memoryId = (sessionId: string, key: string): string => {
  if (sessionId === '' || sessionId.includes(':')) {
    throw new Error(`会话 ID 非法：${JSON.stringify(sessionId)}（记忆键必须能唯一归属到一个会话）`)
  }
  return `${sessionId}:${key}`
}

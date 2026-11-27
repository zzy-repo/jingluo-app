/** MemoryRepo 的 SQLite 实现。排序口径与 `sessionMemory.ts` 一致：createdAt 升序、同毫秒按主键升序。 */
import type { StoredSessionMemory } from '../../../chat/db.js'
import type { MemoryRepo } from '../../types.js'
import { encodeKey } from '../mapping.js'
import { queryAll } from '../paged.js'
import type { Runner } from './context.js'
import { deleteRow, deleteRows, getRow, keyOf, putRow, selectRows } from './rows.js'
import { memoryId } from './shared.js'

export const createMemoryRepo = (runner: Runner): MemoryRepo => ({
  get: (sessionId, key) => runner.direct((ex) => getRow<StoredSessionMemory>(ex, 'sessionMemory', memoryId(sessionId, key))),

  listBySession: (sessionId) => {
    memoryId(sessionId, '')
    return runner.direct((ex) =>
      selectRows<StoredSessionMemory>(ex, 'sessionMemory', {
        sql: 'session_id = ?',
        params: [encodeKey(sessionId)],
        orderBy: 'created_at, id',
      }),
    )
  },

  put: (entry, evictIds) =>
    runner.tx(async (ex) => {
      await putRow(ex, 'sessionMemory', entry.id, entry)
      await deleteRows(ex, 'sessionMemory', evictIds)
    }),

  delete: (sessionId, key) =>
    runner.tx((ex) => deleteRow(ex, 'sessionMemory', memoryId(sessionId, key))),

  clearSession: (sessionId) => {
    memoryId(sessionId, '')
    return runner.tx(async (ex) => {
      // #940：一个会话的记忆条数没有硬上限 → 走分页口取全，别让键列表自己撞原生上限
      const keys = (await queryAll(ex, 'SELECT id FROM session_memory WHERE session_id = ?', [encodeKey(sessionId)])).map(
        (row) => keyOf(row.id),
      )
      await deleteRows(ex, 'sessionMemory', keys)
      return keys.length
    })
  },
})

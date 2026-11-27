/**
 * IndexedDB 原始行只读源（#910）：迁移引擎的 `RawStoreSource` 实现。
 *
 * 铁律：**永远不对旧库写入 / 删除**。本文件只用 `readonly` 事务，且只调用游标读取；
 * `tests/unit/migration-engine-raw.test.mjs` 把 `put/add/delete/clear`（含游标的 `update/delete`）
 * 打桩成抛错后整套读取仍要成功。
 *
 * 读的是**原值**（不经业务仓储接口，D2）：全部字段原样返回，Blob 保持 Blob。
 */
import { openChatTransaction } from '../../chat/db.js'
import { estimateRowBytes } from '../migration/hash.js'
import {
  RAW_STORE_NAMES,
  type RawPage,
  type RawRow,
  type RawStoreName,
  type RawStoreSource,
} from '../migration/types.js'

const lowerBoundExclusive = (after: string | undefined): IDBKeyRange | undefined =>
  after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)

/** 估算时给每个 store 的固定余量与比例余量：宁高勿低。 */
const ESTIMATE_MARGIN = 1.1
const ESTIMATE_FIXED_BYTES = 64 * 1024

export const createIdbRawSource = (): RawStoreSource => {
  const readBatch = async (
    store: RawStoreName,
    after: string | undefined,
    limit: number
  ): Promise<RawPage> => {
    const size = Math.max(1, Math.floor(limit))
    const tx = await openChatTransaction([store], 'readonly')
    const rows: RawRow[] = []
    let more = false
    const objectStore = tx.store as unknown as IDBObjectStoreLike
    const reading = (async () => {
      for (
        let cursor = await objectStore.openCursor(lowerBoundExclusive(after), 'next');
        cursor;
        cursor = await cursor.continue()
      ) {
        if (rows.length === size) {
          more = true
          break
        }
        rows.push({ key: String(cursor.key), value: cursor.value })
      }
    })()
    await Promise.all([reading, tx.done])
    const last = rows[rows.length - 1]
    return more && last ? { rows, next: last.key } : { rows }
  }

  const count = async (store: RawStoreName): Promise<number> => {
    const tx = await openChatTransaction([store], 'readonly')
    const objectStore = tx.store as unknown as IDBObjectStoreLike
    const [total] = await Promise.all([objectStore.count(), tx.done])
    return total
  }

  const estimateBytes = async (): Promise<number> => {
    let total = 0
    for (const store of RAW_STORE_NAMES) {
      let bytes = ESTIMATE_FIXED_BYTES
      let after: string | undefined
      for (;;) {
        const page = await readBatch(store, after, 32)
        for (const row of page.rows) {
          bytes += estimateRowBytes(row)
        }
        if (page.next === undefined) {
          break
        }
        after = page.next
      }
      total += Math.ceil(bytes * ESTIMATE_MARGIN)
    }
    return total
  }

  return { count, readBatch, estimateBytes }
}

/** 只声明本文件用到的只读方法：类型层面就看不到 put/add/delete/clear。 */
type IDBObjectStoreLike = {
  count(): Promise<number>
  openCursor(
    range?: IDBKeyRange,
    direction?: IDBCursorDirection
  ): Promise<{ key: IDBValidKey; value: unknown; continue(): Promise<IDBCursorLike | null> } | null>
}
type IDBCursorLike = { key: IDBValidKey; value: unknown; continue(): Promise<IDBCursorLike | null> }

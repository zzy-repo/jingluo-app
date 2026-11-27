/**
 * IndexedDB 后端的内部小工具（不出本目录）。
 * 不 import 任何 UI / 状态库 / diagnostics，只依赖 `chat/db.ts` 的公开导出。
 */
import type { Page, PageQuery } from '../types.js'

/** 事务已因请求失败中止时 `abort()` 会抛，忽略即可（与 `db.ts` 的同名私有函数同口径）。 */
export const abortTransaction = (tx: { abort(): void }): void => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

/** 「主键严格大于 after」的范围；缺省 = 从头开始。 */
export const rangeAfter = (after: string | undefined): IDBKeyRange | undefined =>
  after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)

/** 分页时多取一条用来判断有没有下一页；不传 `limit` = 全部（设计文档第 6 节开放问题 3）。 */
export const fetchCount = (query: PageQuery | undefined): number | undefined =>
  query?.limit === undefined ? undefined : Math.max(1, Math.floor(query.limit)) + 1

/** 把「多取一条」的结果裁成一页：`next` = 本页最后一条的主键，没有下一页为 `null`。 */
export const toPage = <T>(rows: readonly T[], keyOf: (row: T) => string, query: PageQuery | undefined): Page<T> => {
  const count = fetchCount(query)
  if (count === undefined || rows.length < count) {
    return { items: rows, next: null }
  }
  const items = rows.slice(0, count - 1)
  return { items, next: keyOf(items[items.length - 1] as T) }
}

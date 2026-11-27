// [helper | 依赖: 纯 Node + 一个真/假 SqlDatabase | 无全局副作用]
//
// #940：**带「原生 4 MiB 结果上限」的分页驱动** —— `SqlDatabase.allPaged()` 的测试替身。
//
// 契约（`AppSqlitePlugin` 的分页化 + `paged.ts` 的 `queryAll`）：
//   allPaged(sql, params, { limit, offset }) → { rows, done, nextOffset }
//   - `done` 只在**真的到结果集末尾**时为 true；
//   - 原生按字节预算提前收口：行数到 `limit` **或** 再加一行就超 4 MiB → 返回 `done:false`；
//   - 只有「第一行单独就超预算」才抛 `RESULT_TOO_LARGE`（单行超大要靠按列分块，不靠分页）。
//
// 本文件把真 SQLite（`db.all`）包成这个形状，并按 `AppSqlitePlugin.queryOn()` 的计数口径
// （`nativeResultBytes`）做预算与超限判定 —— 于是 `queryAll` 的循环、`done` 语义、自校验
// 都能在 Node 里对着**真数据**跑，而不是对着一个只会点头的 stub。
//
// 故障注入（`faults`）用来造负向：少给数据却 `done:true`、offset 不前进、`done:false` 却空页、
// 直接抛 `RESULT_TOO_LARGE`。
import { MAX_RESULT_BYTES, nativeResultBytes } from './bridge-bytes.mjs'

export const tooLarge = (bytes) => {
  const error = new Error(`result exceeds ${MAX_RESULT_BYTES} bytes; refusing to truncate`)
  error.code = 'RESULT_TOO_LARGE'
  error.bytes = bytes
  return error
}

/** `allPaged` 会把语句包进子查询，尾分号会变成语法错误 → 提前拒绝。 */
const assertSingleStatement = (sql) => {
  if (String(sql).trim().endsWith(';')) {
    throw new Error(`allPaged 只接受单条无分号语句（包进子查询用）: ${String(sql).trim().slice(-20)}`)
  }
}

/**
 * 给一个**真**库套上「原生 4 MiB 结果上限」：`all` / 事务里的 `tx.all` 一超限就抛
 * `code:'RESULT_TOO_LARGE'`。真机上 `queryOn()` 就是这一层；分块 / 分页路径必须能绕开它。
 * @returns {{ db: object, stat: { calls: number, maxBytesSeen: number } }}
 */
export const withBridgeLimit = (db, { maxResultBytes = MAX_RESULT_BYTES } = {}) => {
  // maxBytesSeen = **成功返回**的查询里最大的那条（被上限拒掉的另记 oversize）：
  // 「先直读、撞限再分块」是允许的策略，所以被拒的那次不该算进「读路径超限」。
  const stat = { calls: 0, maxBytesSeen: 0, maxAttemptedBytes: 0, oversize: [] }
  const guard = (rows, sql) => {
    stat.calls += 1
    const bytes = nativeResultBytes(rows)
    stat.maxAttemptedBytes = Math.max(stat.maxAttemptedBytes, bytes)
    if (bytes > maxResultBytes) {
      const error = tooLarge(bytes)
      error.sql = sql
      stat.oversize.push({ bytes, sql })
      throw error
    }
    stat.maxBytesSeen = Math.max(stat.maxBytesSeen, bytes)
    return rows
  }
  const wrapTx = (tx) => ({
    run: (sql, params) => tx.run(sql, params),
    all: async (sql, params) => guard(await tx.all(sql, params), sql),
  })
  return {
    stat,
    db: {
      run: (sql, params) => db.run(sql, params),
      all: async (sql, params) => guard(await db.all(sql, params), sql),
      transaction: (work, options) => db.transaction((tx) => work(wrapTx(tx)), options),
      batch: (statements) => db.batch(statements),
      backupTo: (dest) => db.backupTo(dest),
      integrityCheck: () => db.integrityCheck(),
      info: () => db.info(),
      close: () => db.close(),
    },
  }
}

/**
 * @param db 有 `all(sql, params)` 的库（真 node:sqlite 驱动或内存实现）
 * @param options.maxResultBytes 原生上限（默认 4 MiB）
 * @param options.faults 负向注入：
 *   - `failWith: 'RESULT_TOO_LARGE'` 第 N 次起直接抛超限
 *   - `forceDoneAfterFirstPage: true` 第 2 次起返回空页 + done:true（少给数据但说自己完了）
 *   - `staleOffset: true` 每页都返回同一个 nextOffset（分页不前进）
 *   - `emptyUndone: true` 第 1 次返回空页 + done:false
 *   - `dropRowsOnPage: n` 第 n 页悄悄少给 1 行（模拟边界算错）
 */
export const createBridgePagedDriver = (db, { maxResultBytes = MAX_RESULT_BYTES, faults = {} } = {}) => {
  const stat = { calls: 0, maxBytesSeen: 0, maxRowsSeen: 0, pages: [] }
  const all = (sql, params) => db.all(sql, params)

  const allPaged = async (sql, params, page) => {
    const limit = Math.max(1, Math.floor(page?.limit ?? 200))
    const offset = Math.max(0, Math.floor(page?.offset ?? 0))
    stat.calls += 1
    const nth = stat.calls

    if (faults.failFromCall !== undefined && nth >= faults.failFromCall) {
      throw tooLarge(maxResultBytes + 1)
    }
    if (faults.forceDoneAfterFirstPage && nth > 1) {
      stat.pages.push({ limit, offset, fetched: 0, kept: 0, forced: 'done' })
      return { rows: [], done: true, nextOffset: offset }
    }
    if (faults.emptyUndone && nth === 1) {
      stat.pages.push({ limit, offset, fetched: 0, kept: 0, forced: 'empty-undone' })
      return { rows: [], done: false, nextOffset: offset }
    }

    assertSingleStatement(sql)
    const rows = await all(`SELECT * FROM (${String(sql).trim()}) LIMIT ? OFFSET ?`, [
      ...(params ?? []),
      limit,
      offset,
    ])

    // 原生按字节预算收口：逐行累加，加不下就地停
    const kept = []
    let bytes = 2
    for (const row of rows) {
      const rowBytes = nativeResultBytes([row]) - 2
      if (bytes + rowBytes > maxResultBytes) {
        if (kept.length === 0) {
          // 第一行单独就超预算：分页救不了，只能按列分块
          throw tooLarge(bytes + rowBytes)
        }
        break
      }
      kept.push(row)
      bytes += rowBytes
    }
    stat.maxBytesSeen = Math.max(stat.maxBytesSeen, bytes)
    stat.maxRowsSeen = Math.max(stat.maxRowsSeen, kept.length)

    const dropped = faults.dropRowsOnPage === nth && kept.length > 0 ? kept.pop() : undefined
    if (dropped !== undefined) {
      bytes -= nativeResultBytes([dropped]) - 2
    }

    const reachedEnd = rows.length < limit
    const done = reachedEnd && kept.length === rows.length
    const nextOffset = faults.staleOffset ? offset : offset + kept.length
    stat.pages.push({ limit, offset, fetched: rows.length, kept: kept.length, done })
    return { rows: kept, done, nextOffset }
  }

  return { db: { all, allPaged }, allPaged, stat }
}

/** 一次性读取（给「常规路径不回归」当对照基准）：同一条 SQL 走不分页的 `all`。 */
export const readAllAtOnce = async (db, sql, params, { maxResultBytes = MAX_RESULT_BYTES } = {}) => {
  const rows = await db.all(sql, params)
  const bytes = nativeResultBytes(rows)
  if (bytes > maxResultBytes) {
    throw tooLarge(bytes)
  }
  return rows
}

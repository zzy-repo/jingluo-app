/**
 * 仓储的执行上下文：同一份仓储代码既跑在「每个方法自开事务」的顶层，也跑在 `runAtomic` 的同一个事务里。
 *  - `direct`：单条语句的读，直接走连接，不开事务；
 *  - `tx`：多语句读或任何写，必须在一个 `BEGIN IMMEDIATE` 事务里（顶层自开，`runAtomic` 里并入外层事务）。
 * 驱动错误在这里换成带分类名字的错误（见 `errors.ts`）。
 */
import type { SqlDatabase, SqlTx } from '../driver.js'
import { mapSqlError } from './errors.js'
import type { Ex } from './rows.js'

export type Runner = {
  direct<T>(work: (ex: Ex) => Promise<T>): Promise<T>
  tx<T>(work: (ex: Ex) => Promise<T>): Promise<T>
}

/**
 * 单连接串行闸（#951）：同一个库上的顶层语句**排队**，一次只跑一条。
 *
 * 为什么必须有：原生后端只有**一条**连接（`AppSqlitePlugin` 一个 `handle` 一个 `SQLiteConnection`），
 * 事务期间它对同连接的其它调用是**拒绝**而不是排队 —— `guardIdle()` 抛
 * `connection is inside a transaction`（UNAVAILABLE），JS 侧 `db.transaction()` 自己也有
 * `nested transactions not supported` 的守卫。而 `chat/store.ts` 的持久化是 fire-and-forget：
 * 流式追加每一帧、自动标题、`retrySaveSessions()` 的扇出、pagehide 兜底都会**叠着发**。
 * 叠上去的那一次必然被拒 → 上层记成「保存失败」→ 用户看到「这段对话没存到本机，点重试」，
 * 而重试自己也是扇出（并发），于是**点几次都失败**。
 *
 * 排队不是吞异常：每一次调用仍然执行，失败的仍然抛给上层；排队只保证它们**互相不撞**。
 * 事务内部不要再调顶层 runner（那是 `joinedRunner` 的活儿）：这种写法在本闸之前就是直接报
 * 「nested transactions not supported」，现在它会**等待**，所以别这么写。
 */
const queues = new WeakMap<SqlDatabase, Promise<unknown>>()

/** 把一段会碰连接的工作排到该库的队尾；前一次失败也继续跑下一次（不因前车之鉴丢后面的写）。 */
export const serializeOn = <T>(db: SqlDatabase, work: () => Promise<T>): Promise<T> => {
  const tail = queues.get(db) ?? Promise.resolve()
  const queued = tail.then(work, work)
  queues.set(
    db,
    queued.then(
      () => undefined,
      () => undefined,
    ),
  )
  return queued
}

export const topRunner = (db: SqlDatabase): Runner => ({
  direct: async (work) => {
    try {
      return await serializeOn(db, () => work(db))
    } catch (error) {
      throw mapSqlError(error)
    }
  },
  tx: async (work) => {
    try {
      return await serializeOn(db, () => db.transaction((tx) => work(tx)))
    } catch (error) {
      throw mapSqlError(error)
    }
  },
})

/** `runAtomic` 里的执行器：所有调用并入同一个事务。 */
export const joinedRunner = (tx: SqlTx): Runner => {
  const run = async <T>(work: (ex: Ex) => Promise<T>): Promise<T> => {
    try {
      return await work(tx)
    } catch (error) {
      throw mapSqlError(error)
    }
  }
  return { direct: run, tx: run }
}

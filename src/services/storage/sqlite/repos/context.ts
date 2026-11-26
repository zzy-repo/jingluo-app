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

export const topRunner = (db: SqlDatabase): Runner => ({
  direct: async (work) => {
    try {
      return await work(db)
    } catch (error) {
      throw mapSqlError(error)
    }
  },
  tx: async (work) => {
    try {
      return await db.transaction((tx) => work(tx))
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

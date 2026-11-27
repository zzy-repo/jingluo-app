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
 *
 * ## 不变量：本闸**不可重入**
 *
 * 一个任务进闸之后，它的 `work()` 内部**禁止**再调 `topRunner.direct` / `topRunner.tx`
 * （同一个 db）。原因是构造性的：重入时 `queues.get(db)` 拿到的队尾就是**自己这次尚未
 * resolve 的 promise**，`tail.then(work)` 于是排在「等自己」上 → **永久挂起**。
 *
 * 这条为什么危险：改前这种写法是**直接报错**（原生侧 `guardIdle()` 抛
 * `connection is inside a transaction`、JS 侧 `db.transaction()` 抛
 * `nested transactions not supported`），可恢复、有栈可查；进闸之后它变成**等不到头的
 * 等待**，生产现场只表现为「应用卡住」，没有日志、没有栈，只能杀进程。
 *
 * 所以：**事务 / `runAtomic` 回调内部只能使用传进来的 `ex`（或 `tx`）句柄**，读和写都走它
 * ——那正是 `joinedRunner(tx)` 的职责（直通 `work(tx)`，不过闸，见下）。回调里也不许回头
 * 调外层的 `storage.<repo>` 门面，那条路用的就是 `topRunner`。
 *
 * 这条不变量靠「约定 + 静态护栏」守住，不靠运行期检测：浏览器没有 `AsyncLocalStorage`，
 * 运行期无法区分「任务内重入」与「外部并发」——两者在调用点上都是「当前有一次 work 在飞」，
 * 而外部并发正是本闸要排队放行的正常情况（`chat/store.ts` 的持久化就是扇出）。误判成重入
 * 会把这个闸修好的问题原样打回去。护栏见 `tests/unit/serialization-invariants-951.test.mjs`。
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

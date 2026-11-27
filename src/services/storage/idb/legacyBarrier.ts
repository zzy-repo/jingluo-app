/**
 * 旧 IndexedDB 的「防降级屏障」（#916 / #910，用户条件批准，见 #916 评论 7196902445）。
 *
 * 作用：`committed` 之后，若用户手动装回旧 APK（只认 DB v15），旧代码打开 v16 的库会得到 `VersionError`，
 * 而不是静默读到再也不更新的过期数据。
 *
 * 约束（静态断言钉在 `tests/unit/migration-switch-barrier.test.mjs`）：
 *  - 只做 `indexedDB.open(name, 目标版本)`，**升级回调为空**：不建/删 store、不改索引、不碰任何一行业务数据；
 *  - 本文件**不含**任何删除/清空调用（deleteDatabase / delete / clear / deleteObjectStore）；
 *  - 幂等：库已经 ≥ 目标版本（重入）视为已完成；之后必须能再次打开才算成功。
 *  - 只由迁移编排器在 `verified` 之后、写 SQLite meta 之前，经依赖注入调用；普通应用启动不会调用。
 */
import { DB_NAME, DB_VERSION, getChatDB } from '../../chat/db.js'

/** 屏障版本 = 当前库版本 + 1（现为 16）。版本号的唯一来源仍是 `db.ts` 的 `DB_VERSION`。 */
export const LEGACY_BARRIER_VERSION = DB_VERSION + 1

const BLOCKED_TIMEOUT_MS = 10_000

const openAt = (name: string, version: number | undefined): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version)
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('legacy idb barrier: open blocked by another connection'))
      }
    }, BLOCKED_TIMEOUT_MS)
    const done = (action: () => void): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        action()
      }
    }
    // 空升级：什么都不改，只让版本号前进
    request.onupgradeneeded = () => {}
    request.onsuccess = () => done(() => resolve(request.result))
    request.onerror = () => done(() => reject(request.error ?? new Error('legacy idb barrier: open failed')))
    request.onblocked = () => {
      // 其它连接挡住升级：不无限等，由超时计时器统一失败
    }
  })

/**
 * 升到屏障版本并确认能再次打开。失败抛错（编排器因此不写 committed）。
 *
 * **必须先关掉本进程自己那条 IDB 连接**：迁移期间 `db.ts` 的共享连接是活的（源就是经它读的），
 * 而另一个连接持有旧版本会让 `open(…, 16)` 永远 `blocked` —— 真机实测就是这样失败的
 * （`legacy idb barrier: open blocked by another connection`，数据库与备份都已就绪）。
 * 关掉之后 `openChatTransaction` 的 InvalidStateError 重连逻辑不受影响（它本来就会重开），
 * 而 `committed` 之后 IDB 不再被读写（D5）。
 */
export const bumpLegacyIdbVersion = async (name: string = DB_NAME): Promise<void> => {
  await getChatDB()
    .then((db) => {
      db.close()
    })
    .catch(() => {})
  try {
    const db = await openAt(name, LEGACY_BARRIER_VERSION)
    db.close()
  } catch (error) {
    // 库已经比目标版本高（上一次升过 / 之后又升了）：视为已完成，下面照样要求能打开
    if ((error as { name?: string } | null)?.name !== 'VersionError') {
      throw error
    }
  }
  const verify = await openAt(name, undefined)
  const ok = verify.version >= LEGACY_BARRIER_VERSION
  verify.close()
  if (!ok) {
    throw new Error('legacy idb barrier: version did not advance')
  }
}

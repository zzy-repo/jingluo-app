// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 chat/db.ts + src/services/storage/idb | 耗时: <30s]
//
// Issue #906：存储契约套件（tests/helpers/storage-contract/**）的 IDB runner。
// 套件本体只依赖 Node 与 `StorageBackend` 接口；本文件负责 IDB 专属的环境搭建（fake-indexeddb、
// 故障注入、旧库建库、打不开场景），并附上只属于 IDB 的 `idbOnly` 用例（特征化测试里「先钉死」的现状）。
// 将来 SQLite 的 runner 写一份同形状的钩子，原样调同一个 `runStorageContract`。
//
// 为什么在 UNIT_SOLO：用例会临时补丁 `IDBObjectStore.prototype` 并改写全局 `indexedDB`，
// 同批别的文件会被串扰；且 `chat/db.ts` 是进程内单例连接。
import 'fake-indexeddb/auto'

import { runStorageContract } from '../helpers/storage-contract/index.mjs'
import { createIdbHooks } from '../helpers/storage-contract-idb-env.mjs'
import { registerIdbOnly } from '../helpers/storage-contract-idb-only.mjs'
import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installMinimalLocalStorage()
installEndpointsGlobals()
installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')
const storage = await loadTsModule('src/services/storage/index.ts')

runStorageContract({
  name: 'indexeddb (fake-indexeddb)',
  ...createIdbHooks({ db, storage }),
  extra: [registerIdbOnly],
  // 契约按 types.ts 的承诺断言；下面两条是 IDB 后端与 types.ts 注释不一致的「已知偏离」（后端缺陷，不是契约写错）。
  // 修好后用例转绿，汇总会报 FIXED?，到时删掉对应条目。只减不增。
  knownDeviations: [
    {
      match: '[blob][原子] putMany',
      reason: 'IDB 的 saveFiles 不 abort 事务，失败前已排队的 put 仍提交（char-session「saveFiles 非原子（现状）」），与 types:putMany「要么全写入要么全不写入」相反',
    },
    {
      match: '[atomic][嵌套]',
      reason: 'idb/backend.ts 的 runAtomic 每次新开一个事务，回调里再调 runAtomic 不会被拒绝；types:runAtomic「不允许嵌套……实现必须拒绝」',
    },
  ],
})

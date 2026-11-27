// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <10s]
//
// Issue #986 阶段一 · 第 1/2/3 项：**破坏性动作的前置判定只有一处，且「查不出来」不允许动手。**
//
// 修复前的两处真实缺口（都在「主库文件在不在」这一步）：
//
//   state.ts:      `await deps.sqliteFileExists().catch(() => true)`
//   orchestrator:  `await deps.sqliteFileExists().catch(() => true)`
//
// 检查**自己失败**时按「文件在」处理 → 仍然 `openSqlite()` → 而驱动会为不存在的库**创建空库**
// （`state.ts` 里 `readSqliteWitness` 的注释就是这么写的）→ 探针读回「没有 committed_at、
// 没有业务数据」→ 下游据此判定「干净、可以清」。也就是说：**一次失败的检查，自己造出了
// 允许破坏性动作的那条证据。** 空库还会污染下一次冷启动（见证人从「没有库」变成「空库」）。
//
// 本文件钉的是运行期事实，不是源码文本：
//   ① 三态读法：抛错 = `unknown`，绝不折成 present/absent；
//   ② 四类破坏性动作（迁移 / 清库 / 切换 / 恢复）在 `unknown` 下**全部**不放行；
//   ③ 走到 `unknown` 时**主库文件根本没被创建**（这才是上面那条链条的断点）、IDB 源一个字节没动、
//      状态文件没被写、`clearAll` 一次都没发生；
//   ④ 写侧：缓存里过期的 `indexeddb` 结论不再被信任 —— 已提交的库不会被当成 IDB 写。
//
//   node --test tests/unit/storage-presence-986.test.mjs
//   node tests/run-layer.mjs unit --only storage-presence-986
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { afterEach, test } from 'node:test'

import { loadTsModule } from '../helpers/dom-env.mjs'
import {
  createTarget,
  mainRows,
  makeEnv,
  makeRuntime,
  mods,
  snapshotOf,
} from '../helpers/migration-switch/kit.mjs'

const presence = mods.presence
const storage = await loadTsModule('src/services/storage/index.ts')
const runtimeMod = await loadTsModule('src/services/storage/migration/runtime.ts')
const fsIndex = await loadTsModule('src/services/fs/index.ts')

const ACTIONS = ['migrate', 'clear', 'switch', 'restore']

let env
const setup = (options) => {
  env = makeEnv(options)
  fsIndex.setFsForTests(env.fs)
  return env
}
afterEach(() => {
  runtimeMod.configureStorageRuntime(undefined)
  runtimeMod.setMigrationRunning(false)
  storage.setStorageForTests(null)
  fsIndex.setFsForTests(undefined)
  env?.cleanup()
  env = undefined
})

/** 一个「查不出来的文件系统」：`sqliteFileExists` 自己抛错（原生桥掉了 / 权限变了 / 通道断了）。 */
const brokenPresence = () => async () => {
  throw new Error('Filesystem plugin unavailable')
}
/** 按顺序给答案的桩：第 n 次调用返回/抛出第 n 项（用来看「中途才坏」会发生什么）。 */
const presenceSeq = (steps) => {
  let i = 0
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)]
    i += 1
    if (step === 'unknown') {
      throw new Error('Filesystem plugin unavailable')
    }
    return step === 'present'
  }
}

// ============================================================ ① 三态读法（纯函数）

test('① 读存在性：抛错 = unknown（绝不折成 present / absent）', async () => {
  assert.equal(await presence.readFilePresence(async () => true), 'present')
  assert.equal(await presence.readFilePresence(async () => false), 'absent')
  assert.equal(await presence.readFilePresence(brokenPresence()), 'unknown')
  // 没接线：生产接线的**声明值**（原生插件没有 exists，`wiring.ts` 恒报「在」），不是「失败被当成在」
  assert.equal(await presence.readFilePresence(undefined), 'present')
})

test('② 四类破坏性动作在 unknown 下全部不放行；present / absent 的口径完全相同', () => {
  for (const action of ACTIONS) {
    const unknown = presence.judgeMainDbTouch('unknown', action)
    assert.equal(unknown.allow, false, `${action}: unknown 必须停下来`)
    assert.equal(unknown.reason, 'presence-unknown')
    assert.match(
      unknown.detail,
      new RegExp(presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL, 'u'),
      `${action}: 详情可归因`
    )
    // 只有 present / absent 会被放行，且放行结论里**不携带** unknown（类型层同一条纪律）
    for (const fact of ['present', 'absent']) {
      const verdict = presence.judgeMainDbTouch(fact, action)
      assert.equal(verdict.allow, true, `${action}: ${fact} 允许继续`)
      assert.equal(verdict.presence, fact)
    }
  }
})

test('② assertNever：新增一种结论却没人判 → 运行期也不放行（编译期同一条）', () => {
  assert.throws(() => presence.assertNever('fourth-state'), /unhandled case/u)
})

// ============================================================ ③ 迁移：查不出来就不动手

test('③ 存在性检查抛错 → 迁移 blocked，且主库文件**根本没被创建**', async () => {
  const e = setup()
  const before = await snapshotOf(e.source)
  const result = await mods.orchestrator.runMigration(
    e.deps({ sqliteFileExists: brokenPresence() })
  )
  assert.equal(result.status, 'blocked', '不是 failed、更不是 migrated')
  assert.equal(result.detail, presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL)
  // 这一条是整个单子的核心：旧代码 `.catch(() => true)` 会走到 openSqlite，把空库造出来
  assert.equal(existsSync(e.mainPath), false, '一次失败的检查不得造出一个空库')
  assert.deepEqual(await snapshotOf(e.source), before, 'IDB 源一个字节都没动')
  assert.equal(await e.readState(), undefined, '状态文件没被写（下次冷启动不会被这次污染）')
})

test('③ 中途才查不出来（第二次探测抛错）→ 仍然 blocked，clearAll 一次都没发生', async () => {
  const e = setup()
  const cleared = []
  const deps = e.deps({
    // 1: 读见证人（absent）→ 2: 入口探针（absent）→ 3: 准备复制前的探测（present）→ 4: 清库前复核（查不出来）
    sqliteFileExists: presenceSeq(['absent', 'absent', 'present', 'unknown']),
    createTarget: async (db) => {
      const target = await createTarget(db)
      return {
        source: target.source,
        sink: {
          ...target.sink,
          clearAll: async () => {
            cleared.push('clearAll')
            await target.sink.clearAll()
          },
        },
      }
    },
  })
  const result = await mods.orchestrator.runMigration(deps)
  assert.equal(result.status, 'blocked')
  assert.match(result.detail, new RegExp(presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL, 'u'))
  assert.deepEqual(cleared, [], '「不知道库在不在」时绝不清空（openSqlite 会创建空库）')
})

test('③ 恢复：查不出来 → ok:false / presence-unknown，主库内容一行都没动', async () => {
  const e = setup()
  assert.equal((await mods.orchestrator.runMigration(e.deps())).status, 'committed')
  const backup = (await e.readState()).backup
  const before = await mainRows(e)
  const result = await mods.backup.restoreFromBackup(
    e.deps({ sqliteFileExists: brokenPresence() }),
    { confirmed: true, backup }
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'presence-unknown')
  assert.match(result.detail, new RegExp(presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL, 'u'))
  assert.deepEqual(await mainRows(e), before, '恢复被拦下时主库一行都没动')
})

test('③ 切换（写 committed_at）前查不出来 → blocked，真源没有被切过去', async () => {
  const e = setup()
  // 前三次探测都是「文件不存在」（读见证人 / 入口探针 / 准备复制前），第四次是提交前的切换复核
  const result = await mods.orchestrator.runMigration(
    e.deps({ sqliteFileExists: presenceSeq(['absent', 'absent', 'absent', 'unknown']) })
  )
  assert.equal(result.status, 'blocked', '切换是四类破坏性动作之一，未知时不许切')
  assert.match(result.detail, new RegExp(presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL, 'u'))
  const state = await e.readState()
  assert.notEqual(state.phase, 'committed', '状态文件不许写成已提交')
  const main = await e.openSqlite({ name: mods.config.MAIN_DB_NAME })
  const committed = await main.all("SELECT value FROM meta WHERE key='committed_at'")
  await main.close()
  assert.deepEqual(committed, [], '库里的 committed_at 也没写：真源仍然是 IDB')
})

// ============================================================ ③ 路由：未知不许被当成「可以回退 IDB」
test('③ 已提交（状态文件 committed + 库里有 committed_at）+ 查不出来 → blocked，不回退 IDB', async () => {
  const e = setup()
  const { db } = await e.mainTarget()
  await db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    'committed_at',
    '1700000000000',
  ])
  await db.close()
  await e.writeState({ phase: 'committed', sourceFingerprint: 'fp-1' })
  const choice = await mods.router.resolveStorageEngine(
    e.routerDeps({ sqliteFileExists: brokenPresence() })
  )
  assert.equal(choice.engine, 'blocked', '已提交的用户绝不能被送回冻结的旧 IDB 快照')
  assert.equal(choice.detail, presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL)
})

test('③ 全新安装（没有状态文件）+ 查不出来 → 同样 blocked（宁可停在闸门页，不猜）', async () => {
  const e = setup()
  const choice = await mods.router.resolveStorageEngine(
    e.routerDeps({ sqliteFileExists: brokenPresence() })
  )
  assert.equal(choice.engine, 'blocked')
  assert.equal(choice.detail, presence.MAIN_DB_PRESENCE_UNKNOWN_DETAIL)
  assert.equal(existsSync(e.mainPath), false)
})

// ============================================================ ④ 写侧：过期的 indexeddb 结论不再被信任

test('④ 缓存说 indexeddb、但库已提交 → getStorage() 给的是 SQLite 后端（不往旧快照里写）', async () => {
  const e = setup()
  const { db } = await e.mainTarget()
  await db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    'committed_at',
    '1700000000000',
  ])
  await db.close()
  await e.writeState({ phase: 'committed', sourceFingerprint: 'fp-1' })
  const marker = {
    __kind: 'sqlite',
    __marker: 'sqlite-opened',
    close: async () => {},
    health: async () => ({}),
    probe: async () => ({}),
  }
  runtimeMod.configureStorageRuntime(makeRuntime(e, { openSqliteBackend: async () => marker }))
  // 模拟「上一次判定的那一刻」：迁移还没提交，于是缓存了 indexeddb
  runtimeMod.setEngineChoice({ engine: 'indexeddb', reason: 'native-not-ready' })
  const backend = await storage.getStorage()
  assert.equal(backend.__marker, 'sqlite-opened', '写库之前必须重新问一遍路由，命中的是 sqlite')
})

test('④ 缓存说 sqlite → 直接复用（不为每次写都重跑一遍路由）', async () => {
  const e = setup()
  const marker = {
    __kind: 'sqlite',
    __marker: 'sqlite-opened',
    close: async () => {},
    health: async () => ({}),
    probe: async () => ({}),
  }
  let opened = 0
  runtimeMod.configureStorageRuntime(
    makeRuntime(e, {
      openSqliteBackend: async () => {
        opened += 1
        return marker
      },
    })
  )
  runtimeMod.setEngineChoice({ engine: 'sqlite' })
  assert.equal((await storage.getStorage()).__marker, 'sqlite-opened')
  assert.equal((await storage.getStorage()).__marker, 'sqlite-opened', '同一条结论第二次直接复用')
  assert.equal(opened, 1, '不重新打开后端')
})

test('④ 缓存说 indexeddb、库其实不存在（全新安装）→ 仍然走 IDB，不误判成 sqlite', async () => {
  const e = setup()
  runtimeMod.configureStorageRuntime(makeRuntime(e, { sqliteFileExists: async () => false }))
  runtimeMod.setEngineChoice({ engine: 'indexeddb', reason: 'web' })
  // 裸 Node 里没有 indexedDB：走 IDB 打开器必然失败，但**不能**是 StorageEngineBlockedError
  // （那说明我们把它误判成「已提交」而拦住了合法的新装用户）
  await assert.rejects(
    () => storage.getStorage(),
    (error) => error.name !== 'StorageEngineBlockedError'
  )
})

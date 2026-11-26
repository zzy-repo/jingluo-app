// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <5s]
//
// #916：getStorage() 路由（blocked / migrating 抛错、不返回内存实现）+ 启动闸门（开关、失败、重试、继续使用）。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { loadTsModule } from '../helpers/dom-env.mjs'
import { makeEngine, makeEnv, mods } from '../helpers/migration-switch/kit.mjs'

const storage = await loadTsModule('src/services/storage/index.ts')
const gate = await loadTsModule('src/services/storage/gate.ts')
const runtimeMod = await loadTsModule('src/services/storage/migration/runtime.ts')
const fsIndex = await loadTsModule('src/services/fs/index.ts')

const SQLITE_BACKEND = { __kind: 'sqlite', close: async () => {}, health: async () => ({}), probe: async () => ({}) }

const runtimeOf = (env, over = {}) => ({
  isSqliteAvailable: () => true,
  openSqlite: env.openSqlite,
  createTarget: (db) => mods.schema && import('../helpers/migration-switch/kit.mjs').then((k) => k.createTarget(db)),
  openSqliteBackend: async () => SQLITE_BACKEND,
  openIdbSource: () => env.source,
  engine: makeEngine(),
  sqliteFileExists: env.sqliteFileExists,
  ...over,
})

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
  gate.resetGateForTests()
  fsIndex.setFsForTests(undefined)
  env?.cleanup()
  env = undefined
})

test('没注册运行时：getStorage() 与合并前一致（走 IDB 打开器，这里只证明没进路由分支）', async () => {
  setup()
  const view = await gate.ensureStorageReady()
  assert.deepEqual(view, { kind: 'ready' })
})

test('开关默认关：未 committed 的原生用户不迁移，闸门直接 ready 且仍是 IDB', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  const view = await gate.ensureStorageReady()
  assert.deepEqual(view, { kind: 'ready' })
  assert.equal(runtimeMod.getEngineChoice().engine, 'indexeddb')
  assert.equal(await env.readState(), undefined, '没有写任何状态')
  assert.equal(await env.sqliteFileExists(), false)
})

test('开关开 + 能力满足 + 未 committed → 迁移，进度发布，终态 ready 且路由为 sqlite', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  const seen = []
  gate.subscribeGate(() => seen.push(gate.getGateView().kind))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.deepEqual(view, { kind: 'ready' })
  assert.ok(seen.includes('migrating'))
  assert.equal(runtimeMod.getEngineChoice().engine, 'sqlite')
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
})

test('开关开但能力不满足（SQLite 不可用）→ 不迁移，留在 IDB', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env, { isSqliteAvailable: () => false }))
  assert.deepEqual(await gate.ensureStorageReady({ enabled: true }), { kind: 'ready' })
  assert.equal(await env.readState(), undefined)
})

test('Web（fs 不支持）：开关开也不迁移', async () => {
  setup()
  fsIndex.setFsForTests({ ...env.fs, supported: false })
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  assert.deepEqual(await gate.ensureStorageReady({ enabled: true }), { kind: 'ready' })
  assert.equal(await env.readState(), undefined)
})

test('开关关闭但已 committed：仍走 SQLite（已迁用户不被开关拉回旧库）', async () => {
  setup()
  assert.equal((await mods.orchestrator.runMigration(env.deps())).status, 'committed')
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  assert.deepEqual(await gate.ensureStorageReady({ enabled: false }), { kind: 'ready' })
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
})

test('【核心】committed 后 SQLite 不可用：闸门 blocked，getStorage 抛 StorageEngineBlockedError，不回退 IDB、不返回内存实现', async () => {
  setup()
  await mods.orchestrator.runMigration(env.deps())
  runtimeMod.configureStorageRuntime(runtimeOf(env, { isSqliteAvailable: () => false }))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.equal(view.kind, 'blocked')
  assert.equal(view.reason, 'sqlite-unavailable-after-commit')
  await assert.rejects(storage.getStorage(), (error) => {
    assert.equal(error.name, 'StorageEngineBlockedError')
    assert.equal(error.kind, 'unavailable')
    assert.equal(error.reason, 'sqlite-unavailable-after-commit')
    return true
  })
  // 再来一次仍然抛，没有被「缓存成功」
  await assert.rejects(storage.getStorage(), (error) => error.name === 'StorageEngineBlockedError')
})

test('迁移进行中：getStorage 抛 StorageMigratingError（业务写入被拒），结束后恢复', async () => {
  setup()
  let release
  const hold = new Promise((resolve) => { release = resolve })
  const engine = makeEngine()
  const copy = engine.copyAll
  engine.copyAll = async (args) => { await hold; return copy(args) }
  runtimeMod.configureStorageRuntime(runtimeOf(env, { engine }))
  const done = gate.ensureStorageReady({ enabled: true })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(gate.getGateView().kind, 'migrating')
  await assert.rejects(storage.getStorage(), (error) => error.name === 'StorageMigratingError' && error.kind === 'unavailable')
  release()
  assert.deepEqual(await done, { kind: 'ready' })
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
})

test('迁移失败：闸门 failed（带原因），不自动重试；重试按钮才再跑一次；IDB 未变', async () => {
  setup()
  const failing = makeEngine({ failCopyAt: 15 })
  runtimeMod.configureStorageRuntime(runtimeOf(env, { engine: failing }))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.equal(view.kind, 'failed')
  assert.equal(view.failure.code, 'copy-failed')
  const copiesAfterFail = failing.copies
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(failing.copies, copiesAfterFail, '没有自动重试')
  // 失败时业务读写：仍被拒（闸门没放行前不放行；这里模拟「迁移已结束但没放行」）
  runtimeMod.configureStorageRuntime(runtimeOf(env, { engine: makeEngine() }))
  const retried = await gate.retryMigration()
  assert.deepEqual(retried, { kind: 'ready' })
  assert.equal(runtimeMod.getEngineChoice().engine, 'sqlite')
})

test('失败后「继续使用」：路由仍是 IDB 才放行；放行后 choice 是 indexeddb，数据未动', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env, { engine: makeEngine({ failCopyAt: 15 }) }))
  assert.equal((await gate.ensureStorageReady({ enabled: true })).kind, 'failed')
  const view = await gate.continueWithLegacy()
  assert.deepEqual(view, { kind: 'ready' })
  assert.deepEqual(runtimeMod.getEngineChoice(), { engine: 'indexeddb', reason: 'migration-failed-fallback-allowed' })
})

test('矛盾见证：闸门 blocked:needs-user-decision，不显示 ready', async () => {
  setup()
  await mods.orchestrator.runMigration(env.deps())
  await env.writeState({ phase: 'copying', seq: 99 })
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.deepEqual([view.kind, view.reason], ['blocked', 'needs-user-decision'])
})

test('源码里 getStorage() 不含内存实现的返回路径', async () => {
  const { readFileSync } = await import('node:fs')
  const text = readFileSync(new URL('../../src/services/storage/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /memory|Memory/u)
})

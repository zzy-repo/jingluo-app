// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <5s]
//
// #916：getStorage() 路由（blocked / migrating 抛错、不返回内存实现）+ 启动闸门（开关、失败、重试、继续使用）。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { setupDom, loadTsModule } from '../helpers/dom-env.mjs'
import { makeEngine, makeEnv, mods } from '../helpers/migration-switch/kit.mjs'

// 本文件守的是「开关值只能被有意识地改动」。
// main 上必须是 false（合并不改变线上行为）：本 PR 把内测分支的交互补全搬进 main，
// 但迁移开关保持关闭，只有内测 APK 分支才是 true。
// 任何人翻转 config.ts 时必须同步来这里翻转 EXPECTED_SWITCH，
// 这就是双写校验的意义：让"无意翻转"变红，让"有意翻转"留下痕迹。
const EXPECTED_SWITCH = false // ← main 口径：不向全量用户开启迁移（内测分支为 true）

// 路由结论从 EXPECTED_SWITCH 派生，不写死 'sqlite' / 'indexeddb'：
// 开关开 = 会启动迁移 → 迁移成功后走 sqlite；开关关 = 不迁移 → 留在 indexeddb。
// 这样本条在 main（false）与本分支（true）都成立，且真正验证的是「闸门是否迁移跟随开关」。
const EXPECTED_ENGINE = EXPECTED_SWITCH ? 'sqlite' : 'indexeddb'

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

test('闸门跟随开关常量（防无意翻转）：未 committed 的原生用户，开关开则迁移（成功提示 succeeded，确认后 ready）且路由 sqlite；开关关则不迁移且仍是 IDB', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  const view = await gate.ensureStorageReady() // 不传 enabled：闸门读的正是 config 里的开关常量
  assert.equal(runtimeMod.getEngineChoice().engine, EXPECTED_ENGINE)
  if (EXPECTED_SWITCH) {
    // 开关开 = 正式迁移：终态是「成功提示」而不是静默 ready —— 真源已定 sqlite，用户确认后才进 App。
    assert.deepEqual(view, { kind: 'succeeded' })
    // succeeded 只可能来自 orchestrated 的 committed（真校验通过），所以状态必须是 committed
    assert.equal((await env.readState())?.phase, 'committed')
    assert.equal(await env.sqliteFileExists(), true)
    assert.deepEqual(gate.acknowledgeGateNotice(), { kind: 'ready' })
    assert.equal(runtimeMod.getEngineChoice().engine, 'sqlite', '确认只放行，不改真源')
  } else {
    assert.deepEqual(view, { kind: 'ready' })
    assert.equal(await env.readState(), undefined, '没有写任何状态')
    assert.equal(await env.sqliteFileExists(), false)
  }
})

test('负向对照：显式 enabled:false 时即使开关常量为开，闸门也不启动迁移（关闭路径不随分支消失）', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  assert.deepEqual(await gate.ensureStorageReady({ enabled: false }), { kind: 'ready' })
  assert.equal(runtimeMod.getEngineChoice().engine, 'indexeddb')
  assert.equal(await env.readState(), undefined, '没有写任何状态')
  assert.equal(await env.sqliteFileExists(), false)
})

test('开关开 + 能力满足 + 未 committed → 迁移，进度发布，终态 succeeded（确认后 ready），路由 sqlite', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  const seen = []
  gate.subscribeGate(() => seen.push(gate.getGateView().kind))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.deepEqual(view, { kind: 'succeeded' })
  assert.ok(seen.includes('migrating'), '迁移过程要发布过 migrating')
  assert.ok(seen.includes('succeeded'), '成功也要发布一次该状态（UI 靠它显示「已完成」）')
  assert.equal((await env.readState())?.phase, 'committed', 'succeeded 只在真提交之后')
  assert.equal(runtimeMod.getEngineChoice().engine, 'sqlite')
  assert.equal((await storage.getStorage()).__kind, 'sqlite', '提示态也已是 sqlite 真源，不等确认')
  assert.deepEqual(gate.acknowledgeGateNotice(), { kind: 'ready' })
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
})

test('空间不足 → failed 带 insufficient-space 与判定当时的 need/have；空间够了之后 recheckStorage 重新检测即成功', async () => {
  setup({ freeBytes: 1 })
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  const failed = await gate.ensureStorageReady({ enabled: true })
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.failure.code, 'insufficient-space')
  assert.equal(failed.space?.freeBytes, 1, '可用空间取判定那一刻的数（失败后不重读磁盘）')
  assert.equal(typeof failed.space?.requiredBytes, 'number')
  assert.ok(failed.space.requiredBytes > failed.space.freeBytes, '所需必须大于可用，否则不会是这个失败码')
  assert.equal((await env.readState())?.phase, 'failed', '失败落状态，IDB 未变')

  // 「重新检测」不是失败重试：清掉本次判定缓存后重走路由 + 预检（换一个空间够的环境，模拟清理后重启）
  const roomy = makeEnv()
  try {
    fsIndex.setFsForTests(roomy.fs)
    runtimeMod.configureStorageRuntime(runtimeOf(roomy))
    assert.deepEqual(await gate.recheckStorage(), { kind: 'succeeded' })
    assert.equal((await roomy.readState())?.phase, 'committed')
  } finally {
    roomy.cleanup()
  }
})

test('开关开但能力不满足（SQLite 不可用）→ 不迁移，先明确告知一次（unsupported），确认后 ready 且仍是 IDB', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env, { isSqliteAvailable: () => false }))
  const view = await gate.ensureStorageReady({ enabled: true })
  assert.deepEqual(view, { kind: 'unsupported' })
  assert.equal(runtimeMod.getEngineChoice().engine, 'indexeddb')
  assert.equal(await env.readState(), undefined, '没有写任何状态')
  assert.deepEqual(gate.acknowledgeGateNotice(), { kind: 'ready' })
  assert.equal(runtimeMod.getEngineChoice().engine, 'indexeddb')
  assert.equal(await env.sqliteFileExists(), false, '确认后照旧用 IndexedDB，不建库')
})

test('unsupported 只提示一次：确认时写 localStorage 标记，下一次冷启动据此直接 ready（不拦人）', async () => {
  const dom = setupDom()
  const KEY = 'chat-demo:storage-gate:unsupported-ack'
  try {
    setup()
    runtimeMod.configureStorageRuntime(runtimeOf(env, { isSqliteAvailable: () => false }))
    assert.deepEqual(await gate.ensureStorageReady({ enabled: true }), { kind: 'unsupported' })
    assert.equal(dom.localStorage.getItem(KEY), null, '确认之前不写标记')
    gate.acknowledgeGateNotice()
    assert.equal(dom.localStorage.getItem(KEY), '1')
    // 下一次冷启动：进程内判定缓存清掉（resetGateForTests 连标记一起清），把上次留下的标记补回来
    gate.resetGateForTests()
    dom.localStorage.setItem(KEY, '1')
    assert.deepEqual(await gate.ensureStorageReady({ enabled: true }), { kind: 'ready' }, '提示过一次就不再拦人')
    assert.equal(runtimeMod.getEngineChoice().engine, 'indexeddb')
    assert.equal(await env.readState(), undefined)
  } finally {
    dom.restore()
  }
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

test('迁移进行中：getStorage 抛 StorageMigratingError（业务写入被拒），结束后 succeeded 并恢复 sqlite', async () => {
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
  assert.deepEqual(await done, { kind: 'succeeded' })
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
  assert.deepEqual(gate.acknowledgeGateNotice(), { kind: 'ready' })
  assert.equal((await storage.getStorage()).__kind, 'sqlite', '确认只放行，路由不退回 IDB')
})

test('迁移失败：闸门 failed（带原因），不自动重试；重试按钮才再跑一次（成功 → succeeded），IDB 未变', async () => {
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
  assert.deepEqual(retried, { kind: 'succeeded' })
  assert.equal(runtimeMod.getEngineChoice().engine, 'sqlite')
  assert.deepEqual(gate.acknowledgeGateNotice(), { kind: 'ready' })
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

test('getStorage 自己的迁移防线独立成立：路由结论已缓存为 sqlite，迁移标记置位时仍抛 StorageMigratingError', async () => {
  setup()
  runtimeMod.configureStorageRuntime(runtimeOf(env))
  runtimeMod.setEngineChoice({ engine: 'sqlite' })
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
  storage.resetStorageRouting()
  runtimeMod.setMigrationRunning(true)
  await assert.rejects(storage.getStorage(), (error) => error.name === 'StorageMigratingError')
  runtimeMod.setMigrationRunning(false)
  assert.equal((await storage.getStorage()).__kind, 'sqlite')
})

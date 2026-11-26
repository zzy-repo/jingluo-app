// [layer: unit | 依赖: fake-indexeddb + node:sqlite + 内存 FS | 耗时: <5s]
//
// #916：IDB v16 防降级屏障（用户条件批准，#916 评论 7196902445）。
//   ① 真实现 legacyBarrier.ts：空升级、不动数据、幂等、可再次打开；静态断言无 delete/clear；
//   ② 触发条件：只在「开关开 + 校验通过」的正式迁移里调用；开关关闭/未校验/普通启动一律不调用（负向对照）；
//   ③ 失败处置：升版前强杀 / 升版后强杀 / 满盘 / 状态写入失败，重入继续，不回 idle，不在 SQLite 未校验时升版。
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { installFakeIdbGlobals, snapshotDatabase } from '../helpers/fake-idb.mjs'
import { loadTsModule } from '../helpers/dom-env.mjs'
import { killAt, makeEngine, makeEnv, mainRows, mods, snapshotOf } from '../helpers/migration-switch/kit.mjs'

installFakeIdbGlobals()
const barrier = await loadTsModule('src/services/storage/idb/legacyBarrier.ts')
const dbMod = await loadTsModule('src/services/chat/db.ts')
const gate = await loadTsModule('src/services/storage/gate.ts')
const runtimeMod = await loadTsModule('src/services/storage/migration/runtime.ts')
const fsIndex = await loadTsModule('src/services/fs/index.ts')

const NAME = 'legacy-barrier-probe'
const seed = async (version) => {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, version)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('byTitle', 'title')
      db.createObjectStore('files', { keyPath: 'id' })
    }
    req.onsuccess = () => {
      const tx = req.result.transaction(['sessions', 'files'], 'readwrite')
      tx.objectStore('sessions').put({ id: 's1', title: '一' })
      tx.objectStore('files').put({ id: 'f1', blob: new Blob(['abc'], { type: 'text/plain' }) })
      tx.oncomplete = () => {
        req.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}
const wipe = () => new Promise((resolve) => { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = r.onerror = r.onblocked = () => resolve() })

afterEach(async () => {
  await wipe()
  runtimeMod.configureStorageRuntime(undefined)
  runtimeMod.setMigrationRunning(false)
  gate.resetGateForTests()
  fsIndex.setFsForTests(undefined)
})

// ---------------------------------------------------------------- ① 真实现

test('屏障版本 = DB_VERSION + 1（现为 16）', () => {
  assert.equal(barrier.LEGACY_BARRIER_VERSION, dbMod.DB_VERSION + 1)
  assert.equal(barrier.LEGACY_BARRIER_VERSION, 16)
})

test('升到 16：库结构与全部数据逐字节不变，旧版本号再打开得 VersionError，当前版本可打开', async () => {
  await seed(dbMod.DB_VERSION)
  const before = await snapshotDatabase(NAME)
  await barrier.bumpLegacyIdbVersion(NAME)
  const after = await snapshotDatabase(NAME)
  assert.equal(before.version, dbMod.DB_VERSION)
  assert.equal(after.version, 16)
  assert.deepEqual({ ...after, version: 0 }, { ...before, version: 0 }, 'stores / data / indexes 完全不变')
  // 旧 APK 用 v15 打开：必须失败，而不是静默读过期数据
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, dbMod.DB_VERSION)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }),
    (error) => error.name === 'VersionError',
  )
})

test('幂等：重复调用（重入）不抛错，版本仍是 16，数据不变', async () => {
  await seed(dbMod.DB_VERSION)
  await barrier.bumpLegacyIdbVersion(NAME)
  const once = await snapshotDatabase(NAME)
  await barrier.bumpLegacyIdbVersion(NAME)
  assert.deepEqual(await snapshotDatabase(NAME), once)
})

test('静态断言：legacyBarrier.ts 不含任何删除/清空调用，升级回调为空', () => {
  const text = readFileSync(new URL('../../src/services/storage/idb/legacyBarrier.ts', import.meta.url), 'utf8')
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
  for (const forbidden of [/deleteDatabase/u, /deleteObjectStore/u, /\.clear\s*\(/u, /\.delete\s*\(/u, /createObjectStore/u, /createIndex/u, /\.put\s*\(/u, /\.add\s*\(/u]) {
    assert.doesNotMatch(code, forbidden)
  }
  assert.match(code, /onupgradeneeded\s*=\s*\(\)\s*=>\s*\{\s*\}/u, '升级回调必须为空')
})

// ---------------------------------------------------------------- ② 触发条件（负向对照）

test('未注入 bump（默认）：完整迁移不调用任何屏障，状态里也没有屏障子步骤', async () => {
  const env = makeEnv()
  try {
    assert.equal((await mods.orchestrator.runMigration(env.deps())).status, 'committed')
    assert.equal((await env.readState()).legacyBarrier, undefined)
  } finally {
    env.cleanup()
  }
})

test('【负向对照】校验未通过：不调用 bump（SQLite 未校验时不得升版）', async () => {
  for (const engine of [makeEngine({ failVerify: true }), makeEngine({ failCopyAt: 15 })]) {
    const env = makeEnv()
    try {
      let calls = 0
      const result = await mods.orchestrator.runMigration(env.deps({ engine, bumpLegacyIdbVersion: async () => { calls += 1 } }))
      assert.equal(result.status, 'failed')
      assert.equal(calls, 0)
    } finally {
      env.cleanup()
    }
  }
})

test('【负向对照】预检拒绝（空间不足 / freeBytes 未知 / 超硬上界）：不调用 bump', async () => {
  for (const options of [{ freeBytes: 1 }, { freeBytes: null }, { bytes: mods.limits.LIMITS.storageMigration.maxBytes + 1 }]) {
    const env = makeEnv(options)
    try {
      let calls = 0
      const result = await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: async () => { calls += 1 } }))
      assert.equal(result.status, 'failed')
      assert.equal(calls, 0)
    } finally {
      env.cleanup()
    }
  }
})

test('【负向对照】完整性/计数复核在升版之前：meta 前的复核失败不会升版', async () => {
  const env = makeEnv()
  try {
    let calls = 0
    const deps = env.deps({
      bumpLegacyIdbVersion: async () => { calls += 1 },
      openSqlite: async (o) => {
        const db = await env.openSqlite(o)
        return o.name === mods.config.MAIN_DB_NAME ? { ...db, integrityCheck: async () => ['*** in database main *** page 3 corrupt'] } : db
      },
    })
    assert.equal((await mods.orchestrator.runMigration(deps)).status, 'failed')
    assert.equal(calls, 0)
  } finally {
    env.cleanup()
  }
})

const gateRuntime = (env, bump) => ({
  isSqliteAvailable: () => true,
  openSqlite: env.openSqlite,
  createTarget: async (db) => (await import('../helpers/migration-switch/kit.mjs')).createTarget(db),
  openSqliteBackend: async () => ({ __kind: 'sqlite' }),
  openIdbSource: () => env.source,
  engine: makeEngine(),
  sqliteFileExists: env.sqliteFileExists,
  bumpLegacyIdbVersion: bump,
})

test('【负向对照】开关关闭（默认）：启动闸门不跑迁移，bump 不会被调用', async () => {
  const env = makeEnv()
  try {
    fsIndex.setFsForTests(env.fs)
    let calls = 0
    runtimeMod.configureStorageRuntime(gateRuntime(env, async () => { calls += 1 }))
    assert.equal(mods.config.NATIVE_SQLITE_MIGRATION_ENABLED, false)
    assert.deepEqual(await gate.ensureStorageReady(), { kind: 'ready' })
    assert.equal(calls, 0)
    assert.equal(await env.readState(), undefined)
  } finally {
    env.cleanup()
  }
})

test('【负向对照】开关关闭 + 已 committed（普通应用更新）：不调用 bump', async () => {
  const env = makeEnv()
  try {
    fsIndex.setFsForTests(env.fs)
    await mods.orchestrator.runMigration(env.deps())
    let calls = 0
    runtimeMod.configureStorageRuntime(gateRuntime(env, async () => { calls += 1 }))
    await gate.ensureStorageReady({ enabled: false })
    assert.equal(calls, 0)
  } finally {
    env.cleanup()
  }
})

test('开关开 + 校验通过：闸门经 runtime 注入的 bump 被调用恰好一次，且在 SQLite meta 之前', async () => {
  const env = makeEnv()
  try {
    fsIndex.setFsForTests(env.fs)
    const log = []
    runtimeMod.configureStorageRuntime(gateRuntime(env, async () => {
      const { db } = await env.mainTarget()
      log.push(`bump meta-rows=${(await db.all('SELECT key FROM meta')).length} state=${(await env.readState()).phase}`)
      await db.close()
    }))
    assert.deepEqual(await gate.ensureStorageReady({ enabled: true }), { kind: 'ready' })
    assert.deepEqual(log, ['bump meta-rows=0 state=verified'])
  } finally {
    env.cleanup()
  }
})

// ---------------------------------------------------------------- ③ 失败处置

test('升版前强杀（started 已写 / 未写）：重入从提交步继续，不回 idle，不重复复制', async () => {
  const env = makeEnv()
  try {
    let calls = 0
    const bump = async () => { calls += 1 }
    const probe = killAt()
    const scratch = makeEnv()
    await mods.orchestrator.runMigration(scratch.deps({ hooks: probe.hooks, bumpLegacyIdbVersion: bump }))
    scratch.cleanup()
    const at = probe.state.names.indexOf('legacy-started') + 1
    await assert.rejects(mods.orchestrator.runMigration(env.deps({ hooks: killAt(at).hooks, bumpLegacyIdbVersion: bump })))
    const mid = await env.readState()
    assert.equal(mid.phase, 'verified')
    assert.equal(mid.legacyBarrier, 'started')
    const eng = makeEngine()
    assert.equal((await mods.orchestrator.runMigration(env.deps({ engine: eng, bumpLegacyIdbVersion: bump }))).status, 'committed')
    assert.equal(eng.copies, 0)
  } finally {
    env.cleanup()
  }
})

test('升版后、committed 前强杀：状态记着 done，重入不再升版，直接写 meta 与 committed', async () => {
  const env = makeEnv()
  try {
    const scratch = makeEnv()
    const probe = killAt()
    await mods.orchestrator.runMigration(scratch.deps({ hooks: probe.hooks, bumpLegacyIdbVersion: async () => {} }))
    scratch.cleanup()
    const at = probe.state.names.indexOf('legacy-done') + 1
    await assert.rejects(mods.orchestrator.runMigration(env.deps({ hooks: killAt(at).hooks, bumpLegacyIdbVersion: async () => {} })))
    assert.equal((await env.readState()).legacyBarrier, 'done')
    let calls = 0
    assert.equal((await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: async () => { calls += 1 } }))).status, 'committed')
    assert.equal(calls, 0)
    assert.equal(await mainRows(env), await snapshotOf(env.source))
  } finally {
    env.cleanup()
  }
})

test('升版时满盘（ENOSPC 类错误）：不写 meta/committed，不写 failed，状态停在 verified；重入成功', async () => {
  const env = makeEnv()
  try {
    let full = true
    const bump = async () => { if (full) { const e = new Error('QuotaExceededError'); e.kind = 'quota'; throw e } }
    const first = await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: bump }))
    assert.equal(first.status, 'failed')
    const mid = await env.readState()
    assert.equal(mid.phase, 'verified')
    assert.equal(mid.legacyBarrier, 'started')
    const { db } = await env.mainTarget()
    assert.equal((await db.all('SELECT key FROM meta')).length, 0)
    await db.close()
    full = false
    assert.equal((await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: bump }))).status, 'committed')
  } finally {
    env.cleanup()
  }
})

test('状态写入失败（写 started 时）：未升版，不调用 bump；落 failed 或停在 verified 都可重入', async () => {
  const env = makeEnv()
  try {
    let calls = 0
    const bump = async () => { calls += 1 }
    const hooks = { boundary: (name) => { if (name === 'enter:commit') env.fs.injectEnospc() } }
    const first = await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: bump, hooks }))
    assert.equal(first.status, 'failed')
    assert.equal(calls, 0, '状态没落盘就不得升版')
    assert.equal((await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: bump }))).status, 'committed')
    assert.equal(calls, 1)
  } finally {
    env.cleanup()
  }
})

test('状态写入失败（写 done 时）：版本已升，不写 failed、不回 idle；重入补 done 后提交', async () => {
  const env = makeEnv()
  try {
    let calls = 0
    const bump = async () => { calls += 1 }
    const hooks = { boundary: (name) => { if (name === 'legacy-started') env.fs.injectEnospc() } }
    const first = await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: bump, hooks }))
    assert.equal(first.status, 'failed')
    assert.equal((await env.readState()).phase, 'verified')
    assert.equal((await env.readState()).legacyBarrier, 'started')
    const eng = makeEngine()
    assert.equal((await mods.orchestrator.runMigration(env.deps({ bumpLegacyIdbVersion: bump, engine: eng }))).status, 'committed')
    assert.equal(eng.copies, 0)
  } finally {
    env.cleanup()
  }
})

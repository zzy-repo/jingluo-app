// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <5s]
//
// #916：真源路由。committed 后 SQLite 不可用必须 blocked 而不是回退 IDB；开关关闭时已 committed 仍走 SQLite。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEnv, mods } from '../helpers/migration-switch/kit.mjs'

// 本文件守的是「开关值只能被有意识地改动」。
// main 上必须是 false（合并不改变线上行为）；本分支 release/v2.0.1-internal
// 为内测真机验证有意开启为 true。任何人翻转 config.ts 时必须同步来这里翻转 EXPECTED_SWITCH，
// 这就是双写校验的意义：让"无意翻转"变红，让"有意翻转"留下痕迹。
const EXPECTED_SWITCH = true // ← 本分支 release/v2.0.1-internal

const { resolveStorageEngine } = mods.router

const withEnv = async (options, body) => {
  const env = makeEnv(options)
  try {
    await body(env)
  } finally {
    env.cleanup()
  }
}
const migrated = async (env) => {
  const r = await mods.orchestrator.runMigration(env.deps())
  assert.equal(r.status, 'committed')
}

test('Web（fs 不支持）→ indexeddb:web，不看 SQLite', async () => {
  await withEnv({}, async (env) => {
    const fs = { ...env.fs, supported: false }
    const choice = await resolveStorageEngine(env.routerDeps({ fs, isSqliteAvailable: () => { throw new Error('不该被调用') } }))
    assert.deepEqual(choice, { engine: 'indexeddb', reason: 'web' })
  })
})

test('原生但 SQLite 不可用、从未迁移 → indexeddb:native-not-ready', async () => {
  await withEnv({}, async (env) => {
    assert.deepEqual(await resolveStorageEngine(env.routerDeps({ isSqliteAvailable: () => false })), { engine: 'indexeddb', reason: 'native-not-ready' })
  })
})

test('从未迁移、SQLite 可用 → 仍是 IDB（不会为了看一眼而创建空库）', async () => {
  await withEnv({}, async (env) => {
    assert.deepEqual(await resolveStorageEngine(env.routerDeps()), { engine: 'indexeddb', reason: 'native-not-ready' })
    assert.equal(await env.sqliteFileExists(), false)
  })
})

test('committed + SQLite 正常 → sqlite', async () => {
  await withEnv({}, async (env) => {
    await migrated(env)
    assert.deepEqual(await resolveStorageEngine(env.routerDeps()), { engine: 'sqlite' })
  })
})

test('【核心】committed 后原生 SQLite 不可用 → blocked，绝不回退 IDB', async () => {
  await withEnv({}, async (env) => {
    await migrated(env)
    const choice = await resolveStorageEngine(env.routerDeps({ isSqliteAvailable: () => false }))
    assert.equal(choice.engine, 'blocked')
    assert.equal(choice.reason, 'sqlite-unavailable-after-commit')
    // isSqliteAvailable 抛错同样不回退
    const thrown = await resolveStorageEngine(env.routerDeps({ isSqliteAvailable: () => { throw new Error('x') } }))
    assert.equal(thrown.engine, 'blocked')
  })
})

test('【核心】committed 后库文件消失 / 打不开 → blocked，绝不回退 IDB', async () => {
  await withEnv({}, async (env) => {
    await migrated(env)
    const missing = await resolveStorageEngine(env.routerDeps({ sqliteFileExists: async () => false }))
    assert.deepEqual([missing.engine, missing.reason], ['blocked', 'sqlite-unavailable-after-commit'])
    const unopenable = await resolveStorageEngine(env.routerDeps({ openSqlite: async () => { throw new Error('SQLITE_CORRUPT') } }))
    assert.deepEqual([unopenable.engine, unopenable.reason], ['blocked', 'sqlite-unavailable-after-commit'])
  })
})

test('负向对照：未 committed 时同样的故障（SQLite 不可用）不会 blocked，而是留在 IDB', async () => {
  await withEnv({}, async (env) => {
    const choice = await resolveStorageEngine(env.routerDeps({ openSqlite: async () => { throw new Error('boom') } }))
    assert.equal(choice.engine, 'indexeddb')
  })
})

test('开关值与 EXPECTED_SWITCH 一致（防无意翻转），且开关取值不影响路由：已 committed 仍走 SQLite（路由不读开关；开关只管闸门是否启动迁移）', async () => {
  await withEnv({}, async (env) => {
    await migrated(env)
    assert.equal(mods.config.NATIVE_SQLITE_MIGRATION_ENABLED, EXPECTED_SWITCH)
    assert.deepEqual(await resolveStorageEngine(env.routerDeps()), { engine: 'sqlite' })
  })
})

test('状态文件缺失但 SQLite 已见证 → sqlite（以 SQLite 为真源）', async () => {
  await withEnv({}, async (env) => {
    await migrated(env)
    await env.fs.remove('storage-engine/state.json')
    assert.deepEqual(await resolveStorageEngine(env.routerDeps()), { engine: 'sqlite' })
  })
})

test('两处见证矛盾 → blocked:needs-user-decision', async () => {
  await withEnv({}, async (env) => {
    await migrated(env)
    await env.writeState({ phase: 'copying', seq: 50 })
    const choice = await resolveStorageEngine(env.routerDeps())
    assert.deepEqual([choice.engine, choice.reason], ['blocked', 'needs-user-decision'])
  })
})

test('状态文件损坏且无 SQLite 见证 → 仍是 IDB（idle）；损坏且 SQLite 已见证 → blocked', async () => {
  await withEnv({}, async (env) => {
    await env.fs.writeAtomic('storage-engine/state.json', 'garbage')
    assert.equal((await resolveStorageEngine(env.routerDeps())).engine, 'indexeddb')
    await migrated(env)
    await env.fs.writeAtomic('storage-engine/state.json', 'garbage')
    assert.equal((await resolveStorageEngine(env.routerDeps())).engine, 'blocked')
  })
})

test('migrating/failed 阶段：以 IDB 为真源', async () => {
  await withEnv({}, async (env) => {
    await env.writeState({ phase: 'copying', seq: 2 })
    assert.equal((await resolveStorageEngine(env.routerDeps())).engine, 'indexeddb')
    await env.writeState({ phase: 'failed', seq: 3, failure: { code: 'copy-failed', message: 'x', at: 1 } })
    assert.deepEqual(await resolveStorageEngine(env.routerDeps()), { engine: 'indexeddb', reason: 'migration-failed-fallback-allowed' })
  })
})

test('迁移在本进程内运行 → blocked:migrating', async () => {
  await withEnv({}, async (env) => {
    const choice = await resolveStorageEngine(env.routerDeps({ migrationRunning: () => true }))
    assert.deepEqual(choice, { engine: 'blocked', reason: 'migrating' })
  })
})

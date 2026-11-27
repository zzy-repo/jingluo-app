// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <5s]
//
// #916/#924：备份恢复。需要用户确认、先备份当前、校验不过拒绝、不碰 IDB、不删任何文件。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTarget, makeEnv, mainRows, mods, snapshotOf } from '../helpers/migration-switch/kit.mjs'

const withMigrated = async (body) => {
  const env = makeEnv()
  try {
    assert.equal((await mods.orchestrator.runMigration(env.deps())).status, 'committed')
    await body(env, (await env.readState()).backup)
  } finally {
    env.cleanup()
  }
}

test('未确认 → 拒绝，什么都不动', async () => {
  await withMigrated(async (env, backup) => {
    const before = await mainRows(env)
    const result = await mods.backup.restoreFromBackup(env.deps(), { confirmed: false, backup })
    assert.deepEqual(result, { ok: false, reason: 'not-confirmed' })
    assert.equal(await mainRows(env), before)
  })
})

test('确认后：先备份当前主库，再把备份恢复进主库；IDB 源不变；不删任何文件', async () => {
  await withMigrated(async (env, backup) => {
    // 主库在迁移后被业务改坏（多了一行、少了一行）
    const { db, target } = await env.mainTarget()
    await target.sink.writeBatch('sessions', [{ key: 'zz', value: { id: 'zz' } }])
    await db.run("DELETE FROM raw_rows WHERE store='sessions' AND k='s1'")
    await db.close()
    const sourceBefore = await snapshotOf(env.source)
    const removed = []
    const realRemove = env.fs.remove
    env.fs.remove = async (p) => (removed.push(p), realRemove(p))
    const result = await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup })
    assert.equal(result.ok, true)
    assert.match(result.preRestoreBackup, /^storage-engine\/pre-restore-\d+\.db$/u)
    // 恢复前的主库内容被保存（含用户那条 zz）
    const pre = await env.openSqlite({ name: result.preRestoreBackup })
    const preRows = await pre.all("SELECT k FROM raw_rows WHERE store='sessions' ORDER BY k")
    await pre.close()
    assert.deepEqual(preRows.map((r) => r.k), ['s2', 's3', 'zz'])
    // s1 回来了
    const { db: main, target: t } = await env.mainTarget()
    assert.ok((await t.source.readBatch('sessions', undefined, 50)).rows.some((r) => r.key === 's1'))
    await main.close()
    assert.equal(await snapshotOf(env.source), sourceBefore)
    assert.deepEqual(removed, [])
  })
})

test('备份清单被改/缺失 → 拒绝（校验和不通过）', async () => {
  await withMigrated(async (env, backup) => {
    const manifest = mods.backup.manifestPathOf(backup.dir)
    const good = await env.fs.readText(manifest)
    await env.fs.writeAtomic(manifest, good.replace('"version":1', '"version":2'))
    assert.equal((await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup })).reason, 'backup-invalid')
    await env.fs.remove(manifest)
    assert.equal((await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup })).reason, 'backup-invalid')
    await env.fs.writeAtomic(manifest, good)
    assert.equal((await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup })).ok, true)
  })
})

test('备份库内容与清单计数不符 → 拒绝，主库不动', async () => {
  await withMigrated(async (env, backup) => {
    const db = await env.openSqlite({ name: backup.dir })
    await db.run("DELETE FROM raw_rows WHERE store='sessions' AND k='s1'")
    await db.close()
    const before = await mainRows(env)
    const result = await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup })
    assert.equal(result.reason, 'backup-invalid')
    assert.equal(await mainRows(env), before)
  })
})

test('无备份记录 → no-backup', async () => {
  await withMigrated(async (env) => {
    assert.equal((await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup: undefined })).reason, 'no-backup')
  })
})

test('当前主库无法先备份 → 拒绝，不在没有退路时改写', async () => {
  await withMigrated(async (env, backup) => {
    const before = await mainRows(env)
    const deps = env.deps({
      openSqlite: async (options) => {
        const db = await env.openSqlite(options)
        return options.name === mods.config.MAIN_DB_NAME ? { ...db, backupTo: async () => { throw new Error('ENOSPC') } } : db
      },
    })
    const result = await mods.backup.restoreFromBackup(deps, { confirmed: true, backup })
    assert.equal(result.reason, 'current-unbackupable')
    assert.equal(await mainRows(env), before)
  })
})

test('主库损坏打不开 → main-unopenable，不删不重建', async () => {
  await withMigrated(async (env, backup) => {
    const deps = env.deps({ openSqlite: async (o) => { if (o.name === mods.config.MAIN_DB_NAME) throw new Error('SQLITE_CORRUPT'); return env.openSqlite(o) } })
    const result = await mods.backup.restoreFromBackup(deps, { confirmed: true, backup })
    assert.equal(result.reason, 'main-unopenable')
    assert.equal(await env.sqliteFileExists(), true)
  })
})

// ---------------------------------------------------------------- #980 F3
//
// 恢复路径**刻意不设防**：用户点了「恢复」，语义就是要覆盖主库。
// 但必须有 pre-restore 备份（见上一条用例）。这条用例钉住「恢复仍然清空后重灌」——
// 否则将来有人把迁移侧的 `clearOwnTarget()` 顺手套到恢复路径上，恢复功能会静默坏掉
// （前置检查发现主库有 committed_at → 拒绝清空 → 「恢复」变成什么都没做）。
test('#980 F3：用户主动恢复仍然「清空后重灌」（迁移路径设防，恢复路径刻意不设防）', async () => {
  await withMigrated(async (env, backup) => {
    // 备份之后又产生了主库独有的内容（备份里没有）：恢复完成后它们必须消失
    const { db, target } = await env.mainTarget()
    await target.sink.writeBatch('sessions', [{ key: 'after-backup', value: { id: 'after-backup' } }])
    await db.run("DELETE FROM raw_rows WHERE store='sessions' AND k='s1'")
    await db.close()
    const result = await mods.backup.restoreFromBackup(env.deps(), { confirmed: true, backup })
    assert.equal(result.ok, true)
    const { db: main, target: t } = await env.mainTarget()
    const rows = (await t.source.readBatch('sessions', undefined, 50)).rows.map((row) => row.key)
    await main.close()
    // ① 备份里没有的行被清掉了（= 真的先清空，而不是「合并」）
    assert.equal(rows.includes('after-backup'), false)
    // ② 备份里的行回来了
    assert.ok(rows.includes('s1'))
    // ③ 主库内容与备份一致（九张 store 全等，不只是 sessions）
    assert.equal(await mainRows(env), await snapshotOf(env.source))
  })
})

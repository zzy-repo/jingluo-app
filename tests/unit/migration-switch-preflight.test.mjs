// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <5s]
//
// #916（lead 采纳的预检三条线）：拒绝线 / 警告线 / 硬上界的边界值；回滚保护注入点的顺序与失败处置；
// 「state.json 缺失但 IDB 有数据」（还原到新设备后状态机回到 idle 重新迁移）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { killAt, makeEngine, makeEnv, mainRows, mods, snapshotOf } from '../helpers/migration-switch/kit.mjs'

const { judgePreflight, requiredFreeBytes, runMigration } = mods.orchestrator
const T = mods.limits.LIMITS.storageMigration

const withEnv = async (options, body) => {
  const env = makeEnv(options)
  try {
    await body(env)
  } finally {
    env.cleanup()
  }
}

test('阈值只在 LIMITS 一处：固定数值（256MiB / 200MiB / 2GiB）', () => {
  assert.deepEqual({ ...T }, { reserveBytes: 256 * 1024 * 1024, warnBytes: 200 * 1024 * 1024, maxBytes: 2 * 1024 * 1024 * 1024 })
})

test('拒绝线：freeBytes < 2S + 备份(S) + 256MB；刚好等于通过，少 1 字节拒绝', () => {
  for (const S of [0, 1000, T.warnBytes, T.maxBytes]) {
    const need = requiredFreeBytes(S)
    assert.equal(need, 3 * S + T.reserveBytes)
    assert.equal(judgePreflight(S, need), undefined, `S=${S} 刚好等于`)
    assert.deepEqual(judgePreflight(S, need - 1)?.code, 'insufficient-space', `S=${S} 少 1 字节`)
  }
})

test('硬上界：S > 2GB 直接拒绝（即使空间无限），S = 2GB 不拒绝', () => {
  assert.equal(judgePreflight(T.maxBytes, Number.MAX_SAFE_INTEGER), undefined)
  const over = judgePreflight(T.maxBytes + 1, Number.MAX_SAFE_INTEGER)
  assert.equal(over.code, 'unsupported')
  assert.match(over.message, /export/u)
})

test('freeBytes 未知 → unsupported；先于空间比较', () => {
  assert.equal(judgePreflight(10, undefined).code, 'unsupported')
})

test('警告线：S > 200MB 才 warn（等于不警告，多 1 字节警告）；预检进度带预计体积与所需空间', async () => {
  for (const [S, warn] of [[T.warnBytes, false], [T.warnBytes + 1, true]]) {
    await withEnv({ bytes: S, freeBytes: requiredFreeBytes(S) }, async (env) => {
      let seen
      const result = await runMigration(env.deps({ onProgress: (p) => { if (p.preflight) seen = p.preflight } }))
      assert.equal(result.status, 'committed')
      assert.deepEqual(seen, { estimateBytes: S, requiredBytes: requiredFreeBytes(S), warn })
    })
  }
})

test('空间少 1 字节：不开始（没读源、没建备份、没建主库）；硬上界同样不开始', async () => {
  await withEnv({ bytes: 5000, freeBytes: requiredFreeBytes(5000) - 1 }, async (env) => {
    const result = await runMigration(env.deps())
    assert.equal(result.failure.code, 'insufficient-space')
    assert.equal(env.source.reads, 0)
    assert.equal(await env.sqliteFileExists(), false)
  })
  await withEnv({ bytes: T.maxBytes + 1, freeBytes: Number.MAX_SAFE_INTEGER }, async (env) => {
    const result = await runMigration(env.deps())
    assert.equal(result.failure.code, 'unsupported')
    assert.equal(env.source.reads, 0)
    assert.equal((await env.fs.list('storage-engine')).filter((e) => e.name.startsWith('backup-')).length, 0)
  })
})

// ---------------------------------------------------------------- 回滚保护注入点（默认关闭）

test('默认不传 bumpLegacyIdbVersion：不执行任何回滚保护', async () => {
  await withEnv({}, async (env) => {
    const probe = killAt()
    await runMigration(env.deps({ hooks: probe.hooks }))
    assert.ok(!probe.state.names.includes('legacy-bumped'))
  })
})

test('顺序固定：校验通过 → 升 IDB 版本 → 写 SQLite meta → 写 state.json committed', async () => {
  await withEnv({}, async (env) => {
    const log = []
    const result = await runMigration(
      env.deps({
        bumpLegacyIdbVersion: async () => { log.push(`bump@${(await env.readState()).phase}`) },
        hooks: { boundary: (name) => { if (name === 'meta-written' || name === 'written:committed') log.push(name) } },
      }),
    )
    assert.equal(result.status, 'committed')
    assert.deepEqual(log, ['bump@verified', 'meta-written', 'written:committed'])
  })
})

test('升版本失败（可能已部分生效）：不写 meta、不写 committed，状态停在 verified、不回 idle；重入再试', async () => {
  await withEnv({}, async (env) => {
    let fail = true
    let calls = 0
    const bump = async () => { calls += 1; if (fail) throw new Error('IDB upgrade blocked') }
    const first = await runMigration(env.deps({ bumpLegacyIdbVersion: bump }))
    assert.equal(first.status, 'failed')
    assert.equal((await env.readState()).phase, 'verified', '不回到 idle、不写 failed')
    const { db } = await env.mainTarget()
    assert.equal((await db.all('SELECT key FROM meta')).length, 0, 'meta 未写')
    await db.close()
    fail = false
    const eng = makeEngine()
    const second = await runMigration(env.deps({ bumpLegacyIdbVersion: bump, engine: eng }))
    assert.equal(second.status, 'committed')
    assert.equal(eng.copies, 0, '没有重新复制')
    assert.equal(calls, 2)
  })
})

test('屏障子步骤：升版前强杀 / 升版后 committed 前强杀，重入都继续提交，不回 idle、不重做复制', async () => {
  const probe = killAt()
  await withEnv({}, async (env) => {
    await runMigration(env.deps({ hooks: probe.hooks, bumpLegacyIdbVersion: async () => {} }))
  })
  const start = probe.state.names.indexOf('legacy-started') + 1
  assert.ok(start > 0)
  for (let k = start; k <= probe.state.n; k += 1) {
    await withEnv({}, async (env) => {
      await assert.rejects(
        runMigration(env.deps({ hooks: killAt(k).hooks, bumpLegacyIdbVersion: async () => {} })),
        (e) => e?.killed === true,
      )
      const after = await env.readState()
      assert.ok(['verified', 'committed'].includes(after.phase), `${probe.state.names[k - 1]}:${after.phase}`)
      if (k > probe.state.names.indexOf('legacy-started')) {
        assert.ok(['started', 'done'].includes(after.legacyBarrier) || after.phase === 'committed', `子步骤应落盘 ${k}`)
      }
      const eng = makeEngine()
      const result = await runMigration(env.deps({ engine: eng, bumpLegacyIdbVersion: async () => {} }))
      assert.equal(result.status, 'committed')
      assert.equal(eng.copies, 0)
      assert.equal(await mainRows(env), await snapshotOf(env.source))
    })
  }
})

test('版本已升、写 meta 失败：状态不被写成 failed（停在 verified），下次重入继续提交', async () => {
  await withEnv({}, async (env) => {
    const deps = env.deps({
      bumpLegacyIdbVersion: async () => {},
      openSqlite: async (o) => {
        const db = await env.openSqlite(o)
        if (o.name !== mods.config.MAIN_DB_NAME) return db
        return {
          ...db,
          transaction: (work, options) =>
            db.transaction((tx) => work({ ...tx, run: (sql, params) => (/INTO meta/u.test(sql) ? Promise.reject(new Error('SQLITE_FULL')) : tx.run(sql, params)) }), options),
        }
      },
    })
    const first = await runMigration(deps)
    assert.equal(first.status, 'failed')
    assert.equal((await env.readState()).phase, 'verified')
    const second = await runMigration(env.deps({ bumpLegacyIdbVersion: async () => {} }))
    assert.equal(second.status, 'committed')
  })
})

// ---------------------------------------------------------------- 云备份还原到新设备

test('state.json 缺失但 IDB 有数据（还原到新设备）：回到 idle 重新迁移，数据完整', async () => {
  await withEnv({}, async (env) => {
    assert.equal(await env.readState(), undefined)
    assert.equal(await env.sqliteFileExists(), false)
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'committed')
    assert.equal(await mainRows(env), await snapshotOf(env.source))
  })
})

test('state.json 缺失 + 遗留半个主库（无 committed 见证）：清掉自己的半成品重来，不被当成已迁移', async () => {
  await withEnv({}, async (env) => {
    const stale = await env.mainTarget()
    await stale.target.sink.writeBatch('sessions', [{ key: 'ghost', value: { id: 'ghost' } }])
    await stale.db.close()
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'committed')
    assert.equal(await mainRows(env), await snapshotOf(env.source), '幽灵行被清掉，内容与 IDB 一致')
    assert.ok(!(await mainRows(env)).includes('ghost'))
  })
})

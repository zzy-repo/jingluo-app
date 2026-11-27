// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <10s]
//
// #916：编排器状态机转移、预检、断点续迁、杀进程重入、失败后 IDB 不变、幂等。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { killAt, makeEngine, makeEnv, mainRows, mods, snapshotOf } from '../helpers/migration-switch/kit.mjs'

const { runMigration, requiredFreeBytes } = mods.orchestrator

const withEnv = async (options, body) => {
  const env = makeEnv(options)
  try {
    await body(env)
  } finally {
    env.cleanup()
  }
}

test('完整一遍：每个阶段先写状态再推进，终态 committed，SQLite 内容与源一致', async () => {
  await withEnv({}, async (env) => {
    const phases = []
    const result = await runMigration(env.deps({ onProgress: ({ phase }) => phases.push(phase) }))
    assert.equal(result.status, 'committed')
    const order = [...new Set(phases)]
    assert.deepEqual(order, ['preflight', 'backing-up', 'backup-verified', 'copying', 'verifying', 'verified', 'committed'])
    assert.equal((await env.readState()).phase, 'committed')
    assert.equal(await mainRows(env), await snapshotOf(env.source))
    const { db } = await env.mainTarget()
    const rows = await db.all('SELECT key FROM meta ORDER BY key')
    await db.close()
    assert.deepEqual(rows.map((r) => r.key), ['committed_at', 'engine_version', 'migrated_from'])
  })
})

test('committed 的写入顺序：先 SQLite meta，再状态文件', async () => {
  await withEnv({}, async (env) => {
    const seen = []
    await runMigration(
      env.deps({
        hooks: {
          boundary: async (name) => {
            if (name === 'meta-written') {
              seen.push(['meta-written', (await env.readState()).phase])
            }
          },
        },
      }),
    )
    // meta 写入那一刻，状态文件还停在 verified
    assert.deepEqual(seen, [['meta-written', 'verified']])
  })
})

test('备份：独立文件库 + 清单落盘，对源校验通过才 backup-verified；备份内容与源一致', async () => {
  await withEnv({}, async (env) => {
    await runMigration(env.deps())
    const state = await env.readState()
    assert.match(state.backup.dir, /^storage-engine\/backup-\d+\.db$/u)
    assert.ok(state.backup.verifiedAt > 0)
    const names = (await env.fs.list('storage-engine')).map((e) => e.name)
    assert.ok(names.some((n) => /^backup-\d+\.manifest\.json$/u.test(n)))
    const db = await env.openSqlite({ name: state.backup.dir })
    const target = await mods.backup.readBackupManifest(env.fs, async (t) => (await import('node:crypto')).createHash('sha256').update(t).digest('hex'), state.backup)
    assert.ok(target, '清单校验和对得上')
    const t = await (await import('../helpers/migration-switch/kit.mjs')).createTarget(db)
    assert.equal(await snapshotOf(t.source), await snapshotOf(env.source))
    await db.close()
  })
})

test('备份校验不过（对源）→ failed/backup-failed，不进入复制，主库不存在，IDB 不变', async () => {
  await withEnv({}, async (env) => {
    const before = await snapshotOf(env.source)
    const result = await runMigration(env.deps({ engine: makeEngine({ failVerify: true }) }))
    assert.equal(result.status, 'failed')
    assert.equal(result.failure.code, 'backup-failed')
    assert.equal((await env.readState()).phase, 'failed')
    assert.equal(await env.sqliteFileExists(), false)
    assert.equal(await snapshotOf(env.source), before)
  })
})

test('预检：freeBytes 未知 → 不迁移（unsupported），没碰源、没建备份', async () => {
  await withEnv({ freeBytes: null }, async (env) => {
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'failed')
    assert.equal(result.failure.code, 'unsupported')
    assert.equal(env.source.reads, 0)
    assert.equal((await env.fs.list('storage-engine')).filter((e) => e.name.startsWith('backup-')).length, 0)
    assert.equal(await env.sqliteFileExists(), false)
  })
})

test('预检：空间 < 源×3 + 余量 → insufficient-space，不开始；恰好够则开始（负向对照）', async () => {
  const need = requiredFreeBytes(1000)
  assert.equal(need, 3000 + mods.limits.LIMITS.storageMigration.reserveBytes)
  await withEnv({ freeBytes: need - 1 }, async (env) => {
    const result = await runMigration(env.deps())
    assert.equal(result.failure.code, 'insufficient-space')
    assert.equal(env.source.reads, 0)
    assert.equal(await env.sqliteFileExists(), false)
    assert.equal((await env.readState()).failure.code, 'insufficient-space')
  })
  await withEnv({ freeBytes: need }, async (env) => {
    assert.equal((await runMigration(env.deps())).status, 'committed')
  })
})

test('复制失败 → failed/copy-failed，IDB 数据未变，不是 committed', async () => {
  await withEnv({}, async (env) => {
    const before = await snapshotOf(env.source)
    // 备份阶段用掉前 10 次批读（共 20 次）；让失败落在主库复制阶段
    const result = await runMigration(env.deps({ engine: makeEngine({ failCopyAt: 15 }) }))
    assert.equal(result.status, 'failed')
    assert.equal(result.failure.code, 'copy-failed')
    assert.equal(await snapshotOf(env.source), before)
    assert.notEqual((await env.readState()).phase, 'committed')
  })
})

test('失败后重试：从检查点续，终态 committed；已复制批次不重复读（断点续迁）', async () => {
  await withEnv({}, async (env) => {
    const failing = await runMigration(env.deps({ engine: makeEngine({ failCopyAt: 15 }) }))
    assert.equal(failing.status, 'failed')
    const retry = makeEngine()
    const result = await runMigration(env.deps({ engine: retry }))
    assert.equal(result.status, 'committed')
    assert.equal(await mainRows(env), await snapshotOf(env.source))
    // 备份已校验，不重做：重试的 copies 只有主库剩余批次，少于完整一遍
    const full = makeEngine()
    await runMigration(makeEnv().deps({ engine: full }))
    assert.ok(retry.copies < full.copies, `${retry.copies} < ${full.copies}`)
  })
})

test('校验失败 → failed/verify-failed；重试清掉**自己的**目标重来', async () => {
  await withEnv({}, async (env) => {
    const eng = makeEngine()
    const base = eng.verifyAll
    let calls = 0
    eng.verifyAll = async (args) => {
      calls += 1
      const report = await base(args)
      return calls === 2 ? { ...report, ok: false, semanticIssues: ['injected'] } : report
    }
    const first = await runMigration(env.deps({ engine: eng }))
    assert.equal(first.failure.code, 'verify-failed')
    const second = await runMigration(env.deps({ engine: eng }))
    assert.equal(second.status, 'committed')
    assert.equal(await mainRows(env), await snapshotOf(env.source))
  })
})

test('源在两次运行之间变了 → 清自己的目标重来，终态与新源一致；IDB 不被写', async () => {
  await withEnv({}, async (env) => {
    const failing = await runMigration(env.deps({ engine: makeEngine({ failCopyAt: 15 }) }))
    assert.equal(failing.status, 'failed')
    env.source.data.sessions.s9 = { id: 's9', title: '新增' }
    delete env.source.data.sessions.s3
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'committed')
    assert.equal(result.restarted, true)
    assert.equal(await mainRows(env), await snapshotOf(env.source))
    assert.ok(env.source.data.sessions.s9, '源保持用户最新数据')
  })
})

test('杀进程：每个边界被杀后重入，终态相同（committed 且内容一致），IDB 不变', async () => {
  const probe = killAt()
  await withEnv({}, async (env) => {
    await runMigration(env.deps({ hooks: probe.hooks }))
  })
  const total = probe.state.n
  assert.ok(total > 25, `边界数 ${total}`)
  for (let k = 1; k <= total; k += 1) {
    await withEnv({}, async (env) => {
      const before = await snapshotOf(env.source)
      const kill = killAt(k)
      await assert.rejects(runMigration(env.deps({ hooks: kill.hooks })), (e) => e?.killed === true, `杀在第 ${k} 个边界 ${probe.state.names[k - 1]}`)
      // 丢弃协调器实例，用同一份持久状态（同一 fs + 同一目录）重建
      const result = await runMigration(env.deps())
      assert.equal(result.status, 'committed', `边界 ${k}:${probe.state.names[k - 1]}`)
      assert.equal((await env.readState()).phase, 'committed')
      assert.equal(await mainRows(env), await snapshotOf(env.source), `边界 ${k}`)
      assert.equal(await snapshotOf(env.source), before)
    })
  }
})

test('被杀不会写 failed（真杀进程什么都来不及写）', async () => {
  await withEnv({}, async (env) => {
    await assert.rejects(runMigration(env.deps({ hooks: killAt(8).hooks })))
    assert.notEqual((await env.readState())?.phase, 'failed')
  })
})

test('杀在「meta 已写、状态未写」之间：重入补写 committed，不判矛盾、不重复复制', async () => {
  await withEnv({}, async (env) => {
    const probe = killAt()
    await runMigration(makeEnv().deps({ hooks: probe.hooks }))
    const index = probe.state.names.indexOf('meta-written') + 1
    await assert.rejects(runMigration(env.deps({ hooks: killAt(index).hooks })))
    assert.equal((await env.readState()).phase, 'verified')
    const eng = makeEngine()
    const result = await runMigration(env.deps({ engine: eng }))
    assert.equal(result.status, 'committed')
    assert.equal(eng.copies, 0)
    assert.equal((await env.readState()).phase, 'committed')
  })
})

test('已 committed 再跑：幂等，什么都不重做，seq 不变', async () => {
  await withEnv({}, async (env) => {
    await runMigration(env.deps())
    const seq = (await env.readState()).seq
    const eng = makeEngine()
    const again = await runMigration(env.deps({ engine: eng }))
    assert.equal(again.status, 'committed')
    assert.equal(eng.copies, 0)
    assert.equal(env.source.reads, env.source.reads)
    assert.equal((await env.readState()).seq, seq)
  })
})

test('两处见证矛盾 → blocked，什么都不动', async () => {
  await withEnv({}, async (env) => {
    await runMigration(env.deps())
    await env.writeState({ phase: 'copying', seq: 99 })
    const eng = makeEngine()
    const result = await runMigration(env.deps({ engine: eng }))
    assert.equal(result.status, 'blocked')
    assert.equal(eng.copies, 0)
    assert.equal((await env.readState()).phase, 'copying')
  })
})

test('状态文件损坏 + 无 SQLite 见证：当作 idle 重新迁移，损坏文件被另存保留', async () => {
  await withEnv({}, async (env) => {
    await env.fs.writeAtomic('storage-engine/state.json', '{broken')
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'committed')
    const names = (await env.fs.list('storage-engine')).map((e) => e.name)
    assert.ok(names.some((n) => n.startsWith('state.corrupt-')))
  })
})

test('编排器不写 IDB 源、不删备份：整个过程 fs 里的 backup-* 只增不减', async () => {
  await withEnv({}, async (env) => {
    const removed = []
    const realRemove = env.fs.remove
    env.fs.remove = async (path) => {
      removed.push(path)
      return realRemove(path)
    }
    await runMigration(env.deps({ engine: makeEngine({ failCopyAt: 15 }) }))
    await runMigration(env.deps())
    assert.deepEqual(removed, [])
    assert.equal(typeof env.source.writeBatch, 'undefined')
  })
})

test('abort 信号 → failed/interrupted，IDB 不变', async () => {
  await withEnv({}, async (env) => {
    const controller = new AbortController()
    controller.abort()
    const result = await runMigration(env.deps({ signal: controller.signal }))
    assert.equal(result.failure.code, 'interrupted')
  })
})

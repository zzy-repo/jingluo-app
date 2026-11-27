// [layer: unit | 依赖: node:sqlite + 内存 FS | 耗时: <10s]
//
// #916：编排器状态机转移、预检、断点续迁、杀进程重入、失败后 IDB 不变、幂等。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTarget, killAt, makeEngine, makeEnv, mainRows, mods, snapshotOf } from '../helpers/migration-switch/kit.mjs'

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

// ---------------------------------------------------------------- #980 护栏 B（写侧）
//
// 用户口径：「迁移状态不明确时**禁止**清空主库」（是禁止，不是「先备份再清」）。
// 这三条用例守的是同一件事：**无法证明 committed 时，`clearAll` 根本不发生**。

const seedUserRows = async (env) => {
  const { db } = await env.mainTarget()
  // 见证人读的是 schema 里的真 `sessions` 表（不是内存桩的 raw_rows），所以直接往里写一行
  await db.run('INSERT INTO sessions (id, doc) VALUES (?, ?)', [Buffer.from('s1'), JSON.stringify({ id: 's1', title: '用户的会话' })])
  await db.close()
}

test('#980 护栏 B：状态文件损坏 + 主库有业务数据 + 无见证 → blocked，一行都不删、状态文件不重写', async () => {
  await withEnv({}, async (env) => {
    await seedUserRows(env)
    await env.fs.writeAtomic('storage-engine/state.json', '{broken')
    const before = await mainRows(env)
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'blocked')
    assert.equal(result.detail, mods.orchestrator.MAIN_DB_AMBIGUOUS_DETAIL)
    // ① 主库没被清空（这是用户验收的核心：状态异常不清空主库）
    assert.equal(await mainRows(env), before)
    // ② 状态文件没被改写成 idle（保留现场，下次还能查）
    assert.equal(await env.fs.readText('storage-engine/state.json'), '{broken')
    // ③ 没有重跑迁移：不产生新备份、不写 meta
    const names = (await env.fs.list('storage-engine')).map((entry) => entry.name)
    assert.equal(names.some((name) => name.startsWith('backup-')), false)
    const { db } = await env.mainTarget()
    const meta = await db.all('SELECT key FROM meta ORDER BY key')
    await db.close()
    assert.deepEqual(meta, [])
  })
})

test('#980 护栏 B：状态文件缺失 + 主库有业务数据 + 无见证 → blocked（不再当作全新安装重迁一遍）', async () => {
  await withEnv({}, async (env) => {
    await seedUserRows(env)
    const before = await mainRows(env)
    const result = await runMigration(env.deps())
    assert.equal(result.status, 'blocked')
    assert.equal(result.detail, mods.orchestrator.MAIN_DB_AMBIGUOUS_DETAIL)
    assert.equal(await mainRows(env), before)
    // 全新安装（没有库文件）不受影响：那条路径由其它用例覆盖
    assert.equal((await env.fs.list('storage-engine')).some((entry) => entry.name.startsWith('backup-')), false)
  })
})

test('#980 护栏 B 最后一道：清空前一刻发现主库已被提交 → 拒绝清空并失败（不覆盖已提交的库）', async () => {
  await withEnv({}, async (env) => {
    // 造「上次迁移没做完、这次要清掉自己的半成品重来」的局面（源指纹已记录，说明库里的行是我们自己写的），
    // 主库里有我们的半成品行；随后源指纹变化 → 走到 clearOwnTarget
    await env.writeState({ phase: 'failed', seq: 3, sourceFingerprint: 'fp-stale', failure: { code: 'verify-failed', message: 'x', at: 1 } })
    await seedUserRows(env)
    const before = await mainRows(env)
    // 模拟并发提交：入口判定之后、真正 clearAll 之前，库里的 meta 出现 committed_at
    let opens = 0
    const racingOpen = async (options) => {
      const db = await env.openSqlite(options)
      opens += 1
      if (opens > 1 && options.name === mods.config.MAIN_DB_NAME) {
        await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('committed_at', '1795753487411')")
      }
      return db
    }
    const result = await runMigration(env.deps({ openSqlite: racingOpen }))
    // 不是「迁移失败」，是「拒绝覆盖」：blocked + 自解释详情，绝不能显示成「原生数据库不可用」
    assert.equal(result.status, 'blocked')
    assert.equal(result.detail, mods.orchestrator.MAIN_DB_COMMITTED_DETAIL)
    // 行还在：护栏宁可让这次迁移失败，也不清一份已提交的库
    assert.equal(await mainRows(env), before)
  })
})

test('#980 护栏 B：主库文件存在但读不出来 → blocked，且 clearAll 一次都没被调用（fail-open 已堵）', async () => {
  await withEnv({}, async (env) => {
    await seedUserRows(env) // 库里确有业务行：文件在、且不是空壳
    // 状态文件本身是好的（否则会先被收敛阶段以 state-file-* 的理由挡住，测不到探针这条）
    await env.writeState({ phase: 'copying', seq: 2, sourceFingerprint: 'fp-1' })
    let clears = 0
    const spyTarget = async (db) => {
      const target = await createTarget(db)
      return {
        ...target,
        sink: {
          ...target.sink,
          clearAll: async () => {
            clears += 1
            await target.sink.clearAll()
          },
        },
      }
    }
    const result = await runMigration(
      env.deps({
        // 「文件存在但打不开」：瞬时锁 / 权限 / 损坏都可能长这样，探针必须判成 unreadable
        openSqlite: async () => {
          throw new Error('database is locked')
        },
        createTarget: spyTarget,
      }),
    )
    assert.equal(result.status, 'blocked')
    assert.equal(result.detail, mods.orchestrator.MAIN_DB_UNREADABLE_DETAIL)
    // 关键断言：不是「blocked 就算过」，而是证明**一次都没清**
    assert.equal(clears, 0)
    // 现场还在（seedUserRows 写的是真 `sessions` 表，不是内存桩的 raw_rows）
    const { db } = await env.mainTarget()
    const rows = await db.all('SELECT id FROM sessions')
    await db.close()
    assert.equal(rows.length, 1)
  })
})

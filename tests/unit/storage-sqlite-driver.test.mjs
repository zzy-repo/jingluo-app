// [layer: unit | 依赖: node:sqlite + tests/helpers/storage-sqlite/nodeSqliteDriver.mjs | 耗时: <3s]
//
// #910：Node 测试驱动自身的行为（它是契约测试与迁移审计的地基，先证明它可信）。
//   node tests/run-layer.mjs unit --case storage-sqlite-driver
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  makeTempSqliteDir,
  openNodeSqliteDatabase,
  SqliteDriverError,
} from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'

const withDb = async (options, body) => {
  const tmp = makeTempSqliteDir()
  const opened = await openNodeSqliteDatabase(options === 'file' ? { dir: tmp.dir } : {})
  try {
    await body(opened, tmp)
  } finally {
    await opened.db.close().catch(() => undefined)
    tmp.cleanup()
  }
}

test('文件库：WAL / synchronous=FULL / foreign_keys / busy_timeout 由 info() 回读', async () => {
  await withDb('file', async ({ db }) => {
    const info = await db.info()
    assert.equal(info.journalMode, 'wal')
    assert.equal(info.synchronous, 'FULL')
    assert.equal(info.foreignKeys, true)
    assert.ok(info.busyTimeoutMs >= 5000)
    assert.equal(info.kind, 'node-test')
    assert.ok(info.sqliteVersion.length > 0)
  })
})

test('内存库：日志模式为 memory，其余约束仍成立', async () => {
  await withDb('memory', async ({ db }) => {
    const info = await db.info()
    assert.equal(info.journalMode, 'memory')
    assert.equal(info.synchronous, 'FULL')
    assert.equal(info.foreignKeys, true)
  })
})

test('BLOB 参数与结果是 Uint8Array，往返字节相等', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE b(id INTEGER PRIMARY KEY, data BLOB, n INTEGER, t TEXT)')
    const bytes = Uint8Array.from([0, 1, 2, 254, 255])
    await db.run('INSERT INTO b VALUES (1, ?, ?, ?)', [bytes, 9007199254740991, '中文'])
    const [row] = await db.all('SELECT * FROM b')
    assert.ok(row.data instanceof Uint8Array)
    assert.deepEqual([...row.data], [...bytes])
    assert.equal(row.n, 9007199254740991)
    assert.equal(row.t, '中文')
  })
})

test('非法参数（undefined / boolean / NaN）被拒绝，不静默写成 NULL', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE p(a)')
    for (const bad of [undefined, true, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      await assert.rejects(() => db.run('INSERT INTO p VALUES (?)', [bad]), SqliteDriverError)
    }
    assert.equal((await db.all('SELECT count(*) AS c FROM p'))[0].c, 0)
  })
})

test('transaction：成功提交；回调抛错回滚并原样抛出', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE t(a INTEGER PRIMARY KEY)')
    const value = await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)')
      return (await tx.all('SELECT count(*) AS c FROM t'))[0].c
    })
    assert.equal(value, 1)
    const boom = new Error('业务错误')
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (2)')
          throw boom
        }),
      (error) => error === boom,
    )
    assert.deepEqual(
      (await db.all('SELECT a FROM t ORDER BY a')).map((r) => r.a),
      [1],
    )
  })
})

test('transaction：回调里误用 db.run 直接抛错（真机会死锁）；事务随之回滚', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE t(a INTEGER PRIMARY KEY)')
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)')
          await db.run('INSERT INTO t VALUES (2)')
        }),
      /必须用传入的 tx/,
    )
    assert.equal((await db.all('SELECT count(*) AS c FROM t'))[0].c, 0)
  })
})

test('transaction：同一连接上的调用排队，不交错', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE t(a INTEGER)')
    const order = []
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const slow = db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1)')
      await gate
      order.push('tx')
    })
    const after = db.run('INSERT INTO t VALUES (2)').then(() => order.push('run'))
    release() // 外部 run 已排在事务之后；事务回调放行后才轮到它
    await Promise.all([slow, after])
    assert.deepEqual(order, ['tx', 'run'])
  })
})

test('transaction：超时回滚，随后 tx 失效，且连接仍可用', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE t(a INTEGER)')
    let leaked
    await assert.rejects(
      () =>
        db.transaction(
          async (tx) => {
            leaked = tx
            await tx.run('INSERT INTO t VALUES (1)')
            await new Promise(() => {}) // 永不返回：靠驱动的 txTimeoutMs 终止
          },
          { txTimeoutMs: 20 },
        ),
      (error) => error.kind === 'unavailable',
    )
    await assert.rejects(() => leaked.run('INSERT INTO t VALUES (2)'), (error) => error.kind === 'unavailable')
    assert.equal((await db.all('SELECT count(*) AS c FROM t'))[0].c, 0)
    await db.run('INSERT INTO t VALUES (3)')
  })
})

test('batch：全成或全回滚', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE t(a INTEGER PRIMARY KEY)')
    const ok = await db.batch([
      { sql: 'INSERT INTO t VALUES (?)', params: [1] },
      { sql: 'INSERT INTO t VALUES (?)', params: [2] },
    ])
    assert.deepEqual(ok, [{ changes: 1 }, { changes: 1 }])
    await assert.rejects(
      () =>
        db.batch([
          { sql: 'INSERT INTO t VALUES (?)', params: [3] },
          { sql: 'INSERT INTO t VALUES (?)', params: [1] }, // 主键冲突
        ]),
      (error) => error.code === 'SQLITE_CONSTRAINT',
    )
    assert.deepEqual(
      (await db.all('SELECT a FROM t ORDER BY a')).map((r) => r.a),
      [1, 2],
    )
  })
})

test('外键约束生效（foreign_keys=ON）', async () => {
  await withDb('memory', async ({ db }) => {
    await db.run('CREATE TABLE p(id INTEGER PRIMARY KEY)')
    await db.run('CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id))')
    await assert.rejects(() => db.run('INSERT INTO c VALUES (1, 99)'), (error) => error.code === 'SQLITE_CONSTRAINT')
  })
})

test('backupTo：VACUUM INTO 产出可独立打开、内容一致的副本', async () => {
  await withDb('file', async ({ db }, tmp) => {
    await db.run('CREATE TABLE t(a TEXT)')
    await db.run('INSERT INTO t VALUES (?)', ['x'])
    const { bytes } = await db.backupTo('backup/copy.db')
    assert.ok(bytes > 0)
    assert.ok(existsSync(join(tmp.dir, 'backup', 'copy.db')))
    const copy = await openNodeSqliteDatabase({ path: join(tmp.dir, 'backup', 'copy.db') })
    try {
      assert.deepEqual(await copy.db.all('SELECT a FROM t'), [{ a: 'x' }])
    } finally {
      await copy.db.close()
    }
    await assert.rejects(() => db.backupTo('/etc/evil.db'), /相对路径/)
    await assert.rejects(() => db.backupTo('../escape.db'), /越出/)
  })
})

test('integrityCheck：健康库返回空数组', async () => {
  await withDb('file', async ({ db }) => {
    await db.run('CREATE TABLE t(a)')
    assert.deepEqual(await db.integrityCheck(), [])
  })
})

test('故障注入：第 N 次 run 抛指定错误，kind 映射 SQLITE_FULL→quota，且只触发一次', async () => {
  await withDb('memory', async ({ db, faults }) => {
    await db.run('CREATE TABLE t(a)')
    faults.failNthRun(2)
    await db.run('INSERT INTO t VALUES (1)')
    await assert.rejects(
      () => db.run('INSERT INTO t VALUES (2)'),
      (error) => error instanceof SqliteDriverError && error.kind === 'quota' && error.code === 'SQLITE_FULL',
    )
    await db.run('INSERT INTO t VALUES (3)')
    assert.deepEqual(
      (await db.all('SELECT a FROM t ORDER BY a')).map((r) => r.a),
      [1, 3],
    )
  })
})

test('故障注入：事务中途失败整体回滚；COMMIT 失败也回滚', async () => {
  await withDb('memory', async ({ db, faults }) => {
    await db.run('CREATE TABLE t(a)')
    faults.failNthRun(2)
    await assert.rejects(() =>
      db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)')
        await tx.run('INSERT INTO t VALUES (2)')
      }),
    )
    assert.equal((await db.all('SELECT count(*) AS c FROM t'))[0].c, 0)

    faults.failNextCommit('SQLITE_IOERR')
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (9)')
        }),
      (error) => error.code === 'SQLITE_IOERR' && error.kind === 'unavailable',
    )
    assert.equal((await db.all('SELECT count(*) AS c FROM t'))[0].c, 0)
  })
})

test('故障注入：diskFull 之后所有写失败、读照常；clearDiskFull 恢复', async () => {
  await withDb('memory', async ({ db, faults }) => {
    await db.run('CREATE TABLE t(a)')
    faults.diskFull()
    await assert.rejects(() => db.run('INSERT INTO t VALUES (1)'), (error) => error.kind === 'quota')
    await assert.rejects(() => db.batch([{ sql: 'INSERT INTO t VALUES (1)' }]), (error) => error.kind === 'quota')
    assert.equal((await db.all('SELECT count(*) AS c FROM t'))[0].c, 0)
    faults.clearDiskFull()
    await db.run('INSERT INTO t VALUES (1)')
  })
})

test('真实的库满：limitPages 后 SQLite 自己抛 SQLITE_FULL（映射为 quota）', async () => {
  await withDb('file', async ({ db, limitPages, pageCount }) => {
    await db.run('CREATE TABLE t(a BLOB)')
    limitPages(pageCount() + 4)
    const chunk = new Uint8Array(64 * 1024)
    let failure
    for (let i = 0; i < 50 && !failure; i += 1) {
      try {
        await db.run('INSERT INTO t VALUES (?)', [chunk])
      } catch (error) {
        failure = error
      }
    }
    assert.ok(failure, '应当写满')
    assert.equal(failure.code, 'SQLITE_FULL')
    assert.equal(failure.kind, 'quota')
  })
})

test('kill：连接被丢弃，未提交事务不落盘，之后调用抛 unavailable；重开同一文件看不到未提交数据', async () => {
  const tmp = makeTempSqliteDir()
  try {
    const first = await openNodeSqliteDatabase({ dir: tmp.dir })
    await first.db.run('CREATE TABLE t(a)')
    await first.db.run('INSERT INTO t VALUES (1)')
    const pending = first.db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (2)')
      first.faults.kill()
      await tx.run('INSERT INTO t VALUES (3)')
    })
    await assert.rejects(() => pending, (error) => error.kind === 'unavailable')
    await assert.rejects(() => first.db.all('SELECT 1'), (error) => error.kind === 'unavailable')

    const second = await openNodeSqliteDatabase({ dir: tmp.dir })
    try {
      assert.deepEqual(
        (await second.db.all('SELECT a FROM t ORDER BY a')).map((r) => r.a),
        [1],
      )
    } finally {
      await second.db.close()
    }
  } finally {
    tmp.cleanup()
  }
})

test('close 幂等；close 后调用抛 unavailable', async () => {
  const { db } = await openNodeSqliteDatabase()
  await db.close()
  await db.close()
  await assert.rejects(() => db.run('SELECT 1'), (error) => error.kind === 'unavailable')
})

test('打开损坏文件：映射为 unavailable（SQLITE_NOTADB / CORRUPT）', async () => {
  const { writeFileSync } = await import('node:fs')
  const tmp = makeTempSqliteDir()
  try {
    writeFileSync(join(tmp.dir, 'bad.db'), Buffer.from('this is definitely not a sqlite database file'.repeat(40)))
    await assert.rejects(
      () => openNodeSqliteDatabase({ dir: tmp.dir, name: 'bad.db' }),
      (error) => error instanceof SqliteDriverError && error.kind === 'unavailable',
    )
  } finally {
    tmp.cleanup()
  }
})

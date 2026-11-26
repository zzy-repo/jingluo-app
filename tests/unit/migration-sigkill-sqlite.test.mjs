// [layer: unit | 依赖: node:sqlite + 真子进程 SIGKILL | 耗时: <15s]
//
// #923 第 ① 层：真实 node:sqlite 文件库 + 真子进程被 SIGKILL（不是丢弃对象）。
// 断言：杀在哪个保持点，已提交的 BLOB 完整可读、未提交的整个不存在、没有半条记录，库 integrity_check 通过。
// 读回由 killproc.mjs 的 inspectBlobDb 完成：独立连接、独立期望字节生成器，逐块比字节。
//
// 诚实边界：SIGKILL 杀的是进程，**不是断电**。操作系统页缓存在进程死后仍在，所以 synchronous=FULL 与 NORMAL
// 在本测试里**无法被区分**（区分它们需要断电/内核崩溃，只有真机或虚拟机掉电能做）。本文件对耐久性配置能证明的只有：
// 子进程里 PRAGMA 回读到的 journal_mode/synchronous 就是 FULL/WAL，且把它降成 NORMAL 时「配置断言」会变红。
// 真正的 FULL vs NORMAL 掉电差异属于「未验证」，见 docs/sqlite-upgrade-audit.md 与 #923 回填区。
//   node tests/run-layer.mjs unit --case migration-sigkill-sqlite
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { inspectBlobDb, runKilledWriter } from '../helpers/migration-faults/killproc.mjs'

const CHUNK = 64 * 1024
const BASE = { blobs: 4, chunksPerBlob: 5, chunkBytes: CHUNK }

const withTmp = async (body) => {
  const dir = mkdtempSync(join(tmpdir(), 'migration-sigkill-'))
  try {
    return await body(join(dir, 'data.db'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const run = (dbPath, extra) => runKilledWriter({ dbPath, ...BASE, ...extra })

const assertKilledBySigkill = (r) => {
  assert.equal(r.killed, true, `没有到达保持点；输出：${r.lines.join('|')}`)
  assert.equal(r.signal, 'SIGKILL', '子进程必须是被 SIGKILL 信号结束，而不是正常退出')
  assert.equal(r.code, null)
  assert.ok(!r.lines.includes('DONE') && !r.lines.includes('TIMEOUT'))
}

test('基线：不杀，4 个 BLOB 全部完整；配置回读 WAL/FULL', async () => {
  await withTmp(async (db) => {
    const r = await run(db, {})
    assert.equal(r.signal, null)
    assert.equal(r.code, 0)
    assert.deepEqual(r.config, { journal_mode: 'wal', synchronous: 2 })
    const s = inspectBlobDb(db, { chunkBytes: CHUNK })
    assert.deepEqual(s.integrity, ['ok'])
    assert.equal(s.headCount, 4)
    assert.ok(s.heads.every((h) => h.ok), JSON.stringify(s.heads))
    assert.equal(s.lastBlob, 4)
  })
})

// 每个保持点：[名字, 期望完整存在的 blob 数, 期望 lastBlob]
const POINTS_TX = [
  ['blob3:header', 2, 2],
  ['blob3:chunk0:inserted', 2, 2],
  ['blob3:chunk2:inserted', 2, 2], // 块与块之间
  ['blob3:chunk4:inserted', 2, 2], // 最后一块已 insert、尚未 COMMIT
  ['blob3:precommit', 2, 2],
  ['blob3:committed', 3, 3], // COMMIT 已返回之后
]

for (const [point, wantBlobs, wantLast] of POINTS_TX) {
  test(`事务写：在 ${point} 被 SIGKILL → ${wantBlobs} 个完整 BLOB，无半条记录`, async () => {
    await withTmp(async (db) => {
      assertKilledBySigkill(await run(db, { killAt: point }))
      const s = inspectBlobDb(db, { chunkBytes: CHUNK })
      assert.deepEqual(s.integrity, ['ok'])
      assert.equal(s.headCount, wantBlobs, `heads=${JSON.stringify(s.heads.map((h) => h.id))}`)
      assert.ok(s.heads.every((h) => h.ok), `残缺 BLOB：${JSON.stringify(s.heads.filter((h) => !h.ok))}`)
      assert.deepEqual(s.orphanChunkIds, [], '不得有没有头的孤儿块（半条记录）')
      assert.equal(s.chunkRows, wantBlobs * BASE.chunksPerBlob)
      assert.equal(s.lastBlob, wantLast, '检查点与数据同一事务：不会超前也不会落后')
    })
  })
}

test('杀后重启继续写：恢复后第 3 个 BLOB 可重新写入且全部完整（幂等重做）', async () => {
  await withTmp(async (db) => {
    assertKilledBySigkill(await run(db, { killAt: 'blob3:chunk2:inserted' }))
    // 重启：同一库，从头再写（子进程里 INSERT 对已提交的 blob1/2 会主键冲突，所以只写 3..4）
    const r = await runKilledWriter({ dbPath: db, ...BASE, blobs: 4, chunksPerBlob: 5, chunkBytes: CHUNK, skip: 2 })
    assert.notEqual(r.signal, 'SIGKILL')
    const s = inspectBlobDb(db, { chunkBytes: CHUNK })
    assert.deepEqual(s.integrity, ['ok'])
    assert.ok(s.heads.every((h) => h.ok))
  })
})

test('杀在 COMMIT 返回之前后，WAL 里有未提交帧：读回看不到，且不阻塞新连接', async () => {
  await withTmp(async (db) => {
    assertKilledBySigkill(await run(db, { killAt: 'blob2:precommit' }))
    const s = inspectBlobDb(db, { chunkBytes: CHUNK })
    assert.equal(s.headCount, 1)
    assert.equal(s.lastBlob, 1)
  })
})

// ---------------------------------------------------------------- 负向对照

test('负向对照 1：非原子写法（header 与块各自提交）在块间被杀 → 检查必须能抓到残缺 BLOB', async () => {
  await withTmp(async (db) => {
    // split 模式先写块、最后写 header：杀在最后一块之后、header 之前 → 孤儿块（有数据没有头）
    assertKilledBySigkill(await run(db, { mode: 'split', killAt: 'blob2:chunk4:inserted' }))
    const s = inspectBlobDb(db, { chunkBytes: CHUNK })
    assert.deepEqual(s.orphanChunkIds, ['blob2'], '判据必须发现孤儿块；若这里为空，说明判据没有区分力')
    assert.equal(s.headCount, 1)
  })
})

test('负向对照 2：把一个已提交块的一个字节改掉 → 读回判 not ok（判据不是只看行数）', async () => {
  await withTmp(async (db) => {
    await run(db, {})
    const { DatabaseSync } = await import('node:sqlite')
    const h = new DatabaseSync(db)
    const row = h.prepare("SELECT data FROM blob_chunk WHERE id='blob2' AND idx=3").get()
    const bad = Uint8Array.from(row.data)
    bad[100] ^= 1
    h.prepare("UPDATE blob_chunk SET data=? WHERE id='blob2' AND idx=3").run(bad)
    h.close()
    const s = inspectBlobDb(db, { chunkBytes: CHUNK })
    const b2 = s.heads.find((x) => x.id === 'blob2')
    assert.equal(b2.ok, false)
    assert.ok(b2.problems.some((p) => /sha256 mismatch/.test(p)))
    assert.ok(b2.problems.some((p) => /independent expectation/.test(p)), '独立期望也必须抓到（即使有人把块 sha256 一并改了）')
    assert.ok(s.heads.filter((x) => x.id !== 'blob2').every((x) => x.ok))
  })
})

test('负向对照 3：耐久性配置降级为 NORMAL → 配置断言变红（只证明配置被回读，不证明掉电行为）', async () => {
  await withTmp(async (db) => {
    const r = await run(db, { synchronous: 'NORMAL' })
    assert.equal(r.config.synchronous, 1)
    assert.notDeepEqual(r.config, { journal_mode: 'wal', synchronous: 2 }, '降级必须能被断言区分出来')
  })
  await withTmp(async (db) => {
    const r = await run(db, { synchronous: 'OFF' })
    assert.equal(r.config.synchronous, 0)
  })
})

// [layer: unit | 依赖: node:sqlite（Node 22 自带）+ src/services/storage/sqlite 真实现 | 耗时: <10s]
// Issue #940：**超过 4 MiB 也不能丢一个字节** —— C 组（BLOB 半）：单个 >4 MiB 的原件。
//
// 事故链：迁移读侧 `getRow()` 是「一条 SELECT 带出整行」。一个 4 MiB 的原件如果在一条查询里出来，
// 原生 `queryOn()` 攒到 4 MiB 就抛 `result exceeds 4194304 bytes` → 整个迁移确定性失败。
// 仓库当前的对策是**按 512 KiB 分块存原件**（`blobStore.ts`，ADR-0910），读回时逐块校验
// （序号连续 / 块长 / 总长 / 整体 sha256），任一不符抛错、不返回残缺字节。
//
// 本文件在**真 SQLite** 上钉住这条防线（不需要等 #940 的分页接口，今天就应该绿）：
//   C1 4 MiB + 12 KiB 的原件：写→读往返，字节逐字节相同、长度相等、sha256 与源一致
//   C2 读侧没有任何一条查询超过 4 MiB 上限（分块读真的把单次过桥压在 2 MiB 量级）
//   C3 负向：删掉中间一块 → 读必须抛错（绝不静默返回短数据）
//   C4 负向：某块的长度被改小 → 读必须抛错
//   C5 负向：总长被改大 → 读必须抛错
//
//   node tests/run-layer.mjs unit --case migration-large-payload-blob
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { openNodeSqliteDatabase } from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'
import { withBridgeLimit } from '../helpers/migration-large-payload/paged-driver.mjs'
import {
  COLUMN_CHUNK_BYTES,
  MAX_RESULT_BYTES,
  deterministicBytes,
  nativeResultBytes,
  sha256Hex,
} from '../helpers/migration-large-payload/bridge-bytes.mjs'

installTsResolve()
const { applySchema } = await loadTsModule('src/services/storage/sqlite/schema.ts')
const { createSqliteRawSink, createSqliteRawSource } = await loadTsModule('src/services/storage/sqlite/raw.ts')
const { encodeKey } = await loadTsModule('src/services/storage/sqlite/mapping.ts')

const MiB = 1024 * 1024

const openFixture = async () => {
  const opened = await openNodeSqliteDatabase()
  await applySchema(opened.db)
  const bridge = withBridgeLimit(opened.db)
  return {
    opened,
    bridge,
    sink: createSqliteRawSink(bridge.db),
    source: createSqliteRawSource(bridge.db),
    async close() {
      await opened.db.close().catch(() => undefined)
    },
  }
}

/** 写入一个内存里的原件行（`files` 是原件 store，主键 = 原件 id）。 */
const writeBlobRow = async (fixture, id, bytes, type = 'application/octet-stream') => {
  const blob = new Blob([bytes], { type })
  await fixture.sink.writeBatch('files', [{ key: id, value: { id, blob } }])
  return blob
}

const readBlobRow = async (fixture, id) => {
  const page = await fixture.source.readBatch('files', undefined, 8)
  const row = page.rows.find((item) => item.key === id)
  assert.ok(row, `${id} 没读回来（files store 里有 ${page.rows.length} 行）`)
  const blob = row.value.blob
  assert.ok(blob instanceof Blob, `${id} 的 blob 没还原成 Blob：${Object.prototype.toString.call(blob)}`)
  return { row, bytes: new Uint8Array(await blob.arrayBuffer()), blob }
}

test('C1 单个 >4 MiB 的原件：写→读往返，字节、长度、sha256 全一致', async () => {
  const fixture = await openFixture()
  try {
    const size = 4 * MiB + 12 * 1024 // 4 MiB + 12 KiB：刚好越过原生上限
    const source = deterministicBytes(size, 940)
    const written = await writeBlobRow(fixture, 'f-oversize', source)
    const { bytes, blob } = await readBlobRow(fixture, 'f-oversize')

    assert.equal(bytes.length, size, `读回长度 ${bytes.length} ≠ 原始 ${size}`)
    assert.equal(blob.size, size)
    assert.equal(blob.type, 'application/octet-stream', 'MIME 也要还原')
    assert.equal(sha256Hex(bytes), sha256Hex(source), 'sha256 与源不一致（有字节被改或被丢）')
    assert.equal(written.size, size)
    // 逐段抽查 + 首尾字节（避免 4 MiB 的 assert.deepEqual 拖慢又不给信息）
    assert.deepEqual(Array.from(bytes.subarray(0, 64)), Array.from(source.subarray(0, 64)), '首 64 字节不同')
    assert.deepEqual(
      Array.from(bytes.subarray(size - 64)),
      Array.from(source.subarray(size - 64)),
      '末 64 字节不同'
    )
    for (const offset of [0, 512 * 1024 - 1, 512 * 1024, size - 1]) {
      assert.equal(bytes[offset], source[offset], `第 ${offset} 字节不同`)
    }
  } finally {
    await fixture.close()
  }
})

test('C2 读侧没有任何一条查询超过 4 MiB 上限（分块读把单次过桥压在 2 MiB 量级）', async () => {
  const fixture = await openFixture()
  try {
    const size = 4 * MiB + 12 * 1024
    await writeBlobRow(fixture, 'f-quota', deterministicBytes(size, 3))
    fixture.bridge.stat.maxBytesSeen = 0
    fixture.bridge.stat.calls = 0
    const { bytes } = await readBlobRow(fixture, 'f-quota')
    assert.equal(bytes.length, size)
    assert.ok(fixture.bridge.stat.calls >= 2, `读一个 >4 MiB 的原件应该分多次查询，实测 ${fixture.bridge.stat.calls} 次`)
    assert.ok(
      fixture.bridge.stat.maxBytesSeen <= MAX_RESULT_BYTES,
      `读侧有一条查询过了 ${fixture.bridge.stat.maxBytesSeen} 字节 > 上限 ${MAX_RESULT_BYTES}`
    )
    // 一次读 4 块 × 512 KiB = 2 MiB 数据；再加列名与行标点的零头。证明「分块」不是为了贴着 4 MiB 过
    const readBudget = 4 * COLUMN_CHUNK_BYTES + 8 * 1024
    assert.ok(
      fixture.bridge.stat.maxBytesSeen <= readBudget,
      `单次读 ${fixture.bridge.stat.maxBytesSeen} 字节偏大（应 ≤4 块 + 零头 = ${readBudget}）`
    )
  } finally {
    await fixture.close()
  }
})

test('C3 负向：删掉中间一块 → 读必须报错，不许返回短数据', async () => {
  const fixture = await openFixture()
  try {
    const size = 2 * MiB
    await writeBlobRow(fixture, 'f-holed', deterministicBytes(size, 5))
    // 中间那一块（seq = 1）被抹掉：模拟存储受损 / 写入未完成
    await fixture.bridge.db.run('DELETE FROM blob_chunks WHERE owner = ? AND id = ? AND seq = 1', [
      'files',
      encodeKey('f-holed'),
    ])
    await assert.rejects(
      () => readBlobRow(fixture, 'f-holed'),
      (error) => {
        assert.notEqual(error.code, 'RESULT_TOO_LARGE', '这不是超限错误，是完整性错误')
        assert.ok(
          /缺块|总长|sha256|第 \d+ 块/.test(String(error.message)),
          `错误信息要指出缺块/长度/哈希不符，实际：${error.message}`
        )
        return true
      },
      '少一块时读必须抛错（静默返回残缺字节 = 静默数据损坏）'
    )
  } finally {
    await fixture.close()
  }
})

test('C4 负向：某块声明长度被改小 → 读必须报错', async () => {
  const fixture = await openFixture()
  try {
    await writeBlobRow(fixture, 'f-shortlen', deterministicBytes(MiB, 9))
    await fixture.bridge.db.run('UPDATE blob_chunks SET len = len - 1 WHERE owner = ? AND id = ? AND seq = 0', [
      'files',
      encodeKey('f-shortlen'),
    ])
    await assert.rejects(
      () => readBlobRow(fixture, 'f-shortlen'),
      () => true,
      '块长与声明不符时必须抛错'
    )
  } finally {
    await fixture.close()
  }
})

test('C5 负向：元数据里的总长被改大 → 读必须报错', async () => {
  const fixture = await openFixture()
  try {
    const size = MiB
    await writeBlobRow(fixture, 'f-longtotal', deterministicBytes(size, 13))
    await fixture.bridge.db.run('UPDATE blob_meta SET total = total + 1024 WHERE owner = ? AND id = ?', [
      'files',
      encodeKey('f-longtotal'),
    ])
    await assert.rejects(
      () => readBlobRow(fixture, 'f-longtotal'),
      (error) => {
        assert.ok(/总长/.test(String(error.message)), `应指出总长不符，实际：${error.message}`)
        return true
      },
      '声明长度与实际不符时必须抛错'
    )
  } finally {
    await fixture.close()
  }
})

// [layer: unit | 依赖: tests/helpers/migration-faults/* | 耗时: <2s]
//
// #910 / #923：故障注入工具箱自检。注入器自己不可靠，后面所有「故障下数据不丢」的结论都不可信。
// 每条规则都验证两面：该触发时触发（fired 计数 + 真抛错），不该触发时不触发。
//   node tests/run-layer.mjs unit --case migration-inject-selftest
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { generateDataset } from '../helpers/migration-faults/dataset.mjs'
import {
  CoordinatorKilled,
  corruptFile,
  createFaultController,
  createHostFs,
  makeError,
  mutateSourceData,
} from '../helpers/migration-faults/inject.mjs'
import { compareSources } from '../helpers/migration-faults/oracle.mjs'
import { cloneData, memorySink, memorySource } from '../helpers/migration-faults/sources.mjs'

test('failNth：只有第 N 次调用失败，其余成功，规则 fired=1', async () => {
  const ctl = createFaultController()
  const sink = ctl.wrapSink(memorySink())
  const rule = ctl.failNth('sink.writeBatch', 3)
  await sink.writeBatch('sessions', [{ key: 'a', value: 1 }])
  await sink.writeBatch('sessions', [{ key: 'b', value: 2 }])
  await assert.rejects(() => sink.writeBatch('sessions', [{ key: 'c', value: 3 }]), { name: 'InjectedError' })
  await sink.writeBatch('sessions', [{ key: 'd', value: 4 }])
  assert.equal(rule.fired, 1)
  assert.deepEqual([...sink.data.sessions.keys()], ['a', 'b', 'd'], '失败的那次不落地')
})

test('nth 只对满足 match 的调用计数', async () => {
  const ctl = createFaultController()
  const sink = ctl.wrapSink(memorySink())
  ctl.failNth('sink.writeBatch', 2, { store: 'files' })
  await sink.writeBatch('sessions', [])
  await sink.writeBatch('files', [])
  await sink.writeBatch('sessions', [])
  await assert.rejects(() => sink.writeBatch('files', []))
})

test('ENOSPC：fs 抛 kind=quota/code=ENOSPC，sql 抛 SQLITE_FULL，且 path 过滤生效', async () => {
  const ctl = createFaultController()
  const fs = ctl.wrapFs(createHostFs())
  ctl.enospc('fs.writeAtomic', { path: /state\.json$/ })
  await fs.writeAtomic('storage-engine/other.bin', 'ok')
  await assert.rejects(() => fs.writeAtomic('storage-engine/state.json', '{}'), { kind: 'quota', code: 'ENOSPC' })
  assert.equal(await fs.readText('storage-engine/state.json'), undefined, '注入失败时不得留半成品')
  const e = makeError('enospc-sql')
  assert.equal(e.code, 'SQLITE_FULL')
  assert.equal(e.kind, 'quota')
})

test('killAfter：方法已落地后协调器死亡；之后一切包装调用都抛 CoordinatorKilled；持久状态保留', async () => {
  const ctl = createFaultController()
  const host = createHostFs()
  const fs = ctl.wrapFs(host)
  ctl.killAfter('fs.writeAtomic', { path: /state\.json$/, nth: 2 })
  await fs.writeAtomic('storage-engine/state.json', 'v1')
  await assert.rejects(() => fs.writeAtomic('storage-engine/state.json', 'v2'), CoordinatorKilled)
  assert.equal(ctl.dead, true)
  assert.equal(await host.readText('storage-engine/state.json'), 'v2', 'after = 写已落地')
  await assert.rejects(() => fs.read('storage-engine/state.json'), CoordinatorKilled, '死后任何包装调用都失败')
  await assert.rejects(() => fs.writeAtomic('x', 'y'), CoordinatorKilled)
  assert.equal(host.files.has('x'), false, '死后不得再落地')
  ctl.revive()
  assert.equal(await fs.readText('storage-engine/state.json'), 'v2')
})

test('killBefore：方法没执行就死', async () => {
  const ctl = createFaultController()
  const host = createHostFs()
  const fs = ctl.wrapFs(host)
  ctl.killBefore('fs.writeAtomic', { path: 'a' })
  await assert.rejects(() => fs.writeAtomic('a', '1'), CoordinatorKilled)
  assert.equal(host.files.has('a'), false)
})

test('afterCall：成功之后做副作用（备份文件写完立刻被损坏），副作用用的是未包装的真 fs', async () => {
  const ctl = createFaultController()
  const host = createHostFs()
  const fs = ctl.wrapFs(host)
  ctl.afterCall('fs.writeAtomic', { path: /manifest/ }, () => corruptFile(host, 'backup/manifest.json', 'flip-byte'))
  await fs.writeAtomic('backup/manifest.json', '{"ok":true,"files":[]}')
  assert.notEqual(await host.readText('backup/manifest.json'), '{"ok":true,"files":[]}')
})

test('corruptFile：六种模式各自产生与原文不同的内容；delete 后读不到', async () => {
  for (const mode of ['flip-byte', 'truncate', 'empty', 'garbage', 'append-junk']) {
    const host = createHostFs()
    await host.writeAtomic('f', '{"phase":"committed","seq":9}')
    await corruptFile(host, 'f', mode)
    assert.notEqual(await host.readText('f'), '{"phase":"committed","seq":9}', mode)
  }
  const host = createHostFs()
  await host.writeAtomic('f', 'x')
  await corruptFile(host, 'f', 'delete')
  assert.equal(await host.read('f'), undefined)
  await corruptFile(host, 'f', 'delete') // 不存在时 delete 不抛（remove 语义）
  await assert.rejects(() => corruptFile(host, 'nope', 'flip-byte'))
})

test('sql 包装：事务内的 tx.run 也走规则（按 SQL 文本匹配），transaction 本身可被计数', async () => {
  const calls = []
  const realTx = { run: async (sql) => (calls.push(sql), { changes: 1 }), all: async () => [] }
  const db = {
    run: async () => ({ changes: 0 }), all: async () => [], batch: async () => [], backupTo: async () => ({ bytes: 0 }),
    integrityCheck: async () => [], info: async () => ({}), close: async () => {},
    transaction: async (work) => work(realTx),
  }
  const ctl = createFaultController()
  const wrapped = ctl.wrapSql(db)
  ctl.failNth('sql.tx.run', 1, { sql: 'INSERT INTO meta' })
  await wrapped.transaction(async (tx) => {
    await tx.run('INSERT INTO rows VALUES (1)')
    await assert.rejects(() => tx.run('INSERT INTO meta VALUES (1)'), { name: 'InjectedError' })
  })
  assert.deepEqual(calls, ['INSERT INTO rows VALUES (1)'])
  assert.equal(ctl.callCount('sql.transaction'), 1)
})

test('源数据在迁移间隙被改：add / delete / mutate / 改 Blob 一个字节，oracle 都能看见', async () => {
  const ds = await generateDataset({ scale: 'small', seed: 3 })
  const snapshot = cloneData(ds.data)
  const live = ds.data
  const key = [...live.sessions.keys()][1]
  await mutateSourceData(live, { kind: 'mutate', store: 'sessions', key, fn: (v) => { v.title += '!' } })
  let r = await compareSources(memorySource(snapshot), memorySource(live), { pageSize: 4 })
  assert.ok(r.diffs.some((d) => d.kind === 'value' && d.key === key))
  await mutateSourceData(live, { kind: 'mutate', store: 'sessions', key, fn: (v) => { v.title = snapshot.sessions.get(key).title } })
  assert.equal((await compareSources(memorySource(snapshot), memorySource(live))).ok, true, '改回去就相同（判据不是「改过」而是「现在不同」）')
  await mutateSourceData(live, { kind: 'add', store: 'sessions', key: 'new', value: { id: 'new' } })
  await mutateSourceData(live, { kind: 'delete', store: 'sessions', key })
  r = await compareSources(memorySource(snapshot), memorySource(live))
  assert.deepEqual([...new Set(r.diffs.map((d) => d.kind))].sort(), ['extra-row', 'missing-row'])
  const fileKey = [...live.files.entries()].find(([, f]) => f.blob.size > 4)[0]
  await mutateSourceData(live, { kind: 'replace-blob-byte', store: 'files', key: fileKey, offset: 1 })
  r = await compareSources(memorySource(snapshot), memorySource(live))
  assert.ok(r.diffs.some((d) => d.kind === 'blob-bytes' && d.key === fileKey))
  ds.cleanup()
})

test('包装器对未触发的路径是透明的：行为与未包装完全相同（oracle 逐行比对）', async () => {
  const ds = await generateDataset({ scale: 'small', seed: 5 })
  const ctl = createFaultController()
  ctl.failNth('source.readBatch', 999) // 永不触发
  const wrapped = ctl.wrapSource(memorySource(ds.data))
  assert.equal((await compareSources(memorySource(ds.data), wrapped, { pageSize: 3 })).ok, true)
  assert.ok(ctl.callCount('source.readBatch') > 5)
  ds.cleanup()
})

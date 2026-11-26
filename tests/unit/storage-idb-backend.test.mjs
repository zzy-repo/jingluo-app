// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 chat/db.ts | 耗时: <5s]
//
// Issue #906：IndexedDB 后端（src/services/storage/idb）的**冒烟测试**，只证明薄适配没接错线：
// 每个仓储一两条，经 `getStorage()` 写、再用底层 `openDB` 直读（不经被测模块）核对落盘结果。
// 完整的契约测试（原子边界、错误映射、两后端一致性）由另一份用例负责，这里不重复。
//
//   node tests/run-layer.mjs unit --case storage-idb-backend
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDB } from 'idb'

import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installMinimalLocalStorage()
installEndpointsGlobals()
installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')
const storage = await loadTsModule('src/services/storage/index.ts')
const { DB_NAME } = db

const peek = async (storeName) => {
  const handle = await openDB(DB_NAME)
  try {
    return await handle.getAll(storeName)
  } finally {
    handle.close()
  }
}

const blobOf = (text, type = 'text/plain') => new Blob([text], { type })

const sessionOf = (id, { files = [], branchOf } = {}) => ({
  id,
  title: `会话 ${id}`,
  createdAt: 1,
  updatedAt: 1,
  ...(branchOf === undefined ? {} : { branchOf }),
  messages: [{ id: `${id}-u`, role: 'user', content: 'x', files, createdAt: 1 }],
})

const fileRef = (id) => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 1 })

const attachmentDraft = (overrides) => ({
  id: 'att-smoke',
  filename: 'smoke.txt',
  mimeType: 'text/plain',
  size: 4,
  sha256: 'ab'.repeat(32),
  status: 'pending',
  createdAt: 1,
  ...overrides,
})

const memoryRow = (sessionId, key, createdAt = 1) => ({
  id: `${sessionId}:${key}`,
  sessionId,
  key,
  text: key,
  bytes: key.length,
  createdAt,
  updatedAt: createdAt,
})

const backend = await storage.getStorage()

test('[单例] getStorage 返回同一实例；setStorageForTests 注入后返回替身，传 null 恢复', async () => {
  assert.equal(await storage.getStorage(), backend)
  const fake = { tag: 'fake' }
  storage.setStorageForTests(fake)
  assert.equal(await storage.getStorage(), fake)
  storage.setStorageForTests(null)
  const reopened = await storage.getStorage()
  assert.notEqual(reopened, fake)
  assert.equal(typeof reopened.sessions.save, 'function')
})

test('[SessionRepo] save → get / listSummaries；自愈语义原样返回 outcome', async () => {
  const outcome = await backend.sessions.save(sessionOf('s1', { files: [fileRef('img-1')] }), [
    { id: 'img-1', blob: blobOf('png', 'image/png') },
  ])
  assert.deepEqual(outcome, { failure: null, degradedFiles: [], strippedFields: [] })
  assert.equal((await backend.sessions.get('s1')).title, '会话 s1')
  assert.deepEqual((await backend.sessions.listSummaries()).map((row) => row.id), ['s1'])
  assert.equal(await (await backend.blobs.get('img-1')).text(), 'png', '原件随会话写入 files')
})

test('[SessionRepo] listReferencing / listBranchesOf / listFull 分页（主键游标）', async () => {
  await backend.sessions.save(sessionOf('s2', { files: [fileRef('img-1')] }))
  await backend.sessions.save(sessionOf('b1', { branchOf: { sessionId: 's1', messageId: 'm1' } }))
  assert.deepEqual([...(await backend.sessions.listReferencing('img-1'))].sort(), ['s1', 's2'])
  assert.deepEqual((await backend.sessions.listBranchesOf('s1')).map((row) => row.id), ['b1'])
  const first = await backend.sessions.listFull({ limit: 2 })
  assert.deepEqual(first.items.map((row) => row.id), ['b1', 's1'], '主键升序')
  assert.equal(first.next, 's1')
  const second = await backend.sessions.listFull({ after: first.next, limit: 2 })
  assert.deepEqual(second.items.map((row) => row.id), ['s2'])
  assert.equal(second.next, null)
  assert.equal((await backend.sessions.listFull()).items.length, 3, '不传 limit = 全部')
})

test('[SessionRepo] pin / rename / delete（删会话连带清引用归零的原件与本会话记忆）', async () => {
  await backend.sessions.pin('s2', 99)
  await backend.sessions.rename('s2', '改名')
  const summary = (await backend.sessions.listSummaries()).find((row) => row.id === 's2')
  assert.equal(summary.pinnedAt, 99)
  assert.equal(summary.title, '改名')
  await backend.memory.put(memoryRow('s2', 'k'), [])
  await backend.sessions.delete('s2')
  assert.equal(await backend.sessions.get('s2'), undefined)
  assert.ok(await backend.blobs.get('img-1'), 's1 仍引用 img-1，原件保留')
  assert.deepEqual(await backend.memory.listBySession('s2'), [])
  await backend.sessions.delete('s1')
  assert.equal(await backend.blobs.get('img-1'), undefined, '引用归零后原件被删')
  await backend.sessions.delete('b1')
})

test('[BlobRepo] putMany / listKeys 分页 / delete / clearExcept', async () => {
  await backend.blobs.putMany([
    { id: 'a', blob: blobOf('a') },
    { id: 'b', blob: blobOf('b') },
    { id: 'attachment-keep', blob: blobOf('k') },
  ])
  const page = await backend.blobs.listKeys({ limit: 2 })
  assert.deepEqual(page.items, ['a', 'attachment-keep'])
  assert.equal(page.next, 'attachment-keep')
  assert.deepEqual((await backend.blobs.listKeys({ after: page.next })).items, ['b'])
  await backend.blobs.delete('a')
  await backend.blobs.delete('不存在')
  await backend.blobs.clearExcept((key) => key.startsWith('attachment-'))
  assert.deepEqual((await peek('files')).map((row) => row.id), ['attachment-keep'])
  await backend.blobs.clearExcept(() => false)
})

test('[AssetRepo] put / get / delete，updatedAt 由实现填', async () => {
  await backend.assets.put('bg', blobOf('x', 'image/jpeg'))
  const asset = await backend.assets.get('bg')
  assert.equal(asset.key, 'bg')
  assert.equal(typeof asset.updatedAt, 'number')
  await backend.assets.delete('bg')
  assert.equal(await backend.assets.get('bg'), undefined)
})

test('[AttachmentRepo] add → get/list；writeText → readText；remove 引用归零连带清原件与全文', async () => {
  const record = await backend.attachments.add(attachmentDraft({}), blobOf('data'))
  assert.equal(record.localPath, `attachment-${'ab'.repeat(32)}`)
  assert.equal((await backend.attachments.get('att-smoke')).id, 'att-smoke')
  assert.equal((await backend.attachments.list()).length, 1)
  const text = await backend.attachments.writeText({
    sha256: record.sha256,
    parserVersion: 'v1',
    text: '正文',
    status: 'success',
  })
  assert.equal(text.characterCount, 2, 'characterCount 缺省取 text.length')
  assert.equal((await backend.attachments.readText(text.key)).text, '正文')
  assert.equal(await backend.attachments.readText(undefined), undefined)
  await backend.attachments.put({ ...record, parsedTextPath: text.key })
  assert.equal(await backend.attachments.remove('att-smoke'), 3, '元数据 + 全文 + 原件')
  assert.equal(await backend.attachments.remove('att-smoke'), 0)
  assert.deepEqual(await peek('files'), [])
})

test('[AttachmentRepo] removeUnreferenced / sweepOrphans 接到现有实现', async () => {
  await backend.attachments.add(attachmentDraft({ id: 'att-1', sha256: '01'.repeat(32) }), blobOf('1'))
  await backend.attachments.add(attachmentDraft({ id: 'att-2', sha256: '02'.repeat(32) }), blobOf('2'))
  assert.equal(await backend.attachments.removeUnreferenced(new Set(['att-1'])), 2)
  assert.deepEqual((await backend.attachments.list()).map((row) => row.id), ['att-1'])
  await backend.blobs.putMany([{ id: `attachment-${'03'.repeat(32)}`, blob: blobOf('orphan') }])
  assert.equal(await backend.attachments.sweepOrphans(), 1, '只清没有附件指向的原件')
  await backend.attachments.remove('att-1')
})

test('[MemoryRepo] put（含淘汰）/ get / listBySession 排序 / delete / clearSession 隔离', async () => {
  await backend.memory.put(memoryRow('m1', 'b', 2), [])
  await backend.memory.put(memoryRow('m1', 'a', 2), [])
  await backend.memory.put(memoryRow('m1', 'c', 1), [])
  await backend.memory.put(memoryRow('m2', 'a', 1), [])
  assert.deepEqual(
    (await backend.memory.listBySession('m1')).map((row) => row.key),
    ['c', 'a', 'b'],
    'createdAt 升序，同毫秒按主键升序'
  )
  assert.equal((await backend.memory.get('m1', 'a')).sessionId, 'm1')
  await backend.memory.put(memoryRow('m1', 'd', 3), ['m1:c'])
  assert.equal(await backend.memory.get('m1', 'c'), undefined, 'evictIds 同事务删除')
  assert.equal(await backend.memory.delete('m1', 'd'), true)
  assert.equal(await backend.memory.delete('m1', 'd'), false)
  assert.equal(await backend.memory.clearSession('m1'), 2)
  assert.equal((await backend.memory.listBySession('m2')).length, 1, '其它会话不动')
  await assert.rejects(() => backend.memory.listBySession('a:b'), /会话 ID 非法/)
  await backend.memory.clearSession('m2')
})

test('[StagingRepo] addSession 键冲突抛错；putFiles → commit 整包替换并清记忆；merge 不碰记忆', async () => {
  await backend.staging.clear()
  await backend.sessions.save(sessionOf('old'))
  await backend.memory.put(memoryRow('old', 'k'), [])
  await backend.staging.addSession(sessionOf('new', { files: [fileRef('img-n')] }))
  await assert.rejects(() => backend.staging.addSession(sessionOf('new')))
  await backend.staging.putFiles([{ id: 'img-n', blob: blobOf('n', 'image/png') }])
  const committed = await backend.staging.commit()
  assert.deepEqual(committed.map((row) => row.id), ['new'])
  assert.deepEqual((await backend.sessions.listSummaries()).map((row) => row.id), ['new'])
  assert.equal(await (await backend.blobs.get('img-n')).text(), 'n')
  assert.deepEqual(await peek('sessionMemory'), [], 'commit 清空全部记忆')
  assert.deepEqual(await peek('sessionsStaging'), [])

  await backend.memory.put(memoryRow('new', 'k'), [])
  await backend.staging.addSession(sessionOf('extra'))
  const plan = await backend.staging.merge({ onConflict: 'keep-newer' })
  assert.deepEqual(plan.written, ['extra'])
  assert.equal((await backend.memory.listBySession('new')).length, 1, 'merge 不碰记忆')
  await backend.memory.clearSession('new')
  await backend.sessions.delete('new')
  await backend.sessions.delete('extra')
  await backend.blobs.clearExcept(() => false)
})

test('[runAtomic] 回调抛错整体回滚且原样抛出；成功返回回调的值', async () => {
  const boom = new Error('业务错误')
  await assert.rejects(
    () =>
      backend.runAtomic(async (repos) => {
        await repos.assets.put('atomic', blobOf('x'))
        await repos.memory.put(memoryRow('at', 'k'), [])
        throw boom
      }),
    (error) => error === boom
  )
  assert.equal(await backend.assets.get('atomic'), undefined, '回滚')
  assert.deepEqual(await peek('sessionMemory'), [])
  const value = await backend.runAtomic(async (repos) => {
    await repos.assets.put('atomic', blobOf('y'))
    await repos.blobs.putMany([{ id: 'atomic-f', blob: blobOf('f') }])
    return 42
  })
  assert.equal(value, 42)
  assert.ok(await backend.assets.get('atomic'))
  assert.ok(await backend.blobs.get('atomic-f'))
  await backend.assets.delete('atomic')
  await backend.blobs.delete('atomic-f')
})

test('[health / probe] 正常时 ok；persisted 在无 StorageManager 的宿主为 undefined', async () => {
  assert.deepEqual(await backend.health(), { ok: true })
  const probe = await backend.probe()
  assert.deepEqual(probe.health, { ok: true })
  assert.equal(probe.versionTooNew, false)
})

test('[close] 幂等；关闭后各仓储方法抛 StorageUnavailableError，重新 getStorage 可恢复', async () => {
  await backend.close()
  await backend.close()
  await assert.rejects(() => backend.sessions.get('x'), (error) => error.name === 'StorageUnavailableError')
  await assert.rejects(() => backend.runAtomic(async () => 1), (error) => error.name === 'StorageUnavailableError')
  assert.equal((await backend.health()).ok, false)
  // getStorage 单例的 close 会让缓存失效；此处直接重开验证连接可恢复（沿用 db.ts 重连语义）
  const again = await storage.openIndexedDbStorage()
  assert.equal(await again.sessions.get('x'), undefined)
})

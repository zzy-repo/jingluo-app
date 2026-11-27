// [layer: unit | 依赖: fake-indexeddb + 真 chat/db.ts（模块级连接单例） | 耗时: <10s]
//
// #910 迁移引擎：IndexedDB 原始行只读源（createIdbRawSource）。钉三件事：
//   1. 9 个 store 的原始行全部读回（含全部字段、Blob 保持 Blob、主键升序分页）；
//   2. estimateBytes 含 Blob 大小且宁高勿低；
//   3. 旧库只读：把 IDBObjectStore 与 IDBCursor 的全部写方法打桩成抛错后，整套读取仍成功。
//
// 机制类别：进程级全局（改写 IDBObjectStore.prototype）+ 模块级单例（chat/db.ts 的连接缓存）
// —— 合批会打到同批其它文件的写入，登记 UNIT_SOLO（技术债，见 docs/sqlite-migration-plan.md 第 6 节）。
//
//   node tests/run-layer.mjs unit --case migration-engine-raw
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installMinimalLocalStorage()
installEndpointsGlobals()
installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')
const idbRaw = await loadTsModule('src/services/storage/idb/raw.ts')
const hash = await loadTsModule('src/services/storage/migration/hash.ts')
const { RAW_STORE_NAMES } = await loadTsModule('src/services/storage/migration/types.ts')

const source = idbRaw.createIdbRawSource()

const blobOf = (text, type = 'text/plain') => new Blob([new TextEncoder().encode(text)], { type })

const sessionOf = (id, fileId) => ({
  id,
  title: `会话 ${id}`,
  createdAt: 1000,
  updatedAt: 2000,
  pinnedAt: id === 's-a' ? 3000 : undefined,
  messages: [
    { id: `${id}-u`, role: 'user', content: `你好 ${id}`, createdAt: 1000, files: [{ id: fileId, name: `${fileId}.png`, mimeType: 'image/png', size: 4 }] },
    { id: `${id}-a`, role: 'assistant', content: `回答 ${id}`, createdAt: 1001 },
  ],
})

const readAll = async (store) => {
  const rows = []
  let after
  for (;;) {
    const page = await source.readBatch(store, after, 2)
    assert.ok(page.rows.length <= 2)
    rows.push(...page.rows)
    if (page.next === undefined) return rows
    assert.ok(page.next > (after ?? ''), '分页必须前进')
    after = page.next
  }
}

const seed = async () => {
  const a = sessionOf('s-a', 'img-a')
  const b = sessionOf('s-b', 'img-b')
  await db.saveSession(a)
  await db.saveSession(b)
  await db.saveFiles([
    { id: 'img-a', blob: blobOf('AAAA', 'image/png') },
    { id: 'img-b', blob: blobOf('BBBB', 'image/png') },
    { id: 'attachment-deadbeef', blob: blobOf('doc-bytes') },
  ])
  await db.saveAppAsset('chat-background:default', blobOf('bg', 'image/jpeg'))
  await db.addStagingSession({ id: 'stg-1', title: 'staging', createdAt: 1, updatedAt: 1, messages: [] })
  await db.saveStagingFiles([{ id: 'stg-file', blob: blobOf('staging-blob') }])
  // 附件元数据 / 全文 / 记忆：夹具直接写原始行（写的是测试库，不是被测的 raw.ts）
  const handle = await db.getChatDB()
  const digest = 'ab'.repeat(32)
  await handle.put('attachments', {
    id: 'att-1',
    filename: 'doc.txt',
    mimeType: 'text/plain',
    size: 9,
    sha256: digest,
    localPath: 'attachment-deadbeef',
    parsedTextPath: `${digest}:v1`,
    status: 'success',
    characterCount: 4,
    warnings: ['w1'],
    createdAt: 5,
  })
  await handle.put('attachmentTexts', {
    key: `${digest}:v1`,
    sha256: digest,
    parserVersion: 'v1',
    text: '全文',
    characterCount: 2,
    status: 'success',
    createdAt: 6,
  })
  await handle.put('sessionMemory', {
    id: 's-a:chunk-0',
    sessionId: 's-a',
    key: 'chunk-0',
    text: '记忆',
    vec: [0.5, -1],
    model: 'm',
    dim: 2,
    bytes: 10,
    createdAt: 7,
    updatedAt: 8,
  })
}

await seed()

const WRITE_METHODS = ['put', 'add', 'delete', 'clear']

test('9 个 store 的原始行全部读回：字段完整、Blob 保持 Blob、主键升序、count 一致', async () => {
  for (const store of RAW_STORE_NAMES) {
    const rows = await readAll(store)
    assert.equal(rows.length, await source.count(store), store)
    assert.deepEqual(rows.map((r) => r.key), [...rows.map((r) => r.key)].sort(), `${store} 主键必须升序`)
    assert.ok(rows.length > 0, `${store} 夹具应非空`)
  }
  const sessions = await readAll('sessions')
  const a = sessions.find((r) => r.key === 's-a').value
  assert.equal(a.title, '会话 s-a')
  assert.equal(a.pinnedAt, 3000)
  assert.equal(a.messages[0].files[0].id, 'img-a')
  const files = await readAll('files')
  const img = files.find((r) => r.key === 'img-a').value
  assert.ok(img.blob instanceof Blob, 'Blob 字段必须保持 Blob，不许预先序列化')
  assert.equal(await img.blob.text(), 'AAAA')
  assert.equal(img.blob.type, 'image/png')
  const attachment = (await readAll('attachments')).find((r) => r.key === 'att-1').value
  assert.deepEqual(attachment.warnings, ['w1'])
  assert.equal(attachment.localPath, 'attachment-deadbeef')
  const memory = (await readAll('sessionMemory')).find((r) => r.key === 's-a:chunk-0').value
  assert.deepEqual(memory.vec, [0.5, -1])
  const asset = (await readAll('appAssets')).find((r) => r.key === 'chat-background:default').value
  assert.ok(asset.blob instanceof Blob)
  assert.equal(typeof asset.updatedAt, 'number')
  const staging = await readAll('sessionsStaging')
  assert.equal(staging[0].value.title, 'staging')
  const stagingFile = (await readAll('filesStaging'))[0].value
  assert.ok(stagingFile.blob instanceof Blob)
})

test('estimateBytes 含 Blob 大小且宁高勿低', async () => {
  let lower = 0
  for (const store of RAW_STORE_NAMES) {
    for (const row of await readAll(store)) {
      lower += hash.estimateRowBytes(row)
    }
  }
  assert.ok(lower > 0)
  const estimate = await source.estimateBytes()
  assert.ok(estimate >= lower, `estimateBytes=${estimate} 低于逐行估算 ${lower}`)
})

test('旧库只读：store 与游标的全部写方法打桩成抛错后，count / 分页读取 / estimateBytes 仍成功', async () => {
  const before = {}
  for (const store of RAW_STORE_NAMES) {
    before[store] = await source.count(store)
  }
  const boom = () => {
    throw new Error('raw source 不得对旧库写入')
  }
  const originals = {}
  for (const method of WRITE_METHODS) {
    originals[method] = IDBObjectStore.prototype[method]
    IDBObjectStore.prototype[method] = boom
  }
  const cursorOriginals = {
    update: IDBCursor.prototype.update,
    delete: IDBCursor.prototype.delete,
  }
  IDBCursor.prototype.update = boom
  IDBCursor.prototype.delete = boom
  // 再钉一层：raw.ts 开的每个事务模式必须是 readonly（打桩只能抓到「调了写方法」，抓不到「开了写事务」）
  const txModes = []
  const originalTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
    txModes.push(mode ?? 'readonly')
    return originalTransaction.call(this, stores, mode, ...rest)
  }
  try {
    for (const store of RAW_STORE_NAMES) {
      const rows = await readAll(store)
      assert.equal(rows.length, before[store], store)
    }
    assert.ok((await source.estimateBytes()) > 0)
    for (const store of RAW_STORE_NAMES) {
      assert.equal(await source.count(store), before[store], '读取过程中计数不得变化')
    }
    assert.ok(txModes.length > 0)
    assert.deepEqual([...new Set(txModes)], ['readonly'], '只允许 readonly 事务')
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction
    for (const method of WRITE_METHODS) {
      IDBObjectStore.prototype[method] = originals[method]
    }
    IDBCursor.prototype.update = cursorOriginals.update
    IDBCursor.prototype.delete = cursorOriginals.delete
  }
})

test('分页边界：limit 大于总数时一页读完且没有 next', async () => {
  const page = await source.readBatch('sessions', undefined, 1000)
  assert.equal(page.next, undefined)
  assert.equal(page.rows.length, await source.count('sessions'))
  const first = await source.readBatch('sessions', undefined, 1)
  assert.equal(first.rows.length, 1)
  assert.equal(first.next, first.rows[0].key)
  const rest = await source.readBatch('sessions', first.next, 1000)
  assert.ok(rest.rows.every((r) => r.key > first.next))
})

// [layer: unit | 依赖: fake-indexeddb（devDependency，纯 Node 内存 IndexedDB） | 耗时: <3s]
//
// Issue #906（存储仓储抽象）的**特征化测试**：附件 / 应用资源 / 会话记忆这几处直接碰
// IndexedDB 原语，是抽象的重点。本文件把它们**今天**的对外行为钉死，作为「抽象之后行为
// 零变化」的证据。只断言，不修任何 src。
//
// 已有测试覆盖、这里不重复（check:test-duplication 的 R1）：
//   - attachment-store-572：同内容去重（一份原件 / 一份全文 / 只解析一次）、parserVersion 分键、
//     引用计数删除、坏全文容错；
//   - attachment-add：legacy WebCrypto 哈希复用与补回、并发添加、写失败与提交前中止的回滚；
//   - attachment-preserve-import-531：commitStaging 保留 attachment- 原件、sweep 不误删仍被引用的、
//     sweepOrphans(referenced) 按孤儿回收；
//   - memory-session-scope-399：跨会话隔离、覆盖写、容量淘汰、删会话联动清记忆、向量开关、
//     单条超限拒绝、迁移不变量；
//   - session-branch-831：attachmentAvailable 的正例与「原件不在 → 不可用」。
//
// 本文件补的缺口：
//   [A] appAssets：load 未设置 = undefined、save 覆盖且 updatedAt 前进、delete 幂等、
//       全局 key 与会话 key 互不覆盖、appAssets.ts 的 read* 未设置时按 null 收口、
//       写失败整条回滚、不存在的 key 删除不波及其它；
//   [B] attachments/store：get 不存在 = undefined、list 形状、parsedTextPath 索引查询、
//       跨 sha256 删除不误伤、remove 不存在返回 0、removeUnreferenced 空集合全清 /
//       命中集合一条不动、sweep 只清 attachment- 前缀（聊天图片原件不动）、
//       非 attachment- 的 localPath 不删 files、putAttachment 覆盖、
//       writeAttachmentTextRecord 的键 / characterCount 缺省 / 可选字段省略 / 幂等覆盖、
//       删除时共享全文但不同 sha256 的引用计数；
//   [C] sessionMemory：read/list 不存在 = undefined / []、deleteMemoryEntry 返回布尔且重复删
//       为 false、clearSessionMemory 只清本会话并返回条数、非法 sessionId 与空 key 在入口
//       拒绝且库不变、覆盖写不留旧向量、commitStaging 清空记忆而 mergeStaging 不动记忆；
//   [D] 关联一致性：deleteSession 的 fileIds 引用计数不删 attachment- 原件与仍被引用的图片、
//       attachmentAvailable 对图片 id 与 att- id 的缺失判定。
//
// 负向对照（见提交说明）：逐条临时改坏 src 对应逻辑后本文件变红，git checkout 还原。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/storage-char-blob-attach.test.mjs
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
const store = await loadTsModule('src/services/attachments/store.ts')
const branchAttachments = await loadTsModule('src/services/chat/branchAttachments.ts')
const appAssets = await loadTsModule('src/services/chat/appAssets.ts')
const memory = await loadTsModule('src/services/memory/sessionMemory.ts')

const { DB_NAME } = db

/** 底层只读观察点：断言「库里到底有什么」时集中走这里，用例本体只调对外函数。 */
const peek = async (storeName) => {
  const handle = await openDB(DB_NAME)
  try {
    return await handle.getAll(storeName)
  } finally {
    handle.close()
  }
}
const peekKeys = async (storeName) => (await peek(storeName)).map((row) => row.id ?? row.key)

const blobOf = (text, type = 'text/plain') => new Blob([text], { type })

const attachmentDraft = (overrides) => ({
  id: 'att-probe',
  filename: 'probe.txt',
  mimeType: 'text/plain',
  size: 4,
  sha256: 'aa'.repeat(32),
  status: 'pending',
  createdAt: 1,
  ...overrides,
})

const sessionOf = (id, files = []) => ({
  id,
  title: `会话 ${id}`,
  createdAt: 1,
  updatedAt: 1,
  messages: [{ id: `${id}-u`, role: 'user', content: 'x', files, createdAt: 1 }],
})

// ───────────────────────────────────────── [A] appAssets

test('[A1] loadAppAsset 未设置返回 undefined；save 覆盖同 key 且 updatedAt 单调前进', async () => {
  const KEY = 'probe-asset-a1'
  assert.equal(await db.loadAppAsset(KEY), undefined, '没写过的 key 是 undefined，不是 null 也不是抛错')

  const first = blobOf('first', 'image/jpeg')
  await db.saveAppAsset(KEY, first)
  const saved = await db.loadAppAsset(KEY)
  assert.equal(saved.key, KEY)
  assert.equal(await saved.blob.text(), 'first', '读回的是写入的那份字节')
  assert.equal(saved.blob.type, 'image/jpeg', 'blob 的 MIME 原样保留')
  assert.equal(typeof saved.updatedAt, 'number')

  await db.saveAppAsset(KEY, blobOf('second', 'image/png'))
  const rows = (await peek('appAssets')).filter((row) => row.key === KEY)
  assert.equal(rows.length, 1, '同 key 再写是覆盖，不产生第二条')
  const again = await db.loadAppAsset(KEY)
  assert.equal(await again.blob.text(), 'second')
  assert.ok(again.updatedAt >= saved.updatedAt, '覆盖写的 updatedAt 不回退（同毫秒时相等也成立）')

  await db.deleteAppAsset(KEY)
})

test('[A2] deleteAppAsset 幂等；删一个 key 不影响别的 key', async () => {
  await db.saveAppAsset('probe-asset-keep', blobOf('keep'))
  await db.saveAppAsset('probe-asset-drop', blobOf('drop'))
  await db.deleteAppAsset('probe-asset-drop')
  await db.deleteAppAsset('probe-asset-drop')
  await db.deleteAppAsset('probe-asset-never')
  assert.equal(await db.loadAppAsset('probe-asset-drop'), undefined)
  assert.equal(await (await db.loadAppAsset('probe-asset-keep')).blob.text(), 'keep')
  await db.deleteAppAsset('probe-asset-keep')
})

test('[A3] 全局背景 key 与会话背景 key 互不覆盖，读不到时按 null 收口', async () => {
  assert.equal(await appAssets.readChatBackground(), null, '未设置的全局背景是 null 不是 undefined')
  assert.equal(await appAssets.readSessionBackground('sess-none'), null)

  const globalBlob = blobOf('global-jpeg', 'image/jpeg')
  const sessionBlob = blobOf('session-jpeg', 'image/jpeg')
  await db.saveAppAsset(appAssets.CHAT_BACKGROUND_KEY, globalBlob)
  await appAssets.saveSessionBackgroundAsset('sess-a3', sessionBlob)

  assert.equal(appAssets.sessionBackgroundKey('sess-a3'), 'chat-background:session:sess-a3')
  assert.equal(await (await appAssets.readChatBackground()).text(), 'global-jpeg')
  assert.equal(await (await appAssets.readSessionBackground('sess-a3')).text(), 'session-jpeg')
  assert.equal(await appAssets.readSessionBackground('sess-other'), null, '别的会话读不到这一份')

  await appAssets.clearChatBackground()
  assert.equal(await appAssets.readChatBackground(), null, '清全局不影响会话图')
  assert.equal(await (await appAssets.readSessionBackground('sess-a3')).text(), 'session-jpeg')
  await appAssets.clearSessionBackground('sess-a3')
  assert.equal(await appAssets.readSessionBackground('sess-a3'), null)
  assert.equal((await peek('appAssets')).some((row) => row.key.startsWith('chat-background')), false)
})

test('[A4] saveAppAsset 写失败整条回滚：库里既无新 key 也不留半条', async (t) => {
  const original = IDBObjectStore.prototype.put
  t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    if (this.name === 'appAssets') throw new DOMException('injected', 'QuotaExceededError')
    return original.apply(this, args)
  })
  const before = await peekKeys('appAssets')
  await assert.rejects(db.saveAppAsset('probe-asset-fail', blobOf('nope')), { name: 'QuotaExceededError' })
  assert.deepEqual(await peekKeys('appAssets'), before, '失败后 appAssets 与失败前逐键相同')
})

// ───────────────────────────────────────── [B] attachments/store

test('[B1] getAttachment 不存在返回 undefined；listAttachments 返回全部记录', async () => {
  assert.equal(await store.getAttachment('att-does-not-exist'), undefined)
  const before = await store.listAttachments()
  const draft = attachmentDraft({ id: 'att-b1' })
  const saved = await store.saveNewAttachment(draft, blobOf('b1'))
  assert.equal(saved.localPath, `attachment-${draft.sha256}`, '返回值补上内容寻址的 localPath')
  assert.equal(saved.status, 'pending')
  const listed = await store.listAttachments()
  assert.equal(listed.length, before.length + 1)
  assert.deepEqual(listed.find((row) => row.id === 'att-b1'), saved, 'list 里的记录与写入返回值同形')
  await store.removeAttachment('att-b1')
})

test('[B2] 全文记录：键形状、characterCount 缺省取 text.length、可选字段省略、缺 key 读 undefined、同键覆盖', async () => {
  assert.equal(await store.readAttachmentTextRecord(undefined), undefined, '没有 parsedTextPath 时直接 undefined')
  assert.equal(await store.readAttachmentTextRecord('missing:txt-1'), undefined)

  const written = await store.writeAttachmentTextRecord({
    sha256: 'b2hash',
    parserVersion: 'txt-1',
    text: '一二三',
    status: 'partial',
  })
  assert.equal(written.key, 'b2hash:txt-1')
  assert.equal(written.characterCount, 3, '缺省 characterCount = text.length')
  assert.equal(written.totalPages, undefined, '没传的可选字段不落库（不是 null）')
  assert.equal(written.warnings, undefined, '空 warnings 不落库')
  assert.equal(typeof written.createdAt, 'number')

  const rich = await store.writeAttachmentTextRecord({
    sha256: 'b2hash',
    parserVersion: 'txt-1',
    text: '一二三',
    characterCount: 2,
    status: 'success',
    totalPages: 4,
    extractedPages: 3,
    warnings: ['一页是扫描件'],
  })
  assert.equal(rich.characterCount, 2, '显式传入的字数不被 text.length 覆盖')
  assert.equal(rich.totalPages, 4)
  assert.deepEqual(rich.warnings, ['一页是扫描件'])
  const rows = (await peek('attachmentTexts')).filter((row) => row.sha256 === 'b2hash')
  assert.equal(rows.length, 1, '同 sha256:parserVersion 再写是覆盖')
  assert.equal(rows[0].status, 'success')

  const handle = await openDB(DB_NAME)
  await handle.delete('attachmentTexts', 'b2hash:txt-1')
  handle.close()
})

test('[B3] parsedTextPath 索引：删一条只回收无人再指向的全文，别的 sha256 的全文不动', async () => {
  const shared = 'shared-b3:txt-1'
  await store.writeAttachmentTextRecord({ sha256: 'shared-b3', parserVersion: 'txt-1', text: '共用正文', status: 'success' })
  await store.writeAttachmentTextRecord({ sha256: 'other-b3', parserVersion: 'txt-1', text: '另一份', status: 'success' })
  for (const id of ['att-b3-a', 'att-b3-b']) {
    await store.saveNewAttachment(
      attachmentDraft({ id, sha256: id, parsedTextPath: id === 'att-b3-b' ? 'other-b3:txt-1' : shared }),
      blobOf(id)
    )
  }
  // 两条不同内容的附件指向同一份全文（parsedTextPath 相同、sha256 不同）
  await store.putAttachment({ ...(await store.getAttachment('att-b3-a')), parsedTextPath: shared })
  const retargeted = await store.getAttachment('att-b3-b')
  await store.putAttachment({ ...retargeted, parsedTextPath: shared })

  assert.equal(await store.removeAttachment('att-b3-a'), 2, '元数据 1 + 它独占的原件 1；全文仍被 b 指向')
  assert.equal((await peekKeys('attachmentTexts')).includes(shared), true, '还有引用 ⇒ 全文不删')
  assert.equal(await store.removeAttachment('att-b3-b'), 3, '最后一条：元数据 + 原件 + 全文')
  assert.equal((await peekKeys('attachmentTexts')).includes(shared), false)
  assert.equal((await peekKeys('attachmentTexts')).includes('other-b3:txt-1'), true, '没人删过的全文留着')

  const handle = await openDB(DB_NAME)
  await handle.delete('attachmentTexts', 'other-b3:txt-1')
  handle.close()
})

test('[B4] removeAttachment 不存在返回 0；localPath 不是 attachment- 前缀时不碰 files', async () => {
  assert.equal(await store.removeAttachment('att-never-existed'), 0)

  const handle = await openDB(DB_NAME)
  await handle.put('files', { id: 'chat-image-b4', blob: blobOf('img', 'image/png') })
  await handle.put('attachments', attachmentDraft({
    id: 'att-b4',
    sha256: 'b4hash',
    localPath: 'chat-image-b4',
    parsedTextPath: undefined,
  }))
  handle.close()

  assert.equal(await store.removeAttachment('att-b4'), 1, '只删元数据：非本模块的 files 键不算它的')
  assert.equal((await peekKeys('files')).includes('chat-image-b4'), true, '聊天图片原件原封不动')
  const cleanup = await openDB(DB_NAME)
  await cleanup.delete('files', 'chat-image-b4')
  cleanup.close()
})

test('[B5] removeUnreferencedAttachments：空集合清光，命中的集合一条不动', async () => {
  const ids = ['att-b5-a', 'att-b5-b']
  for (const id of ids) {
    await store.saveNewAttachment(attachmentDraft({ id, sha256: id }), blobOf(id))
  }
  assert.equal(await store.removeUnreferencedAttachments(new Set(['att-b5-a'])), 2, 'b 的元数据 + 原件')
  assert.notEqual(await store.getAttachment('att-b5-a'), undefined, '在集合里的不动')
  assert.equal(await store.getAttachment('att-b5-b'), undefined)
  assert.equal((await peekKeys('files')).includes('attachment-att-b5-b'), false, '失去引用的原件一起走')
  assert.equal((await peekKeys('files')).includes('attachment-att-b5-a'), true)

  const removed = await store.removeUnreferencedAttachments(new Set())
  assert.ok(removed >= 2, '空集合 = 一个不留')
  assert.equal(await store.getAttachment('att-b5-a'), undefined)
  assert.equal((await peekKeys('files')).includes('attachment-att-b5-a'), false)
})

test('[B6] sweepOrphanStorage 只清 attachment- 前缀的无主原件与无主全文，聊天图片不动', async () => {
  await store.saveNewAttachment(attachmentDraft({ id: 'att-b6', sha256: 'b6live' }), blobOf('live'))
  await store.writeAttachmentTextRecord({ sha256: 'b6orphan', parserVersion: 'txt-1', text: '没人指向', status: 'success' })
  const handle = await openDB(DB_NAME)
  await handle.put('files', { id: 'attachment-b6dead', blob: blobOf('dead') })
  await handle.put('files', { id: 'chat-image-b6', blob: blobOf('img', 'image/png') })
  handle.close()

  const removed = await store.sweepOrphanStorage()
  assert.equal(removed, 2, '一条无主全文 + 一条无主原件')
  const keys = await peekKeys('files')
  assert.equal(keys.includes('attachment-b6dead'), false)
  assert.equal(keys.includes('attachment-b6live'), true, '仍被元数据引用的原件不删')
  assert.equal(keys.includes('chat-image-b6'), true, '没有 attachment- 前缀的键一律不碰')
  assert.equal((await peekKeys('attachmentTexts')).includes('b6orphan:txt-1'), false)
  assert.notEqual(await store.getAttachment('att-b6'), undefined, '清扫不删元数据')

  await store.removeAttachment('att-b6')
  const cleanup = await openDB(DB_NAME)
  await cleanup.delete('files', 'chat-image-b6')
  cleanup.close()
})

test('[B7] putAttachment 按 id 覆盖且不产生第二条', async () => {
  const saved = await store.saveNewAttachment(attachmentDraft({ id: 'att-b7', sha256: 'b7hash' }), blobOf('b7'))
  await store.putAttachment({ ...saved, filename: 'renamed.txt', status: 'failed', errorMessage: 'boom' })
  const rows = (await peek('attachments')).filter((row) => row.id === 'att-b7')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].filename, 'renamed.txt')
  assert.equal(rows[0].status, 'failed')
  assert.equal(rows[0].sha256, 'b7hash', '没改的字段原样保留')
  await store.removeAttachment('att-b7')
})

// ───────────────────────────────────────── [C] sessionMemory

test('[C1] 读不存在返回 undefined、列不存在的会话返回 []；deleteMemoryEntry 报告真假，重复删为 false', async () => {
  const session = 'sess-906-c1'
  assert.equal(await memory.readMemoryEntry(session, 'nope'), undefined)
  assert.deepEqual(await memory.listMemoryEntries(session), [])

  const outcome = await memory.saveMemoryEntry(session, { key: 'k1', text: '第一条' })
  assert.equal(outcome.written, true)
  assert.equal(outcome.evicted, 0)
  assert.deepEqual(outcome.evictedKeys, [])
  assert.equal(outcome.entry.key, 'k1')
  assert.equal(outcome.entry.text, '第一条')
  assert.equal(outcome.entry.vec, undefined, '默认关闭态不写向量')
  assert.equal(outcome.entry.bytes, memory.memoryEntryBytes('第一条'))

  const listed = await memory.listMemoryEntries(session)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].key, 'k1')

  assert.equal(await memory.deleteMemoryEntry(session, 'k1'), true)
  assert.equal(await memory.readMemoryEntry(session, 'k1'), undefined)
  assert.equal(await memory.deleteMemoryEntry(session, 'k1'), false, '再删同键返回 false，不抛错')
  assert.equal(await memory.deleteMemoryEntry(session, 'never'), false)
})

test('[C2] clearSessionMemory 只清本会话并返回条数，别的会话一条不动', async () => {
  for (const session of ['sess-906-c2a', 'sess-906-c2b']) {
    await memory.saveMemoryEntry(session, { key: 'k', text: session })
  }
  assert.equal(await memory.clearSessionMemory('sess-906-c2a'), 1)
  assert.equal(await memory.clearSessionMemory('sess-906-c2a'), 0, '清空后再清返回 0')
  assert.deepEqual(await memory.listMemoryEntries('sess-906-c2a'), [])
  assert.equal((await memory.listMemoryEntries('sess-906-c2b')).length, 1)
  await memory.clearSessionMemory('sess-906-c2b')
})

test('[C3] 非法 sessionId 与空 key 在入口拒绝，库里不留半条', async () => {
  const before = (await peek('sessionMemory')).length
  for (const bad of ['', 'a:b']) {
    await assert.rejects(memory.saveMemoryEntry(bad, { key: 'k', text: 'x' }), /会话 ID 非法/)
    await assert.rejects(memory.readMemoryEntry(bad, 'k'), /会话 ID 非法/)
    await assert.rejects(memory.listMemoryEntries(bad), /会话 ID 非法/)
    await assert.rejects(memory.deleteMemoryEntry(bad, 'k'), /会话 ID 非法/)
    await assert.rejects(memory.clearSessionMemory(bad), /会话 ID 非法/)
  }
  await assert.rejects(memory.saveMemoryEntry('sess-906-c3', { key: '', text: 'x' }), /记忆 key 不能为空/)
  assert.equal((await peek('sessionMemory')).length, before, '拒绝发生在写库之前')
})

test('[C4] 覆盖写丢掉旧向量字段：新值没有向量时，记录上不再残留 vec/model/dim', async () => {
  const session = 'sess-906-c4'
  const handle = await openDB(DB_NAME)
  await handle.put('sessionMemory', {
    id: `${session}:k`,
    sessionId: session,
    key: 'k',
    text: '旧',
    vec: [0.1, 0.2],
    model: 'old-model',
    dim: 2,
    bytes: 4,
    createdAt: 1,
    updatedAt: 1,
  })
  handle.close()

  const outcome = await memory.saveMemoryEntry(session, { key: 'k', text: '新' })
  assert.equal(outcome.written, true)
  assert.equal(outcome.entry.createdAt, 1, '覆盖写保留首次 createdAt')
  assert.equal(outcome.entry.vec, undefined)
  const row = (await peek('sessionMemory')).find((item) => item.id === `${session}:k`)
  assert.equal(row.text, '新')
  assert.equal('vec' in row, false, '关闭态覆盖写不残留旧向量')
  assert.equal('model' in row, false)
  assert.equal('dim' in row, false)
  await memory.clearSessionMemory(session)
})

test('[C5] commitStaging 把 sessionMemory 整表清空；mergeStaging 一条不动', async () => {
  const session = 'sess-906-c5'
  await db.saveSession(sessionOf(session))
  await memory.saveMemoryEntry(session, { key: 'k', text: '导入前的记忆' })
  assert.equal((await memory.listMemoryEntries(session)).length, 1)

  await db.clearStaging()
  await db.addStagingSession(sessionOf('sess-906-imported'))
  await db.mergeStaging('merge')
  assert.equal(
    (await memory.listMemoryEntries(session))[0]?.text,
    '导入前的记忆',
    '增量合并不删任何会话，因此不碰记忆'
  )

  await db.clearStaging()
  await db.addStagingSession(sessionOf('sess-906-replaced'))
  await db.commitStaging()
  assert.deepEqual(await memory.listMemoryEntries(session), [], '整包替换换掉全部会话，旧记忆失去归属，一并清空')
  assert.equal((await peek('sessionMemory')).length, 0)
  await db.deleteSession('sess-906-replaced')
})

// ───────────────────────────────────────── [D] 关联一致性

test('[D1] deleteSession 按 fileIds 引用计数删图片原件，但不碰 attachment- 原件，也不误删仍被引用的', async () => {
  const image = { id: 'img-d1', name: 'a.png', size: 1, isImage: true, mimeType: 'image/png' }
  const shared = { ...image, id: 'img-d1-shared' }
  await db.saveSession(sessionOf('sess-906-d1a', [image, shared]))
  await db.saveSession(sessionOf('sess-906-d1b', [shared]))
  await db.saveFiles([
    { id: 'img-d1', blob: blobOf('a', 'image/png') },
    { id: 'img-d1-shared', blob: blobOf('b', 'image/png') },
  ])
  await store.saveNewAttachment(attachmentDraft({ id: 'att-d1', sha256: 'd1hash' }), blobOf('doc'))

  await db.deleteSession('sess-906-d1a')
  const keys = await peekKeys('files')
  assert.equal(keys.includes('img-d1'), false, '只被被删会话引用的图片原件回收')
  assert.equal(keys.includes('img-d1-shared'), true, '另一个会话还引用 ⇒ 不删')
  assert.equal(keys.includes('attachment-d1hash'), true, 'attachment- 前缀不在 fileIds 的清理范围里')
  assert.equal((await peek('sessionMemory')).some((row) => row.sessionId === 'sess-906-d1b'), false)

  await db.deleteSession('sess-906-d1b')
  await store.removeAttachment('att-d1')
})

test('[D2] attachmentAvailable：att- 前缀看元数据在不在，其余看 files 里的 blob 在不在', async () => {
  assert.equal(await branchAttachments.attachmentAvailable('att-missing-906'), false)
  assert.equal(await branchAttachments.attachmentAvailable('img-missing-906'), false)

  await store.saveNewAttachment(attachmentDraft({ id: 'att-d2', sha256: 'd2hash' }), blobOf('doc'))
  await db.saveFiles([{ id: 'img-d2', blob: blobOf('img', 'image/png') }])
  assert.equal(await branchAttachments.attachmentAvailable('att-d2'), true)
  assert.equal(await branchAttachments.attachmentAvailable('img-d2'), true, '非 att- 前缀按 files 表判定')

  await store.removeAttachment('att-d2')
  assert.equal(await branchAttachments.attachmentAvailable('att-d2'), false, '元数据没了即不可用，不看 blob 还在不在')
  const handle = await openDB(DB_NAME)
  await handle.delete('files', 'img-d2')
  handle.close()
  assert.equal(await branchAttachments.attachmentAvailable('img-d2'), false)
})

// [layer: unit | 依赖: fake-indexeddb（devDependency，纯 Node 内存 IndexedDB） | 耗时: <3s]
//
// Issue #572「附件与解析结果独立存储：sha256 去重 + 引用清理」的**存储层证据**。
//
// 关闭条件里有三条是要「单测证明」的，本文件就是把那三条钉住（其余条目的证据见 issue 核对表）：
//   [1] 去重命中：同内容（同 sha256）的两条附件只存一份原件、一份全文，且**只解析一次**
//       —— 第二份直接按 `sha256:parserVersion` 缓存命中还原结论（不是"又解析了一遍但没存"，
//       解析调用次数在这里是断言，不是观测量）；
//   [2] 去重未命中：`sha256` 变（内容不同）或 `parserVersion` 变（解析器改动）都必须落成新条目，
//       否则改了解析器老用户会一直命中旧缓存、看不到修复效果；
//   [3] 引用计数删除：同内容被两条附件引用时，删掉其中一条**不删**原件与全文（不能误删仍被引用的），
//       最后一条删掉时才回收；
//   [4] 坏数据容错：元数据指向不存在的全文 / 全文记录被外部写坏（缺 `text`）时，
//       `getText()` 返回 `undefined` 且不抛错，`remove()` 仍能正常清理（不留半删状态）。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/attachment-store-572.test.mjs
//
// 为什么能直接跑真 `db.ts` / 真 store / 真 manager（与 #531 同一理由）：被测物正是存储语义，
// 给 `db` 打桩等于把被测物换成替身。`fake-indexeddb` 是 `idb` 的纯 JS 宿主，事务 / 索引 /
// 游标全部走真实现。解析器用真 txt 解析器（外面包一层计数器来断言「解析了几次」），
// 用例结束时 `wireParsers()` 把注册表还原，避免同进程的其它用例看到假解析器。
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import * as fakeIdb from 'fake-indexeddb'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

/**
 * `fake-indexeddb/auto` 的副作用只在**模块首次求值**时跑一次；而 run-layer 每跑完一个文件
 * 会把该文件新增的全局抹掉（#513 的进程内隔离口径，「清掉全局 13（indexedDB, IDBDatabase…）」）。
 * 于是同进程里本文件排在 `attachment-preserve-import-531` 之后时，会拿到
 * `IDBDatabase is not defined`（批内红、单跑绿 —— 实测过一次，别退回去）。
 * 解决办法不是「换个文件名字母序」，而是每个用例前**显式装一遍**（幂等，已有就跳过）。
 */
const IDB_GLOBALS = [
  'indexedDB',
  'IDBCursor',
  'IDBCursorWithValue',
  'IDBDatabase',
  'IDBFactory',
  'IDBIndex',
  'IDBKeyRange',
  'IDBObjectStore',
  'IDBOpenDBRequest',
  'IDBRequest',
  'IDBTransaction',
  'IDBVersionChangeEvent',
]

const installFakeIdb = () => {
  for (const name of IDB_GLOBALS) {
    if (globalThis[name] === undefined && fakeIdb[name] !== undefined) {
      globalThis[name] = fakeIdb[name]
    }
  }
}

before(installFakeIdb)

const db = await loadTsModule('src/services/chat/db.ts')
const store = await loadTsModule('src/services/attachments/store.ts')
const attachments = await loadTsModule('src/services/attachments/manager.ts')
const txt = await loadTsModule('src/services/attachments/parsers/txt.ts')

/** 真 txt 解析器 + 调用计数（断言「同内容只解析一次」用） */
let parseCalls = 0
attachments.registerAttachmentParser('.txt', async (file, options) => {
  parseCalls += 1
  return txt.parseTxtFile(file, options)
})

const created = []

/** 记下自建的附件 id，用例结束后清干净（同进程可能还有别的用例共用一个内存库） */
const upload = async (text, name) => {
  const record = await attachments.addAttachmentFile(new File([text], name, { type: 'text/plain' }))
  created.push(record.id)
  return record
}

const fileKeys = async () => (await (await db.getChatDB()).getAllKeys('files')).map(String)
const textKeys = async () =>
  (await (await db.getChatDB()).getAllKeys('attachmentTexts')).map(String)

after(async () => {
  for (const id of created) {
    await attachments.removeAttachmentById(id).catch(() => {})
  }
  // 还原解析器注册表：别的用例（#531 等）要用真 txt 解析器
  attachments.wireParsers()
})

test('[1] 去重命中：同内容两条附件 = 一份原件 + 一份全文 + 只解析一次', async () => {
  const TEXT = '第一段：同内容去重命中。\n第二段：改名上传不该再解析一次。'
  const before = parseCalls

  const a = await upload(TEXT, 'report.txt')
  const b = await upload(TEXT, 'report-改个名.txt')

  assert.notEqual(a.id, b.id, '两条附件是两条独立记录（各有自己的 id）')
  assert.equal(a.sha256, b.sha256, '内容相同 ⇒ sha256 相同')
  assert.equal(a.localPath, b.localPath, '同内容共用一份原件（attachment-<sha256>）')

  const parsedA = await attachments.parseAttachment(a.id)
  const parsedB = await attachments.parseAttachment(b.id)
  assert.equal(parsedA.status, 'success', '前置：真 txt 解析器解析成功')
  assert.equal(parsedB.status, 'success', '第二份也必须落到 success（缓存命中，不是失败）')

  assert.equal(parseCalls - before, 1, '同 sha256 + 同 parserVersion ⇒ 只解析一次')
  assert.equal(parsedB.parsedTextPath, parsedA.parsedTextPath, '两份共用同一份全文缓存条目')
  assert.equal(parsedB.characterCount, parsedA.characterCount, '缓存还原的字数与首次解析一致')

  const keys = await fileKeys()
  assert.equal(
    keys.filter((key) => key === a.localPath).length,
    1,
    'files 里同内容只有一条原件（不是两条）'
  )
  const texts = await textKeys()
  assert.equal(
    texts.filter((key) => key === parsedA.parsedTextPath).length,
    1,
    'attachmentTexts 里同内容同版本只有一条全文'
  )
  assert.equal(await attachments.getText(b.id), TEXT, '第二份附件的正文可读，且与原文逐字相同')
})

test('[2] 去重未命中：内容变了 / parserVersion 变了都必须落新条目', async () => {
  const [first, second] = await Promise.all([
    upload('内容 A：去重未命中对照 1', 'one.txt'),
    upload('内容 B：去重未命中对照 2', 'two.txt'),
  ])
  assert.notEqual(first.sha256, second.sha256, '内容不同 ⇒ sha256 不同')
  assert.notEqual(first.localPath, second.localPath, '内容不同 ⇒ 原件各存一份')

  const KEY = 'cafebabe572'
  const v1 = await store.writeAttachmentTextRecord({
    sha256: KEY,
    parserVersion: 'txt-1',
    text: '解析器 v1 的输出',
    status: 'success',
  })
  const v2 = await store.writeAttachmentTextRecord({
    sha256: KEY,
    parserVersion: 'txt-2',
    text: '解析器 v2 的输出',
    status: 'success',
  })
  assert.notEqual(v1.key, v2.key, '缓存键必须含 parserVersion（改解析器不吃旧缓存）')
  assert.equal((await store.readAttachmentTextRecord(v1.key)).text, '解析器 v1 的输出')
  assert.equal((await store.readAttachmentTextRecord(v2.key)).text, '解析器 v2 的输出')
  assert.equal(
    await store.readAttachmentTextRecord(store.attachmentTextKey(KEY, 'txt-9')),
    undefined,
    '没解析过的版本号是未命中（返回 undefined，不返回别人的正文）'
  )
  await (await db.getChatDB()).delete('attachmentTexts', v1.key)
  await (await db.getChatDB()).delete('attachmentTexts', v2.key)
})

test('[3] 引用计数删除：删一条不误删仍被引用的原件与全文，删到 0 才回收', async () => {
  const TEXT = '第一段：引用计数删除。\n第二段：两条附件共享同一份原件。'
  const a = await upload(TEXT, 'shared-a.txt')
  const b = await upload(TEXT, 'shared-b.txt')
  const parsedA = await attachments.parseAttachment(a.id)
  const parsedB = await attachments.parseAttachment(b.id)
  assert.equal(parsedA.parsedTextPath, parsedB.parsedTextPath, '前置：两条共用一份全文')

  await attachments.removeAttachmentById(a.id)

  assert.ok((await fileKeys()).includes(b.localPath), '还有一条附件引用 ⇒ 原件不许删')
  assert.ok((await textKeys()).includes(parsedB.parsedTextPath), '还有一条附件引用 ⇒ 全文不许删')
  assert.equal(await attachments.getText(b.id), TEXT, '剩下那条仍能读到全文（没有被误删）')
  assert.equal(await attachments.getMeta(a.id), undefined, '被删那条的元数据确实没了')

  await attachments.removeAttachmentById(b.id)

  assert.ok(!(await fileKeys()).includes(b.localPath), '引用归零 ⇒ 原件回收')
  assert.ok(!(await textKeys()).includes(parsedB.parsedTextPath), '引用归零 ⇒ 全文回收')
})

test('[4] 坏数据容错：缺全文 / 全文记录被写坏都不抛错，且还能删干净', async () => {
  const database = await db.getChatDB()
  const brokenId = 'att-broken-572'
  const danglingTextId = 'att-dangling-572'

  // 元数据指向一个根本不存在的全文条目（外部改库 / 老版本残留）
  await database.put('attachments', {
    id: brokenId,
    filename: 'broken.txt',
    mimeType: 'text/plain',
    size: 3,
    sha256: 'broken572',
    localPath: 'attachment-broken572',
    parsedTextPath: 'broken572:txt-1',
    status: 'success',
    createdAt: Date.now(),
  })
  assert.equal(
    await attachments.getText(brokenId),
    undefined,
    '全文条目不存在 ⇒ getText 返回 undefined（不抛错、不编造正文）'
  )

  // 全文记录被写坏：缺 `text` 字段
  await database.put('attachmentTexts', {
    key: 'dangling572:txt-1',
    sha256: 'dangling572',
    parserVersion: 'txt-1',
    characterCount: 0,
    status: 'success',
    createdAt: Date.now(),
  })
  await database.put('attachments', {
    id: danglingTextId,
    filename: 'dangling.txt',
    mimeType: 'text/plain',
    size: 3,
    sha256: 'dangling572',
    localPath: 'attachment-dangling572',
    parsedTextPath: 'dangling572:txt-1',
    status: 'success',
    createdAt: Date.now(),
  })
  assert.equal(
    await attachments.getText(danglingTextId),
    undefined,
    '坏记录（缺 text）⇒ getText 返回 undefined，调用方按「无正文」降级'
  )

  // 坏数据不能把删除路径也带崩：删完元数据与全文都不该留下
  await attachments.removeAttachmentById(brokenId)
  await attachments.removeAttachmentById(danglingTextId)
  assert.equal(await attachments.getMeta(brokenId), undefined)
  assert.equal(await attachments.getMeta(danglingTextId), undefined)
  assert.ok(!(await textKeys()).includes('dangling572:txt-1'), '坏全文记录随最后一条引用一起清掉')
  assert.ok(
    !(await fileKeys()).includes('attachment-broken572'),
    '不存在的原件调用是幂等的（不抛错）'
  )
})

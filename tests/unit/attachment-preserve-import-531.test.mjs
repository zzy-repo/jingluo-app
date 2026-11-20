// [layer: unit | 依赖: fake-indexeddb（devDependency，纯 Node 内存 IndexedDB） | 耗时: <3s]
//
// Issue #531：`commitStaging()`（整包导入替换历史）在替换 `files` store 时会**连附件原件一起清掉**，
// 结果是「导入之后，之前上传的附件再也解析不了」（`parse()` 落 `failed: source-missing`，
// 而且无法重试 —— 原件没了）。
//
// 修法的口径（issue 方案 A）：整包导入只替换**聊天数据**，`attachment-<sha256>` 前缀的原件留下。
// 本文件钉三类断言 + 一条相邻边界的如实记录：
//
//   [1] 原件在：替换后 `attachment-<sha256>` 的 blob 仍在 `files` 里，且字节内容与上传时逐字节相同
//   [2] 全文在：替换后 `getText()` 仍拿到全文；**并且**把全文缓存清掉后重新 `parse()` 仍能成功
//       —— 后者才是「原件真的还在」的证据（只查 `getText()` 会走 `attachmentTexts` 缓存，缺件也绿）
//   [3] 没有误留：同一次替换里，旧会话 / 旧摘要 / 旧聊天图片原件照常被换掉（不是"什么都不换"）
//   [4] 顺带确认 `sweepOrphans()` 的交互：存储层清扫**不会**误删刚保留的原件（附件元数据还在 ⇒
//       引用计数非 0）；而「删除会话收尾」那条清扫按引用计数判定，替换后旧附件确实会被当成孤儿回收
//       —— 这是 #527 定义的语义（引用为 0 = 孤儿），不是本修复的副作用，详见 PR 说明。
//
// 负向对照：把 `db.ts` 的保留逻辑换回 `files.clear()` → [1] [2] 变红（[2] 落 `failed: source-missing`）。
//
//   node --test tests/unit/attachment-preserve-import-531.test.mjs
//
// 为什么这里能直接跑真 `db.ts` / 真 IndexedDB 代码（其它 L0 用例都是给 db 打桩）：本用例要验的
// **正是** `commitStaging()` 对 `files` store 的替换语义，桩掉 db 就等于把被测物换成替身，
// 什么也证明不了。所以装 `fake-indexeddb`（纯 JS 内存实现）当宿主，`idb` / 事务 / 游标 / 索引
// 全部走真实现。
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')
const store = await loadTsModule('src/services/attachments/store.ts')
const attachments = await loadTsModule('src/services/attachments/manager.ts')

/** 被测附件正文：够短，但两段带换行，能区分「读到了原件」与「读到了一个空串」 */
const TEXT = '第一段：这是附件原件的正文。\n第二段：整包导入不该把它清掉。'

const NOW = Date.parse('2026-11-20T10:00:00Z')

/** 一条本地会话（替换前的"旧聊天数据"） */
const sessionOf = (id, title, messages) => ({ id, title, createdAt: NOW, updatedAt: NOW, messages })

const userMessage = (id, content, files = []) => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: NOW,
})

const assistantMessage = (id, text) => ({
  id,
  role: 'assistant',
  createdAt: NOW,
  status: 'done',
  model: 'deepseek-flash',
  blocks: [{ type: 'text', text }],
})

/** 消息里的聊天图片引用：`files` store 的键就是它的 id（与附件原件的 `attachment-` 前缀互不干扰） */
const imageRef = (id) => ({
  id,
  serverId: `srv-${id}`,
  name: `${id}.png`,
  size: 3,
  isImage: true,
  mimeType: 'image/png',
})

const imageBlob = (seed) =>
  new Blob([new Uint8Array([seed, seed + 1, seed + 2])], { type: 'image/png' })

/** `files` store 里当前所有键（附件原件 + 聊天图片原件都在这里） */
const fileKeys = async () => (await (await db.getChatDB()).getAllKeys('files')).map(String)

/**
 * 造一份「导入包」的暂存：会话进 `sessionsStaging`，图片原件进 `filesStaging`。
 * 整包导入的写入过程（zip → 暂存）不是本用例的被测物，这里直接按 `replaceHistory()` 的落库结果造。
 */
const stageImport = async ({ sessions, files = [] }) => {
  await db.clearStaging()
  for (const session of sessions) {
    await db.addStagingSession(session)
  }
  if (files.length > 0) {
    await db.saveStagingFiles(files)
  }
}

/**
 * 上传 + 解析一个附件（走真 `AttachmentManager`：sha256、`attachment-<sha256>` 键、全文都真落库）。
 * 返回 `{ id, localPath, sha256, text }`。
 */
const uploadAndParse = async () => {
  const added = await attachments.addAttachmentFile(
    new File([TEXT], 'evidence.txt', { type: 'text/plain' })
  )
  const parsed = await attachments.parseAttachment(added.id)
  assert.equal(parsed.status, 'success', '前置：附件应当解析成功（真 txt 解析器）')
  assert.equal(await attachments.getText(added.id), TEXT, '前置：解析全文应当可读')
  return { id: added.id, localPath: added.localPath, sha256: added.sha256, text: TEXT }
}

/** 一条"旧"的本地会话：带一张聊天图片，导入替换后这张图片的原件应当消失 */
const seedLocalSessionWithImage = async (sessionId, imageId) => {
  await db.saveSession(
    sessionOf(sessionId, '导入前的本地会话', [
      userMessage(`${sessionId}-u0`, '看看这张图', [imageRef(imageId)]),
      assistantMessage(`${sessionId}-a0`, '这是图里的内容'),
    ]),
    [{ id: imageId, blob: imageBlob(10) }]
  )
}

test('[1][2] 整包导入替换后：附件原件仍在，全文仍可读，还能重新解析', async () => {
  const attachment = await uploadAndParse()
  const before = await fileKeys()
  assert.ok(
    before.includes(attachment.localPath),
    `前置：原件应当已经在 files 里（${attachment.localPath}）`
  )

  await seedLocalSessionWithImage('local-before-import', 'img-local-531')
  await stageImport({
    sessions: [
      sessionOf('imported-531', '来自导入包的新会话', [
        userMessage('imported-531-u0', '包里的这一轮', [imageRef('img-imported-531')]),
        assistantMessage('imported-531-a0', '包里的这一答'),
      ]),
    ],
    files: [{ id: 'img-imported-531', blob: imageBlob(20) }],
  })

  await db.commitStaging()

  // [1] 原件仍在，且内容逐字节等于上传时的正文
  const after = await fileKeys()
  assert.ok(after.includes(attachment.localPath), '替换后附件原件的 blob 键必须仍在 files 里')
  const blob = await db.loadFile(attachment.localPath)
  assert.ok(blob !== undefined, '替换后必须能按键读到原件')
  assert.equal(await blob.text(), TEXT, '读回的原件必须与上传的正文逐字节相同')

  // [2] 全文仍可读
  assert.equal(await attachments.getText(attachment.id), TEXT, '替换后 getText() 仍应拿到全文')

  // [2 续] 把全文缓存清掉再解析一次：只有原件真的在，才能重新出正文
  // （不清缓存这条会命中 attachmentTexts，缺件也是绿的 —— 那就证明不了原件还在）
  const textKey = await (await db.getChatDB()).get('attachments', attachment.id)
  assert.ok(textKey?.parsedTextPath !== undefined, '前置：解析成功后应当有全文缓存键')
  await (await db.getChatDB()).delete('attachmentTexts', textKey.parsedTextPath)
  const reparsed = await attachments.parseAttachment(attachment.id)
  assert.equal(
    reparsed.status,
    'success',
    '替换后重新解析必须成功（不得落 failed: source-missing）'
  )
  assert.equal(reparsed.errorMessage ?? '', '', '重新解析不该带上 failed 的原因')
  assert.equal(await attachments.getText(attachment.id), TEXT, '重新解析出的全文必须与原件一致')
})

test('[3] 同一次替换里，会话 / 摘要 / 聊天图片原件照常被换掉（没有误留）', async () => {
  const attachment = await uploadAndParse()
  await seedLocalSessionWithImage('local-replaced-531', 'img-local-replaced-531')
  assert.equal(
    (await db.loadSession('local-replaced-531')) !== undefined,
    true,
    '前置：旧会话在库里'
  )

  await stageImport({
    sessions: [
      sessionOf('imported-replaced-531', '替换后唯一剩下的会话', [
        userMessage('imported-replaced-531-u0', '替换后的一轮', [
          imageRef('img-imported-replaced-531'),
        ]),
        assistantMessage('imported-replaced-531-a0', '替换后的一答'),
      ]),
    ],
    files: [{ id: 'img-imported-replaced-531', blob: imageBlob(30) }],
  })

  const summaries = await db.commitStaging()

  // 旧会话与旧摘要消失
  assert.equal(await db.loadSession('local-replaced-531'), undefined, '旧会话必须被替换掉')
  const summaryIds = (await db.loadSessionSummaries()).map((summary) => summary.id)
  assert.equal(summaryIds.includes('local-replaced-531'), false, '旧摘要必须被替换掉')
  assert.deepEqual(summaryIds, ['imported-replaced-531'], '摘要表里只该剩导入包里的会话')
  assert.deepEqual(
    summaries.map((summary) => summary.id),
    ['imported-replaced-531'],
    'commitStaging 返回本次写入的摘要'
  )

  // 旧聊天图片原件消失、包内图片原件到位 —— 证明 `files` 确实被换过，不是"整库不动"
  const keys = await fileKeys()
  assert.equal(keys.includes('img-local-replaced-531'), false, '旧聊天图片原件必须被替换掉')
  assert.equal(keys.includes('img-imported-replaced-531'), true, '包内的图片原件应当写入')
  // 同一事务里，附件原件照旧留下
  assert.equal(keys.includes(attachment.localPath), true, '同一次替换里附件原件仍应保留')
})

test('[4] sweepOrphans 的交互：存储层清扫不误删；删除会话收尾的清扫按孤儿回收', async () => {
  const attachment = await uploadAndParse()
  await stageImport({
    sessions: [
      sessionOf('imported-sweep-531', '替换后的会话', [
        userMessage('imported-sweep-531-u0', '纯文本一轮', []),
      ]),
    ],
  })
  await db.commitStaging()

  // (a) 存储层清扫：附件元数据还在 ⇒ `files` 里这条原件的 sha256 引用数 = 1，不是孤儿
  const removedByStorageSweep = await store.sweepOrphanStorage()
  assert.equal(
    (await db.loadFile(attachment.localPath)) !== undefined,
    true,
    '存储层清扫不得删掉仍被附件元数据引用的原件'
  )
  assert.equal(
    (await store.getAttachment(attachment.id)) !== undefined,
    true,
    '附件元数据不该被存储层清扫删掉'
  )
  void removedByStorageSweep

  // (b) 删除会话收尾那条清扫（走引用计数）：替换后旧消息没了 ⇒ 该附件不再被任何会话引用 ⇒ 被回收。
  //     这是 #527 定义的「孤儿」语义（引用为 0 = 孤儿），由**用户删除会话**触发；
  //     与「整包导入顺手把原件毁掉」是两件事，本修复不改它的判定口径。
  const referenced = await attachments.collectReferencedAttachmentIds()
  assert.equal(referenced.has(attachment.id), false, '替换后该附件确实不再被任何消息引用')
  const removed = await attachments.attachmentManager.sweepOrphans(referenced)
  assert.ok(removed >= 1, `按引用计数清扫应当回收该附件（实际回收 ${removed} 条）`)
  assert.equal(await store.getAttachment(attachment.id), undefined, '元数据被回收')
  assert.equal(await db.loadFile(attachment.localPath), undefined, '原件随之被回收')
  assert.equal(await attachments.getText(attachment.id), undefined, '全文随之被回收')
})

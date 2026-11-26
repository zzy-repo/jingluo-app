// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 src/services/chat/db.ts | 耗时: <3s]
//
// Issue #906「存储抽象成仓储接口，行为零变化」的**特征化测试**：导入暂存与合并这一块。
// 目的不是证明现状「对」，而是把现状钉死——重构后同一份断言必须仍然成立；标着【现状】的断言
// 记录的是「看起来像 bug 但先不改」的行为，要改请另开 Issue 并同步改这里。
//
// 被测面（只经对外函数）：clearStaging / addStagingSession / saveStagingFiles / updateStagingFileTypes /
// commitStaging（整包替换）/ mergeStaging(policy)（增量合并，返回 MergePlan）。
// 调用序列取自 src/services/chat/store.ts 的 importHistoryInto：clearStaging → 写暂存 → commit|merge，
// 失败/取消再 clearStaging。
//
// 为什么跑真 db.ts + fake-indexeddb 而不是桩：被测物就是「事务里 clear + put 要么全成要么全回滚」，
// 桩掉存储等于把被测物换成替身。用 tests/helpers/fake-idb.mjs 的幂等装配，不另起假 IDB。
//
// 为什么不用 installImportEnv / 不进 UNIT_SOLO：本文件不替换 `../db.js`（那个钩子「先注册者胜」，
// 会让同批文件串扰），只用无桩的 installTsResolve，与 chat-db-reconnect 同口径，可进合并批次。
//
// 读底层的代码全部集中在下面的 `peek`：将来换仓储后端，只改这一处。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installTsResolve()
const db = await loadTsModule('src/services/chat/db.ts')

// ------------------------------------------------------------------ peek：唯一读底层的地方
const STORES = [
  'sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging',
  'sessionMemory', 'attachments', 'attachmentTexts', 'appAssets',
]
const fold = async (row) => {
  const copy = { ...row }
  for (const [key, value] of Object.entries(copy)) {
    if (value instanceof Blob) {
      copy[key] = { __blob: true, type: value.type, size: value.size, text: await value.text() }
    }
  }
  return copy
}
const peek = {
  /** 全库快照：store → 按主键序的记录（Blob 折成 {type,size,text}），可 deepEqual */
  all: async () => {
    const handle = await db.getChatDB()
    const out = {}
    for (const store of STORES) {
      out[store] = await Promise.all((await handle.getAll(store)).map(fold))
    }
    return out
  },
  rows: async (store) => (await peek.all())[store],
  keys: async (store) => (await (await db.getChatDB()).getAllKeys(store)).map(String),
  put: async (store, value) => (await db.getChatDB()).put(store, value),
  wipe: async () => {
    const handle = await db.getChatDB()
    for (const store of STORES) {
      await handle.clear(store)
    }
  },
}

// ------------------------------------------------------------------ 造数
const T0 = Date.parse('2026-11-20T10:00:00Z')
const fileRef = (id) => ({ id, serverId: `srv-${id}`, name: `${id}.png`, size: 3, isImage: true, mimeType: 'image/png' })
const blobOf = (text, type = 'image/png') => new Blob([text], { type })
const sessionOf = (id, { title = `标题-${id}`, updatedAt = T0, files = [], ...extra } = {}) => ({
  id,
  title,
  createdAt: T0,
  updatedAt,
  messages: [
    { id: `${id}-u`, role: 'user', content: `问-${id}`, files: files.map(fileRef), createdAt: T0 },
    { id: `${id}-a`, role: 'assistant', createdAt: T0, status: 'done', model: 'deepseek-flash', blocks: [{ type: 'text', text: `答-${id}` }] },
  ],
  ...extra,
})
const SHA = 'a'.repeat(64)
const ATT = `attachment-${SHA}`

/** 按 importHistoryInto 的顺序写暂存：clearStaging → 逐条 add → 一次 save 图片 */
const stage = async ({ sessions, files = [], clear = true }) => {
  if (clear) {
    await db.clearStaging()
  }
  for (const session of sessions) {
    await db.addStagingSession(session)
  }
  if (files.length > 0) {
    await db.saveStagingFiles(files)
  }
}

/** 正式库的「导入前」状态：两条会话 + 各自图片 + 附件原件 + 一条记忆 + 一条无主杂项原件 */
const seedLocal = async () => {
  await db.saveSession(sessionOf('L1', { updatedAt: T0 + 1000, files: ['img-L1'] }), [{ id: 'img-L1', blob: blobOf('local-1') }])
  await db.saveSession(sessionOf('L2', { updatedAt: T0 + 2000, files: ['img-L2'] }), [{ id: 'img-L2', blob: blobOf('local-22') }])
  await db.saveFiles([
    { id: ATT, blob: blobOf('附件原文', 'text/plain') },
    { id: 'stray-no-owner', blob: blobOf('stray') },
  ])
  await peek.put('sessionMemory', {
    id: 'L1:m0', sessionId: 'L1', key: 'm0', text: '记忆', bytes: 6, createdAt: T0, updatedAt: T0,
  })
}

/** 在 `proto[method]` 上注入同步抛错：满足 when 的第 nth 次调用抛 DOMException（模拟配额/写失败） */
const injectFailure = (t, proto, method, { nth = 1, when = () => true, name = 'QuotaExceededError' } = {}) => {
  const original = proto[method]
  let hits = 0
  const mocked = t.mock.method(proto, method, function injected(...args) {
    if (when(this, args)) {
      hits += 1
      if (hits === nth) {
        throw new DOMException('injected failure', name)
      }
    }
    return original.apply(this, args)
  })
  return { hits: () => hits, restore: () => mocked.mock.restore() }
}
const onStore = (name) => (store) => store.name === name

test.beforeEach(async () => {
  await peek.wipe()
})

// ================================================================== 一、暂存区本身
test('[暂存] 写暂存只进 *Staging 两张表，正式库（会话/摘要/原件/记忆）一字节不动', async () => {
  await seedLocal()
  const before = await peek.all()
  await stage({ sessions: [sessionOf('S1', { files: ['img-S1'] })], files: [{ id: 'img-S1', blob: blobOf('s1') }] })
  const after = await peek.all()
  for (const store of ['sessions', 'sessionSummaries', 'files', 'sessionMemory', 'attachments', 'attachmentTexts', 'appAssets']) {
    assert.deepEqual(after[store], before[store], `${store} 不得被暂存写入污染`)
  }
  assert.deepEqual(after.sessionsStaging.map((row) => row.id), ['S1'])
  assert.deepEqual(after.filesStaging.map((row) => row.id), ['img-S1'])
  // 读正式库的对外函数看不到暂存
  assert.equal(await db.loadSession('S1'), undefined)
  assert.equal(await db.loadFile('img-S1'), undefined)
  assert.deepEqual((await db.loadSessionSummaries()).map((row) => row.id), ['L1', 'L2'])
})

test('[暂存] clearStaging 清空两张暂存表、不碰正式库；空暂存上重复调用不报错', async () => {
  await seedLocal()
  await stage({ sessions: [sessionOf('S1'), sessionOf('S2')], files: [{ id: 'f', blob: blobOf('x') }] })
  const live = (await peek.all())
  await db.clearStaging()
  await db.clearStaging()
  const after = await peek.all()
  assert.deepEqual([after.sessionsStaging, after.filesStaging], [[], []])
  for (const store of ['sessions', 'sessionSummaries', 'files', 'sessionMemory']) {
    assert.deepEqual(after[store], live[store])
  }
})

test('[暂存] addStagingSession 用 add 语义：同 id 第二次写入抛 ConstraintError，先写入的那条保留', async () => {
  await db.clearStaging()
  await db.addStagingSession(sessionOf('dup', { title: '第一次' }))
  await assert.rejects(db.addStagingSession(sessionOf('dup', { title: '第二次' })), { name: 'ConstraintError' })
  assert.deepEqual((await peek.rows('sessionsStaging')).map((row) => row.title), ['第一次'])
})

test('[暂存] saveStagingFiles 同 id 用 put 语义：后写覆盖前写；传空数组也是合法的空事务', async () => {
  await db.clearStaging()
  await db.saveStagingFiles([{ id: 'f', blob: blobOf('old') }])
  await db.saveStagingFiles([{ id: 'f', blob: blobOf('new') }])
  await db.saveStagingFiles([])
  const rows = await peek.rows('filesStaging')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].blob.text, 'new')
})

test('[暂存] updateStagingFileTypes 回填 MIME，保留 isImage；只改暂存、只改 user 消息的 files', async () => {
  await seedLocal()
  const staged = sessionOf('S1', { files: ['p1', 'p2'] })
  staged.messages[0].files[1].isImage = false
  staged.messages[0].files[1].mimeType = 'application/x-old'
  await stage({ sessions: [staged] })
  const liveBefore = await peek.rows('sessions')
  await db.updateStagingFileTypes(new Map([['p1', 'image/jpeg'], ['p2', 'text/plain']]))
  const [row] = await peek.rows('sessionsStaging')
  assert.deepEqual(row.messages[0].files.map((file) => [file.id, file.mimeType, file.isImage]), [
    ['p1', 'image/jpeg', true],
    ['p2', 'text/plain', false],
  ])
  assert.deepEqual(row.messages[1], staged.messages[1], 'assistant 消息原样不动')
  assert.deepEqual(await peek.rows('sessions'), liveBefore, '正式库不受影响')
})

test('[暂存][现状] updateStagingFileTypes：map 里没有的文件 id 被回填成空串 ""（不是保持原值）', async () => {
  const staged = sessionOf('S1', { files: ['hit', 'miss'] })
  await stage({ sessions: [staged] })
  await db.updateStagingFileTypes(new Map([['hit', 'image/png']]))
  const [row] = await peek.rows('sessionsStaging')
  assert.equal(row.messages[0].files.find((file) => file.id === 'hit').mimeType, 'image/png')
  assert.equal(row.messages[0].files.find((file) => file.id === 'miss').mimeType, '', '【现状】缺席即清空')
  // 空 map：所有 user 文件的 mimeType 都被清成 ""
  await db.updateStagingFileTypes(new Map())
  const [again] = await peek.rows('sessionsStaging')
  assert.deepEqual(again.messages[0].files.map((file) => file.mimeType), ['', ''])
})

// ================================================================== 二、commitStaging 整包替换
test('[commit] 整包替换：旧会话/旧摘要/旧图片/旧记忆全换掉，暂存清空，新数据逐条到位', async () => {
  await seedLocal()
  const incoming = [
    sessionOf('N1', { title: '新一', updatedAt: T0 + 10, files: ['img-N1'] }),
    sessionOf('N2', { title: '新二', updatedAt: T0 + 20 }),
  ]
  await stage({ sessions: incoming, files: [{ id: 'img-N1', blob: blobOf('n1-bytes') }] })
  const summaries = await db.commitStaging()
  const after = await peek.all()

  assert.deepEqual(after.sessions.map((row) => row.id), ['N1', 'N2'])
  assert.deepEqual(after.sessions, incoming, '会话记录原样落库')
  assert.deepEqual(after.sessionSummaries.map((row) => [row.id, row.fileIds]), [['N1', ['img-N1']], ['N2', []]])
  assert.deepEqual(after.sessionMemory, [], '#399：旧会话记忆随整包替换一并清空')
  assert.deepEqual([after.sessionsStaging, after.filesStaging], [[], []], '暂存清空')
  const keys = after.files.map((row) => row.id)
  assert.ok(keys.includes('img-N1'), '包内图片落库')
  assert.equal(after.files.find((row) => row.id === 'img-N1').blob.text, 'n1-bytes')
  for (const gone of ['img-L1', 'img-L2', 'stray-no-owner']) {
    assert.ok(!keys.includes(gone), `${gone} 应被替换掉`)
  }
  assert.deepEqual(summaries, await db.loadSessionSummaries(), '返回值 = 提交后再读出的摘要（内容与顺序）')
})

test('[commit] 返回的 SessionSummary[]：只含摘要字段（无 messages/fileIds），带 pinnedAt/branchOf，按 id 升序而非 updatedAt', async () => {
  const branchOf = { sessionId: 'parent', messageId: 'm1', createdAt: T0 }
  await stage({
    sessions: [
      sessionOf('c', { updatedAt: T0 + 999 }),
      sessionOf('a', { updatedAt: T0 + 1, pinnedAt: T0 + 5 }),
      sessionOf('b', { updatedAt: T0 + 500, branchOf }),
    ],
  })
  const summaries = await db.commitStaging()
  assert.deepEqual(summaries.map((row) => row.id), ['a', 'b', 'c'], '【现状】游标即主键序，不按 updatedAt 排；排序是 store 层的事')
  assert.deepEqual(summaries[0], { id: 'a', title: '标题-a', createdAt: T0, updatedAt: T0 + 1, pinnedAt: T0 + 5 })
  assert.deepEqual(summaries[1], { id: 'b', title: '标题-b', createdAt: T0, updatedAt: T0 + 500, branchOf })
  assert.equal(Object.hasOwn(summaries[2], 'pinnedAt'), false, '未置顶不带 pinnedAt 键')
  assert.equal(Object.hasOwn(summaries[2], 'branchOf'), false)
  for (const row of summaries) {
    assert.equal(Object.hasOwn(row, 'messages'), false)
    assert.equal(Object.hasOwn(row, 'fileIds'), false, '对外摘要不含内部 fileIds')
  }
  assert.notEqual(summaries[1].branchOf, (await peek.rows('sessions'))[1].branchOf)
})

test('[commit] 摘要里的 fileIds 重建：按 user 消息去重取文件 id', async () => {
  const session = sessionOf('d', { files: ['x', 'y'] })
  session.messages.push({ id: 'd-u2', role: 'user', content: '再来', files: [fileRef('x'), fileRef('z')], createdAt: T0 })
  await stage({ sessions: [session] })
  await db.commitStaging()
  const [row] = await peek.rows('sessionSummaries')
  assert.deepEqual(row.fileIds, ['x', 'y', 'z'])
})

test('[commit][blob 前缀] attachment-* 键在整包替换里原地保留，其余 files 键（含大小写/前后缀不匹配者）被清掉', async () => {
  const other = `attachment-${'b'.repeat(64)}`
  await db.saveFiles([
    { id: ATT, blob: blobOf('原件甲', 'text/plain') },
    { id: other, blob: blobOf('无人引用的原件乙', 'text/plain') },
    { id: 'attachment-', blob: blobOf('仅前缀') },
    { id: 'Attachment-upper', blob: blobOf('大写前缀') },
    { id: 'x-attachment-mid', blob: blobOf('中间含前缀') },
    { id: 'plain-image', blob: blobOf('图') },
  ])
  await peek.put('attachments', { id: 'att-1', sha256: SHA, localPath: ATT })
  await stage({ sessions: [sessionOf('N')] })
  await db.commitStaging()
  assert.deepEqual((await peek.keys('files')).sort(), ['attachment-', other, ATT].sort(), '只按前缀判定，不看引用（无人引用的也留）')
  assert.equal((await peek.rows('files')).find((row) => row.id === ATT).blob.text, '原件甲', '字节不变')
  assert.deepEqual((await peek.rows('attachments')).map((row) => row.id), ['att-1'], '附件元数据表不属于替换范围')
})

test('[commit][blob 前缀][现状] 暂存里若带 attachment-* 键的文件：先保留旧原件、再被暂存同键 put 覆盖', async () => {
  await db.saveFiles([{ id: ATT, blob: blobOf('旧原件', 'text/plain') }])
  await stage({ sessions: [sessionOf('N')], files: [{ id: ATT, blob: blobOf('包内同键', 'text/plain') }] })
  await db.commitStaging()
  assert.equal((await peek.rows('files')).find((row) => row.id === ATT).blob.text, '包内同键')
})

test('[commit][空包][现状] 暂存为空时 commitStaging 仍把正式会话/摘要/记忆/图片全部清空，返回 []，仅保留附件原件', async () => {
  await seedLocal()
  await db.clearStaging()
  assert.deepEqual(await db.commitStaging(), [])
  const after = await peek.all()
  assert.deepEqual([after.sessions, after.sessionSummaries, after.sessionMemory], [[], [], []])
  assert.deepEqual(after.files.map((row) => row.id), [ATT])
})

test('[commit][暂存残留] 上次中断留下的暂存，不先 clearStaging 就会被本次 commit 一并提交；先清则不会', async () => {
  await stage({ sessions: [sessionOf('stale')], files: [{ id: 'stale-img', blob: blobOf('s') }] }) // 模拟上次中断
  await stage({ sessions: [sessionOf('fresh')], clear: false }) // 忘记清：残留混入
  assert.deepEqual((await db.commitStaging()).map((row) => row.id), ['fresh', 'stale'], '【现状】残留会被一起提交')
  assert.deepEqual(await peek.keys('files'), ['stale-img'])

  await peek.wipe()
  await stage({ sessions: [sessionOf('stale')] })
  await stage({ sessions: [sessionOf('fresh')] }) // importHistoryInto 的标准序列：先 clearStaging
  assert.deepEqual((await db.commitStaging()).map((row) => row.id), ['fresh'])
})

test('[commit][超大包] 300 条会话 + 60 张图：全部落库，摘要与会话一一对应，暂存清空', async () => {
  const sessions = Array.from({ length: 300 }, (_, i) => {
    const id = `big-${String(i).padStart(3, '0')}`
    return sessionOf(id, { updatedAt: T0 + i, files: i < 60 ? [`bimg-${i}`] : [] })
  })
  await seedLocal()
  await stage({ sessions, files: Array.from({ length: 60 }, (_, i) => ({ id: `bimg-${i}`, blob: blobOf(`b${i}`) })) })
  const summaries = await db.commitStaging()
  assert.equal(summaries.length, 300)
  assert.deepEqual(summaries.map((row) => row.id), sessions.map((row) => row.id), '三位补零的 id，主键序 = 造数序')
  const after = await peek.all()
  assert.equal(after.sessions.length, 300)
  assert.equal(after.sessionSummaries.length, 300)
  assert.equal(after.files.length, 60 + 1, '60 张图 + 1 个附件原件')
  assert.deepEqual([after.sessionsStaging.length, after.filesStaging.length], [0, 0])
})

// ================================================================== 四、mergeStaging
const T = { older: T0 - 500, same: T0, newer: T0 + 500 }
const seedMergeLocal = async () => {
  await db.saveSession(sessionOf('keep', { updatedAt: T0, files: ['img-keep'], pinnedAt: T0 + 9 }), [{ id: 'img-keep', blob: blobOf('keep-local') }])
  await db.saveSession(sessionOf('dup', { title: '本地版', updatedAt: T0, files: ['img-dup-local'], pinnedAt: T0 + 7 }), [{ id: 'img-dup-local', blob: blobOf('dup-local') }])
  await db.saveFiles([{ id: ATT, blob: blobOf('附件原文', 'text/plain') }])
  await peek.put('sessionMemory', { id: 'dup:m0', sessionId: 'dup', key: 'm0', text: '记忆', bytes: 6, createdAt: T0, updatedAt: T0 })
}

test('[merge][merge 策略] 新增 / 包内更新 / 时间相同 → 写入；包内更旧 → 跳过；plan 形状与顺序', async () => {
  await db.saveSession(sessionOf('ov', { updatedAt: T0, title: '本地ov' }))
  await db.saveSession(sessionOf('eq', { updatedAt: T0, title: '本地eq' }))
  await db.saveSession(sessionOf('old', { updatedAt: T0, title: '本地old' }))
  await stage({
    sessions: [
      sessionOf('eq', { updatedAt: T.same, title: '包内eq' }),
      sessionOf('fresh', { updatedAt: T.older, title: '包内fresh' }),
      sessionOf('old', { updatedAt: T.older, title: '包内old' }),
      sessionOf('ov', { updatedAt: T.newer, title: '包内ov' }),
    ],
  })
  const plan = await db.mergeStaging('merge')
  assert.deepEqual(plan, {
    added: 1,
    overwritten: 2,
    skipped: 1,
    skippedTitles: ['包内old'],
    written: ['eq', 'fresh', 'ov'], // 注意：按暂存游标顺序（主键序）而不是写入顺序
  })
  const titles = Object.fromEntries((await peek.rows('sessions')).map((row) => [row.id, row.title]))
  assert.deepEqual(titles, { eq: '包内eq', fresh: '包内fresh', old: '本地old', ov: '包内ov' })
  const summaryTitles = Object.fromEntries((await peek.rows('sessionSummaries')).map((row) => [row.id, row.title]))
  assert.deepEqual(summaryTitles, titles, '摘要与会话同步（包括被跳过的那条保持本地版）')
})

test('[merge][skip 策略] 本地已有同 id 一律保留（哪怕包内更新）；本地没有的新增', async () => {
  await db.saveSession(sessionOf('dup', { updatedAt: T0, title: '本地版' }))
  await stage({ sessions: [sessionOf('dup', { updatedAt: T.newer, title: '包内更新版' }), sessionOf('new', { title: '全新' })] })
  const plan = await db.mergeStaging('skip')
  assert.deepEqual(plan, { added: 1, overwritten: 0, skipped: 1, skippedTitles: ['包内更新版'], written: ['new'] })
  assert.equal((await db.loadSession('dup')).title, '本地版')
  assert.equal((await db.loadSession('new')).title, '全新')
})

test('[merge] 暂存与正式库互不污染：合并后暂存两表清空（含被跳过会话的图片），本地其它会话/图片/记忆/附件原件不动', async () => {
  await seedMergeLocal()
  await stage({
    sessions: [
      sessionOf('dup', { title: '包内旧', updatedAt: T.older, files: ['img-dup-pkg'] }),
      sessionOf('added', { files: ['img-added'] }),
    ],
    files: [
      { id: 'img-dup-pkg', blob: blobOf('pkg-skipped') },
      { id: 'img-added', blob: blobOf('pkg-added') },
      { id: 'img-unreferenced', blob: blobOf('no-owner') },
    ],
  })
  const before = await peek.all()
  const plan = await db.mergeStaging('merge')
  assert.deepEqual([plan.added, plan.overwritten, plan.skipped, plan.written], [1, 0, 1, ['added']])
  const after = await peek.all()
  assert.deepEqual([after.sessionsStaging, after.filesStaging], [[], []])
  assert.deepEqual(after.files.map((row) => row.id).sort(), ['attachment-' + SHA, 'img-added', 'img-dup-local', 'img-keep'].sort(),
    '只搬「被写入会话引用」的原件；被跳过会话的图与无人引用的图不落库')
  assert.deepEqual(after.sessions.find((row) => row.id === 'keep'), before.sessions.find((row) => row.id === 'keep'))
  assert.deepEqual(after.sessions.find((row) => row.id === 'dup'), before.sessions.find((row) => row.id === 'dup'), '被跳过的会话字节不变')
  assert.deepEqual(after.sessionMemory, before.sessionMemory, 'merge 不碰记忆')
  assert.deepEqual(after.sessionSummaries.find((row) => row.id === 'added').fileIds, ['img-added'])
})

test('[merge][现状] 覆盖整条替换：本地的 pinnedAt 丢失，本地旧图片原件留在 files 里成为无主原件', async () => {
  await seedMergeLocal()
  await stage({ sessions: [sessionOf('dup', { title: '包内新', updatedAt: T.newer, files: ['img-dup-pkg'] })], files: [{ id: 'img-dup-pkg', blob: blobOf('pkg') }] })
  await db.mergeStaging('merge')
  const stored = await db.loadSession('dup')
  assert.equal(stored.title, '包内新')
  assert.equal(Object.hasOwn(stored, 'pinnedAt'), false, '【现状】不继承本地置顶')
  const summary = (await peek.rows('sessionSummaries')).find((row) => row.id === 'dup')
  assert.equal(Object.hasOwn(summary, 'pinnedAt'), false)
  assert.deepEqual(summary.fileIds, ['img-dup-pkg'])
  assert.ok((await peek.keys('files')).includes('img-dup-local'), '【现状】merge 不清旧图片，留成孤儿')
  assert.equal((await peek.rows('sessionMemory')).length, 1, '【现状】被覆盖会话的旧记忆不清')
})

test('[merge] 多个会话共用同一图片 id：只要有一个被写入，图片就搬；两个都被跳过则不搬', async () => {
  await db.saveSession(sessionOf('s1', { updatedAt: T0 }))
  await db.saveSession(sessionOf('s2', { updatedAt: T0 }))
  await stage({
    sessions: [
      sessionOf('s1', { updatedAt: T.older, files: ['shared'] }),
      sessionOf('s2', { updatedAt: T.older, files: ['shared'] }),
      sessionOf('s3', { files: ['shared'] }),
    ],
    files: [{ id: 'shared', blob: blobOf('shared-bytes') }],
  })
  const plan = await db.mergeStaging('merge')
  assert.deepEqual(plan.written, ['s3'])
  assert.deepEqual(await peek.keys('files'), ['shared'])
  await peek.wipe()
  await db.saveSession(sessionOf('s1', { updatedAt: T0 }))
  await stage({ sessions: [sessionOf('s1', { updatedAt: T.older, files: ['shared'] })], files: [{ id: 'shared', blob: blobOf('x') }] })
  await db.mergeStaging('merge')
  assert.deepEqual(await peek.keys('files'), [], '全被跳过 → 不留孤儿原件')
})

test('[merge][幂等] 同一份包连续合并两次：第二次全部按「时间相同 → 覆盖」，数据与第一次后相同', async () => {
  const pkg = [sessionOf('a', { updatedAt: T0 }), sessionOf('b', { updatedAt: T0 + 1 })]
  await stage({ sessions: pkg })
  const first = await db.mergeStaging('merge')
  const afterFirst = await peek.all()
  await stage({ sessions: pkg })
  const second = await db.mergeStaging('merge')
  assert.deepEqual(first, { added: 2, overwritten: 0, skipped: 0, skippedTitles: [], written: ['a', 'b'] })
  assert.deepEqual(second, { added: 0, overwritten: 2, skipped: 0, skippedTitles: [], written: ['a', 'b'] })
  assert.deepEqual(await peek.all(), afterFirst)
  await stage({ sessions: pkg })
  assert.deepEqual((await db.mergeStaging('skip')).skipped, 2, 'skip 下同一份包全部跳过')
})

test('[merge][空包] 暂存为空：返回全零 plan，本地数据一字节不动（与 commit 空包的「清空」相反）', async () => {
  await seedMergeLocal()
  await db.clearStaging()
  const before = await peek.all()
  for (const policy of ['merge', 'skip']) {
    assert.deepEqual(await db.mergeStaging(policy), { added: 0, overwritten: 0, skipped: 0, skippedTitles: [], written: [] })
  }
  assert.deepEqual(await peek.all(), before)
})

test('[merge][暂存残留] 上次中断的暂存会被一并合并；合并后残留与本次包都清空', async () => {
  await stage({ sessions: [sessionOf('stale')], files: [{ id: 'stale-img', blob: blobOf('s') }] })
  await stage({ sessions: [sessionOf('fresh')], clear: false })
  const plan = await db.mergeStaging('merge')
  assert.deepEqual(plan.written, ['fresh', 'stale'], '【现状】残留不隔离')
  assert.deepEqual([(await peek.rows('sessionsStaging')).length, (await peek.rows('filesStaging')).length], [0, 0])
})

test('[merge][超大包] 200 条（半数与本地冲突）：计数、written 顺序、落库条数都对', async () => {
  const local = Array.from({ length: 100 }, (_, i) => sessionOf(`m-${String(i).padStart(3, '0')}`, { updatedAt: T0 + (i % 2 === 0 ? 1000 : -1000) }))
  for (const session of local) {
    await db.saveSession(session)
  }
  const incoming = Array.from({ length: 200 }, (_, i) => sessionOf(`m-${String(i).padStart(3, '0')}`, { updatedAt: T0, title: `包-${i}` }))
  await stage({ sessions: incoming })
  const plan = await db.mergeStaging('merge')
  // 偶数 id 本地更新（T0+1000）→ 跳过 50；奇数 id 本地更旧 → 覆盖 50；后 100 条新增
  assert.deepEqual([plan.added, plan.overwritten, plan.skipped], [100, 50, 50])
  assert.equal(plan.skippedTitles.length, 50)
  assert.equal(plan.written.length, 150)
  assert.deepEqual(plan.written, [...plan.written].sort())
  assert.equal((await peek.rows('sessions')).length, 200)
  assert.equal((await peek.rows('sessionSummaries')).length, 200)
})

// ================================================================== 六、调用序列（store.importHistoryInto 的用法）
test('[序列] clearStaging → 写暂存 → commit；失败分支再 clearStaging 后正式库不变、暂存为空', async (t) => {
  await seedLocal()
  const before = await peek.all()
  await stage({ sessions: [sessionOf('N1'), sessionOf('N2')], files: [{ id: 'i', blob: blobOf('i') }] })
  const fault = injectFailure(t, IDBObjectStore.prototype, 'put', { nth: 1, when: onStore('sessionSummaries') })
  await assert.rejects(db.commitStaging())
  fault.restore()
  await db.clearStaging() // store.ts 失败分支的清理出口
  assert.deepEqual(await peek.all(), before)
})

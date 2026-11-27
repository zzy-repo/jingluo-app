// [layer: unit | 依赖: fake-indexeddb + 真 src/services/chat/db.ts | 耗时: <3s]
//
// Issue #906 特征化测试的**回滚**分册：commitStaging / mergeStaging 在注入写失败、配额失败、
// 事务建不起来时必须整事务回滚——失败前后整库逐条相等。语义正文（暂存、替换、合并）在
// tests/unit/storage-char-staging.test.mjs；本文件只收「注入故障」的用例。
//
// 为什么单独成册：tests/README.md 规定单文件 ≤500 行，按场景拆。两文件各自 import 真 db.ts、
// 共用同一个 chat-demo 库，所以**不并行**——node:test 默认同文件串行、跨文件并行，本文件的
// 用例全部包在一个串行 describe 里，跨文件互不触碰彼此的数据（beforeEach 全清 + 自造数据）。
// 装配与 storage-char-staging.test.mjs 同口径：无桩 installTsResolve + installFakeIdbGlobals，
// 不走 installImportEnv（其钩子先注册者胜，同批并行会串扰），因此可进合并批次。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installTsResolve()
const db = await loadTsModule('src/services/chat/db.ts')

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

const T0 = Date.parse('2026-11-20T10:00:00Z')
const fileRef = (id) => ({ id, serverId: `srv-${id}`, name: `${id}.png`, size: 3, isImage: true, mimeType: 'image/png' })
const blobOf = (text, type = 'image/png') => new Blob([text], { type })
const sessionOf = (id, { title = `标题-${id}`, updatedAt = T0, files = [], ...extra } = {}) => ({
  id, title, createdAt: T0, updatedAt,
  messages: [
    { id: `${id}-u`, role: 'user', content: `问-${id}`, files: files.map(fileRef), createdAt: T0 },
    { id: `${id}-a`, role: 'assistant', createdAt: T0, status: 'done', model: 'deepseek-flash', blocks: [{ type: 'text', text: `答-${id}` }] },
  ],
  ...extra,
})
const SHA = 'a'.repeat(64)
const ATT = `attachment-${SHA}`
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
const seedLocal = async () => {
  await db.saveSession(sessionOf('L1', { updatedAt: T0 + 1000, files: ['img-L1'] }), [{ id: 'img-L1', blob: blobOf('local-1') }])
  await db.saveSession(sessionOf('L2', { updatedAt: T0 + 2000, files: ['img-L2'] }), [{ id: 'img-L2', blob: blobOf('local-22') }])
  await db.saveFiles([{ id: ATT, blob: blobOf('附件原文', 'text/plain') }, { id: 'stray-no-owner', blob: blobOf('stray') }])
  await peek.put('sessionMemory', { id: 'L1:m0', sessionId: 'L1', key: 'm0', text: '记忆', bytes: 6, createdAt: T0, updatedAt: T0 })
}
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
const T = { older: T0 - 500, same: T0, newer: T0 + 500 }
const seedMergeLocal = async () => {
  await db.saveSession(sessionOf('keep', { updatedAt: T0, files: ['img-keep'], pinnedAt: T0 + 9 }), [{ id: 'img-keep', blob: blobOf('keep-local') }])
  await db.saveSession(sessionOf('dup', { title: '本地版', updatedAt: T0, files: ['img-dup-local'], pinnedAt: T0 + 7 }), [{ id: 'img-dup-local', blob: blobOf('dup-local') }])
  await db.saveFiles([{ id: ATT, blob: blobOf('附件原文', 'text/plain') }])
  await peek.put('sessionMemory', { id: 'dup:m0', sessionId: 'dup', key: 'm0', text: '记忆', bytes: 6, createdAt: T0, updatedAt: T0 })
}

// ================================================================== 三、commitStaging 原子回滚
/**
 * 旧数据丰富、暂存也丰富，然后在 commit 的第 nth 次写入点注入失败：
 * 断言 reject，且正式库（sessions/files/summaries/memory 全部 store）与暂存逐条等于失败前。
 */
const assertCommitRollsBack = async (t, { proto, method, when, nth = 1, name = 'QuotaExceededError', expectedName }) => {
  await seedLocal()
  await stage({
    sessions: [sessionOf('N1', { files: ['img-N1'] }), sessionOf('N2'), sessionOf('N3')],
    files: [{ id: 'img-N1', blob: blobOf('n1') }, { id: 'img-N2', blob: blobOf('n2') }],
  })
  const before = await peek.all()
  const fault = injectFailure(t, proto, method, { nth, when, name })
  await assert.rejects(db.commitStaging(), (error) => error.name === (expectedName ?? name))
  assert.ok(fault.hits() >= nth, '注入点确实被走到了（否则断言是空转）')
  fault.restore()
  assert.deepEqual(await peek.all(), before, '失败后整库（含暂存）逐条与失败前一致')
  // 旧数据还能被对外函数读到，且摘要仍是旧的
  assert.deepEqual((await db.loadSessionSummaries()).map((row) => row.id), ['L1', 'L2'])
  assert.equal(await (await db.loadFile('img-L1')).text(), 'local-1')
}

test('[commit][回滚] 写第 2 条会话时配额失败：旧 sessions/files/summaries/memory 与暂存逐条不变', async (t) => {
  await assertCommitRollsBack(t, { proto: IDBObjectStore.prototype, method: 'put', nth: 2, when: onStore('sessions') })
})

test('[commit][回滚] 写摘要失败（sessions 已 clear+put 之后）：整体回滚', async (t) => {
  await assertCommitRollsBack(t, { proto: IDBObjectStore.prototype, method: 'put', nth: 1, when: onStore('sessionSummaries') })
})

test('[commit][回滚] 写图片失败（会话与摘要都已写完之后）：会话侧的替换也一起回滚', async (t) => {
  await assertCommitRollsBack(t, { proto: IDBObjectStore.prototype, method: 'put', nth: 1, when: onStore('files') })
})

test('[commit][回滚] 清旧图片阶段失败（逐键 delete）：整体回滚', async (t) => {
  await assertCommitRollsBack(t, { proto: IDBObjectStore.prototype, method: 'delete', nth: 1, when: onStore('files') })
})

test('[commit][回滚] 清记忆失败（sessions 已被 clear 之后）：被清空的会话也回来了', async (t) => {
  await assertCommitRollsBack(t, { proto: IDBObjectStore.prototype, method: 'clear', nth: 1, when: onStore('sessionMemory') })
})

test('[commit][回滚] 最后清暂存失败：已写入的正式数据也回滚（不会出现「半新半旧」）', async (t) => {
  await assertCommitRollsBack(t, { proto: IDBObjectStore.prototype, method: 'clear', nth: 1, when: onStore('filesStaging') })
})

test('[commit][回滚] 非配额错误同样整体回滚，错误原样抛给调用方', async (t) => {
  await assertCommitRollsBack(t, {
    proto: IDBObjectStore.prototype, method: 'put', nth: 2, when: onStore('sessions'), name: 'DataCloneError',
  })
})

test('[commit][回滚] 事务建不起来（InvalidStateError 连续两次）：reject，正式库与暂存都没动', async (t) => {
  await seedLocal()
  await stage({ sessions: [sessionOf('N1')] })
  await db.getChatDB()
  const before = await peek.all()
  const start = t.mock.method(IDBDatabase.prototype, 'transaction', () => {
    throw new DOMException('closing', 'InvalidStateError')
  })
  await assert.rejects(db.commitStaging(), { name: 'InvalidStateError' })
  start.mock.restore()
  assert.deepEqual(await peek.all(), before)
})

test('[commit][回滚] 失败后立即重试同一份暂存可以成功（暂存没被半途消耗）', async (t) => {
  await seedLocal()
  await stage({ sessions: [sessionOf('N1'), sessionOf('N2')] })
  const fault = injectFailure(t, IDBObjectStore.prototype, 'put', { nth: 2, when: onStore('sessions') })
  await assert.rejects(db.commitStaging(), { name: 'QuotaExceededError' })
  fault.restore()
  assert.deepEqual((await db.commitStaging()).map((row) => row.id), ['N1', 'N2'])
  assert.deepEqual((await peek.rows('sessions')).map((row) => row.id), ['N1', 'N2'])
})

// ================================================================== 五、mergeStaging 原子回滚
const assertMergeRollsBack = async (t, { method, when, nth = 1 }) => {
  await seedMergeLocal()
  await stage({
    sessions: [sessionOf('dup', { title: '包内新', updatedAt: T.newer, files: ['img-p1'] }), sessionOf('n1', { files: ['img-p2'] }), sessionOf('n2')],
    files: [{ id: 'img-p1', blob: blobOf('p1') }, { id: 'img-p2', blob: blobOf('p2') }],
  })
  const before = await peek.all()
  const fault = injectFailure(t, IDBObjectStore.prototype, method, { nth, when })
  await assert.rejects(db.mergeStaging('merge'), { name: 'QuotaExceededError' })
  assert.ok(fault.hits() >= nth, '注入点确实被走到了')
  fault.restore()
  assert.deepEqual(await peek.all(), before, '失败后整库（含暂存）逐条等于失败前')
}

test('[merge][回滚] 写第 2 条会话失败：已 put 的第 1 条一并回滚', async (t) => {
  await assertMergeRollsBack(t, { method: 'put', nth: 2, when: onStore('sessions') })
})

test('[merge][回滚] 写摘要失败：整体回滚', async (t) => {
  await assertMergeRollsBack(t, { method: 'put', nth: 1, when: onStore('sessionSummaries') })
})

test('[merge][回滚] 搬图片失败（会话与摘要已写）：整体回滚', async (t) => {
  await assertMergeRollsBack(t, { method: 'put', nth: 1, when: onStore('files') })
})

test('[merge][回滚] 最后清暂存失败：已写入的正式数据一并回滚', async (t) => {
  await assertMergeRollsBack(t, { method: 'clear', nth: 1, when: onStore('filesStaging') })
})


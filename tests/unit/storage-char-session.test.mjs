// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 chat/db.ts | 耗时: <10s]
//
// Issue #906（特征化测试，重构前的「现状快照」）：把 `src/services/chat/db.ts` 的**会话读写**
// 现有行为钉死，作为「存储抽象成仓储接口、行为零变化」的证据。**只记录现状，不修现状**
// （看起来像 bug 的行为也原样钉住，见文件末的「现状清单」）。
//
// 被测对象（全部是对外函数，断言不碰内部 store / 索引名之外的实现细节）：
//   loadSessionSummaries / loadSession / saveSession（SaveSessionOutcome、FileDegradation 降级、
//   stripNonCloneableFields 剔除不可克隆字段、会话与摘要的同步写、fileIds 索引维护）/
//   pinSession / renameSession / deleteSession（级联清理 files / 摘要 / 分支引用）/
//   branchOf 相关行为 / saveFiles / loadFile。
//
// 为什么跑真实现：桩掉 db 就等于把被测物换成替身，绿了也不说明「两个 store 是同一个事务」。
// 宿主用 `fake-indexeddb`（`idb` / 事务 / 索引 / 游标 / Blob 走真码），装配复用
// `tests/helpers/fake-idb.mjs`（与 memory-session-scope-399 / session-branch-831 同一份，
// 不另起一套假 IDB）。本文件**不**用 `installImportEnv`（那套假存储按 parent 匹配、
// `registerHooks` 先注册者胜，同批会串扰）；这里要的是真 db，所以只需 `installTsResolve()`。
//
// 读底层只经文件顶部的 `peek`：将来换后端时只改这一处。
//
// 独占进程（登记进 `tests/run-layer.mjs` 的 UNIT_SOLO）：
//   本文件用例里会临时改写 `IDBObjectStore.prototype.put/delete`（注入写失败），
//   并在「缺能力」用例里临时删掉 `globalThis.indexedDB`；同时 `db.ts` 的连接是模块级单例，
//   本文件独占同一个库（用例间只清数据）。这三件都是进程级的：同批别的文件共用同一份原型、
//   全局与模块缓存，合批时失败注入会打到别人的写入、别人的库数据会混进本文件的「空库」
//   （机制类别：进程级全局 + 原型 mock + 模块级单例）。单列最诚实。
//
//   node tests/run-layer.mjs unit --case storage-char-session
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fake from 'fake-indexeddb'
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

// `fake-indexeddb/auto` 只在模块首次求值时装一次；合并批次跑完一个文件会把新增全局抹掉（#513），
// 所以每个文件自己幂等补一遍（只补 undefined 的，不覆盖别人装好的实现）。
installFakeIdbGlobals()
// 最小 localStorage：`settings.ts` / `apiConfig.ts` 只做 get / set / remove
installMinimalLocalStorage()
// `.js→.ts` 解析：源码里 `import './history/mergeSessions.js'` 实际是 `.ts`。必须在动态 import 之前。
installTsResolve()

const db = await loadTsModule('src/services/chat/db.ts')


const NOW = 1_700_000_000_000

/** 最小会话。`extra` 用来塞不可克隆字段等「现状要钉」的东西。 */
const sessionOf = (id, extra = {}) => ({
  id,
  title: `标题-${id}`,
  createdAt: NOW,
  updatedAt: NOW + 1,
  messages: [],
  ...extra,
})

const userMessage = (id, content, files = []) => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: NOW,
})

const fileRef = (id, name = `${id}.png`) => ({
  id,
  serverId: null,
  name,
  size: 3,
  isImage: true,
  mimeType: 'image/png',
})

const storedFile = (id, text = 'bytes') => ({ id, blob: new Blob([text], { type: 'image/png' }) })

/**
 * 读底层的唯一入口（换后端时只改这里）。
 * 不经被测模块：直接用当前 `indexedDB` 打开应用库，按 store 读出全部记录。
 * Blob 折成 `{ __blob, type, size, text }`，才能深比较。
 */
const peek = async (store) => {
  const handle = await new Promise((resolve, reject) => {
    const request = indexedDB.open(db.DB_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = handle.transaction(store, 'readonly')
      const request = tx.objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return await Promise.all(
      rows.map(async (row) => {
        const copy = { ...row }
        for (const [key, value] of Object.entries(copy)) {
          if (value instanceof Blob) {
            copy[key] = { __blob: true, type: value.type, size: value.size, text: await value.text() }
          }
        }
        return copy
      })
    )
  } finally {
    handle.close()
  }
}

const summaryOf = async (id) => (await peek('sessionSummaries')).find((row) => row.id === id)
const fileIdsOf = async (id) => (await summaryOf(id))?.fileIds ?? null

/**
 * 每条用例从空库开始：清空所有 store（不删库、不换连接）。
 * `db.ts` 缓存了一条连接且没有导出重置口，换 `indexedDB` 全局会让缓存的连接指向旧库，
 * 所以这里沿用同一个库，只清数据。换后端时这一处改成「该后端的清库」即可。
 */
const freshDb = async () => {
  const handle = await db.getChatDB()
  const names = [...handle.objectStoreNames]
  const tx = handle.transaction(names, 'readwrite')
  for (const name of names) {
    tx.objectStore(name).clear()
  }
  await tx.done
}

/** 注入写失败：让指定 store 的 `method`（put / delete）抛给定 DOMException。返回还原函数。 */
const failWrites = (store, method, name, message = name) => {
  const original = fake.IDBObjectStore.prototype[method]
  fake.IDBObjectStore.prototype[method] = function patched(value, key) {
    if (this.name === store) {
      throw new DOMException(message, name)
    }
    return original.call(this, value, key)
  }
  return () => {
    fake.IDBObjectStore.prototype[method] = original
  }
}

/** 让指定 store 的 put 只失败前 `times` 次（用来钉「配额失败会重试恰好一次」）。 */
const failWritesTimes = (store, name, times) => {
  const original = fake.IDBObjectStore.prototype.put
  let left = times
  fake.IDBObjectStore.prototype.put = function patched(value, key) {
    if (this.name === store && left > 0) {
      left -= 1
      throw new DOMException(name, name)
    }
    return original.call(this, value, key)
  }
  return () => {
    fake.IDBObjectStore.prototype.put = original
  }
}

// ---------------------------------------------------------------- 读写往返与摘要同步

test('往返：saveSession 落盘后 loadSession 原样读回，outcome 全空', async () => {
  await freshDb()
  const session = sessionOf('s1', { messages: [userMessage('m1', '你好')] })
  const outcome = await db.saveSession(session)
  assert.deepEqual(outcome, { failure: null, degradedFiles: [], strippedFields: [] })
  assert.deepEqual(await db.loadSession('s1'), session)
})

test('摘要同步：摘要只含列表字段 + fileIds，不带 messages', async () => {
  await freshDb()
  const session = sessionOf('s1', { messages: [userMessage('m1', '你好', [fileRef('f1')])] })
  await db.saveSession(session, [storedFile('f1')])
  const summary = await summaryOf('s1')
  assert.deepEqual(Object.keys(summary).sort(), ['createdAt', 'fileIds', 'id', 'title', 'updatedAt'])
  assert.deepEqual(summary.fileIds, ['f1'])
  assert.equal('messages' in summary, false)
  // fileIds 索引能按原件反查到这条摘要（删会话时靠它判断原件还有没有主）
  const rows = await db.loadSessionSummaries()
  assert.deepEqual(rows.map((row) => row.id), ['s1'])
})

test('摘要排序：loadSessionSummaries 按主键 id 升序返回，不按写入顺序也不按更新时间', async () => {
  await freshDb()
  await db.saveSession(sessionOf('late', { updatedAt: 100 }))
  await db.saveSession(sessionOf('early', { updatedAt: 1 }))
  const rows = await db.loadSessionSummaries()
  assert.deepEqual(rows.map((row) => row.id), ['early', 'late'])
  assert.deepEqual(rows.map((row) => row.updatedAt), [1, 100])
})

test('边界：不存在的 id → loadSession 返回 undefined，摘要里没有它', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1'))
  assert.equal(await db.loadSession('missing'), undefined)
  assert.equal((await db.loadSessionSummaries()).some((row) => row.id === 'missing'), false)
})

test('边界：空会话（messages 为空、rootMessageId 为 null）原样往返', async () => {
  await freshDb()
  const session = sessionOf('empty', { messages: [], rootMessageId: null })
  await db.saveSession(session)
  assert.deepEqual(await db.loadSession('empty'), session)
  assert.deepEqual(await fileIdsOf('empty'), [])
})

test('幂等：同一条会话重复保存，库里仍只有一条，内容是最后一次', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1', { title: '第一次' }))
  const outcome = await db.saveSession(sessionOf('s1', { title: '第二次' }))
  assert.equal(outcome.failure, null)
  const sessions = await peek('sessions')
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].title, '第二次')
  const summaries = await peek('sessionSummaries')
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].title, '第二次')
})

test('fileIds 维护：第二次保存去掉附件后，摘要的 fileIds 跟着变，旧原件仍在', async () => {
  await freshDb()
  const withFile = sessionOf('s1', { messages: [userMessage('m1', '带图', [fileRef('f1')])] })
  await db.saveSession(withFile, [storedFile('f1', '图1')])
  assert.deepEqual(await fileIdsOf('s1'), ['f1'])
  const without = sessionOf('s1', { messages: [userMessage('m1', '不带图')] })
  await db.saveSession(without)
  assert.deepEqual(await fileIdsOf('s1'), [])
  // 现状：saveSession 不回收不再被引用的原件（只有 deleteSession 才按引用清理）
  assert.equal(await (await db.loadFile('f1')).text(), '图1')
})

test('fileIds 去重：同一原件被两条消息引用，摘要里只记一次', async () => {
  await freshDb()
  const session = sessionOf('s1', {
    messages: [userMessage('m1', '一', [fileRef('f1')]), userMessage('m2', '二', [fileRef('f1')])],
  })
  await db.saveSession(session)
  assert.deepEqual(await fileIdsOf('s1'), ['f1'])
})

// ---------------------------------------------------------------- pin / rename

test('pin：置顶写入详情与摘要；传 undefined 是取消，字段整个消失而不是 null', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1'))
  await db.pinSession('s1', 42)
  assert.equal((await db.loadSession('s1')).pinnedAt, 42)
  assert.equal((await summaryOf('s1')).pinnedAt, 42)
  await db.pinSession('s1', undefined)
  assert.equal(Object.hasOwn(await db.loadSession('s1'), 'pinnedAt'), false)
  assert.equal(Object.hasOwn(await summaryOf('s1'), 'pinnedAt'), false)
})

test('pin / rename：目标会话不存在时静默无操作，不新建记录', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1'))
  await db.pinSession('missing', 7)
  await db.renameSession('missing', '新名字')
  assert.equal((await peek('sessions')).length, 1)
  assert.equal((await peek('sessionSummaries')).length, 1)
})

test('rename：详情与摘要的标题一起改，其余字段不动', async () => {
  await freshDb()
  const session = sessionOf('s1', { pinnedAt: 5 })
  await db.saveSession(session)
  await db.renameSession('s1', '改过的标题')
  const stored = await db.loadSession('s1')
  assert.equal(stored.title, '改过的标题')
  assert.equal(stored.updatedAt, session.updatedAt, '改名不碰 updatedAt')
  assert.equal(stored.pinnedAt, 5)
  assert.equal((await summaryOf('s1')).title, '改过的标题')
})

// ---------------------------------------------------------------- delete 级联

test('delete：会话、摘要一起删；原件只在没有别的会话引用时才删', async () => {
  await freshDb()
  const shared = sessionOf('keep', { messages: [userMessage('m1', '甲', [fileRef('shared')])] })
  const doomed = sessionOf('drop', {
    messages: [userMessage('m2', '乙', [fileRef('shared'), fileRef('only-drop')])],
  })
  await db.saveSession(shared, [storedFile('shared', '共用')])
  await db.saveSession(doomed, [storedFile('only-drop', '独占')])
  await db.deleteSession('drop')
  assert.equal(await db.loadSession('drop'), undefined)
  assert.equal(await summaryOf('drop'), undefined)
  assert.equal(await (await db.loadFile('shared')).text(), '共用', '还有会话引用的原件必须留着')
  assert.equal(await db.loadFile('only-drop'), undefined, '无人引用的原件要删掉')
  assert.deepEqual(await db.loadSession('keep'), shared, '别的会话一条不动')
})

test('delete：不存在的会话也静默成功，不误删其它数据', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1'), [storedFile('f1')])
  await db.deleteSession('missing')
  assert.deepEqual((await db.loadSessionSummaries()).map((row) => row.id), ['s1'])
  assert.ok(await db.loadFile('f1'))
})

test('delete：会话的窗口记忆在同一个事务里清掉，别的会话的记忆留着', async () => {
  await freshDb()
  await db.saveSession(sessionOf('drop'))
  await db.saveSession(sessionOf('keep'))
  const memory = (sessionId) => ({
    id: `${sessionId}:k`,
    sessionId,
    key: 'k',
    text: '记忆',
    bytes: 6,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const handle = await db.getChatDB()
  const tx = handle.transaction('sessionMemory', 'readwrite')
  await tx.store.put(memory('drop'))
  await tx.store.put(memory('keep'))
  await tx.done
  await db.deleteSession('drop')
  const left = await peek('sessionMemory')
  assert.deepEqual(left.map((row) => row.id), ['keep:k'])
})

test('delete 原子性：中途写失败则整体回滚，会话 / 摘要 / 原件都还在', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1', { messages: [userMessage('m1', '甲', [fileRef('f1')])] }), [
    storedFile('f1', '原件'),
  ])
  const restore = failWrites('files', 'delete', 'InvalidStateError')
  try {
    await assert.rejects(db.deleteSession('s1'), (error) => error.name === 'InvalidStateError')
  } finally {
    restore()
  }
  assert.equal((await db.loadSession('s1')).title, '标题-s1', '事务回滚：会话还在')
  assert.ok(await summaryOf('s1'), '事务回滚：摘要还在')
  assert.equal(await (await db.loadFile('f1')).text(), '原件', '事务回滚：原件还在')
})

// ---------------------------------------------------------------- branchOf

test('branchOf：来源信息同时进详情与摘要，没有 branchOf 的会话摘要里也不凭空多出该字段', async () => {
  await freshDb()
  const branchOf = { sessionId: 'parent', messageId: 'pm-2', createdAt: NOW }
  await db.saveSession(sessionOf('child', { branchOf }))
  const stored = await db.loadSession('child')
  const summary = (await db.loadSessionSummaries()).find((row) => row.id === 'child')
  assert.deepEqual(stored.branchOf, branchOf)
  assert.deepEqual(summary.branchOf, branchOf)
  // 注意：不断言「摘要与详情不是同一个对象」。idb 写入时会结构化克隆，读回来的永远是两份，
  // 对外接口观察不到 toSessionSummary 里那次浅拷贝（负向对照实测：去掉它测试仍绿），所以不钉。
  // 没有 branchOf 的会话，摘要里也不该凭空多出这个字段
  await db.saveSession(sessionOf('plain'))
  assert.equal(Object.hasOwn(await summaryOf('plain'), 'branchOf'), false)
})

test('delete 父会话：子会话的 branchOf 引用原样保留（不级联改写）', async () => {
  await freshDb()
  await db.saveSession(sessionOf('parent'))
  await db.saveSession(sessionOf('child', { branchOf: { sessionId: 'parent', createdAt: NOW } }))
  await db.deleteSession('parent')
  assert.deepEqual((await db.loadSession('child')).branchOf, { sessionId: 'parent', createdAt: NOW })
})

// ---------------------------------------------------------------- 不可克隆字段剔除

test('剔除：顶层函数字段被去掉后会话照常落盘，outcome 报出被剔除的路径', async () => {
  await freshDb()
  const session = sessionOf('s1', { stray: () => '坏', note: '留着' })
  const outcome = await db.saveSession(session)
  assert.equal(outcome.failure, null)
  assert.deepEqual(outcome.strippedFields, ['stray'])
  const stored = await db.loadSession('s1')
  assert.equal(Object.hasOwn(stored, 'stray'), false)
  assert.equal(stored.note, '留着', '其余字段一个不丢')
  assert.equal(Object.hasOwn(session, 'stray'), true, '剔除只作用于副本，不改调用方的对象')
})

test('剔除：坏字段藏在消息成员里时只剔成员，消息条数与正文都在', async () => {
  await freshDb()
  const session = sessionOf('s1', {
    messages: [{ ...userMessage('m1', '正文'), onDone: () => {} }],
  })
  const outcome = await db.saveSession(session)
  assert.equal(outcome.failure, null)
  assert.deepEqual(outcome.strippedFields, ['messages[0].onDone'])
  const stored = await db.loadSession('s1')
  assert.equal(stored.messages.length, 1)
  assert.equal(stored.messages[0].content, '正文')
  assert.equal(Object.hasOwn(stored.messages[0], 'onDone'), false)
})

test('剔除兜底：顶层浅扫不认「关键字段」保护，函数型 title 会被直接剔掉（现状，见文末清单）', async () => {
  await freshDb()
  const outcome = await db.saveSession(sessionOf('s1', { title: () => '函数当标题' }))
  assert.equal(outcome.failure, null)
  assert.deepEqual(outcome.strippedFields, ['title'])
  const stored = await db.loadSession('s1')
  assert.equal(Object.hasOwn(stored, 'title'), false, '现状：落盘的是一条没有 title 的会话')
  assert.equal((await summaryOf('s1')).title, undefined)
})

test('剔除兜底：messages 里修不动的坏成员 → 整次保存失败(clone)，库保持原样、不存空壳', async () => {
  await freshDb()
  await db.saveSession(sessionOf('s1', { title: '旧标题' }))
  // 数组元素本身是不可克隆的非数组对象：repairOneLevel 只剔「成员」不剔数组元素，修不动，
  // 而 messages 是受保护字段，所以宁可失败
  const outcome = await db.saveSession(sessionOf('s1', { title: '新标题', messages: [new WeakMap()] }))
  assert.equal(outcome.failure.kind, 'clone')
  assert.equal(outcome.failure.name, 'DataCloneError')
  assert.equal(outcome.failure.stores, 'sessions,sessionSummaries')
  assert.deepEqual(outcome.strippedFields, [])
  assert.deepEqual(outcome.degradedFiles, [])
  assert.equal((await db.loadSession('s1')).title, '旧标题', '失败不得覆盖已有的好数据')
  assert.equal((await summaryOf('s1')).title, '旧标题', '摘要同样不变')
})

// ---------------------------------------------------------------- 失败分类与原子性

test('分类：会话写失败按 error.name 归类，outcome 带 stores 与截断后的 message', async () => {
  await freshDb()
  const cases = [
    ['QuotaExceededError', 'quota'],
    ['UnknownError', 'unavailable'],
    ['InvalidStateError', 'unknown'],
  ]
  for (const [name, kind] of cases) {
    const restore = failWrites('sessions', 'put', name, `x${name}`.repeat(40))
    try {
      const outcome = await db.saveSession(sessionOf(`id-${kind}`))
      assert.equal(outcome.failure.kind, kind, name)
      assert.equal(outcome.failure.name, name)
      assert.equal(outcome.failure.stores, 'sessions,sessionSummaries')
      assert.ok(outcome.failure.message.length <= 200, 'message 最多 200 字符')
      assert.equal(typeof outcome.failure.at, 'number')
    } finally {
      restore()
    }
  }
  assert.equal((await peek('sessions')).length, 0, '三种失败都不得留下会话')
  assert.equal((await peek('sessionSummaries')).length, 0, '三种失败都不得留下摘要')
})

test('原子性：摘要写失败时整个事务回滚，会话记录也不留', async () => {
  await freshDb()
  const restore = failWrites('sessionSummaries', 'put', 'InvalidStateError')
  try {
    const outcome = await db.saveSession(sessionOf('s1'))
    assert.equal(outcome.failure.kind, 'unknown')
    assert.equal(outcome.failure.stores, 'sessions,sessionSummaries')
  } finally {
    restore()
  }
  assert.equal(await db.loadSession('s1'), undefined, '摘要没写上，会话也不能留（半写）')
  assert.equal((await peek('sessionSummaries')).length, 0)
})

test('原子性：会话写失败时，同一次调用带的附件一个都不写', async () => {
  await freshDb()
  const restore = failWrites('sessions', 'put', 'InvalidStateError')
  try {
    const outcome = await db.saveSession(sessionOf('s1'), [storedFile('f1', '不该落')])
    assert.equal(outcome.failure.kind, 'unknown')
    assert.deepEqual(outcome.degradedFiles, [], '会话失败时不进入附件阶段，降级列表是空的')
  } finally {
    restore()
  }
  assert.equal(await db.loadFile('f1'), undefined)
  assert.equal((await peek('sessions')).length, 0)
})

test('配额：会话写失败会先清孤儿原件再重试恰好一次，第二次成功即落盘', async () => {
  await freshDb()
  await db.saveFiles([storedFile('orphan', '孤儿')])
  const restore = failWritesTimes('sessions', 'QuotaExceededError', 1)
  try {
    const outcome = await db.saveSession(sessionOf('s1'))
    assert.equal(outcome.failure, null, '重试那一次成功就该算成功')
  } finally {
    restore()
  }
  assert.equal((await db.loadSession('s1')).id, 's1')
  assert.equal(await db.loadFile('orphan'), undefined, '重试前要先清掉无人引用的原件')
})

test('配额：重试仍失败时如实报 quota，且不留下半条会话', async () => {
  await freshDb()
  const restore = failWrites('sessions', 'put', 'QuotaExceededError')
  try {
    const outcome = await db.saveSession(sessionOf('s1'))
    assert.equal(outcome.failure.kind, 'quota')
    assert.equal(outcome.failure.name, 'QuotaExceededError')
  } finally {
    restore()
  }
  assert.equal(await db.loadSession('s1'), undefined)
})

// ---------------------------------------------------------------- 附件降级（事务 B 可以失败）

test('降级：附件写失败不影响已落盘的会话，outcome 逐个报出降级附件', async () => {
  await freshDb()
  const session = sessionOf('s1', { messages: [userMessage('m1', '甲', [fileRef('bad')])] })
  const restore = failWrites('files', 'put', 'UnknownError')
  let outcome
  try {
    outcome = await db.saveSession(session, [storedFile('bad', '坏的')])
  } finally {
    restore()
  }
  assert.equal(outcome.failure, null, '附件失败不得回滚会话')
  assert.deepEqual(await db.loadSession('s1'), session)
  assert.equal(outcome.degradedFiles.length, 1)
  assert.equal(outcome.degradedFiles[0].id, 'bad')
  assert.equal(outcome.degradedFiles[0].bytes, storedFile('bad', '坏的').blob.size)
  assert.equal(outcome.degradedFiles[0].failure.kind, 'unavailable')
  assert.equal(outcome.degradedFiles[0].failure.stores, 'files')
  assert.equal(await db.loadFile('bad'), undefined, '写失败的原件不在库里')
})

test('降级：批量附件里只有一个写失败时，只降级那一个，其余照常落盘', async () => {
  await freshDb()
  const original = fake.IDBObjectStore.prototype.put
  fake.IDBObjectStore.prototype.put = function patched(value, key) {
    if (this.name === 'files' && value?.id === 'bad') {
      throw new DOMException('UnknownError', 'UnknownError')
    }
    return original.call(this, value, key)
  }
  let outcome
  try {
    outcome = await db.saveSession(sessionOf('s1'), [
      storedFile('good', '好的'),
      storedFile('bad', '坏的'),
    ])
  } finally {
    fake.IDBObjectStore.prototype.put = original
  }
  assert.equal(outcome.failure, null)
  assert.deepEqual(outcome.degradedFiles.map((item) => item.id), ['bad'])
  assert.equal(await (await db.loadFile('good')).text(), '好的')
  assert.equal(await db.loadFile('bad'), undefined)
})

test('降级：附件配额失败会先清孤儿再重试一次，重试成功则不算降级', async () => {
  await freshDb()
  await db.saveFiles([storedFile('orphan', '孤儿')])
  const restore = failWritesTimes('files', 'QuotaExceededError', 1)
  let outcome
  try {
    outcome = await db.saveSession(sessionOf('s1'), [storedFile('f1', '这次')])
  } finally {
    restore()
  }
  assert.equal(outcome.failure, null)
  assert.deepEqual(outcome.degradedFiles, [])
  assert.equal(await (await db.loadFile('f1')).text(), '这次')
  assert.equal(await db.loadFile('orphan'), undefined, '腾空间时孤儿被清掉')
})

test('降级：keepFileIds 里的原件在腾空间时必须避开，即使还没有任何会话引用', async () => {
  await freshDb()
  await db.saveFiles([storedFile('pending', '刚排队')])
  const restore = failWritesTimes('files', 'QuotaExceededError', 1)
  try {
    const outcome = await db.saveSession(sessionOf('s1'), [storedFile('f1', '新的')], {
      keepFileIds: ['pending'],
    })
    assert.deepEqual(outcome.degradedFiles, [])
  } finally {
    restore()
  }
  assert.equal(await (await db.loadFile('pending')).text(), '刚排队', '还没写进会话的原件不能当孤儿删')
})

// ---------------------------------------------------------------- saveFiles / loadFile

test('saveFiles / loadFile：按 id 存取原件；不存在的 id 返回 undefined', async () => {
  await freshDb()
  await db.saveFiles([storedFile('f1', '你好'), storedFile('f2', '世界')])
  assert.equal(await (await db.loadFile('f1')).text(), '你好')
  assert.equal((await db.loadFile('f1')).type, 'image/png')
  assert.equal(await db.loadFile('missing'), undefined)
  // 重复保存同一 id 覆盖而不是追加
  await db.saveFiles([storedFile('f1', '覆盖')])
  assert.equal(await (await db.loadFile('f1')).text(), '覆盖')
  assert.equal((await peek('files')).length, 2)
})

test('saveFiles 非原子（现状）：put 同步抛错时，同批里已排队的前面几个仍会提交', async () => {
  await freshDb()
  const original = fake.IDBObjectStore.prototype.put
  fake.IDBObjectStore.prototype.put = function patched(value, key) {
    if (this.name === 'files' && value?.id === 'f2') {
      throw new DOMException('InvalidStateError', 'InvalidStateError')
    }
    return original.call(this, value, key)
  }
  try {
    await assert.rejects(
      db.saveFiles([storedFile('f1', '甲'), storedFile('f2', '乙'), storedFile('f3', '丙')]),
      (error) => error.name === 'InvalidStateError'
    )
  } finally {
    fake.IDBObjectStore.prototype.put = original
  }
  // 与 saveSession 内部的 putFilesOnce 不同：saveFiles 不会 abort 事务，已排队的 put 照常提交
  assert.equal(await (await db.loadFile('f1')).text(), '甲', '现状：失败之前的那个已落盘')
  assert.equal(await db.loadFile('f2'), undefined)
  assert.equal(await db.loadFile('f3'), undefined, '失败之后的没机会排队')
})

// ---------------------------------------------------------------- 缺能力宿主

test('缺能力：没有 indexedDB 时读写都抛 StorageUnavailableError，且不留下半成品', async () => {
  await freshDb()
  const saved = globalThis.indexedDB
  delete globalThis.indexedDB
  try {
    await assert.rejects(db.loadSession('any'), (error) => error.name === 'StorageUnavailableError')
    await assert.rejects(db.loadSessionSummaries(), (error) => error instanceof db.StorageUnavailableError)
    await assert.rejects(db.pinSession('any', 1), (error) => error.name === 'StorageUnavailableError')
    await assert.rejects(db.deleteSession('any'), (error) => error.name === 'StorageUnavailableError')
    const outcome = await db.saveSession(sessionOf('s1'))
    assert.equal(outcome.failure.kind, 'unavailable')
    assert.equal(outcome.failure.name, 'StorageUnavailableError')
    assert.deepEqual(outcome.degradedFiles, [])
  } finally {
    globalThis.indexedDB = saved
  }
})

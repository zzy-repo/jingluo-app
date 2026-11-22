// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 store / 真 db / 真归档 | 耗时: <10s]
//
// Issue #831：**会话级分支** —— 从历史会话分叉出一条独立的新会话（完整分支 / 节点分支）。
//
// 为什么跑真实现：本单的四条硬约束（复制不是移动、分叉点之后不带入、附件按引用共享、导出导入带
// `branchOf`）全都落在**存储语义**上。给 `chat/db.ts` 打桩等于把被测物换成替身 —— 断言再绿也
// 不说明「两条会话的记录互不覆盖」。所以：
//   - 宿主用 `fake-indexeddb`（`idb` / 事务 / 索引 / 游标 / Blob 走真码）；
//   - 被测的是真 `chat/store.ts` 的 `createSessionBranch()` / `previewSessionBranch()`；
//   - store 的 `./db.js` 换成测试接缝（`tests/fixtures/domain03-04/session-db.mjs`，见
//     `installSessionMatrixEnv()`），但**接缝的每个方法都桥回真 `chat/db.ts`** —— 于是
//     「store 的动作」与「库里的记录」是同一条链路，不是两套并行事实；
//   - 归档往返用真 `exportArchive()` / `importArchive()` / `commitStaging()`（真 ZIP）。
//
// 覆盖（对应票面 1–7 条与验收 ①–⑦）：
//   ① 完整分支      —— 新会话消息数 = 父会话消息数，`branchOf.sessionId` = 父
//   ② 节点分支      —— 从第 N 条分叉只带前 N 条；确认文案带「之后的 M 条不会带入」
//   ③ 命名与徽标    —— 默认 `<原标题>（分支）`、可改名；列表徽标两态文案
//   ④ 双向独立      —— 改父标题 / 删父消息 / 继续聊父 → 分支不动；反向同样
//   ⑤ 附件按引用    —— 两侧附件 id 相同、存储只一份；父删后原件不在时降级「附件不可用」且不抛错
//   ⑥ 导出→导入     —— `branchOf` 保留；父会话不在本机时导入成功、徽标降级「来源已不在本机」
//   ⑦ DB 迁移       —— v14 → v15 可重复执行、老数据一条不丢、新索引就位
//
// 负向对照（人工各跑一次，结论见 PR 正文与文件末）：
//   ① 删掉「分叉点之后不带入」的判断（`path.slice(0, point.kept)` → `path`）→ ② 红；
//   ② 把附件改成「深拷贝」（分支侧给附件换新 id 并复制原件）→ ⑤ 红。
//
//   node tests/run-layer.mjs unit --case session-branch-831
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fakeIdb from 'fake-indexeddb'
import { openDB } from 'idb'
import { installSessionMatrixEnv, loadTsModule, setupDom } from '../helpers/dom-env.mjs'

/**
 * `fake-indexeddb/auto` 的副作用只在模块首次求值时装一次；合并批次跑完一个文件会把该文件
 * 新增的全局抹掉（#513）。所以每个文件自己幂等装一遍（与 `memory-session-scope-399` 同做法）。
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
for (const name of IDB_GLOBALS) {
  if (globalThis[name] === undefined && fakeIdb[name] !== undefined) {
    globalThis[name] = fakeIdb[name]
  }
}

/** 最小 localStorage：`settings.ts` / `apiConfig.ts` 只做 get / set / remove */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

// 装配顺序要紧：hook 必须先于任何 `src/**` 的动态 import（`.js→.ts` + 原生桥 / 诊断替身）
installSessionMatrixEnv()
// store.ts 在模块级用到 document / window（持久化钩子）与 requestAnimationFrame（流式增量）
setupDom()

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')

const db = await loadTsModule('src/services/chat/db.ts')
const attachments = await loadTsModule('src/services/attachments/store.ts')
const branch = await loadTsModule('src/services/chat/sessionBranch.ts')
const branchAttachments = await loadTsModule('src/services/chat/branchAttachments.ts')
const exportArchiveModule = await loadTsModule('src/services/chat/history/exportArchive.ts')
const importArchiveModule = await loadTsModule('src/services/chat/history/importArchive.ts')
const zipReader = await loadTsModule('src/services/chat/history/zipReader.ts')
const schema = await loadTsModule('src/services/chat/history/schema.ts')
const toLocal = await loadTsModule('src/services/chat/history/toLocal.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
// 展示层用**真**渲染函数（`.ts`，裸 Node 可直接加载）+ 真 zh / en 文案表：
// 断言的是「界面上会出现哪句话」，不是用例自己另写一份文案
const { BranchAttachmentNoticeView, SessionBranchBadgeView } = await loadTsModule(
  'src/components/session/sessionBranchView.ts'
)
const chat = await import('../../src/services/chat/store.ts')

const types = await loadTsModule('src/services/chat/types.ts')
const { DB_NAME, DB_VERSION, upgradeChatDB } = db
const { toSessionSummary } = types

const NOW = 1_700_000_000_000
const PARENT = 'sess-831-parent'
const ATT_ID = 'att-831-doc'
const ATT_SHA = 'b'.repeat(64)
const IMG_ID = 'img-831-file'

/** 与 i18n 的 `createTranslate` 等价：用真实 zh / en 文案渲染，占位符照抄真实现的规则 */
const translate = (table, key, params) =>
  table[key].replace(/\{(\w+)\}/g, (placeholder, name) =>
    typeof params?.[name] === 'string' || typeof params?.[name] === 'number'
      ? String(params[name])
      : placeholder
  )

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
  model: 'deepseek-chat',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text }],
})

/** 6 条消息的线性父会话（3 轮）：节点分叉点选第 2 条时「之后的 4 条不会带入」 */
const parentSession = () => ({
  id: PARENT,
  title: '原标题',
  createdAt: NOW,
  updatedAt: NOW,
  messages: [
    userMessage('p-u1', '第一问'),
    assistantMessage('p-a1', '第一答'),
    userMessage('p-u2', '第二问'),
    assistantMessage('p-a2', '第二答'),
    userMessage('p-u3', '第三问'),
    assistantMessage('p-a3', '第三答'),
  ],
})

/** 页内直读整库：断言「存储里有几条」用，不经被测模块 */
const rawRows = async (store) => {
  const handle = await openDB(DB_NAME)
  try {
    return await handle.getAll(store)
  } finally {
    handle.close()
  }
}

const rawKeys = async (store) => {
  const handle = await openDB(DB_NAME)
  try {
    return await handle.getAllKeys(store)
  } finally {
    handle.close()
  }
}

/** 起点干净：db.ts 的 `dbPromise` 是懒建的（import 时不连库），此刻删库不会被 blocked */
await new Promise((resolve) => {
  const request = indexedDB.deleteDatabase(DB_NAME)
  request.onsuccess = () => resolve()
  request.onerror = () => resolve()
  request.onblocked = () => resolve()
})

/** 清空业务数据（不删库：db.ts 的 `dbPromise` 还连着，deleteDatabase 会 blocked） */
const clearAll = async () => {
  // 先让**产品自己的** openDB 把库建到当前版本（不在这里另写一份 schema）：
  // 直接 `openDB(DB_NAME)` 会以 v1 建一个空库，`transaction([])` 当场 InvalidAccessError。
  await db.loadSessionSummaries()
  const handle = await openDB(DB_NAME)
  try {
    const names = [...handle.objectStoreNames]
    const tx = handle.transaction(names, 'readwrite')
    for (const name of names) {
      tx.objectStore(name).clear()
    }
    await tx.done
  } finally {
    handle.close()
  }
}

/**
 * store ↔ 真库的桥：`chat/store.ts` 的 `./db.js` 被换成了接缝模块，接缝的每个方法都调
 * `globalThis.__db.<name>`。这里把每个方法接到**真** `chat/db.ts` 上 ——
 * 于是「store 的动作」真的写进了 IndexedDB，断言可以直接读库。
 */
const bridgeDbToReal = () => {
  globalThis.__db = {
    calls: [],
    errors: [],
    loadSessionSummaries: () => db.loadSessionSummaries(),
    loadSession: (id) => db.loadSession(id),
    saveSession: (session, files) => db.saveSession(session, files ?? []),
    pinSession: (id, pinnedAt) => db.pinSession(id, pinnedAt),
    renameSession: (id, title) => db.renameSession(id, title),
    deleteSession: (id) => db.deleteSession(id),
  }
}

/** 造一个「真库里有父会话」的起点，并把 store 的内存态摆好（列表 + 详情缓存） */
const seedParent = async (session = parentSession()) => {
  await clearAll()
  bridgeDbToReal()
  await db.saveSession(session)
  chat.useChatStore.setState({
    ready: true,
    initError: false,
    importingHistory: false,
    sessions: [toSessionSummary(session)],
    sessionCache: { [session.id]: session },
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
    waitHints: {},
  })
  return session
}

/**
 * 等到某个终态（`persist()` 是 fire-and-forget，没有「落盘完成」的回调）。
 * 用 `setImmediate` 轮询而不是固定 sleep：结论与机器快慢无关（docs/TESTING-POLICY.md §11.5）。
 */
const until = async (label, predicate) => {
  for (let round = 0; round < 200; round += 1) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`等待超时：${label}`)
}

/** 渲染徽标（真 zh 文案 + 真渲染函数） */
const badgeMarkup = ({ origin, parentTitle, onOpenParent }) =>
  renderToStaticMarkup(
    createElement(SessionBranchBadgeView, {
      origin,
      parentTitle,
      onOpenParent,
      t: (key, params) => translate(zh, key, params),
    })
  )

const saveSessionOf = (id) => globalThis.__db.calls.filter((call) => call.name === 'saveSession' && call.args[0].id === id)

// ─────────────────────────────────────────────── ① 完整分支（票面 2 前半 / 验收 ①）

test('① 完整分支：新会话消息数 = 父会话消息数，branchOf.sessionId = 父会话', async () => {
  const parent = await seedParent()
  const id = await chat.createSessionBranch({ sessionId: PARENT, title: '原标题（分支）' })
  assert.ok(id, '分支应当创建成功')

  const branched = await db.loadSession(id)
  assert.equal(branched.messages.length, parent.messages.length, '完整分支要复制全部消息')
  assert.equal(branched.branchOf.sessionId, PARENT)
  assert.equal(branched.branchOf.messageId, undefined, '完整分支不记分叉点（缺省 = 整条复制）')
  assert.equal(branched.branchOf.createdAt > 0, true)

  // 列表徽标靠摘要里的 branchOf：摘要必须一起落库（不能只有详情有）
  const summaries = await db.loadSessionSummaries()
  const summary = summaries.find((item) => item.id === id)
  assert.equal(summary.branchOf.sessionId, PARENT)

  // 新会话可继续聊：消息树是线性列表（分叉出来的不是「消息级分支」的树）
  assert.equal(branched.rootMessageId, undefined)
  assert.equal(branched.messages.every((message) => message.parentId === undefined), true)
})

// ─────────────────────────────────────────────── ② 节点分支（票面 2 后半 / 验收 ②）

test('② 节点分支：从第 N 条分叉只含前 N 条；确认文案带「之后 M 条不会带入」', async () => {
  const parent = await seedParent()

  // 分叉点 = 第 2 条消息（第一轮回答）→ 带入 2 条，丢弃 4 条
  const point = await chat.previewSessionBranch({ sessionId: PARENT, messageId: 'p-a1' })
  assert.equal(point.kept, 2)
  assert.equal(point.dropped, 4)
  assert.equal(point.messageId, 'p-a1')

  // 创建前确认文案（真 zh / en 模板 + 真参数）：票面要求写清「第 N 条」「之后 M 条不带入」
  const zhConfirm = translate(zh, 'sessionBranchConfirmNode', { kept: point.kept, dropped: point.dropped })
  assert.equal(zhConfirm.includes('第 2 条消息处分支'), true, zhConfirm)
  assert.equal(zhConfirm.includes('之后的 4 条不会带入'), true, zhConfirm)
  const enConfirm = translate(en, 'sessionBranchConfirmNode', { kept: point.kept, dropped: point.dropped })
  assert.equal(enConfirm.includes('Branching at message 2'), true, enConfirm)
  assert.equal(enConfirm.includes('The 4 message(s) after it will not be carried over'), true, enConfirm)

  const id = await chat.createSessionBranch({
    sessionId: PARENT,
    messageId: 'p-a1',
    title: '原标题（分支）',
  })
  const branched = await db.loadSession(id)
  assert.equal(branched.messages.length, 2, '分叉点之后的消息一条都不许带入')
  assert.deepEqual(branched.messages.map((message) => message.id), ['p-u1', 'p-a1'])
  assert.equal(branched.branchOf.messageId, 'p-a1', '节点分支要记分叉点消息 id')

  // 分叉点算不出来（消息已被删）：不创建、不瞎猜位置
  assert.equal(await chat.previewSessionBranch({ sessionId: PARENT, messageId: 'nope' }), null)
  assert.equal(
    await chat.createSessionBranch({ sessionId: PARENT, messageId: 'nope', title: 'x' }),
    null
  )
  // 父会话的消息一条没少
  assert.equal((await db.loadSession(PARENT)).messages.length, parent.messages.length)
})

// ─────────────────────────────────────────── ③ 命名与徽标（票面 3 / 验收 ③）

test('③ 默认命名 `<原标题>（分支）`、可当场改名；列表徽标文案正确', async () => {
  await seedParent()

  // 默认名：真 zh / en 后缀各拼一次（空标题不留「（分支）」这种没有主语的标题）
  assert.equal(branch.branchTitle('原标题', zh.sessionBranchTitleSuffix), '原标题（分支）')
  assert.equal(branch.branchTitle('My chat', en.sessionBranchTitleSuffix), 'My chat (branch)')
  assert.equal(branch.branchTitle('   ', zh.sessionBranchTitleSuffix), zh.sessionBranchTitleSuffix.trim())

  const defaultTitle = branch.branchTitle('原标题', zh.sessionBranchTitleSuffix)
  const id = await chat.createSessionBranch({ sessionId: PARENT, title: defaultTitle })
  assert.equal((await db.loadSession(id)).title, '原标题（分支）')
  assert.equal((await db.loadSessionSummaries()).find((item) => item.id === id).title, '原标题（分支）')

  // 当场改名（弹层里改的就是这个值）：落库、且父会话标题不受影响
  chat.renameSession(id, '我改的名字')
  await until('分支标题落库', async () => (await db.loadSession(id)).title === '我改的名字')
  assert.equal((await db.loadSession(id)).title, '我改的名字')
  assert.equal((await db.loadSession(PARENT)).title, '原标题')

  // 列表徽标两态（纯展示组件，markup 级断言）
  const origin = { sessionId: PARENT, createdAt: NOW }
  const normal = badgeMarkup({ origin, parentTitle: '原标题' })
  assert.equal(normal.includes('data-testid="session-branch-badge"'), true)
  assert.equal(normal.includes('data-branch-state="branch"'), true)
  assert.equal(normal.includes(zh.sessionBranchBadge), true, '正常态徽标文案 = 「分支」')
  assert.equal(normal.includes(zh.sessionBranchBadgeFrom.replace('{title}', '原标题')), true)

  const degraded = badgeMarkup({ origin, parentTitle: null })
  assert.equal(degraded.includes('data-branch-state="source-missing"'), true)
  assert.equal(degraded.includes(zh.sessionBranchSourceMissing), true, '父会话不在 → 「来源已不在本机」')
  assert.equal(degraded.includes('session-branch-open-parent'), false, '降级态不可点（没有跳转目标）')

  // 普通会话不渲染徽标（不是分支就别加装饰）
  assert.equal(badgeMarkup({ parentTitle: '原标题' }), '')
})

// ─────────────────────────────────────────── ④ 双向独立（票面 4 / 验收 ④）

test('④ 双向独立：改父标题 / 删父消息 / 继续聊父 → 分支不变；反向同样', async () => {
  await seedParent()
  const id = await chat.createSessionBranch({ sessionId: PARENT, title: '原标题（分支）' })
  const branchBefore = await db.loadSession(id)
  const parentBefore = await db.loadSession(PARENT)

  // ① 改父标题（走 store 的真入口 → 真库）
  chat.renameSession(PARENT, '父会话改过的标题')
  await until('父会话标题落库', async () => (await db.loadSession(PARENT)).title === '父会话改过的标题')
  assert.equal((await db.loadSession(PARENT)).title, '父会话改过的标题')
  assert.deepEqual(await db.loadSession(id), branchBefore, '父会话改名不该动到分支的记录')

  // ② 删父消息（界面无「删除单条消息」入口；这里走 store 落盘的唯一出口 `db.saveSession`
  //    真实写入，验的是「两条会话的记录互不覆盖」，不是模拟状态）
  await db.saveSession({ ...parentBefore, title: '父会话改过的标题', messages: parentBefore.messages.slice(0, 2) })
  assert.equal((await db.loadSession(PARENT)).messages.length, 2)
  assert.deepEqual((await db.loadSession(id)).messages, branchBefore.messages, '父会话删消息不该动到分支')

  // ③ 继续聊父（追加一轮，与 sendMessage 落盘同一条路径）
  await db.saveSession({
    ...parentBefore,
    title: '父会话改过的标题',
    messages: [
      ...parentBefore.messages.slice(0, 2),
      userMessage('p-u-new', '父会话新问'),
      assistantMessage('p-a-new', '父会话新答'),
    ],
    updatedAt: NOW + 1000,
  })
  assert.deepEqual(await db.loadSession(id), branchBefore, '父会话继续对话不该动到分支')

  // ④ 反向：改分支标题 / 删分支消息 / 继续聊分支 → 父会话不变
  const parentSnapshot = await db.loadSession(PARENT)
  chat.renameSession(id, '分支自己也改名')
  await until('分支标题落库', async () => (await db.loadSession(id)).title === '分支自己也改名')
  await db.saveSession({ ...branchBefore, title: '分支自己也改名', messages: branchBefore.messages.slice(0, 2) })
  await db.saveSession({
    ...branchBefore,
    title: '分支自己也改名',
    messages: [
      ...branchBefore.messages.slice(0, 2),
      userMessage('b-u-new', '分支新问'),
      assistantMessage('b-a-new', '分支新答'),
    ],
    updatedAt: NOW + 2000,
  })
  assert.deepEqual(await db.loadSession(PARENT), parentSnapshot, '分支侧的任何改动不该回写父会话')
  assert.equal((await db.loadSession(id)).messages.length, 4)

  // ⑤ 内存对象也彼此独立（不只是库里两行）：消息 / 附件条目各是各的对象
  const plan = branch.planBranchSession({
    source: parentBefore,
    id: 'mem-only',
    title: '内存对照',
    createdAt: NOW,
  })
  const sharedParentFile = {
    id: IMG_ID,
    serverId: null,
    name: 'a.png',
    size: 3,
    isImage: true,
    mimeType: 'image/png',
  }
  const withFile = {
    ...parentBefore,
    messages: [userMessage('p-file', '带附件的问', [sharedParentFile])],
  }
  const memPlan = branch.planBranchSession({ source: withFile, id: 'mem-file', title: 't', createdAt: NOW })
  assert.notEqual(memPlan.session.messages[0], withFile.messages[0], '消息对象必须复制')
  assert.notEqual(memPlan.session.messages[0].files[0], withFile.messages[0].files[0], '附件条目也要各一份')
  assert.equal(memPlan.session.messages[0].files[0].id, withFile.messages[0].files[0].id, '但 id 是同一个（按引用共享）')
  memPlan.session.messages[0].files[0].serverId = 'uploaded-elsewhere'
  assert.equal(withFile.messages[0].files[0].serverId, null, '改分支侧的附件字段不该穿透到父会话')
  assert.ok(plan)
})

// ─────────────────────────────────────────── ⑤ 附件按引用（票面 6 / 验收 ⑤）

test('⑤ 附件按引用共享：两侧 id 相同、存储只一份；原件不在时降级「附件不可用」且不抛错', async () => {
  const parent = await seedParent()
  // 父会话的一条提问同时带文档附件（att- 前缀）与图片原件
  const attachmentsBefore = await rawKeys('attachments')
  await attachments.putAttachment({
    id: ATT_ID,
    filename: '合同.txt',
    mimeType: 'text/plain',
    size: 3,
    sha256: ATT_SHA,
    localPath: await attachments.saveAttachmentBlob(ATT_SHA, new Blob(['abc'], { type: 'text/plain' })),
    status: 'success',
    characterCount: 3,
    createdAt: NOW,
  })
  await db.saveFiles([{ id: IMG_ID, blob: new Blob(['PNG'], { type: 'image/png' }) }])
  const withFiles = {
    ...parent,
    messages: [
      userMessage('p-u1', '带附件的问', [
        {
          id: ATT_ID,
          serverId: null,
          name: '合同.txt',
          size: 3,
          isImage: false,
          mimeType: 'text/plain',
        },
        { id: IMG_ID, serverId: null, name: 'a.png', size: 3, isImage: true, mimeType: 'image/png' },
      ]),
      assistantMessage('p-a1', '第一答'),
    ],
  }
  await db.saveSession(withFiles)
  chat.useChatStore.setState({
    sessions: [toSessionSummary(withFiles)],
    sessionCache: { [PARENT]: withFiles },
  })

  const id = await chat.createSessionBranch({ sessionId: PARENT, title: '原标题（分支）' })
  const branched = await db.loadSession(id)
  assert.deepEqual(
    branched.messages[0].files.map((file) => file.id),
    [ATT_ID, IMG_ID],
    '两侧引用同一批附件 id（不换新 id）'
  )

  // 存储里只有一份：附件元数据 1 条、原件 1 份（分支没有复制任何本体）
  const attachmentRows = await rawRows('attachments')
  assert.equal(attachmentRows.length, attachmentsBefore.length + 1)
  assert.equal(attachmentRows.filter((row) => row.sha256 === ATT_SHA).length, 1, '同 sha256 只有一份')
  const blobKeys = await rawKeys('files')
  assert.equal(blobKeys.filter((key) => key === `attachment-${ATT_SHA}`).length, 1)
  assert.equal(blobKeys.filter((key) => key === IMG_ID).length, 1)
  // 创建分支没有写任何 files 记录（store 侧一次都没传原件）
  assert.equal(saveSessionOf(id).every((call) => (call.args[1] ?? []).length === 0), true)

  // 父会话删除：分支仍引用同一批 id，所以原件按引用计数「还有人要」→ 分支照常可用（引用的应有结果）
  await db.deleteSession(PARENT)
  assert.equal((await rawKeys('files')).includes(IMG_ID), true, '分支还引用着，原件不该被删')
  assert.equal((await rawKeys('attachments')).includes(ATT_ID), true)
  assert.equal(await branchAttachments.attachmentAvailable(ATT_ID), true)

  // 原件真的不在本机（换设备导入 / 存储被清理 / 父会话的附件被外部清掉）：降级，不抛错
  await attachments.removeAttachment(ATT_ID)
  const handle = await openDB(DB_NAME)
  await handle.delete('files', IMG_ID)
  handle.close()
  const missing = await branch.unavailableAttachmentIds(
    branch.attachmentRefsOf(branched),
    branchAttachments.attachmentAvailable
  )
  assert.deepEqual(missing.sort(), [ATT_ID, IMG_ID].sort())
  // 判断函数抛错也按「不可用」收口（绝不让会话页炸掉）
  const throwing = await branch.unavailableAttachmentIds([ATT_ID], () => {
    throw new Error('storage exploded')
  })
  assert.deepEqual(throwing, [ATT_ID])
  // 会话本身仍然读得出来、能继续聊（降级只在展示层）
  assert.equal((await db.loadSession(id)).messages.length, 2)

  const markup = renderToStaticMarkup(
    createElement(BranchAttachmentNoticeView, {
      missing: missing.length,
      t: (key, params) => translate(zh, key, params),
    })
  )
  assert.equal(markup.includes('data-testid="session-branch-attachment-missing"'), true)
  assert.equal(markup.includes('附件不可用'), true, markup)
  assert.equal(
    renderToStaticMarkup(
      createElement(BranchAttachmentNoticeView, { missing: 0, t: (key, params) => translate(zh, key, params) })
    ),
    ''
  )
})

// ─────────────────────────────────────── ⑥ 导出 / 导入（票面 7 / 验收 ⑥）

test('⑥ 导出→导入保留 branchOf；父会话不在本机的设备导入成功、徽标降级「来源已不在本机」', async () => {
  const parent = await seedParent()
  const id = await chat.createSessionBranch({ sessionId: PARENT, messageId: 'p-a1', title: '原标题（分支）' })
  const branched = await db.loadSession(id)

  // 只导出**分支这一条**（#390 选择性导出，包结构与全量一致）
  const blob = await exportArchiveModule.exportArchive([branched], { sessionIds: [id] })
  const entries = []
  for await (const entry of zipReader.readArchive(blob)) {
    // 每个条目都要读完（流式读法靠「读了下一条」校验上一条的大小 / CRC），只挑出会话 JSON 解析
    const data = await zipReader.readEntry(entry)
    if (entry.path === `chat_sessions/${id}.json`) {
      entries.push(JSON.parse(await data.text()))
    }
  }
  assert.equal(entries.length, 1)
  assert.equal(entries[0].branch_of.session_id, PARENT, '归档必须带 branch_of')
  assert.equal(entries[0].branch_of.message_id, 'p-a1')
  assert.equal(typeof entries[0].branch_of.created_at, 'string')

  // 归档 → 本地：`branchOf` 原样还原（父会话在不在本机不影响这一步）
  const local = toLocal.toLocalSessionResult(schema.readSessionFile(entries[0]))
  assert.equal(local.ok, true)
  assert.equal(local.session.session.branchOf.sessionId, PARENT)
  assert.equal(local.session.session.branchOf.messageId, 'p-a1')
  assert.equal(local.session.session.branchOf.createdAt, branched.branchOf.createdAt)

  // 真·换设备：整库清空（父会话不存在），把包装进去
  await clearAll()
  const zipFile = new File([blob], 'deepseek_data-831.zip', { type: 'application/zip' })
  await db.clearStaging()
  const result = await importArchiveModule.importArchive(zipFile)
  const summaries = await db.commitStaging()
  assert.equal(result.skipped.length, 0)
  assert.equal(summaries.length, 1, '导入必须成功（父会话不在不是失败）')
  const imported = await db.loadSession(id)
  assert.equal(imported.branchOf.sessionId, PARENT)
  assert.equal(imported.branchOf.messageId, 'p-a1')
  assert.equal(imported.messages.length, 2)

  // 父会话不在本机 → 徽标降级「来源已不在本机」（不报错、不假装存在）
  const loaded = await db.loadSessionSummaries()
  assert.equal(Object.hasOwn(Object.fromEntries(loaded.map((item) => [item.id, true])), PARENT), false)
  const parentTitle = branch.parentTitleOf(imported.branchOf, loaded)
  assert.equal(parentTitle, null)
  const markup = badgeMarkup({ origin: imported.branchOf, parentTitle })
  assert.equal(markup.includes(zh.sessionBranchSourceMissing), true, markup)

  // 父会话在的设备：同一份归档导进去，标题回到正常徽标文案
  const restored = badgeMarkup({ origin: imported.branchOf, parentTitle: '原标题' })
  assert.equal(restored.includes(zh.sessionBranchBadge), true)
  assert.equal(parent.messages.length > 0, true)
})

// ─────────────────────────────────────────── ⑦ DB 迁移（验收 ⑦）

/** v14 的 store / 索引清单（冻结的历史 schema，不跟着当前 `upgradeChatDB` 变） */
const LEGACY_SCHEMA = [
  ['sessions', { keyPath: 'id' }, []],
  ['sessionSummaries', { keyPath: 'id' }, [['fileIds', 'fileIds', { multiEntry: true }]]],
  ['files', { keyPath: 'id' }, []],
  ['sessionsStaging', { keyPath: 'id' }, []],
  ['filesStaging', { keyPath: 'id' }, []],
  ['appAssets', { keyPath: 'key' }, []],
  [
    'attachments',
    { keyPath: 'id' },
    [
      ['sha256', 'sha256', {}],
      ['parsedTextPath', 'parsedTextPath', {}],
    ],
  ],
  ['attachmentTexts', { keyPath: 'key' }, [['sha256', 'sha256', {}]]],
  ['sessionMemory', { keyPath: 'id' }, [['sessionId', 'sessionId', {}]]],
]

const LEGACY_DB_VERSION = 14
const PROBE_DB = 'chat-demo-migration-probe-831'

const seedLegacy = async () => {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(PROBE_DB)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
  const legacy = await openDB(PROBE_DB, LEGACY_DB_VERSION, {
    upgrade(handle) {
      for (const [name, options, indexList] of LEGACY_SCHEMA) {
        const store = handle.createObjectStore(name, options)
        for (const [indexName, keyPath, indexOptions] of indexList) {
          store.createIndex(indexName, keyPath, indexOptions)
        }
      }
    },
  })
  await legacy.put('sessions', {
    id: 'sess-legacy-831',
    title: 'v14 的老会话',
    createdAt: NOW,
    updatedAt: NOW,
    rootMessageId: null,
    messages: [userMessage('legacy-u1', '旧消息')],
  })
  await legacy.put('sessionSummaries', {
    id: 'sess-legacy-831',
    title: 'v14 的老会话',
    createdAt: NOW,
    updatedAt: NOW,
    fileIds: [],
  })
  await legacy.put('files', { id: 'legacy-img', blob: new Blob(['OLD'], { type: 'image/png' }) })
  await legacy.put('attachments', {
    id: 'att-legacy',
    filename: 'a.txt',
    mimeType: 'text/plain',
    size: 3,
    sha256: 'c'.repeat(64),
    localPath: `attachment-${'c'.repeat(64)}`,
    status: 'success',
    characterCount: 3,
    createdAt: NOW,
  })
  await legacy.put('sessionMemory', {
    id: 'sess-legacy-831:chunk-1',
    sessionId: 'sess-legacy-831',
    key: 'chunk-1',
    text: '旧记忆',
    bytes: 9,
    createdAt: NOW,
    updatedAt: NOW,
  })
  legacy.close()
}

/** 整库快照：store → 记录（Blob 折成 {type,size}，才能深比较） */
const snapshotProbe = async () => {
  const handle = await openDB(PROBE_DB)
  try {
    const stores = [...handle.objectStoreNames].sort()
    const data = {}
    const indexes = {}
    for (const store of stores) {
      const tx = handle.transaction(store, 'readonly')
      indexes[store] = [...tx.store.indexNames].sort()
      const rows = await tx.store.getAll()
      data[store] = rows.map((row) => {
        const copy = { ...row }
        for (const [key, value] of Object.entries(copy)) {
          if (value instanceof Blob) {
            copy[key] = { __blob: true, type: value.type, size: value.size }
          }
        }
        return copy
      })
    }
    return { version: handle.version, stores, data, indexes }
  } finally {
    handle.close()
  }
}

test('⑦ DB 迁移 v14 → v15：可重复执行、老数据一条不丢、branchOf 索引就位', async () => {
  assert.equal(DB_VERSION > LEGACY_DB_VERSION, true, 'DB_VERSION 必须大于迁移起点（版本号不许往回改）')
  await seedLegacy()
  const before = await snapshotProbe()
  assert.equal(before.version, LEGACY_DB_VERSION)
  assert.equal(before.stores.includes('sessionSummaries'), true)
  assert.deepEqual(before.indexes.sessionSummaries, ['fileIds'], 'v14 的摘要只有 fileIds 索引')

  // ① 用产品里**同一个** upgrade 回调升级，并在**同一个 versionchange 事务里跑两遍**：
  //    第二遍必须是无操作（`contains()` 守卫），否则 `createIndex` 会抛 ConstraintError
  const upgraded = await openDB(PROBE_DB, DB_VERSION, {
    upgrade(handle, oldVersion, newVersion, tx) {
      upgradeChatDB(handle, oldVersion, newVersion, tx)
      upgradeChatDB(handle, oldVersion, newVersion, tx)
    },
  })
  upgraded.close()
  const after = await snapshotProbe()

  assert.equal(after.version, DB_VERSION)
  assert.deepEqual(after.stores, before.stores, '本次迁移只新增索引，一个 store 都不增不减')
  for (const store of before.stores) {
    if (store === 'sessionSummaries') {
      // 唯一的变化：多一条 branchOf 索引；旧的 fileIds 一个不少
      assert.deepEqual(after.indexes[store], ['branchOf', 'fileIds'])
    } else {
      assert.deepEqual(after.indexes[store], before.indexes[store], `${store} 的索引被改动`)
    }
  }
  for (const store of before.stores) {
    assert.deepEqual(after.data[store], before.data[store], `${store} 的旧数据被升级改动了`)
  }

  // ② 再升级一次（v15 → v15 不会触发回调，但用一个从 v14 起步、索引已半就位的库验「可重复」）
  const partial = await openDB(PROBE_DB, DB_VERSION, {
    upgrade(handle, oldVersion, newVersion, tx) {
      // 手工先把索引建好，再跑整段回调：`contains()` 守卫必须让它变成无操作而不是抛错
      const summaries = tx.objectStore('sessionSummaries')
      if (!summaries.indexNames.contains('branchOf')) {
        summaries.createIndex('branchOf', 'branchOf.sessionId')
      }
      upgradeChatDB(handle, oldVersion, newVersion, tx)
    },
  })
  partial.close()
  const again = await snapshotProbe()
  assert.deepEqual(again, after, '重复执行迁移不应改变库的任何一处')

  // ③ 新索引真的可用：分支摘要按父会话 id 能查到（老摘要没有 branchOf，不进索引，读起来照旧）
  const probe = await openDB(PROBE_DB)
  const tx = probe.transaction('sessionSummaries', 'readwrite')
  await tx.store.put({
    id: 'sess-branch-831',
    title: '分支',
    createdAt: NOW,
    updatedAt: NOW,
    fileIds: [],
    branchOf: { sessionId: 'sess-legacy-831', createdAt: NOW },
  })
  await tx.done
  const hits = await probe.getAllFromIndex('sessionSummaries', 'branchOf', 'sess-legacy-831')
  const legacy = await probe.get('sessionSummaries', 'sess-legacy-831')
  probe.close()
  assert.deepEqual(hits.map((row) => row.id), ['sess-branch-831'])
  assert.equal(legacy.branchOf, undefined, '老记录不该被回填（schemaless 字段缺省即有语义）')
})

// ─────────────────────────────────── 用语表（zh / en 成对，占位符对齐）

test('文案：新增 key 的 zh / en 成对且占位符一致', () => {
  const keys = Object.keys(zh).filter((key) => key.startsWith('sessionBranch'))
  assert.equal(keys.length >= 14, true, `新增 key 数量异常：${keys.join(',')}`)
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    const placeholders = (text) => (text.match(/\{(\w+)\}/g) ?? []).sort().join(',')
    assert.equal(placeholders(en[key]), placeholders(zh[key]), `${key} 占位符不一致`)
    assert.equal(/[\u4e00-\u9fa5]/.test(en[key]), false, `${key} 的英文里混了中文`)
  }
})

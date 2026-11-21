// [layer: unit | 依赖: fake-indexeddb（devDependency，纯 Node 内存 IndexedDB） | 耗时: <5s]
//
// Issue #399：**窗口记忆按会话隔离存储** + 会话删除联动清理 + 容量淘汰（证据文件）。
//
// 为什么能直接跑真实现（与 #572 / #531 同一理由）：被测物就是存储语义本身 —— 给 `chat/db.ts`
// 或索引打桩等于把被测的东西换成替身，断言再绿也不说明产品行为。宿主用 `fake-indexeddb`
// （纯 JS 内存实现），`idb` / 事务 / 索引 / 游标 / Blob 全走真码。
//
// 覆盖（对应 #399 的四条关闭条件 + #398 的接线条目，表驱动）：
//   T1 两会话交叉写入      —— A 读不到 B 的、B 读不到 A 的（隔离的读侧 + 写侧）
//   T2 同会话覆盖写        —— 后写覆盖先写，条数仍是 1，`createdAt` 不漂
//   T3 超条数上限          —— 按 oldest-first 淘汰、**只淘汰本会话**、有 toast 提示 + diagnostic 日志
//   T4 超字节上限          —— 同上（双限里的第二条腿，边界「正好等于上限」不淘汰）
//   T5 删会话              —— 该会话记忆清 0（直接读库核对），其它会话一条不少
//   T6 embedding 关闭/打开 —— 关闭态 `fetchCalls === 0` 且库里没有向量；打开态真的发请求并落向量
//   T7 单条超上限          —— 明确拒绝写入 + 提示（不是「写进去再淘汰自己」）
//   T8 DB 迁移不变量       —— 在一个真 v13 库上跑**同一个** upgrade 回调：旧 store / 旧数据一条不动
//
// 负向对照（人工各跑一次，结论写在 PR 与 file 末）：
//   ① 把 `memoryEntryId()` 里的 `sessionId` 去掉（变成全局键 `id = key`）→ T1 变红；
//   ② 删掉 `db.deleteSession()` 里清 `sessionMemory` 的那段 → T5 变红；
//   ③ 把 T4 的淘汰序反过来（「最新优先」而不是 oldest-first）→ T4 的不变量①变红；
//   ④ 把 T4 的会话键改回不定宽（`b-${i}`）：同毫秒平局落到主键**字典序**（`b-10 < b-2`）→
//      T4 在本机变成**间歇**红（就是 #399 这次 CI 红的那种形状）。零填充把字典序钉成写入序，
//      所以用例与「这批写入落在几个毫秒里」无关 —— 这是修**确定性**，不是放宽断言。
//
//   node tests/run-layer.mjs unit --only memory-session-scope-399
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as fakeIdb from 'fake-indexeddb'
import { openDB } from 'idb'
import {
  chatCollectorStub,
  chatStub,
  installEndpointsGlobals,
  installTsResolve,
  loadTsModule,
  resetLog,
} from '../helpers/dom-env.mjs'

/**
 * `fake-indexeddb/auto` 的副作用只在模块首次求值时装一次；run-layer 合并批次跑完一个文件会把
 * 该文件新增的全局抹掉（#513）。所以每个文件自己幂等装一遍（同 `attachment-store-572` 的做法）。
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

// 装配：`.js→.ts` 解析 + Capacitor / 诊断写入口替身（诊断替身把 `record()` 收进 `globalThis.__log`，
// T3 / T4 / T7 的「必须留痕」就断言在那里）。顺序要紧：hook 必须先于任何 `src/**` 的动态 import。
installTsResolve({
  stubs: { '@capacitor/core': chatStub('capacitor.mjs') },
  onResolve: (specifier) =>
    /diagnostics\/collector\.js$/u.test(specifier) ? chatCollectorStub() : undefined,
})
installEndpointsGlobals({ apiOrigin: 'https://api.test.invalid' })

/** 每一次 fetch 都记一笔：#398 的硬指标「关闭态零请求」落在这个数组的长度上 */
const fetchCalls = []
let fetchHandler = () => new Response('{}', { status: 200 })
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ method: (init.method ?? 'GET').toUpperCase(), url: String(url), body: init.body })
  return fetchHandler(url, init)
}

const db = await loadTsModule('src/services/chat/db.ts')
const memory = await loadTsModule('src/services/memory/sessionMemory.ts')
// 同一个 ESM 实例（`loadTsModule` 走动态 import，模块图共享）：`isEmbeddingEnabled()` 读的就是
// `sessionMemory.ts` 里那道门读的那份设置 —— T4 用它**断言**当前确实是关闭态，不靠默认值假设。
const embeddingGate = await loadTsModule('src/services/memory/embeddingGate.ts')
const settings = await loadTsModule('src/services/settings.ts')
const apiConfig = await loadTsModule('src/services/api/apiConfig.ts')
const { LIMITS } = await loadTsModule('src/services/limits.ts')

const { DB_NAME, DB_VERSION, upgradeChatDB } = db
const MEMORY_LIMITS = LIMITS.memory

/** 会话夹具：只要有 id / 标题 / 时间戳与空消息表，`saveSession()` 就能落库 */
const sessionOf = (id, updatedAt = 1_700_000_000_000) => ({
  id,
  title: `会话 ${id}`,
  createdAt: updatedAt,
  updatedAt,
  messages: [],
})

/** 直接读库（**不经被测模块**）取 `sessionMemory` 的全部行：用来核对「库里到底有没有」 */
const rawMemoryRows = async () => {
  const handle = await openDB(DB_NAME)
  try {
    return await handle.getAll('sessionMemory')
  } finally {
    handle.close()
  }
}

const rawCountOf = async (sessionId) => {
  const rows = await rawMemoryRows()
  return rows.filter((row) => row.sessionId === sessionId).length
}

/** 提示通道：把 `onMemoryNotice` 收到的通知攒起来（T3/T4/T7 断言「不许静默」） */
const collectNotices = () => {
  const notices = []
  const off = memory.onMemoryNotice((notice) => notices.push(notice))
  return { notices, off }
}

/** 诊断日志里本单写的那几条（`record('warning', 'warn', 'memory: …')`） */
const memoryRecords = () =>
  (globalThis.__log?.records ?? []).filter((entry) => String(entry.message).startsWith('memory: '))

const resetFetch = () => {
  fetchCalls.length = 0
  fetchHandler = () => new Response('{}', { status: 200 })
}

/** 一条 OpenAI 兼容的 /embeddings 响应 */
const embeddingResponse = (vectors) => () =>
  new Response(
    JSON.stringify({
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )

/** 把渠道配成「OpenAI 兼容 + 地址 + Key」：唯一声明了 /embeddings 的渠道（#397） */
const useOpenAiChannel = () => {
  apiConfig.setProviderKind('openai')
  apiConfig.setBaseUrl('https://embed.test.invalid/v1')
  apiConfig.setModel('chat-model-of-channel')
  apiConfig.setApiKey('sk-test-399')
}

// ────────────────────────────────────────────────────────────── T1 隔离（关闭条件 1）

/**
 * 交叉写入表：两个会话用**同一个 key** 写不同正文 —— 这是最容易把「隔离」写成「最后一条覆盖我」
 * 的形状。断言落在三个观测面：按 key 直读、按会话取全量、直接读库。
 */
const CROSS_WRITE_CASES = [
  { id: 'T1-a', session: 'sess-399-a', key: 'chunk-1', text: 'A 的第一次倾诉：我想辞职' },
  { id: 'T1-b', session: 'sess-399-b', key: 'chunk-1', text: 'B 的完全无关内容：晚饭吃什么' },
]

test('T1 两会话交叉写入：A 读不到 B 的，B 读不到 A 的（同一个 key 也不串）', async () => {
  settings.setEmbeddingEnabled(false)
  for (const row of CROSS_WRITE_CASES) {
    const outcome = await memory.saveMemoryEntry(row.session, { key: row.key, text: row.text })
    assert.equal(outcome.written, true, `${row.id} 应当写入成功`)
  }

  // ① 按 key 直读：同一个 key，两个会话各自读到自己那份
  const a = await memory.readMemoryEntry('sess-399-a', 'chunk-1')
  const b = await memory.readMemoryEntry('sess-399-b', 'chunk-1')
  assert.equal(a?.text, CROSS_WRITE_CASES[0].text)
  assert.equal(b?.text, CROSS_WRITE_CASES[1].text)
  assert.notEqual(a?.text, b?.text)

  // ② 按会话取全量：列表里没有别人的条目
  const listA = await memory.listMemoryEntries('sess-399-a')
  const listB = await memory.listMemoryEntries('sess-399-b')
  assert.deepEqual(listA.map((entry) => entry.text), [CROSS_WRITE_CASES[0].text])
  assert.deepEqual(listB.map((entry) => entry.text), [CROSS_WRITE_CASES[1].text])

  // ③ 直接读库：两条记录、两个 sessionId、主键含会话 ID
  const rows = await rawMemoryRows()
  const mine = rows.filter((row) => row.sessionId.startsWith('sess-399-'))
  assert.deepEqual(
    mine.map((row) => row.id).sort(),
    ['sess-399-a:chunk-1', 'sess-399-b:chunk-1']
  )

  // ④ 不存在的 key：A 读 B 独有的 key 拿不到东西
  await memory.saveMemoryEntry('sess-399-b', { key: 'only-in-b', text: 'B 独有' })
  assert.equal(await memory.readMemoryEntry('sess-399-a', 'only-in-b'), undefined)
  assert.equal((await memory.listMemoryEntries('sess-399-a')).length, 1)
})

// ────────────────────────────────────────────────────────── T2 同会话覆盖写

const OVERWRITE_CASES = [
  { id: 'T2-a', key: 'summary-1', text: '第一版摘要', expect: '第二版摘要（覆盖）' },
]

test('T2 同会话覆盖写：后者覆盖前者，不产生重复条目，createdAt 不漂', async () => {
  settings.setEmbeddingEnabled(false)
  for (const row of OVERWRITE_CASES) {
    const first = await memory.saveMemoryEntry('sess-399-overwrite', {
      key: row.key,
      text: row.text,
    })
    assert.equal(first.written, true)
    const second = await memory.saveMemoryEntry('sess-399-overwrite', {
      key: row.key,
      text: row.expect,
    })
    assert.equal(second.written, true)

    const list = await memory.listMemoryEntries('sess-399-overwrite')
    assert.equal(list.length, 1, `${row.id} 覆盖写不该产生第二条`)
    assert.equal(list[0].text, row.expect)
    if (first.written && second.written) {
      assert.equal(second.entry.createdAt, first.entry.createdAt, '首次写入时间不该被覆盖改掉')
      assert.ok(second.entry.updatedAt >= first.entry.updatedAt)
    }
    assert.equal(await rawCountOf('sess-399-overwrite'), 1)
  }
})

// ─────────────────────────────────────────────────── T3 超条数上限（只淘汰本会话）

/**
 * 会话内记忆键：**必须定宽零填充**（`c-0000`…），不是 `c-0`…
 *
 * 实现的淘汰序是 `(updatedAt 升序, 同一毫秒按主键 id 升序)`（见 `sessionMemory.ts` 文件头），
 * 而主键是 `` `${sessionId}:${key}` ``。键不定宽时同毫秒平局落到**字典序**：`c-10 < c-2`，
 * 于是「谁是最新写入的那批」在「这批写入全落在同一毫秒」时按数值序算就错位（#399 的 CI 红
 * 就是这一种形状：本地跑得快/慢决定了撞不撞平局，所以它看起来像间歇性 flaky）。
 * 零填充让**字典序 == 写入序**，用例因此与「这批写入跨了几个毫秒」无关 ——
 * 确定性来自契约（`(updatedAt, id)`），不靠写入速度碰运气。T3 的条数上限用例同理。
 */
const paddedSessKey = (prefix, index) => `${prefix}-${String(index).padStart(4, '0')}`

/**
 * 表驱动：每行 = 一个会话的「写多少条 + 上限是多少」。
 * 期望值全部由 `LIMITS.memory` 现算，不写死数字 —— 阈值调整时用例跟着变，不会悄悄失效。
 */
const ENTRY_LIMIT_CASES = [
  {
    id: 'T3-a',
    label: '本会话：写「上限 + 3」条，只留最新的「上限」条',
    session: 'sess-399-cap-a',
    over: 3,
  },
]

/** 邻居会话：全程不写，用来证明「淘汰只在本会话内」 */
const CAP_NEIGHBOUR = 'sess-399-cap-neighbour'
const CAP_NEIGHBOUR_ENTRIES = 5

test('T3 超条数上限：oldest-first 淘汰、只淘汰本会话、有提示与日志', async () => {
  settings.setEmbeddingEnabled(false)
  const limit = MEMORY_LIMITS.maxEntriesPerSession
  const victim = ENTRY_LIMIT_CASES[0].session
  const neighbour = CAP_NEIGHBOUR

  // 邻居会话先写几条（远离上限），用来证明「淘汰只在本会话内」
  await memory.clearSessionMemory(neighbour)
  for (let i = 0; i < CAP_NEIGHBOUR_ENTRIES; i += 1) {
    await memory.saveMemoryEntry(neighbour, { key: paddedSessKey('n', i), text: `邻居的第 ${i} 条` })
  }
  const neighbourBefore = await memory.listMemoryEntries(neighbour)
  await memory.clearSessionMemory(victim)

  const { notices, off } = collectNotices()
  resetLog()
  const texts = []
  const outcomes = []
  try {
    for (let i = 0; i < limit + ENTRY_LIMIT_CASES[0].over; i += 1) {
      const text = `本会话第 ${i} 条`
      texts.push(text)
      outcomes.push(await memory.saveMemoryEntry(victim, { key: paddedSessKey('c', i), text }))
    }
  } finally {
    off()
  }

  const survivors = await memory.listMemoryEntries(victim)
  assert.equal(survivors.length, limit, `应当只剩 ${limit} 条`)
  // oldest-first：留下的是**最后写的** limit 条，顺序仍是写入顺序
  assert.deepEqual(
    survivors.map((entry) => entry.text),
    texts.slice(texts.length - limit)
  )
  // 前 3 次写入之后每次都在淘汰，累计淘汰条数 = over
  const totalEvicted = outcomes.reduce((sum, item) => sum + (item.written ? item.evicted : 0), 0)
  assert.equal(totalEvicted, ENTRY_LIMIT_CASES[0].over)
  assert.equal(await rawCountOf(victim), limit)

  // 提示：至少有一条「淘汰了 N 条」，且参数是条数
  const evictedNotices = notices.filter((notice) => notice.key === 'memoryEvicted')
  assert.ok(evictedNotices.length > 0, '淘汰必须给提示（不许静默丢）')
  assert.ok(evictedNotices.every((notice) => notice.params.count > 0))

  // 日志：复用既有的 record，且带上会话维度与淘汰条数
  const logged = memoryRecords().filter((entry) => entry.kind === 'warning')
  assert.ok(logged.length > 0, '淘汰必须留一条诊断日志')
  assert.equal(logged[0].level, 'warn')
  assert.equal(logged[0].fields['memory.session'], victim)
  assert.ok(logged[0].fields['memory.evicted'] >= 1)

  // 邻居会话一条不少（跨会话淘汰是不允许的）
  const neighbourAfter = await memory.listMemoryEntries(neighbour)
  assert.deepEqual(
    neighbourAfter.map((entry) => entry.text),
    neighbourBefore.map((entry) => entry.text),
    '淘汰必须只在本会话内进行'
  )
  await memory.clearSessionMemory(neighbour)
  await memory.clearSessionMemory(victim)
})

// ─────────────────────────────────────────────────── T4 超字节上限（双限的第二条腿）

const BYTE_LIMIT_CASES = [
  { id: 'T4-a', label: '每条约 64 KB，写 上限/条大小 + 2 条', sizeOf: 64 * 1024, over: 2 },
]

/** 按实现的排序契约排一遍：`updatedAt` 升序，同毫秒按主键 `id` 升序（用例自己排，不借模块的顺序） */
const byContractOrder = (a, b) =>
  a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt - b.updatedAt

test('T4 超字节上限：按 oldest-first 淘汰、边界「正好等于上限」不淘汰', async () => {
  // ── 状态隔离：不依赖「上一个文件跑完时的开关状态」。embedding 开着时每条会多算
  // 4 字节/分量的向量，字节口径就变了（同一个用例就会淘汰出不同的条数），所以这里
  // **显式置关闭 + 断言当前确实是关闭态**，跑完在 finally 里还原成进来时的值。
  const embeddingWasEnabled = embeddingGate.isEmbeddingEnabled()
  settings.setEmbeddingEnabled(false)
  try {
    assert.equal(
      embeddingGate.isEmbeddingEnabled(),
      false,
      '用例前提：T4 必须在 embedding 关闭态下跑（打开态每条会带上向量分量，字节口径就不是纯正文了）'
    )

    const limit = MEMORY_LIMITS.maxBytesPerSession
    const row = BYTE_LIMIT_CASES[0]
    const session = 'sess-399-bytes'
    await memory.clearSessionMemory(session)

    // 用例前提（对夹具数字，不对运行结果断言）：条大小整除上限 —— 只有这样
    // 「写满 上限/条 条」才正好是「正好等于上限」的边界，也才能断言「剩下的正好填满上限」。
    assert.equal(limit % row.sizeOf, 0, '用例前提：单条大小整除字节上限（边界用例要用它）')
    const fit = Math.floor(limit / row.sizeOf)
    assert.ok(fit >= 2, '用例前提：单条大小至少能放下两条，否则测的是「单条超上限」（T7）')
    const body = (i) => `${String(i).padStart(4, '0')}${'x'.repeat(row.sizeOf - 4)}`

    // 字节口径**只有一份**：用例拿被测模块导出的同一个 `memoryEntryBytes` 去核对，
    // 不另写一套 `Buffer.byteLength` / `TextEncoder` 估算（两套算法迟早漂移）。
    for (let i = 0; i < fit + row.over; i += 1) {
      assert.equal(
        memory.memoryEntryBytes(body(i)),
        row.sizeOf,
        `用例前提：正文正好 ${row.sizeOf} 字节（口径 = 实现的 memoryEntryBytes，UTF-8）`
      )
    }

    const { notices, off } = collectNotices()
    resetLog()
    const outcomes = []
    try {
      for (let i = 0; i < fit + row.over; i += 1) {
        outcomes.push(await memory.saveMemoryEntry(session, { key: paddedSessKey('b', i), text: body(i) }))
      }
    } finally {
      off()
    }

    // 三个观测面：模块列表 / **直接读库** / 每次写入的返回值。期望值全部现算，不硬编码 id 列表。
    const survivors = await memory.listMemoryEntries(session)
    const dbRows = (await rawMemoryRows()).filter((item) => item.sessionId === session)
    const written = outcomes
      .filter((item) => item.written)
      .map((item) => ({
        id: memory.memoryEntryId(session, item.entry.key),
        key: item.entry.key,
        updatedAt: item.entry.updatedAt,
        bytes: item.entry.bytes,
      }))
    assert.equal(written.length, fit + row.over, '每一次写入都应当写成功（单条远小于上限）')

    // 每条字节数 = 用例设定（关闭态：不含向量分量）
    assert.ok(
      survivors.every((entry) => entry.bytes === row.sizeOf),
      '每条都该正好等于用例设定的字节数（口径唯一：memoryEntryBytes）'
    )
    assert.equal(
      survivors.length,
      fit,
      `字节上限下应当只剩 ${fit} 条（条数由字节口径现算：上限 / 条大小，不写死数字）`
    )

    // ① 顺序契约：幸存集合 == 全部写入按 (updatedAt, id) 升序的**最后 N 条**，且顺序就是那个升序。
    //    N 取幸存条数（由字节口径决定），所以换条大小 / 换上限也照样成立。
    const expectedSurvivorKeys = [...written]
      .sort(byContractOrder)
      .slice(-survivors.length)
      .map((item) => item.key)
    assert.deepEqual(
      survivors.map((entry) => entry.key),
      expectedSurvivorKeys,
      '留下的是最新写入的那批（oldest-first：按 (updatedAt,id) 升序取尾部）'
    )
    //    同一个不变量在**库上**再核一遍（不经被测模块的排序：`listMemoryEntries` 自己也会排）
    assert.deepEqual(
      [...dbRows].sort(byContractOrder).map((item) => item.key),
      expectedSurvivorKeys,
      '直接读库的幸存集合与模块列表一致（读回核对，不是信模块自报）'
    )

    // ② 幸存总字节 ≤ 上限；且是「能留的最大一批」：把最老的那条被淘汰项放回来必然超上限。
    //    （后者比「条数对上」更硬：多淘汰一条，这个不等式立刻不成立。）
    const sum = survivors.reduce((total, entry) => total + entry.bytes, 0)
    assert.ok(sum <= limit, `幸存总字节 ${sum} 不该超过上限 ${limit}`)
    const survivorKeySet = new Set(survivors.map((entry) => entry.key))
    const evictedByContract = [...written]
      .sort(byContractOrder)
      .filter((item) => !survivorKeySet.has(item.key))
    assert.ok(evictedByContract.length > 0, '本用例写了「上限/条 + 2」条，必须真的发生淘汰（否则断言的是空转）')
    assert.ok(
      sum + evictedByContract[0].bytes > limit,
      `不许超额淘汰：把最老的被淘汰项（${evictedByContract[0].key}）放回来就该超上限`
    )
    //    边界（闭区间）：条大小整除上限（上面已钉住为前提）→ 剩下的必须**正好填满**上限，
    //    也就是「正好等于上限不淘汰」这条边界：多淘汰一条，这个等式立刻不成立。
    assert.equal(sum, limit, '留下的正好填满上限（边界闭区间，不多淘汰一条）')

    // ③ 有淘汰就有账：条数、提示、日志三样都得在（不许静默丢）
    const totalEvicted = outcomes.reduce((total, item) => total + (item.written ? item.evicted : 0), 0)
    assert.ok(totalEvicted > 0, '必须真的淘汰过（本用例超了 2 条）')
    assert.equal(totalEvicted, row.over, `累计淘汰条数应当是「超出的条数」${row.over}`)
    assert.ok(notices.some((notice) => notice.key === 'memoryEvicted'), '淘汰必须给提示（不许静默丢）')
    assert.ok(memoryRecords().some((entry) => entry.fields['memory.evicted'] >= 1), '淘汰必须留一条诊断日志')

    // ── 边界专测：「正好等于上限」→ 一条都不淘汰 ─────────────────────────────
    // 上面那条 `sum === limit` 是「淘汰后正好填满」；这里直接构造「写进去的正好等于上限」，
    // 钉住的是另一侧：**判据是闭区间**（> 上限才淘汰，== 上限不淘汰）。
    const boundarySession = 'sess-399-bytes-boundary'
    await memory.clearSessionMemory(boundarySession)
    const boundary = collectNotices()
    resetLog()
    const boundaryOutcomes = []
    try {
      for (let i = 0; i < fit; i += 1) {
        boundaryOutcomes.push(
          await memory.saveMemoryEntry(boundarySession, { key: paddedSessKey('b', i), text: body(i) })
        )
      }
    } finally {
      boundary.off()
    }
    const boundaryRows = (await rawMemoryRows()).filter((item) => item.sessionId === boundarySession)
    assert.equal(
      boundaryRows.length,
      fit,
      `正好等于上限（${fit} × ${row.sizeOf} = ${limit} 字节）不该淘汰任何一条`
    )
    assert.equal(
      boundaryRows.reduce((total, item) => total + item.bytes, 0),
      limit,
      '边界用例的库内总字节必须正好等于上限'
    )
    assert.deepEqual(
      boundaryOutcomes.map((item) => (item.written ? item.evicted : -1)),
      Array.from({ length: fit }, () => 0),
      '正好等于上限 → 每次写入的 evicted 都是 0（闭区间：只有 > 上限才淘汰）'
    )
    assert.deepEqual(boundary.notices, [], '没淘汰就不该有淘汰提示')
    assert.deepEqual(
      memoryRecords().filter((entry) => entry.fields['memory.evicted'] !== undefined),
      [],
      '没淘汰就不该留淘汰日志'
    )
  } finally {
    await memory.clearSessionMemory('sess-399-bytes')
    await memory.clearSessionMemory('sess-399-bytes-boundary')
    settings.setEmbeddingEnabled(embeddingWasEnabled)
  }
})

// ──────────────────────────────────────────────────── T5 删除会话联动清理

const DELETE_CASES = [
  { id: 'T5-a', session: 'sess-399-del-a', entries: 3 },
  { id: 'T5-b', session: 'sess-399-del-b', entries: 2 },
  { id: 'T5-c', session: 'sess-399-del-c', entries: 1 },
]

test('T5 删会话：该会话记忆清 0，其它会话一条不少（同一个事务里清）', async () => {
  settings.setEmbeddingEnabled(false)
  for (const row of DELETE_CASES) {
    await db.saveSession(sessionOf(row.session))
    await memory.clearSessionMemory(row.session)
    for (let i = 0; i < row.entries; i += 1) {
      await memory.saveMemoryEntry(row.session, { key: `m-${i}`, text: `${row.session} 的第 ${i} 条` })
    }
  }
  assert.equal(await rawCountOf('sess-399-del-a'), 3)

  // 走真实路径：db.deleteSession()
  await db.deleteSession('sess-399-del-a')

  // ① 直接读库核对：该会话的记录为 0（不靠模块自己报账）
  assert.equal(await rawCountOf('sess-399-del-a'), 0)
  assert.equal((await memory.listMemoryEntries('sess-399-del-a')).length, 0)
  // ② 会话本体也确实删了（记忆联动不是唯一动作）
  assert.equal(await db.loadSession('sess-399-del-a'), undefined)

  // ③ 其它会话一条不少
  for (const row of DELETE_CASES.slice(1)) {
    assert.equal(await rawCountOf(row.session), row.entries, `${row.id} 不该被牵连`)
    assert.equal((await memory.listMemoryEntries(row.session)).length, row.entries)
  }
  // ④ 库里不存在任何「孤儿记忆」（有记忆但没有会话）
  const rows = await rawMemoryRows()
  const orphanIds = []
  for (const row of rows.filter((item) => item.sessionId.startsWith('sess-399-del-'))) {
    if ((await db.loadSession(row.sessionId)) === undefined) {
      orphanIds.push(row.id)
    }
  }
  assert.deepEqual(orphanIds, [])
  for (const row of DELETE_CASES.slice(1)) {
    await db.deleteSession(row.session)
  }
})

// ───────────────────────────────────────── T6 embedding 关闭 / 打开（#398 的接线条目）

const EMBEDDING_CASES = [
  { id: 'T6-a', enabled: false, expectFetch: 0, expectVector: false },
  { id: 'T6-b', enabled: true, expectFetch: 1, expectVector: true },
]

test('T6 关闭态零请求 + 不写向量；打开态走 embeddingGate.embed() 并落向量', async () => {
  useOpenAiChannel()
  for (const row of EMBEDDING_CASES) {
    const session = `sess-399-embed-${row.enabled ? 'on' : 'off'}`
    await memory.clearSessionMemory(session)
    settings.setEmbeddingEnabled(row.enabled)
    resetFetch()
    fetchHandler = embeddingResponse([[0.1, 0.2, 0.3]])

    const outcome = await memory.saveMemoryEntry(session, {
      key: 'chunk-1',
      text: `开关 ${row.enabled ? '开' : '关'} 时写入的一段记忆`,
      model: 'embed-test-model',
    })
    assert.equal(outcome.written, true)
    assert.equal(fetchCalls.length, row.expectFetch, `${row.id}：请求次数不对`)

    const [entry] = await memory.listMemoryEntries(session)
    if (row.expectVector) {
      assert.deepEqual(entry.vec, [0.1, 0.2, 0.3])
      assert.equal(entry.dim, 3)
      assert.equal(entry.model, 'embed-test-model')
      // 请求本身走的是 #397 的 API 层（不另立第二套请求栈）
      assert.match(String(fetchCalls[0].url), /\/embeddings$/u)
    } else {
      assert.equal('vec' in entry, false, '关闭态不许写向量（不是写零向量）')
      assert.equal('dim' in entry, false)
      assert.equal(entry.text, `开关 关 时写入的一段记忆`, '关闭态仍然存文本（召回退到 BM25）')
    }
    // 直接读库再确认一次（模块的返回值不是唯一证据）
    const rows = (await rawMemoryRows()).filter((item) => item.sessionId === session)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].vec === undefined, !row.expectVector)
    await memory.clearSessionMemory(session)
  }
  settings.setEmbeddingEnabled(false)
  resetFetch()
})

// ────────────────────────────────────────── T7 单条超上限：明确拒绝，不许静默丢

const TOO_LARGE_CASES = [
  { id: 'T7-a', label: '正文正好超过字节上限 1 字节' },
]

test('T7 单条超上限：拒绝写入 + 提示 + 日志，库里不留半条', async () => {
  settings.setEmbeddingEnabled(false)
  const limit = MEMORY_LIMITS.maxBytesPerSession
  const session = 'sess-399-toolarge'
  await memory.clearSessionMemory(session)
  const { notices, off } = collectNotices()
  resetLog()
  let outcome
  try {
    outcome = await memory.saveMemoryEntry(session, {
      key: TOO_LARGE_CASES[0].id,
      text: 'y'.repeat(limit + 1),
    })
  } finally {
    off()
  }

  assert.equal(outcome.written, false)
  assert.equal(outcome.reason, 'entry-too-large')
  assert.equal(outcome.limit, limit)
  assert.equal(await rawCountOf(session), 0, '拒绝写入 = 库里确实没有它')
  assert.ok(notices.some((notice) => notice.key === 'memoryEntryTooLarge'), '必须提示')
  assert.ok(
    memoryRecords().some((entry) => entry.fields['memory.limit.bytes'] === limit),
    '必须留日志'
  )
})

// ──────────────────────────────────────────────── T8 DB 迁移不变量（v13 → v14）

/**
 * 迁移起点：**v13**（#399 之前最后一次 schema）。**故意写死**：这是历史事实，不跟着
 * `DB_VERSION` 走 —— 与 `tests/helpers/chat-db.mjs` 的 `LEGACY_DB_VERSION` 同一口径。
 * 断言里同时要求 `DB_VERSION > LEGACY_DB_VERSION`，谁把版本号改小了立刻红。
 */
const LEGACY_DB_VERSION = 13

/** 探测用的**独立**库名：不碰应用的 `chat-demo`，因此不依赖「进程里此刻谁连着 chat-demo」 */
const PROBE_DB = 'chat-demo-migration-probe-399'

/** v13 的 store / 索引清单（冻结的历史 schema，不跟着当前 `upgradeChatDB` 变） */
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
]

/** 旧库整库快照：store → 记录（Blob 折成 {type,text}，才能深比较） */
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

test('T8 DB 迁移不变量：v13 旧库升级后旧 store / 旧数据一条不动，新 store 就位', async () => {
  assert.ok(DB_VERSION > LEGACY_DB_VERSION, 'DB_VERSION 必须大于迁移起点（版本号不许往回改）')
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(PROBE_DB)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })

  // ① 建 v13 旧库 + 写旧数据（含 Blob：字节有没有被升级动过是要断言的东西）
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
  const legacySession = {
    ...sessionOf('sess-legacy-1'),
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: '旧会话的一条消息',
        files: [{ id: 'file-legacy-1', serverId: null, name: 'a.png', size: 3, isImage: true, mimeType: 'image/png' }],
        createdAt: 1_700_000_000_000,
      },
    ],
  }
  await legacy.put('sessions', legacySession)
  await legacy.put('sessionSummaries', {
    id: legacySession.id,
    title: legacySession.title,
    createdAt: legacySession.createdAt,
    updatedAt: legacySession.updatedAt,
    fileIds: ['file-legacy-1'],
  })
  await legacy.put('files', {
    id: 'file-legacy-1',
    blob: new Blob(['PNG'], { type: 'image/png' }),
  })
  await legacy.put('appAssets', {
    key: 'chat-background',
    blob: new Blob(['BG'], { type: 'image/png' }),
    updatedAt: 1_700_000_000_001,
  })
  await legacy.put('attachments', {
    id: 'att-legacy-1',
    name: 'a.txt',
    size: 3,
    sha256: 'a'.repeat(64),
    localPath: 'attachment-' + 'a'.repeat(64),
    parsedTextPath: `${'a'.repeat(64)}:v1`,
    status: 'success',
    characterCount: 3,
    createdAt: 1_700_000_000_002,
  })
  await legacy.put('attachmentTexts', {
    key: `${'a'.repeat(64)}:v1`,
    sha256: 'a'.repeat(64),
    parserVersion: 'v1',
    text: 'abc',
    characterCount: 3,
    status: 'success',
    createdAt: 1_700_000_000_003,
  })
  legacy.close()

  const before = await snapshotProbe()
  assert.equal(before.version, LEGACY_DB_VERSION)
  assert.equal(before.stores.includes('sessionMemory'), false, 'v13 里本来没有记忆存储')

  // ② 用**产品里同一个** upgrade 回调把旧库升到当前版本
  const upgraded = await openDB(PROBE_DB, DB_VERSION, { upgrade: upgradeChatDB })
  upgraded.close()
  const after = await snapshotProbe()

  // ③ 版本与 store 清单：只多了一个 sessionMemory
  assert.equal(after.version, DB_VERSION)
  assert.deepEqual(
    after.stores.filter((name) => !before.stores.includes(name)),
    ['sessionMemory'],
    '升级只许新增 store'
  )
  for (const store of before.stores) {
    assert.ok(after.stores.includes(store), `旧 store ${store} 在升级后不见了`)
  }

  // ④ 索引：旧索引不变，新 store 的索引就是 sessionId
  for (const store of before.stores) {
    assert.deepEqual(after.indexes[store], before.indexes[store], `${store} 的索引被改动`)
  }
  assert.deepEqual(after.indexes.sessionMemory, ['sessionId'])

  // ⑤ 旧数据逐字节相同（含 Blob 的类型与大小），新 store 是空的
  for (const store of before.stores) {
    assert.deepEqual(after.data[store], before.data[store], `${store} 的旧数据被升级改动了`)
  }
  assert.deepEqual(after.data.sessionMemory, [])
})

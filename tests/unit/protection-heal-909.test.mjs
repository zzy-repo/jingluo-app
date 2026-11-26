// [layer: unit | 依赖: fake-indexeddb（纯 Node 内存 IndexedDB）+ 真 Storage Module | 耗时: <3s]
//
// Issue #909（5/5 summaries 自愈）：启动时 `sessionSummaries` 为空而 `sessions` 非空、或两边条数不一致 →
// 按 sessions 原子重建摘要；失败整体回滚；可重入、幂等；只动摘要，不动会话正文。
//
//   [H1] 摘要整表丢失：重建后每条会话都有摘要，且带 fileIds（清孤儿原件靠它判断引用，缺了会误删在用的图）
//   [H2] 摘要数与会话数不一致（缺一条 / 多一条幽灵）：补齐 + 清掉幽灵，会话正文一字不动
//   [H3] 一致时什么都不写（ok），不白白开写事务
//   [H4] 原子性：重建中途失败 → 回滚，摘要保持重建前的样子，返回 failed 且不抛
//   [H5] 可重入：并发两次调用合并成一轮；连跑两次第二次是 ok（幂等）
//   [H6] 空库（新装）：ok，不误报也不写
//
// 负向对照：重建时不用 runAtomic 而是逐条 save（去掉原子性）→ H4 变红；
// 不比较条数、一律重建 → H3 变红。
//
// 为什么独占进程（登记在 UNIT_SOLO）：要真 IndexedDB（顶层装 fake-indexeddb 全局）并占用 `chat/db.ts` 的连接单例。
//
//   node tests/run-layer.mjs unit --case protection-heal-909
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chatCollectorStub, chatStub, installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { installFakeIdbGlobals, installMinimalLocalStorage } from '../helpers/fake-idb.mjs'

installFakeIdbGlobals()
installMinimalLocalStorage()
installEndpointsGlobals()
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatCollectorStub()],
  ],
})
globalThis.__log = { records: [], events: [], actions: [] }

const db = await loadTsModule('src/services/chat/db.ts')
const { getStorage, setStorageForTests } = await loadTsModule('src/services/storage/index.ts')
const { createStorageAccess } = await loadTsModule('src/services/protection/storageAccess.ts')
const { createHeal } = await loadTsModule('src/services/protection/heal.ts')
const { resetProtectionDiagnosticsForTests } = await loadTsModule('src/services/protection/diagnostics.ts')

const sessionOf = (id, files = []) => ({
  id,
  title: `会话 ${id}`,
  createdAt: 1,
  updatedAt: 2,
  messages: [{ id: `${id}-u`, role: 'user', content: `正文 ${id}`, files, createdAt: 1 }],
})
const fileRef = (id) => ({ id, serverId: null, name: `${id}.png`, size: 3, isImage: true, mimeType: 'image/png' })

const raw = async (store) => (await db.getChatDB()).getAll(store)
const rawClear = async (store) => (await db.getChatDB()).clear(store)
const rawPutSummary = async (summary) => (await db.getChatDB()).put('sessionSummaries', summary)
const rawDeleteSummary = async (id) => (await db.getChatDB()).delete('sessionSummaries', id)

const heal = () => {
  const storage = createStorageAccess()
  return createHeal({ fs: undefined, storage, now: () => 0, local: undefined })
}

const reset = async (sessions) => {
  setStorageForTests(null)
  resetProtectionDiagnosticsForTests()
  globalThis.__log.records.length = 0
  await rawClear('sessions')
  await rawClear('sessionSummaries')
  const storage = await getStorage()
  for (const session of sessions) {
    await storage.sessions.save(session)
  }
}

test('H1 摘要整表丢失：重建后每条都有摘要，带 fileIds，正文不动', async () => {
  await reset([sessionOf('a', [fileRef('f1')]), sessionOf('b'), sessionOf('c', [fileRef('f2'), fileRef('f3')])])
  const sessionsBefore = JSON.stringify(await raw('sessions'))
  await rawClear('sessionSummaries')
  const result = await heal().heal()
  assert.deepEqual(result, { status: 'healed', before: 0, after: 3 })
  const summaries = await raw('sessionSummaries')
  assert.deepEqual(summaries.map((summary) => summary.id), ['a', 'b', 'c'])
  assert.deepEqual(summaries.find((summary) => summary.id === 'c').fileIds.sort(), ['f2', 'f3'])
  assert.equal(JSON.stringify(await raw('sessions')), sessionsBefore, '会话正文一字不动')
})

test('H2 摘要缺一条 / 多一条幽灵：补齐并清掉幽灵', async () => {
  await reset([sessionOf('a'), sessionOf('b'), sessionOf('c')])
  await rawDeleteSummary('b')
  await rawPutSummary({ id: 'ghost', title: '幽灵', createdAt: 1, updatedAt: 1, fileIds: [] })
  await rawPutSummary({ id: 'ghost2', title: '幽灵2', createdAt: 1, updatedAt: 1, fileIds: [] })
  const result = await heal().heal()
  assert.deepEqual(result, { status: 'healed', before: 4, after: 3 })
  assert.deepEqual((await raw('sessionSummaries')).map((summary) => summary.id), ['a', 'b', 'c'])
  assert.equal((await raw('sessions')).length, 3)
})

test('H3 一致时不写：ok，且没有开写事务', async () => {
  await reset([sessionOf('a'), sessionOf('b')])
  let writes = 0
  const real = await getStorage()
  setStorageForTests({
    ...real,
    runAtomic: (...args) => {
      writes += 1
      return real.runAtomic(...args)
    },
  })
  assert.deepEqual(await heal().heal(), { status: 'ok', summaries: 2 })
  assert.equal(writes, 0)
})

test('H4 中途失败整体回滚：摘要保持原样，返回 failed，不抛，记一条诊断', async () => {
  await reset([sessionOf('a'), sessionOf('b'), sessionOf('c')])
  await rawClear('sessionSummaries')
  await rawPutSummary({ id: 'a', title: '旧摘要', createdAt: 1, updatedAt: 1, fileIds: [] })
  const before = JSON.stringify(await raw('sessionSummaries'))
  const real = await getStorage()
  setStorageForTests({
    ...real,
    runAtomic: (work, options) =>
      real.runAtomic((repos) => {
        let saves = 0
        return work({
          ...repos,
          sessions: {
            ...repos.sessions,
            save: async (...args) => {
              saves += 1
              if (saves === 2) {
                throw new Error('injected rebuild failure')
              }
              return repos.sessions.save(...args)
            },
          },
        })
      }, options),
  })
  const result = await heal().heal()
  assert.equal(result.status, 'failed')
  assert.equal(JSON.stringify(await raw('sessionSummaries')), before, '回滚：连第一条已经重建的也不能留下')
  assert.equal((await raw('sessions')).length, 3)
  assert.ok(globalThis.__log.records.some((entry) => entry.message === 'protection.heal-summaries failed'))
  // 故障排除后同一个库可以再自愈
  setStorageForTests(null)
  assert.equal((await heal().heal()).status, 'healed')
  assert.equal((await raw('sessionSummaries')).length, 3)
})

test('H5 可重入：并发合并成一轮；连跑第二次是 ok', async () => {
  await reset([sessionOf('a'), sessionOf('b')])
  await rawClear('sessionSummaries')
  let runs = 0
  const real = await getStorage()
  setStorageForTests({
    ...real,
    runAtomic: (...args) => {
      runs += 1
      return real.runAtomic(...args)
    },
  })
  const one = heal()
  const [first, second] = await Promise.all([one.heal(), one.heal()])
  assert.deepEqual(first, second, '并发调用拿到同一个结果')
  assert.equal(first.status, 'healed')
  assert.equal(runs, 1, '只重建了一次')
  assert.deepEqual(await one.heal(), { status: 'ok', summaries: 2 }, '幂等')
})

test('H6 空库（新装）：ok，不写', async () => {
  await reset([])
  assert.deepEqual(await heal().heal(), { status: 'ok', summaries: 0 })
})

test('H7 IndexedDB 不可用：skipped，不抛', async () => {
  const result = await createHeal({
    fs: undefined,
    storage: { ...createStorageAccess(), available: () => false },
    now: () => 0,
    local: undefined,
  }).heal()
  assert.deepEqual(result, { status: 'skipped' })
})

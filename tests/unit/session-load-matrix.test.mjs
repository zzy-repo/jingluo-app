// [layer: integration(L1 口径) | 依赖: 无（纯 Node；存储层打桩，零浏览器） | 耗时: <2s]
//
// #362 / #367 · 域 4 最小充分集 · N4-B「会话加载三态 + 缓存」（L1，一张表 12 行）
//
// 为什么单列：这里需要 never-resolve / 按 id 抛错的假 db 语义（在飞、并发合并、超时兜底），
// 与 N4-A 的同步状态断言不同构；合成一个 test 等于把两条用例写进一个函数，并不省执行成本。
// 为什么不能上浮 L2：L2 注入不了「存储读一半失败」「首屏无限转圈」这些终态（#45 / #133 的线上形态）。
//
// 被测对象是真 `src/services/chat/store.ts` 的加载链路（ensureSessionLoaded / trimSessionCache /
// initChat / normalizeSession 报告）。存储层用可注入时序与失败的替身。
//
// 覆盖功能点：
//   F4-02 切换会话：按需加载、同 id 并发合并、旧响应不把界面切回、加载中就是转圈态
//   F4-06 长会话加载与缓存：SESSION_CACHE_LIMIT=5 的 LRU 淘汰、超时/失败终态不再是无限转圈
//   F4-09 损坏会话隔离：单条会话损坏只标该会话（sessionLoadErrors），列表与其他会话照常
//
// 跑法：
//   node tests/run-layer.mjs unit --only session-load-matrix
//   node --test tests/unit/session-load-matrix.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fixtureUrl, installTsResolve, setupDom } from '../helpers/dom-env.mjs'

import { chatBaseUrl, legacyHosts } from '../../scripts/lib/endpoints.mjs'

// 装配（`.js→.ts` + 原生桥/诊断/存储替身）走 tests/helpers/dom-env.mjs 的公共入口（#366 第二批）：
// 这段以前是本文件里手抄的 ~28 行 registerHooks 样板，30 多个 L0 文件各有一份。
// 存储层替身按**父模块**区分（只有 chat/store.ts 的 `./db.js` 换成内存库），所以走 onResolve。
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, fixtureUrl('domain03-04/capacitor.mjs')],
    [/diagnostics\/collector\.js$/, fixtureUrl('domain03-04/collector.mjs')],
  ],
  onResolve: (specifier, context) => (
    specifier === './db.js' && String(context.parentURL ?? '').endsWith('/chat/store.ts')
      ? fixtureUrl('domain03-04/session-db.mjs')
      : undefined
  ),
})

globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  inviteBaseUrl: 'https://invite.test.invalid',
  feedbackUrl: 'https://feedback.test.invalid',
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([]),
})
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false
globalThis.__log = { records: [], events: [], actions: [] }

// 浏览器全局替身（localStorage / document / window / rAF）走公共入口（#366 第二批）
setupDom()
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: { message: 'not used in this case' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })

const freshDb = (overrides = {}) => {
  globalThis.__db = {
    calls: [],
    errors: [],
    loadSessionSummaries: async () => [],
    loadSession: async () => undefined,
    saveSession: async () => {},
    pinSession: async () => {},
    renameSession: async () => {},
    deleteSession: async () => {},
    ...overrides,
  }
  return globalThis.__db
}
freshDb()

const chat = await import('../../src/services/chat/store.ts')

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const summaryOf = (id, extra = {}) => ({
  id,
  title: `标题-${id}`,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...extra,
})
const sessionOf = (id, extra = {}) => ({
  id,
  title: `标题-${id}`,
  createdAt: 1_000,
  updatedAt: 1_000,
  messages: [],
  rootMessageId: null,
  ...extra,
})
const callsOf = (name) => globalThis.__db.calls.filter((entry) => entry.name === name)
const cacheIds = () => Object.keys(chat.useChatStore.getState().sessionCache)

const reset = ({ sessions = [], loadSession, summaries } = {}) => {
  freshDb({ loadSession, ...(summaries ? { loadSessionSummaries: summaries } : {}) })
  chat.useChatStore.setState({
    ready: false,
    initError: false,
    importingHistory: false,
    sessions,
    sessionCache: {},
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId: null,
    streaming: {},
    importSkipped: [],
    waitHints: {},
  })
}

test('N4-B 会话加载三态 + 缓存矩阵（表驱动 12 行）', async (t) => {
  await t.test('[1] F4-02 打开会话：activeId 切换 + 详情进缓存', async () => {
    reset({ sessions: [summaryOf('a')], loadSession: async (id) => sessionOf(id) })
    chat.selectSession('a')
    await settle()
    assert.equal(chat.useChatStore.getState().activeId, 'a')
    assert.deepEqual(cacheIds(), ['a'], '打开后才按需加载详情（列表只带摘要）')
    assert.notEqual(chat.useChatStore.getState().sessionLoadErrors.a, true, '成功后不留加载失败标记')
  })

  await t.test('[2] F4-02 同 id 并发读取合并：只打一次存储', async () => {
    reset({ sessions: [summaryOf('a')], loadSession: async (id) => sessionOf(id) })
    chat.selectSession('a')
    chat.selectSession('a')
    chat.selectSession('a')
    await settle()
    assert.equal(callsOf('loadSession').length, 1, '重复点同一个会话不该重复读（#45 的「切太快」）')
    assert.deepEqual(cacheIds(), ['a'])
  })

  await t.test('[3] F4-02 加载中切走：旧响应不把界面切回', async () => {
    let releaseA
    const aLoaded = new Promise((resolve) => {
      releaseA = resolve
    })
    reset({
      sessions: [summaryOf('a'), summaryOf('b')],
      loadSession: async (id) => {
        if (id === 'a') {
          await aLoaded
        }
        return sessionOf(id)
      },
    })
    chat.selectSession('a')
    chat.selectSession('b')
    await settle()
    releaseA()
    await settle()
    assert.equal(chat.useChatStore.getState().activeId, 'b', '慢的旧请求回来不许把界面拽回 a')
    assert.deepEqual(cacheIds().sort(), ['a', 'b'], '两条都进缓存，但当前会话仍是 b')
  })

  await t.test('[4] F4-02 转圈态：详情未到时 activeId 已切、无失败标记（不是白屏）', async () => {
    reset({ sessions: [summaryOf('never')], loadSession: () => new Promise(() => {}) })
    chat.selectSession('never')
    await settle()
    const state = chat.useChatStore.getState()
    assert.equal(state.activeId, 'never')
    assert.equal(Object.hasOwn(state.sessionCache, 'never'), false)
    assert.equal(state.sessionLoadErrors.never, false, '加载中要显式 false（界面据此显示「加载中」而不是「加载失败」）')
  })

  await t.test('[5] F4-06 超时兜底：读失败要落到「加载失败」终态，不能永远转圈', async () => {
    reset({
      sessions: [summaryOf('failed')],
      loadSession: async () => {
        throw new Error('load timeout (#133)')
      },
    })
    chat.selectSession('failed')
    await settle()
    assert.equal(chat.useChatStore.getState().sessionLoadErrors.failed, true, '#133：弱网下必须给出终态')
    assert.equal(globalThis.__db.errors.at(-1).action, 'read session', '失败要上报，否则无从定位')
    assert.equal(callsOf('saveSession').length, 0, '读失败不许回写空会话（会把数据抹掉）')
  })

  await t.test('[6] F4-09 读取期损坏：messages=null 修成 [] 并报 damage，会话仍可用', async () => {
    reset({
      sessions: [summaryOf('broken')],
      loadSession: async (id) => sessionOf(id, { messages: null, rootMessageId: undefined }),
    })
    chat.selectSession('broken')
    await settle()
    const session = chat.useChatStore.getState().sessionCache.broken
    assert.ok(session, '坏会话也要能打开（一条坏数据不许让整页白屏）')
    assert.deepEqual(session.messages, [], 'messages=null 必须修成 []')
    assert.equal(session.rootMessageId, null, '根指针要补成 null 而不是 undefined')
    const damage = globalThis.__log.records.find((entry) => entry.message === 'session data repaired')
    assert.equal(damage?.fields.stage, 'session.normalize', '修复要留痕，且 stage 与「加载失败」区分开')
    assert.equal(callsOf('saveSession').length, 1, '修好的会话要回写，否则每次打开都再修一遍')
  })

  await t.test('[7] F4-09 会话级隔离：a 读失败不影响 b，也不动列表', async () => {
    reset({
      sessions: [summaryOf('a'), summaryOf('b')],
      loadSession: async (id) => {
        if (id === 'a') {
          throw new Error('a is broken')
        }
        return sessionOf(id)
      },
    })
    chat.selectSession('a')
    await settle()
    chat.selectSession('b')
    await settle()
    const state = chat.useChatStore.getState()
    assert.equal(state.sessionLoadErrors.a, true)
    assert.deepEqual(cacheIds(), ['b'], 'b 正常加载')
    assert.deepEqual(state.sessions.map((session) => session.id), ['a', 'b'], '坏会话不许从列表里静默消失')
  })

  await t.test('[8] F4-09 存储里没有这条会话：标该会话失败，不造空壳', async () => {
    reset({ sessions: [summaryOf('ghost')], loadSession: async () => undefined })
    chat.selectSession('ghost')
    await settle()
    assert.equal(chat.useChatStore.getState().sessionLoadErrors.ghost, true)
    assert.equal(Object.hasOwn(chat.useChatStore.getState().sessionCache, 'ghost'), false)
  })

  await t.test('[9] F4-06 LRU：最多缓存 5 条，最久未访问的先卸载', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    reset({ sessions: ids.map((id) => summaryOf(id)), loadSession: async (id) => sessionOf(id) })
    for (const id of ids) {
      chat.selectSession(id)
      await settle(5)
    }
    assert.equal(cacheIds().length, 5, 'SESSION_CACHE_LIMIT = 5')
    assert.equal(cacheIds().includes('a'), false, '最久没打开的 a 先被卸载')
    assert.equal(cacheIds().includes('f'), true, '刚打开的 f 必须还在（否则又回到「一点就转圈」）')
  })

  await t.test('[10] F4-06 当前会话不被淘汰：访问序最旧也留下', async () => {
    reset({
      sessions: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => summaryOf(id)),
      loadSession: async (id) => sessionOf(id),
    })
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      chat.selectSession(id)
      await settle(5)
    }
    chat.selectSession('a')
    await settle()
    chat.selectSession('f')
    await settle()
    const state = chat.useChatStore.getState()
    assert.equal(state.activeId, 'f')
    assert.equal(cacheIds().length, 5)
    assert.equal(cacheIds().includes('b'), false, '淘汰按访问序（b 最旧）')
    assert.equal(cacheIds().includes('e'), true, '较新的 e 留下')
  })

  await t.test('[11] F4-09 列表加载失败：initError 可见、ready 不假绿、失败被上报', async () => {
    reset({
      summaries: async () => {
        throw new Error('indexedDB unavailable')
      },
    })
    await chat.initChat()
    const state = chat.useChatStore.getState()
    assert.equal(state.initError, true, '界面要能显示「对话列表加载失败，请重试」')
    assert.equal(state.ready, false, '失败不能把 ready 置真（否则空列表看起来像「没有对话」）')
    assert.equal(globalThis.__db.errors.at(-1).action, 'read local sessions')
  })

  await t.test('[12] F4-09 列表加载成功：ready + 置顶/更新时间排序', async () => {
    reset({
      summaries: async () => [
        summaryOf('old', { updatedAt: 10 }),
        summaryOf('pinned', { updatedAt: 1, pinnedAt: 99 }),
        summaryOf('new', { updatedAt: 90 }),
      ],
    })
    await chat.initChat()
    const state = chat.useChatStore.getState()
    assert.equal(state.ready, true)
    assert.equal(state.initError, false)
    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ['pinned', 'new', 'old'],
      '列表顺序与界面一致：置顶优先，其余按 updatedAt 倒序'
    )
  })
})

// [layer: integration(L1 口径) | 依赖: 无（纯 Node；存储层打桩，零浏览器） | 耗时: <2s]
//
// #362 / #367 · 域 4 最小充分集 · N4-A「会话增删改 + 持久化」（L1，一张表 15 行）
//
// 为什么不能升到 L2：L2 注入不了「落盘失败」「流式中删除」这两种状态，而它们正是白屏与资损的来源；
// 为什么不能并进 N4-B：N4-B 需要 never-resolve / 按 id 抛错的读取语义，与这里的同步状态断言不同构。
//
// 被测对象是真 `src/services/chat/store.ts`（排序 / 置顶 / 重命名 / 删除 / 新建），只把
// `chat/db.ts` 换成可注入失败的替身（tests/fixtures/domain03-04/session-db.mjs）。
//
// 覆盖功能点：
//   F4-01 新建会话：newChat 回空态、旧会话不丢；首次发送才建会话并落盘
//   F4-03 会话置顶 / 取消置顶与排序：写 pinnedAt 并落盘、置顶优先再按 updatedAt 倒序、再点取消
//   F4-04 重命名会话：标题写回摘要并落盘、落盘失败可见（sessionSaveErrors）
//   F4-05 删除会话：删当前会话回空态、流式中先中止再删、清理草稿、失败保留会话并上报
//
// 跑法：
//   node tests/run-layer.mjs unit --only session-crud-matrix
//   node --test tests/unit/session-crud-matrix.test.mjs
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

// store.ts 在模块级用到 document / window（持久化钩子）与 requestAnimationFrame（流式增量）：
// 浏览器全局替身也走公共入口（#366 第二批），一个文件一份手抄最容易和别处跑偏。
setupDom()

/** 存储层默认全成功；每行按需覆盖 */
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

// 上游一律不参与：本用例只跑本地状态机
globalThis.fetch = async () =>
  new Response(JSON.stringify({ error: { message: 'not used in this case' } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })

const chat = await import('../../src/services/chat/store.ts')
const drafts = await import('../../src/services/chat/drafts.ts')

const callsOf = (name) => globalThis.__db.calls.filter((entry) => entry.name === name)
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

/** 每行起点：干净的 store 状态 + 干净的存储替身 */
const reset = ({ sessions = [], cache = {}, activeId = null, streaming = {} } = {}, dbOverrides = {}) => {
  freshDb(dbOverrides)
  chat.useChatStore.setState({
    ready: true,
    initError: false,
    importingHistory: false,
    sessions,
    sessionCache: cache,
    sessionLoadErrors: {},
    sessionSaveErrors: {},
    activeId,
    streaming,
    importSkipped: [],
    waitHints: {},
  })
  drafts.clearAllDrafts()
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('N4-A 会话增删改 + 持久化矩阵（表驱动 15 行）', async (t) => {
  // ---------------- F4-03 置顶 / 取消置顶 / 排序 ----------------
  await t.test('[1] F4-03 置顶：写 pinnedAt 并落盘（同一个时间戳）', async () => {
    reset({ sessions: [summaryOf('a', { updatedAt: 5 })] })
    chat.pinSession('a')
    const [summary] = chat.useChatStore.getState().sessions
    assert.equal(typeof summary.pinnedAt, 'number', '置顶必须写 pinnedAt（不是布尔）')
    const [call] = callsOf('pinSession')
    assert.deepEqual(call.args, ['a', summary.pinnedAt], '落盘的 pinnedAt 必须与界面一致')
  })

  await t.test('[2] F4-03 取消置顶：pinnedAt 被移除（不是置 0）', async () => {
    reset({ sessions: [summaryOf('a', { pinnedAt: 42 })] })
    chat.pinSession('a')
    const [summary] = chat.useChatStore.getState().sessions
    assert.equal(summary.pinnedAt, undefined, '取消置顶要回到 undefined，0 会被当成「置顶于 1970」')
    assert.deepEqual(callsOf('pinSession')[0].args, ['a', undefined])
  })

  await t.test('[3] F4-03 排序：置顶优先，其余按 updatedAt 倒序', async () => {
    reset({
      sessions: [
        summaryOf('old-pinned', { pinnedAt: 10, updatedAt: 2 }),
        summaryOf('newest', { updatedAt: 90 }),
        summaryOf('middle', { updatedAt: 50 }),
        summaryOf('new-pinned', { pinnedAt: 20, updatedAt: 1 }),
      ],
    })
    chat.pinSession('middle')
    const order = chat.useChatStore.getState().sessions.map((session) => session.id)
    assert.deepEqual(order, ['middle', 'new-pinned', 'old-pinned', 'newest'], '置顶按 pinnedAt 倒序，未置顶按 updatedAt 倒序')
  })

  await t.test('[4] F4-03 置顶不是万能的：未知 id / 导入中 / 删除中都不动列表', async () => {
    reset({ sessions: [summaryOf('a')] })
    chat.pinSession('nope')
    assert.equal(callsOf('pinSession').length, 0, '未知 id 不该写盘')
    chat.useChatStore.setState({ importingHistory: true })
    chat.pinSession('a')
    assert.equal(callsOf('pinSession').length, 0, '导入期间禁止改列表')
    assert.equal(chat.useChatStore.getState().sessions[0].pinnedAt, undefined)
  })

  // ---------------- F4-04 重命名 ----------------
  await t.test('[5] F4-04 重命名（已缓存）：标题写回会话与摘要，并落盘', async () => {
    reset({ sessions: [summaryOf('a')], cache: { a: sessionOf('a') } })
    chat.renameSession('a', '用户手动改的名字')
    assert.equal(chat.useChatStore.getState().sessionCache.a.title, '用户手动改的名字')
    assert.equal(chat.useChatStore.getState().sessions[0].title, '用户手动改的名字', '列表摘要也要跟着改')
    const [saved] = callsOf('saveSession')
    assert.equal(saved.args[0].title, '用户手动改的名字', '改名要落盘，否则刷新就丢')
  })

  await t.test('[6] F4-04 重命名（未加载详情）：只改摘要并调用 db.renameSession', async () => {
    reset({ sessions: [summaryOf('a')] })
    chat.renameSession('a', '未加载也能改')
    assert.equal(chat.useChatStore.getState().sessions[0].title, '未加载也能改')
    assert.deepEqual(callsOf('renameSession')[0].args, ['a', '未加载也能改'], '详情不在内存时要直接改库')
    assert.equal(callsOf('saveSession').length, 0, '没有详情就不该整条回写')
  })

  await t.test('[7] F4-04 落盘失败：会话仍在，但标记 sessionSaveErrors（界面给「保存失败 + 重试」）', async () => {
    reset(
      { sessions: [summaryOf('a')], cache: { a: sessionOf('a') } },
      {
        saveSession: async () => {
          throw new Error('QuotaExceededError')
        },
      }
    )
    chat.renameSession('a', '改了但存不下')
    await settle()
    assert.equal(chat.useChatStore.getState().sessionCache.a.title, '改了但存不下', '内存里先生效')
    assert.equal(chat.useChatStore.getState().sessionSaveErrors.a, true, '失败必须可见，不能静默丢数据')
    assert.equal(globalThis.__db.errors.at(-1).action, 'save session')
  })

  // ---------------- F4-01 新建 ----------------
  await t.test('[8] F4-01 新建会话：回空态，旧会话一条不丢', async () => {
    reset({ sessions: [summaryOf('a'), summaryOf('b')], activeId: 'b' })
    chat.newChat()
    const state = chat.useChatStore.getState()
    assert.equal(state.activeId, null, '新建后是欢迎页，不能停在旧会话上')
    assert.deepEqual(state.sessions.map((session) => session.id), ['a', 'b'], '旧会话必须还在列表里')
  })

  await t.test('[9] F4-01 首次发送才建会话并落盘', async () => {
    reset({ sessions: [summaryOf('old')] })
    drafts.setDraftText(null, '第一条消息')
    assert.equal(chat.sendMessage(null), true)
    const state = chat.useChatStore.getState()
    const created = state.sessions[0]
    assert.equal(state.sessions.length, 2, '新会话进列表，旧会话不受影响')
    assert.equal(state.activeId, created.id, '新会话立刻成为当前会话')
    assert.equal(state.sessionCache[created.id].messages.at(-1).role, 'assistant', '占位回复已挂上')
    const [saved] = callsOf('saveSession')
    assert.equal(saved.args[0].id, created.id, '新会话要落盘')
    chat.stopReply(created.id)
    await settle()
  })

  // ---------------- F4-05 删除 ----------------
  await t.test('[10] F4-05 删当前会话：回空态、清缓存与草稿', async () => {
    reset({ sessions: [summaryOf('a'), summaryOf('b')], cache: { a: sessionOf('a') }, activeId: 'a' })
    drafts.setDraftText('a', '没发出去的草稿')
    assert.equal(await chat.removeSession('a'), true)
    const state = chat.useChatStore.getState()
    assert.deepEqual(state.sessions.map((session) => session.id), ['b'], '列表里必须消失')
    assert.equal(Object.hasOwn(state.sessionCache, 'a'), false, '缓存里的详情也要清掉')
    assert.equal(state.activeId, null, '删的是当前会话 → 回空态，不能停在已删会话上')
    assert.equal(drafts.getDraft('a').text, '', '仅被它引用的草稿要一起清')
    assert.deepEqual(callsOf('deleteSession')[0].args, ['a'])
  })

  await t.test('[11] F4-05 删非当前会话：当前会话不被带跑', async () => {
    reset({ sessions: [summaryOf('a'), summaryOf('b')], cache: { b: sessionOf('b') }, activeId: 'b' })
    assert.equal(await chat.removeSession('a'), true)
    assert.equal(chat.useChatStore.getState().activeId, 'b')
    assert.equal(Object.hasOwn(chat.useChatStore.getState().sessionCache, 'b'), true)
  })

  await t.test('[12] F4-05 流式中删除：先中止流，删完不被收尾写回', async () => {
    const controller = new AbortController()
    reset({
      sessions: [summaryOf('a')],
      cache: { a: sessionOf('a') },
      activeId: 'a',
      streaming: { a: controller },
    })
    const task = chat.removeSession('a')
    await settle()
    assert.equal(controller.signal.aborted, true, '删除前必须 abort 流，否则收尾会把会话写回来')
    // 模拟流真的收尾：从 streaming 里摘掉，waitForIdle 才会放行
    chat.useChatStore.setState((state) => {
      const { a: _removed, ...rest } = state.streaming
      return { streaming: rest }
    })
    assert.equal(await task, true)
    await settle()
    const savesAfterDelete = globalThis.__db.calls
      .slice(globalThis.__db.calls.findIndex((entry) => entry.name === 'deleteSession'))
      .filter((entry) => entry.name === 'saveSession')
    assert.equal(savesAfterDelete.length, 0, '删除之后不许再有保存（否则「删完又回来」）')
  })

  await t.test('[13] F4-05 删除失败：会话保留 + 上报错误 + 把停止后的状态存回去', async () => {
    reset(
      { sessions: [summaryOf('a')], cache: { a: sessionOf('a') }, activeId: 'a' },
      {
        deleteSession: async () => {
          throw new Error('TransactionInactiveError')
        },
      }
    )
    assert.equal(await chat.removeSession('a'), false, '失败要明确返回 false（界面据此弹 toast）')
    const state = chat.useChatStore.getState()
    assert.deepEqual(state.sessions.map((session) => session.id), ['a'], '删不掉就不能从列表里消失')
    assert.equal(state.activeId, 'a')
    assert.equal(globalThis.__db.errors.at(-1).action, 'delete session', '失败必须上报，否则白屏无从定位')
    assert.equal(callsOf('saveSession').length, 1, '失败后要保存「已停止」的最新状态')
  })

  await t.test('[14] F4-05 并发删同一个会话：只打一次存储，第二次直接拒', async () => {
    reset({ sessions: [summaryOf('a')], cache: { a: sessionOf('a') } })
    const first = chat.removeSession('a')
    const second = await chat.removeSession('a')
    assert.equal(second, false, '删除中重复点击不该再打一次库')
    assert.equal(await first, true)
    assert.equal(callsOf('deleteSession').length, 1)
  })

  await t.test('[15] F4-05/F4-03 导入历史期间：改名 / 置顶 / 删除全部冻结', async () => {
    reset({ sessions: [summaryOf('a')], cache: { a: sessionOf('a') }, activeId: 'a' })
    chat.useChatStore.setState({ importingHistory: true })
    chat.renameSession('a', '导入中改名')
    chat.pinSession('a')
    assert.equal(await chat.removeSession('a'), false)
    const state = chat.useChatStore.getState()
    assert.equal(state.sessions[0].title, '标题-a', '导入期间不许改名')
    assert.equal(state.sessions[0].pinnedAt, undefined, '导入期间不许置顶')
    assert.equal(state.sessions.length, 1, '导入期间不许删除')
    assert.equal(callsOf('deleteSession').length, 0)
  })
})

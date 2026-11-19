// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #328：首字等待的**阶段化**提示（阶段名 + 已等待 Ns）。
//
//   node tests/unit/chat-wait-stage.test.mjs
//
// 覆盖：
//   [1] 阶段枚举与文案 key：六个阶段都有 zh/en 文案，中英不同，秒数只由 {seconds} 注入
//   [2] 分档不另起一套：waitDeadlines 就是 startedAt + STREAM_NOTICE_TIERS（5s / 30s / 60s）
//   [3] composeWaitNotice：5s 之前不打扰、三档升级、60s 给出口、阶段未知时回落到分档文案
//   [4] 重试：立刻可见（不等 5s），key 与 {attempt,limit} 契约不变
//   [5] waitTierLine：30s 只给「等上游」阶段，60s 全阶段
//   [6] needsUpload：有附件没上到服务端才是「正在上传附件」
//   [7] 真实 store + 假时钟：waitHints[sid].stage 流转（connecting → awaitingFirstToken → thinking → 撤下），
//       5s/30s/60s 在同一 startedAt 上升级，跨阶段不重置
//   [8] 修 G4：AssistantMessage 的 waiting 不再被 message.thinking 吞掉（专家模式三档提示复活）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installChatEnv } from '../helpers/dom-env.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// 真实 store + 假时钟：阶段流转与三档升级
// ---------------------------------------------------------------------------

// 装配走公共入口（#366 第二批 / #408）：原生桥 + 诊断写入口 + 「只有 chat/store.ts 的 ./db.js 才是假库」这条按父模块的规则，
// 都收在 installChatEnv 里。以前这段是本文件手抄的 41 行样板，chat 一族 5 个文件各一份。
const { stub } = installChatEnv()

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__INTERNAL_BUILD__ ??= true
globalThis.__log = { records: [], events: [], actions: [] }

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => {
    memory.set(key, String(value))
  },
  removeItem: (key) => {
    memory.delete(key)
  },
}

const realSetImmediate = globalThis.setImmediate
const realClearImmediate = globalThis.clearImmediate
/** 假时钟下也要能推进「画帧」：用真 setImmediate，避免和 mock 的 setTimeout 纠缠 */
globalThis.requestAnimationFrame = (cb) => realSetImmediate(cb)
globalThis.cancelAnimationFrame = (id) => realClearImmediate(id)
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const { setRequestTimeout, setStreamIdleTimeout } =
  await import('../../src/services/api/client.ts')
const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { useChatStore, initChat, sendMessage } = await import('../../src/services/chat/store.ts')

const encoder = new TextEncoder()
const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`

/** 只有本轮的流式回答算数：自动标题也是流请求，按输出预算区分（同 chat-retry-retryable） */
const isStreamRequest = (init) => {
  try {
    const body = JSON.parse(init?.body ?? '{}')
    if (typeof body.max_tokens === 'number' && body.max_tokens <= 64) {
      return false
    }
    return body.stream === true
  } catch {
    return false
  }
}

/** 让出微任务 + 真 macrotask，让 tick 触发的 Promise 链继续跑 */
const flush = async (times = 12) => {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => realSetImmediate(resolve))
  }
}

let fetchCalls = 0
let releaseHeaders = null
let bodyController = null
globalThis.fetch = async (_url, init) => {
  if (!isStreamRequest(init)) {
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  fetchCalls += 1
  // 响应头什么时候到由用例决定：用来把「正在连接上游」这段停住
  await new Promise((resolve) => {
    releaseHeaders = resolve
  })
  return new Response(
    new ReadableStream({
      start(controller) {
        bodyController = controller
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )
}

const {
  WAIT_STAGE_KEYS,
  composeWaitNotice,
  needsUpload,
  waitDeadlines,
  waitSeconds,
  waitTierLine,
} = await import('../../src/services/chat/waitStage.ts')
const { STREAM_NOTICE_TIERS, streamNoticeTier } =
  await import('../../src/services/chat/streamNotice.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const STAGES = ['preparing', 'uploading', 'connecting', 'awaitingFirstToken', 'thinking', 'retrying']

test('阶段枚举：六个阶段都有中英文案，秒数不写死', () => {
  assert.deepEqual(Object.keys(WAIT_STAGE_KEYS).sort(), [...STAGES].sort(), '阶段枚举不能缺项')
  for (const stage of STAGES) {
    const key = WAIT_STAGE_KEYS[stage]
    assert.equal(typeof zh[key], 'string', `${stage} 有中文文案（${key}）`)
    assert.equal(typeof en[key], 'string', `${stage} 有英文文案（${key}）`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了，不是同一串`)
  }
  // 重试沿用 #105 的 key 与占位符契约，不新造一套
  assert.equal(WAIT_STAGE_KEYS.retrying, 'chatRetrying')
  assert.match(zh.waitElapsed, /\{seconds\}/, '中文秒数只由占位符注入')
  assert.match(en.waitElapsed, /\{seconds\}/, '英文秒数只由占位符注入')
  for (const key of ['waitStagePreparing', 'waitStageUploading', 'waitStageConnecting']) {
    assert.doesNotMatch(zh[key], /\d+\s*s/i, `${key} 不许把秒数写进文案`)
  }
})

test('分档复用：waitDeadlines 就是 startedAt + 既有三档', () => {
  const startedAt = 1_700_000_000_000
  assert.deepEqual(
    waitDeadlines(startedAt),
    [5_000, 30_000, 60_000].map((ms) => startedAt + ms),
    '阈值必须来自 STREAM_NOTICE_TIERS，不能另起一套'
  )
  assert.deepEqual(
    waitDeadlines(startedAt).map((at) => at - startedAt),
    STREAM_NOTICE_TIERS.map((tier) => tier.afterMs)
  )
  assert.equal(waitSeconds(startedAt, startedAt), 0)
  assert.equal(waitSeconds(startedAt, startedAt + 6_400), 6, '秒数向下取整')
  assert.equal(waitSeconds(startedAt, startedAt - 1_000), 0, '时钟回拨不出现负数')
})

test('composeWaitNotice：5s 之前不打扰，三档升级，60s 才给出口', () => {
  const startedAt = 0
  const at = (ms, stage = 'awaitingFirstToken') =>
    composeWaitNotice({ stage, startedAt, now: ms })

  assert.equal(at(0), null, '刚发出请求不提示')
  assert.equal(at(4_999), null, '4.9s 仍不提示')

  const first = at(5_000)
  assert.equal(first.key, 'waitStageAwaitingFirstToken', '5s 起显示阶段名')
  assert.equal(first.stage, 'awaitingFirstToken')
  assert.deepEqual(first.tier, streamNoticeTier(5_000), '档位就是 streamNoticeTier 的结果')
  assert.equal(first.actions, false, '5s/30s 不给停止入口')
  assert.equal(first.startedAt, startedAt, '提示带着本轮起点，供叶子组件算秒数')

  const slow = at(30_000)
  assert.equal(slow.tier.afterMs, 30_000, '30s 升到第二档')
  assert.equal(slow.key, 'waitStageAwaitingFirstToken', '升档只加一行，不改主行')
  assert.equal(slow.actions, false)

  const stalled = at(60_000)
  assert.equal(stalled.tier.afterMs, 60_000, '60s 升到第三档')
  assert.equal(stalled.actions, true, '最高档给停止/重新生成入口')
  assert.equal(at(95_000).tier.afterMs, 60_000, '更久仍是最高档')
})

test('composeWaitNotice：阶段未知时回落到分档文案，重试立刻可见', () => {
  const unknown = composeWaitNotice({ stage: null, startedAt: 0, now: 5_000 })
  assert.equal(unknown.key, 'replyWaitingFirstToken', '没设阶段也不能退化成没提示')
  assert.equal(unknown.stage, null)

  const retrying = composeWaitNotice({
    stage: 'retrying',
    startedAt: 0,
    now: 0,
    retry: { attempt: 1, limit: 3 },
  })
  assert.ok(retrying, '重试是已出错的等待，必须立刻可见（不等 5s）')
  assert.equal(retrying.key, 'chatRetrying', 'key 与 #105 契约一致')
  assert.deepEqual(retrying.params, { attempt: 1, limit: 3 }, 'params 仍是 {attempt,limit}')
  assert.equal(retrying.stage, 'retrying')
  assert.equal(retrying.actions, false, '重试期还没有停止出口（那是 60s 档的事）')
})

test('waitTierLine：30s 只给等上游的阶段，60s 全阶段', () => {
  const [first, slow, stalled] = [5_000, 30_000, 60_000].map((ms) => streamNoticeTier(ms))
  assert.equal(waitTierLine('connecting', first), null, '5s 档只有主行')
  for (const stage of ['connecting', 'awaitingFirstToken', 'thinking']) {
    assert.equal(waitTierLine(stage, slow), 'replyWaitingSlow', `${stage} 30s 才说「服务较慢」`)
    assert.equal(waitTierLine(stage, stalled), 'replyWaitingStalled')
  }
  for (const stage of ['preparing', 'uploading', 'retrying', null]) {
    assert.equal(
      waitTierLine(stage, slow),
      null,
      `${stage} 30s 档不追加「服务响应较慢」（上传期归因错误）`
    )
    assert.equal(waitTierLine(stage, stalled), 'replyWaitingStalled', '60s 档全阶段都要给出路')
  }
})

test('needsUpload：只有真没上到服务端的附件才算上传阶段', () => {
  assert.equal(needsUpload([]), false)
  assert.equal(needsUpload([{ serverId: 'file-1' }]), false)
  assert.equal(needsUpload([{ serverId: 'file-1' }, { serverId: null }]), true)
  assert.equal(needsUpload([{}]), true)
})

const START = 1_700_000_000_000

test('store 接线：阶段流转 + 5/30/60 三档在同一 startedAt 上升级', async (t) => {
  // 假时钟：只假 setTimeout/setInterval/Date，流与 Promise 仍是真的
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START })
  t.after(() => {
    t.mock.timers.reset()
  })
  // 请求预算 / 空闲预算都放到 10 分钟外：本用例只快进 60s，不该被超时打断
  setRequestTimeout(600_000)
  setStreamIdleTimeout(600_000)
  await initChat()
  setApiKey('sk-test-328')
  setDraftText(null, '你好')

  /** 期间出现过的每一条等待提示（按写入顺序） */
  const seen = []
  const unsubscribe = useChatStore.subscribe((state) => {
    const hint = state.waitHints[Object.keys(state.waitHints)[0]]
    if (hint && seen.at(-1) !== hint) {
      seen.push(hint)
    }
  })

  try {
    const before = Date.now()
    assert.equal(sendMessage(null), true, '草稿非空时应能发出去')
    const sessionId = useChatStore.getState().activeId
    assert.ok(sessionId, '应新建会话')
    const hintOf = () => useChatStore.getState().waitHints[sessionId]

    // ① 请求发出、等响应头：这段是「正在连接上游」
    for (let i = 0; i < 40 && !releaseHeaders; i += 1) {
      await flush(2)
    }
    assert.equal(fetchCalls, 1, '本轮回答请求应该已经发出')
    assert.equal(hintOf(), undefined, '5s 之前不打扰用户')

    t.mock.timers.tick(5_000)
    await flush()
    const connecting = hintOf()
    assert.ok(connecting, '5s 起必须给提示')
    assert.equal(connecting.stage, 'connecting', '响应头还没到 = 正在连接上游')
    assert.equal(connecting.key, 'waitStageConnecting')
    assert.equal(connecting.startedAt, before, 'startedAt 是点发送那一刻')
    assert.equal(connecting.tier.afterMs, 5_000)
    assert.equal(connecting.actions, false)

    // ② 响应头到达：阶段切到「已连接，等待模型首字」，秒数不归零
    releaseHeaders()
    await flush()
    const awaiting = hintOf()
    assert.equal(awaiting.stage, 'awaitingFirstToken', '响应头到了就该说「已连接，等首字」')
    assert.equal(awaiting.key, 'waitStageAwaitingFirstToken')
    assert.equal(awaiting.startedAt, before, '阶段变化不重置起点')
    assert.equal(awaiting.tier.afterMs, 5_000, '还没到 30s，仍是第一档')

    // ③ 30s / 60s：同一 startedAt 上继续升级，只有最高档给出口
    t.mock.timers.tick(25_000)
    await flush()
    const slow = hintOf()
    assert.equal(slow.tier.afterMs, 30_000, '30s 升到第二档')
    assert.equal(slow.stage, 'awaitingFirstToken')
    assert.equal(slow.startedAt, before, '升档不重置起点')
    assert.equal(waitTierLine(slow.stage, slow.tier), 'replyWaitingSlow', '30s 追加「服务较慢」')
    assert.equal(slow.actions, false)

    t.mock.timers.tick(30_000)
    await flush()
    const stalled = hintOf()
    assert.equal(stalled.tier.afterMs, 60_000, '60s 升到第三档')
    assert.equal(stalled.actions, true, '60s 给停止入口')
    assert.equal(waitTierLine(stalled.stage, stalled.tier), 'replyWaitingStalled')
    assert.equal(waitSeconds(stalled.startedAt, Date.now()), 60, '叶子组件算出来的秒数 = 60s')

    // ④ 第一个块是思考块：提示不撤，换成「模型正在思考」（hidden 档也还有文案）
    bodyController.enqueue(
      encoder.encode(
        chunk({
          id: 'chatcmpl-328',
          model: 'deepseek-v4.1-flash',
          choices: [{ index: 0, delta: { role: 'assistant' } }],
        })
      )
    )
    bodyController.enqueue(
      encoder.encode(
        chunk({
          id: 'chatcmpl-328',
          choices: [{ index: 0, delta: { reasoning_content: '先想一下' } }],
        })
      )
    )
    for (let i = 0; i < 40 && hintOf()?.stage !== 'thinking'; i += 1) {
      await flush(2)
    }
    const thinking = hintOf()
    assert.ok(thinking, '思考期提示不能被撤掉（G5）')
    assert.equal(thinking.stage, 'thinking')
    assert.equal(thinking.key, 'waitStageThinking')
    assert.equal(thinking.startedAt, before, '思考阶段的秒数继续累加，不归零')

    // ⑤ 开始吐正文：提示立刻撤下
    bodyController.enqueue(
      encoder.encode(
        chunk({ id: 'chatcmpl-328', choices: [{ index: 0, delta: { content: '你好' } }] })
      )
    )
    for (let i = 0; i < 40 && hintOf() !== undefined; i += 1) {
      await flush(2)
    }
    assert.equal(hintOf(), undefined, '首个正文块到达后等待提示必须消失')

    // ⑥ 收尾
    bodyController.enqueue(
      encoder.encode(
        chunk({ id: 'chatcmpl-328', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      )
    )
    bodyController.enqueue('data: [DONE]\n\n')
    bodyController.close()
    for (
      let i = 0;
      i < 40 && Object.hasOwn(useChatStore.getState().streaming, sessionId);
      i += 1
    ) {
      await flush(2)
    }
    assert.equal(
      Object.hasOwn(useChatStore.getState().streaming, sessionId),
      false,
      '本轮必须收尾'
    )

    // 所有提示共享同一个 startedAt：跨阶段（含重试）累计等待，不归零
    assert.ok(seen.length >= 4, `至少要看到 建连 / 等首字 / 思考 几个阶段，实际 ${seen.length}`)
    for (const hint of seen) {
      assert.equal(hint.startedAt, before, '任何阶段的提示都用同一个 startedAt')
    }
    assert.deepEqual(
      [...new Set(seen.map((hint) => hint.stage))],
      ['connecting', 'awaitingFirstToken', 'thinking'],
      '阶段只能按 connecting → awaitingFirstToken → thinking 前进'
    )
  } finally {
    unsubscribe()
  }
})

test('挂载点契约：G4 修好（waiting 不再被 message.thinking 吞掉）、WaitNotice 是叶子', () => {
  const message = read('../../src/components/messages/AssistantMessage.tsx')
  const waitingLine = message
    .split('\n')
    .find((line) => line.includes('const waiting ='))
  assert.ok(waitingLine, '消息组件要自己算「还在等首字」')
  assert.doesNotMatch(waitingLine, /message\.thinking/, 'G4：不能再让专家模式的 thinking 关掉整段等待提示')
  assert.match(message, /thinkingHidden \|\| view\.steps\.length === 0/, '隐藏档 / 还没出步骤时都要留等待占位')
  assert.match(message, /<WaitNotice/, '等待占位要挂叶子组件')
  assert.match(message, /waitHint\?\.actions/, '停止入口由提示自带，不靠 key 反查')
  assert.match(message, /stopReply/, '最高档要能停止')

  const notice = read('../../src/components/messages/WaitNotice.tsx')
  assert.match(notice, /setInterval/, '秒数要 1Hz 自刷')
  assert.match(notice, /waitElapsed/, '秒数文案走 i18n')
  assert.match(notice, /aria-hidden/, '秒数不进读屏，避免每秒播报')

  const store = read('../../src/services/chat/store.ts')
  assert.match(store, /armWaitHints\(sessionId, startedAt\)/, 'startedAt 从 streamReply 顶部传入')
  assert.match(store, /setWaitStage\(sessionId, 'connecting'\)/, 'prepareFiles 之后切「正在连接上游」')
  assert.match(store, /setWaitStage\(sessionId, 'awaitingFirstToken'\)/, '复用 onHeaders 钩子切「等首字」')
  assert.match(store, /setWaitStage\(sessionId, 'thinking'\)/, 'thinking 块切「模型正在思考」')
  assert.match(store, /setWaitStage\(sessionId, 'retrying'/, '重试阶段复用 chatRetrying')
  assert.match(store, /needsUpload\(roundFiles\(request\)\)/, '附件没补传完要显示「正在上传附件」')
  assert.match(store, /setWaitStage/, '阶段一律经 setWaitStage，不许直接 setWaitHint')

  const reply = read('../../src/components/messages/ReplyArea.tsx')
  assert.match(reply, /view\.steps\.length === 0/, '首字前不出「正在思考」标题')
  assert.match(reply, /message\.createdAt/, '思考期标题的秒数从点发送算起')
})

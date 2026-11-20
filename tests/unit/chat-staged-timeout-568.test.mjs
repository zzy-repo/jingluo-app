// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #568：请求超时拆成**三段**（连接 / 首字 / 空闲），并且**只对安全的场景自动重试**。
//
// 改前的事实（本单的立项理由，跑真代码核对过）：
//   · 只有一个「到响应头」预算（15s）+ 一个「正文空闲」预算（45s），两种完全不同的失败
//     ——「连不上」和「吐了半句后不动」——只能共用一个口径；
//   · 更没有「响应头到了、但第一个事件一直不来」这一档：那段被并进空闲超时，
//     于是「连上了但一直不出字」既说不清卡在哪，也没法（安全地）重试。
//
// 本用例的判据（逐条对应 #568 的验收）：
//   [1] 连接阶段超时        → code=connect_timeout，**会重试**
//   [2] 首字阶段超时        → code=first_token_timeout，**会重试**
//   [3] 已出内容后空闲超时  → code=idle_timeout，**不重试**（重复输出 / 重复计费的唯一闸门）
//   [4] 正常流式            → 三段定时器都被清理，**没有残留 timer**
//   [5] 重试次数到上限      → 终态错误明确（code 保留、文案可读、不再发请求）
//   [6] 重试用的请求体逐字节相同 → #345 的前缀稳定性不被重试破坏
//   [7] 负向对照：把「已出内容后不重试」改成无条件重试 → [3] 的断言必须红
//
// 跑真代码：真 store / 真 client / 真 sse 解析；只有 fetch、IndexedDB、原生桥、诊断写入口换成替身。
//
//   node --test tests/unit/chat-staged-timeout-568.test.mjs
//   node tests/run-layer.mjs unit --only chat-staged-timeout-568
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { ROOT, installChatEnv, installEndpointsGlobals } from '../helpers/dom-env.mjs'

// 装配：原生桥 + 诊断写入口 + 只对 chat/store.ts 的 ./db.js 换假库（#366 / #408 的公共入口）
installChatEnv()
installEndpointsGlobals({ apiOrigin: 'https://api.test.invalid', internalBuild: true, resetLogRecords: false })

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__INTERNAL_BUILD__ = true
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

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
/**
 * 只压退避等待（1s / 2s → 1ms）：超时预算本身是本用例的被测物，一毫秒都不许动。
 * 不压的话「重试到上限」那条要跑 1+2 秒，而它要证明的只是「到了上限就停」。
 */
const BACKOFF_DELAYS = new Set([1000, 2000])
/**
 * **定时器账本**（`[4]` 的判据）：进程里所有 `setTimeout` / `clearTimeout` 都经这里，
 * 记下「set 了但还没被 clear、也还没触发」的那些 id。
 *
 * 为什么不能只数 `process.getActiveResourcesInfo()`：那个数只反映「此刻活着的 timer 总数」，
 * 被漏掉的 timer 一旦到点触发就自己消失了 —— 一个 200ms 后触发的泄漏在事后轮询里看不见。
 * 账本记的是**我们自己 set 出去、没人负责清**的那批：正常收尾后它必须是空的。
 */
const trackedTimers = new Set()
let trackTimers = false
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = realSetTimeout(
    () => {
      trackedTimers.delete(id)
      fn()
    },
    BACKOFF_DELAYS.has(ms) ? 1 : ms,
    ...args
  )
  if (trackTimers) {
    trackedTimers.add(id)
  }
  return id
}
globalThis.clearTimeout = (id) => {
  trackedTimers.delete(id)
  realClearTimeout(id)
}
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const client = await import('../../src/services/api/client.ts')
const policy = await import('../../src/services/chat/timeoutPolicy.ts')
const { setApiKey, setProviderKind, setModel } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const store = await import('../../src/services/chat/store.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

// 下面断言的是中文措辞（停止 / 重新生成）：settings 的默认语言跟随 navigator.language
// （Node 里来自 shell 的 LANG），不钉死就会 LANG=en_US 红、LANG=zh_CN 绿。
assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言必须钉在中文，不能跟随 shell 的 LANG')

const { useChatStore, initChat, sendMessage } = store

// ---------------------------------------------------------------------------
// 预算：全部压到百毫秒级，跑真定时器（假时钟会把 sse 的 Promise.race + reader.cancel 搅在一起）
// ---------------------------------------------------------------------------
const CONNECT_MS = 120
const FIRST_TOKEN_MS = 180
const IDLE_MS = 220

const applyBudgets = () => {
  client.setRequestTimeout(CONNECT_MS)
  client.setFirstTokenTimeout(FIRST_TOKEN_MS)
  client.setStreamIdleTimeout(IDLE_MS)
}

test.after(() => {
  // 恢复默认：本文件跑完后其余单测（同进程内的其它 --only 组合）不该继承小预算
  client.setRequestTimeout(client.DEFAULT_REQUEST_TIMEOUT_MS)
  client.setFirstTokenTimeout(client.FIRST_TOKEN_TIMEOUT_MS)
  client.setStreamIdleTimeout(client.STREAM_IDLE_TIMEOUT_MS)
})

// ---------------------------------------------------------------------------
// 桩：本轮回答请求的响应形态由每个用例自己给
// ---------------------------------------------------------------------------
const encoder = new TextEncoder()
/** 一条完整 SSE 事件：末尾必须有**空行**（两个换行），少一个就会和下一帧粘在一起而不派发 */
const frame = (event, data) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, '', ''].join('\n')

const messageStart = frame('message_start', {
  type: 'message_start',
  message: { usage: { input_tokens: 9, output_tokens: 0 } },
})
const blockStart = frame('content_block_start', {
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
})
const delta = (text) =>
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })
const TAIL = [
  frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  frame('message_stop', { type: 'message_stop' }),
].join('')

const sseResponse = (stream) =>
  new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })

/** 立刻把给定帧推进去、然后正常结束：正常流式的形状 */
const completedStream = (text) =>
  sseResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${messageStart}${blockStart}${delta(text)}${TAIL}`))
        controller.close()
      },
    })
  )

/** 响应头到手、**一个字节都不发**、也不结束：首字超时的形状（连上了但一直不出字） */
const silentBody = () => sseResponse(new ReadableStream({ start() {} }))

/** 发几帧正文、然后挂住不结束也不发：出过内容之后空闲超时的形状 */
const stalledAfterContent = (text) =>
  sseResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`${messageStart}${blockStart}${delta(text)}`))
      },
    })
  )

/** 永不 resolve：等自身 signal 被中断（连接超时的形状） */
const hungRequest = (_url, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal
    const fail = () => reject(new DOMException('Aborted', 'AbortError'))
    if (!signal) {
      return
    }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })

/** 只有本轮回答请求算数（自动标题也是流式请求，不能算进重试次数） */
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

let calls = 0
let handler = () => completedStream('默认回答')
/** 每次回答请求的原始请求体（字符串）：用来证明重试用的是**同一份**请求体（#345） */
let bodies = []

globalThis.fetch = async (url, init) => {
  if (!isStreamRequest(init)) {
    return sseResponse(
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      })
    )
  }
  calls += 1
  const body = String(init?.body ?? '')
  bodies.push(body)
  return handler(url, init, calls)
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

/** 等待本轮收尾（streaming 里没有它了） */
const waitForSettle = async (sessionId, limitMs = 12000) => {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return true
    }
    await delay(5)
  }
  return false
}

/**
 * 跑一轮对话，返回：本轮实际发出几次请求、终态回复、界面出现过的「正在第 N 次重试」提示。
 */
const runRound = async ({ respond, budgets = true }) => {
  handler = respond
  calls = 0
  bodies = []
  trackedTimers.clear()
  trackTimers = true
  if (budgets) {
    applyBudgets()
  }
  setProviderKind('deepseek')
  setModel('deepseek-flash')
  await initChat()
  setApiKey('sk-test-568')
  setDraftText(null, '你好')
  const hints = []
  const unsubscribe = useChatStore.subscribe((state) => {
    for (const hint of Object.values(state.waitHints)) {
      if (hint && hint.key === 'chatRetrying') {
        hints.push(hint)
      }
    }
  })
  try {
    assert.equal(sendMessage(null), true, '草稿非空时应能发出去')
    const sessionId = useChatStore.getState().activeId
    assert.ok(sessionId, '应新建会话')
    const settled = await waitForSettle(sessionId)
    assert.equal(settled, true, '本轮必须收尾，不能一直挂着')
    /** 收尾那一刻还挂着、也没人负责清的定时器：正常路径必须是空的 */
    const leakedTimers = [...trackedTimers]
    trackTimers = false
    const session = useChatStore.getState().sessionCache[sessionId]
    const reply = session.messages.filter((message) => message.role === 'assistant').at(-1)
    const text = reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    return { calls, reply, text, hints, leakedTimers }
  } finally {
    unsubscribe()
  }
}

const limit = () => {
  const value = store.STREAM_RETRY_LIMIT
  assert.ok(Number.isInteger(value) && value >= 1, '重试必须有明确上限，且至少 1 次')
  return value
}

// ---------------------------------------------------------------------------
// [1] 连接阶段超时
// ---------------------------------------------------------------------------
test('连接阶段超时：报 connect_timeout，且会重试', async () => {
  const { calls: sent, reply, hints } = await runRound({ respond: hungRequest })
  assert.equal(reply.status, 'error', '重试到上限后必须是明确的终态错误')
  assert.equal(reply.error?.code, 'connect_timeout', '连接段要能单独认出来（不是笼统的「超时」）')
  assert.equal(reply.error?.kind, 'timeout')
  assert.equal(
    sent,
    1 + limit(),
    `连接段超时是安全的重试场景（还没向用户输出任何内容）：1 次首发 + ${limit()} 次重试`
  )
  assert.equal(
    hints.length >= 1,
    true,
    '重试必须有可见提示（「正在第 N 次重试」），不能静默重试'
  )
  assert.deepEqual(hints[0].params, { attempt: 1, limit: limit() })
})

// ---------------------------------------------------------------------------
// [2] 首字阶段超时
// ---------------------------------------------------------------------------
test('首字阶段超时：报 first_token_timeout，且会重试', async () => {
  const { calls: sent, reply } = await runRound({ respond: () => silentBody() })
  assert.equal(reply.status, 'error')
  assert.equal(
    reply.error?.code,
    'first_token_timeout',
    '「连上了但一直不出字」必须自成一档，不能混进空闲超时'
  )
  assert.equal(reply.error?.kind, 'timeout')
  assert.equal(
    sent,
    1 + limit(),
    `首字超时时用户还什么也没看到，重发安全：1 + ${limit()} 次`
  )
})

// ---------------------------------------------------------------------------
// [3] 已出内容后的空闲超时：不重试
// ---------------------------------------------------------------------------
test('已出内容后空闲超时：报 idle_timeout，且不重试（已收内容保留）', async () => {
  const { calls: sent, reply, text, hints } = await runRound({
    respond: () => stalledAfterContent('已经收到的半句'),
  })
  assert.equal(reply.status, 'error')
  assert.equal(reply.error?.code, 'idle_timeout', '空闲段要能单独认出来')
  assert.equal(reply.error?.kind, 'idle')
  assert.equal(
    sent,
    1,
    '已经出过内容之后超时绝不能重发：重发会答两遍、上游重复计费（#568 的硬约束）'
  )
  assert.deepEqual(hints, [], '不重试就不该出现「正在第 N 次重试」')
  assert.equal(text, '已经收到的半句', '超时前收到的正文不能丢')
  // 界面上必须是「可操作」的出口，而不是一句内部 code
  const notice = describeReply(reply)
  assert.ok(notice, '超时后必须有提示，不能静默收尾')
  assert.match(notice.text, /停止|重新生成/, '文案要给出可操作的出口')
})

// ---------------------------------------------------------------------------
// [4] 正常流式：三段定时器都不许留
// ---------------------------------------------------------------------------
test('正常流式：三段定时器都被清理，没有残留 timer', async () => {
  /** 当前进程里活着的 setTimeout 数量 */
  const liveTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

  const baseline = liveTimeouts()
  const { calls: sent, reply, text, leakedTimers } = await runRound({
    respond: () => completedStream('正常回答'),
  })
  assert.equal(sent, 1, '正常流式不该重试')
  assert.equal(reply.status, 'done')
  assert.equal(text, '正常回答')
  assert.deepEqual(
    leakedTimers,
    [],
    `本轮收尾时不许还有没人清的 setTimeout（连接 / 首字 / 空闲三段 + 等待提示三档）：残留 ${leakedTimers.length} 个`
  )

  // 收尾是异步的（画帧 / 落盘）：给一点时间让所有 finally 的清理真的跑完
  const deadline = Date.now() + 1500
  let leaked = liveTimeouts() - baseline
  while (leaked > 0 && Date.now() < deadline) {
    await delay(20)
    leaked = liveTimeouts() - baseline
  }
  assert.equal(
    leaked,
    0,
    `正常结束后不许再有活着的 setTimeout（连接 / 首字 / 空闲三段 + 等待提示三档都要清）：残留 ${leaked} 个`
  )
})

// ---------------------------------------------------------------------------
// [5] 重试次数上限
// ---------------------------------------------------------------------------
test('重试次数上限：超限后终态错误明确，不再发请求', async () => {
  const { calls: sent, reply } = await runRound({ respond: hungRequest })
  assert.equal(sent, 1 + limit(), '重试必须收敛到上限，不能无限重试')
  assert.equal(reply.status, 'error')
  // 终态错误必须说清「卡在哪一段」，且文案可读（不是 i18n 的裸 key、也不是上游英文原文）
  const key = reply.error?.localMessage?.key
  assert.equal(key, 'requestTimeout', '终态仍保留该段的文案 key')
  assert.ok(String(zh[key] ?? '').length > 0, 'zh 文案齐全')
  assert.ok(String(en[key] ?? '').length > 0, 'en 文案齐全')
  assert.match(String(zh[key]), /超时/, '用户看到的是「超时」，不是一个内部 code')
})

// ---------------------------------------------------------------------------
// [6] #345 前缀稳定性：重试不许重建上下文
// ---------------------------------------------------------------------------
test('重试用的是同一份请求体（#345 的前缀稳定性不被重试破坏）', async () => {
  const { calls: sent } = await runRound({
    respond: (_url, _init, attempt) =>
      attempt === 1 ? hungRequest(_url, _init) : completedStream('第二次才成功'),
  })
  assert.equal(sent, 2, '第一次连接超时 → 第二次成功，一共两条请求')
  assert.equal(bodies.length, 2)
  assert.equal(
    bodies[0],
    bodies[1],
    '重试必须逐字节复用同一份请求体：重建上下文会让 #345 的前缀缓存失效（也就等于换了一条对话）'
  )
})

// ---------------------------------------------------------------------------
// [7] 负向对照：把「已出内容后不重试」改成重试 → [3] 的断言必须红
// ---------------------------------------------------------------------------
/**
 * 复制 `timeoutPolicy.ts` 的源码、只改**一行**（`idle_timeout` 那行的 `requiresNoContent`），
 * 写成临时 `.ts` 模块再导入 —— 这就是「把实现改坏」的那一次注入。
 *
 * 为什么套模板跑：只断言「生产代码返回 false」证明不了这条断言对**那一行**敏感
 * （比如某人把整个矩阵删了、改成 `return false`，用例照样绿）。所以必须看见：
 * 注入后的模块让同一条断言变成红。
 */
const loadMutatedPolicy = (mutate) => {
  const source = readFileSync(path.join(ROOT, 'src/services/chat/timeoutPolicy.ts'), 'utf8')
  const mutated = mutate(source)
  assert.notEqual(mutated, source, '负向对照必须真的改动源码（一行都没变说明注入失效）')
  const dir = mkdtempSync(path.join(tmpdir(), 'neg-568-'))
  const file = path.join(dir, 'timeoutPolicy.mts')
  writeFileSync(file, mutated, 'utf8')
  return { url: pathToFileURL(file).href, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** [3] 的那条判据，抽成一个函数：生产实现与注入后的实现都必须跑它 */
const assertIdleAfterContentNotRetried = (shouldRetry, label) => {
  assert.equal(shouldRetry('idle_timeout', true), false, `${label}：出过内容后的空闲超时不许重试`)
  assert.equal(shouldRetry('idle_timeout', false), true, `${label}：还没出内容时空闲超时可以重试`)
}

test('重试矩阵是唯一判定处：三段各一行，可逐行单测', () => {
  const codes = policy.STREAM_TIMEOUT_POLICIES.map((row) => row.code)
  assert.deepEqual(codes, ['connect_timeout', 'first_token_timeout', 'idle_timeout'], '三段各一行，不多不少')
  assert.deepEqual(
    policy.STREAM_TIMEOUT_POLICIES.map((row) => row.stage),
    ['connect', 'first_token', 'idle'],
    '每行都要说清卡在哪一段（诊断与文案都靠它）'
  )
  // 连接 / 首字：还没输出任何内容，重发安全
  assert.equal(policy.shouldRetryStreamTimeout('connect_timeout', false), true)
  assert.equal(policy.shouldRetryStreamTimeout('first_token_timeout', false), true)
  // 不是三段超时 → null（调用方按原有分类走，矩阵不扩权）
  assert.equal(policy.shouldRetryStreamTimeout('stream_empty', false), null)
  assert.equal(policy.shouldRetryStreamTimeout(undefined, false), null)
  // [3] 的判据
  assertIdleAfterContentNotRetried(policy.shouldRetryStreamTimeout, '生产实现')
})

test('负向对照：把「已出内容后不重试」改成无条件重试，[3] 的断言必须红', async () => {
  const { url, cleanup } = loadMutatedPolicy((source) =>
    source.replace(
      "{ code: 'idle_timeout', stage: 'idle', retryable: true, requiresNoContent: true }",
      "{ code: 'idle_timeout', stage: 'idle', retryable: true, requiresNoContent: false }"
    )
  )
  try {
    const mutant = await import(url)
    assert.equal(
      typeof mutant.shouldRetryStreamTimeout,
      'function',
      '注入后的模块要能真的跑（不能因为导入失败而「看起来通过了」）'
    )
    // 注入后的实现：已出内容也照样重试 —— 这正是 #568 禁止的那件事
    assert.equal(mutant.shouldRetryStreamTimeout('idle_timeout', true), true, '注入必须改变行为')
    assert.throws(
      () => assertIdleAfterContentNotRetried(mutant.shouldRetryStreamTimeout, '注入后的实现'),
      (error) => error instanceof assert.AssertionError,
      '[3] 的断言在注入后必须红：绿了就说明它根本没在检查「已出内容后不重试」'
    )
  } finally {
    cleanup()
  }
})

// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #105：断网 / 5xx / 超时都必须走有上限的自动重试，用户取消不许重试、4xx 鉴权类重试无用。
// 这里跑的是真实 store / client / errors 代码：只把 fetch、IndexedDB、Capacitor、诊断写入口换成替身，
// 请求失败用假 Response / 假断网 / 挂起的 promise 造出来，断言的是「真的又发了几次请求」与终态。
//
//   node tests/unit/chat-retry-retryable.test.mjs
//
// 覆盖：
//   [1] 断网：连失败两次后自动重试成功，用户看到的是回答，不是报错
//   [2] 5xx：按上限重试后放弃，终态仍报服务端繁忙（不无限重试）
//   [3] 超时：kind='timeout'（#45）也算可重试，按上限重试后给出超时报错
//   [4] 4xx 鉴权类：401 不重试，一次失败就收尾（重试无用）
//   [5] 用户停止：abort 不是可重试错误，立刻按已停止收尾，不再发请求
//   [6] 重试期间界面有「正在第 N 次重试」（带次数与上限占位符，中英都有）
//   [7] 重试判定是纯函数，逐个分类都能单测（abort 优先级最高）
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

// 假 db：IndexedDB 在裸 Node 里不存在，只换存储边界，store 的请求 / 重试逻辑仍是真实代码
const fakeDB = `data:text/javascript,${encodeURIComponent(`
export const loadSessionSummaries = async () => []
export const loadSession = async () => undefined
export const saveSession = async () => {}
export const saveFiles = async () => {}
export const loadFile = async () => undefined
export const deleteSession = async () => {}
export const pinSession = async () => {}
export const renameSession = async () => {}
export const clearStaging = async () => {}
export const addStagingSession = async () => {}
export const saveStagingFiles = async () => {}
export const updateStagingFileTypes = async () => {}
export const commitStaging = async () => []
export const reportStorageError = () => () => {}
export const loadAppAsset = async () => undefined
export const saveAppAsset = async () => {}
export const deleteAppAsset = async () => {}
`)}`

// 诊断写入口替身：沿用公共 stub，再补上它没覆盖的 recordError（store 顶层要用）
const collectorStub = `data:text/javascript,${encodeURIComponent(`
export * from '${stub('collector.mjs')}'
export const recordError = (message, fields = {}) => {
  globalThis.__log.records.push({ kind: 'error', level: 'error', message, fields })
}
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: collectorStub, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      const parent = String(context.parentURL ?? '')
      if (specifier === './db.js' && parent.endsWith('/chat/store.ts')) {
        return { url: fakeDB, shortCircuit: true }
      }
      // 源码里的相对引用写的是构建产物名 .js，单测直接跑 .ts 源码：换后缀再试一次
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

// 打包期 DefinePlugin 常量 + 最小浏览器边界，都在 import 真实源码之前挂好
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
const realSetTimeout = globalThis.setTimeout
/** 退避等待压缩到 1ms：只压 1s / 2s 这两个退避值，首字分级提示与请求超时预算都不动 */
const BACKOFF_DELAYS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, BACKOFF_DELAYS.has(ms) ? 1 : ms, ...args)
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = {
  visibilityState: 'visible',
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const { setRequestTimeout } = await import('../../src/services/api/client.ts')
const { classifyStatus } = await import('../../src/services/api/errors.ts')
const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const store = await import('../../src/services/chat/store.ts')
const { useChatStore, initChat, sendMessage, stopReply } = store

/** 自动重试上限（不含首次请求）由实现导出：没有上限或上限非法，用例直接红 */
const retryLimit = () => {
  const limit = store.STREAM_RETRY_LIMIT
  assert.ok(Number.isInteger(limit) && limit >= 1, '重试必须有明确上限，且上限至少 1 次')
  return limit
}

const encoder = new TextEncoder()
const frame = (event, data) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, ''].join('\n')

// 默认协议是 OpenAI 兼容，流的形态按它来写：delta 拼正文，finish_reason 收尾
const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const ANSWER = [
  chunk({ id: 'chatcmpl-105', model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
  chunk({
    id: 'chatcmpl-105',
    choices: [{ index: 0, delta: { content: '重试之后的回答' }, finish_reason: null }],
  }),
  chunk({ id: 'chatcmpl-105', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
].join('')

/** 正常流：一段 SSE 字节流 */
const answerResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ANSWER))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 上游报错：4xx / 5xx 都走这条 */
const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** 断网：fetch 直接抛，和浏览器「连不上」同一类 */
const networkError = () => {
  throw new TypeError('fetch failed')
}

/** 挂住不响应：等自身 signal 被中断（请求超时 / 用户停止）才 reject */
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

let calls = 0
let handler = networkError
/**
 * 只有本轮回答请求算数：自动标题也是流式请求（#127），不能算进重试次数，
 * 所以按「请求里带了本轮用户消息」认。
 */
const isStreamRequest = (init) => {
  try {
    const body = JSON.parse(init?.body ?? '{}')
    // 自动标题也是流式请求，且带着同一套 system 提示，只能靠输出预算区分：
    // 标题只给 32 个 token（AUTO_TITLE_MAX_OUTPUT_TOKENS），回答请求远大于此
    if (typeof body.max_tokens === 'number' && body.max_tokens <= 64) {
      return false
    }
    return body.stream === true
  } catch {
    return false
  }
}
globalThis.fetch = async (url, init) => {
  if (!isStreamRequest(init)) {
    return answerResponse()
  }
  calls += 1
  return handler(url, init, calls)
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

/** 一轮对话：返回本轮实际发出的请求次数、终态消息与期间出现过的等待提示 */
const runRound = async ({ respond, timeoutMs = 4000, onStart }) => {
  handler = respond
  calls = 0
  setRequestTimeout(timeoutMs)
  await initChat()
  setApiKey('sk-test-105')
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
    onStart?.(sessionId)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
        break
      }
      await delay(5)
    }
    assert.equal(
      Object.hasOwn(useChatStore.getState().streaming, sessionId),
      false,
      '本轮必须收尾，不能一直挂着'
    )
    const session = useChatStore.getState().sessionCache[sessionId]
    const reply = session.messages.filter((m) => m.role === 'assistant').at(-1)
    const text = reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    return { calls, reply, text, hints }
  } finally {
    unsubscribe()
  }
}

test('断网：连续失败后自动重试，最终拿到回答（不是直接报错）', async () => {
  const { calls, reply, text } = await runRound({
    respond: (_url, _init, attempt) => (attempt <= 2 ? networkError() : answerResponse()),
  })
  assert.equal(calls, 3, '断网两次后重试：一共该发 3 次请求')
  assert.equal(reply.status, 'done', '第 3 次请求成功，本轮应正常结束')
  assert.equal(text, '重试之后的回答')
  assert.ok(retryLimit() >= 2, '两次断网后仍然重试，说明上限至少 2 次')
})

test('5xx：服务端繁忙可按上限重试，达到上限就放弃并保留繁忙报错', async () => {
  const { calls, reply } = await runRound({
    respond: () => errorResponse(503, 'server is busy'),
  })
  assert.equal(calls > 1, true, '5xx 是暂时性失败，应自动重试而不是一次就放弃')
  const limit = retryLimit()
  assert.equal(calls, 1 + limit, `5xx 应重试到上限：1 次首发 + ${limit} 次重试`)
  assert.equal(reply.status, 'error')
  // 终态仍带着原始报错：kind/status 是 ApiError 自己的，界面按 status 归到「服务端繁忙」
  assert.equal(reply.error?.kind, 'http')
  assert.equal(reply.error?.status, 503)
  assert.equal(classifyStatus(reply.error?.status), 'serverBusy', '界面上应说「服务端繁忙」而不是「其他错误」')
})

test('超时：kind=timeout 同样自动重试，按上限放弃后报超时', async () => {
  const { calls, reply } = await runRound({ respond: hungRequest, timeoutMs: 120 })
  assert.equal(calls > 1, true, '超时等于这一轮没等到响应，应自动重试')
  const limit = retryLimit()
  assert.equal(calls, 1 + limit, `超时也应重试到上限：1 + ${limit} 次`)
  assert.equal(reply.status, 'error')
  assert.equal(reply.error?.kind, 'timeout')
})

test('4xx 鉴权类：401 重试无用，一次失败就收尾', async () => {
  const { calls, reply, hints } = await runRound({
    respond: () => errorResponse(401, 'invalid api key'),
  })
  assert.equal(calls, 1, '鉴权失败不该重试')
  assert.equal(reply.status, 'error')
  assert.equal(reply.error?.kind, 'http')
  assert.equal(reply.error?.status, 401)
  assert.deepEqual(hints, [], '不重试就不该出现「正在第 N 次重试」')
})

test('用户停止：abort 不算可重试错误，立刻按已停止收尾', async () => {
  const { calls, reply, hints } = await runRound({
    respond: hungRequest,
    timeoutMs: 4000,
    onStart: (sessionId) => {
      realSetTimeout(() => stopReply(sessionId), 30)
    },
  })
  assert.equal(calls, 1, '用户点了停止就不许再发请求')
  assert.equal(reply.status, 'stopped')
  assert.equal(reply.error, undefined)
  assert.deepEqual(hints, [], '用户取消不是重试，不该出现「正在第 N 次重试」')
})

test('重试期间界面提示「正在第 N 次重试」，且中英文案带次数与上限占位符', async () => {
  const { hints } = await runRound({
    respond: (_url, _init, attempt) => (attempt === 1 ? networkError() : answerResponse()),
  })
  assert.equal(hints.length >= 1, true, '重试时必须给用户看得见的提示，不能静默卡住')
  const limit = retryLimit()
  for (const hint of hints) {
    assert.equal(hint.key, 'chatRetrying')
    assert.deepEqual(hint.params, { attempt: 1, limit })
  }
  assert.match(zh.chatRetrying, /\{attempt\}/, '中文文案要带第几次')
  assert.match(zh.chatRetrying, /\{limit\}/, '中文文案要带上限')
  assert.match(en.chatRetrying, /\{attempt\}/)
  assert.match(en.chatRetrying, /\{limit\}/)
})

test('重试判定是纯函数：abort 优先，4xx 不重试，可重试错误按上限收敛', async () => {
  const { decideStreamRetry } = store
  assert.equal(typeof decideStreamRetry, 'function', 'streamReply 的重试判定要能脱离 UI 单测')
  const { ApiError } = await import('../../src/services/api/client.ts')
  const network = new ApiError('network', 'fetch failed')
  const timeout = new ApiError('timeout', 'request timed out')
  const busy = new ApiError('http', 'server is busy', 503)
  const limited = new ApiError('http', 'rate limited', 429)
  const auth = new ApiError('http', 'invalid api key', 401)
  const bad = new ApiError('http', 'bad request', 400)
  const base = { attempt: 0, receivedContent: false, aborted: false, fileRecovered: false }

  assert.equal(decideStreamRetry({ ...base, error: network }), 'retry')
  assert.equal(decideStreamRetry({ ...base, error: timeout }), 'retry')
  assert.equal(decideStreamRetry({ ...base, error: busy }), 'retry')
  assert.equal(decideStreamRetry({ ...base, error: limited }), 'retry')
  assert.equal(decideStreamRetry({ ...base, error: auth }), 'final')
  assert.equal(decideStreamRetry({ ...base, error: bad }), 'final')

  // 用户取消优先级最高：即使底层是可重试的网络错误，也不重试
  assert.equal(decideStreamRetry({ ...base, error: network, aborted: true }), 'aborted')
  // 已经出过内容就不再重发，避免重复回答
  assert.equal(decideStreamRetry({ ...base, error: network, receivedContent: true }), 'final')
  // 附件失效属于 400，但重新补传后可以再来一次
  assert.equal(decideStreamRetry({ ...base, error: bad, fileRecovered: true }), 'retry')
  // 上限收敛
  const limit = retryLimit()
  assert.equal(decideStreamRetry({ ...base, attempt: limit - 1, error: network }), 'retry')
  assert.equal(decideStreamRetry({ ...base, attempt: limit, error: network }), 'final')
})

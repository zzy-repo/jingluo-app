// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #299：额度/余额用完必须单独成一档（`insufficientBalance`），走真实链路做到四件事：
//   [1] 分类：HTTP 402、以及网关用 code/type 写的 `insufficient_quota` 一类响应都归到额度档，
//       不会被 429 的限流档或 400 的泛业务档吃掉；
//   [2] 不重试：额度是终态错误，`isRetryableApiError` 为 false，且真实 store 里一次都不重发（#105）；
//   [3] 文案与出路：界面固定说「余额或额度不足」并带充值动作，不认上游英文原文、不说网络异常；
//   [4] 诊断可区分：日志里带 `billing.quota=exhausted` 结构化字段（不新增枚举），能单独统计。
//
// 负向用例：502 / 网络断开 / 超时 / 普通 400 的分类与可重试性必须一点不变。
//
//   node tests/unit/quota-exhausted.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

// 假 db / 假诊断写入口，与 tests/unit/chat-retry-retryable.test.mjs 同一套（只换 I/O 边界）
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
export const reportStorageError = async () => () => {}
export const loadAppAsset = async () => undefined
export const saveAppAsset = async () => {}
export const deleteAppAsset = async () => {}
`)}`

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
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

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
/** 退避等待压缩到 1ms：只压 1s / 2s 这两个退避值，请求超时预算不动 */
const BACKOFF_DELAYS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, BACKOFF_DELAYS.has(ms) ? 1 : ms, ...args)
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const { ApiError, setRequestTimeout } = await import('../../src/services/api/client.ts')
const { classifyApiError, classifyErrorSignature, isRetryableApiError } = await import(
  '../../src/services/api/errors.ts'
)
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const store = await import('../../src/services/chat/store.ts')
const { useChatStore, initChat, sendMessage } = store

const realSetTimeoutRef = realSetTimeout
const delay = (ms) => new Promise((resolve) => realSetTimeoutRef(resolve, ms))
const retryLimit = () => store.STREAM_RETRY_LIMIT

const encoder = new TextEncoder()
const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const ANSWER = [
  chunk({ id: 'chatcmpl-299', model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
  chunk({ id: 'chatcmpl-299', choices: [{ index: 0, delta: { content: '额度正常时的回答' }, finish_reason: null }] }),
  chunk({ id: 'chatcmpl-299', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
].join('')

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

/** 上游报错：body 是完整的网关错误体（含 code / type 字段） */
const errorResponse = (status, error) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const networkError = () => {
  throw new TypeError('fetch failed')
}

const hungRequest = (_url, init) =>
  new Promise((_, reject) => {
    const signal = init?.signal
    if (!signal) {
      return
    }
    const fail = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })

let calls = 0
let handler = networkError
/** 自动标题也是流式请求（#127），按输出预算把它排除在回答请求之外 */
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
globalThis.fetch = async (_url, init) => {
  if (!isStreamRequest(init)) {
    return answerResponse()
  }
  calls += 1
  return handler(_url, init, calls)
}

/** 跑一轮对话：返回真实发出的请求次数、终态回复与界面提示 */
const runRound = async ({ respond, timeoutMs = 4000 }) => {
  handler = respond
  calls = 0
  globalThis.__log.records.length = 0
  setRequestTimeout(timeoutMs)
  await initChat()
  setApiKey('sk-test-299')
  setDraftText(null, '你好')
  assert.equal(sendMessage(null), true, '草稿非空时应能发出去')
  const sessionId = useChatStore.getState().activeId
  assert.ok(sessionId, '应新建会话')
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
    '本轮必须收尾'
  )
  const session = useChatStore.getState().sessionCache[sessionId]
  const reply = session.messages.filter((m) => m.role === 'assistant').at(-1)
  const text = reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
  const notice = describeReply(reply)
  const failureRecord = globalThis.__log.records.find((r) => r.message === 'chat stream failed')
  return { calls, reply, text, notice, failureRecord }
}

/** 造一个带上游 code 的 HTTP 错误（等价于真实链路里 readErrorResponse 的产物） */
const httpError = (status, message, upstreamCode) =>
  new ApiError('http', message, status, undefined, undefined, upstreamCode)

// ---------------------------------------------------------------- [1] 分类

test('402：归到额度档，不混进网络类与泛业务类', () => {
  const error = httpError(402, 'Payment Required', 'insufficient_balance')
  assert.equal(classifyApiError(error), 'insufficientBalance')
  assert.equal(isRetryableApiError(error), false, '额度类是终态，不许重试')
})

test('429 + insufficient_quota：认上游 code，归额度档而不是限流档', () => {
  const error = httpError(
    429,
    'You exceeded your current quota, please check your plan and billing details.',
    'insufficient_quota'
  )
  assert.equal(classifyApiError(error), 'insufficientBalance', '429 不等于限流，额度不足优先')
  assert.equal(isRetryableApiError(error), false, '改前会当成限流重试三次（#105）')
})

test('400 + code：网关把额度不足放进 400 也认出来', () => {
  for (const code of [
    'insufficient_quota',
    'insufficient_balance',
    'quota_exhausted',
    'billing_hard_limit_reached',
    'credit_balance_too_low',
  ]) {
    assert.equal(
      classifyApiError(httpError(400, 'quota problem', code)),
      'insufficientBalance',
      `code=${code} 应归额度档`
    )
    assert.equal(isRetryableApiError(httpError(400, 'quota problem', code)), false)
  }
})

test('只有 message 没有 code：文案里说余额/额度不足也能认出（含中文）', () => {
  for (const message of [
    'Insufficient quota for this request',
    'Your credit balance is too low to access the API',
    '账户余额不足，请充值',
    '当前额度已用完',
  ]) {
    assert.equal(
      classifyApiError(new ApiError('http', message, 400)),
      'insufficientBalance',
      `message=${message} 应归额度档`
    )
  }
})

test('流内 error 帧（没有状态码）带着额度 code 也归额度档', () => {
  const error = new ApiError('stream', 'quota exhausted', undefined, undefined, undefined, 'insufficient_quota')
  assert.equal(classifyApiError(error), 'insufficientBalance')
  assert.equal(isRetryableApiError(error), false)
})

// ---------------------------------------------------------------- 负向：原有分类不变

test('负向：502 / 网络断开 / 超时 / 普通 400 的分类与可重试性一点不变', () => {
  const busy = httpError(502, 'bad gateway')
  assert.equal(classifyApiError(busy), 'serverBusy', '502 仍是服务端繁忙')
  assert.equal(isRetryableApiError(busy), true, '502 仍可重试')

  const offline = new ApiError('network', 'fetch failed')
  assert.equal(classifyApiError(offline), 'network', '断网仍是网络问题')
  assert.equal(isRetryableApiError(offline), true, '断网仍可重试')

  const timeout = new ApiError('timeout', 'timed out')
  assert.equal(isRetryableApiError(timeout), true, '超时仍可重试')

  const plain = httpError(400, 'invalid request: max_tokens must be a positive integer', 'invalid_request_error')
  // #324：普通 400 从「未分类（other）」明确归到参数错误档，依旧不许被额度档吃掉
  assert.equal(classifyApiError(plain), 'badRequest', '普通 400 不许被额度档吃掉')
  assert.equal(isRetryableApiError(plain), false, '参数错误重试无用（改前就是这样）')

  const rate = httpError(429, 'rate limit exceeded', 'rate_limit_exceeded')
  assert.equal(classifyApiError(rate), 'rateLimited', '真限流仍是限流档')
  assert.equal(isRetryableApiError(rate), true, '真限流仍可重试')

  // 文件/存储配额是「传不上去」，不是「余额不足」：不能被额度档吃掉（#299 边界）
  for (const message of [
    'User storage quota exceeded, limit 2 GB',
    'User file count limit exceeded, limit 1000',
  ]) {
    assert.equal(
      classifyErrorSignature({ status: 400, message }),
      // 400 现在统一归「参数错误」档（#324）；关键断言是**不许**是 insufficientBalance
      'badRequest',
      `文件配额文案不该进额度档：${message}`
    )
  }

  // 上下文超长仍优先于额度档（#122 的动作完全不同）
  assert.equal(
    classifyErrorSignature({ status: 400, message: 'prompt is too long: 200000 tokens' }),
    'contextLimit'
  )
})

// ---------------------------------------------------------------- [2][3][4] 真实链路

test('额度不足：真实 store 一次都不重试，界面给明确文案 + 充值动作，诊断单独打标', async () => {
  const { calls, reply, notice, failureRecord } = await runRound({
    respond: () =>
      errorResponse(429, {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      }),
  })
  // [2] 不重试
  assert.equal(calls, 1, '额度不足是终态：一次失败就收尾，不许自动重试')
  assert.equal(retryLimit() >= 1, true, '重试上限依然存在（只是额度不计入）')
  assert.equal(reply.status, 'error')
  // 上游 code 存进回复：刷新后仍认得出
  assert.equal(reply.error?.upstreamCode, 'insufficient_quota')
  // [3] 文案与出路
  assert.ok(notice, '必须有提示，不能静默失败')
  assert.equal(notice.text, zh.replyInsufficientBalance)
  assert.match(notice.text, /余额|额度/, '文案要点明余额/额度')
  assert.match(notice.text, /不足以|无法继续生成/, '文案要说清无法继续生成')
  assert.doesNotMatch(notice.text, /网络|生成失败|未知错误/, '不许退回网络异常 / 泛化失败')
  assert.equal(notice.action, 'topUp', '必须给出充值 / 兑换入口')
  // [4] 诊断可区分
  assert.ok(failureRecord, '失败必须落一条 error 日志')
  assert.equal(failureRecord.fields['ui.condition'], 'insufficientBalance')
  assert.equal(failureRecord.fields['ui.notice'], 'replyInsufficientBalance')
  assert.equal(failureRecord.fields['billing.quota'], 'exhausted', '额度不足要能用结构化字段筛出来')
  assert.equal(failureRecord.fields['billing.quota.code'], 'insufficient_quota')
})

test('402：同一条链路给出同样的文案与充值动作', async () => {
  const { calls, notice } = await runRound({
    respond: () => errorResponse(402, { message: 'Insufficient balance', code: 'insufficient_balance' }),
  })
  assert.equal(calls, 1, '402 不重试')
  assert.equal(notice?.text, zh.replyInsufficientBalance)
  assert.equal(notice?.action, 'topUp')
})

test('负向：502 仍按上限重试，界面仍是「服务器繁忙」', async () => {
  const { calls, notice, failureRecord } = await runRound({
    respond: () => errorResponse(502, { message: 'bad gateway' }),
  })
  assert.equal(calls, 1 + retryLimit(), '5xx 仍要自动重试')
  // #324：回答里的 5xx 改用专门文案（显式写「可以重试」），与弹层用的 completionServerBusyToast 区分
  assert.equal(notice?.text, zh.replyServerBusy)
  assert.equal(failureRecord.fields['billing.quota'], undefined, '5xx 不该被打上额度标记')
})

test('负向：普通 400 不重试，落到参数错误档（#324 之前这里是「未知错误」），不打额度标记', async () => {
  const { calls, notice, failureRecord } = await runRound({
    respond: () =>
      errorResponse(400, {
        message: 'invalid request: max_tokens must be a positive integer',
        code: 'invalid_request_error',
      }),
  })
  assert.equal(calls, 1, '参数错误重试无用')
  // #324：400 参数错误有了独立档位（不可重试），不再落到「未知错误」兜底
  assert.equal(notice?.text, zh.replyBadRequest)
  assert.match(notice?.text ?? '', /不要重试/)
  assert.equal(failureRecord.fields['billing.quota'], undefined)
  assert.equal(failureRecord.fields['ui.condition'], 'badRequest')
  // 上游短码进诊断，便于按 code 切片（#324 第 4 条）
  assert.equal(failureRecord.fields.upstreamCode, 'invalid_request_error')
  assert.equal(failureRecord.fields.status, 400, '失败日志落真实 HTTP 状态码')
})

test('负向：网络断开仍重试并给出网络异常文案', async () => {
  const { calls, notice } = await runRound({ respond: networkError })
  assert.equal(calls, 1 + retryLimit(), '断网仍按上限重试')
  assert.equal(notice?.text, zh.commonNetworkErrorToast)
})

test('负向：超时仍重试，报超时文案', async () => {
  const { calls } = await runRound({ respond: hungRequest, timeoutMs: 120 })
  assert.equal(calls, 1 + retryLimit(), '超时仍按上限重试')
})

test('额度正常：回答照常渲染，没有额度提示、没有额度日志', async () => {
  const { calls, reply, text, notice, failureRecord } = await runRound({ respond: answerResponse })
  assert.equal(calls, 1)
  assert.equal(reply.status, 'done')
  assert.equal(text, '额度正常时的回答')
  assert.equal(notice, null, '成功回答不该有任何错误提示')
  assert.equal(failureRecord, undefined, '成功回答不该落失败日志')
})

test('中英文案成对：额度文案与充值入口两个 key 都有', () => {
  for (const key of ['replyInsufficientBalance', 'quotaTopUpEntry']) {
    assert.equal(typeof zh[key], 'string', `zh 缺 key：${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 key：${key}`)
    assert.notEqual(zh[key], '', `zh 的 ${key} 不能为空`)
    assert.notEqual(en[key], '', `en 的 ${key} 不能为空`)
  }
  // 英文文案也要点明余额/额度不足，不是泛化的生成失败
  assert.match(en.replyInsufficientBalance, /balance|quota/i)
})

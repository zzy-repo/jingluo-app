// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #122 收尾条件②：上游「上下文太长」必须和普通失败区分开。
// 现状（修复前）：413 归到 tooLarge、400 + context_length_exceeded 归到 other，
// 界面上都给不出「这段对话太长，开新会话或删几条消息」这种可操作的话。
// 这里跑真实 store / client / errors / describe 代码，只把 fetch、IndexedDB、Capacitor 换成替身。
//
//   node tests/unit/chat-context-limit-error.test.mjs
//
// 覆盖：
//   [1] 分类：上游常见原文 + 413 都归 contextLimit；无关的 400 仍是 other（不许一锅端）
//   [2] 分类：contextLimit 不可重试（重试解决不了上下文超长）
//   [3] 文案：超限提示必须和「未知错误」兜底文案不同，且是中文可读、可操作的话
//   [4] 全链路：真的发一次请求就收尾（不重试），落库的是 contextLimit 文案 key
//   [5] i18n：中英都有一对一的 key，且没有改动既有 key
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

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
// 本用例不发重试，不需要把退避压到 1ms；保持原生定时器，避免和测试运行器自身的调度打架
globalThis.requestAnimationFrame = (cb) => realSetTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }
// 说明性输出走 stderr：stdout 是测试运行器的消息通道，少往上面写，避免和它抢缓冲
const log = (...parts) => process.stderr.write(`${parts.join(' ')}
`)

const { ApiError } = await import('../../src/services/api/client.ts')
const { setRequestTimeout } = await import('../../src/services/api/client.ts')
const {
  CONTEXT_LIMIT_PATTERNS,
  classifyApiError,
  classifyStatus,
  isContextLimitMessage,
  isRetryableApiError,
} = await import('../../src/services/api/errors.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')
const { useChatStore, initChat, sendMessage } = await import('../../src/services/chat/store.ts')

// 本文件的期望值是中文文案（zh.replyContextLimit 等），而 settings.ts 的默认语言跟随
// navigator.language（Node 里来自 shell 的 LANG）：不钉死就会 LANG=en_US 红、LANG=zh_CN 绿。
// 这里用真实 store + 真实 translate 把语言钉在中文，不依赖 shell 环境变量（见 tests/helpers/locale.mjs）。
assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言必须钉在中文，不能跟随 shell 的 LANG')

/** 上游真实报错原文：各家措辞不同，逐个都要认出来 */
const UPSTREAM_TEXTS = [
  '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, your messages resulted in 91234 tokens."}}',
  'context_length_exceeded',
  'Prompt is too long: 210000 tokens > 128000 maximum',
  'input is too long for this model',
  'The request exceeds the maximum context window of this model',
  '上下文长度超出上限，请缩短对话',
]

/** 不是上下文超限的 400：不能被误判，否则用户会被引导去开新会话（白干） */
const NOT_CONTEXT_TEXTS = [
  'invalid_request_error: temperature must be <= 2',
  'invalid api key',
  'unsupported file type: .exe',
]

const httpError = (status, message) => new ApiError('http', message, status)

test('分类：上游说「上下文太长」的常见原文都归 contextLimit', () => {
  for (const text of UPSTREAM_TEXTS) {
    const error = httpError(400, text)
    assert.equal(classifyApiError(error), 'contextLimit', `没认出上游原文：${text}`)
    assert.equal(isContextLimitMessage(text), true, `isContextLimitMessage 漏了：${text}`)
  }
  log(`  认出的原文特征：${UPSTREAM_TEXTS.length} 条（400 + 各家措辞）`)
})

test('分类：413 本体就是请求体超限，也归 contextLimit', () => {
  const error = httpError(413, 'Payload Too Large')
  assert.equal(classifyApiError(error), 'contextLimit', '413 应归 contextLimit，而不是只归到笼统的超大')
})

test('分类：无关的 400 不许被误判成 contextLimit', () => {
  for (const text of NOT_CONTEXT_TEXTS) {
    const error = httpError(400, text)
    // #324 之后这些 400 归到「参数错误」档（依旧不许是 contextLimit，也不许是额度/内容拦截）
    assert.equal(classifyApiError(error), 'badRequest', `误判成上下文超限：${text}`)
    assert.equal(isContextLimitMessage(text), false, `isContextLimitMessage 误判：${text}`)
  }
  // 既有分类不能被带偏
  assert.equal(classifyApiError(httpError(401, 'invalid api key')), 'unauthorized')
  assert.equal(classifyApiError(httpError(429, 'slow down')), 'rateLimited')
  assert.equal(classifyApiError(httpError(503, 'server is busy')), 'serverBusy')
  assert.equal(classifyStatus(413), 'tooLarge', 'classifyStatus 的既有口径不许动（上传等通道还在用）')
  log(`  未误判的原文：${NOT_CONTEXT_TEXTS.length} 条；既有分类（401/429/503）未受影响`)
})

test('分类：上下文超限不可重试（重试解决不了长度问题）', () => {
  for (const text of UPSTREAM_TEXTS) {
    assert.equal(isRetryableApiError(httpError(400, text)), false, `不该重试：${text}`)
  }
  assert.equal(isRetryableApiError(httpError(413, 'Payload Too Large')), false, '413 不该重试')
})

test('文案：上下文超限的提示必须和「未知错误」兜底不同，且能照着做', () => {
  for (const key of Object.keys(zh)) {
    assert.ok(en[key] !== undefined || key.startsWith('__'), `英文少了 key：${key}`)
  }
  const limitText = zh.replyContextLimit
  const unknownText = zh.replyUnknownError
  assert.ok(typeof limitText === 'string' && limitText.length > 0, 'zh 必须有 replyContextLimit')
  assert.ok(typeof en.replyContextLimit === 'string' && en.replyContextLimit.length > 0, 'en 必须有 replyContextLimit')
  assert.notEqual(limitText, unknownText, '上下文超限的文案不能和未知错误一样')
  assert.notEqual(en.replyContextLimit, en.replyUnknownError, '英文同样不能一样')
  // 可操作：告诉用户要么开新会话，要么删几条较早的消息
  assert.match(limitText, /新会话|新的会话/, '中文文案要给出「开新会话」这条路')
  assert.match(limitText, /删|清理/, '中文文案要给出「删几条消息」这条路')

  const reply = (status, message) => ({
    id: 'r1',
    role: 'assistant',
    status: 'error',
    blocks: [],
    error: { kind: 'http', status, message },
    createdAt: 1,
  })
  const limitNotice = describeReply(reply(400, UPSTREAM_TEXTS[0]))
  const otherNotice = describeReply(reply(400, NOT_CONTEXT_TEXTS[0]))
  assert.ok(limitNotice && otherNotice)
  assert.equal(limitNotice.text, limitText, `界面上应给上下文超限文案，实际：${limitNotice.text}`)
  // #324：无关的 400 现在有明确档位（参数错误），不再落到「未知错误」兜底
  assert.equal(otherNotice.text, zh.replyBadRequest, `无关 400 应走参数错误文案，实际：${otherNotice.text}`)
  assert.notEqual(otherNotice.text, unknownText, '普通 400 不该再被说成「未知错误」')
  assert.notEqual(limitNotice.text, otherNotice.text, '两种失败的措辞必须能区分')
  // 英文原文不许直接丢给用户
  assert.ok(!/maximum context length/i.test(limitNotice.text), '上游英文原文不该出现在界面文案里')
  log(`  超限文案：${limitText}`)
  log(`  普通 400 文案：${zh.replyBadRequest}（「未知错误」只留给真未知：${unknownText}）`)
})

test('文案：413 也走同一句可操作提示，不是「超大文件」那套', () => {
  const notice = describeReply({
    id: 'r2',
    role: 'assistant',
    status: 'error',
    blocks: [],
    error: { kind: 'http', status: 413, message: 'Payload Too Large' },
    createdAt: 1,
  })
  assert.ok(notice)
  assert.equal(notice.text, zh.replyContextLimit, `413 应给上下文超限文案，实际：${notice.text}`)
})

const encoder = new TextEncoder()
const TITLE_SSE = [
  `data: ${JSON.stringify({ id: 'chatcmpl-title', choices: [{ index: 0, delta: { content: '会话标题' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: 'chatcmpl-title', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('')

/** 自动标题请求（#127）：给它一段正常流，避免它自己报错干扰本次断言 */
const titleResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(TITLE_SSE))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

let calls = 0
let payload = { status: 400, message: UPSTREAM_TEXTS[0] }

const errorResponse = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

globalThis.fetch = async (_url, init) => {
  let body = {}
  try {
    body = JSON.parse(init?.body ?? '{}')
  } catch {
    body = {}
  }
  // 自动标题请求不算本轮回答请求（标题有专属开关）
  if (body?.title?.enabled === true) {
    return titleResponse()
  }
  calls += 1
  return errorResponse(payload.status, payload.message)
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

const runRound = async ({ status, message }) => {
  payload = { status, message }
  calls = 0
  setRequestTimeout(4000)
  await initChat()
  setApiKey('sk-test-122')
  setDraftText(null, '把上面那段话再展开讲讲')
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
  assert.equal(Object.hasOwn(useChatStore.getState().streaming, sessionId), false, '本轮必须收尾')
  const session = useChatStore.getState().sessionCache[sessionId]
  const reply = session.messages.filter((m) => m.role === 'assistant').at(-1)
  return { calls, reply, notice: describeReply(reply) }
}

test('全链路：上游返回上下文超限，只发一次请求，界面给可操作提示', async () => {
  const { calls: sent, reply, notice } = await runRound({ status: 400, message: UPSTREAM_TEXTS[0] })
  assert.equal(sent, 1, '上下文超限重试也没用，只该发 1 次请求')
  assert.equal(reply.status, 'error')
  assert.equal(reply.error?.status, 400)
  assert.equal(
    reply.error?.localMessage?.key,
    'replyContextLimit',
    `落库的文案 key 应是 replyContextLimit，实际：${JSON.stringify(reply.error?.localMessage)}`
  )
  assert.ok(notice, '必须给出提示')
  assert.equal(notice.text, zh.replyContextLimit, `界面文案：${notice.text}`)
  log(`  全链路：${sent} 次请求，localMessage=${reply.error?.localMessage?.key}，界面「${notice.text}」`)
})

test('全链路：413 同样只发一次请求，提示同一句话', async () => {
  const { calls: sent, reply, notice } = await runRound({ status: 413, message: 'Payload Too Large' })
  assert.equal(sent, 1, '413 也不该重试')
  assert.equal(reply.error?.status, 413)
  assert.ok(notice)
  assert.equal(notice.text, zh.replyContextLimit, `界面文案：${notice.text}`)
})

test('上游原文仍在日志里（不丢证据），但不上界面', async () => {
  __log.records.length = 0
  const { reply } = await runRound({ status: 400, message: UPSTREAM_TEXTS[0] })
  const failed = __log.records.filter((record) => record.message === 'chat stream failed')
  assert.ok(failed.length > 0, '请求失败必须落一条日志')
  const [record] = failed
  assert.equal(record.fields['ui.condition'], 'contextLimit', '日志里的条件分类应是 contextLimit')
  assert.equal(record.fields['ui.notice'], 'replyContextLimit', '日志里的文案 key 应是 replyContextLimit')
  const rawLog = `${record.fields['error.detail'] ?? ''}${record.fields['error.msg'] ?? ''}`
  assert.match(rawLog, /maximum context length/i, '原始报错原文必须留在日志里（error.detail / error.msg）')
  log(`  日志字段：${Object.keys(record.fields).join(',')}`)
  // 落库的 message 仍是原文（归档 / 导入的历史还能靠它重新认出来），只是界面上不展示
  assert.match(String(reply.error?.message ?? ''), /maximum context length/i, '归档里的原文不能丢')
  log(`  日志：ui.condition=${record.fields['ui.condition']} ui.notice=${record.fields['ui.notice']}`)
})

test('识别清单是导出的常量，报告里能逐条列出来', () => {
  assert.ok(Array.isArray(CONTEXT_LIMIT_PATTERNS) && CONTEXT_LIMIT_PATTERNS.length >= 5, '要能列出认得哪些原文特征')
  const listed = CONTEXT_LIMIT_PATTERNS.map((pattern) => pattern.source)
  log(`  认得 ${listed.length} 条原文特征：${listed.join(' | ')}`)
})

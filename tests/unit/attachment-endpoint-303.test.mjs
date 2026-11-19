// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #303：客户端高频请求不存在的 `/v1/chat/completions/files`，404 之后是否还会重试。
// 这里**跑真实 src 代码**（providers / apiConfig / client / attachments / errors / chat store），
// 只把 fetch、IndexedDB、Capacitor、诊断写入口换成替身，断言的是「实际发出的 URL」与
// 「真的发了几次请求」，不靠读代码推断。
//
//   node tests/run-layer.mjs unit --only attachment-endpoint-303
//
// 覆盖：
//   [1] 官方渠道的附件端点 = `{base}/anthropic/v1/files`（不再是 `{messages}/files`）
//   [2] 没有 Files API 的渠道（ours）：本地上报「不支持上传」，**fetch 一次都不发**
//   [3] baseUrl 已带 /v1 时不再拼成 `/v1/v1/...`（joinUrl）
//   [4] 重试策略：4xx（429 除外）一律不重试，429 / 5xx / 超时 / 断网才退避
//   [5] 真实 store：404 只发 1 次，429 与 502 各按上限重试（贴的是真实请求计数）
//   [6] 真实上传任务：404 一次就收尾，且卡片标记为「不可重试」
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

// 打包期注入的常量：标准构建（默认渠道 deepseek 官方），地址用官方域名
globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ = false
globalThis.__log = { records: [], events: [], actions: [] }

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}
const realSetTimeout = globalThis.setTimeout
/** 退避等待压缩到 1ms：只压 1s / 2s 这两个退避值，请求超时预算与首字提示都不动 */
const BACKOFF_DELAYS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, BACKOFF_DELAYS.has(ms) ? 1 : ms, ...args)
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const client = await import('../../src/services/api/client.ts')
const errors = await import('../../src/services/api/errors.ts')
const attachments = await import('../../src/services/attachments.ts')
const { zh } = await import('../../src/i18n/zh.ts')

const { setApiKey, setProviderKind } = apiConfig
const encoder = new TextEncoder()

/** 记录每一次 fetch：URL、方法；两种场景共用同一个出口，避免后定义的替身把前面的盖掉 */
const requests = []
const jsonHandler = { fn: () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }) }
/** 'simple'：单发请求用例；'stream'：走真实 store 的重试用例 */
let mode = 'simple'

const reset = () => {
  requests.length = 0
}

const jsonOk = (body) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const errorResponse = (status, message) => () =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const file = () => new File([new Uint8Array(64)], 'shot.png', { type: 'image/png' })

test('[1] 官方渠道：附件上传/删除都打到 {base}/anthropic/v1/files，不再拼 {messages}/files', async () => {
  setProviderKind('deepseek')
  setApiKey('sk-test-303')
  reset()
  jsonHandler.fn = jsonOk({ id: 'file-api-303', type: 'file' })
  const uploaded = await client.uploadFile('sk-test-303', file(), null)
  assert.equal(uploaded.id, 'file-api-303')
  await client.deleteFile('sk-test-303', 'file-api-303')
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.url}`),
    [
      'POST https://api.deepseek.com/anthropic/v1/files',
      'DELETE https://api.deepseek.com/anthropic/v1/files/file-api-303',
    ],
    '官方渠道的附件端点必须是 Files API，不能挂在 messages 前缀下'
  )
  assert.equal(requests.some((r) => r.url.includes('/anthropic/v1/messages/files')), false)
})

test('[2] 没有 Files API 的渠道：本地判失败，一个请求都不发', async () => {
  setProviderKind('ours')
  setApiKey('sk-test-303')
  assert.equal(client.supportsFileUpload(), false, 'ours 的 spec 没有声明 paths.files')
  assert.equal(client.getUploadUrl(), null)
  reset()
  await assert.rejects(
    () => client.uploadFile('sk-test-303', file(), null),
    (error) => {
      assert.equal(error.name, 'ApiError')
      assert.equal(error.status, undefined, '这是本地判定，不该有 HTTP 状态码')
      assert.equal(error.message, zh.uploadChannelUnsupported)
      return true
    }
  )
  await assert.rejects(() => client.deleteFile('sk-test-303', 'file-api-303'))
  assert.equal(requests.length, 0, '不支持上传的渠道绝不能再猜一个路径去打（#303 的 86% 日志来源）')
  // 附件卡片上要能读到原因，不能只剩泛化的「上传失败」
  const localError = await client.uploadFile('sk', file(), null).catch((e) => e)
  assert.deepEqual(attachments.describeUploadError(localError), { key: 'uploadChannelUnsupported' })
  assert.equal(requests.length, 0, '读文案也不该顺手发一次请求')
})

test('[3] baseUrl 已带 /v1：不再拼成 /v1/v1/...', () => {
  const { joinUrl } = apiConfig
  assert.equal(joinUrl('https://host/v1', '/v1/chat/completions'), 'https://host/v1/chat/completions')
  assert.equal(joinUrl('https://host/v1/', '/v1/models'), 'https://host/v1/models')
  assert.equal(joinUrl('https://host', '/anthropic/v1/messages'), 'https://host/anthropic/v1/messages')
  assert.equal(joinUrl('https://host/anthropic', '/anthropic/v1/files'), 'https://host/anthropic/v1/files')
  // 用户自填渠道实际生效的地址走同一条规则（写入走 setter，读的时候才和线上一致）
  setProviderKind('openai')
  assert.equal(apiConfig.setBaseUrl('https://host/v1'), true)
  assert.equal(apiConfig.getMessagesUrl(), 'https://host/v1/chat/completions')
  assert.equal(apiConfig.getModelsUrl(), 'https://host/v1/models')
})

test('[4] 重试策略：4xx（429 除外）不重试，429 / 5xx / 超时 / 断网才重试', () => {
  const { ApiError } = client
  const { isRetryableApiError, isRetryableStatus } = errors
  const http = (status) => new ApiError('http', 'boom', status)
  for (const status of [400, 401, 403, 404, 405, 409, 413, 422]) {
    assert.equal(isRetryableStatus(status), false, `${status} 不该重试`)
    assert.equal(isRetryableApiError(http(status)), false, `${status} 不该重试`)
  }
  for (const status of [429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, `${status} 该退避重试`)
    assert.equal(isRetryableApiError(http(status)), true)
  }
  // 负向用例：被判成终态的必须是「重发也没用」的那类，超时 / 断网 / 断流仍然重试
  assert.equal(isRetryableApiError(new ApiError('timeout', 'timeout', undefined, 'request_timed_out')), true)
  assert.equal(isRetryableApiError(new ApiError('network', 'fetch failed')), true)
  assert.equal(isRetryableApiError(new ApiError('interrupted', 'cut')), true)
})

// ---------- 真实 store 的重试计数 ----------

const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const ANSWER = [
  chunk({ id: 'chatcmpl-303', model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { role: 'assistant' } }] }),
  chunk({ id: 'chatcmpl-303', choices: [{ index: 0, delta: { content: '重试之后的回答' }, finish_reason: null }] }),
  chunk({ id: 'chatcmpl-303', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
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

let calls = 0
let streamHandler = () => answerResponse()
/** 只有本轮回答请求算数：自动标题也是流式请求（它只给 32 个输出 token） */
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
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  if (mode === 'simple') {
    return jsonHandler.fn(String(url), init)
  }
  if (!isStreamRequest(init)) {
    return answerResponse()
  }
  calls += 1
  return streamHandler(url, init, calls)
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const { useChatStore, initChat, sendMessage } = await import('../../src/services/chat/store.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { setRequestTimeout } = client

const runRound = async (respond) => {
  mode = 'stream'
  streamHandler = respond
  calls = 0
  setRequestTimeout(4000)
  await initChat()
  setApiKey('sk-test-303')
  setDraftText(null, '你好')
  assert.equal(sendMessage(null), true)
  const sessionId = useChatStore.getState().activeId
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      break
    }
    await delay(5)
  }
  const session = useChatStore.getState().sessionCache[sessionId]
  const reply = session.messages.filter((m) => m.role === 'assistant').at(-1)
  return { calls, reply }
}

test('[5] 真实请求计数：404 只发 1 次；429 / 502 才按上限退避重试', async () => {
  const notFound = await runRound(() => errorResponse(404, '404 page not found')())
  assert.equal(notFound.calls, 1, '404 是终态：一次就收尾，不许忙等重试（#303 的放大来源）')
  assert.equal(notFound.reply.status, 'error')

  const limited = await runRound(errorResponse(429, 'rate limited'))
  assert.equal(limited.calls, 3, '429 首次 + 2 次退避重试')

  const busy = await runRound(errorResponse(502, 'bad gateway'))
  assert.equal(busy.calls, 3, '502 首次 + 2 次退避重试')

  const forbidden = await runRound(() => errorResponse(403, 'INSUFFICIENT_BALANCE')())
  assert.equal(forbidden.calls, 1, '403 余额类同样不重试（重发只会再失败一次）')
})

test('[6] 真实上传任务：404 一次收尾，卡片标记不可重试', async () => {
  setProviderKind('deepseek')
  setApiKey('sk-test-303')
  mode = 'simple'
  jsonHandler.fn = errorResponse(404, '404 page not found')
  reset()
  const { uploadAttachment, useUploads } = attachments
  const error = await uploadAttachment('sk-test-303', 'local-303', file(), 'shot.png', true).catch((e) => e)
  assert.equal(error.name, 'ApiError')
  assert.equal(error.status, 404)
  assert.equal(requests.length, 1, '404 只发一次')
  const task = useUploads.getState().tasks['local-303']
  assert.equal(task.status, 'error')
  assert.equal(task.retryable, false, '4xx 在界面上也不该给「点击重试」')
})

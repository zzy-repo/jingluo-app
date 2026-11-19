// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #303 问题 3：上游回 401 之后，客户端还在继续自动打 `/v1/models`，界面上也没有可读提示。
// 这里跑真实 src（client / keyRejection / chat store），断言三件事：
//
//   [1] 401 一旦发生就被记住：自动探测停、诊断里数得出来（且同一次失效只记一条）
//   [2] 换了 Key / 换了地址，判定自动失效（不会把新 Key 一起拦住）
//   [3] 401 之外的失败（403 / 500）不算「Key 判死」
//   [4] 真实 store：聊天 401 只发 1 次，界面文案是「Key 无效或已过期」，不再是上游原文
//
//   node tests/run-layer.mjs unit --only key-rejection-303
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

/** 替身再包一层：chat store 的依赖链里还用到 recordError */
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
const BACKOFF_DELAYS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, BACKOFF_DELAYS.has(ms) ? 1 : ms, ...args)
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const client = await import('../../src/services/api/client.ts')
const keyRejection = await import('../../src/services/api/keyRejection.ts')
const { zh } = await import('../../src/i18n/zh.ts')

const { setApiKey, setBaseUrl, setProviderKind } = apiConfig
const { isKeyRejected, shouldAutoProbe, clearKeyRejection, useKeyRejection } = keyRejection

const requests = []
/** 探测/校验类请求的应答（非 chat 路径） */
let status = 200
let body = '{}'
/** 聊天流式请求的应答模式：'ok' | '401' */
let chatMode = 'ok'
const encoder = new TextEncoder()

const chunk = (payload) => `data: ${JSON.stringify(payload)}\\n\\n`
const answerResponse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              chunk({ id: 'c303', model: 'm', choices: [{ index: 0, delta: { content: 'ok' } }] }),
              'data: [DONE]\\n\\n',
            ].join('')
          )
        )
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 唯一出口：后定义的替身不能把前面的盖掉 */
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  if (!String(url).endsWith('/chat/completions')) {
    return new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
  }
  if (chatMode === 'ok') {
    return answerResponse()
  }
  return new Response(JSON.stringify({ error: { message: 'Invalid API key provided' } }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  })
}

const reset = () => {
  requests.length = 0
  status = 200
  body = '{}'
  chatMode = 'ok'
  globalThis.__log.records.length = 0
  globalThis.__log.events.length = 0
  clearKeyRejection()
}

const rejectionRecords = () =>
  globalThis.__log.records.filter((entry) => entry.message === 'api key rejected')

test('[1] 401 之后：自动探测停、诊断记一条（重复 401 不刷日志）', async () => {
  reset()
  setProviderKind('openai')
  setBaseUrl('https://gateway.invalid/v1')
  setApiKey('sk-expired-303')
  assert.equal(shouldAutoProbe(), true, '新 Key 没有被判过，自动探测照常')

  status = 401
  body = JSON.stringify({ error: { message: 'Invalid API key' } })
  const result = await client.probeProvider({ baseUrl: 'https://gateway.invalid/v1', apiKey: 'sk-expired-303' })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.equal(isKeyRejected(), true, '401 之后必须处于「Key 判死」状态')
  assert.equal(shouldAutoProbe(), false, '自动探测必须停下（#303 问题 3）')

  // 再被判一次（模拟用户又打开一次设置页）：状态不变，诊断也只多一条
  await client.probeProvider({ baseUrl: 'https://gateway.invalid/v1', apiKey: 'sk-expired-303' }).catch(() => {})
  await client.verifyApiKey('sk-expired-303').catch(() => {})
  const records = rejectionRecords()
  assert.equal(records.length, 1, '同一次失效只记一条，不许被重复请求刷满日志')
  assert.equal(records[0].fields['http.status'], 401)
  assert.equal(records[0].fields.host, 'gateway.invalid')
  assert.equal(records[0].fields.stage, 'probe', '第一条来自模型探测这条路')
  // 指纹里不能出现 Key 原文
  assert.equal(JSON.stringify(records[0]).includes('sk-expired-303'), false)
})

test('[2] 换 Key / 换地址后判定自动失效', async () => {
  reset()
  setProviderKind('openai')
  setBaseUrl('https://gateway.invalid/v1')
  setApiKey('sk-expired-303')
  status = 401
  await client.verifyApiKey('sk-expired-303').catch(() => {})
  assert.equal(isKeyRejected(), true)

  setApiKey('sk-fresh-303')
  assert.equal(isKeyRejected(), false, '换了 Key 就不该再被旧判定拦住')
  assert.equal(shouldAutoProbe(), true)

  // 同 Key 换地址同理（另一台网关的判定不能串台）
  setApiKey('sk-expired-303')
  assert.equal(isKeyRejected(), true)
  setBaseUrl('https://other-gateway.invalid/v1')
  assert.equal(isKeyRejected(), false)
  assert.equal(useKeyRejection.getState().rejection !== null, true, '状态本身还在，只是指纹不匹配')
})

test('[3] 403 / 500 不算「Key 判死」', async () => {
  reset()
  setProviderKind('openai')
  setBaseUrl('https://gateway.invalid/v1')
  setApiKey('sk-broke-303')
  status = 403
  body = JSON.stringify({ error: { message: 'INSUFFICIENT_BALANCE' } })
  await client.verifyApiKey('sk-broke-303').catch(() => {})
  assert.equal(isKeyRejected(), false, '403 是权限/余额，不是 Key 失效')
  status = 500
  await client.verifyApiKey('sk-broke-303').catch(() => {})
  assert.equal(isKeyRejected(), false, '5xx 是上游故障，不能判成 Key 失效')
  assert.equal(rejectionRecords().length, 0)
})

// ---------- 真实 store：聊天 401 ----------

const streamRequests = () => requests.filter((entry) => entry.url.endsWith('/chat/completions'))

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const { useChatStore, initChat, sendMessage } = await import('../../src/services/chat/store.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')

test('[4] 真实聊天 401：只发 1 次，界面文案是「Key 无效或已过期」', async () => {
  reset()
  setProviderKind('openai')
  setBaseUrl('https://gateway.invalid/v1')
  setApiKey('sk-expired-303')
  client.setRequestTimeout(4000)
  chatMode = '401'
  await initChat()
  setDraftText(null, '你好')
  assert.equal(sendMessage(null), true)
  const sessionId = useChatStore.getState().activeId
  const deadline = Date.now() + 12000
  while (Date.now() < deadline && Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
    await delay(5)
  }
  assert.equal(streamRequests().length, 1, '401 是终态：一次就收尾，不重试')
  const session = useChatStore.getState().sessionCache[sessionId]
  const reply = session.messages.filter((message) => message.role === 'assistant').at(-1)
  assert.equal(reply.status, 'error')
  assert.equal(reply.error.localMessage.key, 'apiKeyRejected')
  assert.equal(zh.apiKeyRejected, 'Key 无效或已过期，请重新登录或重新填写')
  const failed = globalThis.__log.records.filter((entry) => entry.message === 'chat stream failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].fields['ui.notice'], 'apiKeyRejected')
  assert.equal(isKeyRejected(), true)
  assert.equal(shouldAutoProbe(), false)
})

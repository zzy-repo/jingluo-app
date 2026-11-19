// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #397：窗口记忆的 embedding 请求收进 app 的 API 层。
//
// 这里**跑真实 src 代码**：`services/api/embedding.ts`（API 层出口）+ `services/memory/embedding.js`
// （记忆侧客户端）+ `apiConfig` / `client` / `errors` / `providers`。只把 fetch、localStorage、
// Capacitor、诊断写入口换成替身，断言的是「实际发出的 URL / 请求头 / 请求体」与
// 「失败时返回空向量 + 可诊断原因」，不靠读代码推断。
//
//   node tests/run-layer.mjs unit --only memory-embedding-api
//
// 覆盖（对应 #397 的关闭条件）：
//   [1] 成功：地址 = 渠道 baseUrl + spec.paths.embedding（joinUrl 去重），鉴权头来自 spec.auth
//   [2] 无配置：没 Key / 渠道没有 embedding 端点 → 空向量 + 原因，**一次请求都不发**
//   [3] HTTP 4xx / 5xx：带上状态码与 classifyApiError 的结论，空向量，不抛错
//   [4] 超时：走 request() 的预算，收敛成 reason='timeout'，不抛错
//   [5] 维度不一致：同批维度不同 / 与已探测维度不同 → reason='dimension-mismatch'，空向量
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

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
      // 与打包器一致（rspack 的 extensionAlias）：源码内部用 .js 说明符指向 .ts 文件
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

// 构建期注入的常量：单测没有 rspack 的 DefinePlugin，先挂到全局再 import
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.__INTERNAL_BUILD__ = false
globalThis.__log = { records: [], events: [], actions: [] }

const memoryStore = new Map()
globalThis.localStorage = {
  getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
  setItem: (key, value) => memoryStore.set(key, String(value)),
  removeItem: (key) => memoryStore.delete(key),
}

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const apiEmbedding = await import('../../src/services/api/embedding.ts')
const memoryEmbedding = await import('../../src/services/memory/embedding.js')

const { setApiKey, setBaseUrl, setProviderKind, setModel } = apiConfig
const { embedTexts, resolveEmbeddingChannel } = apiEmbedding
const { client, EmbeddingClient } = memoryEmbedding

/** 记录每一次 fetch：方法 + URL + 请求头 + 请求体 */
const requests = []
let handler = () => new Response('{}', { status: 200 })

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  const entry = {
    method: (init.method ?? 'GET').toUpperCase(),
    url: String(url),
    headers: { ...(init.headers ?? {}) },
    body: init.body,
    signal: init.signal,
  }
  requests.push(entry)
  return handler(url, init)
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }
const jsonResponse = (body, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

const reset = () => {
  requests.length = 0
  handler = jsonResponse({})
}

/** 一条 OpenAI 兼容的 /embeddings 响应（故意打乱顺序：上游不保证 index 顺序） */
const embeddingResponse = (vectors) => () =>
  jsonResponse({
    object: 'list',
    data: vectors
      .map((embedding, index) => ({ object: 'embedding', index, embedding }))
      .reverse(),
  })()

/** 把渠道配成「OpenAI 兼容 + 地址 + Key」，并把记忆侧模型名设好 */
const useOpenAiChannel = ({ baseUrl = 'https://embed.test.invalid/v1', model = 'test-embed-1' } = {}) => {
  setProviderKind('openai')
  setBaseUrl(baseUrl)
  setModel('chat-model-of-channel')
  setApiKey('sk-test-397')
  client.configure({ model })
  client._dimensions = 0
  client._ready = false
}

test('[1] 成功：地址 = 渠道 baseUrl + spec.paths.embedding，鉴权头来自 spec.auth（Bearer）', async () => {
  reset()
  useOpenAiChannel()
  handler = embeddingResponse([
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ])

  const result = await client.embedBatch(['第一段', '第二段'])

  assert.equal(result.ok, true)
  assert.deepEqual(result.vectors, [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
  ])
  // 地址：baseUrl 已带 /v1，joinUrl 不会拼成 /v1/v1/embeddings（#303 的同一条口径）
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'POST')
  assert.equal(requests[0].url, 'https://embed.test.invalid/v1/embeddings')
  // 鉴权头来自 authHeaders()：openai 渠道 spec.auth = 'bearer'
  assert.deepEqual(requests[0].headers, {
    Authorization: 'Bearer sk-test-397',
    'Content-Type': 'application/json',
  })
  // 请求体只带模型与输入：模型是记忆侧传的，不是渠道里的对话模型
  assert.deepEqual(JSON.parse(requests[0].body), { model: 'test-embed-1', input: ['第一段', '第二段'] })
  // 探测维度后 ready / dimensions 跟着更新
  assert.equal(client.dimensions, 4)
  assert.equal(client.ready, true)
})

test('[2] 无配置：没 Key / 渠道没有 embedding 端点 → 空向量 + 原因，一次请求都不发', async () => {
  reset()
  useOpenAiChannel()
  setApiKey('')
  assert.equal(client.configured, false)
  assert.equal(client.configReason, 'missing-api-key')
  const noKey = await client.embedBatch(['任意文本'])
  assert.deepEqual(noKey, {
    ok: false,
    vectors: [],
    reason: 'missing-api-key',
    detail: '未配置 API Key（渠道 openai）',
  })

  // DeepSeek 官方 / Anthropic 协议没有 /embeddings：本地失败，不许猜一个端点去打（#303 的教训）
  setApiKey('sk-test-397')
  setProviderKind('deepseek')
  assert.equal(resolveEmbeddingChannel('test-embed-1').reason, 'channel-unsupported')
  const unsupported = await client.embedBatch(['任意文本'])
  assert.equal(unsupported.ok, false)
  assert.deepEqual(unsupported.vectors, [])
  assert.equal(unsupported.reason, 'channel-unsupported')

  const probe = await client.probe()
  assert.equal(probe.ok, false)
  assert.equal(probe.reason, 'channel-unsupported')

  assert.equal(requests.length, 0, '不可用时不许发出任何请求')
})

test('[3] HTTP 4xx / 5xx：空向量 + 状态码 + classifyApiError 的结论，不抛错', async () => {
  reset()
  useOpenAiChannel()

  handler = () => new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
    status: 401,
    headers: JSON_HEADERS,
  })
  const unauthorized = await client.embedBatch(['任意文本'])
  assert.equal(unauthorized.ok, false)
  assert.deepEqual(unauthorized.vectors, [])
  assert.equal(unauthorized.reason, 'http-401')
  assert.match(unauthorized.detail, /unauthorized/, 'detail 里要带 classifyApiError 的结论，便于诊断')

  handler = () => new Response(JSON.stringify({ error: { message: 'upstream exploded' } }), {
    status: 503,
    headers: JSON_HEADERS,
  })
  const serverBusy = await embedTexts({ model: 'test-embed-1', input: ['任意文本'] })
  assert.equal(serverBusy.ok, false)
  assert.deepEqual(serverBusy.vectors, [])
  assert.equal(serverBusy.reason, 'http-503')
  assert.equal(serverBusy.status, 503)
  assert.match(serverBusy.detail, /serverBusy/)

  // 上游把网页当接口数据返回（路径不匹配 / 网关报错页）：不解析成向量
  handler = () => new Response('<html>not found</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
  const html = await client.embedBatch(['任意文本'])
  assert.equal(html.ok, false)
  assert.deepEqual(html.vectors, [])
  assert.equal(html.reason, 'malformed-response')
})

test('[4] 超时：request() 的预算内没拿到响应头 → reason=timeout，不抛错', async () => {
  reset()
  useOpenAiChannel()
  handler = (_url, init) =>
    new Promise((_resolve, reject) => {
      // 上游把连接晾着：只有 abort 时才收尾（与 api-request-timeout.test.mjs 同一形态）
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })

  const started = Date.now()
  const result = await embedTexts({ model: 'test-embed-1', input: ['任意文本'], timeoutMs: 40 })
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.deepEqual(result.vectors, [])
  assert.equal(result.reason, 'timeout')
  assert.ok(elapsed < 5000, `应在自带的 40ms 预算附近收口，实际 ${elapsed}ms`)
})

test('[5] 维度不一致：与已探测维度不同 / 同批之间不同 → 空向量 + dimension-mismatch', async () => {
  reset()
  useOpenAiChannel()
  handler = embeddingResponse([[1, 0, 0, 0]])
  const probed = await client.probe()
  assert.deepEqual(probed, { ok: true, dimensions: 4 })
  assert.equal(client.dimensions, 4)

  // 模型被换掉：返回 3 维。混进同一个索引会算出无意义的余弦，必须判失败
  handler = embeddingResponse([[1, 0, 0]])
  const switched = await client.embedBatch(['任意文本'])
  assert.equal(switched.ok, false)
  assert.deepEqual(switched.vectors, [])
  assert.equal(switched.reason, 'dimension-mismatch')
  assert.match(switched.detail, /期望 4 维，实际 3 维/)

  // 同批之间维度不一致（没有已探测维度也要拦住）
  const fresh = new EmbeddingClient()
  fresh.configure({ model: 'test-embed-1' })
  handler = () =>
    jsonResponse({
      data: [
        { index: 0, embedding: [1, 0, 0, 0] },
        { index: 1, embedding: [0, 1, 0] },
      ],
    })()
  const mixed = await fresh.embedBatch(['第一条', '第二条'])
  assert.equal(mixed.ok, false)
  assert.deepEqual(mixed.vectors, [])
  assert.equal(mixed.reason, 'dimension-mismatch')
  assert.equal(fresh.ready, false)
})

// 兜底：任何一条失败路径都不许把异常抛给调用方（关闭条件 3：不抛错、不阻塞对话）
test('[6] 所有失败路径都不抛错：记忆侧拿到的永远是对象', async () => {
  reset()
  useOpenAiChannel()
  const cases = [
    () => new Response('{}', { status: 500, headers: JSON_HEADERS }),
    () => {
      throw new TypeError('Failed to fetch')
    },
    () => new Response('not json', { status: 200, headers: JSON_HEADERS }),
    () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: JSON_HEADERS }),
  ]
  for (const next of cases) {
    handler = next
    const result = await client.embedBatch(['任意文本'])
    assert.equal(result.ok, false)
    assert.deepEqual(result.vectors, [])
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, '失败必须带可诊断原因')
  }
  globalThis.fetch = realFetch
})

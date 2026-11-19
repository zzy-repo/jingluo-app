// [layer: unit(L1 口径) | 依赖: 无（纯 Node；fetch / Capacitor 打桩，零真实网络） | 耗时: <2s]
//
// #362 / #367 · 域 3 最小充分集 · N3-B「探测协议矩阵」（L1，一张表 21 行）
//
// 为什么必须有这条：现存 `model-probe-status.test.mjs` 在用例内**自实现**了 status→reason 映射，
// 4 条断言打在测试自己的箭头函数上，对产品代码零约束（附录 B-2）。这里直接 import 真
// `probeProvider`（src/services/api/client.ts:651），断言它真实的六档 reason、鉴权头与双传输分支。
//
// 覆盖功能点：
//   F3-03 请求路径与鉴权头按渠道 —— 同一份 spec 同时决定路径与头（deepseek / anthropic / openai / ours）
//   F3-05 API Key 校验与探测 —— 非 2xx 的 message 取上游 error.message；401 记一次「Key 判死」
//   F3-06 探测失败文案分类（六档）—— invalid / timeout / network / html / json / http 各有专属 reason
//   F3-07 模型列表拉取 —— data / models / model_list / result / 顶层数组五种形状 + 空列表
//
// 跑法：
//   node tests/run-layer.mjs unit --only provider-probe-matrix
//   node --test tests/unit/provider-probe-matrix.test.mjs
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

import { chatBaseUrl, legacyHosts } from '../../scripts/lib/endpoints.mjs'

const fixture = (name) => new URL(`../fixtures/domain03-04/${name}`, import.meta.url).href
const collectorStub = new URL('../fixtures/domain03-04/collector.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: fixture('capacitor.mjs'), shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: collectorStub, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
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
globalThis.__nativePlatform = false
globalThis.__nativeCalls = []
globalThis.__nativeGet = undefined

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
}

const cfg = await import('../../src/services/api/apiConfig.ts')
const client = await import('../../src/services/api/client.ts')
const rejection = await import('../../src/services/api/keyRejection.ts')

const KEY = 'sk-probe-matrix-key'
const BASE = 'https://relay.example.com'
const RELAY_OFFICIAL = 'https://api.deepseek.com'

/** 记录 fetch 收包：只看「打到哪、带了什么头」，不真发请求 */
const calls = []
let handler = () => new Response('{}', { status: 200 })
const abortable = (promise, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(resolve, reject)
  })

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method, headers: init.headers ?? {}, signal: init.signal })
  const response = handler(url, init)
  // 真 fetch 在 AbortController 中止时会 reject（probeProvider 靠这个区分 timeout 与 network）
  return init.signal ? abortable(response, init.signal) : response
}

const json = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
const html = (status = 200) =>
  new Response('<!doctype html><title>502 Bad Gateway</title>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

/** 一行 = 一个渠道 + 一个上游响应；断言真 probeProvider 的返回值 */
const seed = (kind) => {
  memory.clear()
  globalThis.__log = { records: [], events: [], actions: [] }
  calls.length = 0
  globalThis.__nativePlatform = false
  globalThis.__nativeCalls.length = 0
  globalThis.__nativeGet = undefined
  rejection.clearKeyRejection()
  cfg.useApiConfig.setState({ kind, apiKey: KEY, baseUrl: '', model: '' })
  memory.set('chat-demo:provider-kind', kind)
  memory.set('chat-demo:api-key', KEY)
  return kind
}

/** 六档 reason 的期望值：ok 为真时 reason 必须缺省 */
/** HTTP 头大小写不敏感：源码里写的是 `Authorization`，断言按小写取 */
const headerOf = (headers, name) => {
  const key = Object.keys(headers ?? {}).find((item) => item.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : headers[key]
}

const expectProbe = (actual, expected) => {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `${key} 不符（实际 ${JSON.stringify(actual)}）`)
  }
}

test('N3-B 探测协议矩阵（表驱动 21 行）', async (t) => {
  // ---------- F3-05 / F3-06：非法地址在本地被拦下，一个请求都不发 ----------
  await t.test('[1] F3-06 invalid：地址不合法 → reason=invalid，fetch 一次都不发', async () => {
    seed('openai')
    const result = await client.probeProvider({ baseUrl: 'relay.example.com', apiKey: KEY })
    expectProbe(result, { ok: false, reason: 'invalid', models: [] })
    assert.equal(calls.length, 0, '地址不合法时不许发请求（否则会打到构建默认地址上）')
  })

  // ---------- F3-07：五种模型列表形状 + 空列表 ----------
  const shapes = [
    { id: '2', name: 'data[]（OpenAI 官方）', body: { data: [{ id: 'm-a' }, { id: 'm-b' }] }, models: ['m-a', 'm-b'] },
    { id: '3', name: 'models[]（Anthropic 兼容）', body: { models: [{ id: 'claude-a' }] }, models: ['claude-a'] },
    { id: '4', name: 'model_list[]（部分中转）', body: { model_list: [{ name: 'relay-x' }] }, models: ['relay-x'] },
    { id: '5', name: 'result[]（部分中转）', body: { result: [{ model: 'wrapped-y' }] }, models: ['wrapped-y'] },
    { id: '6', name: '顶层数组 + 纯字符串项', body: ['plain-a', { id: 'obj-b' }], models: ['plain-a', 'obj-b'] },
  ]
  for (const row of shapes) {
    await t.test(`[${row.id}] F3-07 200 + ${row.name} → ok，models 解析为 ${row.models.join(',')}`, async () => {
      seed('openai')
      handler = () => json(row.body)
      const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
      expectProbe(result, { ok: true, status: 200, models: row.models })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `${BASE}/v1/models`, 'openai 渠道的模型列表路径来自 spec.paths.models')
    })
  }

  await t.test('[7] F3-06 okEmpty：200 但没有任何列表 → ok 且 models=[]', async () => {
    seed('openai')
    handler = () => json({})
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
    expectProbe(result, { ok: true, status: 200, models: [] })
  })

  // ---------- F3-06：其余五档失败分类 ----------
  await t.test('[8] F3-06 html：200 + text/html → reason=html（不能当接口数据解析）', async () => {
    seed('openai')
    handler = () => html(200)
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
    expectProbe(result, { ok: false, status: 200, reason: 'html', models: [] })
  })

  await t.test('[9] F3-06 json：200 + 声明 JSON 但正文不是 JSON → reason=json，原文截断进 message', async () => {
    seed('openai')
    handler = () => json('{"data": [broken')
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
    expectProbe(result, { ok: false, status: 200, reason: 'json', models: [] })
    assert.match(result.message, /broken/, 'message 要带上原文，方便用户/日志判断上游到底说了什么')
    assert.ok(result.message.length <= 200, 'message 必须截断（避免把整页 HTML/错误页塞进界面）')
  })

  await t.test('[10] F3-05/F3-06 http 401：message 取上游 error.message，并且记一次「Key 判死」', async () => {
    seed('openai')
    handler = () => json({ error: { message: 'Invalid API Key' } }, 401)
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
    expectProbe(result, { ok: false, status: 401, reason: 'http', models: [], message: 'Invalid API Key' })
    assert.equal(rejection.isKeyRejected(), true, '401 必须让「自动探测」停下来（#303 问题 3）')
    assert.equal(
      rejection.useKeyRejection.getState().rejection?.stage,
      'probe',
      '判死来源要标成 probe，日志里才分得清是哪条链路先发现的'
    )
  })

  await t.test('[11] F3-06 http 500：非 2xx 且正文不是 JSON 错误体 → 原样展示正文', async () => {
    seed('openai')
    handler = () => new Response('gateway boom', { status: 500, headers: { 'content-type': 'text/plain' } })
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
    expectProbe(result, { ok: false, status: 500, reason: 'http', models: [], message: 'gateway boom' })
    assert.equal(rejection.isKeyRejected(), false, '只有 401 才改「Key 是否有效」的判断')
  })

  await t.test('[12] F3-06 network：fetch 抛错（断网 / 跨域被拦）→ reason=network 且不带状态码', async () => {
    seed('openai')
    handler = () => {
      throw new TypeError('Failed to fetch')
    }
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY })
    expectProbe(result, { ok: false, reason: 'network', models: [], message: 'Failed to fetch' })
    assert.equal(result.status, undefined, '网络错误不能凭空造一个 HTTP 状态码')
  })

  await t.test('[13] F3-06 timeout：上游不响应 → reason=timeout（不再是 network/http）', async () => {
    seed('openai')
    handler = () => new Promise(() => {})
    const result = await client.probeProvider({ baseUrl: BASE, apiKey: KEY }, 25)
    expectProbe(result, { ok: false, reason: 'timeout', models: [] })
    assert.equal(result.status, undefined)
  })

  // ---------- F3-03：同一份 spec 同时决定「路径」与「鉴权头」 ----------
  const authRows = [
    {
      id: '14',
      channel: 'deepseek（官方地址）',
      kind: 'deepseek',
      baseUrl: RELAY_OFFICIAL,
      url: `${RELAY_OFFICIAL}/models`,
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      forbidden: ['authorization'],
    },
    {
      id: '15',
      channel: 'deepseek（自填中转地址）',
      kind: 'deepseek',
      baseUrl: BASE,
      url: `${BASE}/models`,
      headers: { 'x-api-key': KEY },
      forbidden: ['authorization', 'anthropic-version'],
    },
    {
      id: '16',
      channel: 'anthropic',
      kind: 'anthropic',
      baseUrl: BASE,
      url: `${BASE}/v1/models`,
      headers: { 'x-api-key': KEY },
      forbidden: ['authorization', 'anthropic-version'],
    },
    {
      id: '17',
      channel: 'openai',
      kind: 'openai',
      baseUrl: BASE,
      url: `${BASE}/v1/models`,
      headers: { authorization: `Bearer ${KEY}` },
      forbidden: ['x-api-key', 'anthropic-version'],
    },
    {
      id: '18',
      channel: 'ours',
      kind: 'ours',
      baseUrl: chatBaseUrl,
      url: `${chatBaseUrl}/v1/models`,
      headers: { authorization: `Bearer ${KEY}` },
      forbidden: ['x-api-key', 'anthropic-version'],
    },
  ]
  for (const row of authRows) {
    await t.test(`[${row.id}] F3-03 ${row.channel}：GET ${row.url} + 对应鉴权头`, async () => {
      seed(row.kind)
      handler = () => json({ data: [{ id: 'x' }] })
      const result = await client.probeProvider({ baseUrl: row.baseUrl, apiKey: KEY })
      expectProbe(result, { ok: true, status: 200 })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, row.url, '路径与鉴权头必须来自同一份 spec')
      for (const [name, value] of Object.entries(row.headers)) {
        assert.equal(headerOf(calls[0].headers, name), value, `${name} 头不符`)
      }
      for (const name of row.forbidden) {
        assert.equal(headerOf(calls[0].headers, name), undefined, `${row.channel} 不该带 ${name} 头`)
      }
    })
  }

  // ---------- F3-03 / F3-06：原生传输分支（CapacitorHttp） ----------
  await t.test('[19] F3-03 native 200：走 CapacitorHttp.get，不碰 fetch；列表同样解析', async () => {
    seed('ours')
    globalThis.__nativePlatform = true
    globalThis.__nativeGet = () => ({
      status: 200,
      data: { data: [{ id: 'native-model' }] },
    })
    const result = await client.probeProvider({ baseUrl: chatBaseUrl, apiKey: KEY })
    expectProbe(result, { ok: true, status: 200, models: ['native-model'] })
    assert.equal(calls.length, 0, '原生平台不该走 fetch（WebView 里没有 CORS，直连会全红）')
    assert.equal(globalThis.__nativeCalls.length, 1)
    assert.equal(globalThis.__nativeCalls[0].url, `${chatBaseUrl}/v1/models`)
    assert.equal(headerOf(globalThis.__nativeCalls[0].headers, 'authorization'), `Bearer ${KEY}`)
  })

  await t.test('[20] F3-05/F3-06 native 401：同样判 http 并记「Key 判死」', async () => {
    seed('ours')
    globalThis.__nativePlatform = true
    globalThis.__nativeGet = () => ({
      status: 401,
      data: { error: { message: 'native says no' } },
    })
    const result = await client.probeProvider({ baseUrl: chatBaseUrl, apiKey: KEY })
    expectProbe(result, { ok: false, status: 401, reason: 'http', message: 'native says no' })
    assert.equal(rejection.isKeyRejected(), true)
  })

  await t.test('[21] F3-06 native 超时：原生桥不返回 → reason=timeout（Promise.race 兜底）', async () => {
    seed('ours')
    globalThis.__nativePlatform = true
    globalThis.__nativeGet = () => new Promise(() => {})
    const result = await client.probeProvider({ baseUrl: chatBaseUrl, apiKey: KEY }, 25)
    expectProbe(result, { ok: false, reason: 'timeout', models: [] })
  })
})

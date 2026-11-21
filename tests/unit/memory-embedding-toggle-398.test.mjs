// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #398：设置页 embedding 开关 —— **默认关闭；关闭后零外部请求**。
//
// 这里**跑真代码**：`services/settings.ts`（开关状态的唯一存储）+ `services/memory/embeddingGate.ts`
// （门 / 唯一判定）+ `services/api/embedding.ts`（#397 收进 API 层的请求出口）。
// 只把 `fetch`、`localStorage`、Capacitor、诊断写入口换成替身，断言落在
// **真的调用次数**上（`fetchCalls`），而不是读源码推断。
//
//   node tests/run-layer.mjs unit --only memory-embedding-toggle-398
//
// 覆盖（对应 #398 的关闭条件，表驱动）：
//   T1 默认值：从没存过值 → 开关为 false；脏值（'1' / 'TRUE' / 空串）也回落到 false
//   T2 关闭态：`embed()` → **抛 EmbeddingDisabledError（code=embedding-disabled）**，且 `fetchCalls === 0`
//   T3 打开后：`embed()` → 真的发出请求（`fetchCalls >= 1`）并按上游返回向量
//   T4 持久化：用户关掉 / 打开后冷启动读回仍是他的选择（同一个 `chat-demo:memory-embedding` 键）
//   T5 正对照：**绕开门**直连出口会发请求 —— 证明 T2 的 0 是门挡出来的，不是「渠道没配好」的巧合
//
// 负向对照（人工跑过一次，结论写在本文件末与 PR 里）：把 `embeddingGate.ts` 里
// `if (!isEmbeddingEnabled()) { throw ... }` 那两行删掉，T2 立刻变红（`fetchCalls` 从 0 变 1）。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）
// 也不会 `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chatCollectorStub,
  fixtureUrl,
  installEndpointsGlobals,
  installTsResolve,
} from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：`.js→.ts` 解析 + Capacitor / 诊断写入口替身。
// 顺序要紧：hook 必须先于任何 `src/**` 的（动态）import 装好。
installTsResolve({
  stubs: { '@capacitor/core': fixtureUrl('chat-stubs/capacitor.mjs') },
  onResolve: (specifier) =>
    /diagnostics\/collector\.js$/u.test(specifier) ? chatCollectorStub() : undefined,
})
installEndpointsGlobals({ apiOrigin: 'https://api.test.invalid' })

/** 最小 localStorage：settings.ts / apiConfig.ts 只做 get / set / remove */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
}

/** 每一次 fetch 都记一笔 —— #398 的硬断言（关闭态 0 次）就落在这个数组的长度上 */
const fetchCalls = []
let handler = () => new Response('{}', { status: 200 })
globalThis.fetch = async (url, init = {}) => {
  fetchCalls.push({ method: (init.method ?? 'GET').toUpperCase(), url: String(url), body: init.body })
  return handler(url, init)
}

const settingsUrl = new URL('../../src/services/settings.ts', import.meta.url).href
const settings = await import(settingsUrl)
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const apiEmbedding = await import('../../src/services/api/embedding.ts')
const gate = await import('../../src/services/memory/embeddingGate.ts')

/**
 * 冷启动：同一个模块换一个 URL 再导入一次，等价于「关掉应用重开」后重新初始化 store。
 * 每次都先清空存储，保证读到的是本行 seed 的那份内容。
 */
let bootCount = 0
const coldStart = async (entries = []) => {
  storage.clear()
  for (const [key, value] of entries) {
    storage.set(key, value)
  }
  bootCount += 1
  return import(`${settingsUrl}?boot=${bootCount}`)
}

const ENABLED_KEY = 'chat-demo:memory-embedding'

/** 一条 OpenAI 兼容的 /embeddings 响应 */
const embeddingResponse = (vectors) => () =>
  new Response(
    JSON.stringify({
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )

/** 把渠道配成「OpenAI 兼容 + 地址 + Key」：这是唯一声明了 /embeddings 的渠道（#397） */
const useOpenAiChannel = () => {
  apiConfig.setProviderKind('openai')
  apiConfig.setBaseUrl('https://embed.test.invalid/v1')
  apiConfig.setModel('chat-model-of-channel')
  apiConfig.setApiKey('sk-test-398')
}

const reset = () => {
  fetchCalls.length = 0
  handler = () => new Response('{}', { status: 200 })
}

/**
 * T1 表：存了什么东西 → 冷启动后开关应当是几。
 * 未存过值 / 脏值都必须落到 false：读不出设置不等于「用户同意联网」。
 */
const DEFAULT_CASES = [
  { id: 'T1-a', label: '从没存过值（默认）', seed: [], expect: false },
  { id: 'T1-b', label: '用户打开过（true）', seed: [[ENABLED_KEY, 'true']], expect: true },
  { id: 'T1-c', label: '用户关掉过（false）', seed: [[ENABLED_KEY, 'false']], expect: false },
  { id: 'T1-d', label: '脏值 1', seed: [[ENABLED_KEY, '1']], expect: false },
  { id: 'T1-e', label: '脏值 TRUE（大小写变体）', seed: [[ENABLED_KEY, 'TRUE']], expect: false },
  { id: 'T1-f', label: '脏值空串', seed: [[ENABLED_KEY, '']], expect: false },
]

test('T1 默认关闭：从没存过值 / 脏值一律 false（唯一来源 services/settings.ts）', async () => {
  for (const row of DEFAULT_CASES) {
    const mods = await coldStart(row.seed)
    assert.equal(
      mods.useSettings.getState().embeddingEnabled,
      row.expect,
      `${row.id} ${row.label}：embeddingEnabled 应为 ${row.expect}`
    )
  }
  // 判定出口（门）与 store 是同一个值，不存在第二份判断
  storage.clear()
  assert.equal(gate.isEmbeddingEnabled(), false, '没存过值时 isEmbeddingEnabled() 必须是 false')
  settings.setEmbeddingEnabled(true)
  assert.equal(gate.isEmbeddingEnabled(), true, '打开后 isEmbeddingEnabled() 跟着变（只有这一个判定）')
  settings.setEmbeddingEnabled(false)
  assert.equal(gate.isEmbeddingEnabled(), false, '关掉后立刻回到 false')
})

test('T2 关闭态：embed() 抛明确的「未启用」，且 fetchCalls === 0（一个请求都没有）', async () => {
  reset()
  // 关键：渠道是**配好的**（地址 / Key / 端点齐全）。这样「没发请求」只可能是门挡下来的，
  // 而不是「本来就没配好所以发不出去」—— 后者会让这条断言变成假绿。
  useOpenAiChannel()
  settings.setEmbeddingEnabled(false)
  assert.equal(apiEmbedding.resolveEmbeddingChannel('test-embed-1').configured, true, '对照组前提：渠道可用')

  await assert.rejects(
    () => gate.embed({ input: ['第一段'], model: 'test-embed-1' }),
    (error) => {
      assert.equal(error.name, 'EmbeddingDisabledError', '要抛专用的错，不是 TypeError / 网络错')
      assert.equal(error.code, 'embedding-disabled', '错误码固定，调用方按码判断而不是 match 中文')
      assert.match(error.message, /未启用/u, '文案要说得出口「未启用」，不能是空结果')
      return true
    }
  )
  assert.equal(fetchCalls.length, 0, '关闭态必须是零外部请求 —— 一个都不许发')
})

test('T3 打开后：embed() 真的发请求（fetchCalls >= 1）并拿回向量', async () => {
  reset()
  useOpenAiChannel()
  settings.setEmbeddingEnabled(true)
  handler = embeddingResponse([[0.1, 0.2, 0.3]])

  const result = await gate.embed({ input: ['第一段'], model: 'test-embed-1' })
  assert.equal(result.ok, true, '打开后不该再走「未启用」分支')
  assert.deepEqual(result.vectors, [[0.1, 0.2, 0.3]])
  assert.ok(fetchCalls.length >= 1, `打开后应发出请求，实际 ${fetchCalls.length} 次`)
  assert.equal(fetchCalls[0].url, 'https://embed.test.invalid/v1/embeddings', '地址仍来自 #397 的 API 层')
  assert.deepEqual(JSON.parse(fetchCalls[0].body), { model: 'test-embed-1', input: ['第一段'] })
  settings.setEmbeddingEnabled(false)
})

test('T4 持久化：关掉 / 打开后冷启动读回仍是用户选的值（同一个键，不另开 store）', async () => {
  // 打开 → 只有这一个键被写
  storage.clear()
  settings.setEmbeddingEnabled(true)
  assert.deepEqual(Object.fromEntries(storage), { [ENABLED_KEY]: 'true' }, '只落 chat-demo:memory-embedding 一个键')
  assert.equal((await coldStart([...storage])).useSettings.getState().embeddingEnabled, true, '重开还是开着')

  // 关掉 → 同样是用户的选择，不被默认值覆盖
  settings.setEmbeddingEnabled(false)
  assert.deepEqual(Object.fromEntries(storage), { [ENABLED_KEY]: 'false' })
  assert.equal((await coldStart([...storage])).useSettings.getState().embeddingEnabled, false, '重开还是关着')

  // 切渠道不该把开关丢掉（#398 关闭条件里那句「不随切渠道丢失」）：
  // 开关存在 settings 的键里，与 provider-kind / api-key 那套渠道键各存各的
  settings.setEmbeddingEnabled(true)
  const before = [...storage]
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey('sk-another-channel')
  const persisted = before.find(([key]) => key === ENABLED_KEY)
  assert.deepEqual(persisted, [ENABLED_KEY, 'true'], '切渠道后再读，开关值原样还在')
  settings.setEmbeddingEnabled(false)
})

test('T5 正对照：绕开门直连出口会发请求 —— T2 的 0 是门挡出来的', async () => {
  reset()
  useOpenAiChannel()
  settings.setEmbeddingEnabled(false)
  handler = embeddingResponse([[1, 0]])

  // 同一个「关闭态」下，不走门的调用**会**发请求：说明 T2 依赖的是门本身，而不是别处的巧合
  const direct = await apiEmbedding.embedTexts({ input: ['第一段'], model: 'test-embed-1' })
  assert.equal(direct.ok, true)
  assert.equal(fetchCalls.length, 1, '不经门的出口确实会发 1 次请求（正对照）')
})

// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage，零浏览器、零真实网络） | 耗时: <2s]
//
// Issue #986 阶段一 · 第 4 项：**渠道配置写失败不得静默按旧服务商发送**。
//
// 修复前的真实缺口（`src/services/api/apiConfig.ts`）：
//
//   `const write = (key, value): boolean` 有返回值，但两个调用点把它丢了 ——
//   `setProviderKind` → `write(CONFIG_KEYS.kind, next)`、`setApiKey` → `write(CONFIG_KEYS.apiKey, …)`。
//
// 于是 localStorage 写不进去时（无痕 / 配额满 / 分区受限，见 docs/capabilities/host.md）：
// 磁盘上还是旧渠道，`useApiConfig` 已经切到新渠道 —— **界面显示新渠道、请求按磁盘上的旧渠道发出**，
// 用户以为已经切走的那些内容，落在了他以为不再使用的服务商那里。没有任何提示、也没有一处留痕。
//
// 本文件钉的是运行期事实（不是读源码文本）：
//   ① 写失败 → 返回 false，且**内存态与磁盘都没动**（两者相等）；
//   ② 写成功 → 返回 true，两边都变（对照组：防止「永远返回 false」也能过）；
//   ③ 「确认使用」时任一格写失败 → `not-saved` + **整体回滚**，绝不留在「半个新渠道」。
//
//   node --test tests/unit/api-config-write-safety-986.test.mjs
//   node tests/run-layer.mjs unit --only api-config-write-safety-986
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatBridge, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'

// 原生桥 + 诊断写入口替身：apiConfig 会调 recordAction（写失败时要留 `rejected:storage`）
installChatBridge()
installEndpointsGlobals()
const dom = setupDom()
test.after(() => dom.restore())

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const runtime = await import('../../src/components/settings/sourceAccordionRuntime.ts')

const KIND_KEY = 'chat-demo:provider-kind'
const API_KEY_KEY = 'chat-demo:api-key'

/**
 * 让 localStorage 的**写**失败（读照旧）。
 *
 * `shouldFail(key)` 决定哪一把键写不进去：`() => true` = 整机都写不进去（无痕 / 配额满），
 * 只挑一把 = 中途才失败，用来看「已经写进去的那些会不会被退回」。
 * 返回卸下它的函数。
 */
const failWrites = (shouldFail) => {
  const real = globalThis.localStorage
  globalThis.localStorage = {
    getItem: (key) => real.getItem(key),
    setItem: (key, value) => {
      if (shouldFail(key)) {
        throw new Error('QuotaExceededError')
      }
      real.setItem(key, value)
    },
    removeItem: (key) => {
      if (shouldFail(key)) {
        throw new Error('QuotaExceededError')
      }
      real.removeItem(key)
    },
    clear: () => real.clear(),
  }
  return () => {
    globalThis.localStorage = real
  }
}

/** 每个用例都从「官方来源 + 没有 Key」开始，断言不受上一条影响 */
const reset = () => {
  dom.localStorage.clear()
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey('')
}

test('① 渠道写不进去：返回 false，内存态与磁盘都停在旧渠道（界面不会显示一个没生效的渠道）', () => {
  reset()
  assert.equal(apiConfig.getProviderKind(), 'deepseek')
  const restore = failWrites(() => true)
  try {
    assert.equal(apiConfig.setProviderKind('openai'), false, '写失败必须让调用方知道')
  } finally {
    restore()
  }
  assert.equal(apiConfig.getProviderKind(), 'deepseek', '内存态一个字都没动')
  assert.equal(apiConfig.useApiConfig.getState().kind, 'deepseek')
  assert.equal(dom.localStorage.getItem(KIND_KEY), 'deepseek', '磁盘也没动')
})

test('② 渠道写得进去：返回 true，内存态与磁盘同时更新（对照组）', () => {
  reset()
  assert.equal(apiConfig.setProviderKind('openai'), true)
  assert.equal(apiConfig.getProviderKind(), 'openai')
  assert.equal(dom.localStorage.getItem(KIND_KEY), 'openai')
})

test('① Key 写不进去：返回 false，内存里的 Key 与磁盘上的 Key 一起停在旧值', () => {
  reset()
  apiConfig.setApiKey('sk-old-000001')
  const restore = failWrites(() => true)
  try {
    assert.equal(apiConfig.setApiKey('sk-new-000002'), false)
  } finally {
    restore()
  }
  assert.equal(apiConfig.getApiKey(), 'sk-old-000001', '界面继续显示旧 Key（与实际发送用的一致）')
  assert.equal(dom.localStorage.getItem(API_KEY_KEY), 'sk-old-000001')
})

test('② Key 写得进去：返回 true（对照组）', () => {
  reset()
  assert.equal(apiConfig.setApiKey('sk-new-000002'), true)
  assert.equal(apiConfig.getApiKey(), 'sk-new-000002')
  assert.equal(dom.localStorage.getItem(API_KEY_KEY), 'sk-new-000002')
})

test('③「确认使用」时 Key 写不进去 → not-saved + 整体回滚（不留「界面新渠道 / 磁盘旧渠道」）', () => {
  reset()
  assert.equal(apiConfig.getProviderKind(), 'deepseek')
  const restore = failWrites((key) => key === API_KEY_KEY)
  let result
  try {
    // 前几步（切槽位 / 落地址 / 落模型）都成功，只有 Key 写不进去 —— 最容易被漏掉的那种「半个新渠道」
    result = runtime.confirmSourceRow('third', {
      baseUrl: 'https://proxy.example.com/v1',
      apiKey: 'sk-third-000003',
      model: 'gpt-4o',
    })
  } finally {
    restore()
  }
  assert.equal(result.kind, 'not-saved', '不是 applied、也不是 invalid（不是用户填错了）')
  assert.equal(result.messageKey, 'settingsManagedKeyFailStorage', '文案说的是「本机没存下」')
  assert.equal(apiConfig.getProviderKind(), 'deepseek', '生效来源回到点之前')
  assert.equal(apiConfig.useApiConfig.getState().kind, 'deepseek')
  assert.equal(dom.localStorage.getItem(KIND_KEY), 'deepseek', '磁盘上的生效来源也回去了')
  assert.equal(runtime.effectiveRow(), 'official', '打勾的那一行仍是原来那一行')
  assert.equal(apiConfig.getApiKey(), '', '共用那把 Key 没有被写成半截')
  assert.equal(dom.localStorage.getItem(API_KEY_KEY), null, '磁盘上也没留下新 Key')
})

test('③「确认使用」整机都写不进去 → not-saved，一个字都没落地', () => {
  reset()
  const restore = failWrites(() => true)
  let result
  try {
    result = runtime.confirmSourceRow('official', {
      baseUrl: '',
      apiKey: 'sk-official-000004',
      model: '',
    })
  } finally {
    restore()
  }
  assert.equal(result.kind, 'not-saved')
  assert.equal(apiConfig.getProviderKind(), 'deepseek')
  assert.equal(apiConfig.getApiKey(), '')
  assert.equal(dom.localStorage.getItem(KIND_KEY), 'deepseek')
  assert.equal(dom.localStorage.getItem(API_KEY_KEY), null)
})

test('③ 写得进去时「确认使用」照旧 applied + 三格真的落盘（对照组）', () => {
  reset()
  const result = runtime.confirmSourceRow('third', {
    baseUrl: 'https://proxy.example.com/v1',
    apiKey: 'sk-third-000005',
    model: 'gpt-4o',
  })
  assert.equal(result.kind, 'applied')
  assert.equal(apiConfig.getProviderKind(), result.providerKind)
  assert.equal(apiConfig.getApiKey(), 'sk-third-000005')
  assert.equal(apiConfig.getBaseUrl(), 'https://proxy.example.com/v1')
  assert.equal(apiConfig.getModel(), 'gpt-4o')
})

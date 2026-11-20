// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #360：`POST /v1/chat/completions/files` 在我们任何一层都不存在（网关只放行 /v1、/api 前缀 →
// 转发给 sub2api → 路由表里没有这条 → 404），它曾经占掉网关 84% 的流量（近 1 小时 4532 条全 404）。
//
// 本单第一件事是定位：`grep -rn "chat/completions/files" src android` 现在只在**注释**里命中 ——
// 发起调用的代码在 #303 / #37 那一轮已经删掉了（附件上传改成「渠道显式声明 paths.files 才发，
// 否则本地判失败、一个请求都不发」，见 attachment-endpoint-303.test.mjs）。所以这里不删功能：
// **该端点本就不存在，删除不损失任何能力**。
//
// 这一层补的是**防回退的守卫**，让「猜一个 files 端点」不能再悄悄长回来：
//   [1] 源码守卫：剥掉注释后 src/ 里不存在 `completions/files` 字面量
//   [2] 全渠道 × 地址形态矩阵：真实上传 URL 永不落在 completions 前缀下的 /files
//   [3] 没有 paths.files 的渠道：fetch 零调用（#360 的 404 不可能再产生）
//   [4] 404 是终态：上传被 404 只发 1 次、retryable=false（不重试 → 不会变成死循环）
//
//   node tests/run-layer.mjs unit --only attachment-endpoint-360
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

installChatHostStubs()

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = path.join(ROOT, 'src')

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const client = await import('../../src/services/api/client.ts')
const errors = await import('../../src/services/api/errors.ts')
const providers = await import('../../src/services/api/providers.ts')

/** 记录每一次 fetch；两种场景共用同一个出口 */
const called = []
let responder = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })

globalThis.fetch = async (url, init) => {
  called.push({ url: String(url), method: init?.method ?? 'GET' })
  return responder()
}

const blob = () => new File([new Uint8Array(32)], 'shot.png', { type: 'image/png' })
const reset = () => {
  called.length = 0
}

/** 这套端点里不该出现的形状：completions 前缀下面挂一个 /files */
const isGuessedFilesPath = (url) => /\/completions\/?.*\/files$/.test(url) || url.endsWith('/chat/completions/files')

// ============ [1] 源码守卫 ============
test('[1] 源码守卫：剥掉注释后 src/ 里没有 completions/files 这条路径', () => {
  /** 只剥注释，不动字符串：`//` 前必须是行首或非冒号（避免误伤 https://） */
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return walk(full)
      }
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
    })

  const offenders = walk(SRC)
    .map((file) => ({ file: path.relative(ROOT, file), code: stripComments(fs.readFileSync(file, 'utf8')) }))
    .filter(({ code }) => code.includes('completions/files'))

  assert.deepEqual(
    offenders.map((item) => item.file),
    [],
    '这些文件的**代码**里又出现了不存在的 files 端点（注释里说明历史不算）：换个真实端点或删掉'
  )
})

// ============ [2] 全渠道 × 地址形态矩阵 ============
test('[2] 矩阵：四渠道 × 地址形态，上传/删除 URL 永不落在 completions/files', async () => {
  const deepseek = providers.getSpec('deepseek')
  const originalDefaults = { ...deepseek.defaults }
  const shapes = ['https://up.test', 'https://up.test/', 'https://up.test/anthropic', 'https://up.test/v1']

  try {
    for (const base of shapes) {
      deepseek.defaults = { ...originalDefaults, baseUrl: base } // 官方渠道的地址只来自 defaults
      apiConfig.setProviderKind('deepseek')
      apiConfig.setApiKey('sk-test-360')
      reset()
      responder = () =>
        new Response(JSON.stringify({ id: 'file-360', type: 'file' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      await client.uploadFile('sk-test-360', blob(), null)
      await client.deleteFile('sk-test-360', 'file-360')

      const urls = called.map((item) => item.url)
      assert.equal(urls.length, 2, `地址 ${base}：上传 + 删除各一次请求`)
      for (const url of urls) {
        assert.equal(isGuessedFilesPath(url), false, `地址 ${base}：不许打出 ${url}`)
        assert.equal(url.includes('/chat/completions'), false, `地址 ${base}：附件端点与对话端点必须是两条独立路由`)
      }
      assert.match(urls[0], /\/anthropic\/v1\/files$/, `地址 ${base}：上传必须打到显式声明的 paths.files`)
      assert.match(urls[1], /\/anthropic\/v1\/files\/file-360$/, `地址 ${base}：删除必须挂在同一个前缀下`)
    }
  } finally {
    deepseek.defaults = originalDefaults
  }

  // 自填地址的渠道：无论用户把地址填成什么形状，都不可能被拼成 completions/files
  apiConfig.setProviderKind('openai')
  for (const base of shapes) {
    assert.equal(apiConfig.setBaseUrl(base), true, `地址 ${base} 应被接受`)
    reset()
    await assert.rejects(() => client.uploadFile('sk-test-360', blob(), null), 'OpenAI 兼容渠道没有 Files API')
    assert.equal(called.length, 0, `地址 ${base}：没有 paths.files 的渠道不许发任何上传请求`)
  }
})

// ============ [3] 没有 paths.files 的渠道 ============
test('[3] 没有 Files API 的渠道：上传/删除本地判失败，fetch 零调用', async () => {
  for (const kind of providers.PROVIDER_KINDS) {
    if (providers.getSpec(kind).paths.files) {
      continue
    }
    apiConfig.setProviderKind(kind)
    apiConfig.setApiKey('sk-test-360')
    reset()
    const upload = await client.uploadFile('sk-test-360', blob(), null).catch((error) => error)
    const remove = await client.deleteFile('sk-test-360', 'file-360').catch((error) => error)
    for (const [label, error] of [['上传', upload], ['删除', remove]]) {
      assert.equal(error?.name, 'ApiError', `${kind} ${label}：必须是本地判定的 ApiError`)
      assert.equal(error?.status, undefined, `${kind} ${label}：本地判定不该有 HTTP 状态码`)
      assert.equal(error?.localMessage?.key, 'uploadChannelUnsupported', `${kind} ${label}：要能说清原因`)
    }
    assert.equal(called.length, 0, `${kind}：一个请求都不该发（#360 的 84% 流量就是这里漏出去的）`)
  }
})

// ============ [4] 404 是终态 ============
test('[4] 404 不重试：上传只发一次，且标记为不可重试', async () => {
  apiConfig.setProviderKind('deepseek')
  apiConfig.setApiKey('sk-test-360')
  reset()
  responder = () =>
    new Response(JSON.stringify({ error: { message: '404 page not found' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })

  const error = await client.uploadFile('sk-test-360', blob(), null).catch((failure) => failure)
  assert.equal(error?.status, 404, '404 要作为 404 冒出来，不能被吞成网络故障')
  assert.equal(called.length, 1, '同一条请求只能发一次：重试只会把 404 刷成一片死循环')
  assert.equal(errors.isRetryableApiError(error), false, '404 必须是终态（只有 429 / 5xx 才退避重试）')
})

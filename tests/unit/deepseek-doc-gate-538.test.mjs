// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #538：DeepSeek 渠道禁用文档入口 —— 能力语义收紧的证据。
//
// 本文件只钉纯函数与接线位置，不碰 IndexedDB / UI 渲染：
//   [绿 1] `deepseek` = `{textInjection: false, nativeFile: false}`，`acceptsDocuments()` 为 false
//          —— 「没有可用的原生上传实现」如实反映在表里（#360：`/files` 路由不存在）；
//   [绿 2] 三个文本注入渠道 `textInjection: true`、`acceptsDocuments()` 为 true（行为不变）；
//   [绿 3] 未知渠道 fail-closed：两条都不支持，文档入口同样关掉（不给假承诺）；
//   [绿 4] 不变式：**没有任何渠道两条同时为 true**（否则同一份文档会发两遍，#480 §7）；
//   [绿 5] `docInjectionFor()` 返回副本，调用方改不坏能力表；
//   [绿 6] 接线位置固定：UI 门（`ChatInput`）与服务层闸（`store.sendMessage`）都问
//          `acceptsDocuments()`，没有第二套渠道判断。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/deepseek-doc-gate-538.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href)
    }
    return nextResolve(specifier, context)
  },
})

const { acceptsDocuments, docInjectionFor } = await import(
  '../../src/services/attachments/providerCapability.ts'
)

const read = (relative) => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8')

/** 能力表的四个已登记渠道（`Record<ProviderKind, …>` 在类型层强制齐平） */
const KINDS = ['deepseek', 'anthropic', 'openai', 'ours']

test('[绿 1] DeepSeek：没有可用的原生上传实现 → 文档入口判定为「不支持」', () => {
  const caps = docInjectionFor('deepseek')
  assert.equal(caps.textInjection, false, 'DeepSeek 不做文本注入（请求路径零改动的前提）')
  assert.equal(
    caps.nativeFile,
    false,
    'nativeFile 的含义是「确有可用的原生上传实现」；#360 证明 /files 路由不存在'
  )
  assert.equal(acceptsDocuments('deepseek'), false, '两条都不满足 → 不能收文档（#538）')
})

test('[绿 2] 三个文本注入渠道不变：仍可收文档', () => {
  for (const kind of ['anthropic', 'openai', 'ours']) {
    const caps = docInjectionFor(kind)
    assert.equal(caps.textInjection, true, `${kind} 走文本注入`)
    assert.equal(caps.nativeFile, false, `${kind} 没有原生上传`)
    assert.equal(acceptsDocuments(kind), true, `${kind} 的文档入口必须照旧可用`)
  }
})

test('[绿 3] 未知渠道 fail-closed：不注入、也不假装有原生能力', () => {
  const caps = docInjectionFor('openrouter')
  assert.deepEqual(caps, { textInjection: false, nativeFile: false })
  assert.equal(acceptsDocuments('openrouter'), false)
})

test('[绿 4] 不变式：没有渠道两条同时为 true（否则同一份文档发两遍）', () => {
  for (const kind of KINDS) {
    const caps = docInjectionFor(kind)
    assert.equal(
      caps.textInjection && caps.nativeFile,
      false,
      `${kind} 同时走两条路径会把同一份文档发两次`
    )
  }
})

test('[绿 5] docInjectionFor() 返回副本：写不坏能力表', () => {
  const caps = docInjectionFor('deepseek')
  caps.nativeFile = true
  caps.textInjection = true
  assert.deepEqual(docInjectionFor('deepseek'), { textInjection: false, nativeFile: false })
})

test('[绿 6] 接线位置：UI 门与服务层闸都问 acceptsDocuments()，没有第二套判断', () => {
  const chatInput = read('src/components/chatInput/ChatInput.tsx')
  assert.match(chatInput, /const canAttachDocs = acceptsDocuments\(kind\)/, 'UI 门在 ChatInput')
  assert.doesNotMatch(
    chatInput,
    /canAttachDocs = docInjectionFor\(kind\)\.textInjection/,
    '不允许退回「只看 textInjection」的旧口径（那会让 DeepSeek 入口仍以为能用）'
  )
  const store = read('src/services/chat/store.ts')
  assert.match(
    store,
    /documents\.length > 0 && !acceptsDocuments\(getCurrentSpec\(\)\.kind\)/,
    '发送路径（sendMessage）必须有同一判据的闸，绕过 UI 也要挡住'
  )
})

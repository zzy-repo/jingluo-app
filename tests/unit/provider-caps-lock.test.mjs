// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 官方渠道（deepseek）能力矩阵**锁定测试**（issue #324 第 5、6 条）。
//
// 为什么要有这一条：错误分类与渠道能力本来是两条线，但改分类时最容易被顺手削掉的是
// 「这个渠道还需要那些能力吗」——历史上就有过为了绕过某类错误而关掉能力的改法。
// 这里把官方渠道的完整能力矩阵钉死：深度思考、附件 / Files API、图片 vision、搜索、
// 标题、TTS、ASR、extended 扩展（safety_check + latest_reminder）全部为真，
// 快照拒绝的是「顺手降级」；产品有意改动（例如 ae4e2a3 / #363 把 ours 的深度思考改成真生效）
// 必须在改动那笔 commit 里同步本文件，并在断言旁注明出处。
// 并且断言错误分类的代码**没有**（也无法）反过来改这些能力。
//
//   node tests/unit/provider-caps-lock.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'

// 源码里的相对引用写的是构建产物名 .js，单测直接跑 .ts 源码：换后缀再试一次
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

// providers.ts 顶层读构建期注入的端点表（ours 渠道的 defaults.baseUrl），
// 经 apiConfig.ts 间接读 __API_ORIGIN__：两者都要先挂到 globalThis
globalThis.__ENDPOINTS__ = { consume: { baseUrl: 'https://chat.test.invalid' } }
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false

const {
  getSpec,
  requestGates,
  thinkingAvailable,
  PROVIDER_KINDS,
  ANTHROPIC_VERSION,
} = await import('../../src/services/api/providers.ts')
const { classifyErrorSignature } = await import('../../src/services/api/errors.ts')

test('官方渠道：caps 七项全开（含派生的 thinking）', () => {
  const spec = getSpec('deepseek')
  assert.deepEqual(
    {
      text: spec.caps.text,
      thinking: spec.caps.thinking,
      search: spec.caps.search,
      title: spec.caps.title,
      vision: spec.caps.vision,
      tts: spec.caps.tts,
      asr: spec.caps.asr,
    },
    {
      text: true,
      thinking: true,
      search: true,
      title: true,
      vision: true,
      tts: true,
      asr: true,
    },
    '官方渠道的能力矩阵被削了（#324 第 5 条：能力不许减少）'
  )
  assert.equal(thinkingAvailable(spec), true, '深度思考必须可用（Anthropic 协议天生支持 thinking 块）')
})

test('官方渠道：附件走 Files API（/anthropic/v1/files），协议与鉴权头不变', () => {
  const spec = getSpec('deepseek')
  assert.equal(spec.paths.files, '/anthropic/v1/files', '附件端点不许被删改（#303 之后是显式声明）')
  assert.equal(spec.paths.messages, '/anthropic/v1/messages')
  assert.equal(spec.paths.models, '/models')
  assert.equal(spec.protocol, 'anthropic')
  assert.equal(spec.auth, 'x-api-key')
  assert.equal(spec.anthropicVersion, ANTHROPIC_VERSION, 'anthropic-version 头不许丢')
  assert.equal(ANTHROPIC_VERSION, '2023-06-01')
  assert.deepEqual(spec.defaults, {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
  })
})

test('官方渠道：extended 扩展（safety_check / latest_reminder）与全部请求 gate 仍开启', () => {
  const spec = getSpec('deepseek')
  assert.deepEqual(spec.extended, { safetyCheck: true, latestReminder: true })
  assert.deepEqual(requestGates(spec), {
    safety_check: true,
    latest_reminder: true,
    tools: true,
    title: true,
    reasoning_param: true,
    thinking_budget: false,
  })
})

test('能力矩阵快照：四个渠道逐字段锁定（防止改错误分类时顺手降级）', () => {
  const snapshot = Object.fromEntries(
    PROVIDER_KINDS.map((kind) => {
      const spec = getSpec(kind)
      return [
        kind,
        {
          caps: { ...spec.caps },
          files: spec.paths.files ?? null,
          extended: spec.extended ?? null,
        },
      ]
    })
  )
  /**
   * #552：`vision` 一列从 #480 的「只有 deepseek 有图」变成「四个渠道都有图」——
   * anthropic / openai / ours 走本地 base64 内联（能力表 `image.base64`），
   * deepseek 走 Files API 的 `file_id`（`image.nativeFile`）。**这是能力增加，不是减少**
   * （#324 第 5 条禁止的是削能力）；入口门禁仍要求「表里有可用通路」，见 `ChatInput.tsx`。
   */
  assert.deepEqual(snapshot, {
    deepseek: {
      caps: {
        text: true,
        thinking: true,
        search: true,
        title: true,
        vision: true,
        tts: true,
        asr: true,
      },
      files: '/anthropic/v1/files',
      extended: { safetyCheck: true, latestReminder: true },
    },
    anthropic: {
      caps: {
        text: true,
        thinking: true,
        search: false,
        title: false,
        vision: true,
        tts: false,
        asr: false,
      },
      files: null,
      extended: null,
    },
    openai: {
      caps: {
        text: true,
        thinking: false,
        search: false,
        title: false,
        vision: true,
        tts: false,
        asr: false,
      },
      files: null,
      extended: null,
    },
    ours: {
      caps: {
        text: true,
        // 随 ae4e2a3（#443，#363）变更：ours 的 reasoningParam 由 none 改成 reasoning_effort + high，
        // `thinkingAvailable()` 因此派生出 `thinking: true`（旧快照是 false —— 那是「开关点了也不生效」的老缺陷）。
        thinking: true,
        search: false,
        title: false,
        vision: true,
        tts: false,
        asr: false,
      },
      files: null,
      extended: null,
    },
  })
})

test('分类改动不影响能力：errors.ts 不依赖 providers.ts，判定前后能力矩阵不变', async () => {
  const source = await readFile(new URL('../../src/services/api/errors.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /from '\.\/providers\.js'/,
    '错误分类不许 import 渠道能力：能力只由 providers.ts 声明，两边耦合就会「为了修错误分类而削能力」（#324）'
  )

  const before = getSpec('deepseek').caps
  // 跑一遍官方端点真实失败样本的分类：分类过程不许有任何副作用
  for (const sample of [
    { status: 400, code: 'invalid_request_error', message: 'The supported API model names are …' },
    { status: 401, code: 'authentication_error', message: 'Authentication Fails' },
    { status: 422, code: 'invalid_request_error', message: 'max_tokens: invalid value' },
  ]) {
    classifyErrorSignature(sample)
  }
  assert.deepEqual(getSpec('deepseek').caps, before, '分类之后能力矩阵必须一字不差')
  assert.equal(getSpec('deepseek').caps.vision, true, '附件 / 图片能力仍在')
  assert.equal(getSpec('deepseek').paths.files, '/anthropic/v1/files', 'Files API 仍在')
})

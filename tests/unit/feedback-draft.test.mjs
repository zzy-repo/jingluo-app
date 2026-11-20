// [layer: unit | 纯逻辑：反馈草稿（Issue #31）内存存储；不启动浏览器、不构建、不连网]
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// 与打包器相同的 .js -> .ts 解析，直接跑真实源码（本模块只依赖类型，无运行时 import）
registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { readFeedbackDraft, writeFeedbackDraft, clearFeedbackDraft } =
  await import('../../src/services/feedbackDraft.ts')

const SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/services/feedbackDraft.ts'
)

const draft = (extra = {}) => ({
  description: '输入后点取消，重开应该还在',
  contact: 'user@example.org',
  category: 'bug',
  hadScreenshot: false,
  ...extra,
})

test('初始状态没有草稿', () => {
  clearFeedbackDraft()
  assert.equal(readFeedbackDraft(), null)
})

test('写入后读回：描述 / 联系方式 / 分类 / 选过截图 全部保留', () => {
  clearFeedbackDraft()
  writeFeedbackDraft(draft({ category: 'feature', hadScreenshot: true }))
  assert.deepEqual(readFeedbackDraft(), {
    description: '输入后点取消，重开应该还在',
    contact: 'user@example.org',
    category: 'feature',
    hadScreenshot: true,
  })
})

test('读出来是副本：调用方改字段不会污染内部草稿', () => {
  clearFeedbackDraft()
  writeFeedbackDraft(draft())
  const first = readFeedbackDraft()
  first.description = '被调用方改掉了'
  assert.equal(readFeedbackDraft().description, '输入后点取消，重开应该还在')
})

test('只填了联系方式也算草稿（空描述不等于没内容）', () => {
  clearFeedbackDraft()
  writeFeedbackDraft(draft({ description: '   ' }))
  assert.equal(readFeedbackDraft().contact, 'user@example.org')
})

test('只有截图没文本：仍算草稿，用于重开时提示重新选图', () => {
  clearFeedbackDraft()
  writeFeedbackDraft(draft({ description: '', contact: '', hadScreenshot: true }))
  assert.equal(readFeedbackDraft().hadScreenshot, true)
})

test('空草稿等于没有草稿：打开又原样关掉不留空壳', () => {
  clearFeedbackDraft()
  writeFeedbackDraft(draft({ description: '', contact: '', hadScreenshot: false }))
  assert.equal(readFeedbackDraft(), null)
  // 已有草稿被清空成空内容时同样作废，不留旧值
  writeFeedbackDraft(draft())
  writeFeedbackDraft(draft({ description: ' \n ', contact: '', hadScreenshot: false }))
  assert.equal(readFeedbackDraft(), null)
})

test('clearFeedbackDraft 清掉草稿', () => {
  writeFeedbackDraft(draft())
  clearFeedbackDraft()
  assert.equal(readFeedbackDraft(), null)
})

test('隐私：草稿模块不落盘、不进日志、不上报（静态守卫）', async () => {
  const source = await readFile(SOURCE, 'utf8')
  // 文件头注释里会写「不写 localStorage」这类说明，所以只扫代码本身
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // 只允许类型导入；运行时不认识 diagnostics / collector / transport 任何东西
  for (const banned of [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'document.cookie',
    'console.',
    'diagnostics/index',
    'diagnostics/collector',
    'diagnostics/transport',
    'fetch(',
    'XMLHttpRequest',
  ]) {
    assert.equal(code.includes(banned), false, `feedbackDraft.ts 不应出现 ${banned}`)
  }
  // 运行时只允许 type-only import
  const imports = source.match(/^import .*$/gm) ?? []
  for (const line of imports) {
    assert.match(line, /^import type /, `只允许 import type：${line}`)
  }
})

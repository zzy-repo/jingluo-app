// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 错误页「复制诊断信息」的文本生成（issue #28）：
//   [1] 报告里必须有版本 / 阶段 / 错误名 + 消息 / 组件栈 / JS 栈 / 关键 store 状态摘要
//   [2] 报告里**不能**出现 API Key、Bearer、签名参数、完整 URL、聊天正文（调用方根本拿不到正文）
//   [3] 长栈与超长报告都有上限，不会复制出一屏噪音
//   [4] 采集层 meta：stage=ErrorBoundary + reason + 错误名/消息 + 首个组件帧，不记正文
//
//   cd /root/deepseek-error-boundary && node tests/unit/error-report.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'

// 源码内部一律用 `.js` 后缀 import（TS 的 NodeNext 写法），单测里映射回 `.ts`
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const {
  buildErrorReport,
  errorBoundaryMeta,
  scrubReportText,
  MAX_REPORT_CHARS,
  MAX_REPORT_STACK_LINES,
} = await import('../../src/app/errorReport.ts')

const FACTS = {
  ready: 'yes',
  sessions: 3,
  loaded: 1,
  streaming: 0,
  files: 2,
  view: 'session',
  provider: 'deepseek',
  model: 'deepseek-flash',
  configured: 'yes',
  locale: 'zh-CN',
  theme: 'system',
}

const boom = () => {
  const error = new TypeError("Cannot read properties of null (reading 'length')")
  error.stack = [
    "TypeError: Cannot read properties of null (reading 'length')",
    '    at UserMessage (http://127.0.0.1:5293/static/main.js:12:3456)',
    '    at MessageList (http://127.0.0.1:5293/static/main.js:12:2345)',
  ].join('\n')
  return error
}
const COMPONENT_STACK = '\n    at UserMessage\n    at MessageList\n    at SessionView\n'

test('report carries version / stage / error / component stack / js stack / store summary', () => {
  const report = buildErrorReport({
    error: boom(),
    version: '1.4.0-beta.8',
    stage: 'ErrorBoundary',
    facts: FACTS,
    componentStack: COMPONENT_STACK,
    at: Date.parse('2026-11-18T09:30:00Z'),
  })
  assert.match(report, /^DeepSeek 应用渲染异常/)
  assert.match(report, /版本: 1\.4\.0-beta\.8/)
  assert.match(report, /时间: 2026-11-18T09:30:00\.000Z/)
  assert.match(report, /阶段: ErrorBoundary/)
  assert.match(report, /错误: TypeError: Cannot read properties of null \(reading 'length'\)/)
  // 状态摘要：只放数量与开关，逐项都在
  for (const key of [
    'ready=yes',
    'sessions=3',
    'loaded=1',
    'streaming=0',
    'files=2',
    'view=session',
    'model=deepseek-flash',
    'locale=zh-CN',
  ]) {
    assert.ok(report.includes(key), `状态摘要缺少 ${key}`)
  }
  // 先组件栈（哪个组件挂了）再 JS 栈（崩在哪一行）
  assert.ok(report.indexOf('组件栈:') < report.indexOf('堆栈:'), '组件栈应排在堆栈之前')
  assert.match(report, /at UserMessage/)
  assert.match(report, /at UserMessage/)
})

test('report never leaks keys, tokens, signed params or full URLs', () => {
  const error = new Error(
    'request failed sk-abcdefghijklmnop1234567890 Bearer BEARER_SECRET token=TOKEN_SECRET ' +
      'https://oss.example.com/bucket/chat.zip?Signature=SIGNED_SECRET&AccessKeyId=AK_SECRET#frag'
  )
  error.stack = 'Error: failed\n    at upload (https://api.example.com/v1/files?token=STACK_SECRET)'
  const report = buildErrorReport({ error, version: 'x', stage: 'ErrorBoundary', facts: FACTS })
  for (const secret of [
    'abcdefghijklmnop1234567890',
    'BEARER_SECRET',
    'TOKEN_SECRET',
    'SIGNED_SECRET',
    'AK_SECRET',
    'STACK_SECRET',
    'frag',
  ]) {
    assert.ok(!report.includes(secret), `报告里不应出现 ${secret}`)
  }
  // host 保留（定位需要），path / query 全丢
  assert.ok(report.includes('https://oss.example.com/***'), '完整 URL 应收敛成 协议//host/***')
  assert.ok(!report.includes('/bucket/chat.zip'))
})

test('scrubReportText is the copy-time second boundary', () => {
  const text = scrubReportText('key sk-ZZZZZZZZZZZZZZZZZZZZ9999 url https://h/a?Signature=S1')
  assert.ok(!text.includes('ZZZZZZZZZZZZZZZZZZZZ9999'))
  assert.ok(!text.includes('S1'))
  assert.ok(text.includes('https://h/***'))
})

test('long stacks are clipped and oversized reports are capped', () => {
  const error = new Error('boom')
  error.stack = Array.from({ length: 60 }, (_, i) => `    at frame${i} (main.js:1:${i})`).join('\n')
  const report = buildErrorReport({ error, version: '1', stage: 'ErrorBoundary', facts: FACTS })
  const frameLines = report.split('\n').filter((line) => line.trim().startsWith('at frame'))
  assert.equal(frameLines.length, MAX_REPORT_STACK_LINES)
  assert.match(report, /已截断，共 60 行/)

  const huge = new Error('x'.repeat(5000))
  huge.stack = 'y'.repeat(6000)
  const capped = buildErrorReport({
    error: huge,
    version: '1',
    stage: 'ErrorBoundary',
    facts: FACTS,
  })
  assert.ok(
    capped.length <= MAX_REPORT_CHARS + 20,
    `报告应被截到 ${MAX_REPORT_CHARS} 字以内，实际 ${capped.length}`
  )
})

test('facts=null degrades to unknown instead of throwing', () => {
  const report = buildErrorReport({ error: new Error('boom'), version: '', stage: 'ErrorBoundary' })
  assert.match(report, /版本: unknown/)
  assert.match(report, /状态: unknown/)
})

test('collector meta has stage/reason/name/message/first component frame, no body', () => {
  const meta = errorBoundaryMeta(boom(), COMPONENT_STACK)
  assert.equal(meta.stage, 'ErrorBoundary')
  assert.equal(meta.reason, 'render-throw')
  assert.equal(meta['error.name'], 'TypeError')
  assert.match(meta['error.msg'], /Cannot read properties of null/)
  assert.equal(meta['error.component'], 'at UserMessage')
  // 只有错误信息，没有任何消息正文类字段
  assert.deepEqual(Object.keys(meta).sort(), [
    'error.component',
    'error.msg',
    'error.name',
    'reason',
    'stage',
  ])
})

test('non-Error throws still produce a readable report and meta', () => {
  assert.match(
    buildErrorReport({ error: 'plain string', version: '1', stage: 'ErrorBoundary' }),
    /错误: plain string/
  )
  assert.equal(errorBoundaryMeta('plain string').reason, 'render-throw-non-error')
})

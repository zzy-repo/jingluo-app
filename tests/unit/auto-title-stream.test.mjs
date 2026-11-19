// [layer: unit | 依赖: 无（纯 Node，零浏览器/零真实网络） | 耗时: <2s] Issue #93
//
// 自动标题请求必须是**流式**的：能拿到增量，且拿到够用的标题行就断开连接
// （不等整段生成完，省上游 token、缩短占用并发槽位的窗口）。
//
//   node tests/unit/auto-title-stream.test.mjs
//
// 打桩方式：只替换 globalThis.fetch（client.ts 的 request 就是裸 fetch）+ 一个内存版
// localStorage（只为了让 getProviderKind 能切到 openai / anthropic 两支），
// 生产代码路径一行不放宽。
//
// 覆盖（对应 Issue #93 关闭条件）：
//   [1] 两个分支的请求体都必须是 stream:true（修复前是 stream:false）
//   [2] 增量够用就断：读到标题行即断开连接，剩余分块不再拉取（省 token）
//   [3] 流模式下 429 仍记 throttled（与非流式同口径），不当成功
//   [4] 流内错误帧 / 半截内容：不当标题，回退本地截取，不抛错给对话流
//   [5] 网关忽略 stream:true 回了 JSON：仍能拿到标题（老行为不回归）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installChatBridge } from '../helpers/dom-env.mjs'

// 装配走公共入口（#408 收尾批）：原生桥 + 诊断入口的替身由 installChatBridge 一次装好
// （原先 3 个文件各抄一份 23 行 registerHooks + 本地 stub()）。
installChatBridge()

// 构建期注入的常量：单测没有 rspack 的 DefinePlugin，先挂到全局再 import
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

// 内存版 localStorage：只用来切「当前渠道」（getProviderKind 读它），不写任何真实值
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
}

const autoTitle = await import('../../src/services/chat/autoTitle.ts')
const queue = await import('../../src/services/chat/autoTitleQueue.ts')

const KIND_KEY = 'chat-demo:provider-kind'
const useKind = (kind) => memory.set(KIND_KEY, kind)
const stats = () => queue.autoTitleStats()
const resetStats = () => queue.resetAutoTitleStats()

/** 会话首条消息（本地截取兜底会用到它，用来证明「回退能给出可用标题」） */
const MESSAGE = '这个网络的代理老是连不上，怎么排查？'
const TITLE_LINE = '代理老是连不上怎么排查'

/** OpenAI 兼容协议的 SSE 分块 */
const openaiChunks = (filler = 24) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '代理老是' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '连不上' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '怎么排查\n' } }] })}\n\n`,
  ...Array.from(
    { length: filler },
    () => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '这段正文标题用不到' } }] })}\n\n`
  ),
  'data: [DONE]\n\n',
]

/** Anthropic 兼容协议的 SSE 分块 */
const anthropicChunks = (filler = 24) => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { content: [] } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '代理老是' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '连不上' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '怎么排查\n' } })}\n\n`,
  ...Array.from(
    { length: filler },
    () =>
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '这段正文标题用不到' } })}\n\n`
  ),
  `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
]

/**
 * SSE 桩：按需一块一块吐（pull 驱动，所以「提前断开」能直接量出来：
 * pulled = 实际拉取的分块数，cancelled = 调用方是否取消了正文读取）。
 */
const sseResponse = (chunks) => {
  const state = { pulled: 0, cancelled: false, chunks: chunks.length }
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    pull(controller) {
      if (state.pulled >= chunks.length) {
        controller.close()
        return
      }
      state.pulled += 1
      controller.enqueue(encoder.encode(chunks[state.pulled - 1]))
    },
    cancel() {
      state.cancelled = true
    },
  })
  return {
    state,
    response: new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  }
}

/** 装一次桩 fetch：记下请求体，按 respond 决定回什么 */
const installFetch = (respond) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body))
    return respond(calls.length)
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const jsonResponse = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

test('[1] 两个分支的标题请求都必须是 stream:true', async () => {
  for (const kind of ['openai', 'anthropic']) {
    useKind(kind)
    resetStats()
    const chunks = kind === 'openai' ? openaiChunks() : anthropicChunks()
    const { response } = sseResponse(chunks)
    const probe = installFetch(() => response)
    try {
      await autoTitle.generateSessionTitle(MESSAGE)
      assert.equal(probe.calls.length, 1, `${kind}：应当只发一次标题请求`)
      assert.equal(
        probe.calls[0].stream,
        true,
        `${kind} 分支必须是流式请求（stream:true），实际请求体 stream=${JSON.stringify(probe.calls[0].stream)}`
      )
      assert.equal(
        probe.calls[0].max_tokens,
        autoTitle.AUTO_TITLE_MAX_OUTPUT_TOKENS,
        '标题请求的输出上限保持不变（省 token）'
      )
    } finally {
      probe.restore()
    }
  }
})

test('[2] 增量够用就断：读到标题行即断开，剩余分块不再拉取', async () => {
  useKind('openai')
  resetStats()
  const { state, response } = sseResponse(openaiChunks(24))
  const probe = installFetch(() => response)
  try {
    const title = await autoTitle.generateSessionTitle(MESSAGE)
    assert.equal(title, TITLE_LINE, '应当用流式增量拼出标题第一行')
    assert.ok(
      state.cancelled,
      `拿到标题行后必须取消正文读取（提前断开），实际 cancelled=${state.cancelled}`
    )
    assert.ok(
      state.pulled < state.chunks,
      `不该把整段生成读完：pulled=${state.pulled} / 总块数=${state.chunks}`
    )
    assert.ok(
      state.pulled <= 6,
      `读完标题行（第 3 块）就该停：实际拉了 ${state.pulled} 块`
    )
  } finally {
    probe.restore()
  }
})

test('[3] 流式下的 429 仍记 throttled，且不给半截标题当成功', async () => {
  useKind('openai')
  resetStats()
  const probe = installFetch(() =>
    jsonResponse(JSON.stringify({ error: { message: 'rate limit exceeded' } }), 429)
  )
  try {
    const title = await autoTitle.generateSessionTitle(MESSAGE)
    const now = stats()
    assert.equal(now.throttled, 1, '429 必须记 throttled')
    assert.equal(now.failed, 0, '429 不许混进普通失败')
    assert.equal(now.ok, 0, '429 不许当成功')
    assert.equal(title, autoTitle.fallbackTitle(MESSAGE), '限流时回退本地截取，标题仍可用')
  } finally {
    probe.restore()
  }
})

test('[4] 流内错误帧：半截内容不当标题，回退本地截取且不抛错', async () => {
  useKind('anthropic')
  resetStats()
  const errorFrame = [
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '代理老是' } })}\n\n`,
    `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
  ]
  const { response } = sseResponse(errorFrame)
  const probe = installFetch(() => response)
  try {
    const title = await autoTitle.generateSessionTitle(MESSAGE)
    const now = stats()
    assert.equal(now.ok, 0, '流内错误帧不许当成功')
    assert.equal(now.failed, 1, '流内错误帧按普通失败记账')
    assert.equal(title, autoTitle.fallbackTitle(MESSAGE), '失败回退本地截取（「代理老是」不能当标题）')
  } finally {
    probe.restore()
  }
})

test('[5] 网关忽略 stream:true 回了 JSON：仍能拿到标题（老行为不回归）', async () => {
  useKind('anthropic')
  resetStats()
  const jsonBody = JSON.stringify({
    content: [{ type: 'text', text: TITLE_LINE }],
    stop_reason: 'end_turn',
  })
  const probe = installFetch(() => jsonResponse(jsonBody))
  try {
    const title = await autoTitle.generateSessionTitle(MESSAGE)
    assert.equal(title, TITLE_LINE, '非 SSE 响应要按原非流式解析路径兜住')
    assert.equal(stats().ok, 1, '这种响应仍记成功')
  } finally {
    probe.restore()
  }
})

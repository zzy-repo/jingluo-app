// [layer: unit | 依赖: 无（纯 Node，零浏览器/零网络） | 耗时: <2s] Issue #112
//
// 自动标题的批量请求要有预算：并发上限（默认 2）+ 有界队列（默认 6）+ 溢出计数，
// 被上游限流（429）的响应要和普通失败分开记账，不能当成功。
//
//   node tests/unit/auto-title-backpressure.test.mjs
//
// 打桩方式：只替换 globalThis.fetch（client.ts 的 request 就是裸 fetch），桩里数
// 「调用次数 / 在飞数 / 历史峰值」，不放宽任何生产代码路径。
//
// 覆盖（对应 Issue #112 关闭条件）：
//   [1] 同时最多 AUTO_TITLE_MAX_CONCURRENCY 个在飞；第 N+1 个是排队，不是直接发
//   [2] 队列长度有上限：溢出的请求明确跳过并计数（dropped），不静默吞、也不打到上游
//   [3] 429 / 上游限流语义单独记账（throttled），与普通失败（failed）可区分，且不当成功
//   [4] 排队中被调用方取消：不打上游、不占坑，标题仍回退到本地截取（UI 不空）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installChatBridge } from '../helpers/dom-env.mjs'

// 装配走公共入口（#408 收尾批）：原生桥 + 诊断入口的替身由 installChatBridge 一次装好
// （原先 3 个文件各抄一份 23 行 registerHooks + 本地 stub()）。
installChatBridge()

// 构建期注入的常量：单测没有 rspack 的 DefinePlugin，先挂到全局再 import。
// 非空 base url 是 requestTitle 发请求的前置条件（localStorage 在 Node 里不可用，纯 try/catch 兜底）
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const autoTitle = await import('../../src/services/chat/autoTitle.ts')

/**
 * 限流器模块（本次修复新增）。修复前不存在 → 用 null 兜底，
 * 让「并发/队列」断言照常跑真实源码并给出真实数字（红），而不是在 import 处崩掉。
 */
const queue = await import('../../src/services/chat/autoTitleQueue.ts').catch(() => null)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Anthropic 与 OpenAI 两种协议都认的标题响应体（默认渠道走哪一支都不会误判失败） */
const titleBody = (text) =>
  JSON.stringify({
    content: [{ type: 'text', text }],
    choices: [{ finish_reason: 'stop', message: { content: text } }],
  })

const jsonResponse = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

/**
 * 装一个计数桩：calls = 真的打出去的请求数，inflight/peak = 同一时刻在飞数及其峰值。
 * respond(callIndex) 决定这一发返回什么（默认 200 + 合法标题）。
 */
const installFetch = ({ delayMs = 30, respond } = {}) => {
  const state = { calls: 0, inflight: 0, peak: 0 }
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    state.calls += 1
    state.inflight += 1
    state.peak = Math.max(state.peak, state.inflight)
    try {
      if (delayMs > 0) await sleep(delayMs)
      return respond ? respond(state.calls) : jsonResponse(titleBody(`标题${state.calls}`))
    } finally {
      state.inflight -= 1
    }
  }
  return { state, restore: () => (globalThis.fetch = original) }
}

const stats = () => (typeof queue?.autoTitleStats === 'function' ? queue.autoTitleStats() : null)
const resetStats = () => {
  if (typeof queue?.resetAutoTitleStats === 'function') queue.resetAutoTitleStats()
}

/** 默认预算：并发 2、队列 6（超出 2+6 的请求必须被跳过） */
const MAX_CONCURRENCY = 2
const MAX_QUEUE = 6

const text = (i) => `第 ${i} 条会话消息：这个网络的代理老是连不上，怎么排查？`

test('[1] 并发上限：同时最多 N 个在飞，第 N+1 个排队而不是直接发', async () => {
  resetStats()
  const probe = installFetch({ delayMs: 40 })
  try {
    const tasks = Array.from({ length: 6 }, (_, i) => autoTitle.generateSessionTitle(text(i)))
    // 让前两个抢到坑位；第 3 个及以后必须还在队里
    await sleep(15)
    assert.equal(
      probe.state.calls,
      MAX_CONCURRENCY,
      `第 ${MAX_CONCURRENCY + 1} 个请求必须排队：此刻真发出去了 ${probe.state.calls} 个`
    )
    assert.equal(probe.state.inflight, MAX_CONCURRENCY, '在飞数必须等于并发上限')

    // 队列里的请求不能被丢掉：放行后它们照样各自发一次
    const titles = await Promise.all(tasks)
    assert.equal(probe.state.calls, 6, '排队的 4 个最终都要发出去（排队 ≠ 丢弃）')
    assert.equal(probe.state.peak, MAX_CONCURRENCY, `历史峰值在飞数必须是 ${MAX_CONCURRENCY}`)
    assert.ok(
      titles.every((title) => typeof title === 'string' && title.length > 0),
      '每个会话都要拿到非空标题（UI 不能停在「新对话」）'
    )
    assert.equal(stats()?.peak, MAX_CONCURRENCY, '计数口径一致：stats().peak 也是 2')
  } finally {
    probe.restore()
  }
})

test('[2] 队列上限：溢出的明确跳过并计数，不打到上游也不静默吞', async () => {
  resetStats()
  const probe = installFetch({ delayMs: 20 })
  try {
    const total = MAX_CONCURRENCY + MAX_QUEUE + 4
    const titles = await Promise.all(
      Array.from({ length: total }, (_, i) => autoTitle.generateSessionTitle(text(i)))
    )
    const budget = MAX_CONCURRENCY + MAX_QUEUE
    assert.equal(
      probe.state.calls,
      budget,
      `超出 并发${MAX_CONCURRENCY}+队列${MAX_QUEUE} 的 ${total - budget} 个必须跳过，但打出去了 ${probe.state.calls} 个`
    )
    assert.equal(probe.state.peak, MAX_CONCURRENCY, '跳过的请求不能偷偷并发出去')

    const recorded = stats()
    assert.ok(recorded, '必须有可读的计数（autoTitleQueue.ts 未落地）')
    assert.equal(recorded.dropped, total - budget, '溢出跳过必须有计数 dropped')
    assert.equal(recorded.started, budget, '真正发出去的请求数 = started')
    assert.ok(recorded.queued === 0 && recorded.active === 0, '跑完后队列与在飞都要归零')

    // 跳过只是不发请求，标题照旧回退到本地截取：用户看到的是可用标题，不是空
    assert.ok(
      titles.every((title) => typeof title === 'string' && title.length > 0),
      '被跳过的会话也要拿到本地截取的标题'
    )
    assert.ok(
      titles.slice(budget).every((title) => !title.startsWith('标题')),
      '被跳过的会话不能拿到上游标题（说明它们真的没发请求）'
    )
  } finally {
    probe.restore()
  }
})

test('[3] 429 与普通失败可区分：限流单独计数，不当成功', async () => {
  resetStats()
  let call = 0
  const probe = installFetch({
    delayMs: 0,
    respond: () => {
      call += 1
      if (call === 1) {
        return jsonResponse(
          JSON.stringify({ error: { message: 'rate limit exceeded, please retry later' } }),
          429
        )
      }
      return jsonResponse(JSON.stringify({ error: { message: 'internal server error' } }), 500)
    },
  })
  try {
    const throttledTitle = await autoTitle.generateSessionTitle(text(1))
    const failedTitle = await autoTitle.generateSessionTitle(text(2))

    const recorded = stats()
    assert.ok(recorded, '必须有可读的计数（autoTitleQueue.ts 未落地）')
    assert.equal(recorded.throttled, 1, '429 计入 throttled')
    assert.equal(recorded.failed, 1, '500 计入 failed（与限流分开）')
    assert.equal(recorded.ok, 0, '两者都不许当成功')
    assert.ok(throttledTitle.length > 0 && failedTitle.length > 0, '两者都回退本地截取')
    assert.ok(!throttledTitle.startsWith('标题'), '限流响应不能变成标题')
  } finally {
    probe.restore()
  }
})

test('[4] 排队中被取消：不打上游、不占坑，标题仍回退本地截取', async () => {
  resetStats()
  const probe = installFetch({ delayMs: 30 })
  try {
    const controller = new AbortController()
    const first = autoTitle.generateSessionTitle(text(1))
    const second = autoTitle.generateSessionTitle(text(2))
    const third = autoTitle.generateSessionTitle(text(3), controller.signal)
    await sleep(5)
    controller.abort()
    const titles = await Promise.all([first, second, third])
    assert.equal(probe.state.calls, 2, '排队期间被取消的请求不许打到上游')
    assert.ok(titles[2].length > 0, '被取消的会话仍要拿到本地截取标题')
    assert.equal(probe.state.peak, MAX_CONCURRENCY, '取消不影响并发口径')
  } finally {
    probe.restore()
  }
})

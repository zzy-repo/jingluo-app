// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #45：请求统一超时（改动见 src/services/api/client.ts）。
//
// 审计确认的缺陷：只有 probeProvider 自带 15s 超时，其余请求（校验 Key、上传/删除附件、
// 发消息的流式请求）完全没有超时，上游把连接晾着就永久挂起 —— 用户看到的就是长会话「一直转圈」。
//
// 本层的断言全部围绕 request()：把全局 fetch 换成一个「永不 settle、只认 abort」的桩
// （真实卡死的形态），用短超时（40ms）在有限时间内拿到结论，不靠真的等待。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

// 构建期注入的常量：单测没有 rspack 的 DefinePlugin，先挂到全局再 import。
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false

const client = await import('../../src/services/api/client.ts')
const { ApiError, request } = client
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const URL_OK = 'https://api.example.test/v1/messages'
/** 桩在截止时间内既不 resolve 也不 reject 的标记 */
const STILL_PENDING = Symbol('still-pending')

const realFetch = globalThis.fetch
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 定时器允许提前多少毫秒：Node 的 setTimeout 不保证「不早于」预算，libuv 按毫秒取整 +
 * 事件循环调度，实测 40ms 预算会跑出 39ms —— 拿 `elapsed >= 预算` 当断言，机器一换就偶发红
 * （2026-11-19 复现：`应在 40ms 预算处收口（实际 39ms）`，同一分钟在另一台 LANG 下是绿的）。
 * 判据要的只是「按预算收口」，不是「立刻失败」也不是「永久挂起」：下界给几毫秒容差即可，
 * 1ms 内就返回的那种「没设超时」的 bug 照样会被抓住。
 */
const TIMER_EARLY_TOLERANCE_MS = 5

/**
 * 永不 settle 的 fetch：只有拿到 abort 信号才以 AbortError 收尾。
 * 这是「上游不响应」的真实形态（不是 reject，是永远没有回音）。
 */
const installHangingFetch = () => {
  const calls = []
  globalThis.fetch = (_url, init) => {
    calls.push(init)
    return new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        return
      }
      if (signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('The operation was aborted.', 'AbortError')),
        { once: true }
      )
    })
  }
  return calls
}

/** 按顺序给每次 fetch 指定结果；用于「超时 / 网络失败 / 4xx / 5xx」并列对比 */
const installFetchQueue = (...behaviours) => {
  const calls = []
  globalThis.fetch = (_url, init) => {
    calls.push(init)
    const behaviour = behaviours[Math.min(calls.length - 1, behaviours.length - 1)]
    return behaviour(init)
  }
  return calls
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** 带截止时间地等一个 Promise：桩真的挂住时不会把测试一起挂死 */
const settleWithin = async (promise, limitMs) => {
  const startedAt = Date.now()
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(STILL_PENDING), limitMs)
  })
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error })
    ),
    deadline,
  ])
  clearTimeout(timer)
  return { outcome, elapsed: Date.now() - startedAt }
}

/** 必须拿到结论（resolve 或 reject）的等待：桩真的挂住时给出可读的失败而不是拖死整轮 */
const settled = async (promise, limitMs) => {
  const { outcome } = await settleWithin(
    promise.then(
      (value) => value,
      (error) => error
    ),
    limitMs
  )
  assert.notEqual(outcome, STILL_PENDING, `请求在 ${limitMs}ms 内必须有结论（改动前：永久挂起）`)
  return outcome.value
}

test.after(() => {
  globalThis.fetch = realFetch
})

test('永不 resolve 的请求：超时后必须拒绝，错误可与网络失败区分（改动前永久挂起）', async () => {
  const calls = installHangingFetch()
  const { outcome, elapsed } = await settleWithin(request(URL_OK, { method: 'GET' }, { timeoutMs: 40 }), 2000)
  assert.notEqual(
    outcome,
    STILL_PENDING,
    '改动前：请求永久挂起（2s 内既不 resolve 也不 reject），用户侧表现为「一直转圈」'
  )
  assert.ok(outcome.error, '超时必须 reject，不能 resolve 出空响应')
  assert.ok(outcome.error instanceof ApiError, `超时应抛 ApiError，实际 ${outcome.error?.name}`)
  assert.equal(outcome.error.kind, 'timeout', '超时的 kind 必须是 timeout，不能并进 network')
  // #568：这一段只覆盖「发起到拿到响应头」，错误码随之改名为 connect_timeout（三段之一）
  assert.equal(outcome.error.code, 'connect_timeout', '超时要有机器可读的错误码')
  assert.equal(outcome.error.status, undefined, '超时没有 HTTP 状态码')
  assert.equal(outcome.error.localMessage?.key, 'requestTimeout', '超时要有自己的界面文案 key')
  assert.ok(
    elapsed >= 40 - TIMER_EARLY_TOLERANCE_MS && elapsed < 1500,
    `应在 40ms 预算处收口（实际 ${elapsed}ms）`
  )
  assert.equal(calls.length, 1, '只发一次请求，超时后不再重发')
  assert.equal(calls[0].signal.aborted, true, '超时必须真的中断底层 fetch（不留悬挂连接）')
})

test('三类失败互不混淆：超时 / 网络失败 / 4xx / 5xx', async () => {
  // 超时 → kind='timeout'，没有状态码
  installHangingFetch()
  const timeoutError = await settled(request(URL_OK, { method: 'GET' }, { timeoutMs: 30 }), 2000)
  assert.equal(timeoutError?.kind, 'timeout')

  // 请求没发出去（断网、跨域）→ kind='network'
  installFetchQueue(() => Promise.reject(new TypeError('Failed to fetch')))
  const networkError = await settled(request(URL_OK, { method: 'GET' }, { timeoutMs: 5000 }), 2000)
  assert.equal(networkError?.kind, 'network')
  assert.equal(networkError?.status, undefined)

  // 服务端有响应 → kind='http' 且带状态码
  installFetchQueue(() =>
    Promise.resolve(jsonResponse(401, { error: { message: 'invalid api key' } }))
  )
  const unauthorized = await settled(request(URL_OK, { method: 'GET' }, { timeoutMs: 5000 }), 2000)
  assert.equal(unauthorized?.kind, 'http')
  assert.equal(unauthorized?.status, 401)

  installFetchQueue(() =>
    Promise.resolve(jsonResponse(503, { error: { message: 'server busy' } }))
  )
  const busy = await settled(request(URL_OK, { method: 'GET' }, { timeoutMs: 5000 }), 2000)
  assert.equal(busy?.kind, 'http')
  assert.equal(busy?.status, 503)

  const kinds = new Set([timeoutError?.kind, networkError?.kind, unauthorized?.kind, busy?.kind])
  assert.deepEqual(
    [...kinds].sort(),
    ['http', 'network', 'timeout'],
    '超时 / 网络失败 / 4xx / 5xx 必须落在互斥的 kind 上'
  )

  // 超时这一轮没等到响应，重试有效；401 重试无用（沿用既有判定）
  const { isRetryableApiError } = await import('../../src/services/api/errors.ts')
  assert.equal(isRetryableApiError(timeoutError), true, '超时必须可重试')
  assert.equal(isRetryableApiError(unauthorized), false, '401 重试无用')
  assert.equal(isRetryableApiError(busy), true, '5xx 可重试')
})

test('默认超时与 probeProvider 同口径（15s），且可配置；非法值回到默认', async () => {
  assert.equal(client.DEFAULT_REQUEST_TIMEOUT_MS, 15000, '默认值必须与 probeProvider 的 15s 一致')
  assert.equal(client.getRequestTimeout(), 15000, '未配置时用默认值')
  try {
    client.setRequestTimeout(1234)
    assert.equal(client.getRequestTimeout(), 1234, '可配置')
    client.setRequestTimeout(Number.NaN)
    assert.equal(client.getRequestTimeout(), 15000, '非法值回到默认，不能变成「永不超时」')
    client.setRequestTimeout(0)
    assert.equal(client.getRequestTimeout(), 15000, '0 不是有效超时，回到默认')
  } finally {
    client.setRequestTimeout(client.DEFAULT_REQUEST_TIMEOUT_MS)
  }
  assert.equal(client.getRequestTimeout(), 15000, '用例结束恢复默认')
})

test('调用方传入的超时优先于全局配置', async () => {
  installHangingFetch()
  try {
    client.setRequestTimeout(5000)
    const { outcome, elapsed } = await settleWithin(
      request(URL_OK, { method: 'GET' }, { timeoutMs: 30 }),
      2000
    )
    assert.notEqual(outcome, STILL_PENDING, '单次传入的超时必须生效')
    assert.equal(outcome.error?.kind, 'timeout')
    assert.ok(elapsed < 1000, `应被 30ms 收口，不受全局 5000ms 影响（实际 ${elapsed}ms）`)
  } finally {
    client.setRequestTimeout(client.DEFAULT_REQUEST_TIMEOUT_MS)
  }
})

test('调用方主动取消：抛原始 abort，不伪装成超时', async () => {
  installHangingFetch()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  const error = await request(URL_OK, { method: 'GET', signal: controller.signal }, { timeoutMs: 5000 })
    .then(() => null)
    .catch((cause) => cause)
  assert.ok(error, '取消必须 reject')
  assert.notEqual(error?.name, 'ApiError', '取消不是接口错误，不能被报成超时')
  assert.equal(error?.name, 'AbortError')
})

test('超时只约束响应头：流式正文读得久也不被误杀', async () => {
  let aborted = false
  globalThis.fetch = (_url, init) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true
    })
    return Promise.resolve(
      new Response(
        new ReadableStream({
          async start(stream) {
            stream.enqueue(new TextEncoder().encode('event: ping\n\n'))
            await sleep(150)
            stream.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
            stream.close()
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    )
  }
  const response = await request(URL_OK, { method: 'POST' }, { timeoutMs: 40 })
  // 超过 40ms 预算仍在读正文：不能把还在正常产出的流掐掉
  const text = await response.text()
  assert.equal(text.includes('"ok":true'), true, '正文必须读完')
  assert.equal(aborted, false, '响应头到了之后不能再按请求预算中断连接')
})

test('超时文案 zh / en 都有且带秒数占位符', () => {
  assert.equal(typeof zh.requestTimeout, 'string')
  assert.equal(typeof en.requestTimeout, 'string')
  assert.match(zh.requestTimeout, /\{seconds\}/)
  assert.match(en.requestTimeout, /\{seconds\}/)
  assert.match(zh.requestTimeout, /超时/)
  // #568：文案改成「连接上游超时」，英文对应 connect timeout
  assert.match(en.requestTimeout, /connect timeout/i)
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
})

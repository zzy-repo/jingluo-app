// [layer: unit | dependencies: none | no build, browser, network or Android | 一个 127.0.0.1 本地 SSE 桩服务器]
//
// Issue #150：流式响应体阶段没有空闲超时。
//
// 取证（docs/ui/133-weak-device/README.md 第 2 条）：
//   S2 中途掐断  → 1.26s 报「连接中断」（#41，正常）
//   S3 龟速      → 首段正文上屏后 ≥70s 无新内容，界面无限停在 streaming 态，无超时无错误
//   S4 连不上    → 48s 后报「请求超时」（15s 预算只覆盖拿到响应头之前）
// 也就是说：`DEFAULT_REQUEST_TIMEOUT_MS` 的 15s 计时器在响应头到手时就撤掉了，
// 从那一刻起没有任何计时器 —— 上游「不断也不动」可以把界面永久挂住。
//
// 本用例的判据（对应 #150 的关闭条件）：
//   [1] 发头 + 第一段正文后长时间静默 → 必须收口成独立的空闲超时错误（改动前：无限等待）
//   [2] 反例：一直有数据、总时长远超阈值 → 不许杀（阈值是「空闲」口径，不是总时长）
//   [3] 超时后已收到的内容必须保留；错误文案可读、可重试，且不复用「无响应」那套语义
//   [4] 阈值有据可依（默认值 + 可配置 + 非法值回默认），不是拍脑袋的 0/Infinity
//
// 跑真代码：真实 streamMessage + 真实 fetch + 本地真 socket 服务器（不是假 fetch 喂字节），
// 这样「连接被晾着」的形态和线上一致。只有 Capacitor / 诊断落库换成替身。
//
//   node tests/unit/stream-idle-timeout.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createServer } from 'node:http'
import { listenFreePort } from '../helpers/ports.mjs'

const stub = (name) => new URL(`../fixtures/chat-stubs/${name}`, import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: stub('collector.mjs'), shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // 源码里的相对引用写的是构建产物名 .js，单测直接跑 .ts 源码：换后缀再试一次
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
globalThis.__log = { records: [], events: [], actions: [] }

// apiConfig 把渠道/地址存 localStorage：给个内存版，用例就能把 baseUrl 指到本地桩服务器
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}

const client = await import('../../src/services/api/client.ts')
const { ApiError, streamMessage } = client
const { classifyApiError, isRetryableApiError } = await import('../../src/services/api/errors.ts')
const { applyEvent, settleReply } = await import('../../src/services/chat/reply.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { setApiKey, setBaseUrl, setModel, setProviderKind } = await import(
  '../../src/services/api/apiConfig.ts'
)
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const KEY = 'sk-idle-timeout-test'
const BODY = { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }
/** 本用例把阈值调小到 300ms：真等 45s 的用例没人会跑第二遍 */
const TINY_IDLE_MS = 300
const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
}

/** 一条完整的 SSE 事件（末尾空行收尾）：少一个空行，事件就会和下一段粘成一包 */
const frame = (event, data) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, '', ''].join('\n')

/** 发得出去的第一段：message_start + 一段正文（对应取证里的「第一段已上屏」） */
const HEAD = [
  frame('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 9, output_tokens: 0 } },
  }),
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '已经收到的半句' },
  }),
].join('')

const TAIL = [
  frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 9, output_tokens: 8 },
  }),
  frame('message_stop', { type: 'message_stop' }),
].join('')

/** 一段正文增量，用来验证「一直有数据就不许杀」 */
const deltaFrame = (text) =>
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  })

/** 起一个本地 SSE 桩服务器；handler 拿到 (req, res, state) */
const startStub = async (handler) => {
  const state = {}
  const server = createServer((req, res) => handler(req, res, state))
  const port = await listenFreePort(server)
  const origin = `http://127.0.0.1:${port}`
  // 把当前渠道指到这个桩服务器（anthropic 协议：POST /v1/messages）
  setProviderKind('anthropic')
  setModel('deepseek-flash')
  assert.equal(setBaseUrl(origin), true, '本地桩服务器地址必须是合法 baseUrl')
  setApiKey(KEY)
  return {
    state,
    origin,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

const emptyReply = () => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 0,
  status: 'pending',
  blocks: [],
  prefix: false,
})

/**
 * 跑一次真实的 streamMessage 并按 store 的方式合并事件。
 * `limitMs` 是安全网：桩真的挂住时给个可读结论，绝不把整轮用例拖死。
 */
const runStream = async (limitMs) => {
  const controller = new AbortController()
  const blockIndexes = new Map()
  let reply = emptyReply()
  let error
  const startedAt = Date.now()
  const work = (async () => {
    try {
      for await (const event of streamMessage(KEY, BODY, controller.signal)) {
        reply = applyEvent(reply, event, 0, blockIndexes)
      }
    } catch (caught) {
      error = caught
    }
  })()
  const STILL_STREAMING = Symbol('still-streaming')
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(STILL_STREAMING), limitMs)
  })
  const outcome = await Promise.race([work.then(() => 'settled'), deadline])
  clearTimeout(timer)
  if (outcome === STILL_STREAMING) {
    // 收口后再断言：先把悬挂的连接掐掉，否则用例进程留着真 socket
    controller.abort()
    await work
  }
  return {
    error,
    reply,
    elapsed: Date.now() - startedAt,
    stillStreaming: outcome === STILL_STREAMING,
  }
}

const textOf = (reply) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/** store.streamReply 的 catch 分支对 ApiError 就是这么收尾的 */
const settle = (reply, error) =>
  settleReply(reply, 'error', 1, {
    kind: error.kind,
    message: error.message,
    status: error.status,
    localMessage: error.localMessage,
  })

/** 阈值配置入口不存在时（改动前）不改配置，让用例走到「无限等待」这个真实症状上 */
const configureIdle = (ms) =>
  typeof client.setStreamIdleTimeout === 'function' && client.setStreamIdleTimeout(ms)

test.after(() => {
  if (typeof client.setStreamIdleTimeout === 'function') {
    client.setStreamIdleTimeout(client.STREAM_IDLE_TIMEOUT_MS)
  }
})

test('流式阶段长时间没有新数据：必须收口成空闲超时错误，不能无限等待', async () => {
  configureIdle(TINY_IDLE_MS)
  const { state, close } = await startStub((req, res, st) => {
    res.writeHead(200, sseHeaders)
    res.flushHeaders()
    res.write(HEAD)
    st.sentAt = Date.now()
    // 之后就是「不断也不动」：不写、不结束、也不关（#133 的 S3 形态）
    res.on('close', () => {
      st.closedAt = Date.now()
    })
  })

  try {
    const { error, reply, elapsed, stillStreaming } = await runStream(1500)
    assert.equal(
      stillStreaming,
      false,
      '改动前：响应体阶段没有任何计时器，连接被晾住时 1.5s 内既不结束也不报错，界面永久停在 streaming 态'
    )
    assert.ok(error, '空闲超时必须抛错收口，不能把「没数据」当成正常结束')
    assert.ok(error instanceof ApiError, `空闲超时必须是 ApiError，实际 ${error?.name}`)
    assert.equal(
      error.kind,
      'idle',
      '空闲超时要自己一类 kind，不能并进 interrupted / timeout / network'
    )
    assert.equal(error.code, 'stream_idle', '空闲超时要有独立错误码，上层才能精确分支')
    assert.equal(error.status, undefined, '空闲超时没有 HTTP 状态码')
    assert.ok(
      elapsed >= TINY_IDLE_MS - 50 && elapsed < 1400,
      `应在空闲阈值附近收口（阈值 ${TINY_IDLE_MS}ms，实际 ${elapsed}ms）`
    )
    assert.ok(state.sentAt, '桩服务器确实发过第一段正文')
    // 断开是异步的：给底层一点传播时间，再确认桩服务器真的收到 close
    const closedBy = Date.now() + 800
    while (!state.closedAt && Date.now() < closedBy) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(state.closedAt, '超时后必须真的断开底层连接（不留悬挂 socket）')
    assert.equal(textOf(reply), '已经收到的半句', '超时前收到的正文不能丢')
  } finally {
    await close()
  }
})

test('反例：一直有数据时，总时长远超阈值也不许超时', async () => {
  configureIdle(TINY_IDLE_MS)
  // 每 80ms 一段正文，一共 12 段 + 收尾 ≈ 1s，总时长是阈值的 3 倍多
  const gapMs = 80
  const pieces = Array.from({ length: 12 }, (_, index) => `第${index + 1}段`)
  const { close } = await startStub((req, res) => {
    res.writeHead(200, sseHeaders)
    res.flushHeaders()
    res.write(
      [
        frame('message_start', {
          type: 'message_start',
          message: { usage: { input_tokens: 9, output_tokens: 0 } },
        }),
        frame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      ].join('')
    )
    let index = 0
    const tick = setInterval(() => {
      if (index < pieces.length) {
        res.write(deltaFrame(pieces[index]))
        index += 1
        return
      }
      clearInterval(tick)
      res.write(TAIL)
      res.end()
    }, gapMs)
    res.on('close', () => clearInterval(tick))
  })

  try {
    const { error, reply, elapsed, stillStreaming } = await runStream(6000)
    assert.equal(stillStreaming, false, '正常出字的流必须能收尾')
    assert.equal(error, undefined, `总时长 ${elapsed}ms 但一直在出字，不许判超时`)
    assert.equal(settleReply(reply, 'done', 1).status, 'done', '长回答正常结束')
    assert.equal(textOf(reply), pieces.join(''), '长回答的正文一字都不能少')
    assert.ok(elapsed > TINY_IDLE_MS, `本例总时长必须超过阈值才有意义（实际 ${elapsed}ms）`)
  } finally {
    await close()
  }
})

test('超时后已收内容保留，提示可读、可重试，且不复用「无响应」语义', async () => {
  configureIdle(TINY_IDLE_MS)
  const { close } = await startStub((req, res) => {
    res.writeHead(200, sseHeaders)
    res.flushHeaders()
    res.write(HEAD)
    res.write(deltaFrame('，还差最后一句'))
    // 静默
  })

  try {
    const { error, reply, stillStreaming } = await runStream(1500)
    assert.equal(stillStreaming, false, '静默必须收口（改动前：无限等待）')
    assert.ok(error instanceof ApiError, '空闲超时必须抛 ApiError')

    const settled = settle(reply, error)
    assert.equal(settled.status, 'error', '空闲超时落在 error 状态，用户能重新生成')
    assert.equal(textOf(settled), '已经收到的半句，还差最后一句', '已经收到的内容必须保留')

    // 文案：i18n 里真有这个 key，中英都齐全，读得出来是「等了太久」而不是「没响应」
    const key = error.localMessage?.key
    assert.ok(key, '空闲超时要有界面文案 key，不能只留内部 English 原文')
    assert.ok(String(zh[key] ?? '').length > 0, `zh 缺少文案：${key}`)
    assert.ok(String(en[key] ?? '').length > 0, `en 缺少文案：${key}`)
    assert.equal(error.message, translate(key), 'error.message 就是本地化文案')

    const notice = describeReply(settled)
    assert.ok(notice, '超时后必须有提示，不能静默收尾')
    assert.equal(notice.text, translate(key), '界面提示用这条文案')
    assert.notEqual(
      notice.text,
      translate('requestTimeout'),
      '不许复用「请求超时（N 秒没有响应）」那套语义：#150 是响应体阶段空闲，不是请求没发出去'
    )
    assert.doesNotMatch(notice.text, /没有响应/, '文案不能说成「没有响应」')
    assert.match(notice.text, /停止|重新生成/, '文案要给出可操作的出口')

    // 分类与重试：独立一类，且允许重试（换一条连接通常就好了）
    assert.equal(classifyApiError(error), 'idle', 'classifyApiError 要把空闲超时单列')
    assert.equal(isRetryableApiError(error), true, '空闲超时可重试')
    assert.notEqual(classifyApiError(error), 'interrupted', '不能并进断流（#41 是另一层问题）')
  } finally {
    await close()
  }
})

test('阈值的默认值有据可依，且可配置；非法值回默认（不允许关掉超时）', () => {
  // 前面的用例把阈值调小过，这里先回到默认口径
  configureIdle(Number.POSITIVE_INFINITY)
  assert.equal(
    typeof client.STREAM_IDLE_TIMEOUT_MS,
    'number',
    '空闲阈值必须是具名常量（注释里要写清为什么是这个数量级）'
  )
  assert.equal(
    typeof client.getStreamIdleTimeout,
    'function',
    '要有 getStreamIdleTimeout（默认值可被读到）'
  )
  assert.equal(
    typeof client.setStreamIdleTimeout,
    'function',
    '要有 setStreamIdleTimeout（测试/诊断要能调小）'
  )

  const fallback = client.STREAM_IDLE_TIMEOUT_MS
  assert.equal(client.getStreamIdleTimeout(), fallback, '未配置时用默认值')
  // 默认值要比请求头预算（15s）宽得多：正文阶段的弱网抖动比建连更常见，
  // 但又要小于「用户已经在怀疑卡死」的 60s 量级，否则体验上等于没超时。
  assert.ok(
    fallback > client.DEFAULT_REQUEST_TIMEOUT_MS,
    `空闲阈值应明显大于响应头预算（${client.DEFAULT_REQUEST_TIMEOUT_MS}ms），实际 ${fallback}ms`
  )
  assert.ok(fallback <= 60_000, `空闲阈值不能大到用户以为卡死，实际 ${fallback}ms`)

  try {
    client.setStreamIdleTimeout(1234)
    assert.equal(client.getStreamIdleTimeout(), 1234, '可配置')
    client.setStreamIdleTimeout(Number.NaN)
    assert.equal(client.getStreamIdleTimeout(), fallback, '非法值回默认，不能变成「永不超时」')
    client.setStreamIdleTimeout(0)
    assert.equal(client.getStreamIdleTimeout(), fallback, '0 不是有效阈值，回默认')
    client.setStreamIdleTimeout(-1)
    assert.equal(client.getStreamIdleTimeout(), fallback, '负数不是有效阈值，回默认')
  } finally {
    client.setStreamIdleTimeout(fallback)
  }
})

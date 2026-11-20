// 域 2（Issue #362 / #367）集成用例共用的**流式** mock 上游。
//
// 为什么不用 `page.route` + `route.fulfill`：那是一次性把整段 SSE 塞进响应，
// 浏览器侧「逐字上屏 / 流到一半点停止 / 上游挂着不动」这些形态根本造不出来
// （#362 盘点里 F2-03 的缺口就是「全仓没有一处 `.click()` 点停止」——因为造不出「正在流」的状态）。
// 这里起一个真的 HTTP 服务，按块 + 按延时下发，客户端就是真的读流。
//
// 用法：把 App 切到「Anthropic 协议」渠道并把服务地址指到这个服务（见 `configureAnthropicChannel`），
// 于是所有请求都落在本机，不连外网、也不需要 CORS 之外的任何东西。
import http from 'node:http'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'x-api-key,content-type,anthropic-version,authorization,x-session-id',
  'access-control-max-age': '600',
}

/** 标准 Anthropic SSE 的一段（message_start + content_block_start），供各行为复用 */
const sseStart = (model) => [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 0 },
    },
  })}`,
  '',
  'event: content_block_start',
  `data: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}`,
  '',
]

const sseDelta = (text) => [
  'event: content_block_delta',
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
  '',
]

const sseEnd = () => [
  'event: content_block_stop',
  `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 12 },
  })}`,
  '',
  'event: message_stop',
  `data: ${JSON.stringify({ type: 'message_stop' })}`,
  '',
  '',
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 起 mock 上游。返回 { url, state, close }。
 * `state.respond(callIndex, res)` 由每个用例按行改写；默认 = 正常完整流式回答。
 * `state.calls` 记录每次 POST /messages 的请求体（含自动标题请求），
 * `state.chatCalls` 只记**回答**请求 —— 断言「发了几次 / 是否重发」一律看后者。
 */
export const startMockUpstream = async ({ host = '127.0.0.1' } = {}) => {
  const state = {
    /** 所有 POST /messages 请求（含自动标题请求） */
    calls: [],
    /** 只算「回答」请求，不含自动标题 —— 用例断言「发了几次」一律看这里 */
    chatCalls: [],
    /** 每次回答请求的行为，可在用例中途替换；参数是第几次**回答**请求（1 起，不含标题） */
    respond: async (callIndex, res) => {
      await writeStream(res, { chunks: ['你好', '呀，', '这是', '流式回答'], gapMs: 40 })
    },
    /** 自动标题请求（首轮回答结束后 App 会补一次，max_tokens=32）的默认应答 */
    respondTitle: async (res) => {
      await writeStream(res, { chunks: ['会话标题'] })
    },
  }

  const server = http.createServer(async (req, res) => {
    for (const [header, value] of Object.entries(CORS)) {
      res.setHeader(header, value)
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const { pathname } = new URL(req.url, 'http://mock')
    if (req.method === 'GET' && /\/models$/.test(pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ data: [{ id: 'mock-model', type: 'model' }], has_more: false })
      )
      return
    }
    if (req.method === 'POST' && /\/messages$/.test(pathname)) {
      const body = await readBody(req)
      state.calls.push({ url: req.url, headers: req.headers, body })
      // 自动标题请求与回答请求走同一个端点（Anthropic 协议没有服务端标题），
      // 靠 max_tokens=32 区分（见 src/services/chat/autoTitle.ts 的 AUTO_TITLE_MAX_OUTPUT_TOKENS）；
      // 否则「发了几次回答」会被标题请求 +1，停止/重试的断言全部失真。
      const title = Number(body?.max_tokens) === 32
      try {
        if (title) {
          await state.respondTitle(res)
        } else {
          state.chatCalls.push({ url: req.url, headers: req.headers, body })
          await state.respond(state.chatCalls.length, res, body)
        }
      } catch (error) {
        console.error('[mock-upstream] respond failed:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: String(error) } }))
        } else {
          res.end()
        }
      }
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"not found"}}')
  })

  await new Promise((resolve) => server.listen(0, host, resolve))
  const { port } = server.address()
  return {
    url: `http://${host}:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const readBody = (req) =>
  new Promise((resolve) => {
    const parts = []
    req.on('data', (chunk) => parts.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8')
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve({ raw: text })
      }
    })
  })

const writeSseHeaders = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.flushHeaders?.()
}

/** 正常完整流式回答：按 chunks 逐块下发，块间 gapMs 毫秒 */
export const writeStream = async (res, { chunks, gapMs = 40 }) => {
  writeSseHeaders(res)
  for (const line of sseStart('mock-model')) {
    res.write(`${line}\n`)
  }
  for (const chunk of chunks) {
    await sleep(gapMs)
    if (res.destroyed || res.writableEnded) {
      return
    }
    for (const line of sseDelta(chunk)) {
      res.write(`${line}\n`)
    }
  }
  await sleep(gapMs)
  if (res.destroyed || res.writableEnded) {
    return
  }
  for (const line of sseEnd()) {
    res.write(`${line}\n`)
  }
  res.end()
}

/** 流到一半就停住（连接不断、也不再发数据）：用来造「正在生成」状态，给「点停止」用 */
export const writePartialThenHang = async (res, { chunks = ['前半句', '还没说完'] } = {}) => {
  writeSseHeaders(res)
  for (const line of sseStart('mock-model')) {
    res.write(`${line}\n`)
  }
  for (const chunk of chunks) {
    await sleep(60)
    for (const line of sseDelta(chunk)) {
      res.write(`${line}\n`)
    }
  }
  // 故意不 end、也不发 message_stop：客户端会一直处于 streaming
  await new Promise((resolve) => res.on('close', resolve))
}

/** 断流：发了几块正文后直接结束响应，不发 message_stop（= F2-09 的「连接中断」） */
export const writeCut = async (res, { chunks = ['收到一半'] } = {}) => {
  writeSseHeaders(res)
  for (const line of sseStart('mock-model')) {
    res.write(`${line}\n`)
  }
  for (const chunk of chunks) {
    await sleep(40)
    for (const line of sseDelta(chunk)) {
      res.write(`${line}\n`)
    }
  }
  res.end()
}

/** 只有响应头、正文一个字节都不发（= F2-09 的空闲超时 / F2-10 的首字等待） */
export const writeHeadersThenHang = async (res) => {
  writeSseHeaders(res)
  await new Promise((resolve) => res.on('close', resolve))
}

/** HTTP 状态码 + JSON 错误体（401 / 429 / 502 / 413 …） */
export const writeJsonError = async (res, status, error) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'error', error }))
}

/**
 * 把 App 指到「Anthropic 协议」渠道 + 本机 mock 上游。
 * 字段名与 `src/services/api/apiConfig.ts` 的 CONFIG_KEYS 一致（都是 localStorage 键）。
 */
export const configureAnthropicChannel = async (page, { url, apiKey }) => {
  await page.evaluate(
    ([baseUrl, key]) => {
      window.localStorage.setItem('chat-demo:provider-kind', 'anthropic')
      window.localStorage.setItem('chat-demo:api-key', key)
      window.localStorage.setItem('chat-demo:base-url:anthropic', baseUrl)
      window.localStorage.setItem('chat-demo:model:anthropic', 'mock-model')
    },
    [url, apiKey]
  )
}

/**
 * 带思考块的完整回答：先流思考、再流正文（= F2-11「思考过程折叠/隐藏」的真实形态）。
 * `holdMs` 是思考结束到正文开始之间的停顿，用来观察「流式时自动展开」那一段。
 */
export const writeThinkingStream = async (
  res,
  { thinking = ['正在推理第一步，', '再验证第二步'], answer = ['最终答案正文'], gapMs = 60, holdMs = 700 } = {}
) => {
  writeSseHeaders(res)
  for (const line of sseStart('mock-model')) {
    res.write(`${line}\n`)
  }
  // content_block index 0 = 思考块
  for (const line of [
    'event: content_block_start',
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}`,
    '',
  ]) {
    res.write(`${line}\n`)
  }
  for (const chunk of thinking) {
    await sleep(gapMs)
    for (const line of [
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: chunk } })}`,
      '',
    ]) {
      res.write(`${line}\n`)
    }
  }
  for (const line of [
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-mock' } })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
  ]) {
    res.write(`${line}\n`)
  }
  await sleep(holdMs)
  // content_block index 1 = 正文
  for (const line of [
    'event: content_block_start',
    `data: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}`,
    '',
  ]) {
    res.write(`${line}\n`)
  }
  for (const chunk of answer) {
    await sleep(gapMs)
    for (const line of [
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: chunk } })}`,
      '',
    ]) {
      res.write(`${line}\n`)
    }
  }
  for (const line of [
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
    '',
  ]) {
    res.write(`${line}\n`)
  }
  res.end()
}

/**
 * 响应头已发、正文一直不来的**挂起**形态，但每隔 intervalMs 发一个 SSE 注释/心跳事件：
 * - 心跳不会被当成正文（`event: ping` 是未识别事件，客户端静默丢弃），所以界面一直停在「等待首字」；
 * - 但它会让「建连预算」与「空闲超时」都不触发——否则 15s 建连超时 / 45s 空闲超时会先于
 *   5s / 30s / 60s 三档提示把这一轮判失败，F2-10 的三档就永远看不到。
 */
export const writeKeepAliveHang = async (res, { intervalMs = 2000 } = {}) => {
  writeSseHeaders(res)
  const timer = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      return
    }
    res.write('event: ping\ndata: {"type":"ping"}\n\n')
  }, intervalMs)
  await new Promise((resolve) => res.on('close', resolve))
  clearInterval(timer)
}

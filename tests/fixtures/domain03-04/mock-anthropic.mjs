// 内测版验收用的本地 mock 上游：只用 node 标准库，不依赖任何真实上游（内测上游号池耗尽）。
//
//   node tests/mock-anthropic.mjs            # 监听 config/endpoints.json 里的聊天上游（需先把该 IP 绑到 lo）
//   node tests/mock-anthropic.mjs --host 127.0.0.1
//
// 行为（模拟内测版固定上游「只有 /v1/messages，没有 /anthropic 前缀」）：
//   OPTIONS /v1/messages, /v1/models  → 204 + CORS 预检应答（放行 x-api-key / content-type）
//   GET     /v1/models               → {"data":[{"id":"deepseek-v4.1-flash"}]}
//   POST    /v1/messages             → 标准 Anthropic SSE，正文分三块逐字下发
//
// 每收到一个请求都会把 {method,url,headers,body} 追加到 MOCK_LOG（默认
// /tmp/mock-anthropic-requests.jsonl），验收脚本据此断言请求 URL 与请求体。
import http from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

import { endpointHosts } from '../../../scripts/lib/endpoints.mjs'

const args = process.argv.slice(2)
const hostArg = args.indexOf('--host')
const HOST = hostArg >= 0 ? args[hostArg + 1] : process.env.MOCK_HOST || endpointHosts[0]
const PORT = Number(process.env.MOCK_PORT || 60010)
export const LOG = process.env.MOCK_LOG || '/tmp/mock-anthropic-requests.jsonl'
const REPLY_TEXT = process.env.MOCK_REPLY_TEXT || '内测版验收回复：固定服务地址与模型已生效，逐字流出。'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'x-api-key,content-type,anthropic-version,authorization',
  'access-control-max-age': '600',
}

/** 标准 Anthropic SSE（正文切成三块，检验增量拼接） */
const sseChunks = (text, model) => {
  const pieces = [text.slice(0, 6), text.slice(6, 14), text.slice(14)]
  const out = [
    'event: message_start',
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_mock_internal',
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 0 },
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
  for (const piece of pieces) {
    if (!piece) {
      continue
    }
    out.push(
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: piece },
      })}`,
      ''
    )
  }
  out.push(
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 24 },
    })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
    ''
  )
  return out.join('\n')
}

const record = (entry) => {
  try {
    appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
  } catch {
    // 日志不可写不影响应答
  }
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const server = http.createServer(async (req, res) => {
  const url = `http://${HOST}:${PORT}${req.url}`
  const body = await readBody(req)
  record({ method: req.method, url, path: req.url, headers: req.headers, body })

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models') {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash', type: 'model' }], has_more: false }))
    return
  }

  if (req.method === 'POST' && req.url.split('?')[0] === '/v1/messages') {
    let model = 'deepseek-v4.1-flash'
    try {
      model = JSON.parse(body).model ?? model
    } catch {
      // 请求体不是 JSON 也照样回一段合法 SSE，方便定位问题
    }
    res.writeHead(200, {
      ...CORS,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // 逐块下发（20ms 间隔），让前端真的走流式渲染
    const lines = sseChunks(REPLY_TEXT, model).split('\n')
    let i = 0
    const timer = setInterval(() => {
      if (i >= lines.length) {
        clearInterval(timer)
        res.end()
        return
      }
      res.write(`${lines[i]}\n`)
      i += 1
    }, 20)
    req.on('close', () => clearInterval(timer))
    return
  }

  res.writeHead(404, { ...CORS, 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { type: 'not_found', message: `no mock route for ${req.url}` } }))
})

try {
  writeFileSync(LOG, '')
} catch {
  // 忽略
}

server.listen(PORT, HOST, () => {
  console.log(`mock anthropic upstream on http://${HOST}:${PORT} (log: ${LOG})`)
})

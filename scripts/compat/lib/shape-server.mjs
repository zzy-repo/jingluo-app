// Issue #133 取证：宿主机「弱网 / 断网」整形服务。
//
// 只伪造四种上游形态，从不参与产品逻辑；App 侧只改 localStorage 里的 baseUrl：
//   /ok       正常 200 + SSE 分片，完整收尾（对照组）
//   /hold     收下请求后一个字节都不回（模拟「半死连接 / 域名黑洞」）→ 只能靠 15s 超时兜底
//   /cut      200 + 先发两段正文，随后直接 destroy socket（模拟「回了两句就断」）
//   /trickle  200 + 每 3 秒一段正文，持续 24 秒（模拟极慢速弱网，无超时但有内容到达）
//
// 端口 5399；未监听端口（5398）用于「连接被拒」的不可达对照。
import { createServer } from 'node:http'

const PORT = Number(process.env.SHAPE_PORT || 5399)
const DELTA_TEXT = '这是一段用于弱网取证的正文内容，用来观察流式回答在异常网络下的界面表现。'

const sse = (res, text) =>
  `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'probe-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`

const headers = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
}

const log = (...args) => console.log(new Date().toISOString(), ...args)

const server = createServer((req, res) => {
  const url = req.url ?? '/'
  const scenario = url.split('/')[1] || 'ok'
  log(`${req.method} ${url} -> ${scenario}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    })
    res.end()
    return
  }
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'probe-model', object: 'model' }] }))
    return
  }

  req.resume()
  req.on('end', () => {
    if (scenario === 'hold') {
      // 什么都不发：连接一直挂着，靠客户端 15s 超时收场
      log('  hold: 请求已收下，不回任何字节')
      return
    }
    if (scenario === 'cut') {
      headers(res)
      res.write(sse(res, '收到你的问题，我先看第一段：'))
      setTimeout(() => res.write(sse(res, '这个现象通常是依赖数组漏项。')), 400)
      setTimeout(() => {
        log('  cut: 发完两段后 destroy')
        res.socket?.destroy()
      }, 1200)
      return
    }
    if (scenario === 'trickle') {
      headers(res)
      res.write(sse(res, '慢速网络下第 1 段。'))
      let count = 1
      const timer = setInterval(() => {
        count += 1
        log(`  trickle: 第 ${count} 段`)
        res.write(sse(res, `第 ${count} 段。${DELTA_TEXT}`))
        if (count >= 8) {
          clearInterval(timer)
          res.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', model: 'probe-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }
      }, 3000)
      // Node 里 IncomingMessage 的 'close' 在请求体读完就已触发，用它清理会让滴流只发第 1 段；
      // 必须挂到响应上（客户端真的断开时才清）
      res.on('close', () => clearInterval(timer))
      return
    }
    // ok
    headers(res)
    res.write(sse(res, '这是对照组：'))
    setTimeout(() => res.write(sse(res, '正常 200 + SSE 分片，')), 300)
    setTimeout(() => res.write(sse(res, '回答完整收尾。')), 700)
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', model: 'probe-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }, 1000)
  })
})

server.listen(PORT, '0.0.0.0', () => log(`整形服务已就绪: http://0.0.0.0:${PORT}`))

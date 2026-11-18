// 「我们的渠道」（ours）上游契约 —— 只有一处定义，改契约就改这里。
//
// 现状（1.4.0-beta.6 起，src/services/api/providers.ts 的 ours spec）：
//   地址    http://62.106.70.167:60010      （内置，设置页不渲染）
//   模型    deepseek-v4.1-flash             （内置）
//   协议    OpenAI 兼容：POST /v1/chat/completions，SSE 事件是 chat.completion.chunk + [DONE]
//   鉴权    Authorization: Bearer <key>      （不带 x-api-key、不带 anthropic-version）
//   能力    只有基础对话（无深度思考 / 搜索 / 附件 / 语音）
//
// 历史坑（Issue #19）：地址曾是 http://123.207.199.196:60010 且走 Anthropic Messages 协议
// （/v1/messages + x-api-key），契约换了以后 motion / mode-switch / provider-channels /
// internal-build 里各自写死的旧打桩全变假红。这里集中成 fixture，用例只 import 常量。
export const OURS_HOST = 'http://62.106.70.167:60010'
export const OURS_MODEL = 'deepseek-v4.1-flash'
export const OURS_CHAT_PATH = '/v1/chat/completions'
export const OURS_CHAT_URL = `${OURS_HOST}${OURS_CHAT_PATH}`

/** 中转服务的 CORS 预检只放行这些头（多带 anthropic-version 会让预检失败） */
export const OURS_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '600',
}

/**
 * OpenAI 形状的流式响应（chat.completion.chunk）。
 * 文本分 3 段吐，便于断言「逐字流出」类行为。
 */
export const openAiSse = (text) => {
  const pieces = [text.slice(0, 6), text.slice(6, 14), text.slice(14)].filter(Boolean)
  const chunk = (delta, extra = {}) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock-ours',
      object: 'chat.completion.chunk',
      model: OURS_MODEL,
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    })}`
  const lines = [chunk({ role: 'assistant', content: '' }), '']
  for (const piece of pieces) {
    lines.push(chunk({ content: piece }), '')
  }
  lines.push(
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock-ours',
      object: 'chat.completion.chunk',
      model: OURS_MODEL,
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 },
    })}`,
    '',
    `data: ${JSON.stringify({
      id: 'chatcmpl-mock-ours',
      object: 'chat.completion.chunk',
      model: OURS_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}`,
    '',
    'data: [DONE]',
    '',
    ''
  )
  return lines.join('\n')
}

/** 非流式 JSON 响应（/models 探测用） */
export const modelsJson = () => JSON.stringify({ object: 'list', data: [{ id: OURS_MODEL, object: 'model' }] })

/**
 * 用 page.route 打桩整个 ours 上游；命中记录进 hits（{method, path, headers, body}）。
 * 不依赖真实网络，也不需要把上游 IP 绑到回环。
 */
export const routeOurs = async (page, { reply = 'mock 回复', hits = [] } = {}) => {
  await page.route(`${OURS_HOST}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: OURS_CORS, body: '' })
      return
    }
    hits.push({
      method: request.method(),
      path: url.pathname,
      headers: request.headers(),
      body: request.postData(),
    })
    if (url.pathname.endsWith('/models')) {
      await route.fulfill({
        status: 200,
        headers: { ...OURS_CORS, 'content-type': 'application/json' },
        body: modelsJson(),
      })
      return
    }
    await route.fulfill({
      status: 200,
      headers: { ...OURS_CORS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: openAiSse(reply),
    })
  })
  return hits
}

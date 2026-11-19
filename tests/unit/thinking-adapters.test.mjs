// [layer: unit | 依赖: 无（纯 Node + 本机 mock 上游，零浏览器零真实上游） | 耗时: <2s]
//
// GitHub issue #297：深度思考适配 —— oai 渠道显式思考参数（三档）+ ath 渠道核校，
// 「UI 开关必须真实生效」。
//
// 本用例是这一单的**唯一证据来源**（issue 的验收口径就是「全部以 mock 为准」）：
//   · 真 mock 上游（node:http）**记录收到的请求体**并回放 SSE —— 断言的是 JSON，不是源码正则；
//   · 请求体由**真代码**拼：`chat/requestBody.ts` 的 buildMessageBody（store.ts 用的就是它）
//     + 真正的 `client.ts` streamMessage 打出去（路径、鉴权头、适配层翻译全走真链路）；
//   · UI 断言在 DOM 层：`react-dom/server` 渲染**真的开关组件** `ThinkingToggle.ts`，
//     断言 `data-thinking-toggle` 节点在不在、`aria-pressed` 是 true 还是 false。
//     （纯 Node 认得 .ts 但认不出 JSX，按 #158/#189 的做法把「怎么显示」放在 .ts 里。）
//
// 覆盖（对应 issue「验收」1–4 的每个子项）：
//   [1] oai + none          → 请求体不含 reasoning_effort，也不含 thinking
//   [2] oai + reasoning_effort → 含 reasoning_effort: 'medium'
//   [3] oai + thinking_enabled → 含 thinking: { type: 'enabled' }
//   [4] oai 关闭开关        → 非 none 档也不发思考参数
//   [5] ath 开              → 含 thinking: { type: 'enabled', budget_tokens: 4096 }
//   [6] ath 关              → 不含 thinking 参数（type=disabled 且没有 budget_tokens）
//   [7] deepseek 开         → thinking:{type:'enabled'} 且不带 budget_tokens（回归：不动官方渠道）
//   [8] ours                → 不发任何思考参数（回归：内测渠道不受影响）
//   [9] 响应侧 oai          → reasoning_content → thinking 块 + thinking_delta，正文进 text 块
//  [10] 响应侧 ath          → thinking_delta 事件同理
//  [11] UI：四渠道开关恒常驻 + data-thinking-effective 标记（#341）
//  [12] UI：点击后 aria-pressed 翻转 + 写入 settings（四渠道各一遍）
//  [13] thinkingDisplay=hidden：思考内容不渲染，但请求仍带思考参数
//  [14] 负向：mock 回 400 unknown_parameter → 可读报错、不卡死、不重试
//  [15] 负向：只回 content 不回 reasoning_content → 不产生空 thinking 块
//  [16] 负向：非法 reasoningParam → 门禁 fail-closed，一个思考字段都不发
//  [17] 接线：ChatInput 真的渲染 ThinkingToggle（不是只加了个没人调的组件）
//
//   node tests/run-layer.mjs unit --only thinking-adapters
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})

/** 最小 localStorage：settings.ts / apiConfig.ts 只在读不到时回落默认值 */
const storage = new Map()
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
// 构建期注入值（真实构建由 rspack DefinePlugin 给，单测自己补）
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const providers = await import('../../src/services/api/providers.ts')
const settings = await import('../../src/services/settings.ts')
const thinkingDisplay = await import('../../src/components/messages/thinkingDisplay.ts')
const { buildMessageBody } = await import('../../src/services/chat/requestBody.ts')
const { ApiError, streamMessage } = await import('../../src/services/api/client.ts')
const { ThinkingToggle, THINKING_TOGGLE_ATTR } = await import(
  '../../src/components/chatInput/ThinkingToggle.ts'
)
const { listenFreePort } = await import('../helpers/ports.mjs')

// ---------- mock 上游：记录请求体 + 回放 SSE ----------

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'x-api-key,content-type,anthropic-version,authorization',
}
const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' }

/** OpenAI 兼容流的 data 行 */
const openaiSse = (chunks) =>
  `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`

/** 带 reasoning_content 的 OpenAI 流：先思考后正文 */
const openaiReasoningSse = (reasoning, content) =>
  openaiSse([
    { id: 'chatcmpl-mock', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-mock', choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] },
    { id: 'chatcmpl-mock', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id: 'chatcmpl-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])

/** 只回 content（负向：不许凭空造一个空 thinking 块） */
const openaiContentOnlySse = (content) =>
  openaiSse([
    { id: 'chatcmpl-mock', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-mock', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id: 'chatcmpl-mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])

/** Anthropic 协议流（thinking 块的路径与真上游一致：content_block_start(thinking) + thinking_delta） */
const anthropicSse = ({ thinking = '', content = '' } = {}) => {
  const lines = []
  const push = (event, payload) => {
    lines.push(`event: ${event}`, `data: ${JSON.stringify(payload)}`, '')
  }
  push('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock_ath',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'mock-model',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  })
  const textIndex = thinking ? 1 : 0
  if (thinking) {
    push('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    })
    push('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    })
    push('content_block_stop', { type: 'content_block_stop', index: 0 })
  }
  push('content_block_start', {
    type: 'content_block_start',
    index: textIndex,
    content_block: { type: 'text', text: '' },
  })
  push('content_block_delta', {
    type: 'content_block_delta',
    index: textIndex,
    delta: { type: 'text_delta', text: content },
  })
  push('content_block_stop', { type: 'content_block_stop', index: textIndex })
  push('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  push('message_stop', { type: 'message_stop' })
  return `${lines.join('\n')}\n\n`
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })

const startMock = async () => {
  /** 每个请求都记下来：{method, path, headers, raw, json} —— 断言对象就是 json */
  const requests = []
  let handler = () => ({ status: 200, headers: SSE_HEADERS, body: anthropicSse({ content: '你好' }) })
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    let json = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = null
    }
    const entry = { method: req.method, path: String(req.url ?? '').split('?')[0], headers: req.headers, raw, json }
    if (req.method !== 'OPTIONS') {
      requests.push(entry)
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    const reply = handler(entry)
    res.writeHead(reply.status, { ...CORS, ...reply.headers })
    res.end(reply.body ?? '')
  })
  const port = await listenFreePort(server)
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** 只算 POST：一次请求 = 一条记录，用来证明「没有无限重试」 */
    posts: () => requests.filter((item) => item.method === 'POST'),
    lastJson: () => requests.at(-1)?.json ?? null,
    on: (fn) => {
      handler = fn
    },
    reset: () => {
      requests.length = 0
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}

const mock = await startMock()
after(() => mock.close())

// ---------- 渠道切换（真 spec + 真派生） ----------

/** 渠道配置好后，把 mock 地址塞进去；reasoningParam 改动后按 app 启动时的同一条派生重算 caps.thinking */
const pristine = Object.fromEntries(
  providers.PROVIDER_KINDS.map((kind) => {
    const spec = providers.getSpec(kind)
    return [
      kind,
      {
        reasoningParam: spec.reasoningParam,
        reasoningEffort: spec.reasoningEffort,
        thinkingCap: spec.caps.thinking,
        baseUrl: spec.defaults?.baseUrl,
      },
    ]
  })
)

const useChannel = (kind, { reasoningParam, reasoningEffort } = {}) => {
  const spec = providers.getSpec(kind)
  const base = pristine[kind]
  localStorage.setItem('chat-demo:provider-kind', kind)
  localStorage.setItem('chat-demo:api-key', 'sk-mock-thinking-297')
  if (!spec.locked) {
    localStorage.setItem(`chat-demo:model:${kind}`, 'mock-model')
  }
  // 每个用例都先回到出厂 spec（子测试之间不互相污染），再施加本用例的档位
  spec.reasoningParam = base.reasoningParam
  spec.reasoningEffort = base.reasoningEffort
  spec.caps.thinking = base.thinkingCap
  spec.defaults = { ...spec.defaults, baseUrl: spec.locked ? mock.url : base.baseUrl }
  if (spec.locked) {
    // ours 是 locked 渠道（地址只认 spec.defaults），其它渠道按渠道分开存
    spec.defaults = { ...spec.defaults, baseUrl: mock.url }
  } else if (base.baseUrl) {
    // deepseek：地址来自 spec.defaults，老用户那份共享 key 只对它生效
    localStorage.setItem('chat-demo:base-url', mock.url)
  } else {
    localStorage.setItem(`chat-demo:base-url:${kind}`, mock.url)
  }
  if (reasoningParam !== undefined) {
    spec.reasoningParam = reasoningParam
    if (reasoningEffort !== undefined) {
      spec.reasoningEffort = reasoningEffort
    }
    // 与 providers.ts 的 withDerivedCaps 同一条派生：caps.thinking 从 thinkingAvailable 来
    spec.caps.thinking = providers.thinkingAvailable(spec)
  }
  return spec
}

const ASK = {
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages: [{ role: 'user', content: '你好' }],
}

/** 走真链路发一次：buildMessageBody（store 用的同一个函数）→ client.streamMessage → mock */
const send = async (kind, { thinking, search = false, title = false, patch } = {}) => {
  const spec = useChannel(kind, patch)
  const body = buildMessageBody(spec, { model: 'mock-model', ...ASK, thinking, search, title })
  const events = []
  for await (const event of streamMessage('sk-mock-thinking-297', body, new AbortController().signal)) {
    events.push(event)
  }
  return { body, events, received: mock.lastJson() }
}

const types = (events) => events.map((event) => event.type)

/** mock 真正收到的请求体片段，报告里贴的就是它 */
const snippet = (json) => JSON.stringify(json ?? null)

// ============ [1]–[4] oai 三档 ============
test('[1] oai + reasoningParam=none：请求体不含 reasoning_effort / thinking', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('你好') }))
  const { received } = await send('openai', { thinking: true })
  assert.ok(received, 'mock 没收到请求体')
  assert.equal(Object.hasOwn(received, 'reasoning_effort'), false, `不该带 reasoning_effort：${snippet(received)}`)
  assert.equal(Object.hasOwn(received, 'thinking'), false, `不该带 thinking：${snippet(received)}`)
  assert.deepEqual(Object.keys(received).sort(), ['messages', 'model', 'stream', 'stream_options'], `顶层字段不对：${snippet(received)}`)
  // 能力侧：默认 none 的 oai 渠道 caps.thinking 必须是 false（入口常驻，但标记为不生效、请求不带参数）
  assert.equal(providers.getSpec('openai').caps.thinking, false, 'oai 默认档不该声明思考能力')
  assert.equal(providers.requestGates(providers.getSpec('openai')).reasoning_param, false)
})

test('[2] oai + reasoning_effort：请求体含 reasoning_effort: "medium"', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('你好') }))
  const { received, body } = await send('openai', { thinking: true, patch: { reasoningParam: 'reasoning_effort' } })
  assert.equal(received?.reasoning_effort, 'medium', `没带 reasoning_effort: "medium"：${snippet(received)}`)
  assert.equal(Object.hasOwn(received ?? {}, 'thinking'), false, `reasoning_effort 档不该带 thinking：${snippet(received)}`)
  assert.equal(body.thinking.type, 'enabled', '请求侧（适配前）必须是开启态')
  assert.equal(providers.getSpec('openai').caps.thinking, true, '这一档必须声明思考能力，否则 data-thinking-effective 会误报')
})

test('[3] oai + thinking_enabled：请求体含 thinking: { type: "enabled" }', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('你好') }))
  const { received } = await send('openai', { thinking: true, patch: { reasoningParam: 'thinking_enabled' } })
  assert.deepEqual(received?.thinking, { type: 'enabled' }, `没带 thinking:{type:'enabled'}：${snippet(received)}`)
  assert.equal(Object.hasOwn(received ?? {}, 'reasoning_effort'), false, `这一档不该带 reasoning_effort：${snippet(received)}`)
})

test('[4] oai 关掉开关：非 none 档也不发思考参数', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('你好') }))
  for (const reasoningParam of ['reasoning_effort', 'thinking_enabled']) {
    mock.reset()
    const { received } = await send('openai', { thinking: false, patch: { reasoningParam } })
    assert.equal(Object.hasOwn(received ?? {}, 'reasoning_effort'), false, `${reasoningParam} 关闭态不该带 reasoning_effort：${snippet(received)}`)
    assert.equal(Object.hasOwn(received ?? {}, 'thinking'), false, `${reasoningParam} 关闭态不该带 thinking：${snippet(received)}`)
  }
})

// ============ [5]–[6] ath（Anthropic 协议）核校 ============
test('[5] ath 开：请求体含 thinking:{type:enabled,budget_tokens:4096}', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: anthropicSse({ thinking: '先想一下', content: '你好' }) }))
  const { received } = await send('anthropic', { thinking: true })
  assert.deepEqual(received?.thinking, { type: 'enabled', budget_tokens: 4096 }, `ath 开启态没带预算：${snippet(received)}`)
})

test('[6] ath 关：请求体不含 thinking 参数（type=disabled 且无 budget_tokens）', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: anthropicSse({ content: '你好' }) }))
  const { received } = await send('anthropic', { thinking: false })
  assert.equal(received?.thinking?.type, 'disabled', `关闭态 thinking.type 应为 disabled：${snippet(received)}`)
  assert.equal(Object.hasOwn(received?.thinking ?? {}, 'budget_tokens'), false, `关闭态不该带 budget_tokens：${snippet(received)}`)
})

// ============ [7]–[8] 其它渠道默认行为不变 ============
test('[7] deepseek 开：thinking:{type:enabled} 且不带 budget_tokens（回归）', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: anthropicSse({ thinking: '先想', content: '你好' }) }))
  const { received } = await send('deepseek', { thinking: true, search: true, title: true })
  assert.equal(received?.thinking?.type, 'enabled', `官方渠道开启态丢了 thinking：${snippet(received)}`)
  assert.equal(Object.hasOwn(received?.thinking ?? {}, 'budget_tokens'), false, `官方渠道不该带 budget_tokens：${snippet(received)}`)
  assert.deepEqual(received?.safety_check, { level: 'high' }, `官方渠道丢了 safety_check：${snippet(received)}`)
  assert.equal(Object.hasOwn(received ?? {}, 'title'), true, `官方渠道丢了 title：${snippet(received)}`)
})

test('[8] ours：不发任何思考参数（回归，内测渠道不受影响）', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('你好') }))
  const { received } = await send('ours', { thinking: true })
  assert.equal(Object.hasOwn(received ?? {}, 'reasoning_effort'), false, `ours 不该带 reasoning_effort：${snippet(received)}`)
  assert.equal(Object.hasOwn(received ?? {}, 'thinking'), false, `ours 不该带 thinking：${snippet(received)}`)
  assert.equal(providers.getSpec('ours').caps.thinking, false, 'ours 不该声明思考能力')
})

// ============ [9]–[10] 响应侧 ============
test('[9] 响应侧 oai：reasoning_content → thinking 块 + thinking_delta，正文进 text 块', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiReasoningSse('先想一下', '你好') }))
  const { events } = await send('openai', { thinking: true, patch: { reasoningParam: 'reasoning_effort' } })
  assert.deepEqual(types(events), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ], `事件序列不对：${JSON.stringify(types(events))}`)
  const starts = events.filter((event) => event.type === 'content_block_start')
  assert.equal(starts[0].content_block.type, 'thinking', `第一个块必须是 thinking：${JSON.stringify(starts[0])}`)
  assert.equal(starts[1].content_block.type, 'text', `第二个块必须是 text：${JSON.stringify(starts[1])}`)
  const deltas = events.filter((event) => event.type === 'content_block_delta')
  assert.deepEqual(deltas[0].delta, { type: 'thinking_delta', thinking: '先想一下' }, `思考增量不对：${JSON.stringify(deltas[0])}`)
  assert.deepEqual(deltas[1].delta, { type: 'text_delta', text: '你好' }, `正文增量不对：${JSON.stringify(deltas[1])}`)
})

test('[10] 响应侧 ath：thinking_delta 事件 → 同一个 thinking 块渲染路径', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: anthropicSse({ thinking: '先想一下', content: '你好' }) }))
  const { events } = await send('anthropic', { thinking: true })
  const starts = events.filter((event) => event.type === 'content_block_start')
  assert.equal(starts[0].content_block.type, 'thinking', `ath 的思考块丢了：${JSON.stringify(starts[0])}`)
  const deltas = events.filter((event) => event.type === 'content_block_delta')
  assert.deepEqual(deltas[0].delta, { type: 'thinking_delta', thinking: '先想一下' }, `ath 思考增量不对：${JSON.stringify(deltas[0])}`)
  assert.deepEqual(deltas[1].delta, { type: 'text_delta', text: '你好' }, `ath 正文增量不对：${JSON.stringify(deltas[1])}`)
})

// ============ [11]–[12] UI：DOM 层断言 ============

const TOGGLE_PROPS = {
  label: '深度思考',
  tooltip: '本轮不启用深度思考',
  icon: null,
  className: 'toggle',
  selectedClassName: 'selected',
  labelClassName: 'toggleLabel',
}

/** 真开关组件的渲染结果（aria-pressed 只有 true / false 两种，节点在不在也是一条断言） */
const renderToggle = (caps, thinking) =>
  renderToStaticMarkup(
    createElement(ThinkingToggle, { ...TOGGLE_PROPS, caps, thinking, onToggle: () => {} })
  )

test('[11] UI：四渠道开关恒常驻，data-thinking-effective 只标记是否真生效（#341）', async () => {
  for (const kind of providers.PROVIDER_KINDS) {
    const spec = useChannel(kind)
    const markup = renderToggle(spec.caps, false)
    // #341：入口必须存在且可见，不置灰、不带 disabled/aria-disabled
    assert.ok(markup.includes(THINKING_TOGGLE_ATTR), `${kind} 必须渲染深度思考开关：${markup}`)
    assert.ok(markup.includes('aria-label="深度思考"'), `${kind} 开关缺少无障碍名：${markup}`)
    assert.ok(!markup.includes('disabled'), `${kind} 开关不许置灰/禁用：${markup}`)
    assert.ok(!markup.includes('aria-disabled'), `${kind} 开关不许带 aria-disabled：${markup}`)
    // 唯一渠道差异：不可见标记
    const expected = spec.caps.thinking ? 'true' : 'false'
    assert.ok(
      markup.includes(`data-thinking-effective="${expected}"`),
      `${kind} 的 data-thinking-effective 应为 ${expected}：${markup}`
    )
    assert.ok(markup.includes('aria-pressed="false"'), `${kind} 开关初始必须是未按下：${markup}`)
  }
})

test('[12] UI：四渠道点击后 aria-pressed 翻转，并写入 settings（#341）', async () => {
  for (const kind of providers.PROVIDER_KINDS) {
    const label = kind
    // 复位成关闭态
    settings.setThinking(false)
    const spec = useChannel(kind)
    // 与 ChatInput 完全一致的接线：onToggle = () => setThinking(!thinking)
    const props = {
      ...TOGGLE_PROPS,
      caps: spec.caps,
      thinking: settings.useSettings.getState().thinking,
      onToggle: () => settings.setThinking(!settings.useSettings.getState().thinking),
    }
    const before = renderToggle(props.caps, props.thinking)
    assert.ok(before.includes('aria-pressed="false"'), `${label} 点击前应是未按下：${before}`)

    // 真按钮元素上的 onClick —— 就是 React 会调的那一个
    const element = ThinkingToggle(props)
    assert.equal(typeof element.props.onClick, 'function', `${label} 开关没有 onClick`)
    element.props.onClick()

    // 1) 状态写入 settings（内存 + localStorage 两个都要，刷新后不丢）
    assert.equal(settings.useSettings.getState().thinking, true, `${label} 点击后 settings.thinking 没变`)
    assert.equal(localStorage.getItem('chat-demo:thinking'), 'true', `${label} 没写 chat-demo:thinking`)
    assert.equal(localStorage.getItem('chat-demo:chat-mode'), 'expert', `${label} 没写 chat-demo:chat-mode`)

    // 2) DOM 层：同一份渲染逻辑下 aria-pressed 翻过来了
    const after = renderToggle(props.caps, settings.useSettings.getState().thinking)
    assert.ok(after.includes('aria-pressed="true"'), `${label} 点击后 aria-pressed 没翻转：${after}`)
    assert.ok(after.includes('selected'), `${label} 开启态没有高亮类名：${after}`)

    // 3) 再点一次：翻回去（不是单向开关）
    ThinkingToggle({ ...props, thinking: settings.useSettings.getState().thinking }).props.onClick()
    assert.equal(settings.useSettings.getState().thinking, false, `${label} 再点一次没关回去`)
    settings.setThinking(false)
  }
})

test("[13] thinkingDisplay='hidden'：思考内容不渲染，但请求仍带思考参数", async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiReasoningSse('先想一下', '你好') }))
  const { received, events } = await send('openai', {
    thinking: true,
    patch: { reasoningParam: 'reasoning_effort' },
  })
  // 请求侧照旧带参数（hidden 只影响呈现，不能变成「请求带了思考、界面什么也没有」的静默档）
  assert.equal(received?.reasoning_effort, 'medium', `hidden 档请求侧也必须带参数：${snippet(received)}`)

  // 呈现侧：真的走了同一条判定
  const steps = [
    { type: 'thinking', text: '先想一下' },
    { type: 'text', text: '你好' },
  ]
  const layout = thinkingDisplay.resolveThinkingLayout({
    mode: 'hidden',
    hasThinking: thinkingDisplay.hasThinkingContent(true, steps),
    streaming: false,
    hasResponse: true,
    open: null,
  })
  assert.equal(layout.showSteps, false, `hidden 档不该挂思考正文：${JSON.stringify(layout)}`)
  assert.equal(layout.showTitle, false, `hidden 档不该显示思考标题：${JSON.stringify(layout)}`)
  const visible = thinkingDisplay.selectVisibleSteps(steps, layout)
  assert.deepEqual(visible, [{ type: 'text', text: '你好' }], `hidden 档必须剔除思考步骤：${JSON.stringify(visible)}`)
  // 事件侧确实产出了思考增量（证明「不渲染」不是因为没收到）
  assert.ok(
    events.some((event) => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta'),
    'mock 回了 reasoning_content，客户端却没产出 thinking_delta'
  )
})

// ============ [14]–[16] 负向用例 ============
test('[14] 负向：mock 回 400 unknown_parameter → 可读报错、不卡死、不重试', async () => {
  mock.reset()
  mock.on(() => ({
    status: 400,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: {
        type: 'invalid_request_error',
        code: 'unknown_parameter',
        message: "Unknown parameter: 'reasoning_effort'.",
      },
    }),
  }))
  const started = Date.now()
  let error = null
  try {
    await send('openai', { thinking: true, patch: { reasoningParam: 'reasoning_effort' } })
  } catch (caught) {
    error = caught
  }
  const elapsed = Date.now() - started
  assert.ok(error, '400 必须抛错，不能静默当成空回答')
  assert.ok(error instanceof ApiError, `应为 ApiError，实际 ${error?.name}`)
  assert.equal(error.kind, 'http', `应为 http 类错误，实际 ${error.kind}`)
  assert.equal(error.status, 400, `应带上状态码，实际 ${error.status}`)
  assert.match(error.message, /unknown_parameter|Unknown parameter/, `报错必须可读，实际：${error.message}`)
  assert.ok(elapsed < 5000, `不能卡死，实际耗时 ${elapsed}ms`)
  assert.equal(mock.posts().length, 1, `不能重试，mock 实际收到 ${mock.posts().length} 次请求`)
})

test('[15] 负向：只回 content 不回 reasoning_content → 不产生空 thinking 块', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('纯正文') }))
  const { events } = await send('openai', { thinking: true, patch: { reasoningParam: 'reasoning_effort' } })
  const thinkingStarts = events.filter(
    (event) => event.type === 'content_block_start' && event.content_block.type === 'thinking'
  )
  assert.equal(thinkingStarts.length, 0, `不该凭空造 thinking 块：${JSON.stringify(thinkingStarts)}`)
  const thinkingDeltas = events.filter(
    (event) => event.type === 'content_block_delta' && event.delta.type === 'thinking_delta'
  )
  assert.equal(thinkingDeltas.length, 0, `不该凭空造 thinking_delta：${JSON.stringify(thinkingDeltas)}`)
  const text = events
    .filter((event) => event.type === 'content_block_delta' && event.delta.type === 'text_delta')
    .map((event) => event.delta.text)
    .join('')
  assert.equal(text, '纯正文', `正文丢了：${JSON.stringify(text)}`)
})

test('[16] 负向：非法 reasoningParam → 门禁 fail-closed，一个思考字段都不发', async () => {
  mock.reset()
  mock.on(() => ({ status: 200, headers: SSE_HEADERS, body: openaiContentOnlySse('你好') }))
  const { received } = await send('openai', { thinking: true, patch: { reasoningParam: 'bogus_tier' } })
  assert.equal(received?.reasoning_effort, undefined, `非法档位不该发 reasoning_effort：${snippet(received)}`)
  assert.equal(received?.thinking, undefined, `非法档位不该发 thinking：${snippet(received)}`)
  // 能力侧同步关闭：非法值等于 none，请求侧不发字段（#341 起入口仍常驻、只改本地档位）
  const spec = useChannel('openai', { reasoningParam: 'bogus_tier' })
  assert.equal(spec.caps.thinking, false, '非法档位不该声明思考能力')
  assert.equal(providers.requestGates(spec).reasoning_param, false, '非法档位不该放行 reasoning_param 门禁')
  assert.equal(providers.reasoningParamOf(spec), 'none', '非法档位必须归一化成 none')
})

// ============ [17] 接线 ============
test('[17] 接线：ChatInput 真的渲染 ThinkingToggle（不是只加了个没人调的组件）', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/components/chatInput/ChatInput.tsx', import.meta.url)),
    'utf8'
  )
  assert.match(source, /<ThinkingToggle/, 'ChatInput 没有渲染 ThinkingToggle')
  assert.match(source, /caps=\{caps\}/, '开关能力没接到当前渠道的 caps')
  assert.match(source, /onToggle=\{\(\) => setThinking\(!thinking\)\}/, '开关点击没接到 setThinking')
  assert.doesNotMatch(
    source,
    /aria-pressed=\{thinking\}/,
    '内联的旧按钮还在（说明只是复制了一份没接上）'
  )
})

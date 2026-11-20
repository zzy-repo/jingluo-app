// [layer: unit | 依赖: 无（纯 Node + 宿主替身 + 内存 fetch，零真实上游） | 耗时: <2s]
//
// GitHub issue #576：请求补会话标识 —— 服务端 `usage_logs.session_id` 一直为空，
// 记忆只能靠内容相似度去猜属于哪段对话，两段相近的对话必然串号。
//
// 本用例钉住四件事：
//   [1] 表驱动：四个渠道各自「带不带、带哪个头」，以及值的归一化口径；
//   [2] 跨轮不变：同一会话连续三轮，真实请求上的 `X-Session-Id` **完全相同**；
//       新会话是**另一个** id；首轮（新建会话那一轮）就带；
//   [3] DeepSeek 官方渠道请求体**除该头之外零影响**：带 / 不带 id 发出去的两个请求，
//       请求体**逐字节相同**，header 只差这一个键；
//   [4] 负向对照：把 id 改成「每轮新生成」，本文件的稳定性断言**必须变红**。
//
// 断言对象都是**真代码**打出来的东西：
//   · `client.ts` 的 `streamMessage` 是真链路（路径、鉴权头、会话头都在这儿拼）；
//   · `chat/store.ts` 的 sendMessage 是真会话流（id 取自会话主键）；
//   · 只有 `globalThis.fetch` 是替身 —— 它记录真的 `init.headers` 与 `init.body` 原文；
//   · `requestBody.ts` 的 buildMessageBody 是真代码，用来证明请求体一字未改。
//
//   node tests/run-layer.mjs unit --only chat-session-id
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

installChatHostStubs()

const { createId } = await import('../../src/utils/id.ts')

const { setApiKey, setProviderKind } = await import('../../src/services/api/apiConfig.ts')
const { getSpec } = await import('../../src/services/api/providers.ts')
const { sessionIdHeaders, sessionIdHeaderFor, normalizeSessionId, SESSION_ID_HEADER, MAX_SESSION_ID_LENGTH } =
  await import('../../src/services/api/sessionId.ts')
const { buildMessageBody } = await import('../../src/services/chat/requestBody.ts')
const { streamMessage } = await import('../../src/services/api/client.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { useChatStore, initChat, sendMessage } = await import('../../src/services/chat/store.ts')

const HEADER = SESSION_ID_HEADER.toLowerCase()

/** 本轮抓到的真实请求：url + 原始 header 对象 + 未解析的请求体字符串 */
const requests = []

const sse = (lines) => `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join('')}data: [DONE]\n\n`

/** Anthropic 事件流（deepseek）：少一个事件正文就进不了历史 */
const anthropicSse = (text) =>
  [
    `event: message_start`,
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg-576',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}`,
    '',
    'event: content_block_start',
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    '',
    'event: content_block_delta',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    '',
    'event: content_block_stop',
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
    '',
    'event: message_delta',
    `data: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    })}`,
    '',
    'event: message_stop',
    `data: ${JSON.stringify({ type: 'message_stop' })}`,
    '',
  ].join('\n') + '\n'

/** OpenAI chunk 流（ours / openai） */
const openaiSse = (text) =>
  sse([
    { id: 'chatcmpl-576', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-576', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: 'chatcmpl-576', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])

/** 标题请求（max_tokens 很小时的那套体）与问答请求分开回放 */
const isTitleRequest = (body) => body?.max_tokens !== undefined

/** 当前渠道对应的 SSE 回放（协议不同，回错流正文就进不了历史） */
let currentPayload = anthropicSse
globalThis.fetch = async (url, init) => {
  const raw = typeof init?.body === 'string' ? init.body : ''
  let body = null
  try {
    body = raw ? JSON.parse(raw) : null
  } catch {
    body = null
  }
  const headers = Object.fromEntries(
    Object.entries(init?.headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)])
  )
  requests.push({ url: String(url), headers, raw, body })
  const text = isTitleRequest(body) ? '会话标题' : '好的'
  return new Response(currentPayload(text), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const awaitIdle = async (sessionId, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return
    }
    await delay(2)
  }
  throw new Error('本轮没有收尾，测试无法继续')
}

const textOf = (content) =>
  typeof content === 'string' ? content : (content ?? []).map((block) => block.text ?? '').join('')

/** 某一轮的问答请求（排除标题请求） */
const roundRequest = (question) =>
  requests.filter(
    (item) => !isTitleRequest(item.body) && textOf(item.body?.messages?.at(-1)?.content) === question
  )

/**
 * 稳定性断言：一组请求上的会话头必须**完全相同**（且非空）。
 * 负向对照直接复用这个函数 —— 它红，才说明它真的能抓到「每轮新生成」。
 */
const assertSameSessionId = (items, label) => {
  assert.ok(items.length >= 2, `${label}：至少要抓到两个请求才谈得上「跨轮」`)
  const ids = items.map((item) => item.headers[HEADER])
  for (const [index, id] of ids.entries()) {
    assert.ok(id, `${label}：第 ${index} 个请求没带 ${SESSION_ID_HEADER}`)
  }
  assert.deepEqual(new Set(ids).size, 1, `${label}：同一会话的 ${SESSION_ID_HEADER} 必须完全相同，实际 ${JSON.stringify(ids)}`)
  return ids[0]
}

/** 「请求体除该头之外零影响」的断言：body 逐字节相同 + header 只多这一个键 */
const assertBodyUntouched = (without, withId, label) => {
  assert.equal(
    withId.raw,
    without.raw,
    `${label}：带会话标识后请求体必须逐字节不变（不带长度 ${without.raw.length} / 带长度 ${withId.raw.length}）`
  )
  const extra = Object.keys(withId.headers).filter((key) => !(key in without.headers))
  assert.deepEqual(extra, [HEADER], `${label}：header 只允许新增 ${SESSION_ID_HEADER}，实际新增 ${JSON.stringify(extra)}`)
  assert.equal(without.headers[HEADER], undefined, `${label}：没给会话 id 时不该出现这个头`)
}

// ---------- [1] 表驱动：渠道能力表 + 值的归一化 ----------

test('[1] 四个渠道各自带不带会话头（能力表是唯一判定处）', () => {
  const table = [
    // 我们自己的网关：本单要修的服务端，读的就是这个头
    { kind: 'ours', header: SESSION_ID_HEADER },
    // DeepSeek 官方：CORS 预检回显请求头（curl -X OPTIONS 实测），服务端对未知头一律忽略
    { kind: 'deepseek', header: SESSION_ID_HEADER },
    // 用户自填中转：预检白名单不可知，fail-closed
    { kind: 'anthropic', header: null },
    { kind: 'openai', header: null },
  ]
  for (const { kind, header } of table) {
    assert.equal(sessionIdHeaderFor(kind), header, `${kind} 的头名判定`)
    const headers = sessionIdHeaders(kind, 'sess-576')
    if (header) {
      assert.deepEqual(headers, { [header]: 'sess-576' }, `${kind} 应当带会话头`)
    } else {
      assert.deepEqual(headers, {}, `${kind} 不该带会话头（fail-closed）`)
    }
  }
})

test('[1b] 没有会话上下文 / 值不合法 → 一个头都不发（不猜、不造）', () => {
  const cases = [
    { name: 'undefined', input: undefined },
    { name: 'null', input: null },
    { name: '空串', input: '' },
    { name: '只有空白', input: '   \t  ' },
    { name: 'CR 注入', input: 'sess\r\nX-Injected: 1' },
    { name: 'NUL', input: 'sess\u0000123' },
    { name: '超长（>255）', input: 'a'.repeat(MAX_SESSION_ID_LENGTH + 1) },
  ]
  for (const { name, input } of cases) {
    assert.deepEqual(sessionIdHeaders('ours', input), {}, `${name}：不发头`)
    assert.deepEqual(sessionIdHeaders('deepseek', input), {}, `${name}：不发头`)
  }
  // 边界：正好 255 个字符照发（服务端列宽），256 就整条丢弃（截断会让两个会话撞号）
  assert.equal(normalizeSessionId('b'.repeat(MAX_SESSION_ID_LENGTH)).length, MAX_SESSION_ID_LENGTH)
  assert.deepEqual(sessionIdHeaders('ours', 'b'.repeat(MAX_SESSION_ID_LENGTH + 1)), {})
  // 前后空白会被 trim，与服务端 sanitizeSessionID 同口径
  assert.deepEqual(sessionIdHeaders('ours', '  conv-576  '), { [SESSION_ID_HEADER]: 'conv-576' })
})

// ---------- [2] 跨轮不变 / 首轮就带 / 新会话换 id ----------

test('[2] 同一会话连续三轮：请求上的会话头完全相同，且等于会话主键', async () => {
  await initChat()
  setApiKey('sk-test-576')
  setProviderKind('deepseek')
  currentPayload = anthropicSse
  requests.length = 0

  const sessionId = await (async () => {
    setDraftText(null, '第 0 轮：这段对话属于哪段记忆？')
    assert.equal(sendMessage(null), true, '首轮应能发出去')
    const created = useChatStore.getState().activeId
    assert.ok(created, '第 0 轮应新建会话')
    await awaitIdle(created)
    return created
  })()

  for (let round = 1; round <= 2; round += 1) {
    const question = `第 ${round} 轮：继续这段对话`
    setDraftText(sessionId, question)
    assert.equal(sendMessage(sessionId), true, `第 ${round} 轮应能发出去`)
    await awaitIdle(sessionId)
  }

  const items = [roundRequest('第 0 轮：这段对话属于哪段记忆？')[0], roundRequest('第 1 轮：继续这段对话')[0], roundRequest('第 2 轮：继续这段对话')[0]]
  assert.ok(items.every(Boolean), '三轮问答请求都要抓到')
  // 首轮（新建会话那一轮）也必须带 —— 首轮就该有 id
  assert.equal(items[0].headers[HEADER], sessionId, '首轮就要带会话 id，且等于会话主键')
  const id = assertSameSessionId(items, 'deepseek 三轮')
  assert.equal(id, sessionId, '请求上的会话头必须等于会话主键（不能每轮现造一个）')
  console.log(`  三轮请求的 ${SESSION_ID_HEADER} = ${id}（= 会话主键，三轮相同）`)
})

test('[2b] 换一个会话：会话头跟着换，不复用上一段的 id', async () => {
  const first = useChatStore.getState().activeId
  setDraftText(null, '另一段对话的第一句')
  assert.equal(sendMessage(null), true, '新会话应能发出去')
  const second = useChatStore.getState().activeId
  assert.ok(second && second !== first, '应新建了另一个会话')
  await awaitIdle(second)

  const request = roundRequest('另一段对话的第一句')[0]
  assert.ok(request, '新会话的首轮请求要抓到')
  assert.equal(request.headers[HEADER], second, '新会话带自己的 id')
  assert.notEqual(request.headers[HEADER], first, '不同会话的 id 必须不同')
})

test('[2c] 我们自己的渠道（ours，OpenAI 协议）+ 自动标题请求：同一个 id', async () => {
  await initChat()
  setApiKey('sk-test-576')
  setProviderKind('ours')
  currentPayload = openaiSse
  requests.length = 0

  setDraftText(null, 'ours 渠道：这段对话的标题请求也该属于同一段对话')
  assert.equal(sendMessage(null), true, 'ours 渠道应能发出去')
  const sessionId = useChatStore.getState().activeId
  await awaitIdle(sessionId)

  // 标题请求是首轮结束后异步补的（autoTitle.ts），给它一点时间落地
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !requests.some((item) => isTitleRequest(item.body))) {
    await delay(10)
  }

  const turn = roundRequest('ours 渠道：这段对话的标题请求也该属于同一段对话')[0]
  assert.ok(turn, '问答请求要抓到')
  assert.equal(turn.headers[HEADER], sessionId, '问答请求带会话 id')
  const title = requests.find((item) => isTitleRequest(item.body))
  assert.ok(title, 'ours 渠道首轮后应有一次标题请求')
  assert.equal(title.headers[HEADER], sessionId, '标题请求带同一个会话 id（同一段对话不该在这里断掉）')
})

// ---------- [3] DeepSeek 官方渠道：请求体除该头之外零影响 ----------

test('[3] deepseek：带 / 不带会话 id 的请求体逐字节相同，header 只多一个键', async () => {
  setApiKey('sk-test-576')
  setProviderKind('deepseek')
  currentPayload = anthropicSse
  const spec = getSpec('deepseek')
  const body = buildMessageBody(spec, {
    model: 'deepseek-flash',
    system: '你是助手',
    messages: [{ role: 'user', content: '零影响证明' }],
    thinking: true,
    search: true,
    title: false,
  })

  const send = async (options) => {
    requests.length = 0
    const events = streamMessage('sk-test-576', body, new AbortController().signal, options)
    for await (const event of events) {
      // 只等流跑完：断言流本身没被会话头搞坏（真链路，不 mock client）
      assert.ok(typeof event?.type === 'string', '流里应当只有可识别的事件')
    }
    assert.equal(requests.length, 1, '一次调用应当只有一个请求')
    return requests[0]
  }

  const without = await send()
  const withId = await send({ sessionId: 'conv-zero-impact' })

  assertBodyUntouched(without, withId, 'deepseek')
  // 请求体里不该出现任何会话字段（#576 只加头）：服务端不读 body 字段，
  // 上游遇到未知顶层字段会 400（providers.ts 里 extended.safetyCheck 的同一套理由）
  for (const key of Object.keys(withId.body)) {
    assert.ok(!/session|conversation/i.test(key), `请求体不该有会话字段，实际多了 ${key}`)
  }
  assert.equal(withId.raw, without.raw, '请求体逐字节不变')
  console.log(`  deepseek 请求体 ${withId.raw.length} B，带 / 不带会话头完全相同；多出来的 header：${SESSION_ID_HEADER}`)
})

// ---------- [4] 负向对照：每轮新生成 → 断言必须红 ----------

test('[4] 负向对照：id 改成每轮新生成 / 塞进请求体，本文件的断言都会红', () => {
  const perRound = [0, 1].map(() => ({
    headers: Object.fromEntries(
      Object.entries(sessionIdHeaders('deepseek', createId())).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ])
    ),
  }))
  assert.notDeepEqual(
    perRound[0].headers[HEADER],
    perRound[1].headers[HEADER],
    '两次 createId() 本来就该不同（负向对照的前提）'
  )
  assert.throws(
    () => assertSameSessionId(perRound, '负向对照：每轮新生成'),
    /must be completely equal|必须完全相同/,
    '每轮新生成的 id 必须让稳定性断言变红'
  )

  // 同理：把 id 塞进请求体（issue 文本里的「方式 B」）会让「请求体逐字节不变」当场变红
  const without = { raw: '{"model":"deepseek-flash"}', headers: {} }
  const withBodyField = { raw: '{"model":"deepseek-flash","session_id":"conv-x"}', headers: {} }
  assert.throws(
    () => assertBodyUntouched(without, withBodyField, '负向对照：body 字段'),
    /逐字节不变/,
    '请求体被改动必须让「零影响」断言变红'
  )
})

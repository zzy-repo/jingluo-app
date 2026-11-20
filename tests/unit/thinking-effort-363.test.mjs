// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #363：思考档位「UI 档位 → settings → AssistantMessage.thinking → 请求体」这条链路
// 必须真的通。线上取证（issue 正文）：近 60 分钟 1516 个请求里，765 个显式
// `reasoning_effort=none`、750 个压根不带字段、**只有 1 个 high**；不开思考平均输出 79–121 token，
// `finish_reason` 全是 `stop` —— 「内容很短」不是被 max_tokens 砍的，是根本没走推理。
//
// 根因两条（都在本单修掉）：
//   1) 生产默认渠道 `ours` 的 spec 写成 `reasoningParam: 'none'`：`thinkingAvailable()` 因此恒为
//      false → `REQUEST_GATES.reasoning_param` 恒拦截 → #341 起「四渠道恒常驻」的深度思考开关
//      点了也不生效，一个思考字段都发不出去（开关亮着、请求里什么都没有）。
//   2) 缺省档位是 `fast`（= 不开思考），从没碰过开关的机器默认就不思考。
//
// 本用例全部走**真代码**（providers / settings / requestBody / openaiAdapter / client），
// 不连真实上游：最后一条用 stub fetch 截获真实请求体，断言的是 JSON 而不是源码正则。
//
//   node tests/run-layer.mjs unit --only thinking-effort-363
//
// 覆盖：
//   [1] 默认档位 = 专家模式，且默认档位的意图真的落进 ours 的请求体（reasoning_effort: high）
//   [2] 表驱动：档位 × 渠道 → body.thinking.type 与适配后的思考字段
//   [3] 显式关闭档：四渠道都零思考字段（关掉就该真的不思考）
//   [4] 渠道门禁 false（reasoningParam='none'）：档位开着也零字段（fail-closed，不猜上游能力）
//   [5] 真链路：client.streamMessage 实际发出的 JSON（stub fetch 记录，零网络）
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

// 宿主替身（Capacitor / 诊断收集器 / 内存 db / 浏览器全局）只在边界上换实现
installChatHostStubs()

const providers = await import('../../src/services/api/providers.ts')
const settings = await import('../../src/services/settings.ts')
const { buildMessageBody } = await import('../../src/services/chat/requestBody.ts')
const { toOpenAIRequest, reasoningFields } = await import('../../src/services/api/openaiAdapter.ts')
const apiConfig = await import('../../src/services/api/apiConfig.ts')
const client = await import('../../src/services/api/client.ts')

/**
 * 「这台机器从没碰过这个开关」时的档位。
 *
 * 取法：先把两个档位键清掉，再**重新求值一次** settings 模块（带一次性 query 绕开模块缓存）——
 * 合并批次跑的时候，同进程里的前一个文件可能已经写过 `chat-demo:chat-mode`，直接读当前 store
 * 得到的就不是默认值。这里要断言的正是「出厂默认」。
 */
const freshDefaultMode = async (tag) => {
  globalThis.localStorage.removeItem('chat-demo:chat-mode')
  globalThis.localStorage.removeItem('chat-demo:thinking')
  const fresh = await import(`../../src/services/settings.ts?probe=${tag}`)
  return {
    chatMode: fresh.useSettings.getState().chatMode,
    thinking: fresh.useSettings.getState().thinking,
    storedMode: globalThis.localStorage.getItem('chat-demo:chat-mode'),
    storedThinking: globalThis.localStorage.getItem('chat-demo:thinking'),
  }
}

const INPUT = {
  model: 'mock-model',
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages: [{ role: 'user', content: '你好' }],
}

/**
 * 真代码拼一次请求体：`buildMessageBody`（store.ts 用的就是它）→ `toOpenAIRequest`
 * （只有 openai 协议渠道过这一层；anthropic 协议原样发）。
 */
const build = (kind, thinking) => {
  const spec = providers.getSpec(kind)
  const body = buildMessageBody(spec, { ...INPUT, thinking })
  const sent = toOpenAIRequest(body, spec)
  return { spec, body, sent, gates: providers.requestGates(spec) }
}

/** 适配后真正会写进请求体的思考字段（其余字段与本单无关） */
const thinkingFields = (sent) => ({
  ...(Object.hasOwn(sent, 'reasoning_effort') ? { reasoning_effort: sent.reasoning_effort } : {}),
  ...(Object.hasOwn(sent, 'thinking') ? { thinking: sent.thinking } : {}),
})

// ============ [1] 默认档位 ============
test('[1] 默认档位 = 专家模式，且默认意图真的落进 ours 的请求体', async () => {
  const defaults = await freshDefaultMode('default')
  assert.equal(
    defaults.chatMode,
    'expert',
    '缺省档位必须是「开思考」：默认 fast 时线上 1516 个请求 1515 个不思考（#363）'
  )
  assert.equal(defaults.thinking, true, 'settings.thinking 必须与 chatMode 同步为 true')
  assert.equal(defaults.storedMode, null, '缺省值不写存储：只有用户点过开关才落 localStorage')
  assert.equal(defaults.storedThinking, null)

  const { sent, gates } = build('ours', defaults.thinking)
  assert.equal(
    gates.reasoning_param,
    true,
    'ours 的 reasoning_param 门禁必须放行（#363 之前恒为 false = 开关点了也不生效）'
  )
  assert.equal(
    sent.reasoning_effort,
    'high',
    `默认档位没落进请求体：${JSON.stringify(thinkingFields(sent))}`
  )
})

// ============ [2] 档位 → 请求体字段 映射表 ============
test('[2] 表驱动：渠道 × 档位 → body.thinking 与适配后的思考字段', () => {
  const CASES = [
    // 我们自己的渠道：OpenAI 协议 + reasoning_effort（档位 high）—— 唯一真正改变线上分布的一档
    { kind: 'ours', thinking: true, bodyType: 'enabled', expected: { reasoning_effort: 'high' } },
    { kind: 'ours', thinking: false, bodyType: 'disabled', expected: {} },
    // 第三方 OpenAI 兼容：档位 none，开不开都不发（不猜别人的能力，#297 的 fail-closed 保留）
    { kind: 'openai', thinking: true, bodyType: 'disabled', expected: {} },
    { kind: 'openai', thinking: false, bodyType: 'disabled', expected: {} },
    // Anthropic 协议：思考块是协议原生的，请求体带 thinking（官方不带预算，中转带 4096）
    { kind: 'deepseek', thinking: true, bodyType: 'enabled', expected: {} },
    { kind: 'deepseek', thinking: false, bodyType: 'disabled', expected: {} },
    { kind: 'anthropic', thinking: true, bodyType: 'enabled', expected: {} },
    { kind: 'anthropic', thinking: false, bodyType: 'disabled', expected: {} },
  ]

  for (const item of CASES) {
    const { body, sent, spec } = build(item.kind, item.thinking)
    const label = `${item.kind} / 档位${item.thinking ? '开' : '关'}`
    assert.equal(body.thinking?.type, item.bodyType, `${label}：body.thinking.type 不对`)
    if (spec.protocol === 'openai') {
      assert.deepEqual(thinkingFields(sent), item.expected, `${label}：适配后的思考字段不对`)
      continue
    }
    // anthropic 协议：请求体原样发，没有 OpenAI 适配层
    assert.deepEqual(thinkingFields(sent), {}, `${label}：anthropic 协议不该出现 OpenAI 字段`)
    assert.equal(
      Object.hasOwn(body.thinking ?? {}, 'budget_tokens'),
      item.thinking && Boolean(spec.thinkingBudget),
      `${label}：budget_tokens 只在该渠道声明了预算且开启时出现`
    )
  }
})

// ============ [3] 显式关闭档 ============
test('[3] 显式关闭：四渠道都零思考字段（不给上游留「关了还在思考」的尾巴）', () => {
  settings.setThinking(false) // 真开关的写入口：等于切到快速模式
  assert.equal(settings.useSettings.getState().chatMode, 'fast')
  assert.equal(globalThis.localStorage.getItem('chat-demo:chat-mode'), 'fast', '档位要落 localStorage')

  for (const kind of providers.PROVIDER_KINDS) {
    const { body, sent } = build(kind, settings.useSettings.getState().thinking)
    assert.equal(body.thinking?.type, 'disabled', `${kind}：关闭态请求体应为 disabled`)
    assert.deepEqual(thinkingFields(sent), {}, `${kind}：关闭态不该带任何思考字段`)
  }

  settings.setThinking(true) // 还原，避免影响同进程后续断言
})

// ============ [4] 渠道门禁 false ============
test('[4] 门禁 false（reasoningParam=none）：档位开着也零字段', () => {
  const spec = providers.getSpec('ours')
  const gated = { ...spec, reasoningParam: 'none', reasoningEffort: undefined }
  const body = buildMessageBody(gated, { ...INPUT, thinking: true })
  const sent = toOpenAIRequest(body, gated)
  assert.equal(
    providers.requestGates(gated).reasoning_param,
    false,
    'reasoningParam=none 的渠道必须被门禁拦下'
  )
  assert.equal(body.thinking?.type, 'disabled', '门禁拦下时请求侧不许开 thinking')
  assert.deepEqual(thinkingFields(sent), {}, '门禁为 false 时一个思考字段都不许发')
  // 适配层自身也是 fail-closed：非法 / none 档在开启态仍然什么都不加
  assert.deepEqual(reasoningFields({ reasoningParam: 'bogus' }, true), {}, '非法档位必须 fail-closed')
})

// ============ [5] 真链路：实际发出的 JSON ============
const openAiSse = (content) =>
  [
    { id: 'chatcmpl-363', model: 'mock-model', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { id: 'chatcmpl-363', choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    { id: 'chatcmpl-363', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('') + 'data: [DONE]\n\n'

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), json: init?.body ? JSON.parse(String(init.body)) : null })
  return new Response(openAiSse('好'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  })
}

/** 走真 client：路径、鉴权头、适配层翻译全在链路上，只有网络出口是 stub */
const roundTrip = async (thinking) => {
  apiConfig.setProviderKind('ours')
  apiConfig.setApiKey('sk-mock-363')
  const body = buildMessageBody(providers.getSpec('ours'), { ...INPUT, thinking })
  const events = []
  for await (const event of client.streamMessage('sk-mock-363', body, new AbortController().signal)) {
    events.push(event.type)
  }
  return { sent: calls.at(-1), events }
}

test('[5] 真链路：开档位发出 reasoning_effort=high，关档位零思考字段', async () => {
  calls.length = 0
  const on = await roundTrip(true)
  assert.match(String(on.sent.url), /\/v1\/chat\/completions$/, `请求路径不对：${on.sent.url}`)
  assert.equal(on.sent.json?.reasoning_effort, 'high', `真实请求体丢了档位：${JSON.stringify(on.sent.json)}`)
  assert.equal(Object.hasOwn(on.sent.json ?? {}, 'thinking'), false, 'reasoning_effort 档不该带 thinking')
  assert.equal(on.events.at(-1), 'message_stop', `这一轮必须正常收尾：${on.events.join(',')}`)

  calls.length = 0
  const off = await roundTrip(false)
  assert.equal(
    Object.hasOwn(off.sent.json ?? {}, 'reasoning_effort'),
    false,
    `关闭档不该带 reasoning_effort：${JSON.stringify(off.sent.json)}`
  )
  assert.equal(Object.hasOwn(off.sent.json ?? {}, 'thinking'), false)
})

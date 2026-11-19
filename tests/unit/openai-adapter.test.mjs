// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// 翻译器单测（不启浏览器）：直接 import 源码里的适配器与 SSE 解析器，喂构造好的 OpenAI SSE 文本。
//
//   cd /root/deepseek-app && node tests/unit/openai-adapter.test.mjs
//
// [3] 干净流：事件序列必须严格是
//     message_start → content_block_start → content_block_delta ×3 → content_block_stop
//     → message_delta(stop_reason=end_turn, usage) → message_stop
// [4] 脏数据：空 choices、delta 空对象、`: ping` 注释行、非 JSON 的 data 行、多 choices、无 [DONE] 断流
//     → 不抛错、不卡死、都能正常收尾
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

// #297：适配器要按 spec.reasoningParam 翻译思考参数，于是开始 import './providers.js'
// （运行期值，不是 type-only）。裸 node 不认识 `.js → .ts` 的对应关系 —— 这条 resolve hook
// 现在只有一份（tests/helpers/dom-env.mjs，#366）；本文件以前自带一份一模一样的。
installTsResolve()

// hook 装好之后再动态加载被测模块（静态 import 会被提升到 hook 之前）
const {
  contentToString,
  mapFinishReason,
  toOpenAIRequest,
  translateOpenAIStream,
} = await loadTsModule('src/services/api/openaiAdapter.ts')
const { ServerSentEventDecoder } = await loadTsModule('src/services/api/sse.ts')

const failures = []
let checks = 0
const ok = (message) => {
  checks += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${label} = ${a}`)
  } else {
    bad(`${label}：期望 ${b}，实际 ${a}`)
  }
}

/** 一段构造的 SSE 文本 → 解析后的事件数组（注释行由 SSE 解析层丢弃） */
const decode = (text) => {
  const decoder = new ServerSentEventDecoder()
  const events = decoder.push(text)
  events.push(...decoder.end())
  return events
}

const sse = (lines) => lines.map((line) => (line === '' ? '' : `data: ${line}`)).join('\n\n') + '\n\n'

/** 收集全部事件，带超时保护：卡死就是失败，不会被挂住 */
const collect = async (source, fallback) => {
  const events = []
  const run = (async () => {
    for await (const event of translateOpenAIStream(source, fallback)) {
      events.push(event)
    }
  })()
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 3000)
  })
  const result = await Promise.race([run.then(() => 'done'), timeout])
  // 必须清掉：promise race 输了不代表定时器消失，5 条用例各留一个 3s 定时器，
  // 进程要空转 3 秒才退出（#366 前本文件 3.1s 里只有 90ms 是断言，其余是这段空转）。
  clearTimeout(timer)
  return { events, result }
}

const types = (events) => events.map((event) => event.type)

// ============ [3] 干净流：严格事件序列 ============
console.log('\n[3] 翻译器：干净流的事件序列')
const CLEAN_SSE = sse([
  '{"id":"chatcmpl-accept","object":"chat.completion.chunk","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '{"id":"chatcmpl-accept","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  '{"id":"chatcmpl-accept","choices":[{"index":0,"delta":{"content":"，世界"},"finish_reason":null}]}',
  '{"id":"chatcmpl-accept","choices":[{"index":0,"delta":{"content":"！"},"finish_reason":null}]}',
  '{"id":"chatcmpl-accept","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}',
  '{"id":"chatcmpl-accept","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '[DONE]',
])
console.log('  喂入的 OpenAI SSE：')
for (const line of CLEAN_SSE.trimEnd().split('\n')) {
  console.log(`    ${line}`)
}
const clean = await collect(decode(CLEAN_SSE))
if (clean.result !== 'done') {
  bad(`[3] 翻译没有在 3 秒内结束（${clean.result}）`)
}
eq(
  types(clean.events),
  [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ],
  '[3] 事件序列'
)
const text = clean.events
  .filter((event) => event.type === 'content_block_delta')
  .map((event) => event.delta.text)
  .join('')
eq(text, '你好，世界！', '[3] 三个 text_delta 拼出的正文')
eq(clean.events[1]?.content_block, { type: 'text', text: '' }, '[3] content_block_start 是 index 0 的空 text 块')
eq(clean.events[1]?.index, 0, '[3] content_block_start.index')
eq(clean.events[5]?.index, 0, '[3] content_block_stop.index')
const messageDelta = clean.events.find((event) => event.type === 'message_delta')
eq(messageDelta?.delta.stop_reason, 'end_turn', '[3] finish_reason=stop → stop_reason')
eq(
  messageDelta?.usage,
  {
    input_tokens: 12,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 7,
  },
  '[3] message_delta 带 usage（prompt_tokens/completion_tokens → Anthropic 计费字段）'
)
eq(clean.events[0]?.message?.id, 'chatcmpl-accept', '[3] message_start 带上游 id')
console.log('  产出的事件序列（实际输出）：')
for (const event of clean.events) {
  console.log(`    ${JSON.stringify(event)}`)
}

// ============ [4] 脏数据：不抛错、不卡死、能正常结束 ============
console.log('\n[4] 翻译器：脏数据容错')

// 4a 空 choices（只有 usage 的收尾 chunk，正文一个都没有）
const emptyChoices = await collect(
  decode(sse(['{"choices":[]}', '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":0}}', '[DONE]']))
)
eq(emptyChoices.result, 'done', '[4a] 空 choices 流正常结束（未卡死）')
eq(
  types(emptyChoices.events),
  ['message_start', 'message_delta', 'message_stop'],
  '[4a] 空 choices 的事件序列（无内容块）'
)

// 4b 没有 [DONE] 就断流：finish_reason 也没有
const truncated = await collect(
  decode(
    sse([
      '{"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
      '{"id":"x","choices":[{"index":0,"delta":{"content":"半句话"}}]}',
    ])
  )
)
eq(truncated.result, 'done', '[4b] 缺 [DONE] 的断流不抛错、不卡死')
eq(
  types(truncated.events),
  [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ],
  '[4b] 断流也补齐 content_block_stop/message_delta/message_stop'
)
eq(
  truncated.events.find((event) => event.type === 'message_delta')?.delta.stop_reason,
  'end_turn',
  '[4b] 缺 finish_reason 时 stop_reason 兜底'
)

// 4c `: ping` 注释行 + 非 JSON 的 data 行 + delta 空对象 + 同一 chunk 多条 choices
const messyText = [
  ': ping',
  '',
  'data: {"id":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}',
  '',
  ': ping',
  '',
  'data: not-json-at-all',
  '',
  'data: {"choices":[{"index":0,"delta":{}}]}',
  '',
  'data: {"choices":[{"index":1,"delta":{"content":"第二条不该出现"}},{"index":0,"delta":{"content":"第一条"}}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}',
  '',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
  '',
  '[DONE]',
  '',
].join('\n')
const messy = await collect(decode(messyText))
eq(messy.result, 'done', '[4c] 注释行/非法 JSON 混流不抛错、不卡死')
eq(
  types(messy.events),
  [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ],
  '[4c] 脏流仍然产出合法事件序列'
)
eq(
  messy.events.find((event) => event.type === 'content_block_delta')?.delta.text,
  '第一条',
  '[4c] 多 choices 只取 index 0，且 delta 空对象被忽略'
)
eq(
  messy.events.find((event) => event.type === 'message_delta')?.delta.stop_reason,
  'max_tokens',
  '[4c] content_filter→refusal 之后 length→max_tokens（后者为准）'
)

// 4d 空流（一个事件都没有）：同样要收尾
const emptyStream = await collect([])
eq(emptyStream.result, 'done', '[4d] 空流不卡死')
eq(types(emptyStream.events), ['message_start', 'message_delta', 'message_stop'], '[4d] 空流事件序列')

// 4e finish_reason 映射表逐项
for (const [reason, expected] of [
  ['stop', 'end_turn'],
  ['length', 'max_tokens'],
  ['tool_calls', 'end_turn'],
  ['content_filter', 'refusal'],
  ['something_new', 'end_turn'],
]) {
  eq(mapFinishReason(reason), expected, `[4e] finish_reason ${reason} → stop_reason`)
}

// ============ 请求方向：Anthropic 请求体 → OpenAI 请求体 ============
console.log('\n[2b] 请求体转换（纯函数）')
const anthropicBody = {
  model: 'gpt-4o-mini',
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages: [
    { role: 'latest_reminder', content: '当前时间 2026-11-17 20:40' },
    { role: 'user', content: '你好' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '内部思考不回传', signature: 'sig' },
        { type: 'text', text: '你好，我是助手。' },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'file', file_id: 'file-1' } },
        { type: 'text', text: '这张图是什么' },
      ],
    },
  ],
  thinking: { type: 'enabled' },
  safety_check: { level: 'high' },
  title: { enabled: true },
  tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
}
const converted = toOpenAIRequest(anthropicBody)
eq(
  converted.messages,
  [
    { role: 'system', content: '该助手为DeepSeek，由深度求索公司创造。' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，我是助手。' },
    { role: 'user', content: '这张图是什么' },
  ],
  '[2b] system 进头部 + 丢弃图片/思考/latest_reminder'
)
eq(converted.stream, true, '[2b] stream: true 必带')
eq(
  Object.hasOwn(converted, 'safety_check') ||
    Object.hasOwn(converted, 'title') ||
    Object.hasOwn(converted, 'tools') ||
    Object.hasOwn(converted, 'thinking'),
  false,
  '[2b] 剥离 safety_check/title/tools/thinking'
)
eq(
  contentToString([
    { type: 'text', text: '甲' },
    { type: 'image', source: { type: 'file', file_id: 'f' } },
    { type: 'text', text: '乙' },
  ]),
  '甲\n\n乙',
  '[2b] block 数组只取 text 块拼接'
)

console.log(`\n共 ${checks} 项断言`)
if (failures.length > 0) {
  console.error(`FAIL tests/unit/openai-adapter.test.mjs（${failures.length} 条）`)
  process.exit(1)
}
console.log('PASS tests/unit/openai-adapter.test.mjs')

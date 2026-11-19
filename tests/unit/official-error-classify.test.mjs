// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #324：DeepSeek 官方渠道（Anthropic 协议，https://api.deepseek.com/anthropic/v1/messages）
// 的**真实**失败样本 → 分类 → 中文文案 → 可自证诊断。
//
// 下面所有 status / upstreamCode / message **都来自 2026-11-19 对该端点的真实抓取**
// （原始响应片段见 issue #324 的评论；key 已脱敏，测试里一律用占位符 sk-test）：
//
// | 场景 | HTTP | 上游 code(error.type) | 是否 SSE |
// | --- | --- | --- | --- |
// | 正常 | 200 | – | 是 |
// | 非法模型名 | 400 | invalid_request_error | 否 |
// | 空 messages | 400 | invalid_request_error | 否 |
// | max_tokens: -1 | 422 | invalid_request_error | 否 |
// | 上下文超长（1.5M tokens） | 400 | invalid_request_error | 否 |
// | 错误 Key | 401 | authentication_error | 否 |
// | 断流（--max-time 截断，115 帧无 message_stop） | 200 | – | 是 |
//
//   node tests/unit/official-error-classify.test.mjs
//
// 覆盖（对应 issue #324 的验收标准）：
//   [1] 真实样本各归各档：模型不存在 / 参数错误 / 上下文超长 / 鉴权 / 空响应
//   [2] 流内 error 帧（没有 HTTP 状态码）也能分类：内容拦截、模型不存在
//   [3] 可重试 / 不可重试在文案上显式区分（含「可以重试」「不要重试」两种措辞）
//   [4] 负向：502 不误判内容拦截；普通 400 不误判额度
//   [5] replyUnknownError 只在**真未知**（无状态码、无上游 code、无中文文案）时出现
//   [6] 兜底分支给出 HTTP 状态码 + 上游短码 + 可复制诊断（复用 #104 的脱敏口径）
//   [7] 空流（200 + SSE 零帧 / 200 + 非 SSE）走真代码，落到空响应档而不是「未知错误」
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chatStub, installTsResolve } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口两个替身 + `.js→.ts` 解析。
// 以前每个 chat-stubs 文件各抄一份 registerHooks + 本地 `.js→.ts` 兜底（#408 已把同族 5 个文件迁走，
// 这几个文件是同族剩下的手抄件，一起收掉）。
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
  ],
})

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { ApiError, streamMessage } = await import('../../src/services/api/client.ts')
const {
  classifyApiError,
  classifyErrorSignature,
  isRetryableApiError,
  parseSupportedModels,
} = await import('../../src/services/api/errors.ts')
const { applyEvent, settleReply } = await import('../../src/services/chat/reply.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { buildReplyErrorReport } = await import('../../src/services/chat/replyErrorReport.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言必须钉在中文，不能跟随 shell 的 LANG')

// ---------------------------------------------------------------- 真实样本
// 以下四条 message 是官方端点的**原文**（只截掉了 request_id）

/** 400：非法模型名（真实抓取） */
const MODEL_NOT_FOUND = {
  status: 400,
  code: 'invalid_request_error',
  message:
    'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed no-such-model.',
}

/** 400：空 messages（真实抓取） */
const EMPTY_MESSAGES = {
  status: 400,
  code: 'invalid_request_error',
  message: 'messages: at least one message is required',
}

/** 422：max_tokens 非法（真实抓取） */
const BAD_MAX_TOKENS = {
  status: 422,
  code: 'invalid_request_error',
  message:
    'Failed to deserialize the JSON body into the target type: max_tokens: invalid value: integer `-1`, expected u32 at line 1 column 41',
}

/** 400：上下文超长（真实抓取，1.5M tokens 输入） */
const CONTEXT_TOO_LONG = {
  status: 400,
  code: 'invalid_request_error',
  message:
    "This model's maximum context length is 1048576 tokens. However, you requested 1500046 tokens (1500030 in the messages, 16 in the completion). Please reduce the length of the messages or completion.",
}

const emptyReply = () => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 0,
  status: 'error',
  blocks: [],
  prefix: false,
})

/** 把「上游给了什么」按 store 的存法落成一条 error 回复，再问界面会显示什么 */
const noticeOf = (error) =>
  describeReply({
    ...emptyReply(),
    error: {
      kind: error.kind ?? 'http',
      message: error.message,
      status: error.status,
      ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
    },
  })

const apiErrorOf = ({ status, code, message }, kind = 'http') =>
  new ApiError(kind, message, status, undefined, undefined, code)

/**
 * #339 起 `replyModelInvalid` 带两个占位符：实际发出的模型名 + 上游可用模型列表。
 * 这里按真实 translate() 口径拼期望值 —— noticeOf 造的回复没有 model 快照，模型名落到「未记录」。
 */
const MODEL_LIST = 'deepseek-flash, deepseek-v4-pro'
const modelInvalidCopy = (model = '未记录') =>
  translate('replyModelInvalid', { model, models: MODEL_LIST })

// ---------------------------------------------------------------- [1] 真实样本
test('[1] 真实样本：400 非法模型名 → 模型不存在档，不再落「未知错误」', () => {
  const condition = classifyErrorSignature(MODEL_NOT_FOUND)
  assert.equal(condition, 'modelInvalid', '官方端点 400 + supported API model names 要认成模型不存在')

  const notice = noticeOf(apiErrorOf(MODEL_NOT_FOUND))
  assert.equal(notice.text, modelInvalidCopy(), '用「模型不可用」的专用文案（带实际模型名与可用列表）')
  assert.notEqual(notice.text, zh.replyUnknownError, '绝不能再是「未知错误」')
  assert.match(notice.text, /不要重试/, '模型不存在是终态：文案要说清不要重试')
  assert.match(notice.text, /模型/, '文案要指出是模型的问题')
  assert.equal(notice.diagnostics, undefined, '已识别的场景不需要额外诊断文本')
})

test('[1] 上游可用模型列表可解析（#339）：原文 → 列表，脏文本 → 空数组', () => {
  assert.deepEqual(
    parseSupportedModels(
      'The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed x'
    ),
    ['deepseek-flash', 'deepseek-v4-pro'],
    '列表要在「but you passed」之前结束'
  )
  for (const dirty of ['', undefined, 'model not found', '当前模型在上游不可用']) {
    assert.deepEqual(parseSupportedModels(dirty), [], `脏文本不该解析出模型名：${String(dirty)}`)
  }
})

test('[1] 真实样本：400 空 messages / 422 max_tokens 非法 → 参数错误档（不可重试）', () => {
  // #347：参数档的文案改成带状态码 + **具体字段**（上游原文里点得出来就带上），
  // 并附带「打开设置」入口与可复制的诊断 —— 期望值走真实 translate()，不手写字符串
  const paramCopy = (status, field) =>
    translate('replyParamInvalid', { status: `HTTP ${status}`, field })
  for (const [label, sample, field] of [
    ['空 messages', EMPTY_MESSAGES, 'messages'],
    ['max_tokens 非法', BAD_MAX_TOKENS, 'max_tokens'],
  ]) {
    assert.equal(classifyErrorSignature(sample), 'badRequest', `${label} 是请求被拒绝`)
    const notice = noticeOf(apiErrorOf(sample))
    assert.equal(notice.text, paramCopy(sample.status, field), `${label} 用参数错误文案（带字段）`)
    assert.match(notice.text, /不要重试/, `${label} 是 4xx：文案要说清不要重试`)
    assert.equal(notice.action, 'settings', `${label} 要给出「打开设置」入口（#347 / #353）`)
    assert.match(notice.upstream ?? '', /HTTP \d{3}/, `${label} 的折叠区里有上游原文（#347）`)
  }
})

test('[1] 真实样本：上下文超长仍是上下文档（#122 不回退）', () => {
  assert.equal(classifyErrorSignature(CONTEXT_TOO_LONG), 'contextLimit')
  const notice = noticeOf(apiErrorOf(CONTEXT_TOO_LONG))
  assert.equal(notice.text, zh.replyContextLimit)
})

test('[1] 真实样本：401 authentication_error 仍是 Key 无效（#303 不回退）', () => {
  const sample = {
    status: 401,
    code: 'authentication_error',
    message: 'Authentication Fails, Your api key: ****2305 is invalid',
  }
  assert.equal(classifyErrorSignature(sample), 'unauthorized')
  const notice = noticeOf(apiErrorOf(sample))
  assert.equal(notice.text, zh.replyInvalidApiKey)
  assert.equal(notice.action, 'apiKey')
})

// ---------------------------------------------------------------- [2] 流内 error 帧
test('[2] 流内 error 帧（没有 HTTP 状态码）也能分类：内容拦截 / 模型不存在', () => {
  const filtered = classifyErrorSignature({
    code: 'content_filter',
    message: 'Your request was rejected by the content filter.',
  })
  assert.equal(filtered, 'contentFilter', '没有 status 也要认出内容拦截')

  const filteredNotice = noticeOf({
    kind: 'stream',
    message: 'Your request was rejected by the content filter.',
    upstreamCode: 'content_filter',
  })
  assert.equal(filteredNotice.text, zh.replyContentFiltered)
  assert.match(filteredNotice.text, /不要重试/, '内容拦截重发一定还是被拦：明说不要重试')

  const modelNotice = noticeOf({
    kind: 'stream',
    message: MODEL_NOT_FOUND.message,
    upstreamCode: MODEL_NOT_FOUND.code,
  })
  assert.equal(modelNotice.text, modelInvalidCopy(), '流内帧里说模型不存在，同样要认出来')
})

// ---------------------------------------------------------------- [3] 可重试性
test('[3] 可重试 / 不可重试：分类与文案同时说清', () => {
  const cases = [
    ['内容拦截', apiErrorOf({ status: 400, message: 'blocked by content filter' }), false],
    ['模型不存在', apiErrorOf(MODEL_NOT_FOUND), false],
    ['参数错误', apiErrorOf(BAD_MAX_TOKENS), false],
    ['额度不足', apiErrorOf({ status: 402, code: 'insufficient_balance', message: 'no balance' }), false],
    ['服务过载 503', apiErrorOf({ status: 503, message: 'server overloaded' }), true],
    ['502 网关', apiErrorOf({ status: 502, message: 'bad gateway' }), true],
    ['限流 429', apiErrorOf({ status: 429, message: 'rate_limit_reached' }), true],
    ['空响应 200', apiErrorOf({ status: 200, message: '' }, 'protocol'), true],
    ['断流', new ApiError('interrupted', 'broken pipe'), true],
    ['空闲超时', new ApiError('idle', { key: 'replyWaitingStalled' }), true],
  ]
  for (const [label, error, expected] of cases) {
    assert.equal(isRetryableApiError(error), expected, `${label} 的可重试性`)
  }

  // 文案层面也要显式区分：5xx 说「可以重试」，内容拦截/参数错误说「不要重试」
  const busy = noticeOf(apiErrorOf({ status: 503, message: 'server overloaded' }))
  assert.equal(busy.text, zh.replyServerBusy)
  assert.match(busy.text, /可以重试/, '5xx 是临时故障：明说可以重试')
  const filtered = noticeOf(apiErrorOf({ status: 400, message: 'rejected: content_policy_violation' }))
  assert.match(filtered.text, /不要重试/, '内容拦截：明说不要重试')
  // 现有 5xx / 限流文案也带上了明确措辞，且与终态文案不重名
  assert.match(zh.replyRateLimited, /可以重试/)
  assert.match(zh.replyInsufficientBalance, /不要重试/)
  assert.match(zh.replyEmptyStream, /可以重试/)
})

// ---------------------------------------------------------------- [4] 负向
test('[4] 负向：502 不会被认成内容拦截（文案里带 content filter 也不行）', () => {
  const condition = classifyErrorSignature({
    status: 502,
    code: 'invalid_request_error',
    message: 'upstream connect error or disconnect/reset before headers; content filter unavailable',
  })
  assert.equal(condition, 'serverBusy', '5xx 一律走服务端故障档，不参与文案类判定')
  const notice = noticeOf(
    apiErrorOf({
      status: 502,
      message: 'upstream connect error or disconnect/reset before headers; content filter unavailable',
    })
  )
  assert.equal(notice.text, zh.replyServerBusy)
  assert.doesNotMatch(notice.text, /审核/, '不能把网关故障说成内容被拦')
})

test('[4] 负向：普通 400 不会被认成额度 / 内容拦截', () => {
  const condition = classifyErrorSignature(BAD_MAX_TOKENS)
  assert.equal(condition, 'badRequest', '参数错误就是参数错误')
  assert.notEqual(condition, 'insufficientBalance')
  assert.notEqual(condition, 'contentFilter')
  // 400 里出现「quota」这个词但不是额度问题（文件数量配额）也不该进额度档
  assert.notEqual(
    classifyErrorSignature({ status: 400, message: 'User file count limit exceeded' }),
    'insufficientBalance',
    '附件数量配额 ≠ 余额不足（#299 的口径不能被放宽）'
  )
})

test('[4] 负向：200 正常内容不会被当成空响应', () => {
  assert.equal(classifyErrorSignature({ status: 200 }), 'emptyStream', '2xx 出现在错误分类里只可能是空壳')
  // 真正的正常路径根本不进分类：describeReply 对 done 的回复返回 null
  assert.equal(describeReply({ ...emptyReply(), status: 'done' }), null)
})

// ---------------------------------------------------------------- [5] 真未知
test('[5] replyUnknownError 只在真未知时出现', () => {
  const unknown = noticeOf({ kind: 'stream', message: 'upstream exploded at /v1/messages' })
  assert.equal(unknown.text, zh.replyUnknownError, '无状态码、无上游 code、无可读文案 → 才是真未知')
  assert.equal(unknown.diagnostics, undefined, '真未知没有可复制的诊断内容')

  // 只要上游给了状态码，就不再是「未知错误」
  const withStatus = noticeOf({ kind: 'http', message: 'weird failure', status: 418 })
  assert.notEqual(withStatus.text, zh.replyUnknownError)
  assert.match(withStatus.text, /HTTP 418/, '状态码要摆出来')
  assert.ok(withStatus.diagnostics, '有状态码就该给一份可复制的诊断')

  // 只要上游给了 code，也不再是「未知错误」
  const withCode = noticeOf({
    kind: 'stream',
    message: 'weird failure',
    upstreamCode: 'upstream_timeout',
  })
  assert.notEqual(withCode.text, zh.replyUnknownError)
  assert.match(withCode.text, /upstream_timeout/, '上游短码要摆出来')
  assert.ok(withCode.diagnostics)
})

// ---------------------------------------------------------------- [6] 可自证诊断
test('[6] 兜底文案带状态码 + 上游短码 + 可复制诊断，且不含聊天正文与 Key', () => {
  // 418 + 未知短码 = 既不是额度 / 拦截 / 模型 / 参数档，也不是 5xx：真正的「未识别但有据可查」
  const notice = noticeOf({
    kind: 'http',
    status: 418,
    message: 'totally new upstream failure shape',
    upstreamCode: 'weird_upstream_code',
  })
  assert.match(notice.text, /HTTP 418/, '文案里有 HTTP 状态码')
  assert.match(notice.text, /weird_upstream_code/, '文案里有上游短码')
  assert.match(notice.text, /不要重试/, '4xx 的未识别错误属终态：明说不要重试')
  assert.doesNotMatch(notice.text, /totally new upstream failure shape/, '长英文原文不上界面')
  assert.ok(notice.diagnostics, '带「复制诊断信息」的内容')

  const diagnostics = notice.diagnostics
  assert.match(diagnostics, /HTTP 状态: 418/, '诊断里有状态码')
  assert.match(diagnostics, /上游 code: weird_upstream_code/, '诊断里有上游短码')
  assert.match(diagnostics, /环节: http/, '诊断里说明了失败发生在哪个环节')
  assert.doesNotMatch(diagnostics, /你好|聊天正文/, '诊断里没有聊天正文')

  // 脱敏：跑一遍 #104 同一条口径（scrubReportText）
  const scrubbed = buildReplyErrorReport({
    status: 500,
    upstreamCode: 'boom',
    kind: 'stream',
    message: 'failed with sk-test0000000000000000000000 at https://api.deepseek.com/x?sign=abc',
    at: 0,
  })
  assert.doesNotMatch(scrubbed, /sk-test0000000000000000000000/, 'API Key 必须被抹掉')
  assert.match(scrubbed, /sk-\*\*\*/, 'Key 脱敏成 sk-***')
  assert.doesNotMatch(scrubbed, /sign=abc/, 'URL query 里的签名不进诊断')
  assert.match(scrubbed, /响应流内/, '诊断说明失败发生在流里')

  // 中英文案成对：新增的 7 个 key 两个语言都有，且真的翻译了
  const keys = [
    'replyContentFiltered',
    'replyModelInvalid',
    'replyBadRequest',
    'replyEmptyStream',
    'replyServerBusy',
    'replyUnclassifiedRetryable',
    'replyUnclassifiedFatal',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }
  // 占位符 language-neutral：两个语言都带 {detail}
  assert.match(zh.replyUnclassifiedRetryable, /\{detail\}/)
  assert.match(en.replyUnclassifiedRetryable, /\{detail\}/)
  assert.equal(
    translate('replyUnclassifiedRetryable', { detail: 'HTTP 422，code=x' }),
    zh.replyUnclassifiedRetryable.replace('{detail}', 'HTTP 422，code=x')
  )
})

// ---------------------------------------------------------------- [7] 空流真代码路径
const encoder = new TextEncoder()
const sseHeaders = { 'Content-Type': 'text/event-stream' }
const BODY = { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }

/** 跑真实的 streamMessage，按 store 的方式收尾，再问界面显示什么 */
const runStream = async (response) => {
  globalThis.fetch = async () => response
  const controller = new AbortController()
  const blockIndexes = new Map()
  let reply = { ...emptyReply(), status: 'pending' }
  let error
  try {
    for await (const event of streamMessage('sk-test', BODY, controller.signal)) {
      reply = applyEvent(reply, event, 0, blockIndexes)
    }
  } catch (caught) {
    error = caught
  }
  const settled = error
    ? settleReply(reply, 'error', 1, {
        kind: error.kind,
        message: error.message,
        status: error.status,
        ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
        localMessage: error.localMessage,
      })
    : settleReply(reply, 'done', 1)
  return { error, condition: error ? classifyApiError(error) : null, notice: describeReply(settled) }
}

test('[7] 200 + SSE 但零帧（空流）→ emptyStream，不是「未知错误」也不是「连接中断」', async () => {
  const { error, condition, notice } = await runStream(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      { status: 200, headers: sseHeaders }
    )
  )
  assert.equal(error?.code, 'stream_empty', '空流有独立 code')
  assert.equal(condition, 'emptyStream', '分类是 emptyStream（可重试的临时故障）')
  assert.equal(notice.text, zh.replyEmptyStream)
  assert.notEqual(notice.text, zh.replyUnknownError)
  assert.notEqual(notice.text, zh.replyStreamInterrupted, '一帧没收到 ≠ 说到一半断了')
})

test('[7] 200 + 非 SSE 正文（上游给了个空壳）→ emptyStream', async () => {
  const { condition, notice } = await runStream(
    new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } })
  )
  assert.equal(condition, 'emptyStream')
  assert.equal(notice.text, zh.replyEmptyStream)
})

test('[7] 说到一半断掉仍是「连接中断」（不被空流抢走）', async () => {
  const head = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}',
    '',
    '',
  ].join('\n')
  const { condition, notice } = await runStream(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(head))
          controller.close()
        },
      }),
      { status: 200, headers: sseHeaders }
    )
  )
  assert.equal(condition, 'interrupted', '收到过帧再断 = 断流')
  assert.equal(notice.text, zh.replyStreamInterrupted)
})

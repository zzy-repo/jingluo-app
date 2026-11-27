// [layer: unit | 依赖: 无（纯 Node，零浏览器零真实上游） | 耗时: <2s]
//
// Issue #929：**流式错误帧丢弃 `code` / `type`，附件报错落入「未知错误」**
// （`openaiAdapter → client` 链路）。
//
// 线上形态（issue 里的生产数据）：当日 `status_code=200` 的错误 631 条，其中 604 条没有
// 中文文本 —— 界面上只剩一句「回答没有完成，出现了未知错误」。可这些失败的**上游帧里
// 明明带着机器可读的 code**，只是链路把它扔了：
//
//   OpenAI 兼容协议（`openaiAdapter.ts`）在流里读到错误帧时
//     throw new OpenAIStreamError(detail.message)      ← code / type 在这里被丢掉
//   `client.ts` 的 catch 再把它降级成
//     new ApiError('stream', error.message)            ← 没有 upstreamCode、没有 detail
//   于是 `errorNotice.ts` 的判定拿不到任何证据 → 落到最后一行 →「未知错误」。
//
// 对照：**Anthropic 协议那一路**早就把上游短码带上了（`readUpstreamCode(payload)`），
// 所以同一个网关、同一个错误，只有走 OpenAI 兼容协议时才是「未知」。这就是本单的缺陷面。
//
// 本文件既是 issue 要的复现脚本（`repro-attach-unknown`），也是修复后的回归用例：
//   [A] 打印「错误帧原文 → 上层 ApiError → 界面文案」的对照表（修复前后贴进 PR 的就是它）
//   [B] 帧里带 code/type → `ApiError.upstreamCode` 到位，界面不再说「未知错误」
//   [C] 帧里只有 message（老格式 / 没有 code 的帧）→ 不炸、照旧透传原文，界面文案仍是我们
//       自己的 i18n 文案（**绝不把英文原文直出给用户**）；此时仍然是既有的「未知错误」档 ——
//       「流内错误帧但没给 code」该说什么话是 #940/#941 的事，本单只负责把字段送上去
//   [D] `code` 优先于 `type`（两家网关两种写法）
//   [E] 顺带钉住 issue 里另一条范围：`classifyErrorSignature` 的「HTML 先于 413」顺序
//       （413 → contextLimit 的既有口径不许被 #434 的 HTML 判定抢走，反之亦然）
//
//   node --test tests/unit/repro-attach-unknown.test.mjs
//   node tests/run-layer.mjs unit --only repro-attach-unknown
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

import { chatStub, installTsResolve, setupDom } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口两个替身 + `.js→.ts` 解析 + 浏览器全局替身。
// 附件上传 / 配置写入都会记诊断，不给替身就会在装配阶段就炸（与本单无关）。
installTsResolve({
  stubs: [
    [/^@capacitor\/core$/, chatStub('capacitor.mjs')],
    [/diagnostics\/collector\.js$/, chatStub('collector.mjs')],
  ],
})

const dom = setupDom()
after(() => dom.restore())

globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const { classifyErrorSignature } = await import('../../src/services/api/errors.ts')
const { streamMessage } = await import('../../src/services/api/client.ts')
const { applyEvent, settleReply } = await import('../../src/services/chat/reply.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { pickErrorNotice } = await import('../../src/services/chat/errorNotice.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言才不跟着 shell 的 LANG 走')

// ---------------------------------------------------------------- 渠道：OpenAI 兼容协议
// 走 openai 兼容协议是这条缺陷的前提（Anthropic 那一路已经带 code）。地址用不可解析的
// 保留域名：所有请求都被下面的 fetch 替身接住，一个字节都不会真的出网。
const BASE_URL = 'https://relay-929.mock.invalid'
const MODEL = 'relay-model'
apiConfig.setProviderKind('openai')
apiConfig.setApiKey('sk-repro-929')
assert.equal(apiConfig.setBaseUrlFor('openai', BASE_URL), true, 'mock 地址要能写进去')
apiConfig.setModelFor('openai', MODEL)
assert.equal(
  apiConfig.getCurrentSpec().protocol,
  'openai',
  '前提：这条链路必须走 openaiAdapter（否则测的是 Anthropic 那条已经带 code 的路）'
)

// ---------------------------------------------------------------- 构造上游流
const encoder = new TextEncoder()
const sseHeaders = { 'Content-Type': 'text/event-stream' }

/** 首帧：正常正文（真实失败里流通常是先开始再报错，错误帧落在正文之后） */
const OPENING_CHUNK = JSON.stringify({
  id: 'chatcmpl-929',
  model: MODEL,
  choices: [{ index: 0, delta: { role: 'assistant', content: '收到' } }],
})

/**
 * 附件请求（#929 的现场）：用户发了一份附件，OpenAI 兼容中转在流里回一条错误帧。
 * 请求体按本渠道的真实形态拼：附件正文走文本注入（这条协议没有 file 块，见
 * `openaiAdapter.ts` 文件头的能力说明），所以上游看到的是「带附件正文的一条消息」。
 */
const attachmentBody = () => ({
  model: MODEL,
  system: '',
  max_tokens: 512,
  messages: [
    {
      role: 'user',
      content: `[附件：q3-report.pdf]\n（正文略）\n\n帮我看下这份报表`,
    },
  ],
})

/**
 * 跑一次真链路：`client.streamMessage` → `openaiAdapter.translateOpenAIStream` →
 * 错误帧 → `ApiError` → `settleReply` 落盘 → `describeReply` 渲染。
 * 返回上层真正拿到的东西，供对照表与断言使用。
 */
const runStream = async (frameLines) => {
  const text = [OPENING_CHUNK, ...frameLines].map((line) => `data: ${line}\n\n`).join('')
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text))
          controller.close()
        },
      }),
      { status: 200, headers: sseHeaders }
    )
  }
  const blockIndexes = new Map()
  let reply = { id: 'reply-929', role: 'assistant', createdAt: 0, status: 'pending', blocks: [], prefix: false }
  let error
  try {
    for await (const event of streamMessage('sk-repro-929', attachmentBody(), new AbortController().signal)) {
      reply = applyEvent(reply, event, 0, blockIndexes)
    }
  } catch (caught) {
    error = caught
  }
  assert.ok(calls.length > 0, 'fetch 替身必须被调用（否则说明没走到真实请求层）')
  // 与 store.ts 落盘口径一致：上游短码 / 原文一起写进 error 里，界面层只看这份
  const settled = error
    ? settleReply(reply, 'error', 1, {
        kind: error.kind,
        message: error.message,
        status: error.status,
        ...(error.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
        ...(error.detail ? { detail: error.detail } : {}),
        localMessage: error.localMessage,
      })
    : settleReply(reply, 'done', 1)
  const notice = describeReply(settled)
  const condition = error ? classifyErrorSignature({
    status: error.status,
    code: error.upstreamCode,
    message: [error.message, error.detail ?? ''].join('\n'),
  }) : null
  const row = notice
    ? pickErrorNotice({
        kind: error?.kind,
        code: error?.code,
        status: error?.status,
        upstreamCode: error?.upstreamCode,
        condition,
        hasReadableText: false,
      })
    : null
  return { url: calls[0], error, settled, notice, condition, row }
}

/** 错误帧原文 → 上层对象 → 界面文案 的对照表（PR 里贴的就是它） */
const report = (label, frame, result) => {
  const { error, notice, condition, row } = result
  const lines = [
    '',
    `── ${label} ─────────────────────────────────────────────`,
    `请求地址           ${result.url}`,
    `错误帧原文         ${frame}`,
    `上层错误类型       ${error ? error.name : '（没有抛错）'}`,
    `  kind             ${String(error?.kind)}`,
    `  status           ${String(error?.status)}`,
    `  code             ${String(error?.code)}`,
    `  upstreamCode     ${String(error?.upstreamCode)}   ← 上游 error.code ?? error.type`,
    `  detail           ${error?.detail === undefined ? 'undefined' : JSON.stringify(error.detail)}`,
    `  message          ${JSON.stringify(error?.message)}`,
    `落盘 error         ${JSON.stringify(result.settled.error)}`,
    `分类 condition     ${String(condition)}`,
    `命中表格行         ${String(row?.id)}（文案 key=${String(
      row ? (typeof row.key === 'function' ? row.key({
        kind: error?.kind,
        status: error?.status,
        upstreamCode: error?.upstreamCode,
        condition,
        hasReadableText: false,
      }) : row.key) : '(无)'
    )}）`,
    `界面文案           ${JSON.stringify(notice?.text)}`,
    `  == 未知错误?     ${
      notice?.text === zh.replyUnknownError
        ? error?.upstreamCode
          ? '**是**（帧里有 code 却落成「未知」= 本单要修的缺陷）'
          : '是（帧里本来就没 code；本单不改文案，该档话术归 #940/#941）'
        : '否'
    }`,
    `折叠区上游原文     ${notice?.upstream === undefined ? '无' : JSON.stringify(notice.upstream)}`,
  ]
  console.log(lines.join('\n'))
  return result
}

// ---------------------------------------------------------------- [A] 对照表 + [B] 台账
// 帧原文照中转的真实形状写：`error` 里同时有 `type`（OpenAI 官方写法）与 `code`（网关常用）。
const ATTACH_FRAME = JSON.stringify({
  error: {
    message: 'File type is not supported: application/pdf',
    type: 'invalid_request_error',
    code: 'unsupported_file_type',
  },
})

test('[A] 附件请求被上游拒：错误帧原文 → 上层 ApiError → 界面文案（对照表）', async () => {
  const result = report('[A] 附件错误帧（带 code + type）', ATTACH_FRAME, await runStream([ATTACH_FRAME]))
  assert.ok(result.error, '错误帧必须抛错（不能被翻译成一个空的正常回复）')
})

test('[B] 帧里的 code/type 要透传到 ApiError.upstreamCode（#929 的核心修复）', async () => {
  const { error, notice } = await runStream([ATTACH_FRAME])
  assert.equal(error?.kind, 'stream', '错误帧仍是 kind=stream（区分「流里报错」与 4xx/断流）')
  assert.equal(error?.status, undefined, '流内错误帧没有 HTTP 状态码')
  assert.equal(
    error?.upstreamCode,
    'unsupported_file_type',
    '上游短码必须透传（改前这里是 undefined，界面因此只能说「未知错误」）'
  )
  assert.match(String(error?.detail), /unsupported_file_type/, '错误帧原文进 detail，只给日志与折叠区')
  assert.ok(notice, '界面必须有提示')
  assert.notEqual(notice.text, zh.replyUnknownError, '带 code 的失败不许再显示「未知错误」')
  assert.doesNotMatch(
    notice.text,
    /File type is not supported/,
    '主文案不许把上游英文原文直出（原文只进折叠区 / 诊断）'
  )
})

// ---------------------------------------------------------------- [C] 向后兼容
test('[C] 老格式（只有 message、没有 code/type）→ 不炸，原文照旧透传', async () => {
  const oldFrame = JSON.stringify({ error: { message: 'upstream overloaded, try later' } })
  // 这一类是 issue 里「604 条无中文文本」的主体：帧里根本没有 code。本单**只负责透传**，
  // 所以它们的行为与改前完全一致（仍是既有的 unknown 档）—— 不给它们专用文案是刻意的：
  // 「流内错误帧该怎么说话」归 #940/#941，避免三方各写一套。
  const { error, notice } = report('[C] 老格式错误帧（没有 code/type）', oldFrame, await runStream([oldFrame]))
  assert.equal(error?.kind, 'stream', '没有 code 也照旧是流内错误帧')
  assert.equal(error?.upstreamCode, undefined, '没有 code/type 时 upstreamCode 必须是 undefined（不编造）')
  assert.equal(error?.message, 'upstream overloaded, try later', 'message 原样透传（与改前一致）')
  assert.ok(notice?.text, '界面仍要有提示（不能因为没 code 就什么都不显示）')
  assert.doesNotMatch(notice.text, /upstream overloaded/, '英文原文不许直出')
  assert.equal(notice.text, zh.replyUnknownError, '没有 code 时仍走既有「未知错误」档（本单不改文案）')
})

test('[C] 老格式的错误帧在中文 / 英文界面都显示我们自己的文案', async () => {
  const oldFrame = JSON.stringify({ error: { message: 'upstream overloaded, try later' } })
  try {
    useSettings.setState({ locale: 'zh-CN' })
    const zhText = (await runStream([oldFrame])).notice?.text
    useSettings.setState({ locale: 'en-US' })
    const enText = (await runStream([oldFrame])).notice?.text
    assert.match(zhText ?? '', /[\u4e00-\u9fa5]/, `中文环境是中文：${zhText}`)
    assert.doesNotMatch(enText ?? '', /[\u4e00-\u9fa5]/, `英文环境不是中文：${enText}`)
    assert.doesNotMatch(enText ?? '', /upstream overloaded/, '英文环境也不许直出上游原文')
  } finally {
    useSettings.setState({ locale: 'zh-CN' })
  }
})

test('[C] 帧里只有字符串 error（老中转 `{"error":"..."}`）→ 仍按流内错误帧处理', async () => {
  const bare = JSON.stringify({ error: 'rate limited by relay' })
  const { error, notice } = await runStream([bare])
  assert.equal(error?.kind, 'stream')
  assert.equal(error?.upstreamCode, undefined, '没有结构化 code 时不编造')
  assert.match(String(error?.message), /rate limited by relay/)
  assert.ok(notice?.text)
})

// ---------------------------------------------------------------- [D] code 优先于 type
test('[D] code 与 type 都有时取 code（两家网关两种写法，口径与 readUpstreamCode 一致）', async () => {
  const both = JSON.stringify({
    error: { message: 'boom', type: 'invalid_request_error', code: 'context_length_exceeded' },
  })
  const { error, condition, notice } = await runStream([both])
  assert.equal(error?.upstreamCode, 'context_length_exceeded', 'code 优先')
  assert.equal(condition, 'contextLimit', '认出上下文超长（改前没 code，只能落 other → 未知错误）')
  assert.notEqual(notice?.text, zh.replyUnknownError)
})

test('[D] 只有 type 时退到 type（OpenAI 官方 400 的常见写法）', async () => {
  const typeOnly = JSON.stringify({
    error: { message: 'You exceeded your current quota', type: 'insufficient_quota' },
  })
  const { error, condition, notice } = await runStream([typeOnly])
  assert.equal(error?.upstreamCode, 'insufficient_quota', 'type 兜底')
  assert.equal(condition, 'insufficientBalance', '额度不足要认出来（改前是「未知错误」）')
  assert.notEqual(notice?.text, zh.replyUnknownError)
})

// ---------------------------------------------------------------- [E] 413 / HTML 顺序
test('[E] 范围外的另一条：`HTML 先于 413` 的判定顺序（现有口径，本单不改）', () => {
  // 2xx + text/html = 打到网关（#434）：必须优先于 413 的 contextLimit
  assert.equal(
    classifyErrorSignature({ status: 200, contentType: 'text/html; charset=utf-8' }),
    'upstreamReturnedHtml',
    '2xx + 网页优先于一切状态码分类'
  )
  // 413 本身仍然是上下文超长（不是 HTML、也不该被 HTML 判定抢走）
  assert.equal(classifyErrorSignature({ status: 413 }), 'contextLimit', '413 仍是上下文档')
  // 413 + HTML 页：状态码更可操作（这里 HTML 判定被 isHtmlLikeStatus 限定在 2xx/3xx，故仍走 contextLimit）
  assert.equal(
    classifyErrorSignature({ status: 413, contentType: 'text/html' }),
    'contextLimit',
    '413 + 网页仍按状态码走上下文档（#434 的既有口径）'
  )
})

// ------------------------------------------- 本单不动文案：用到的 key 都是既有词条
// #929 只做适配层的字段透传（code / type 能到上层），**不新增任何用户文案** ——
// 「流内错误帧该说什么话」是 #940 / #941 的活，避免三方各写一套。这条用例就是那个边界的钉子：
// 上面断言用到的每个 key 都必须在中英两边**早已存在**。
test('[F] 本单只复用既有文案 key（没有新增词条）', () => {
  const keys = ['replyUnknownError', 'replyUnclassifiedRetryable', 'replyUnclassifiedFatal']
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }
})

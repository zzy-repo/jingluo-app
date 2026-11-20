// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发真实网络请求） | 耗时: <2s]
//
// Issue #434：上游对 `POST /anthropic/v1/messages` 返回 **200 + text/html**（网关首页 / 报错页）时，
// 界面给的是「上游这次没有返回任何内容（空响应）；属于临时故障，可以重试」——
// `src/i18n/zh.ts` 里那条 `upstreamReturnedHtml` 文案**从界面上永远走不到**。
//
// 用例分三段，缺口各补一处：
//   [1] 表驱动：content-type × 状态码 × 是否 SSE → 分类。
//       6 行里必须有一行是 `200 + text/html` 走 html 档，另有一行 `200 + application/json`
//       仍走 emptyStream（#324 的空响应口径**不许**被这次改动吃掉）。
//   [2] 真代码路径：真 `streamMessage()` + 200 + text/html → `ApiError.code` 判死、
//       分类 = upstreamReturnedHtml、**不可重试**（改前落 emptyStream，重试 3 次）、
//       界面文案带「上游返回的是网页而不是数据」，折叠区带 content-type + 正文前 200 字。
//   [3] 负向：非 2xx 的 HTML 报错页仍按状态码走（401 换 Key / 5xx 可重试），
//       不能被「返回的是网页」抢走出路。
//
//   node --test tests/unit/upstream-html-classify-434.test.mjs
//   node tests/run-layer.mjs unit --only upstream-html-classify-434
import '../helpers/injected.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatBridge, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口 + 构建期注入值一次装好
installChatBridge()
installEndpointsGlobals()
const dom = setupDom()

const {
  classifyApiError,
  classifyErrorSignature,
  isRetryableApiError,
  UPSTREAM_HTML_CODE,
} = await import('../../src/services/api/errors.ts')
const { streamMessage } = await import('../../src/services/api/client.ts')
const { applyEvent, settleReply } = await import('../../src/services/chat/reply.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

test.after(() => dom.restore())

assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言钉在中文，断言不受 shell 的 LANG 影响')

const GATEWAY_HTML =
  '<!doctype html><html><head><title>Sub2API - AI API Gateway</title></head><body>SUB2API_GATEWAY_HTML</body></html>'

// ---------------------------------------------------------------- [1] 表驱动分类
/**
 * 一行 = 一种「上游回了什么」。
 *   status / contentType  ：响应头事实（SSE 用 `text/event-stream` 表达，与真实响应同形）
 *   expect                ：分类结果
 *   why                   ：这一行在守什么（写进断言消息，红了就知道是哪条口径破了）
 */
const ROWS = [
  {
    label: '200 + text/html（网关首页 / 报错页，#434 的主场景）',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    expect: 'upstreamReturnedHtml',
    why: '网页冒充接口数据要单独成档，绝不能被 2xx 兜底吃成「空响应」',
  },
  {
    label: '200 + application/xhtml+xml（同族的 XML 变体）',
    status: 200,
    contentType: 'application/xhtml+xml',
    expect: 'upstreamReturnedHtml',
    why: '只认 text/html 会漏掉网关的 XHTML 报错页',
  },
  {
    label: '200 + text/html + 请求层已判死的 code',
    status: 200,
    contentType: 'text/html',
    code: UPSTREAM_HTML_CODE,
    expect: 'upstreamReturnedHtml',
    why: '请求层明确分类过的失败，分类层必须认同一件事（#434 的根因就在这里）',
  },
  {
    label: '200 + 空 content-type（上游给了个空壳）',
    status: 200,
    expect: 'emptyStream',
    why: '#324 的空响应口径不许回归：没有正文、没有类型 = 上游这次什么都没说',
  },
  {
    label: '200 + application/json（非 SSE 的 JSON 空壳）',
    status: 200,
    contentType: 'application/json',
    expect: 'emptyStream',
    why: '同上：JSON 但没有内容，仍然是「空响应、可重试」',
  },
  {
    label: '200 + text/event-stream（SSE 头到了但零帧）',
    status: 200,
    contentType: 'text/event-stream',
    expect: 'emptyStream',
    why: 'SSE 是流式接口的正常类型，一帧没来仍然是空响应',
  },
  {
    label: '401 + text/html（网关的鉴权失败页）',
    status: 401,
    contentType: 'text/html',
    expect: 'unauthorized',
    why: '401 的出路是换 Key：不能被「返回的是网页」抢走',
  },
  {
    label: '502 + text/html（网关报错页）',
    status: 502,
    contentType: 'text/html',
    expect: 'serverBusy',
    why: '5xx 是临时故障、可重试：走状态码档比说「网页」更有用',
  },
]

test('[1] 表驱动：content-type × 状态码 × 是否 SSE → 分类（含 200 + text/html 必须走 html 档）', () => {
  assert.ok(ROWS.length >= 6, `用例行数要 ≥6，实际 ${ROWS.length}`)
  assert.ok(
    ROWS.some((row) => row.status === 200 && /text\/html/.test(row.contentType ?? '')),
    '表里必须有一行是 200 + text/html（#434 的验收口径）'
  )
  for (const row of ROWS) {
    const actual = classifyErrorSignature({
      status: row.status,
      code: row.code,
      contentType: row.contentType,
    })
    assert.equal(actual, row.expect, `[${row.label}] ${row.why}（实际 ${actual}）`)
  }
})

// ---------------------------------------------------------------- [2] 真代码路径
const BODY = { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }
const emptyReply = () => ({
  id: 'reply-434',
  role: 'assistant',
  createdAt: 0,
  status: 'pending',
  blocks: [],
  prefix: false,
})

/** 跑真实 streamMessage，再按 store 的方式收尾，最后问界面显示什么 */
const runStream = async (response) => {
  globalThis.fetch = async () => response
  const controller = new AbortController()
  const blockIndexes = new Map()
  let reply = emptyReply()
  let error
  try {
    for await (const event of streamMessage('sk-test-434', BODY, controller.signal)) {
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
        // store.ts 落盘的三个字段（#434）：客户端 code + 响应摘要 + 本地文案
        ...(error.code ? { code: error.code } : {}),
        ...(error.detail ? { detail: error.detail } : {}),
        localMessage: error.localMessage,
      })
    : settleReply(reply, 'done', 1)
  return { error, settled, condition: error ? classifyApiError(error) : null }
}

test('[2] 真代码路径：200 + text/html → html 档、不可重试、文案可达、折叠区有响应摘要', async () => {
  const { error, settled, condition } = await runStream(
    new Response(GATEWAY_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  )
  assert.ok(error, '这种响应必须抛错，绝不能当成回答渲染')
  assert.equal(error.code, UPSTREAM_HTML_CODE, '请求层要给出明确的客户端错误码')
  assert.equal(error.status, 200, '状态码按上游原样保留（诊断里要能看到「上游说 200」）')
  assert.match(error.detail ?? '', /content-type: text\/html/i, '响应摘要里要有 content-type')
  assert.match(error.detail ?? '', /SUB2API_GATEWAY_HTML/, '响应摘要里要有正文开头（认得出是谁的报错页）')

  assert.equal(condition, 'upstreamReturnedHtml', '分类不能再是 emptyStream')
  assert.equal(
    isRetryableApiError(error),
    false,
    '同一份 HTML 重发多少次都一样：#434 改前白重试 3 次，这里必须判死'
  )

  const notice = describeReply(settled)
  assert.equal(notice.text, zh.upstreamReturnedHtml, '主文案必须是 upstreamReturnedHtml（以前不可达）')
  assert.match(notice.text, /上游返回的是网页而不是数据/, '说人话：是网页而不是数据')
  assert.match(notice.text, /网关或代理/, '并指出通常是网关 / 代理出错')
  assert.match(notice.text, /不要重试/, '同一请求重发没用：明说不要重试')
  assert.doesNotMatch(notice.text, /空响应/, '不许再说成空响应')
  assert.ok(notice.upstream, '折叠区要有响应摘要')
  assert.match(notice.upstream, /HTTP 200/, '折叠区第一行是状态码')
  assert.match(notice.upstream, /content-type: text\/html/i, '折叠区带 content-type')
  assert.match(notice.upstream, /SUB2API_GATEWAY_HTML/, '折叠区带正文前 200 字')
  assert.ok(notice.diagnostics, '可复制诊断（反馈时要这一段）')
  // 摘要截断：整页 HTML 不能原样进折叠区
  assert.ok((notice.upstream ?? '').length < 400, '响应摘要必须截断到 200 字量级')
})

test('[2] 负向对照：200 + application/json 的空壳仍是 emptyStream（可重试、文案是空响应）', async () => {
  const { error, settled, condition } = await runStream(
    new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } })
  )
  assert.equal(condition, 'emptyStream', '#324 的口径不许被 #434 的改动吃掉')
  assert.equal(isRetryableApiError(error), true, '空响应是临时故障：仍然可重试')
  const notice = describeReply(settled)
  assert.equal(notice.text, zh.replyEmptyStream)
  assert.doesNotMatch(notice.text, /网页/, '空响应不能说成「返回的是网页」')
})

// ---------------------------------------------------------------- [3] 负向 + 中英文案
test('[3] 负向：非 2xx 的 HTML 报错页仍按状态码给出路（401 换 Key / 5xx 可重试）', () => {
  // 分类层的口径（请求层会把 401 的 HTML 也标成 upstream_returned_html，这里两条都断言）
  assert.equal(classifyErrorSignature({ status: 401, contentType: 'text/html' }), 'unauthorized')
  assert.equal(
    classifyErrorSignature({ status: 401, code: UPSTREAM_HTML_CODE }),
    'unauthorized',
    '401 的出路是换 Key，不能被「网页」抢走'
  )
  assert.equal(classifyErrorSignature({ status: 503, contentType: 'text/html' }), 'serverBusy')
  assert.equal(
    classifyErrorSignature({ status: 503, code: UPSTREAM_HTML_CODE }),
    'serverBusy',
    '503 是临时故障，仍按可重试的 5xx 处理'
  )
})

test('[3] 中英文案成对：新的 html 文案两边都有、真的翻译了、都没有留空', () => {
  assert.equal(typeof zh.upstreamReturnedHtml, 'string')
  assert.equal(typeof en.upstreamReturnedHtml, 'string')
  assert.notEqual(zh.upstreamReturnedHtml, en.upstreamReturnedHtml, '英文要真的翻译过')
  assert.match(zh.upstreamReturnedHtml, /网页/)
  assert.match(en.upstreamReturnedHtml, /web page/)
  assert.equal(
    translate('upstreamReturnedHtml'),
    zh.upstreamReturnedHtml,
    'translate() 与 zh 原文一致（占位符没漏）'
  )
})

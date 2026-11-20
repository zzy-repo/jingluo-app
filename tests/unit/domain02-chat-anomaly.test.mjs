// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #452（聊天部分 C1 / C3）—— #362 盘点的「部分覆盖（缺异常分支）」补齐。
//
// 覆盖功能点（docs/testing/coverage/domain-01-02.md）：
//   F2-07 限流 / 断网 / 超时 / 断流的**有上限自动重试**
//         → C1 行 1：断流（每次都在第一个字之前断掉）按上限重试后收敛，请求次数 = 1 + 上限
//   F2-09 断流 / 空响应的**终态文案**
//         → C1 行 1：终态必须说「上游这次什么都没返回，属于临时故障，可以重试」，
//           不能糊成「未知错误」，也不能说成「不要重试」（那是终态 4xx 的话）
//   F2-08 上下文超长
//         → C3：长会话先被预算裁剪，裁剪后上游**仍然**说超限时，界面给的是可操作建议
//           （开新会话 / 删几条较早的消息），并且**不再重试**（只发 1 次请求）
//
// 为什么 C1 用「一个内容帧都没有的断流」而不是「说到一半断掉」：
// `store.decideStreamRetry` 对「已经收到过内容」的失败一律不再重发（重发会答两遍），
// 所以「重试后仍失败」在生产里唯一可达的形态是「每次都在出第一个字之前断」。
// 「说到一半断掉 → 半句保留 + 不重试」由 integration/domain02-reply-error-ui 的行 5 覆盖。
//
// 这里跑的是**真实 store / reply / describe / contextBudget 代码**，只用替身换掉
// fetch（造各种失败形态）、IndexedDB（假库）、Capacitor 原生桥与诊断写入口。
//
// 负向验证（改坏对应分支必须让本文件变红，实测输出见 PR）：
//   C1：把 `decideStreamRetry` 里的 `attempt >= STREAM_RETRY_LIMIT` 去掉 → 行 1 的请求次数断言红（变成无限重试）
//   C1：把 store 里 `error.localMessage` 的回落改成 `undefined` → 行 1 的终态文案断言红（变成上游英文原文）
//   C3：把 store 里 `condition === 'contextLimit'` 的特判去掉 → C3 的终态文案断言红（变成参数错误档）
//
// 跑法：
//   node tests/unit/domain02-chat-anomaly.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installChatEnv, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 / #408）：原生桥 + 诊断写入口 + 「只有 chat/store.ts 的 ./db.js 才是假库」
installChatEnv()
// 构建期注入值（__ENDPOINTS__ / __API_ORIGIN__ / __INTERNAL_BUILD__）与 __log 记账本
installEndpointsGlobals()

setupDom()

const realSetTimeout = globalThis.setTimeout
/**
 * 退避等待压缩到 1ms：只压 `retryBaseDelay × 2^attempt` 的 1000 / 2000 两档。
 * 其余定时器（首字分级提示、请求超时预算）原样不动 —— 压它们会改变被测语义。
 */
const RETRY_BACKOFF_MS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, RETRY_BACKOFF_MS.has(ms) ? 1 : ms, ...args)

// ---- fetch 替身：必须在 import 真实源码**之前**挂好（请求层在模块初始化时就会取一次 fetch） ----
const encoder = new TextEncoder()

/** 一条完整的 Anthropic 风格 SSE 回答（官方渠道就是这条协议） */
const answerSse = (text) =>
  [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_452',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'mock-model',
          stop_reason: null,
          usage: { input_tokens: 8, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('')

const sseResponse = (body) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 正常答完的一轮（用来攒长历史） */
const answerStream = (text) => sseResponse(answerSse(text))

/**
 * 断流的最短形态：200 + SSE 头，然后**一个内容帧都没有**就结束。
 * 请求层判成 `interrupted` + `stream_empty`（#324），界面文案该说「空响应，可以重试」。
 */
const emptyStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 上游报错：Anthropic 兼容形状的 JSON body */
const jsonError = (status, { message, type }) =>
  new Response(JSON.stringify({ type: 'error', error: { message, type } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * 自动标题请求（#127）也是流式请求，不能算进「回答请求发了几次」。
 * 官方渠道由服务端在 message_delta 里返回标题、不发单独请求；兼容渠道靠 `max_tokens=32` 区分。
 */
const isTitleRequest = (body) => typeof body?.max_tokens === 'number' && body.max_tokens <= 64

let calls = 0
let respond = () => emptyStream()
const requests = []

globalThis.fetch = async (_url, init) => {
  let body = {}
  try {
    body = JSON.parse(init?.body ?? '{}')
  } catch {
    body = {}
  }
  if (isTitleRequest(body)) {
    return answerStream('会话标题')
  }
  calls += 1
  requests.push({ body })
  return respond(calls, body)
}

// ---- 真实源码 ----
const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { getLastContextTrim, resetContextBudget, setContextBudget } = await import(
  '../../src/services/chat/contextBudget.ts'
)
const { zh } = await import('../../src/i18n/zh.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { pinLocale } = await import('../helpers/locale.mjs')
const store = await import('../../src/services/chat/store.ts')

const { STREAM_RETRY_LIMIT, initChat, sendMessage, useChatStore } = store

// 本文件断言的是中文文案，语言必须钉死（否则 LANG=en_US 的机器上整片红，见 #366）
assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言必须钉在中文，不能跟随 shell 的 LANG')
assert.ok(
  Number.isInteger(STREAM_RETRY_LIMIT) && STREAM_RETRY_LIMIT >= 1,
  `自动重试必须有明确上限且至少 1 次（实际 ${STREAM_RETRY_LIMIT}）`
)

/** 本轮出现的「正在第 N 次重试」提示，按 attempt 去重（store 每次重算都会 set 一次） */
const retryHints = new Map()
useChatStore.subscribe((state) => {
  for (const hint of Object.values(state.waitHints ?? {})) {
    if (hint?.key === 'chatRetrying') {
      retryHints.set(hint.params?.attempt, hint)
    }
  }
})

const sessionOf = (sessionId) => useChatStore.getState().sessionCache[sessionId]
const lastReply = (sessionId) =>
  sessionOf(sessionId).messages.filter((message) => message.role === 'assistant').at(-1)

/** 等本轮收尾：订阅 streaming 表，而不是轮询 */
const awaitIdle = (sessionId, timeoutMs = 20_000) =>
  new Promise((resolve, reject) => {
    const streaming = () => Object.hasOwn(useChatStore.getState().streaming, sessionId)
    if (!streaming()) {
      resolve()
      return
    }
    const timer = realSetTimeout(() => {
      unsubscribe()
      reject(new Error('本轮没有收尾，用例无法继续（疑似卡在重试或永远 streaming）'))
    }, timeoutMs)
    const unsubscribe = useChatStore.subscribe(() => {
      if (!streaming()) {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
    })
  })

/** 新会话里发一条，等收尾，返回本轮的回答请求次数、终态回复与界面文案 */
const runRound = async ({ onRespond, text = '这条会失败' }) => {
  calls = 0
  requests.length = 0
  retryHints.clear()
  respond = onRespond
  await initChat()
  setApiKey('sk-test-452')
  setDraftText(null, text)
  assert.equal(sendMessage(null), true, '草稿非空时应能发出去')
  const sessionId = useChatStore.getState().activeId
  assert.ok(sessionId, '应新建会话')
  await awaitIdle(sessionId)
  const reply = lastReply(sessionId)
  const notice = describeReply(reply)
  return {
    calls,
    reply,
    sessionId,
    text: notice?.text ?? '',
    hints: [...retryHints.values()],
    body: requests.at(-1)?.body ?? {},
  }
}

// ---------------------------------------------------------------------------
// C1 断流重试后仍失败：终态文案 + 可重试/不可重试判定 + 重试有上限
// ---------------------------------------------------------------------------
/**
 * 表驱动两行，列就是断言口径：
 *   respond       本轮的失败形态（会作用在**每一次**尝试上）
 *   calls         回答请求的准确次数（= 1 + 重试次数；这是「有上限」的唯一硬证据）
 *   kind          终态 error.kind
 *   expectText    界面必须出现的终态文案（整句比对，含「可重试 / 不要重试」的判定）
 *   retryable     文案是否告诉用户「可以重试」
 *   hintAttempts  「正在第 N 次重试」出现过的 attempt 序列
 */
const C1_ROWS = [
  {
    id: 'C1 行 1 断流（空响应）每次都在首字前断掉',
    covers: ['F2-07', 'F2-09'],
    respond: () => emptyStream(),
    calls: 1 + STREAM_RETRY_LIMIT,
    kind: 'interrupted',
    expectText: zh.replyEmptyStream,
    retryable: true,
    hintAttempts: Array.from({ length: STREAM_RETRY_LIMIT }, (_, index) => index + 1),
  },
  {
    id: 'C1 行 2 不可重试档（403 被拒）只发 1 次',
    covers: ['F2-07'],
    respond: () => jsonError(403, { message: 'forbidden by upstream gateway', type: 'permission_error' }),
    calls: 1,
    kind: 'http',
    expectText: zh.replyUpstreamRejected.replace('{status}', 'HTTP 403'),
    retryable: false,
    hintAttempts: [],
  },
]

for (const row of C1_ROWS) {
  test(`${row.id}（覆盖 ${row.covers.join(' / ')}）`, async () => {
    const result = await runRound({ onRespond: row.respond })
    // ① 重试有上限：次数必须精确等于「1 次首发 + 上限次重试」，多一次就是无限重试，少一次就是没兜底
    assert.equal(
      result.calls,
      row.calls,
      `回答请求次数必须是 ${row.calls}（1 次首发 + ${row.calls - 1} 次重试），实际 ${result.calls}`
    )
    // ② 终态：错误收尾并回到可发送态，不是永远 streaming
    assert.equal(result.reply.status, 'error', '重试到上限后必须收尾成 error，不能挂着 streaming')
    assert.equal(result.reply.error?.kind, row.kind, `终态 error.kind 应为 ${row.kind}`)
    assert.equal(
      Object.hasOwn(useChatStore.getState().streaming, result.sessionId),
      false,
      '收尾后不能继续占着 streaming（否则输入框永远回不到可发送态）'
    )
    // ③ 最终文案：整句比对，顺带证明「可重试 / 不要重试」的判定没有串档
    assert.equal(result.text, row.expectText, '终态文案必须是这一档的整句原文')
    if (row.retryable) {
      assert.match(result.text, /可以重试/, '可重试档必须明确告诉用户可以重试')
      assert.doesNotMatch(result.text, /不要重试/, '可重试档不许说「不要重试」')
    } else {
      assert.doesNotMatch(result.text, /可以重试/, '不可重试档不许误导成「可以重试」')
      assert.match(result.text, /不要重试/, '不可重试档必须明说重试没用')
    }
    // ④ 「正在第 N 次重试」：次数与上限都要对得上，且不重复计次
    assert.deepEqual(
      result.hints.map((hint) => hint.params?.attempt),
      row.hintAttempts,
      `重试提示的 attempt 序列应为 ${JSON.stringify(row.hintAttempts)}`
    )
    for (const hint of result.hints) {
      assert.equal(hint.params?.limit, STREAM_RETRY_LIMIT, '重试提示里的上限必须与实现一致')
    }
  })
}

// ---------------------------------------------------------------------------
// C3 上下文超长后的降级：裁剪后仍超限 → 给可操作建议，不再重试
// ---------------------------------------------------------------------------
/**
 * 前提：会话真的**被裁剪过**（否则「裁剪后仍超限」这句话不成立）。
 * 做法：把预算调到很小（maxTokens 150 / maxRounds 3），先正常攒 6 轮历史；
 * 第 7 轮上游回 400 + context_length_exceeded —— 此时请求体已经裁过，仍然超限。
 */
const LONG_ROUNDS = 6
const answerFor = (index) => `第 ${index} 轮回答：先做幂等写入，再做冲突合并，最后补重试队列。`

test('C3 裁剪后仍超限：给可操作建议且不再重试（覆盖 F2-08）', async () => {
  setContextBudget({ maxTokens: 150, maxRounds: 3 })
  try {
    calls = 0
    requests.length = 0
    retryHints.clear()
    respond = (call) => answerStream(answerFor(call))
    await initChat()
    setApiKey('sk-test-452')

    let sessionId = null
    for (let index = 0; index < LONG_ROUNDS; index += 1) {
      const text = index === 0 ? '把「历史记录同步」拆成接口清单和实现步骤' : `接着上一轮，补充第 ${index} 部分`
      setDraftText(sessionId, text)
      assert.equal(sendMessage(sessionId), true, `第 ${index + 1} 轮应能发出去`)
      sessionId = useChatStore.getState().activeId
      assert.ok(sessionId, '应有一个会话')
      await awaitIdle(sessionId)
    }
    const historyMessages = sessionOf(sessionId).messages.length
    assert.ok(historyMessages >= LONG_ROUNDS * 2, `${LONG_ROUNDS} 轮应攒出 ${LONG_ROUNDS * 2} 条消息`)

    // 关键一步：这一次上游**仍然**说上下文太长（裁剪没救回来）
    calls = 0
    requests.length = 0
    retryHints.clear()
    respond = () =>
      jsonError(400, {
        message:
          "This model's maximum context length is 8192 tokens. However, your messages resulted in 91234 tokens.",
        type: 'invalid_request_error',
      })
    setDraftText(sessionId, '这轮会被裁剪，也会被上游判超限')
    assert.equal(sendMessage(sessionId), true, '这一轮应能发出去')
    await awaitIdle(sessionId)

    const reply = lastReply(sessionId)
    const notice = describeReply(reply)
    const trim = getLastContextTrim()
    const body = requests.at(-1)?.body ?? {}
    const userMessages = (body.messages ?? []).filter((message) => message.role === 'user')

    // ① 前提成立：请求体确实被裁过（否则这条用例证明不了「裁剪之后」）
    assert.ok(trim.roundsDropped > 0, `本轮必须真的裁剪过历史（roundsDropped=${trim.roundsDropped}）`)
    assert.ok(
      userMessages.length < LONG_ROUNDS + 1,
      `裁剪后请求体里不应再带全部 ${LONG_ROUNDS} 轮历史（实际带 ${userMessages.length - 1} 轮 + 本轮提问）`
    )
    assert.equal(
      userMessages.length,
      trim.roundsKept + 1,
      '请求体里的提问条数必须等于「保留下来的轮数 + 本轮提问」'
    )
    // ② 不再重试：上下文超长重发多少次都是同一个结果（这正是 C3 要防的「用户一直重试」）
    assert.equal(calls, 1, `裁剪后仍超限时只许发 1 次请求，实际 ${calls} 次`)
    assert.equal(retryHints.size, 0, '不许出现「正在第 N 次重试」——这不是重试能解决的问题')
    assert.equal(reply.status, 'error', '这一轮应正常收尾成 error')
    assert.equal(reply.error?.status, 400, '终态保留上游真实状态码，便于对账')
    // ③ 文案可操作：说清「开新会话 / 删几条较早的消息」，且不是「可以重试」
    assert.equal(notice?.text, zh.replyContextLimit, '终态文案必须是上下文超长这一档的原文')
    assert.match(notice?.text ?? '', /开一个新会话/, '必须给出「开新会话」这条可操作的路')
    assert.match(notice?.text ?? '', /删掉几条较早的消息/, '必须给出「删几条较早的消息」这条可操作的路')
    assert.doesNotMatch(notice?.text ?? '', /可以重试/, '上下文超长不能说成「可以重试」')
    assert.equal(
      reply.error?.localMessage?.key,
      'replyContextLimit',
      '落库的文案 key 必须是这一档（刷新后仍说同一句话）'
    )
  } finally {
    resetContextBudget()
  }
})

test('C1 收尾：本轮结束后「正在第 N 次重试」已撤下，界面不会一直像在重试（覆盖 F2-07）', async () => {
  const result = await runRound({ onRespond: () => emptyStream() })
  assert.equal(result.reply.status, 'error', '前置：这一轮必须已经结束')
  await new Promise((resolve) => realSetTimeout(resolve, 20))
  const lingering = Object.values(useChatStore.getState().waitHints ?? {}).filter(
    (hint) => hint?.key === 'chatRetrying'
  )
  assert.deepEqual(lingering, [], '收尾后不许残留重试提示（否则界面永远像还在重试）')
})

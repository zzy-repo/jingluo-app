// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #41 断流可识别 + 错误文案本地化：只 import 真实源码（client.ts / errors.ts / chat/describe.ts），
// 用假 fetch 喂 SSE 字节流，不碰 DOM / Capacitor / 真网络。诊断写入口替换成内存数组。
//
//   node tests/unit/chat-stream-interrupt.test.mjs
//
// 覆盖（对应任务书第 2、3 条）：
//   [1] 流在 message_stop 之前结束：抛可识别的断流错误，不是空消息、不冒充「网络异常」
//   [2] 读到一半响应体报错（真断网/断流）：同样是断流，原始原因保留在 detail 里给日志
//   [3] 断流错误码独立，与上游返回 HTML、普通网络错误的分类互不冲突
//   [4] 已收到的半句正文不丢，重试入口（status=error）仍在
//   [5] 界面提示是 i18n 文案、含「连接中断」，中英各自本地化
//   [6] 未知错误的英文原文不上界面，改走 i18n 兜底；中文可读原文原样展示
//   [7] 正常结束的流不受影响（不误判断流、不产生提示）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installChatBridge } from '../helpers/dom-env.mjs'

// 装配走公共入口（#408 收尾批）：原生桥 + 诊断入口的替身由 installChatBridge 一次装好
// （原先 3 个文件各抄一份 23 行 registerHooks + 本地 stub()）。
installChatBridge()

// 构建期注入的常量：单测没有 rspack 的 DefinePlugin，先挂到全局再 import。
globalThis.__API_ORIGIN__ = 'https://api.test.invalid'
globalThis.INTERNAL_BUILD = false
globalThis.__log = { records: [], events: [], actions: [] }

const { ApiError, streamMessage } = await import('../../src/services/api/client.ts')
const { classifyApiError } = await import('../../src/services/api/errors.ts')
const { applyEvent, settleReply } = await import('../../src/services/chat/reply.ts')
const { describeReply } = await import('../../src/services/chat/describe.ts')
const { translate } = await import('../../src/i18n/index.ts')
const { useSettings } = await import('../../src/services/settings.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const { pinLocale } = await import('../helpers/locale.mjs')

// 断流提示的断言看的是中文渲染结果（「连接中断」），而 settings.ts 的默认语言跟随
// navigator.language（Node 里来自 shell 的 LANG）：不钉死就会 LANG=en_US 红、LANG=zh_CN 绿。
// 默认钉在中文；需要英文的用例自己在局部切 locale（见下面的 localized 判定）。
assert.equal(pinLocale(useSettings), 'zh-CN', '界面语言必须钉在中文，不能跟随 shell 的 LANG')

const encoder = new TextEncoder()

const frame = (event, data) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, ''].join('\n')

/** 前两段正文之后流就没了（服务端没有 message_stop，也没给 error 帧） */
const HEAD = [
  frame('message_start', {
    type: 'message_start',
    message: { usage: { input_tokens: 9, output_tokens: 0 } },
  }),
  frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '服务端已经' },
  }),
  frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '发了半句' },
  }),
  '',
].join('\n')

const TAIL = [
  frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { input_tokens: 9, output_tokens: 8 },
  }),
  frame('message_stop', { type: 'message_stop' }),
  '',
].join('\n')

const sseHeaders = { 'Content-Type': 'text/event-stream' }

/** 正常字节流：把 chunks 依次吐出后正常关闭 */
const streamOf = (chunks) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    }),
    { status: 200, headers: sseHeaders }
  )

/** 断掉的字节流：先吐一次，再让 reader 直接 reject（模拟连接被掐断） */
const brokenStreamOf = (chunk, error) => {
  let sent = false
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(chunk))
          return
        }
        controller.error(error)
      },
    }),
    { status: 200, headers: sseHeaders }
  )
}

const emptyReply = () => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 0,
  status: 'pending',
  blocks: [],
  prefix: false,
})

const BODY = { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] }

/** 跑一次真实的 streamMessage：事件真合并进回复，出错按 store 的方式收尾 */
const run = async (responseFactory) => {
  globalThis.fetch = async () => responseFactory()
  const controller = new AbortController()
  const blockIndexes = new Map()
  let reply = emptyReply()
  let error
  try {
    for await (const event of streamMessage('sk-test', BODY, controller.signal)) {
      reply = applyEvent(reply, event, 0, blockIndexes)
    }
  } catch (caught) {
    error = caught
  }
  return {
    error,
    reply,
    // store.streamReply 的 catch 分支对 ApiError 就是这么翻译的
    settled: error
      ? settleReply(reply, 'error', 1, {
          kind: error.kind,
          message: error.message,
          status: error.status,
          localMessage: error.localMessage,
          retryable: true,
        })
      : settleReply(reply, 'done', 1),
  }
}

const textOf = (reply) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

test('断流：没有 message_stop 就结束，抛可识别的断流错误', async () => {
  const { error, settled } = await run(() => streamOf([HEAD]))

  assert.ok(error instanceof ApiError, '断流必须抛 ApiError，不能是裸 TypeError')
  assert.equal(error.kind, 'interrupted', '断流的 kind 保持 interrupted')
  assert.equal(error.code, 'stream_interrupted', '断流要有独立错误码')
  assert.ok(error.message.trim(), '错误消息不能是空串（空串界面就是一片空白）')
  assert.equal(error.localMessage?.key, 'replyStreamInterrupted', '断流要带 i18n 文案 key')
  assert.equal(error.message, translate('replyStreamInterrupted'), '错误消息是本地化文案')

  // [3] 分类：断流既不是「网络异常」，也不该并进 other
  assert.equal(classifyApiError(error), 'interrupted', 'classifyApiError 单独归类断流')
  assert.notEqual(classifyApiError(error), 'network', '断流不能冒充普通网络错误')

  // [4][5] 提示：有解释、含「连接中断」、已经收到的正文还在
  const notice = describeReply(settled)
  assert.ok(notice, '断流后必须有提示，不能 alerts=[]')
  assert.match(notice.text, /连接中断/, '提示要说清楚是连接中断')
  assert.equal(textOf(settled), '服务端已经发了半句', '已经收到的正文不能丢')
  assert.equal(settled.status, 'error', '断流后仍是可重试的 error 状态')
})

test('断流：读到一半响应体报错，同样是断流且原文留给日志', async () => {
  const cause = new TypeError('network error')
  const { error, settled } = await run(() => brokenStreamOf(HEAD, cause))

  assert.ok(error instanceof ApiError, '响应体中途报错也要收成 ApiError')
  assert.equal(error.kind, 'interrupted', '中途断掉按断流处理')
  assert.equal(error.code, 'stream_interrupted', '错误码与「正常结束但缺 message_stop」一致')
  assert.equal(error.detail, 'network error', '原始原因留在 detail 里，只给日志/元信息')
  assert.doesNotMatch(error.message, /network error/, '界面文案里不出现英文原文')

  const notice = describeReply(settled)
  assert.ok(notice, '断流后必须有提示')
  assert.match(notice.text, /连接中断/, '提示要说清楚是连接中断')
  assert.doesNotMatch(notice.text, /network|error/i, '提示里不泄露英文原文')
  assert.equal(textOf(settled), '服务端已经发了半句', '已经收到的正文不能丢')
})

test('断流：中止请求仍按用户停止处理，不误报断流', async () => {
  globalThis.fetch = async (_url, init) => {
    const signal = init?.signal
    const body = new ReadableStream({
      start(controller) {
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        controller.enqueue(encoder.encode(HEAD))
      },
    })
    return new Response(body, { status: 200, headers: sseHeaders })
  }
  const controller = new AbortController()
  const iterator = streamMessage('sk-test', BODY, controller.signal)
  await iterator.next()
  controller.abort()
  let error
  try {
    for (;;) {
      const { done } = await iterator.next()
      if (done) {
        break
      }
    }
  } catch (caught) {
    error = caught
  }
  assert.ok(error, '中止后迭代器必须退出')
  assert.notEqual(error.kind, 'interrupted', '用户停止不能当成断流去提示')
})

test('正常流：message_stop 收尾，不误判断流、不产生提示', async () => {
  const { error, reply, settled } = await run(() => streamOf([HEAD, TAIL]))

  assert.equal(error, undefined, '正常结束不应该抛错')
  assert.equal(textOf(reply), '服务端已经发了半句', '正文完整拼接')
  assert.equal(settled.status, 'done', '正常结束是 done')
  assert.equal(describeReply(settled), null, '正常结束不弹提示')
})

test('本地化：中英文案各自落地，未知英文原文不上界面', async () => {
  assert.notEqual(zh.replyStreamInterrupted, en.replyStreamInterrupted, '断流文案中英不同')
  for (const key of ['replyStreamInterrupted', 'replyUnknownError']) {
    assert.equal(typeof zh[key], 'string', `${key} 有中文文案`)
    assert.equal(typeof en[key], 'string', `${key} 有英文文案`)
    assert.notEqual(zh[key], en[key], `${key} 真的翻译了`)
  }

  const localized = (locale) => {
    useSettings.setState({ locale })
    try {
      return describeReply({
        ...emptyReply(),
        status: 'error',
        error: {
          kind: 'interrupted',
          message: 'whatever',
          localMessage: { key: 'replyStreamInterrupted' },
        },
      }).text
    } finally {
      useSettings.setState({ locale: 'zh-CN' })
    }
  }
  assert.match(localized('zh-CN'), /连接中断/, '中文环境显示中文')
  assert.doesNotMatch(localized('en-US'), /[\u4e00-\u9fa5]/, '英文环境不显示中文')

  // [6] 未知错误：英文内部错误只进日志，界面走 i18n 兜底
  const unknown = describeReply({
    ...emptyReply(),
    status: 'error',
    error: { kind: 'stream', message: 'upstream exploded at /v1/messages' },
  })
  assert.ok(unknown, '未知错误也要有提示')
  assert.equal(unknown.text, translate('replyUnknownError'), '未知错误用 i18n 兜底文案')
  assert.doesNotMatch(unknown.text, /upstream exploded/, '不把英文原文丢给用户')

  // 上游给的是可读中文提示时原样展示，不吞掉有用信息
  const chinese = describeReply({
    ...emptyReply(),
    status: 'error',
    error: { kind: 'stream', message: '当前模型不支持图片输入' },
  })
  assert.equal(chinese.text, '当前模型不支持图片输入', '中文原文可读就直接展示')

  // 网络错误仍然是「网络异常」，不受本次改动影响
  const network = describeReply({
    ...emptyReply(),
    status: 'error',
    error: { kind: 'network', message: 'Failed to fetch' },
  })
  assert.equal(network.text, translate('commonNetworkErrorToast'), '普通网络错误文案不变')
})

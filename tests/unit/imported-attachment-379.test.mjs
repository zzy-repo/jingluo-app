// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #379：导入的历史会话（曾带附件）继续聊天报「上传失败」，官方渠道也复现，新会话正常。
//
// 根因链（本用例把整条链路钉住，store / reply / attachments 都是真代码）：
//   ① 导入时所有附件的 serverId 一律置空（history/toLocal.ts 的 toFile）；
//   ② 旧代码发送前不只补本轮提问的附件，还会把**历史轮次**里没有 serverId 的附件也拿去补传
//      （prepareFiles 第二段循环）。导入的图片原件是随 ZIP 落盘的 → db.loadFile 有值
//      → 真的打了一次 Files API；
//   ③ 上传失败把失败态写进上传任务表（attachments.ts 的 setTask），
//      附件卡片照任务表渲染（MessageFile 的 useUploadState）→「上传失败」挂在老附件上，
//      用户以为纯文字消息也发不出去。
//
// 修复后的口径：
//   [1] 历史附件**一个上传请求都不发**（它们只是历史记录，不属于本轮）；
//   [2] 文字消息照常发出、本轮回答正常收尾（附件不可用不再阻断发送）；
//   [3] 上传任务表里没有历史附件的失败态 → 卡片不会再显示「上传失败」；
//   [4] 诊断日志能区分「历史附件跳过」与「本轮附件上传失败」；
//   [5] 再发一轮仍然不重传（不是只跳过第一次）。
//
//   node tests/unit/imported-attachment-379.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

const SESSION_ID = 'imp-379'
/** 导入的历史附件：本地 id 沿用归档里的 id，serverId 一律 null（toLocal 的 toFile 就是这么写的） */
const HISTORY_FILE_ID = 'hist-img-379'

/** 导入会话照 toLocal 的产物造：历史附件 serverId=null、mimeType=''，标题是导入语 */
const importedSession = () => ({
  id: SESSION_ID,
  title: '来自分享的对话',
  createdAt: Date.parse('2026-11-10T10:00:00Z'),
  updatedAt: Date.parse('2026-11-10T10:05:00Z'),
  rootMessageId: 'u1',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: '看看这张图',
      createdAt: Date.parse('2026-11-10T10:00:00Z'),
      selectedChildId: 'a1',
      files: [
        // 归档里没有扩展名的图片是常态（用户相册导出），MIME 也是空串
        { id: HISTORY_FILE_ID, serverId: null, name: 'IMG_0001', size: 2048, isImage: true, mimeType: '' },
      ],
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: Date.parse('2026-11-10T10:00:20Z'),
      model: null,
      thinking: false,
      search: false,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: '这是一张海边的照片。' }],
    },
  ],
})

/** 导入的图片原件确实在本地（ZIP 里带原件的图片就是这么落盘的）：旧代码因此真的发起了上传 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

/**
 * 对照组：**本机自己上传过**的会话。历史附件带着 file_id，原件也在本机 ——
 * 服务端判它失效时必须还能重传自愈（换服务地址后旧 file_id 全失效就是这条路径）。
 * 它和导入会话的区别就是「有没有 file_id」，修复不能把这两件事混为一谈。
 */
const OWN_FILE_ID = 'own-img-379'
const OWN_SESSION_ID = 'own-379'
const ownSession = () => ({
  id: OWN_SESSION_ID,
  title: '换过服务地址的会话',
  createdAt: Date.parse('2026-11-10T09:00:00Z'),
  updatedAt: Date.parse('2026-11-10T09:05:00Z'),
  rootMessageId: 'ou1',
  messages: [
    {
      id: 'ou1',
      role: 'user',
      content: '这张图呢',
      createdAt: Date.parse('2026-11-10T09:00:00Z'),
      selectedChildId: 'oa1',
      files: [
        {
          id: OWN_FILE_ID,
          serverId: 'file-api-old379',
          name: 'photo.png',
          size: 2048,
          isImage: true,
          mimeType: 'image/png',
        },
      ],
    },
    {
      id: 'oa1',
      role: 'assistant',
      createdAt: Date.parse('2026-11-10T09:00:20Z'),
      model: null,
      thinking: false,
      search: false,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: '这是一张山景照。' }],
    },
  ],
})

installChatHostStubs({
  sessions: [importedSession(), ownSession()],
  loadFile: (id) =>
    id === HISTORY_FILE_ID || id === OWN_FILE_ID
      ? new Blob([PNG_BYTES], { type: id === OWN_FILE_ID ? 'image/png' : '' })
      : undefined,
})

const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { useUploads } = await import('../../src/services/attachments.ts')
const store = await import('../../src/services/chat/store.ts')
const { useChatStore, initChat, selectSession, sendMessage } = store

/** 真定时器：只借它做轮询，不接管 store 里的退避等待 */
const realSetTimeout = globalThis.setTimeout
const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

const encoder = new TextEncoder()
const ANSWER = '收到，我接着聊这张图。'

/** deepseek（Anthropic 协议）的 SSE：少一个事件都拿不到正文 */
const anthropicStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        send({
          type: 'message_start',
          message: {
            id: 'msg-379',
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        send({ type: 'content_block_stop', index: 0 })
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 20 },
        })
        send({ type: 'message_stop' })
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/**
 * 上游对「没有扩展名 + 空 MIME 的图片走文档通道」这类请求就是 400（#379 现场那次拒绝）。
 * 旧代码会把这条失败写进上传任务表 → 卡片显示「上传失败」。
 */
const uploadRejected = () =>
  new Response(JSON.stringify({ error: { message: 'invalid file_name: missing extension' } }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })

/** 每次真实请求：上传（FormData）与问答（JSON）分开记 */
const uploads = []
const chats = []
/** 上传成功的返回（自愈路径用得上）：Files API 的 file_id */
const uploadAccepted = (id) =>
  new Response(JSON.stringify({ id, object: 'file' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
/** 用例若接管问答请求，就由它决定这一轮返回什么 */
let chatResponder = null
/** 上传请求的应答：默认全部按「上游拒绝」处理（#379 现场那次），自愈用例改成成功 */
let uploadResponder = () => uploadRejected()

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/files')) {
    uploads.push({ url: target, method: init?.method ?? 'GET' })
    return uploadResponder()
  }
  const raw = typeof init?.body === 'string' ? init.body : ''
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  // 自动标题请求带 max_tokens，走另一套体，不算本轮问答
  if (body?.max_tokens !== undefined) {
    return anthropicStream('会话标题')()
  }
  chats.push({ url: target, raw, body })
  if (chatResponder) {
    const response = chatResponder(chats.length)
    if (response) {
      return response
    }
  }
  return anthropicStream(ANSWER)()
}

/** 等会话详情真正加载进缓存（selectSession 的加载是异步的） */
const awaitLoaded = async (timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (useChatStore.getState().sessionCache[SESSION_ID]) {
      return
    }
    await delay(2)
  }
  throw new Error('会话没有加载进来，测试无法继续')
}

/** 等这一轮收尾（不再有 streaming 中的流） */
const awaitIdle = async (sessionId, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return
    }
    await delay(2)
  }
  throw new Error('本轮没有收尾，测试无法继续')
}

/** 发一条纯文字消息，等收尾，返回本轮的最后一条回答 */
const send = async (sessionId, text) => {
  setDraftText(sessionId, text)
  assert.equal(sendMessage(sessionId), true, `「${text}」应能发出去`)
  await awaitIdle(sessionId)
  const session = useChatStore.getState().sessionCache[sessionId]
  return session.messages.filter((message) => message.role === 'assistant').at(-1)
}

const replyText = (reply) => reply.blocks.map((block) => block.text ?? '').join('')

/** 诊断日志替身里的记录（helpers 已把收集器写入口换成内存） */
const logRecords = (message) => globalThis.__log.records.filter((entry) => entry.message === message)

test('① 导入会话继续聊天：历史附件不重传，一个上传请求都不发', async () => {
  await initChat()
  setApiKey('sk-test-379')
  selectSession(SESSION_ID)
  await awaitLoaded()

  uploads.length = 0
  chats.length = 0
  const reply = await send(SESSION_ID, '开始')

  assert.deepEqual(
    uploads.map((item) => item.method),
    [],
    `历史附件不该在本轮重新上传（实际发了 ${uploads.length} 次上传请求）`
  )
  assert.equal(reply.status, 'done', '文字消息照常发出并正常收尾')
  assert.equal(replyText(reply), ANSWER)
})

test('② 历史附件没有留下失败态：卡片不会再渲染「上传失败」', () => {
  const tasks = useUploads.getState().tasks
  assert.equal(
    Object.hasOwn(tasks, HISTORY_FILE_ID),
    false,
    '历史附件不该有上传任务（有 error 任务卡片就会显示「上传失败」）'
  )
})

test('③ 请求里不重传也不引用失效的历史附件：纯文字 + 历史回答照常进上下文', () => {
  assert.ok(chats.length >= 1, '本轮必须真的发过问答请求')
  const messages = chats.at(-1).body.messages
  // 历史提问的文字还在、回答还在（上下文不因附件不可用而整轮丢失）
  assert.equal(messages[0].content, '看看这张图')
  assert.equal(messages[1].role, 'assistant')
  // 历史附件没有 file_id：不进请求，也不编一个假的
  const raw = chats.at(-1).raw
  assert.equal(raw.includes(HISTORY_FILE_ID), false, '本机附件 id 不该出现在请求里')
  assert.equal(raw.includes('"file_id"'), false, '没有 file_id 的历史附件不许重传成请求里的 file 引用')
})

test('④ 诊断日志能区分「历史附件跳过」与「本轮上传失败」', () => {
  const skipped = logRecords('history attachments not re-uploaded')
  assert.equal(skipped.length >= 1, true, '历史附件被跳过要有自己的日志事件')
  assert.equal(skipped.at(-1).fields.count, 1, '本轮有 1 个历史附件没有 file_id')
  assert.equal(skipped.at(-1).fields.reason, 'history')
  assert.deepEqual(logRecords('file upload failed'), [], '跳过不是失败，不许记成上传失败')
})

test('⑤ 再发一轮仍然不重传：不是只跳过第一次', async () => {
  uploads.length = 0
  const reply = await send(SESSION_ID, '继续')
  assert.deepEqual(uploads.map((item) => item.method), [], '第二轮同样不许补传历史附件')
  assert.equal(reply.status, 'done')
})

test('⑥ 对照：本机自己的附件被判失效时仍会重传自愈（不把「不重传历史」做成砍掉自愈）', async () => {
  selectSession(OWN_SESSION_ID)
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !useChatStore.getState().sessionCache[OWN_SESSION_ID]) {
    await delay(2)
  }
  assert.ok(useChatStore.getState().sessionCache[OWN_SESSION_ID], '对照会话要加载进来')

  uploads.length = 0
  chats.length = 0
  uploadResponder = () => uploadAccepted('file-api-new379')
  /** 第一次问答按上游口径回 400「file_id 失效」并点名旧 id，重试时恢复正常 */
  chatResponder = (count) =>
    count === 1
      ? new Response(
          JSON.stringify({
            error: {
              message:
                'messages.1.content.0.source.file_id: invalid file_id: file-api-old379',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      : null
  try {
    const reply = await send(OWN_SESSION_ID, '再看看吧')
    assert.equal(uploads.length, 1, '被判失效的自己的附件必须重传一次（原件在本机）')
    assert.equal(reply.status, 'done', '重传成功后这一轮照常收尾')
    assert.ok(chats.length >= 2, '失效 → 重传 → 重发，至少要两次问答请求')
    assert.equal(chats.at(-1).raw.includes('file-api-new379'), true, '重发必须用新的 file_id')
    assert.equal(chats.at(-1).raw.includes('file-api-old379'), false, '不许把失效的旧 id 再发一次')
  } finally {
    chatResponder = null
    uploadResponder = () => uploadRejected()
  }
})

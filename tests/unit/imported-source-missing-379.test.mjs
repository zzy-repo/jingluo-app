// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #379：导入的历史会话（曾带附件）继续聊天报「上传失败」，官方渠道也复现，新会话正常。
//
// ## 本轮定性（先把「失败在哪一环」说清楚，再谈改法）
//
// 9a5aae0（PR #444）已经把「历史轮次里的附件每轮都补传一次」这条路径去掉，所以**新发一条纯文字**
// 在今天的 main 上不会再去打 Files API —— 那一环已经不成立了（本文件 [1] 钉住：0 个上传请求）。
// 但同一个根因（导入附件在本机没有原件 / 不该被当成待发送附件）还活着，出现在**同一条附件被
// 当成「本轮提问附件」再发一次**的路径上：编辑并重发、重新生成、补传重试。
//
// 修复前的实测（真 store / 真 reply / 真 attachments 代码，本文件 [6] 就是这条的回归）：
//   · base64 渠道（anthropic / openai / ours）：`prepareInlineImages` 对提问图片取不到原件 →
//     抛 `imageSourceMissing` → **整条消息一个请求都没发出去**（reply.status = 'error',
//     error.kind = 'upload'）；
//   · deepseek 渠道：`ensureServerId` 返回 null → 图片**静默消失**（违反 #548「不许静默丢图」），
//     卡片上什么原因都不说；
//   · 源文件还在的导入图片更糟：被当成待上传附件真发一次 Files API，上游 400 后界面只剩
//     「上传失败」——不知道是哪张图、也不知道为什么。
//
// ## 修复后的口径
//
// 「源缺失」= **本机没有原件** → 只能展示、不能发送，因此：
//   [1] 不重传（没有东西可传）、不阻断（消息按剩下的内容照常发出）；
//   [2] 不静默：把「哪个附件、为什么没发」落到这条 user 消息上（`UserMessage.unavailable`），
//       界面在消息里给一条持久提示（不是 toast）—— 见 [1] / [2]；
//   [3] 官方渠道请求体**一字不改**：被跳过的附件本来就没有 `serverId`、也不会拼出 `file_id` 块，
//       于是「去掉它」与「它不存在」逐字节相同 —— 见 [4]；
//   [4] 真·上传失败必须点名（哪个附件 + 原因：缺失 / 404 / 超限 / 网络）—— 见 [5]；
//   [5] 附件全不可用又没有文字时**不发空消息** —— 见 [7]。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/imported-source-missing-379.test.mjs
//
// ## 负向对照（人工跑一次，结果抄在 PR 里）
//
// 把 `src/services/attachments/sendAudit.ts` 的判定 4 改成「一律按可发送处理」
// （即 `if (hasSource) { sendable.push(file) }` 换成 `sendable.push(file); continue` 之前不再查源），
// 则 [1] 的「消息发出去了 + 有提示」与 [6] 的「重发不再被附件拖垮」都变红 —— 那正是修前的现场。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

const IMP = 'imp-379-missing'
const PLAIN = 'imp-379-plain'
const PRESENT = 'imp-379-present'
/** ④ 专用的一对会话：只发一轮，请求体里除了「有没有那个源缺失的附件」之外条件完全相同 */
const BYTES_WITH = 'imp-379-bytes-with'
const BYTES_WITHOUT = 'imp-379-bytes-without'
/** ⑩ 专用：base64 渠道上「修前整条消息发不出去」的现场 */
const BASE64 = 'imp-379-base64'
/** 归档里的附件 id（导入沿用导出产物里的 id，不是本机新生成的） */
const FILE_ID = 'hist-file-379'
/** 同一份归档附件在「原件随 ZIP 落盘」那份会话里的 id：原件只在它身上存在 */
const FILE_ID_PRESENT = 'hist-file-379-present'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0x0d])
const QUESTION = '开始'

const userMessage = (id, content, files) => ({
  id,
  role: 'user',
  content,
  createdAt: Date.parse('2026-11-10T10:00:00Z'),
  // 分支指针：导入产物里消息树靠 parent_id / current_message_id 还原（history/toLocal.ts），
  // 这里照导入后的形状给（缺了它 getVisibleMessages 会把历史当成空的，探针就测不到历史附件）
  selectedChildId: 'a1',
  files,
})
const assistantMessage = (id) => ({
  id,
  parentId: 'u1',
  role: 'assistant',
  createdAt: Date.parse('2026-11-10T10:00:20Z'),
  model: null,
  thinking: false,
  search: false,
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text: '好的，我看过了。' }],
})

/** 导入会话：`history/toLocal.ts` 的 toFile 产物 —— serverId 一律 null、MIME 是空串 */
const importedFile = (id) => ({
  id,
  serverId: null,
  name: 'IMG_0001',
  size: 2048,
  isImage: true,
  mimeType: '',
})

const importedSession = (id, files) => ({
  id,
  title: '来自分享的对话',
  createdAt: Date.parse('2026-11-10T10:00:00Z'),
  updatedAt: Date.parse('2026-11-10T10:05:00Z'),
  rootMessageId: 'u1',
  messages: [userMessage('u1', '看看这张图', files), assistantMessage('a1')],
})

installChatHostStubs({
  sessions: [
    // 元信息在、原件不在（导入只保留文件信息：ZIP 只带图片原件，这条没有）
    importedSession(IMP, [importedFile(FILE_ID)]),
    // 同样的历史文字，**不带附件** —— 官方渠道请求体逐字节对照用
    importedSession(PLAIN, []),
    // 同样的历史文字，附件原件真的在（导入时随 ZIP 落盘的那种）
    importedSession(PRESENT, [importedFile(FILE_ID_PRESENT)]),
    importedSession(BYTES_WITH, [importedFile('hist-bytes-379')]),
    importedSession(BYTES_WITHOUT, []),
    importedSession(BASE64, [importedFile('hist-b64-379')]),
  ],
  loadFile: (id) => (id === FILE_ID_PRESENT ? new Blob([PNG], { type: 'image/jpeg' }) : undefined),
})

const { setApiKey, setProviderKind } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const store = await import('../../src/services/chat/store.ts')
const { useChatStore, initChat, selectSession, sendMessage, regenerateReply, editMessage } = store
const { auditSendableAttachments } = await import('../../src/services/attachments/sendAudit.ts')
const { describeUploadFailure, uploadFailureReasonOf, AttachmentUploadError } =
  await import('../../src/services/attachments/uploadFailure.ts')
const { ApiError } = await import('../../src/services/api/client.ts')
const { ImageSourceError } = await import('../../src/services/attachments/imageSource.ts')

setApiKey('sk-379-test')
// 官方渠道：请求体必须与「没有这个附件」逐字节相同（[4]）
setProviderKind('deepseek')

const realSetTimeout = globalThis.setTimeout
const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const encoder = new TextEncoder()
const ANSWER = '收到，我们接着聊。'

/** deepseek（Anthropic 协议）的 SSE：少一个事件都拿不到正文 */
const anthropicStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
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
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        })
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        send({ type: 'content_block_stop', index: 0 })
        send({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        })
        send({ type: 'message_stop' })
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** 上传请求（FormData）与问答请求（JSON）分开记：一个都不许发的是上传那一类 */
const uploads = []
const chats = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/files')) {
    uploads.push(target)
    return new Response(JSON.stringify({ error: { message: 'invalid file_name' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const raw = typeof init?.body === 'string' ? init.body : ''
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  if (body?.max_tokens !== undefined) {
    return anthropicStream('会话标题')()
  }
  chats.push({ url: target, raw })
  return anthropicStream(ANSWER)()
}

const awaitLoaded = async (sessionId, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (useChatStore.getState().sessionCache[sessionId]) {
      return
    }
    await delay(2)
  }
  throw new Error(`会话 ${sessionId} 没有加载进来`)
}

const awaitIdle = async (sessionId, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return
    }
    await delay(2)
  }
  throw new Error(`会话 ${sessionId} 的本轮没有收尾`)
}

const send = async (sessionId, text) => {
  setDraftText(sessionId, text)
  assert.equal(sendMessage(sessionId), true, `「${text}」应能发出去`)
  await awaitIdle(sessionId)
  const session = useChatStore.getState().sessionCache[sessionId]
  return {
    reply: session.messages.filter((message) => message.role === 'assistant').at(-1),
    question: session.messages.filter((message) => message.role === 'user').at(-1),
  }
}

const replyText = (reply) => reply.blocks.map((block) => block.text ?? '').join('')

await initChat()

/**
 * 切到某个会话并等它加载进缓存。
 * 不预加载全部会话：`SESSION_CACHE_LIMIT` 只有 5，预加载 6 个会把先用的那个挤出去，
 * 现象是「消息上的提示突然没了」——那是缓存淘汰，不是被测逻辑。每条用例自己声明要用哪个会话。
 *
 * 顺带它是「提示真的落进会话」的弱证明：被挤出去再读回来，提示还得在（见 [2]）。
 */
const use = async (sessionId) => {
  selectSession(sessionId)
  await awaitLoaded(sessionId)
}

test('① 导入会话（附件源缺失）发纯文字：一个上传请求都不发，消息照常发出，且提示里点名是哪个附件', async () => {
  await use(IMP)
  const before = uploads.length
  const { reply, question } = await send(IMP, QUESTION)
  assert.equal(uploads.length, before, '源缺失的附件不许再触发上传请求')
  assert.equal(reply.status, 'done', '消息必须真的发出去（不是停在「上传失败」）')
  assert.equal(replyText(reply), ANSWER)
  assert.equal(reply.error, undefined)
  assert.deepEqual(
    question.unavailable,
    [{ id: FILE_ID, name: 'IMG_0001', reason: 'source-missing' }],
    '消息上要留下「哪个附件、为什么没发」，界面据此在消息里提示'
  )
  // 日志能区分「附件不可用」与「上传端点失败」：有前者、没有后者
  const messages = globalThis.__log.records.map((entry) => entry.message)
  assert.ok(messages.includes('attachments unavailable at send'), '要有一条「附件不可用」的日志')
  assert.ok(!messages.includes('file upload failed'), '这条路径不许出现上传失败')
})

test('② 提示挂在**消息**上（不是全局状态 / toast），且不回头改写导入的老消息', async () => {
  await use(IMP)
  const session = useChatStore.getState().sessionCache[IMP]
  const questions = session.messages.filter((message) => message.role === 'user')
  const sent = questions.at(-1)
  assert.deepEqual(
    sent.unavailable,
    [{ id: FILE_ID, name: 'IMG_0001', reason: 'source-missing' }],
    '提示是这条消息自己的字段：重新渲染 / 重新读会话都还在'
  )
  assert.equal(
    questions[0].unavailable,
    undefined,
    '导入进来的老消息不许被事后改写（历史记录只读；提示只描述「这条新消息是怎么发的」）'
  )
})

test('③ 附件原件在的导入会话：与正常会话一致（不误报、不重传）', async () => {
  await use(PRESENT)
  const before = uploads.length
  const { reply, question } = await send(PRESENT, QUESTION)
  assert.equal(uploads.length, before, '历史附件不重传（#444 的口径保持不变）')
  assert.equal(reply.status, 'done')
  assert.equal(question.unavailable, undefined, '原件在的附件不许被说成「不可用」—— 误报比不报更糟')
})

test('④ 官方渠道：源缺失附件「去掉」与「它不存在」的请求体逐字节相同', async () => {
  await use(BYTES_WITH)
  await use(BYTES_WITHOUT)
  const start = chats.length
  await send(BYTES_WITH, QUESTION)
  await send(BYTES_WITHOUT, QUESTION)
  const [withMissing, withoutFile] = chats.slice(start)
  assert.ok(withMissing && withoutFile, '两轮问答请求都要真的发出去')
  assert.equal(
    withMissing.raw,
    withoutFile.raw,
    'deepseek 请求体不许因为「有个源缺失的附件」多/少一个字节（丢附件之外一字不改）'
  )
  assert.equal(/file/i.test(withMissing.raw), false, '源缺失的附件不许拼出 file_id / file 块')
})

test('⑤ 真·上传失败要点名：哪个附件 + 原因（缺失 / 404 / 超限 / 网络 / 其它）', () => {
  const sourceMissing = new ImageSourceError({ key: 'imageSourceMissing' }, false)
  assert.equal(uploadFailureReasonOf(sourceMissing), 'source-missing')
  assert.equal(describeUploadFailure('IMG_0001', sourceMissing).key, 'uploadFailedSourceMissing')

  const notFound = new ApiError('http', 'not found', 404)
  assert.equal(uploadFailureReasonOf(notFound), 'endpoint-not-found')
  assert.equal(describeUploadFailure('a.png', notFound).key, 'uploadFailedEndpointMissing')

  const tooLarge = new ApiError('http', 'payload too large', 413)
  assert.equal(uploadFailureReasonOf(tooLarge), 'too-large')

  const network = new ApiError('network', 'offline')
  assert.equal(uploadFailureReasonOf(network), 'network')
  assert.equal(describeUploadFailure('a.png', network).key, 'uploadFailedNetwork')

  const other = new ApiError('http', 'invalid file_name', 400)
  assert.equal(uploadFailureReasonOf(other), 'other')
  const copy = describeUploadFailure('report.pdf', other)
  assert.equal(copy.key, 'uploadFailedUnknown')
  assert.deepEqual(copy.params, { name: 'report.pdf' }, '文案里必须带上是哪个附件')
})

test('⑥ 导入消息「重新生成」+ 附件源缺失：以前整条发不出去，现在照常发出并提示', async () => {
  await use(IMP)
  const before = uploads.length
  regenerateReply(IMP)
  await awaitIdle(IMP)
  const session = useChatStore.getState().sessionCache[IMP]
  const reply = session.messages.filter((message) => message.role === 'assistant').at(-1)
  assert.equal(uploads.length, before, '重发也不许补传源缺失的历史附件')
  assert.equal(reply.status, 'done', '重发必须成功（修前 base64 渠道在这里抛 imageSourceMissing）')
  assert.equal(replyText(reply), ANSWER)
  const question = session.messages.filter((message) => message.role === 'user').at(-1)
  assert.deepEqual(question.unavailable, [
    { id: FILE_ID, name: 'IMG_0001', reason: 'source-missing' },
  ])
})

test('⑦ 附件全不可用、又没有文字：明说不发，不构造空消息', async () => {
  await use(IMP)
  const before = chats.length
  assert.equal(editMessage(IMP, 'u1', ''), true, '编辑成空文本（附件还在）这条路径要能走到发送前')
  await awaitIdle(IMP)
  const session = useChatStore.getState().sessionCache[IMP]
  const reply = session.messages.filter((message) => message.role === 'assistant').at(-1)
  assert.equal(chats.length, before, '没有任何内容可发时不许真的打上游')
  assert.equal(reply.status, 'error')
  assert.equal(reply.error?.kind, 'upload')
  assert.equal(
    reply.error?.localMessage?.key,
    'attachUnavailableNoText',
    '要说「附件不可用且没有文字」，不能发一条空消息'
  )
})

test('⑧ 审计本身：有 serverId / 文档引用 / 本轮刚选的 一律可发送，只有「没原件的历史附件」被跳过', async () => {
  const audit = await auditSendableAttachments(
    [
      {
        id: 'file-api-1',
        serverId: 'file-api-1',
        name: 'a.png',
        size: 1,
        isImage: true,
        mimeType: 'image/png',
      },
      {
        id: 'att-doc',
        serverId: null,
        name: 'a.pdf',
        size: 9,
        isImage: false,
        mimeType: 'application/pdf',
      },
      {
        id: 'draft-1',
        serverId: null,
        name: 'b.png',
        size: 1,
        isImage: true,
        mimeType: 'image/png',
      },
      { id: 'hist-1', serverId: null, name: 'c.png', size: 1, isImage: true, mimeType: '' },
      { id: 'hist-2', serverId: null, name: 'd.png', size: 1, isImage: true, mimeType: '' },
    ],
    { isOwnUpload: (id) => id === 'draft-1', hasSource: async (id) => id === 'hist-2' }
  )
  assert.deepEqual(
    audit.sendable.map((file) => file.id),
    ['file-api-1', 'att-doc', 'draft-1', 'hist-2'],
    '逐个状态都被判对：serverId / 文档引用 / 本轮新选 / 原件在'
  )
  assert.deepEqual(audit.unavailable, [{ id: 'hist-1', name: 'c.png', reason: 'source-missing' }])
  assert.deepEqual([...audit.unavailableIds], ['hist-1'])
})

test('⑨ 同一个附件出现在提问与历史里只判一次（编辑 / 重新生成会这样）', async () => {
  const file = { id: 'hist-9', serverId: null, name: 'e.png', size: 1, isImage: true, mimeType: '' }
  let reads = 0
  const audit = await auditSendableAttachments([file, file], {
    isOwnUpload: () => false,
    hasSource: async () => {
      reads += 1
      return false
    },
  })
  assert.equal(reads, 1, '同一条附件只查一次源（别每处各查一遍）')
  assert.deepEqual(
    audit.unavailable.map((item) => item.id),
    ['hist-9']
  )
  assert.ok(
    new AttachmentUploadError({ id: 'x', name: 'x.png' }, new Error('boom')) instanceof Error
  )
})

test('⑩ base64 渠道（ours）+ 源缺失附件重新生成：修前整条消息一个请求都发不出去，现在照常发出', async () => {
  // base64 渠道的图片要在本地编码内联：修前这里对提问图片取不到原件 → 抛 imageSourceMissing →
  // streamReply 进「上传失败」分支，**一个请求都没发出**（用户在官方式渠道上看到的就是红字）
  setProviderKind('ours')
  try {
    await use(BASE64)
    const beforeChats = chats.length
    const beforeUploads = uploads.length
    regenerateReply(BASE64)
    await awaitIdle(BASE64)
    const session = useChatStore.getState().sessionCache[BASE64]
    const reply = session.messages.filter((message) => message.role === 'assistant').at(-1)
    const question = session.messages.filter((message) => message.role === 'user').at(-1)
    assert.equal(uploads.length, beforeUploads, 'base64 渠道本来就不发上传请求')
    assert.equal(chats.length, beforeChats + 1, '消息必须真的发出去（修前这里是 0）')
    assert.equal(reply.status, 'done')
    assert.equal(reply.error, undefined, '不许落「上传失败」')
    assert.deepEqual(question.unavailable, [
      { id: 'hist-b64-379', name: 'IMG_0001', reason: 'source-missing' },
    ])
    assert.equal(/base64|image/i.test(chats.at(-1).raw), false, '源缺失的图片不许内联进请求体')
  } finally {
    setProviderKind('deepseek')
  }
})

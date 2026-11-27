// [layer: unit | 依赖: 无（纯 Node，零浏览器零真实上游） | 耗时: <3s]
//
// Issue #955（内测 P0）：**含历史附件的会话无法继续发消息**，提示「上传失败」，重试无效。
//
// 与 #379 不是同一件事。#379 修的是「历史附件被当成待上传文件重传一次」；这一单是
// **发送前的附件可用性审计自己抛错**，把整条消息拖死：
//
//   prepareFiles()                        chat/store.ts:2010-2015
//     → auditSendableAttachments(...)     attachments/sendAudit.ts:66
//         → await options.hasSource(id)   sendAudit.ts:82      ← 没有任何 try/catch
//             → (await getStorage()).blobs.get(id)
//
// 只要那次「本机有没有原件」的读**抛错**（IDB `files` 读失败 / SQLite 分块校验失败 /
// `getStorage()` 拒绝：迁移中、引擎 blocked），异常就一路冒到 `prepareFiles` 之外，
// 被 `preparing` 这一档接住（store.ts:2471 / 2483-2485）→ 落成 `kind: 'upload'` 的消息错误
// （store.ts:2795-2803）→ 界面渲染成泛化的「上传失败」（describe.ts:227-228 → i18n
// `uploadFileStatusFailed`）。**它连 #379 的点名提示都绕过了**：只有 `hasSource` 干净地返回
// `undefined` 才会产出 `{reason: 'source-missing'}`（sendAudit.ts:89-92）。
//
// 而「重试无效」是必然的：两次尝试之间没有任何状态变化，`prepareFiles` 原样重跑同一次读。
//
// 判定口径（本文件钉的就是这几条，都不许用「删附件 / 清会话 / 藏提示」换绿）：
//   [A] 审计**永远不许因为「查不到原件」而抛错**：读失败 = 本机这一份读不出来，
//       记成 `source-unreadable`，跳过它，**本轮消息照常发出**（历史附件本来就不进请求）；
//   [B] 底层错误不许被吞：诊断里留一条 warn（带 store/原因），排查时能定位到是哪一层坏了；
//   [C] 消息上点名到底是哪个附件没跟着发（`unavailable`），不是一句泛化的「上传失败」；
//   [D] 再发一轮 / 冷启动（缓存清空、从库里重读）之后仍然能发 —— 不是只有第一次能发；
//   [E] 对照：本轮**新选**的附件读不出来时，仍然是点名报「上传失败」（#548），修复不许把
//       本轮的失败也一起咽掉；历史附件原件**在**的时候也不许多余提示、不许发上传请求。
//
//   node --test tests/unit/attachment-history-send-955.test.mjs
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

const SESSION_ID = 'hist-955'
/** 历史附件：服务端判过失效、`serverId` 已被清成 null（`reuploadInvalidatedFiles` 的产物） */
const HISTORY_FILE_ID = 'hist-doc-955'
const HISTORY_FILE_NAME = '季度报告.pdf'

/**
 * 现场状态：这条附件曾经有 file_id，服务端回 400 判失效后
 * `chat/store.ts:2176-2207` 把会话里的 `serverId` 清成 null —— 从此每一轮发送都要过审计的
 * 「本机有没有原件」这一读。原件本身在不在，取决于设备上那个后端有没有坏。
 */
const historySession = () => ({
  id: SESSION_ID,
  title: '带附件的老会话',
  createdAt: Date.parse('2026-11-20T10:00:00Z'),
  updatedAt: Date.parse('2026-11-20T10:05:00Z'),
  rootMessageId: 'hu1',
  messages: [
    {
      id: 'hu1',
      role: 'user',
      content: '帮我看看这份报告',
      createdAt: Date.parse('2026-11-20T10:00:00Z'),
      selectedChildId: 'ha1',
      files: [
        {
          id: HISTORY_FILE_ID,
          serverId: null,
          name: HISTORY_FILE_NAME,
          size: 4096,
          isImage: false,
          mimeType: 'application/pdf',
        },
      ],
    },
    {
      id: 'ha1',
      role: 'assistant',
      createdAt: Date.parse('2026-11-20T10:00:20Z'),
      model: null,
      thinking: false,
      search: false,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: '这份报告一共三章。' }],
    },
  ],
})

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x00, 0xff])

/** 原件读取的现场：`ok` = 读得到；`throw` = 后端读失败（本单的触发条件）；`missing` = 没有原件 */
let sourceMode = 'throw'
/** 读失败时的原始错误：模拟存储层的完整性错误（IDB / SQLite 各自的读失败形态） */
const storageFailure = () => {
  const error = new Error('blob_chunks 缺块：期望 1 块，读到 0 块')
  error.name = 'StorageUnavailableError'
  return error
}

installChatHostStubs({
  sessions: [historySession()],
  loadFile: (id) => {
    if (id !== HISTORY_FILE_ID) {
      return undefined
    }
    if (sourceMode === 'throw') {
      throw storageFailure()
    }
    if (sourceMode === 'missing') {
      return undefined
    }
    return new Blob([PDF_BYTES], { type: 'application/pdf' })
  },
})

const { setApiKey } = await import('../../src/services/api/apiConfig.ts')
const { setDraftText } = await import('../../src/services/chat/drafts.ts')
const { useUploads } = await import('../../src/services/attachments.ts')
const { auditSendableAttachments } = await import('../../src/services/attachments/sendAudit.ts')
const store = await import('../../src/services/chat/store.ts')
const { useChatStore, initChat, selectSession, sendMessage } = store

const realSetTimeout = globalThis.setTimeout
const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

const encoder = new TextEncoder()
const ANSWER = '收到，我们接着聊。'

/** deepseek（Anthropic 协议）的 SSE：少一个事件都拿不到正文 */
const anthropicStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        send({
          type: 'message_start',
          message: {
            id: 'msg-955',
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

const uploads = []
const chats = []

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('/files')) {
    uploads.push({ url: target, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ id: 'file-api-955', object: 'file' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const raw = typeof init?.body === 'string' ? init.body : ''
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  if (body?.max_tokens !== undefined) {
    return anthropicStream('会话标题')()
  }
  chats.push({ url: target, raw, body })
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
  throw new Error(`会话 ${sessionId} 没有加载进来，测试无法继续`)
}

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

/** 发一条纯文字消息，等收尾，返回 { reply, userMessage } */
const send = async (sessionId, text) => {
  setDraftText(sessionId, text)
  assert.equal(sendMessage(sessionId), true, `「${text}」应能发出去`)
  await awaitIdle(sessionId)
  const session = useChatStore.getState().sessionCache[sessionId]
  const reply = session.messages.filter((message) => message.role === 'assistant').at(-1)
  const userMessage = session.messages.filter((message) => message.role === 'user').at(-1)
  return { reply, userMessage }
}

const replyText = (reply) => reply.blocks.map((block) => block.text ?? '').join('')
const logRecords = (message) => globalThis.__log.records.filter((entry) => entry.message === message)

/**
 * [E] 纯函数契约（先钉在最小单位上，跑起来最快）：
 * `hasSource` 抛错时审计**不许**随之拒绝 —— 它是一次「能不能带」的判定，不是一次必须成功的读。
 */
test('A 审计：hasSource 抛错 → 不抛出、该附件进 unavailable 且带原因', async () => {
  const audit = await auditSendableAttachments(
    [{ id: 'hist-x', serverId: null, name: 'x.pdf', size: 1, isImage: false, mimeType: 'application/pdf' }],
    {
      isOwnUpload: () => false,
      hasSource: async () => {
        throw storageFailure()
      },
    }
  )
  assert.equal(audit.unavailableIds.has('hist-x'), true, '读失败的历史附件不许算「可发送」')
  assert.equal(audit.unavailable.length, 1)
  assert.equal(audit.unavailable[0].reason, 'source-unreadable', '读失败要说成「读取失败」，不是「没有原件」')
  assert.deepEqual(audit.sendable, [], '它不该进本轮请求')
})

test('B 审计：本轮新选的附件根本不查原件（#548 的点名报错留在上传环节）', async () => {
  let asked = 0
  const audit = await auditSendableAttachments(
    [{ id: 'fresh-x', serverId: null, name: 'x.png', size: 1, isImage: true, mimeType: 'image/png' }],
    {
      isOwnUpload: () => true,
      hasSource: async () => {
        asked += 1
        return false
      },
    }
  )
  assert.equal(asked, 0, '本轮刚选的附件不该去查本机原件（原件可能还没落盘）')
  assert.equal(audit.sendable.length, 1)
  assert.equal(audit.unavailable.length, 0)
})

test('① 历史附件原件读不出来：纯文字消息照常发出（修复前这里是「上传失败」）', async () => {
  await initChat()
  setApiKey('sk-test-955')
  selectSession(SESSION_ID)
  await awaitLoaded(SESSION_ID)

  sourceMode = 'throw'
  uploads.length = 0
  chats.length = 0
  const { reply, userMessage } = await send(SESSION_ID, '继续')

  assert.equal(
    reply.status,
    'done',
    `消息必须发出去（实际 status=${reply.status}，错误 = ${JSON.stringify(reply.error ?? null)}）`
  )
  assert.equal(reply.error, undefined, '这条消息不该因为历史附件读不出来而带错误（界面就会渲染「上传失败」）')
  assert.equal(replyText(reply), ANSWER)
  assert.equal(chats.length >= 1, true, '这一轮必须真的发过问答请求')

  // [C] 点名：这条消息上要写清哪个附件没跟着发、为什么
  assert.equal(userMessage.content, '继续', '用户发的文字原样保留')
  assert.equal(Array.isArray(userMessage.unavailable), true, '不可用的历史附件要落到消息上（不是 toast）')
  assert.equal(userMessage.unavailable.length, 1)
  assert.equal(userMessage.unavailable[0].id, HISTORY_FILE_ID)
  assert.equal(userMessage.unavailable[0].name, HISTORY_FILE_NAME)
  assert.equal(userMessage.unavailable[0].reason, 'source-unreadable')

  // 历史附件仍然挂在原来那条消息上：不许靠删附件换绿
  const first = useChatStore.getState().sessionCache[SESSION_ID].messages.find((item) => item.id === 'hu1')
  assert.equal(first.files.length, 1, '历史附件记录必须还在（不许删历史附件）')
  assert.equal(first.files[0].id, HISTORY_FILE_ID)
})

test('② 底层错误不许被吞：诊断里留下读取失败的原因', () => {
  const records = logRecords('history attachment source unreadable')
  assert.equal(records.length >= 1, true, '读失败要有自己的诊断事件，排查时才知道是存储层坏了')
  assert.equal(records.at(-1).fields.count, 1)
  assert.equal(records.at(-1).fields.reason, 'history')
  // 归因要能落到存储层：错误名 / 原文里带着原始失败（诊断的统一字段，见 `errorMeta`）
  assert.equal(
    records.at(-1).fields['error.name'],
    'StorageUnavailableError',
    `诊断要带原始错误名（实际 ${JSON.stringify(records.at(-1).fields)}）`
  )
  assert.equal(String(records.at(-1).fields['error.msg'] ?? '').includes('缺块'), true)
  assert.deepEqual(logRecords('file upload failed'), [], '读失败不是上传失败，不许记成上传失败')
})

test('③ 再发一轮仍然能发：不是只跳过第一次', async () => {
  uploads.length = 0
  const { reply } = await send(SESSION_ID, '接着说')
  assert.equal(reply.status, 'done')
  assert.equal(replyText(reply), ANSWER)
  assert.deepEqual(uploads.map((item) => item.method), [], '历史附件一个上传请求都不发')
})

test('④ 冷启动（缓存清空、从库里重读）之后继续发新消息仍然成功', async () => {
  // 冷启动 = 进程里没有会话缓存，一切从库里重读（对照 #936 用例的「新进程」口径）
  useChatStore.setState({ sessionCache: {}, streaming: {} })
  await initChat()
  selectSession(SESSION_ID)
  await awaitLoaded(SESSION_ID)
  assert.equal(
    useChatStore.getState().sessionCache[SESSION_ID].messages.length >= 4,
    true,
    '重读后历史消息还在（含附件的那轮）'
  )

  uploads.length = 0
  const { reply, userMessage } = await send(SESSION_ID, '冷启动后继续')
  assert.equal(reply.status, 'done', '冷启动后第一条消息也要发得出去')
  assert.equal(replyText(reply), ANSWER)
  assert.equal(userMessage.unavailable?.length, 1, '重读后审计同样点名，不是只在内存里侥幸通过')
})

test('⑤ 对照：原件读得到时不多余提示、也不发上传请求', async () => {
  sourceMode = 'ok'
  uploads.length = 0
  const { reply, userMessage } = await send(SESSION_ID, '原件在的时候')
  assert.equal(reply.status, 'done')
  assert.equal(userMessage.unavailable, undefined, '原件在就不该有「没跟着发」的提示')
  assert.deepEqual(uploads.map((item) => item.method), [], '历史附件仍然不重传')
})

test('⑥ 对照：原件确实没有时照旧按「本机没有原件」处理（不是所有失败都叫读取失败）', async () => {
  sourceMode = 'missing'
  const { reply, userMessage } = await send(SESSION_ID, '原件没有的时候')
  assert.equal(reply.status, 'done')
  assert.equal(userMessage.unavailable?.length, 1)
  assert.equal(
    userMessage.unavailable[0].reason,
    'source-missing',
    '「没有原件」和「读不出来」要分开：前者是导入会话的常态，后者是本机存储出了问题'
  )
})

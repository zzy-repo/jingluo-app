// [layer: unit | dependencies: node + 内存版 IndexedDB 落点 | 预算: ≤3s]
//
// #528 **L1 链路口径**（Node 版）：上传 → 解析 → 组请求消息 → 注入 → 组装**发往上游的请求体**。
//
// 为什么放在 unit 层跑：这条链全部是纯 Node 可执行的（没有 DOM 参与），用
//  `tests/fixtures/480/memory-attachment-db.mjs` 换掉 IndexedDB **引擎**即可让
//  `attachments/{store,manager}.ts` 的**真代码**跑起来（真 sha256、真缓存键、真状态机、真引用计数）。
// 浏览器里那条「真 UI + 真 IndexedDB + 真网络」的主路径见 `tests/golden/g13-480-doc-attach.test.mjs`。
//
// 覆盖 #528 清单：
//  1. 上传 txt → 解析 → 组请求 → **请求体里文档是纯文本注入**：有 §7 声明与 `<document>` 块，
//     且没有 base64 / 二进制 / `file_id` / `input_file` / `file` 块；
//  2. **三渠道（anthropic / openai / ours）注入结果一致**：同一条注入文本，Anthropic 请求体的
//     message.content 与 OpenAI 兼容请求体的 message.content 逐字节相同；
//  3. **多轮追问第二轮不重复注入**：第二轮请求里文档块只出现一次（在它所属的那一轮里）；
//  4. **取消解析 → partial + warning**（PDF 的取消粒度是「页」）；
//  5. **`commitStaging()` 清原件后的降级**（#531）：落 `failed: source-missing`，不抛、不崩，
//     已解析的正文仍在缓存里可读；
//  6. **`reply.ts:390` 的已知缺口**：只有附件、没有文字的历史轮**仍被整轮丢弃** —— 本文件把它钉成
//     可观测的现状（缺口另开 issue 登记，不在本单修）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '../fixtures/480')

const dbStub = new URL('../fixtures/480/memory-attachment-db.mjs', import.meta.url).href
const pdfLoaderStub = new URL('../fixtures/480/pdfjs-node-loader.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = String(context.parentURL ?? '')
    // 附件存储的 IndexedDB 落点（引擎替身；store/manager 是真代码）
    if (specifier === '../chat/db.js' && /\/attachments\/(store|manager)\.ts$/.test(parent)) {
      return { url: dbStub, shortCircuit: true }
    }
    // pdfjs 的浏览器加载口（只换加载方式，pdfjs 本身是真的）
    if (specifier === './pdfLoader.js' || specifier.endsWith('/pdfLoader.js')) {
      return { url: pdfLoaderStub, shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const db = await import('../fixtures/480/memory-attachment-db.mjs')
const { addAttachmentFile, parseAttachment, getText } = await import(
  '../../src/services/attachments/manager.ts'
)
const { buildWithDocuments } = await import('../../src/services/attachments/contextBuilder.ts')
const { collectAttachmentsForRequest } = await import(
  '../../src/services/attachments/requestDocs.ts'
)
const { toRequestMessages } = await import('../../src/services/chat/reply.ts')
const { buildMessageBody, SYSTEM_PROMPT } = await import('../../src/services/chat/requestBody.ts')
const { toOpenAIRequest } = await import('../../src/services/api/openaiAdapter.ts')
const { PROVIDER_SPECS } = await import('../../src/services/api/providers.ts')
const { DOCUMENT_PREAMBLE } = await import('../../src/services/attachments/inject.ts')

const specOf = (kind) => {
  const spec = PROVIDER_SPECS.find((item) => item.kind === kind)
  assert.ok(spec, `渠道 ${kind} 不存在`)
  return spec
}

/** 夹具 → File（附件上传入口只收 File） */
const fileOf = (relative, mimeType) => {
  const bytes = readFileSync(path.join(FIXTURES, relative))
  return new File([bytes], path.basename(relative), { type: mimeType })
}

/** 本地文档附件引用（#527 契约：`serverId` 恒 null、`isImage` false、id 就是 manager 主键） */
const refOf = (record) => ({
  id: record.id,
  serverId: null,
  name: record.filename,
  size: record.size,
  isImage: false,
  mimeType: record.mimeType,
})

const userMessage = (id, content, files = []) => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: Date.parse(`2026-11-20T10:0${id.length}:00Z`),
})

/** 历史里的回答：`status=done` + 非 refusal 才进上下文（`isUsableReply` 的口径） */
const assistantMessage = (id, text) => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  status: 'done',
  stopReason: 'end_turn',
  createdAt: Date.parse('2026-11-20T10:30:00Z'),
})

/** 走完「一轮请求」：reply.ts 出消息（挂引用）→ contextBuilder 注入 → 请求体 */
const buildRequest = async ({ history = [], question, kind }) => {
  const spec = specOf(kind)
  const messages = toRequestMessages(history, question, undefined, false, undefined, {
    attachmentRefs: true,
  })
  const refs = collectAttachmentsForRequest(messages)
  const injected =
    refs.length === 0
      ? { messages, injected: [], skipped: [], warnings: [] }
      : await buildWithDocuments(messages, [], {})
  const body = buildMessageBody(spec, {
    model: spec.defaultModel ?? 'm',
    system: SYSTEM_PROMPT,
    messages: injected.messages,
    thinking: false,
    search: false,
    title: false,
  })
  return { spec, messages, refs, injected, body }
}

/** 请求体里所有消息内容的纯文本视图（结构断言用它：JSON 里 `<document name=\"…\">` 的引号是转义的） */
const contentTextOf = (body) =>
  body.messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n')
    )
    .join('\n')

/** 请求体里「装着注入块的那条 content」 —— 三渠道的协议形状不同，注入文本本身必须一致 */
const injectedContentOf = (body) => {
  const json = JSON.stringify(body)
  assert.equal(json.includes(DOCUMENT_PREAMBLE), true, '请求体里没有 §7 注入声明')
  const start = json.indexOf(DOCUMENT_PREAMBLE)
  const end = json.lastIndexOf('</document>')
  assert.ok(end > start)
  return json.slice(start, end + '</document>'.length)
}

const upload = async (relative, mimeType) => {
  const record = await addAttachmentFile(fileOf(relative, mimeType))
  const parsed = await parseAttachment(record.id)
  return parsed
}

test('[L1-1] 上传 txt → 解析 → 发消息：请求体里是纯文本注入，没有 base64 / file_id / 二进制', async () => {
  db.__reset()
  const parsed = await upload('enc/utf8.txt', 'text/plain')
  assert.equal(parsed.status, 'success')
  assert.equal(parsed.parsedTextPath, `${parsed.sha256}:txt-1`, '缓存键必须是 sha256:parserVersion')
  assert.equal(await getText(parsed.id), '编码样本 480 验收：第一行文本')

  const { body, injected } = await buildRequest({
    question: userMessage('q1', '请总结这份文档', [refOf(parsed)]),
    kind: 'anthropic',
  })

  assert.deepEqual(injected.injected.map((item) => item.attachmentId), [parsed.id])
  const json = JSON.stringify(body)
  const text = contentTextOf(body)
  // ① 注入的是**纯文本**
  assert.equal(text.includes(DOCUMENT_PREAMBLE), true)
  assert.equal(text.includes('<document name="utf8.txt">'), true)
  assert.equal(text.includes('编码样本 480 验收：第一行文本'), true, '文档正文必须逐字进请求体')
  assert.equal(text.includes('用户问题：请总结这份文档'), true)
  // ② 没有任何「二进制 / 原生文件」痕迹
  for (const forbidden of ['base64', 'file_id', 'input_file', '"type":"document"', '"type":"file"', '"serverId"', '"isImage"', '"attachments"']) {
    assert.equal(json.includes(forbidden), false, `请求体里不该出现 ${forbidden}`)
  }
  // ③ 正文是普通字符串（不是块数组里的 file/document 块）
  const userParam = body.messages[body.messages.length - 1]
  assert.equal(typeof userParam.content, 'string', 'user content 必须是纯文本')
  assert.equal(userParam.content.startsWith(DOCUMENT_PREAMBLE), true)
})

test('[L1-2] 三渠道（anthropic / openai / ours）注入结果逐字节一致', async () => {
  db.__reset()
  const parsed = await upload('enc/utf8.txt', 'text/plain')
  const question = () => userMessage('q1', '请总结这份文档', [refOf(parsed)])

  const anthropic = await buildRequest({ question: question(), kind: 'anthropic' })
  const openai = await buildRequest({ question: question(), kind: 'openai' })
  const ours = await buildRequest({ question: question(), kind: 'ours' })

  const injectedOf = {
    anthropic: injectedContentOf(anthropic.body),
    openai: injectedContentOf(toOpenAIRequest(openai.body, specOf('openai'))),
    ours: injectedContentOf(toOpenAIRequest(ours.body, specOf('ours'))),
  }
  assert.equal(
    injectedOf.openai,
    injectedOf.anthropic,
    'OpenAI 渠道的注入文本必须与 Anthropic 渠道逐字节相同'
  )
  assert.equal(injectedOf.ours, injectedOf.anthropic, 'ours 渠道同上')
  // 三个渠道的 OpenAIChatRequest 里，装着注入块的 user 消息内容也一致
  const openaiWire = toOpenAIRequest(openai.body, specOf('openai'))
  const oursWire = toOpenAIRequest(ours.body, specOf('ours'))
  const userText = (wire) => wire.messages.filter((message) => message.role === 'user').pop().content
  assert.equal(userText(openaiWire), userText(oursWire))
  assert.equal(userText(openaiWire).includes('<document name="utf8.txt">'), true)
})

test('[L1-3] 多轮追问：第二轮请求里同一附件只注入一次（老消息逐字节不变）', async () => {
  db.__reset()
  const parsed = await upload('enc/utf8.txt', 'text/plain')
  const round1Question = userMessage('q1', '请总结这份文档', [refOf(parsed)])
  const round1 = await buildRequest({ question: round1Question, kind: 'anthropic' })

  const history = [
    userMessage('q1', '请总结这份文档', [refOf(parsed)]),
    assistantMessage('a1', '这份文档讲的是编码验收样本。'),
  ]
  const round2 = await buildRequest({
    history,
    question: userMessage('q2', '再展开说说第二条'),
    kind: 'anthropic',
  })

  // 纪律：每轮都用**未注入的 base** 重建（见 contextBuilder 文件头），所以历史轮的附件会照旧注入 ——
  // 关键是「一次请求里只出现一份」，而不是「第二轮不再注入」。
  assert.equal(round2.injected.injected.length, 1, '历史轮的附件照旧注入（同一条消息、同一位置）')
  assert.deepEqual(round2.refs.map((ref) => ref.attachmentId), [parsed.id], '第二轮提问本身没有附件，引用来自历史轮')
  const text2 = contentTextOf(round2.body)
  assert.equal(
    text2.split('<document name="utf8.txt">').length - 1,
    1,
    `文档块在第二轮请求里出现了多次：${text2.slice(0, 400)}`
  )
  assert.equal(text2.split(DOCUMENT_PREAMBLE).length - 1, 1, '注入声明也只能出现一次')
  // 前缀稳定：第一轮那条 user 消息在第二轮里逐字节不变
  assert.equal(
    JSON.stringify(round2.body.messages[0]),
    JSON.stringify(round1.body.messages[0]),
    '老消息（含注入块）必须逐字节相同，否则上游缓存全失效'
  )
})

test('[L1-4] 取消解析 PDF（第 2 页前 abort）→ status=partial + 「已取消」warning', async () => {
  db.__reset()
  const record = await addAttachmentFile(fileOf('pdf/text-layer.pdf', 'application/pdf'))
  const controller = new AbortController()
  const parsed = await parseAttachment(record.id, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.page === 1) {
        controller.abort()
      }
    },
  })
  assert.equal(parsed.status, 'partial', '取消不是失败，也不能算成功')
  assert.equal(parsed.extractedPages, 1)
  assert.equal(parsed.totalPages, 2)
  assert.ok(
    parsed.warnings.some((warning) => warning === '已取消'),
    `取消必须留在 warnings 里：${JSON.stringify(parsed.warnings)}`
  )
  // partial 的正文仍然可用（第一页已经取到），注入侧会带一条 partial 说明
  const { injected } = await buildRequest({
    question: userMessage('q1', '看看这份 PDF', [refOf(parsed)]),
    kind: 'anthropic',
  })
  assert.equal(injected.injected.length, 1)
  assert.ok(
    injected.warnings.some((warning) => warning.includes('只解析出一部分内容')),
    `partial 必须显式告知：${JSON.stringify(injected.warnings)}`
  )
})

test('[L1-5] commitStaging() 清原件（#531）→ 降级不崩：failed: source-missing，缓存正文仍可读', async () => {
  db.__reset()
  const parsed = await upload('enc/utf8.txt', 'text/plain')
  // 整包导入的 commitStaging() 会 files.clear()：原件没了，解析全文还在 attachmentTexts
  db.__clearFiles()
  assert.equal(await getText(parsed.id), '编码样本 480 验收：第一行文本', '正文在缓存里，原件没了也能读')

  // 另一份**没解析过**的文件（同内容会命中 `sha256:parserVersion` 缓存，压根不读原件）
  const second = await addAttachmentFile(fileOf('enc/gbk.txt', 'text/plain'))
  db.__clearFiles()
  const failed = await parseAttachment(second.id)
  assert.equal(failed.status, 'failed', '原件丢了必须落 failed，不许假装成功')
  assert.equal(
    failed.errorMessage,
    'source-missing: attachment source is no longer in local storage'
  )
  assert.equal(await getText(second.id), undefined)
  // 降级：注入侧把它记成 parse_failed + warning，提问照发（不崩、不阻塞）
  const { injected, body } = await buildRequest({
    question: userMessage('q1', '还能总结吗', [refOf(failed)]),
    kind: 'anthropic',
  })
  assert.equal(injected.injected.length, 0)
  assert.deepEqual(injected.skipped.map((item) => item.reason), ['parse_failed'])
  assert.ok(
    injected.warnings.some((warning) => warning.includes('解析失败')),
    `未注入必须显式告知：${JSON.stringify(injected.warnings)}`
  )
  assert.equal(JSON.stringify(body).includes('还能总结吗'), true, '提问本身必须照发')
})

test('[L1-6] 只有附件没有文字的历史轮：文本注入渠道**保留**并注入（DeepSeek 路径仍整轮省略）', async () => {
  db.__reset()
  const parsed = await upload('enc/utf8.txt', 'text/plain')

  // 真实形状：第一轮只上传了文档、没打字（content 为空串），回答正常。
  // 这条曾是被 `reply.ts` 轮次过滤整轮丢掉的缺口（`toFileBlocks()` 对文档附件恒空），
  // 基线 `d18edb6`「纯文档轮不许整轮丢」已修；本用例钉住**修好后的行为**，
  // 负向验证里用「改回旧过滤」证明它真的会红（见 tests/tools/negative-verify-480.mjs 的 M13）。
  const attachmentOnlyRound = userMessage('q1', '', [refOf(parsed)])
  const history = [attachmentOnlyRound, assistantMessage('a1', '已收到你的文档。')]

  const messages = toRequestMessages(
    history,
    userMessage('q2', '继续讲讲这份文档'),
    undefined,
    false,
    undefined,
    { attachmentRefs: true }
  )
  // ① 这一轮被保留了，而且挂在它自己那条消息上（不是并到本轮提问）
  assert.equal(messages.filter((message) => message.role === 'user').length, 2, '纯文档历史轮不许消失')
  assert.deepEqual(collectAttachmentsForRequest(messages).map((ref) => ref.attachmentId), [parsed.id])
  // ② 空正文被占位说明填上（纯函数，同轮永远同字节；避免上游收到空 user 消息）
  assert.equal(String(messages[0].content), '[用户上传了 1 个附件]')

  const injected = await buildWithDocuments(messages, [], {})
  assert.equal(injected.injected.length, 1)
  const firstContent = String(injected.messages[0].content)
  assert.ok(firstContent.startsWith(DOCUMENT_PREAMBLE), '注入段在它所属消息的最前面')
  assert.ok(firstContent.includes('<document name="utf8.txt">'), '文档块进的是历史轮自己的消息')
  assert.ok(firstContent.includes('编码样本 480 验收：第一行文本'))
  assert.equal(
    String(injected.messages[injected.messages.length - 1].content),
    '继续讲讲这份文档',
    '本轮提问不该被并进上一轮的文档块'
  )

  // ③ DeepSeek 原生路径：这些文档没有 file_id，保留下来只会多一条空 user 消息（400 风险），
  //    所以那边的行为一个字不变 —— 整轮仍然省略
  const deepseekMessages = toRequestMessages(
    history,
    userMessage('q2', '继续讲讲这份文档'),
    undefined,
    false,
    undefined,
    { attachmentRefs: false }
  )
  assert.equal(deepseekMessages.length, 1, 'DeepSeek 路径仍整轮省略纯文档轮')
  assert.equal(JSON.stringify(deepseekMessages).includes('用户上传了'), false, '原生路径不该出现占位说明')
  assert.equal(JSON.stringify(deepseekMessages).includes('"attachments"'), false)

  // ④ 前缀稳定：尾部多一轮之后，老消息（含占位说明与注入块）逐字节不变
  const nextRound = toRequestMessages(
    [
      attachmentOnlyRound,
      assistantMessage('a1', '已收到你的文档。'),
      userMessage('q2', '继续讲讲这份文档'),
      assistantMessage('a2', '好的。'),
    ],
    userMessage('q3', '再补充一点'),
    undefined,
    false,
    undefined,
    { attachmentRefs: true }
  )
  const nextInjected = await buildWithDocuments(nextRound, [], {})
  assert.equal(
    JSON.stringify(nextInjected.messages[0]),
    JSON.stringify(injected.messages[0]),
    '纯文档轮的消息（占位说明 + 注入块）必须逐字节稳定'
  )
})

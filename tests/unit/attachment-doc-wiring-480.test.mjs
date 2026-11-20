// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #480 集成轮：**请求侧接线**的证据（合并 #530 三渠道注入之后的那一层）。
//
// 这一层要同时证明两件相反方向的事，所以单列一个文件：
//   [绿 1] DeepSeek 官方**零影响**：`attachmentRefs` 不传 / 传 false 时，`toRequestMessages()`
//          的输出与改动前逐字节相同（消息上根本没有 `attachments` 这个键），
//          请求体里仍然是原生 `document` / `image` 文件块，没有任何文档正文被注入；
//   [绿 2] 文本注入渠道：附件引用**挂在它所属的那条 user 消息**上（只挂文档、不挂图片，
//          按 id 去重），被历史裁剪掉的轮次连同引用一起消失（裁剪协同）；
//   [绿 3] 注入落地：`buildWithDocuments()` 出参把 `attachments` 键剥干净、正文进对应消息，
//          拼出来的请求体里就是那段文本（普通 user 文本，不是 file_id / base64）；
//   [绿 4] 降级不阻断：解析失败 / 预算耗尽时不静默、也不拖垮提问 —— 提问完整发出，warnings 有记录；
//   [绿 5] 只传文档、没打字的历史轮**不许整轮丢**（#480 §8 多轮）：文本注入渠道保留它并注入正文，
//          DeepSeek 路径仍按原规则省略（零影响）；
//   [绿 6] 占位说明是纯函数：注入全失败时该轮仍有非空内容（不给上游空 user 消息），
//          且尾部多一轮后老消息逐字节不变（#345 前缀稳定性）。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/attachment-doc-wiring-480.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
    }
    return nextResolve(specifier, context)
  },
})

const { toRequestMessages } = await import('../../src/services/chat/reply.ts')
const { buildMessageBody } = await import('../../src/services/chat/requestBody.ts')
const { PROVIDER_SPECS } = await import('../../src/services/api/providers.ts')
const { buildWithDocuments, DOC_INTRO } = await import(
  '../../src/services/attachments/contextBuilder.ts'
)
const { attachmentRefsOf, collectAttachmentsForRequest } = await import(
  '../../src/services/attachments/requestDocs.ts'
)

/** 一条真实形状的本地附件（`isImage=false` 才是文档） */
const file = (id, name, extra = {}) => ({
  id,
  serverId: `srv-${id}`,
  name,
  size: 1024,
  isImage: false,
  mimeType: 'application/pdf',
  ...extra,
})
const imageFile = (id) => file(id, 'figure.png', { isImage: true, mimeType: 'image/png' })
/**
 * 真实形态的**文档附件**：`serverId: null`（原件在 AttachmentManager，不走上传）。
 * UI 就是这么存的（drafts.ts::DraftDocument → prepareDraftMessage → files[]），
 * 所以它不会产出 `file_id` 块 —— [绿 5] / [绿 6] 必须用这个而不是上面的 `file()`。
 */
const docFile = (id, name) => ({ ...file(id, name), serverId: null })

const historyUser = (index, files = []) => ({
  id: `u${index}`,
  role: 'user',
  content: `第 ${index} 轮提问`,
  files,
  createdAt: index * 2,
})
const historyReply = (index) => ({
  id: `a${index}`,
  role: 'assistant',
  createdAt: index * 2 + 1,
  model: null,
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text: `第 ${index} 轮回答`, citations: [] }],
})

const spec = (kind) => {
  const found = PROVIDER_SPECS.find((item) => item.kind === kind)
  assert.ok(found, `找不到渠道 ${kind}`)
  return found
}

/** 递归找 `attachments` 键：DeepSeek 路径上一个都不许出现 */
const hasAttachmentsKey = (value) => {
  if (Array.isArray(value)) return value.some(hasAttachmentsKey)
  if (!value || typeof value !== 'object') return false
  if (Object.hasOwn(value, 'attachments')) return true
  return Object.values(value).some(hasAttachmentsKey)
}

// ============ [绿 1] DeepSeek 零影响 ============

test('[绿 1] DeepSeek：attachmentRefs 不传 / false 与改动前逐字节相同，且没有任何 attachments 键', () => {
  const history = [
    historyUser(0, [file('doc-a', '报告.pdf')]),
    historyReply(0),
    historyUser(1, [imageFile('img-b'), file('doc-c', '附录.docx')]),
    historyReply(1),
  ]
  const question = historyUser(2, [file('doc-d', '说明书.pdf')])

  // 改动前的调用形态：只带 anchorKey，没有 attachmentRefs
  const before = toRequestMessages(history, question, undefined, false, '快照', {
    anchorKey: 'session-deepseek',
  })
  // 接线后的调用形态：store.ts 给文本注入渠道传 true，DeepSeek 传的仍是 false
  const after = toRequestMessages(history, question, undefined, false, '快照', {
    anchorKey: 'session-deepseek',
    attachmentRefs: false,
  })
  const withoutOption = toRequestMessages(history, question, undefined, false, '快照', {
    anchorKey: 'session-deepseek',
    attachmentRefs: undefined,
  })

  assert.equal(JSON.stringify(after), JSON.stringify(before), '传 false 必须与改动前逐字节相同')
  assert.equal(JSON.stringify(withoutOption), JSON.stringify(before), '不传也必须逐字节相同')
  assert.equal(hasAttachmentsKey(after), false, 'DeepSeek 路径上不许出现 attachments 键')

  // 原生文件块照旧：文档 → document 块，图片 → image 块，全部按 serverId 引用（正文不上行）
  const body = buildMessageBody(spec('deepseek'), {
    model: 'deepseek-flash',
    system: '该助手为DeepSeek，由深度求索公司创造。',
    messages: after,
    thinking: false,
    search: false,
    title: false,
  })
  const json = JSON.stringify(body)
  assert.equal(hasAttachmentsKey(body), false, '请求体里不许出现 attachments 键')
  assert.equal(json.includes('<document name='), false, 'DeepSeek 路径不许有文本注入')
  assert.equal(json.includes(DOC_INTRO), false, 'DeepSeek 路径不许带注入声明')
  assert.ok(json.includes('"file_id":"srv-doc-d"'), '原生文件块必须照旧带 file_id')
})

// ============ [绿 2] 引用挂在所属消息上 ============

test('[绿 2] 文本注入渠道：引用只挂文档、按 id 去重，裁剪掉的轮次不带引用', () => {
  const history = [
    historyUser(0, [file('doc-old', '很旧的附件.pdf')]),
    historyReply(0),
    historyUser(1, [file('doc-keep', '留着的附件.docx'), imageFile('img-x')]),
    historyReply(1),
  ]
  const question = historyUser(2, [file('doc-keep', '留着的附件.docx'), file('doc-new', '本轮.pdf')])

  const messages = toRequestMessages(history, question, undefined, false, undefined, {
    anchorKey: 'session-inject',
    attachmentRefs: true,
    budget: { maxRounds: 1 },
  })

  // 裁剪只保留最近一轮历史 + 本轮提问：老轮次的引用随着消息一起消失
  assert.equal(messages.some((message) => JSON.stringify(message).includes('doc-old')), false)
  const refs = collectAttachmentsForRequest(messages)
  assert.deepEqual(
    refs.map((ref) => ref.attachmentId),
    ['doc-keep', 'doc-new'],
    '同一附件在多条消息上重复出现时只收集一次，且保持请求顺序'
  )

  // 图片不进文档注入（走渠道自己的视觉能力）
  const userWithImage = messages.find(
    (message) => message.role === 'user' && JSON.stringify(message).includes('srv-img-x')
  )
  if (userWithImage) {
    assert.equal(
      (userWithImage.attachments ?? []).some((ref) => ref.attachmentId === 'img-x'),
      false,
      '图片不许挂成文档引用'
    )
  }

  // 引用挂在**它所属的那条** user 消息上（不是全堆到最后一条）
  const owners = messages
    .filter((message) => message.role === 'user' && message.attachments?.length)
    .map((message) => message.attachments.map((ref) => ref.attachmentId))
  assert.deepEqual(owners, [['doc-keep'], ['doc-keep', 'doc-new']])
})

test('[绿 2-补] attachmentRefsOf：非图片、有 id、按 id 去重', () => {
  const refs = attachmentRefsOf([
    file('a', 'a.pdf'),
    imageFile('img'),
    file('a', 'a-重复.pdf'),
    { ...file('b', 'b.txt'), id: '' },
    file('c', 'c.txt'),
  ])
  assert.deepEqual(
    refs.map((ref) => ref.attachmentId),
    ['a', 'c']
  )
})

// ============ [绿 3] 注入落地 ============

test('[绿 3] 注入后：正文进对应消息、attachments 键剥干净、请求体里没有 file_id 正文', async () => {
  const source = {
    getText: async (id) => ({ 'doc-a': '第一章 总则\n第二章 细则', 'doc-b': '附录正文' })[id],
    getMeta: async (id) => ({
      filename: { 'doc-a': '报告.pdf', 'doc-b': '附录.docx' }[id],
      sha256: `sha-${id}`,
      status: 'success',
    }),
  }
  const base = [
    { ...historyUser(0, [file('doc-a', '报告.pdf')]), id: 'u0' },
    { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }] },
    {
      ...historyUser(1, [file('doc-b', '附录.docx')]),
      id: 'u1',
    },
  ]
  // 模拟 reply.ts 的产出：引用挂在消息上
  const withRefs = base.map((message) =>
    message.role === 'user'
      ? { ...message, attachments: attachmentRefsOf(message.files ?? []) }
      : message
  )
  assert.deepEqual(
    collectAttachmentsForRequest(withRefs).map((ref) => ref.attachmentId),
    ['doc-a', 'doc-b']
  )

  const result = await buildWithDocuments(withRefs, [], { source })
  assert.equal(result.injected.length, 2)
  assert.equal(result.skipped.length, 0)
  assert.equal(hasAttachmentsKey(result.messages), false, '出参必须剥掉 attachments 键')

  // 请求体里看到的必须是普通 user 文本（不是 file_id / base64）
  const body = buildMessageBody(spec('openai'), {
    model: 'gpt-x',
    system: 'sys',
    messages: result.messages,
    thinking: false,
    search: false,
    title: false,
  })
  const bodyText = JSON.stringify(body)
  assert.equal(bodyText.includes(DOC_INTRO), true, '注入声明必须在请求体里')
  assert.equal(bodyText.includes('srv-doc-a'), false, '文本注入渠道不走 file_id')
  assert.equal(bodyText.includes('base64'), false, '不许把二进制塞进请求体')

  const firstUser = result.messages.find((message) => message.role === 'user')
  const content = String(firstUser.content)
  assert.ok(content.includes('<document name="报告.pdf">'), `块头不对：${content.slice(0, 200)}`)
  assert.ok(content.includes('第一章 总则'), '正文要进注入块')
  assert.ok(content.endsWith('用户问题：第 0 轮提问'), '原始提问要包在「用户问题：」里')
})

// ============ [绿 4] 降级不阻断 ============

test('[绿 4] 解析失败 / 预算耗尽：提问照发，warnings 有记录（不静默）', async () => {
  const source = {
    getText: async (id) => (id === 'big' ? '很长的正文'.repeat(4000) : '正常正文'),
    getMeta: async (id) => ({
      filename: { failed: '坏.pdf', big: '大.txt' }[id] ?? `${id}.txt`,
      sha256: `sha-${id}`,
      status: id === 'failed' ? 'failed' : 'success',
      errorMessage: id === 'failed' ? '无文本层' : undefined,
    }),
  }
  const base = [
    { ...historyUser(0, [file('failed', '坏.pdf'), file('big', '大.txt')]), id: 'u0' },
  ]
  const withRefs = base.map((message) => ({
    ...message,
    attachments: attachmentRefsOf(message.files),
  }))

  // 预算压到只够一份：一份解析失败、一份超预算 —— 两种降级都要说出来
  const result = await buildWithDocuments(withRefs, [], { source, docBudgetChars: 900 })
  assert.ok(result.warnings.length >= 1, '降级必须有 warnings')
  assert.ok(
    result.skipped.some((item) => item.reason === 'parse_failed'),
    '解析失败要进 skipped'
  )
  // 预算只够一份：大的那份要么被截断注入（带标注），要么整份跳过 —— 两种都不许静默
  const bigTruncated = result.injected.some((item) => item.truncated)
  const bigSkipped = result.skipped.some((item) => item.reason === 'budget_exhausted')
  assert.ok(bigTruncated || bigSkipped, '超预算的大附件必须被截断（带标注）或明确跳过')
  assert.ok(
    bigTruncated
      ? result.messages.some((message) =>
          String(message.content).includes('[内容过长，已截断，剩余')
        )
      : result.warnings.some((warning) => warning.includes('预算')),
    '截断/跳过都要在正文或 warnings 里说清楚'
  )
  // 关键：提问本身完整送达（文档是增强项，不是发送前置条件）
  const questionParam = result.messages[result.messages.length - 1]
  assert.equal(questionParam.role, 'user')
  assert.ok(String(questionParam.content).includes('第 0 轮提问'))
  assert.equal(hasAttachmentsKey(result.messages), false)
})

// ============ [绿 5] 纯文档轮不许整轮丢（#480 §8） ============

test('[绿 5] 只有文档没有文字的历史轮：注入渠道保留并注入，DeepSeek 仍省略', async () => {
  // 第 0 轮：只上传了 PDF、没打字（UI 允许这种发送：prepareDraftMessage 有 documents 就放行）
  const docOnlyRound = { ...historyUser(0, [docFile('att-doc0', '标书.pdf')]), content: '' }
  const history = [docOnlyRound, historyReply(0)]
  const question = historyUser(1, [docFile('att-doc1', '说明.pdf')])

  // --- 文本注入渠道：这一轮必须还在，且它的附件引用进得了注入
  const withInjection = toRequestMessages(history, question, undefined, false, undefined, {
    anchorKey: 'session-doc-only',
    attachmentRefs: true,
  })
  assert.equal(
    withInjection.some((message) => message.role === 'user' && String(message.content) === ''),
    false,
    '不许出现空 content 的 user 消息'
  )
  const refIds = collectAttachmentsForRequest(withInjection).map((ref) => ref.attachmentId)
  assert.deepEqual(refIds, ['att-doc0', 'att-doc1'], '纯文档轮的引用必须进请求')

  // 真注入一次：第 0 轮的正文进到它自己的消息里，而不是并到本轮提问上
  const source = {
    getText: async (id) => (id === 'att-doc0' ? '标书正文' : '说明书正文'),
    getMeta: async (id) => ({ filename: id === 'att-doc0' ? '标书.pdf' : '说明.pdf', status: 'success' }),
  }
  const injected = await buildWithDocuments(withInjection, [], { source })
  assert.equal(injected.injected.length, 2)
  const firstUser = injected.messages.find((message) => message.role === 'user')
  assert.ok(String(firstUser.content).includes('<document name="标书.pdf">'), String(firstUser.content))
  assert.ok(
    String(firstUser.content).includes('用户上传了 1 个附件'),
    '空提问要用占位说明兜住（否则注入失败时就是一条空 user 消息）'
  )

  // --- DeepSeek：同一份历史仍然整轮省略（与改动前逐字节相同），零影响
  const forDeepSeek = toRequestMessages(history, question, undefined, false, undefined, {
    anchorKey: 'session-doc-only',
    attachmentRefs: false,
  })
  assert.equal(JSON.stringify(forDeepSeek).includes('att-doc0'), false, 'DeepSeek 路径不许带文档引用')
  assert.equal(hasAttachmentsKey(forDeepSeek), false)
  assert.equal(
    forDeepSeek.some((message) => message.role === 'user' && String(message.content).includes('用户上传了')),
    false,
    'DeepSeek 路径不许出现占位说明（那是注入渠道的兜底）'
  )
})

test('[绿 6] 注入全失败时该轮仍有非空内容，且老消息逐字节稳定（#345）', async () => {
  const docOnly = (index) => ({
    ...historyUser(index, [docFile(`att-${index}`, `附件${index}.pdf`)]),
    content: '',
  })
  const history = [docOnly(0), historyReply(0), docOnly(1), historyReply(1)]
  const question = historyUser(2)

  const failing = {
    getText: async () => undefined,
    getMeta: async (id) => ({ filename: `${id}.pdf`, status: 'failed', errorMessage: '无文本层' }),
  }
  const turnA = toRequestMessages(history.slice(0, 2), docOnly(1), undefined, false, undefined, {
    anchorKey: 'session-fail',
    attachmentRefs: true,
  })
  const resultA = await buildWithDocuments(turnA, [], { source: failing })
  assert.equal(resultA.injected.length, 0, '全部解析失败 ⇒ 一份都不注入')
  assert.ok(
    resultA.messages.every((message) => String(message.content) !== ''),
    '解析失败也必须留下占位说明，不许出现空 user 消息'
  )
  assert.ok(resultA.warnings.length >= 1, '失败要进 warnings（不静默）')

  // 前缀稳定：尾部多一轮之后，A 轮整段请求逐字节相同
  const turnB = toRequestMessages(
    [...history, historyUser(3), historyReply(3)],
    historyUser(4),
    undefined,
    false,
    undefined,
    { anchorKey: 'session-fail', attachmentRefs: true }
  )
  assert.equal(
    JSON.stringify(turnB.slice(0, turnA.length)),
    JSON.stringify(turnA),
    '占位说明必须是纯函数，否则 #345 的前缀稳定性会被打破'
  )
})

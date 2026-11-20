// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #553（母单 #548 的 vision-4）：三渠道图片（vision）适配的**唯一一次统一验收**。
// 结构基线 = #562 对齐后的 `feat/vision-three-channels`（能力表一张、limits 一份、接线在 #569）。
//
// 本文件钉的是「发出去的那串字节」：
//
//   [1] 三渠道请求体逐字：openai / ours 是 `{type:'image_url', image_url:{url:'data:…'}}`，
//       anthropic 是 `{type:'image', source:{type:'base64', media_type, data}}`，
//       而**文本部分三渠道逐字一致**（只有图片部分的形状不同）；
//   [2] 预处理与边界：阈值内原图一个字节不改、长边超限压到 1568 且出 webp、白名单外明确拒绝、
//       单图 / 张数 / 总量超限**明确拒绝不静默**、多图同消息顺序正确；
//   [3] EXIF 方向（83 档：引擎自己会转，绝不许再手动转一次 → 无 90°/180° 错位）；
//   [4] 上下文：#345 的前缀稳定在带图时仍然成立，历史轮图片每轮重发且字节相同；
//   [5] DeepSeek 零改动：仍然只走 `file_id`，请求体里一个 base64 都不出现，
//       且「不传 vision 选项」这条老调用路径与 deepseek 的产物逐字节相同。
//
// 另一半（79 档「引擎不自动转」→ 手动校正分支）在 `vision-exif-manual-553.test.mjs`：
// `probeAutoOrient()` 的探测结果是**模块级缓存**，一个进程只能探一次，两档必须各占一个进程。
//
// 边界（不在本文件假装覆盖，验收报告里如实列出）：
//   - openai / ours / anthropic 走的是**真 store + 假 fetch**（真组装、真序列化，不发真 HTTP）；
//   - 真实解码 / 压缩率 / 真机内核归真机与集成层，这里只在 DOM 边界上换实现
//     （`tests/helpers/fake-image-dom.mjs`，`FKE1` 栅格，被测逻辑一行不改）；
//   - HEIC 目前**不支持**：本文件断言的是「明确拒绝」，不是「能发」。
//
//   node tests/run-layer.mjs unit --only vision-acceptance-553
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）
// 也不会 `ReferenceError: __ENDPOINTS__ is not defined`。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

// 宿主替身（IndexedDB / 诊断收集器 / Capacitor / 浏览器全局）只在边界上换实现；
// store / reply / requestBody / openaiAdapter / imageSource 全是真代码。
installChatHostStubs()

const fake = await import('../helpers/fake-image-dom.mjs')
// 先载入被测模块（替身复用它的 `sniffImage()`，不重复实现 magic-bytes 判定）
const imageSource = await fake.loadImageSource()
// 83 档：Chrome 81+ / WebView 83 会自动应用 EXIF 方向（见 exif-orientation-findings.md）
const dom = fake.installFakeImageDom({ autoOrient: true })

const capability = await import('../../src/services/attachments/providerCapability.ts')
const { setApiKey, setProviderKind, getCurrentSpec } = await import(
  '../../src/services/api/apiConfig.ts'
)
const drafts = await import('../../src/services/chat/drafts.ts')
const upload = await import('../../src/services/attachments.ts')
const { useChatStore, initChat, sendMessage } = await import('../../src/services/chat/store.ts')

const API_KEY = 'sk-test-553'
const FIXTURES = 'tests/fixtures/vision'
const FIXTURE_QUADRANTS = fake.quadrantColors({
  gridW: 4,
  gridH: 4,
  samples: fake.quadrantGrid(4, 4),
})

const fixtureBytes = (name) => new Uint8Array(readFileSync(`${FIXTURES}/${name}`))
const fileOf = (name, type) => new File([fixtureBytes(name)], name, { type })
const blobOf = (name, type) => new Blob([fixtureBytes(name)], { type })

/** 用例里的「一张图」= 夹具名 + 声明的 MIME（MIME 只用于过草稿层，真判定看 magic bytes） */
const TINY = ['tiny-64x32.png', 'image/png']
const EXIF6 = ['exif-orientation-6.jpg', 'image/jpeg']
const OVERSIZE = ['oversize-6000x4000.jpg', 'image/jpeg']
const HEIC = ['heic-sample.heic', 'image/heic']

// ---------- 上游替身：真 store → 假 fetch（抓原始字符串，逐字断言） ----------

const encoder = new TextEncoder()
const chunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
const realSetTimeout = globalThis.setTimeout

/** Anthropic 协议的 SSE（deepseek / anthropic）：少一个事件都拿不到正文 */
const anthropicStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(chunk(payload)))
        send({
          type: 'message_start',
          message: {
            id: 'msg-553',
            type: 'message',
            role: 'assistant',
            model: 'test-model',
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
          usage: { output_tokens: 8 },
        })
        send({ type: 'message_stop' })
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

/** OpenAI 协议的 SSE（openai / ours）：一段正文 + 收尾 + [DONE] */
const openaiStream = (text) => () =>
  new Response(
    new ReadableStream({
      start(controller) {
        const send = (payload) => controller.enqueue(encoder.encode(chunk(payload)))
        send({ id: 'chatcmpl-553', choices: [{ index: 0, delta: { role: 'assistant' } }] })
        send({ id: 'chatcmpl-553', choices: [{ index: 0, delta: { content: text } }] })
        send({ id: 'chatcmpl-553', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  )

const protocolOf = (kind) => (kind === 'openai' || kind === 'ours' ? 'openai' : 'anthropic')
const useChannel = (kind) => setProviderKind(kind)

/** 每次真实请求的原始记录：**未解析的 JSON 字符串** + 解析结果 */
const requests = []
/** Files API 上传拿到什么 file_id（deepseek 走这条） */
const UPLOADED_ID = 'file-vision-553'

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const raw = typeof init?.body === 'string' ? init.body : ''
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    body = {}
  }
  // #360：只有声明了 paths.files 的渠道才会出现上传请求（deepseek）；这里回一个 file_id
  if (target.includes('/files')) {
    return new Response(JSON.stringify({ id: UPLOADED_ID, object: 'file' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  requests.push({ url: target, raw, body })
  return (protocolOf(getCurrentSpec().kind) === 'openai' ? openaiStream : anthropicStream)(
    '收到，这是一张四象限的测试图。'
  )()
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const awaitIdle = async (sessionId, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!Object.hasOwn(useChatStore.getState().streaming, sessionId)) {
      return
    }
    await delay(2)
  }
  throw new Error('本轮没有收尾，测试无法继续')
}

const draftTaskStatuses = (sessionId) =>
  drafts.getDraft(sessionId).attachments.map((item) => upload.useUploads.getState().tasks[item.id])

/** 等本批附件「可发送」：base64 渠道是 `inline`，file_id 渠道是 `done` */
const awaitAttachmentsReady = async (sessionId, count, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tasks = draftTaskStatuses(sessionId)
    if (
      tasks.length === count &&
      tasks.every((task) => task?.status === 'inline' || task?.status === 'done')
    ) {
      return
    }
    await delay(2)
  }
  throw new Error(`附件没有就绪：${JSON.stringify(draftTaskStatuses(sessionId))}`)
}

/**
 * 发一轮：加附件 → 等就绪 → 发送 → 等收尾，返回这一轮的请求记录与落库的回复。
 * `sessionId` 传 null 表示「新会话」（与用户在输入框里第一次发送等价）。
 */
const sendRound = async ({ kind, sessionId = null, text = '', images = [] }) => {
  useChannel(kind)
  for (const [name, type] of images) {
    const notice = drafts.addDraftFiles(sessionId, [fileOf(name, type)], API_KEY)
    assert.equal(notice, null, `添加 ${name} 不该被拒：${JSON.stringify(notice)}`)
  }
  if (text) {
    drafts.setDraftText(sessionId, text)
  }
  const attachmentIds = drafts.getDraft(sessionId).attachments.map((item) => item.id)
  if (attachmentIds.length > 0) {
    await awaitAttachmentsReady(sessionId, attachmentIds.length)
  }
  const before = requests.length
  assert.equal(sendMessage(sessionId), true, '草稿非空且附件就绪时应能发出')
  const id = useChatStore.getState().activeId
  assert.ok(id, '应存在会话')
  await awaitIdle(id)
  const reply = useChatStore
    .getState()
    .sessionCache[id].messages.filter((message) => message.role === 'assistant')
    .at(-1)
  // 发送成功后草稿会被清空（`clearSentDraft`），附件 id 必须在这里就带出去
  return { sessionId: id, request: requests[before], reply, attachmentIds }
}

/** 最后一轮提问的 content（user 侧） */
const lastUserContent = (body) => body.messages.at(-1).content

/** 内容块数组 → 文本块（按消息顺序）；`content` 是纯字符串时就是它自己 */
const textPartsOf = (content) =>
  typeof content === 'string'
    ? [content]
    : content.filter((block) => block.type === 'text').map((block) => block.text)

/** `data:` URI 里的 base64 是否合法：字符集 + 长度 + 往返一致（不许是截断的一串） */
const assertBase64 = (value, label) => {
  assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/, `${label} 必须是合法 base64：${value.slice(0, 40)}…`)
  assert.equal(value.length % 4, 0, `${label} 的 base64 长度必须是 4 的倍数`)
  const bytes = Buffer.from(value, 'base64')
  assert.ok(bytes.length > 100, `${label} 解码后不该是空串（实得 ${bytes.length} B）`)
  assert.equal(bytes.toString('base64'), value, `${label} 必须能无损往返（截断的 base64 在这里出局）`)
  return bytes
}

/** 请求里最后一轮的图片部分（按协议取形状，便于跨渠道对比） */
const imagePartsOf = (kind, content) => {
  if (protocolOf(kind) !== 'openai') {
    return content.filter((block) => block.type === 'image')
  }
  return content.filter((block) => block.type === 'image_url')
}

/** 全文件只初始化一次会话层（多次 initChat 只会重读同一份 localStorage） */
await initChat()
setApiKey(API_KEY)

const QUESTION = '这张图里有什么？'

// ---------- [1] 三渠道请求体逐字 ----------

const roundOn = async (kind, images = [OVERSIZE]) =>
  sendRound({ kind, text: QUESTION, images })

test('[1] openai：content[] 里是 text + image_url 的 data URI（前缀正确、base64 合法）', async () => {
  const { request } = await roundOn('openai')
  const content = lastUserContent(request.body)
  assert.ok(Array.isArray(content), '有图时 content 必须升级成 part 数组')
  assert.equal(content.length, 2, `文本 + 一张图：${JSON.stringify(content.map((b) => b.type))}`)
  assert.deepEqual(content[0], { type: 'text', text: QUESTION }, '文本在前，且逐字等于提问')
  assert.equal(content[1].type, 'image_url')
  const url = content[1].image_url.url
  assert.ok(
    url.startsWith('data:image/webp;base64,'),
    `openai 渠道必须发 webp 的 data URI（超阈值图会被压成 webp），实际：${url.slice(0, 40)}`
  )
  assertBase64(url.slice('data:image/webp;base64,'.length), 'openai 的 image_url')
  // 形状只允许这两个键：多一个字段某些 OpenAI 兼容上游会直接 400
  assert.deepEqual(Object.keys(content[1]), ['type', 'image_url'])
  assert.deepEqual(Object.keys(content[1].image_url), ['url'])
})

test('[1] ours：与 openai 同一形状（同一个 openaiAdapter 翻译，不改第二遍）', async () => {
  const { request } = await roundOn('ours')
  const content = lastUserContent(request.body)
  assert.deepEqual(content[0], { type: 'text', text: QUESTION })
  assert.equal(content[1].type, 'image_url')
  assert.ok(content[1].image_url.url.startsWith('data:image/webp;base64,'))
  assertBase64(content[1].image_url.url.split(',')[1], 'ours 的 image_url')
  assert.equal(request.url.includes('/v1/chat/completions'), true, 'ours 走 OpenAI 协议端点')
})

test('[1] anthropic：image block = {type:"image", source:{type:"base64", media_type, data}}', async () => {
  const { request } = await roundOn('anthropic')
  const content = lastUserContent(request.body)
  const images = imagePartsOf('anthropic', content)
  assert.equal(images.length, 1, `Anthropic 协议下图片是 image 块：${JSON.stringify(content.map((b) => b.type))}`)
  assert.deepEqual(Object.keys(images[0]), ['type', 'source'], 'Anthropic 的块只有 type / source 两个键')
  assert.equal(images[0].type, 'image')
  assert.deepEqual(Object.keys(images[0].source), ['type', 'media_type', 'data'])
  assert.equal(images[0].source.type, 'base64', '三渠道没有 Files API，只能内联 base64')
  assert.equal(images[0].source.media_type, 'image/webp')
  assertBase64(images[0].source.data, 'anthropic 的 source.data')
  // 反向：Anthropic 协议里不该出现 OpenAI 的字段（否则就是翻译串了）
  assert.equal(request.raw.includes('image_url'), false, 'Anthropic 请求体里不许出现 image_url')
})

test('[1] 三渠道文本部分逐字一致：只有图片部分的形状不同', async () => {
  const results = {}
  for (const kind of ['anthropic', 'openai', 'ours']) {
    results[kind] = (await roundOn(kind)).request
  }
  /**
   * 会话文本部分：**去掉协议级的 system 行**再比 —— OpenAI 协议把 system 表达成 messages[0]，
   * Anthropic 协议把它放在顶层 `system` 字段，那是协议形状差异，不是文本差异（下面单独比 system 字段）。
   */
  const textOf = (kind) =>
    results[kind].body.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, text: textPartsOf(message.content) }))
  // 同一个提问 + 同一张图 → 三条请求的消息条数、角色、文本逐字相同
  assert.deepEqual(textOf('openai'), textOf('ours'), 'openai 与 ours 的文本部分必须逐字相同')
  assert.deepEqual(textOf('anthropic'), textOf('openai'), 'anthropic 的文本部分也必须逐字相同')
  /**
   * system 也逐字相同，只是**表达位置不同**：
   * Anthropic 协议放顶层 `system` 字段，OpenAI 协议由适配层搬成 `messages[0]`（`role:'system'`），
   * 所以 OpenAI 侧的 body 里没有顶层 system —— 这不是文本差异。
   */
  const systemOf = (kind) =>
    protocolOf(kind) === 'openai' ? results[kind].body.messages[0].content : results[kind].body.system
  assert.equal(results.openai.body.messages[0].role, 'system', 'OpenAI 侧第一条是 system 行')
  assert.equal(results.openai.body.system, undefined, 'OpenAI 侧 system 只在 messages[0]，不重复下发')
  const systems = { anthropic: systemOf('anthropic'), openai: systemOf('openai'), ours: systemOf('ours') }
  assert.equal(systems.anthropic, systems.openai, `system 必须逐字相同：${JSON.stringify(systems)}`)
  assert.equal(systems.openai, systems.ours, `system 必须逐字相同：${JSON.stringify(systems)}`)
  assert.ok(systems.anthropic.length > 0, 'system 不该是空的（空说明这条断言什么也没比）')
  // 图片部分：三渠道都有且只有一处
  for (const kind of ['anthropic', 'openai', 'ours']) {
    assert.equal(
      imagePartsOf(kind, lastUserContent(results[kind].body)).length,
      1,
      `${kind} 的图片块数量`
    )
  }
  // 文本相同、形状不同：这四条把「只有图片部分形状不同」钉死
  const images = lastUserContent(results.openai.body)[1]
  const anthropicImage = imagePartsOf('anthropic', lastUserContent(results.anthropic.body))[0]
  assert.equal(anthropicImage.source.data, images.image_url.url.split(',')[1], '三渠道发出的是**同一份字节**')
  assert.equal(anthropicImage.source.media_type, 'image/webp')
  // openai 侧没有 base64 分字段、（协议级）也没有 image 块
  assert.equal(lastUserContent(results.openai.body).some((b) => b.type === 'image'), false)
})

// ---------- [2] 预处理与边界 ----------

test('[2] 阈值内（64×32 png）：原图直发，字节一个不改', async () => {
  const before = dom.statistics()
  const part = await imageSource.toImagePart(blobOf(...TINY))
  assert.equal(part.mediaType, 'image/png', '没超过阈值的图不许被重编码（EXIF / 动图帧 / 色深都要保真）')
  assert.deepEqual([part.width, part.height], [64, 32])
  assert.equal(
    Buffer.from(part.base64, 'base64').toString('hex'),
    Buffer.from(fixtureBytes(...TINY)).toString('hex'),
    '直发分支必须把原件原样 base64，一个字节都不许变'
  )
  assert.equal(dom.statistics().toBlobs, before.toBlobs, '直发分支不该碰 canvas.toBlob')
})

test('[2] 长边超限（6000×4000）：压到长边 1568 并输出 webp', async () => {
  const part = await imageSource.toImagePart(blobOf(...OVERSIZE))
  assert.equal(part.mediaType, 'image/webp', '超阈值统一出 webp（绝不输出 PNG：q1.0 会把截图撑到 2–4MB）')
  assert.equal(part.width, 1568, '长边必须收到 limits.images.maxEdge')
  assert.equal(
    part.height,
    Math.round((4000 * 1568) / 6000),
    `等比缩放：${part.width}×${part.height}`
  )
  // 产物自证：解出来的 SOF 尺寸必须和 part 报的一致（不是「标了 1568 其实没缩」）
  const bytes = Buffer.from(part.base64, 'base64')
  const sniffed = imageSource.sniffImage(new Uint8Array(bytes))
  assert.deepEqual([sniffed.width, sniffed.height], [part.width, part.height])
  const { LIMITS } = await import('../../src/services/limits.ts')
  assert.ok(bytes.length < LIMITS.images.maxEncodedBytes, '产物必须在编码产物上限之内')
  assert.ok(
    sniffed.width !== imageSource.sniffImage(fixtureBytes(...OVERSIZE)).width,
    '产物尺寸必须真的变小，不是只改了标签'
  )
})

test('[2] 单图超限：原图 > 16MB 直接拒绝（不解码），有可读原因', async () => {
  const before = dom.statistics()
  const big = new Uint8Array(17 * 1024 * 1024)
  big.set(fake.pngSkeleton(64, 32), 0)
  const blob = new Blob([big], { type: 'image/png' })
  await assert.rejects(
    () => imageSource.toImagePart(blob),
    (error) => {
      assert.equal(error.name, 'ImageSourceError')
      assert.equal(error.localMessage.key, 'imageTooLarge', '必须给「太大」的可读原因，不许静默丢图')
      assert.equal(error.retryable, false, '换一次重试也不会变小')
      return true
    }
  )
  assert.equal(dom.statistics().decoded, before.decoded, '超硬上限的图必须**不解码**（100MP 的图会先 OOM）')
})

test('[2] 白名单外（heic）：入口就明确拒绝，并给出可读原因', async () => {
  // ① 真判定口：magic bytes 说了算（MIME 与扩展名都可能撒谎）
  await assert.rejects(
    () => imageSource.toImagePart(blobOf(...HEIC)),
    (error) => {
      assert.equal(error.localMessage.key, 'imageUnsupportedFormat')
      assert.equal(error.retryable, false, 'HEIC 重试也没用，要用户换格式')
      return true
    }
  )
  // ② 用户从相册选 `.heic`：草稿层就先拦（更早、更便宜），而且给的是**能照做**的那句
  //    （#580 缺口 2：以前它会先撞扩展名白名单，落到泛化的 uploadUnsupportedFormat ——
  //     既没给「转成 JPEG」这个动作，还顺带说「图片支持」）
  assert.deepEqual(
    drafts.addDraftFiles(null, [fileOf(...HEIC)], API_KEY),
    { key: 'imageUnsupportedFormat', params: { formats: imageSource.IMAGE_FORMAT_LABELS } },
    'HEIC 也是图片：草稿层给「格式不支持 + HEIC 请先转成 JPEG」，不是「暂未支持的文件格式」'
  )
  assert.ok(
    imageSource.IMAGE_FORMAT_LABELS.includes('GIF'),
    '提示语里的格式清单必须从白名单派生（GIF 在白名单里就必须出现，见 #580 缺口 1）'
  )
  // 真渲染一遍：清单填进去了、模板占位符没有漏到界面上
  const { translate } = await import('../../src/i18n/index.ts')
  const rendered = translate('imageUnsupportedFormat', {
    formats: imageSource.IMAGE_FORMAT_LABELS,
  })
  assert.ok(
    rendered.includes('GIF') && rendered.includes('HEIC') && !rendered.includes('{formats}'),
    `文案要既写全白名单、又给出 HEIC 的动作：${rendered}`
  )
  assert.equal(drafts.getDraft(null).attachments.length, 0, '被拒的文件不许留在草稿里')

  // ③ 最要命的一种：文件名 / MIME 都装成 png，字节是 HEIC —— 只有 magic bytes 能抓住它。
  //    这时入口已经放行，必须在**编码**这一步明确失败，并让发送闸不放行（不静默丢图）。
  const disguised = new File([fixtureBytes(...HEIC)], 'photo.png', { type: 'image/png' })
  assert.equal(drafts.addDraftFiles(null, [disguised], API_KEY), null, '伪装成 png 时草图层看不出来')
  const id = drafts.getDraft(null).attachments[0].id
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && upload.useUploads.getState().tasks[id]?.status !== 'error') {
    await delay(2)
  }
  assert.deepEqual(
    upload.useUploads.getState().tasks[id],
    {
      status: 'error',
      // 文案清单从白名单派生（#580 缺口 1）：GIF 也在里面
      error: {
        key: 'imageUnsupportedFormat',
        params: { formats: imageSource.IMAGE_FORMAT_LABELS },
      },
      retryable: false,
    },
    '必须落到「不支持的格式」错误态（卡片上有原因），而不是悄悄当成 png 发出去'
  )
  assert.equal(
    drafts.prepareDraftMessage(drafts.getDraft(null), upload.useUploads.getState().tasks),
    null,
    '编码失败的图片不许被静默丢掉后照发文字（母单 #548）'
  )
  drafts.clearDraft(null)
})

test('[2] 张数超限（maxCount + 1）：明确拒绝，一个请求都不发', async () => {
  useChannel('openai')
  const { LIMITS } = await import('../../src/services/limits.ts')
  const count = LIMITS.images.maxCount
  const files = Array.from(
    { length: count + 1 },
    (_, index) => new File([fixtureBytes(...TINY)], `tiny-${index}.png`, { type: 'image/png' })
  )
  const notice = drafts.addDraftFiles(null, files, API_KEY)
  assert.equal(notice, null, '草稿层先收下（张数闸归发送前的准备阶段）')
  await awaitAttachmentsReady(null, files.length)
  const before = requests.length
  assert.equal(sendMessage(null), true)
  const id = useChatStore.getState().activeId
  await awaitIdle(id)
  const reply = useChatStore
    .getState()
    .sessionCache[id].messages.filter((message) => message.role === 'assistant')
    .at(-1)
  assert.equal(reply.status, 'error')
  assert.deepEqual(
    reply.error?.localMessage,
    { key: 'imageTooMany', params: { count } },
    '超出张数必须明确拒绝（母单 #548：不许静默丢图）'
  )
  assert.equal(requests.length, before, '被拒绝的轮次不许真的发出请求')
  drafts.clearDraft(null)
})

test('[2] 总量超限（> 20MB）：明确拒绝，一个请求都不发', async () => {
  useChannel('openai')
  const { LIMITS, mbOf } = await import('../../src/services/limits.ts')
  const perImage = 4 * 1024 * 1024
  const count = Math.floor(LIMITS.images.maxTotalBytes / perImage) + 1
  assert.ok(count <= LIMITS.images.maxCount, '这条用例要撞的是总量闸，不是张数闸')
  // 每张都真的能编码（小 png），超限发生在**逐张累加之后**的总量闸上
  assert.equal(
    drafts.addDraftFiles(
      null,
      Array.from(
        { length: count },
        (_, index) => new File([fixtureBytes(...TINY)], `bulk-${index}.png`, { type: 'image/png' })
      ),
      API_KEY
    ),
    null
  )
  const ids = drafts.getDraft(null).attachments.map((item) => item.id)
  // 先等真编码落定（它会写缓存），再按同一份缓存接口把每张换成 4MB 的产物 ——
  // 这条用例要撞的是**总量闸**，不是编码速度。
  await awaitAttachmentsReady(null, ids.length)
  for (const id of ids) {
    imageSource.putImagePart(id, {
      mediaType: 'image/webp',
      base64: Buffer.alloc(perImage).toString('base64'),
    })
  }
  const before = requests.length
  assert.equal(sendMessage(null), true)
  const id = useChatStore.getState().activeId
  await awaitIdle(id)
  const reply = useChatStore
    .getState()
    .sessionCache[id].messages.filter((message) => message.role === 'assistant')
    .at(-1)
  assert.equal(reply.status, 'error')
  assert.deepEqual(reply.error?.localMessage, {
    key: 'imageTotalTooLarge',
    params: { size: mbOf(LIMITS.images.maxTotalBytes) },
  })
  assert.equal(requests.length, before, '被拒绝的轮次不许真的发出请求')
  drafts.clearDraft(null)
  for (const id of ids) {
    imageSource.dropImagePart(id)
  }
})

test('[2] 多图同消息：顺序与用户选图顺序一致', async () => {
  const { request, attachmentIds: idsInOrder } = await sendRound({
    kind: 'anthropic',
    text: QUESTION,
    images: [TINY, EXIF6, OVERSIZE],
  })
  assert.equal(idsInOrder.length, 3, '三张图都要进消息')
  // 期望的字节：按选图顺序从缓存里取（同一份 `imagePartOf`，拼请求时用的就是它）
  const expected = idsInOrder.map((id) => imageSource.imagePartOf(id)?.base64)
  const content = lastUserContent(request.body)
  const images = imagePartsOf('anthropic', content)
  assert.equal(images.length, 3, `三张图都要在请求里：${JSON.stringify(content.map((b) => b.type))}`)
  assert.deepEqual(
    images.map((block) => block.source.data),
    expected,
    '图片块必须与选图顺序一一对应（顺序错 = 用户看到 A 说的是 B）'
  )
  // 文本块在图片之后（Anthropic 侧 `toUserParam` 是「先附件后正文」）
  assert.equal(content.at(-1).type, 'text')
  assert.equal(content.at(-1).text, QUESTION)
})

// ---------- [3] EXIF 方向（83 档：引擎自动应用，代码不许再转一次） ----------

test('[3] EXIF Orientation=6：输出方向正确，且只转一次（无 90°/180° 错位）', async () => {
  const stored = imageSource.sniffImage(fixtureBytes(...EXIF6))
  assert.equal(stored.orientation, 6, '夹具本身必须带 Orientation=6')
  assert.deepEqual([stored.width, stored.height], [4000, 3000], '存储态尺寸（竖拍照片存成横的）')
  const before = dom.statistics()
  const part = await imageSource.toImagePart(blobOf(...EXIF6))
  assert.equal(part.mediaType, 'image/webp')
  // 方向 6 = 顺时针 90°：显示态是 3000×4000，长边 4000 → 1568 → 1176×1568
  assert.deepEqual([part.width, part.height], [1176, 1568], '方向 6 必须长宽对调（否则就是没转或转反）')
  const raster = fake.readRaster(new Uint8Array(Buffer.from(part.base64, 'base64')))
  assert.deepEqual(
    fake.quadrantColors(raster),
    fake.uprightQuadrants(6, FIXTURE_QUADRANTS),
    '象限排列必须是「顺时针 90° 一次」的结果：再转一次就是 180° 错位，少转就是 0°'
  )
  // 引擎自己会转（83 档）→ 只允许一次重编码；手动再转一次会多出一趟 canvas
  assert.equal(dom.statistics().toBlobs - before.toBlobs, 1, '83 档只该有一次重编码（手动校正分支才需要第二趟）')
})

// ---------- [4] 上下文：带图时前缀仍稳定，历史图片每轮重发 ----------

/** 请求体里 `messages` 数组的起始偏移：`"messages":[` 之后就是第一条消息 */
const messagesStart = (raw) => {
  const at = raw.indexOf('"messages":[')
  assert.ok(at > 0, '请求体里必须能找到 messages 数组（协议变了要改这个用例）')
  return at + '"messages":['.length
}

/** 前缀的字节边界：`messages` 之前的所有字段 + 除最后一条以外的全部消息（= 上游前缀缓存能命中的长度） */
const prefixCut = (item) => {
  const lead = item.body.messages.slice(0, -1)
  return (
    messagesStart(item.raw) +
    lead.reduce((sum, message) => sum + JSON.stringify(message).length + 1, 0)
  )
}

test('[4] 前缀稳定：第 2 轮请求是第 3 轮的逐字节前缀（带图也不破坏 #345）', async () => {
  const first = await sendRound({ kind: 'openai', text: QUESTION, images: [OVERSIZE] })
  const second = await sendRound({ kind: 'openai', sessionId: first.sessionId, text: '再说说这张图的右下角' })
  const third = await sendRound({ kind: 'openai', sessionId: first.sessionId, text: '那左上角呢' })
  assert.ok(first.request && second.request && third.request, '三轮都要抓到请求')
  // 被比较的那段前缀里**确实包含图片字节**：否则这条用例只是在比两段空文本
  assert.ok(
    second.request.raw.slice(0, prefixCut(second.request)).includes('data:image/webp;base64,'),
    '前缀里必须含第 1 轮那张图的 data URI（否则前缀稳定性没被真正验证）'
  )
  assert.ok(
    third.request.raw.startsWith(second.request.raw.slice(0, prefixCut(second.request))),
    `第 3 轮必须逐字节以第 2 轮为前缀（fork_at=${second.request.raw
      .split('')
      .findIndex((char, index) => char !== third.request.raw[index])}）—— 图片进请求体后这一步最容易破`
  )
  // 历史轮图片**每轮重发**，且字节完全一样（重编码不同 → 前缀立刻断）
  const urlIn = (item) => {
    const content = lastUserContent(item.body)
    const images = imagePartsOf('openai', content)
    return images.length ? images[0].image_url.url : undefined
  }
  const firstUrl = urlIn(first.request)
  const historyImage = (item) => {
    const userMessages = item.body.messages.filter((message) => message.role === 'user')
    const content = userMessages[0].content
    const blocks = Array.isArray(content) ? content.filter((b) => b.type === 'image_url') : []
    return blocks[0]?.image_url.url
  }
  assert.equal(typeof firstUrl, 'string')
  assert.equal(historyImage(second.request), firstUrl, '第 2 轮必须重发第 1 轮那张图，且字节相同')
  assert.equal(historyImage(third.request), firstUrl, '第 3 轮同样重发（D1 决策未定：先按现状断言）')
})

// ---------- [5] DeepSeek 零改动 ----------

test('[5] deepseek 传图：仍走 file_id，请求体里不出现任何 base64', async () => {
  const { request, attachmentIds } = await sendRound({
    kind: 'deepseek',
    text: QUESTION,
    images: [OVERSIZE],
  })
  const content = lastUserContent(request.body)
  assert.deepEqual(content, [
    { type: 'image', source: { type: 'file', file_id: UPLOADED_ID } },
    { type: 'text', text: QUESTION },
  ])
  assert.equal(request.raw.includes('data:image'), false, 'DeepSeek 的请求体里不许出现 data URI')
  assert.equal(request.raw.includes('base64'), false, 'DeepSeek 的请求体里不许出现 base64 字段')
  // 零改动的机械证据：这条渠道的图片根本没有本地编码产物（编码只在 base64 渠道发生）
  const id = attachmentIds[0]
  assert.equal(typeof id, 'string')
  assert.equal(imageSource.imagePartOf(id), undefined, '这条渠道根本不该有本地编码产物')
  // 传的是原图的 file_id，不是压缩产物：上传体积 = 原件体积
  const task = upload.useUploads.getState().tasks[id]
  assert.equal(task.status, 'done', 'deepseek 走 Files API 上传（与改造前一致）')
})

test('[5] deepseek：不传 vision 选项的老调用路径与「按能力表传」的产物逐字节相同', async () => {
  // #551 把 base64 通路做成可选参数，缺省是 `FILE_ID_ONLY`。这条用例钉的是「缺省 == deepseek == 改造前」：
  // 谁把缺省改成 base64（或让 deepseek 也走 base64），这里立刻红。
  const deepseek = capability.visionFor('deepseek')
  assert.deepEqual(deepseek, { base64: false, nativeFile: true })
  const reply = await import('../../src/services/chat/reply.ts')
  const user = {
    id: 'u-1',
    role: 'user',
    content: QUESTION,
    createdAt: 0,
    files: [
      { id: 'f-1', serverId: UPLOADED_ID, name: 'photo.jpg', size: 1024, isImage: true, mimeType: 'image/jpeg' },
      { id: 'f-2', serverId: 'file-doc', name: 'a.txt', size: 10, isImage: false, mimeType: 'text/plain' },
    ],
  }
  const answer = {
    id: 'a-1',
    role: 'assistant',
    createdAt: 1,
    model: null,
    prefix: true,
    status: 'done',
    blocks: [{ type: 'text', text: '上一轮的回答' }],
  }
  const legacy = reply.toRequestMessages([{ ...user, id: 'u-0', content: '第一轮', files: [] }, answer], user)
  const explicit = reply.toRequestMessages(
    [{ ...user, id: 'u-0', content: '第一轮', files: [] }, answer],
    user,
    undefined,
    false,
    undefined,
    { vision: deepseek }
  )
  assert.equal(
    JSON.stringify(explicit),
    JSON.stringify(legacy),
    'deepseek 的出参必须与「不传 vision 选项」的老路径逐字节相同（#551 的零改动边界）'
  )
  // 也不许因为传了 vision 而多出附件引用键（那是 #480 的文本注入字段）
  assert.equal(JSON.stringify(explicit).includes('attachments'), false)
  assert.equal(JSON.stringify(explicit).includes('base64'), false)
})

test('[5] 只有 deepseek 声明 nativeFile：三渠道连 paths.files 都没有', async () => {
  const providers = await import('../../src/services/api/providers.ts')
  for (const kind of ['anthropic', 'openai', 'ours']) {
    assert.deepEqual(capability.visionFor(kind), { base64: true, nativeFile: false }, `${kind} 没有 Files API`)
    assert.equal(providers.getSpec(kind).paths.files, undefined, `${kind} 的 paths.files 必须不存在（#360）`)
  }
  // 未知渠道 fail-closed：两条通路全关 → 发送闸必须报「不支持图片」而不是猜一条
  assert.deepEqual(capability.visionFor('unknown-channel'), { base64: false, nativeFile: false })
})

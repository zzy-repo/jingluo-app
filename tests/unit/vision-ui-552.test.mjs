// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #552（母单 #548 的 vision-3）：把 vision 通路接到**既有** UI 上。
// 结构基线：#562 对齐后（能力表只有 `attachments/providerCapability.ts` 一张、
// limits 只有 `services/limits.ts` 一份、上传任务在 `attachments.ts`）。
//
// 这一层只钉「不依赖 canvas / DOM」的那半；真实的压缩率、蒙层观感、真机内核归真机验收。
//
//   [1] 「发出去的是什么」的卡片标签：**字节变了才提示**，格式只认编码产物的 `mediaType`
//       （文件名叫 photo.png 也可能发成 webp，拿扩展名显示会把用户看到的东西写反）；
//   [2] 内联三态：编码中 / 就绪（带格式 + 体积）/ 失败（带 `retryable`）—— 卡片读的就是这三个态；
//   [3] 发送闸门：只有「上传完成」或「内联就绪」才放行；编码中、失败都不放行。
//       宁可不让发，也不发出去一张用户不知道丢了什么、少了什么的图（**不许静默丢图**）；
//   [4] 编码产物缓存：`imagePartBytes` 的 base64→字节换算、`dropImagePart` 在「换渠道改走
//       file_id」时清掉残留产物（否则卡片会拿 webp 的体积描述一次原图上传）；
//   [5] 接线断言（源码级，改坏了就红）：输入框卡片与消息卡片都真的渲染了这个标签；
//       入口门禁**只查能力表**（`supportsImage` / `visionFor`），不再自己拼 `paths.files`；
//       选图即编码（失败当场可重试），编码串行。
//
//   node tests/run-layer.mjs unit --only vision-ui-552
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import`
// 预加载）也不会 `ReferenceError: __ENDPOINTS__ is not defined`。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

// 宿主替身（Capacitor / IndexedDB / 诊断收集器 / 浏览器全局）只在边界上换实现，
// 顺带注册 `.js → .ts` 的 resolve 钩子；drafts / upload / imageSource 仍然是真代码。
installChatHostStubs()

const upload = await import('../../src/services/attachments.ts')
const imageSource = await import('../../src/services/attachments/imageSource.ts')
const drafts = await import('../../src/services/chat/drafts.ts')

const KB = 1024
const MB = 1024 * 1024
/** 卡片拿到的就是这份形状：`UploadTask` 的 `inline` 态 */
const inlineInfo = (mediaType, bytes) => ({ mediaType, bytes })
const tasks = () => upload.useUploads.getState().tasks
const resetTasks = () => upload.useUploads.setState({ tasks: {} })

// ---------- 1. 标签 ----------

test('[1] 压缩过才提示：格式取编码产物，字节没变就一个像素都不加', () => {
  const original = Math.round(4.8 * MB)
  // 4.8MB 的相机原图被压成 218KB 的 webp —— 用户点发送前就该看到这个
  assert.equal(upload.describeSentImage(inlineInfo('image/webp', 218 * KB), original), 'WEBP · 218 KB')
  // 原图直发（passthrough 分支，字节一个没改）→ 不加提示
  assert.equal(upload.describeSentImage(inlineInfo('image/png', original), original), null)
  // webp 不可用时的 jpeg 回落
  assert.equal(upload.describeSentImage(inlineInfo('image/jpeg', 900 * KB), original), 'JPEG · 900 KB')
  // 小于 1KB 的产物也照 `formatSize` 的既有口径显示
  assert.equal(upload.describeSentImage(inlineInfo('image/webp', 300), original), 'WEBP · 300 B')
})

test('[1] 格式只看 mediaType，不看文件名的扩展名', () => {
  assert.equal(upload.formatOfImageMediaType('image/webp'), 'WEBP')
  assert.equal(upload.formatOfImageMediaType('image/jpeg'), 'JPEG')
  // photo.png 被压过之后发出去的是 webp：标签必须是 WEBP，不能是 PNG
  assert.equal(upload.describeSentImage(inlineInfo('image/webp', 1024), 5 * MB), 'WEBP · 1.0 KB')
})

// ---------- 2. 三态 ----------

test('[2] 内联三态：编码中 / 就绪（带格式体积）/ 失败（带可重试位）', () => {
  resetTasks()
  const id = 'draft-1'
  upload.markInlineEncoding(id)
  assert.deepEqual(tasks()[id], { status: 'uploading' })
  // 就绪：卡片据此显示「WEBP · 218 KB」，同时表示「可以发送」
  upload.markInlineReady(id, inlineInfo('image/webp', 218 * KB))
  assert.deepEqual(tasks()[id], {
    status: 'inline',
    mediaType: 'image/webp',
    bytes: 218 * KB,
  })
  // 重试无效（格式不支持 / 太大）：只给原因，不给重试入口
  upload.markInlineRejected(id, { key: 'imageUnsupportedFormat' }, false)
  assert.deepEqual(tasks()[id], {
    status: 'error',
    error: { key: 'imageUnsupportedFormat' },
    retryable: false,
  })
  // 解码 / 编码失败可重试：卡片上是刷新图标
  upload.markInlineRejected(id, { key: 'imageEncodeFailed' }, true)
  assert.equal(tasks()[id].retryable, true)
})

// ---------- 3. 发送闸门 ----------

/** 只有 name / size / type 会被用到（`resolveMimeType` + 体积），不必造真 File */
const draftWith = (id) => ({
  text: '',
  attachments: [
    {
      id,
      file: { name: 'photo.png', size: 5 * MB, type: 'image/png' },
      isImage: true,
      previewUrl: null,
    },
  ],
  // #480 的文档附件是同一个草稿上的另一条车道（引用形态，不走上传），这里为空
  documents: [],
})

test('[3] 发送闸门：编码中与失败都不放行，就绪才放行（不静默丢图）', () => {
  resetTasks()
  const id = 'gate-1'
  const draft = draftWith(id)
  upload.markInlineEncoding(id)
  assert.equal(drafts.prepareDraftMessage(draft, tasks()), null)
  // 失败了但用户还按发送：不放行（卡片上有原因 + 重试），绝不「静默丢掉这张图直接发文字」
  upload.markInlineRejected(id, { key: 'imageUnsupportedFormat' }, false)
  assert.equal(drafts.prepareDraftMessage(draft, tasks()), null)
  // 就绪：放行，且内联通路没有 serverId（图片正文在本地，不发上传请求）
  upload.markInlineReady(id, inlineInfo('image/webp', 218 * KB))
  const prepared = drafts.prepareDraftMessage(draft, tasks())
  assert.equal(prepared.files.length, 1)
  assert.equal(prepared.files[0].serverId, null)
  // 原件仍然交出去（编码产物在缓存里，`store.prepareFiles` 只查缓存、不再压一遍）
  assert.equal(prepared.files[0].blob, draft.attachments[0].file)
})

test('[3] 上传通路（deepseek）不受影响：done + serverId 照旧放行', () => {
  resetTasks()
  const id = 'upload-1'
  upload.useUploads.setState({ tasks: { [id]: { status: 'done', serverId: 'file-abc' } } })
  const prepared = drafts.prepareDraftMessage(draftWith(id), tasks())
  assert.equal(prepared.files[0].serverId, 'file-abc')
})

// ---------- 4. 编码产物缓存 ----------

test('[4] base64 换算真实字节数（含 padding）', () => {
  const bytes = (base64) => imageSource.imagePartBytes({ mediaType: 'image/webp', base64 })
  assert.equal(bytes('QUJD'), 3) // 'ABC'
  assert.equal(bytes('QUJDRA=='), 4) // 'ABCD'
  assert.equal(bytes('QQ=='), 1) // 'A'
})

test('[4] dropImagePart：换渠道改走 file_id 时清掉残留的内联产物', () => {
  const id = 'switch-channel-1'
  imageSource.putImagePart(id, { mediaType: 'image/webp', base64: 'QUJD' })
  assert.equal(imageSource.imagePartOf(id).mediaType, 'image/webp')
  imageSource.dropImagePart(id)
  assert.equal(imageSource.imagePartOf(id), undefined)
  // 别的图不受影响
  imageSource.putImagePart('other-1', { mediaType: 'image/png', base64: 'QUJD' })
  imageSource.dropImagePart(id)
  assert.ok(imageSource.imagePartOf('other-1'))
  imageSource.clearImageParts()
})

// ---------- 5. 接线（源码级） ----------

const readSource = (relative) =>
  readFileSync(fileURLToPath(new URL(`../../src/${relative}`, import.meta.url)), 'utf8')

test('[5] 输入框卡片与消息卡片都渲染了「发出去的格式与体积」', () => {
  const draftCard = readSource('components/chatInput/DraftAttachments.tsx')
  assert.match(draftCard, /describeSentImage\(task, item\.file\.size\)/)
  assert.match(draftCard, /styles\.imageMeta/)

  const messageCard = readSource('components/messages/MessageFile.tsx')
  // 消息侧不持久化任何东西：编码产物在选图时就进了缓存，这里同步查一次
  assert.match(messageCard, /imagePartOf\(file\.id\)/)
  assert.match(messageCard, /styles\.meta/)

  // 64px 混排缩略图沿用失败原因那一档可见性，不再引入新判据（#214 的口径）
  const messageCss = readSource('components/messages/MessageFile.module.css')
  assert.match(messageCss, /\.meta \{[\s\S]*--message-file-reason-display/)
})

test('[5] 选图即编码：编码失败当场给原因与重试态，且串行不压垮输入框', () => {
  const draftsSource = readSource('services/chat/drafts.ts')
  assert.match(draftsSource, /markInlineEncoding\(attachment\.id\)/)
  assert.match(draftsSource, /putImagePart\(attachment\.id, part\)/)
  // `ImageSourceError` 自带的「能不能重试」原样交给卡片，不重新归纳成一律可重试
  assert.match(draftsSource, /markInlineRejected\(attachment\.id, error\.localMessage, error\.retryable\)/)
  // 编码串行：一次可以选很多张，全并发压 canvas 在 83 档 WebView 上会卡死输入框
  assert.match(draftsSource, /inlineQueue = inlineQueue\.then\(job\)/)
})

test('[5] 入口门禁只查那一张能力表：supportsImage + visionFor，不再自己拼 paths.files', () => {
  const chatInput = readSource('components/chatInput/ChatInput.tsx')
  assert.match(chatInput, /supportsImage\(kind\)/)
  assert.match(chatInput, /visionFor\(kind\)/)
  // 不可用时两种原因分流：有图片能力但没有可用通路 vs 压根没有图片能力
  assert.match(
    chatInput,
    /supportsImage\(kind\) \? 'uploadChannelUnsupported' : 'visionUnsupported'/
  )
  // 点击 / 拖拽 / 粘贴三条入口都走同一句提示，一条都不许静默忽略
  const toasts = chatInput.match(/showToast\(\{ key: attachDenied \}\)/g) ?? []
  assert.equal(toasts.length, 2)
  // base64 渠道的选择框只列图片格式
  assert.match(chatInput, /imageTransport\.base64 \? IMAGE_ACCEPT : ACCEPT/)
})

test('[5] 能力表与发送闸同源：base64 渠道不再走 Files API 上传', () => {
  const storeSource = readSource('services/chat/store.ts')
  // 发送前：base64 渠道先本地编码；两条通路都没有才明确报错
  assert.match(storeSource, /await prepareInlineImages\(sessionId, request, signal\)/)
  assert.match(storeSource, /hasImage && !vision\.base64 && !vision\.nativeFile/)
  // 上传循环里跳过内联图片（#360：这条渠道没有上传端点，也不许回落）
  assert.match(storeSource, /file\.isImage && vision\.base64/)
  // 请求侧：图片块按本渠道通路拼（file_id / base64）
  assert.match(storeSource, /vision: visionFor\(spec\.kind\)/)
  const replySource = readSource('services/chat/reply.ts')
  assert.match(replySource, /imagePartOf\(id\)/)
  assert.match(replySource, /const vision = options\?\.vision \?\? FILE_ID_ONLY/)
})

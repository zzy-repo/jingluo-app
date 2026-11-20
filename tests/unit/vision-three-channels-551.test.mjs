// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #551（母单 #548 的 vision-2）：三渠道图片能力适配。本文件钉的是**不依赖 canvas 的那半**：
//
//   [1] `visionFor()` 能力表：deepseek 只有 file_id 通路、anthropic/openai/ours 只有 base64 通路、
//       未知渠道两条全关（fail-closed）—— 这是「不发请求就不猜路径」（#360）的前提；
//   [2] 格式白名单按 **magic bytes** 判定（png/jpeg/webp/gif），HEIC / AVIF 一律认不出来 →
//       上层给「不支持的图片格式」，而不是把请求发出去等 provider 400；
//   [3] EXIF 方向与头部尺寸解析：手机竖拍（Orientation=6/8）要能读出方向与**存储时**的宽高 ——
//       这是「手动校正」分支的输入。**是否该手动转由运行时探测决定**（`probeAutoOrient()`，
//       实测 Chrome 81+ / WebView 83 自动转、79 不转；一律手动转会双转 90°，见 PR 说明），
//       探测需要真实 canvas，归 #554 的验收；
//   [4] `toOpenAIRequest()` 的两种形状：无图 → content 仍是**纯字符串**（与改造前逐字节一致，
//       #345 前缀稳定）；有 base64 图 → `image_url` 的 `data:` URI（openai 与 ours 共用这一处）；
//   [5] 文档块（`type:'document'`）不被误翻译成图片：OpenAI 协议下没有对应字段。
//
// 另一半（canvas 压缩 / toBlob / 体积闸）需要真实 DOM，归 #554 的验收用例，这里不假装覆盖。
//
//   node tests/run-layer.mjs unit --only vision-three-channels-551
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installChatHostStubs } from '../helpers/chat-host-stubs.mjs'

// 宿主替身（Capacitor / IndexedDB / 诊断收集器 / 浏览器全局）只在边界上换实现，
// 顺带注册 `.js → .ts` 的 resolve 钩子（providers.ts 里有 `./internalBuild.js` 这类写法）
installChatHostStubs()

const providers = await import('../../src/services/api/providers.ts')
// 渠道能力表只有一张（#562）：文档维度（#480）与图片维度（#551）在同一个对象里
const capability = await import('../../src/services/attachments/providerCapability.ts')
const { sniffImage } = await import('../../src/services/attachments/imageSource.ts')
const { toOpenAIRequest } = await import('../../src/services/api/openaiAdapter.ts')

// ---------- 构造字节（真文件头，不用图片库） ----------

const pngBytes = (width, height) => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const gifBytes = (width, height) => {
  const bytes = new Uint8Array(13)
  bytes.set(Array.from('GIF89a', (char) => char.charCodeAt(0)), 0)
  const view = new DataView(bytes.buffer)
  view.setUint16(6, width, true)
  view.setUint16(8, height, true)
  return bytes
}

const webpBytes = (width, height) => {
  const bytes = new Uint8Array(30)
  const put = (offset, text) => bytes.set(Array.from(text, (char) => char.charCodeAt(0)), offset)
  put(0, 'RIFF')
  put(8, 'WEBP')
  put(12, 'VP8X')
  bytes[24] = (width - 1) & 0xff
  bytes[25] = ((width - 1) >> 8) & 0xff
  bytes[26] = ((width - 1) >> 16) & 0xff
  bytes[27] = (height - 1) & 0xff
  bytes[28] = ((height - 1) >> 8) & 0xff
  bytes[29] = ((height - 1) >> 16) & 0xff
  return bytes
}

/** JPEG：SOI + APP1(Exif, Orientation) + SOF0（宽高）；orientation 为 null 时不带 EXIF */
const jpegBytes = (width, height, orientation) => {
  const parts = [[0xff, 0xd8]]
  if (orientation !== null) {
    const exif = new Uint8Array(14 + 12 + 4)
    const view = new DataView(exif.buffer)
    exif.set([0x49, 0x49], 0) // 'II' = little endian
    view.setUint16(2, 0x2a, true)
    view.setUint32(4, 8, true)
    view.setUint16(8, 1, true) // 1 个 IFD0 条目
    view.setUint16(10, 0x0112, true) // Orientation
    view.setUint16(12, 3, true) // SHORT
    view.setUint32(14, 1, true)
    view.setUint16(18, orientation, true)
    const payload = [...Array.from('Exif\0\0', (char) => char.charCodeAt(0)), ...exif]
    parts.push([0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff], payload)
  }
  parts.push(
    [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 0x03],
    [0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]
  )
  return new Uint8Array(parts.flat())
}

/** HEIC / AVIF：ISO-BMFF 的 `ftyp` 头 —— 一律认不出来（白名单之外） */
const ftypBytes = (brand) => {
  const bytes = new Uint8Array(24)
  bytes.set([0, 0, 0, 0x18], 0)
  bytes.set(Array.from('ftyp', (char) => char.charCodeAt(0)), 4)
  bytes.set(Array.from(brand, (char) => char.charCodeAt(0)), 8)
  bytes.set(Array.from('mif1', (char) => char.charCodeAt(0)), 16)
  return bytes
}

// ---------- [1] 能力表 ----------

test('[1] visionFor：deepseek 只走 file_id，三渠道只走 base64，未知渠道两条全关', () => {
  assert.deepEqual(
    capability.visionFor('deepseek'),
    { base64: false, nativeFile: true },
    'deepseek 的图片通路必须**保持原样**：继续走 Files API 的 file_id（#551 的零改动边界）'
  )
  for (const kind of ['anthropic', 'openai', 'ours']) {
    assert.deepEqual(
      capability.visionFor(kind),
      { base64: true, nativeFile: false },
      `${kind}：没有 paths.files（#360），只能本地编码内联`
    )
  }
  assert.deepEqual(
    capability.visionFor('unknown-channel'),
    { base64: false, nativeFile: false },
    '未知渠道必须 fail-closed：宁可报「不支持图片」，也不猜一条通路'
  )
})

test('[1] 能力表只有一张：文档维度与图片维度在同一个能力对象里（#562）', () => {
  // 一个渠道一个能力对象：`documents`（#480）与 `image`（#551）是同一行的两个维度。
  // 这条断言是「不许新建第二张表」的守门人：谁把 image 挪回 providers.ts 另开一张表，
  // 或者把它拆成两个平行 Record，这里立刻红。
  assert.deepEqual(capability.channelCapabilityOf('deepseek'), {
    documents: { textInjection: false, nativeFile: false },
    image: { base64: false, nativeFile: true },
  })
  assert.deepEqual(capability.channelCapabilityOf('anthropic'), {
    documents: { textInjection: true, nativeFile: false },
    image: { base64: true, nativeFile: false },
  })
  assert.equal(capability.supportsImage('deepseek'), true)
  assert.equal(capability.supportsImage('anthropic'), true)
  assert.equal(capability.supportsImage('unknown-channel'), false, '未知渠道 fail-closed')
  // 文档判定（#480 / #538）没被图片维度影响
  assert.equal(capability.acceptsDocuments('deepseek'), false)
  assert.equal(capability.acceptsDocuments('anthropic'), true)
})

test('[1] 通路表与 caps.vision 各回答一半：入口位在 #552 接线时与注入链路一起翻', () => {
  // 入口门禁是「`caps.vision` 且能力表里有可用通路」：`caps.vision` 是 UI 开关（#480 的语义），
  // `visionFor().image` 是请求侧怎么走（#562 的单一能力表）。#551 只落通路表，两个位子
  // **必须一起翻**，否则就是「入口亮着、点下去拿不到图」—— #552 是那一步（`ChatInput.tsx`）。
  assert.equal(providers.getSpec('deepseek').caps.vision, true, 'deepseek 的 vision 保持 true 不变')
  for (const kind of ['anthropic', 'openai', 'ours']) {
    assert.equal(
      providers.getSpec(kind).caps.vision,
      true,
      `${kind} 的 caps.vision 已由 #552 与 base64 注入链路一起置真`
    )
  }
  assert.equal(
    providers.getSpec('deepseek').paths.files,
    '/anthropic/v1/files',
    'deepseek 的 paths.files 一个字符都不许动（零改动证明之一）'
  )
  // 通路表则如实声明：三个渠道的图片只能本地编码（它们没有、也不会有 paths.files）
  for (const kind of ['anthropic', 'openai', 'ours']) {
    assert.equal(capability.visionFor(kind).base64, true, `${kind} 的 base64 通路由能力表声明`)
    assert.equal(providers.getSpec(kind).paths.files, undefined, `${kind} 没有 Files API 端点`)
  }
})

// ---------- [2] magic bytes 白名单 ----------

test('[2] 白名单按 magic bytes：png/jpeg/webp/gif 认得，heic/avif 一律拒绝', () => {
  assert.equal(sniffImage(pngBytes(64, 32)).mediaType, 'image/png')
  assert.equal(sniffImage(jpegBytes(64, 32, null)).mediaType, 'image/jpeg')
  assert.equal(sniffImage(webpBytes(64, 32)).mediaType, 'image/webp')
  assert.equal(sniffImage(gifBytes(64, 32)).mediaType, 'image/gif')

  // iPhone 默认格式：任何一家协议都不接受 image/heic，Chromium 83 也解不了 →
  // 必须在入口判掉（返回 null，上层给「不支持的图片格式」），不能靠扩展名放行
  assert.equal(sniffImage(ftypBytes('heic')), null, 'HEIC 必须认不出来')
  assert.equal(sniffImage(ftypBytes('avif')), null, 'AVIF 必须认不出来')
  assert.equal(sniffImage(new Uint8Array([0x42, 0x4d, 0x36, 0x00])), null, 'BMP 必须认不出来')
  assert.equal(sniffImage(new Uint8Array(0)), null, '空文件不许崩，也不许当成图片')
})

test('[2] 头部尺寸解析：png/gif/webp 的尺寸字段都对得上', () => {
  assert.deepEqual(
    { width: sniffImage(pngBytes(1024, 600)).width, height: sniffImage(pngBytes(1024, 600)).height },
    { width: 1024, height: 600 }
  )
  assert.deepEqual(
    { width: sniffImage(gifBytes(320, 240)).width, height: sniffImage(gifBytes(320, 240)).height },
    { width: 320, height: 240 }
  )
  assert.deepEqual(
    { width: sniffImage(webpBytes(1568, 900)).width, height: sniffImage(webpBytes(1568, 900)).height },
    { width: 1568, height: 900 }
  )
})

// ---------- [3] EXIF 方向 ----------

test('[3] EXIF 方向能读出来，且拿到的是**存储时**的宽高（手动校正分支的输入）', () => {
  const upright = sniffImage(jpegBytes(4032, 3024, 1))
  assert.equal(upright.orientation, 1, '没有有效方向时按 1 处理')
  assert.deepEqual([upright.width, upright.height], [4032, 3024])

  for (const orientation of [3, 6, 8]) {
    const rotated = sniffImage(jpegBytes(4032, 3024, orientation))
    assert.equal(rotated.orientation, orientation, `Orientation=${orientation} 必须读出来`)
    assert.deepEqual(
      [rotated.width, rotated.height],
      [4032, 3024],
      '存储尺寸不变 —— 与解码尺寸比较即可判断引擎有没有应用方向'
    )
  }
})

// ---------- [4] OpenAI 侧序列化 ----------

const body = (content) => ({
  model: 'test-model',
  system: '',
  thinking: { type: 'disabled' },
  messages: [{ role: 'user', content }],
})

test('[4] 无图消息：content 仍是纯字符串（与改造前逐字节一致）', () => {
  const request = toOpenAIRequest(body('你好'))
  assert.deepEqual(request.messages, [{ role: 'user', content: '你好' }])
})

test('[4] 有 base64 图：翻成 image_url 的 data URI，文本在前', () => {
  const request = toOpenAIRequest(
    body([
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' } },
      { type: 'text', text: '这是什么' },
    ])
  )
  assert.deepEqual(request.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } },
      ],
    },
  ])
})

test('[4] 只有图没有文字：消息不许被当成空消息丢掉', () => {
  const request = toOpenAIRequest(
    body([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }])
  )
  assert.equal(request.messages.length, 1, '只发图不说话是合法输入')
  assert.deepEqual(request.messages[0].content, [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } },
  ])
})

// ---------- [5] 文档块不误伤 ----------

test('[5] document 块（file_id）不会被翻译成图片，也不会让 content 变成数组', () => {
  const request = toOpenAIRequest(
    body([
      { type: 'document', source: { type: 'file', file_id: 'file-1' } },
      { type: 'text', text: '看下这个文件' },
    ])
  )
  assert.deepEqual(request.messages, [{ role: 'user', content: '看下这个文件' }])
})

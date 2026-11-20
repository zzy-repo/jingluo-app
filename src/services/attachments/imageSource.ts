/**
 * 图片 → 内联 base64 的统一入口（#551 / 母单 #548 的 vision-2；参数依据 `ref-vision.md` 5.1–5.3）。
 *
 * 为什么需要这一层：走 Files API 的渠道（今天只有 deepseek）图片按 `file_id` 引用，正文不进
 * 请求体；而 **anthropic / openai / ours 永远不会有 `paths.files`**（#360 的纪律：能力显式声明，
 * 没有就一个请求都不发），这三家的图片只能本地编码成 base64 内联。于是这里集中做三件事，
 * 三渠道共用，不许在别处各写一遍：
 *
 * 1. **格式白名单按 magic bytes 判定**（不信 MIME、不信扩展名）：`png / jpeg / webp / gif`。
 *    iPhone 的 HEIC 是高频输入，而任何一家协议都不接受 `image/heic`，Chromium 83 也解不了
 *    —— 与其等 provider 400，不如在入口就判掉并给出可读原因（`imageUnsupportedFormat`）。
 * 2. **压缩是「阈值触发的降级」，不是无条件重编码**：长边 ≤1568 **且** 像素 ≤1.15MP **且**
 *    字节 ≤3.5MB → **原图一个字节不改**（Anthropic 官方推荐值；也避免 canvas 重编码带来的
 *    EXIF / 动图帧 / 主线程阻塞这些坑）。只有超了才用 canvas 降一次，输出 **webp q0.85**
 *    （**绝不输出 PNG**：PNG q1.0 会把 1568px 截图撑到 2–4MB，base64 再 ×4/3，是纯负资产）。
 * 3. **体积极限明确拒绝**：原图 >16MB 直接拒（不解码，避免 OOM）、动图超阈值不压（会被拍平，
 *    说明原因）、编码产物异常（空 / 超限 / 格式回落）都报错，**不截断、不静默丢图**。
 *
 * 内部表示用**分字段 base64**（`{mediaType, base64}`），`data:` URL 只在最后一公里拼
 * （openaiAdapter 里那一次）—— anthropic 要 `media_type` + `data` 两个字段，存 data URL 会让
 * 那条通路每轮拆一次前缀。
 *
 * 兼容口径：Chromium 83 / ES2017 —— 只用 `createObjectURL` + `new Image()` +
 * `document.createElement('canvas')` + `ctx.drawImage` + `canvas.toBlob`（**不用**
 * `createImageBitmap` / `OffscreenCanvas`：前者在移动端分支不一致，后者 83 上支持不全），
 * 不写 `??=` / `||=` / 私有字段 / 顶层 await，不引任何重型依赖。
 *
 * 这一层**不碰网络、不碰 IndexedDB**：只吃 Blob、吐 ImagePart。调用方（发送前的
 * `store.prepareFiles`）负责取原件，这样 `reply.ts` 拼请求时只需同步查一次缓存，
 * 整条链路不用改成 async。
 *
 * ## 接线状态（#562 结构对齐 → #552 接线）
 *
 * 本文件是**传输层实现**，与 #480 的文档链路共用同一套 `limits`（`LIMITS.images`）与同一张
 * 渠道能力表（`providerCapability.ts` 的 `visionFor()`）。链路已经接通：
 *
 * - **选图时**编码一次（`chat/drafts.ts` 的 `prepareInline`，串行队列），产物进下面的缓存，
 *   卡片当场显示「发出去的是 WEBP · 218 KB」/ 可读的失败原因（#552）；
 * - **发送前**`store.prepareInlineImages()` 只查缓存（没命中才补编一次），本轮图片要么编好
 *   要么明确报错，**绝不静默丢图**；
 * - **拼请求时**`reply.toFileBlocks()` 同步查一次 `imagePartOf()`，把内联块放进 user content。
 *
 * 深链约束不变：deepseek 走 `file_id`，缓存对它永远是空的，那条路径逐字节与改造前一致。
 */

import type { TranslationMessage } from '../../i18n/index.js'
import { LIMITS, mbOf } from '../limits.js'

/**
 * 编码产物：协议层要的三样东西（分字段，不含 `data:` 前缀）。
 * `width` / `height` 是**编码后**的逻辑像素尺寸（只进日志，不进请求体）。
 */
export type ImagePart = {
  mediaType: string
  base64: string
  width?: number
  height?: number
}

/** 支持的图片媒体类型（magic bytes 判定得出，顺序即提示语里的展示顺序） */
export const IMAGE_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

/** 选择文件对话框的图片过滤条件（base64 渠道只收这四类） */
export const IMAGE_ACCEPT = IMAGE_MEDIA_TYPES.join(',')

export const isSupportedImageMediaType = (value: string): boolean =>
  IMAGE_MEDIA_TYPES.includes(value)

/** 扩展名白名单（与 IMAGE_MEDIA_TYPES 对齐）：只在「浏览器没给 MIME」时用于快速放行/拦截 */
export const IMAGE_EXTS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif']

/**
 * 提示语里展示的格式清单：**从 `IMAGE_MEDIA_TYPES` 派生**（`image/png` → `PNG`）。
 *
 * 为什么不写死一句「仅支持 PNG / JPEG / WebP」（#580 缺口 1）：GIF 从 #551 起就在白名单里，
 * 文案却漏了它 —— 用户拿一张 GIF 报错时被告知「只支持三种」，方向正好是反的（能发却说不能）。
 * 白名单是唯一判定处，展示清单跟着它派生，以后加格式就不会再出现「能发了但没告知」。
 */
export const IMAGE_FORMAT_LABELS: string = IMAGE_MEDIA_TYPES.map((mediaType) =>
  (mediaType.split('/')[1] ?? mediaType).toUpperCase()
).join(' / ')

/**
 * 「格式不支持」的统一消息：**唯一构造处** —— 草稿层的选图闸与编码层的 magic bytes 闸共用，
 * 于是两处的清单永远是同一份（都来自 `IMAGE_FORMAT_LABELS`）。
 *
 * 「HEIC 请先转成 JPEG」放在这句里：HEIC 是最高频的「不支持的图」（iPhone 相册默认格式），
 * 而它有一步到位的处理动作，不是「这个文件坏了」。所以这条原因必须**真的能被 HEIC 用户看到**
 * （#580 缺口 2：见 `drafts.ts` 的 `imageGateMessage`）。
 */
export const unsupportedImageFormatMessage = (): TranslationMessage => ({
  key: 'imageUnsupportedFormat',
  params: { formats: IMAGE_FORMAT_LABELS },
})

/**
 * HEIC / HEIF（iPhone 相册默认格式）：**是图片，但任何一家协议都不收**（`image/heic` 不是
 * 合法输入），Chromium 83 也解不了 —— 所以不在白名单里。
 *
 * 但草稿层必须**先认出它是图片**：否则它会先撞扩展名白名单（`ACCEPT_FILE_EXTS` 不含 heic），
 * 拿到一句「暂未支持的文件格式……支持 PDF、DOC、图片、文本……」，既没给可做动作、
 * 还顺带说「图片支持」（#580 缺口 2）。
 */
export const HEIF_EXTS: readonly string[] = ['heic', 'heif', 'hif']

/**
 * 编码 / 压缩失败的统一错误：`message` 是给用户看的中文文案（含参数），
 * `retryable` 表示「换一张 / 重试」是否有意义（解码失败可重试，格式不支持不可重试）。
 */
export class ImageSourceError extends Error {
  /** 给用户看的中文文案（key + 参数），由调用方转成 ApiError 的 `localMessage` */
  readonly localMessage: TranslationMessage
  readonly retryable: boolean

  constructor(localMessage: TranslationMessage, retryable: boolean) {
    // 错误原文只是给日志的兜底，界面一律用 localMessage（翻译在渲染层做）
    super(localMessage.key)
    this.name = 'ImageSourceError'
    this.localMessage = localMessage
    this.retryable = retryable
  }
}

// ---------- magic bytes + 头部尺寸 + EXIF 方向 ----------

/** 头部嗅探结果：媒体类型、**存储时**的像素尺寸（0 = 没解出来）、EXIF 方向（1 = 无 / 未解出） */
export type SniffedImage = {
  mediaType: string
  width: number
  height: number
  orientation: number
}

const ascii = (bytes: Uint8Array, offset: number, text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false
    }
  }
  return true
}

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** JPEG：扫段找 SOF（含尺寸）与 APP1（含 EXIF 方向）；越界一律返回 0，不做猜测 */
const sniffJpeg = (bytes: Uint8Array): SniffedImage => {
  const data = view(bytes)
  let offset = 2
  let width = 0
  let height = 0
  let orientation = 1
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      break
    }
    const marker = bytes[offset + 1]
    // 填充字节 / 无长度的标记
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) {
      break
    }
    const length = data.getUint16(offset + 2)
    if (length < 2) {
      break
    }
    const body = offset + 4
    // EXIF（APP1）：'Exif\0\0' 后面是 TIFF 头，只在还没读到方向时解一次
    if (marker === 0xe1 && orientation === 1 && bytes.length >= body + 14 && ascii(bytes, body, 'Exif')) {
      orientation = readExifOrientation(bytes, body + 6)
    }
    // SOF0…SOF15（排除 DHT=C4 / JPG=C8 / DAC=CC）
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof && bytes.length >= body + 5) {
      height = data.getUint16(body + 1)
      width = data.getUint16(body + 3)
      if (width > 0 && height > 0) {
        break
      }
    }
    offset = body + length - 2
  }
  return { mediaType: 'image/jpeg', width, height, orientation }
}

/** TIFF 头里的 IFD0 tag 0x0112（Orientation）；任何异常都当「没有方向」返回 1 */
const readExifOrientation = (bytes: Uint8Array, tiffStart: number): number => {
  const data = view(bytes)
  if (tiffStart + 8 > bytes.length) {
    return 1
  }
  const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49
  const u16 = (at: number) => (little ? data.getUint16(at, true) : data.getUint16(at, false))
  const u32 = (at: number) => (little ? data.getUint32(at, true) : data.getUint32(at, false))
  const ifd = tiffStart + u32(tiffStart + 4)
  if (ifd + 2 > bytes.length) {
    return 1
  }
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > bytes.length) {
      return 1
    }
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

const sniffWebp = (bytes: Uint8Array): SniffedImage => {
  const data = view(bytes)
  let width = 0
  let height = 0
  if (bytes.length >= 30 && ascii(bytes, 12, 'VP8X')) {
    width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
    height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
  } else if (bytes.length >= 30 && ascii(bytes, 12, 'VP8 ')) {
    width = data.getUint16(26, true) & 0x3fff
    height = data.getUint16(28, true) & 0x3fff
  } else if (bytes.length >= 25 && ascii(bytes, 12, 'VP8L')) {
    const bits = data.getUint32(21, true)
    width = (bits & 0x3fff) + 1
    height = ((bits >> 14) & 0x3fff) + 1
  }
  return { mediaType: 'image/webp', width, height, orientation: 1 }
}

/**
 * 只靠**前若干字节**判定媒体类型（magic bytes，与 DSH `sniffImageMediaType` 同一口径）。
 * 认不出来一律 null → 调用方按「不支持的格式」明确拒绝。
 */
export const sniffImage = (bytes: Uint8Array): SniffedImage | null => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) {
    const data = view(bytes)
    return {
      mediaType: 'image/png',
      width: data.getUint32(16),
      height: data.getUint32(20),
      orientation: 1,
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return sniffJpeg(bytes)
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) {
    const data = view(bytes)
    return {
      mediaType: 'image/gif',
      width: data.getUint16(6, true),
      height: data.getUint16(8, true),
      orientation: 1,
    }
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    return sniffWebp(bytes)
  }
  return null
}

/** 读头部字节（256KB 足够覆盖 JPEG 的 APP1/SOF 与各容器的尺寸字段） */
const readHead = async (blob: Blob): Promise<Uint8Array> =>
  new Uint8Array(
    await blob.slice(0, Math.min(blob.size, LIMITS.images.maxHeadBytes)).arrayBuffer()
  )

// ---------- 编码 / 压缩 ----------

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0 || comma === result.length - 1) {
        // iOS 老 WebKit 在超 canvas 面积时会给 `data:,` 而不是抛错：必须校验产物非空
        reject(new ImageSourceError({ key: 'imageEncodeFailed' }, true))
        return
      }
      resolve(result.slice(comma + 1))
    }
    reader.onerror = () => reject(new ImageSourceError({ key: 'imageEncodeFailed' }, true))
    reader.readAsDataURL(blob)
  })

/** 解码成 `<img>`：拿逻辑尺寸，同时充当「这张图本地能不能打开」的探针 */
const loadImage = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new ImageSourceError({ key: 'imageDecodeFailed' }, true))
    }
    image.src = url
  })

// ---------- EXIF 方向：运行时探测「引擎会不会自动转」 ----------
//
// 实测结论（`/root/未分组/exif-orientation-findings.md`，79/81/83/109 四档真机）：
// **Chrome 81 起 `drawImage` 自动应用 EXIF 方向**（`image-orientation` 初始值改成 `from-image`，
// canvas 没有 CSS 逃逸路径），Chromium 83 与 Android WebView 83 **8 种方向全对**；而
// `config/compat.json` 的 `probeTiers` 里还有 **79 档，它不转**。
//
// 所以两种「省事写法」都是错的：
// - 「总是手动转」→ 83+ 上**双转 90°**（用户看到照片歪着，正是要修的 bug）；
// - 「从不手动转」→ 79 档上照片**完全没转**。
//
// 唯一两边都对的写法是**探测一次 + 只在「不自动」的分支手动校正**。探测本身用
// 「4×2、EXIF Orientation=5」的最小 JPEG 走一遍 `Image + drawImage`（与业务管线同构），
// 自动旋转的引擎会给出 2×4 且左上角像素来自原图左下 → 两道判据一起看。

/**
 * 探针图：64×32，上半红、下半蓝；Orientation=5（转置）会让它变成 32×64，
 * 且 (16,8) 处的像素来自原图下半（蓝）。
 *
 * 为什么不用 4×2 这种极小图：JPEG 的色度子采样会把 2×1 的色块糊成中间值，
 * 颜色判据会假阴性（实测：转置确实发生了，但红蓝被打平，`B > R` 不成立）。
 * 64×32 的每个色块是 64×16，压缩后颜色仍然是纯的。
 */
const PROBE_WIDTH = 64
const PROBE_HEIGHT = 32
const PROBE_TOP = '#ff0000'
const PROBE_BOTTOM = '#0000ff'
const PROBE_ORIENTATION = 5

/** 往 JPEG 的 SOI 之后插一个只带 Orientation 的 APP1(Exif) 段 */
const withExifOrientation = (jpeg: Uint8Array, orientation: number): Uint8Array => {
  const exif = new Uint8Array(14 + 12 + 4)
  const view = new DataView(exif.buffer)
  exif.set([0x49, 0x49], 0) // 'II'：小端 TIFF
  view.setUint16(2, 0x2a, true)
  view.setUint32(4, 8, true)
  view.setUint16(8, 1, true) // IFD0 只有 1 个条目
  view.setUint16(10, 0x0112, true) // Orientation
  view.setUint16(12, 3, true) // SHORT
  view.setUint32(14, 1, true)
  view.setUint16(18, orientation, true)
  const payload = new Uint8Array(6 + exif.length)
  payload.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 0) // 'Exif\0\0'
  payload.set(exif, 6)
  const app1 = new Uint8Array(4 + payload.length)
  app1.set([0xff, 0xe1], 0)
  app1[2] = ((payload.length + 2) >> 8) & 0xff
  app1[3] = (payload.length + 2) & 0xff
  app1.set(payload, 4)
  const out = new Uint8Array(jpeg.length + app1.length)
  out.set(jpeg.subarray(0, 2), 0)
  out.set(app1, 2)
  out.set(jpeg.subarray(2), 2 + app1.length)
  return out
}

/** 造探针 JPEG：canvas 出图（无 EXIF）→ 手动塞进 Orientation=5 */
const orientationProbe = async (): Promise<Blob> => {
  const canvas = document.createElement('canvas')
  canvas.width = PROBE_WIDTH
  canvas.height = PROBE_HEIGHT
  const context = canvas.getContext('2d')
  if (!context) {
    throw new ImageSourceError({ key: 'imageEncodeFailed' }, true)
  }
  context.fillStyle = PROBE_TOP
  context.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT / 2)
  context.fillStyle = PROBE_BOTTOM
  context.fillRect(0, PROBE_HEIGHT / 2, PROBE_WIDTH, PROBE_HEIGHT / 2)
  const raw = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result)
          return
        }
        reject(new ImageSourceError({ key: 'imageEncodeFailed' }, true))
      },
      'image/jpeg',
      LIMITS.images.jpegFallbackQuality
    )
  })
  const bytes = new Uint8Array(await raw.arrayBuffer())
  const patched = withExifOrientation(bytes, PROBE_ORIENTATION)
  return new Blob([patched.buffer as ArrayBuffer], { type: 'image/jpeg' })
}

/**
 * 引擎是否会把 EXIF 方向应用到 `drawImage`：
 * 探针图（4×2，Orientation=5）在自动旋转的引擎上解码成 2×4，且左上角来自原图**左下**（蓝）。
 * 探测**只跑一次**（模块级缓存 Promise，并发调用共用同一次），失败按「不自动」处理
 * （= 走手动校正分支，与 findings 的保守回落一致）。
 */
let autoOrientProbe: Promise<boolean> | null = null

export const probeAutoOrient = (): Promise<boolean> => {
  if (autoOrientProbe) {
    return autoOrientProbe
  }
  autoOrientProbe = (async () => {
    try {
      const image = await loadImage(await orientationProbe())
      const width = image.naturalWidth || image.width
      const height = image.naturalHeight || image.height
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) {
        return false
      }
      context.drawImage(image, 0, 0)
      // 自动应用方向的引擎：64×32 的探针变成 32×64，且 (16,8) 来自原图下半（蓝）
      const rotated = width === PROBE_HEIGHT && height === PROBE_WIDTH
      let pixelMatches = true
      try {
        const pixel = context.getImageData(
          Math.floor(PROBE_HEIGHT / 2),
          Math.floor(PROBE_HEIGHT / 4),
          1,
          1
        ).data
        pixelMatches = pixel[2] > pixel[0] // 蓝 > 红
      } catch {
        // getImageData 受限（理论上 object URL 不会污染画布）：只信尺寸判据
        pixelMatches = true
      }
      return rotated && pixelMatches
    } catch {
      return false
    }
  })()
  return autoOrientProbe
}

/** EXIF Orientation 1–8 的 `setTransform` 参数（w,h = **原始**像素宽高；见 findings §5.3 的表） */
const ORIENTATION_MATRIX: Record<number, [number, number, number, number]> = {
  1: [1, 0, 0, 1],
  2: [-1, 0, 0, 1],
  3: [-1, 0, 0, -1],
  4: [1, 0, 0, -1],
  5: [0, 1, 1, 0],
  6: [0, 1, -1, 0],
  7: [0, -1, -1, 0],
  8: [0, -1, 1, 0],
}

/**
 * 按 EXIF 方向手工校正（**只在探测结果为「不自动」时调用**）。
 * 输出尺寸：方向 5–8 会把长宽对调。
 */
const orientCanvas = (image: HTMLImageElement, orientation: number): HTMLCanvasElement => {
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const swap = orientation >= 5
  const width = swap ? sourceHeight : sourceWidth
  const height = swap ? sourceWidth : sourceHeight
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new ImageSourceError({ key: 'imageEncodeFailed' }, true)
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const matrix = ORIENTATION_MATRIX[orientation] ?? ORIENTATION_MATRIX[1]
  const translateX =
    orientation === 2 || orientation === 3
      ? sourceWidth
      : orientation === 6 || orientation === 7
        ? sourceHeight
        : 0
  const translateY =
    orientation === 3 || orientation === 4
      ? sourceHeight
      : orientation === 7 || orientation === 8
        ? sourceWidth
        : 0
  context.setTransform(matrix[0], matrix[1], matrix[2], matrix[3], translateX, translateY)
  context.drawImage(image, 0, 0)
  context.setTransform(1, 0, 0, 1, 0, 0)
  return canvas
}

/** 目标尺寸：长边 ≤ maxEdge，且总像素 ≤ maxCanvasArea（超面积的老 WebKit 会静默给空产物） */
const targetSize = (width: number, height: number, maxEdge: number, maxArea: number) => {
  const longEdge = Math.max(width, height)
  const scale = Math.min(1, maxEdge / longEdge, Math.sqrt(maxArea / (width * height)))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 缩图 + 重编码。
 *
 * 方向：**先探测再决定**（`probeAutoOrient()`）——
 * - 引擎自动应用 EXIF（Chrome 81+ / WebView 83 实测）→ 原样 `drawImage`，**绝不自己转**；
 * - 引擎不应用（79 档）→ 先用 `orientCanvas()` 按 1–8 表校正一次，再缩放。
 * 两者都不做就是上面说的两个用户可见 bug 之一。
 *
 * 先铺白底：webp / jpeg 都没有透明通道，PNG 的透明区不铺底会变黑块。
 */
const reencode = async (
  image: HTMLImageElement,
  width: number,
  height: number,
  orientation: number,
  autoOrient: boolean,
  type: string,
  quality: number
): Promise<Blob> => {
  const source =
    autoOrient || orientation <= 1 ? image : orientCanvas(image, orientation)
  const result = await new Promise<Blob | null>((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      reject(new ImageSourceError({ key: 'imageEncodeFailed' }, true))
      return
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(source, 0, 0, width, height)
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.size === 0) {
          reject(new ImageSourceError({ key: 'imageEncodeFailed' }, true))
          return
        }
        resolve(blob)
      },
      type,
      quality
    )
  })
  if (!result) {
    throw new ImageSourceError({ key: 'imageEncodeFailed' }, true)
  }
  return result
}

/**
 * 统一入口：Blob → ImagePart（含白名单 / 阈值 / 压缩 / 体积闸）。
 *
 * 判定顺序就是「能不能省掉重编码」的顺序：
 * 1. magic bytes 不在白名单 → 直接拒绝（HEIC 等在这里出局，解都不用解）；
 * 2. 原图 > 16MB → 直接拒绝（**不解码**：100MP 的图在 Chromium 83 上会先 OOM）；
 * 3. 解码拿逻辑尺寸；**长边 ≤1568 且 像素 ≤1.15MP 且 字节 ≤3.5MB → 原图直发，字节不改**；
 * 4. 超阈值 → canvas 缩到长边 1568、输出 webp 0.85（webp 不可用时回落 jpeg 0.9）；
 * 5. 产物超 `maxEncodedBytes` → 明确拒绝（不截断、不静默丢）。
 *
 * 类型一律**以字节为准**（magic bytes），不看调用方给的 MIME、也不看扩展名。
 */
export const toImagePart = async (blob: Blob): Promise<ImagePart> => {
  const sniffed = sniffImage(await readHead(blob))
  if (!sniffed || !isSupportedImageMediaType(sniffed.mediaType)) {
    throw new ImageSourceError(unsupportedImageFormatMessage(), false)
  }
  if (blob.size > LIMITS.images.maxSourceBytes) {
    throw new ImageSourceError(
      { key: 'imageTooLarge', params: { size: mbOf(LIMITS.images.maxSourceBytes) } },
      false
    )
  }
  const image = await loadImage(blob)
  const decodedWidth = image.naturalWidth || image.width
  const decodedHeight = image.naturalHeight || image.height
  if (decodedWidth <= 0 || decodedHeight <= 0) {
    throw new ImageSourceError({ key: 'imageDecodeFailed' }, true)
  }
  const pixels = decodedWidth * decodedHeight
  const longEdge = Math.max(decodedWidth, decodedHeight)
  const withinLimits =
    longEdge <= LIMITS.images.maxEdge &&
    pixels <= LIMITS.images.maxPixels &&
    blob.size <= LIMITS.images.passThroughBytes
  if (withinLimits) {
    // 原图直发：一个字节不改，EXIF / 动图帧 / 色深全部保真
    return {
      mediaType: sniffed.mediaType,
      base64: await blobToBase64(blob),
      width: decodedWidth,
      height: decodedHeight,
    }
  }
  if (sniffed.mediaType === 'image/gif') {
    // 动图过 canvas 只剩首帧：宁可不发也不偷偷拍平（用户能看到的第一帧可能不是他要的）
    throw new ImageSourceError(
      { key: 'imageAnimatedTooLarge', params: { size: mbOf(LIMITS.images.passThroughBytes) } },
      false
    )
  }
  /**
   * 方向：引擎会不会自己转？—— 探测一次（模块级缓存）。
   * 不回自动、且这张图真有方向时才需要手动校正；校正会把长宽对调（方向 5–8）。
   */
  const autoOrient = await probeAutoOrient()
  const manual = !autoOrient && sniffed.orientation >= 2
  const logicalWidth =
    manual && sniffed.orientation >= 5 ? decodedHeight : decodedWidth
  const logicalHeight =
    manual && sniffed.orientation >= 5 ? decodedWidth : decodedHeight
  const target = targetSize(logicalWidth, logicalHeight, LIMITS.images.maxEdge, LIMITS.images.maxCanvasArea)
  let result = await reencode(
    image,
    target.width,
    target.height,
    sniffed.orientation,
    autoOrient,
    'image/webp',
    LIMITS.images.webpQuality
  )
  let mediaType = 'image/webp'
  // toBlob 遇到不支持的 type 会**静默回落成 PNG**（体积最大那种）：结果类型不对就改走 JPEG
  if (result.type !== mediaType) {
    result = await reencode(
      image,
      target.width,
      target.height,
      sniffed.orientation,
      autoOrient,
      'image/jpeg',
      LIMITS.images.jpegFallbackQuality
    )
    mediaType = 'image/jpeg'
    if (result.type !== mediaType) {
      // 连 JPEG 都编不出来（引擎异常）：明确报错，绝不错标成 image/jpeg 发出去
      throw new ImageSourceError({ key: 'imageEncodeFailed' }, true)
    }
  }
  if (result.size > LIMITS.images.maxEncodedBytes) {
    throw new ImageSourceError(
      { key: 'imageTooLarge', params: { size: mbOf(LIMITS.images.maxEncodedBytes) } },
      false
    )
  }
  return {
    mediaType,
    base64: await blobToBase64(result),
    width: target.width,
    height: target.height,
  }
}

// ---------- 编码结果缓存（fileId + 参数） ----------

/**
 * 缓存签名：**参数变了结果就不该复用**（阈值 / 质量调整后老产物必须失效）。
 * 这也是 #345 前缀稳定的前提之一：同一张图在同一组参数下永远得到同一份字节。
 */
const CACHE_SIGNATURE = [
  LIMITS.images.maxEdge,
  LIMITS.images.maxPixels,
  LIMITS.images.passThroughBytes,
  LIMITS.images.webpQuality,
  LIMITS.images.jpegFallbackQuality,
  LIMITS.images.maxEncodedBytes,
].join('|')

const parts = new Map<string, ImagePart>()

const cacheKey = (id: string): string => `${id}::${CACHE_SIGNATURE}`

/**
 * 缓存一条编码结果。超出 `cacheEntries` 时按插入顺序淘汰最旧的一条（Map 保序，兼作 LRU 队列）。
 */
export const putImagePart = (id: string, part: ImagePart): void => {
  const key = cacheKey(id)
  parts.delete(key)
  parts.set(key, part)
  while (parts.size > LIMITS.images.cacheEntries) {
    const oldest = parts.keys().next()
    if (oldest.done) {
      break
    }
    parts.delete(oldest.value)
  }
}

/** 取已编码结果：`reply.ts` 拼请求时同步查这一下，没命中就当这张图没有内联形态 */
export const imagePartOf = (id: string): ImagePart | undefined => parts.get(cacheKey(id))

/**
 * 丢掉某一张图的编码产物（#552）：同一批附件换了渠道发（例如先在 base64 渠道选了图、
 * 后来切到按 `file_id` 上传的渠道），此前编好的内联产物就不再代表「发出去的字节」，
 * 留着只会让卡片拿 webp 的体积去描述一次原图上传。**只影响展示用的缓存，不影响任何请求。**
 */
export const dropImagePart = (id: string): void => {
  parts.delete(cacheKey(id))
}

/** 清空缓存（会话删除 / 单测用；编码结果是可重算的派生物，生产不主动清） */
export const clearImageParts = (): void => {
  parts.clear()
}

/** base64 字符串对应的原始字节数（4 字符 = 3 字节，末尾 padding 要扣掉） */
export const imagePartBytes = (part: ImagePart): number => {
  const padding = part.base64.endsWith('==') ? 2 : part.base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((part.base64.length * 3) / 4) - padding)
}

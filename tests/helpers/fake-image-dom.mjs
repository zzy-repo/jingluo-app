// 图片链路的**宿主替身**（`Image` / `canvas` 2D / `FileReader` / `URL.createObjectURL`）。
//
// 为什么需要它：`src/services/attachments/imageSource.ts` 的压缩、尺寸计算、EXIF 校正全都落在
// 「`new Image()` 解码 + `ctx.drawImage` + `canvas.toBlob`」这三步上，裸 Node 一样都没有。
// 但**被测的是它自己的判定逻辑**（阈值触发、长边/像素/面积换算、方向矩阵、阈值回落），
// 不是浏览器的解码器质量 —— 所以这里只在 DOM 边界上换实现，`imageSource.ts` 一行不改。
//
// ## 栅格模型（`FKE1`）
//
// 替身的「像素」是一张 **grid × grid 的采样栅格**（每格一个 RGB），不是完整位图：
// 一张 4000×3000 的图存 4×4 个采样点足够判方向、也足够证明「画到 canvas 上的是哪一块」，
// 而内存是几十字节而不是 36MB。文件里因此带一段测试专用载荷：
//
//   <真实文件头（能被 imageSource 的 magic-bytes/尺寸解析认出来）> + "FKE1" + gridW + gridH + grid 个 RGB
//
// 明确边界：**`FKE1` 是替身自己的格式，不冒充真编码产物**。真实 JPEG/PNG 解码归浏览器，
// 由 #551 的头部解析用例 + 真机/集成层覆盖；这里只负责「按字节喂进去、按协议形状取出来」。
//
// ## 引擎差异（这是本文件存在的第二个理由）
//
// `imageSource.ts` 的方向处理是「先探测引擎会不会自动应用 EXIF，再决定要不要手动转」
// （`probeAutoOrient()`，findings 见 `/root/未分组/exif-orientation-findings.md`）：
// Chrome 81+ / WebView 83 自动转，79 档不转。替身用**同一个开关** `autoOrient` 模拟这两档：
// 打开 = 83 档（`Image` 的 `naturalWidth/Height` 已交换、采样时应用方向矩阵），
// 关闭 = 79 档（原样给存储尺寸，不应用方向）。于是「探测结果」与「引擎实际行为」永远一致，
// 两条分支都能被真实代码走一遍。
//
// 注意 `probeAutoOrient()` 的探测结果在 `imageSource` 里是**模块级缓存**：同一个进程里只探一次。
// 所以「自动档」与「不自动档」必须分成两个用例文件（各自独占进程，见 `tests/run-layer.mjs`
// 的 `UNIT_SOLO`），否则第二个文件会读到第一个文件探到的结论。
/** 采样栅格的魔数（放在真实文件头之后） */
export const FKE_MAGIC = 'FKE1'

/** 四象限颜色：方向一旦转错（90°/180°/镜像），象限排列就变，断言立刻红 */
export const QUADRANTS = {
  tl: [255, 0, 0],
  tr: [0, 255, 0],
  bl: [0, 0, 255],
  br: [255, 255, 0],
}

/**
 * 造一段「存储态」的采样栅格：四个象限各一色。
 * 用象限而不是渐变，是因为方向错误的三种典型形态（双转 90° / 转反 / 少转）都会改变象限排列，
 * 而象限中心点采样对最近邻缩放完全不敏感。
 */
export const quadrantGrid = (gridW, gridH) => {
  const samples = new Uint8Array(gridW * gridH * 3)
  for (let gy = 0; gy < gridH; gy += 1) {
    for (let gx = 0; gx < gridW; gx += 1) {
      const top = gy < gridH / 2
      const left = gx < gridW / 2
      const color = top ? (left ? QUADRANTS.tl : QUADRANTS.tr) : left ? QUADRANTS.bl : QUADRANTS.br
      samples.set(color, (gy * gridW + gx) * 3)
    }
  }
  return samples
}

/** JPEG 的最小可解析骨架：SOI + SOF0（宽高）+ EOI；`sniffImage()` 只认这些字段 */
export const jpegSkeleton = (width, height) => {
  const bytes = new Uint8Array(23)
  bytes.set([0xff, 0xd8], 0)
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 2)
  bytes[7] = (height >> 8) & 0xff
  bytes[8] = height & 0xff
  bytes[9] = (width >> 8) & 0xff
  bytes[10] = width & 0xff
  bytes.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01], 11)
  bytes.set([0xff, 0xd9], 21)
  return bytes
}

/** PNG 的最小可解析骨架：签名 + IHDR（宽高）；`sniffImage()` 读 16/20 处的宽度与高度 */
export const pngSkeleton = (width, height) => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** HEIC 的 `ftyp` 头：白名单之外，`sniffImage()` 必须认不出来 */
export const heicBytes = () => {
  const bytes = new Uint8Array(24)
  bytes.set([0, 0, 0, 0x18], 0)
  bytes.set(Array.from('ftyp', (char) => char.charCodeAt(0)), 4)
  bytes.set(Array.from('heic', (char) => char.charCodeAt(0)), 8)
  bytes.set(Array.from('mif1', (char) => char.charCodeAt(0)), 16)
  return bytes
}

/** 头部 + `FKE1` 载荷（`imageSource.ts` 只看文件头，载荷只有替身的解码器读） */
export const withRaster = (header, gridW, gridH, samples) => {
  const magic = Array.from(FKE_MAGIC, (char) => char.charCodeAt(0))
  const bytes = new Uint8Array(header.length + magic.length + 2 + samples.length)
  bytes.set(header, 0)
  bytes.set(magic, header.length)
  bytes[header.length + magic.length] = gridW
  bytes[header.length + magic.length + 1] = gridH
  bytes.set(samples, header.length + magic.length + 2)
  return bytes
}

/** 从字节里取 `FKE1` 栅格；没有载荷（例如纯骨架）时按「全白」处理 */
export const readRaster = (bytes) => {
  const magic = Array.from(FKE_MAGIC, (char) => char.charCodeAt(0))
  for (let at = 0; at + magic.length + 2 <= bytes.length; at += 1) {
    let hit = true
    for (let i = 0; i < magic.length; i += 1) {
      if (bytes[at + i] !== magic[i]) {
        hit = false
        break
      }
    }
    if (!hit) {
      continue
    }
    const gridW = bytes[at + magic.length]
    const gridH = bytes[at + magic.length + 1]
    const start = at + magic.length + 2
    const samples = bytes.slice(start, start + gridW * gridH * 3)
    if (samples.length !== gridW * gridH * 3) {
      return null
    }
    return { gridW, gridH, samples }
  }
  return null
}

/** 一组采样栅格的某个「象限中心」颜色：方向断言只看这四个点 */
export const quadrantColors = ({ gridW, gridH, samples }) => {
  const at = (gx, gy) => {
    const base = (Math.floor(gy) * gridW + Math.floor(gx)) * 3
    return [samples[base], samples[base + 1], samples[base + 2]]
  }
  return {
    tl: at(gridW / 4, gridH / 4),
    tr: at((gridW * 3) / 4, gridH / 4),
    bl: at(gridW / 4, (gridH * 3) / 4),
    br: at((gridW * 3) / 4, (gridH * 3) / 4),
  }
}

/**
 * 一张「四象限各一色」的存储态图，按 EXIF 方向应有的**显示态**象限排列。
 *
 * 只列本仓用到的两个方向：1（不转）与 6（顺时针 90°）。
 * 方向 6 的矩阵是 `[0,1,-1,0]` + `translate(sourceHeight)`，即
 * `显示(x,y) = 存储(y, 高-1-x)` —— 存储的左下角落到显示的左上角。
 */
export const uprightQuadrants = (orientation, storage = QUADRANTS) => {
  if (orientation === 1) {
    return { tl: storage.tl, tr: storage.tr, bl: storage.bl, br: storage.br }
  }
  if (orientation === 6) {
    return { tl: storage.bl, tr: storage.tl, bl: storage.br, br: storage.tr }
  }
  throw new Error(`uprightQuadrants 只登记了方向 1 / 6，收到 ${orientation}`)
}

// ---------------------------------------------------------------------------
// DOM 替身
// ---------------------------------------------------------------------------

const colorOf = (grid, u, v) => {
  const gx = Math.min(grid.gridW - 1, Math.max(0, Math.floor(u * grid.gridW)))
  const gy = Math.min(grid.gridH - 1, Math.max(0, Math.floor(v * grid.gridH)))
  const base = (gy * grid.gridW + gx) * 3
  return [grid.samples[base], grid.samples[base + 1], grid.samples[base + 2]]
}

/** 显示态归一化坐标 → 存储态归一化坐标（方向 5–8 会转置，2/3/4 会镜像；这里只用得到 5–8 与 6） */
const toStorageUv = (orientation, u, v) => {
  // 方向 5–8 的四条式子由 `ORIENTATION_MATRIX` 反解得到（显示坐标 → 存储坐标）：
  //   5 转置 [0,1,1,0]            → 存储(v, u)
  //   6 顺转 90° [0,1,-1,0] + H    → 存储(v, 1-u)
  //   7 反转 90° [0,-1,-1,0] + H,W → 存储(1-v, 1-u)
  //   8 逆转 90° [0,-1,1,0] + W    → 存储(1-v, u)
  if (orientation === 5) {
    return [v, u]
  }
  if (orientation === 6) {
    return [v, 1 - u]
  }
  if (orientation === 7) {
    return [1 - v, 1 - u]
  }
  if (orientation === 8) {
    return [1 - v, u]
  }
  if (orientation === 2) {
    return [1 - u, v]
  }
  if (orientation === 3) {
    return [1 - u, 1 - v]
  }
  if (orientation === 4) {
    return [u, 1 - v]
  }
  return [u, v]
}

class FakeRaster {
  constructor(bytes, sniffed, autoOrient) {
    this.width = sniffed.width
    this.height = sniffed.height
    this.orientation = sniffed.orientation
    this.autoOrient = autoOrient
    this.grid =
      readRaster(bytes) ??
      { gridW: 2, gridH: 2, samples: quadrantGrid(2, 2) }
    const swap = autoOrient && this.orientation >= 5
    /** 与浏览器一致：自动应用方向的引擎在 `naturalWidth/Height` 上就给出**显示态**尺寸 */
    this.naturalWidth = swap ? this.height : this.width
    this.naturalHeight = swap ? this.width : this.height
  }

  /** 按**显示态**归一化坐标取色（最近邻；canvas 的 drawImage 就是这一手） */
  sample(u, v) {
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) {
      return null
    }
    const [su, sv] = this.autoOrient ? toStorageUv(this.orientation, u, v) : [u, v]
    return colorOf(this.grid, su, sv)
  }
}

/** 一个 canvas 的「绘制记录」：不真存位图，按需采样（见文件头的栅格模型） */
class FakeCanvas {
  constructor(autoOrient) {
    this.width = 300
    this.height = 150
    this.autoOrient = autoOrient
    this.ops = []
    this.transform = [1, 0, 0, 1, 0, 0]
    this.context = new FakeContext(this)
    /** 诊断：用例可以确认「这张图到底有没有进过 canvas」 */
    this.draws = 0
  }

  getContext(type) {
    return type === '2d' ? this.context : null
  }

  /** canvas 上某一点的像素（点坐标，内部取像素中心） */
  sampleAt(x, y) {
    for (let index = this.ops.length - 1; index >= 0; index -= 1) {
      const op = this.ops[index]
      if (op.kind === 'fill') {
        if (x >= op.x && x < op.x + op.w && y >= op.y && y < op.y + op.h) {
          return op.color
        }
        continue
      }
      const [a, b, c, d, e, f] = op.transform
      // 逆变换：显示坐标 → drawImage 的「用户坐标」
      const det = a * d - b * c
      if (!det) {
        continue
      }
      const ux = (d * (x - e) - c * (y - f)) / det
      const uy = (a * (y - f) - b * (x - e)) / det
      const u = (ux - op.x) / op.w
      const v = (uy - op.y) / op.h
      const color = op.source.sample(u, v)
      if (color) {
        return color
      }
    }
    return null
  }

  /** 作为 drawImage 的**源**被采样（`orientCanvas()` 的产物会再画一次） */
  sample(u, v) {
    if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) {
      return null
    }
    return this.sampleAt(u * this.width, v * this.height)
  }

  /** 采样整张 canvas，产出 `FKE1` 栅格（长边最多 32 格，够判方向也够小） */
  raster() {
    const gridW = Math.max(1, Math.min(this.width, 32))
    const gridH = Math.max(1, Math.min(this.height, 32))
    const samples = new Uint8Array(gridW * gridH * 3)
    for (let gy = 0; gy < gridH; gy += 1) {
      for (let gx = 0; gx < gridW; gx += 1) {
        const color =
          this.sampleAt(((gx + 0.5) * this.width) / gridW, ((gy + 0.5) * this.height) / gridH) ??
          [255, 255, 255]
        samples.set(color, (gy * gridW + gx) * 3)
      }
    }
    return { gridW, gridH, samples }
  }

  toBlob(callback, type) {
    const { gridW, gridH, samples } = this.raster()
    const bytes = withRaster(
      jpegSkeleton(this.width, this.height),
      gridW,
      gridH,
      samples
    )
    callback(new Blob([bytes], { type: type || 'image/png' }))
  }
}

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas
    this.fillStyle = '#ffffff'
  }

  fillRect(x, y, w, h) {
    this.canvas.ops.push({ kind: 'fill', x, y, w, h, color: parseColor(this.fillStyle) })
  }

  drawImage(source, x, y, w, h) {
    this.canvas.draws += 1
    this.canvas.ops.push({
      kind: 'draw',
      source,
      x,
      y,
      w: w ?? source.naturalWidth ?? source.width,
      h: h ?? source.naturalHeight ?? source.height,
      transform: this.canvas.transform.slice(),
    })
  }

  setTransform(a, b, c, d, e, f) {
    this.canvas.transform = [a, b, c, d, e, f]
  }

  getImageData(x, y, w, h) {
    const data = new Uint8ClampedArray(w * h * 4)
    for (let py = 0; py < h; py += 1) {
      for (let px = 0; px < w; px += 1) {
        const color = this.canvas.sampleAt(x + px + 0.5, y + py + 0.5) ?? [255, 255, 255]
        const base = (py * w + px) * 4
        data[base] = color[0]
        data[base + 1] = color[1]
        data[base + 2] = color[2]
        data[base + 3] = 255
      }
    }
    return { data, width: w, height: h }
  }
}

const NAMED = {
  '#ffffff': [255, 255, 255],
  '#ff0000': [255, 0, 0],
  '#0000ff': [0, 0, 255],
  '#00ff00': [0, 255, 0],
}

const parseColor = (value) => NAMED[String(value).toLowerCase()] ?? [255, 255, 255]

/**
 * 装好整套替身。
 *
 * @param {{ autoOrient?: boolean }} [options]
 *   `autoOrient: true`（默认）= 83 档：引擎自己应用 EXIF 方向；
 *   `false` = 79 档：引擎不应用，`imageSource` 必须手动校正。
 * @returns {{ autoOrient: boolean, statistics: () => object, restore: () => void }}
 */
export const installFakeImageDom = ({ autoOrient = true } = {}) => {
  const saved = new Map()
  const remember = (key) => {
    saved.set(key, [Object.hasOwn(globalThis, key), globalThis[key]])
  }
  const stats = { decoded: 0, canvases: 0, toBlobs: 0 }

  const objectUrls = new Map()
  let urlSeq = 0

  class FakeImage {
    constructor() {
      this.naturalWidth = 0
      this.naturalHeight = 0
      this.width = 0
      this.height = 0
      this.onload = null
      this.onerror = null
      this._src = ''
    }

    set src(value) {
      this._src = value
      const blob = objectUrls.get(value)
      const decode = async () => {
        try {
          if (!blob) {
            throw new Error(`未注册的 objectURL：${value}`)
          }
          const bytes = new Uint8Array(await blob.arrayBuffer())
          const sniffed = sniffCache().sniffImage(bytes)
          if (!sniffed || !sniffed.width || !sniffed.height) {
            throw new Error('替身解不出来：没有可解析的文件头')
          }
          stats.decoded += 1
          const raster = new FakeRaster(bytes, sniffed, autoOrient)
          this.raster = raster
          this.naturalWidth = raster.naturalWidth
          this.naturalHeight = raster.naturalHeight
          this.width = raster.naturalWidth
          this.height = raster.naturalHeight
          this.onload?.()
        } catch (error) {
          this.onerror?.(error)
        }
      }
      setTimeout(decode, 0)
    }

    get src() {
      return this._src
    }

    sample(u, v) {
      return this.raster ? this.raster.sample(u, v) : null
    }
  }

  const fakeDocument = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
    createElement(tag) {
      if (tag !== 'canvas') {
        throw new Error(`替身只实现 canvas，收到 ${tag}`)
      }
      stats.canvases += 1
      const canvas = new FakeCanvas(autoOrient)
      const toBlob = canvas.toBlob.bind(canvas)
      canvas.toBlob = (callback, type, quality) => {
        stats.toBlobs += 1
        return toBlob(callback, type, quality)
      }
      return canvas
    },
  }

  class FakeFileReader {
    constructor() {
      this.result = ''
      this.onload = null
      this.onerror = null
    }

    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((buffer) => {
          const base64 = Buffer.from(buffer).toString('base64')
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`
          this.onload?.()
        })
        .catch((error) => this.onerror?.(error))
    }
  }

  remember('document')
  remember('Image')
  remember('FileReader')
  remember('URL')
  globalThis.document = fakeDocument
  globalThis.Image = FakeImage
  globalThis.FileReader = FakeFileReader
  /**
   * 只换两个静态方法，`new URL(...)` 照旧能用（`chat-host-stubs` 的 resolve 钩子、
   * `drafts` 的预览地址都依赖它）：替身是 `URL` 的子类，`instanceof URL` 仍然成立。
   */
  const NativeUrl = globalThis.URL
  class FakeUrl extends NativeUrl {}
  FakeUrl.createObjectURL = (blob) => {
    urlSeq += 1
    const url = `blob:fake/${urlSeq}`
    objectUrls.set(url, blob)
    return url
  }
  FakeUrl.revokeObjectURL = (url) => {
    objectUrls.delete(url)
  }
  globalThis.URL = FakeUrl

  return {
    autoOrient,
    statistics: () => ({ ...stats }),
    restore() {
      for (const [key, [existed, value]] of saved) {
        if (existed) {
          globalThis[key] = value
        } else {
          delete globalThis[key]
        }
      }
    },
  }
}

/** `sniffImage` 由被测模块自己提供（替身不重复实现 magic-bytes 判定） */
let sniffModule = null
const sniffCache = () => {
  if (!sniffModule) {
    throw new Error('先 await loadImageSource()，替身要复用被测的 sniffImage()')
  }
  return sniffModule
}

/**
 * 载入被测的 `imageSource.ts`（同时把它的 `sniffImage` 交给替身）。
 * 必须在 `installChatHostStubs()` / `installFakeImageDom()` 之后调用。
 */
export const loadImageSource = async () => {
  sniffModule = await import('../../src/services/attachments/imageSource.ts')
  return sniffModule
}

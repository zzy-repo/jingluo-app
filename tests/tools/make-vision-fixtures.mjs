#!/usr/bin/env node
/**
 * make-vision-fixtures.mjs —— 生成 `tests/fixtures/vision/` 下的图片夹具（#553 验收）。
 *
 * 一次性工具（`tests/tools/` 不参与分层执行）。夹具是**提交进仓库的字节**，这里只是让它们可复现：
 * 改象限颜色 / 尺寸后重跑本脚本即可，别手工改二进制。
 *
 *   node tests/tools/make-vision-fixtures.mjs
 *
 * 为什么这么小：`#553` 的硬要求是「不要放大图进仓库」。这四份加起来不到 1KB ——
 * 它们的用途是**喂字节**（magic bytes / EXIF 方向 / 阈值分支），不是给人看的照片；
 * 真实解码由浏览器负责，替身在 `tests/helpers/fake-image-dom.mjs`（`FKE1` 栅格）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  heicBytes,
  jpegSkeleton,
  pngSkeleton,
  quadrantGrid,
  withRaster,
} from '../helpers/fake-image-dom.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../fixtures/vision')

/** 在 SOI 之后插一个只带 Orientation 的 APP1(Exif) 段（与 `imageSource.ts` 的探针同构） */
const withExifOrientation = (jpeg, orientation) => {
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

/** 四象限 4×4 栅格：够判方向，且方向 6 的转置在 4×4 上仍然整齐 */
const GRID = 4

const fixtures = {
  /** 阈值内的小 PNG：走「原图直发」分支，字节一个不改 */
  'tiny-64x32.png': withRaster(pngSkeleton(64, 32), GRID, GRID, quadrantGrid(GRID, GRID)),
  /** 手机竖拍：存储 4000×3000 + EXIF Orientation=6（显示 3000×4000）→ 必须压缩且方向正确 */
  'exif-orientation-6.jpg': withRaster(
    withExifOrientation(jpegSkeleton(4000, 3000), 6),
    GRID,
    GRID,
    quadrantGrid(GRID, GRID)
  ),
  /** 长边 6000 > 1568 且 2400 万像素 > 1.15MP → 压缩到长边 1568，输出 webp */
  'oversize-6000x4000.jpg': withRaster(
    jpegSkeleton(6000, 4000),
    GRID,
    GRID,
    quadrantGrid(GRID, GRID)
  ),
  /** iPhone 默认格式：白名单之外，必须在入口就明确拒绝 */
  'heic-sample.heic': heicBytes(),
}

await mkdir(OUT, { recursive: true })
let total = 0
for (const [name, bytes] of Object.entries(fixtures)) {
  await writeFile(path.join(OUT, name), bytes)
  total += bytes.length
  console.log(`${name}: ${bytes.length} B`)
}
console.log(`合计 ${total} B → ${path.relative(process.cwd(), OUT)}`)

#!/usr/bin/env node
/**
 * gen-ios-icon.mjs —— 从唯一图标源生成 iOS 那张 1024×1024 的 AppIcon（Issue #873）。
 *
 * 为什么需要脚本而不是「拿 sips 敲一下」：
 *   `cap add ios` 生成的是 **Capacitor 模板图**（md5 与
 *   `node_modules/@capacitor/cli/assets/ios-spm-template.tar.gz` 里的文件字节一致），
 *   装上手机就是 Capacitor 的 logo。换图这件事必须可复现 —— 否则下一次谁再跑一遍
 *   `cap add ios`（换机器 / 重建工程）就又把模板图带回来了，而且没人看得出来。
 *
 * 为什么源图是 `icon-512.png` 而不是 `source.png`（实测，2026-11-26）：
 *   `source.png`（1254×1254）是**带白框的预览图** —— 四角是 (253,253,253) 白、深色圆角方块
 *   外面还有一圈 ~119px 的白边，直接缩放出来的 1024 图四边全是白像素（`pnpm check:icon` 实测
 *   FAIL：四边各 1000+ 个 >245 的白像素），正是 #266 要拦的「图标在启动器/商店里被裁成东西贴边」。
 *   它四角的白是**背景**，不是留白 —— 要把它变成满版，就得自己往角落里补画渐变，那是设计的事。
 *   `icon-512.png` 才是**满版成品**：四角 (108,112,128) 深色、白边像素 0（`pnpm check:icon` 通过），
 *   也是 Android 那套 mipmap 的来源。所以 iOS 这张从它放大得到 —— 同一张画、同一个取景，
 *   两端不会是两种图标。
 *   代价是 2× 放大（512 → 1024），平滑渐变图上几乎看不出来；**等设计给出 1024 满版母版，
 *   把下面的 SRC 指过去重新跑一次即可**（脚本会重新裁白框 + 收正方形）。
 *
 * 判据与产物：
 *   输入  docs/ui/app-icon/icon-512.png（满版成品；改图标只在设计侧改它）
 *   输出  ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *         —— 文件名是 Capacitor/Xcode 模板约定，内容是 1024×1024、RGB 无 alpha
 *         （App Store 拒收带 alpha 的营销图标）、无白边。
 *
 * 零依赖：自己解 PNG（IHDR + IDAT + zlib inflate + unfilter）+ 自己编 PNG
 * （RGB8 + filter 0 + zlib deflate）。和 `scripts/check-icon-edges.mjs` 同一套解码口径，
 * 所以「生成」和「检查」看到的是同一批像素。
 *
 * 用法：
 *   node scripts/gen-ios-icon.mjs            # 生成
 *   node scripts/gen-ios-icon.mjs --dry-run  # 只报裁切框与产物信息，不落盘
 *   pnpm run gen:ios-icon
 *
 * 退出码：0 成功 / 2 源图读不了或形态不支持（隔行 / 调色板 / 16bit）
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'docs', 'ui', 'app-icon', 'icon-512.png')
const OUT = path.join(ROOT, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-512@2x.png')
const SIZE = 1024
/** 与 check-icon-edges.mjs 的白边判据同一个阈值：三通道都 > 245 算白 */
const WHITE = 245

class Unsupported extends Error {}

const decodePng = (buf) => {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) throw new Unsupported('不是 PNG')
  let off = 8
  let ihdr = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] }
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Unsupported('缺少 IHDR')
  if (ihdr.depth !== 8) throw new Unsupported(`只支持 8bit，实际 ${ihdr.depth}`)
  if (ihdr.interlace !== 0) throw new Unsupported('不支持隔行 PNG')
  const ch = ihdr.colorType === 2 ? 3 : ihdr.colorType === 6 ? 4 : 0
  if (!ch) throw new Unsupported(`只支持 RGB/RGBA，实际 colorType=${ihdr.colorType}`)

  const { width, height } = ihdr
  const stride = width * ch
  const raw = inflateSync(Buffer.concat(idat))
  const rgb = Buffer.alloc(width * height * 3)
  const cur = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = raw[pos + x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      cur[x] = v
    }
    pos += stride
    // 落成 RGB（alpha 忽略：源图本来就是满版不透明；带 alpha 的源由下面 bbox 判据兜住）
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 3
      const from = x * ch
      rgb[to] = cur[from]
      rgb[to + 1] = cur[from + 1]
      rgb[to + 2] = cur[from + 2]
    }
    cur.copy(prev)
  }
  return { width, height, rgb }
}

/** 非白像素的包围盒 = 去掉白框后真正要的那块画 */
const contentBox = ({ width, height, rgb }) => {
  const isWhite = (x, y) => {
    const i = (y * width + x) * 3
    return rgb[i] > WHITE && rgb[i + 1] > WHITE && rgb[i + 2] > WHITE
  }
  let top = 0
  let bottom = height - 1
  let left = 0
  let right = width - 1
  const rowWhite = (y) => {
    for (let x = 0; x < width; x += 1) if (!isWhite(x, y)) return false
    return true
  }
  const colWhite = (x) => {
    for (let y = 0; y < height; y += 1) if (!isWhite(x, y)) return false
    return true
  }
  while (top < bottom && rowWhite(top)) top += 1
  while (bottom > top && rowWhite(bottom)) bottom -= 1
  while (left < right && colWhite(left)) left += 1
  while (right > left && colWhite(right)) right -= 1
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1 }
}

/** 双线性重采样（放大/缩小同一套；图标是 1254→1024 这种小比例，够用且无 glibc 依赖） */
const resample = (src, box, size) => {
  const { rgb, width } = src
  const out = Buffer.alloc(size * size * 3)
  const scaleX = box.width / size
  const scaleY = box.height / size
  const at = (x, y, c) => {
    const sx = Math.min(box.width - 1, Math.max(0, x))
    const sy = Math.min(box.height - 1, Math.max(0, y))
    return rgb[((box.top + sy) * width + (box.left + sx)) * 3 + c]
  }
  for (let y = 0; y < size; y += 1) {
    const fy = (y + 0.5) * scaleY - 0.5
    const y0 = Math.floor(fy)
    const wy = fy - y0
    for (let x = 0; x < size; x += 1) {
      const fx = (x + 0.5) * scaleX - 0.5
      const x0 = Math.floor(fx)
      const wx = fx - x0
      const to = (y * size + x) * 3
      for (let c = 0; c < 3; c += 1) {
        const p00 = at(x0, y0, c)
        const p10 = at(x0 + 1, y0, c)
        const p01 = at(x0, y0 + 1, c)
        const p11 = at(x0 + 1, y0 + 1, c)
        const top = p00 + (p10 - p00) * wx
        const bottom = p01 + (p11 - p01) * wx
        out[to + c] = Math.round(top + (bottom - top) * wy)
      }
    }
  }
  return out
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of crcInput) {
    crc ^= byte
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([head, data, tail])
}

/** RGB8 + 每行 filter 0（图标体积不敏感，换来「编码器没有 bug 面」） */
const encodePng = (rgb, size) => {
  const stride = size * 3
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colorType: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const main = (argv) => {
  let src
  try {
    src = decodePng(readFileSync(SRC))
  } catch (error) {
    console.error(`[gen:ios-icon] 读不了源图 ${path.relative(ROOT, SRC)}：${error.message}`)
    return 2
  }

  const box = contentBox(src)
  // 源图若带白框，左右/上下的白框宽度不会完全相等（实测 source.png 四边 118~121px），
  // 包围盒就会比正方形差几个像素。这里按短边居中收成正方形而不是横向拉伸：0.3% 的拉伸看不出来，
  // 但「我悄悄改了图的比例」是以后最说不清的一件事。超出 1% 就不是抗锯齿误差了 —— 那要人回去改源图。
  const side = Math.min(box.width, box.height)
  const skew = Math.abs(box.width - box.height) / Math.max(box.width, box.height)
  if (skew > 0.01) {
    console.error(
      `[gen:ios-icon] 源图去掉白框后不是正方形（${box.width}×${box.height}，差 ${(skew * 100).toFixed(1)}%）—— ` +
        'iOS 的 AppIcon 必须是正方形，先改源图，别在这里拉伸。',
    )
    return 2
  }
  const square = {
    left: box.left + Math.floor((box.width - side) / 2),
    top: box.top + Math.floor((box.height - side) / 2),
    width: side,
    height: side,
  }

  const png = encodePng(resample(src, square, SIZE), SIZE)
  const relOut = path.relative(ROOT, OUT).replace(/\\/g, '/')
  console.log(
    `[gen:ios-icon] 源 ${path.relative(ROOT, SRC).replace(/\\/g, '/')} ${src.width}×${src.height}` +
      ` → 裁掉白框 (left ${box.left} / top ${box.top} / ${box.width}×${box.height})` +
      ` → 收成正方形 ${side}×${side}` +
      ` → ${SIZE}×${SIZE} RGB（无 alpha）`,
  )
  if (argv.includes('--dry-run')) {
    console.log(`[gen:ios-icon] --dry-run：未落盘（本会写 ${relOut}，${Math.round(png.length / 1024)} KiB）`)
    return 0
  }
  writeFileSync(OUT, png)
  console.log(`[gen:ios-icon] 已写入 ${relOut}（${Math.round(png.length / 1024)} KiB）—— 跑 pnpm check:icon 复核白边`)
  return 0
}

process.exitCode = main(process.argv.slice(2))

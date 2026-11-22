import { deflateSync } from 'node:zlib'

/** 极简 PNG 编码器：只为造「长边 ≥4000px」的真图，不引入依赖。
 *  用平滑渐变（压缩后不大），长边 4000 > LIMITS.images.maxEdge(1568) → 必然走压缩分支。 */
const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** width/height 为像素；返回 RGB8 PNG */
export const makePng = (width, height) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  const rowBytes = width * 3 + 1
  const raw = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y += 1) {
    const off = y * rowBytes
    raw[off] = 0 // filter: none
    const g = Math.round((y / height) * 255)
    for (let x = 0; x < width; x += 1) {
      const p = off + 1 + x * 3
      raw[p] = Math.round((x / width) * 255)
      raw[p + 1] = g
      raw[p + 2] = 160
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

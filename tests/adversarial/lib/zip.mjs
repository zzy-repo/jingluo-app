// 手工拼 ZIP：要能控制条目物理顺序、中央目录顺序、原始文件名字节、重复条目、声明尺寸/CRC 与截断位置。
// fflate 的 zipSync 做不到这些（它会规范化文件名、去重、按自己的顺序写），所以这里自己写字节。
import { crc32, deflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
export const FLAG_UTF8 = 0x800

const encoder = new TextEncoder()

const bytesOf = (value) => (value instanceof Uint8Array ? value : encoder.encode(String(value)))

const little = (value, width) => {
  const out = new Uint8Array(width)
  let rest = value
  for (let index = 0; index < width; index += 1) {
    out[index] = rest & 0xff
    rest = Math.floor(rest / 256)
  }
  return out
}

const writer = () => {
  const parts = []
  let size = 0
  return {
    push(chunk) {
      parts.push(chunk)
      size += chunk.length
      return size - chunk.length
    },
    get size() {
      return size
    },
    concat() {
      const out = new Uint8Array(size)
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.length
      }
      return out
    },
  }
}

/**
 * 造一个 ZIP。
 * entry 字段：
 *   name            条目名（string 或原始 Uint8Array）
 *   data            内容（string / Uint8Array / 省略 = 目录或空文件）
 *   compress        true = deflate 压缩（method 8）
 *   flags           覆盖本地头与中央目录的 flag 位（默认按 utf8 决定是否带 0x800）
 *   utf8            false = 不带 UTF-8 标志位（用于造「非 UTF-8 文件名」）
 *   local/central   覆盖两处头部里的版本号等（一般不用）
 *   declaredSize    中央目录里声明的解压后大小（默认真实大小）
 *   declaredPacked  中央目录里声明的压缩后大小（默认真实大小）
 *   declaredCrc     覆盖 CRC
 *   external        外部属性（默认 0；0xa000 高位会被识别成符号链接）
 *   centralOrder    数字，越小排中央目录里越靠前（默认同物理顺序）
 *   skipLocal       true = 只写中央目录条目、不写本地头（造「中央目录指向不存在的本地头」）
 * comment           ZIP 尾部注释
 */
export const buildZip = (entries, { comment = null } = {}) => {
  const out = writer()
  const central = []
  entries.forEach((spec, position) => {
    const name = bytesOf(spec.name)
    const isDir = spec.dir === true || (spec.data === undefined && name[name.length - 1] === 0x2f)
    const raw = spec.data === undefined ? new Uint8Array(0) : bytesOf(spec.data)
    const compress = spec.compress === true || spec.method === 8
    const packed = compress ? new Uint8Array(deflateRawSync(raw, { level: spec.level ?? 9 })) : raw
    const method = compress ? 8 : 0
    const utf8 = spec.utf8 !== false
    const flags = spec.flags ?? (utf8 ? FLAG_UTF8 : 0)
    const crc = spec.declaredCrc ?? crc32(raw)
    const realSize = spec.declaredSize ?? raw.length
    const realPacked = spec.declaredPacked ?? packed.length
    const offset = spec.skipLocal === true ? 0 : out.size
    if (spec.skipLocal !== true) {
      out.push(little(SIG_LOCAL, 4))
      out.push(little(spec.versionNeeded ?? 20, 2))
      out.push(little(flags, 2))
      out.push(little(method, 2))
      out.push(little(0, 2)) // 时间
      out.push(little(0x21, 2)) // 日期
      out.push(little(crc, 4))
      out.push(little(realPacked, 4))
      out.push(little(realSize, 4))
      out.push(little(name.length, 2))
      out.push(little(0, 2))
      out.push(name)
      out.push(packed)
    }
    central.push({
      name,
      flags,
      method,
      crc,
      realPacked,
      realSize,
      offset,
      external: spec.external ?? (isDir ? 0x10 : 0),
      order: spec.centralOrder ?? position,
    })
  })

  const directory = writer()
  for (const item of [...central].sort((a, b) => a.order - b.order)) {
    directory.push(little(SIG_CENTRAL, 4))
    directory.push(little(20, 2)) // version made by
    directory.push(little(20, 2)) // version needed
    directory.push(little(item.flags, 2))
    directory.push(little(item.method, 2))
    directory.push(little(0, 2)) // 时间
    directory.push(little(0x21, 2)) // 日期
    directory.push(little(item.crc, 4))
    directory.push(little(item.realPacked, 4))
    directory.push(little(item.realSize, 4))
    directory.push(little(item.name.length, 2))
    directory.push(little(0, 2)) // extra
    directory.push(little(0, 2)) // comment
    directory.push(little(0, 2)) // disk start
    directory.push(little(0, 2)) // internal attrs
    directory.push(little(item.external, 4))
    directory.push(little(item.offset, 4))
    directory.push(item.name)
  }
  const cdOffset = out.size
  const cdBytes = directory.concat()
  out.push(cdBytes)

  const tail = bytesOf(comment ?? '')
  out.push(little(SIG_EOCD, 4))
  out.push(little(0, 2))
  out.push(little(0, 2))
  out.push(little(central.length, 2))
  out.push(little(central.length, 2))
  out.push(little(cdBytes.length, 4))
  out.push(little(cdOffset, 4))
  out.push(little(tail.length, 2))
  out.push(tail)
  return out.concat()
}

/** 截掉末尾 n 字节，用于造「文件被截断」。 */
export const truncate = (bytes, cut) => bytes.slice(0, Math.max(0, bytes.length - cut))

/** 翻转第 offset 个字节，用于造 CRC 不匹配。 */
export const flipByte = (bytes, offset) => {
  const copy = new Uint8Array(bytes)
  copy[offset] = copy[offset] ^ 0xff
  return copy
}

/** 在字节流里找子串位置（找不到 -1）。 */
export const findBytes = (haystack, needle) => {
  const target = bytesOf(needle)
  outer: for (let start = 0; start + target.length <= haystack.length; start += 1) {
    for (let index = 0; index < target.length; index += 1) {
      if (haystack[start + index] !== target[index]) {
        continue outer
      }
    }
    return start
  }
  return -1
}

/** 造 UTF-16LE 编码的文件名字节（不带 BOM），用于验证「非 UTF-8 文件名」被拒。 */
export const utf16le = (text) => {
  const out = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    out[index * 2] = code & 0xff
    out[index * 2 + 1] = code >> 8
  }
  return out
}

export const utf8WithBom = (text) => {
  const body = encoder.encode(text)
  const out = new Uint8Array(body.length + 3)
  out.set([0xef, 0xbb, 0xbf])
  out.set(body, 3)
  return out
}

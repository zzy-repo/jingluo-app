/**
 * 迁移用的规范化内容哈希（#910）。
 *
 * 口径：对 IndexedDB 里的**原值**生成与具体后端无关的 sha256。校验器用它比较源与目标：
 *  - 对象键排序后序列化；数组保序；
 *  - Blob 比「类型 + 字节数 + 字节 sha256」；ArrayBuffer / Uint8Array 比字节 sha256；
 *  - Date / NaN / ±Infinity / -0 / bigint / null 都带类型标签，所以 `Date` 被悄悄变成字符串会被抓到；
 *  - 对象属性值为 `undefined` 视为「没有这个属性」（JSON / 列映射本来就无法保留它，两者在读取方看来等价）；
 *    数组元素与顶层值为 `undefined` 则带标签；
 *  - 不认识的值类型（函数、symbol、Map、类实例、环）直接抛错，不猜。
 *
 * 浏览器与 Node 都能跑：不 import 任何 `node:*`。小块走 `crypto.subtle`，大 Blob 走本文件的增量 SHA-256
 * （`crypto.subtle.digest` 没有流式接口，100MB 级的原件不能整块读进内存）。
 */
import { RAW_STORE_NAMES, type RawRow, type RawStoreName, type RawStoreSource } from './types.js'

// ---------------------------------------------------------------- 增量 SHA-256

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0')
  }
  return out
}

/** 增量 SHA-256（纯 JS）。`update` 可多次调用，`digestHex` 只能调用一次。 */
export class Sha256Stream {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private readonly schedule = new Uint32Array(64)
  private blockLength = 0
  private total = 0
  private finished = false

  update(data: Uint8Array): this {
    if (this.finished) {
      throw new Error('Sha256Stream: already finalized')
    }
    this.total += data.length
    this.feed(data)
    return this
  }

  private feed(data: Uint8Array): void {
    let offset = 0
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.length)
      this.block.set(data.subarray(0, take), this.blockLength)
      this.blockLength += take
      offset = take
      if (this.blockLength === 64) {
        this.compress(this.block, 0)
        this.blockLength = 0
      }
    }
    while (offset + 64 <= data.length) {
      this.compress(data, offset)
      offset += 64
    }
    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0)
      this.blockLength = data.length - offset
    }
  }

  digestHex(): string {
    if (this.finished) {
      throw new Error('Sha256Stream: already finalized')
    }
    this.finished = true
    const bitsHigh = Math.floor((this.total * 8) / 0x100000000)
    const bitsLow = (this.total * 8) >>> 0
    const padLength = this.blockLength < 56 ? 56 - this.blockLength : 120 - this.blockLength
    const tail = new Uint8Array(padLength + 8)
    tail[0] = 0x80
    const view = new DataView(tail.buffer)
    view.setUint32(padLength, bitsHigh)
    view.setUint32(padLength + 4, bitsLow)
    this.feed(tail) // 补位不计入总长度
    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, this.state[i] as number)
    }
    return toHex(out)
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.schedule
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4
      w[i] =
        ((data[o] as number) << 24) |
        ((data[o + 1] as number) << 16) |
        ((data[o + 2] as number) << 8) |
        (data[o + 3] as number)
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number
      const w2 = w[i - 2] as number
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0
    }
    const s = this.state
    let a = s[0] as number
    let b = s[1] as number
    let c = s[2] as number
    let d = s[3] as number
    let e = s[4] as number
    let f = s[5] as number
    let g = s[6] as number
    let h = s[7] as number
    for (let i = 0; i < 64; i++) {
      const t1 =
        (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K[i] as number) + (w[i] as number)) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    s[0] = ((s[0] as number) + a) | 0
    s[1] = ((s[1] as number) + b) | 0
    s[2] = ((s[2] as number) + c) | 0
    s[3] = ((s[3] as number) + d) | 0
    s[4] = ((s[4] as number) + e) | 0
    s[5] = ((s[5] as number) + f) | 0
    s[6] = ((s[6] as number) + g) | 0
    s[7] = ((s[7] as number) + h) | 0
  }
}

// ---------------------------------------------------------------- 字节与 Blob

const encoder = new TextEncoder()

type SubtleLike = { digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer> }

const subtleOf = (): SubtleLike | undefined =>
  (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle

/** 字节的 sha256（十六进制）。优先 `crypto.subtle`，宿主没有时回落到本文件的纯 JS 实现。 */
export const sha256HexOfBytes = async (bytes: Uint8Array): Promise<string> => {
  const subtle = subtleOf()
  if (subtle) {
    return toHex(new Uint8Array(await subtle.digest('SHA-256', bytes as unknown as BufferSource)))
  }
  return new Sha256Stream().update(bytes).digestHex()
}

/** Blob 一次读进内存的上限：更大的原件按片读取，增量哈希，不占满内存。 */
const BLOB_CHUNK_BYTES = 1 << 20

const readBlobBytes = (blob: Blob): Promise<Uint8Array> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  }
  // 老 WebView 的 Blob 没有 arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsArrayBuffer(blob)
  })
}

/** Blob 内容的 sha256：按 1MiB 片读取并增量哈希；读到的总长度与 `size` 不符就抛错（不返回一个看似正常的哈希）。 */
export const sha256HexOfBlob = async (blob: Blob): Promise<string> => {
  const size = blob.size
  if (size <= BLOB_CHUNK_BYTES) {
    const bytes = await readBlobBytes(blob)
    if (bytes.length !== size) {
      throw new Error(`Blob read ${bytes.length} bytes but size is ${size}`)
    }
    return sha256HexOfBytes(bytes)
  }
  const stream = new Sha256Stream()
  let read = 0
  for (let offset = 0; offset < size; offset += BLOB_CHUNK_BYTES) {
    const bytes = await readBlobBytes(blob.slice(offset, Math.min(size, offset + BLOB_CHUNK_BYTES)))
    read += bytes.length
    stream.update(bytes)
  }
  if (read !== size) {
    throw new Error(`Blob read ${read} bytes but size is ${size}`)
  }
  return stream.digestHex()
}

// ---------------------------------------------------------------- 规范化序列化

const tagOf = (value: object): string => Object.prototype.toString.call(value).slice(8, -1)

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === null || Object.getPrototypeOf(proto) === null
}

const numberToken = (value: number): string => {
  if (Object.is(value, -0)) {
    return '-0'
  }
  return String(value) // NaN / Infinity / -Infinity 也各有固定字面量
}

const canonicalize = async (value: unknown, out: string[], path: unknown[]): Promise<void> => {
  if (value === null) {
    out.push('n')
    return
  }
  switch (typeof value) {
    case 'undefined':
      out.push('u')
      return
    case 'boolean':
      out.push(value ? 'T' : 'F')
      return
    case 'number':
      out.push(`d${numberToken(value)}`)
      return
    case 'bigint':
      out.push(`i${value.toString()}`)
      return
    case 'string':
      out.push(`s${JSON.stringify(value)}`)
      return
    case 'function':
    case 'symbol':
      throw new Error(`hash: unsupported value type ${typeof value}`)
    default:
      break
  }
  const object = value as object
  if (path.includes(object)) {
    throw new Error('hash: circular reference')
  }
  const tag = tagOf(object)
  if (tag === 'Date') {
    out.push(`D${numberToken((object as Date).getTime())}`)
    return
  }
  if (tag === 'Blob' || tag === 'File') {
    const blob = object as Blob
    const file = tag === 'File' ? (object as File) : undefined
    const head = file ? `F${JSON.stringify(file.name)}:${numberToken(file.lastModified)}:` : 'B'
    out.push(`${head}${JSON.stringify(blob.type)}:${blob.size}:${await sha256HexOfBlob(blob)}`)
    return
  }
  if (tag === 'ArrayBuffer') {
    const bytes = new Uint8Array(object as ArrayBuffer)
    out.push(`A${bytes.length}:${await sha256HexOfBytes(bytes)}`)
    return
  }
  if (ArrayBuffer.isView(object)) {
    const view = object as ArrayBufferView
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    out.push(`V${tag}:${bytes.length}:${await sha256HexOfBytes(bytes)}`)
    return
  }
  if (Array.isArray(object)) {
    path.push(object)
    out.push('[')
    for (let i = 0; i < object.length; i++) {
      if (i > 0) {
        out.push(',')
      }
      await canonicalize(object[i], out, path)
    }
    out.push(']')
    path.pop()
    return
  }
  if (tag === 'Object' && isPlainObject(object)) {
    path.push(object)
    out.push('{')
    const record = object as Record<string, unknown>
    let first = true
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) {
        continue // 属性值为 undefined ≡ 没有该属性
      }
      if (!first) {
        out.push(',')
      }
      first = false
      out.push(`${JSON.stringify(key)}:`)
      await canonicalize(item, out, path)
    }
    out.push('}')
    path.pop()
    return
  }
  throw new Error(`hash: unsupported value type ${tag}`)
}

/** 一个值的规范化序列化文本（Blob / 二进制只含其字节哈希）。不认识的类型抛错。 */
export const canonicalText = async (value: unknown): Promise<string> => {
  const out: string[] = []
  await canonicalize(value, out, [])
  return out.join('')
}

/** 规范化内容哈希：与具体后端无关，键顺序无关，Blob 比字节。 */
export const hashValue = async (value: unknown): Promise<string> =>
  sha256HexOfBytes(encoder.encode(await canonicalText(value)))

/** 一行的内容哈希（含主键）。 */
export const hashRow = (row: RawRow): Promise<string> => hashValue(['row', row.key, row.value])

// ---------------------------------------------------------------- 体积估算（宁高勿低）

const utf8Bytes = (text: string): number => {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // 代理对的两个码元各记 2，合计 4（正好等于 UTF-8 的 4 字节）；孤立代理按 3 字节的替换字符上界
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdfff ? 2 : 3
  }
  return bytes
}

/** 每个属性 / 元素额外记的结构开销（JSON 引号、冒号、逗号、列映射的行头）。 */
const NODE_OVERHEAD = 8

/**
 * 二进制值**过桥时**的体积（#940 实测）：二进制不能直接塞进 JSON，桥把它编成 base64
 * （`{$b64: "…"}`），体积放大到 4/3 —— 一个 4 MiB 的 Blob 过桥实得 5592458 字节，
 * 按 `blob.size` 估只有 4194478，差 25%。
 * 分批预算要管的是「这一批真正压在 WebView / 原生堆上多少」，所以按过桥形态估。
 */
const bridgeBinaryBytes = (raw: number): number => 4 * Math.ceil(raw / 3)

/** 一个值落盘后大约占多少字节。不抛错（不认识的类型按 64 字节记）；Blob 记其 `size`，不读内容。 */
export const estimateValueBytes = (value: unknown, seen: WeakSet<object> = new WeakSet()): number => {
  if (value === null || value === undefined) {
    return 4
  }
  switch (typeof value) {
    case 'string':
      return utf8Bytes(value) + 2
    case 'number':
    case 'bigint':
      return 24
    case 'boolean':
      return 5
    case 'object':
      break
    default:
      return 64
  }
  const object = value as object
  if (seen.has(object)) {
    return 0
  }
  seen.add(object)
  const tag = tagOf(object)
  if (tag === 'Blob' || tag === 'File') {
    return bridgeBinaryBytes((object as Blob).size) + 64
  }
  if (tag === 'ArrayBuffer') {
    return bridgeBinaryBytes((object as ArrayBuffer).byteLength) + 16
  }
  if (ArrayBuffer.isView(object)) {
    return bridgeBinaryBytes(object.byteLength) + 16
  }
  if (tag === 'Date') {
    return 32
  }
  if (Array.isArray(object)) {
    let total = 2
    for (const item of object) {
      total += estimateValueBytes(item, seen) + NODE_OVERHEAD
    }
    return total
  }
  if (tag === 'Object') {
    let total = 2
    for (const [key, item] of Object.entries(object as Record<string, unknown>)) {
      total += utf8Bytes(key) + 2 + estimateValueBytes(item, seen) + NODE_OVERHEAD
    }
    return total
  }
  return 64
}

export const estimateRowBytes = (row: RawRow): number => utf8Bytes(row.key) + 32 + estimateValueBytes(row.value)

// ---------------------------------------------------------------- 扫描与源指纹

/** 值里带 Blob 的 store：一页只取很少几行（Blob 虽是句柄，但目标端读取时会占内存）。 */
export const BLOB_STORES: ReadonlySet<RawStoreName> = new Set<RawStoreName>(['files', 'filesStaging', 'appAssets'])

export const BLOB_PAGE_ROWS = 8

/** 一页最多读几行：Blob store 封顶 `BLOB_PAGE_ROWS`，其余按 `base`。 */
export const pageLimitFor = (store: RawStoreName, base: number): number =>
  BLOB_STORES.has(store) ? Math.min(base, BLOB_PAGE_ROWS) : Math.max(1, Math.floor(base))

export const abortError = (signal?: AbortSignal): Error => {
  const reason = (signal as { reason?: unknown } | undefined)?.reason
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error('Migration aborted')
  error.name = 'AbortError'
  return error
}

/** 按主键升序逐页扫描一个 store；`after` 之后开始。回调抛错 / 源读取抛错都原样向上抛。 */
export const scanStore = async (
  source: RawStoreSource,
  store: RawStoreName,
  options: { limit: number; after?: string; signal?: AbortSignal },
  onRow: (row: RawRow) => Promise<void> | void
): Promise<void> => {
  let after = options.after
  for (;;) {
    if (options.signal?.aborted) {
      throw abortError(options.signal)
    }
    const page = await source.readBatch(store, after, options.limit)
    for (const row of page.rows) {
      await onRow(row)
    }
    if (page.next === undefined || page.rows.length === 0) {
      return
    }
    if (page.next === after) {
      throw new Error(`readBatch(${store}) did not advance past ${JSON.stringify(after)}`)
    }
    after = page.next
  }
}

/**
 * 源指纹：各 store 的计数 + 主键集合哈希。断点续迁时重算并与开始时比对，变了判 `source-changed`。
 * 只依赖键，不含内容：用户在迁移间隙改了某条会话的内容、但键集合不变时不会触发。
 * 内容层面的差异由复制后的全量校验兜底。
 */
export const fingerprintSource = async (
  source: RawStoreSource,
  options: { signal?: AbortSignal; pageRows?: number } = {}
): Promise<string> => {
  const lines: string[] = []
  for (const store of RAW_STORE_NAMES) {
    const count = await source.count(store)
    const keys = new Sha256Stream()
    let counted = 0
    await scanStore(
      source,
      store,
      { limit: pageLimitFor(store, options.pageRows ?? 200), signal: options.signal },
      (row) => {
        counted += 1
        keys.update(encoder.encode(`${row.key.length}:${row.key}`))
      }
    )
    lines.push(`${store}|${count}|${counted}|${keys.digestHex()}`)
  }
  return `fp1:${await sha256HexOfBytes(encoder.encode(lines.join('\n')))}`
}

/**
 * IDB 原值 ↔ SQLite `doc` 文本的无损编码（#910，设计见 `docs/sqlite-schema.md` §4）。
 *
 * 目标：`decodeDoc(encodeDoc(v).json, …)` 与 `v` 在结构化克隆的意义上相等
 * （含 `undefined` 值的键、稀疏数组的洞、`Date`、`Map`/`Set`、二进制、`NaN`、`-0`）。
 * 不认识的类型抛 `SqliteCodecError`（名字是 `DataCloneError`，于是 `classifyStorageFailure` 判成 `clone`，
 * `SessionRepo.save` 的「剔字段重试」自愈照常工作），**绝不静默丢**。
 *
 * Blob 不进 JSON：编码时收进 `blobs` 列表，`doc` 里只留 `{"$t":"blob","slot":n,…}`；
 * 字节由 `repos/blobStore.ts` 写进分块表。
 *
 * 纯函数，不碰数据库，不 import 任何 UI / 状态库。
 */

export class SqliteCodecError extends Error {
  /** 与 IDB 的克隆失败同名：`classifyStorageFailure` 只认 `name` */
  override readonly name = 'DataCloneError'
  readonly path: string

  constructor(message: string, path: string) {
    super(`${message}（路径 ${path || '<root>'}）`)
    this.path = path
  }
}

/** 一个被抽出 JSON 的 Blob/File：`slot` 是它在本行里的序号。 */
export type EncodedBlob = { slot: number; blob: Blob }

export type EncodeResult = { json: string; blobs: EncodedBlob[] }

const TAG = '$t'

const TYPED_ARRAYS = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
} as const
type TypedArrayName = keyof typeof TYPED_ARRAYS
const isTypedArrayName = (name: string): name is TypedArrayName => Object.hasOwn(TYPED_ARRAYS, name)

// ---------------------------------------------------------------- base64（不依赖 btoa/Buffer，WebView 通用）

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i += 1) {
    table[B64.charCodeAt(i)] = i
  }
  return table
})()

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += B64[(triple >> 18) & 63]
    out += B64[(triple >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(triple >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[triple & 63] : '='
  }
  return out
}

export const base64ToBytes = (text: string): Uint8Array => {
  if (text.length % 4 !== 0) {
    throw new SqliteCodecError('base64 长度不是 4 的倍数', '')
  }
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const out = new Uint8Array((text.length / 4) * 3 - padding)
  let o = 0
  for (let i = 0; i < text.length; i += 4) {
    let triple = 0
    for (let j = 0; j < 4; j += 1) {
      const ch = text.charCodeAt(i + j)
      const isPad = ch === 61
      const value = isPad ? 0 : ch < 128 ? (B64_LOOKUP[ch] ?? -1) : -1
      if (value < 0 || (isPad && i + j < text.length - padding)) {
        throw new SqliteCodecError('base64 含非法字符', '')
      }
      triple = (triple << 6) | value
    }
    if (o < out.length) {out[o++] = (triple >> 16) & 255}
    if (o < out.length) {out[o++] = (triple >> 8) & 255}
    if (o < out.length) {out[o++] = triple & 255}
  }
  return out
}

// ---------------------------------------------------------------- 键编码（UTF-16BE BLOB）

/**
 * 主键与「按值等值/排序」的派生列一律存 **UTF-16BE 字节的 BLOB**，不存 TEXT。三个原因（都有实测）：
 *  1. NUL：SQLite 的 TEXT 经 C 字符串接口会在 U+0000 处截断（`'id\0x'` 与 `'id\0y'` 并成 `'id'`）；
 *  2. 孤立代理项：UTF-8 编不出来，被替换成 U+FFFD（`'a\uD800b'` 与 `'a\uDC00b'` 撞成一行）；
 *  3. 排序：TEXT 按 UTF-8 字节序（= 码点序）比较，JS / IDB 按 UTF-16 码元序，
 *     二者在「增补平面字符 vs U+E000–U+FFFF」上相反（`'～'` 与 `'😀'`）。
 * BLOB 按 memcmp 比较，UTF-16BE 的 memcmp 序**恰好等于** JS 字符串的 `<` 序，且任何码元序列（含孤立代理项、NUL）
 * 都可逆。所以 `ORDER BY k` / `WHERE k > ?` 与 IDB 的主键升序、引擎按 JS 序记录的检查点完全一致。
 */
export const encodeKey = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length * 2)
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    out[i * 2] = unit >>> 8
    out[i * 2 + 1] = unit & 0xff
  }
  return out
}

export const decodeKey = (bytes: Uint8Array): string => {
  if (bytes.length % 2 !== 0) {
    throw new SqliteCodecError('键的字节数不是偶数，不是 UTF-16BE', '')
  }
  const CHUNK = 4096
  let out = ''
  for (let start = 0; start < bytes.length; start += CHUNK * 2) {
    const end = Math.min(bytes.length, start + CHUNK * 2)
    const units: number[] = []
    for (let i = start; i < end; i += 2) {
      units.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
    }
    out += String.fromCharCode(...units)
  }
  return out
}

/** 绑定参数里把可空的键值编码（`undefined`/`null` → `null`）。 */
export const keyParam = (value: string | undefined | null): Uint8Array | null =>
  value === undefined || value === null ? null : encodeKey(value)

// ---------------------------------------------------------------- 编码

const tagOf = (value: unknown): string => Object.prototype.toString.call(value).slice(8, -1)

const isBlobLike = (value: unknown): value is Blob => {
  const tag = tagOf(value)
  return (
    (tag === 'Blob' || tag === 'File') &&
    typeof (value as Blob).size === 'number' &&
    typeof (value as Blob).arrayBuffer === 'function'
  )
}

const copyBytes = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))

/**
 * 把原值编码成 `doc` 文本。`allowBlobs=false` 时遇到 Blob 抛错（只有 `files` / `filesStaging` / `appAssets`
 * 三张表有二进制字段，其它表出现 Blob 说明数据形状不对，不能悄悄吞掉）。
 */
export const encodeDoc = (value: unknown, options: { allowBlobs: boolean }): EncodeResult => {
  const blobs: EncodedBlob[] = []
  const stack = new Set<object>()

  const walk = (current: unknown, path: string): unknown => {
    switch (typeof current) {
      case 'string':
      case 'boolean':
        return current
      case 'undefined':
        return { [TAG]: 'undefined' }
      case 'number':
        if (Number.isNaN(current)) {return { [TAG]: 'nan' }}
        if (current === Infinity) {return { [TAG]: 'inf', v: 1 }}
        if (current === -Infinity) {return { [TAG]: 'inf', v: -1 }}
        if (Object.is(current, -0)) {return { [TAG]: 'negzero' }}
        return current
      case 'bigint':
        return { [TAG]: 'bigint', v: current.toString() }
      case 'function':
      case 'symbol':
        throw new SqliteCodecError(`不可克隆的值（${typeof current}）`, path)
      default:
        break
    }
    if (current === null) {return null}
    const object = current as object
    if (stack.has(object)) {
      throw new SqliteCodecError('循环引用', path)
    }
    const tag = tagOf(object)
    if (isBlobLike(object)) {
      if (!options.allowBlobs) {
        throw new SqliteCodecError('该表不允许出现 Blob', path)
      }
      const slot = blobs.length
      blobs.push({ slot, blob: object })
      const encoded: Record<string, unknown> = { [TAG]: 'blob', slot, mime: object.type, size: object.size }
      if (tag === 'File') {
        encoded.file = { name: (object as File).name, lastModified: (object as File).lastModified }
      }
      return encoded
    }
    if (tag === 'Date') {
      const time = (object as Date).getTime()
      return { [TAG]: 'date', v: Number.isNaN(time) ? null : time }
    }
    if (tag === 'RegExp') {
      return { [TAG]: 're', s: (object as RegExp).source, f: (object as RegExp).flags }
    }
    if (tag === 'ArrayBuffer') {
      return { [TAG]: 'ab', v: bytesToBase64(new Uint8Array((object as ArrayBuffer).slice(0))) }
    }
    if (ArrayBuffer.isView(object)) {
      const name = tag
      if (name === 'DataView') {
        return { [TAG]: 'dv', v: bytesToBase64(copyBytes(object)) }
      }
      if (!isTypedArrayName(name)) {
        throw new SqliteCodecError(`不支持的二进制视图 ${name}`, path)
      }
      return { [TAG]: 'ta', c: name, v: bytesToBase64(copyBytes(object)) }
    }
    stack.add(object)
    try {
      if (Array.isArray(object)) {
        const out: unknown[] = []
        for (let i = 0; i < object.length; i += 1) {
          out.push(i in object ? walk(object[i], `${path}[${i}]`) : { [TAG]: 'hole' })
        }
        return out
      }
      if (tag === 'Map') {
        const entries: unknown[] = []
        let i = 0
        for (const [k, v] of object as Map<unknown, unknown>) {
          entries.push([walk(k, `${path}.<key ${i}>`), walk(v, `${path}.<value ${i}>`)])
          i += 1
        }
        return { [TAG]: 'map', v: entries }
      }
      if (tag === 'Set') {
        const items: unknown[] = []
        let i = 0
        for (const item of object as Set<unknown>) {
          items.push(walk(item, `${path}.<item ${i}>`))
          i += 1
        }
        return { [TAG]: 'set', v: items }
      }
      // 与结构化克隆一致：普通对象与「带原型的类实例」都只取自有可枚举字符串键
      if (tag !== 'Object') {
        throw new SqliteCodecError(`不可克隆的对象（${tag}）`, path)
      }
      const keys = Object.keys(object)
      const members: [string, unknown][] = keys.map((key) => [
        key,
        walk((object as Record<string, unknown>)[key], path === '' ? key : `${path}.${key}`),
      ])
      if (keys.includes(TAG)) {
        // 数据里恰好有 `$t` 键：整个对象转义成键值对列表，避免被当成类型标签
        return { [TAG]: 'obj', v: members }
      }
      const out: Record<string, unknown> = {}
      for (const [key, member] of members) {
        Object.defineProperty(out, key, { value: member, enumerable: true, writable: true, configurable: true })
      }
      return out
    } finally {
      stack.delete(object)
    }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value) || tagOf(value) !== 'Object') {
    throw new SqliteCodecError('行值必须是普通对象', '')
  }
  const json = JSON.stringify(walk(value, ''))
  return { json, blobs }
}

// ---------------------------------------------------------------- 解码

/** 一个 Blob 槽位还原所需的字节（已由 blobStore 校验长度与哈希）。分块原样交给 Blob，不拼成一整块。 */
export type DecodedBlobBytes = { parts: readonly Uint8Array[]; mime: string }

const defineOwn = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

export const decodeDoc = (json: string, blobBytes: ReadonlyMap<number, DecodedBlobBytes>): unknown => {
  const fail = (message: string): never => {
    throw new SqliteCodecError(message, '')
  }
  const asRecord = (node: unknown): Record<string, unknown> => node as Record<string, unknown>

  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') {
      return node
    }
    if (Array.isArray(node)) {
      const out: unknown[] = new Array<unknown>(node.length)
      for (let i = 0; i < node.length; i += 1) {
        const item = node[i] as unknown
        const isHole =
          typeof item === 'object' && item !== null && !Array.isArray(item) && asRecord(item)[TAG] === 'hole'
        if (!isHole) {
          out[i] = walk(item)
        }
      }
      return out
    }
    const record = asRecord(node)
    if (!Object.hasOwn(record, TAG)) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record)) {
        defineOwn(out, key, walk(record[key]))
      }
      return out
    }
    switch (record[TAG]) {
      case 'undefined':
        return undefined
      case 'nan':
        return Number.NaN
      case 'inf':
        return record.v === -1 ? -Infinity : Infinity
      case 'negzero':
        return -0
      case 'bigint':
        return BigInt(String(record.v))
      case 'date':
        return new Date(record.v === null ? Number.NaN : Number(record.v))
      case 're':
        return new RegExp(String(record.s), String(record.f))
      case 'ab':
        return copyBytes(base64ToBytes(String(record.v))).buffer
      case 'dv':
        return new DataView(copyBytes(base64ToBytes(String(record.v))).buffer)
      case 'ta': {
        const name = String(record.c)
        if (!isTypedArrayName(name)) {
          return fail(`未知的类型数组 ${name}`)
        }
        const bytes = copyBytes(base64ToBytes(String(record.v)))
        const Ctor = TYPED_ARRAYS[name] as unknown as new (buffer: ArrayBuffer) => ArrayBufferView
        return new Ctor(bytes.buffer as ArrayBuffer)
      }
      case 'map': {
        const out = new Map<unknown, unknown>()
        for (const entry of record.v as unknown[][]) {
          out.set(walk(entry[0]), walk(entry[1]))
        }
        return out
      }
      case 'set': {
        const out = new Set<unknown>()
        for (const item of record.v as unknown[]) {
          out.add(walk(item))
        }
        return out
      }
      case 'obj': {
        const out: Record<string, unknown> = {}
        for (const [key, member] of record.v as [string, unknown][]) {
          defineOwn(out, key, walk(member))
        }
        return out
      }
      case 'blob': {
        const slot = Number(record.slot)
        const stored = blobBytes.get(slot)
        if (stored === undefined) {
          return fail(`缺少 Blob 槽位 ${slot} 的字节`)
        }
        const mime = typeof record.mime === 'string' ? record.mime : stored.mime
        const parts = stored.parts as unknown as BlobPart[]
        const file = record.file as { name?: unknown; lastModified?: unknown } | undefined
        if (file !== undefined && typeof File === 'function') {
          return new File(parts, String(file.name), { type: mime, lastModified: Number(file.lastModified) })
        }
        return new Blob(parts, { type: mime })
      }
      default:
        return fail(`未知的类型标签 ${String(record[TAG])}`)
    }
  }

  return walk(JSON.parse(json) as unknown)
}

/** 读 `doc` 里 Blob 槽位的 `slot` 清单（读字节前先知道要取哪些槽）。 */
export const blobSlotsOf = (json: string): number[] => {
  const slots: number[] = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {return}
    if (Array.isArray(node)) {
      for (const item of node) {walk(item)}
      return
    }
    const record = node as Record<string, unknown>
    if (record[TAG] === 'blob') {
      slots.push(Number(record.slot))
      return
    }
    if (record[TAG] === 'obj') {
      for (const [, member] of record.v as [string, unknown][]) {walk(member)}
      return
    }
    if (record[TAG] === 'map' || record[TAG] === 'set') {
      walk(record.v)
      return
    }
    for (const key of Object.keys(record)) {walk(record[key])}
  }
  walk(JSON.parse(json) as unknown)
  return slots
}

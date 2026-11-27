// [helper | 依赖: 纯 Node（crypto / TextEncoder）| 无全局副作用]
//
// #940：**过桥字节口径**的测试替身。原生 `AppSqlitePlugin.queryOn` 把查询结果编成行数组交给 WebView，
// 中途按一个自己算的字节数判断是否超过 `MAX_RESULT_BYTES`（4 MiB）。这个 counter 与实际过桥的 JSON 体积
// **不是一回事**，本文件把两者都算出来，好让测试能分辨「原生以为多大」与「真的多大」：
//
//   nativeResultBytes(rows)  逐字复刻 Java 侧 queryOn 的累加（AppSqlitePlugin.java:629-655 与 encode()）：
//                              bytes 起始 2；每行 +2；每列 += 值字节数 + 列名字符数。
//                              值字节数：null→4、整数→20、浮点→24、BLOB→**原始字节数**（base64 膨胀不算）、
//                              TEXT→`String.length()`（UTF-16 码元数，UTF-8 多字节不算）。
//   bridgeJsonBytes(rows)    真的过桥形态：BLOB 变成 {"$b64":"..."}（≈4/3），TEXT 变成 JSON 字符串，
//                              再加行标点与列名。用 JSON.stringify + Buffer.byteLength 量出来的真实字节数。
//
// 这两个数字的差就是 #940 的坑：**同一个「4 MiB」在两侧含义不同**。测试断言「估算器必须覆盖
// bridgeJsonBytes」而不是「原生计数器」，因为真机上撑爆 WebView / CursorWindow 的是后者。
//
// 与 `src/services/storage/sqlite/paged.ts` 的 `nativeResultBytes` 是同一口径的两份实现：
// `tests/unit/migration-paged-query.test.mjs` 里有一条断言钉住两者必须逐行相等（谁改了那边，这里会红）。
import { createHash } from 'node:crypto'

/** 与 `AppSqlitePlugin.java:60` 的 `MAX_RESULT_BYTES` 同值。 */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024

/** 单列分块帧长（与 `schema.ts` 的 `BLOB_CHUNK_BYTES` 同值）。 */
export const COLUMN_CHUNK_BYTES = 512 * 1024

const encoder = new TextEncoder()

/** 原生 `encode()` 给一个值记的字节数（**不含** base64 膨胀，也不含 UTF-8 多字节）。 */
export const encodedBytesOf = (value) => {
  if (value === null || value === undefined) {
    return 4
  }
  if (typeof value === 'boolean') {
    return 20
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 20 : 24
  }
  if (typeof value === 'string') {
    return value.length
  }
  if (value instanceof Uint8Array) {
    return value.byteLength
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength
  }
  // Blob 是迁移读侧的句柄；原生 BLOB 分支记的就是「它变成字节之后的长度」
  if (value instanceof Blob) {
    return value.size
  }
  throw new TypeError(`不认识的列值类型: ${Object.prototype.toString.call(value)}`)
}

/**
 * 一个**值**按原生口径占多少字节（容器递归求和：列名 + 值；与 `queryOn()` 同一套单位）。
 * 迁移的行值不是扁平的 SQL 行，所以拿它来对 `estimateValueBytes` / `estimateRowBytes`。
 */
export const nativeValueBytes = (value) => {
  if (value === null || value === undefined) {
    return 4
  }
  if (value instanceof Blob) {
    // 迁移读侧的 Blob 会在过桥前被读成字节；原生 BLOB 分支记的就是这个长度
    return value.size
  }
  if (Array.isArray(value)) {
    return 2 + value.reduce((sum, item) => sum + nativeValueBytes(item), 0)
  }
  if (
    typeof value === 'object' &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(value)
  ) {
    let total = 2
    for (const [key, item] of Object.entries(value)) {
      total += String(key).length + nativeValueBytes(item)
    }
    return total
  }
  return encodedBytesOf(value)
}

/**
 * 原生 `queryOn()` 的字节累加口径（逐字复刻，行数/列序无关）。
 * 超限判定是 `bytes > MAX_RESULT_BYTES`（Java 侧每处理完一行判一次）。
 */
export const nativeResultBytes = (rows) => {
  let bytes = 2
  for (const row of rows) {
    let rowBytes = 0
    for (const [column, value] of Object.entries(row)) {
      rowBytes += encodedBytesOf(value) + String(column).length
    }
    bytes += rowBytes + 2
  }
  return bytes
}

/** 一个值过桥后的 JSON 形态：BLOB → `{"$b64":"…"}`（原生 encode() 的 BLOB 分支），容器递归。 */
export const toBridgeValue = (value) => {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (value instanceof Uint8Array) {
    return { $b64: Buffer.from(value).toString('base64') }
  }
  if (value instanceof ArrayBuffer) {
    return { $b64: Buffer.from(new Uint8Array(value)).toString('base64') }
  }
  if (ArrayBuffer.isView(value)) {
    return { $b64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64') }
  }
  if (value instanceof Blob) {
    // 迁移读侧拿到的是 Blob（句柄）。过桥前必然读成字节、再编成 base64；这里只关心**字节数**，
    // 所以用等长的占位 base64（长度 = 4*ceil(size/3)，与真编码逐字节等长）代替真内容。
    return { $b64: 'A'.repeat(4 * Math.ceil(value.size / 3)) }
  }
  if (Array.isArray(value)) {
    return value.map(toBridgeValue)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toBridgeValue(item)]))
  }
  throw new TypeError(`不认识的列值类型: ${Object.prototype.toString.call(value)}`)
}

/** 一条 SQL 结果行过桥后的 JSON 形态（列名 → 值）。 */
export const toBridgeRow = (row) =>
  Object.fromEntries(Object.entries(row).map(([column, value]) => [column, toBridgeValue(value)]))

/**
 * 这些**值**（迁移的行值 / 一行的列值）真的过桥要占多少字节：`JSON.stringify(values)` 的 UTF-8 长度。
 * 与 `estimateRowBytes` 对比时用它（后者额外含主键与 32 字节行信封，所以只会更宽）。
 */
export const bridgeJsonBytes = (values) => Buffer.byteLength(JSON.stringify(values.map(toBridgeValue)), 'utf8')

/** 一整条查询响应的过桥体积：`{"rows":[…]}` 那一层也算（`rows` 是扁平的 SQL 结果行）。 */
export const bridgeResponseBytes = (rows) =>
  Buffer.byteLength(JSON.stringify({ rows: rows.map(toBridgeRow) }), 'utf8')

/** Blob 读成字节（迁移读侧的原件在算过桥体积之前必须先落地成字节）。 */
export const bytesOfBlob = async (blob) => new Uint8Array(await blob.arrayBuffer())

/** 确定性伪随机字节（不用 Math.random：失败要可复现）。 */
export const deterministicBytes = (length, seed = 1) => {
  const out = new Uint8Array(length)
  let state = seed >>> 0 || 1
  for (let i = 0; i < length; i += 1) {
    // xorshift32：够用且可复现
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    out[i] = state & 0xff
  }
  return out
}

export const sha256Hex = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')

export const utf8 = (text) => encoder.encode(text)

/** 「像真的」大 BLOB 行（files store 里的原件：id + blob + 少量元数据）。 */
export const blobRow = (id, bytes) => ({
  key: id,
  value: { id, blob: new Blob([bytes], { type: 'application/octet-stream' }) },
})

/**
 * 带「原生 4 MiB 上限」的、faithful 的**过桥计数器**：给定一批行，判原生会不会抛。
 * 抛出的错误形状照真机：`message` 原文 + `code === 'RESULT_TOO_LARGE'`。
 */
export const assertNativeWouldAccept = (rows, { label = 'rows' } = {}) => {
  const bytes = nativeResultBytes(rows)
  if (bytes > MAX_RESULT_BYTES) {
    const error = new Error(`result exceeds ${MAX_RESULT_BYTES} bytes; refusing to truncate`)
    error.code = 'RESULT_TOO_LARGE'
    error.bytes = bytes
    error.label = label
    throw error
  }
  return bytes
}

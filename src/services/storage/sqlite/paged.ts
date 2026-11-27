/**
 * 大结果读取（#940）：把「一次查询要把全部结果攒进一个 JSArray」拆成**可控窗口 + 诚实续传**。
 *
 * 背景（实测见 `tests/tools/940-result-bytes-evidence.mjs`）：
 *  - 原生 `AppSqlitePlugin.queryOn` 把整段结果攒成一个 `JSArray`，累计字节超过 `MAX_RESULT_BYTES`
 *    （4 MiB）就 `throw`，不截断；
 *  - 那个「字节」是**原生自己的计数口径**：TEXT 记 UTF-16 码元数、BLOB 记**原始**长度（不含 base64）、
 *    再逐列加列名长度。它与真实过桥的 JSON 体积不是一个量：中文正文实测放大 2.86×、
 *    BLOB base64 放大 1.33×。所以 4 MiB 既不等于、也不约束过桥载荷；
 *  - 但**单行/单列本身**超过这个计数时，分页（limit/offset）永久救不了 —— 只能按列分块。
 *
 * 本文件给两件东西：
 *  1. `queryAll()`：**唯一**推荐的「我要拿到全部结果」入口。它必须循环到 `done === true`，
 *     并对账（行数 / 偏移必须前进），**绝不**把「这一块」当「全部」；
 *  2. `readTextColumn()` / `readBlobColumn()`：单列分块读取（`LENGTH(CAST(col AS BLOB))` 判长 +
 *     `SUBSTR(CAST(col AS BLOB), start, len)` 分段），重组后**必须**与声明总长逐字节对上，否则报错。
 *
 * 错误：两个稳定 `code` —— `RESULT_TOO_LARGE`（单次结果/单行超限，分类映射在上层）与
 * `RESULT_INCOMPLETE`（没取完却被当成取完了）。其余错误沿用既有 kind，不在这里改语义。
 */
import type { SqlPage, SqlPageQuery, SqlRow, SqlTx, SqlValue } from './driver.js'
import { RESULT_INCOMPLETE, RESULT_TOO_LARGE } from './driver.js'
import { isResultTooLarge, resultIncompleteError, resultTooLargeError } from './repos/errors.js'

export { RESULT_INCOMPLETE, RESULT_TOO_LARGE }

/** 与 `AppSqlitePlugin.MAX_RESULT_BYTES` 同值。**仅用于诊断与预算推导，不是可调上限**（#940 明令不许提高）。 */
export const MAX_RESULT_BYTES = 4 * 1024 * 1024

/** 默认一页多少行。原生还会按字节预算提前收口，所以实际行数可能更少（见 `allPaged` 契约）。 */
export const DEFAULT_PAGE_ROWS = 256

/** 单列分块帧长（字节）。与 `schema.ts` 的 `BLOB_CHUNK_BYTES` 同值：512 KiB 原始字节 → 过桥约 683 KiB base64。 */
export const COLUMN_CHUNK_BYTES = 512 * 1024

/** 分页口（`SqlDatabase` / `SqlTx` 都有）。`all` 可选：没有分页口的旧实现退化成「一次取完」。 */
export type PagedSource = Pick<SqlTx, 'allPaged'> & Partial<Pick<SqlTx, 'all'>>

export type QueryAllOptions = {
  /** 一页请求多少行（原生可能按字节预算收口，实际更少）。 */
  pageRows?: number
  /**
   * 期望总行数（调用方用 `COUNT(*)` / `count()` 拿到）。**给了就一定会对账**：
   * 累计行数不等 → 抛 `RESULT_INCOMPLETE`。这是唯一能识别「驱动少给数据却 done:true」的通用手段。
   */
  expectedRows?: number
  signal?: AbortSignal
}

/**
 * 原生 `queryOn` 的字节累加口径（`AppSqlitePlugin.java` 的 `queryOn` + `encode`），逐字一份。
 * 用途：诊断、测试造 faithful 上限、以及把「原生会怎么算」与「真实过桥多少」分开讲清楚。
 * 不要把当它过桥体积（见本文件头部的实测倍数）。
 */
export const nativeResultBytes = (rows: ReadonlyArray<Record<string, unknown>>): number => {
  let bytes = 2
  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      bytes += nativeEncodedBytes(value) + name.length
    }
    bytes += 2
  }
  return bytes
}

const nativeEncodedBytes = (value: unknown): number => {
  if (value === null || value === undefined) {
    return 4
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 20 : 24
  }
  if (typeof value === 'string') {
    return value.length
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return (value as { byteLength: number }).byteLength
  }
  return 4
}

const abortIfNeeded = (signal: AbortSignal | undefined): void => {
  if (!signal?.aborted) {
    return
  }
  const reason = (signal as { reason?: unknown }).reason
  if (reason instanceof Error) {
    throw reason
  }
  const error = new Error('query aborted')
  error.name = 'AbortError'
  throw error
}

/** 调一页。旧驱动没有 `allPaged` 时退化成「一次取完」—— 不会少给，只会可能超限报错。 */
const fetchPage = async (
  source: PagedSource,
  sql: string,
  params: readonly SqlValue[] | undefined,
  page: SqlPageQuery,
): Promise<SqlPage> => {
  if (typeof source.allPaged === 'function') {
    return source.allPaged(sql, params, page)
  }
  if (typeof source.all !== 'function') {
    throw resultIncompleteError('驱动既没有 allPaged 也没有 all，无法读取结果')
  }
  const rows = await source.all(sql, params)
  return { rows, done: true, nextOffset: page.offset + rows.length }
}

/**
 * **取完**一条查询的全部结果行。
 *
 * 契约（调用方据此保证「拿全了」）：
 *  - 只有在原生回报 `done === true` 时才认为结束；否则一直循环。
 *  - `done === false` 时 `rows` 必须非空且 `nextOffset` 必须前进，否则抛 `RESULT_INCOMPLETE`
 *    （宁可报错，也不静默少给）。
 *  - 传了 `expectedRows` 就一定对账，行数不符抛 `RESULT_INCOMPLETE`。
 *  - 单行本身超预算（原生 `RESULT_TOO_LARGE`）时**不吞**，向上抛：这种行要改用
 *    `readTextColumn()` / `readBlobColumn()` 按列分块读。
 */
export const queryAll = async (
  source: PagedSource,
  sql: string,
  params?: readonly SqlValue[],
  options: QueryAllOptions = {},
): Promise<SqlRow[]> => {
  const pageRows = Math.max(1, Math.floor(options.pageRows ?? DEFAULT_PAGE_ROWS))
  const rows: SqlRow[] = []
  let offset = 0
  let limit = pageRows
  for (;;) {
    abortIfNeeded(options.signal)
    const page = await fetchPage(source, sql, params, { limit, offset })
    const pageRowsGot = Array.isArray(page.rows) ? page.rows.length : 0
    for (const row of page.rows) {
      rows.push(row)
    }
    if (page.done) {
      break
    }
    if (pageRowsGot === 0) {
      // 原生契约保证不会发生；TS 侧不信任：把「说还没读完却一行都不给」直接判成不完整
      throw resultIncompleteError(`分页在 offset=${offset} 处返回空页但 done=false，拒绝把部分结果当全部`)
    }
    if (!(typeof page.nextOffset === 'number') || !Number.isFinite(page.nextOffset) || page.nextOffset <= offset) {
      throw resultIncompleteError(
        `分页没有前进：offset=${offset} → nextOffset=${String(page.nextOffset)}，拒绝死循环或把部分结果当全部`,
      )
    }
    offset = page.nextOffset
    // 原生按字节预算提前收口时 rows 会少于 limit：下一轮用实测窗口，避免每页都白撞一次
    if (pageRowsGot < limit) {
      limit = Math.max(1, pageRowsGot)
    }
  }
  if (options.expectedRows !== undefined && rows.length !== options.expectedRows) {
    throw resultIncompleteError(
      `结果行数不符：期望 ${options.expectedRows}，实际取到 ${rows.length}（可能中途少给，拒绝当成功返回）`,
    )
  }
  return rows
}

// ---------------------------------------------------------------- 单列分块

/** 一列的读取结果。`found === false` = 没有这一行；`text/bytes === null` = 该列是 NULL。 */
export type ColumnRead<T> = { found: boolean; value: T | null }

export type ColumnSpec = {
  /** 表名。**只接受仓储内部的常量**（来自 `STORE_TABLES`），不得由外部字符串拼接。 */
  table: string
  /** 列名。同上。 */
  column: string
  /** WHERE 片段（`id = ?` 之类），值一律走 `params` 绑定。 */
  where: string
  params: readonly SqlValue[]
}

export type ColumnReadOptions = {
  /** 分块帧长（字节），默认 `COLUMN_CHUNK_BYTES`。 */
  chunkBytes?: number
  /** 单次直读的字节预算：超过它就直接走分块（默认 `MAX_RESULT_BYTES`，即交给原生上限自己触发）。 */
  budgetBytes?: number
  signal?: AbortSignal
}

const lengthSql = (spec: ColumnSpec, selectValue: boolean): string =>
  `SELECT LENGTH(CAST(${spec.column} AS BLOB)) AS n${selectValue ? `, ${spec.column} AS v` : ''} FROM ${spec.table} WHERE ${spec.where}`

/** 未知值 → 字节。TEXT 按 UTF-8 编码；不认识的值返回 `undefined`（调用方据此报错，不猜）。 */
const toBytes = (value: unknown): Uint8Array | undefined => {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof value === 'string') {
    return new TextEncoder().encode(value)
  }
  return undefined
}

const asNumber = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN)

/**
 * 取 `[start, start+length)` 这一段字节（`start` 从 1 起，按**字节**切，不会劈开多字节字符）。
 *
 * 撞上限就**对半再切**：原生上限可能比 `COLUMN_CHUNK_BYTES` 更小（未来调低、或别的实现更严），
 * 这时候「按 512KiB 一块」本身就会超 —— 一路二分到能取为止（最小 1 字节，仍超则原样抛出）。
 */
const readRange = async (
  exec: Pick<SqlTx, 'all'>,
  spec: ColumnSpec,
  start: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> => {
  abortIfNeeded(signal)
  let rows
  try {
    rows = await exec.all(
      // 注意占位符顺序：SELECT 列表里的 SUBSTR 两个 `?` 在 WHERE 之前 → 绑参也必须 start/length 在前
      `SELECT SUBSTR(CAST(${spec.column} AS BLOB), ?, ?) AS part FROM ${spec.table} WHERE ${spec.where}`,
      [start, length, ...spec.params],
    )
  } catch (error) {
    if (!isResultTooLarge(error) || length <= 1) {
      throw error
    }
    const half = Math.max(1, Math.floor(length / 2))
    const head = await readRange(exec, spec, start, half, signal)
    const tail = await readRange(exec, spec, start + half, length - half, signal)
    const joined = new Uint8Array(head.length + tail.length)
    joined.set(head, 0)
    joined.set(tail, head.length)
    return joined
  }
  const row = rows[0]
  if (row === undefined) {
    throw resultIncompleteError(
      `列 ${spec.table}.${spec.column} 分块读取时行消失了（start=${start}），拒绝把部分结果当成功`,
    )
  }
  const chunk = toBytes(row.part) ?? new Uint8Array(0)
  if (chunk.length !== length) {
    throw resultIncompleteError(
      `列 ${spec.table}.${spec.column} 第 ${start} 段长度不符：请求 ${length}，实得 ${chunk.length}`,
    )
  }
  return chunk
}

/**
 * 读一个可能超大的列（TEXT / BLOB 通用，返回原始字节）。
 *
 * 步骤：
 *  1. 一次直读（`LENGTH` + 值）；不超原生上限时这就是全部工作，并顺手校验字节数；
 *  2. 直读撞 `RESULT_TOO_LARGE` → 只读 `LENGTH(CAST(col AS BLOB))`；
 *  3. 按 `SUBSTR(CAST(col AS BLOB), start, len)` 逐段取，**段边界在字节上**（不会切断多字节字符）；
 *  4. 重组后校验：总字节数必须等于声明长度，否则抛 `RESULT_INCOMPLETE` —— 绝不把短的重组结果当成功。
 */
export const readColumnBytes = async (
  exec: Pick<SqlTx, 'all'>,
  spec: ColumnSpec,
  options: ColumnReadOptions = {},
): Promise<ColumnRead<Uint8Array>> => {
  const chunkBytes = Math.max(1, Math.floor(options.chunkBytes ?? COLUMN_CHUNK_BYTES))
  abortIfNeeded(options.signal)
  try {
    const rows = await exec.all(lengthSql(spec, true), spec.params)
    const row = rows[0]
    if (row === undefined) {
      return { found: false, value: null }
    }
    const declared = asNumber(row.n)
    const value = row.v
    if (value === null || value === undefined) {
      return { found: true, value: null }
    }
    const bytes = toBytes(value)
    if (bytes === undefined) {
      throw resultIncompleteError(`列 ${spec.table}.${spec.column} 的值既不是文本也不是二进制，无法判长`)
    }
    if (Number.isFinite(declared) && bytes.length !== declared) {
      throw resultIncompleteError(
        `列 ${spec.table}.${spec.column} 直读长度不符：声明 ${declared} 字节，实得 ${bytes.length} 字节`,
      )
    }
    return { found: true, value: bytes }
  } catch (error) {
    if (!isResultTooLarge(error)) {
      throw error
    }
  }

  // 直读撞上限 → 先拿声明长度，再按字节分块
  const lengthRows = await exec.all(lengthSql(spec, false), spec.params)
  const lengthRow = lengthRows[0]
  if (lengthRow === undefined) {
    return { found: false, value: null }
  }
  if (lengthRow.n === null || lengthRow.n === undefined) {
    return { found: true, value: null }
  }
  const total = asNumber(lengthRow.n)
  if (!Number.isFinite(total) || total < 0) {
    throw resultIncompleteError(`列 ${spec.table}.${spec.column} 的 LENGTH() 不是有效字节数：${String(lengthRow.n)}`)
  }
  const parts: Uint8Array[] = []
  let received = 0
  for (let start = 1; start <= total; start += chunkBytes) {
    abortIfNeeded(options.signal)
    const length = Math.min(chunkBytes, total - (start - 1))
    const chunk = await readRange(exec, spec, start, length, options.signal)
    parts.push(chunk)
    received += chunk.length
  }
  if (received !== total) {
    throw resultIncompleteError(`列 ${spec.table}.${spec.column} 重组总长不符：声明 ${total} 字节，重组 ${received} 字节`)
  }
  const joined = new Uint8Array(received)
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return { found: true, value: joined }
}

const decoder = (): TextDecoder => new TextDecoder('utf-8', { fatal: true })

/** `readColumnBytes` 的别名（叫 `readBlobColumn` 更直观：取原始字节）。同签名同语义。 */
export const readBlobColumn = readColumnBytes

/** `readColumnBytes` 的文本版：字节重组后按 UTF-8 解码（非法序列直接抛错，不产出替换字符）。 */
export const readTextColumn = async (
  exec: Pick<SqlTx, 'all'>,
  spec: ColumnSpec,
  options: ColumnReadOptions = {},
): Promise<ColumnRead<string>> => {
  const read = await readColumnBytes(exec, spec, options)
  if (!read.found || read.value === null) {
    return { found: read.found, value: null }
  }
  let text: string
  try {
    text = decoder().decode(read.value)
  } catch (error) {
    throw resultIncompleteError(`列 ${spec.table}.${spec.column} 的字节不是合法 UTF-8，拒绝返回损坏文本`, { cause: error })
  }
  return { found: true, value: text }
}

export { resultTooLargeError, resultIncompleteError }

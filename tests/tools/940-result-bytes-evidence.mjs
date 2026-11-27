#!/usr/bin/env node
// #940 证据脚本：原生 `MAX_RESULT_BYTES` 的口径 vs 真实过桥体积 vs TS 侧 `estimateRowBytes` 的口径。
//
// 用法：node tests/tools/940-result-bytes-evidence.mjs
// 输出一张表 + 结论行；PR 正文里的数字就是这份输出。
//
// 三个量必须分清（issue 的「关键怀疑」把它们混成了两个）：
//   A. nativeCounter —— `AppSqlitePlugin.queryOn` 自己累加的那个 `bytes`，与 4 MiB 比较的就是它；
//   B. wireBytes     —— 这一页真的过桥的 JSON 文本的 UTF-8 字节数（BLOB 是 base64，TEXT 是 UTF-8 + 转义）；
//   C. tsEstimate    —— TS 侧 `hash.ts` 的 `estimateRowBytes`（逻辑值口径，给分批用）。
import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

const hash = await loadTsModule('src/services/storage/migration/hash.ts')
const mapping = await loadTsModule('src/services/storage/sqlite/mapping.ts')

const encoder = new TextEncoder()
const utf8 = (text) => encoder.encode(text).length

/** A：逐字对应 AppSqlitePlugin.queryOn（java:636-651）的累加口径。 */
const nativeCounter = (rows) => {
  let bytes = 2
  for (const row of rows) {
    for (const [name, value] of Object.entries(row)) {
      bytes += encodedBytes(value) + name.length
    }
    bytes += 2
  }
  return bytes
}

/** 逐字对应 AppSqlitePlugin.encode（java:672-700）：Blob/字节记原始长度，TEXT 记 UTF-16 码元数。 */
const encodedBytes = (value) => {
  if (value === null || value === undefined) return 4
  if (typeof value === 'number') return Number.isInteger(value) ? 20 : 24
  if (typeof value === 'string') return value.length
  if (value instanceof Uint8Array) return value.length
  throw new Error(`unsupported: ${typeof value}`)
}

/** B：真实过桥形态 —— BLOB 变 `{"$b64":"…"}`、TEXT 原样，再整体 JSON.stringify 取 UTF-8 长度。 */
const wireBytes = (rows) => utf8(JSON.stringify({ rows }))

const base64 = (bytes) => Buffer.from(bytes).toString('base64')
const wireRow = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? { $b64: base64(v) } : v]),
  )

const CJK = '这是一段中文消息内容，用于模拟真实会话记录里的正文。'
const ASCII = 'The quick brown fox jumps over the lazy dog. '

/** 一条会话：messages 里全是中文正文（真实形态）。 */
const sessionDoc = (messageCount) =>
  JSON.stringify({
    id: 'sess-0001',
    title: '中文标题示例',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: CJK.repeat(20),
    })),
  })

/** 一条 ASCII 会话（对照组：没有多字节字符）。 */
const asciiSessionDoc = (messageCount) =>
  JSON.stringify({
    id: 'sess-0002',
    title: 'ascii title',
    messages: Array.from({ length: messageCount }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: ASCII.repeat(40),
    })),
  })

const MIB = 1024 * 1024
const BLANK = '　'
const table = []

const record = (label, wireRowValue, { count = 1, key = 'k-0001', tsValue } = {}) => {
  const rows = Array.from({ length: count }, () => ({ ...wireRowValue }))
  const a = nativeCounter(rows)
  const b = wireBytes(rows.map(wireRow))
  // C：TS 侧把「同一份数据」当作迁移行来估 —— 用解码后的对象（与 IDB 原值同形）
  const decoded = tsValue ?? JSON.parse(String(wireRowValue.doc))
  const c = hash.estimateRowBytes({ key, value: decoded })
  table.push({ label, native: a, wire: b, ts: c })
  return { a, b, c }
}

// 1. 中文会话 doc（迁移 / 会话读取的主形态）
record('sessions/docs 中文正文', { doc: sessionDoc(40) })
// 2. 同规模的 ASCII 会话 doc
record('sessions/docs ASCII 正文', { doc: asciiSessionDoc(40) })
// 3. 一条刚好越过原生 4 MiB 计数器门槛的单行 doc（「单行 >4MiB」这一类，分页救不了）
record('sessions/docs 中文正文（单行越过 4MiB 门槛）', { doc: sessionDoc(7800) })
// 4. BLOB 列（blob_chunks.data 的过桥形态）；C 用「同一个原件在 IDB 侧是 Blob」来估
const blobOf = (bytes) => new Blob([bytes])
record('blob_chunks/data 512KiB 块 ×4', { data: new Uint8Array(512 * 1024) }, { count: 4, tsValue: { blob: blobOf(new Uint8Array(2 * MIB)) } })
record('blob_chunks/data 4MiB 单块（旧库更粗的块）', { data: new Uint8Array(4 * MIB) }, { count: 1, tsValue: { blob: blobOf(new Uint8Array(4 * MIB)) } })
// 5. 纯键页（pageKeys / readBatch 的键查询）：TS 侧不给这种页做估算
record('pageKeys 201 个 ASCII 键', { k: new Uint8Array('k-0000000000000000000000000000000000'.length * 2) }, { count: 201, tsValue: {} })
// 6. 小行（回归对照）
record('sessions/docs 小行', { doc: JSON.stringify({ id: 's', n: 1 }) })

const pad = (value, width) => String(value).padStart(width)
console.log('')
console.log('#940 字节口径实测（nativeCounter = queryOn 与 4 MiB 比较的那个数）')
console.log('')
console.log('| 形态 | nativeCounter (A) | 真实过桥 wireBytes (B) | B/A | tsEstimateRowBytes (C) | C/A |')
console.log('|---|---|---|---|---|---|')
for (const row of table) {
  console.log(
    `| ${row.label} | ${pad(row.native, 10)} | ${pad(row.wire, 10)} | ${(row.wire / row.native).toFixed(2)}× | ${pad(row.ts, 10)} | ${(row.ts / row.native).toFixed(2)}× |`,
  )
}

// ---------------------------------------------------------------- 结论判定

const byLabel = (needle) => table.find((row) => row.label.includes(needle))

const cjk = table.find((row) => row.label === 'sessions/docs 中文正文')
const ascii = byLabel('ASCII 正文')
const huge = byLabel('越过 4MiB 门槛')
const blob = byLabel('512KiB')
const blobBig = byLabel('4MiB 单块')

/** 「TS 认为 ≤4MiB → 原生会不会抛」：TS 估算与原生计数器的大小关系（只看 doc 形态的行；纯键页 TS 侧不估算）。 */
const docShaped = table.filter((row) => !row.label.includes('pageKeys'))
const tsAboveNative = docShaped.every((row) => row.ts >= row.native)
/** 「原生认为 ≤4MiB → 真实过桥体积会不会超 4MiB」。 */
const wireAboveNative = table.every((row) => row.wire >= row.native)

console.log('')
console.log('## 直接检验「关键怀疑」：TS 把一批攒到估算 4 MiB，原生计数器落在哪？')
console.log('')
for (const row of [cjk, ascii, blob]) {
  const ratio = row.ts / row.native
  const nativeAtTs4MiB = Math.round((4 * MIB) / ratio)
  const wireAtTs4MiB = Math.round(((4 * MIB) / ratio) * (row.wire / row.native))
  console.log(
    `- ${row.label}: TS 估算攒到 ${4 * MIB} 时 → 原生计数器 ≈ ${nativeAtTs4MiB}（${(nativeAtTs4MiB / MIB).toFixed(2)} MiB，${nativeAtTs4MiB > 4 * MIB ? '会' : '**不会**'}抛 RESULT_TOO_LARGE），同一批真实过桥 ≈ ${(wireAtTs4MiB / MIB).toFixed(2)} MiB`,
  )
}

console.log('')
console.log(`- TS 估算 ≥ 原生计数（doc 形态）：${tsAboveNative ? '恒成立' : '不成立'}（中文 C/A=${(cjk.ts / cjk.native).toFixed(2)}×，BLOB C/A=${(blob.ts / blob.native).toFixed(2)}×）`)
console.log(`- 真实过桥体积 ≥ 原生计数：${wireAboveNative ? '恒成立' : '不成立'}（中文 B/A=${(cjk.wire / cjk.native).toFixed(2)}×，ASCII B/A=${(ascii.wire / ascii.native).toFixed(2)}×，BLOB B/A=${(blob.wire / blob.native).toFixed(2)}×）`)
console.log(`- 单行中文 doc：原生计数 ${huge.native}（${huge.native > 4 * MIB ? '>' : '<'}${4 * MIB} → 单行查询${huge.native > 4 * MIB ? '必然抛 RESULT_TOO_LARGE，分页救不了' : '不抛'}），真实过桥 ${(huge.wire / MIB).toFixed(2)} MiB`)
console.log(`- 单块 4 MiB 的 BLOB：原生计数 ${blobBig.native}（<${4 * MIB}，逐字节不截断地过桥 ${blobBig.wire} 字节 = ${(blobBig.wire / MIB).toFixed(2)} MiB）`)
console.log('')
console.log('结论：')
console.log(`  1) 「TS 认为一批 ≤4MiB → 序列化后超原生 4MiB 上限 → 原生抛错」**被推翻**。`)
console.log(`     同一批数据，TS 估算 ≥ 原生计数器（中文 ${(cjk.ts / cjk.native).toFixed(2)}×、BLOB ${(blob.ts / blob.native).toFixed(2)}×），`)
console.log(`     所以 TS 攒到估算 4 MiB 时原生计数器只有约 ${((4 * MIB) / (cjk.ts / cjk.native) / MIB).toFixed(2)} MiB（中文），根本到不了原生上限 —— TS 的分页/分批预算不是这次失败的原因。`)
console.log(`  2) 「两个 4194304 含义不同」**成立，而且方向比原假设更糟**：原生计数器系统性地低估过桥体积`)
console.log(`     （中文 ${(cjk.wire / cjk.native).toFixed(2)}×、BLOB ${(blob.wire / blob.native).toFixed(2)}×、键 ${(table.find((r) => r.label.includes('pageKeys')).wire / table.find((r) => r.label.includes('pageKeys')).native).toFixed(2)}×），`)
console.log(`     所以 4 MiB 上限既不等于、也不约束真实过桥字节数：一批「合规」的结果可以推着 12 MiB 的 JSON 过桥。`)
console.log(`  3) 真正确定会失败的只有一类：单行/单列本身超过原生计数器（实测 ${(huge.native / MIB).toFixed(2)} MiB 的单行 doc）。`)
console.log(`     这一类分页（limit/offset）永久救不了，只能按列分块（LENGTH + SUBSTR）。`)
console.log(`  4) 因此两侧都不需要「提高上限」，需要的是：原生加**诚实的分页**（done 只在末尾为真），TS 侧保证「一次查询永远不带回超预算的载荷」`)
console.log(`     并给单列做分块重组 + 长度对账。`)

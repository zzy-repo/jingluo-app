// [helper | 依赖: ./canon.mjs ./sources.mjs | 无全局副作用]
//
// #910 / #921：独立判据 oracle。对两个 `RawStoreSource`（形状见 migration/types.ts，这里只用结构，不 import）
// 逐 store、逐行做结构化深度相等比较，产出**差异清单**（不是一个布尔值）。
//
// 与 migration-engine 的 verify.ts 的区别（独立性）：
//   · verify.ts 比「规范化后的哈希」；本文件直接**递归逐字段**比较并报告路径，哈希只用来给 Blob 比字节；
//   · 本文件不 import src/**（静态扫描见 migration-oracle-selftest）；
//   · 额外检查**源自身的分页契约**：主键严格升序、无重复、`count()` 与实际枚举行数一致。
//     一个坏掉的源会让「两边都读少了」而相等 —— 这类假通过只有检查契约才能发现。
//
// 差异 `kind`：
//   missing-row / extra-row            目标少 / 多一行（A 为期望，B 为实际）
//   type                               值类型不同（含 Blob vs Uint8Array、[] vs {}、1 vs '1'）
//   value                              同类型值不同（字符串按 UTF-16 码元；数字按位，-0≠0，NaN=NaN）
//   missing-key / extra-key            对象属性缺失 / 多出
//   undefined-vs-missing               一边是 `undefined` 值属性，另一边键不存在
//   hole-vs-undefined                  数组空洞 vs `undefined` 元素
//   array-length                       数组长度不同
//   blob-bytes / blob-type / blob-size Blob 内容 / MIME / 长度不同
//   source-contract                    源违反分页契约（乱序、重复、计数不符、不前进的 next）
//   unreadable                         读取抛错（带错误名与信息）
import { blobSha256, kindOf, preview } from './canon.mjs'
import { STORE_NAMES } from './sources.mjs'

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

const firstDiffIndex = (a, b) => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i
  return n
}

/**
 * 递归比较两个值，把差异 push 进 `out`（带路径）。返回是否相等。
 * `ctx.maxDiffsPerRow` 限制单行差异数，避免一个坏行淹没报告。
 */
export const diffValues = async (a, b, path, out, ctx = {}, depth = 0) => {
  const limit = ctx.maxDiffsPerRow ?? 20
  const startLen = out.length
  const push = (kind, extra = {}) => {
    if (out.length - startLen < limit) out.push({ kind, path, ...extra })
  }
  const ka = kindOf(a)
  const kb = kindOf(b)
  if (ka !== kb) {
    push('type', { a: `${ka}:${preview(a)}`, b: `${kb}:${preview(b)}` })
    return false
  }
  if (depth > 64) {
    push('source-contract', { detail: 'depth>64' })
    return false
  }
  switch (ka) {
    case 'undefined':
    case 'null':
      return true
    case 'boolean':
    case 'bigint':
      if (a !== b) return push('value', { a: preview(a), b: preview(b) }), false
      return true
    case 'number':
      // Object.is：-0≠0，NaN=NaN
      if (!Object.is(a, b)) return push('value', { a: preview(a), b: preview(b), note: Object.is(a, -0) !== Object.is(b, -0) ? 'signed-zero' : undefined }), false
      return true
    case 'string': {
      if (a !== b) {
        const i = firstDiffIndex(a, b)
        push('value', {
          a: preview(a),
          b: preview(b),
          note: `lengths ${a.length}/${b.length}, first code-unit difference at ${i}` +
            (i < a.length && i < b.length ? ` (0x${a.charCodeAt(i).toString(16)} vs 0x${b.charCodeAt(i).toString(16)})` : ''),
        })
        return false
      }
      return true
    }
    case 'date':
      if (!Object.is(a.getTime(), b.getTime())) return push('value', { a: preview(a), b: preview(b) }), false
      return true
    case 'regexp':
      if (a.source !== b.source || a.flags !== b.flags) return push('value', { a: String(a), b: String(b) }), false
      return true
    case 'blob': {
      let ok = true
      if (a.size !== b.size) ok = (push('blob-size', { a: a.size, b: b.size }), false)
      if (a.type !== b.type) ok = (push('blob-type', { a: a.type, b: b.type }), false)
      if (a.size === b.size) {
        const [ha, hb] = [await blobSha256(a), await blobSha256(b)]
        if (ha !== hb) ok = (push('blob-bytes', { a: ha.slice(0, 16), b: hb.slice(0, 16) }), false)
      }
      return ok
    }
    case 'arraybuffer':
    case 'object':
    case 'array':
    case 'map':
    case 'set':
      break
    default:
      if (ka.startsWith('view:')) {
        const [ua, ub] = [new Uint8Array(a.buffer, a.byteOffset, a.byteLength), new Uint8Array(b.buffer, b.byteOffset, b.byteLength)]
        if (ua.length !== ub.length || Buffer.compare(ua, ub) !== 0) return push('value', { a: `${ka}(${ua.length})`, b: `${kb}(${ub.length})`, note: 'bytes differ' }), false
        return true
      }
      push('type', { a: `uncomparable:${ka}`, b: `uncomparable:${kb}` })
      return false
  }
  if (ka === 'arraybuffer') {
    const [ua, ub] = [new Uint8Array(a), new Uint8Array(b)]
    if (ua.length !== ub.length || Buffer.compare(ua, ub) !== 0) return push('value', { a: `ArrayBuffer(${ua.length})`, b: `ArrayBuffer(${ub.length})` }), false
    return true
  }
  let ok = true
  if (ka === 'array') {
    if (a.length !== b.length) {
      push('array-length', { a: a.length, b: b.length })
      ok = false
    }
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const ha = i in a
      const hb = i in b
      if (ha !== hb) {
        push('hole-vs-undefined', { path: `${path}[${i}]`, a: ha ? preview(a[i]) : '<hole>', b: hb ? preview(b[i]) : '<hole>' })
        ok = false
      } else if (ha && !(await diffValues(a[i], b[i], `${path}[${i}]`, out, ctx, depth + 1))) ok = false
    }
    return ok
  }
  if (ka === 'map') {
    ok = a.size === b.size
    if (!ok) push('array-length', { a: a.size, b: b.size, note: 'map size' })
    for (const [k, v] of a) {
      if (!b.has(k)) ok = (push('missing-key', { path: `${path}.get(${preview(k)})` }), false)
      else if (!(await diffValues(v, b.get(k), `${path}.get(${preview(k)})`, out, ctx, depth + 1))) ok = false
    }
    return ok
  }
  if (ka === 'set') {
    if (a.size !== b.size) return push('array-length', { a: a.size, b: b.size, note: 'set size' }), false
    for (const v of a) if (!b.has(v)) ok = (push('missing-key', { path: `${path}.has(${preview(v)})` }), false)
    return ok
  }
  // plain object：键集合 + 逐键
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  for (const k of keysA) {
    if (!hasOwn(b, k)) {
      // 对方没有这个键：若本侧值是 undefined，这是「undefined 属性 vs 缺失」，单独分类
      push(a[k] === undefined ? 'undefined-vs-missing' : 'missing-key', { path: `${path}.${k}`, a: preview(a[k]), b: '<absent>' })
      ok = false
    } else if (!(await diffValues(a[k], b[k], `${path}.${k}`, out, ctx, depth + 1))) ok = false
  }
  for (const k of keysB) {
    if (!hasOwn(a, k)) {
      push(b[k] === undefined ? 'undefined-vs-missing' : 'extra-key', { path: `${path}.${k}`, a: '<absent>', b: preview(b[k]) })
      ok = false
    }
  }
  return ok
}

/**
 * 按主键升序遍历一个 store（分页），同时校验源的分页契约。
 * 返回异步迭代器 `{key, value}`；契约违反时把条目 push 到 `problems`，并停止该 store 的遍历。
 */
async function* walkStore(source, store, side, pageSize, problems, counts) {
  let after
  let previous
  let seen = 0
  let guard = 0
  for (;;) {
    let page
    try {
      page = await source.readBatch(store, after, pageSize)
    } catch (error) {
      problems.push({ kind: 'unreadable', store, side, detail: `${error?.name ?? 'Error'}: ${error?.message ?? error}` })
      return
    }
    if (!page || !Array.isArray(page.rows)) {
      problems.push({ kind: 'source-contract', store, side, detail: 'readBatch did not return {rows:[]}' })
      return
    }
    if (page.rows.length > pageSize) {
      problems.push({ kind: 'source-contract', store, side, detail: `page of ${page.rows.length} rows exceeds limit ${pageSize}` })
    }
    for (const row of page.rows) {
      if (typeof row?.key !== 'string') {
        problems.push({ kind: 'source-contract', store, side, detail: `non-string key ${preview(row?.key)}` })
        return
      }
      if (previous !== undefined && !(row.key > previous)) {
        problems.push({ kind: 'source-contract', store, side, key: row.key, detail: row.key === previous ? 'duplicate key' : `keys not ascending after ${preview(previous)}` })
        return
      }
      previous = row.key
      seen++
      yield row
    }
    if (page.next === undefined) break
    if (after !== undefined && !(page.next > after)) {
      problems.push({ kind: 'source-contract', store, side, detail: `next=${preview(page.next)} did not advance past ${preview(after)}` })
      return
    }
    if (page.rows.length === 0) {
      problems.push({ kind: 'source-contract', store, side, detail: 'empty page with next set' })
      return
    }
    after = page.next
    if (++guard > 5_000_000) {
      problems.push({ kind: 'source-contract', store, side, detail: 'pagination did not terminate' })
      return
    }
  }
  counts[side] = seen
}

/**
 * 比较两个源。A = 期望（迁移前快照），B = 实际（迁移后）。
 * @param {{count, readBatch}} A
 * @param {{count, readBatch}} B
 * @param {{stores?: string[], pageSize?: number, maxDiffs?: number, maxDiffsPerRow?: number, compareContent?: boolean}} [options]
 *   compareContent=false 时只比主键集合与计数（给「只想知道少了哪几行」的场景，默认 true）。
 * @returns {Promise<{ok:boolean, diffs:object[], stores:object[], totals:object}>}
 */
export const compareSources = async (A, B, options = {}) => {
  const stores = options.stores ?? STORE_NAMES
  const pageSize = options.pageSize ?? 64
  const maxDiffs = options.maxDiffs ?? 200
  const compareContent = options.compareContent ?? true
  const diffs = []
  const report = []
  const room = () => diffs.length < maxDiffs
  for (const store of stores) {
    const problems = []
    const counts = {}
    const entry = { store, rowsExpected: 0, rowsActual: 0, missing: 0, extra: 0, changed: 0, declaredCountA: undefined, declaredCountB: undefined }
    for (const [side, src] of [['A', A], ['B', B]]) {
      try {
        entry[`declaredCount${side}`] = await src.count(store)
      } catch (error) {
        problems.push({ kind: 'unreadable', store, side, detail: `count(): ${error?.name ?? 'Error'}: ${error?.message ?? error}` })
      }
    }
    const ia = walkStore(A, store, 'A', pageSize, problems, counts)
    const ib = walkStore(B, store, 'B', pageSize, problems, counts)
    let ra = await ia.next()
    let rb = await ib.next()
    while (!ra.done || !rb.done) {
      if (!ra.done && (rb.done || ra.value.key < rb.value.key)) {
        entry.rowsExpected++
        entry.missing++
        if (room()) diffs.push({ kind: 'missing-row', store, key: ra.value.key })
        ra = await ia.next()
      } else if (!rb.done && (ra.done || rb.value.key < ra.value.key)) {
        entry.rowsActual++
        entry.extra++
        if (room()) diffs.push({ kind: 'extra-row', store, key: rb.value.key })
        rb = await ib.next()
      } else {
        entry.rowsExpected++
        entry.rowsActual++
        if (compareContent) {
          const rowDiffs = []
          let same
          try {
            same = await diffValues(ra.value.value, rb.value.value, '$', rowDiffs, options)
          } catch (error) {
            same = false
            rowDiffs.push({ kind: 'unreadable', path: '$', detail: `${error?.name ?? 'Error'}: ${error?.message ?? error}` })
          }
          if (!same) {
            entry.changed++
            for (const d of rowDiffs) if (room()) diffs.push({ store, key: ra.value.key, ...d })
          }
        }
        ra = await ia.next()
        rb = await ib.next()
      }
    }
    for (const p of problems) if (room()) diffs.push({ ...p, store })
    // 源自己声明的 count 必须等于实际枚举行数（枚举被契约违反中止时跳过，已经有 source-contract 条目）
    for (const side of ['A', 'B']) {
      const declared = entry[`declaredCount${side}`]
      const actual = side === 'A' ? entry.rowsExpected : entry.rowsActual
      const aborted = problems.some((p) => p.side === side)
      if (!aborted && declared !== undefined && declared !== actual && room()) {
        diffs.push({ kind: 'source-contract', store, side, detail: `count()=${declared} but enumerated ${actual} rows` })
      }
    }
    report.push(entry)
  }
  const totals = report.reduce(
    (t, e) => ({ missing: t.missing + e.missing, extra: t.extra + e.extra, changed: t.changed + e.changed, rows: t.rows + e.rowsExpected }),
    { missing: 0, extra: 0, changed: 0, rows: 0 },
  )
  return { ok: diffs.length === 0, diffs, stores: report, totals, truncated: diffs.length >= maxDiffs }
}

/** 一行可读摘要（给测试失败信息用）。 */
export const summarize = (result, limit = 12) => {
  if (result.ok) return `identical (${result.totals.rows} rows over ${result.stores.length} stores)`
  const head = result.diffs.slice(0, limit).map((d) => `${d.kind} ${d.store}${d.key !== undefined ? `/${preview(d.key, 40)}` : ''}${d.path ? ` ${d.path}` : ''}${d.a !== undefined ? ` a=${d.a}` : ''}${d.b !== undefined ? ` b=${d.b}` : ''}${d.detail ? ` ${d.detail}` : ''}`)
  return `${result.diffs.length}${result.truncated ? '+' : ''} differences\n  ${head.join('\n  ')}`
}

/** 断言两个源相同；不同则抛带差异清单的错误。 */
export const assertSourcesEqual = async (A, B, options) => {
  const r = await compareSources(A, B, options)
  if (!r.ok) {
    const error = new Error(`sources differ: ${summarize(r)}`)
    error.name = 'OracleMismatch'
    error.result = r
    throw error
  }
  return r
}

// ---------------------------------------------------------------- 引用关系（外键等价物）

/**
 * IndexedDB 没有外键；应用靠主键引用维持关系。边：
 *   sessionSummaries.fileIds[*]      → files
 *   sessions.messages[user].files[*] → files（本地没有原件的附件是**合法悬空**，所以只比较「期望里没有、实际里新出现」的悬空）
 *   attachments.localPath            → files
 *   attachments.parsedTextPath       → attachmentTexts
 *   attachmentTexts.sha256           → 存在同 sha256 的 attachments（孤儿全文合法，不算）
 *   sessionMemory.sessionId          → sessions
 *   sessionSummaries.id              → sessions（摘要对应会话）
 *   sessions.branchOf.sessionId      → sessions（父会话被删是合法悬空）
 * 返回悬空边集合 `Set<"from-store/from-key -> to-store/to-key">`。
 */
export const danglingEdges = async (source, options = {}) => {
  const pageSize = options.pageSize ?? 64
  const keys = Object.fromEntries(STORE_NAMES.map((s) => [s, new Set()]))
  const rows = Object.fromEntries(STORE_NAMES.map((s) => [s, []]))
  for (const store of STORE_NAMES) {
    let after
    for (;;) {
      const page = await source.readBatch(store, after, pageSize)
      for (const r of page.rows) {
        keys[store].add(r.key)
        if (['sessions', 'sessionSummaries', 'attachments', 'sessionMemory'].includes(store)) rows[store].push(r)
      }
      if (page.next === undefined) break
      after = page.next
    }
  }
  const out = new Set()
  const edge = (fs, fk, ts, tk) => {
    if (typeof tk === 'string' && !keys[ts].has(tk)) out.add(`${fs}/${fk} -> ${ts}/${tk}`)
  }
  for (const r of rows.sessionSummaries) {
    for (const f of Array.isArray(r.value?.fileIds) ? r.value.fileIds : []) edge('sessionSummaries', r.key, 'files', f)
    edge('sessionSummaries', r.key, 'sessions', r.key)
  }
  for (const r of rows.sessions) {
    for (const m of Array.isArray(r.value?.messages) ? r.value.messages : []) {
      if (m?.role === 'user') for (const f of Array.isArray(m.files) ? m.files : []) edge('sessions', r.key, 'files', f?.id)
    }
    if (r.value?.branchOf) edge('sessions', r.key, 'sessions', r.value.branchOf.sessionId)
  }
  for (const r of rows.attachments) {
    edge('attachments', r.key, 'files', r.value?.localPath)
    if (r.value?.parsedTextPath !== undefined) edge('attachments', r.key, 'attachmentTexts', r.value.parsedTextPath)
  }
  for (const r of rows.sessionMemory) edge('sessionMemory', r.key, 'sessions', r.value?.sessionId)
  return out
}

/** B 里**新出现**的悬空边 = 迁移造成的外键断裂（A 里本来就悬空的不算）。 */
export const brokenReferences = async (A, B, options) => {
  const [da, db] = [await danglingEdges(A, options), await danglingEdges(B, options)]
  return [...db].filter((e) => !da.has(e)).sort()
}

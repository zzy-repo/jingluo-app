// [layer: unit | 依赖: tests/helpers/migration-faults/* | 耗时: <3s]
//
// #910 / #921：独立判据 oracle 的自检。判据自己不可信，就不能拿来验收别人。
// 每一类差异都有「改坏一处 → 必须报出该类差异」的负向对照，另有「没改 → 必须报相同」的正向对照。
//   node tests/run-layer.mjs unit --case migration-oracle-selftest
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { digestValue } from '../helpers/migration-faults/canon.mjs'
import { buildManifest, generateDataset } from '../helpers/migration-faults/dataset.mjs'
import { brokenReferences, compareSources, diffValues } from '../helpers/migration-faults/oracle.mjs'
import { cloneData, emptyData, memorySource, STORE_NAMES } from '../helpers/migration-faults/sources.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const helperDir = join(here, '..', 'helpers', 'migration-faults')

const kinds = (result) => result.diffs.map((d) => d.kind)
const compare = (a, b, options) => compareSources(memorySource(a), memorySource(b), { pageSize: 3, ...options })

let base
test.before(async () => {
  base = await generateDataset({ scale: 'small', seed: 7 })
})
test.after(() => base?.cleanup())

/** 克隆基准，对副本做一处改动，返回比较结果。 */
const mutated = async (fn) => {
  const copy = cloneData(base.data)
  await fn(copy)
  return compare(base.data, copy)
}

// ---------------------------------------------------------------- 独立性

test('独立性：判据文件不 import src/** 也不 import migration/verify', () => {
  for (const name of readdirSync(helperDir).filter((f) => f.endsWith('.mjs'))) {
    const text = readFileSync(join(helperDir, name), 'utf8')
    const imports = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2])
    for (const spec of imports) {
      assert.ok(!/(^|\/)src\//.test(spec), `${name} imports ${spec}`)
      assert.ok(!/verify(\.|$)/.test(spec) && !/storage\//.test(spec), `${name} imports ${spec}`)
    }
  }
})

test('store 清单与契约一致（漂移即红）', () => {
  const types = readFileSync(join(here, '..', '..', 'src', 'services', 'storage', 'migration', 'types.ts'), 'utf8')
  const block = types.match(/RAW_STORE_NAMES = \[([\s\S]*?)\] as const/)[1]
  const declared = [...block.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
  assert.deepEqual([...STORE_NAMES], declared)
})

// ---------------------------------------------------------------- 正向对照

test('正向：相同数据集（独立副本）判相同', async () => {
  const r = await compare(base.data, cloneData(base.data))
  assert.equal(r.ok, true, JSON.stringify(r.diffs.slice(0, 3)))
  assert.equal(r.totals.rows, STORE_NAMES.reduce((n, s) => n + base.data[s].size, 0))
})

test('正向：同 seed 重新生成的数据集 manifest 逐字节相同；不同 seed 不同', async () => {
  const again = await generateDataset({ scale: 'small', seed: 7 })
  const other = await generateDataset({ scale: 'small', seed: 8 })
  const [m1, m2, m3] = [await buildManifest(base.data), await buildManifest(again.data), await buildManifest(other.data)]
  assert.equal(m1.manifestSha256, m2.manifestSha256)
  assert.notEqual(m1.manifestSha256, m3.manifestSha256)
  assert.equal((await compare(base.data, again.data)).ok, true)
  again.cleanup()
  other.cleanup()
})

test('正向：分页大小不影响结论（1 / 3 / 1000）', async () => {
  const copy = cloneData(base.data)
  for (const pageSize of [1, 3, 1000]) assert.equal((await compare(base.data, copy, { pageSize })).ok, true, `pageSize=${pageSize}`)
})

// ---------------------------------------------------------------- 负向对照：逐类差异

test('负向：少一行 → missing-row', async () => {
  const r = await mutated((d) => d.sessions.delete([...d.sessions.keys()][2]))
  assert.equal(r.ok, false)
  assert.ok(kinds(r).includes('missing-row'))
  assert.equal(r.totals.missing, 1)
})

test('负向：多一行 → extra-row', async () => {
  const r = await mutated((d) => d.sessionMemory.set('zzz:extra', { id: 'zzz:extra', sessionId: 'zzz', key: 'extra', text: '', bytes: 0, createdAt: 0, updatedAt: 0 }))
  assert.ok(kinds(r).includes('extra-row'))
  assert.equal(r.totals.extra, 1)
})

test('负向：主键错一个字符（同数量）→ 同时 missing-row 与 extra-row', async () => {
  const r = await mutated((d) => {
    const [key, value] = [...d.sessions.entries()][1]
    d.sessions.delete(key)
    d.sessions.set(`${key}x`, { ...value, id: `${key}x` })
  })
  assert.deepEqual([...new Set(kinds(r))].sort(), ['extra-row', 'missing-row'])
})

test('负向：改一个字符（正文）→ value，路径指到该字段', async () => {
  const r = await mutated((d) => {
    const [k, v] = [...d.sessions.entries()].find(([, s]) => s.messages.length > 0)
    const m = structuredClone(v)
    m.messages[0].content += '。'
    d.sessions.set(k, m)
  })
  const hit = r.diffs.find((x) => x.kind === 'value')
  assert.ok(hit, JSON.stringify(r.diffs))
  assert.match(hit.path, /^\$\.messages\[0\]\.content$/)
})

test('负向：改字段值（标题）/ 改数字（updatedAt+1）→ value', async () => {
  for (const [field, fn] of [['title', (s) => `${s.title}!`], ['updatedAt', (s) => s.updatedAt + 1]]) {
    const r = await mutated((d) => {
      const [k, v] = [...d.sessions.entries()][0]
      d.sessions.set(k, { ...v, [field]: fn(v) })
    })
    assert.ok(kinds(r).includes('value'), field)
  }
})

test('负向：Blob 改一个字节（长度、type 不变）→ blob-bytes，且只有它', async () => {
  const r = await mutated(async (d) => {
    const [k, v] = [...d.files.entries()].find(([, f]) => f.blob.size > 10)
    const bytes = new Uint8Array(await v.blob.arrayBuffer())
    bytes[bytes.length - 1] ^= 1
    d.files.set(k, { ...v, blob: new Blob([bytes], { type: v.blob.type }) })
  })
  assert.deepEqual(kinds(r), ['blob-bytes'])
})

test('负向：Blob 只改 MIME → blob-type；只截短 → blob-size', async () => {
  const r1 = await mutated(async (d) => {
    const [k, v] = [...d.files.entries()][0]
    d.files.set(k, { ...v, blob: new Blob([await v.blob.arrayBuffer()], { type: `${v.blob.type}x` }) })
  })
  assert.ok(kinds(r1).includes('blob-type'))
  const r2 = await mutated(async (d) => {
    const [k, v] = [...d.files.entries()].find(([, f]) => f.blob.size > 10)
    d.files.set(k, { ...v, blob: v.blob.slice(0, v.blob.size - 1, v.blob.type) })
  })
  assert.ok(kinds(r2).includes('blob-size'))
})

test('负向：丢字段 → missing-key；多字段 → extra-key', async () => {
  const r1 = await mutated((d) => {
    const [k, v] = [...d.attachments.entries()][0]
    const { sha256: _drop, ...rest } = v
    d.attachments.set(k, rest)
  })
  assert.ok(r1.diffs.some((x) => x.kind === 'missing-key' && x.path === '$.sha256'))
  const r2 = await mutated((d) => {
    const [k, v] = [...d.attachments.entries()][0]
    d.attachments.set(k, { ...v, injected: 1 })
  })
  assert.ok(r2.diffs.some((x) => x.kind === 'extra-key' && x.path === '$.injected'))
})

test('负向：类型被改（number→string、[]→{}、null→undefined、Blob→Uint8Array）→ type', async () => {
  const cases = [
    [{ n: 1 }, { n: '1' }],
    [{ a: [] }, { a: {} }],
    [{ a: null }, { a: undefined }],
    [{ b: new Blob(['ab']) }, { b: new Uint8Array([97, 98]) }],
    [{ d: new Date(5) }, { d: 5 }],
    [{ t: true }, { t: 1 }],
  ]
  for (const [a, b] of cases) {
    const out = []
    assert.equal(await diffValues(a, b, '$', out), false)
    assert.ok(out.some((x) => x.kind === 'type'), JSON.stringify(out))
  }
})

test('负向：外键断裂（删被引用的原件 / 删会话）→ brokenReferences 非空，且基准自身为空', async () => {
  assert.deepEqual(await brokenReferences(memorySource(base.data), memorySource(base.data)), [])
  const copy = cloneData(base.data)
  const referenced = [...copy.sessionSummaries.values()].flatMap((s) => s.fileIds).find((id) => copy.files.has(id))
  assert.ok(referenced, '数据集必须含被引用的原件')
  copy.files.delete(referenced)
  const broken = await brokenReferences(memorySource(base.data), memorySource(copy))
  assert.ok(broken.some((e) => e.endsWith(`-> files/${referenced}`)), broken.join('\n'))
  const copy2 = cloneData(base.data)
  const sid = [...copy2.sessionMemory.values()][0].sessionId
  copy2.sessions.delete(sid)
  assert.ok((await brokenReferences(memorySource(base.data), memorySource(copy2))).some((e) => e.includes(`sessions/${sid}`)))
})

// ---------------------------------------------------------------- 相等语义的边角

const same = async (a, b) => {
  const out = []
  const ok = await diffValues(a, b, '$', out)
  return { ok, out }
}

test('-0 与 0 不同；NaN 与 NaN 相同；NaN 与数不同', async () => {
  assert.equal((await same(0, -0)).ok, false)
  assert.equal((await same(-0, -0)).ok, true)
  assert.equal((await same(NaN, NaN)).ok, true)
  assert.equal((await same(NaN, 0)).ok, false)
  assert.equal((await same([-0], [0])).ok, false)
  assert.notEqual(await digestValue(-0), await digestValue(0))
  assert.equal(await digestValue(NaN), await digestValue(NaN))
})

test('undefined 属性 ≠ 缺失键；数组空洞 ≠ undefined 元素', async () => {
  const r1 = await same({ a: undefined }, {})
  assert.equal(r1.ok, false)
  assert.equal(r1.out[0].kind, 'undefined-vs-missing')
  const r2 = await same({}, { a: undefined })
  assert.equal(r2.out[0].kind, 'undefined-vs-missing')
  // eslint-disable-next-line no-sparse-arrays
  const r3 = await same([1, , 3], [1, undefined, 3])
  assert.equal(r3.ok, false)
  assert.equal(r3.out[0].kind, 'hole-vs-undefined')
  assert.notEqual(await digestValue({ a: undefined }), await digestValue({}))
})

test('字符串按 UTF-16 码元：孤立代理项 ≠ U+FFFD；NUL 截断 ≠ 原串；仅差一个码元也能抓到', async () => {
  assert.equal((await same('a\ud800b', 'a\ufffdb')).ok, false)
  assert.equal((await same('a\u0000b', 'a')).ok, false)
  assert.equal((await same('a\ud800b', 'a\udc00b')).ok, false)
  assert.equal((await same('x\ud83d', 'x\ufffd')).ok, false)
  assert.equal((await same('a\ud800b', 'a\ud800b')).ok, true)
  assert.equal((await same('😀', '\ud83d\ude00')).ok, true)
  assert.notEqual(await digestValue('a\ud800'), await digestValue('a\ufffd'))
  assert.notEqual(await digestValue('a\0'), await digestValue('a'))
  const long = 'y'.repeat(200_000)
  assert.equal((await same(long, `${long.slice(0, 199_999)}z`)).ok, false)
})

test('Date 比时间戳；Invalid Date 与有效日期不同；Date 与同值数字不同', async () => {
  assert.equal((await same(new Date(5), new Date(5))).ok, true)
  assert.equal((await same(new Date(5), new Date(6))).ok, false)
  assert.equal((await same(new Date(NaN), new Date(NaN))).ok, true)
  assert.equal((await same(new Date(NaN), new Date(0))).ok, false)
})

test('对象属性顺序不是语义', async () => {
  assert.equal((await same({ a: 1, b: 2 }, { b: 2, a: 1 })).ok, true)
  assert.equal(await digestValue({ a: 1, b: 2 }), await digestValue({ b: 2, a: 1 }))
})

test('循环结构 → 规范化抛 UncomparableValueError（不死循环）', async () => {
  const a = { x: 1 }
  a.self = a
  await assert.rejects(() => digestValue(a), { name: 'UncomparableValueError' })
})

// ---------------------------------------------------------------- 源契约（坏源不能造成假通过）

const wrapReadBatch = (data, transform) => {
  const src = memorySource(data)
  return { ...src, readBatch: async (store, after, limit) => transform(await src.readBatch(store, after, limit), store, after, limit) }
}

test('源契约：count 与枚举不符 → source-contract', async () => {
  const lying = { ...memorySource(base.data), count: async () => 9999 }
  const r = await compareSources(memorySource(base.data), lying, { pageSize: 5 })
  assert.ok(r.diffs.some((d) => d.kind === 'source-contract' && /count\(\)=9999/.test(d.detail)))
})

test('源契约：两边都「读少了」不能被判相同（空源 vs 空源以外，坏分页 vs 坏分页）', async () => {
  // 两边都在第一页后丢掉 next：枚举到的行数都少于 count()
  const truncating = (d) => wrapReadBatch(d, (page) => ({ rows: page.rows }))
  const r = await compareSources(truncating(base.data), truncating(base.data), { pageSize: 2 })
  assert.equal(r.ok, false)
  assert.ok(r.diffs.some((d) => d.kind === 'source-contract'))
})

test('源契约：乱序、重复、next 不前进、单页超限 → source-contract', async () => {
  const bad = {
    unordered: wrapReadBatch(base.data, (p) => ({ ...p, rows: [...p.rows].reverse() })),
    duplicate: wrapReadBatch(base.data, (p) => ({ ...p, rows: p.rows.length ? [p.rows[0], ...p.rows] : p.rows })),
    stuck: wrapReadBatch(base.data, (p, _s, after) => (p.next === undefined ? p : { ...p, next: after ?? '' })),
    oversize: wrapReadBatch(base.data, (p, s) => (p.rows.length ? { rows: [...p.rows, { key: `~${s}`, value: {} }] } : p)),
  }
  for (const [name, src] of Object.entries(bad)) {
    const r = await compareSources(memorySource(base.data), src, { pageSize: 2 })
    assert.equal(r.ok, false, name)
    assert.ok(r.diffs.some((d) => d.kind === 'source-contract' || d.kind === 'extra-row' || d.kind === 'missing-row'), name)
  }
})

test('读取抛错 → unreadable（不是静默当空）', async () => {
  const boom = { ...memorySource(base.data), readBatch: async () => { throw Object.assign(new Error('x'), { name: 'DataCloneError' }) } }
  const r = await compareSources(memorySource(base.data), boom)
  assert.ok(r.diffs.some((d) => d.kind === 'unreadable' && /DataCloneError/.test(d.detail)))
})

test('空源 vs 空源 = 相同；空源 vs 非空 = 差异（「正常空库」不能被当成通过）', async () => {
  assert.equal((await compare(emptyData(), emptyData())).ok, true)
  const r = await compare(base.data, emptyData())
  assert.equal(r.ok, false)
  assert.equal(r.totals.missing, r.totals.rows)
})

// ---------------------------------------------------------------- 数据集覆盖（生成器自己要有区分力）

test('数据集含全部必测形态', async () => {
  const d = base.data
  assert.ok([...d.sessions.values()].some((s) => s.branchOf !== undefined), 'branchOf')
  assert.ok([...d.sessions.values()].some((s) => s.pinnedAt === 0), 'pinnedAt=0（假值但存在）')
  assert.ok([...d.sessions.values()].some((s) => 'rootMessageId' in s && s.rootMessageId === undefined), '显式 undefined 属性')
  assert.ok([...d.sessions.values()].some((s) => !('pinnedAt' in s)), '缺失键')
  assert.ok([...d.sessions.values()].some((s) => s.userIdentity !== undefined), '旧字段')
  assert.ok([...d.sessionSummaries.values()].some((s) => s.fileIds.length > 0), '带 fileIds')
  assert.ok([...d.files.keys()].some((k) => k.startsWith('attachment-')), 'attachment- 文档原件')
  assert.ok([...d.files.values()].some((f) => f.blob.size === 0), '空 Blob')
  assert.ok(d.attachmentTexts.size > 0 && d.sessionMemory.size > 0 && d.appAssets.size > 0)
  assert.ok([...d.sessionMemory.values()].some((m) => m.vec?.some((x) => Object.is(x, -0))), '向量里的 -0')
  const text = JSON.stringify([...d.sessions.values()].map((s) => s.title + s.messages.map((m) => m.content ?? m.blocks?.[1]?.text).join('')))
  assert.ok(text.includes('\\u0000'), 'NUL')
  assert.ok(text.includes('\\ud800'), '孤立代理项')
})

// [layer: unit | 依赖: 纯 Node（hash.ts 无 DOM/IDB 依赖） | 耗时: <5s]
//
// #910 迁移引擎：规范化内容哈希。钉三件事：增量 SHA-256 与 node:crypto 逐字节一致；
// 规范化对「键序无关、类型敏感、Blob 比字节」；不认识的类型抛错、不猜。
//
//   node tests/run-layer.mjs unit --case migration-engine-hash
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { GeneratedBlob } from '../helpers/migration-engine/mem.mjs'

installTsResolve()
const hash = await loadTsModule('src/services/storage/migration/hash.ts')

test('Sha256Stream 与 node:crypto 一致（含 55/56/63/64/65 边界与分片喂入）', () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
    const bytes = randomBytes(length)
    const expected = createHash('sha256').update(bytes).digest('hex')
    assert.equal(new hash.Sha256Stream().update(bytes).digestHex(), expected, `length=${length}`)
    const stream = new hash.Sha256Stream()
    for (let at = 0; at < length; at += 7) {
      stream.update(bytes.subarray(at, Math.min(length, at + 7)))
    }
    assert.equal(stream.digestHex(), expected, `chunked length=${length}`)
  }
})

test('sha256HexOfBytes（crypto.subtle）与 node:crypto 一致', async () => {
  const bytes = randomBytes(5000)
  assert.equal(await hash.sha256HexOfBytes(bytes), createHash('sha256').update(bytes).digest('hex'))
})

test('Blob：真 Blob 与生成式大 Blob（3.5MiB，跨片）按字节哈希，与独立实现一致', async () => {
  const real = new Blob([randomBytes(3000)], { type: 'x/y' })
  const text = await hash.canonicalText({ b: real })
  assert.match(text, /^\{"b":B"x\/y":3000:[0-9a-f]{64}\}$/)
  const big = new GeneratedBlob(3 * 1024 * 1024 + 517, 9)
  assert.equal(await hash.sha256HexOfBlob(big), big.expectedSha256())
})

test('键序无关；数组保序；属性值 undefined ≡ 没有该属性', async () => {
  assert.equal(await hash.hashValue({ a: 1, b: { c: 2, d: 3 } }), await hash.hashValue({ b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(await hash.hashValue([1, 2]), await hash.hashValue([2, 1]))
  assert.equal(await hash.hashValue({ a: 1, v: undefined }), await hash.hashValue({ a: 1 }))
  assert.notEqual(await hash.hashValue([undefined]), await hash.hashValue([null]))
})

test('类型敏感：Date≠字符串≠数字，NaN/-0/Infinity 各自有标签，字符串"1"≠数字1', async () => {
  const values = [new Date(5), '1970-01-01T00:00:00.005Z', 5, '5', NaN, 'NaN', -0, 0, Infinity, 'Infinity', null, 'null', true, 'true', 5n]
  const seen = new Map()
  for (const value of values) {
    const digest = await hash.hashValue(value)
    assert.ok(!seen.has(digest), `${String(value)} 与 ${String(seen.get(digest))} 哈希相同`)
    seen.set(digest, value)
  }
  assert.equal(await hash.hashValue(new Date(NaN)), await hash.hashValue(new Date(NaN)))
})

test('二进制：Uint8Array / ArrayBuffer / Blob 彼此不同类型但各自按字节比较', async () => {
  const a = new Uint8Array([1, 2, 3])
  assert.equal(await hash.hashValue(a), await hash.hashValue(new Uint8Array([1, 2, 3])))
  assert.notEqual(await hash.hashValue(a), await hash.hashValue(new Uint8Array([1, 2, 4])))
  assert.notEqual(await hash.hashValue(a), await hash.hashValue(a.buffer))
  assert.notEqual(await hash.hashValue(new Blob([a])), await hash.hashValue(new Blob([new Uint8Array([1, 2, 4])])))
  assert.notEqual(await hash.hashValue(new Blob([a], { type: 'a/b' })), await hash.hashValue(new Blob([a], { type: 'a/c' })))
})

test('不认识的类型直接抛错：函数 / symbol / Map / Set / 类实例 / 环', async () => {
  class Foo {}
  const cyc = {}
  cyc.self = cyc
  for (const bad of [() => 1, Symbol('x'), new Map(), new Set(), new Foo(), cyc, { nested: [() => 1] }]) {
    await assert.rejects(() => hash.hashValue(bad), /hash:/)
  }
})

test('hashRow 含主键：同值不同键哈希不同', async () => {
  assert.notEqual(await hash.hashRow({ key: 'a', value: 1 }), await hash.hashRow({ key: 'b', value: 1 }))
})

test('estimateValueBytes 宁高勿低：Blob 记 size，字符串按 UTF-8 上界', () => {
  const blob = new Blob([new Uint8Array(1000)])
  assert.ok(hash.estimateValueBytes({ blob }) >= 1000)
  const text = '你好😀'.repeat(10)
  assert.ok(hash.estimateValueBytes(text) >= new TextEncoder().encode(text).length)
  assert.ok(hash.estimateRowBytes({ key: 'k', value: { v: new Float64Array(100) } }) >= 800)
})

test('fingerprintSource：键集合变（多/少/换键）指纹变，值变不变；同一内容两次相同', async () => {
  const { createMem, makeFixture } = await import('../helpers/migration-engine/mem.mjs')
  const a = createMem(makeFixture())
  const b = createMem(makeFixture())
  const base = await hash.fingerprintSource(a.source)
  assert.equal(await hash.fingerprintSource(b.source), base)
  b.set('sessions', 's000', { changed: true })
  assert.equal(await hash.fingerprintSource(b.source), base, '只改内容不改键：指纹不变（内容由全量校验兜底）')
  b.remove('files', 'img-s001')
  assert.notEqual(await hash.fingerprintSource(b.source), base)
  b.set('files', 'img-s001x', { id: 'x' })
  assert.notEqual(await hash.fingerprintSource(b.source), base)
  assert.match(base, /^fp1:[0-9a-f]{64}$/)
})

// [helper | 依赖: node:crypto | 无全局副作用]
//
// #910 / #921：独立判据的「规范化编码 + 结构化差异」内核。
//
// 独立性：本文件不 import `src/**` 的任何东西（不碰 storage/**、migration/verify.ts、chat/db.ts），
// 与 migration-engine 的 verify.ts 是**另一份实现**。静态扫描见 tests/unit/migration-oracle-selftest.test.mjs。
//
// 比较语义（都是 IndexedDB 结构化克隆里真实存在、且 JSON 往返会丢的区别）：
//   · `undefined` 属性与「键缺失」不同；数组空洞与 `undefined` 元素不同；
//   · `-0` 与 `0` 不同，`NaN` 与任何数不同、与 `NaN` 相同（规范化为同一编码）；
//   · 字符串按 UTF-16 码元逐个比较（孤立代理项、NUL 原样参与，不经 UTF-8/JSON）；
//   · Blob 比字节（sha256 + 长度）与 type；Date 比时间戳（含 Invalid Date）；
//   · 类型必须相同：`1` 与 `'1'`、`[]` 与 `{}`、Blob 与 Uint8Array 都是差异。
import { createHash } from 'node:crypto'

export class UncomparableValueError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'UncomparableValueError'
  }
}

const isBlob = (v) => typeof Blob !== 'undefined' && v instanceof Blob
const tagOf = (v) => Object.prototype.toString.call(v).slice(8, -1)
const isPlain = (v) => {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const f64 = (n) => {
  const b = Buffer.alloc(8)
  b.writeDoubleBE(n) // NaN 写成规范 NaN；-0 与 0 的字节不同
  return b
}
const str = (s) => Buffer.concat([u32(s.length), Buffer.from(s, 'utf16le')]) // utf16le 保留孤立代理项

/** 值的粗分类：两侧分类不同 = 类型差异。 */
export const kindOf = (v) => {
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'boolean' || t === 'number' || t === 'bigint' || t === 'string') return t
  if (t === 'symbol' || t === 'function') return 'uncloneable'
  if (isBlob(v)) return 'blob'
  if (v instanceof Date) return 'date'
  if (v instanceof ArrayBuffer) return 'arraybuffer'
  if (ArrayBuffer.isView(v)) return `view:${tagOf(v)}`
  if (v instanceof RegExp) return 'regexp'
  if (Array.isArray(v)) return 'array'
  if (v instanceof Map) return 'map'
  if (v instanceof Set) return 'set'
  if (tagOf(v) === 'Object' && isPlain(v)) return 'object'
  return `other:${tagOf(v)}`
}

/** 给人看的短预览（码元级转义，截断）。 */
export const preview = (v, max = 80) => {
  const k = kindOf(v)
  let text
  if (k === 'string') {
    text = JSON.stringify(v.replace(/[\u0000-\u001f\ud800-\udfff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))
  } else if (k === 'number') {
    text = Object.is(v, -0) ? '-0' : String(v)
  } else if (k === 'blob') {
    text = `Blob(size=${v.size},type=${JSON.stringify(v.type)})`
  } else if (k === 'date') {
    text = `Date(${v.getTime()})`
  } else if (k === 'array') {
    text = `Array(${v.length})`
  } else if (k === 'object') {
    text = `Object{${Object.keys(v).slice(0, 6).join(',')}}`
  } else if (k === 'bigint') {
    text = `${v}n`
  } else {
    text = k === 'undefined' || k === 'null' || k === 'boolean' ? String(v) : `<${k}>`
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Blob 内容的 sha256（流式，不整块进内存）。 */
export const blobSha256 = async (blob) => {
  const h = createHash('sha256')
  for await (const chunk of blob.stream()) h.update(chunk)
  return h.digest('hex')
}


/**
 * 把值的规范编码喂给 hash（Blob 内容流式喂入）。编码里每个值都以类型标签开头，
 * 所以 `1`/`'1'`、`[]`/`{}`、`undefined` 属性/缺失键、-0/0 的编码互不相同。
 * 对象属性按 UTF-16 码元序排序后编码（属性插入顺序不是语义）。数组空洞与 `undefined` 元素编码不同。
 */
export const feedValue = async (hash, v, stack = []) => {
  const k = kindOf(v)
  switch (k) {
    case 'undefined': return void hash.update('U')
    case 'null': return void hash.update('N')
    case 'boolean': return void hash.update(v ? 'T' : 'F')
    case 'number': return void hash.update(Buffer.concat([Buffer.from('n'), f64(v)]))
    case 'bigint': return void hash.update(Buffer.concat([Buffer.from('i'), str(v.toString())]))
    case 'string': return void hash.update(Buffer.concat([Buffer.from('s'), str(v)]))
    case 'date': return void hash.update(Buffer.concat([Buffer.from('d'), f64(v.getTime())]))
    case 'regexp': return void hash.update(Buffer.concat([Buffer.from('r'), str(v.source), str(v.flags)]))
    case 'blob': {
      hash.update(Buffer.concat([Buffer.from('b'), str(v.type), f64(v.size)]))
      hash.update(await blobSha256(v))
      return
    }
    case 'arraybuffer': {
      hash.update(Buffer.concat([Buffer.from('a'), f64(v.byteLength)]))
      return void hash.update(new Uint8Array(v))
    }
    case 'array': {
      if (stack.includes(v)) throw new UncomparableValueError('cyclic structure')
      stack.push(v)
      hash.update(Buffer.concat([Buffer.from('['), u32(v.length)]))
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) hash.update('H')
        else await feedValue(hash, v[i], stack)
      }
      stack.pop()
      return void hash.update(']')
    }
    case 'object': {
      if (stack.includes(v)) throw new UncomparableValueError('cyclic structure')
      stack.push(v)
      const keys = Object.keys(v).sort()
      hash.update(Buffer.concat([Buffer.from('{'), u32(keys.length)]))
      for (const key of keys) {
        hash.update(str(key))
        await feedValue(hash, v[key], stack)
      }
      stack.pop()
      return void hash.update('}')
    }
    default:
      if (k.startsWith('view:')) {
        hash.update(Buffer.concat([Buffer.from('v'), str(k), f64(v.byteLength)]))
        return void hash.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
      }
      throw new UncomparableValueError(`cannot canonicalize value of kind ${k}`)
  }
}

export const digestValue = async (v) => {
  const hash = createHash('sha256')
  await feedValue(hash, v)
  return hash.digest('hex')
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

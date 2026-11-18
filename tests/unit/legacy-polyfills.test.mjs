// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #13「低内核白屏」的**运行时**那一半：语法降级（rspack target=chrome83）只能让
// main.js 解析得动，Object.hasOwn / Array.prototype.at / structuredClone 这些是**运行时 API**，
// 必须在入口最早处补齐。本用例把宿主里的原生实现**真的删掉**（模拟 WebView 83），
// 再走真实入口模块，验证：
//   1 删掉后功能可用（不是 try/catch 兜住，而是真的能跑）
//   2 幂等：重复 install 不会重复定义（方法引用不变）
//   3 不覆盖已存在的原生实现（新版 WebView 上必须等于什么都没做）
//   4 structuredClone 的降级路径：函数/DOM 这类不可深拷贝的值按引用透传而不是抛错；
//     真·transfer 列表明确抛 DataCloneError（不静默丢语义）
//
// 为什么能直接 import 源码 .ts：node 22 的 type stripping + 下面的 resolve hook（与
// tests/unit/legacy-webview-compat.test.mjs 同一套手法）。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const MODULE = '../../src/polyfills/legacy.ts'

const REMOVED_APIS = [
  ['Object', 'hasOwn'],
  ['Array.prototype', 'at'],
  ['String.prototype', 'at'],
  ['Array.prototype', 'findLast'],
  ['Array.prototype', 'findLastIndex'],
  ['Array.prototype', 'toSorted'],
  ['Array.prototype', 'toReversed'],
  ['Array.prototype', 'toSpliced'],
  ['Array.prototype', 'with'],
]

const holderOf = (path) =>
  path.split('.').reduce((owner, key) => (owner ? owner[key] : undefined), globalThis)

/** 模拟 WebView 83：把这些 API 真的从宿主里删掉，返回恢复函数 */
const withoutModernApis = () => {
  const saved = []
  for (const [holderPath, name] of REMOVED_APIS) {
    const holder = holderOf(holderPath)
    saved.push([holder, name, Object.getOwnPropertyDescriptor(holder, name)])
    delete holder[name]
  }
  const savedClone = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone')
  delete globalThis.structuredClone
  const savedUuid = globalThis.crypto ? Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID') : undefined
  if (globalThis.crypto && savedUuid) {
    delete globalThis.crypto.randomUUID
  }
  return () => {
    for (const [holder, name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(holder, name, descriptor)
      }
    }
    if (savedClone) {
      Object.defineProperty(globalThis, 'structuredClone', savedClone)
    }
    if (globalThis.crypto && savedUuid) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', savedUuid)
    }
  }
}

test('模拟 WebView 83：入口 polyfill 装上后 Object.hasOwn / at / structuredClone 真的能用', async (t) => {
  const restore = withoutModernApis()
  t.after(restore)
  try {
    assert.equal(globalThis.Object.hasOwn, undefined, '前置：宿主里已无 Object.hasOwn')
    assert.equal(Array.prototype.at, undefined, '前置：宿主里已无 Array.prototype.at')
    assert.equal(globalThis.structuredClone, undefined, '前置：宿主里已无 structuredClone')

    const { installLegacyPolyfills, LEGACY_POLYFILL_FLAG, LEGACY_POLYFILL_VERSION } = await import(MODULE)
    installLegacyPolyfills()

    // 1. Object.hasOwn
    assert.equal(Object.hasOwn({ a: 1 }, 'a'), true)
    assert.equal(Object.hasOwn({ a: 1 }, 'b'), false)
    assert.equal(Object.hasOwn({}, 'toString'), false, '原型链上的属性不算自有')
    assert.throws(() => Object.hasOwn(null, 'a'), TypeError, 'null 上调用要抛 TypeError（与原生一致）')
    assert.equal(Object.getOwnPropertyDescriptor(Object, 'hasOwn').enumerable, false, '内建方法不可枚举')

    // 2. Array.prototype.at / String.prototype.at
    assert.equal([1, 2, 3].at(-1), 3)
    assert.equal([1, 2, 3].at(0), 1)
    assert.equal([1, 2, 3].at(9), undefined)
    assert.equal([].at(-1), undefined)
    assert.equal('汉字abc'.at(-1), 'c')
    assert.equal('汉字'.at(0), '汉')

    // 3. ES2023 不可变数组方法：语义必须与规范一致（不改入参、返回新数组）
    const source = [3, 1, 2]
    assert.deepEqual(source.toSorted(), [1, 2, 3])
    assert.deepEqual(source, [3, 1, 2], 'toSorted 不能改入参')
    assert.deepEqual(source.toSorted((a, b) => b - a), [3, 2, 1])
    assert.deepEqual(source.toReversed(), [2, 1, 3])
    assert.deepEqual(source, [3, 1, 2], 'toReversed 不能改入参')
    assert.deepEqual([1, 2, 3].toSpliced(1, 1, 'x'), [1, 'x', 3])
    assert.deepEqual([1, 2, 3].toSpliced(-1), [1, 2], '负下标 + 省略 deleteCount 等于删到结尾')
    assert.deepEqual([1, 2, 3].with(-1, 9), [1, 2, 9])
    assert.deepEqual([1, 2, 3], [1, 2, 3], 'with 不能改入参')
    assert.throws(() => [1, 2, 3].with(5, 9), RangeError, 'with 越界要抛 RangeError')

    // 4. findLast / findLastIndex（第三方依赖会用）
    assert.equal([1, 2, 3, 4].findLast((value) => value % 2 === 0), 4)
    assert.equal([1, 2, 3, 4].findLastIndex((value) => value % 2 === 0), 3)

    // 5. structuredClone：深拷贝 + 环引用 + 内建类型
    const original = { a: 1, nested: { list: [1, 2, { deep: true }] }, when: new Date(1000) }
    original.self = original
    const copy = structuredClone(original)
    assert.notEqual(copy, original)
    assert.notEqual(copy.nested, original.nested)
    assert.deepEqual(copy.nested.list, [1, 2, { deep: true }])
    assert.equal(copy.self, copy, '环引用要在拷贝里闭合到自身')
    assert.equal(copy.when instanceof Date, true)
    assert.notEqual(copy.when, original.when, 'Date 必须复制而不是共享')
    const mapValue = { v: 1 }
    const clonedMap = structuredClone(new Map([['k', mapValue]]))
    assert.deepEqual(clonedMap.get('k'), { v: 1 })
    assert.notEqual(clonedMap.get('k'), mapValue, 'Map 里的对象要深拷贝')

    // 6. crypto.randomUUID（update 检查直接用）
    assert.match(crypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    // 7. 安装标记（诊断/联调能看到补丁跑过）
    assert.equal(globalThis[LEGACY_POLYFILL_FLAG], LEGACY_POLYFILL_VERSION)
  } finally {
    restore()
  }
})

test('structuredClone 降级：不可深拷贝的值按引用透传而不是整条链路抛错', async (t) => {
  const restore = withoutModernApis()
  t.after(restore)
  try {
    const { installLegacyPolyfills, legacyPolyfillReport } = await import(MODULE)
    installLegacyPolyfills()
    const before = legacyPolyfillReport().degradedClones

    const handler = () => 'ok'
    const withFunction = structuredClone({ handler, list: [1] })
    assert.equal(typeof withFunction.handler, 'function', '函数不能丢，按引用透传')
    assert.equal(withFunction.handler, handler)
    assert.deepEqual(withFunction.list, [1], '同层的可克隆值仍然正常深拷贝')

    // Symbol 同理（结构化克隆协议不支持，按引用透传而不是中断调用）
    const symbol = Symbol('legacy')
    assert.equal(structuredClone({ symbol }).symbol, symbol)

    assert.ok(legacyPolyfillReport().degradedClones > before, '降级次数要能被诊断读到')

    // 真·transfer 列表：没有原生转移能力，明确抛 DataCloneError，而不是静默丢语义
    const buffer = new ArrayBuffer(8)
    assert.throws(() => structuredClone(buffer, { transfer: [buffer] }), /transfer list is not supported/)
  } finally {
    restore()
  }
})

test('幂等：重复 install 不会重复定义，方法引用保持不变', async (t) => {
  const restore = withoutModernApis()
  t.after(restore)
  try {
    const { installLegacyPolyfills } = await import(MODULE)
    installLegacyPolyfills()
    const first = {
      hasOwn: Object.hasOwn,
      at: Array.prototype.at,
      toSorted: Array.prototype.toSorted,
      structuredClone: globalThis.structuredClone,
    }
    installLegacyPolyfills()
    assert.equal(Object.hasOwn, first.hasOwn, '第二次 install 不应替换已装好的实现')
    assert.equal(Array.prototype.at, first.at)
    assert.equal(Array.prototype.toSorted, first.toSorted)
    assert.equal(globalThis.structuredClone, first.structuredClone)
  } finally {
    restore()
  }
})

test('不覆盖原生实现：宿主已有（更新的 WebView）时原样保留', async () => {
  const saved = {
    hasOwn: Object.getOwnPropertyDescriptor(Object, 'hasOwn'),
    at: Object.getOwnPropertyDescriptor(Array.prototype, 'at'),
    clone: Object.getOwnPropertyDescriptor(globalThis, 'structuredClone'),
  }
  const sentinelHasOwn = () => 'native-hasOwn-sentinel'
  const sentinelAt = () => 'native-at-sentinel'
  const sentinelClone = () => 'native-clone-sentinel'
  try {
    Object.defineProperty(Object, 'hasOwn', { value: sentinelHasOwn, configurable: true, writable: true })
    Object.defineProperty(Array.prototype, 'at', { value: sentinelAt, configurable: true, writable: true })
    Object.defineProperty(globalThis, 'structuredClone', { value: sentinelClone, configurable: true, writable: true })

    const { installLegacyPolyfills } = await import(MODULE)
    installLegacyPolyfills()

    assert.equal(Object.hasOwn, sentinelHasOwn, 'Object.hasOwn 已存在时不能被覆盖')
    assert.equal(Array.prototype.at, sentinelAt, 'Array.prototype.at 已存在时不能被覆盖')
    assert.equal(globalThis.structuredClone, sentinelClone, 'structuredClone 已存在时不能被覆盖')
  } finally {
    for (const [holder, name, descriptor] of [
      [Object, 'hasOwn', saved.hasOwn],
      [Array.prototype, 'at', saved.at],
      [globalThis, 'structuredClone', saved.clone],
    ]) {
      if (descriptor) {
        Object.defineProperty(holder, name, descriptor)
      } else {
        delete holder[name]
      }
    }
  }
})

// [layer: regression | 依赖: 无（纯 Node，直接改本进程原型再还原） | Issue #79（关联 #13 / #39）]
//
// 回归对象：旧内核补丁里的 String.prototype.replaceAll ——src/polyfills/legacy.ts。
//
// 修复前症状（#79）：Chrome 83 没有 replaceAll，产物里一旦用到就直接白屏；
//   补丁又常常写成可枚举 / 覆盖原生实现 / 允许非全局正则，把别处的 String 行为改坏。
// 修复后预期：缺失时补上且语义与原生一致；非全局正则必须抛 TypeError（原生如此）；
//   属性不可枚举、幂等、且绝不覆盖已经存在的实现（原生或他人的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// 源码里 `legacy.ts` 用 `./graphemeSegmenter.js` 这种打包期写法引用兄弟模块（产物里就是 .js），
// 裸 node 的 type stripping 不会把 .js 映射到 .ts。其它层级（tests/unit/legacy-polyfills.test.mjs）
// 都带这段 resolve hook，本文件原先漏了 → 直接 ERR_MODULE_NOT_FOUND，整层接入前从未曝光（#368）。
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const { installLegacyPolyfills, legacyPolyfillReport, LEGACY_POLYFILL_FLAG } = await import(
  '../../src/polyfills/legacy.ts'
)

const originalDescriptor = Object.getOwnPropertyDescriptor(String.prototype, 'replaceAll')

const withoutReplaceAll = (body) => {
  const run = () => {
    delete String.prototype.replaceAll
    const report = legacyPolyfillReport()
    return { ...body(report) }
  }
  try {
    return run()
  } finally {
    if (originalDescriptor === undefined) delete String.prototype.replaceAll
    else Object.defineProperty(String.prototype, 'replaceAll', originalDescriptor)
  }
}

test('#79 replaceAll 缺失时补上，字符串与全局正则都要能替换', () => {
  const result = withoutReplaceAll(() => {
    installLegacyPolyfills()
    return {
      plain: 'a-b-c'.replaceAll('-', '+'),
      global: 'a1b2c'.replaceAll(/\d/g, '#'),
      empty: 'abc'.replaceAll('', '-'),
      dollars: 'x'.replaceAll('x', '$&$&'),
    }
  })
  assert.deepEqual(result, { plain: 'a+b+c', global: 'a#b#c', empty: '-a-b-c-', dollars: 'xx' })
})

test('#79 非全局正则必须抛 TypeError（与原生一致，不能"顺手"当成全局）', () => {
  withoutReplaceAll(() => {
    installLegacyPolyfills()
    assert.throws(() => 'a1b2c'.replaceAll(/\d/, '#'), /non-global/i)
    assert.throws(() => 'abc'.replaceAll(/b/, 'x'), TypeError)
  })
})

test('#79 补上的方法不可枚举、且幂等（重复安装不换实现）', () => {
  withoutReplaceAll(() => {
    installLegacyPolyfills()
    const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'replaceAll')
    assert.equal(descriptor.enumerable, false, '可枚举会让 for...in 多出一个键')
    assert.equal(typeof descriptor.value, 'function')
    const before = descriptor.value
    installLegacyPolyfills()
    assert.equal(String.prototype.replaceAll, before, '重复安装必须保留同一个实现')
  })
})

test('#79 已有实现时绝不覆盖（原生 / 他人补丁优先）', () => {
  const sentinel = function replaceAll() {
    return 'sentinel'
  }
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true,
    writable: true,
    enumerable: false,
    value: sentinel,
  })
  try {
    installLegacyPolyfills()
    assert.equal(String.prototype.replaceAll, sentinel)
    assert.equal('a-b'.replaceAll('-', '+'), 'sentinel')
  } finally {
    if (originalDescriptor === undefined) delete String.prototype.replaceAll
    else Object.defineProperty(String.prototype, 'replaceAll', originalDescriptor)
  }
})

test('#79 补丁标记与自检报告可用于判断"这个产物到底打没打补丁"', () => {
  assert.equal(typeof LEGACY_POLYFILL_FLAG, 'string')
  assert.ok(LEGACY_POLYFILL_FLAG.length > 0)
  const report = legacyPolyfillReport()
  assert.equal(Array.isArray(report.installed), true)
  assert.equal(typeof report.degradedClones, 'number')
})

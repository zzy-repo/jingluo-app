// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #220「能力探测谎报原生支持」的回归用例。
//
// 旧行为：诊断区块在入口 polyfill **装完之后**才探 `typeof x === 'function'`，于是在 WebView 83 上
// hasOwn / toSorted / at 一律 true —— 「内核原生具备」和「自家兜底补齐」被合成同一个 true，而这个
// 字段正是排查兼容问题的唯一依据，等于在说谎。
//
// 本用例把宿主里的原生实现**真的删掉**（与 tests/unit/legacy-polyfills.test.mjs 同一套手法：node 22
// 的 type stripping + resolve hook，直接 import 源码 .ts），装载真实 src/polyfills/legacy.ts，再调
// 真实的诊断能力读取 src/services/diagnostics/capabilityTruth.ts，断言：
//   1 原生缺失时 native 标记为 false，polyfilled 里点名这三项（不再谎报原生）
//   2 runtime 维度保持原语义（能调就 true），已上线的老字段消费者不受影响
//   3 原生具备时（等价于新版 WebView：每个 installer 直接早退）native 为 true、polyfilled 为空
//   4 degradedClones 从 legacyPolyfillReport() 原样透出（structuredClone 降级可观测）
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

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

const holderOf = (path) =>
  path.split('.').reduce((owner, key) => (owner ? owner[key] : undefined), globalThis)

/** WebView 83 上不存在的三项（诊断里各有对应字段） */
const MISSING = [
  ['Object', 'hasOwn'],
  ['Array.prototype', 'at'],
  ['Array.prototype', 'toSorted'],
]

/** 模拟 WebView 83：真的删掉，返回恢复函数 */
const withoutModernApis = () => {
  const saved = []
  for (const [holderPath, name] of MISSING) {
    const holder = holderOf(holderPath)
    saved.push([holder, name, Object.getOwnPropertyDescriptor(holder, name)])
    delete holder[name]
  }
  return () => {
    for (const [holder, name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(holder, name, descriptor)
      }
    }
  }
}

test('宿主原生缺 hasOwn / at / toSorted 时，诊断只报兜底可用，不再谎报原生', async (t) => {
  const restore = withoutModernApis()
  t.after(restore)

  // 先确认宿主确实「没有」——不然本用例什么也没证明
  assert.equal(typeof Object.hasOwn, 'undefined')
  assert.equal(typeof Array.prototype.at, 'undefined')
  assert.equal(typeof Array.prototype.toSorted, 'undefined')

  const legacy = await import('../../src/polyfills/legacy.ts')
  // 兜底真的装上了：删掉之后又能调（这就是「能调 ≠ 原生」的现场）
  assert.equal(typeof Object.hasOwn, 'function')
  assert.equal(typeof Array.prototype.toSorted, 'function')

  const { readCapabilityTruth } = await import('../../src/services/diagnostics/capabilityTruth.ts')
  const facts = readCapabilityTruth()

  // runtime：能调就是 true（老字段语义不变）
  assert.equal(facts.runtime.hasOwn, true)
  assert.equal(facts.runtime.at, true)
  assert.equal(facts.runtime.toSorted, true)

  // native：内核原生**不具备**（旧代码这里就是那个假的 true）
  assert.equal(facts.native.hasOwn, false)
  assert.equal(facts.native.at, false)
  assert.equal(facts.native.toSorted, false)

  // polyfilled：点名是谁补的，且与 legacy.ts 自己的台账一致
  const reported = legacy.legacyPolyfillReport()
  assert.deepEqual(facts.polyfilled, reported.installed)
  for (const name of ['hasOwn', 'at', 'toSorted']) {
    assert.ok(facts.polyfilled.includes(name), `${name} 应出现在 polyfilled 里`)
  }
  assert.equal(facts.degradedClones, reported.degradedClones)
})

test('原生具备时（新版 WebView：installer 全部早退）native 为 true、polyfilled 为空', async () => {
  const { readCapabilityTruth } = await import('../../src/services/diagnostics/capabilityTruth.ts')
  // 同一进程里 legacy.ts 只求值一次，装过的记录不会消失；这里用「一份什么都没装的报告」
  // 代表新版内核上每个 installer 都早退的那个现场，走的是同一条判定逻辑。
  const facts = readCapabilityTruth({ installed: [], degradedClones: 0 })
  assert.equal(facts.native.hasOwn, true)
  assert.equal(facts.native.at, true)
  assert.equal(facts.native.toSorted, true)
  assert.deepEqual(facts.polyfilled, [])
  assert.equal(facts.degradedClones, 0)
})

test('runtime 与 native 的字段集合一致，已上线的老字段一个不少', async () => {
  const { readCapabilityTruth } = await import('../../src/services/diagnostics/capabilityTruth.ts')
  const facts = readCapabilityTruth()
  const keys = Object.keys(facts.runtime).sort()
  // #220 之前就在上报的字段（下游按名字读，不许改名/删除）
  for (const field of [
    'at',
    'blobStream',
    'clipboard',
    'cryptoRandomUUID',
    'dvh',
    'fetchPatched',
    'flexGapVerified',
    'hasOwn',
    'intlDisplayNames',
    'intlSegmenter',
    'isNative',
    'structuredClone',
    'toSorted',
    'visualViewport',
  ]) {
    assert.ok(keys.includes(field), `capabilities.${field} 不能消失`)
    assert.equal(typeof facts.runtime[field], 'boolean')
  }
  assert.deepEqual(Object.keys(facts.native).sort(), keys)
})

test('degradedClones 是观测值而不是写死的 0（report 里涨了就跟着涨）', async () => {
  const { readCapabilityTruth } = await import('../../src/services/diagnostics/capabilityTruth.ts')
  const facts = readCapabilityTruth({ installed: ['structuredClone'], degradedClones: 3 })
  assert.equal(facts.degradedClones, 3)
  // structuredClone 被兜底过 ⇒ 原生不具备，哪怕当前能调
  assert.equal(facts.native.structuredClone, false)
})

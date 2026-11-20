// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #167：`Intl.Segmenter`（Chromium 87）在 WebView 83 上不存在。
// 缺了它，调用方（mermaid 的标签换行等）会退回 `[...text]` **按码点**切：
//   '👨‍👩‍👧‍👦' → 7 段（家庭被拆成 4 个人 + 3 个 ZWJ）
//   'e' + U+0301（分解形 é）→ 2 段（重音符号被甩到下一行）
//   'กำ'（泰文）→ 2 段；'क्ष'（印地文连字）→ 3 段
// 本用例把宿主里的原生 `Intl.Segmenter` **真的删掉**（模拟 WebView 83），再走真实入口模块，验证：
//   A 删掉后字素簇分段可用，且与原生语义一致（emoji / 肤色修饰 / 国旗 / 组合字符 /
//     泰文 / 印地文连字 / 韩文音节 / CRLF / CJK）
//   B `granularity` 只实现 grapheme（word/sentence 明确抛 RangeError，不静默降级）
//   C `segments.containing(index)` 与原生同形（含小数、越界、簇内偏移）
//   D 幂等：重复 install 不重复定义；**不覆盖**已存在的原生实现
//   E 新增的 polyfill 源码是 ES5 语法（无箭头函数 / 模板串 / let / const）
//
// 为什么能直接 import 源码 .ts：node 22 的 type stripping + 下面的 resolve hook
// （与 tests/unit/legacy-polyfills.test.mjs 同一套手法）。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'

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
const SEGMENTER_SOURCE = readFileSync(
  new URL('../../src/polyfills/graphemeSegmenter.ts', import.meta.url),
  'utf8'
)
const DATA_SOURCE = readFileSync(
  new URL('../../src/polyfills/graphemeData.ts', import.meta.url),
  'utf8'
)

/** 模拟 WebView 83：这条 API 在宿主里根本不存在 */
const savedSegmenter = Object.getOwnPropertyDescriptor(Intl, 'Segmenter')
delete Intl.Segmenter
after(() => {
  if (savedSegmenter) Object.defineProperty(Intl, 'Segmenter', savedSegmenter)
})

/** 修复前这里是「Intl.Segmenter is not a constructor」；修复后必须能装出来 */
const { installLegacyPolyfills, legacyPolyfillReport } = await import(MODULE)

const clusters = (text) => [...new Intl.Segmenter().segment(text)].map((item) => item.segment)

test('A1 宿主缺 Intl.Segmenter 时，入口模块把它补上并记进诊断报告', () => {
  assert.equal(typeof Intl.Segmenter, 'function')
  // 诊断报告沿用既有约定：记的是方法名，不是全路径
  assert.ok(legacyPolyfillReport().installed.includes('Segmenter'))
})

test('A2 emoji：ZWJ 家庭 / 肤色修饰 / 国旗都是一个字素簇', () => {
  assert.equal(typeof Intl.Segmenter, 'function', '前置条件：补丁已装')
  assert.deepEqual(clusters('👨‍👩‍👧‍👦'), ['👨‍👩‍👧‍👦'])
  assert.deepEqual(clusters('👍🏽'), ['👍🏽'])
  assert.deepEqual(clusters('👍🏽👍'), ['👍🏽', '👍'])
  assert.deepEqual(clusters('🇨🇳'), ['🇨🇳'])
  // 相邻两面国旗各自成簇（GB12/13 的 RI 奇偶配对）
  assert.deepEqual(clusters('🇨🇳🇯🇵'), ['🇨🇳', '🇯🇵'])
  // ZWJ 之后又来一个 Extend（肤色修饰）：GB11 的序列被打断，后面的 emoji 必须另起一簇
  // （对照原生 Intl.Segmenter 发现的第一个偏差，见 PR 的对照核验）
  assert.deepEqual(clusters('中😀‍🏽😀'), ['中', '😀‍🏽', '😀'])
})

test('A3 组合字符 / 泰文 / 印地文连字 / 韩文音节 / CRLF / CJK', () => {
  assert.equal(typeof Intl.Segmenter, 'function', '前置条件：补丁已装')
  // 分解形 é = e + U+0301（组合用锐音符）
  assert.deepEqual(clusters('e\u0301'), ['e\u0301'])
  assert.deepEqual(clusters('e\u0301x'), ['e\u0301', 'x'])
  // 泰文：ก + ำ（U+0E33 SpacingMark）
  assert.deepEqual(clusters('กำ'), ['กำ'])
  // 印地文连字：क + ्（U+094D 连字号）+ ष —— GB9c，Unicode 15.1 起
  assert.deepEqual(clusters('क्ष'), ['क्ष'])
  assert.deepEqual(clusters('क्षि'), ['क्षि'])
  // 韩文：LV 音节 + LVT 音节
  assert.deepEqual(clusters('한글'), ['한', '글'])
  // CRLF 是单个字素簇（GB3）
  assert.deepEqual(clusters('a\r\nb'), ['a', '\r\n', 'b'])
  // CJK 逐字
  assert.deepEqual(clusters('中文'), ['中', '文'])
})

test('A4 每段的 index 是 UTF-16 偏移，input 指回原串（mermaid 依赖这个形状）', () => {
  assert.equal(typeof Intl.Segmenter, 'function', '前置条件：补丁已装')
  const segments = [...new Intl.Segmenter().segment('a👍🏽b')]
  assert.deepEqual(
    segments.map((item) => [item.segment, item.index, item.input]),
    [
      ['a', 0, 'a👍🏽b'],
      ['👍🏽', 1, 'a👍🏽b'],
      ['b', 5, 'a👍🏽b'],
    ]
  )
})

test('A5 复现 mermaid 的调用点：有 Segmenter 时不再按码点切碎', () => {
  // node_modules/mermaid/dist/chunks/mermaid.core/chunk-62K37W7T.mjs 里的原样逻辑
  const splitTextToChars = (text) => {
    if (Intl.Segmenter) {
      return [...new Intl.Segmenter().segment(text)].map((segment) => segment.segment)
    }
    return [...text]
  }
  // 记录 bug 本身：码点切法把家庭 emoji 切成 7 段
  assert.equal([...'👨‍👩‍👧‍👦'].length, 7)
  assert.deepEqual(splitTextToChars('👨‍👩‍👧‍👦'), ['👨‍👩‍👧‍👦'])
  assert.deepEqual(splitTextToChars('hi'), ['h', 'i'])
})

test('B granularity 只做 grapheme：word / sentence 明确抛 RangeError，不静默降级', () => {
  assert.equal(typeof Intl.Segmenter, 'function', '前置条件：补丁已装')
  assert.deepEqual(new Intl.Segmenter().resolvedOptions().granularity, 'grapheme')
  assert.deepEqual(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).resolvedOptions().granularity,
    'grapheme'
  )
  assert.throws(() => new Intl.Segmenter(undefined, { granularity: 'word' }), RangeError)
  assert.throws(() => new Intl.Segmenter('zh-CN', { granularity: 'sentence' }), RangeError)
  // 原生要求 new，兜底实现也要同样报错（否则调用方会拿到 undefined 而不是抛错）
  assert.throws(() => Intl.Segmenter(), TypeError)
  // segment() 先 ToString，与原生一致
  assert.deepEqual(
    [...new Intl.Segmenter().segment(123)].map((item) => item.segment),
    ['1', '2', '3']
  )
})

test('C segments.containing(index) 与原生同形', () => {
  assert.equal(typeof Intl.Segmenter, 'function', '前置条件：补丁已装')
  const segments = new Intl.Segmenter().segment('abc')
  assert.deepEqual(segments.containing(0), { segment: 'a', index: 0, input: 'abc' })
  assert.deepEqual(segments.containing(1.5), { segment: 'b', index: 1, input: 'abc' })
  assert.equal(segments.containing(-1), undefined)
  assert.equal(segments.containing(3), undefined)
  assert.equal(segments.containing(99), undefined)
  // 簇中间的偏移也归到该簇
  const emoji = new Intl.Segmenter().segment('👍🏽a')
  assert.equal(emoji.containing(1).segment, '👍🏽')
  assert.equal(emoji.containing(4).segment, 'a')
  // containing 是非枚举的（与原生一致：展开/keys 不该看见它）
  assert.deepEqual(Object.keys(segments), [])
})

test('D1 幂等：重复 install 不重复定义', () => {
  const before = Intl.Segmenter
  installLegacyPolyfills()
  assert.equal(Intl.Segmenter, before)
})

test('D2 不覆盖原生实现：宿主已有 Intl.Segmenter 时等于什么都没做', () => {
  const sentinel = function NativeSegmenter() {}
  Object.defineProperty(Intl, 'Segmenter', {
    value: sentinel,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  try {
    installLegacyPolyfills()
    assert.equal(Intl.Segmenter, sentinel)
  } finally {
    delete Intl.Segmenter
    installLegacyPolyfills()
  }
  assert.notEqual(Intl.Segmenter, sentinel, '恢复后应重新装回兜底实现')
  assert.deepEqual(clusters('👨‍👩‍👧‍👦'), ['👨‍👩‍👧‍👦'])
})

test('E 新 polyfill 源码是 ES5 语法：无箭头函数 / 模板串 / let / const', () => {
  // 注释里用反引号包 API 名是仓库惯例，只检查**代码本身**
  const code = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  for (const [name, source] of [
    ['graphemeSegmenter.ts', code(SEGMENTER_SOURCE)],
    ['graphemeData.ts', code(DATA_SOURCE)],
  ]) {
    assert.doesNotMatch(source, /=>/, `${name} 不能出现箭头函数`)
    assert.doesNotMatch(source, /`/, `${name} 不能出现模板串`)
    assert.doesNotMatch(source, /\b(?:let|const)\s+[A-Za-z_$]/, `${name} 只能用 var/function`)
  }
  // 数据表是区间字面量，不是正则属性转义（ES5 解析器不认 /\p{…}/u）
  assert.doesNotMatch(code(DATA_SOURCE), /\p\{/)
  assert.match(DATA_SOURCE, /export var GRAPHEME_EXTEND = \[/)
  assert.match(SEGMENTER_SOURCE, /export function createGraphemeSegmenter\(/)
})

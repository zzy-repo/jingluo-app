// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #79：Chrome 83 缺 String.prototype.replaceAll（Chrome 85+）。src 里没人直接调，
// 但第三方依赖（数学/mermaid 那条链）的 async chunk 里带进来 31 处裸调用 —— 低内核上就是
// `TypeError: s.replaceAll is not a function`，一个未捕获异常把整屏 React 卸掉（与 issue #27 同形态）。
//
// 本用例把宿主里的原生 replaceAll **真的删掉**（模拟 WebView 83），再走真实入口模块 legacy.ts，验：
//   1 补丁前：不存在，裸调用必 TypeError（核上白屏的现场）
//   2 补丁后字符串 search：全量替换 / 不重叠前进 / 空串 search / 元字符按字面量
//   3 正则 search：带 g 才允许，不带 g 按规范抛 TypeError（不许悄悄只换首个）
//   4 替换串语义：$& / $1 / $$ / $` / $' 必须走 GetSubstitution 展开 —— split/join 糊的实现会在这里红
//   5 不改入参（返回新串）
//   6 宿主已有原生实现（更新的 WebView）时不被覆盖
//
// 为什么能直接 import 源码 .ts：node 22 的 type stripping + 下面的 resolve hook（与
// tests/unit/legacy-polyfills.test.mjs 同一套手法）。
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

const MODULE = '../../src/polyfills/legacy.ts'

/**
 * 模拟 WebView 83：把原生 replaceAll 真的删掉。
 * 注意本文件**不恢复**原生实现 —— 后面的用例都要在「宿主没有原生 replaceAll」的前提下跑补丁，
 * 恢复回去就成了测原生。每个用例文件独立进程（tests/run-layer.mjs），不影响别的用例。
 */
const withoutReplaceAll = () => {
  const saved = Object.getOwnPropertyDescriptor(String.prototype, 'replaceAll')
  delete String.prototype.replaceAll
  return saved
}

const savedNative = withoutReplaceAll()

test('补丁前：WebView 83 上没有 replaceAll，裸调用就是 TypeError；装上后可用', async () => {
  assert.equal(typeof String.prototype.replaceAll, 'undefined', '前置：宿主里已无 String.prototype.replaceAll')
  assert.throws(() => 'a-b'.replaceAll('-', '_'), TypeError, '补丁前裸调用必 TypeError（低核上就死在这）')

  const { installLegacyPolyfills } = await import(MODULE)
  installLegacyPolyfills()

  assert.equal(typeof String.prototype.replaceAll, 'function', '入口模块装上补丁后必须可用')
  assert.equal(Object.getOwnPropertyDescriptor(String.prototype, 'replaceAll').enumerable, false, '内建方法不可枚举')
})

test('字符串 search：全量替换 / 不重叠 / 空串 / 元字符按字面量', () => {
  assert.equal('a-b-c'.replaceAll('-', '_'), 'a_b_c')
  assert.equal('aaa'.replaceAll('aa', 'b'), 'ba', '匹配后前进一个 search 长度，不重叠（与原生一致）')
  assert.equal('abc'.replaceAll('', '-'), '-a-b-c-', '空串 search 要在每个位置都插一次，含首尾')
  assert.equal('abc'.replaceAll('', (matched, position) => String(position)), '0a1b2c3', '空串 search 的函数替换')
  assert.equal('a.b.c'.replaceAll('.', '!'), 'a!b!c', '字符串 search 里 . 是字面量，不是通配')
  assert.equal('x[y]z*p'.replaceAll('[y]', 'Y').replaceAll('*', 'S'), 'xYzSp', '字符类 / 量词元字符要转义')
  assert.equal('a\\b'.replaceAll('\\', '/'), 'a/b', '反斜杠按字面量处理')
  assert.equal('abc'.replaceAll('zzz', 'X'), 'abc', '没命中就原样返回')
  assert.equal('abc'.replaceAll(undefined, 'x'), 'abc', 'searchValue=undefined 按 "undefined" 去搜')
  assert.equal('abc'.replaceAll('b'), 'aundefinedc', 'replaceValue 缺省按 "undefined"（与原生一致）')
  assert.equal('abc'.replaceAll('b', null), 'anullc')
  assert.equal(
    'abc'.replaceAll('b', (matched, position, whole) => matched.toUpperCase() + position + whole.length),
    'aB13c',
    '函数替换的参数是 (matched, offset, 整串)'
  )
  assert.equal(
    String.prototype.replaceAll.call({ toString: () => 'a-b' }, '-', '_'),
    'a_b',
    'this 走 RequireObjectCoercible + ToString，非字符串 this 也要能用'
  )
  assert.throws(() => String.prototype.replaceAll.call(null, 'a', 'b'), TypeError, 'null this 要抛 TypeError')
})

test('正则 search：带 g 才允许，不带 g 按规范抛 TypeError', () => {
  assert.equal('a1 b2'.replaceAll(/([a-z])(\d)/g, '$2$1'), '1a 2b')
  assert.equal('a-b'.replaceAll(/-/g, '[$&]'), 'a[-]b')
  assert.equal('a.b'.replaceAll(/\./g, '!'), 'a!b', '正则 search 里 . 才是通配的量级差别')
  assert.equal('abc'.replaceAll(/zzz/g, 'X'), 'abc')
  assert.equal('aaa'.replaceAll(/a/g, 'b'), 'bbb')
  assert.throws(
    () => 'abc'.replaceAll(/b/, 'x'),
    TypeError,
    '正则不带 g 必须抛 TypeError（规范要求，不许悄悄降级成只换首个）'
  )
})

test('替换串语义：$& / $1 / $$ / $` / $\' 走 GetSubstitution 展开（split/join 实现会红）', () => {
  // 字符串 search 也不能把替换串当字面量
  assert.equal('abc'.replaceAll('b', '$&'), 'abc', '$& 展开成匹配到的子串；split/join 实现会得到 a$&c')
  assert.equal('aXbX'.replaceAll('X', '$$'), 'a$b$', '$$ 是字面量 $')
  assert.equal('abc'.replaceAll('b', '$`'), 'aac', '$` 是匹配位置之前的整段')
  assert.equal("abc".replaceAll('b', "$'"), 'acc', "$' 是匹配位置之后的整段")
  assert.equal('abc'.replaceAll('b', '$1'), 'a$1c', '没有捕获组时 $1 保持字面量（与原生一致）')
  // 正则 search：捕获组 + 全部特殊模式
  assert.equal('a1 b2'.replaceAll(/([a-z])(\d)/g, '$2$1'), '1a 2b', '$1/$2 取捕获组')
  assert.equal(
    'abc'.replaceAll(/(b)/g, "[$1|$&|$`|$'|$$]"),
    'a[b|b|a|c|$]c',
    '$1 / $& / $` / $\' / $$ 五种模式一次对齐原生'
  )
})

test('返回新串、不改入参；字符串 search 与正则 search 都不写回原值', () => {
  const original = 'a-b-c'
  const result = original.replaceAll('-', '_')
  assert.equal(original, 'a-b-c', '入参不能被改（字符串不可变，但实现里也别指望就地替换）')
  assert.notEqual(result, original)
  assert.equal(result, 'a_b_c')

  const pattern = /-/g
  assert.equal(original.replaceAll(pattern, '+'), 'a+b+c')
  assert.equal(pattern.lastIndex, 0, '不动调用方传进来的正则状态')
})

test('不覆盖原生实现：宿主已有（更新的 WebView）时原样保留', async () => {
  const installed = Object.getOwnPropertyDescriptor(String.prototype, 'replaceAll')
  const sentinel = () => 'native-replaceAll-sentinel'
  Object.defineProperty(String.prototype, 'replaceAll', {
    value: sentinel,
    configurable: true,
    writable: true,
    enumerable: false,
  })
  try {
    const { installLegacyPolyfills } = await import(MODULE)
    installLegacyPolyfills()
    assert.equal(String.prototype.replaceAll, sentinel, '已存在实现时不能被覆盖')
  } finally {
    if (installed) {
      Object.defineProperty(String.prototype, 'replaceAll', installed)
    } else if (savedNative) {
      Object.defineProperty(String.prototype, 'replaceAll', savedNative)
    }
  }
})

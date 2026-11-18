// [layer: unit | 纯 Node + vm，无浏览器无网络 | 耗时: <1s]
// GitHub issue #155：`Intl.DisplayNames`（Chromium 81）裸调用。
//
// 两个必须真的成立的职责：
//   A 降级：宿主里**没有** `Intl.DisplayNames`（WebView 79/80）时，`src/services/location.ts`
//     必须能加载，并且 getRegionName() 返回**可用**的中文/英文地区名 —— 不是空串、不是码本身、
//     不抛错。修复前它是模块顶层 `new Intl.DisplayNames(...)`，模块求值期就 TypeError，
//     把整个产物的运行下限从 80 抬到 81。
//   B 守卫：`src/index.html` 的内联 ES5 守卫的 REQUIRED 清单要含 `Intl.DisplayNames` 探测，
//     缺了就走「缺少：…」那条具体文案（指得到「更新 Android System WebView」），
//     而不是泛泛的「启动任务异常 / 12 秒内没有启动」。
//
// 为什么能直接 import 源码 .ts：node 22 的 type stripping + 下面的 resolve hook
// （与 tests/unit/legacy-polyfills.test.mjs 同一套手法）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, test } from 'node:test'
import vm from 'node:vm'

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

const LOCATION_MODULE = '../../src/services/location.ts'
const LOCATION_SOURCE = readFileSync(new URL(LOCATION_MODULE, import.meta.url), 'utf8')
const LOCALES = ['zh-CN', 'en-US']

/** 模拟 WebView 79/80：这条 API 在宿主里根本不存在 */
const savedDisplayNames = Object.getOwnPropertyDescriptor(Intl, 'DisplayNames')
delete Intl.DisplayNames
after(() => {
  if (savedDisplayNames) Object.defineProperty(Intl, 'DisplayNames', savedDisplayNames)
})

/** 动态 import：修复前这里是模块求值期的 TypeError（红），修复后必须解析成功（绿） */
const loadLocation = async () => import(LOCATION_MODULE)

test('A1 宿主没有 Intl.DisplayNames 时模块仍可加载（顶层不许直接构造）', async () => {
  assert.equal(Intl.DisplayNames, undefined, '宿主侧必须真的没有这条 API，否则本用例不成立')
  const module = await loadLocation()
  assert.equal(typeof module.getRegionName, 'function')
  assert.equal(typeof module.normalizeLocation, 'function')
})

test('A2 缺失时返回可用地区名：不是空串、不是抛错', async () => {
  const { getRegionName } = await loadLocation()
  assert.equal(getRegionName('US', 'zh-CN'), '美国')
  assert.equal(getRegionName('JP', 'zh-CN'), '日本')
  assert.equal(getRegionName('US', 'en-US'), 'United States')
  assert.equal(getRegionName('JP', 'en-US'), 'Japan')
})

test('A3 缺失时全量 regionCodes × 两个 locale 都有名字（表必须覆盖整张清单）', async () => {
  const { getRegionName, regionCodes } = await loadLocation()
  assert.ok(regionCodes.length > 200, `地区清单应有 200+ 项，实际 ${regionCodes.length}`)
  const holes = []
  for (const locale of LOCALES) {
    for (const code of regionCodes) {
      const name = getRegionName(code, locale)
      if (typeof name !== 'string' || name.length === 0) holes.push(`${locale}/${code}=空`)
      else if (name === code) holes.push(`${locale}/${code}=码本身`)
    }
  }
  assert.deepEqual(holes, [], '降级表必须给每个地区一个真名字，不能拿码顶替')
})

test('A4 地区名覆写仍然优先于内建名（政治正确的那几条不能被降级冲掉）', async () => {
  const { getRegionName } = await loadLocation()
  assert.equal(getRegionName('TW', 'zh-CN'), '中国台湾')
  assert.equal(getRegionName('HK', 'zh-CN'), '中国香港')
  assert.equal(getRegionName('TW', 'en-US'), 'Taiwan, China')
})

test('A5 半吊子实现（构造器在但构造就抛）也不许把调用方带崩', async () => {
  const { getRegionName } = await loadLocation()
  Object.defineProperty(Intl, 'DisplayNames', {
    value: function DisplayNames() {
      throw new RangeError('half-baked Intl.DisplayNames')
    },
    configurable: true,
    writable: true,
  })
  try {
    assert.equal(getRegionName('US', 'zh-CN'), '美国', '构造失败要退回内建表，不能抛')
    assert.equal(getRegionName('DE', 'en-US'), 'Germany')
  } finally {
    delete Intl.DisplayNames
  }
})

test('A6 宿主有原生实现时优先用原生（降级不是默认路径）', async () => {
  const { getRegionName } = await loadLocation()
  Object.defineProperty(Intl, 'DisplayNames', {
    value: function DisplayNames(locales, options) {
      assert.deepEqual(options, { type: 'region' }, '只做 region 类型')
      return { of: (code) => `native:${locales[0]}:${code}` }
    },
    configurable: true,
    writable: true,
  })
  try {
    assert.equal(getRegionName('US', 'en-US'), 'native:en-US:US')
    assert.equal(getRegionName('TW', 'zh-CN'), '中国台湾', '覆写表在原生之上')
  } finally {
    delete Intl.DisplayNames
  }
})

test('A7 源码层锁：Intl.DisplayNames 必须带 typeof 存在性探测，不许再裸调', () => {
  assert.match(
    LOCATION_SOURCE,
    /typeof\s+Intl\.DisplayNames\s*!==?\s*['"]function['"]/,
    'src/services/location.ts 里必须能看到 typeof Intl.DisplayNames 的探测'
  )
  for (const line of LOCATION_SOURCE.split('\n')) {
    if (!/new\s+Intl\.DisplayNames\s*\(/.test(line)) continue
    assert.fail(`裸调 new Intl.DisplayNames(...) 还在：${line.trim()}`)
  }
})

// ── B 兜底守卫（src/index.html 的内联 ES5） ─────────────────────────────────
const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
const guardSource = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const BOOT_DEADLINE_MS = 12000

const harness = ({ remove = [], boot = false } = {}) => {
  const box = { hidden: true, style: {}, textContent: '' }
  const listeners = new Map()
  const clock = { now: 0 }
  const intervals = new Map()
  let nextTimerId = 1

  const FakeDate = function FakeDate(...args) {
    return new Date(...args)
  }
  FakeDate.now = () => clock.now
  FakeDate.prototype = Date.prototype

  const context = vm.createContext({
    console,
    document: { getElementById: () => box },
    addEventListener: (name, handler) => {
      listeners.set(name, handler)
    },
    setInterval: (handler) => {
      const id = nextTimerId
      nextTimerId += 1
      intervals.set(id, handler)
      return id
    },
    clearInterval: (id) => {
      intervals.delete(id)
    },
    Date: FakeDate,
  })
  vm.runInContext('window = globalThis', context)
  vm.runInContext(
    [
      'fetch = function fetch() {}',
      'URL = function URL() {}',
      'AbortController = function AbortController() {}',
      'TextDecoder = function TextDecoder() {}',
      'ResizeObserver = function ResizeObserver() {}',
      'CSS = { escape: function escape() {} }',
    ].join('\n'),
    context
  )
  if (boot) {
    vm.runInContext('window.__DEEPSEEK_BOOTED__ = true', context)
  }
  for (const expression of remove) {
    vm.runInContext(expression, context)
  }

  vm.runInContext(guardSource, context)

  return {
    context,
    box,
    listeners,
    tick(ms) {
      clock.now += ms
      for (const handler of [...intervals.values()]) {
        handler()
      }
    },
  }
}

test('B1 缺 Intl.DisplayNames 时守卫命中「缺少：」分支并点名该 API', () => {
  const { context, box } = harness({ remove: ['if (window.Intl) { delete window.Intl.DisplayNames }'] })
  assert.equal(vm.runInContext('typeof (window.Intl && window.Intl.DisplayNames)', context), 'undefined')
  assert.equal(box.hidden, false, '缺这条 API 必须给出提示，而不是静默白屏')
  assert.match(box.textContent, /Android System WebView/, '要指向可行动的那句：更新 WebView')
  assert.match(box.textContent, /缺少：.*Intl\.DisplayNames/, '要走「缺少：…」那条具体文案')
  assert.deepEqual([...context.__DEEPSEEK_COMPATIBILITY_ERROR__], ['Intl.DisplayNames'])
})

test('B2 能力齐全时不误报（WebView 81+ 与新版浏览器不受影响）', () => {
  const { context, box } = harness()
  assert.equal(box.hidden, true)
  assert.equal(context.__DEEPSEEK_COMPATIBILITY_ERROR__, undefined)
})

test('B3 静默白屏兜底没被改动：12 秒不启动仍然报超时', () => {
  const { box, tick } = harness()
  tick(BOOT_DEADLINE_MS + 1000)
  assert.equal(box.hidden, false)
  assert.match(box.textContent, /12 秒内没有启动/)
})

test('B4 守卫补完还是 ES5：老内核解析得了才救得了场', () => {
  assert.doesNotMatch(guardSource, /\b(?:const|let|class|async|await)\b/)
  assert.doesNotMatch(guardSource, /=>/)
  assert.doesNotMatch(guardSource, /\?\.|\?\?/)
  assert.doesNotMatch(guardSource, /`/)
  assert.doesNotMatch(guardSource, /\.at\(|\.includes\(|\.find\(|Object\.assign/)
})

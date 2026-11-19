// [layer: unit | 纯 Node + vm，无浏览器无网络 | 耗时: <1s]
// GitHub issue #219：`Intl.DisplayNames` 不是启动硬性必需项。
//
// 背景矛盾：#155 已经给这条 API 建好了降级路径（`src/services/regionNameFallback.ts`，
// WebView 79/80 上地区名照样可读），但 `src/index.html` 的启动守卫仍把它列进 REQUIRED，
// 缺了就走 `missing-api` 分支拦死启动 —— 「有兜底的事」被升格成「不可启动」。
//
// 本文件钉住修完后的三条事实：
//   1. 宿主没有 `Intl.DisplayNames` 时，守卫**不**拦启动（不写
//      `window.__DEEPSEEK_COMPATIBILITY_ERROR__`、不画兜底卡片）；
//   2. 同一次运行里地区名确实**走 regionNameFallback**（返回值逐条等于内建表，不是码本身、
//      也不是原生 formatter —— 原生 formatter 在这个宿主里根本不存在）；
//   3. 守卫的上报语义没被顺手改坏：真正必需的能力（`fetch`）缺了仍然走 ① 分支点名。
//
// 为什么单独一个文件：`Intl.DisplayNames` 的删除要在 import `location.ts` **之前**生效，
// 而 `intl-displaynames-fallback.test.mjs` 里 A5/A6 会临时装回一个原生/半吊子实现并在
// location.ts 的模块级 formatter 缓存里留下成功实例；runner 是「一个文件一个 node 进程」
// （tests/helpers/runtime.mjs），独立文件才有干净的模块注册表和干净的地区名缓存。
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
const FALLBACK_MODULE = '../../src/services/regionNameFallback.ts'
const LOCALES = ['zh-CN', 'en-US']
/** 只挑没有覆写表（TW/HK/MO）、也没别名歧义的码，纯粹比内建表 */
const PROBE_CODES = ['US', 'JP', 'DE', 'BR']

const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
const guardSource = html.match(/<script>([\s\S]*?)<\/script>/)[1]

/** 宿主侧（Node 自己的 realm）：模拟 WebView 79/80 —— 这条 API 根本不存在 */
const savedDisplayNames = Object.getOwnPropertyDescriptor(Intl, 'DisplayNames')
delete Intl.DisplayNames
after(() => {
  if (savedDisplayNames) Object.defineProperty(Intl, 'DisplayNames', savedDisplayNames)
})

const harness = (remove = []) => {
  const box = { hidden: true, style: {}, textContent: '' }
  const listeners = new Map()
  const intervals = new Map()
  let nextTimerId = 1

  const FakeDate = function FakeDate(...args) {
    return new Date(...args)
  }
  FakeDate.now = () => 0
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
  // 除 `Intl.DisplayNames` 之外的能力都给齐：这样唯一变量就是这条 API
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
  for (const expression of remove) {
    vm.runInContext(expression, context)
  }

  vm.runInContext(guardSource, context)

  return { context, box, listeners }
}

/** 从守卫源码里取 REQUIRED 清单的名字（顺序保持源码顺序） */
const requiredNames = () => [...guardSource.matchAll(/\[\s*'([^']+)'\s*,\s*function/g)].map((m) => m[1])

test('#219 缺 Intl.DisplayNames 时守卫放行，且地区名走 regionNameFallback', async () => {
  const { context, box } = harness(['if (window.Intl) { delete window.Intl.DisplayNames }'])
  assert.equal(
    vm.runInContext('typeof (window.Intl && window.Intl.DisplayNames)', context),
    'undefined',
    'vm 侧必须真的没有这条 API，否则本用例不成立'
  )

  // ① 守卫不拦死：不画兜底卡片、不写诊断变量
  assert.equal(box.hidden, true, '缺 Intl.DisplayNames 有 regionNameFallback 兜底，不该弹兜底卡片')
  assert.equal(box.textContent, '', '兜底卡片文案不该被写')
  assert.equal(
    context.__DEEPSEEK_COMPATIBILITY_ERROR__,
    undefined,
    '没拦启动就不该写 __DEEPSEEK_COMPATIBILITY_ERROR__'
  )

  // ② 同一次运行里地区名确实走内建表（宿主侧也没有这条 API）
  assert.equal(Intl.DisplayNames, undefined, '宿主侧必须真的没有这条 API，否则兜底路径不成立')
  const { getRegionName } = await import(LOCATION_MODULE)
  const { regionNameFallback } = await import(FALLBACK_MODULE)
  for (const locale of LOCALES) {
    for (const code of PROBE_CODES) {
      const name = getRegionName(code, locale)
      assert.equal(
        name,
        regionNameFallback[locale][code],
        `${locale}/${code} 必须命中 regionNameFallback 的内建表，实际拿到 ${JSON.stringify(name)}`
      )
      assert.notEqual(name, code, `${locale}/${code} 不许拿地区码顶替`)
      assert.ok(!String(name).startsWith('native:'), `${locale}/${code} 不该走原生 formatter`)
    }
  }
})

test('#219 守卫仍点名真正必需的能力（摘掉的只有 Intl.DisplayNames）', () => {
  const { context, box } = harness(['fetch = undefined'])
  assert.equal(box.hidden, false, '真缺 fetch 必须给提示，而不是静默白屏')
  assert.equal(context.__DEEPSEEK_COMPATIBILITY_ERROR__.branch, '①')
  assert.deepEqual([...context.__DEEPSEEK_COMPATIBILITY_ERROR__.missing], ['fetch'])
  assert.match(box.textContent, /缺少的运行环境能力：fetch/)
})

test('#219 源码锁：REQUIRED 恰好 12 项，Intl.DisplayNames 不在其中', () => {
  assert.deepEqual(requiredNames(), [
    'Promise',
    'fetch',
    'URL',
    'AbortController',
    'TextDecoder',
    'ResizeObserver',
    'CSS.escape',
    'Object.defineProperty',
    'Array.prototype.forEach',
    'Map',
    'Set',
    'WeakMap',
  ])
  assert.doesNotMatch(guardSource, /Intl\.DisplayNames\s*'/, '守卫的探针清单不许再点名 Intl.DisplayNames')
  // 注释要跟 #155 的结论一致，别再写「缺了只能靠这里点名」
  const comment = html.match(/<!--([\s\S]*?)-->/)[1]
  assert.match(comment, /regionNameFallback/, '守卫注释要写清楚 Intl.DisplayNames 走 regionNameFallback 兜底')
  assert.doesNotMatch(comment, /必须\*\*列进来|它没有 polyfill/, '过期注释（缺了只能靠守卫点名）必须改掉')
})

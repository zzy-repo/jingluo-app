// [layer: unit | 纯 Node + vm，无浏览器无网络 | 耗时: <1s]
// GitHub issue #13 兜底层：src/index.html 里的 ES5 启动守卫。
//
// 为什么单独测这段内联脚本：WebView 解析不了主包时，React 一行都不会执行，能救场的只有这段
// ES5。它的两个职责必须是**真的**：
//   A 极端内核（连 Promise/fetch 都没有）：给出可读提示，而不是白屏
//   B 静默失败（脚本解析失败、部分内核不抛 error 事件）：靠「一直没启动」兜底
// 同时有一条**反向**约束：Object.hasOwn / Array.prototype.at / structuredClone 已经在
// src/polyfills/legacy.ts 里补齐了，守卫**不能**把它们当致命缺失 —— 否则 WebView 83 上明明
// 能用却会弹“页面启动失败”，那就把 P0 修成了另一个 P0。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
const guardSource = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const BOOT_DEADLINE_MS = 12000

/** 造一个最小宿主：web 能力默认齐全，按需删；定时器/时钟可手动推进 */
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
  // WebView 83 上这些是有的（属于老 API），先都给上；缺的用例单独删
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
    /** 推进时钟并触发一次看门狗 */
    tick(ms) {
      clock.now += ms
      for (const handler of [...intervals.values()]) {
        handler()
      }
    },
    get pendingTimers() {
      return intervals.size
    },
  }
}

test('能力齐全时不打扰用户：不显示提示，也不往 window 上留错误标记', () => {
  const { context, box } = harness()
  assert.equal(box.hidden, true)
  assert.equal(context.__DEEPSEEK_COMPATIBILITY_ERROR__, undefined)
})

test('极端内核（没有 fetch）给出可读提示，且写明 WebView 与缺什么', () => {
  const { context, box } = harness({ remove: ['fetch = undefined'] })
  assert.equal(box.hidden, false)
  assert.match(box.textContent, /Android System WebView/)
  assert.match(box.textContent, /fetch/)
  assert.deepEqual([...context.__DEEPSEEK_COMPATIBILITY_ERROR__], ['fetch'])
})

test('补过的 API 不算致命缺失：Object.hasOwn / at / structuredClone 全没有也不报错', () => {
  const { context, box } = harness({
    remove: ['Object.hasOwn = undefined', 'Array.prototype.at = undefined', 'String.prototype.at = undefined', 'structuredClone = undefined'],
  })
  assert.equal(box.hidden, true, '这些由 src/polyfills/legacy.ts 补齐，守卫不该判死')
  assert.equal(context.__DEEPSEEK_COMPATIBILITY_ERROR__, undefined)
})

test('启动期脚本报错：把原始错误消息显示出来，且不被后续错误覆盖', () => {
  const { listeners, box } = harness()
  listeners.get('error')({ message: "Uncaught SyntaxError: Unexpected token '='" })
  assert.equal(box.hidden, false)
  assert.match(box.textContent, /Unexpected token '='/)
  const first = box.textContent
  listeners.get('unhandledrejection')({})
  assert.equal(box.textContent, first, '先到的具体原因优先，不能被“启动任务异常”盖掉')
})

test('静默白屏兜底：入口 12 秒内没启动就报错；启动了就不吵', () => {
  const stalled = harness()
  stalled.tick(BOOT_DEADLINE_MS + 1000)
  assert.equal(stalled.box.hidden, false, '超时后必须给提示')
  assert.match(stalled.box.textContent, /12 秒内没有启动/)
  assert.equal(stalled.pendingTimers, 0, '报完要停掉看门狗，别一直轮询')

  const booted = harness({ boot: true })
  booted.tick(BOOT_DEADLINE_MS + 1000)
  assert.equal(booted.box.hidden, true, '入口跑起来了就不该再报')
  assert.equal(booted.pendingTimers, 0, '启动后看门狗要自己退场')
})

test('守卫本体是 ES5：老内核解析不了新语法时它还得能跑', () => {
  assert.doesNotMatch(guardSource, /\b(?:const|let|class|async|await)\b/, '不能用 ES6 声明')
  assert.doesNotMatch(guardSource, /=>/, '不能用箭头函数')
  assert.doesNotMatch(guardSource, /\?\.|\?\?/, '不能用可选链/nullish（Chrome 80 以下没有）')
  assert.doesNotMatch(guardSource, /`/, '不能用模板字符串')
  assert.doesNotMatch(guardSource, /\.at\(|\.includes\(|\.find\(|Object\.assign/, '不能用较新的内建方法')
  assert.match(guardSource, /\bvar\b/, '要老老实实写 var')
})

test('守卫在 <head>/<body> 里先于业务包，且提示容器就在 #root 下', () => {
  assert.ok(html.indexOf('<div id="root">') < html.indexOf('<script>'), '提示容器要在脚本之前')
  assert.match(html, /<div id="root"><div id="compatibility-error" hidden><\/div><\/div>/)
  assert.ok(html.indexOf('<script>') < html.indexOf('<noscript>'))
})

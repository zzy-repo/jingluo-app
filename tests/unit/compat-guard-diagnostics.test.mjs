// [layer: unit | 纯 Node + vm，无浏览器无网络 | 耗时: <1s]
// GitHub issue #180：兜底页（src/index.html 的内联 ES5 守卫）三个出口的诊断与文案。
//
// 缺陷现场（WebView 69 / 74 实测）：三个出口里只有 ① 会写 window.__DEEPSEEK_COMPATIBILITY_ERROR__，
// ②（window error 监听）和 ③（12 秒看门狗）只画字不写变量 —— 于是反馈里拿到的是 null，
// 既不知道是哪条出口，也不知道内核版本（#104 缺的就是这个）。更糟的是 ② 把
// event.message 原样拼进用户可见文案，屏幕上直接出现「Uncaught SyntaxError: Unexpected token ?」。
//
// 本文件的四条硬要求：
//   A 三个出口都写结构化诊断（branch / code / message / missing / url / line / col / ua / webviewVersion）
//   B 用户可见文案只来自本地化模板，**不含**原始异常文本
//   C 文案与 tests/fixtures/compat-boot/compat-boot-copy.mjs 的 compatBoot* 文案逐字一致（内联 COPY 表不许自己长歪）
//   D 启动成功之后再报错不弹卡片（红线：兜底页只在真启动失败时出现）
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installTsResolve } from '../helpers/dom-env.mjs'
import { test } from 'node:test'
import vm from 'node:vm'

// 装配走公共入口（#408 收尾批）：`.js→.ts` 解析由 installTsResolve 统一装，不再手抄 registerHooks。
// 本文件没有模块替身（内联守卫源码是 readFileSync + vm 起跑），所以不带 stubs。
installTsResolve()

// 参照文案 = i18n 表 + 只存在于兜底页的文案（#104 的 17 个 key 运行时读不到 i18n，
// 已按 check-i18n R4 从 src/i18n 删除，逐字参照副本在 tests/fixtures/compat-boot/）。
const { zh, en } = await import('../fixtures/compat-boot/compat-boot-copy.mjs')

const html = readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8')
const guardSource = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const BOOT_DEADLINE_MS = 12000
const LF = String.fromCharCode(10)

/** 实测机型的 UA 原文（api26 = WebView 69.0.3497.100） */
const UA_69 =
  'Mozilla/5.0 (Linux; Android 8.0.0; Android SDK built for x86 Build/OSR1.180418.011; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/69.0.3497.100 Mobile Safari/537.36'
/** 实测机型的 UA 原文（api29 = WebView 74.0.3729.185） */
const UA_74 =
  'Mozilla/5.0 (Linux; Android 10; Android SDK built for x86 Build/QSR1.200428.001; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/74.0.3729.185 Mobile Safari/537.36'

/** 和 src/i18n/index.ts 的 {param} 替换同语义；这里独立实现，避免「用被测代码验证被测代码」 */
const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])))

/** 造一个最小宿主：web 能力默认齐全，按需删；定时器/时钟可手动推进 */
const harness = ({ remove = [], boot = false, locale = 'zh-CN', userAgent = UA_69, storedLocale = null } = {}) => {
  const box = { hidden: true, style: {}, textContent: '' }
  const listeners = new Map()
  const clock = { now: 1_700_000_000_000 }
  const intervals = new Map()
  const errors = []
  let nextTimerId = 1

  const FakeDate = function FakeDate(...args) {
    return new Date(...args)
  }
  FakeDate.now = () => clock.now
  FakeDate.prototype = Date.prototype

  const store = new Map()
  if (storedLocale !== null) {
    store.set('chat-demo:locale', storedLocale)
  }

  const context = vm.createContext({
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
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
    navigator: { language: locale, languages: [locale], userAgent },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
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
    ].join(LF),
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
    errors,
    get detail() {
      return context.__DEEPSEEK_COMPATIBILITY_ERROR__
    },
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

/**
 * #104 之后的卡片结构（顺序固定）：标题 / 主文案 / 五项环境信息（App、内核、Android、阶段、时间；
 * 设备码可选）/ 这次为什么没起来 / 升级路径或更新方法 / 页脚。
 * 这里按同一顺序拼出期望值 —— 断言的是**渲染结果**，不是守卫里的拼装逻辑。
 */
const START_AT = 1_700_000_000_000
const stampOf = (at) => {
  const pad2 = (value) => (value < 10 ? `0${value}` : String(value))
  const date = new Date(at)
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ')
}

const cardLines = (table, { code, extra, at = START_AT }) => {
  const lead =
    code === 'boot-timeout' || code === 'runtime-error' || code === 'missing-api'
      ? fill(table.compatBootLeadOld, { version: '69.0' })
      : table.compatBootLead
  return [
    table.compatBootTitle,
    lead,
    fill(table.compatBootEnvApp, { version: 'unknown' }),
    fill(table.compatBootEnvEngine, { version: '69.0.3497.100' }),
    fill(table.compatBootEnvAndroid, { version: '8.0.0' }),
    fill(table.compatBootEnvStage, {
      stage:
        code === 'missing-api'
          ? table.compatBootStageMissing
          : code === 'runtime-error'
            ? table.compatBootStageRuntime
            : table.compatBootStageTimeout,
    }),
    fill(table.compatBootEnvTime, { time: stampOf(at) }),
    ...extra,
    table.compatBootUpgradePath,
    table.compatBootFooter,
  ].join(LF)
}

/** 三个出口的诊断都必须是这一套字段（缺字段 = 反馈里又要来回问） */
const DIAGNOSTIC_FIELDS = ['branch', 'code', 'message', 'missing', 'url', 'line', 'col', 'ua', 'webviewVersion']

const assertShape = (detail, expected) => {
  assert.ok(detail && typeof detail === 'object', `诊断变量没写出来：${String(detail)}`)
  for (const field of DIAGNOSTIC_FIELDS) {
    assert.ok(field in detail, `诊断变量缺字段 ${field}`)
  }
  assert.equal(detail.branch, expected.branch)
  assert.equal(detail.code, expected.code)
  assert.equal(detail.ua, expected.ua)
  assert.equal(detail.webviewVersion, '69.0.3497.100')
  assert.equal(typeof detail.at, 'number')
  assert.equal(typeof detail.text, 'string')
}

test('#180 ① 探针缺失：写结构化诊断（branch ① + missing 名单），文案不含原始异常', () => {
  const h = harness({ remove: ['fetch = undefined'] })
  assert.equal(h.box.hidden, false)
  assertShape(h.detail, { branch: '①', code: 'missing-api', ua: UA_69 })
  assert.deepEqual([...h.detail.missing], ['fetch'])
  assert.equal(h.detail.message, '')
  assert.equal(h.detail.url, null)
  assert.equal(h.detail.line, null)
  assert.equal(h.detail.col, null)
  assert.match(h.detail.text, /缺少的运行环境能力：fetch/)
})

test('#180 ② 启动期脚本报错：原始 message / 文件名 / 行列号只进诊断，界面仍是可读中文', () => {
  const h = harness()
  h.listeners.get('error')({
    message: "Uncaught SyntaxError: Unexpected token '='",
    filename: 'https://localhost/static/js/main.030dd2a6.js',
    lineno: 1,
    colno: 249411,
  })
  assert.equal(h.box.hidden, false, '真启动失败必须给卡片')
  // 缺陷本身：这几个字符串以前就长这样直接出现在用户屏幕上
  assert.doesNotMatch(h.box.textContent, /Unexpected token/, '界面不许出现原始 JS 异常')
  assert.doesNotMatch(h.box.textContent, /SyntaxError|main\.030dd2a6\.js/, '文件名/异常类型也不许上屏')
  assert.match(h.box.textContent, /Android System WebView/, '要指向可行动的那句：更新 WebView')
  assertShape(h.detail, { branch: '②', code: 'runtime-error', ua: UA_69 })
  assert.match(h.detail.message, /Unexpected token '='/)
  assert.equal(h.detail.url, 'https://localhost/static/js/main.030dd2a6.js')
  assert.equal(h.detail.line, 1)
  assert.equal(h.detail.col, 249411)
  assert.deepEqual([...h.detail.missing], [])
  assert.equal(h.errors.length, 1, '原始细节要进 console.error，排查时能捞到')
  assert.match(h.errors[0], /\[boot-guard\] runtime-error/)
})

test('#180 ③ 12 秒看门狗：也写诊断变量（修复前这里是 null）', () => {
  const h = harness()
  h.tick(BOOT_DEADLINE_MS + 1000)
  assert.equal(h.box.hidden, false)
  assertShape(h.detail, { branch: '③', code: 'boot-timeout', ua: UA_69 })
  assert.equal(h.detail.message, '')
  assert.match(h.box.textContent, /12 秒内没有启动/)
  assert.equal(h.pendingTimers, 0, '报完要停掉看门狗')
})

test('#180 三出口的 webviewVersion 都能从 UA 解析出来（#104 缺的就是这个）', () => {
  const missing = harness({ remove: ['fetch = undefined'] })
  const runtime = harness({ userAgent: UA_74 })
  runtime.listeners.get('error')({ message: 'boom', filename: 'https://localhost/a.js', lineno: 2, colno: 3 })
  const watchdog = harness({ userAgent: UA_74 })
  watchdog.tick(BOOT_DEADLINE_MS + 1000)

  assert.equal(missing.detail.webviewVersion, '69.0.3497.100')
  assert.equal(runtime.detail.webviewVersion, '74.0.3729.185')
  assert.equal(watchdog.detail.webviewVersion, '74.0.3729.185')
  assert.match(missing.detail.ua, /; wv\)/)
})

test('#180 UA 里没有 Chrome/Chromium 时给 null，不编造版本号', () => {
  const h = harness({ userAgent: 'SomeEmbeddedBrowser/1.0' })
  h.listeners.get('error')({ message: 'boom' })
  assert.equal(h.detail.webviewVersion, null)
  assert.match(h.box.textContent, /内核版本：无法从浏览器标识里解析出来/)
})

test('#180 红线：入口已经跑起来（__DEEPSEEK_BOOTED__）之后再报错，不弹卡片、不写诊断', () => {
  const h = harness({ boot: true })
  h.listeners.get('error')({ message: 'late runtime error' })
  h.listeners.get('unhandledrejection')({})
  h.tick(BOOT_DEADLINE_MS + 1000)
  assert.equal(h.box.hidden, true, '启动成功后的运行时错误不该被当成「启动失败」')
  assert.equal(h.pendingTimers, 0)
  assert.equal(h.box.textContent, '')
  assert.equal(h.detail, undefined)
})

test('#180 文案与兜底页文案参照逐字一致（中文）', () => {
  const h = harness({ remove: ['fetch = undefined'] })
  const expected = cardLines(zh, {
    code: 'missing-api',
    extra: [fill(zh.compatBootMissing, { apis: 'fetch' })],
  })
  assert.equal(h.box.textContent, expected)
  assert.equal(h.detail.text, expected)
  // #104：UA_69 < 83，主文案必须是带升级路径那一版，而不是通用那句
  assert.match(h.box.textContent, /内核过旧（69\.0）/)
  assert.match(h.box.textContent, /设置 → 应用 → Android System WebView → 更新/)
})

test('#180 文案与兜底页文案参照逐字一致（英文界面，卡片不出中文）', () => {
  const h = harness({ remove: ['fetch = undefined'], locale: 'en-US' })
  const expected = cardLines(en, {
    code: 'missing-api',
    extra: [fill(en.compatBootMissing, { apis: 'fetch' })],
  })
  assert.equal(h.box.textContent, expected)
  assert.doesNotMatch(h.box.textContent, /[\u4e00-\u9fff]/, '英文界面不许出中文')
})

test('#180 应用内选过的语言优先于系统语言（存储里存了 en-US 就出英文）', () => {
  const h = harness({ remove: ['fetch = undefined'], locale: 'zh-CN', storedLocale: 'en-US' })
  assert.match(h.box.textContent, /This page could not start/)
  assert.doesNotMatch(h.box.textContent, /[\u4e00-\u9fff]/)
})

test('#180 超时文案同样与兜底页文案参照逐字一致', () => {
  const h = harness({ locale: 'en-US' })
  h.tick(BOOT_DEADLINE_MS + 1000)
  const expected = cardLines(en, {
    code: 'boot-timeout',
    extra: [en.compatBootTimeout],
    at: START_AT + BOOT_DEADLINE_MS + 1000,
  })
  assert.equal(h.box.textContent, expected)
})

test('#180 兜底页仍守着内核边界：守卫本体没有引入新语法，且不误伤 polyfill 过的 API', () => {
  assert.doesNotMatch(guardSource, /\b(?:const|let|class|async|await)\b/)
  assert.doesNotMatch(guardSource, /=>/)
  assert.doesNotMatch(guardSource, /\?\.|\?\?/)
  const patched = harness({
    remove: ['Object.hasOwn = undefined', 'Array.prototype.at = undefined', 'structuredClone = undefined'],
  })
  assert.equal(patched.box.hidden, true, '这些由 src/polyfills/legacy.ts 补齐，守卫不该判死')
  assert.equal(patched.detail, undefined)
})

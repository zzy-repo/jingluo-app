// [layer: unit | 纯 Node + vm，无浏览器无网络 | 耗时: <1s]
// GitHub issue #104（验收项 3 / 4）：兜底页的环境信息、一键复制、低内核明确指引。
//
// 这里盯的是「用户报障时能不能自己把话说清楚」，所以每条用例都对着**渲染出来的文本**断言，
// 而不是对着内部变量：
//   A 五项环境信息（App 版本 / 内核版本 / Android 版本 / 失败阶段 / 时间）都上卡片，格式固定；
//   B 内核主版本 < config/compat.json 的 baselineChromium 时换主文案 + 给升级路径，>= 83 不误报；
//   C 复制三层回退真的按顺序走：clipboard → execCommand → 保留可见 textarea 让用户长按；
//   D 复制内容过脱敏：设备码只留尾 4 位、URL 去 query/hash、sk-/token= 打码、不读 API Key；
//   E 异常原文只进卡片的兄弟节点 #compatibility-detail，卡片正文永远干净。
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
const START_AT = 1_700_000_000_000

const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (match, name) => (values[name] === undefined ? match : String(values[name])))

/** 和守卫里手写的格式同口径：YYYY-MM-DD HH:mm:ss（本地时区，不依赖 toLocaleString 的 options） */
const stamp = (at) => {
  const pad2 = (value) => (value < 10 ? `0${value}` : String(value))
  const date = new Date(at)
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(' ')
}

/** 实测机型 UA（#180 用过的原始串）+ 边界档位 */
const UA_69 =
  'Mozilla/5.0 (Linux; Android 8.0.0; Android SDK built for x86 Build/OSR1.180418.011; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/69.0.3497.100 Mobile Safari/537.36'
const UA_79 =
  'Mozilla/5.0 (Linux; Android 10; PDEM10 Build/QKQ1.200209.002; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/79.0.3945.93 Mobile Safari/537.36'
const UA_83 =
  'Mozilla/5.0 (Linux; Android 11; Pixel 4 Build/RQ3A.210805.001.A1; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.106 Mobile Safari/537.36'
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 造一个尽可能像真 DOM 的最小节点（nodeType 1 是守卫认节点的唯一判据） */
const createNode = (id, extra = {}) => ({
  nodeType: 1,
  id,
  hidden: true,
  className: '',
  textContent: '',
  value: '',
  style: {},
  attributes: {},
  listeners: [],
  addEventListener(name, handler) {
    this.listeners.push({ name, handler })
  },
  setAttribute(name, value) {
    this.attributes[name] = value
  },
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  },
  focus() {
    this.focused = true
  },
  select() {
    this.selected = true
  },
  setSelectionRange(start, end) {
    this.selection = [start, end]
  },
  ...extra,
})

const harness = ({
  userAgent = UA_79,
  locale = 'zh-CN',
  storedLocale = null,
  appVersion = '1.4.0-beta.10',
  deviceId = null,
  clipboard = 'none',
  execCommand = undefined,
  detailsSupported = true,
  boot = false,
  clockStart = START_AT,
} = {}) => {
  const card = createNode('compatibility-error')
  const actions = createNode('compatibility-actions')
  const button = createNode('compatibility-copy')
  const hint = createNode('compatibility-copy-hint')
  const textarea = createNode('compatibility-copy-fallback')
  const details = createNode('compatibility-detail', detailsSupported ? { open: false } : {})
  const summary = createNode('compatibility-detail-summary')
  const body = createNode('compatibility-detail-body')
  const meta = appVersion === null ? null : createNode('meta', { attributes: { content: appVersion } })
  const nodes = {
    'compatibility-error': card,
    'compatibility-actions': actions,
    'compatibility-copy': button,
    'compatibility-copy-hint': hint,
    'compatibility-copy-fallback': textarea,
    'compatibility-detail': details,
    'compatibility-detail-summary': summary,
    'compatibility-detail-body': body,
  }

  const listeners = new Map()
  const intervals = new Map()
  const errors = []
  const clock = { now: clockStart }
  const reads = []
  const store = new Map()
  if (storedLocale !== null) store.set('chat-demo:locale', storedLocale)
  if (deviceId !== null) store.set('chat-demo:ours-device-id', deviceId)
  let nextTimerId = 1
  let copied = null

  const FakeDate = function FakeDate(...args) {
    return new Date(...args)
  }
  FakeDate.now = () => clock.now
  FakeDate.prototype = Date.prototype

  const navigator = { language: locale, languages: [locale], userAgent }
  if (clipboard === 'available' || clipboard === 'reject' || clipboard === 'throw') {
    navigator.clipboard = {
      writeText(value) {
        if (clipboard === 'throw') throw new Error('clipboard is not allowed here')
        if (clipboard === 'reject') return Promise.reject(new Error('denied'))
        copied = String(value)
        return Promise.resolve()
      },
    }
  }

  const context = vm.createContext({
    console: { error: (...args) => errors.push(args.map(String).join(' ')) },
    document: {
      getElementById: (id) => nodes[id] ?? null,
      querySelector: (selector) => (selector === 'meta[name="application-version"]' ? meta : null),
      execCommand,
    },
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
    navigator,
    localStorage: {
      getItem: (key) => {
        reads.push(key)
        return store.has(key) ? store.get(key) : null
      },
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
  if (boot) vm.runInContext('window.__DEEPSEEK_BOOTED__ = true', context)

  vm.runInContext(guardSource, context)

  const click = () => {
    const listener = button.listeners.find((item) => item.name === 'click')
    assert.ok(listener, '复制按钮上没有挂 click 监听')
    listener.handler({})
  }

  return {
    context,
    card,
    actions,
    button,
    hint,
    textarea,
    details,
    summary,
    body,
    errors,
    reads,
    click,
    get copied() {
      return copied
    },
    get detail() {
      return context.__DEEPSEEK_COMPATIBILITY_ERROR__
    },
    /** 触发出口 ②（启动期脚本报错） */
    runtimeError(event = {}) {
      assert.ok(listeners.has('error'), '守卫没有监听 window error')
      listeners.get('error')({
        message: "Uncaught SyntaxError: Unexpected token '?'",
        filename: 'https://localhost/static/js/main.0badf00d.js',
        lineno: 1,
        colno: 249411,
        ...event,
      })
    },
    tick(ms) {
      clock.now += ms
      for (const handler of [...intervals.values()]) handler()
    },
    get pendingTimers() {
      return intervals.size
    },
  }
}

/** 卡片正文按行切开，方便断言「第 N 行是哪个字段」而不被前后的文案顺序卡死 */
const linesOf = (text) => text.split(LF)

test('#104 五项环境信息都上卡片：App 版本 / 内核版本 / Android 版本 / 失败阶段 / 时间', () => {
  const h = harness()
  h.runtimeError()
  const lines = linesOf(h.card.textContent)
  assert.ok(
    lines.includes(fill(zh.compatBootEnvApp, { version: '1.4.0-beta.10' })),
    `卡片里没有 App 版本：${h.card.textContent}`
  )
  assert.ok(lines.includes(fill(zh.compatBootEnvEngine, { version: '79.0.3945.93' })))
  assert.ok(lines.includes(fill(zh.compatBootEnvAndroid, { version: '10' })))
  assert.ok(lines.includes(fill(zh.compatBootEnvStage, { stage: zh.compatBootStageRuntime })))
  assert.ok(lines.includes(fill(zh.compatBootEnvTime, { time: stamp(START_AT) })))
  // 五项之外不该冒出第二份版本号（上一次实现里版本号出现两次，用户对不上是哪一份）
  assert.equal(
    lines.filter((line) => line.indexOf('内核版本：') === 0).length,
    1,
    '内核版本只许出现一次'
  )
  // 卡片是纯文本 + pre-line：不拼 HTML，也不塞子节点
  assert.match(html, /#compatibility-error \{[^}]*white-space: pre-line/)
  assert.equal(h.card.childNodes, undefined, '卡片只写 textContent，不放子节点')
  assert.equal(h.actions.hidden, false, '有卡片就要露出复制入口')
})

test('#104 内核 < 83：主文案点名「内核过旧（79.0）」并给出设置里的升级路径', () => {
  const h = harness({ userAgent: UA_79 })
  h.runtimeError()
  const lines = linesOf(h.card.textContent)
  assert.equal(lines[1], fill(zh.compatBootLeadOld, { version: '79.0' }))
  assert.ok(lines.includes(zh.compatBootUpgradePath), '缺「设置 → 应用 → Android System WebView → 更新」')
  assert.match(h.card.textContent, /设置 → 应用 → Android System WebView → 更新/)
  assert.doesNotMatch(h.card.textContent, /Unexpected token|SyntaxError|main\.0badf00d\.js/, '卡片正文不许出现异常原文')
  assert.equal(h.detail.engineMajor, 79)
  assert.equal(h.detail.engineShort, '79.0')
})

test('#104 内核 >= 83：保持通用主文案与更新方法，不误报「内核过旧」', () => {
  const h = harness({ userAgent: UA_83 })
  h.runtimeError()
  const lines = linesOf(h.card.textContent)
  assert.equal(lines[1], zh.compatBootLead)
  assert.ok(lines.includes(zh.compatBootHowTo))
  assert.doesNotMatch(h.card.textContent, /内核过旧/)
  assert.equal(h.detail.engineMajor, 83)
})

test('#104 UA 表：内核版本 / Android 版本 / 是否 WebView / 是否判旧', () => {
  const cases = [
    [UA_69, '69.0.3497.100', 69, '8.0.0', true, true],
    [UA_79, '79.0.3945.93', 79, '10', true, true],
    [UA_83, '83.0.4103.106', 83, '11', true, false],
    [
      'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.118 Mobile Safari/537.36',
      '109.0.5414.118',
      109,
      '13',
      true,
      false,
    ],
    [UA_DESKTOP, '141.0.0.0', 141, null, false, false],
    ['SomeEmbeddedBrowser/1.0', null, null, null, false, false],
  ]
  for (const [userAgent, engine, major, android, isWebView, outdated] of cases) {
    const h = harness({ userAgent, locale: 'en-US' })
    h.runtimeError()
    assert.equal(h.detail.engineVersion, engine, `内核版本解析错：${userAgent}`)
    assert.equal(h.detail.engineMajor, major)
    assert.equal(h.detail.androidVersion, android)
    assert.equal(h.detail.isWebView, isWebView)
    assert.equal(h.detail.stage, en.compatBootStageRuntime)
    const lead = linesOf(h.card.textContent)[1]
    assert.equal(lead, outdated ? fill(en.compatBootLeadOld, { version: h.detail.engineShort }) : en.compatBootLead)
  }
})

test('#104 复制第 ① 层：有 navigator.clipboard 就直接写，textarea 不参与', () => {
  const h = harness({ clipboard: 'available' })
  h.runtimeError()
  h.click()
  return Promise.resolve().then(() => {
    assert.equal(h.hint.textContent, zh.compatBootCopied)
    assert.equal(h.hint.hidden, false)
    assert.ok(h.copied && h.copied.indexOf('App 版本：1.4.0-beta.10') > -1, '复制内容里要有环境信息')
    assert.equal(h.textarea.value, '', '走剪贴板时不该往 textarea 里塞东西')
  })
})

test('#104 复制第 ② 层：clipboard 被拒 → execCommand 兜底成功', () => {
  const h = harness({ clipboard: 'reject', execCommand: (command) => command === 'copy' })
  h.runtimeError()
  h.click()
  return new Promise((resolve) => setImmediate(resolve)).then(() => {
    assert.equal(h.textarea.selected, true, '老内核这条路要先全选')
    assert.deepEqual(h.textarea.selection, [0, h.textarea.value.length])
    assert.equal(h.textarea.hidden, true, '复制成功后把 textarea 收起来')
    assert.equal(h.hint.textContent, zh.compatBootCopied)
  })
})

test('#104 复制第 ③ 层：execCommand 返回 false → textarea 留在屏幕上并提示长按', () => {
  const h = harness({ execCommand: () => false })
  h.runtimeError()
  h.click()
  assert.equal(h.textarea.hidden, false, '复制失败要把文本留在屏幕上')
  assert.ok(h.textarea.value.length > 0)
  assert.equal(h.hint.textContent, zh.compatBootCopyManual)
  assert.equal(h.hint.className, 'compatibility-failed')
})

test('#104 复制第 ③ 层：连 execCommand 都没有（老内核）也只是提示长按，不抛错', () => {
  const h = harness()
  h.runtimeError()
  h.click()
  assert.equal(h.textarea.hidden, false)
  assert.equal(h.hint.textContent, zh.compatBootCopyManual)
  assert.equal(h.errors.length, 1, 'console.error 只有守卫自己那条，不该多出异常')
})

test('#104 脱敏铁律：设备码只留尾 4 位、URL 去 query/hash、sk-/token= 打码、不读 API Key', () => {
  const h = harness({ deviceId: 'dev-0123456789abcdef' })
  h.runtimeError({
    message:
      "Uncaught SyntaxError: Unexpected token '?' sk-abcdefghijklmnopqrstuvwxyz012345 token=leaked-token",
    filename: 'https://api.rose7.cn/v1/chat?token=leaked#frag',
    lineno: 7,
    colno: 9,
  })
  h.click()
  const payload = h.textarea.value
  assert.ok(payload.indexOf('sk-***') > -1, 'API Key 要打码')
  assert.ok(payload.indexOf('sk-abcdefghijklmnopqrstuvwxyz012345') === -1, '原文不许出现')
  assert.ok(payload.indexOf('token=***') > -1, 'token 要打码')
  assert.ok(payload.indexOf('leaked') === -1)
  assert.ok(payload.indexOf('https://api.rose7.cn/v1/chat') > -1, 'URL 留 host + path')
  assert.ok(payload.indexOf('?token=') === -1 && payload.indexOf('#frag') === -1, 'URL 要去 query/hash')
  assert.ok(payload.indexOf('••••cdef') > -1, '设备码只留尾 4 位')
  assert.ok(payload.indexOf('dev-0123456789abcdef') === -1, '完整设备码不许出现')
  assert.ok(payload.indexOf(fill(zh.compatBootEnvDevice, { code: '••••cdef' })) > -1)
  assert.equal(h.reads.includes('chat-demo:api-key'), false, '守卫绝不许读 API Key')
  assert.deepEqual([...new Set(h.reads)], ['chat-demo:locale', 'chat-demo:ours-device-id'])
})

test('#104 复制内容超过 4000 字符要截断并标注', () => {
  const h = harness()
  h.runtimeError({ message: 'boom ' + 'A'.repeat(5000) })
  h.click()
  const payload = h.textarea.value
  assert.equal(payload.length, 4000, `截断到 4000 字符，实际 ${payload.length}`)
  assert.ok(payload.endsWith(zh.compatBootTruncated), '截断要标注')
})

test('#104 异常原文只进兄弟折叠区：卡片干净、折叠区有原文、默认收起', () => {
  const h = harness()
  h.runtimeError()
  assert.equal(h.details.hidden, false)
  assert.equal(h.summary.textContent, zh.compatBootDetails)
  assert.match(h.body.textContent, /Unexpected token '\?'/)
  assert.match(h.body.textContent, /main\.0badf00d\.js/)
  assert.doesNotMatch(h.card.textContent, /Unexpected token|SyntaxError|main\.0badf00d\.js/)
  // 折叠区是卡片的兄弟节点（不是子节点）：否则 card.textContent 会把原文一起算进去
  assert.match(html, /<details id="compatibility-detail" hidden>/)
})

test('#104 老内核没有原生折叠控件：原文宁可不上屏，也不许跑到卡片里', () => {
  const h = harness({ detailsSupported: false })
  h.runtimeError()
  assert.equal(h.details.hidden, true)
  assert.equal(h.body.textContent, '')
  assert.doesNotMatch(h.card.textContent, /Unexpected token|SyntaxError/)
})

test('#104 复制内容 = 卡片 + 技术细节（反馈要带证据），且技术细节同样脱敏', () => {
  const h = harness()
  h.runtimeError()
  h.click()
  const payload = h.textarea.value
  assert.ok(payload.indexOf(h.card.textContent) === 0, '先卡片正文')
  assert.match(payload, /code: runtime-error/)
  assert.match(payload, /branch: ②/)
  assert.match(payload, /Unexpected token '\?'/)
  assert.match(payload, /ua: Mozilla\/5\.0/)
})

test('#104 看门狗出口同样带环境信息；启动成功后不写诊断', () => {
  const h = harness()
  h.tick(BOOT_DEADLINE_MS + 1000)
  assert.equal(h.card.hidden, false)
  assert.equal(h.detail.code, 'boot-timeout')
  assert.ok(linesOf(h.card.textContent).includes(fill(zh.compatBootEnvStage, { stage: zh.compatBootStageTimeout })))
  assert.equal(h.pendingTimers, 0)

  const booted = harness({ boot: true })
  booted.runtimeError()
  assert.equal(booted.card.hidden, true)
  assert.equal(booted.detail, undefined)
})

test('#104 英文界面：卡片与技术细节不出中文（除了设计上就是中文的箭头路径）', () => {
  const h = harness({ locale: 'en-US' })
  h.runtimeError()
  assert.match(h.card.textContent, /Copy environment info|Engine version/)
  const lines = linesOf(h.card.textContent)
  assert.equal(lines[1], fill(en.compatBootLeadOld, { version: '79.0' }))
  assert.ok(lines.includes(fill(en.compatBootEnvStage, { stage: en.compatBootStageRuntime })))
  // 中文只允许出现在「设置 → 应用 → …」这句升级路径里？不 —— 英文文案走的是 Settings → Apps，
  // 所以整张卡片一个汉字都不该有。
  assert.doesNotMatch(h.card.textContent, /[\u4e00-\u9fff]/)
})

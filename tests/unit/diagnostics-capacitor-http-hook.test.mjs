// [layer: unit | 纯 Node + @capacitor/core 桩；不访问网络、不启动构建 | 耗时: <1s]
//
// GitHub issue #248：`installCapacitorHttpHook` 在 Capacitor 8 上挂不上，原生通道采集静默为空。
//
// 两条断言缺一不可：
//   A 可挂形态（原生桥接给了 `Capacitor.nativePromise`）：一条请求恰好一条 request + 一条 response，
//     标 `native: true`、能按 requestId 配对，响应原样交回 —— 搬挂点不许改变行为；
//   B 挂不上形态（拿不到 / 赋值不落地）：**必须留一条降级信号**。
//     「零记录 + 零信号」正是本单要消灭的东西，再静默一次等于没修。
//
// 桩照着 Capacitor 8 的真实形态摆：`registerPlugin()` 返回 `new Proxy({}, { get })`，
// `get` 每次都现造一个新函数、没有 `set` 陷阱，插件方法体里调 `cap.nativePromise(plugin, name, options)`。
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { test } from 'node:test'

let caseSeq = 0
let stubUrl = ''

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stubUrl, shortCircuit: true }
    }
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

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

const memoryStorage = () => {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    },
  }
}

/** 插件代理：真实形态 —— 每次取值现造新函数，赋值不落地（本单的成因） */
const PLUGIN_PROXY = `
const wrap = (name) => {
  const fn = (options) => Capacitor.nativePromise('CapacitorHttp', name, options)
  fn.toString = () => name + '() { [capacitor code] }'
  return fn
}
export const CapacitorHttp = new Proxy({}, {
  get: (_target, name) => (typeof name === 'string' ? wrap(name) : undefined),
})
`

/** 原生桥接：真机上由 native-bridge.js 补上，原生通道（含被换掉的 fetch）都收敛到这里 */
const NATIVE_BRIDGE = `
  nativePromise: (pluginName, methodName, options) => {
    globalThis.__bridge.push([pluginName, methodName, options])
    return globalThis.__bridgeReply
      ? globalThis.__bridgeReply(pluginName, methodName, options)
      : Promise.resolve({ status: 200, data: '{"ok":true}', url: String(options?.url ?? '') })
  },`

/**
 * 造一份 `@capacitor/core` 桩：`ok` 可挂 / `frozen` 存在但只读（赋值不落地）/ `missing` 没有。
 * 每个用例一份独立 data URL，等于独立模块实例。
 */
const stub = ({ nativePromise = 'ok', native = true } = {}) => {
  caseSeq += 1
  const parts = [PLUGIN_PROXY]
  parts.push('export const Capacitor = {')
  parts.push(`  getPlatform: () => ${native ? "'android'" : "'web'"},`)
  parts.push(`  isNativePlatform: () => ${native},`)
  if (nativePromise !== 'missing') {
    parts.push(NATIVE_BRIDGE)
  }
  parts.push('}')
  if (nativePromise === 'frozen') {
    parts.push('Object.freeze(Capacitor)')
  }
  parts.push(`// case-${caseSeq}`)
  stubUrl = `data:text/javascript,${encodeURIComponent(parts.join('\n'))}`
  globalThis.__bridge = []
  return stubUrl
}

const boot = async () => {
  define('window', globalThis)
  define('localStorage', memoryStorage())
  define('setInterval', () => 0)
  define('fetch', async () => new Response('page-fetch'))
  globalThis.__bridge = []
  globalThis.addEventListener ??= () => {}
  globalThis.removeEventListener ??= () => {}
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} })
  // 每个用例一份独立模块实例：hooksInstalled 是一次性标记，同一实例只能装一次 hook
  const collector = await import(`../../src/services/diagnostics/collector.ts?case=${caseSeq}`)
  await collector.initCollector({ installHooks: true })
  await collector.flushLogs()
  return collector
}

const netLogs = (collector) =>
  collector
    .getSnapshot()
    .logs.filter((entry) => entry.kind === 'net_request' || entry.kind === 'net_response' || entry.kind === 'net_error')

/** 原生通道的降级信号：`stage: 'http-hook'`（与 #210 的 `stage: 'fetch-hook'` 同一套约定） */
const httpNotices = (collector) =>
  collector.getSnapshot().logs.filter((entry) => entry.kind === 'warning' && entry.meta?.['stage'] === 'http-hook')

/** --- A 可挂形态：原生桥接在，钩子必须真挂上且行为不变 ---------------------------- */

test('A1 能用 Capacitor.nativePromise 时：一次请求恰好一条 request + 一条 response，标 native:true', async () => {
  stub({ nativePromise: 'ok' })
  const core = await import(stubUrl)

  // 先把「老挂点为什么是死的」当场坐实，免得这条用例变成口头描述
  assert.notEqual(core.CapacitorHttp.get, core.CapacitorHttp.get, 'Capacitor 8 的插件代理每次取值都现造新函数')
  core.CapacitorHttp.get = async () => ({ status: 599, data: 'MINE' })
  assert.equal(
    (await core.CapacitorHttp.get({ url: 'https://probe.invalid/a' })).status,
    200,
    '往插件代理上赋值不落地 —— 老实现正是这样挂的，所以一条都记不到'
  )

  const originalBridge = core.Capacitor.nativePromise
  const collector = await boot()
  assert.notEqual(core.Capacitor.nativePromise, originalBridge, '可挂形态必须真把 nativePromise 换掉')

  const response = await core.CapacitorHttp.get({ url: 'https://api.deepseek.com/chat/completions?key=SECRET' })
  assert.equal(response.status, 200, '调用方照旧拿到原响应')
  assert.equal(response.data, '{"ok":true}')

  const logs = collector.getSnapshot().logs
  const requests = logs.filter((entry) => entry.kind === 'net_request')
  const responses = logs.filter((entry) => entry.kind === 'net_response')
  assert.equal(requests.length, 1, '一次原生请求只许一条 net_request')
  assert.equal(responses.length, 1, '一次原生请求只许一条 net_response')
  const [request] = requests
  const [reply] = responses
  assert.equal(request.meta?.native, true, '走原生通道的必须标 native: true')
  assert.equal(reply.meta?.native, true, '走原生通道的必须标 native: true')
  assert.equal(request.meta?.method, 'GET', '插件直调时方法名来自 nativePromise 的 methodName')
  assert.equal(request.meta?.['url.host'], 'api.deepseek.com')
  assert.match(String(reply.meta?.['url.path']), /^\/chat\/completions/u)
  assert.equal(reply.meta?.['http.status'], 200)
  assert.equal(request.meta?.requestId, reply.meta?.requestId, 'request/response 必须能按 requestId 配对')
  assert.ok(Number(reply.meta?.bytes) > 0, '响应体积要记出来（不是 -1 那种「量不到」）')
  assert.equal(globalThis.__bridge.length, 1, '桥接只许被调一次（不许包一层再打一次卡）')
  assert.deepEqual(httpNotices(collector), [], '挂上了就不许再喊降级')
})

test('A2 非 CapacitorHttp 插件原样直通：不记录、不多包一层', async () => {
  stub({ nativePromise: 'ok' })
  const core = await import(stubUrl)
  const collector = await boot()

  const result = await core.Capacitor.nativePromise('Filesystem', 'readFile', { path: '/notes/a.txt' })
  assert.equal(result.status, 200, '结果原样交回')
  assert.deepEqual(netLogs(collector), [], '别的插件的调用不许混进 net_* 记录')
  assert.equal(globalThis.__bridge.length, 1)
  assert.equal(globalThis.__bridge[0][0], 'Filesystem', '原样透传插件名')
})

test('A3 原生请求失败：记 net_error（带原文）并把原错误抛回', async () => {
  stub({ nativePromise: 'ok' })
  const core = await import(stubUrl)
  globalThis.__bridgeReply = () => Promise.reject(new Error('ECONNRESET'))
  const collector = await boot()

  await assert.rejects(
    () => core.CapacitorHttp.post({ url: 'https://api.deepseek.com/x', method: 'POST', data: '{}' }),
    /ECONNRESET/u
  )

  const errors = collector.getSnapshot().logs.filter((entry) => entry.kind === 'net_error')
  assert.equal(errors.length, 1, '失败必须记一条 net_error')
  assert.equal(errors[0].level, 'error')
  assert.equal(errors[0].meta?.native, true)
  assert.equal(errors[0].meta?.method, 'POST')
  assert.match(errors[0].msg, /ECONNRESET/u, '错误原文必须留在库里')
  delete globalThis.__bridgeReply
})

/** --- B 挂不上形态：必须出声，不许再静默一次 ------------------------------------ */

test('B1 拿不到 Capacitor.nativePromise：写一条可诊断的降级信号', async () => {
  stub({ nativePromise: 'missing' })
  const core = await import(stubUrl)
  const collector = await boot()

  const notices = httpNotices(collector)
  assert.equal(notices.length, 1, '挂不上必须留一条信号，且只留一条')
  const [notice] = notices
  assert.equal(notice.level, 'warn')
  assert.match(notice.msg, /原生通道采集不可用/u)
  assert.match(notice.msg, /net_\* 记录/u, '信号里要写清楚后果：不会有 net_* 记录')
  assert.equal(notice.meta?.['http.channel'], 'native')
  assert.equal(notice.meta?.['http.entry'], 'nativePromise')
  assert.equal(notice.meta?.['http.hook'], 'missing')
  assert.equal(notice.meta?.['http.proxy'], 'rebuilt-on-get', '顺带把「插件代理也挂不上」这个事实写进信号')
  assert.equal(notice.meta?.native, true, '这条信号本身属于原生通道')

  // 确实记不到（老问题依旧存在）—— 但现在库里有信号说明原因，不再被读成「没有网络请求」
  assert.throws(() => core.CapacitorHttp.get({ url: 'https://api.deepseek.com/x' }), TypeError)
  assert.deepEqual(netLogs(collector), [])
  assert.equal(httpNotices(collector).length, 1, '重复初始化不许重复写信号')
})

test('B2 nativePromise 存在但赋值不落地：写降级信号，且把原桥接还回去', async () => {
  stub({ nativePromise: 'frozen' })
  const core = await import(stubUrl)
  const collector = await boot()

  const notices = httpNotices(collector)
  assert.equal(notices.length, 1, '赋值不落地同样是「挂不上」，必须有信号')
  assert.equal(notices[0].meta?.['http.hook'], 'unassignable')
  assert.match(notices[0].msg, /赋值不落地/u)

  const response = await core.CapacitorHttp.get({ url: 'https://api.deepseek.com/x' })
  assert.equal(response.status, 200, '探测失败后业务必须照旧能用（原桥接没被弄坏）')
  assert.equal(globalThis.__bridge.length, 1, '调用仍然打到真桥接')
  assert.deepEqual(netLogs(collector), [])
})

test('B3 非原生平台：没有原生通道也不许乱报警', async () => {
  stub({ nativePromise: 'missing', native: false })
  const collector = await boot()
  assert.deepEqual(httpNotices(collector), [], '网页里 CapacitorHttp 走 fetch，由 fetch 那层负责，报降级只会变成噪音')
})

/** --- D 幂等：重复初始化不许双份记录 ------------------------------------------- */

test('D1 重复 initCollector：不重复装钩子、不重复记录', async () => {
  stub({ nativePromise: 'ok' })
  const core = await import(stubUrl)
  const collector = await boot()
  await collector.initCollector({ installHooks: true })

  await core.CapacitorHttp.request({ url: 'https://api.deepseek.com/x', method: 'PUT' })
  const requests = netLogs(collector).filter((entry) => entry.kind === 'net_request')
  assert.equal(requests.length, 1, '一次请求只许一条 net_request')
  assert.equal(requests[0].meta?.method, 'PUT', '桥接换掉的 fetch 形态走 options.method')
  assert.equal(globalThis.__bridge.length, 1, '桥接不许被打两次')
})

// --- 收尾：把全局宿主桩拆掉，免得污染同进程后续用例 -------------------------------
test('Z 拆除宿主桩', () => {
  delete globalThis.__bridge
  delete globalThis.__bridgeReply
  define('fetch', undefined)
  define('window', undefined)
  define('localStorage', undefined)
})

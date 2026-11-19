// [layer: unit | 纯 Node，无浏览器无网络 | 耗时: <1s]
// GitHub issue #210「采集层假设 window.fetch 是本尊」的回归用例。
//
// 旧行为：installFetchHook 一进门就 `const original = window.fetch.bind(window)`，等于宣告
// 「window.fetch 此刻是引擎原生实现」。一旦宿主桥接层（Capacitor native-bridge 的 doPatchHttp）
// 已经把 window.fetch 换成走原生通道的包装，这段代码就把**别人的包装**当成原生：
//   - 我们照旧记 net_request / net_response，可这条路根本不经过 JS 侧的 CapacitorHttp 代理，
//     `inNativeHttp` 重入计数器永远为 0 —— 同一条请求在原生通道那边还会再记一条，双份；
//   - 我们这条记录不带 `native` 标记，于是一份原生通道的请求被标成「页面 fetch 通道」，通道标错；
//   - 桥接实现返回的 Response 是拼出来的，`response.body` 不是真流，SSE 会静默退化。
//
// 本文件钉两个方向（只钉其中一个方向等于没钉）：
//   A 浏览器形态（window.fetch 是引擎原生）：照旧接管，记录字段与既有语义一字不改，
//     并且必须把**同一个 Response 实例**原样交回（流没被动过）；
//   B 宿主接管形态（CapacitorHttp 已经把 fetch 换掉）：采集层不许再套一层 ——
//     不接管、不入库 net_*、不留带错标记的记录，只留一条可诊断的降级信号。
//   C 兜底：既不是原生、也没有 Capacitor 痕迹的第三方包装，同样不许当成原生。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

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

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

const memoryStorage = () => {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  }
}

let caseSeq = 0

/**
 * 起一个「页面环境」再装采集层。
 *
 * window 直接指向 globalThis —— 浏览器里本来就是同一个对象，这样 `window.fetch` 与
 * `globalThis.fetch` 不会像桩对象那样悄悄分家（分家会让用例假绿）。
 * setInterval 收掉：initCollector 会起 30 秒周期快照，单元测试里不能留着定时器。
 */
const boot = async ({ fetch: hostFetch, savedFetch }) => {
  caseSeq += 1
  define('window', globalThis)
  define('localStorage', memoryStorage())
  define('setInterval', () => 0)
  define('fetch', hostFetch)
  globalThis.addEventListener ??= () => {}
  globalThis.removeEventListener ??= () => {}
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {} })
  if (savedFetch === undefined) {
    delete globalThis.CapacitorWebFetch
  } else {
    define('CapacitorWebFetch', savedFetch)
  }
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

const fetchNotices = (collector) =>
  collector
    .getSnapshot()
    .logs.filter((entry) => entry.kind === 'warning' && entry.meta?.['fetch.channel'] !== undefined)

/** 引擎原生函数在 V8 里就是 `function () { [native code] }`（bind 出来的函数同样如此） */
const asEngineNative = (impl) => impl.bind(null)

/** --- A 浏览器形态：window.fetch 是引擎原生实现 --------------------------------- */

test('A1 浏览器形态照旧接管 fetch，记录语义一字不改', async () => {
  const response = new Response('ok')
  const hostFetch = asEngineNative(async () => response)
  const collector = await boot({ fetch: hostFetch })

  assert.notEqual(globalThis.fetch, hostFetch, '浏览器里必须照旧接管 fetch')
  const returned = await globalThis.fetch('https://api.deepseek.com/chat/completions', { method: 'POST', body: '{}' })

  // 关键：交回的就是宿主给的那一个 Response，body 流没被复制/消费/替换
  assert.equal(returned, response, '必须原样交回宿主返回的 Response 实例（响应体仍是真流）')

  const logs = collector.getSnapshot().logs
  const requests = logs.filter((entry) => entry.kind === 'net_request')
  const responses = logs.filter((entry) => entry.kind === 'net_response')
  assert.equal(requests.length, 1, '一次请求只许一条 net_request')
  assert.equal(responses.length, 1, '一次请求只许一条 net_response')
  const [request] = requests
  const [reply] = responses
  assert.equal(request.meta?.method, 'POST')
  assert.equal(request.meta?.['url.host'], 'api.deepseek.com')
  assert.equal(request.meta?.['url.path'], '/chat/completions')
  assert.equal(reply.meta?.['http.status'], 200)
  assert.equal(request.meta?.native, undefined, '浏览器通道不许被标成原生通道')
  assert.equal(reply.meta?.native, undefined, '浏览器通道不许被标成原生通道')
  assert.equal(request.meta?.requestId, reply.meta?.requestId, 'request/response 必须能按 requestId 配对')
  assert.deepEqual(fetchNotices(collector), [], '原生通道下不该出现降级信号')
})

/** --- B 宿主接管形态：CapacitorHttp 已经把 window.fetch 换掉 ---------------------- */

test('B1 fetch 已被宿主桥接接管时，采集层不接管、不误记、只留降级信号', async () => {
  // 桥接实现：走的是 cap.nativePromise，不经过 JS 侧 CapacitorHttp 代理（所以重入计数器管不着它）
  const nativePromise = async () => new Response('[{"choices":[]}]', { status: 200 })
  const savedFetch = asEngineNative(async () => new Response('native'))
  const bridged = function bridgedFetchWithNativeHttp(input) {
    return nativePromise('CapacitorHttp', 'request', { url: String(input) })
  }
  const collector = await boot({ fetch: bridged, savedFetch })

  assert.equal(globalThis.fetch, bridged, '已经被宿主接管的 fetch 不许再套一层（等于替原生桥接打两次卡）')
  const returned = await globalThis.fetch('https://api.deepseek.com/chat/completions')
  assert.equal(returned.status, 200, '调用方照旧拿得到响应')

  const collectorLogs = collector.getSnapshot().logs
  assert.deepEqual(
    netLogs(collector).map((entry) => `${entry.kind}:${entry.msg}`),
    [],
    '不是我们的通道就别入库：这条请求由原生通道负责，页面层再记一条就是双份 + 标错通道'
  )

  const notices = fetchNotices(collector)
  assert.equal(notices.length, 1, '降级必须留一条可诊断信号，且只留一条')
  const [notice] = notices
  assert.match(notice.msg, /采集降级/u)
  assert.equal(notice.meta?.['fetch.channel'], 'host-bridge', '要能看出是谁接管的')
  assert.equal(notice.meta?.native, true, '这条信号本身属于原生通道')
  assert.equal(notice.meta?.streaming, 'unsupported', '桥接层拿不到真流，必须明确写出来而不是假装能流式')

  // 重复 initCollector 不会重复装 hook，也不会重复写降级信号
  await collector.initCollector({ installHooks: true })
  assert.equal(fetchNotices(collector).length, 1, '重复初始化不许重复写降级信号')
  assert.ok(collectorLogs.length > 0)
})

/** --- C 兜底：既非原生、也无 Capacitor 痕迹的第三方包装 -------------------------- */

test('C1 未知包装（不是原生、也没有 Capacitor 痕迹）同样不许当成原生', async () => {
  const wrapped = (input) => Promise.resolve(new Response(`wrapped:${String(input)}`))
  const collector = await boot({ fetch: wrapped })

  assert.equal(globalThis.fetch, wrapped, '不认识的包装也不许在它外面再套一层')
  await globalThis.fetch('https://api.deepseek.com/chat/completions')
  assert.deepEqual(netLogs(collector), [], '不是我们的通道就别入库')

  const [notice] = fetchNotices(collector)
  assert.ok(notice, '同样要留降级信号')
  assert.equal(notice.meta?.['fetch.channel'], 'wrapped')
  assert.equal(notice.meta?.streaming, 'unsupported')
})

// --- 收尾：把全局宿主桩拆掉，免得污染同进程后续用例 -------------------------------
test('Z 拆除宿主桩', () => {
  delete globalThis.CapacitorWebFetch
  define('fetch', undefined)
  define('window', undefined)
  define('localStorage', undefined)
})

// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 导入失败文案按「原因」分档（#111）：真的断网 / 连接被拒绝 / 服务可达但返回错误
// 必须是三句互不相同的文案，不能都折叠成「网络已断开，请检查网络后重试」。
//
// 为什么单独一层：三档原因只在原生桥 reject 的那一瞬间可区分，真机复现要改 DNS、关端口、
// 或者让服务端吐 5xx。这里只替换 Capacitor 原生桥 / diagnostics / backup，
// urlImport 的真实分类代码（分块、重试、isTimeout / isUnreachable、fail 分支）原样运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href
// 分档纯函数（#111 本体）必须用**真模块**：本层断言的就是它的判断结果，替换成桩就什么都没测到
const failureModule = new URL('../../src/services/chat/history/importFailure.ts', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: stub('capacitor.mjs'), shortCircuit: true }
    }
    if (specifier === '../../diagnostics/collector.js') {
      return { url: stub('collector.mjs'), shortCircuit: true }
    }
    if (specifier === '../backup.js') {
      return { url: stub('backup.mjs'), shortCircuit: true }
    }
    if (specifier === './errors.js') {
      return { url: stub('errors.mjs'), shortCircuit: true }
    }
    // 上限常量（issue #34）用真模块
    if (specifier === './importLimit.js') {
      return { url: limitModule, shortCircuit: true }
    }
    // 失败分档（issue #111）用真模块
    if (specifier === './importFailure.js') {
      return { url: failureModule, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const URL_OK = 'https://obs.example.test/deepseek_data-2026-11-01.zip'

/** 三档原因各自对应的文案 key（#111 的分档契约）。 */
const KEY_OFFLINE = 'historyImportUrlOffline'
const KEY_REFUSED = 'historyImportUrlRefused'
const KEY_SERVER = 'historyImportUrlHttp'

/** 中文一眼可辨：用于断言 en 字典里这三条不含任何汉字。 */
const HAN = /[\u4e00-\u9fff]/

/**
 * 真实原生层（Android HttpURLConnection / OkHttp）抛出这几类错误的原文形态。
 * 「真的没网」「服务没监听」「服务可达但报错」在 JS 侧只剩 message，所以必须按原文分档。
 */
const ERR_DNS = Object.assign(
  new Error('java.net.UnknownHostException: Unable to resolve host "obs.example.test": No address associated with hostname'),
  { name: 'Error' }
)
const ERR_REFUSED = Object.assign(
  new Error(
    'java.net.ConnectException: failed to connect to obs.example.test/203.0.113.7:443 after 10000ms: isConnected failed: ECONNREFUSED (Connection refused)'
  ),
  { name: 'Error' }
)

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

const useNative = (get) => {
  const native = { native: true, calls: [], get }
  globalThis.__native = native
  return native
}

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

/** 首块就 reject 指定错误：分类点在 fetchChunk 的 catch 分支。 */
const failFast = (error) =>
  useNative(() => {
    throw error
  })

/** 首块返回指定 HTTP 状态：分类点在 failForStatus。 */
const statusNative = (status) =>
  useNative(() => ({ status, url: URL_OK, headers: {}, data: null }))

/** 跑一次导入，返回 result（error）而不是抛出去。 */
const runImport = async (options = {}) => {
  const error = await importHistoryFromUrl(URL_OK, options).then(
    () => null,
    (reason) => reason
  )
  assert.ok(error, '必须在有限时间内给出失败终态，不能一直 pending')
  assert.equal(error.name, 'BackupError', `失败终态应是 BackupError，实际 ${error?.name}`)
  return error
}

/** 一个用例：换掉原生桥，跑一次导入，拿回失败 key（并打印给人看）。 */
const keyFor = async (setup) => {
  resetEnv()
  setup()
  const error = await runImport()
  console.log(`    -> key=${error.key} params=${JSON.stringify(error.params ?? null)}`)
  return error.key
}

test('① 真的没有网络（DNS 失败）→ 沿用现有那句「网络已断开」', async () => {
  const key = await keyFor(() => failFast(ERR_DNS))
  assert.equal(key, KEY_OFFLINE, 'DNS 解析失败属于「真的没网」，应保留 historyImportUrlOffline')
  assert.equal(zh[KEY_OFFLINE], '网络已断开，请检查网络后重试', 'zh 这句要保持用户已习惯的措辞')
})

test('② 连接被拒绝 / 服务未监听（ECONNREFUSED）→ 不能说成「网络已断开」', async () => {
  const key = await keyFor(() => failFast(ERR_REFUSED))
  assert.equal(
    key,
    KEY_REFUSED,
    `ECONNREFUSED 说明网络是通的、只是对面没在监听，实际仍然报成了 ${key}`
  )
})

test('③ 服务可达但返回错误（503）→ 单独一档，且带上状态码', async () => {
  resetEnv()
  statusNative(503)
  const error = await runImport()
  console.log(`    -> key=${error.key} params=${JSON.stringify(error.params ?? null)}`)
  assert.equal(error.key, KEY_SERVER, '4xx/5xx 属于「服务可达但返回错误」，不能折叠成断网')
  assert.equal(error.params?.status, 503)
})

test('④ 三档文案互不相同（这就是 #111 的核心断言）', async () => {
  const offline = await keyFor(() => failFast(ERR_DNS))
  const refused = await keyFor(() => failFast(ERR_REFUSED))
  resetEnv()
  statusNative(404)
  const server = (await runImport()).key
  console.log(`    -> offline=${offline} refused=${refused} server=${server}`)
  assert.equal(new Set([offline, refused, server]).size, 3, '三档原因必须是三个不同的 key')
  for (const key of [offline, refused, server]) {
    assert.equal(typeof zh[key], 'string', `zh 字典缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 字典缺少 ${key}`)
  }
  const copies = [zh[offline], zh[refused], zh[server]]
  console.log(`    -> ${copies.join('  |  ')}`)
  assert.equal(new Set(copies).size, 3, '三档的中文文案必须互不相同')
})

test('⑤ en 字典下这三档都不含中文（否则用户会看到中英混排）', () => {
  for (const key of [KEY_OFFLINE, KEY_REFUSED, KEY_SERVER]) {
    const text = en[key]
    assert.equal(typeof text, 'string', `en 字典缺少 ${key}`)
    assert.equal(HAN.test(text), false, `en.${key} 含中文：${text}`)
    console.log(`    -> en.${key} = ${text}`)
  }
})

test('⑥ 纯函数分类：offline / refused / server 三档，且 navigator.onLine === false 一律算断网', async () => {
  // 纯 Node 可测：不碰 Capacitor、不碰网络、不碰 i18n 运行时
  const { classifyImportFailure } = await import('../../src/services/chat/history/importFailure.ts')
  assert.equal(classifyImportFailure({ error: ERR_DNS }), 'offline')
  assert.equal(classifyImportFailure({ error: ERR_REFUSED }), 'refused')
  assert.equal(classifyImportFailure({ status: 500 }), 'server')
  assert.equal(classifyImportFailure({ status: 404 }), 'server')
  // 离线是权威信号：浏览器自己说没网，就一定是「真的断网」，不看底层错误码
  assert.equal(classifyImportFailure({ error: ERR_REFUSED, online: false }), 'offline')
  // 认不出来的错误不能被硬塞进任何一档（避免又把无关失败说成断网）
  assert.equal(classifyImportFailure({ error: new Error('something else entirely') }), null)
})

// [layer: unit | 依赖: 无（纯 Node；原生桥用替身，不发真实请求） | Issue #18（关联 #12 / #111 / #154）]
//
// 回归对象：导入失败里「**真的没网**」与「**有网但连不上导入服务**」必须是两句不同的文案。
//
// 修复前症状（#18 池子第 1 项，由 #111 分档后残留）：
//   #111 把「连接被拒 / 服务端回错」从「网络已断开」里拆了出来，但「有网却连不上」这一档
//   （DNS 解析失败、ENETUNREACH / EHOSTUNREACH、net::ERR_NETWORK_CHANGED）仍然落到
//   `historyImportUrlOffline`＝「网络已断开，请检查网络后重试」。用户网络明明是通的，
//   照着文案去检查网络、开关飞行模式，怎么试都不对 —— 该说的是「暂时连不上导入服务」。
//
// 修复后预期：
//   - navigator.onLine === false（或等价信号）→ offline 档，沿用「网络已断开」那句
//   - 在线但够不到服务 → unreachable 档，新文案（中文不含「网络已断开」，英文不含汉字）
//   - 连接被拒（ECONNREFUSED）仍单独一档，不被这次拆分吞掉
//   - 两档都必须仍然可重试（保留重试，不因分档砍掉重试）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve, loadTsModule, moduleUrl } from '../helpers/dom-env.mjs'

// 装配（`.js→.ts` + 原生桥替身）走 tests/helpers/dom-env.mjs 的公共入口（#366）：
// 这段以前是本文件里手抄的 45 行样板，90 个 L0 文件各有一份。
// 上限常量（issue #34）和失败分档（issue #111）用**真模块**：本层断言的就是它们的判断结果，
// 换成桩就什么都没测到；只有原生桥 / 诊断 / 备份这三样换替身。
installTsResolve({
  stubs: {
    '@capacitor/core': fixtureUrl('url-import-stubs/capacitor.mjs'),
    '../../diagnostics/collector.js': fixtureUrl('url-import-stubs/collector.mjs'),
    '../backup.js': fixtureUrl('url-import-stubs/backup.mjs'),
    './errors.js': fixtureUrl('url-import-stubs/errors.mjs'),
    './importLimit.js': moduleUrl('src/services/chat/history/importLimit.ts'),
    './importFailure.js': moduleUrl('src/services/chat/history/importFailure.ts'),
  },
})

const { importHistoryFromUrl } = await loadTsModule('src/services/chat/history/urlImport.ts')
const { classifyImportFailure, IMPORT_FAILURE_KEYS } = await loadTsModule('src/services/chat/history/importFailure.ts')
const { zh } = await loadTsModule('src/i18n/zh.ts')
const { en } = await loadTsModule('src/i18n/en.ts')

const KEY_OFFLINE = 'historyImportUrlOffline'
const KEY_UNREACHABLE = 'historyImportUrlUnreachable'
const KEY_REFUSED = 'historyImportUrlRefused'

/** 中文一眼可辨：英文文案里出现汉字就是没本地化。 */
const HAN = /[\u4e00-\u9fff]/

/**
 * 真实原生层（OkHttp / HttpURLConnection）与 WebView 抛出的「有网但够不到服务」原文。
 * 这几条过去都被判成 offline（文案：「网络已断开」），用户照着改网络怎么都修不好。
 */
const ERR_HOST_UNREACHABLE = new Error('java.net.NoRouteToHostException: ENETUNREACH (Network is unreachable)')
const ERR_WEBVIEW_NETWORK_CHANGED = new TypeError('net::ERR_NETWORK_CHANGED')
const ERR_REFUSED = new Error('java.net.ConnectException: failed to connect to obs.example.test: ECONNREFUSED (Connection refused)')
const ERR_DNS = new Error('java.net.UnknownHostException: Unable to resolve host "obs.example.test"')

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

const useFailingNative = (makeError) => {
  const native = { native: true, calls: [], get: () => Promise.reject(makeError()) }
  globalThis.__native = native
  return native
}

/** 装一个假的 navigator.onLine，用完恢复原样（同进程其它用例不受影响）。 */
const withOnLine = async (onLine, run) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine, connection: undefined },
    configurable: true,
    writable: true,
  })
  try {
    return await run()
  } finally {
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
  }
}

/** 跑一次导入，返回失败终态 + 原生桥实际被调用次数。 */
const startImport = async (url) => {
  const error = await importHistoryFromUrl(url, {}).then(
    () => null,
    (reason) => reason
  )
  assert.ok(error, '必须在有限时间内给出失败终态，不能一直 pending')
  return error
}

const URL_UNREACHABLE = 'https://obs.example.test/copy-unreachable.zip'
const URL_OFFLINE = 'https://obs.example.test/copy-offline.zip'
const URL_REFUSED = 'https://obs.example.test/copy-refused.zip'

test('#18 在线但够不到服务 → 归 unreachable 档，不再算「断网」', () => {
  // 纯函数层：网络是通的（online 未置 false），失败原因是解析不到 / 路由不到
  assert.equal(classifyImportFailure({ error: ERR_HOST_UNREACHABLE }), 'unreachable')
  assert.equal(classifyImportFailure({ error: ERR_WEBVIEW_NETWORK_CHANGED }), 'unreachable')
  assert.equal(classifyImportFailure({ error: ERR_DNS }), 'unreachable')
  // 权威信号优先：浏览器自己说没网就还是 offline，不看错误串
  assert.equal(classifyImportFailure({ error: ERR_HOST_UNREACHABLE, online: false }), 'offline')
  // 连接被拒是第三件事，不许被这次拆分吞掉
  assert.equal(classifyImportFailure({ error: ERR_REFUSED }), 'refused')
})

test('#18 unreachable 有独立文案 key，与 offline / refused 三句互不相同', () => {
  assert.equal(IMPORT_FAILURE_KEYS.offline, KEY_OFFLINE)
  assert.equal(IMPORT_FAILURE_KEYS.unreachable, KEY_UNREACHABLE)
  assert.equal(IMPORT_FAILURE_KEYS.refused, KEY_REFUSED)
  console.log(`    -> zh offline      = ${zh[KEY_OFFLINE]}`)
  console.log(`    -> zh unreachable  = ${zh[KEY_UNREACHABLE]}`)
  console.log(`    -> zh refused      = ${zh[KEY_REFUSED]}`)
  assert.equal(new Set(Object.values(IMPORT_FAILURE_KEYS)).size, Object.keys(IMPORT_FAILURE_KEYS).length)
  assert.notEqual(zh[KEY_UNREACHABLE], zh[KEY_OFFLINE], '两档共用一句等于没分档')
  assert.equal(
    zh[KEY_UNREACHABLE].includes('网络已断开'),
    false,
    `unreachable 的文案不许再说「网络已断开」（用户网络是通的）：${zh[KEY_UNREACHABLE]}`
  )
})

test('#18 en 字典同步有这条，且不含汉字', () => {
  assert.equal(typeof en[KEY_UNREACHABLE], 'string', `en 字典缺少 ${KEY_UNREACHABLE}`)
  console.log(`    -> en unreachable  = ${en[KEY_UNREACHABLE]}`)
  assert.equal(HAN.test(en[KEY_UNREACHABLE]), false, `en.${KEY_UNREACHABLE} 含中文：${en[KEY_UNREACHABLE]}`)
})

test('#18 端到端：Safari/WebView 的网络变化错误 → unreachable 文案，且仍然重试', async () => {
  resetEnv()
  const native = useFailingNative(() => new TypeError('net::ERR_NETWORK_CHANGED'))
  await withOnLine(true, async () => {
    const error = await startImport(URL_UNREACHABLE)
    console.log(`    -> 在线不可达：key=${error.key}、请求 ${native.calls.length} 次`)
    assert.equal(
      error.key,
      KEY_UNREACHABLE,
      `有网却连不上导入服务时不能报「网络已断开」（实际 ${error.key}）`
    )
    assert.equal(native.calls.length, 2, '判不可达不等于砍掉重试：瞬时断链恢复后仍要能续上')
  })
})

test('#18 端到端：navigator.onLine === false → 仍是 offline 文案（旧口径不退化）', async () => {
  resetEnv()
  const native = useFailingNative(() => new TypeError('net::ERR_NETWORK_CHANGED'))
  await withOnLine(false, async () => {
    const error = await startImport(URL_OFFLINE)
    console.log(`    -> 真离线：key=${error.key}、请求 ${native.calls.length} 次`)
    assert.equal(error.key, KEY_OFFLINE, `真没网必须还是那句「网络已断开」（实际 ${error.key}）`)
    assert.equal(native.calls.length, 2, '离线也保留重试')
  })
})

test('#18 端到端：连接被拒仍是 refused 档（三档不互相覆盖）', async () => {
  resetEnv()
  const native = useFailingNative(() => ERR_REFUSED)
  await withOnLine(true, async () => {
    const error = await startImport(URL_REFUSED)
    console.log(`    -> 连接被拒：key=${error.key}、请求 ${native.calls.length} 次`)
    assert.equal(error.key, KEY_REFUSED)
  })
})

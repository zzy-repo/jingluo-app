// [layer: regression | 依赖: 无（纯 Node；原生桥用替身，不发真实请求） | Issue #111（关联 #12 / #9）]
//
// 回归对象：导入失败原因的**分档**——src/services/chat/history/importFailure.ts 与
//   urlImport 的失败分类出口。
//
// 修复前症状（#111 / #12）：所有失败都落到同一句「网络已断开，请检查网络后重试」。
//   连接被拒（对面没在监听）、服务端 403（链接过期 / 签名错 / 无权限）全被说成"你手机没网"，
//   用户只能反复换网，问题在服务端却看不出来。
// 修复后预期：至少三档互不混用——真的没网（offline）、链路通但没人接（refused）、
//   服务可达但回了错误（server）；三档对应不同的文案 key，403 还要再分 过期 / 签名 / 无权限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') return { url: stub('capacitor.mjs'), shortCircuit: true }
    if (specifier === '../../diagnostics/collector.js') return { url: stub('collector.mjs'), shortCircuit: true }
    if (specifier === '../backup.js') return { url: stub('backup.mjs'), shortCircuit: true }
    if (specifier === './errors.js') return { url: stub('errors.mjs'), shortCircuit: true }
    // importLimit 要真模块：这条用例本身就是「上限口径」，替身会失去意义
    if (specifier === './importLimit.js') return { url: limitModule, shortCircuit: true }
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

const { classifyImportFailure, IMPORT_FAILURE_KEYS } = await import(
  '../../src/services/chat/history/importFailure.ts'
)
const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')

test('#111 真的没网才归 offline（DNS 失败 / 浏览器离线）', () => {
  assert.equal(classifyImportFailure({ error: new Error('net::ERR_INTERNET_DISCONNECTED') }), 'offline')
  assert.equal(classifyImportFailure({ error: new Error('net::ERR_NAME_NOT_RESOLVED') }), 'offline')
  assert.equal(classifyImportFailure({ error: new Error('Unable to resolve host "obs.example.test"') }), 'offline')
  assert.equal(classifyImportFailure({ online: false }), 'offline', 'navigator.onLine === false 是最高优先级信号')
})

test('#111 连接被拒必须单独一档，不能混成"你的网络断了"', () => {
  assert.equal(classifyImportFailure({ error: new Error('Connection refused (ECONNREFUSED)') }), 'refused')
  assert.equal(classifyImportFailure({ error: new Error('net::ERR_CONNECTION_REFUSED') }), 'refused')
  assert.equal(
    classifyImportFailure({ online: false, error: new Error('ECONNREFUSED') }),
    'offline',
    '浏览器明确说离线时，即使错误原文像 refused 也算离线'
  )
})

test('#111 服务可达但回错自成一档；认不出来的失败不许硬塞进任何一档', () => {
  assert.equal(classifyImportFailure({ status: 500 }), 'server')
  assert.equal(classifyImportFailure({ status: 403 }), 'server')
  assert.equal(classifyImportFailure({ error: new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE') }), 'server')
  assert.equal(classifyImportFailure({ error: new Error('某个没人见过的新错误') }), null)
})

test('#111 三档对应三个不同文案 key（这就是"用户看不到真实原因"的回归点）', () => {
  assert.equal(IMPORT_FAILURE_KEYS.offline, 'historyImportUrlOffline')
  assert.equal(IMPORT_FAILURE_KEYS.refused, 'historyImportUrlRefused')
  assert.equal(IMPORT_FAILURE_KEYS.server, 'historyImportUrlHttp')
  const shown = new Set(Object.values(IMPORT_FAILURE_KEYS))
  assert.equal(shown.size, 3, '三档共用一句文案等于没分档')
  assert.notEqual(zh.historyImportUrlOffline, zh.historyImportUrlRefused)
})

/** 组装一次 CapacitorHttp.get：固定状态码 + 错误体，用来走 403 的三个子类。 */
const staticNative = (response) => async () => response

const runImport = async (url, get) => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__native = { native: true, calls: [], get }
  try {
    await importHistoryFromUrl(url, {})
    return null
  } catch (error) {
    return error
  }
}

const URL_403 = 'https://obs.example.test/deepseek_data-403.zip'
const body403 = (code) => `<Error><Code>${code}</Code><Message>denied</Message></Error>`

test('#111 403 签名错 → 链接无效（签名错误），不是"网络断开"', async () => {
  const error = await runImport(URL_403, staticNative({ status: 403, url: URL_403, headers: {}, data: body403('SignatureDoesNotMatch') }))
  assert.equal(error?.key, 'historyImportUrlBadSignature')
})

test('#111 403 过期 / 时间偏移 → 链接已过期', async () => {
  for (const code of ['Expired', 'RequestTimeTooSkewed']) {
    const error = await runImport(URL_403, staticNative({ status: 403, url: URL_403, headers: {}, data: body403(code) }))
    assert.equal(error?.key, 'historyImportUrlExpired', `${code} 要归到"过期"而不是"没权限"`)
  }
})

test('#111 403 其他原因 → 无权限，并把服务端原文带给用户', async () => {
  const error = await runImport(
    URL_403,
    staticNative({ status: 403, url: URL_403, headers: {}, data: body403('AccessDenied') })
  )
  assert.equal(error?.key, 'historyImportUrlForbidden')
  assert.match(String(error?.params?.detail), /AccessDenied/)
})

test('#111 服务端 5xx → 带状态码的 HTTP 失败文案', async () => {
  const error = await runImport(URL_403, staticNative({ status: 500, url: URL_403, headers: {}, data: 'oops' }))
  assert.equal(error?.key, 'historyImportUrlHttp')
  assert.equal(error?.params?.status, 500)
})

test('#111 原生桥报"网络不可达"与"连接被拒"落到不同文案', async () => {
  const offline = await runImport(URL_403, async () => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED')
  })
  assert.equal(offline?.key, 'historyImportUrlOffline')
  const refused = await runImport(URL_403, async () => {
    throw new Error('Connection refused (ECONNREFUSED)')
  })
  assert.equal(refused?.key, 'historyImportUrlRefused')
})

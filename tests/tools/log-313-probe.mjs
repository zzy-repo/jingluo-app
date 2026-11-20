// [tool] Issue #313 改前 / 改后对照探针（同一批场景，跑两份 src）
//
//   node tests/tools/log-313-probe.mjs D:/all_project/runs/log313-base   # 改前（origin/main）
//   node tests/tools/log-313-probe.mjs D:/all_project/runs/log313        # 改后
//
// 为什么需要它：改前改后的对照必须是**同一场景、同一份采集清洗**。
// 这里只把外部世界换掉（Capacitor 原生桥 / fetch / backup / 错误类），
// `record()` 的清洗仍然调目标 src 里的真实 `sanitizeMeta`，
// 所以打印出来的 meta 就是那一版代码在真机上会写进日志的东西。
//
// 输出：每个场景一条 JSON（日志按 message 分组，附每条 meta 的键），最后一份 summary。
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? process.cwd())
if (!existsSync(`${root}/src/services/chat/history/urlImport.ts`)) {
  console.error(`不是 deepseek-app 的 src 根：${root}`)
  process.exit(2)
}
const srcFile = (rel) => pathToFileURL(`${root}/src/${rel}`).href
const fixture = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href

const dataModule = (code) => `data:text/javascript,${encodeURIComponent(code)}`

/** 采集替身：**清洗是真的**（目标 src 里的 sanitizeMeta），只有存储是内存 */
const collectorStub = dataModule(`
import { sanitizeMeta } from '${srcFile('services/diagnostics/fields.ts')}'
import { redactUrl } from '${srcFile('services/diagnostics/redact.ts')}'
export { redactUrl }
const DEFAULT_LEVEL = { error: 'error', net_error: 'error', import_error: 'error', warning: 'warn', longtask: 'warn' }
const clean = (fields) => {
  const meta = sanitizeMeta(fields ?? {})
  return Object.keys(meta).length === 0 ? undefined : meta
}
export const record = (kind, level, message, fields) => {
  const entry = { kind, level: level ?? DEFAULT_LEVEL[kind] ?? 'info', message, meta: clean(fields) }
  globalThis.__log.entries.push(entry)
  return entry
}
export const recordEvent = (kind, message, fields) => record(kind, undefined, message, fields)
export const recordAction = (kind, action, fields = {}) => record(kind, 'info', action, { action, ...fields })
export const errorMeta = (error) =>
  error instanceof Error ? { 'error.msg': error.message, 'error.name': error.name } : {}
export const recordError = (message, fields = {}, error) => record('error', 'error', message, { ...fields, ...errorMeta(error) })
export const captureStateSnapshot = () => ''
export const flushLogs = async () => {}
export const getLogCount = () => 0
`)

const capacitorStub = dataModule(`
export const Capacitor = {
  isNativePlatform: () => globalThis.__native?.native === true,
  getPlatform: () => (globalThis.__native?.native === true ? 'android' : 'web'),
}
export const CapacitorHttp = {
  get: (options) => {
    globalThis.__native.calls.push(options)
    return globalThis.__native.get(options)
  },
  post: (options) => {
    globalThis.__native.calls.push(options)
    return Promise.reject(new Error('native post not stubbed'))
  },
}
`)

/** 相对导入写的是 `.js`、实际文件是 `.ts`：按**目标 src** 解析 */
const asTypescript = (specifier, parentURL) => {
  if (!parentURL || !specifier.startsWith('.') || !specifier.endsWith('.js')) {
    return null
  }
  const target = fileURLToPath(new URL(specifier, parentURL)).replace(/\.js$/, '.ts')
  return existsSync(target) ? pathToFileURL(target).href : null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: capacitorStub, shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: collectorStub, shortCircuit: true }
    }
    if (specifier === '../backup.js') {
      return { url: fixture('backup.mjs'), shortCircuit: true }
    }
    if (specifier === './errors.js') {
      return { url: fixture('errors.mjs'), shortCircuit: true }
    }
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ = false
globalThis.__ENDPOINTS__ = { chatBaseUrl: 'https://api.deepseek.com' }
globalThis.__log = { entries: [] }
globalThis.__imported = []
globalThis.__importCount = 3

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}
const realSetTimeout = globalThis.setTimeout
const BACKOFF_DELAYS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, BACKOFF_DELAYS.has(ms) ? 1 : ms, ...args)
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }

const requests = []
let fetchImpl = () => Promise.reject(new Error('fetch not stubbed'))
globalThis.fetch = (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  return fetchImpl({ url: String(url), init })
}

const delay = (ms) => new Promise((done) => realSetTimeout(done, ms))
const blob = (size) => new Blob([new Uint8Array(size)], { type: 'image/png' })
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}
const zip = zipBytes(3 * 1024 * 1024 + 512 * 1024)
const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}
const sliceResponse = (url, source, from, to) => {
  const end = Math.min(to, source.length - 1)
  const slice = source.slice(from, end + 1)
  return {
    status: 206,
    url,
    headers: {
      'Content-Range': `bytes ${from}-${end}/${source.length}`,
      'Content-Length': String(slice.length),
    },
    data: slice.buffer,
  }
}
const useNative = (get) => {
  globalThis.__native = { native: true, calls: [], get }
}
const rangeNative = () =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    return Promise.resolve(sliceResponse(options.url, zip, from, to))
  })
const stallAfterFirstChunk = () => {
  let served = 0
  useNative((options) => {
    if (served >= 1) {
      return new Promise(() => {})
    }
    served += 1
    const { from, to } = rangeOf(options)
    return Promise.resolve(sliceResponse(options.url, zip, from, to))
  })
}

const apiConfig = await import(srcFile('services/api/apiConfig.ts'))
const attachments = await import(srcFile('services/attachments.ts'))
const urlImport = await import(srcFile('services/chat/history/urlImport.ts'))
const { setApiKey, setProviderKind } = apiConfig

const resetLog = () => {
  globalThis.__log.entries.length = 0
  requests.length = 0
}

/** 一条日志 → 给人看的摘要：level + 文案 + meta 的键（值太长的不打） */
const digest = (entry) => ({
  level: entry.level,
  kind: entry.kind,
  message: entry.message,
  metaKeys: Object.keys(entry.meta ?? {}),
})

const report = (name, extra = {}) => {
  const entries = globalThis.__log.entries
  const byMessage = new Map()
  for (const entry of entries) {
    const key = entry.message
    byMessage.set(key, (byMessage.get(key) ?? 0) + 1)
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        scene: name,
        total: entries.length,
        thinMeta: entries.filter((entry) => Object.keys(entry.meta ?? {}).length < 2).length,
        counts: Object.fromEntries(byMessage),
        logs: entries.map(digest),
        ...extra,
      },
      null,
      1
    )}\n`
  )
  resetLog()
}

// ---------------------------------------------------------------- 场景

// [1] 三个文件：1 成功 / 1 服务端 500 / 1 取消
{
  setProviderKind('deepseek')
  setApiKey('sk-test-313')
  resetLog()
  fetchImpl = () => Promise.resolve(jsonResponse({ id: 'file-ok', type: 'file' }))
  await attachments.uploadAttachment('sk-test-313', 'p-ok', blob(3072), 'ok.png', true)

  fetchImpl = () => Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500))
  await attachments.uploadAttachment('sk-test-313', 'p-fail', blob(4096), 'fail.png', true).catch(() => {})

  fetchImpl = ({ init }) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      )
    })
  const cancelling = attachments
    .uploadAttachment('sk-test-313', 'p-cancel', blob(8192), 'cancel.png', true)
    .catch(() => {})
  await delay(10)
  attachments.cancelUpload('p-cancel')
  await cancelling
  report('附件上传：成功 + 500 + 取消', { fetchRequests: requests.length })
}

// [2] 渠道没有 Files API
{
  setProviderKind('ours')
  setApiKey('sk-test-313')
  resetLog()
  await attachments.uploadAttachment('sk-test-313', 'p-ours', blob(1024), 'a.png', true).catch(() => {})
  report('附件上传：渠道不支持', { fetchRequests: requests.length })
}

// [3] URL 导入：3.5MB 分块下载成功
{
  resetLog()
  rangeNative()
  await urlImport.importHistoryFromUrl('https://obs.example.test/log-313-ok.zip', {
    heartbeatIntervalMs: 10_000,
    downloadStallMs: 5_000,
  })
  report('URL 导入：成功（3.5MB）')
}

// [4] URL 导入：下载停滞（第一块之后无数据）
{
  resetLog()
  stallAfterFirstChunk()
  const error = await urlImport
    .importHistoryFromUrl('https://obs.example.test/log-313-stall.zip', {
      heartbeatIntervalMs: 40,
      downloadStallMs: 150,
    })
    .catch((reason) => reason)
  report('URL 导入：下载停滞', { errorKey: error?.key ?? null })
}

// [5] 非法 URL
{
  resetLog()
  useNative(() => Promise.resolve({ status: 200, data: null }))
  const error = await urlImport.importHistoryFromUrl('not a url').catch((reason) => reason)
  report('URL 导入：非法地址', { errorKey: error?.key ?? null, nativeCalls: globalThis.__native.calls.length })
}

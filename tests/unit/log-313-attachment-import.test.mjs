// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #313 验收：附件上传与 URL 导入两条链路的埋点（失败点补齐 / 成功点补齐 / 每条 meta 够用）。
//
// 这一层只替换「外部世界」，业务代码原样运行：
//   - `@capacitor/core`：原生桥替身（可返回永不 settle 的 Promise）；
//   - `chat/backup.js`：只返回固定会话数（导入解析本身有独立用例）；
//   - `chat/history/errors.js`：等价 BackupError（真模块用了 TS 参数属性，strip-only 跑不了）；
//   - diagnostics 的**存储**：内存数组。
//
// 关键一点：写入的 meta 走的是**真实的 `sanitizeMeta`**（与 `collector.record()` 同一个清洗函数，
// 白名单 / 截断 / 完整 URL 压成 path / 密钥键整条丢弃都在），所以下面断言的 meta
// 就是后端真正会收到的那份；不是把调用方传进去的对象原样回读。
//
//   node tests/run-layer.mjs unit --only log-313-attachment-import
//
// 覆盖：
//   [1] 多文件上传：每个文件都有「开始 / 成功」两条，排队等待（queueMs）能单独看到
//   [2] 上传失败：一条 error，带 status / durationMs / retryable / error.msg
//   [3] 用户取消：warn 级「aborted」，与真实失败分开
//   [4] 渠道没有 Files API：warn 级 rejected + reason=channel-unsupported + retryable=false，**0 请求**
//   [5] 额度不足：reason=quota-files，retryable=false
//   [6] URL 导入成功（3.5MB 分块）：开始 → 下载开始 → 下载完成 → import_done，四段同一个 correlationId
//   [7] 下载停滞：阶段日志 + 心跳 + 失败终态三件都有，且「停在哪一块」可见
//   [8] 续传：第二次导入的第一条日志带 status=partial + 已下载字节
//   [9] 非法 URL：reason=invalid-url，与下载失败分得开
//  [10] 全量体检：本次两条链路产出的每一条日志 meta 都不为空、且至少 2 个键
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipBytes } from '../helpers/url-import-fixtures.mjs'

const srcUrl = (rel) => new URL(`../../src/${rel}`, import.meta.url).href
const fieldsUrl = srcUrl('services/diagnostics/fields.ts')
const redactModule = srcUrl('services/diagnostics/redact.ts')
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href
const failureModule = new URL('../../src/services/chat/history/importFailure.ts', import.meta.url).href
const stubUrl = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href

const dataModule = (code) => `data:text/javascript,${encodeURIComponent(code)}`

/** 源码里写的是 `.js`、实际文件是 `.ts`（NodeNext 约定），node 不会自己改后缀 */
const asTypescript = (specifier, parentURL) => {
  if (!parentURL || !specifier.startsWith('.') || !specifier.endsWith('.js')) {
    return null
  }
  const target = fileURLToPath(new URL(specifier, parentURL)).replace(/\.js$/, '.ts')
  return existsSync(target) ? pathToFileURL(target).href : null
}

/**
 * 诊断采集替身：**清洗用真实的 sanitizeMeta**，只有「写到哪里」是替身。
 * `meta` 为空时按真实现丢掉整个字段（`cleanMeta` 的行为），这样「meta 缺失」也能被断言到。
 */
const collectorStub = dataModule(`
import { sanitizeMeta } from '${fieldsUrl}'
import { redactUrl } from '${redactModule}'
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

/** 原生桥替身：`globalThis.__native` 由用例装配（附件链路用不到，就是非原生 → 走 fetch） */
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: capacitorStub, shortCircuit: true }
    }
    if (/diagnostics\/collector\.js$/.test(specifier)) {
      return { url: collectorStub, shortCircuit: true }
    }
    if (specifier === '../backup.js') {
      return { url: stubUrl('backup.mjs'), shortCircuit: true }
    }
    if (specifier === './errors.js') {
      return { url: stubUrl('errors.mjs'), shortCircuit: true }
    }
    // 上限常量与失败分档用真模块：本层断言的就是那两个默认值
    if (specifier === './importLimit.js') {
      return { url: limitModule, shortCircuit: true }
    }
    if (specifier === './importFailure.js') {
      return { url: failureModule, shortCircuit: true }
    }
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

// ---------------------------------------------------------------- 浏览器环境替身

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
// 构建期注入的端点表（`endpointKeyFromUrl` 靠它把地址归到 chatBaseUrl（= consume.baseUrl 的 origin）/ feedbackUrl）
globalThis.__ENDPOINTS__ = { consume: { baseUrl: 'https://api.deepseek.com' } }
globalThis.__INTERNAL_BUILD__ = false
globalThis.__log = { entries: [] }
/** 跨用例留档：最后一条用例要对**全部**产出的日志做「meta 至少 2 个键」的体检 */
globalThis.__all = []
globalThis.__imported = []
globalThis.__importCount = 3

const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
}
const realSetTimeout = globalThis.setTimeout
/** 退避等待压缩到 1ms：只压 1s / 2s 这两个退避值，停滞窗口与心跳周期都不动 */
const BACKOFF_DELAYS = new Set([1000, 2000])
globalThis.setTimeout = (fn, ms, ...args) =>
  realSetTimeout(fn, BACKOFF_DELAYS.has(ms) ? 1 : ms, ...args)
globalThis.requestAnimationFrame = (cb) => globalThis.setTimeout(cb, 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.window = { addEventListener() {}, removeEventListener() {} }

/** 记录真实发出的每一次 fetch（断言「一个请求都没发」靠它） */
const requests = []
let fetchImpl = () => Promise.reject(new Error('fetch not stubbed'))
globalThis.fetch = (url, init) => {
  requests.push({ url: String(url), method: init?.method ?? 'GET' })
  return fetchImpl({ url: String(url), init })
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
const blob = (size) => new Blob([new Uint8Array(size)], { type: 'image/png' })
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const apiConfig = await import('../../src/services/api/apiConfig.ts')
const attachments = await import('../../src/services/attachments.ts')
const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const { setApiKey, setProviderKind } = apiConfig

/** 清日志：每个用例只看自己产出的那批 */
const resetLog = () => {
  globalThis.__all.push(...globalThis.__log.entries)
  globalThis.__log.entries.length = 0
  requests.length = 0
}
const entries = () => globalThis.__log.entries
const named = (message) => entries().filter((entry) => entry.message === message)
const one = (message) => {
  const found = named(message)
  assert.equal(found.length, 1, `「${message}」应恰好 1 条，实际 ${found.length} 条`)
  return found[0]
}
const keysOf = (entry) => Object.keys(entry.meta ?? {})

// ---------------------------------------------------------------- 附件上传：五种形态

test('[1] 多文件上传：每个文件都有开始 / 成功两条，排队等待单独可量', async () => {
  setProviderKind('deepseek')
  setApiKey('sk-test-313')
  resetLog()
  // 并发上限是 3（LIMITS.attachments.maxConcurrent）：第 4 个文件必然先排队
  let seq = 0
  const releases = []
  fetchImpl = () =>
    new Promise((resolve) => {
      const id = `file-${(seq += 1)}`
      releases.push(() => resolve(jsonResponse({ id, type: 'file' })))
    })
  const tasks = [0, 1, 2, 3].map((index) =>
    attachments.uploadAttachment('sk-test-313', `att-${index}`, blob(1024 * (index + 1)), `shot-${index}.png`, true)
  )
  await delay(40)
  assert.equal(named('upload-attachment').length, 3, '前 3 个已经开始，第 4 个应该还在队列里')
  while (releases.length > 0) {
    releases.shift()()
    await delay(20)
  }
  const serverIds = await Promise.all(tasks)
  assert.deepEqual(serverIds, ['file-1', 'file-2', 'file-3', 'file-4'])

  const starts = named('upload-attachment')
  const dones = named('file upload done')
  assert.equal(starts.length, 4, '每个文件一条开始')
  assert.equal(dones.length, 4, '每个文件一条成功（此前成功一条都没有）')

  for (const done of dones) {
    const meta = done.meta
    assert.equal(meta.flow, 'chat')
    assert.equal(meta.stage, 'chat.upload')
    assert.equal(meta.status, 'ok')
    assert.equal(meta.endpointKey, 'chatBaseUrl')
    assert.equal(meta.attempt, 1)
    assert.equal(meta.retryable, false, '成功了就不用再试')
    assert.equal(typeof meta.bytes, 'number')
    assert.equal(meta.totalBytes, meta.bytes, '单文件：bytes 与 totalBytes 一致')
    assert.equal(typeof meta.durationMs, 'number')
    assert.equal(typeof meta.speedBps, 'number')
  }
  // 排队时长：第 4 个文件在队列里等过，`queueMs` 必须真的 > 0（这就是要新键的理由）
  const queued = [...starts, ...dones].filter((entry) => (entry.meta.queueMs ?? 0) > 0)
  assert.ok(queued.length >= 1, '至少有一个文件在队列里等过，queueMs 应 > 0')
  // 上传耗时 = durationMs − queueMs：两个数都在，才能分开「排队卡住」与「传得慢」
  for (const entry of dones) {
    assert.ok(entry.meta.durationMs >= entry.meta.queueMs, 'durationMs 应包含排队时间')
    assert.ok(entry.meta.durationMs - entry.meta.queueMs <= entry.meta.durationMs)
  }
})

test('[2] 上传失败：一条 error，能看到耗时 / 能不能重试 / 原始错误', async () => {
  setProviderKind('deepseek')
  setApiKey('sk-test-313')
  resetLog()
  fetchImpl = () => Promise.resolve(jsonResponse({ error: { message: 'boom' } }, 500))
  await assert.rejects(() => attachments.uploadAttachment('sk-test-313', 'att-fail', blob(2048), 'a.png', true))
  const entry = one('file upload failed')
  assert.equal(entry.level, 'error')
  assert.equal(entry.meta.flow, 'chat')
  assert.equal(entry.meta.stage, 'chat.upload')
  assert.equal(entry.meta.status, 'error')
  assert.equal(entry.meta.retryable, true, '5xx 属于「再试一次有意义」')
  assert.equal(entry.meta.bytes, 2048)
  assert.equal(typeof entry.meta.durationMs, 'number')
  assert.equal(typeof entry.meta['error.msg'], 'string')
  assert.ok(entry.meta['error.msg'].length > 0, 'error.msg 不能为空')
  assert.equal(entry.meta.reason, undefined, '网络/HTTP 失败不带 reason，靠 error.msg 看原文')
})

test('[3] 用户取消：warn 级 aborted，与真实失败分开', async () => {
  setProviderKind('deepseek')
  setApiKey('sk-test-313')
  resetLog()
  fetchImpl = ({ init }) =>
    new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      )
    })
  const pending = attachments
    .uploadAttachment('sk-test-313', 'att-cancel', blob(4096), 'big.png', true)
    .catch((error) => error)
  await delay(10)
  attachments.cancelUpload('att-cancel')
  await pending
  const entry = one('file upload aborted')
  assert.equal(entry.level, 'warn', '用户取消不是故障')
  assert.equal(entry.meta.status, 'aborted')
  assert.equal(entry.meta.reason, 'aborted')
  assert.equal(entry.meta.retryable, true)
  assert.equal(named('file upload failed').length, 0, '取消不能再冒一条 error 级失败')
})

test('[4] 渠道没有 Files API：warn 级 rejected + 不可重试，且一个请求都不发', async () => {
  setProviderKind('ours')
  setApiKey('sk-test-313')
  resetLog()
  await assert.rejects(() =>
    attachments.uploadAttachment('sk-test-313', 'att-ours', blob(1024), 'a.png', true)
  )
  assert.equal(requests.length, 0, '不支持上传的渠道不该发出任何请求（#303）')
  const entry = one('file upload unavailable: channel has no files endpoint')
  assert.equal(entry.level, 'warn', '这是能力缺失，不是上传出错')
  assert.equal(entry.meta.status, 'rejected')
  assert.equal(entry.meta.reason, 'channel-unsupported')
  assert.equal(entry.meta.retryable, false, '重试没用，要让用户换渠道')
  assert.equal(entry.meta.stage, 'chat.upload')
  assert.equal(typeof entry.meta.durationMs, 'number')
})

test('[5] 额度不足：reason=quota-files，且标明重试没用', async () => {
  setProviderKind('deepseek')
  setApiKey('sk-test-313')
  resetLog()
  fetchImpl = () =>
    Promise.resolve(jsonResponse({ error: { message: 'User file count limit exceeded, limit 5000' } }, 400))
  await assert.rejects(() => attachments.uploadAttachment('sk-test-313', 'att-quota', blob(1024), 'a.png', true))
  const entry = one('file upload failed: quota-files')
  assert.equal(entry.meta.reason, 'quota-files')
  assert.equal(entry.meta.status, 'error')
  assert.equal(entry.meta.retryable, false, '额度满了，原样重试还是同一个结果')
})

// ---------------------------------------------------------------- URL 导入

/** 合法 ZIP 头 + 真实长度的填充字节（urlImport 会校验 PK\x03\x04） */
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
  const native = { native: true, calls: [], get }
  globalThis.__native = native
  return native
}
/** 正常链路：按 Range 立即返回 */
const rangeNative = (source) =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    return Promise.resolve(sliceResponse(options.url, source, from, to))
  })
/**
 * 第一块正常返回，第二块起永久挂起：真实发生过的「停滞」形态。
 * 不按字节阈值切是因为块大小会自适应放大（瞬时响应的链路下一块就能把整包拿完），
 * 按「第几次请求」切才稳定复现「推进了一块之后没数据」。
 */
const stallAfterFirstChunk = (source) => {
  let served = 0
  return useNative((options) => {
    if (served >= 1) {
      return new Promise(() => {})
    }
    served += 1
    const { from, to } = rangeOf(options)
    return Promise.resolve(sliceResponse(options.url, source, from, to))
  })
}

const correlationOf = (entry) => entry.meta?.correlationId

test('[6] URL 导入成功：开始 → 下载开始 → 下载完成 → import_done，四段同一条 correlationId', async () => {
  resetLog()
  globalThis.__importCount = 3
  rangeNative(zip)
  const count = await importHistoryFromUrl('https://obs.example.test/log-313-ok.zip', {
    heartbeatIntervalMs: 10_000,
    downloadStallMs: 5_000,
  })
  assert.equal(count, 3)

  // recordAction(kind, action)：kind 才是 import_start / import_done，message 是动作名
  const start = entries().filter((entry) => entry.kind === 'import_start')
  assert.equal(start.length, 1, `开始日志应恰好 1 条，实际 ${start.length} 条`)
  assert.equal(start[0].meta.source, 'url')
  assert.equal(start[0].meta.stage, 'import.download')

  const begin = one('import: download archive')
  const done = one('import: download complete')
  const finish = entries().filter((entry) => entry.kind === 'import_done')
  assert.equal(finish.length, 1, '成功必须有一条 import_done（此前链接导入没有成功点）')

  const ids = new Set([start[0], begin, done, finish[0]].map(correlationOf))
  assert.equal(ids.size, 1, `四段日志必须是同一条 correlationId，实际 ${[...ids].join(' / ')}`)
  assert.equal(typeof [...ids][0], 'string', 'correlationId 必须真的写进去')

  assert.equal(begin.meta.stage, 'import.download')
  assert.equal(done.meta.stage, 'import.download')
  assert.equal(done.meta.status, 'ok')
  assert.equal(done.meta.bytes, zip.length, '下载完成必须带上真实字节数')
  assert.equal(done.meta.totalBytes, zip.length)
  assert.equal(typeof done.meta.durationMs, 'number')
  assert.equal(typeof done.meta.speedBps, 'number')

  const commit = finish[0]
  assert.equal(commit.meta.stage, 'import.commit')
  assert.equal(commit.meta.status, 'ok')
  assert.equal(commit.meta.sessions, 3, '导入成功要能读出「导进了几个会话」')
  assert.equal(commit.meta.totalBytes, zip.length)
  assert.equal(typeof commit.meta.durationMs, 'number')
  assert.equal(commit.meta.retryable, false)
})

test('[7] 下载停滞：阶段 + 心跳 + 失败终态三件齐全，且停在哪个字节可见', async () => {
  resetLog()
  stallAfterFirstChunk(zip)
  const url = 'https://obs.example.test/log-313-stall.zip'
  const error = await importHistoryFromUrl(url, {
    heartbeatIntervalMs: 40,
    downloadStallMs: 150,
  }).catch((reason) => reason)
  assert.equal(error?.key, 'historyImportUrlStalled', '停滞必须给出停滞终态')

  const failure = one('import download failed: stalled')
  assert.equal(failure.level, 'error')
  assert.equal(failure.meta.stage, 'import.download')
  assert.equal(failure.meta.status, 'error')
  assert.equal(failure.meta.reason, 'stalled')
  // 此前这里写的是字符串 'yes'，而它不在清洗白名单里 —— 生产日志里这个键根本不存在
  assert.equal(failure.meta.retryable, true, '停滞是链路问题，续传/重试有意义')
  assert.equal(failure.meta.resume, 'yes', '已到手字节必须允许续传')
  assert.ok(failure.meta['download.bytes'] > 0, '失败时的已下载字节必须可见')
  assert.equal(failure.meta['url.path'], '/log-313-stall.zip', '只留 path，不带签名 query')
  assert.equal(typeof failure.meta.durationMs, 'number')
  assert.equal(typeof failure.meta['error.msg'], 'string')

  const stalled = one('import: download stalled')
  assert.equal(stalled.meta.stage, 'import.download')
  assert.equal(stalled.meta.status, 'timeout')
  assert.equal(stalled.meta.retryable, true)
  assert.equal(typeof stalled.meta['idle.ms'], 'number')
  assert.equal(typeof stalled.meta['request.from'], 'number', '停在哪一块的起点必须可见')

  const beats = named('import: download heartbeat')
  assert.ok(beats.length >= 1, `停滞期间应有心跳，实际 ${beats.length} 条`)
  for (const beat of beats) {
    assert.equal(beat.meta.stage, 'import.download')
    assert.equal(typeof beat.meta['download.bytes'], 'number')
    assert.equal(typeof beat.meta['stall.leftMs'], 'number')
  }
  // 一次导入的整条链路：所有带 correlationId 的日志必须是同一个 id
  const ids = new Set(entries().map(correlationOf).filter(Boolean))
  assert.equal(ids.size, 1, `一次导入只该有一个 correlationId，实际 ${[...ids].join(' / ')}`)
})

test('[8] 续传：第二次导入的第一条日志就写着 status=partial 与已下载字节', async () => {
  resetLog()
  rangeNative(zip)
  const url = 'https://obs.example.test/log-313-stall.zip' // 与上一条失败用例同一链接：续传点还在
  await importHistoryFromUrl(url, { heartbeatIntervalMs: 10_000, downloadStallMs: 5_000 })
  const begin = one('import: download archive')
  assert.equal(begin.meta.resume, 'yes', '同一链接重试应从断点继续')
  assert.equal(begin.meta.status, 'partial', '续传要能在 status 上一眼看出（不是从头开始）')
  assert.ok(begin.meta.bytes > 0, '起点的已下载字节必须 > 0')
  assert.equal(begin.meta.flow, 'import')
})

test('[9] 非法 URL：reason=invalid-url，与下载失败分得开', async () => {
  resetLog()
  globalThis.__native = { native: true, calls: [], get: () => Promise.resolve({ status: 200, data: null }) }
  const error = await importHistoryFromUrl('not a url').catch((reason) => reason)
  assert.equal(error?.key, 'historyImportUrlInvalid')
  const entry = one('import rejected: invalid url')
  assert.equal(entry.level, 'error')
  assert.equal(entry.meta.stage, 'import.check')
  assert.equal(entry.meta.status, 'rejected')
  assert.equal(entry.meta.reason, 'invalid-url')
  assert.equal(entry.meta.retryable, false, '地址本身不合法，重试同一个地址没用')
  assert.equal(globalThis.__native.calls.length, 0, '非法地址不该发出任何原生请求')
})

test('[10] 全量体检：本次两条链路产出的每一条日志，meta 都不为空且至少 2 个键', () => {
  const all = [...globalThis.__all, ...entries()]
  const offenders = all
    .filter((entry) => {
      const keys = keysOf(entry)
      return keys.length < 2
    })
    .map((entry) => `${entry.message}: ${JSON.stringify(entry.meta ?? null)}`)
  assert.deepEqual(offenders, [], `这些日志的 meta 不足 2 个键：${offenders.join(' | ')}`)
  assert.ok(all.length > 20, `本文件累计产出的日志条数应足够（实际 ${all.length}）`)
})

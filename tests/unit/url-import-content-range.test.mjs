// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 「总长度从哪儿来」的回归层（issue #24 的反向缺陷）。
//
// 缺陷形态（实测）：服务端按 206 分块、**不下发 Content-Range**，代码把这次响应里的
// Content-Length（= 这一块的长度，例如 4096）当成了整包总长，于是
//   1) 4KB 就被当成「已经下完」；
//   2) 200MB 上限拿这个假总长去比 —— 几百 MB 的包被放过，正常包也可能被误判。
// 期望：total 只从可信来源取（Content-Range 的 total，或首次整包 200 的 Content-Length）；
// 206 缺 Content-Range 时 total 保持未知，超限改按「已累计字节」判断。
//
// 这一层只替换 Capacitor 原生桥 / diagnostics / backup，urlImport 的真实分块逻辑
// （自适应块长、收敛判定、超限、错误分类）原样运行；state.total 用 onProgress 上报的
// totalBytes 观察（它就是 UI 与详情里显示的那个字段）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve, moduleUrl } from '../helpers/dom-env.mjs'

// 装配走公共入口（#366 第二批 / #408）：`.js→.ts` 解析 + 替身表收成一张表，
// 不再是本文件手抄的 ~30 行 `registerHooks` + 本地 `asTypescript`（urlImport 一族 4 个文件各有一份）。
// 本文件关心的是「Range 续传与内容长度」，所以只替换 I/O 边界（原生桥 / 诊断 / 备份 / errors），
// 上限常量与失败原因分档用**真模块**——本层断言的就是它们本身，不能替换成桩。
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

const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')

const URL_OK = 'https://obs.example.test/deepseek_data-2026-11-01.zip'
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

/** 合法 ZIP 头（urlImport 会校验 PK\x03\x04），其余字节填充，保证长度真实。 */
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

/**
 * 装一个按 Range 回字节的原生桥：真按 bytes=a-b 切块返回，
 * 响应头由用例决定 —— 这正是本组用例唯一变化的变量。
 * 请求记录由 stub 的 CapacitorHttp.get 统一 push 到 native.calls，用例不要重复记。
 */
const serveChunks = (source, headersFor) => {
  globalThis.__native = {
    native: true,
    calls: [],
    get: (options) => {
      const { from, to } = rangeOf(options)
      const end = Math.min(to, source.length - 1)
      const slice = from > end ? new Uint8Array(0) : source.slice(from, end + 1)
      return Promise.resolve({
        status: 206,
        url: URL_OK,
        headers: headersFor({ from, end, length: slice.byteLength }),
        data: slice.buffer,
      })
    },
  }
  return globalThis.__native
}

/** 跑一次导入：绝不 await 到超时，失败也把原因带回来。 */
const runImport = async (options = {}) => {
  const progress = []
  const error = await importHistoryFromUrl(URL_OK, {
    onProgress: (entry) => progress.push(entry),
    downloadStallMs: 30_000,
    heartbeatIntervalMs: 1_000,
    ...options,
  }).then(
    () => null,
    (reason) => reason
  )
  return { error, progress }
}

const downloads = (progress) => progress.filter((entry) => entry.phase === 'downloading')
const reportedTotals = (progress) => [...new Set(downloads(progress).map((entry) => entry.totalBytes))]

test('A：206 缺 Content-Range 时 total 必须未知，且不能只拿到 4KB 就判完成', async () => {
  resetEnv()
  const source = zipBytes(16 * 1024)
  // 每一块只有自己的 Content-Length，没有 Content-Range —— 实测缺陷形态
  const native = serveChunks(source, ({ length }) => ({ 'Content-Length': String(length) }))

  const { error, progress } = await runImport()

  assert.ok(downloads(progress).length >= 1, '至少要上报一条下载进度')
  assert.deepEqual(
    reportedTotals(progress),
    [undefined],
    `206 缺 Content-Range 时总长必须未知（不能把块长当总长），实际上报 ${JSON.stringify(reportedTotals(progress))}`
  )
  // 「未被判完成」：第一个块（4096B）之后必须继续请求，最终拿到整包
  assert.ok(native.calls.length >= 2, `第一块之后不能收工，实际请求 ${native.calls.length} 次`)
  assert.equal(error, null, `能下完就必须成功（实际 ${error?.key ?? ''} ${error?.message ?? ''}）`)
  assert.equal(globalThis.__imported.length, 1)
  assert.equal(
    globalThis.__imported[0].size,
    source.length,
    '不能只拿到第一块（4KB）就当下载完成'
  )
  assert.equal(records('import_error').length, 0, '成功路径不应记录失败')
})

test('B：206 带 Content-Range bytes a-b/21195845 → total 取 total 段', async () => {
  resetEnv()
  const total = 21195845
  const source = zipBytes(total)
  serveChunks(source, ({ from, end }) => ({
    'Content-Range': `bytes ${from}-${end}/${total}`,
    'Content-Length': String(end - from + 1),
  }))

  const { error, progress } = await runImport()

  assert.equal(error, null, `正常分块必须成功（实际 ${error?.key ?? ''}）`)
  assert.deepEqual(reportedTotals(progress), [total], `总长应取 Content-Range 里的 ${total}`)
  assert.equal(globalThis.__imported[0].size, total)
})

test('C：206 带 Content-Range bytes a-b/* → total 视为未知（不回落块长）', async () => {
  resetEnv()
  const source = zipBytes(16 * 1024)
  serveChunks(source, ({ from, end }) => ({
    'Content-Range': `bytes ${from}-${end}/*`,
    'Content-Length': String(end - from + 1),
  }))

  const { error, progress } = await runImport()

  assert.deepEqual(
    reportedTotals(progress),
    [undefined],
    `total 为 * 时必须保持未知，实际上报 ${JSON.stringify(reportedTotals(progress))}`
  )
  assert.equal(error, null, `分块收敛后必须成功（实际 ${error?.key ?? ''}）`)
  assert.equal(globalThis.__imported[0].size, source.length)
})

test('D：total 未知时按累计字节判超限（累计 > 200MB 仍然报超限）', async () => {
  resetEnv()
  // 不真造 200MB 文件：复用一块 4MB 缓冲区模拟「永远下不完的大包」，
  // 每块长度真实计入累计，只有长度参与判定。
  const block = new Uint8Array(4 * 1024 * 1024)
  block.set([0x50, 0x4b, 3, 4], 0)
  globalThis.__native = {
    native: true,
    calls: [],
    get: (options) => {
      const { from } = rangeOf(options)
      const first = from === 0
      return Promise.resolve({
        status: 206,
        url: URL_OK,
        headers: first ? { 'Content-Length': '4096' } : { 'Content-Length': String(block.byteLength) },
        data: first ? block.buffer.slice(0, 4096) : block.buffer,
      })
    },
  }

  const { error } = await runImport()

  assert.equal(error?.name, 'BackupError', `累计超限必须失败（实际 ${error?.message ?? 'success'}）`)
  assert.equal(error.key, 'historyImportUrlTooLarge')
  assert.equal(error.params.size, MAX_ARCHIVE_BYTES / 1024 / 1024)
  assert.ok(globalThis.__native.calls.length > 1, '必须真按块累计，而不是第一块就判超限')
})

test('E：整包 200 带 Content-Length → total 取 Content-Length', async () => {
  resetEnv()
  const source = zipBytes(16 * 1024)
  globalThis.__native = {
    native: true,
    calls: [],
    get: () =>
      Promise.resolve({
        status: 200,
        url: URL_OK,
        headers: { 'Content-Length': String(source.byteLength) },
        data: source.buffer,
      }),
  }

  const { error, progress } = await runImport()

  assert.equal(error, null, `整包 200 必须成功（实际 ${error?.key ?? ''}）`)
  assert.deepEqual(reportedTotals(progress), [source.length], '整包 200 的 Content-Length 就是总长')
  assert.equal(globalThis.__native.calls.length, 1, '200 说明服务端忽略了 Range，一次就够')
  assert.equal(globalThis.__imported[0].size, source.length)
})

test('F：下载失败的 import_error 事件带 url.path 与 error.msg（#19）', async () => {
  resetEnv()
  const calls = []
  globalThis.__native = {
    native: true,
    calls,
    get: () => Promise.resolve({ status: 500, url: URL_OK, headers: {}, data: null }),
  }

  const { error } = await runImport()

  assert.equal(error?.key, 'historyImportUrlHttp')
  const failures = records('import_error')
  assert.equal(failures.length, 1, `失败必须落一条 import_error，实际 ${failures.length} 条`)
  const fields = failures[0].fields
  assert.equal(fields.stage, 'import.download')
  // 只留 path，不带 host / query（签名参数都在 query 里）
  assert.equal(fields['url.path'], '/deepseek_data-2026-11-01.zip')
  assert.equal(typeof fields['error.msg'], 'string')
  assert.ok(fields['error.msg'].length > 0, 'error.msg 不能为空')
})

// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 「总长度从哪儿来」的回归层（issue #24 的反向缺陷），#34 之后口径变了但承诺没变。
//
// 缺陷原形态（实测）：服务端按 206 分块、**不下发 Content-Range**，JS 把这次响应里的
// Content-Length（= 这一块的长度，例如 4096）当成整包总长，于是
//   1) 4KB 就被当成「已经下完」；
//   2) 200MB 上限拿这个假总长去比 —— 几百 MB 的包被放过，正常包也可能被误判。
//
// #34 把「网络读 + 写盘」搬进原生插件（HistoryArchivePlugin）之后，总长度的**来源**变成了
// 响应头解析（Java 侧：206 的 `Content-Range` 尾部、200 的 `Content-Length`），JS 不再自己
// 解析任何响应头。所以这一层守的不再是「解析对不对」，而是 JS 侧的等价承诺：
//   A. 原生报不上 total 时，进度里**不编数字**、也不拿已下字节当总量；
//   B. 原生报了 total 时，进度与详情显示的就是那个数；
//   C. total 未知时超限按**累计字节**判（不是拿某个瞬时长度去比）；
//   D. 建连阶段就失败时立刻分类收口，且诊断里有 url.path / error.msg（#19）。
//
// 只替换原生下载插件 / diagnostics / backup 三个边界，urlImport 的真实代码原样运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { simulate, TEMP_PATH } from '../fixtures/url-import-stubs/download-simulator.mjs'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href
const failureModule = new URL('../../src/services/chat/history/importFailure.ts', import.meta.url).href

/** 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`；node 不会自己改后缀。 */
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
    if (specifier === './importLimit.js') {
      return { url: limitModule, shortCircuit: true }
    }
    if (specifier === './importFailure.js') {
      return { url: failureModule, shortCircuit: true }
    }
    if (specifier === './nativeArchive.js') {
      return { url: stub('nativeArchive.mjs'), shortCircuit: true }
    }
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')

const URL_UNKNOWN_TOTAL = 'https://obs.example.test/unknown-total.zip'
const URL_KNOWN_TOTAL = 'https://obs.example.test/known-total.zip'
const URL_OVER_LIMIT = 'https://obs.example.test/over-limit.zip'
const URL_REFUSED = 'https://obs.example.test/refused.zip'
const URL_DECLARED_TOO_LARGE = 'https://obs.example.test/declared-too-large.zip'

const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

const fakeTime = (t, start = 1_700_000_000_000) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start })
  return { tick: (ms) => t.mock.timers.tick(ms) }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__download = undefined
}

const useNative = (spec) => {
  const download = simulate(spec)
  globalThis.__download = download
  globalThis.__native = { native: true }
  return download
}

const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

const startImport = (url, options = {}) => {
  const trace = []
  const progress = []
  const done = importHistoryFromUrl(url, {
    onTrace: (entry) => trace.push(entry),
    onProgress: (entry) => progress.push(entry),
    ...options,
  }).then(
    () => null,
    (error) => error
  )
  return { trace, progress, done }
}

const drive = async (clock, run, { maxMs = 120_000, step = 500 } = {}) => {
  let outcome
  run.done.then((error) => {
    outcome = { error }
  })
  let spent = 0
  while (outcome === undefined && spent < maxMs) {
    clock.tick(step)
    await flush()
    spent += step
  }
  assert.notEqual(outcome, undefined, `导入在 ${maxMs}ms 假时间内没有终态`)
  return { error: outcome.error, spent }
}

test('A：原生报不上 total 时进度里不编数字，也不拿「已下字节」当总量', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(64 * 1024)
  // total 未知、但链路正常结束：模拟器用 completeAtBytes 表达「原生侧 state=done」
  const native = useNative({
    source,
    total: null,
    completeAtBytes: source.length,
    // 慢一点，好让「未知总量」这件事在多条进度采样上都被看到（64KB / 32KB/s ≈ 2s）
    bytesPerSecond: 32 * 1024,
  })
  const run = startImport(URL_UNKNOWN_TOTAL, { downloadStallMs: 10_000, heartbeatIntervalMs: 1_000 })

  const { error } = await drive(clock, run)

  assert.equal(error, null, `总量未知的合法包必须能导完（实际 ${error?.key ?? ''}）`)
  assert.ok(run.progress.length >= 2, '未知总量时也要有进度')
  for (const entry of run.progress) {
    if (entry.phase !== 'downloading') {
      continue
    }
    assert.equal(entry.totalBytes, undefined, '原生没报总量时不允许编一个数出来')
    assert.equal(typeof entry.downloadedBytes, 'number')
  }
  // 详情里的下载条目也不带 totalBytes
  const downloads = run.trace.filter((entry) => entry.kind === 'download')
  assert.ok(downloads.length >= 1)
  assert.ok(downloads.every((entry) => entry.totalBytes === undefined))
  // 收口靠的是原生 state=done，而不是「字节数到了某个数」
  assert.equal(globalThis.__imported[0].size, source.length)
  assert.ok(native.polls >= 2)
})

test('B：原生上报 total 时，进度与详情显示的就是那个数', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(256 * 1024)
  useNative({ source, total: source.length, bytesPerSecond: 512 * 1024 })
  const run = startImport(URL_KNOWN_TOTAL, { downloadStallMs: 10_000, heartbeatIntervalMs: 1_000 })

  const { error } = await drive(clock, run)

  assert.equal(error, null)
  const downloading = run.progress.filter((entry) => entry.phase === 'downloading')
  assert.ok(downloading.length >= 1)
  assert.ok(
    downloading.every((entry) => entry.totalBytes === source.length),
    '上报了总量就必须原样透出（UI 的百分比靠它）'
  )
  const downloads = run.trace.filter((entry) => entry.kind === 'download')
  assert.ok(downloads.every((entry) => entry.totalBytes === source.length))
})

test('C：total 未知时超限按累计字节判，不是拿瞬时长度去比', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(64 * 1024)
  const MAX = 8 * 1024
  const native = useNative({ source, total: null, bytesPerSecond: 256 * 1024 })
  const run = startImport(URL_OVER_LIMIT, {
    downloadStallMs: 10_000,
    heartbeatIntervalMs: 1_000,
    maxBytes: MAX,
  })

  const { error } = await drive(clock, run)

  assert.equal(error?.key, 'historyImportUrlTooLarge', '累计字节超上限必须报「文件过大」')
  await run.done
  assert.ok(run.done)
  const failure = records('import_error').find((entry) => entry.fields.stage === 'size')
  assert.ok(failure, '超限必须留一条 stage=size 的诊断')
  assert.equal(failure.fields['limit.bytes'], MAX)
  assert.ok(failure.fields['download.bytes'] > MAX, '记录里要写清实测超出多少')
  assert.match(String(zh.historyImportUrlTooLarge), /文件过大/)
  // 临时文件不留：超限也是失败终态
  assert.equal(native.discarded, 1)
  assert.equal(globalThis.__imported.length, 0)
})

test('D：建连阶段就失败（Connection refused）→ 立刻分类收口，诊断带 url.path 与 error.msg', async () => {
  resetEnv()
  const native = useNative({
    startState: 'failed',
    startError: 'java.net.ConnectException: Connection refused (Connection refused)',
  })
  // 真实时钟：这条路径不该有任何等待
  const run = startImport(URL_REFUSED, { downloadStallMs: 30_000, heartbeatIntervalMs: 100 })
  const error = await run.done

  assert.equal(error?.key, 'historyImportUrlRefused', '连接被拒要单独一档，不能混成「网络错误」')
  assert.equal(native.polls, 0, '建连就失败时不该再去轮询进度')
  const failure = records('import_error')[0]
  assert.equal(failure.fields.stage, 'download')
  assert.equal(failure.fields.reason, 'refused')
  // #19：事后必须能把一条失败对上具体文件与原始错误
  assert.equal(typeof failure.fields['url.path'], 'string')
  assert.match(String(failure.fields['url.path']), /refused\.zip/)
  assert.equal(typeof failure.fields['error.msg'], 'string')
  // 临时文件根本没建出来，但清理路径照走一遍（幂等）
  assert.equal(native.served, 0)
  assert.equal(native.discarded, 1)
  assert.deepEqual(native.removed, [])
})

test('E：响应头声明的总量超上限 → 一个字节都不写就拒（关闭条件 3 的 JS 侧）', async () => {
  resetEnv()
  const declared = 250 * 1024 * 1024
  const native = useNative({ startState: 'tooLarge', declared })
  const run = startImport(URL_DECLARED_TOO_LARGE, { downloadStallMs: 30_000 })
  const error = await run.done

  assert.equal(error?.key, 'historyImportUrlTooLarge')
  assert.equal(error.params.actual !== undefined, true, '文案里必须同时给「上限」和「实测/声明体积」')
  assert.equal(native.served, 0, '超限拒绝发生在写盘之前：模拟器一个字节都不该写')
  assert.equal(native.polls, 0, '也不该开始轮询')
  const failure = records('import_error')[0]
  assert.equal(failure.fields.stage, 'size')
  assert.equal(failure.fields['download.bytes'], declared, '记录里要写清声明体积')
  assert.equal(failure.fields['limit.bytes'], 200 * 1024 * 1024, '上限就是 importLimit 里那一个 200MB')
})

test('F：成功导入后临时文件被删掉，且删的就是那个下载落点', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  useNative({ source: zipBytes(16 * 1024), bytesPerSecond: 512 * 1024 })
  const run = startImport('https://obs.example.test/cleanup.zip', {
    downloadStallMs: 10_000,
    heartbeatIntervalMs: 1_000,
  })
  const { error } = await drive(clock, run)
  assert.equal(error, null)
  assert.deepEqual(globalThis.__download.removed, [TEMP_PATH])
})

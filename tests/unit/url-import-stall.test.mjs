// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 「从链接导入」的**下载阶段**：#34 改成原生流式落盘之后的停滞判定 / 总上限 / 心跳 / 清理。
//
// 为什么单独一层：集成用例要真跑浏览器 + 真产物，而本组断言的场景是「原生侧一直不吐字节」、
// 「慢到总时长超过旧的 120s 总预算」——这些用真实时钟要么跑几分钟要么跑不出来，
// 所以用 node:test 的假 timer（setTimeout/setInterval/Date 一起假），**不 sleep**。
//
// 这一层替换的是「原生下载插件」这一个边界（`nativeArchive.mjs` → 用例提供的模拟器，
// 见 `tests/fixtures/url-import-stubs/download-simulator.mjs`），以及 diagnostics / backup。
// urlImport 的真实代码原样运行：轮询、停滞看门狗、总上限、心跳、临时文件清理、错误分类。
//
// 判定口径（#38 的结论，流式化之后照旧）：**只看「字节是否在增长」+ 防御性硬上限**，
// 没有任何形式的「120s 总墙钟」——那条在 #38 里被证明会误杀合法大包。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { simulate, TEMP_PATH } from '../fixtures/url-import-stubs/download-simulator.mjs'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href
// 失败原因分档（issue #111）同样用真模块：它不碰浏览器/网络，没有替换的必要
const failureModule = new URL('../../src/services/chat/history/importFailure.ts', import.meta.url).href

/**
 * 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`；node 不会自己改后缀。
 * 与 import-size-limit.test.mjs 同一套做法：本层要跑真实的 urlImport 链路，
 * 而 #275 之后它多了一个依赖 src/services/limits.ts（阈值表）。
 */
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
    // 上限常量（issue #34）用**真模块**，本层断言的就是那个默认值，不能替换成桩
    if (specifier === './importLimit.js') {
      return { url: limitModule, shortCircuit: true }
    }
    if (specifier === './importFailure.js') {
      return { url: failureModule, shortCircuit: true }
    }
    // 原生下载插件（#34）：换成用例驱动的模拟器，见文件头
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

const { importHistoryFromUrl, UrlImportCancelled } =
  await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** 每个用例用自己的链接：用例之间不共享任何状态。 */
const URL_PENDING = 'https://obs.example.test/pending.zip'
const URL_SLOW = 'https://obs.example.test/slow-164mb.zip'
const URL_STALL = 'https://obs.example.test/stall.zip'
const URL_DEADLINE = 'https://obs.example.test/deadline.zip'
const URL_BROKEN = 'https://obs.example.test/broken.zip'
const URL_TIMEOUT = 'https://obs.example.test/timeout.zip'
const URL_CANCEL = 'https://obs.example.test/cancel.zip'
const URL_FAST = 'https://obs.example.test/fast.zip'
const URL_NOTZIP = 'https://obs.example.test/not-zip.zip'
const URL_EXPIRED = 'https://obs.example.test/expired.zip'

/** 合法 ZIP 头（urlImport 会校验 PK\x03\x04），其余字节填充，保证长度真实。 */
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

/** 与 urlImport 内的 formatSize 同档，用来断言文案里的数字。 */
const formatSize = (bytes) =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
      : `${(bytes / 1024 / 1024).toFixed(1)}MB`

/** 把 BackupError（key + params）渲染成用户真正看到的文案。 */
const render = (messages, error) =>
  String(messages[error.key]).replace(/\{(\w+)\}/g, (raw, name) =>
    error.params?.[name] === undefined ? raw : String(error.params[name])
  )

/** 假时钟：setTimeout / setInterval / Date 一起假，tick 之后让出微任务再继续。 */
const fakeTime = (t, start = 1_700_000_000_000) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start })
  return {
    now: () => Date.now(),
    tick: (ms) => t.mock.timers.tick(ms),
  }
}

/** 让出微任务 + 一个真 macrotask，好让 tick 触发的 Promise 链继续跑。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

const resetEnv = ({ importCount = 1 } = {}) => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = importCount
  globalThis.__download = undefined
}

/** 装好模拟器并把原生能力打开（`canImportFromUrl` 依赖 `native: true`）。 */
const useNative = (spec) => {
  const download = simulate(spec)
  globalThis.__download = download
  globalThis.__native = { native: true }
  return download
}

const events = (message) => globalThis.__log.events.filter((entry) => entry.message === message)
const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

/** 起一次导入（不 await：时间由用例自己推进）。 */
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

/**
 * 推进假时钟直到导入结束（成功或失败）。
 * step 越小越贴近真实事件顺序；返回判定为终态时已经用掉的假时间。
 */
const drive = async (clock, run, { maxMs = 400_000, step = 500 } = {}) => {
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
  assert.notEqual(outcome, undefined, `导入在 ${maxMs}ms 假时间内没有终态（还在无限转圈）`)
  return { error: outcome.error, spent }
}

test('慢速但持续推进：总时长超过旧 120s 预算也不判死，最终成功', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  // 3MB / 20KB/s = 约 150s 假时间：比 #38 被误杀的 120s 总预算更长，但字节一直在增长
  const source = zipBytes(3 * 1024 * 1024)
  const native = useNative({ source, bytesPerSecond: 20 * 1024 })
  const run = startImport(URL_SLOW, { heartbeatIntervalMs: 600, downloadStallMs: 40_000 })

  const { error, spent } = await drive(clock, run)

  assert.equal(error, null, `慢但推进的合法包不得判死（实际 ${error?.key ?? ''}）`)
  assert.ok(spent > 120_000, `总时长必须真的超过旧 120s 预算（实际 ${spent}ms）`)
  console.log(`  慢速推进：假时长 ${(spent / 1000).toFixed(1)}s、字节 ${source.length}、轮询 ${native.polls} 次`)
  assert.equal(records('import_error').length, 0, '成功路径不允许留失败记录')
  assert.equal(globalThis.__imported.length, 1)
  assert.equal(globalThis.__imported[0].size, source.length, '交给解析链路的包体长度必须与原始字节数一致')
  // 成功路径的清理：原生状态释放一次、临时文件在导入结束后删掉
  assert.equal(native.released, 1, '成功路径必须释放原生下载状态')
  assert.equal(native.discarded, 0, '成功路径不能走 discard（那会把临时文件删掉，解析就没得读了）')
  assert.deepEqual(native.removed, [TEMP_PATH], '导入结束后必须删掉临时文件')

  // 心跳必须能看出「在推进」：progress.bytes > 0 / progress.state=advancing
  const beats = events('import: download heartbeat')
  assert.ok(beats.length >= 2, `心跳至少 2 条，实际 ${beats.length}`)
  assert.ok(
    beats.some((beat) => beat.fields['progress.state'] === 'advancing'),
    '慢速推进时心跳必须出现 advancing'
  )
  const maxIdle = Math.max(...beats.map((beat) => beat.fields['idle.ms']))
  assert.ok(maxIdle < 40_000, `推进中的 idle 不允许接近停滞窗口（实际 ${maxIdle}ms）`)
  assert.ok(beats.every((beat) => typeof beat.fields['stall.leftMs'] === 'number'))
})

test('真正停滞（下到 1MB 后再无数据）：窗口到点判 stalled，文案含已下载/总数', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(2 * 1024 * 1024)
  const LIMIT = 1024 * 1024
  // 20KB/s 先推到 1MB（约 51s，期间心跳必须是 advancing），之后彻底没有新数据
  const native = useNative({ source, bytesPerSecond: 20 * 1024, stallAfter: LIMIT })
  const STALL_MS = 8_000
  const run = startImport(URL_STALL, { downloadStallMs: STALL_MS, heartbeatIntervalMs: 1_000 })

  const { error, spent } = await drive(clock, run, { maxMs: 200_000 })

  assert.equal(error?.name, 'BackupError')
  assert.equal(error.key, 'historyImportUrlStalled', '停滞必须给出「停滞」终态，而不是别的分类')
  // 判定时机 = 最后一次进度 + 窗口：不能提前，也不能拖太久
  assert.ok(spent >= STALL_MS, `必须撑满停滞窗口才判死（实际 ${spent}ms）`)

  const failures = records('import_error')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].fields.stage, 'download')
  assert.equal(failures[0].fields.reason, 'stalled')
  assert.equal(failures[0].fields.retryable, 'yes')
  assert.equal(failures[0].fields['stall.ms'], STALL_MS)
  assert.ok(failures[0].fields['idle.ms'] >= STALL_MS)
  const downloaded = failures[0].fields['download.bytes']
  assert.ok(downloaded >= LIMIT, `失败时已下载字节应 ≥ ${LIMIT}（实际 ${downloaded}）`)
  assert.equal(failures[0].fields['download.total'], source.length)
  console.log(
    `  真停滞：idle ${failures[0].fields['idle.ms']}ms（窗口 ${STALL_MS}ms）、` +
      `已下载 ${downloaded}/${source.length}、假总时长 ${(spent / 1000).toFixed(1)}s`
  )

  // 文案：停滞 + 卡住多久 + 已下载/共 + 可重试
  const text = render(zh, error)
  assert.match(text, /下载停滞/)
  assert.match(text, /8 秒/)
  assert.match(text, new RegExp(formatSize(downloaded)))
  assert.match(text, new RegExp(`共 ${formatSize(source.length)}`))
  assert.match(text, /可重试/)
  assert.match(render(en, error), /stalled/i)

  // idle 就是「距离最后一次拿到字节」的时长：必须落在窗口上沿（说明是「无进度」判死）
  assert.ok(
    failures[0].fields['idle.ms'] < STALL_MS + 2_000,
    `判死应贴住停滞窗口上沿（实际 idle ${failures[0].fields['idle.ms']}ms）`
  )

  // 心跳必须能分别看出「在推进」与「停滞」
  const beats = events('import: download heartbeat')
  const advancing = beats.filter((beat) => beat.fields['progress.state'] === 'advancing')
  const stalled = beats.filter((beat) => beat.fields['progress.state'] === 'stalled')
  assert.ok(beats.length >= 4, `心跳至少 4 条，实际 ${beats.length}`)
  assert.ok(advancing.length >= 1, '推进阶段心跳必须显示 advancing（progress.bytes > 0）')
  assert.ok(advancing.every((beat) => beat.fields['progress.bytes'] > 0))
  assert.ok(stalled.length >= 2, `停滞阶段心跳至少 2 条，实际 ${stalled.length}`)
  assert.ok(stalled.every((beat) => beat.fields['progress.bytes'] === 0))
  assert.ok(stalled[stalled.length - 1].fields['idle.ms'] > stalled[0].fields['idle.ms'])
  assert.ok(stalled[stalled.length - 1].fields['stall.leftMs'] < STALL_MS)
  assert.ok(run.trace.some((entry) => entry.kind === 'heartbeat' && entry.idleMs > 0))
  assert.equal(run.trace.find((entry) => entry.kind === 'error').message, 'stalled')

  // 失败路径的清理（#34 目标 3）：原生侧当场删掉临时文件，且不需要再走 remove
  assert.equal(native.discarded, 1, '失败后必须当场删掉临时文件')
  assert.deepEqual(native.removed, [], '失败路径不该把文件留给后面的 remove（那时已经没了）')
  assert.equal(globalThis.__imported.length, 0, '失败不能进入导入阶段')

  // 心跳 interval 必须停掉：继续推进时钟也不该再有心跳
  const before = beats.length
  clock.tick(30_000)
  await flush()
  assert.equal(events('import: download heartbeat').length, before, '失败后不能残留心跳 interval')
})

test('防御性总上限：字节一直在增长但超过上限 → 判「下载超时」，不是 stalled', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(2 * 1024 * 1024)
  const native = useNative({ source, bytesPerSecond: 20 * 1024 })
  const MAX_TOTAL_MS = 6_000
  const run = startImport(URL_DEADLINE, {
    downloadStallMs: 60_000,
    downloadMaxTotalMs: MAX_TOTAL_MS,
    heartbeatIntervalMs: 1_000,
  })

  const { error, spent } = await drive(clock, run, { maxMs: 60_000 })

  assert.equal(error?.key, 'historyImportUrlDeadline')
  assert.ok(spent >= MAX_TOTAL_MS && spent < MAX_TOTAL_MS + 4_000, `应在总上限附近收口（实际 ${spent}ms）`)
  const failure = records('import_error')[0]
  assert.equal(failure.fields.reason, 'deadline')
  assert.equal(failure.fields['max.total.ms'], MAX_TOTAL_MS)
  assert.ok(failure.fields['download.bytes'] > 0, '总上限收口时字节通常已经到手一部分')
  assert.match(render(zh, error), /下载超时/)
  assert.equal(native.discarded, 1, '预算耗尽也要删掉临时文件')
})

test('原生侧一直不吐字节（首字节就没有）：窗口到点必须有失败终态 + 心跳 + 无总数文案', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const native = useNative({ bytesPerSecond: 0, total: null })
  const STALL_MS = 4_000
  const run = startImport(URL_PENDING, { downloadStallMs: STALL_MS, heartbeatIntervalMs: 800 })

  const { error, spent } = await drive(clock, run, { maxMs: 40_000 })

  assert.ok(error, '原生侧永不推进时也必须失败，不能一直转圈')
  assert.equal(error.key, 'historyImportUrlStalledUnknownTotal', '拿不到总数时要走「无总数」文案')
  assert.ok(spent >= STALL_MS && spent < STALL_MS + 4_000, `应在停滞窗口到点收口（实际 ${spent}ms）`)
  assert.match(render(zh, error), /下载停滞/)
  assert.match(render(zh, error), /4 秒/)
  assert.ok(native.polls >= 2, `窗口期内必须持续轮询（实际 ${native.polls} 次）`)

  const beats = events('import: download heartbeat')
  assert.ok(beats.length >= 2, `心跳至少 2 条，实际 ${beats.length}`)
  for (const beat of beats) {
    assert.equal(beat.kind, 'import_stage')
    assert.equal(beat.fields.stage, 'download')
    assert.equal(typeof beat.fields['download.bytes'], 'number')
    assert.equal(typeof beat.fields['progress.bytes'], 'number')
    assert.equal(typeof beat.fields['idle.ms'], 'number')
    assert.equal(typeof beat.fields['stall.leftMs'], 'number')
  }
  assert.equal(records('import_error')[0].fields['download.bytes'], 0)
  assert.ok(run.trace.some((entry) => entry.kind === 'heartbeat'))
})

test('断流（unexpected end of stream）：仍是「连接被中断」，不被判成停滞', async (t) => {
  resetEnv()
  const source = zipBytes(32 * 1024)
  // 先写一点字节，然后原生侧报断流：按 interrupted 分类，不是 stalled
  const native = useNative({
    source,
    bytesPerSecond: 512 * 1024,
    failAt: { afterMs: 20, error: 'java.io.IOException: unexpected end of stream on com.android.okhttp.Address@1be17ec1' },
  })
  // 真实时钟即可：这条路径是立刻失败的，不需要假时间
  const run = startImport(URL_BROKEN, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
  const error = await run.done
  assert.equal(error?.name, 'BackupError')
  assert.equal(error.key, 'historyImportUrlInterrupted')
  assert.equal(typeof error.params.percent, 'number')
  assert.equal(records('import_error')[0].fields.reason, 'interrupted')
  assert.equal(run.trace.find((entry) => entry.kind === 'error').message, 'interrupted')
  assert.equal(native.discarded, 1)
})

test('原生读超时（Read timed out）：仍是超时分类，且期间有心跳', async (t) => {
  resetEnv()
  const timers = trackIntervals()
  useNative({
    source: zipBytes(8 * 1024),
    bytesPerSecond: 0,
    total: null,
    failAt: { afterMs: 150, error: 'java.net.SocketTimeoutException: Read timed out' },
  })
  try {
    const run = startImport(URL_TIMEOUT, { downloadStallMs: 5_000, heartbeatIntervalMs: 50 })
    const error = await run.done
    assert.equal(error?.name, 'BackupError')
    assert.equal(error.key, 'historyImportUrlTimeout', '停滞窗口期内原生自己报错时，按既有超时分类')
    assert.ok(events('import: download heartbeat').length >= 1, '等待期间必须留有心跳')
    assert.equal(records('import_error')[0].fields.reason, 'timeout')
    assert.equal(timers.live(), 0, '失败后不能残留心跳 interval')
  } finally {
    timers.restore()
  }
})

test('取消：立刻给出取消终态，不误报下载失败、不留定时器、临时文件当场删掉', async () => {
  resetEnv()
  const timers = trackIntervals()
  const native = useNative({ bytesPerSecond: 0, total: null })
  try {
    // 停滞窗口给得很宽：能不能及时收口全靠取消，而不是靠看门狗
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120)
    const run = startImport(URL_CANCEL, {
      signal: controller.signal,
      downloadStallMs: 60_000,
      heartbeatIntervalMs: 50,
    })
    const error = await run.done
    assert.ok(error instanceof UrlImportCancelled, `取消应抛 UrlImportCancelled，实际 ${error?.name}`)
    assert.equal(records('import_error').length, 0, '取消不是失败，不能记录 import_error')
    assert.equal(records('warning').length, 1)
    assert.equal(run.trace[run.trace.length - 1].kind, 'cancel')
    assert.equal(timers.live(), 0, '取消后不能残留心跳 interval')
    // 目标 3：取消也要清干净（原生侧 discard 就是「同步删文件」）
    assert.equal(native.discarded, 1, '取消后必须当场删掉临时文件')
    assert.equal(globalThis.__imported.length, 0)
  } finally {
    timers.restore()
  }
})

test('慢速但能下完：成功终态、不留定时器、临时文件用后即删', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(12 * 1024)
  const native = useNative({ source, bytesPerSecond: 256 * 1024 })
  const run = startImport(URL_FAST, { downloadStallMs: 5_000, heartbeatIntervalMs: 50 })
  const { error } = await drive(clock, run, { maxMs: 30_000 })
  assert.equal(error, null, `慢速但能下完时必须成功（${error?.message ?? ''}）`)
  assert.equal(records('import_error').length, 0, '成功路径不应记录失败')
  assert.equal(globalThis.__imported.length, 1)
  assert.equal(globalThis.__imported[0].size, source.length)
  assert.equal(run.trace[run.trace.length - 1].kind, 'done')
  assert.deepEqual(native.removed, [TEMP_PATH])
  assert.ok(native.reads >= 1, 'ZIP 头必须按区间读出来校验，而不是把整包读回内存')
})

test('坏包（非 ZIP）：不进入导入阶段，文案是「不是有效的 ZIP」，临时文件同样删掉', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const bad = new Uint8Array(8 * 1024)
  bad.fill(0x41) // "AAAA…"：不是 PK\x03\x04
  const native = useNative({ source: bad, bytesPerSecond: 256 * 1024 })
  const run = startImport(URL_NOTZIP, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 })
  const { error } = await drive(clock, run, { maxMs: 30_000 })
  assert.equal(error?.key, 'historyImportUrlNotZip')
  assert.equal(globalThis.__imported.length, 0)
  assert.equal(native.discarded, 1, '坏包也要把临时文件删掉（否则 200MB 的垃圾留在缓存里）')
  assert.equal(records('import_error')[0].fields.reason, 'not-zip')
})

test('403 + OBS 错误体 RequestTimeTooSkewed：走「链接已过期」，不落到「网络错误」', async () => {
  resetEnv()
  useNative({
    startState: 'http',
    status: 403,
    body: '<Error><Code>RequestTimeTooSkewed</Code><Message>request has expired</Message></Error>',
  })
  const run = startImport(URL_EXPIRED, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
  const error = await run.done
  assert.equal(error?.key, 'historyImportUrlExpired')
  assert.equal(records('import_error')[0].fields['http.status'], 403)
  assert.equal(records('import_error')[0].fields.reason, 'expired')
  assert.match(render(zh, error), /重新导出/)
})

/** 统计心跳 interval 的存活数量：成功/失败/取消之后必须是 0（不能泄漏）。 */
function trackIntervals() {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const live = new Set()
  globalThis.setInterval = (callback, ms) => {
    const id = realSetInterval(callback, ms)
    live.add(id)
    return id
  }
  globalThis.clearInterval = (id) => {
    live.delete(id)
    return realClearInterval(id)
  }
  return {
    live: () => live.size,
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

test('终态文案可读：停滞 / 总上限 / 心跳 在 zh/en 里都有，且占位符齐备', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
  // 停滞：卡住多久 + 已下载/共 + 可重试
  assert.match(zh.historyImportUrlStalled, /\{seconds\}/)
  assert.match(zh.historyImportUrlStalled, /\{done\}/)
  assert.match(zh.historyImportUrlStalled, /\{total\}/)
  assert.match(zh.historyImportUrlStalled, /下载停滞/)
  assert.match(zh.historyImportUrlStalled, /可重试/)
  assert.match(zh.historyImportUrlStalledUnknownTotal, /\{seconds\}/)
  assert.match(zh.historyImportUrlStalledUnknownTotal, /下载停滞/)
  // 总上限：文案是「下载超时」，与停滞分档
  assert.match(zh.historyImportUrlDeadline, /下载超时/)
  assert.match(zh.historyImportUrlDeadline, /\{minutes\}/)
  assert.match(zh.historyImportUrlDeadlineUnknownTotal, /下载超时/)
  // 详情文案
  assert.match(zh.importTraceReasonStalled, /\{seconds\}/)
  assert.match(zh.importTraceReasonDeadline, /\{minutes\}/)
  assert.match(zh.importTraceHeartbeat, /\{idle\}/)
  assert.match(zh.importTraceHeartbeatUnknown, /\{idle\}/)
  // 英文同步
  assert.match(en.historyImportUrlStalled, /no new data for \{seconds\}s/)
  assert.match(en.historyImportUrlDeadline, /timed out/)
  assert.match(en.importTraceReasonStalled, /\{seconds\}/)
})

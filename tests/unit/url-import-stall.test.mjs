// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 「从链接导入」的**停滞判定**与**续传**（改动见 src/services/chat/history/urlImport.ts，#38）。
//
// 为什么单独一层：集成用例要真跑浏览器 + 真产物，而本组断言的场景是「原生 Promise 永久 pending」、
// 「慢到总时长超过 120s」、「服务端忽略 Range」——这些用真实时钟要么跑几分钟要么跑不出来，
// 所以用 node:test 的假 timer（setTimeout/setInterval/Date 一起假），**不 sleep**。
// 这里只替换 Capacitor 原生桥 / diagnostics / backup，urlImport 的真实代码
// （分块、自适应块大小、块级重试、停滞看门狗、心跳、续传、分类、清理定时器）原样运行。
//
// 跑法（Issue #459）：本文件断言的是「停顿到窗口上限就判死」，这条判据一旦失效
// （`stallVerdict()` 恒 `null`），**旧写法既不会 fail、也不会被 `--test-timeout` 收口** ——
// 它卡在假时钟的同步自旋里，整轮 node --test 直接挂住。现在用例自带两个 deadline
// （真实 5s + 假时间预算，见 drive），所以下面的 30s 只是兜底：
//   node --test --test-timeout=30000 tests/unit/url-import-stall.test.mjs tests/unit/import-budget-vs-stall.test.mjs
// 推荐直接走分层入口（自带超时）：`npm test`（= node tests/run-layer.mjs unit）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve, moduleUrl } from '../helpers/dom-env.mjs'
import { settleInRealTime, zipBytes } from '../helpers/url-import-fixtures.mjs'

// 装配走公共入口（#366 第二批 / #408）：`.js→.ts` 解析 + 替身表收成一张表，
// 不再是本文件手抄的 ~30 行 `registerHooks` + 本地 `asTypescript`（urlImport 一族 4 个文件各有一份）。
// 本文件关心的是「停滞判定（无进展才判死）」，所以只替换 I/O 边界（原生桥 / 诊断 / 备份 / errors），
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

const { importHistoryFromUrl, UrlImportCancelled } =
  await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** 每个用例用自己的链接：续传点按 URL 隔离，用例之间不会互相污染。 */
const URL_PENDING = 'https://obs.example.test/pending.zip'
const URL_SLOW = 'https://obs.example.test/slow-164mb.zip'
const URL_STALL = 'https://obs.example.test/stall.zip'
const URL_RESUME = 'https://obs.example.test/resume.zip'
const URL_RANGE = 'https://obs.example.test/no-range.zip'
const URL_DEADLINE = 'https://obs.example.test/deadline.zip'
const URL_BROKEN = 'https://obs.example.test/broken.zip'
const URL_TIMEOUT = 'https://obs.example.test/timeout.zip'
const URL_CANCEL = 'https://obs.example.test/cancel.zip'
const URL_FAST = 'https://obs.example.test/fast.zip'
const URL_NOTZIP = 'https://obs.example.test/not-zip.zip'

/** 合法 ZIP 头（urlImport 会校验 PK\x03\x04），其余字节填充，保证长度真实。 */
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

/** 组装一次 CapacitorHttp.get 的 206 响应（按 Range 切块，与真实原生桥一致）。 */
const rangeResponse = (url, source, from, to) => {
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

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

/** 每个用例自己装配原生桥；calls 记录真实发出了几次请求，served 记录真实发出的字节数。 */
const useNative = (get) => {
  const native = { native: true, calls: [], served: 0, get }
  globalThis.__native = native
  return native
}

/** 原生层把 Promise 永久挂起（实测真实发生的形态）：既不 resolve 也不 reject。 */
const pendingNative = () =>
  useNative(() => new Promise(() => {}))

/**
 * 限速链路：按「请求跨度 / 速率」决定响应延迟，模拟固定带宽的慢网络。
 * 延迟用注入的假 setTimeout 兑现，所以几十上百秒的「总时长」在真机上不需要真等。
 */
const rateLimitedNative = (url, source, bytesPerSecond) =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    const end = Math.min(to, source.length - 1)
    if (from >= source.length) {
      return Promise.resolve({ status: 416, url, headers: {}, data: null })
    }
    const span = end - from + 1
    const delay = Math.max(1, Math.round((span / bytesPerSecond) * 1000))
    return new Promise((resolve) => {
      setTimeout(() => {
        globalThis.__native.served += span
        resolve(rangeResponse(url, source, from, to))
      }, delay)
    })
  })

/** 前 limit 字节正常返回，之后永久挂起：这就是「真停滞」的形态。 */
const stallAfterNative = (url, source, limit) =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    if (from >= limit) {
      return new Promise(() => {})
    }
    return new Promise((resolve) => {
      setTimeout(() => {
        globalThis.__native.served += Math.min(to, source.length - 1) - from + 1
        resolve(rangeResponse(url, source, from, to))
      }, 20)
    })
  })

/**
 * 先按固定速率推进到 limit 字节，之后永久挂起：
 * 让「在推进」与「真正停滞」两个阶段都足够长，心跳日志两种状态都能看到。
 */
const rateLimitedUntilNative = (url, source, limit, bytesPerSecond) =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    if (from >= limit) {
      return new Promise(() => {})
    }
    const end = Math.min(to, source.length - 1)
    const span = end - from + 1
    const delay = Math.max(1, Math.round((span / bytesPerSecond) * 1000))
    return new Promise((resolve) => {
      setTimeout(() => {
        globalThis.__native.served += span
        resolve(rangeResponse(url, source, from, to))
      }, delay)
    })
  })

/** 服务端忽略 Range：任何请求都回 200 + 整包（这是 OBS/网关的常见退化行为）。 */
const noRangeNative = (url, source) =>
  useNative(() =>
    Promise.resolve({
      status: 200,
      url,
      headers: { 'Content-Length': String(source.length) },
      data: source.slice().buffer,
    })
  )

/**
 * 同一个 tick 内允许的「0 延迟重新 arm」次数。
 * 正常路径最多出现一次（判死那一刻 `stallAt - now === 0`），几百次只可能是判据没了在自旋。
 */
const ZERO_DELAY_SPIN_LIMIT = 200

/**
 * 假时钟：setTimeout / setInterval / Date 一起假，tick 之后让出微任务再继续。
 *
 * Issue #459：`t.mock.timers.tick()` **不可中断**。停滞判据一旦失效，看门狗醒来发现
 * 「还是没进展」就按 `stallAt - now === 0` 重新 arm —— 一个 tick 内部同步无限自旋。
 * 实测：不是「在等一个永远不来的 Promise」（那种至少能被 `--test-timeout` 收口判
 * `cancelled`），而是**同步死循环**，`--test-timeout` 也进不去，整轮 node --test 直接挂住。
 * 所以在 tick 期间给 setTimeout 装一个「单 tick 内 0 延迟重新 arm」计数器，超阈值直接
 * 变成一句人话的失败：几毫秒内红，而不是永久挂死。
 */
const fakeTime = (t, start = 1_700_000_000_000) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: start })
  const mockedSetTimeout = globalThis.setTimeout
  const tick = (ms) => {
    let zeroDelayArms = 0
    globalThis.setTimeout = (callback, delay, ...args) => {
      if ((delay ?? 0) === 0 && (zeroDelayArms += 1) > ZERO_DELAY_SPIN_LIMIT) {
        assert.fail(
          `停滞判死失效：假时钟 ${Date.now()}ms 处，同一个 tick 内连续 ${ZERO_DELAY_SPIN_LIMIT}` +
            ' 次 0 延迟重新 arm 看门狗，却始终给不出 stalled 终态 —— #38 的唯一失败判据不见了（#459）'
        )
      }
      return mockedSetTimeout(callback, delay, ...args)
    }
    try {
      t.mock.timers.tick(ms)
    } finally {
      globalThis.setTimeout = mockedSetTimeout
    }
  }
  return { now: () => Date.now(), tick }
}

/** 让出微任务 + 一个真 macrotask，好让 tick 触发的 Promise 链继续跑。 */
const flush = () => new Promise((resolve) => setImmediate(resolve))

const resetEnv = ({ importCount = 1 } = {}) => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = importCount
  globalThis.__native = undefined
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
 *
 * Issue #459：**「等终态」本身必须有 deadline。** 旧写法只按假时间推进，判据一失效
 * （`stallVerdict()` 恒 `null`）就永远撞不到那句断言：卡死在停滞窗口那一刻的
 * `t.mock.timers.tick()` 里（看门狗按 0 延迟反复重新 arm，同步自旋），
 * CI 里于是表现为 `cancelled` / job 超时而不是 `fail`。现在两个预算同时生效：
 *   · 假时间预算 maxMs —— 越过就立刻判红（`导入在 Nms 假时间内没有终态`）；
 *   · **真实时间预算 deadlineMs（5s）** —— 假 timer 会把节奏拖慢，到点仍无终态即判红，
 *     失败信息直说「停滞判死失效」。
 * 三种态必须能分开，由用例显式断言：
 *   stalled   → `{ state: 'settled', error: <BackupError> }`
 *   completed → `{ state: 'settled', error: null }`（停滞场景下「不该发生」）
 *   hung      → 直接 assert.fail（既没 resolve 也没 reject）
 */
const drive = async (clock, run, { maxMs = 400_000, step = 200, deadlineMs = 5_000 } = {}) => {
  let spent = 0
  const outcome = await settleInRealTime(run.done, {
    deadlineMs,
    pump: () => {
      // 假时间预算耗尽仍无终态 = 在无限转圈，不必再等真实 deadline
      if (spent >= maxMs) {
        assert.fail(`导入在 ${maxMs}ms 假时间内没有终态（还在无限转圈）`)
      }
      clock.tick(step)
      spent += step
    },
  })
  if (outcome.state === 'hung') {
    assert.fail(
      `停滞判死失效：假时钟推进 ${spent}ms（真实 ${outcome.realMs}ms）后导入既没有 resolve 也没有 reject —— ` +
        '#38 的唯一失败判据（连续无进展即判 stalled）没有兑现，用例不许靠超时兜底'
    )
  }
  return { error: outcome.value, spent }
}

/**
 * 「本该判死却成功」是第三种要分开的态（Issue #459）：
 * hung（永久等待）由 drive 内部 assert.fail 掉，这里负责把 completed 变成一句人话，
 * 而不是让它落到 `error.key` 是 undefined 的含糊断言上。
 */
const expectFailed = (error, label) => {
  assert.notEqual(error, null, `${label}：不该 completed —— 本该判死的场景竟然成功返回（判据丢了）`)
  assert.equal(error?.name, 'BackupError', `${label}：失败终态必须是 BackupError，实际 ${error?.name}`)
}

test('慢速但持续推进：总时长超过旧 120s 预算也不判死，最终成功', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  // 3MB / 20KB/s = 约 150s 假时间：比 #38 被误杀的 120s 总预算更长，但字节一直在增长
  const source = zipBytes(3 * 1024 * 1024)
  const native = rateLimitedNative(URL_SLOW, source, 20 * 1024)
  const run = startImport(URL_SLOW, { heartbeatIntervalMs: 600, downloadStallMs: 40_000 })

  const { error, spent } = await drive(clock, run)

  assert.equal(error, null, `慢但推进的合法包不得判死（实际 ${error?.key ?? ''}）`)
  assert.ok(spent > 120_000, `总时长必须真的超过旧 120s 预算（实际 ${spent}ms）`)
  console.log(`  慢速推进：假时长 ${(spent / 1000).toFixed(1)}s、字节 ${source.length}、请求 ${native.calls.length} 次`)
  assert.equal(records('import_error').length, 0, '成功路径不允许留失败记录')
  assert.equal(globalThis.__imported.length, 1)
  assert.equal(globalThis.__imported[0].size, source.length, '拼出来的包必须与原始字节数一致')

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

test('真正停滞（拿到 1MB 后再无数据）：N 秒后判 stalled，文案含已下载/总数', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(2 * 1024 * 1024)
  const LIMIT = 1024 * 1024
  // 20KB/s 先推到 1MB（约 51s，期间心跳必须是 advancing），之后彻底没有新数据
  rateLimitedUntilNative(URL_STALL, source, LIMIT, 20 * 1024)
  const STALL_MS = 8_000
  const run = startImport(URL_STALL, { downloadStallMs: STALL_MS, heartbeatIntervalMs: 1_000 })

  const { error, spent } = await drive(clock, run, { maxMs: 200_000 })

  // 三态分开（#459）：hung 由 drive 判红，这里先把 completed 挑出来
  expectFailed(error, '真停滞')
  assert.equal(error.key, 'historyImportUrlStalled', '停滞必须给出「停滞」终态，而不是别的分类')
  // 判定时机 = 最后一次进度 + 窗口：不能提前，也不能拖太久
  assert.ok(spent >= STALL_MS, `必须撑满停滞窗口才判死（实际 ${spent}ms）`)

  const failures = records('import_error')
  assert.equal(failures.length, 1)
  assert.equal(failures[0].fields.stage, 'import.download')
  assert.equal(failures[0].fields.reason, 'stalled')
  assert.equal(failures[0].fields.retryable, true, '链路类失败可重试')
  assert.equal(failures[0].fields.resume, 'yes', '已到手一部分时必须允许续传')
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

  // 心跳 interval 必须停掉：继续推进时钟也不该再有心跳
  const before = beats.length
  clock.tick(30_000)
  await flush()
  assert.equal(events('import: download heartbeat').length, before, '失败后不能残留心跳 interval')
})

test('重试续传：同链接第二次从已下载字节继续，不再从 0 开始', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(2 * 1024 * 1024)
  const LIMIT = 1024 * 1024
  stallAfterNative(URL_RESUME, source, LIMIT)

  // 第一次：下到 1MB 后装死 → 停滞终态，但字节留着当续传点
  const first = await drive(
    clock,
    startImport(URL_RESUME, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 }),
    { maxMs: 60_000 }
  )
  expectFailed(first.error, '续传前的停滞')
  assert.equal(first.error.key, 'historyImportUrlStalled')
  const resumeFrom = records('import_error')[0].fields['download.bytes']
  assert.ok(resumeFrom >= LIMIT)

  // 第二次：网络恢复，按 Range 正常给字节
  const native = rateLimitedNative(URL_RESUME, source, 512 * 1024)
  const second = startImport(URL_RESUME, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
  const result = await drive(clock, second, { maxMs: 200_000 })

  assert.equal(result.error, null, `续传后必须成功（实际 ${result.error?.key ?? ''}）`)
  // 第一条请求就从续传点开始（FIRST_CHUNK_BYTES=4096）
  assert.equal(
    native.calls[0].headers.Range,
    `bytes=${resumeFrom}-${resumeFrom + 4095}`,
    '重试必须带 Range 从已下载字节继续，不能从 0 开始'
  )
  // 真的只补了「剩下那一截」，没有重下前面的字节
  assert.equal(native.served, source.length - resumeFrom, '续传只能补剩余字节')
  console.log(
    `  续传：首次停在 ${resumeFrom}/${source.length}，第二次只补 ${native.served} 字节，` +
      `首请求 Range=${native.calls[0].headers.Range}`
  )
  // 拼出来的包仍然完整
  assert.equal(globalThis.__imported.length, 1)
  assert.equal(globalThis.__imported[0].size, source.length)
  // 详情/进度：明确告知「从已下载的哪里继续」
  const resumedTrace = second.trace.find((entry) => entry.kind === 'resume')
  assert.equal(resumedTrace?.bytes, resumeFrom)
  assert.equal(second.progress[0].downloadedBytes, resumeFrom, '进度不能从 0 重新开始')
  assert.match(render(zh, { key: 'historyImportUrlResumed', params: { done: formatSize(resumeFrom) } }), /继续下载/)
})

test('服务端不支持 Range（回 200 整包）：丢弃本地字节从头重下，并给出「已重新开始」文案', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(512 * 1024)
  const LIMIT = 64 * 1024
  stallAfterNative(URL_RANGE, source, LIMIT)

  const first = await drive(
    clock,
    startImport(URL_RANGE, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 }),
    { maxMs: 60_000 }
  )
  expectFailed(first.error, '回 200 前的停滞')
  assert.equal(first.error.key, 'historyImportUrlStalled')
  assert.ok(records('import_error')[0].fields['download.bytes'] >= LIMIT)

  // 第二轮：服务端不再认 Range，任何请求都回 200 整包
  const native = noRangeNative(URL_RANGE, source)
  const second = startImport(URL_RANGE, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
  const result = await drive(clock, second, { maxMs: 120_000 })

  assert.equal(result.error, null, `不支持边界续传时应退化为从头重下并成功（实际 ${result.error?.key ?? ''}）`)
  assert.equal(native.calls.length, 1, '整包已经一次到手，不应再发后续块')
  // 包体不能被拼成两截（重复字节会让 ZIP 解析失败/体积翻倍）
  assert.equal(globalThis.__imported[0].size, source.length)
  // 明确的「已重新开始」证据：事件 + 详情条目 + 文案
  assert.equal(events('import: range ignored, restart from zero').length, 1)
  const restart = second.trace.find((entry) => entry.kind === 'restart')
  assert.equal(restart?.message, 'range-ignored')
  assert.match(render(zh, { key: 'historyImportUrlRestarted' }), /不支持断点续传，已从头重新下载/)
})

test('防御性总上限：字节一直在增长但超过上限 → 判「下载超时」，不是 stalled', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const source = zipBytes(2 * 1024 * 1024)
  rateLimitedNative(URL_DEADLINE, source, 20 * 1024)
  const MAX_TOTAL_MS = 6_000
  const run = startImport(URL_DEADLINE, {
    downloadStallMs: 60_000,
    downloadMaxTotalMs: MAX_TOTAL_MS,
    heartbeatIntervalMs: 1_000,
  })

  const { error, spent } = await drive(clock, run, { maxMs: 60_000 })

  expectFailed(error, '总上限')
  assert.equal(error.key, 'historyImportUrlDeadline')
  assert.ok(spent >= MAX_TOTAL_MS && spent < MAX_TOTAL_MS + 4_000, `应在总上限附近收口（实际 ${spent}ms）`)
  const failure = records('import_error')[0]
  assert.equal(failure.fields.reason, 'deadline')
  assert.equal(failure.fields['max.total.ms'], MAX_TOTAL_MS)
  assert.ok(failure.fields['download.bytes'] > 0, '总上限收口时字节通常已经到手一部分（可续传）')
  assert.match(render(zh, error), /下载超时/)
})

test('永久 pending 的原生 Promise（首块就没数据）：窗口到点必须有失败终态 + 心跳 + 结果可读', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const native = pendingNative()
  const STALL_MS = 4_000
  const run = startImport(URL_PENDING, { downloadStallMs: STALL_MS, heartbeatIntervalMs: 800 })

  const { error, spent } = await drive(clock, run, { maxMs: 40_000 })

  // 三态分开（#459）：hung 由 drive 判红；这里断言「不会 completed」
  expectFailed(error, '永久 pending')
  // 与真机同形：原生永不 settle 就只会有 1 次请求（没有重试、没有响应）
  assert.equal(native.calls.length, 1, `永不 settle 时只有首请求，实际 ${native.calls.length}`)
  assert.equal(error.key, 'historyImportUrlStalledUnknownTotal', '拿不到总数时要走「无总数」文案')
  assert.ok(spent >= STALL_MS && spent < STALL_MS + 4_000, `应在停滞窗口到点收口（实际 ${spent}ms）`)
  assert.match(render(zh, error), /下载停滞/)
  assert.match(render(zh, error), /4 秒/)

  const beats = events('import: download heartbeat')
  assert.ok(beats.length >= 2, `心跳至少 2 条，实际 ${beats.length}`)
  for (const beat of beats) {
    assert.equal(beat.kind, 'import_stage')
    assert.equal(beat.fields.stage, 'import.download')
    assert.equal(typeof beat.fields['download.bytes'], 'number')
    assert.equal(typeof beat.fields.attempt, 'number')
    assert.equal(typeof beat.fields['progress.bytes'], 'number')
    assert.equal(typeof beat.fields['idle.ms'], 'number')
    assert.equal(typeof beat.fields['stall.leftMs'], 'number')
  }
  assert.equal(records('import_error')[0].fields['download.bytes'], 0)
  assert.equal(records('import_error')[0].fields.resume, 'no', '零字节没有可续传的内容')
  assert.ok(run.trace.some((entry) => entry.kind === 'heartbeat'))
})

test('坏包（非 ZIP）不保留续传点：下次重试仍从 0 开始', async (t) => {
  resetEnv()
  const clock = fakeTime(t)
  const bad = new Uint8Array(8 * 1024)
  bad.fill(0x41) // "AAAA…"：不是 PK\x03\x04
  useNative(() =>
    Promise.resolve({
      status: 200,
      url: URL_NOTZIP,
      headers: { 'Content-Length': String(bad.length) },
      data: bad.slice().buffer,
    })
  )
  const first = await drive(
    clock,
    startImport(URL_NOTZIP, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 }),
    { maxMs: 30_000 }
  )
  assert.equal(first.error?.key, 'historyImportUrlNotZip')

  // 同样的链接再来一次：坏包不能把字节带进下一次（否则永远拼不出合法 ZIP）
  const native = rateLimitedNative(URL_NOTZIP, zipBytes(8 * 1024), 64 * 1024)
  const second = await drive(
    clock,
    startImport(URL_NOTZIP, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 }),
    { maxMs: 30_000 }
  )
  assert.equal(native.calls[0].headers.Range, 'bytes=0-4095', '坏包之后重试必须从 0 开始')
  assert.equal(second.error, null)
})

test('断流（unexpected end of stream）：仍是「连接被中断」，不被判成停滞', async (t) => {
  resetEnv()
  // 首块正常，之后每次请求都断流：块级重试耗尽后按 interrupted 分类
  useNative((options) => {
    const { from, to } = rangeOf(options)
    if (from === 0) {
      return Promise.resolve(rangeResponse(URL_BROKEN, zipBytes(32 * 1024), from, to))
    }
    return Promise.reject(new Error('unexpected end of stream on com.android.okhttp.Address@1be17ec1'))
  })
  // 真实时钟即可：这条路径是立刻失败的，不需要假时间
  const run = startImport(URL_BROKEN, { downloadStallMs: 5_000, heartbeatIntervalMs: 100 })
  const error = await run.done
  assert.equal(error?.name, 'BackupError')
  assert.equal(error.key, 'historyImportUrlInterrupted')
  assert.equal(typeof error.params.percent, 'number')
  assert.equal(records('import_error')[0].fields.reason, 'interrupted')
  assert.equal(run.trace.find((entry) => entry.kind === 'error').message, 'interrupted')
})

test('无响应但最终 reject（读超时）：仍是超时分类，且期间有心跳', async (t) => {
  resetEnv()
  const timers = trackIntervals()
  useNative(
    () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Read timed out')), 150)
      })
  )
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

test('慢速分块：正常下完，仍以成功为终态且不留定时器', async (t) => {
  resetEnv()
  const timers = trackIntervals()
  const source = zipBytes(12 * 1024)
  rateLimitedNative(URL_FAST, source, 256 * 1024)
  const run = startImport(URL_FAST, { downloadStallMs: 5_000, heartbeatIntervalMs: 50 })
  const error = await run.done
  assert.equal(error, null, `慢速但能下完时必须成功（${error?.message ?? ''}）`)
  assert.equal(records('import_error').length, 0, '成功路径不应记录失败')
  assert.equal(globalThis.__imported.length, 1)
  assert.equal(globalThis.__imported[0].size, source.length)
  assert.equal(run.trace[run.trace.length - 1].kind, 'done')
  assert.equal(timers.live(), 0, '成功后不能残留心跳 interval')
  timers.restore()
})

test('取消：立刻给出取消终态，不误报下载失败、不留定时器', async () => {
  resetEnv()
  const timers = trackIntervals()
  pendingNative()
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
    // 迟到的原生响应不会再把失败写回来
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(records('import_error').length, 0)
  } finally {
    timers.restore()
  }
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

test('终态文案可读：停滞/超时/续传/重新开始 在 zh/en 里都有，且占位符齐备', () => {
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
  // 服务端拒绝 Range / 续传
  assert.match(zh.historyImportUrlRestarted, /不支持断点续传，已从头重新下载/)
  assert.match(zh.historyImportUrlResumed, /\{done\}/)
  // 详情文案
  assert.match(zh.importTraceReasonStalled, /\{seconds\}/)
  assert.match(zh.importTraceReasonDeadline, /\{minutes\}/)
  assert.match(zh.importTraceHeartbeat, /\{idle\}/)
  assert.match(zh.importTraceHeartbeatUnknown, /\{idle\}/)
  assert.match(zh.importTraceResume, /\{done\}/)
  assert.match(zh.importTraceRestart, /重新下载/)
  // 英文同步
  assert.match(en.historyImportUrlStalled, /no new data for \{seconds\}s/)
  assert.match(en.historyImportUrlDeadline, /timed out/)
  assert.match(en.historyImportUrlRestarted, /does not support resuming/)
  assert.match(en.importTraceReasonStalled, /\{seconds\}/)
})

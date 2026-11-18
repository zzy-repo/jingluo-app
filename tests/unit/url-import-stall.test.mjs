// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 「从链接导入」的兜底终态与周期心跳（改动见 src/services/chat/history/urlImport.ts）。
//
// 为什么单独一层：集成用例要真跑浏览器 + 真产物，而本组断言的场景是「原生 Promise 永久 pending」，
// 只有把下载总预算调小才能在几秒内验证。这里只替换 Capacitor 原生桥 / diagnostics / backup，
// urlImport 的真实代码（分块、重试、分类、心跳、清理定时器）原样运行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href

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
    return nextResolve(specifier, context)
  },
})

const { importHistoryFromUrl, UrlImportCancelled } =
  await import('../../src/services/chat/history/urlImport.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const URL_OK = 'https://obs.example.test/deepseek_data-2026-11-01.zip'

/** 合法 ZIP 头（urlImport 会校验 PK\x03\x04），其余字节填充，保证长度真实。 */
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

/** 组装一次 CapacitorHttp.get 的正常响应（按 Range 切块，与真实原生桥一致）。 */
const rangeResponse = (source, from, to) => {
  const end = Math.min(to, source.length - 1)
  const slice = source.slice(from, end + 1)
  return {
    status: 206,
    url: URL_OK,
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

/** 每个用例自己装配原生桥；calls 记录真实发出了几次请求。 */
const useNative = (get) => {
  const native = { native: true, calls: [], get }
  globalThis.__native = native
  return native
}

/** 原生层把 Promise 永久挂起（实测真实发生的形态）：既不 resolve 也不 reject。 */
const pendingNative = () => useNative(() => new Promise(() => {}))

/** 按 Range 正常回字节，可选每块延迟；failWhen 返回 Error 时改成 reject。 */
const chunkedNative = (source, { delayMs = 0, failWhen } = {}) =>
  useNative((options) => {
    const { from, to } = rangeOf(options)
    const failure = failWhen?.({ from, to })
    const run = () => {
      if (failure) {
        throw failure
      }
      return rangeResponse(source, from, to)
    }
    if (delayMs === 0) {
      try {
        return Promise.resolve(run())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(run())
        } catch (error) {
          reject(error)
        }
      }, delayMs)
    })
  })

const resetEnv = ({ importCount = 1 } = {}) => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = importCount
  globalThis.__native = undefined
}

const events = (message) => globalThis.__log.events.filter((entry) => entry.message === message)
const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

/** 统计心跳 interval 的存活数量：成功/失败/取消之后必须是 0（不能泄漏）。 */
const trackIntervals = () => {
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const live = new Set()
  let peak = 0
  globalThis.setInterval = (callback, ms) => {
    const id = realSetInterval(callback, ms)
    live.add(id)
    peak = Math.max(peak, live.size)
    return id
  }
  globalThis.clearInterval = (id) => {
    live.delete(id)
    return realClearInterval(id)
  }
  return {
    live: () => live.size,
    peak: () => peak,
    restore: () => {
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

/** 跑一次导入，返回 { error, elapsed, trace }（绝不 await 到超时才算失败）。 */
const runImport = async (options = {}) => {
  const trace = []
  const startedAt = Date.now()
  const error = await importHistoryFromUrl(URL_OK, { onTrace: (entry) => trace.push(entry), ...options }).then(
    () => null,
    (reason) => reason
  )
  return { error, elapsed: Date.now() - startedAt, trace }
}

test('永久 pending 的原生 Promise：预算内必须有失败终态，且日志有心跳与最后阶段', async () => {
  resetEnv()
  const timers = trackIntervals()
  pendingNative()
  try {
    const native = globalThis.__native
    const { error, elapsed, trace } = await runImport({
      downloadBudgetMs: 400,
      heartbeatIntervalMs: 100,
    })
    assert.ok(error, '原生 Promise 永不 settle 时也必须失败，不能一直 pending')
    // 与真机同形：原生永不 settle 就只会有 1 次请求（没有重试、没有响应）
    assert.equal(native.calls.length, 1, `永不 settle 时只有首请求，实际 ${native.calls.length}`)
    assert.equal(error.name, 'BackupError')
    assert.equal(error.key, 'historyImportUrlStalledUnknownTotal')
    assert.ok(elapsed >= 400, `不能早于总预算失败（实际 ${elapsed}ms）`)
    assert.ok(elapsed < 3000, `终态必须在有限时间内出现（实际 ${elapsed}ms，预算 400ms）`)

    // 心跳：≥2 条，带已下载字节与当前 attempt，且带阶段
    const beats = events('import: download heartbeat')
    assert.ok(beats.length >= 2, `心跳至少 2 条，实际 ${beats.length}`)
    for (const beat of beats) {
      assert.equal(beat.kind, 'import_stage')
      assert.equal(beat.fields.stage, 'download')
      assert.equal(typeof beat.fields['download.bytes'], 'number')
      assert.equal(typeof beat.fields.attempt, 'number')
      assert.equal(typeof beat.fields['budget.leftMs'], 'number')
    }
    // 「最后活着的时刻」：最后一条心跳仍在预算内
    assert.ok(beats[beats.length - 1].fields['budget.leftMs'] < 400)

    // 失败终态可读：阶段 + 已下载字节 + 原因 + 可重试
    const failures = records('import_error')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].fields.stage, 'download')
    assert.equal(failures[0].fields.reason, 'stalled')
    assert.equal(failures[0].fields.retryable, 'yes')
    assert.equal(failures[0].fields['download.bytes'], 0)
    assert.ok(failures[0].fields['budget.ms'] === 400)

    // 诊断详情（供 UI 直接展示）：心跳条目 + 带阶段/字节/原因的失败条目
    assert.ok(trace.some((entry) => entry.kind === 'heartbeat'), '详情里要有心跳，能看出最后活着的时刻')
    const failureTrace = trace.find((entry) => entry.kind === 'error')
    assert.equal(failureTrace.message, 'stalled')
    assert.equal(failureTrace.bytes, 0)

    // 心跳 interval 确实起来过，结束时必须归零
    assert.ok(timers.peak() >= 1, '下载期间心跳应在跑')
    assert.equal(timers.live(), 0, '失败后不能残留心跳 interval')
  } finally {
    timers.restore()
  }
})

test('预算覆盖所有重试：重试不会重置总预算', async () => {
  resetEnv()
  pendingNative()
  // 每次请求都拖着不返回、100ms 后以断流失败：块级重试会把总耗时拉长，预算不能被重置
  const native = chunkedNative(zipBytes(64 * 1024), {
    delayMs: 100,
    failWhen: () => new Error('unexpected end of stream on com.android.okhttp.Address@1be17ec1'),
  })
  const { error, elapsed } = await runImport({ downloadBudgetMs: 250, heartbeatIntervalMs: 50 })
  assert.equal(error?.name, 'BackupError')
  assert.equal(error.key, 'historyImportUrlStalledUnknownTotal')
  assert.ok(elapsed >= 250 && elapsed < 2000, `预算应在 250ms 处兜底（实际 ${elapsed}ms）`)
  // 预算耗尽之后不再发新请求
  assert.equal(native.calls.length, 2, `只应发生 1 次首请求 + 1 次重试，实际 ${native.calls.length}`)
})

test('断流（unexpected end of stream）：有失败终态，不做成超时', async () => {
  resetEnv()
  const source = zipBytes(32 * 1024)
  chunkedNative(source, {
    failWhen: ({ from }) =>
      from >= 4096 ? new Error('unexpected end of stream on com.android.okhttp.Address@1be17ec1') : undefined,
  })
  const { error, elapsed, trace } = await runImport({ downloadBudgetMs: 5000, heartbeatIntervalMs: 100 })
  assert.equal(error?.name, 'BackupError')
  assert.equal(error.key, 'historyImportUrlInterrupted')
  assert.equal(typeof error.params.percent, 'number')
  assert.ok(elapsed < 4000, `断流应在预算内被分类（实际 ${elapsed}ms）`)
  assert.equal(records('import_error')[0].fields.reason, 'interrupted')
  assert.equal(trace.find((entry) => entry.kind === 'error').message, 'interrupted')
})

test('无响应但最终 reject（读超时）：有失败终态，且期间有心跳', async () => {
  resetEnv()
  const timers = trackIntervals()
  pendingNative()
  // 150ms 后 reject：比预算早得多，说明「原生最终会 reject」时仍走既有超时分类
  useNative(
    () =>
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('Read timed out')), 150)
      })
  )
  try {
    const { error, elapsed } = await runImport({ downloadBudgetMs: 5000, heartbeatIntervalMs: 50 })
    assert.equal(error?.name, 'BackupError')
    assert.equal(error.key, 'historyImportUrlTimeout')
    assert.ok(elapsed < 3000, `应在预算之前就按超时收口（实际 ${elapsed}ms）`)
    assert.ok(events('import: download heartbeat').length >= 1, '等待期间必须留有心跳')
    assert.equal(records('import_error')[0].fields.reason, 'timeout')
    assert.equal(timers.live(), 0, '失败后不能残留心跳 interval')
  } finally {
    timers.restore()
  }
})

test('慢速分块：正常下完，仍以成功为终态', async () => {
  resetEnv()
  const timers = trackIntervals()
  const source = zipBytes(12 * 1024)
  chunkedNative(source, { delayMs: 80 })
  try {
    const { error, elapsed, trace } = await runImport({ downloadBudgetMs: 5000, heartbeatIntervalMs: 50 })
    assert.equal(error, null, `慢速但能下完时必须成功（${error?.message ?? ''}）`)
    assert.ok(elapsed < 5000, `不该被总预算误杀（实际 ${elapsed}ms）`)
    assert.equal(records('import_error').length, 0, '成功路径不应记录失败')
    assert.equal(globalThis.__imported.length, 1)
    assert.equal(globalThis.__imported[0].size, source.length)
    assert.equal(trace[trace.length - 1].kind, 'done')
    assert.equal(timers.live(), 0, '成功后不能残留心跳 interval')
  } finally {
    timers.restore()
  }
})

test('取消：立刻给出取消终态，不误报下载失败、不留定时器', async () => {
  resetEnv()
  const timers = trackIntervals()
  pendingNative()
  try {
    // 预算给得很宽：能不能及时收口全靠取消，而不是靠预算
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 120)
    const { error, elapsed, trace } = await runImport({
      signal: controller.signal,
      downloadBudgetMs: 10_000,
      heartbeatIntervalMs: 50,
    })
    assert.ok(error instanceof UrlImportCancelled, `取消应抛 UrlImportCancelled，实际 ${error?.name}`)
    assert.ok(elapsed < 2000, `取消必须在有限时间内生效（实际 ${elapsed}ms）`)
    assert.equal(records('import_error').length, 0, '取消不是失败，不能记录 import_error')
    assert.equal(records('warning').length, 1)
    assert.equal(trace[trace.length - 1].kind, 'cancel')
    assert.equal(timers.live(), 0, '取消后不能残留心跳 interval')
    // 迟到的原生响应不会再把失败写回来
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(records('import_error').length, 0)
  } finally {
    timers.restore()
  }
})

test('终态文案可读：zh/en 都有 stalled 与心跳 key，且带 阶段/字节/可重试 的占位符', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh/en 的 key 必须一一对应')
  assert.match(zh.historyImportUrlStalled, /\{done\}/)
  assert.match(zh.historyImportUrlStalled, /\{total\}/)
  assert.match(zh.historyImportUrlStalled, /重试/)
  assert.match(zh.historyImportUrlStalledUnknownTotal, /已下载 \{done\}/)
  assert.match(zh.historyImportUrlStalledUnknownTotal, /重试/)
  assert.match(zh.importTraceReasonStalled, /\{done\}/)
  assert.match(zh.importTraceHeartbeat, /\{done\}/)
  assert.match(en.historyImportUrlStalled, /Retry/)
  assert.match(en.historyImportUrlStalledUnknownTotal, /Retry/)
})

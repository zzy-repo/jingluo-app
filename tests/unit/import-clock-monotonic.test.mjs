// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 导入链路的耗时/停滞判定必须用**单调时钟**，不能用墙钟（Date.now）——issue #151。
//
// 墙钟不单调：系统校时、用户改时间、NTP 跳变、休眠唤醒都会让它整段跳。跳完之后：
// - 前跳：健康的链路凭空「耗完」总上限 → 明明在稳定收字节却被判超时/停滞（成功变失败）
// - 回拨：trace.at 与 import_error.durationMs 变成负数 → 详情里出现「−3600000ms」
//
// 为什么单独一层：本层只替换 Capacitor 原生桥 / diagnostics / backup，urlImport 的真实
// 分块、自适应块大小、看门狗、分类、重试原样运行；唯一的干扰是给 Date.now 加一个偏移，
// 这正是 issue 里那条注入手法（`Date.now = () => realNow() + skew`）。
// 断言只看「用户能看见的结果」：错误码 / 是否成功 / trace.at / durationMs，不看实现细节
// （用 performance.now 还是别的单调源都行，只要不受墙钟偏移影响）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve, moduleUrl } from '../helpers/dom-env.mjs'
import { zipBytes } from '../helpers/url-import-fixtures.mjs'

// 装配走公共入口（#366 第二批 / #408）：`.js→.ts` 解析 + 替身表收成一张表，
// 不再是本文件手抄的 ~30 行 `registerHooks` + 本地 `asTypescript`（urlImport 一族 4 个文件各有一份）。
// 本文件关心的是「时钟单调性（回拨 / durationMs 非负）」，所以只替换 I/O 边界（原生桥 / 诊断 / 备份 / errors），
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

/** 每个用例用自己的链接：续传点按 URL 隔离，用例之间不会互相污染。 */
const URL_SKEW_FORWARD = 'https://obs.example.test/clock-forward.zip'
const URL_SKEW_BACKWARD = 'https://obs.example.test/clock-backward.zip'

const HOUR_MS = 60 * 60 * 1000

/** 合法 ZIP 头（urlImport 会校验 PK\x03\x04），其余字节填充，保证长度真实。 */
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

/** 每个用例自己装配原生桥；calls 记录真实发出了几次请求。 */
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

const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)
const events = (message) => globalThis.__log.events.filter((entry) => entry.message === message)

/**
 * 给 Date.now 注入偏移：`skewAt` 是第几次原生请求时生效（1 = 第一次请求就偏）。
 * 恢复靠返回值里的 restore()，用例必须在 finally 里调用——否则会污染同进程的其它用例。
 */
const skewDateNow = (deltaMs, skewAt) => {
  const realNow = Date.now
  let skew = 0
  Date.now = () => realNow() + skew
  return {
    applyIfDue: (callIndex) => {
      if (callIndex === skewAt) {
        skew = deltaMs
      }
    },
    restore: () => {
      Date.now = realNow
    },
  }
}

/** 起一次导入，返回 trace 与终态。 */
const startImport = async (url, options = {}) => {
  const trace = []
  const progress = []
  const error = await importHistoryFromUrl(url, {
    onTrace: (entry) => trace.push(entry),
    onProgress: (entry) => progress.push(entry),
    ...options,
  }).then(
    () => null,
    (value) => value
  )
  return { trace, progress, error }
}

test('① 系统时间前跳 1 小时：健康链路不得被判超时/停滞（修复前报 historyImportUrlDeadline）', async () => {
  resetEnv()
  const source = zipBytes(32 * 1024)
  const clock = skewDateNow(HOUR_MS, 2)
  // 第 2 次原生请求时把墙钟往前拨 1 小时：包体一直在稳定推进，链路本身完全健康
  useNative((options) => {
    const { from, to } = rangeOf(options)
    clock.applyIfDue(globalThis.__native.calls.length)
    return Promise.resolve(rangeResponse(options.url, source, from, to))
  })

  const { error, trace } = await startImport(URL_SKEW_FORWARD, { heartbeatIntervalMs: 200 })

  try {
    console.log(`  前跳 1h：终态 ${error?.key ?? 'null'}、请求 ${globalThis.__native.calls.length} 次、trace ${trace.length} 条`)
    assert.notEqual(
      error?.key,
      'historyImportUrlStalled',
      '健康链路（一直在收到新字节）不允许被判「下载停滞」'
    )
    assert.notEqual(
      error?.key,
      'historyImportUrlDeadline',
      '墙钟前跳不允许凭空耗完总上限：健康链路必须成功，不得报「超过下载时限」'
    )
    assert.equal(error, null, `健康链路必须成功（实际 ${error?.key ?? 'null'}）`)
    assert.equal(globalThis.__imported.length, 1, '前跳后仍必须真的产出可导入的包')
    assert.equal(globalThis.__imported[0].size, source.length, '拼出来的包必须与原始字节数一致')
    assert.equal(records('import_error').length, 0, '成功路径不允许留失败记录')
    // 看门狗也必须没有开过火
    assert.equal(events('import: download stalled').length, 0, '不允许记录过「停滞」')
    assert.equal(events('import: download deadline exceeded').length, 0, '不允许记录过「超上限」')
  } finally {
    clock.restore()
  }
})

test('② 系统时间回拨 1 小时：trace.at 与 durationMs 一律 >= 0（修复前为 −3600000ms）', async () => {
  resetEnv()
  const clock = skewDateNow(-HOUR_MS, 1)
  // 链路每次都立刻失败：走「重试 → 分类 → 记失败」这条会写出耗时的路径
  useNative(() => {
    clock.applyIfDue(globalThis.__native.calls.length)
    return Promise.reject(new TypeError('Failed to fetch'))
  })

  const { error, trace } = await startImport(URL_SKEW_BACKWARD, { heartbeatIntervalMs: 200 })

  try {
    // 回拨不得改变分类与重试纪律：瞬时错误仍然按「网络异常」重试 2 次后才失败
    assert.equal(error?.key, 'historyImportUrlNetwork', `回拨不应改变错误分类（实际 ${error?.key ?? 'null'}）`)
    assert.equal(globalThis.__native.calls.length, 2, '瞬时错误仍要重试（这里是 1 次上限 = 共 2 次请求）')

    const failures = records('import_error')
    assert.ok(failures.length >= 1, '失败必须留下 import_error 记录')
    const durations = failures.map((entry) => entry.fields.durationMs)
    const at = trace.map((entry) => entry.at)
    const negative = at.filter((value) => !(typeof value === 'number' && value >= 0))
    console.log(`  回拨 1h：trace ${at.length} 条、at = [${at.join(', ')}]、durationMs = [${durations.join(', ')}]`)
    assert.deepEqual(negative, [], `trace.at 不允许出现负数（实测最负 ${Math.min(...at)}ms）`)
    for (const value of durations) {
      assert.equal(typeof value, 'number', `durationMs 必须是数字（实际 ${String(value)}）`)
      assert.ok(value >= 0, `durationMs 不允许为负（实测 ${value}ms）`)
    }
    // 已下载为 0 的失败记录：耗时也不许因为回拨变成负数或超大正数
    assert.ok(
      durations.every((value) => value < HOUR_MS),
      `回拨后的耗时不允许出现「一小时级」的荒谬值（实测 [${durations.join(', ')}]）`
    )
  } finally {
    clock.restore()
  }
})

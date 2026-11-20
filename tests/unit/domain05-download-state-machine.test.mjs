// [layer: unit | 依赖: 无（纯 Node；只替换 Capacitor 原生桥 / diagnostics / backup，urlImport 真实代码） | 耗时: <10s]
//
// 域 5 / N1：**下载状态机表**（docs/testing/coverage/domain-05.md §6.2 N1，11 行）。
//
// 覆盖功能点（注释里的 ID 与盘点表一致）：
//   F-05-02 Range 206 分块下载（块间无缝、字节不重叠不缺失）
//   F-05-03 服务端忽略 Range 回 200 整包 → 丢弃本地字节重下，绝不拼接
//   F-05-04 416 收尾（正向：上一块正好是最后一块 → 正常成功；反向：中途 416 → 连接被中断）
//   F-05-05 停滞判定（40s 无新字节；慢但在推进不判死由第 1 行与本表时长断言共同保证）
//   F-05-06 断点续传（同链接从已下字节继续；换链接必须丢弃旧续传点）
//   F-05-07 两档终态可区分（stalled vs deadline，文案与诊断字段都不同）
//   F-05-22 总长判定（206 缺 Content-Range / total=* 时不得拿块长当总长）
//
// 为什么最脆弱（#38 / #151 / #152 两个热修）：判据是「时间 × 字节 × 并发信号」的三元耦合，
// 而且 200MB / 30min / 40s 三个常量互相牵连（#152 已证明会不自洽）。所以这张表既钉终态，
// 也钉「同一个包里到底发了几个请求、从哪个字节开始、实际交了多少字节」——
// 只断言「没抛错」的用例挡不住「合法包被预算判死」这类线上误杀。
//
//   node --test tests/unit/domain05-download-state-machine.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zipBytes } from '../fixtures/domain05/archive.mjs'
import { installHooks, render, stubOf } from '../fixtures/domain05/hooks.mjs'
import { expectEqual, expectMatch, expectOk, runTable } from '../fixtures/domain05/table.mjs'

installHooks((specifier) => {
  if (specifier === '@capacitor/core') {
    return stubOf('../url-import-stubs/capacitor.mjs')
  }
  if (specifier === '../../diagnostics/collector.js') {
    return stubOf('../url-import-stubs/collector.mjs')
  }
  if (specifier === '../backup.js') {
    return stubOf('../url-import-stubs/backup.mjs')
  }
  if (specifier === './errors.js') {
    return stubOf('../url-import-stubs/errors.mjs')
  }
  return null
})

const { DEFAULT_MAX_IMPORT_BYTES } = await import('../../src/services/chat/history/importLimit.ts')
const { importBudget, importHistoryFromUrl } = await import(
  '../../src/services/chat/history/urlImport.ts'
)
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const START = 1_700_000_000_000
/** 每个用例行用自己的链接：续传点按 URL 隔离，行之间不会互相污染。 */
const url = (name) => `https://obs.example.test/domain05/${name}.zip`

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

const events = (message) => globalThis.__log.events.filter((entry) => entry.message === message)
const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

/** 装配原生桥：calls 由 tests/fixtures/url-import-stubs/capacitor.mjs 统一记录。 */
const serve = (get) => {
  const native = { native: true, calls: [], served: 0, get }
  globalThis.__native = native
  return native
}

const sliceResponse = (link, source, from, to, { headers = true, total } = {}) => {
  const end = Math.min(to, source.length - 1)
  const slice = from > end ? new Uint8Array(0) : source.slice(from, end + 1)
  const declared = total ?? source.length
  return {
    status: 206,
    url: link,
    headers: headers
      ? {
          'Content-Range': `bytes ${from}-${end}/${declared}`,
          'Content-Length': String(slice.length),
        }
      : { 'Content-Length': String(slice.length) },
    data: slice.buffer,
  }
}

/** 按 Range 逐块真给字节；after(字节数) 之后永久挂起（真停滞的形态）。 */
const rangeServer = (link, source, { bytesPerSecond = 256 * 1024, hangAfter = Infinity } = {}) =>
  serve((options) => {
    const { from, to } = rangeOf(options)
    if (from >= hangAfter) {
      return new Promise(() => {})
    }
    // 注意：只按请求区间给字节（不夹到 hangAfter）——夹住会让「短块」被当成完成信号，
    // 那就不是停滞而是「服务端收敛」，两个终态完全不同。
    const end = Math.min(to, source.length - 1)
    const span = end - from + 1
    if (span <= 0) {
      return Promise.resolve({ status: 416, url: link, headers: {}, data: null })
    }
    const delay = Math.max(1, Math.round((span / bytesPerSecond) * 1000))
    return new Promise((resolve) => {
      setTimeout(() => {
        globalThis.__native.served += span
        resolve(sliceResponse(link, source, from, end))
      }, delay)
    })
  })

/** 服务端忽略 Range：任何请求都回 200 + 整包（OBS / 网关的常见退化行为）。 */
const wholeArchiveServer = (link, source) =>
  serve(() =>
    Promise.resolve({
      status: 200,
      url: link,
      headers: { 'Content-Length': String(source.length) },
      data: source.slice().buffer,
    })
  )

/** 假时钟：setTimeout / setInterval / Date 一起假，不 sleep。 */
const enableClock = (t, now = START) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now })
  return {
    tick: (ms) => t.mock.timers.tick(ms),
    jump: (ms) => t.mock.timers.setTime(Date.now() + ms),
    reset: () => t.mock.timers.reset(),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

/** 起一次导入（不 await：时间由用例行自己推进）。 */
const startImport = (link, options = {}) => {
  const trace = []
  const progress = []
  const done = importHistoryFromUrl(link, {
    onTrace: (entry) => trace.push(entry),
    onProgress: (entry) => progress.push(entry),
    ...options,
  }).then(
    () => null,
    (error) => error
  )
  return { trace, progress, done }
}

/** 推进假时钟直到终态；返回「实际用掉的假时间」。 */
const drive = async (clock, run, { maxMs = 400_000, step = 200 } = {}) => {
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
  assert.notEqual(outcome, undefined, `导入在 ${maxMs}ms 假时间内没有终态（还在无终态转圈）`)
  return { error: outcome.error, spent }
}

const downloadedFailures = () => records('import_error')
const formatSize = (bytes) =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
      : `${(bytes / 1024 / 1024).toFixed(1)}MB`

/** 断言「请求区间首尾相接、没有空洞也没有重叠」。 */
const assertContiguous = (calls, column = 'Range 连续性') => {
  const ranges = calls.map(rangeOf)
  for (let index = 1; index < ranges.length; index += 1) {
    expectEqual(ranges[index].from, ranges[index - 1].to + 1, `${column}（第 ${index + 1} 个请求）`)
  }
}

test('N1 下载状态机表：11 行（F-05-02/03/04/05/06/07/22）', async (t) => {
  const rows = [
    {
      name: '206 连续分块：块间首尾相接、无重叠无空洞，拼出的包与原始字节等长',
      url: url('range-ok'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(40 * 1024)]])
        const native = rangeServer(this.url, source)
        const run = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const { error } = await drive(clock, run)
        expectEqual(error, null, '终态')
        expectOk(native.calls.length >= 2, `206 应分多块请求，实际 ${native.calls.length} 次`)
        assertContiguous(native.calls)
        expectEqual(native.calls[0].headers.Range.startsWith('bytes=0-'), true, '首块从 0 开始')
        expectEqual(native.served, source.length, '实际交付字节数')
        expectEqual(globalThis.__imported[0].size, source.length, '拼出的包大小')
        const downloads = run.progress.filter((entry) => entry.phase === 'downloading')
        expectEqual(downloads.at(-1).downloadedBytes, source.length, '进度末值')
        expectEqual(downloads.at(-1).totalBytes, source.length, '总长来自 Content-Range')
        expectEqual(downloadedFailures().length, 0, '成功路径不留失败记录')
        expectEqual(run.trace.at(-1).kind, 'done', '详情最后一条')
      },
    },
    {
      name: '206 缺 Content-Range / total=*：总长按未知处理，不拿块长当总长（F-05-22）',
      url: url('range-no-total'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(20 * 1024)]])
        for (const variant of ['no-header', 'star']) {
          resetEnv()
          const native =
            variant === 'no-header'
              ? serve((options) => {
                  const { from, to } = rangeOf(options)
                  return Promise.resolve(sliceResponse(this.url, source, from, to, { headers: false }))
                })
              : serve((options) => {
                  const { from, to } = rangeOf(options)
                  const end = Math.min(to, source.length - 1)
                  const slice = source.slice(from, end + 1)
                  return Promise.resolve({
                    status: 206,
                    url: this.url,
                    headers: { 'Content-Range': `bytes ${from}-${end}/*` },
                    data: slice.buffer,
                  })
                })
          const run = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
          const { error } = await drive(clock, run)
          expectEqual(error, null, `${variant} 终态`)
          const downloads = run.progress.filter((entry) => entry.phase === 'downloading')
          expectEqual(
            downloads.every((entry) => entry.totalBytes === undefined),
            true,
            `${variant} 总长必须未知（4KB 块不能被当成总长）`
          )
          expectOk(native.calls.length >= 2, `${variant} 不能在首块就判「已下完」`)
          expectEqual(globalThis.__imported[0].size, source.length, `${variant} 包大小`)
        }
      },
    },
    {
      name: '200 忽略 Range（首块 from=0）：整包一次到手，只发一个请求（F-05-03）',
      url: url('whole-first'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(16 * 1024)]])
        const native = wholeArchiveServer(this.url, source)
        const run = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const { error } = await drive(clock, run)
        expectEqual(error, null, '终态')
        expectEqual(native.calls.length, 1, '整包已到手，不应再发后续块')
        expectEqual(globalThis.__imported[0].size, source.length, '包大小')
        const downloads = run.progress.filter((entry) => entry.phase === 'downloading')
        expectEqual(downloads.at(-1).totalBytes, source.length, '200 的 Content-Length 就是总长')
      },
    },
    {
      name: '200 忽略 Range（续传中 from>0）：丢弃本地字节从头重下，绝不拼接（F-05-03 / #38）',
      url: url('whole-on-resume'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(32 * 1024)]])
        // 第一轮：下到 8KB 后装死 → 停滞终态，字节留作续传点
        rangeServer(this.url, source, { hangAfter: 8 * 1024 })
        const first = startImport(this.url, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 })
        const stalled = await drive(clock, first, { maxMs: 60_000 })
        expectEqual(stalled.error?.key, 'historyImportUrlStalled', '第一轮终态')
        const resumeFrom = downloadedFailures()[0].fields['download.bytes']
        expectOk(resumeFrom >= 8 * 1024, `续传起点应 ≥ 8KB，实际 ${resumeFrom}`)

        // 第二轮：服务端不再认 Range → 任何请求都回 200 整包
        resetEnv()
        const native = wholeArchiveServer(this.url, source)
        const second = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const result = await drive(clock, second)
        expectEqual(result.error, null, '放弃续传后必须成功')
        expectEqual(rangeOf(native.calls[0]).from, resumeFrom, '续传首请求从已下载字节开始')
        expectEqual(native.calls.length, 1, '整包到手后不再发块')
        expectEqual(
          globalThis.__imported[0].size,
          source.length,
          '包体不能被拼成两截（重复字节会让体积翻倍）'
        )
        expectEqual(events('import: range ignored, restart from zero').length, 1, '必须留「已重新开始」证据')
        expectEqual(second.trace.find((entry) => entry.kind === 'restart')?.message, 'range-ignored', '详情重启条目')
        expectMatch(render(zh, { key: 'historyImportUrlRestarted' }), /从头重新下载/, '重启文案')
      },
    },
    {
      name: '416 落在末尾且字节已齐：视为下载完成并继续校验入库（F-05-04 正向分支）',
      url: url('range-416-end'),
      async run(clock) {
        // 服务端更严格：只要 from 超过末尾就回 416。total 由 Content-Range 给出，
        // 首块正好把它填满 —— 这就是「上一块正好是最后一块」的真实形态。
        const source = zipBytes([['pad.bin', new Uint8Array(4 * 1024)]])
        const total = 4 * 1024
        const native = serve((options) => {
          const { from } = rangeOf(options)
          if (from > 0) {
            return Promise.resolve({ status: 416, url: this.url, headers: {}, data: null })
          }
          return Promise.resolve(sliceResponse(this.url, source.slice(0, total), 0, total - 1, { total }))
        })
        const run = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const { error } = await drive(clock, run)
        expectEqual(error, null, '416 落在末尾必须按成功收尾，不能退化成「416 即失败」')
        expectOk(native.calls.length >= 2, '必须先填满字节、再靠 416 收尾')
        expectEqual(rangeOf(native.calls[1]).from, total, '第二个请求正是越界的那个')
        expectEqual(globalThis.__imported[0].size, total, '入库包大小')
        expectEqual(downloadedFailures().length, 0, '正向收尾不留失败记录')
      },
    },
    {
      name: '416 中途（字节未齐）：终止并报「连接被中断」，不写脏数据（F-05-04 反向）',
      url: url('range-416-mid'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(4 * 1024)]])
        const total = 8 * 1024
        serve((options) => {
          const { from } = rangeOf(options)
          if (from > 0) {
            return Promise.resolve({ status: 416, url: this.url, headers: {}, data: null })
          }
          return Promise.resolve(sliceResponse(this.url, source, 0, 4 * 1024 - 1, { total }))
        })
        const run = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const { error } = await drive(clock, run)
        expectEqual(error?.key, 'historyImportUrlInterrupted', '中途 416 必须按中断终态')
        expectEqual(error.params.percent, 50, '文案里的百分比')
        expectEqual(globalThis.__imported.length, 0, '字节不齐时一个字都不能入库')
        expectEqual(downloadedFailures()[0].fields.reason, 'incomplete', '诊断原因')
      },
    },
    {
      name: '40s 无新字节 → 停滞终态（文案带已下载/共/秒数，且说「可重试」）F-05-05',
      url: url('stall'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(2 * 1024 * 1024)]])
        const stallMs = 8_000
        rangeServer(this.url, source, { bytesPerSecond: 128 * 1024, hangAfter: 512 * 1024 })
        const run = startImport(this.url, { downloadStallMs: stallMs, heartbeatIntervalMs: 1_000 })
        const { error, spent } = await drive(clock, run, { maxMs: 200_000 })
        expectEqual(error?.key, 'historyImportUrlStalled', '终态')
        expectOk(spent >= stallMs, `必须撑满停滞窗口（实际 ${spent}ms）`)
        const failure = downloadedFailures()[0]
        expectEqual(failure.fields.reason, 'stalled', '诊断原因')
        expectEqual(failure.fields.resume, 'yes', '已到手一部分时必须允许续传')
        expectOk(failure.fields['idle.ms'] >= stallMs, 'idle 必须达到窗口')
        const text = render(zh, error)
        expectMatch(text, /下载停滞/, '中文文案')
        expectMatch(text, /可重试/, '必须告诉用户可重试')
        expectMatch(text, new RegExp(formatSize(failure.fields['download.bytes'])), '已下载字节')
        expectMatch(text, new RegExp(`共 ${formatSize(source.length)}`), '总大小')
        expectMatch(render(en, error), /stalled/i, '英文文案')
        // 心跳必须能区分「推进」与「停滞」——这是弱网下唯一的在线证据
        const beats = events('import: download heartbeat')
        expectOk(beats.length >= 2, `心跳至少 2 条，实际 ${beats.length}`)
        expectOk(
          beats.some((beat) => beat.fields['progress.state'] === 'stalled'),
          '停滞阶段心跳必须标 stalled'
        )
      },
    },
    {
      name: '30min 防御性总上限耗尽 → 下载超时（与停滞是两档，文案与诊断都不同）F-05-07 / #152',
      url: url('deadline'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(2 * 1024 * 1024)]])
        const maxTotalMs = 6_000
        rangeServer(this.url, source, { bytesPerSecond: 16 * 1024 })
        const run = startImport(this.url, {
          downloadStallMs: 60_000,
          downloadMaxTotalMs: maxTotalMs,
          heartbeatIntervalMs: 1_000,
        })
        const { error, spent } = await drive(clock, run, { maxMs: 60_000 })
        expectEqual(error?.key, 'historyImportUrlDeadline', '终态必须是「下载超时」而不是停滞')
        expectOk(spent >= maxTotalMs && spent < maxTotalMs + 4_000, `应在总上限附近收口（实际 ${spent}ms）`)
        const failure = downloadedFailures()[0]
        expectEqual(failure.fields.reason, 'deadline', '诊断原因')
        expectEqual(failure.fields['max.total.ms'], maxTotalMs, '诊断里的总上限')
        // 常量自洽性（#152）：预算耗尽的诊断必须带「按现行常量至少要跑多快」，改一个数不改另一个当场可见
        expectEqual(
          failure.fields['min.bytes.per.sec'],
          importBudget().minBytesPerSec,
          '诊断里的最低所需带宽必须由现行常量推导'
        )
        expectEqual(importBudget().maxBytes, DEFAULT_MAX_IMPORT_BYTES, '预算上限的唯一来源')
        const stalledText = render(zh, { key: 'historyImportUrlStalled', params: {} })
        const deadlineText = render(zh, error)
        expectEqual(deadlineText === stalledText, false, '两档文案不能混为一谈')
        expectMatch(deadlineText, /下载超时/, '中文文案')
        expectMatch(render(en, error), /timed out/i, '英文文案')
      },
    },
    {
      name: '同链接续传：第二次从已下载字节继续，只补剩余字节（F-05-06）',
      url: url('resume'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(1 * 1024 * 1024)]])
        rangeServer(this.url, source, { hangAfter: 256 * 1024 })
        const first = startImport(this.url, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 })
        const stalled = await drive(clock, first, { maxMs: 60_000 })
        expectEqual(stalled.error?.key, 'historyImportUrlStalled', '第一轮终态')
        const resumeFrom = downloadedFailures()[0].fields['download.bytes']

        resetEnv()
        const native = rangeServer(this.url, source)
        const second = startImport(this.url, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const result = await drive(clock, second)
        expectEqual(result.error, null, '续传后必须成功')
        expectEqual(rangeOf(native.calls[0]).from, resumeFrom, '首请求必须从续传点开始')
        expectEqual(native.served, source.length - resumeFrom, '只能补剩余字节，不能重下前面')
        expectEqual(globalThis.__imported[0].size, source.length, '拼出的包仍然完整')
        expectEqual(second.progress[0].downloadedBytes, resumeFrom, '进度不能从 0 重新开始')
        expectEqual(second.trace.find((entry) => entry.kind === 'resume')?.bytes, resumeFrom, '详情续传条目')
      },
    },
    {
      name: '换链接必须丢弃旧续传点：新链接首请求从 0 开始（F-05-06 缺口）',
      url: url('drop-resume'),
      async run(clock) {
        const source = zipBytes([['pad.bin', new Uint8Array(256 * 1024)]])
        const other = url('drop-resume-other')
        rangeServer(this.url, source, { hangAfter: 64 * 1024 })
        const first = startImport(this.url, { downloadStallMs: 5_000, heartbeatIntervalMs: 1_000 })
        expectEqual((await drive(clock, first, { maxMs: 60_000 })).error?.key, 'historyImportUrlStalled', '第一轮终态')

        // 换一个链接：旧续传点必须被丢掉（否则两份包会被拼在一起）
        resetEnv()
        const native = rangeServer(other, source)
        const second = startImport(other, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const result = await drive(clock, second)
        expectEqual(result.error, null, '新链接必须成功')
        expectEqual(native.calls[0].headers.Range, 'bytes=0-4095', '换链接后首请求必须从 0 开始')
        expectEqual(native.served, source.length, '新链接必须从头下完')
        expectEqual(second.progress[0].downloadedBytes, 4 * 1024, '新链接没有续传起点')
      },
    },
    {
      name: '墙钟前跳 1h / 回拨 1h：既不凭空耗完总预算，也不产出负耗时（#151）',
      url: url('clock-jump'),
      async run(clock) {
        // 甲、下载途中系统校时前跳 1h：跳变不计入耗时，健康链路不得被预算判死。
        const source = zipBytes([['pad.bin', new Uint8Array(256 * 1024)]])
        rangeServer(this.url, source, { bytesPerSecond: 64 * 1024 })
        const run = startImport(this.url, {
          downloadStallMs: 40_000,
          downloadMaxTotalMs: 30 * 60_000,
          heartbeatIntervalMs: 1_000,
        })
        let outcome
        run.done.then((error) => {
          outcome = { error }
        })
        for (const step of [500, 500]) {
          clock.tick(step)
          await flush()
        }
        clock.jump(60 * 60_000)
        clock.tick(500)
        await flush()
        for (let spent = 0; outcome === undefined && spent < 120_000; spent += 200) {
          clock.tick(200)
          await flush()
        }
        expectEqual(outcome?.error ?? null, null, '时钟前跳不得让合法包被判死')
        const elapsed = run.trace.map((entry) => entry.at)
        expectOk(
          elapsed.every((value) => Number.isFinite(value) && value >= 0),
          `详情耗时不得为负或非数：${JSON.stringify(elapsed)}`
        )
        // 1h 的跳变若被计入，末条详情就会到 3.6e6ms 量级
        expectOk(elapsed.at(-1) < 30_000, `跳变不得计入耗时（末条详情 at=${elapsed.at(-1)}ms）`)
        expectOk(
          elapsed.every((value, index) => index === 0 || value >= elapsed[index - 1]),
          `详情耗时必须单调不减：${JSON.stringify(elapsed)}`
        )
        expectEqual(downloadedFailures().length, 0, '不得记录失败')
        expectEqual(globalThis.__imported[0].size, source.length, '包必须完整')

        // 乙、两次导入之间回拨 1h（NTP 回拨 / 用户改时间）：耗时既不能倒退成负数，
        //     也不能因为「上次读数在未来」把这一次的判据算错。
        clock.jump(-60 * 60_000)
        resetEnv()
        const other = url('clock-jump-back')
        const second = zipBytes([['pad.bin', new Uint8Array(16 * 1024)]])
        rangeServer(other, second, { bytesPerSecond: 64 * 1024 })
        const back = startImport(other, { downloadStallMs: 40_000, heartbeatIntervalMs: 1_000 })
        const result = await drive(clock, back)
        expectEqual(result.error, null, '回拨后导入必须照常成功')
        const backElapsed = back.trace.map((entry) => entry.at)
        expectOk(
          backElapsed.every((value) => Number.isFinite(value) && value >= 0),
          `回拨后详情耗时不得为负：${JSON.stringify(backElapsed)}`
        )
        expectEqual(globalThis.__imported[0].size, second.length, '回拨后包必须完整')
      },
    },
  ]

  await runTable(rows, async (row) => {
    resetEnv()
    const clock = enableClock(t)
    try {
      await row.run(clock)
    } finally {
      clock.reset()
    }
  })
})

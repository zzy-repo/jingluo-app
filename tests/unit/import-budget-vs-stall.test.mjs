// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 「有进展但总预算先耗尽」与「真停滞」必须是两个可区分的失败——issue #152。
//
// 现状（本文件先跑红的那一条）：
// - 停滞（`historyImportUrlStalled*`）与预算耗尽（`historyImportUrlDeadline*`）的**错误码和文案已经是分开的**
//   （#38 那轮把 120s 绝对总预算换成「无进展才判死」时一起拆了），所以这两点在本文件里是**回归锁**，
//   不是本次修的东西 —— 谁把它们合回同一个码，这里就红。
// - 真正缺的是第 2 项：两个常量（200MB 上限 / 30 分钟防御性总上限）之间**没有任何可校验的关系**。
//   代码里既没推导出「低于多少速率就注定下不完」，也没把这个数写进诊断，于是「常量不自洽」这件事
//   谁都不会在任何一次失败里看到。本文件断言预算耗尽的诊断里必须带这个**推导值**
//   （`min.bytes.per.sec`，= DEFAULT_MAX_IMPORT_BYTES ÷ 总上限秒数），改任一个常量而另一个不跟着改，
//   这个断言会立刻告诉人「现在要求的最低带宽变了」。
//
// 本层只替换 Capacitor 原生桥 / diagnostics / backup；分块、看门狗、心跳、分类全部跑真代码。
// 断言只看用户能看见的结果（终态错误码 / 用户文案）与诊断里的事实字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href
// 上限常量用**真模块**：本文件要断言的就是这两个常量之间的关系，不能替换成桩
const limitModule = new URL('../../src/services/chat/history/importLimit.ts', import.meta.url).href
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

const { importHistoryFromUrl, importBudget, minRequiredBytesPerSec } = await import(
  '../../src/services/chat/history/urlImport.ts'
)
const { DEFAULT_MAX_IMPORT_BYTES } = await import('../../src/services/chat/history/importLimit.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

/** 每个用例用自己的链接：续传点按 URL 隔离。 */
const URL_SLOW = 'https://obs.example.test/budget-slow-but-progressing.zip'
const URL_HANG = 'https://obs.example.test/budget-zero-progress.zip'

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
 * 慢但在推进的服务端：每次请求按 Range 真回字节，只是每块要等 `delayMs`。
 * 请求条数由测试替身 capacitor.mjs 统一 push 到 native.calls，用例里不要重复记。
 */
const serveSlowChunks = (source, delayMs) => {
  globalThis.__native = {
    native: true,
    calls: [],
    get: (options) =>
      new Promise((resolve) => {
        setTimeout(() => {
          const { from, to } = rangeOf(options)
          const end = Math.min(to, source.length - 1)
          const slice = from > end ? new Uint8Array(0) : source.slice(from, end + 1)
          resolve({
            status: 206,
            url: options.url,
            headers: {
              'Content-Length': String(slice.byteLength),
              'Content-Range': `bytes ${from}-${Math.max(from, end)}/${source.length}`,
              'Accept-Ranges': 'bytes',
            },
            data: slice.buffer,
          })
        }, delayMs)
      }),
  }
  return globalThis.__native
}

/** 真停滞：原生 Promise 永久 pending（对端不再吐数据），一个字节都不涨。 */
const serveNothing = () => {
  globalThis.__native = { native: true, calls: [], get: () => new Promise(() => {}) }
  return globalThis.__native
}

const startImport = async (url, options) => {
  const trace = []
  const error = await importHistoryFromUrl(url, {
    onTrace: (entry) => trace.push(entry),
    ...options,
  }).then(
    () => null,
    (value) => value
  )
  return { trace, error }
}

test('① 一直在收字节但总预算先耗尽 → 判「超出下载时限」，不是「长时间无响应」', async () => {
  resetEnv()
  // 1MB 包 + 每块 150ms：预算压到 600ms 时包还远没下完，但每个块都在稳定到货
  const source = zipBytes(1024 * 1024)
  const native = serveSlowChunks(source, 150)

  const { error } = await startImport(URL_SLOW, {
    downloadMaxTotalMs: 600,
    downloadStallMs: 5_000,
    heartbeatIntervalMs: 200,
  })

  assert.ok(error !== null, '慢链路也必须有有限时间内的终态，不能一直 pending')
  // 回归锁：预算耗尽必须是 deadline 这一档，谁把它合回 stalled 这里就红
  assert.equal(error.key.startsWith('historyImportUrlDeadline'), true, `预算耗尽应报「超出下载时限」，实际 ${error.key}`)
  assert.equal(error.key.startsWith('historyImportUrlStalled'), false, '有进展的链路不得被写成「长时间无响应」')

  const failures = records('import_error')
  assert.equal(failures.length > 0, true, '失败必须留下诊断记录')
  assert.equal(failures[0].fields.reason, 'deadline', `诊断原因应是 deadline，实际 ${failures[0].fields.reason}`)
  assert.equal(failures[0].fields.reason !== 'stalled', true, '预算耗尽不得记成 stalled')
  // 「一直在收字节」是这条用例的前提：字节确实在涨，所以不是无响应
  assert.equal(native.calls.length > 1, true, `应当发出多次请求，实际 ${native.calls.length} 次`)
  assert.equal(failures[0].fields['download.bytes'] > 0, true, '失败时已经收到过字节（这才是「预算耗尽」而不是「无响应」）')

  // #152 第 2 项：两个常量的关系必须是**推导出来**并写进诊断的，
  // 否则「200MB ÷ 总上限」这类不自洽永远不会在任何一次失败里显形。
  assert.equal(
    failures[0].fields['min.bytes.per.sec'],
    importBudget().minBytesPerSec,
    '预算耗尽的诊断里必须带「按当前两个常量，至少需要多少字节/秒才可能下完」这个推导值'
  )
  // 「一直在推进但没跑完」与「真的没动静」在诊断里也要能分开 —— 两个字段缺一不可
  assert.equal(
    typeof failures[0].fields['idle.ms'],
    'number',
    '预算耗尽的诊断要同时带 idle.ms（否则看日志分不清「在推进」还是「挂了」）'
  )
})

test('② 零字节增长（真停滞）→ 仍判「长时间无响应」', async () => {
  resetEnv()
  const native = serveNothing()

  const { error } = await startImport(URL_HANG, { downloadStallMs: 300, heartbeatIntervalMs: 200 })

  assert.ok(error !== null, '真停滞必须有终态')
  assert.equal(error.key.startsWith('historyImportUrlStalled'), true, `真停滞应报「长时间无响应」，实际 ${error.key}`)

  const failures = records('import_error')
  assert.equal(failures[0].fields.reason, 'stalled', `诊断原因应是 stalled，实际 ${failures[0].fields.reason}`)
  assert.equal(failures[0].fields.reason !== 'deadline', true, '真停滞不得记成 deadline')
  assert.equal(native.calls.length, 1, `停滞时只该发出一次请求，实际 ${native.calls.length} 次`)
})

test('③ 两档的用户文案互不相同且各自说人话（中文/英文都覆盖）', () => {
  const pairs = [
    ['historyImportUrlStalled', 'historyImportUrlDeadline'],
    ['historyImportUrlStalledUnknownTotal', 'historyImportUrlDeadlineUnknownTotal'],
  ]
  for (const [stalledKey, deadlineKey] of pairs) {
    assert.equal(typeof zh[stalledKey], 'string', `zh 缺少 ${stalledKey}`)
    assert.equal(typeof zh[deadlineKey], 'string', `zh 缺少 ${deadlineKey}`)
    assert.equal(typeof en[stalledKey], 'string', `en 缺少 ${stalledKey}`)
    assert.equal(typeof en[deadlineKey], 'string', `en 缺少 ${deadlineKey}`)
    assert.notEqual(zh[stalledKey], zh[deadlineKey], '停滞与预算耗尽不能共用一句文案')
    // 停滞说「多久没有新字节」，不承诺「超出时限」
    assert.match(zh[stalledKey], /没有收到新数据/, `停滞文案应说明「没有收到新数据」：${zh[stalledKey]}`)
    assert.doesNotMatch(zh[stalledKey], /上限/, '停滞文案不该说「超出上限」')
    // 预算耗尽说「超出多久上限」，不许说成「没收到数据」
    assert.match(zh[deadlineKey], /上限/, `预算耗尽文案应说明「超出上限」：${zh[deadlineKey]}`)
    assert.doesNotMatch(zh[deadlineKey], /没有收到新数据/, '预算耗尽文案不该说「没有收到新数据」')
  }
})

test('④ 所需最低带宽由两个常量推导而来（改任一侧结果都会变），不是写死的字面量', () => {
  // 比例关系成立 = 它确实是个推导式，而不是「114KB/s」这种抄来的常量：
  // 上限翻倍 ⇒ 要求翻倍；时限翻倍 ⇒ 要求减半；乘积回到原上限。
  const base = minRequiredBytesPerSec(10 * 1024 * 1024, 60_000)
  assert.equal(base, (10 * 1024 * 1024) / 60, '推导式 = 上限 ÷ 总秒数')
  assert.equal(minRequiredBytesPerSec(20 * 1024 * 1024, 60_000), base * 2, '上限翻倍，所需带宽必须跟着翻倍')
  assert.equal(minRequiredBytesPerSec(10 * 1024 * 1024, 120_000), base / 2, '时限翻倍，所需带宽必须减半')
  assert.equal(base * 60, 10 * 1024 * 1024, '按推导值跑满总时限，正好传完上限那么多字节')

  // 现行常量下：诊断里那个数必须**就是**用当前这两个常量算出来的那个数。
  // 谁把上限调大（或总时限调短）而另一个没跟着改，这条断言就会用新值报出新的「所需最低带宽」。
  const budget = importBudget()
  assert.equal(budget.minBytesPerSec, minRequiredBytesPerSec(budget.maxBytes, budget.maxTotalMs))
  assert.equal(budget.maxBytes, DEFAULT_MAX_IMPORT_BYTES, '诊断用的上限必须就是导入实际用的那一个（不许各写一份）')
  assert.equal(budget.maxTotalMs > 0, true, '总时限必须是正数')
})

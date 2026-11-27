// [layer: unit | 依赖: 无（裸 Node；只替换 Capacitor 原生桥 / diagnostics / backup / errors） | 耗时: <15s]
//
// P0（#1003）：**从链接导入**这条路上，过去「先落盘、后判空间」。
//
// 现场（模拟器 emulator-5554，2026-11-27 UTC 12:12–12:19）：从链接导入一个 20MB 的导出包，
// 分块下载进 `chunks: Uint8Array[]` → `new File(chunks)`（Chromium 对此会把大 Blob 落到盘上）
// → 之后才走到 `chat/backup.ts` → `importArchive.ts` 的预检。也就是说**空间判断发生在写入之后**，
// 而那一刻 `navigator.storage.estimate()` 报的是漂亮数字（quota 3.7GB / usage 45.6MB），
// 真实可用只有 6MB。盘被写到底 → LevelDB 半条记录 → Chromium 判 IDB 损坏并重建 → 48 个会话全丢。
//
// 契约（本文件钉的就是这三条 + 一条不许误杀）：
//   U1 可信余量不够（原生 `freeBytes` 6MB / 声明 20MB）→ **首块就拒绝**，不再下发后续分块、
//      不组装 File、不进解析阶段；
//   U2 空间未知 + 大包 → 拒绝，文案是「暂时无法确认剩余空间」，**不是**「空间不足」；
//   U3 空间未知 + 小包（≤ 分级线）→ 照常导入（不许因为估不出来就让人完全不能从链接导入）；
//   U4 可信余量充足 → 照常导入（不许误拦）。
//
// 判据不是这里新写的：`quotaPrecheck.checkImportSpace` → `storage.judgeWriteSpace`
// （原生 `freeBytes` 唯一可信；`estimate()` 只作否决；未知按负载分级）。本文件只证明
// **这条判据被放在了写入之前**。
//
//   node tests/unit/url-import-space-gate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'

const STUBS = {
  '@capacitor/core': fixtureUrl('url-import-stubs/capacitor.mjs'),
  '../../diagnostics/collector.js': fixtureUrl('url-import-stubs/collector.mjs'),
  '../backup.js': fixtureUrl('url-import-stubs/backup.mjs'),
  './errors.js': fixtureUrl('url-import-stubs/errors.mjs'),
}

installTsResolve({ stubs: STUBS })

const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const { formatImportBytes } = await import('../../src/services/chat/history/importLimit.ts')
const quota = await import('../../src/services/chat/history/quotaPrecheck.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const MB = 1024 * 1024
// 每个用例一个**不同**的链接：`resumePoint` 是模块级状态（只对同一个链接有效），
// 共用 URL 会让上一个用例的续传点（含它声明的 total）漏进下一个用例。
const urlOf = (tag) => `https://obs.example.test/deepseek_data-${tag}.zip`
const ZIP_HEAD = [0x50, 0x4b, 3, 4]

/** 现场基线：`estimate()` 报「健康」（3.7GB 总量 / 已用 45.6MB）—— 它通过不构成写盘安全的证据。 */
const fieldEstimate = () => ({
  estimate: async () => ({ usage: 45_621_038, quota: 3_736_869_273 }),
})

/** 装 / 拆一个 `navigator.storage`；`undefined` = 整个对象都没有（老 WebView / 隐私模式）。 */
const withStorage = (storage) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: storage === undefined ? {} : { storage },
    configurable: true,
    writable: true,
  })
  return () => {
    if (saved === undefined) {
      delete globalThis.navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', saved)
    }
  }
}

const reset = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importError = undefined
  globalThis.__importCount = 1
  globalThis.__native = undefined
  quota.setNativeFreeBytesReader(undefined)
  quota.setImportSpaceNoteSink(undefined)
}

const toByteLength = (data) => {
  if (data == null) return 0
  if (typeof data === 'string') return data.length
  if (typeof data.byteLength === 'number') return data.byteLength
  return 0
}

/** 原生桥：记下每次请求与真正交给 JS 的字节数（用来断言「下到第几块就停了」）。 */
const useNative = (get) => {
  const native = { native: true, calls: [], bytes: 0 }
  native.get = (options) => {
    const response = get(options)
    if (response instanceof Promise) {
      return response.then((value) => {
        native.bytes += toByteLength(value?.data)
        return value
      })
    }
    native.bytes += toByteLength(response?.data)
    return response
  }
  globalThis.__native = native
  return native
}

const zipBlock = (size) => {
  const block = new Uint8Array(size)
  block.set(ZIP_HEAD, 0)
  return block
}

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

/** 206 + `Content-Range` 声明整包体积，只回 `bodyBytes` 个真字节（绝不真造 20MB 缓冲）。 */
const serveDeclared = (url, declared, bodyBytes = 4096) => {
  const block = zipBlock(bodyBytes)
  return useNative(() => ({
    status: 206,
    url,
    headers: {
      'Content-Range': `bytes 0-${bodyBytes - 1}/${declared}`,
      'Content-Length': String(bodyBytes),
    },
    data: block.buffer,
  }))
}

/**
 * 完整可下载的包：按 Range 真实回字节，越界回 416（真实链路的收尾方式）。
 * 内容不是合法归档也无所谓 —— `../backup.js` 替身只记录「交出去多大的 File」。
 */
const serveBuffer = (url, size) => {
  const full = zipBlock(size)
  return useNative((options) => {
    const { from, to } = rangeOf(options)
    if (from >= size) {
      return { status: 416, url, headers: {}, data: null }
    }
    const end = to < 0 ? size : Math.min(to + 1, size)
    const slice = full.slice(from, end)
    return {
      status: 206,
      url,
      headers: {
        'Content-Range': `bytes ${from}-${end - 1}/${size}`,
        'Content-Length': String(end - from),
      },
      data: slice.buffer,
    }
  })
}

const runImport = (url, options = {}) =>
  importHistoryFromUrl(url, {
    downloadStallMs: 30_000,
    heartbeatIntervalMs: 1_000,
    ...options,
  }).then(
    () => null,
    (reason) => reason
  )

// ---------------------------------------------------------------- U1 可信余量不够

test('U1 原生余量 6MB / 声明 20MB → 首块就拒绝，不组装 File、不进解析', async (t) => {
  reset()
  t.after(() => quota.setNativeFreeBytesReader(undefined))
  quota.setNativeFreeBytesReader(async () => 6 * MB)
  t.after(withStorage(fieldEstimate()))
  const url = urlOf('u1')
  const declared = 20 * MB
  const native = serveDeclared(url, declared)

  const error = await runImport(url)
  console.log(
    `    -> key=${error?.key} params=${JSON.stringify(error?.params ?? null)} requests=${native.calls.length} bytes=${native.bytes}`
  )

  assert.equal(error?.name, 'BackupError', `必须拒绝，实际 ${error === null ? '导入成功' : error.name}`)
  assert.equal(
    error.key,
    'historyImportInsufficientSpace',
    `可信余量明显不够要报「空间不足」，实际 ${error.key}`
  )
  assert.equal(error.params?.free, formatImportBytes(6 * MB), '文案里的「当前可用」必须是原生读数')
  assert.ok(error.params?.need !== undefined && error.params?.short !== undefined, '三个数字都要给')
  assert.equal(native.calls.length, 1, '首块就终态：不许继续发 Range 请求把包下完')
  assert.ok(native.bytes <= 4096, `最多只应拿到首块，实际 ${native.bytes} 字节`)
  assert.deepEqual(globalThis.__imported, [], '不许组装 File 进解析/导入阶段')
})

// ---------------------------------------------------------------- U2 空间未知 + 大包

test('U2 空间未知 + 声明 20MB → 拒绝，文案说「暂时无法确认」，不说「空间不足」', async (t) => {
  reset()
  t.after(() => quota.setNativeFreeBytesReader(undefined))
  quota.setNativeFreeBytesReader(async () => null)
  t.after(withStorage(undefined))
  const url = urlOf('u2')
  const native = serveDeclared(url, 20 * MB)

  const error = await runImport(url)
  console.log(`    -> key=${error?.key} params=${JSON.stringify(error?.params ?? null)}`)

  assert.notEqual(error, null, '大包 + 空间无法确认 → 必须拒绝（不许赌整库）')
  assert.equal(
    error.key,
    'historyImportSpaceUnverifiable',
    `要能和「空间不足」分开，实际 ${error.key}`
  )
  // 与 importArchive 那一档同义：`size` = 判定里的 need（20MB × 1.25 × 2 = 50MB）
  assert.equal(
    error.params?.size,
    formatImportBytes(Math.ceil(20 * MB * 1.25 * 2)),
    '文案要说出这次大约要多少（与本地导入同一口径）'
  )
  assert.equal(native.calls.length, 1, '拒绝发生在下载循环里，首块即终态')
  assert.deepEqual(globalThis.__imported, [], '不许组装 File 进解析/导入阶段')

  // 用户看到的那句话来自 i18n（替身只带 key，所以直接钉文案本体）
  for (const copy of [zh.historyImportSpaceUnverifiable, en.historyImportSpaceUnverifiable]) {
    assert.doesNotMatch(copy, /空间不足|空间不够|还差|not enough space/i, '读不到读数 ≠ 没空间，不许谎报')
    assert.match(copy, /无法确认|restart|重启|can't confirm/i, '要明说「确认不了」并给一个能照做的动作')
  }
})

// ---------------------------------------------------------------- U3 空间未知 + 小包（不许误杀）

test('U3 空间未知 + 小包 → 照常导入（老 WebView 不许完全不能从链接导入）', async (t) => {
  reset()
  t.after(() => quota.setNativeFreeBytesReader(undefined))
  quota.setNativeFreeBytesReader(async () => null)
  t.after(withStorage(undefined))
  const url = urlOf('u3')
  const declared = 8 * MB
  const native = serveBuffer(url, declared)

  const error = await runImport(url)
  console.log(
    `    -> imported=${JSON.stringify(globalThis.__imported)} requests=${native.calls.length} error=${error?.key ?? null}`
  )

  assert.equal(error, null, `小包不许被「估不出来」拦住（实际 ${error?.key ?? error?.name}）`)
  assert.equal(globalThis.__imported.length, 1, '小包必须真的走到导入')
  assert.equal(globalThis.__imported[0].size, declared, '交出去的还是整包（没被截断）')
})

// ---------------------------------------------------------------- U4 余量充足（不许误拦）

test('U4 原生余量 1GB → 照常导入，gate 不误拦', async (t) => {
  reset()
  t.after(() => quota.setNativeFreeBytesReader(undefined))
  quota.setNativeFreeBytesReader(async () => 1024 * MB)
  t.after(withStorage(fieldEstimate()))
  const url = urlOf('u4')
  const declared = 20 * MB
  serveBuffer(url, declared)

  const error = await runImport(url)
  console.log(`    -> imported=${JSON.stringify(globalThis.__imported)} error=${error?.key ?? null}`)

  assert.equal(error, null, `余量充足时不许拦（实际 ${error?.key ?? error?.name}）`)
  assert.equal(globalThis.__imported.length, 1, '必须走到导入')
})

// ---------------------------------------------------------------- 顺序：体积上限先判

test('U5 声明超限 + 空间够 → 仍然是「文件过大」先拒（顺序不许被空间闸抢走）', async (t) => {
  reset()
  t.after(() => quota.setNativeFreeBytesReader(undefined))
  quota.setNativeFreeBytesReader(async () => 8 * 1024 * MB)
  t.after(withStorage(fieldEstimate()))
  const url = urlOf('u5')
  serveDeclared(url, 501 * MB)

  const error = await runImport(url)
  console.log(`    -> key=${error?.key}`)

  assert.equal(error?.key, 'historyImportUrlTooLarge', `体积上限必须仍然是第一道（实际 ${error?.key}）`)
})

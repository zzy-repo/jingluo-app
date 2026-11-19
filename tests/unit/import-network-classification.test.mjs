// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 导入失败的网络分类必须把「离线」与「永久不可用」分开处理——issue #154。
//
// 现状（修复前）：
// - `isUnreachable` / `isStreamBroken` 都是**错误串白名单**匹配，`navigator.onLine` 只在
//   `isUnreachable` 分支里被顺带读一次。真离线时 WebView 抛的是 `TypeError: Failed to fetch`，
//   与「端口被禁」长得一模一样 → 明明手机没网，却报「网络异常，请检查网络连接后重试」。
// - 永久不可用的地址（`net::ERR_UNSAFE_PORT`、非法协议）被当成可重试的瞬时故障，白等两轮重试。
//
// 本层只替换 Capacitor 原生桥 / diagnostics / backup；urlImport 的真实分块、看门狗、
// 重试与分类原样运行。断言只看用户能看见的结果：终态错误码 + 真的发了几次请求。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fixtureUrl, installTsResolve, loadTsModule, moduleUrl } from '../helpers/dom-env.mjs'

// 装配（`.js→.ts` + 原生桥替身）走 tests/helpers/dom-env.mjs 的公共入口（#366）：
// 这段以前是本文件里手抄的 45 行样板，90 个 L0 文件各有一份。
// 上限常量（issue #34）和失败分档（issue #111）用**真模块**：本层断言的就是它们的判断结果，
// 换成桩就什么都没测到；只有原生桥 / 诊断 / 备份这三样换替身。
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

const { importHistoryFromUrl } = await loadTsModule('src/services/chat/history/urlImport.ts')

/** 每个用例用自己的链接：续传点按 URL 隔离，用例之间不会互相污染。 */
const URL_OFFLINE = 'https://obs.example.test/net-offline.zip'
const URL_UNSAFE_PORT = 'https://obs.example.test/net-unsafe-port.zip'
const URL_TRANSIENT = 'https://obs.example.test/net-transient.zip'
const URL_TIMEOUT = 'https://obs.example.test/net-timeout.zip'

/** 合法 ZIP 头（urlImport 会校验 PK\\x03\\x04），其余字节填充，保证长度真实。 */
const zipBytes = (size) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x50, 0x4b, 3, 4], 0)
  for (let index = 4; index < size; index += 1) {
    bytes[index] = index % 251
  }
  return bytes
}

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

/**
 * 原生桥：每次请求都直接抛指定的错误。
 * `calls` 由测试替身 capacitor.mjs 自己 push（一次请求一条），
 * 所以这里的 get 只管失败，**不要**再往里 push —— 否则条数会翻倍。
 */
const useFailingNative = (makeError) => {
  const native = { native: true, calls: [], get: () => Promise.reject(makeError()) }
  globalThis.__native = native
  return native
}

/** 装一个假的 navigator.onLine，用完（finally）恢复原样，避免污染同进程其它用例。 */
const withOnLine = async (onLine, run) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine, connection: undefined },
    configurable: true,
    writable: true,
  })
  try {
    return await run()
  } finally {
    if (descriptor === undefined) {
      delete globalThis.navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', descriptor)
    }
  }
}

/** 起一次导入，返回终态错误（成功则为 null）。 */
const startImport = async (url, options = {}) => {
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

test('① TypeError: Failed to fetch + navigator.onLine=false → 判「网络已断开」（修复前报网络异常）', async () => {
  resetEnv()
  const source = zipBytes(4 * 1024)
  const native = useFailingNative(() => new TypeError('Failed to fetch'))

  await withOnLine(false, async () => {
    const { error } = await startImport(URL_OFFLINE)
    console.log(
      `  离线：终态 ${error?.key ?? 'null'}、请求 ${native.calls.length} 次、包体 ${source.length}B`
    )
    assert.equal(
      error?.key,
      'historyImportUrlOffline',
      `navigator.onLine === false 时不必等错误串匹配，必须直接判「网络已断开」（实际 ${error?.key ?? 'null'}）`
    )
    // 判离线不等于砍掉重试：断网恢复后同一次导入仍应能续上
    assert.equal(native.calls.length, 2, '瞬时失败仍要重试（这里是 1 次上限 = 共 2 次请求）')
    const failures = records('import_error')
    assert.ok(failures.length >= 1, '失败必须留下 import_error 记录')
    assert.equal(failures[0].fields.reason, 'offline', '诊断里的 reason 必须写 offline，便于回查')
  })
})

test('② net::ERR_UNSAFE_PORT（永久不可用）→ 不重试（修复前会重试 2 次）', async () => {
  resetEnv()
  const native = useFailingNative(() => new TypeError('net::ERR_UNSAFE_PORT'))

  await withOnLine(true, async () => {
    const { error } = await startImport(URL_UNSAFE_PORT)
    console.log(`  禁用端口：终态 ${error?.key ?? 'null'}、请求 ${native.calls.length} 次`)
    assert.equal(
      native.calls.length,
      1,
      `永久不可用的地址不该按可重试网络故障反复重试（实际请求 ${native.calls.length} 次）`
    )
    assert.equal(
      error?.key,
      'historyImportUrlInvalid',
      `文案不能再说「请检查网络连接后重试」这类可重试的错误（实际 ${error?.key ?? 'null'}）`
    )
  })
})

test('③ 瞬时失败（在线）→ 仍按「网络异常」重试 2 次（放宽分类不许把重试删掉）', async () => {
  resetEnv()
  const native = useFailingNative(() => new TypeError('Failed to fetch'))

  await withOnLine(true, async () => {
    const { error } = await startImport(URL_TRANSIENT)
    console.log(`  瞬时：终态 ${error?.key ?? 'null'}、请求 ${native.calls.length} 次`)
    assert.equal(error?.key, 'historyImportUrlNetwork', `在线时的通用失败仍报网络异常（实际 ${error?.key ?? 'null'}）`)
    assert.equal(native.calls.length, 2, '在线瞬时错误必须重试')
  })
})

test('④ 读超时 → 仍重试并报「下载超时」（不是离线、也不是永久失败）', async () => {
  resetEnv()
  const native = useFailingNative(() => new Error('timeout of 12000ms exceeded'))

  await withOnLine(true, async () => {
    const { error } = await startImport(URL_TIMEOUT)
    console.log(`  超时：终态 ${error?.key ?? 'null'}、请求 ${native.calls.length} 次`)
    assert.equal(error?.key, 'historyImportUrlTimeout', `超时必须保持既有分类（实际 ${error?.key ?? 'null'}）`)
    assert.equal(native.calls.length, 2, '超时属于瞬时错误，必须重试')
  })
})

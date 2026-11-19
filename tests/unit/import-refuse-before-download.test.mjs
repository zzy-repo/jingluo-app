// [layer: unit | dependencies: none | no build, browser, network or Android]  Issue #195
//
// 修复对象（issue #195）：导入 200MB 归档时「先下满 209,715,200 字节再在读阶段失败」，
// 并且把 WebView 的英文 DOMException 原文直接摆到用户面前：
//   「Import from link failed: The requested file could not be read, typically due to
//    permission problems that have occurred after a reference to a file was acquired.」
//
// 两条契约：
//   甲、**下载前就拒绝**：响应头一旦给出整包体积（206 的 Content-Range / 200 的 Content-Length）
//       就与上限比较，超限当场终态，不再继续发块、也不先把包体解成字节；提示里要同时出现
//       「体积上限」与「实测体积」。服务端不给长度时行为完全不变（不许误拒小包）。
//   乙、**不再漏英文原文**：File / FileReader / Blob 的读取失败一律映射成本地化文案，
//       原始 name / message 只留在诊断日志与 console。
//
// 为什么这一层够用：这里只替换 Capacitor 原生桥、diagnostics、backup，
// urlImport.ts 的真实下载循环（分块、Range、total 判定、超限分支）与真实的
// importFailure.ts 分类函数原样运行；不分配任何 200MB 缓冲区，「声称很大」即可复现。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href

const STUBS = {
  '@capacitor/core': 'capacitor.mjs',
  '../../diagnostics/collector.js': 'collector.mjs',
  // 唯一与其它层不同的替身：可以在「解析归档」这一步抛出读取异常（模拟 FileReader 的 DOMException）
  '../backup.js': 'backup-throwable.mjs',
  './errors.js': 'errors.mjs',
}

/** 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`。 */
const asTypescript = (specifier, parentURL) => {
  if (!parentURL || !specifier.startsWith('.') || !specifier.endsWith('.js')) {
    return null
  }
  const target = fileURLToPath(new URL(specifier, parentURL)).replace(/\.js$/, '.ts')
  return existsSync(target) ? pathToFileURL(target).href : null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const target = STUBS[specifier]
    if (target !== undefined) {
      return { url: stub(target), shortCircuit: true }
    }
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { importHistoryFromUrl, MAX_ARCHIVE_BYTES } = await import(
  '../../src/services/chat/history/urlImport.ts'
)
const { isArchiveReadFailure } = await import('../../src/services/chat/history/importFailure.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const MB = 1024 * 1024
const DEFAULT_LIMIT = 200 * 1024 * 1024
const URL_OK = 'https://obs.example.test/deepseek_data-2026-11-01.zip'
const ZIP_HEAD = [0x50, 0x4b, 3, 4]
const HAN = /[\u4e00-\u9fff]/

const reset = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__importError = undefined
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)

/** 原生桥：记下每次请求的 Range 和真实交给 JS 的字节数（用来断言「到底下了多少」）。 */
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

const toByteLength = (data) => {
  if (data == null) return 0
  if (typeof data === 'string') return data.length
  if (typeof data.byteLength === 'number') return data.byteLength
  return 0
}

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

const zipBlock = (size) => {
  const block = new Uint8Array(size)
  block.set(ZIP_HEAD, 0)
  return block
}

/** 206 + Content-Range 声明整包 total，只回 bodyBytes 个真字节（绝不真造大包）。 */
const serveDeclared = (declared, bodyBytes = 4096) => {
  const block = zipBlock(bodyBytes)
  return useNative(() => ({
    status: 206,
    url: URL_OK,
    headers: {
      'Content-Range': `bytes 0-${bodyBytes - 1}/${declared}`,
      'Content-Length': String(bodyBytes),
    },
    data: block.buffer,
  }))
}

/** 服务端完全不给长度：首块给 size 字节，之后收敛成空块（既有行为）。 */
const serveUnknownLength = (size = 4096) => {
  const block = zipBlock(size)
  return useNative((options) => {
    const { from } = rangeOf(options)
    return from === 0
      ? { status: 206, url: URL_OK, headers: {}, data: block.buffer }
      : { status: 206, url: URL_OK, headers: {}, data: new ArrayBuffer(0) }
  })
}

const runImport = async (options = {}) =>
  importHistoryFromUrl(URL_OK, {
    downloadStallMs: 30_000,
    heartbeatIntervalMs: 1_000,
    ...options,
  }).then(
    () => null,
    (reason) => reason
  )

test('① 响应头声明超限（206 Content-Range）→ 首块即终态，不再往下下载', async () => {
  reset()
  const declared = DEFAULT_LIMIT + 1
  const native = serveDeclared(declared)
  const error = await runImport()
  console.log(
    `    -> key=${error?.key} params=${JSON.stringify(error?.params ?? null)} requests=${native.calls.length} bytes=${native.bytes}`
  )

  assert.equal(error?.name, 'BackupError', `超限必须给出可读的终态，实际 ${error?.name ?? 'success'}`)
  assert.equal(error.key, 'historyImportUrlTooLarge', '超限仍是「文件过大」这一档，不能悄悄变成别的失败')
  assert.equal(error.params?.size, MAX_ARCHIVE_BYTES / MB, '提示里必须有体积上限')
  assert.equal(
    error.params?.actual,
    '200.0MB',
    '提示里还必须有实测体积（用户得知道自己那个包到底多大）'
  )
  assert.equal(native.calls.length, 1, '超限必须首块就拒绝，不许继续发包')
  assert.ok(native.bytes <= 4096, `超限时最多只应拿到首块，实际 ${native.bytes} 字节`)
  assert.deepEqual(globalThis.__imported, [], '超限不能进入解析/导入阶段')
  assert.equal(records('import_error').length, 1, '超限拒绝必须落一条失败日志')
})

test('①b 服务端忽略 Range 回 200 整包：先看 Content-Length，绝不解包体', async () => {
  reset()
  // 包体故意不是 base64：只要代码「先解包体再看头」，这里就会抛出 InvalidCharacterError，
  // 从而把缺陷暴露成一条与体积无关的怪错（这正是真机上的顺序问题）。
  const native = useNative(() => ({
    status: 200,
    url: URL_OK,
    headers: { 'Content-Length': String(DEFAULT_LIMIT + 1) },
    data: '@@@ not base64 @@@',
  }))
  const error = await runImport()
  console.log(`    -> key=${error?.key} params=${JSON.stringify(error?.params ?? null)} requests=${native.calls.length}`)

  assert.equal(
    error?.key,
    'historyImportUrlTooLarge',
    `必须按响应头先判体积，实际 ${error?.key ?? `${error?.name}: ${error?.message}`}`
  )
  assert.equal(error.params?.actual, '200.0MB')
  assert.equal(native.calls.length, 1, '不许为「确认体积」再发请求，也不许继续下')
  assert.deepEqual(globalThis.__imported, [], '不许进到解析阶段')
})

test('② 服务端不给 Content-Length / Content-Range → 行为不变，小包照常导入', async () => {
  reset()
  const native = serveUnknownLength(4096)
  const count = await importHistoryFromUrl(URL_OK, {
    downloadStallMs: 30_000,
    heartbeatIntervalMs: 1_000,
  }).then(
    (value) => value,
    (reason) => reason
  )
  console.log(
    `    -> count=${count} requests=${native.calls.length} imported=${JSON.stringify(globalThis.__imported)}`
  )

  assert.equal(count, 1, `没有长度信息的小包必须照常导入，实际 ${count?.key ?? count?.name ?? 'success'}`)
  assert.equal(globalThis.__imported.length, 1, '必须走到解析/导入阶段')
  assert.equal(globalThis.__imported[0].size, 4096, '传给解析的字节数必须就是下到的字节数')
  assert.equal(records('import_error').length, 0, '正常导入不能有失败日志')
})

test('③ 读取阶段的 DOMException → 本地化文案，英文原文只进诊断与 console', async () => {
  reset()
  serveUnknownLength(4096)
  const rawName = 'NotReadableError'
  const rawMessage =
    'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.'
  globalThis.__importError = new DOMException(rawMessage, rawName)
  const error = await runImport()
  console.log(`    -> key=${error?.key} params=${JSON.stringify(error?.params ?? null)}`)

  assert.equal(
    error?.name,
    'BackupError',
    `读取失败必须收敛成可控错误，实际 ${error?.name}: ${error?.message}`
  )
  assert.equal(error.key, 'historyImportReadFailed', '读取失败要单独一档，不能落回「导入失败：{英文原文}」')

  const zhCopy = zh[error.key]
  const enCopy = en[error.key]
  console.log(`    -> zh: ${zhCopy}`)
  console.log(`    -> en: ${enCopy}`)

  assert.equal(typeof zhCopy, 'string', `zh 字典缺少 ${error.key}`)
  assert.equal(typeof enCopy, 'string', `en 字典缺少 ${error.key}`)
  assert.ok(HAN.test(zhCopy), '中文界面必须是中文文案')
  assert.equal(/could not be read/i.test(zhCopy), false, '中文文案不许出现英文 DOMException 原文')
  assert.equal(zhCopy.includes('{'), false, '文案里的占位符必须都已替换')
  assert.equal(HAN.test(enCopy), false, '英文文案不许混中文')
  assert.equal(/could not be read/i.test(enCopy), false, '英文文案也不该照搬原文（对用户没有可操作信息）')

  // 原文不能丢：诊断日志里必须留着，出问题还能查
  const dumped = JSON.stringify(records('import_error'))
  assert.ok(dumped.includes(rawName), `诊断里要留下原始 name，实际记录：${dumped}`)
  assert.ok(dumped.includes('could not be read'), '诊断里要留下原始 message')
  assert.equal(globalThis.__imported.length, 1, '读取失败发生在「归档已下完」之后，必须先走到解析阶段')
})

test('④ 纯函数：读取类 DOMException 才归为「读取失败」，网络类错误不许被吞掉', async () => {
  const readFailure = new DOMException(
    'The requested file could not be read, typically due to permission problems.',
    'NotReadableError'
  )
  assert.equal(isArchiveReadFailure(readFailure), true, 'FileReader 的 NotReadableError 就是读取失败')
  assert.equal(isArchiveReadFailure({ name: 'NotReadableError', message: '' }), true, '非 Error 形状也要认')
  assert.equal(
    isArchiveReadFailure(new Error("Failed to execute 'arrayBuffer' on 'Blob': The blob has been closed.")),
    true,
    '纯 message 形态（WebView 只留文本时）也要认出来'
  )
  assert.equal(
    isArchiveReadFailure(
      new Error('java.net.UnknownHostException: Unable to resolve host "obs.example.test"')
    ),
    false,
    '断网必须继续走网络分档，不能被当成读取失败'
  )
  assert.equal(
    isArchiveReadFailure(new Error('java.net.ConnectException: Connection refused')),
    false,
    '连接被拒合同样不能被吞成读取失败'
  )
  assert.equal(
    isArchiveReadFailure(new DOMException('The operation was aborted.', 'AbortError')),
    false,
    '取消不是读取失败'
  )
  assert.equal(isArchiveReadFailure(undefined), false)
  assert.equal(isArchiveReadFailure('something else'), false)
})

test('⑤ 两条文案 zh/en 都齐、占位符一致（切英文不许渲染出 {actual}）', () => {
  const slots = (text) => [...new Set(String(text).match(/\{(\w+)\}/g) ?? [])].sort()
  for (const key of ['historyImportUrlTooLarge', 'historyImportReadFailed']) {
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`)
    assert.deepEqual(slots(en[key]), slots(zh[key]), `${key} 的占位符两侧不一致`)
    assert.equal(String(zh[key]).trim() === '', false, `${key} 不许是空文案`)
    assert.equal(String(en[key]).trim() === '', false, `${key} 不许是空文案`)
    console.log(`    -> ${key} zh=${zh[key]}`)
    console.log(`    -> ${key} en=${en[key]}`)
  }
  // 上限那条必须同时说清「上限」和「实测」
  assert.ok(zh.historyImportUrlTooLarge.includes('{size}'), '上限要出现在文案里')
  assert.ok(zh.historyImportUrlTooLarge.includes('{actual}'), '实测体积要出现在文案里')
})

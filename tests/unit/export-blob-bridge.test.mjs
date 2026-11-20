// [layer: unit | 历史归档 ZIP 的落盘出口：原生二进制分块 + Web 下载，注入替身，无设备]
//
// 这一层守的是「导出真的产出文件」这件事的两条腿（Issue #307）：
//   [1] Android：SAF 面板 + 二进制分块，字节必须逐位还原，取消/失败都不能返回 saved；
//   [2] Web：`<a download>` 锚点下载，能力缺失时必须抛错而不是静默什么都不做；
//   [3] 原生兜底上限与导入上限是同一个数（Java 只是兜底，权威判断在 TS 侧，见 #336）。
import { registerHooks } from 'node:module'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export const Capacitor = { isNativePlatform: () => globalThis.__native === true }; export const registerPlugin = () => globalThis.__bridge;"
        )}`,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

const calls = []
let startResult = { id: 'job' }
let finishResult = { status: 'saved', name: 'deepseek_data-2026-11-19.zip' }
let failAt = null
globalThis.__native = true
globalThis.__bridge = {
  start: async (options) => {
    calls.push(['start', options])
    if (failAt === 'start') throw Object.assign(new Error('boom'), { code: 'START_FAILED' })
    return startResult
  },
  writeChunk: async (options) => { calls.push(['chunk', options]) },
  writeBinaryChunk: async (options) => {
    calls.push(['binary', options])
    if (failAt === 'write') throw Object.assign(new Error('写入归档失败'), { code: 'WRITE_FAILED' })
  },
  finish: async () => { calls.push(['finish']); return finishResult },
  abort: async () => { calls.push(['abort']) },
}

const { saveBlobFile, saveBinary } = await import('../../src/services/exportText.ts')

/** 二进制负载：跨多个 48KiB 分块边界，且含 0x00 / 0xff（base64 往返最容易出错的字节）。 */
const payload = (size) => {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251
  bytes[0] = 0xff
  bytes[1] = 0x00
  return bytes
}

const reset = () => { calls.length = 0; failAt = null; startResult = { id: 'job' }; finishResult = { status: 'saved', name: 'deepseek_data-2026-11-19.zip' } }

test('二进制导出：按 48KiB 分块、每块 base64、字节逐位还原，finish 交回落盘文件名', async () => {
  reset()
  const bytes = payload(48 * 1024 * 2 + 777)
  const result = await saveBinary({
    filename: 'deepseek_data-2026-11-19.zip',
    mimeType: 'application/zip',
    blob: new Blob([bytes]),
  })
  assert.deepEqual(result, { status: 'saved', name: 'deepseek_data-2026-11-19.zip' })
  assert.deepEqual(calls.map(([kind]) => kind), ['start', 'binary', 'binary', 'binary', 'finish'])
  assert.equal(calls[0][1].binary, true)
  assert.equal(calls[0][1].mimeType, 'application/zip')
  const joined = Buffer.concat(calls.filter(([kind]) => kind === 'binary').map(([, options]) => Buffer.from(options.data, 'base64')))
  assert.equal(joined.length, bytes.length)
  assert.deepEqual(joined, Buffer.from(bytes))
})

test('用户在选择位置的面板上取消：返回 cancelled，不发字节、不 finish', async () => {
  reset()
  startResult = { status: 'cancelled' }
  assert.deepEqual(
    await saveBinary({ filename: 'a.zip', mimeType: 'application/zip', blob: new Blob([payload(10)]) }),
    { status: 'cancelled' }
  )
  assert.deepEqual(calls.map(([kind]) => kind), ['start'])
})

test('写盘失败：abort 清临时文件、错误向上抛，绝不返回 saved', async () => {
  reset()
  failAt = 'write'
  await assert.rejects(
    saveBinary({ filename: 'a.zip', mimeType: 'application/zip', blob: new Blob([payload(48 * 1024 * 2)]) }),
    /写入归档失败/
  )
  assert.deepEqual(calls.map(([kind]) => kind), ['start', 'binary', 'abort'])
})

test('Web 侧：锚点下载点击一次、文件名与 ZIP 类型一致，且不调用原生桥', async () => {
  reset()
  globalThis.__native = false
  const clicked = []
  const revoked = []
  const originalDocument = globalThis.document
  const originalUrl = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  URL.createObjectURL = (blob) => { clicked.push(['url', blob.type, blob.size]); return 'blob:fake' }
  URL.revokeObjectURL = (url) => revoked.push(url)
  globalThis.document = {
    body: { appendChild: () => {} },
    createElement: () => ({
      set href(value) { this._href = value },
      get href() { return this._href },
      download: '',
      remove: () => {},
      click() { clicked.push(['click', this.download, this._href]) },
    }),
  }
  try {
    const result = await saveBlobFile({
      filename: 'deepseek_data.zip',
      mimeType: 'application/zip',
      blob: new Blob([payload(32)], { type: 'application/zip' }),
    })
    assert.deepEqual(result, { status: 'saved', name: 'deepseek_data.zip' })
    assert.deepEqual(clicked, [
      ['url', 'application/zip', 32],
      ['click', 'deepseek_data.zip', 'blob:fake'],
    ])
    assert.equal(calls.length, 0)
  } finally {
    globalThis.__native = true
    globalThis.document = originalDocument
    URL.createObjectURL = originalUrl
    URL.revokeObjectURL = originalRevoke
  }
})

// [3] 原生兜底：Java 的 MAX_BINARY_BYTES 必须与 TS 的导入上限是同一个数，
// 且不许再出现 220MB（导出上限大于导入上限 = (200MB, 220MB] 死区）。
// 这条只钉「Java 的兜底数字没跟导入侧脱钩」，上限本身的判定口径在 #336 的用例里。
test('Java 兜底上限 = 导入上限（200MB），不许出现第二个数字', async () => {
  const { DEFAULT_MAX_IMPORT_BYTES } = await import('../../src/services/chat/history/importLimit.ts')
  const java = readFileSync(
    new URL('../../android/app/src/main/java/com/example/deepseekchat/ExportTextPlugin.java', import.meta.url),
    'utf8'
  )
  const declared = java.match(/MAX_BINARY_BYTES = (\d+)L \* 1024 \* 1024/)
  assert.ok(declared, '找不到 MAX_BINARY_BYTES 的字面量定义')
  assert.equal(
    Number(declared[1]) * 1024 * 1024,
    DEFAULT_MAX_IMPORT_BYTES,
    '原生兜底必须等于导入上限：大于它就会产出导不回来的包'
  )
  assert.equal(java.includes('220L * 1024 * 1024'), false, '不许再有 220MB 这个第二个数字')
  assert.match(java, /权威判断在 TS 侧/, '注释要写清 Java 只是兜底，权威判断在 TS 侧')
})

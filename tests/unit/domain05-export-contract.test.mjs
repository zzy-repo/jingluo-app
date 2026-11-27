// [layer: unit | 依赖: 无（纯 Node，零浏览器；IndexedDB / 原生桥只替换边界） | 耗时: <10s]
//
// 域 5 / N7：**导出器契约表 + TXT 桥子表**（docs/testing/coverage/domain-05.md §6.2 N7）。
//
// 覆盖功能点：
//   F-05-23 导出全部历史为 ZIP（zipWriter 的写法契约：顺序 / STORE / 条目名 / 确定性）
//   F-05-26 空历史（数据侧：空历史也要产出合法包，UI 置灰由 N9 断）
//   F-05-27 导出上限（ZIP32/ZIP64 硬限：65535 条目、单条目 4GiB；业务上限 200MB = 导入上限，见 A6）
//
// 关于 F-05-27 的 200MB 业务上限（#336 §3）：A4 钉「格式装不下」（ZIP32 硬限），A6 钉「导回来装不下」
// （超过导入上限就在写第一个字节之前拒）。两条不能合并：前者是格式问题，后者是往返一致性问题。
//   F-05-29 TXT 导出桥 JS 侧（取消 / 48KiB 分块 / 写失败 abort / 老内核无 TextEncoder）
//   F-05-30-ish「导出途中会话被删 → 整次失败，不产半份文件」（exportHistory 的快照语义）
//
// 关于 F-05-27（导出上限与导入对齐 200MB）：#336 §3 已把「导回来装不下」这条补上（A6 行），
// 上限不是新数字而是 DEFAULT_MAX_IMPORT_BYTES 的转出；A4 继续钉 ZIP32 硬限。三条硬限被删照样红。
//
//   node --test tests/unit/domain05-export-contract.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { png } from '../fixtures/domain05/archive.mjs'
import { installBuildDefines, installHooks } from '../fixtures/domain05/hooks.mjs'
import { expectEqual, expectMatch, expectOk, runTable } from '../fixtures/domain05/table.mjs'

const GI = 1024 * 1024 * 1024

/** 导出侧的存储边界（loadFile）+ 可切换的「会话在导出途中消失」。 */
const fakeDBSource = `
export const originals = new Map()
export const loadFile = async (id) => originals.get(id)
export const loadSession = async (id) => (globalThis.__loadSession ? globalThis.__loadSession(id) : undefined)
export const clearStaging = async () => {}
export const reportStorageError = () => () => {}
globalThis.__exportDB = { originals }
`
/** 会话列表快照：exportHistory 读 useChatStore.getState()。 */
const fakeStoreSource = `
export const state = { sessions: [], sessionCache: {} }
export const useChatStore = { getState: () => state }
export const replaceHistory = async (run) => await run()
export const importHistoryInto = async (run) => {
  await run()
  return { mode: 'overwrite', count: 0, added: 0, overwritten: 0, skipped: 0, skippedTitles: [] }
}
globalThis.__exportStore = state
`
/** 原生桥替身：Capacitor 原生平台 + ExportText 插件（SAF 三态）。 */
const fakeCapacitorSource = `
export const Capacitor = { isNativePlatform: () => true }
export const CapacitorHttp = { get: async () => ({ status: 200, headers: {}, data: null }) }
export const registerPlugin = () => globalThis.__exportBridge
`
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`

const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

installHooks((specifier, parent) => {
  // 真实 errors.ts 用了 TS 参数属性（node strip-only 不支持）：换成等价替身（保留 key / params + 真实 zh 文案）
  if (specifier === './errors.js' || specifier === './history/errors.js') {
    return errorsStub
  }
  if (specifier === '@capacitor/core') {
    return dataUrl(fakeCapacitorSource)
  }
  // diagnostics 采集层依赖 DOM / 原生桥：本层只关心「写了什么」，换成内存替身
  if (specifier === '../../diagnostics/collector.js') {
    return new URL('../fixtures/url-import-stubs/collector.mjs', import.meta.url).href
  }
  if (specifier === './db.js' && parent.endsWith('/chat/backup.ts')) {
    return dataUrl(fakeDBSource)
  }
  if (specifier === '../db.js' && parent.includes('/history/')) {
    return dataUrl(fakeDBSource)
  }
  if (specifier === './store.js' && parent.endsWith('/chat/backup.ts')) {
    return dataUrl(fakeStoreSource)
  }
  return null
})
await installBuildDefines()

// TXT 桥：exportText.ts 在**模块加载时**就 registerPlugin('ExportText')，所以桥必须在 import 之前就位
const calls = []
let mode = 'saved'
globalThis.__exportBridge = {
  start: async (options) => {
    calls.push(['start', options])
    if (mode === 'cancel-start') {
      return { status: 'cancelled' }
    }
    if (mode === 'cancel-throw') {
      throw Object.assign(new Error('cancel'), { code: 'CANCELLED' })
    }
    return { id: 'job' }
  },
  writeChunk: async (options) => {
    calls.push(['chunk', options])
    if (mode === 'write-failed') {
      throw new Error('disk full')
    }
  },
  finish: async () => {
    calls.push(['finish'])
    return { status: 'saved' }
  },
  abort: async () => {
    calls.push(['abort'])
  },
}

const { exportHistory } = await import('../../src/services/chat/backup.ts')
const { exportArchive } = await import('../../src/services/chat/history/exportArchive.ts')
const { ArchiveLimitError, ExportTooLargeError, MAX_EXPORT_BYTES, isWithinExportLimit, writeArchive } =
  await import('../../src/services/chat/history/zipWriter.ts')
const { DEFAULT_MAX_IMPORT_BYTES, maxImportMegabytes } = await import(
  '../../src/services/chat/history/importLimit.ts'
)
const { saveText } = await import('../../src/services/exportText.ts')
const db = globalThis.__exportDB
const store = globalThis.__exportStore

const T = 1_760_000_000_000

const session = ({ id, title = id, files = [] }) => ({
  id,
  title,
  createdAt: T,
  updatedAt: T,
  messages: [
    { id: 'u1', role: 'user', content: `${id} 的问题`, files, createdAt: T },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: T + 1,
      model: null,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: '回答' }],
    },
  ],
})

const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer())

/**
 * 读 ZIP 中央目录（只为本文件断言写法契约：顺序 / 方法 / 时间戳 / 名字）。
 * 导出物不带注释，EOCD 固定在结尾 22 字节。
 */
const centralDirectory = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = bytes.length - 22
  expectEqual(view.getUint32(eocd, true), 0x06054b50, 'EOCD 签名')
  const count = view.getUint16(eocd + 10, true)
  const size = view.getUint32(eocd + 12, true)
  const start = view.getUint32(eocd + 16, true)
  expectEqual(start + size, eocd, '中央目录必须紧贴 EOCD（没有注释、没有多余字节）')
  const entries = []
  let cursor = start
  for (let index = 0; index < count; index += 1) {
    expectEqual(view.getUint32(cursor, true), 0x02014b50, `第 ${index + 1} 条中央目录签名`)
    const method = view.getUint16(cursor + 10, true)
    const time = view.getUint16(cursor + 12, true)
    const date = view.getUint16(cursor + 14, true)
    const compressed = view.getUint32(cursor + 20, true)
    const uncompressed = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    entries.push({ name, method, time, date, compressed, uncompressed })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const reset = () => {
  db.originals.clear()
  store.sessions = []
  store.sessionCache = {}
  globalThis.__loadSession = undefined
}

test('N7 导出器契约表 + TXT 桥子表（F-05-23/26/27/29）', async () => {
  // ── 子表 A：导出器（ZIP）契约 ────────────────────────────────────────────
  const exporterRows = [
    {
      name: 'A1 结构契约：manifest → 会话 JSON → index → 图片，STORE 写入且字节确定（同输入两次导出完全相同）',
      async run() {
        reset()
        const bytes = png(128)
        db.originals.set('file-1', new Blob([bytes], { type: 'image/png' }))
        const sessions = [
          session({
            id: 'a',
            files: [
              { id: 'file-1', serverId: null, name: 'x.png', size: bytes.length, isImage: true, mimeType: 'image/png' },
            ],
          }),
          session({ id: 'b' }),
        ]
        const first = await blobBytes(await exportArchive(sessions))
        const second = await blobBytes(await exportArchive(sessions))
        expectEqual(
          Buffer.compare(Buffer.from(first), Buffer.from(second)),
          0,
          '同一输入两次导出的字节必须完全相同（mtime 固定 + STORE，不引入随机）'
        )
        const entries = centralDirectory(first)
        expectEqual(
          entries.map((entry) => entry.name).join(','),
          'manifest.json,chat_sessions/a.json,chat_sessions/b.json,chat_session_index.json,chat_sessions/a_files/file-1_x.png',
          '条目顺序必须与导入端约定一致'
        )
        for (const entry of entries) {
          expectEqual(entry.method, 0, `${entry.name} 必须是 STORE（不压缩）`)
          expectEqual(entry.compressed, entry.uncompressed, `${entry.name} 的压缩前后大小`)
          expectEqual(entry.date, 0x0021, `${entry.name} 的 DOS 日期必须固定（1980-01-01）`)
          expectEqual(entry.time, 0, `${entry.name} 的 DOS 时间必须固定`)
        }
      },
    },
    {
      name: 'A2 条目名契约：NFC 归一、路径分隔符归一为下划线、孤立代理项拒绝（不能悄悄变 U+FFFD）',
      async run() {
        reset()
        const decomposed = 'u\u0308' // ü 的分解写法
        const bytes = png(32)
        db.originals.set('file-2', new Blob([bytes], { type: 'image/png' }))
        const entries = centralDirectory(
          await blobBytes(
            await exportArchive([
              session({
                id: 'nfc',
                files: [
                  {
                    id: 'file-2',
                    serverId: null,
                    name: `${decomposed}/shot.png`,
                    size: bytes.length,
                    isImage: true,
                    mimeType: 'image/png',
                  },
                ],
              }),
            ])
          )
        )
        const imageEntry = entries.find((entry) => entry.name.includes('_files/'))
        expectOk(imageEntry, '图片条目必须存在')
        expectEqual(
          imageEntry.name,
          imageEntry.name.normalize('NFC'),
          '条目名必须已 NFC 归一（与读取端同一规则）'
        )
        expectEqual(
          imageEntry.name.endsWith('file-2_u\u0308_shot.png'.normalize('NFC')),
          true,
          `路径分隔符要归一为下划线并保留文件名：${imageEntry.name}`
        )

        // 孤立代理项：编码会变 U+FFFD，附件关联路径就断了 —— 必须拒绝而不是静默改写
        db.originals.set('file-3', new Blob([bytes], { type: 'image/png' }))
        const lone = await exportArchive([
          session({
            id: 'lone',
            files: [
              {
                id: 'file-3',
                serverId: null,
                name: '\uD800.png',
                size: bytes.length,
                isImage: true,
                mimeType: 'image/png',
              },
            ],
          }),
        ]).then(
          () => null,
          (error) => error
        )
        expectOk(lone, '孤立代理项必须被拒绝')
        expectMatch(String(lone.message), /Invalid history archive entry/, '拒绝原因')
      },
    },
    {
      name: 'A3 writeArchive 拒绝非法条目：空名 / 带路径穿越 / 重名（与读取端同一套规则）',
      async run() {
        const blob = new Blob(['x'])
        const cases = [
          { why: '空名', entries: [{ name: '', blob }] },
          { why: '路径穿越', entries: [{ name: 'a/../b', blob }] },
          { why: '反斜杠', entries: [{ name: 'a\\b', blob }] },
          { why: '盘符', entries: [{ name: 'C:/x', blob }] },
          { why: '重名', entries: [{ name: 'a', blob }, { name: 'a', blob }] },
        ]
        for (const item of cases) {
          const error = await writeArchive(item.entries).then(
            () => null,
            (failure) => failure
          )
          expectOk(error, `${item.why} 必须被拒绝`)
          expectMatch(String(error.message), /Invalid history archive entry/, `${item.why} 的拒绝原因`)
        }
      },
    },
    {
      name: 'A4 现有上界：65535 条目 / 单条目 4GiB → ArchiveLimitError（不分配内存、不写半个包）',
      async run() {
        const tiny = new Blob(['x'])
        const tooMany = Array.from({ length: 0xffff }, (_, index) => ({ name: `f${index}`, blob: tiny }))
        expectEqual(tooMany.length, 65535, '条目数正好撞上 ZIP32 上界')
        const manyError = await writeArchive(tooMany).then(
          () => null,
          (failure) => failure
        )
        expectOk(manyError instanceof ArchiveLimitError, '65535 个条目必须抛 ArchiveLimitError')
        expectMatch(String(manyError.message), /ZIP64/, '错误信息要说明需要 ZIP64')

        // 单条目 ≥4GiB：只「声称」大小，绝不真分配 4GiB（blob 只提供 size 与 stream）
        const giant = {
          size: 0xffffffff,
          stream: () => {
            throw new Error('不该走到这里：上界必须在写字节之前判')
          },
        }
        const sizeError = await writeArchive([{ name: 'huge.bin', blob: giant }]).then(
          () => null,
          (failure) => failure
        )
        expectOk(sizeError instanceof ArchiveLimitError, '单条目 4GiB 必须抛 ArchiveLimitError')
      },
    },
    {
      name: 'A5 exportHistory：文件名 deepseek_data-日期.zip；会话在导出途中消失 → 整次失败且不产半份文件',
      async run() {
        reset()
        store.sessions = [{ id: 's2', title: 's2', createdAt: T, updatedAt: T }]
        store.sessionCache = {}
        globalThis.__loadSession = async (id) => (id === 's2' ? session({ id: 's2' }) : undefined)
        const exported = await exportHistory()
        expectMatch(exported.name, /^deepseek_data-\d{4}-\d{2}-\d{2}\.zip$/, '文件名格式')
        expectOk(exported.blob.size > 0, '产物不能为空')
        expectEqual(
          (centralDirectory(await blobBytes(exported.blob))[1] ?? {}).name,
          'chat_sessions/s2.json',
          '导出内容来自列表快照 + 未打开会话逐条读取'
        )

        // 会话在导出途中被删（loadSession 拿不到）→ 整次导出失败，不返回半份包
        reset()
        store.sessions = [{ id: 'gone', title: 'gone', createdAt: T, updatedAt: T }]
        globalThis.__loadSession = async () => undefined
        const failure = await exportHistory().then(
          () => null,
          (error) => error
        )
        expectOk(failure, '会话消失时必须整次失败')
        expectMatch(String(failure.message), /History session disappeared during export: gone/, '失败原因要能定位')

        // 空历史不是错误：产出一个只有 manifest + index 的合法包
        reset()
        const empty = await exportHistory()
        expectEqual(
          centralDirectory(await blobBytes(empty.blob)).map((entry) => entry.name).join(','),
          'manifest.json,chat_session_index.json',
          '空历史的包结构'
        )
      },
    },
    {
      name: 'A6 业务上限 = 导入上限（500MiB）：超限在写第一个字节之前拒（ExportTooLargeError），零字节写出、零次保存面板',
      async run() {
        // 只「声称」体积，绝不真分配：blob 没有任何字节可读，stream 一被碰就炸。
        let streamCalls = 0
        const claimed = {
          size: MAX_EXPORT_BYTES + 1024 * 1024,
          stream: () => {
            streamCalls += 1
            throw new Error('不该走到这里：上限必须在写字节之前判')
          },
        }
        const error = await writeArchive([{ name: 'big.json', blob: claimed }]).then(
          () => null,
          (failure) => failure
        )
        expectOk(error instanceof ExportTooLargeError, '超上限必须抛 ExportTooLargeError')
        expectEqual(error.expectedBytes > MAX_EXPORT_BYTES, true, '错误要带上算准的实测体积')
        expectEqual(error.limitBytes, MAX_EXPORT_BYTES, '错误要带上真正生效的上限')
        expectMatch(
          String(error.message),
          new RegExp(`${maxImportMegabytes()}MB export limit`),
          '错误信息要说清上限（数字来自常量，不手抄）'
        )
        expectEqual(streamCalls, 0, '超限时一个字节都不能写（stream 一次都不许读）')
        // 上限不是第二个数字：与导入侧那一个恒等，且比较口径同为 `<=`（等于上限能导回）。
        expectEqual(MAX_EXPORT_BYTES, DEFAULT_MAX_IMPORT_BYTES, '导出上限必须等于导入上限')
        expectEqual(isWithinExportLimit(MAX_EXPORT_BYTES), true, '等于上限要放行')
        expectEqual(isWithinExportLimit(MAX_EXPORT_BYTES + 1), false, '多一个字节就要拒')
      },
    },
  ]

  // ── 子表 B：TXT 桥（JS 侧四态；原生半边需要真机，见 docs/testing/coverage/domain-05.md） ──
  const textRows = [
    {
      name: 'B1 取消（SAF 面板被取消，两种原生返回形态）→ cancelled，且不发正文、不 finish',
      async run() {
        for (const cancelMode of ['cancel-start', 'cancel-throw']) {
          mode = cancelMode
          calls.length = 0
          const status = await saveText({ filename: 'history.txt', mimeType: 'text/plain', text: '私密正文' })
          expectEqual(status, 'cancelled', `${cancelMode} 的返回值`)
          expectEqual(calls.map(([kind]) => kind).join(','), 'start', `${cancelMode} 只能有 start 一次调用`)
        }
      },
    },
    {
      name: 'B2 48KiB UTF-8 分块：逐块写入后拼回原文（中文 / emoji 不切坏）',
      async run() {
        mode = 'saved'
        calls.length = 0
        const text = JSON.stringify({ logs: ['中文😀'.repeat(40_000)] })
        expectEqual(await saveText({ filename: 'history.txt', mimeType: 'text/plain', text }), 'saved', '返回值')
        const chunks = calls.filter(([kind]) => kind === 'chunk').map(([, options]) => options.data)
        expectEqual(chunks.join(''), text, '分块拼回必须与原文完全一致')
        expectOk(chunks.length > 1, `长文本必须分多块（实际 ${chunks.length} 块）`)
        expectOk(
          chunks.every((chunk) => Buffer.byteLength(chunk) <= 48 * 1024),
          '每块 UTF-8 字节数不得超过 48KiB'
        )
        expectEqual(calls.at(-1)[0], 'finish', '结尾必须是 finish')
      },
    },
    {
      name: 'B3 写失败 → abort 并抛出，绝不返回 saved（不留半份文件）',
      async run() {
        mode = 'write-failed'
        calls.length = 0
        const error = await saveText({ filename: 'history.txt', mimeType: 'text/plain', text: '{}' }).then(
          () => null,
          (failure) => failure
        )
        expectOk(error, '写失败必须抛出')
        expectMatch(String(error.message), /disk full/, '原始错误要冒出来')
        expectEqual(calls.map(([kind]) => kind).join(','), 'start,chunk,abort', '调用序列')
      },
    },
    {
      name: 'B4 老内核没有 TextEncoder 也能分块（按码点估算 UTF-8，不依赖运行时 API）',
      async run() {
        mode = 'saved'
        calls.length = 0
        const original = globalThis.TextEncoder
        globalThis.TextEncoder = undefined
        try {
          expectEqual(
            await saveText({ filename: 'history.txt', mimeType: 'text/plain', text: '中文😀' }),
            'saved',
            '返回值'
          )
        } finally {
          globalThis.TextEncoder = original
        }
        expectEqual(
          calls.filter(([kind]) => kind === 'chunk').map(([, options]) => options.data).join(''),
          '中文😀',
          '分块内容'
        )
      },
    },
  ]

  await runTable(exporterRows, (row) => row.run())
  await runTable(textRows, (row) => row.run())
})

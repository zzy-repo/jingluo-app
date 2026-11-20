// [layer: unit | 依赖: 无（纯 Node；IndexedDB / 原生桥 / diagnostics 只替换边界） | 耗时: <5s]
//
// #336：导出历史对话的 UX 收尾（三项）。本文件只钉「过程反馈 / 空历史原因 / 上限前置」，
// 不重测导出内容与 ZIP 结构（那些在 domain05-export-* 与 golden/g06 里）。
//
//   §1 进度反馈：多条会话时回调「已导出 N / 共 M」，每 20 条让出一次**宏任务**（不是微任务）
//   §2 空历史置灰：置灰必须给原因文案（中英成对），不能只是「点不动」
//   §3 上限前置：超 200MB（= 导入上限）在**写第一个字节之前**就拒，文案要说「怎么办」
//
//   node --test tests/unit/export-ux-336.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { asTypescript, installBuildDefines, placeholders, render } from '../fixtures/domain05/hooks.mjs'

const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`

// ── 边界替身：只有存储 / 列表 / 诊断三处 ─────────────────────────────────────────
const dbStub = dataUrl(`
export const originals = new Map()
export const loadFile = async (id) => originals.get(id)
export const loadSession = async (id) => (globalThis.__loadSession ? globalThis.__loadSession(id) : undefined)
export const clearStaging = async () => {}
export const reportStorageError = () => () => {}
globalThis.__uxDB = { originals }
`)

// 只替换「列表 / 替换事务」这一层；导出链路用不到导入合并（#390 的 importHistoryInto 给个不再使用的空壳）
const storeStub = dataUrl(`
export const state = { sessions: [], sessionCache: {} }
export const useChatStore = { getState: () => state }
export const replaceHistory = async (run) => await run()
export const importHistoryInto = async () => ({ sessions: 0, skipped: [], mode: 'replace' })
globalThis.__uxStore = state
`)

const collectorStub = new URL('../fixtures/url-import-stubs/collector.mjs', import.meta.url).href
const errorsStub = new URL('../fixtures/import-archive-stubs/errors.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = String(context.parentURL ?? '')
    // 只换 chat 域的 BackupError 替身（errors.ts 用了 TS 参数属性，strip-only 不支持）；api/errors.ts 是真的
    if ((specifier === './errors.js' || specifier === './history/errors.js') && !parent.includes('/api/')) {
      return { url: errorsStub, shortCircuit: true }
    }
    if (specifier === '../../diagnostics/collector.js') return { url: collectorStub, shortCircuit: true }
    if (specifier === './db.js' && parent.endsWith('/chat/backup.ts')) return { url: dbStub, shortCircuit: true }
    if (specifier === '../db.js' && parent.includes('/history/')) return { url: dbStub, shortCircuit: true }
    if (specifier === './store.js' && parent.endsWith('/chat/backup.ts')) return { url: storeStub, shortCircuit: true }
    // 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) return { url: typescript, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

await installBuildDefines()

const { exportArchive, EXPORT_YIELD_EVERY } = await import('../../src/services/chat/history/exportArchive.ts')
const { exportHistory, BackupError } = await import('../../src/services/chat/backup.ts')
const { MAX_EXPORT_BYTES } = await import('../../src/services/chat/history/zipWriter.ts')
const zh = (await import('../../src/i18n/zh.ts')).zh
const en = (await import('../../src/i18n/en.ts')).en

const store = globalThis.__uxStore
const db = globalThis.__uxDB

const T = 1_760_000_000_000

/** 最小会话：一条用户消息 + 一条回答；需要图片时给 file 里挂一个 id。 */
const makeSession = (id, files = []) => ({
  id,
  title: id,
  createdAt: T,
  updatedAt: T,
  messages: [
    { id: `${id}-u`, role: 'user', content: `${id} 的问题`, files, createdAt: T },
    {
      id: `${id}-a`,
      role: 'assistant',
      createdAt: T + 1,
      model: null,
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: '回答' }],
    },
  ],
})

const many = (count) => Array.from({ length: count }, (_, index) => makeSession(`s${index}`))

/**
 * 宏任务计数器：返回 `now()` 与 `stop()`。
 * 打包循环里只有「让出」这一个真实定时器来源（loadFile 是微任务），所以 now() 就是让出次数。
 */
/** 0 = 「下一个宏任务」。命名出来是因为它是观察通道，不是等待时长。 */
const NEXT_MACROTASK_MS = 0

/**
 * 宏任务计数器：返回 `now()` 与 `stop()`。
 *
 * 不是 sleep：没有任何一步是「等一会儿再看」。这里链式排 0ms 定时器当探针，数的是
 * 「打包循环途中到底有没有把控制权还给宏任务队列」——循环里只有这一处定时器来源
 * （`db.loadFile` 是微任务），所以 now() 就是让出次数。
 */
const macrotaskProbe = () => {
  let ticks = 0
  let live = true
  const tick = () => {
    if (!live) return
    ticks += 1
    setTimeout(tick, NEXT_MACROTASK_MS)
  }
  setTimeout(tick, NEXT_MACROTASK_MS)
  return { now: () => ticks, stop: () => { live = false } }
}

test('#336 §1 每条会话都回调「已导出 N / 共 M」，最后一条等于总数', async () => {
  const seen = []
  await exportArchive(many(3), { total: 3, onProgress: (progress) => seen.push(progress) })
  assert.deepEqual(seen, [
    { exported: 1, total: 3 },
    { exported: 2, total: 3 },
    { exported: 3, total: 3 },
  ])
})

test('#336 §1 每 20 条让出一次宏任务：让出发生在第 21 / 41 条回调之前（不是白等微任务）', async () => {
  const probe = macrotaskProbe()
  const at = []
  await exportArchive(many(45), {
    total: 45,
    onProgress: (progress) => at.push(probe.now()),
  })
  probe.stop()

  assert.equal(at.length, 45, '每条会话都要回调一次')
  assert.equal(at[19], 0, `前 ${EXPORT_YIELD_EVERY} 条不该让出，实测 ${at[19]} 次`)
  assert.equal(at[20], 1, `第 ${EXPORT_YIELD_EVERY + 1} 条之前必须让出过一次，实测 ${at[20]} 次`)
  assert.equal(at[39], 1, `第 ${EXPORT_YIELD_EVERY * 2} 条还没到第二次让出，实测 ${at[39]} 次`)
  assert.equal(at[40], 2, `第 ${EXPORT_YIELD_EVERY * 2 + 1} 条之前必须让出过两次，实测 ${at[40]} 次`)

  // 不足一批时一次都不让出：小历史不该被无谓的宏任务拖慢
  const smallProbe = macrotaskProbe()
  const seen = []
  await exportArchive(many(EXPORT_YIELD_EVERY - 1), {
    total: EXPORT_YIELD_EVERY - 1,
    onProgress: () => seen.push(smallProbe.now()),
  })
  smallProbe.stop()
  assert.deepEqual(
    seen.filter((ticks) => ticks !== 0),
    [],
    `${EXPORT_YIELD_EVERY - 1} 条不该让出宏任务`
  )
})

test('#336 §1 exportHistory 透传进度，总数取导出开始时的列表快照', async () => {
  store.sessions = [{ id: 'x', title: 'x', createdAt: T, updatedAt: T }]
  store.sessionCache = { x: makeSession('x') }
  const seen = []
  const { blob } = await exportHistory({ onProgress: (progress) => seen.push(progress) })
  assert.ok(blob.size > 0)
  assert.deepEqual(seen, [{ exported: 1, total: 1 }])

  // 不传 onProgress 时行为完全不变（导入侧 / 老调用方不受影响）
  const plain = await exportHistory()
  assert.ok(plain.blob.size > 0)
})

test('#336 §3 超 200MB：exportHistory 抛 BackupError(historyExportTooLarge)，且图片原件一个字节都没读', async () => {
  store.sessionCache = {}
  // 图片只「声称」体积，绝不真分配 205MB；原件被读就说明上限判晚了。
  const claimed = {
    size: MAX_EXPORT_BYTES + 5 * 1024 * 1024,
    stream: () => {
      throw new Error('不该走到这里：上限必须在写字节之前判')
    },
  }
  let loads = 0
  db.originals.set('file-big', claimed)
  store.sessions = [{ id: 'big', title: 'big', createdAt: T, updatedAt: T }]
  globalThis.__loadSession = async () => {
    loads += 1
    return makeSession('big', [
      { id: 'file-big', serverId: null, name: 'big.png', size: claimed.size, isImage: true, mimeType: 'image/png' },
    ])
  }
  const error = await exportHistory().then(
    () => null,
    (failure) => failure
  )
  assert.ok(error instanceof BackupError, `必须是 BackupError，实际 ${error?.name}`)
  assert.equal(error.key, 'historyExportTooLarge')
  assert.equal(error.params.size, 200, '上限数字来自导入侧那一个')
  assert.equal(error.params.actual, '205.0MB', '实测体积要说出来')
  assert.equal(loads, 1, '只该读到这一条会话（不重读）')
  assert.equal((error.params.actual, true), true)

  // 文案必须告诉用户「怎么办」，不是只说文件过大（#336 验收 3）
  const zhText = render(zh, error)
  assert.match(zhText, /205\.0MB/)
  assert.match(zhText, /200MB/)
  assert.match(zhText, /删除|删掉/, `中文文案要给可操作建议：${zhText}`)
  const enText = render(en, error)
  assert.match(enText, /205\.0MB/)
  assert.match(enText, /200MB/)
  assert.match(enText, /Delete|delete|remove/)
})

test('#336 §2 空历史的原因文案与进度文案：中英成对、占位符对齐、英文无中文', () => {
  const keys = ['historyExportEmptyNoSessions', 'historyExporting', 'historyExportProgress', 'historyExportTooLarge']
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.ok(zh[key].trim() !== '' && en[key].trim() !== '', `${key} 不能是空白`)
    assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符必须对齐`)
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `${key} 的英文里不能有中文`)
  }
  assert.deepEqual(placeholders(zh.historyExportProgress), ['exported', 'total'])
  assert.deepEqual(placeholders(zh.historyExportTooLarge), ['actual', 'size'])
})

test('#336 §2 导出那一行真的这么接线：置灰时挂原因文案、进行中挂进度、按钮文案切成「导出中…」', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../../src/components/settings/SettingsDialog.tsx', import.meta.url), 'utf8')
  // 归一空白后再断言：只在意「接了什么」，不在意换行与缩进（格式化不该把门禁弄红）。
  const flat = source.replace(/\s+/g, ' ')

  assert.match(flat, /const emptyExportStatus: Status = \{ key: 'historyExportEmptyNoSessions' \}/)
  assert.match(
    flat,
    /status=\{progress \? null : \(status \?\? \(empty \? emptyExportStatus : null\)\)\}/,
    '空历史没有自己的状态时必须把原因挂到说明位（有失败/导出中状态时状态优先）'
  )
  assert.match(flat, /disabled=\{disabled \|\| progress !== null \|\| empty\}/, '空历史与导出中都必须不可点')
  assert.match(flat, /exportHistory\(\{ onProgress \}\)/, '进度回调要真的传给导出')
  assert.match(flat, /t\(progress \? 'historyExporting' : 'exportAllDownload'\)/, '导出中按钮要换文案')
  assert.match(flat, /historyExportProgress/, '说明位下方要有「已导出 N / 共 M」')
})

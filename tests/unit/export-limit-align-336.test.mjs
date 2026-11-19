// [layer: unit | 依赖: 无（纯 Node，零浏览器 / 零 Android / 零真实大文件）| issue #336 PR-A]
//
// (200MB, 220MB] 死区：导出提示成功、导入报「文件过大」。本层钉住三件事 + 两条顺带：
//   [1] **一个数字**：MAX_EXPORT_BYTES 是 DEFAULT_MAX_IMPORT_BYTES 的转出（不是又一个 200MB），
//       且比较口径与导入侧逐字对齐（导入是 `file.size > 上限` 才拒，所以等于上限的包能导）。
//   [2] **闸在最前面**：writeArchive 算完成品字节数（expectedSize）就拒，一个字节都不写 ——
//       原生 SAF 是这之后才打开的，所以「先让用户选位置、再说文件过大」不可能再发生。
//       205MB 是**声称**的桩：只给 `size`，不分配任何内存、也不提供 stream（真去写就会 TypeError）。
//   [3] **人话**：exportHistory 抛 BackupError('historyExportTooLarge')，带上限与实际体积，
//       不是裸异常、不是 Java 那句「文件过大」。
//   [4] Java 兜底 220MB → 200MB，注释方向订正（**导出上限不能大于导入上限**，反了就产不出可导回的包）。
//   [5] 空历史置灰必须给原因（historyExportEmptyNoSessions，zh/en 成对）。
//
//   node tests/unit/export-limit-align-336.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MB = 1024 * 1024
/** 死区下沿：正好是导入上限（必须能导出、能导回） */
const LIMIT = 200 * MB
/** 死区里的一点：旧导出上限 220MB 下「导出成功」，导入必被拒 */
const OVER_LIMIT = 205 * MB

// ---------------------------------------------------------------- 模块替身
// 真实 errors.ts 用了 TS 参数属性（node 的 strip-only 模式不支持），用仓库既有的等价替身：
// key / params 原样带出，正好用来断言「失败原因是哪一条文案 + 带什么数字」。
const errorsStub = new URL('../fixtures/url-import-stubs/errors.mjs', import.meta.url).href

const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`

/** 假 store：导出只读 `sessions` 摘要 + `sessionCache`（这里全走 loadSession，等价于「未打开的会话」）。 */
const storeStub = dataModule(`
export const replaceHistory = async (run) => await run()
export const useChatStore = { getState: () => globalThis.__exportState }
`)

/** 假 db：会话与图片原件都是桩。图片只「声称」205MB，真去读会走下面那个会抛的 stream。 */
const dbStub = dataModule(`
export const loadSession = async (id) => globalThis.__sessions[id] ?? null
export const loadFile = async (id) => globalThis.__files[id]
`)

/** 假诊断：导出链路不用它，但 backup.ts 在模块顶层 import 了三条写入口。 */
const collectorStub = dataModule(`
export const record = () => {}
export const recordEvent = () => {}
export const recordAction = () => {}
export const captureStateSnapshot = async () => ({})
export const errorMeta = () => ({})
`)

/** 假 describe：只被 toArchive 用来渲染回答摘要，本层不关心正文。 */
const describeStub = dataModule(`
export const describeReply = () => ({ text: '' })
`)

const STUBS = [
  { specifier: './store.js', page: '/chat/backup.ts', url: storeStub },
  { specifier: './db.js', page: '/chat/backup.ts', url: dbStub },
  { specifier: '../db.js', page: '/history/exportArchive.ts', url: dbStub },
  { specifier: '../diagnostics/collector.js', page: '/chat/backup.ts', url: collectorStub },
  { specifier: './history/errors.js', page: '/chat/backup.ts', url: errorsStub },
  { specifier: './errors.js', page: '/history/toArchive.ts', url: errorsStub },
  { specifier: '../describe.js', page: '/history/toArchive.ts', url: describeStub },
]

/**
 * 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`；node 不会自己改后缀。
 * 这条解析规则让真实的 backup.ts / exportArchive.ts / zipWriter.ts 原样跑起来 ——
 * 「上限只有一处」只有在真实链路上才验证得到。
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
    const parent = context.parentURL ?? ''
    const stub = STUBS.find((item) => item.specifier === specifier && parent.endsWith(item.page))
    if (stub) {
      return { url: stub.url, shortCircuit: true }
    }
    const typescript = asTypescript(specifier, context.parentURL)
    if (typescript !== null) {
      return { url: typescript, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { MAX_EXPORT_BYTES, DEFAULT_MAX_IMPORT_BYTES, isWithinExportLimit, maxImportMegabytes } =
  await import('../../src/services/chat/history/importLimit.ts')
const { writeArchive, ExportTooLargeError } =
  await import('../../src/services/chat/history/zipWriter.ts')
const { exportHistory, BackupError } = await import('../../src/services/chat/backup.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** 文案里的占位符渲染（与 src/i18n/index.ts 的 createTranslate 同一套规则，够用就行）。 */
const render = (template, params) =>
  template.replace(/\{(\w+)\}/g, (placeholder, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder
  )

/**
 * 「声称」205MB 的 blob 桩：只实现 size。
 * `stream` 写成 getter 计数 —— 没被读过才算「一个字节都没写」的证据。
 */
const claimedBlob = (size) => {
  const access = { stream: 0 }
  const blob = { size, mimeType: 'image/png' }
  Object.defineProperty(blob, 'stream', {
    get() {
      access.stream += 1
      return undefined
    },
  })
  return { blob, access }
}

// ---------------------------------------------------------------- [1] 一个数字
test('上限只有一处：导出上限就是导入上限，200MB 不变', () => {
  assert.equal(DEFAULT_MAX_IMPORT_BYTES, LIMIT, '默认导入上限仍是 200MB（改默认值要有人拍板）')
  assert.equal(
    MAX_EXPORT_BYTES,
    DEFAULT_MAX_IMPORT_BYTES,
    '导出上限必须是导入上限的转出，不是第二个数字'
  )
  assert.equal(maxImportMegabytes(MAX_EXPORT_BYTES), 200, '文案里的 {size} 仍是 200')
})

test('比较口径与导入侧一致：等于上限的包能导，超一个字节就拒', () => {
  assert.equal(isWithinExportLimit(LIMIT), true, '正好 200MB：导入侧是 > 才拒，所以导出也不能拒')
  assert.equal(isWithinExportLimit(LIMIT + 1), false, '200MB + 1 字节：必须拒')
  assert.equal(isWithinExportLimit(OVER_LIMIT), false, '死区里的 205MB：必须拒')
  assert.equal(isWithinExportLimit(0), true, '空历史导出的空包当然允许')
})

// ---------------------------------------------------------------- [2] 闸在最前面
test('真实小归档：成品 blob.size 一定不超过导入上限（导得出就一定导得回）', async () => {
  const blob = await writeArchive([
    { name: 'manifest.json', blob: new Blob([JSON.stringify({ export_format_version: 3 })]) },
    { name: 'chat_sessions/s1.json', blob: new Blob([JSON.stringify({ id: 's1' })]) },
  ])
  assert.ok(blob.size > 0, '真的产出了字节')
  assert.ok(
    blob.size <= DEFAULT_MAX_IMPORT_BYTES,
    `成品 ${blob.size} 字节必须在 200MB 之内（这条断言就是死区的守门人）`
  )
})

test('205MB 桩：在写出任何字节之前就拒（原生 SAF 还没打开，所以零原生调用）', async () => {
  const { blob, access } = claimedBlob(OVER_LIMIT)
  // 只有 1 个条目：expectedSize = 205MB + 46 + 名字长度 + 46 + 名字长度 + 22
  const expected = OVER_LIMIT + 46 + 'images/big.png'.length + 46 + 'images/big.png'.length + 22
  await assert.rejects(
    () => writeArchive([{ name: 'images/big.png', blob }]),
    (error) => {
      assert.ok(error instanceof ExportTooLargeError, '必须是可识别的「超导出上限」，不是裸 Error')
      assert.equal(error.bytes, expected, '报出来的字节数就是算准的成品大小')
      return true
    }
  )
  assert.equal(access.stream, 0, '一个字节都没读：闸在写之前，用户不会先选位置再看到失败')
})

test('死区已经不存在：200MB 以内导出的包，导入侧的判据不会再命中', async () => {
  // 导入侧就是 `file.size > DEFAULT_MAX_IMPORT_BYTES` 才拒（backup.ts:importHistory）。
  // 导出侧现在保证 blob.size <= MAX_EXPORT_BYTES === DEFAULT_MAX_IMPORT_BYTES，
  // 两个不等式在同一条数轴上闭合：(200MB, 220MB] 里已经没有「导得出」的包。
  const blob = await writeArchive([{ name: 'manifest.json', blob: new Blob(['{}']) }])
  assert.equal(blob.size > DEFAULT_MAX_IMPORT_BYTES, false, '导出的包一定进得了导入的门')
  assert.ok(
    MAX_EXPORT_BYTES <= DEFAULT_MAX_IMPORT_BYTES,
    '导出上限不许大于导入上限（反了就复活死区）'
  )
})

// ---------------------------------------------------------------- [3] 人话
test('exportHistory：205MB 图片 → BackupError(historyExportTooLarge)，带「200MB / 实测」两个数', async () => {
  const { blob, access } = claimedBlob(OVER_LIMIT)
  globalThis.__sessions = {
    s1: {
      id: 's1',
      title: '带大图的会话',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: '看这张图',
          createdAt: 1,
          files: [
            {
              id: 'f1',
              serverId: null,
              name: 'big.png',
              size: OVER_LIMIT,
              isImage: true,
              mimeType: 'image/png',
            },
          ],
        },
      ],
    },
  }
  globalThis.__files = { f1: blob }
  globalThis.__exportState = {
    sessions: [{ id: 's1', title: '带大图的会话', createdAt: 1, updatedAt: 2 }],
    sessionCache: {},
  }
  const error = await exportHistory().then(
    () => null,
    (reason) => reason
  )
  assert.ok(error instanceof BackupError, `必须是可读的 BackupError，实际：${error}`)
  assert.equal(error.key, 'historyExportTooLarge', '失败原因走新增的文案 key')
  assert.equal(error.params.size, 200, '文案里的上限是 200MB（与导入一致）')
  assert.equal(error.params.actual, '205.0MB', '文案里的实测体积要说实话')
  assert.equal(access.stream, 0, '图片原件一个字节都没读：打包在算大小那一步就停了')
  assert.equal(zh.historyExportTooLarge.includes('{size}'), true, 'zh 文案带 {size} 占位符')
  assert.equal(zh.historyExportTooLarge.includes('{actual}'), true, 'zh 文案带 {actual} 占位符')
  // 用户最终看到的是「导出失败：<原因>」——两层拼起来要能读通，且两个数字都在。
  const shown = render(zh.historyExportFailed, {
    message: render(zh.historyExportTooLarge, error.params),
  })
  assert.match(shown, /200MB/)
  assert.match(shown, /205\.0MB/)
  assert.match(shown, /删减/)
})

// ---------------------------------------------------------------- [4] Java 兜底
test('Java 兜底：MAX_BINARY_BYTES 220MB → 200MB，注释方向订正为「导出上限不许大于导入上限」', () => {
  const java = read(
    '../../android/app/src/main/java/com/example/deepseekchat/ExportTextPlugin.java'
  )
  assert.match(
    java,
    /MAX_BINARY_BYTES = 200L \* 1024 \* 1024/,
    '原生兜底必须是 200MB（与导入侧同一个数）'
  )
  assert.equal(java.includes('220L * 1024 * 1024'), false, '上限字面量里不许再有 220MB')
  assert.equal(java.includes('归档超过 220MB'), false, 'reject 文案也不许再说 220MB')
  assert.match(java, /权威判断在 TS 侧/, '注释要写清权威判断在 TS 侧，Java 只是兜底')
  assert.match(java, /导出上限不能大于导入上限/, '那处写反的注释要订正方向')
  assert.match(java, /归档超过 200MB 导出上限/, 'writes 超过上限时的 reject 文案同步成 200MB')
})

// ---------------------------------------------------------------- [5] 空历史 + 文案成对
test('空历史置灰给原因：ExportHistory 用 status 显示 historyExportEmptyNoSessions', () => {
  const dialog = read('../../src/components/settings/SettingsDialog.tsx')
  const start = dialog.indexOf('const ExportHistory = (')
  assert.ok(start > 0, '找不到 ExportHistory 组件')
  const block = dialog.slice(start, dialog.indexOf('\n}\n', start))
  assert.match(
    block,
    /const emptyReason: Status = empty \? \{ key: 'historyExportEmptyNoSessions' \} : null/,
    '空历史时给一句原因（不是只把按钮置灰）'
  )
  assert.match(block, /status=\{status \?\? emptyReason\}/, '原因复用说明位；有导出状态时状态优先')
  assert.match(
    block,
    /disabled=\{disabled \|\| busy \|\| empty\}/,
    '空历史仍然置灰（本单只改「说清为什么」）'
  )
})

test('新增文案 zh / en 成对，占位符齐备，英文里没有中文', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'zh / en 键集合必须一致')
  const CJK = /[\u4e00-\u9fff]/
  for (const key of ['historyExportTooLarge', 'historyExportEmptyNoSessions']) {
    assert.equal(typeof zh[key], 'string', `zh 有 ${key}`)
    assert.equal(typeof en[key], 'string', `en 有 ${key}`)
    assert.notEqual(zh[key].trim(), '', `zh 的 ${key} 非空`)
    assert.notEqual(en[key].trim(), '', `en 的 ${key} 非空`)
    assert.equal(CJK.test(en[key]), false, `en 的 ${key} 不含中文：${JSON.stringify(en[key])}`)
    assert.notEqual(zh[key], en[key], `${key} 中英确实是两份文案`)
  }
  // 上限数字与导入侧同一个：旧文案里的 220MB 不许留
  assert.equal(
    zh.historyExportFailedTooLarge.includes('220'),
    false,
    'zh 的 Java 兜底文案不再是 220MB'
  )
  assert.equal(
    en.historyExportFailedTooLarge.includes('220'),
    false,
    'en 的 Java 兜底文案不再是 220MB'
  )
  assert.match(zh.historyExportFailedTooLarge, /200MB/)
  assert.match(en.historyExportFailedTooLarge, /200MB/)
  assert.match(zh.historyExportEmptyNoSessions, /没有可导出的对话/)
  assert.match(en.historyExportEmptyNoSessions, /no conversations to export/i)
})

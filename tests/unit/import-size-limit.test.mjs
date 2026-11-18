// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// 导入包「大小上限」（issue #34）：
//   1) 本地文件导入（src/services/chat/backup.ts）**完全没有** file.size 上限 ——
//      同一个导出包换个入口进来，就先解析再爆内存，而不是在门口被拒；
//   2) 上限只落成 urlImport.ts 里的一个 200MB 常量，另一条链路拿不到；
//   3) 上限写死，不造 200MB 数据就没法验证「超限被拒」这条分支。
// 期望：上限集中成一个**可配置**常量（默认仍是 200MB，不许偷偷改），
// 两条导入链路都在解析之前按它拒绝，且错误文案可读（{size}MB）。
//
// 这一层只替换 diagnostics / 归档解析 / store / db / Capacitor 原生桥，
// backup.ts 与 urlImport.ts 的真实代码原样运行；超限用「声称很大」的桩文件，
// 绝不真的分配 200MB（CI 里没有意义）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const stub = (name) => new URL(`../fixtures/url-import-stubs/${name}`, import.meta.url).href

const STUBS = {
  '@capacitor/core': 'capacitor.mjs',
  '../../diagnostics/collector.js': 'collector.mjs',
  '../diagnostics/collector.js': 'collector.mjs',
  './errors.js': 'errors.mjs',
  './history/errors.js': 'errors.mjs',
  './store.js': 'store.mjs',
  './db.js': 'db.mjs',
  './history/importArchive.js': 'importArchive.mjs',
  './history/zipReader.js': 'zipReader.mjs',
}

/**
 * 源码里的相对导入写的是 `.js`（NodeNext 约定），实际文件是 `.ts`；
 * node 不会自己改后缀，但 urlImport.ts 的 `../backup.js` 必须解析到**真实的** backup.ts ——
 * 「两个入口共用同一上限」这件事只有在同一条真实链路上才验证得到。
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

// 真实的 backup.ts / urlImport.ts（urlImport 里的 `../backup.js` 故意不替换，
// 两个入口共用同一个真实 importHistory，才谈得上「同一上限」）。
const { importHistory } = await import('../../src/services/chat/backup.ts')
const { importHistoryFromUrl, MAX_ARCHIVE_BYTES } =
  await import('../../src/services/chat/history/urlImport.ts')

const DEFAULT_LIMIT = 200 * 1024 * 1024
const MB = 1024 * 1024
const URL_OK = 'https://obs.example.test/deepseek_data-2026-11-01.zip'

const reset = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__staged = []
  globalThis.__imported = []
  globalThis.__native = undefined
}

const records = (kind) => globalThis.__log.records.filter((entry) => entry.kind === kind)
const stages = () => globalThis.__staged.map((entry) => entry.stage)

/**
 * 只「声称」自己很大：只提供 size/name/type，不分配任何真实字节。
 * 这正是缺陷现场——真实的 200MB 缓冲区和「声称 200MB 的空壳」对上限判断没区别。
 */
const claimedFile = (size) => ({ size, name: 'deepseek_data.zip', type: 'application/zip' })

const runImportFile = async (file, options = {}) =>
  importHistory(file, options).then(
    () => null,
    (reason) => reason
  )

/** 206 + Content-Range 声明整包 total（只回 4KB 真字节，不会真造大包）。 */
const serveDeclared = (declared) => {
  const block = new Uint8Array(4096)
  block.set([0x50, 0x4b, 3, 4], 0)
  globalThis.__native = {
    native: true,
    calls: [],
    get: () =>
      Promise.resolve({
        status: 206,
        url: URL_OK,
        headers: { 'Content-Range': `bytes 0-4095/${declared}`, 'Content-Length': '4096' },
        data: block.buffer,
      }),
  }
  return globalThis.__native
}

const runImportUrl = async (options = {}) =>
  importHistoryFromUrl(URL_OK, {
    downloadStallMs: 30_000,
    heartbeatIntervalMs: 1_000,
    ...options,
  }).then(
    () => null,
    (reason) => reason
  )

test('A：本地文件导入必须按默认上限拒绝「超限」文件，且拒绝发生在解析之前', async () => {
  reset()
  const error = await runImportFile(claimedFile(DEFAULT_LIMIT + 1))

  assert.equal(
    error?.name,
    'BackupError',
    `超限文件必须被明确拒绝，实际 ${error === null ? '成功导入（没有上限检查）' : String(error)}`
  )
  assert.equal(error.key, 'historyImportUrlTooLarge', '必须给出「文件过大」这条可读错误')
  assert.equal(error.params?.size, 200, '提示里的 MB 数应等于默认上限')
  assert.deepEqual(stages(), [], '超限必须在解析/暂存之前拒绝（不能先解析再失败）')
  assert.equal(records('import_error').length, 1, '超限拒绝必须落一条失败日志')
})

test('B：恰好等于上限的文件不能被误拒（边界不缩水）', async () => {
  reset()
  const error = await runImportFile(claimedFile(DEFAULT_LIMIT))

  assert.equal(error, null, `等于上限必须放行，实际 ${error?.key ?? ''}`)
  assert.deepEqual(stages(), ['check', 'import'], '放行的文件照常进入校验与解析')
})

test('C：上限可配置——调小后同一条链路必须按新值拒绝', async () => {
  reset()
  const error = await runImportFile(claimedFile(2 * MB), { maxBytes: 1 * MB })

  assert.equal(error?.name, 'BackupError', `可配置上限必须生效，实际 ${error === null ? '被放行' : String(error)}`)
  assert.equal(error.key, 'historyImportUrlTooLarge')
  assert.equal(error.params?.size, 1, '提示里的 MB 数应跟随配置值')
  assert.deepEqual(stages(), [], '按配置上限拒绝时同样不能进入解析')
})

test('D：上限只有一个来源，不是散落的魔法数', async () => {
  const { DEFAULT_MAX_IMPORT_BYTES, maxImportMegabytes, resolveMaxImportBytes } = await import(
    '../../src/services/chat/history/importLimit.ts'
  )

  assert.equal(DEFAULT_MAX_IMPORT_BYTES, DEFAULT_LIMIT, '默认值必须与现状一致（200MB）')
  assert.equal(MAX_ARCHIVE_BYTES, DEFAULT_MAX_IMPORT_BYTES, '从链接导入的上限必须就是这一个常量')
  assert.equal(maxImportMegabytes(DEFAULT_MAX_IMPORT_BYTES), 200)
  assert.equal(resolveMaxImportBytes(undefined), DEFAULT_MAX_IMPORT_BYTES, '不传就是默认值')
  assert.equal(resolveMaxImportBytes(Number.NaN), DEFAULT_MAX_IMPORT_BYTES, '非法值退回默认值')
  assert.equal(resolveMaxImportBytes(1024), 1024, '合法值原样生效')
})

test('E：从链接导入仍然按默认上限拒绝（回归：默认值不许被偷偷改小/改大）', async () => {
  reset()
  serveDeclared(DEFAULT_LIMIT + 1)
  const error = await runImportUrl()

  assert.equal(error?.key, 'historyImportUrlTooLarge', `声明超限必须拒绝，实际 ${error?.key ?? 'success'}`)
  assert.equal(error.params?.size, 200)
})

test('F：从链接导入也吃同一个可配置上限', async () => {
  reset()
  serveDeclared(3 * MB)
  const error = await runImportUrl({ maxBytes: 1 * MB })

  assert.equal(
    error?.key,
    'historyImportUrlTooLarge',
    `配置上限必须生效，实际 ${error === null ? 'success' : error.key}`
  )
  assert.equal(error.params?.size, 1, '提示里的 MB 数应跟随配置值')
})

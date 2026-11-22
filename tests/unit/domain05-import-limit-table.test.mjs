// [layer: unit | 依赖: 无（纯 Node；只替换 Capacitor 原生桥 / 存储边界 / 归档解析） | 耗时: <5s]
//
// 域 5 / N4：**上限与总长判定表**（docs/testing/coverage/domain-05.md §6.2 N4，8 行）。
//
// 覆盖功能点：
//   F-05-20 上限边界：**恰好** 200MB 必须放行（边界不缩水，> 写成 >= 就误拒）
//   F-05-21 略超上限：**在解析 / 写暂存之前**拒绝，且提示同时给出上限与实测体积
//   F-05-22 总长判定：只认 206 的 Content-Range 与**首次整包 200** 的 Content-Length；
//           206 缺 Content-Range 时绝不拿块长当总长（否则 4KB 块会被判成「已下完」）
//
// 为什么单列一条（不能塞进 N1 状态机）：本文的断言面是**调用序列**——
// 「拒绝发生在 checkArchiveFormat / importArchive 之前、且一个块都不多发」。
// 塞进状态机表会让 N1 的行数翻倍（每行都要再断言一遍时机），而时机正是 #195 的事故点：
// 过去是先把 200MB 包体解一遍、再报「文件过大」，用户等的就是这个白下载。
//
//   node --test tests/unit/domain05-import-limit-table.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import { zipBytes } from '../fixtures/domain05/archive.mjs'
import { installHooks, render, stubOf } from '../fixtures/domain05/hooks.mjs'
import { expectEqual, expectMatch, expectOk, runTable } from '../fixtures/domain05/table.mjs'

const MB = 1024 * 1024

installHooks((specifier, parent) => {
  if (specifier === '@capacitor/core') {
    return stubOf('../url-import-stubs/capacitor.mjs')
  }
  if (specifier === '../../diagnostics/collector.js') {
    return stubOf('../url-import-stubs/collector.mjs')
  }
  // 直链导入要的「本地导入」替身：只用来证明「失败发生在解析之前」（__imported 保持为空）
  if (specifier === '../backup.js' && parent.endsWith('/history/urlImport.ts')) {
    return stubOf('../url-import-stubs/backup.mjs')
  }
  // 本地文件导入（真实 backup.ts）的存储 / 归档边界：只替换边界，上限与拒绝时机全是真代码
  if (specifier === './db.js' && parent.endsWith('/chat/backup.ts')) {
    return stubOf('../url-import-stubs/db.mjs')
  }
  if (specifier === './errors.js' || specifier === './history/errors.js') {
    return stubOf('../import-archive-stubs/errors.mjs')
  }
  if (specifier === './history/importArchive.js') {
    return stubOf('../url-import-stubs/importArchive.mjs')
  }
  if (specifier === './history/zipReader.js') {
    return stubOf('../url-import-stubs/zipReader.mjs')
  }
  if (specifier === './store.js') {
    return stubOf('../url-import-stubs/store.mjs')
  }
  return null
})

// 打包期 DefinePlugin 常量：裸 Node 里没有，backup.ts 会经 diagnostics 读到（同其它单测做法）
const { consumeBaseUrl, legacyHosts } = await import('../../scripts/lib/endpoints.mjs')
globalThis.__ENDPOINTS__ ??= Object.freeze({
  consume: Object.freeze({ baseUrl: consumeBaseUrl }),
  feedbackUrl: 'https://feedback.test.invalid',
  legacyHosts: Object.freeze([...legacyHosts]),
})
globalThis.__API_ORIGIN__ ??= 'https://api.deepseek.com'
globalThis.__INTERNAL_BUILD__ ??= false

const { importHistory } = await import('../../src/services/chat/backup.ts')
const { importHistoryFromUrl } = await import('../../src/services/chat/history/urlImport.ts')
const {
  DEFAULT_MAX_IMPORT_BYTES,
  formatImportBytes,
  maxImportMegabytes,
  resolveMaxImportBytes,
} = await import('../../src/services/chat/history/importLimit.ts')
const { LIMITS } = await import('../../src/services/limits.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const resetEnv = () => {
  globalThis.__log = { records: [], events: [], actions: [] }
  globalThis.__imported = []
  globalThis.__staged = []
  globalThis.__importCount = 1
  globalThis.__native = undefined
}

const rangeOf = (options) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range ?? '')
  return match === null ? { from: 0, to: -1 } : { from: Number(match[1]), to: Number(match[2]) }
}

const stubNative = (get) => {
  const native = { native: true, calls: [], get }
  globalThis.__native = native
  return native
}

const runUrl = (link, options = {}) =>
  importHistoryFromUrl(link, options).then(
    () => null,
    (error) => error
  )

/** 直链响应：206 + 可选 Content-Range 声明。 */
const serveRange = (link, source, { declareTotal, omitRange = false } = {}) =>
  stubNative((options) => {
    const { from, to } = rangeOf(options)
    const end = Math.min(to, source.length - 1)
    const slice = source.slice(from, end + 1)
    const total = declareTotal ?? source.length
    return Promise.resolve({
      status: 206,
      url: link,
      headers: omitRange
        ? { 'Content-Length': String(slice.length) }
        : { 'Content-Range': `bytes ${from}-${end}/${total}`, 'Content-Length': String(slice.length) },
      data: slice.buffer,
    })
  })

test('N4 上限与总长判定表：8 行（F-05-20/21/22）', async () => {
  const rows = [
    {
      name: '本地文件：恰好等于上限 → 放行（边界不缩水，照常走格式校验与解析）',
      async run() {
        resetEnv()
        const source = zipBytes([['manifest.json', new Uint8Array(64)]])
        const file = new File([source], 'deepseek_data.zip')
        // #390：importHistory 返回结果摘要（模式 + 新增/覆盖/跳过），写入条数在 count 里
        const result = await importHistory(file, { maxBytes: file.size })
        expectEqual(result.count, 1, '返回的会话数')
        expectEqual(
          globalThis.__staged.map((entry) => entry.stage).join(','),
          'check,import',
          '恰好等于上限时必须真的走完校验与导入'
        )
      },
    },
    {
      name: '本地文件：超上限 1 字节 → 在解析 / 写暂存之前拒绝，文案给上限与实测体积',
      async run() {
        resetEnv()
        const source = zipBytes([['manifest.json', new Uint8Array(64)]])
        const file = new File([source], 'deepseek_data.zip')
        const error = await importHistory(file, { maxBytes: file.size - 1 }).then(
          () => null,
          (failure) => failure
        )
        expectEqual(error?.key, 'historyImportUrlTooLarge', '终态')
        expectEqual(globalThis.__staged.length, 0, '超限的包不许进格式校验 / 暂存（#195 白下载）')
        expectEqual(error.params.size, maxImportMegabytes(file.size - 1), '文案里的上限 MB')
        expectEqual(error.params.actual, formatImportBytes(file.size), '文案里的实测体积')
        const text = render(zh, error)
        expectMatch(text, /文件过大/, '中文文案')
        expectMatch(text, new RegExp(`${formatImportBytes(file.size)}`), '必须说出实测体积')
        expectEqual(/[\u4e00-\u9fff]/.test(en[error.key]), false, '英文文案不得出现中文')
      },
    },
    {
      name: '默认上限只有一个来源：200MB，且非法入参不许变成「无上限」',
      async run() {
        expectEqual(DEFAULT_MAX_IMPORT_BYTES, 200 * MB, '默认上限')
        expectEqual(maxImportMegabytes(), 200, '文案里的 MB 数')
        expectEqual(LIMITS.importMaxBytes, DEFAULT_MAX_IMPORT_BYTES, 'LIMITS 只做转出，不另写数字')
        for (const illegal of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          expectEqual(resolveMaxImportBytes(illegal), DEFAULT_MAX_IMPORT_BYTES, `非法入参 ${illegal} 必须退回默认`)
        }
        expectEqual(resolveMaxImportBytes(4096), 4096, '合法入参原样生效')
        // #152 的常量自洽：改一个数不改另一个，这条会先红
        expectOk(LIMITS.importMaxBytes / (LIMITS.importMaxTotalMs / 1000) >= 100_000, '上限与总时限仍自洽')
      },
    },
    {
      name: '直链：206 声明的总长超上限 → 读到响应头就拒绝，不再发块、不进解析',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/limit-declared.zip'
        const native = serveRange(link, zipBytes([['manifest.json', new Uint8Array(4096)]]), {
          declareTotal: 2 * MB,
        })
        const error = await runUrl(link, { maxBytes: 1 * MB, downloadStallMs: 5_000 })
        expectEqual(error?.key, 'historyImportUrlTooLarge', '终态')
        expectEqual(native.calls.length, 1, '声明就超限，不该再发后续块')
        expectEqual(globalThis.__imported.length, 0, '不许进入解析阶段')
        expectMatch(render(zh, error), /实测/, '文案要带实测体积')
      },
    },
    {
      name: '直链：206 声明的总长恰好等于上限 → 放行（边界不缩水）',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/limit-exact.zip'
        const source = zipBytes([['manifest.json', new Uint8Array(12 * 1024)]])
        serveRange(link, source, { declareTotal: source.length })
        const error = await runUrl(link, { maxBytes: source.length, downloadStallMs: 5_000 })
        expectEqual(error, null, `恰好等于上限必须放行（实际 ${error?.key}）`)
        expectEqual(globalThis.__imported[0].size, source.length, '整包入库')
      },
    },
    {
      name: '直链：首次整包 200 的 Content-Length 超上限 → 先看头再看包体（不解大包再报超限）',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/limit-whole.zip'
        const body = new Uint8Array(4096)
        body.set([0x50, 0x4b, 3, 4])
        const native = stubNative(() =>
          Promise.resolve({
            status: 200,
            url: link,
            headers: { 'Content-Length': String(2 * MB) },
            data: body.buffer,
          })
        )
        const error = await runUrl(link, { maxBytes: 1 * MB, downloadStallMs: 5_000 })
        expectEqual(error?.key, 'historyImportUrlTooLarge', '终态')
        expectEqual(native.calls.length, 1, '只发了那一个请求')
        expectEqual(globalThis.__imported.length, 0, '不许进入解析阶段')
      },
    },
    {
      name: '直链：206 缺 Content-Range（块长不可信）+ 上限等于整包 → 仍下完（4KB 不能当总长）',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/limit-block-length.zip'
        const source = zipBytes([['manifest.json', new Uint8Array(12 * 1024)]])
        serveRange(link, source, { omitRange: true })
        const error = await runUrl(link, { maxBytes: source.length, downloadStallMs: 5_000 })
        expectEqual(error, null, `块长不可信时也必须下完（实际 ${error?.key}）`)
        // 若把首个 4KB 块的 Content-Length 当总长，这里会「成功但包被截断」——最坏的一种假成功
        expectEqual(globalThis.__imported[0].size, source.length, '入库的必须是完整整包')
      },
    },
    {
      name: '直链：总长未知但累计字节超上限 → 当场停（不等到下完）',
      async run() {
        resetEnv()
        const link = 'https://obs.example.test/domain05/limit-stream.zip'
        const source = zipBytes([['manifest.json', new Uint8Array(64 * 1024)]])
        const native = serveRange(link, source, { omitRange: true })
        const error = await runUrl(link, { maxBytes: 8 * 1024, downloadStallMs: 5_000 })
        expectEqual(error?.key, 'historyImportUrlTooLarge', '终态')
        expectOk(native.calls.length >= 2, `应当在下第二块时才发现超限（实际 ${native.calls.length} 次请求）`)
        expectOk(
          globalThis.__imported.length === 0,
          '超限后不许把已下字节当成功结果交出去'
        )
        expectEqual(
          globalThis.__log.records.filter((entry) => entry.fields?.reason === 'archive-too-large').length,
          1,
          '拒绝必须留一条可查的记录'
        )
      },
    },
  ]

  await runTable(rows, (row) => row.run())
})

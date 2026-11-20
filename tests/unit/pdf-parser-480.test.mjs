// [layer: unit | 依赖: pdfjs-dist@2.16.105（npm 包，Node 内 fake worker）+ 现场拼的最小 PDF | 耗时: ~2s]
//
// Issue #571（母单 #480）：PDF 本地文本提取的**关闭条件**逐条落成断言。
//
// 这个文件回答的是「#571 的每一格到底成不成立」，不是「pdf.ts 里写了什么」：
//
//   [1] 依赖锁定 `pdfjs-dist@2.16.105` + `legacy/build/pdf.min.js` / `pdf.worker.min.js` 经典脚本，
//       且源码里留了「为什么不用 3.x / 4.x」的理由（换成 ESM/3.x 时这里立刻红）；
//   [2] 输出格式 `[第N页]\n正文`，保留 `pages` / `extractedPages` / `pageChars[]`，
//       并且 `pageChars` 求和 === `characterCount`（与 #544 的正文口径同一把尺子）；
//   [3] 无文本层 → 明确错误 + 原文案，**不返回空文本**；
//   [4] 超页数 → 在取任何一页之前抛 `tooManyPages`（不许截断前 N 页当成功）；
//   [5] 取消（AbortSignal）与超时（`timeoutMs`）都返回已提取部分 + warnings，不假装完整文档。
//
// 「部分页失败 → partial」那一条（#571 关闭条件 4）**不在本文件**：真实 PDF 很难稳定造出
// 「第 2 页炸了」，它用桩 pdfjs 注入失败页，见 `pdf-parser-partial-480.test.mjs`。
//
// 夹具：`tests/helpers/pdf480.mjs` 现场拼字节（不落二进制），与 #544 的口径用例共用同一个生成器。
//
//   node --test tests/unit/pdf-parser-480.test.mjs
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

import { PDF_SAMPLE_LINE, buildPdf } from '../helpers/pdf480.mjs'

// 产品代码内部按 NodeNext 写 `.js` 后缀（真实编译单元是 .ts），这里把后缀映射回去
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
      }
      throw error
    }
  },
})

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(ROOT, 'noop.js'))
const readSrc = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

// pdf.ts 从 `window.pdfjsLib` 取库（线上是 `<script src>` 注入的经典脚本）。Node 里手动把 npm 包
// 挂上去 —— 同一个版本、同一份代码，只是加载方式不同；`GlobalWorkerOptions` 给空壳对象，
// 让 pdfjs 走 Node 自带的 fake worker（同步、单线程，正是单测想要的）。
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
globalThis.window = {
  pdfjsLib: {
    version: pdfjs.version,
    getDocument: (params) => pdfjs.getDocument(params),
    GlobalWorkerOptions: {},
  },
}

const { parsePdfFile, PdfParseError, PDF_NO_TEXT_LAYER_MESSAGE, PDF_PARSER_VERSION } = await import(
  '../../src/services/attachments/parsers/pdf.ts'
)
const { ATTACHMENT_LIMITS } = await import('../../src/services/attachments/limits.ts')

const pdfOf = (pages) => new Blob([buildPdf(pages)])
const SAMPLE_PAGES = [[PDF_SAMPLE_LINE, PDF_SAMPLE_LINE], [`Second page ${PDF_SAMPLE_LINE}`], [`Third page ${PDF_SAMPLE_LINE}`]]

// ── [1] 依赖与入口 ─────────────────────────────────────────────────────────

test('#571 依赖锁死 pdfjs-dist@2.16.105，入口是 legacy 经典脚本（不是 ESM / 3.x / 4.x）', () => {
  const pkg = JSON.parse(readSrc('package.json'))
  // 精确版本：带 ^ / ~ 会在一段时间后悄悄跳到 2.17+，而老内核的兼容结论只对 2.16.105 成立
  assert.equal(pkg.dependencies['pdfjs-dist'], '2.16.105', 'pdfjs-dist 必须精确锁定 2.16.105')

  const asset = JSON.parse(readSrc('config/pdfjs.json'))
  assert.equal(asset.script, 'legacy/build/pdf.min.js', '主文件必须是 legacy UMD 构建')
  assert.equal(asset.worker, 'legacy/build/pdf.worker.min.js', 'worker 同源同构建')

  // 「为什么不用 3.x / 4.x」必须写在源码里，否则下一个人只会当成历史包袱删掉
  const loader = readSrc('src/services/attachments/parsers/pdfLoader.ts')
  assert.match(loader, /2\.16\.105/)
  assert.match(loader, /3\.11\.174|3\.x/)
  assert.match(loader, /4\.10\.38|4\.x/)
  assert.match(loader, /ESM/)
  assert.match(loader, /Chromium\s*83|baselineChromium/)
})

test('#571 阈值全部来自 limits.ts：页数上限 / 无文本层阈值 / 时间预算都在（解析器不就地硬编码）', () => {
  assert.equal(ATTACHMENT_LIMITS.pdfMaxPages, 500)
  assert.equal(ATTACHMENT_LIMITS.pdfMinCharsPerPage, 20)
  assert.ok(ATTACHMENT_LIMITS.pdfTimeoutMs >= 60_000, '时间预算至少 1 分钟，别把正常大文档掐掉')
  const src = readSrc('src/services/attachments/parsers/pdf.ts')
  assert.equal(/pdfMaxPages:/.test(src), false, '解析器里不许再写一份页数上限')
})

// ── [2] 正常 PDF：页码 / 格式 / pageChars ──────────────────────────────────

test('#571 正常 PDF：逐页提取，[第N页] 标记不重不漏，pages / extractedPages 对得上', async () => {
  const parsed = await parsePdfFile(pdfOf(SAMPLE_PAGES))

  assert.equal(parsed.pages, 3)
  assert.equal(parsed.extractedPages, 3)
  assert.equal(parsed.warnings, undefined, '完整解析不该带 warnings（带了就说明被降级成 partial）')
  assert.equal(parsed.parserVersion, PDF_PARSER_VERSION)

  // 格式：[第N页]\n正文，页间用单个换行分隔（见 PR 里「页间空行」的偏差说明）
  const bodies = SAMPLE_PAGES.map((lines) => lines.join('\n'))
  assert.equal(parsed.text, `[第1页]\n${bodies[0]}\n[第2页]\n${bodies[1]}\n[第3页]\n${bodies[2]}`)
  // 页码不能凭空多出来 / 错位（这是逐页拼接最容易出的 bug）
  assert.deepEqual(parsed.text.match(/^\[第\d+页\]$/gmu), ['[第1页]', '[第2页]', '[第3页]'])
})

test('#571 pageChars：长度 = pages、按页码对齐，求和 === characterCount（与正文口径同一把尺子）', async () => {
  const parsed = await parsePdfFile(pdfOf(SAMPLE_PAGES))
  const chars = parsed.pageChars

  assert.ok(Array.isArray(chars), 'pageChars 必须存在（#571 关闭条件原文要求保留它）')
  assert.equal(chars.length, parsed.pages, '长度必须是总页数，索引 i 指第 i+1 页')
  assert.deepEqual(
    chars,
    SAMPLE_PAGES.map((lines) => lines.join('\n').length),
    '每页字符数 = 该页正文长度（不含 [第N页] 标记）'
  )
  assert.equal(
    chars.reduce((sum, value) => sum + value, 0),
    parsed.characterCount,
    'pageChars 求和必须等于 characterCount —— 两个字段不许各算一套'
  )
  // 反向断言：pageChars 不含标记开销（否则求和会比 characterCount 大）
  assert.ok(parsed.rawLength > parsed.characterCount, 'PDF 的注入文本比正文长（标记 + 分隔换行）')
})

// ── [3] 无文本层 ───────────────────────────────────────────────────────────

test('#571 无文本层：抛出 noTextLayer + 原文案，绝不返回空文本当成功', async () => {
  // 结构合法、有页、但内容流里一个 Tj 都没有 —— 等价于扫描件的「有页无文字层」
  await assert.rejects(parsePdfFile(pdfOf([[], [], []])), (error) => {
    assert.ok(error instanceof PdfParseError)
    assert.equal(error.code, 'noTextLayer')
    assert.equal(error.message, PDF_NO_TEXT_LAYER_MESSAGE)
    assert.match(error.message, /暂不支持扫描版 PDF/)
    return true
  })
})

// ── [4] 页数上限 ───────────────────────────────────────────────────────────

test('#571 超页数：在取任何一页之前抛 tooManyPages，不截断前 N 页当成功', async () => {
  const tooMany = Array.from({ length: ATTACHMENT_LIMITS.pdfMaxPages + 1 }, () => [PDF_SAMPLE_LINE])
  const startedAt = Date.now()
  await assert.rejects(parsePdfFile(pdfOf(tooMany)), (error) => {
    assert.ok(error instanceof PdfParseError)
    assert.equal(error.code, 'tooManyPages')
    assert.match(error.message, new RegExp(String(ATTACHMENT_LIMITS.pdfMaxPages)))
    assert.match(error.message, /请拆分后再上传/)
    return true
  })
  // 证据：拒绝发生在翻页之前（501 页若真的逐页提取，光是解析内容流就不止这点时间）
  assert.ok(Date.now() - startedAt < 5000, `超页数不该先跑几页再报错，实际 ${Date.now() - startedAt} ms`)
})

// ── [5] 取消与超时 ─────────────────────────────────────────────────────────

test('#571 中途取消：abort 之后不再翻页，已提取的页照常交付 + 已取消 warning', async () => {
  const controller = new AbortController()
  const seenPages = []
  const parsed = await parsePdfFile(pdfOf(SAMPLE_PAGES), {
    signal: controller.signal,
    onProgress: (info) => {
      if (info.stage === 'page') {
        seenPages.push(info.page)
        // 第 1 页开始前就取消：这一页仍会读完（取消粒度是页），第 2 页起不再提取
        if (info.page === 1) {
          controller.abort()
        }
      }
    },
  })

  assert.deepEqual(seenPages, [1], '取消之后不许继续报下一帧进度')
  assert.equal(parsed.extractedPages, 1)
  assert.equal(parsed.pages, 3)
  assert.deepEqual(parsed.pageChars, [SAMPLE_PAGES[0].join('\n').length, 0, 0], '没读到的页记 0，页码仍要对齐')
  assert.deepEqual(parsed.warnings, ['已取消'])
  assert.equal(parsed.text, `[第1页]\n${SAMPLE_PAGES[0].join('\n')}`, '取消不伪造后面几页的标记')
})

test('#571 超时：预算用光就停止翻页，返回已提取部分 + 超时 warning（不是抛错、不是空串）', async () => {
  const parsed = await parsePdfFile(pdfOf(SAMPLE_PAGES), { timeoutMs: 0 })

  assert.equal(parsed.pages, 3)
  assert.equal(parsed.extractedPages, 0, 'timeoutMs=0 时一页都不该开始')
  assert.equal(parsed.text, '')
  assert.deepEqual(parsed.pageChars, [0, 0, 0])
  assert.ok(
    (parsed.warnings ?? []).some((warning) => warning.includes('解析超时')),
    `warnings 必须写明超时，实际 ${JSON.stringify(parsed.warnings)}`
  )
  // 关键：一页都没读到却**不抛错**，而是显式 partial（空 text + 0/3 页 + warning），
  // 这样 manager 落 status:'partial' 而不是把它当「文件损坏」
  assert.equal(parsed.characterCount, 0)
})

// ── 前置闸（顺带守住的既有不变量）────────────────────────────────────────────

test('#571 非 PDF / 加密 PDF / 超体积：三种前置闸都明确失败（不落到 pdfjs 里报奇怪错误）', async () => {
  await assert.rejects(parsePdfFile(new Blob([new Uint8Array([0x50, 0x4b, 3, 4])])), (error) => {
    assert.equal(error.code, 'notPdfFile')
    return true
  })

  // 在合法 PDF 的注释区塞一个 /Encrypt 字典键名：真加密的 PDF 本来就解不开，宁严不宽
  const encrypted = Buffer.from(buildPdf(SAMPLE_PAGES)).toString('latin1').replace('/Type /Catalog', '/Type /Catalog /Encrypt 9 0 R')
  await assert.rejects(parsePdfFile(new Blob([Buffer.from(encrypted, 'latin1')])), (error) => {
    assert.equal(error.code, 'encryptedPdf')
    return true
  })

  const oversized = new Blob([new Uint8Array(ATTACHMENT_LIMITS.pdfMaxBytes + 1)])
  assert.equal(oversized.size, ATTACHMENT_LIMITS.pdfMaxBytes + 1)
  await assert.rejects(parsePdfFile(oversized), (error) => {
    assert.equal(error.code, 'fileTooLarge')
    return true
  })
})

// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #571：PDF 本地文本提取（母单 #480）。被测物 src/services/documents/pdf.ts。
//
// 这一层盯的是 5 条关闭条件，每条都有真实断言（不是"看起来实现了"）：
//   [1] 依赖锁定 2.16.105 + legacy UMD 入口 + 构建侧真的会把 worker 拷进产物
//   [2] 输出格式 `[第N页]\n正文`、页间空行、pages/extractedPages/pageChars
//   [3] 无文本层 → 明确错误码 + 原文案，**不允许返回空串**
//   [4] 部分页失败 → status:'partial' + failedPages（真 PDF 构造不出来，用桩文档注入）
//   [5] 页数上限 / 超时 / AbortSignal 取消（取消要真的中断，不是跑完再丢结果）
//
// 真实 PDF 样本在 tests/fixtures/doc571/：
//   · sample-5p.pdf        5 页真文本层（2542 字符 / PyMuPDF 口径）
//   · scan-3p-noText.pdf   3 页纯图像扫描型（PyMuPDF extract_text() 逐页 0 字符；
//                          50 页 34 MB 的原件太大不入库，按同一手法生成的小样本，
//                          已用 pdfjs 复核 pageChars 全 0，见"无文本层"那条用例）
//
// Node 下 PDF.js 走**主线程 fake worker**（没有 DOM、也没有真实 Worker），这是真实约束不是降级：
// 被测逻辑（逐页 / 页码 / 阈值 / 超时 / 取消）与线程模型无关，浏览器侧接真 worker 的路径由
// 下面"Worker 接线"那条守门；`file://` 的 worker 限制写进 PR 的"未测边界"。
//
//   node tests/run-layer.mjs unit --only doc-571
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const FIXTURES = path.join(ROOT, 'tests/fixtures/doc571')

const {
  parsePdf,
  extractFromDocument,
  setPdfWorkerSrc,
  getPdfWorkerSrcOverride,
  PdfExtractError,
  PDF_NO_TEXT_MESSAGE,
  PDF_WORKER_ASSET,
  DEFAULT_MIN_TOTAL_CHARS,
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS,
} = await import('../../src/services/documents/pdf.ts')

const require = createRequire(path.join(ROOT, 'package.json'))
const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)))
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 断言抛出的是 PdfExtractError 且 code 对得上（顺带把 message/details 带出来） */
const rejectsWithCode = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof PdfExtractError, `期望 PdfExtractError，实际 ${err?.name}: ${err?.message}`)
    assert.equal(err.code, code)
    return true
  })

/**
 * 桩文档：真实 PDF 上很难稳定造出"某一页炸了""某一页永远不返回"，
 * 而这两条正是 #571 要求覆盖的边界。桩只实现 extractFromDocument 用到的那四个成员。
 */
const stubDoc = ({ pages = 3, failOn = [], hangOn = null } = {}) => {
  const calls = []
  return {
    calls,
    numPages: pages,
    getPage(pageNumber) {
      calls.push(pageNumber)
      if (pageNumber === hangOn) return new Promise(() => {})
      if (failOn.includes(pageNumber)) return Promise.reject(new Error(`第 ${pageNumber} 页内容流损坏`))
      return Promise.resolve({
        // 正文故意写得比「无文本层」阈值长（否则残余页字符太少会被判成扫描件，那是另一条判定）
        getTextContent: async () => ({
          items: [{ str: `第 ${pageNumber} 页正文：桩数据，用来验证页码对齐与部分失败的合并语义，字符数要超过无文本层阈值。`, hasEOL: true }],
        }),
        cleanup() {},
      })
    },
    destroy() {
      calls.push('destroy')
    },
  }
}

// ---------------------------------------------------------------------------
// [1] 依赖与产物接线
// ---------------------------------------------------------------------------
test('依赖锁死 pdfjs-dist@2.16.105，入口是 legacy UMD 构建', () => {
  const pkg = JSON.parse(readSrc('package.json'))
  // 精确版本：带 ^ / ~ 会在下次装依赖时悄悄跳到 2.17+，而 3.x/4.x 的语法/模块格式在老 WebView 上不可用
  assert.equal(pkg.dependencies['pdfjs-dist'], '2.16.105')

  const src = readSrc('src/services/documents/pdf.ts')
  assert.match(src, /from 'pdfjs-dist\/legacy\/build\/pdf\.min\.js'/)
  // 注释里必须留下"为什么不用 3.x / 4.x"的理由，避免后人当成历史包袱删掉
  assert.match(src, /3\.x/)
  assert.match(src, /Chromium\s*≥\s*84/)
  assert.match(src, /4\.x/)
  assert.match(src, /ESM/)
})

test('Worker 接线：产物路径固定、构建侧真的会拷 worker、PDF.js 能加载它', () => {
  assert.equal(PDF_WORKER_ASSET, 'static/pdf/pdf.worker.min.js')
  // 源码里写的路径与 Rspack 拷贝目标必须一致，否则线上就是"workerSrc 指了个不存在的文件"
  const rspack = readSrc('rspack.config.ts')
  assert.ok(
    rspack.includes(`pdfjs-dist/legacy/build/pdf.worker.min.js`),
    'rspack.config.ts 里没有拷贝 pdf.worker.min.js 的条目'
  )
  assert.ok(rspack.includes(`static/pdf/pdf.worker.min.js`), 'rspack 拷贝目标与 PDF_WORKER_ASSET 不一致')

  // 直连本地 worker 文件：这个构建里确实导出了 WorkerMessageHandler（浏览器侧 new Worker 跑的就是它）
  const workerEntry = require.resolve('pdfjs-dist/legacy/build/pdf.worker.min.js')
  assert.ok(fs.statSync(workerEntry).size > 100_000, 'worker 文件大小异常')
  const workerModule = require('pdfjs-dist/legacy/build/pdf.worker.min.js')
  assert.equal(typeof workerModule.WorkerMessageHandler, 'function')

  // 可配置入口：显式覆盖优先于默认解析
  setPdfWorkerSrc(workerEntry)
  try {
    assert.equal(getPdfWorkerSrcOverride(), workerEntry)
  } finally {
    setPdfWorkerSrc('')
  }
  assert.equal(getPdfWorkerSrcOverride(), '')
})

// ---------------------------------------------------------------------------
// [2] 正常 PDF：页码、字符数、格式
// ---------------------------------------------------------------------------
test('正常 PDF：逐页提取，页码/页数/字符数都对，格式是 [第N页] + 页间空行', async () => {
  const result = await parsePdf(fixture('sample-5p.pdf'))

  assert.equal(result.status, 'ok')
  assert.equal(result.pages, 5)
  assert.equal(result.extractedPages, 5)
  assert.equal(result.pageChars.length, 5)
  assert.deepEqual(result.failedPages, [])
  assert.deepEqual(result.warnings, [])
  // 每页都有真文本（不是只把页码头写上去）
  for (const [index, chars] of result.pageChars.entries()) {
    assert.ok(chars > 0, `第 ${index + 1} 页字符数为 0`)
  }

  // 格式：`[第N页]\n正文`，页与页之间空行
  assert.ok(result.text.startsWith('[第1页]\n'), result.text.slice(0, 20))
  assert.ok(result.text.includes('[第5页]\n'))
  assert.match(result.text, /\n\n\[第2页\]\n/)
  assert.match(result.text, /\n\n\[第5页\]\n/)
  // 页码不能凭空多出来（错位是最容易出的 bug）
  assert.equal(result.text.match(/^\[第\d+页\]$/gmu).length, 5)

  // 字符数核对：pageChars 之和 = 全文去掉页码头/空白后的可见字符数
  const visible = result.text
    .replace(/^\[第\d+页\]$/gmu, '')
    .replace(/\s/gu, '').length
  assert.equal(
    visible,
    result.pageChars.reduce((a, b) => a + b, 0)
  )
})

test('进度回调覆盖每一页且不重复', async () => {
  const seen = []
  await parsePdf(fixture('sample-5p.pdf'), { onProgress: (info) => seen.push(info.page) })
  assert.deepEqual(seen, [1, 2, 3, 4, 5])
})

// ---------------------------------------------------------------------------
// [3] 无文本层：明确错误，不是空串
// ---------------------------------------------------------------------------
test('无文本层 PDF：抛 PDF_NO_TEXT_LAYER + 原文案，且绝不返回空文本', async () => {
  const bytes = fixture('scan-3p-noText.pdf')
  let caught = null
  await assert.rejects(parsePdf(bytes), (e) => {
    caught = e
    assert.ok(e instanceof PdfExtractError)
    assert.equal(e.code, 'PDF_NO_TEXT_LAYER')
    assert.equal(e.message, PDF_NO_TEXT_MESSAGE)
    assert.equal(e.message, '该 PDF 未检测到可提取的文本，暂不支持扫描版 PDF')
    // 证据：整份文档可见字符 0，页数读得出来（不是"文件打不开"那种失败）
    assert.equal(e.details.pages, 3)
    assert.equal(e.details.visibleChars, 0)
    assert.equal(e.details.minTotalChars, DEFAULT_MIN_TOTAL_CHARS)
    return true
  })
  // 关闭条件的原话：不返回空文本。这里连 result 都不存在，只有 throw。
  assert.ok(caught instanceof PdfExtractError)
  assert.equal(caught.code, 'PDF_NO_TEXT_LAYER')
})

test('阈值口径：真扫描件 0 字符、真文本层远超阈值（阈值夹在两端之间）', async () => {
  // 下端（真实扫描型样本）：pdfjs 逐页 0 字符，与 PyMuPDF extract_text() 一致 —— 已在上面那条用例
  // 由 details.visibleChars === 0 断言。这里补一条**只含空白字符**的桩，证明阈值判的是
  // "去空白后的可见字符"，不是"取到了 items 就算有文本"。
  const whitespaceOnly = {
    numPages: 2,
    getPage: async () => ({ getTextContent: async () => ({ items: [{ str: '   ' }, { str: '\n', hasEOL: true }] }) }),
  }
  await rejectsWithCode(extractFromDocument(whitespaceOnly), 'PDF_NO_TEXT_LAYER')

  // 上端（真实文本层样本）：可见字符数是阈值的三位数倍，说明阈值不是贴着实测下界拍的
  const ok = await parsePdf(fixture('sample-5p.pdf'))
  const visible = ok.pageChars.reduce((a, b) => a + b, 0)
  assert.ok(visible > 2000, `真实样本可见字符 ${visible}，阈值 ${DEFAULT_MIN_TOTAL_CHARS}`)
  assert.ok(DEFAULT_MIN_TOTAL_CHARS * 100 < visible, '阈值不该贴着实测下界')
})

test('阈值可覆盖：把阈值抬到样本字符数以上时，同一份正常 PDF 变成 PDF_NO_TEXT_LAYER', async () => {
  const bytes = fixture('sample-5p.pdf')
  const ok = await parsePdf(bytes)
  const visible = ok.pageChars.reduce((a, b) => a + b, 0)
  await rejectsWithCode(parsePdf(bytes, { minTotalChars: visible + 1 }), 'PDF_NO_TEXT_LAYER')
})

// ---------------------------------------------------------------------------
// [4] 部分页失败
// ---------------------------------------------------------------------------
test('部分页失败：status=partial + failedPages，成功的页照常输出', async () => {
  const doc = stubDoc({ pages: 3, failOn: [2] })
  const result = await extractFromDocument(doc)

  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failedPages, [2])
  assert.equal(result.pages, 3)
  assert.equal(result.extractedPages, 2) // 失败页不占位
  assert.equal(result.pageChars.length, 2)
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /第 2 页提取失败/)
  assert.ok(result.text.includes('[第1页]'))
  assert.ok(result.text.includes('[第3页]'))
  assert.ok(!result.text.includes('[第2页]'), '失败页不该伪造页码头')
})

test('部分页失败不会冒充完整文档：status 不是 ok', async () => {
  const result = await extractFromDocument(stubDoc({ pages: 2, failOn: [1] }))
  assert.notEqual(result.status, 'ok')
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.failedPages, [1])
})

// ---------------------------------------------------------------------------
// [5] 页数上限 / 超时 / 取消
// ---------------------------------------------------------------------------
test('超页数：取第一页之前就拒绝，抛 PDF_TOO_MANY_PAGES', async () => {
  await assert.rejects(parsePdf(fixture('sample-5p.pdf'), { maxPages: 2 }), (err) => {
    assert.ok(err instanceof PdfExtractError)
    assert.equal(err.code, 'PDF_TOO_MANY_PAGES')
    assert.equal(err.details.pages, 5)
    assert.equal(err.details.maxPages, 2)
    return true
  })

  // 桩文档能证明"真的一页都没读"：拒绝发生在 getPage 之前
  const doc = stubDoc({ pages: DEFAULT_MAX_PAGES + 1 })
  await rejectsWithCode(extractFromDocument(doc), 'PDF_TOO_MANY_PAGES')
  assert.deepEqual(doc.calls, [], '超出上限时不该先跑几页再报错')
})

test('超时：卡住的页不会把提取拖死，抛 PDF_TIMEOUT', async () => {
  const doc = stubDoc({ pages: 3, hangOn: 2 })
  const startedAt = Date.now()
  await rejectsWithCode(extractFromDocument(doc, { timeoutMs: 120 }), 'PDF_TIMEOUT')
  const elapsed = Date.now() - startedAt
  // 第 2 页永远不返回；要是"跑完再检查"就会挂死在这个断言上
  assert.ok(elapsed < 5000, `超时没有真正生效，耗时 ${elapsed} ms`)
  assert.ok(doc.calls.includes(2), '应该走到卡住的第 2 页')
})

test('取消：中途 abort 真的中断在飞的提取（不是跑完再丢结果）', async () => {
  const controller = new AbortController()
  const doc = stubDoc({ pages: 3, hangOn: 2 })
  const startedAt = Date.now()
  const runner = extractFromDocument(doc, { signal: controller.signal })
  // 第 2 页永远不 resolve，只有"中断在飞的 promise"才能让这条用例结束
  setTimeout(() => controller.abort(), 50)

  await rejectsWithCode(runner, 'PDF_ABORTED')
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 3000, `取消没有真正中断，耗时 ${elapsed} ms`)
  // 中断后不再继续往后翻页
  assert.ok(!doc.calls.includes(3), '取消之后还在继续读页')
})

test('取消：真实 PDF 在 onProgress 里 abort，后续页不再提取', async () => {
  const controller = new AbortController()
  const seen = []
  await assert.rejects(
    parsePdf(fixture('sample-5p.pdf'), {
      signal: controller.signal,
      onProgress: ({ page }) => {
        seen.push(page)
        if (page === 2) controller.abort()
      },
    }),
    (err) => {
      assert.ok(err instanceof PdfExtractError)
      assert.equal(err.code, 'PDF_ABORTED')
      return true
    }
  )
  assert.ok(seen.length < 5, `abort 之后不该继续跑完，实际进度 ${JSON.stringify(seen)}`)
})

test('已经取消的 signal：一个字节都不解析就抛 PDF_ABORTED', async () => {
  const controller = new AbortController()
  controller.abort()
  await rejectsWithCode(parsePdf(fixture('sample-5p.pdf'), { signal: controller.signal }), 'PDF_ABORTED')
})

test('默认值就是关闭条件要求的那些能力（上限/超时/阈值都在）', () => {
  assert.equal(DEFAULT_MAX_PAGES, 500)
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000)
  assert.equal(DEFAULT_MIN_TOTAL_CHARS, 8)
})

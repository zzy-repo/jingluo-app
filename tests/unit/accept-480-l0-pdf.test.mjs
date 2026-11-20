// [layer: unit | dependencies: node + 真实 pdfjs-dist@2.16.105 | 预算: ≤1.5s]
//
// #528 L0 验收：**PDF 解析器**（#534 契约）。夹具是 `tests/fixtures/480/pdf/` 下的真实 PDF
// （`build-fixtures.mjs` 生成，poppler 的 `pdftotext` 能取出同样的文本层，见 README）。
//
// 只在**加载方式**上做适配：`parsers/pdfLoader.ts` 是浏览器专属的 `<script src>` 注入口，
// L0 通过 resolve hook 换成本目录的 `pdfjs-node-loader.mjs`（同一份 pdfjs 2.16.105 的 UMD 产物）。
// 被验的仍是 `pdf.ts` 的**真代码**：逐页循环、`[第N页]` 拼装、无文本层阈值、取消语义。
//
// 覆盖 #528 清单：
//  1. 逐页格式：`[第1页]` / `[第2页]` 各一次，页序正确，正文来自 pdfjs 的真实文本抽取；
//  2. 无文本层（`pdf/empty.pdf`，有页面但没有文本流）→ `PdfParseError('noTextLayer')` + issue 原文文案；
//  3. 部分页失败 → **不整篇失败**：`extractedPages < pages` + `第 2 页提取失败` warning（partial 口径）；
//  4. 加密（`/Encrypt`）与非 PDF（扩展名骗人）→ 各自的 code，且都在读字节/起 pdfjs 之前就挡住；
//  5. 取消：`signal.abort()` 后只返回已取到的页 + `已取消` warning（partial，不伪装完整）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 只换「pdfjs 加载口」，其它相对导入照旧（.js → .ts）
    if (specifier === './pdfLoader.js' || specifier.endsWith('/pdfLoader.js')) {
      return nextResolve(
        new URL('../../tests/fixtures/480/pdfjs-node-loader.mjs', import.meta.url).href,
        context
      )
    }
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '../fixtures/480/pdf')

const { parsePdfFile, assertPdfAcceptable, PdfParseError, PDF_NO_TEXT_LAYER_MESSAGE } = await import(
  '../../src/services/attachments/parsers/pdf.ts'
)
const { ATTACHMENT_LIMITS } = await import('../../src/services/attachments/limits.ts')

const blobOf = (name) => {
  const bytes = readFileSync(path.join(FIXTURES, name))
  return new Blob([bytes], { type: 'application/pdf' })
}

const rejection = async (run) => {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('期望抛错，实际成功了')
}

test('[L0-PDF] 逐页格式：真实 2 页 PDF → `[第1页]`/`[第2页]` 各一次，页序与正文都对', async () => {
  const parsed = await parsePdfFile(blobOf('text-layer.pdf'))
  assert.equal(parsed.pages, 2)
  assert.equal(parsed.extractedPages, 2)
  assert.equal(parsed.warnings, undefined, '完整解析不该有 warning')
  // pdfjs 真实抽取的两页文本（Helvetica 内置编码，取到的就是原文）
  assert.equal(parsed.text, '[第1页]\nHello 480 page 1\nsecond line\n[第2页]\nHello 480 page 2')
  assert.equal(
    parsed.text.match(/\[第\d+页\]/g).join(','),
    '[第1页],[第2页]',
    '页标记必须按页码升序、一页一个'
  )
  // characterCount 口径：pdf.ts 只累计**页正文**（不含 `[第N页]` 标记与页间换行），
  // 与 txt/docx 的 `characterCount === text.length` 不同。manager 侧统一用 `text.length` 覆盖，
  // 所以不影响落库；这一条差异已在 #528 评论里登记（契约漂移，非缺陷）。
  assert.equal(parsed.characterCount, 44, '页正文合计')
  assert.equal(parsed.text.length, 57, '含页标记的完整注入文本')
  assert.ok(parsed.parserVersion.startsWith('pdfjs-2.16.105'), parsed.parserVersion)
})

test('[L0-PDF] 进度回调：先报 open(totalPages)，每页开报 {page,totalPages,stage:page}', async () => {
  const stages = []
  await parsePdfFile(blobOf('text-layer.pdf'), {
    onProgress: (progress) => stages.push(progress),
  })
  assert.deepEqual(stages[0], { totalPages: 2, stage: 'open' })
  assert.deepEqual(stages[1], { page: 1, totalPages: 2, stage: 'page' })
  assert.deepEqual(stages[2], { page: 2, totalPages: 2, stage: 'page' })
})

test('[L0-PDF] 无文本层（有页面、无文本流）→ noTextLayer + issue 原文文案', async () => {
  const error = await rejection(() => parsePdfFile(blobOf('empty.pdf')))
  assert.ok(error instanceof PdfParseError, `应抛 PdfParseError，实际：${error}`)
  assert.equal(error.code, 'noTextLayer')
  assert.equal(error.message, PDF_NO_TEXT_LAYER_MESSAGE)
  // 阈值来自 limits.ts（禁就地硬编码）
  assert.equal(ATTACHMENT_LIMITS.pdfMinCharsPerPage, 20)
})

test('[L0-PDF] 部分页失败 → 整篇不失败：extractedPages<pages + 页码 warning', async () => {
  globalThis.__480_PDF_FAULTS__ = { failPages: [2] }
  try {
    const parsed = await parsePdfFile(blobOf('text-layer.pdf'))
    assert.equal(parsed.pages, 2)
    assert.equal(parsed.extractedPages, 1, '失败页不计入 extractedPages')
    assert.ok(
      parsed.warnings.some((warning) => warning.includes('第 2 页提取失败')),
      `必须点名失败的页：${JSON.stringify(parsed.warnings)}`
    )
    // 失败页不编造 `[第2页]` 空标记（否则看起来像完整文档）
    assert.equal(parsed.text, '[第1页]\nHello 480 page 1\nsecond line')
    assert.equal(parsed.text.includes('[第2页]'), false)
  } finally {
    delete globalThis.__480_PDF_FAULTS__
  }
})

test('[L0-PDF] 加密 PDF（/Encrypt）→ encryptedPdf，在起 pdfjs 之前挡住', async () => {
  const error = await rejection(() => parsePdfFile(blobOf('encrypted.pdf')))
  assert.ok(error instanceof PdfParseError)
  assert.equal(error.code, 'encryptedPdf')
  assert.equal(error.message, '不支持加密 PDF')
})

test('[L0-PDF] 非 PDF（扩展名骗人）→ notPdfFile，且不把内容当正文', async () => {
  const error = await rejection(() => parsePdfFile(blobOf('not-a-pdf.pdf')))
  assert.ok(error instanceof PdfParseError)
  assert.equal(error.code, 'notPdfFile')
  assert.ok(error.message.includes('%PDF-'), error.message)
})

test('[L0-PDF] 取消（第 2 页前 abort）→ 只返回已取到的页 + 「已取消」warning', async () => {
  const controller = new AbortController()
  const parsed = await parsePdfFile(blobOf('text-layer.pdf'), {
    signal: controller.signal,
    onProgress: (progress) => {
      // 第 1 页开始取时挂断：pdfjs 单页内不可中断，取消粒度是「页」
      if (progress.page === 1) {
        controller.abort()
      }
    },
  })
  // 取消粒度是「页」：第 1 页已经开始取就取完，第 2 页不再开始
  assert.equal(parsed.text, '[第1页]\nHello 480 page 1\nsecond line')
  assert.equal(parsed.extractedPages, 1)
  assert.equal(parsed.pages, 2)
  assert.ok(
    parsed.warnings.some((warning) => warning === '已取消'),
    `取消必须显式告知：${JSON.stringify(parsed.warnings)}`
  )
})

test('[L0-PDF] 前置判定可独立复用：assertPdfAcceptable 对夹具的结论与主流程一致', () => {
  const textLayer = new Uint8Array(readFileSync(path.join(FIXTURES, 'text-layer.pdf')))
  assert.doesNotThrow(() => assertPdfAcceptable(textLayer, textLayer.length))
  const encrypted = new Uint8Array(readFileSync(path.join(FIXTURES, 'encrypted.pdf')))
  assert.throws(
    () => assertPdfAcceptable(encrypted, encrypted.length),
    (error) => error.code === 'encryptedPdf'
  )
  assert.throws(
    () => assertPdfAcceptable(new Uint8Array([0x25, 0x50]), 2),
    (error) => error.code === 'notPdfFile'
  )
  // 体积闸在读字节之前：只给数字就能判
  assert.throws(
    () => assertPdfAcceptable(textLayer, ATTACHMENT_LIMITS.pdfMaxBytes + 1),
    (error) => error.code === 'fileTooLarge'
  )
})

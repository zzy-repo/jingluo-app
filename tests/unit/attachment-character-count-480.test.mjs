// [layer: unit | 依赖: 无（纯 Node；pdfjs 走 npm 包在 Node 里跑 fake worker，无浏览器/网络） | 耗时: ~2s]
//
// Issue #544：`ParsedDocument.characterCount` 的**口径统一**（#480 遗留）。
//
// 修复前：txt / docx 返回 `text.length`，PDF 返回「页正文合计」—— PDF 的 `text` 里还带
// `[第N页]` 标记与页间分隔换行，于是同一个 `characterCount` 字段在三个解析器里量的是三样东西：
// 同一段文字走 txt 拿到 30，走 pdf 拿到 24（差的就是标记），下游（UI「已注入 x / 共 y」、
// 预算估算、以后任何拿它做判断的人）根本没法比。
//
// 本文件的断言就是这句口径本身：**同一段文字，txt 与 pdf 的 `characterCount` 必须相等**。
// 这条比「PDF 的 characterCount 等于某个具体数字」强得多 —— 后者只是把当前实现的输出抄一遍，
// 前者才是口径的定义（谁把标记算进正文，这里立刻红）。
//
// 配套断言（另一半，别只测一边）：
//   · PDF 的 `text` 仍然带 `[第N页]` 标记（注入文本没被改动，golden `g13` 依赖它）；
//   · 需要「含标记的总长度」的人拿 `rawLength`（= `text.length`），它与 `characterCount` 的差
//     必须正好等于标记开销（每页 `[第N页]\n` + 页间 `\n`），不能靠换算去猜。
//
// PDF 夹具现场手工拼（和 tests/fixtures/golden/tiny.pdf 同一种最小结构，Helvetica + WinAnsi），
// 不往仓库里塞二进制；xref 偏移按真实字节算，pdfjs 用 npm 包里的 2.16.105（与线上同一个版本）。
// #507：`__ENDPOINTS__` 等构建期注入值的兜底 —— 装载即挂（幂等），单跑本文件也不会 ReferenceError
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

// 产品代码内部按 NodeNext 写 `.js` 后缀（真实编译单元是 .ts），这里把后缀映射回去
// （与 tests/unit/docx-parser-480.test.mjs 同一套做法）。
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

// 夹具工厂与 #571 的解析器用例共用（见 tests/helpers/pdf480.mjs 的头注释）
const { buildPdf } = await import('../helpers/pdf480.mjs')

// pdf.ts 通过 `window.pdfjsLib` 拿库（线上是 `<script src>` 注入的经典脚本）。
// Node 里手动把 npm 包挂上去 —— 同一个版本、同一份代码，只是加载方式不同。
// `GlobalWorkerOptions` 给一个**空壳对象**：pdfjs 的 workerSrc 在浏览器里是 URL，
// 在 Node 里必须是可 require 的路径，真让 pdfLoader 写进去会走 "Setting up fake worker failed"。
// 给空壳 = 写入被丢弃，pdfjs 用 Node 自带的 fake worker（单线程、同步，正是测试想要的）。
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
globalThis.window = {
  pdfjsLib: {
    version: pdfjs.version,
    getDocument: (params) => pdfjs.getDocument(params),
    GlobalWorkerOptions: {},
  },
}

const { parseTxtFile } = await import('../../src/services/attachments/parsers/txt.ts')
const { parsePdfFile, PDF_PARSER_VERSION } = await import('../../src/services/attachments/parsers/pdf.ts')
// manager 只取一个纯函数（bodyCharacterCount）；不碰 DB / 存储，import 本身无副作用
const { bodyCharacterCount } = await import('../../src/services/attachments/manager.ts')

// `buildPdf` 已抽到 `tests/helpers/pdf480.mjs`（与 #571 的 `pdf-parser-480.test.mjs` 共用同一份
// 生成器；两份各抄一遍 50 行会被 check:test-duplication 的 R1 判红）。字节级实现没变，
// 所以本文件此前全部断言照旧成立。
/** 同一段文字的两种投递方式：txt 字节 与 单页 PDF（正文 = 这段文字） */
const SAME_TEXT = ['Alpha beta gamma', 'Delta epsilon.'].join('\n')
const PAGE_TWO_LINES = ['Second page, one line']

const parseAsTxt = (text) => parseTxtFile(new Blob([text]))
const parseAsPdf = (pages) => parsePdfFile(new Blob([buildPdf(pages)]))

test('#544 同一段文字：txt 与 pdf 的 characterCount 必须相等（口径统一）', async () => {
  const txt = await parseAsTxt(SAME_TEXT)
  const pdf = await parseAsPdf([SAME_TEXT.split('\n')])

  assert.equal(txt.characterCount, SAME_TEXT.length, 'txt 的 characterCount 就是正文字符数')
  assert.equal(pdf.characterCount, txt.characterCount, '同一段文字走 pdf 必须给出同一个正文字数')
  assert.equal(pdf.characterCount, SAME_TEXT.length, 'pdf 的 characterCount 只算正文')
})

test('#544 PDF 的 text 仍然带 [第N页] 标记，标记只进 rawLength 不进 characterCount', async () => {
  const pdf = await parseAsPdf([SAME_TEXT.split('\n')])

  assert.equal(pdf.text, `[第1页]\n${SAME_TEXT}`, '注入文本必须保留页标记（golden g13 依赖它）')
  assert.equal(pdf.rawLength, pdf.text.length, 'rawLength = 注入文本总长度')
  assert.equal(pdf.rawLength, pdf.characterCount + '[第1页]\n'.length, '差正好是标记开销')
  assert.notEqual(
    pdf.characterCount,
    pdf.text.length,
    '若两者相等，说明 characterCount 又退回了「文本长度」口径（#544 的病）'
  )
  assert.equal(pdf.parserVersion, PDF_PARSER_VERSION)
})

test('#544 多页 PDF：characterCount 只累加各页正文，不含标记与页间分隔换行', async () => {
  const pageOne = SAME_TEXT.split('\n')
  const pdf = await parseAsPdf([pageOne, PAGE_TWO_LINES])

  const bodyOne = pageOne.join('\n')
  const bodyTwo = PAGE_TWO_LINES.join('\n')
  assert.equal(pdf.pages, 2)
  assert.equal(pdf.extractedPages, 2)
  assert.equal(pdf.characterCount, bodyOne.length + bodyTwo.length, '正文合计，不含标记')
  assert.equal(pdf.text, `[第1页]\n${bodyOne}\n[第2页]\n${bodyTwo}`)
  assert.equal(
    pdf.rawLength - pdf.characterCount,
    '[第1页]\n'.length + '\n'.length + '[第2页]\n'.length,
    '多出来的正好是两处页标记 + 一处页间分隔换行'
  )
})

test('#544 txt / docx 没有结构标记：rawLength 与 characterCount 恒等', async () => {
  const txt = await parseAsTxt(SAME_TEXT)
  assert.equal(txt.rawLength, txt.characterCount)
  assert.equal(txt.rawLength, txt.text.length)
})

// 落库口径（`DocumentAttachment.characterCount` / `estimatedTokens` / 缓存记录）——
// 这才是用户看得见的那个数：修复前 manager 用 `result.text.length`，于是 PDF 卡片的
// 「x 字符」把 `[第N页]` 也算进去，和 txt 版同一份内容对不上。
test('#544 落库口径：manager 取正文字数，不取 text.length（PDF 上两者不等）', async () => {
  const pdf = await parseAsPdf([SAME_TEXT.split('\n')])
  assert.equal(bodyCharacterCount(pdf), pdf.characterCount, '落库必须用解析器给的正文口径')
  assert.notEqual(bodyCharacterCount(pdf), pdf.text.length, 'PDF 的 text 带页标记，不能当字数')
  // 外部注册的解析器没实现 characterCount 时才走兜底 —— 内置解析器不该落到这一支
  assert.equal(bodyCharacterCount({ text: 'abc' }), 3)
})

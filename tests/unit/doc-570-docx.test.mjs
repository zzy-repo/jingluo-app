// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #570（母单 #480）：DOCX 本地解析 —— `fflate` 解包、按文档顺序取标题/正文/列表/表格，
// 表格转 Markdown，以及安全三条（XXE / 解压炸弹 / 路径穿越）。
//
//   node tests/run-layer.mjs unit --only doc-570
//
// 样本全部在代码里用 `zipSync` 现造（`tests/fixtures` 里不放二进制 docx）：
// 造出来的包最小、能一眼看出每个用例在测什么，也不用担心样本文件被人误改。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { zipSync, strToU8 } = await import('fflate')
const { parseDocx, DocxParseError, DOCX_WARNING } = await import('../../src/services/documents/docx.ts')

// ── 造包 ────────────────────────────────────────────────────────────────────

const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const paragraph = (content, properties = '') =>
  `<w:p>${properties === '' ? '' : `<w:pPr>${properties}</w:pPr>`}${content}</w:p>`
const heading = (level, text) => paragraph(run(text), `<w:pStyle w:val="Heading${level}"/>`)
const bullet = (text) => paragraph(run(text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
const cell = (text) => `<w:tc>${paragraph(run(text))}</w:tc>`
const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`
const table = (...rows) => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`

const documentXml = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document ${WORD_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`

/** 最小可用 docx：只要有 `word/document.xml` 就能解析（其余部件本实现不读） */
const makeDocx = (body, extraEntries = {}) =>
  zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships/>'),
    'word/document.xml': strToU8(documentXml(body)),
    ...extraEntries,
  })

const errorCode = (expected) => (error) => error instanceof DocxParseError && error.code === expected

// ── 关闭条件 3：标题 / 正文 / 列表 / 表格 ─────────────────────────────────────

test('标题：Heading1/2/3 转成 # / ## / ###，元信息记标题数', () => {
  const parsed = parseDocx(makeDocx(heading(1, '一级') + heading(2, '二级') + heading(3, '三级')))
  assert.equal(parsed.text, '# 一级\n\n## 二级\n\n### 三级')
  assert.equal(parsed.meta.headingCount, 3)
})

test('正文段落原样输出，之间空一行；XML 实体解码', () => {
  const parsed = parseDocx(makeDocx(paragraph(run('A &amp; B &lt; C')) + paragraph(run('第二段'))))
  assert.equal(parsed.text, 'A & B < C\n\n第二段')
  assert.equal(parsed.meta.paragraphCount, 2)
})

test('列表项：w:numPr 转成 "- "，列表项数与段落数各自计数', () => {
  const parsed = parseDocx(makeDocx(bullet('项目一') + bullet('项目二')))
  assert.equal(parsed.text, '- 项目一\n\n- 项目二')
  assert.equal(parsed.meta.listItemCount, 2)
  assert.equal(parsed.meta.paragraphCount, 2)
})

test('表格：转 Markdown 表格，保留行列，首行当表头', () => {
  const parsed = parseDocx(
    makeDocx(table(row(cell('城市'), cell('人口')), row(cell('北京'), cell('2100')))),
  )
  assert.equal(parsed.text, '| 城市 | 人口 |\n| --- | --- |\n| 北京 | 2100 |')
  assert.equal(parsed.meta.tableCount, 1)
})

test('表格：短行补空列、单元格内换行压成空格、管道符转义', () => {
  const multiParagraphCell = `<w:tc>${paragraph(run('第一行'))}${paragraph(run('第二行'))}</w:tc>`
  const parsed = parseDocx(
    makeDocx(table(row(cell('h1'), cell('h2'), cell('h3')), row(cell('x|y'), multiParagraphCell))),
  )
  assert.equal(parsed.text, '| h1 | h2 | h3 |\n| --- | --- | --- |\n| x\\|y | 第一行 第二行 |  |')
})

test('块顺序：标题 / 正文 / 列表 / 表格按文档顺序出现', () => {
  const parsed = parseDocx(
    makeDocx(
      heading(2, '总览') +
        paragraph(run('开场白')) +
        bullet('要点') +
        table(row(cell('k'), cell('v')), row(cell('1'), cell('2'))),
    ),
  )
  const blocks = parsed.text.split('\n\n')
  assert.deepEqual(blocks, [
    '## 总览',
    '开场白',
    '- 要点',
    '| k | v |\n| --- | --- |\n| 1 | 2 |',
  ])
})

test('同一个段落被拆成多个 run：按顺序拼接，pre 空格保留', () => {
  const parsed = parseDocx(
    makeDocx(`<w:p><w:r><w:t xml:space="preserve">前半 </w:t></w:r><w:r><w:t>后半</w:t></w:r></w:p>`),
  )
  assert.equal(parsed.text, '前半 后半')
})

test('段内软回车 w:br 与 w:tab 的处理', () => {
  const parsed = parseDocx(
    makeDocx(`<w:p><w:r><w:t>A</w:t></w:r><w:r><w:br/><w:t>B</w:t></w:r><w:r><w:tab/><w:t>C</w:t></w:r></w:p>`),
  )
  assert.equal(parsed.text, 'A\nB C')
})

test('内容控件（w:sdt）里包着的段落也算正文', () => {
  const parsed = parseDocx(
    makeDocx(`<w:sdt><w:sdtPr/><w:sdtContent>${paragraph(run('控件内的一段'))}</w:sdtContent></w:sdt>`),
  )
  assert.equal(parsed.text, '控件内的一段')
})

test('document.xml 是 UTF-16LE（带 BOM）时也能读', () => {
  const xml = documentXml(paragraph(run('十六位编码')))
  const bytes = new Uint8Array(2 + xml.length * 2)
  bytes[0] = 0xff
  bytes[1] = 0xfe
  for (let index = 0; index < xml.length; index += 1) {
    const code = xml.charCodeAt(index)
    bytes[2 + index * 2] = code & 0xff
    bytes[2 + index * 2 + 1] = code >> 8
  }
  const parsed = parseDocx(
    zipSync({ 'word/document.xml': bytes, '[Content_Types].xml': strToU8('<Types/>') }),
  )
  assert.equal(parsed.text, '十六位编码')
})

// ── 关闭条件 4：安全三条 ────────────────────────────────────────────────────

test('XXE：document.xml 带 <!DOCTYPE ... SYSTEM> 直接拒绝', () => {
  const xxe =
    `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` +
    `<w:document ${WORD_NS}><w:body>${paragraph(run('&xxe;'))}</w:body></w:document>`
  assert.throws(
    () => parseDocx(zipSync({ 'word/document.xml': strToU8(xxe) })),
    errorCode('xxe-blocked'),
  )
})

test('XXE：只带 <!ENTITY 声明（没有 DOCTYPE）也拒绝', () => {
  const xxe = `<w:document ${WORD_NS}><!ENTITY xxe "boom"><w:body>${paragraph(run('x'))}</w:body></w:document>`
  assert.throws(
    () => parseDocx(zipSync({ 'word/document.xml': strToU8(xxe) })),
    errorCode('xxe-blocked'),
  )
})

test('zip bomb：单条目声明解压尺寸超过 32MiB → 拒绝（解压前就拦）', () => {
  const bomb = zipSync({ 'word/document.xml': new Uint8Array(40 * 1024 * 1024) })
  assert.throws(() => parseDocx(bomb), errorCode('zip-bomb'))
})

test('zip bomb：各条目都没超限但解压总量超过 64MiB → 同样拒绝', () => {
  const part = () => new Uint8Array(22 * 1024 * 1024)
  const bomb = zipSync({
    'word/document.xml': strToU8(documentXml(paragraph(run('正文')))),
    'word/part1.xml': part(),
    'word/part2.xml': part(),
    'word/part3.xml': part(),
  })
  assert.throws(() => parseDocx(bomb), errorCode('zip-bomb'))
})

test('路径穿越：条目名里的 ../ 直接拒绝整包', () => {
  const traversal = makeDocx(paragraph(run('正文')), { '../evil.xml': strToU8('<x/>') })
  assert.throws(() => parseDocx(traversal), errorCode('path-traversal'))
})

test('路径穿越：绝对路径与 Windows 盘符同样拒绝', () => {
  const absolute = makeDocx(paragraph(run('正文')), { '/etc/evil.xml': strToU8('<x/>') })
  assert.throws(() => parseDocx(absolute), errorCode('path-traversal'))
  const drive = makeDocx(paragraph(run('正文')), { 'C:\\windows\\evil.xml': strToU8('<x/>') })
  assert.throws(() => parseDocx(drive), errorCode('path-traversal'))
})

test('坏 ZIP：乱码字节给明确错误，不漏 fflate 原始异常', () => {
  const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x99, 0xee, 0x11, 0x22, 0x33, 0x44])
  assert.throws(
    () => parseDocx(garbage),
    (error) => error instanceof DocxParseError && error.name === 'DocxParseError' && error.code === 'invalid-zip',
  )
  // 连 ZIP 签名都没有的随机字节
  assert.throws(() => parseDocx(strToU8('这不是 zip，只是一串字节')), errorCode('invalid-zip'))
})

test('缺 word/document.xml → missing-document，而不是当成空文档', () => {
  const noDocument = zipSync({ '[Content_Types].xml': strToU8('<Types/>') })
  assert.throws(() => parseDocx(noDocument), errorCode('missing-document'))
})

// ── 边界（#570「不阻塞关闭」那一节的行为落地） ──────────────────────────────

test('图片条目：忽略并给 media-ignored 警告，正文照常解析', () => {
  const parsed = parseDocx(
    makeDocx(paragraph(run('图在文末')), { 'word/media/image1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
  )
  assert.equal(parsed.text, '图在文末')
  assert.equal(parsed.meta.mediaCount, 1)
  assert.ok(parsed.warnings.includes(DOCX_WARNING.mediaIgnored))
})

test('嵌入对象（w:drawing）：忽略并给 objects-ignored 警告', () => {
  const parsed = parseDocx(
    makeDocx(`<w:p>${run('见图')}<w:r><w:drawing/></w:r></w:p>`),
  )
  assert.equal(parsed.text, '见图')
  assert.equal(parsed.meta.objectCount, 1)
  assert.ok(parsed.warnings.includes(DOCX_WARNING.objectsIgnored))
})

test('修订痕迹：w:del 里的删除文字不出现，并给 revisions-skipped 警告', () => {
  const parsed = parseDocx(
    makeDocx(
      `<w:p>${run('保留')}<w:del><w:r><w:delText>删掉</w:delText></w:r></w:del></w:p>`,
    ),
  )
  assert.equal(parsed.text, '保留')
  assert.equal(parsed.text.includes('删掉'), false)
  assert.ok(parsed.warnings.includes(DOCX_WARNING.revisionsSkipped))
})

test('空正文：text 为空但带 empty-body 警告（不静默）', () => {
  const parsed = parseDocx(makeDocx(''))
  assert.equal(parsed.text, '')
  assert.deepEqual(parsed.warnings, [DOCX_WARNING.emptyBody])
  assert.equal(parsed.meta.paragraphCount, 0)
})

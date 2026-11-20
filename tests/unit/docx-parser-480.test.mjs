// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #480 §5.2：DOCX 解析器的提取规则与安全闸。
//
// 断言分四组，对应 Issue 的硬要求：
// 1. [结构] 标题 / 段落 / 列表 / 表格按**文档顺序**产 Markdown —— 反向断言「不是把所有
//    文本节点拼起来」（同一段文字在拼接实现里会丢掉层级与行列关系）；
// 2. [合并单元格] 跨列 gridSpan 只留首列、跨行 vMerge 留空，并在 warnings 里报数；
// 3. [忽略对象] 图片 / 图表 / OLE / 文本框只计数进 warnings，正文里不出现其内部文字；
// 4. [安全] 20 MiB 上限、条目数上限、XXE 声明剥离、非 ZIP 与缺主文档的明确报错。
//
// 夹具用 fflate 的 zipSync 现场拼（与产品代码同一个解包库），不落任何二进制到仓库。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { zipSync, strToU8 } from 'fflate'

// 产品代码内部按 NodeNext 写 `.js` 后缀（真实编译单元是 .ts），这里把后缀映射回去，
// 与 tests/unit/limits-config.test.mjs 里的做法保持一致。
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

const { parseDocxFile, parseDocx, DOCX_PARSER_VERSION, DocxParseError } = await import(
  '../../src/services/attachments/parsers/docx.ts'
)
const { ATTACHMENT_LIMITS } = await import('../../src/services/attachments/limits.ts')

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const body = (inner) => `${HEAD}<w:document ${NS}><w:body>${inner}</w:body></w:document>`
const paragraph = (text, props) =>
  `<w:p>${props === undefined ? '' : `<w:pPr>${props}</w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text, props) =>
  `<w:tc>${props === undefined ? '' : `<w:tcPr>${props}</w:tcPr>`}<w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`
const row = (cells) => `<w:tr>${cells.join('')}</w:tr>`

/** files: { 路径: 字符串 | Uint8Array } → docx 字节 */
const docxOf = (files) => {
  const table = {}
  for (const key of Object.keys(files)) {
    const value = files[key]
    table[key] = typeof value === 'string' ? strToU8(value) : value
  }
  return zipSync(table)
}

const blobOf = (bytes) => new Blob([bytes])

const NUMBERING = `${HEAD}<w:numbering ${NS}>
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

const STYLES = `${HEAD}<w:styles ${NS}>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>`

const listItem = (numId, level, text) =>
  paragraph(
    text,
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`
  )

test('#480 标题 / 段落 / 列表 / 表格按文档顺序转 Markdown', async () => {
  const xml = body(
    [
      paragraph('第一章 概述', '<w:pStyle w:val="Heading1"/>'),
      paragraph('正文第一段。'),
      paragraph('1.1 小节', '<w:pStyle w:val="Heading2"/>'),
      listItem(1, 0, '无序甲'),
      listItem(1, 1, '无序甲·子项'),
      listItem(2, 0, '有序一'),
      '<w:tbl><w:tblPr/><w:tr>' +
        cell('列一') +
        cell('列二') +
        '</w:tr><w:tr>' +
        cell('A2') +
        cell('B2') +
        '</w:tr></w:tbl>',
      paragraph('表格后的段落。'),
    ].join('')
  )
  const parsed = await parseDocxFile(
    blobOf(
      docxOf({
        'word/document.xml': xml,
        'word/numbering.xml': NUMBERING,
        'word/styles.xml': STYLES,
      })
    )
  )

  assert.equal(parsed.parserVersion, DOCX_PARSER_VERSION)
  assert.equal(parsed.characterCount, parsed.text.length)
  assert.equal(
    parsed.text,
    [
      '# 第一章 概述',
      '',
      '正文第一段。',
      '',
      '## 1.1 小节',
      '',
      '- 无序甲',
      '  - 无序甲·子项',
      '',
      '1. 有序一',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| A2 | B2 |',
      '',
      '表格后的段落。',
    ].join('\n')
  )
  // 结构没有被「文本节点拼接」压平：标题层级与表格分隔行都在
  assert.match(parsed.text, /^# 第一章 概述$/m)
  assert.match(parsed.text, /^\| --- \| --- \|$/m)
  assert.ok((parsed.warnings ?? []).some((warning) => warning.includes('1 个表格')))
})

test('#480 合并单元格：跨列只留首列、跨行留空，并在 warnings 报数', async () => {
  const xml = body(
    '<w:tbl><w:tblPr/>' +
      row([cell('表头跨两列', '<w:gridSpan w:val="2"/>'), cell('第三列')]) +
      row([cell('纵向合并', '<w:vMerge w:val="restart"/>'), cell('B2'), cell('含|竖线')]) +
      row([cell('', '<w:vMerge/>'), cell('B3'), cell('C3')]) +
      '</w:tbl>'
  )
  const parsed = await parseDocxFile(blobOf(docxOf({ 'word/document.xml': xml })))
  assert.equal(
    parsed.text,
    [
      '| 表头跨两列 |  | 第三列 |',
      '| --- | --- | --- |',
      '| 纵向合并 | B2 | 含\\|竖线 |',
      '|  | B3 | C3 |',
    ].join('\n')
  )
  const merged = (parsed.warnings ?? []).find((warning) => warning.includes('合并单元格'))
  assert.ok(merged !== undefined, '合并单元格必须进 warnings')
  assert.match(merged, /3 处/)
})

test('#480 图片 / 图表 / OLE / 文本框只计数进 warnings，正文不含其内部文字', async () => {
  const xml = body(
    [
      '<w:p><w:r><w:t>图前</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>',
      '<w:p><w:r><w:drawing><c:chart r:id="rId6"/></w:drawing></w:r></w:p>',
      '<w:p><w:r><w:object><v:shape/><o:OLEObject Type="Embed"/></w:object></w:r></w:p>',
      '<w:p><w:r><mc:AlternateContent>' +
        '<mc:Choice><w:drawing><w:txbxContent><w:p><w:r><w:t>文本框里的字不该出现</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice>' +
        '<mc:Fallback><w:pict><v:textbox><w:txbxContent><w:p><w:r><w:t>旧版副本</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></mc:Fallback>' +
        '</mc:AlternateContent></w:r></w:p>',
    ].join('')
  )
  const parsed = await parseDocxFile(blobOf(docxOf({ 'word/document.xml': xml })))
  assert.equal(parsed.text, '图前')
  const warnings = (parsed.warnings ?? []).join(' | ')
  assert.match(warnings, /已忽略 1 张图片/)
  assert.match(warnings, /已忽略 1 个图表对象/)
  assert.match(warnings, /已忽略 1 个嵌入对象/)
  assert.match(warnings, /已忽略 1 个文本框/)
  // mc:Fallback 是 mc:Choice 的旧版副本，同一对象不能被数两遍
  assert.doesNotMatch(warnings, /已忽略 2 个文本框/)
})

test('#480 XXE：DOCTYPE/ENTITY 被剥离，未知名实体原样保留、不展开', async () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>' +
    body(paragraph('&xxe;标题')).slice('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'.length)
  const parsed = await parseDocxFile(blobOf(docxOf({ 'word/document.xml': xml })))
  assert.equal(parsed.text, '&xxe;标题')
  assert.ok((parsed.warnings ?? []).some((warning) => warning.includes('DOCTYPE')))
})

test('#480 安全闸：非 ZIP / 缺主文档 / 超过 20 MiB / 条目数超限都明确失败', async () => {
  const notZip = blobOf(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x00, 0x00]))
  await assert.rejects(parseDocxFile(notZip), (error) => {
    assert.ok(error instanceof DocxParseError)
    assert.equal(error.code, 'not_docx')
    return true
  })

  const missing = blobOf(docxOf({ 'word/styles.xml': STYLES }))
  await assert.rejects(parseDocxFile(missing), (error) => {
    assert.equal(error.code, 'missing_document')
    return true
  })

  const oversized = blobOf(new Uint8Array(ATTACHMENT_LIMITS.docxMaxBytes + 1))
  oversized.arrayBuffer // 不读内容，只测体积闸：解包前就要拒绝
  await assert.rejects(parseDocxFile(oversized), (error) => {
    assert.equal(error.code, 'too_large')
    assert.match(error.message, /20\.0 MiB/)
    return true
  })

  const files = { 'word/document.xml': body(paragraph('正文')) }
  for (let index = 0; index <= ATTACHMENT_LIMITS.maxZipEntries; index += 1) {
    files[`word/media/f${index}.bin`] = 'x'
  }
  await assert.rejects(parseDocxFile(blobOf(docxOf(files))), (error) => {
    assert.equal(error.code, 'too_many_entries')
    return true
  })
})

test('#480 字节入口拒绝旧版 .doc，并复用同一份实现', async () => {
  const bytes = docxOf({ 'word/document.xml': body(paragraph('字节入口')) })
  await assert.rejects(parseDocx(bytes, '旧文档.doc'), (error) => {
    assert.equal(error.code, 'not_docx')
    return true
  })
  const parsed = await parseDocx(bytes, '报告.docx')
  assert.equal(parsed.text, '字节入口')
})

test('#480 空文档给出可展示的 warning，而不是静默成功', async () => {
  const parsed = await parseDocxFile(
    blobOf(docxOf({ 'word/document.xml': body('<w:p><w:pPr/></w:p>') }))
  )
  assert.equal(parsed.text, '')
  assert.equal(parsed.characterCount, 0)
  assert.ok((parsed.warnings ?? []).some((warning) => warning.includes('未从文档中提取到任何文本')))
})

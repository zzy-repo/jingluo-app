#!/usr/bin/env node
// [fixture | #480 验收测试 | 无网络、无浏览器]
//
// #528 L0/L1 的**自建最小样本**生成器。产物已随仓库提交（二进制），这个脚本只负责
// 「这些字节是怎么来的」可复现 —— 有人怀疑某个 fixture 的时候，删掉重跑即可得到同一份字节：
//
//   node tests/fixtures/480/build-fixtures.mjs
//
// 为什么不用真实业务文件：真实文档带用户内容、带体积、带不该进仓库的元数据；验收测试要的是
// **最小充分**样本（一个真 docx / 一个带文本层 pdf / 一个空 pdf / 6 种编码样本），
// 每条断言都能指着某几个字节说话。
//
// 生成物清单见同目录 README.md。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const write = (relative, bytes) => {
  const target = path.join(HERE, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  console.log(`  ${relative}  ${bytes.length} B`)
}

// ─────────────────────────────── TXT：6 种编码 ───────────────────────────────
//
// 每个样本都是**一行**中文 + ASCII 混合（issue #528「6 编码各 1 行」）：
// 纯 ASCII 在任何编码下都一样，测不出编码识别；纯中文在等宽编码里才有区分度。

const LINE = '编码样本 480 验收：第一行文本'

/** UTF-8 编码（Node 的 TextEncoder 只有这一种） */
const utf8 = (text) => new Uint8Array(Buffer.from(text, 'utf8'))

/** UTF-16（BOM + 逐码元小端/大端） */
const utf16 = (text, little) => {
  const bytes = new Uint8Array(2 + text.length * 2)
  bytes[0] = little ? 0xff : 0xfe
  bytes[1] = little ? 0xfe : 0xff
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const at = 2 + index * 2
    bytes[at] = little ? code & 0xff : code >> 8
    bytes[at + 1] = little ? code >> 8 : code & 0xff
  }
  return bytes
}

/**
 * GBK / GB18030：浏览器侧没有编码器（只有解码器），所以这里写**固定码表字节**。
 *
 * 「中文测试」的 GBK 码：中 D6D0 / 文 CEC4 / 测 B2E2 / 试 CAD4 —— 这四个是 GB2312 一级汉字，
 * GBK 与 GB18030 的编码完全一致，所以 GBK 样本直接用它们。
 *
 * GB18030 需要一段**四字节序列**才和 GBK 区分得开（`hasGb18030FourByte`），
 * 所以样本里放 `95 32 82 36`（U+20BB7 之外的一个合法四字节码位，解码结果由
 * TextDecoder('gb18030') 读出，见下面的 `gb18030Line()`）：断言侧用同一个解码器取期望值，
 * 不写死某个我记错的字符。
 */
const gbkBytes = () =>
  Uint8Array.from([
    ...Buffer.from('GBK sample: ', 'latin1'),
    0xd6,
    0xd0,
    0xce,
    0xc4,
    0xb2,
    0xe2,
    0xca,
    0xd4, // 中文测试
    ...Buffer.from(' ok', 'latin1'),
  ])

/** GB18030：ASCII + 四字节序列（不落在 GBK 的两字节空间里） */
const gb18030Bytes = () =>
  Uint8Array.from([
    ...Buffer.from('GB18030 sample: ', 'latin1'),
    0x95,
    0x32,
    0x82,
    0x36,
    ...Buffer.from(' ok', 'latin1'),
  ])

/** 期望文本：交给浏览器同一个解码器算，避免手抄码位出错 */
export const gb18030Line = () =>
  new TextDecoder('gb18030').decode(gb18030Bytes())

export const gbkLine = () => new TextDecoder('gbk').decode(gbkBytes())

// ─────────────────────────────── PDF ───────────────────────────────
//
// 手写 PDF（不引第三方库）：1 个 Catalog + N 个 Page + Helvetica 文本流。
// xref 偏移按真实字节算，所以它是**规范合法**的 PDF —— poppler 的 `pdftotext` 能取到文本层
// （生成时实测：`pdftotext pdf/text-layer.pdf -` → "[第1页] Hello 480 page 1"）。

const encodePdfObjects = (objects) => {
  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  let body = ''
  const offsets = []
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(header.length + body.length)
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefAt = header.length + body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${arguments[1] ?? ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return new Uint8Array(Buffer.from(header + body + xref + trailer, 'latin1'))
}

/** 一个页面对象 + 它的内容流（`lines` 为空 = 有页面但没有文本层） */
const pageObjects = (pageTexts) => {
  const objects = []
  const pagesIndex = 1
  const firstPageObject = 3
  const fontObject = firstPageObject + pageTexts.length * 2
  const kids = []
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageNo = firstPageObject + index * 2
    const contentNo = pageNo + 1
    kids.push(`${pageNo} 0 R`)
    const lines = pageTexts[index]
    let stream = ''
    if (lines.length > 0) {
      stream = 'BT /F1 14 Tf 72 760 Td 18 TL\n'
      for (const line of lines) {
        stream += `(${line}) Tj T*\n`
      }
      stream += 'ET'
    }
    objects.push(
      `<< /Type /Page /Parent ${pagesIndex + 1} 0 R /MediaBox [0 0 595 842] ` +
        `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentNo} 0 R >>`
    )
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  return {
    /** 对象数组（1 = Catalog 由调用方补） */
    objects,
    kids,
    fontObject,
  }
}

const buildPdf = (pageTexts, trailerExtra = '') => {
  const { objects, kids, fontObject } = pageObjects(pageTexts)
  const full = []
  full.push('<< /Type /Catalog /Pages 2 0 R >>')
  full.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`)
  for (const object of objects) {
    full.push(object)
  }
  // 字体对象必须排在正文对象之后（页码在 pageObjects 里已经算好）
  full.splice(fontObject - 1, 0, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const header = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  let body = ''
  const offsets = []
  for (let index = 0; index < full.length; index += 1) {
    offsets.push(header.length + body.length)
    body += `${index + 1} 0 obj\n${full[index]}\nendobj\n`
  }
  const xrefAt = header.length + body.length
  let xref = `xref\n0 ${full.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  const trailer =
    `trailer\n<< /Size ${full.length + 1} /Root 1 0 R${trailerExtra} >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`
  return new Uint8Array(Buffer.from(header + body + xref + trailer, 'latin1'))
}

// ─────────────────────────────── DOCX ───────────────────────────────

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

const docOf = (bodyInner) => `${HEAD}<w:document ${NS}><w:body>${bodyInner}</w:body></w:document>`

const para = (text, props = '') =>
  `<w:p>${props === '' ? '' : `<w:pPr>${props}</w:pPr>`}<w:r><w:t>${text}</w:t></w:r></w:p>`

const listItem = (numId, level, text) =>
  para(text, `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`)

const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`

const pngBytes = () =>
  Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AL0AAAAASUVORK5CYII=',
      'base64'
    )
  )

const zipOf = (files) => {
  const table = {}
  for (const key of Object.keys(files)) {
    table[key] = typeof files[key] === 'string' ? strToU8(files[key]) : files[key]
  }
  return zipSync(table)
}

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

const RELS = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`

/** 一张真图片（drawing + 内嵌 png）：正文里不该出现图片内部的任何东西，只该有一条「已忽略」warning */
const IMAGE_PARAGRAPH = `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="图片 1"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>
</wp:inline></w:drawing></w:r></w:p>`

const DOCX_MAIN_BODY = [
  para('480 验收报告', '<w:pStyle w:val="Heading1"/>'),
  para('这是第一段正文，用于断言段落提取。'),
  para('1.1 小节标题', '<w:pStyle w:val="Heading2"/>'),
  listItem(1, 0, '无序列表项甲'),
  listItem(1, 1, '无序列表项甲的子项'),
  listItem(2, 0, '有序列表项一'),
  '<w:tbl><w:tblPr/><w:tr>' + cell('列一') + cell('列二') + '</w:tr>' +
    '<w:tr>' + cell('A2') + cell('B2') + '</w:tr></w:tbl>',
  IMAGE_PARAGRAPH,
  para('图片之后的收尾段落。'),
].join('')

const generate = async () => {
  console.log('[480 fixtures]')

  // TXT 6 编码
  write('enc/utf8.txt', utf8(LINE))
  write('enc/utf8-bom.txt', Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8(LINE)]))
  write('enc/utf16le.txt', utf16(LINE, true))
  write('enc/utf16be.txt', utf16(LINE, false))
  write('enc/gbk.txt', gbkBytes())
  write('enc/gb18030.txt', gb18030Bytes())

  // TXT 异常分支
  write('txt/empty.txt', new Uint8Array(0))
  write('txt/binary.txt', Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x1b, 0x07, 0x00, 0x7f, 0x02]))
  // 乱码：合法 UTF-8 里掺 2 个坏字节（未使用的 0xC3 后跟 0x28），属于「有损但可尽力解码」
  write(
    'txt/mojibake.txt',
    Uint8Array.from([...utf8('乱码样本：'), 0xc3, 0x28, ...utf8('尾行')])
  )

  // DOCX
  write(
    'docx/minimal.docx',
    zipOf({
      '[Content_Types].xml': `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
      'word/document.xml': docOf(DOCX_MAIN_BODY),
      'word/numbering.xml': NUMBERING,
      'word/styles.xml': STYLES,
      'word/_rels/document.xml.rels': RELS,
      'word/media/image1.png': pngBytes(),
    })
  )
  // XXE：DOCTYPE + 外部实体 + 内部实体。解析器必须剥离声明、原样保留未知实体，绝不展开
  write(
    'docx/xxe.docx',
    zipOf({
      'word/document.xml':
        `${HEAD}` +
        '<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
        docOf(
          `<w:p><w:r><w:t>&xxe; 正文不该展开外部实体</w:t></w:r></w:p>` +
            para('XXE 后的普通段落')
        ),
    })
  )
  // 路径穿越：条目名带 ../，且把主文档藏在这种名字下 —— 白名单之外，必须摸不到
  write(
    'docx/path-traversal.docx',
    zipOf({
      'word/document.xml': docOf(para('正常主文档')),
      '../../../../etc/passwd': 'root:x:0:0:root:/root:/bin/bash\n',
      'word/../../../../evil.xml': docOf(para('穿越路径下的假主文档，绝不该被读')),
    })
  )
  write(
    'docx/traversal-only.docx',
    zipOf({
      'word/../../../../evil.xml': docOf(para('只有穿越路径的主文档')),
      '../../etc/passwd': 'root:x:0:0:root:/root:/bin/bash\n',
    })
  )
  // 解压炸弹：40 MiB 的 0 压缩后约 40 KiB（压缩比 1000:1，越过 zipReader 的 200:1 闸）
  const zeros = new Uint8Array(40 * 1024 * 1024)
  write(
    'docx/zip-bomb.docx',
    zipSync({
      'word/document.xml': strToU8(docOf(para('炸弹外壳'))),
      'word/media/bomb.bin': zeros,
    })
  )

  // PDF
  write('pdf/text-layer.pdf', buildPdf([['Hello 480 page 1', 'second line'], ['Hello 480 page 2']]))
  write('pdf/empty.pdf', buildPdf([[]]))
  write(
    'pdf/encrypted.pdf',
    buildPdf([['secret']], ' /Encrypt << /Filter /Standard /V 2 /R 3 >>')
  )
  write('pdf/not-a-pdf.pdf', Uint8Array.from(Buffer.from('这其实是一段纯文本，扩展名骗人\n')))
  console.log('[480 fixtures] done')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await generate()
}

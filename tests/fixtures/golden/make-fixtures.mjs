#!/usr/bin/env node
/**
 * make-fixtures.mjs —— g13（文档附件）/ g14（图片 vision）黄金用例的**最小真二进制夹具**生成器。
 * Issue #567（三主线各补一条黄金回归）。
 *
 * ## 为什么要有这个脚本
 * 这两条黄金用例都需要「一份真文件」喂进真实解析链路，而**手搓 base64** 是这几天反复踩的坑：
 * 有人在用例里拼了一串 base64 当 png，前缀对、CRC 错，浏览器 `<img>` 直接不出图；
 * 也有拼出来的 docx 少了 `_rels/.rels`，`zipReader` 读得到条目、OOXML 侧却认不出主文档。
 * 这类「假绿/假红」在用例侧极难定位 —— 断言失败看起来像产品坏了。
 *
 * 所以夹具改成**脚本生成的真二进制**：结构由代码保证（CRC、xref 偏移、zip 中央目录全部算出来），
 * 产物入库，用例直接读文件，不再有任何字符串层面的手拼。
 *
 * ## 产物（全部 < 2 KB，入库）
 * | 文件 | 内容 | 谁用 |
 * | --- | --- | --- |
 * | `tiny.txt` | 3 段中英混排纯文本 | g13（`parseTxtFile`） |
 * | `tiny.docx` | 合法 OOXML：1 标题 + 1 正文段 + 1 个 2×2 表格 | g13（`parseDocxFile`） |
 * | `tiny.pdf` | 1 页、有文本层，正文含 `Hello golden` | g13（`parsePdfFile`，pdfjs） |
 * | `tiny.png` | 8×8 纯色 RGB | g14（vision 上传） |
 *
 * ## 只依赖 node 内建
 * zip 用 `node:zlib` 的 `deflateRawSync` + 手写中央目录；PNG 的 IDAT 就是 zlib 流；
 * PDF 手写最小结构。**不引第三方包** —— 生成脚本要在任何一台装了 node 的机器上能重跑。
 *
 * ## 幂等
 * 时间戳固定（DOS 1980-01-01 00:00:00）、条目顺序固定、压缩级别固定，且脚本自己会
 * 「生成两遍比对字节」；内容没变时不重写文件（`unchanged`），所以 `git status` 也不脏。
 *
 * ## 自检（解析不过就 throw）
 * 1. 字节级结构自检：zip 中央目录 / 每个条目 CRC / PNG 每个 chunk 的 CRC / PDF 的 xref 偏移
 *    与 `/Length` —— 这一层不依赖任何产品代码，永远跑。
 * 2. 真解析器自检：`src/services/attachments/parsers/{txt,docx,pdf}.ts`（#480／#548 落地后才有）
 *    存在就 **真的解析一遍**并断言取到了预期文本/表格，解析失败直接 throw；
 *    文件还不在这条分支上（#480 未合入 main）或运行环境缺件（node 没有 pdfjs）时，
 *    打印一行 `SKIP` 并说明原因，**不假装通过**。
 *
 * 用法：
 *   node tests/fixtures/golden/make-fixtures.mjs            # 生成 + 自检
 *   node tests/fixtures/golden/make-fixtures.mjs --check    # 只自检，不写盘（CI/评审用）
 *   node tests/fixtures/golden/make-fixtures.mjs --json     # 机器可读结果
 *
 * 退出码：0 通过 / 1 自检失败 / 2 用法错误。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')

/** 单文件体积上限（golden 要求轻量：夹具是「能跑通链路的最小合法文件」，不是样本集） */
const MAX_BYTES = 2048

// ---------------------------------------------------------------- 小工具

/** CRC-32（zip 与 PNG 都用它；表驱动，输出与 zlib.crc32 一致） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

const crc32 = (bytes) => {
  let c = -1
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const u16 = (value) => {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value, 0)
  return buf
}

const u32 = (value) => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

/** 大端 32 位（PNG 的长度与 CRC 都是大端，zip 那一套是小端，别混） */
const be32 = (value) => {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(value >>> 0, 0)
  return buf
}

const utf8 = (text) => Buffer.from(text, 'utf8')

// ---------------------------------------------------------------- tiny.txt

/** 3 段中英混排：够断言「段落切分 + 编码」两条，又不浪费体积 */
const TXT_CONTENT =
  [
    '黄金夹具 tiny.txt：中文一段。',
    'Second paragraph: golden fixture, mixed 中英 文字。',
    '第三段 end.',
  ].join('\n\n') + '\n'

// ---------------------------------------------------------------- tiny.docx（最小 OOXML）

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

/**
 * `word/document.xml`：标题（Heading1）+ 1 段正文 + 1 个 2×2 表格。
 *
 * 表格按真实 OOXML 写全 `w:tblPr` / `w:tblGrid` / `w:tr` / `w:tc` —— 解析器要还原行列关系
 * （#480 §5.2 明确不能「拼所有文本节点」），缺 `w:tblGrid` 的实现差异正是夹具要挡住的那类退化。
 */
const DOCX_DOCUMENT =
  `${XML_HEAD}<w:document ${W_NS}><w:body>` +
  '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Golden 夹具标题</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>正文一段：docx fixture body, 中英混排。</w:t></w:r></w:p>' +
  '<w:tbl><w:tblPr/>' +
  '<w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
  '<w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr>' +
  '<w:tr><w:tc><w:p><w:r><w:t>丙</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>丁</w:t></w:r></w:p></w:tc></w:tr>' +
  '</w:tbl>' +
  '</w:body></w:document>'

/** `word/styles.xml`：只有 Heading1 —— 解析器判标题要么认 `pStyle=Heading1`，要么认 outlineLvl */
const DOCX_STYLES =
  `${XML_HEAD}<w:styles ${W_NS}>` +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>' +
  '<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '</w:styles>'

const CONTENT_TYPES =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>'

const ROOT_RELS =
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>'

const DOC_RELS =
  `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>'

/** 条目顺序固定（幂等的前提之一）——`[Content_Types].xml` 必须第一个，Word 与多数解析器都这么读 */
const DOCX_ENTRIES = [
  ['[Content_Types].xml', CONTENT_TYPES],
  ['_rels/.rels', ROOT_RELS],
  ['word/document.xml', DOCX_DOCUMENT],
  ['word/_rels/document.xml.rels', DOC_RELS],
  ['word/styles.xml', DOCX_STYLES],
]

/** 固定时间戳：DOS 1980-01-01 00:00:00（`date` 0x21 = 1980 年 1 月 1 日） */
const DOS_TIME = 0
const DOS_DATE = 0x21

/**
 * 手写最小 zip（deflate）—— 只支持我们要的那点结构：
 * 每条目 local header + 数据，末尾中央目录 + EOCD。UTF-8 文件名走 flag bit 11。
 */
const buildZip = (entries) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of entries) {
    const nameBytes = utf8(name)
    const raw = utf8(text)
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const crc = crc32(raw)
    const local = Buffer.concat([
      u32(0x04034b50), // local file header
      u16(20), // version needed
      u16(0x0800), // flags：文件名是 UTF-8
      u16(8), // method：deflate
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(deflated.length),
      u32(raw.length),
      u16(nameBytes.length),
      u16(0), // extra
      nameBytes,
      deflated,
    ])
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), // central directory header
        u16(20), // version made by
        u16(20), // version needed
        u16(0x0800),
        u16(8),
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(deflated.length),
        u32(raw.length),
        u16(nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        nameBytes,
      ])
    )
    locals.push(local)
    offset += local.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ])
  return Buffer.concat([...locals, centralDir, eocd])
}

// ---------------------------------------------------------------- tiny.png（8×8 纯色）

const PNG_W = 8
const PNG_H = 8
const PNG_RGB = [0x33, 0x66, 0xcc] // 纯色：#3366cc

/** PNG chunk：长度 + 类型 + 数据 + 类型与数据一起的 CRC */
const pngChunk = (type, data) => {
  const typeBytes = utf8(type)
  const body = Buffer.concat([typeBytes, data])
  return Buffer.concat([be32(data.length), body, be32(crc32(body))])
}

const buildPng = () => {
  const ihdr = Buffer.concat([
    be32(PNG_W),
    be32(PNG_H),
    Buffer.from([8, 2, 0, 0, 0]), // 位深 8、颜色类型 2（RGB）、压缩 0、滤波 0、隔行 0
  ])
  const raw = Buffer.alloc(PNG_H * (1 + PNG_W * 3))
  for (let y = 0; y < PNG_H; y += 1) {
    const rowStart = y * (1 + PNG_W * 3)
    raw[rowStart] = 0 // 每行的滤波字节：0 = None
    for (let x = 0; x < PNG_W; x += 1) {
      const p = rowStart + 1 + x * 3
      raw[p] = PNG_RGB[0]
      raw[p + 1] = PNG_RGB[1]
      raw[p + 2] = PNG_RGB[2]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- tiny.pdf（1 页、有文本层）

/**
 * 正文必须是 `Hello golden`（#567 指定），但同时要过 #480 的 `pdfMinCharsPerPage = 20` 闸，
 * 所以第一行放 `Hello golden`、第二行补一句说明，凑够可提取字符数。
 */
const PDF_LINES = ['Hello golden', 'Hello golden fixture: tiny pdf with a real text layer.']
const PDF_CONTENT_STREAM = [
  'BT',
  '/F1 18 Tf',
  '72 760 Td',
  `(${PDF_LINES[0]}) Tj`,
  '0 -28 Td',
  '/F1 12 Tf',
  `(${PDF_LINES[1]}) Tj`,
  'ET',
].join('\n')

/** 手写最小 PDF：xref 偏移按实际写出位置算，`/Length` 用内容流的真实字节数 */
const buildPdf = () => {
  const contentBytes = utf8(PDF_CONTENT_STREAM)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${contentBytes.length} >>\nstream\n${PDF_CONTENT_STREAM}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  let size = chunks[0].length
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(size)
    const chunk = utf8(`${index + 1} 0 obj\n${body}\nendobj\n`)
    chunks.push(chunk)
    size += chunk.length
  })
  const xrefStart = size
  const pad = (n) => String(n).padStart(10, '0')
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${pad(offset)} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefStart),
    '%%EOF',
    '',
  ].join('\n')
  chunks.push(utf8(xref))
  return Buffer.concat(chunks)
}

// ---------------------------------------------------------------- 自检 1：字节级结构

const fail = (name, message) => {
  throw new Error(`[selfcheck] ${name}：${message}`)
}

/** 读 zip 中央目录，逐条目比对 CRC 并解压出原文 */
const inspectZip = (bytes) => {
  const eocdPos = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdPos < 0) fail('tiny.docx', '找不到 EOCD（不是合法 zip）')
  const count = bytes.readUInt16LE(eocdPos + 10)
  const cdSize = bytes.readUInt32LE(eocdPos + 12)
  const cdOffset = bytes.readUInt32LE(eocdPos + 16)
  if (cdOffset + cdSize !== eocdPos)
    fail('tiny.docx', `中央目录位置不自洽（${cdOffset}+${cdSize} ≠ ${eocdPos}）`)
  const entries = new Map()
  let p = cdOffset
  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) fail('tiny.docx', `第 ${i + 1} 条中央目录签名不对`)
    const method = bytes.readUInt16LE(p + 10)
    const crc = bytes.readUInt32LE(p + 16)
    const csize = bytes.readUInt32LE(p + 20)
    const usize = bytes.readUInt32LE(p + 24)
    const nameLen = bytes.readUInt16LE(p + 28)
    const extraLen = bytes.readUInt16LE(p + 30)
    const commentLen = bytes.readUInt16LE(p + 32)
    const localOffset = bytes.readUInt32LE(p + 42)
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50)
      fail('tiny.docx', `${name} 的 local header 签名不对`)
    const localNameLen = bytes.readUInt16LE(localOffset + 26)
    const localExtraLen = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = bytes.subarray(dataStart, dataStart + csize)
    const raw = method === 0 ? data : zlib.inflateRawSync(data)
    if (raw.length !== usize)
      fail('tiny.docx', `${name} 解压后长度不符（${raw.length} ≠ ${usize}）`)
    if (crc32(raw) !== crc) fail('tiny.docx', `${name} 的 CRC 不符`)
    entries.set(name, raw.toString('utf8'))
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 解析 PNG：逐 chunk 校 CRC，IHDR 尺寸、IDAT 解压后大小 */
const inspectPng = (bytes) => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!bytes.subarray(0, 8).equals(signature)) fail('tiny.png', '文件头不是 PNG 签名')
  let p = 8
  const chunks = []
  let idat = Buffer.alloc(0)
  let width = 0
  let height = 0
  while (p < bytes.length) {
    const len = bytes.readUInt32BE(p)
    const type = bytes.subarray(p + 4, p + 8).toString('latin1')
    const data = bytes.subarray(p + 8, p + 8 + len)
    const crc = bytes.readUInt32BE(p + 8 + len)
    if (crc32(bytes.subarray(p + 4, p + 8 + len)) !== crc)
      fail('tiny.png', `${type} chunk 的 CRC 不符`)
    chunks.push(type)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 2)
        fail('tiny.png', `IHDR 期望 8bit/RGB，实际 ${data[8]}bit/type${data[9]}`)
    }
    if (type === 'IDAT') idat = Buffer.concat([idat, data])
    p += 12 + len
  }
  if (chunks[0] !== 'IHDR' || chunks[chunks.length - 1] !== 'IEND')
    fail('tiny.png', `chunk 序列不对：${chunks.join(',')}`)
  if (width !== PNG_W || height !== PNG_H)
    fail('tiny.png', `尺寸期望 ${PNG_W}×${PNG_H}，实际 ${width}×${height}`)
  const raw = zlib.inflateSync(idat)
  const expected = PNG_H * (1 + PNG_W * 3)
  if (raw.length !== expected)
    fail('tiny.png', `IDAT 解压后期望 ${expected} 字节，实际 ${raw.length}`)
  for (let y = 0; y < PNG_H; y += 1) {
    const rowStart = y * (1 + PNG_W * 3)
    if (raw[rowStart] !== 0) fail('tiny.png', `第 ${y} 行滤波字节不是 0`)
    for (let x = 0; x < PNG_W; x += 1) {
      const q = rowStart + 1 + x * 3
      if (raw[q] !== PNG_RGB[0] || raw[q + 1] !== PNG_RGB[1] || raw[q + 2] !== PNG_RGB[2]) {
        fail('tiny.png', `像素 (${x},${y}) 不是纯色`)
      }
    }
  }
  return { width, height, bytes: bytes.length }
}

/** 解析 PDF：页数、xref 每条偏移指向的对象号、内容流 /Length、文本层字面量 */
const inspectPdf = (bytes) => {
  const text = bytes.toString('latin1')
  if (!text.startsWith('%PDF-1.')) fail('tiny.pdf', '文件头不是 %PDF-1.x')
  const startxrefPos = text.lastIndexOf('startxref')
  if (startxrefPos < 0) fail('tiny.pdf', '缺 startxref')
  const xrefStart = Number(
    text
      .slice(startxrefPos + 'startxref'.length)
      .trim()
      .split(/\s+/)[0]
  )
  if (!Number.isFinite(xrefStart)) fail('tiny.pdf', 'startxref 不是数字')
  if (text.slice(xrefStart, xrefStart + 4) !== 'xref')
    fail('tiny.pdf', `startxref 指向的位置（${xrefStart}）不是 'xref'`)
  const header = /^xref\s+0\s+(\d+)\s*$/m.exec(text.slice(xrefStart))
  if (header === null) fail('tiny.pdf', 'xref 段头格式不对')
  const total = Number(header[1])
  const body = text.slice(xrefStart + header[0].length + 1)
  const entries = body.split('\n').slice(0, total)
  if (entries[0].trim() !== '0000000000 65535 f') fail('tiny.pdf', 'xref 第 0 条应是空闲条目')
  for (let i = 1; i < total; i += 1) {
    const m = /^(\d{10}) (\d{5}) n\s*$/.exec(entries[i] ?? '')
    if (m === null) fail('tiny.pdf', `xref 第 ${i} 条格式不对：${JSON.stringify(entries[i])}`)
    const offset = Number(m[1])
    const expected = `${i} 0 obj`
    if (text.slice(offset, offset + expected.length) !== expected) {
      fail('tiny.pdf', `xref 第 ${i} 条的偏移 ${offset} 没指向 '${expected}'`)
    }
  }
  // 页数：/Type /Page（不是 /Pages）
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
  if (pages !== 1) fail('tiny.pdf', `期望 1 页，实际 ${pages}`)
  // 内容流 /Length 必须等于真实字节数，否则 pdfjs 读流会截断
  const streamMatch = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text)
  if (streamMatch === null) fail('tiny.pdf', '找不到内容流')
  if (Number(streamMatch[1]) !== Buffer.byteLength(streamMatch[2], 'latin1')) {
    fail(
      'tiny.pdf',
      `/Length ${streamMatch[1]} 与内容流真实字节数 ${Buffer.byteLength(streamMatch[2], 'latin1')} 不符`
    )
  }
  if (!/\)\s*Tj/.test(streamMatch[2])) fail('tiny.pdf', '内容流里没有 Tj（文本层缺失）')
  for (const line of PDF_LINES) {
    if (!streamMatch[2].includes(`(${line}) Tj`))
      fail('tiny.pdf', `内容流里没有文本 ${JSON.stringify(line)}`)
  }
  if (text.includes('/Encrypt')) fail('tiny.pdf', '不该出现 /Encrypt（会被判成加密 PDF）')
  return { pages, textLines: PDF_LINES }
}

/** 结构自检的总入口：返回每个夹具的摘要 */
const structuralCheck = (files) => {
  const txt = files.get('tiny.txt').toString('utf8')
  const paragraphs = txt.trimEnd().split(/\n\n/)
  if (paragraphs.length < 2) fail('tiny.txt', `期望 ≥2 段，实际 ${paragraphs.length} 段`)
  if (!/[一-龥]/.test(txt) || !/[A-Za-z]/.test(txt)) fail('tiny.txt', '不是中英混排')

  const zip = inspectZip(files.get('tiny.docx'))
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
  ]) {
    if (!zip.has(required)) fail('tiny.docx', `缺必需条目 ${required}`)
  }
  const documentXml = zip.get('word/document.xml')
  if (!documentXml.includes('<w:pStyle w:val="Heading1"/>'))
    fail('tiny.docx', 'document.xml 里没有标题样式')
  const table = /<w:tbl>[\s\S]*<\/w:tbl>/.exec(documentXml)
  if (table === null) fail('tiny.docx', 'document.xml 里没有表格')
  const rows = table[0].match(/<w:tr>/g) ?? []
  if (rows.length !== 2) fail('tiny.docx', `表格期望 2 行，实际 ${rows.length}`)
  for (const [, row] of table[0].matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)) {
    const cells = row.match(/<w:tc>/g) ?? []
    if (cells.length !== 2) fail('tiny.docx', `表格每行期望 2 列，实际 ${cells.length}`)
  }

  const pdf = inspectPdf(files.get('tiny.pdf'))
  const png = inspectPng(files.get('tiny.png'))

  return {
    txt: { paragraphs: paragraphs.length },
    docx: { entries: zip.size, table: '2×2' },
    pdf,
    png,
  }
}

// ---------------------------------------------------------------- 自检 2：真解析器

/**
 * 产物 → 真解析器。三个都是 #480 的产物，**不在 main 上就没有**：
 * 缺文件不是夹具的问题，是「这条分支还没合入解析器」，打印 SKIP 而不是红。
 */
const PARSER_CASES = [
  {
    fixture: 'tiny.txt',
    module: 'src/services/attachments/parsers/txt.ts',
    fn: 'parseTxtFile',
    assert: (doc) => {
      if (!doc.text.includes('黄金夹具'))
        fail('tiny.txt', `parseTxtFile 没取到正文：${JSON.stringify(doc.text.slice(0, 80))}`)
      if (doc.characterCount < 10) fail('tiny.txt', `characterCount=${doc.characterCount} 太小`)
    },
  },
  {
    fixture: 'tiny.docx',
    module: 'src/services/attachments/parsers/docx.ts',
    fn: 'parseDocxFile',
    assert: (doc) => {
      if (!doc.text.includes('# '))
        fail('tiny.docx', `parseDocxFile 没还原出标题：${JSON.stringify(doc.text.slice(0, 120))}`)
      if (!doc.text.includes('正文一段')) fail('tiny.docx', 'parseDocxFile 没取到正文段')
      if (!doc.text.includes('| 甲') || !doc.text.includes('丁')) {
        fail('tiny.docx', `parseDocxFile 没还原出表格行列：${JSON.stringify(doc.text)}`)
      }
    },
  },
  {
    fixture: 'tiny.pdf',
    module: 'src/services/attachments/parsers/pdf.ts',
    fn: 'parsePdfFile',
    assert: (doc) => {
      if (!doc.text.includes('Hello golden'))
        fail('tiny.pdf', `parsePdfFile 没取到文本层：${JSON.stringify(doc.text)}`)
      if (doc.pages !== 1) fail('tiny.pdf', `期望 1 页，实际 ${doc.pages}`)
    },
    /** node 里没有 DOM/pdfjs 经典脚本，这几种 code 是**环境**问题，不是夹具坏了 */
    environmentCodes: ['libUnavailable', 'openFailed'],
  },
]

/**
 * #480 的 L0 专用「Node 侧 pdfjs 加载口」。`pdfLoader.ts` 是浏览器专属的 `<script src>` 注入口，
 * 在 node 里没有 document；这个文件把加载方式换成同一份 pdfjs-dist 2.16.105 的 UMD 产物，
 * 解析逻辑仍是 `pdf.ts` 的真代码。**它随 #480 落地才有**，没有就走「缺件 SKIP」。
 */
const PDF_NODE_LOADER = 'tests/fixtures/480/pdfjs-node-loader.mjs'

/** 产品代码里写 `.js` 后缀（NodeNext），真编译单元是 `.ts` —— 把后缀映射回去（同 tests/unit 的做法） */
const installTsResolve = async () => {
  const { registerHooks } = await import('node:module')
  const nodeLoader = path.join(ROOT, PDF_NODE_LOADER)
  const useNodePdfLoader = existsSync(nodeLoader)
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        useNodePdfLoader &&
        (specifier === './pdfLoader.js' || specifier.endsWith('/pdfLoader.js'))
      ) {
        return nextResolve(pathToFileURL(nodeLoader).href, context)
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
}

const parserCheck = async (files) => {
  const results = []
  let hooksReady = false
  for (const item of PARSER_CASES) {
    const abs = path.join(ROOT, item.module)
    if (!existsSync(abs)) {
      results.push({
        fixture: item.fixture,
        parser: item.fn,
        status: 'skip',
        reason: `${item.module} 不在本分支（#480 未合入 main）`,
      })
      continue
    }
    if (!hooksReady) {
      await installTsResolve()
      hooksReady = true
    }
    let mod
    try {
      mod = await import(pathToFileURL(abs).href)
    } catch (error) {
      // 解析器在，但它的依赖没装（例如没 `pnpm install`，fflate 缺失）—— 环境问题
      results.push({
        fixture: item.fixture,
        parser: item.fn,
        status: 'skip',
        reason: `模块加载失败：${error.message}`,
      })
      continue
    }
    const parse = mod[item.fn]
    if (typeof parse !== 'function') {
      results.push({
        fixture: item.fixture,
        parser: item.fn,
        status: 'skip',
        reason: `${item.module} 没有导出 ${item.fn}`,
      })
      continue
    }
    // src 里几个模块顶层会读打包期注入的 `__ENDPOINTS__`（同 tests/helpers/injected.mjs）
    if (typeof globalThis.__ENDPOINTS__ === 'undefined') {
      globalThis.__ENDPOINTS__ = { api: 'https://fixture.invalid', site: 'https://fixture.invalid' }
    }
    const blob = new Blob([files.get(item.fixture)])
    try {
      const doc = await parse(blob, { filename: item.fixture })
      item.assert(doc)
      results.push({
        fixture: item.fixture,
        parser: item.fn,
        status: 'pass',
        detail: `text=${doc.text.length} 字符 / characterCount=${doc.characterCount}${doc.pages === undefined ? '' : ` / pages=${doc.pages}`}`,
      })
    } catch (error) {
      const code = error && error.code
      if (item.environmentCodes && item.environmentCodes.includes(code)) {
        results.push({
          fixture: item.fixture,
          parser: item.fn,
          status: 'skip',
          reason: `环境缺件（${code}）：${error.message} —— 真解析由对应黄金用例在真浏览器里跑`,
        })
        continue
      }
      // 夹具本身解析不过 —— 这就是要 throw 的情况
      throw new Error(`[selfcheck] ${item.fixture} 过不了真解析器 ${item.fn}：${error.message}`)
    }
  }
  return results
}

// ---------------------------------------------------------------- 主流程

const buildAll = () => {
  const files = new Map()
  files.set('tiny.txt', utf8(TXT_CONTENT))
  files.set('tiny.docx', buildZip(DOCX_ENTRIES))
  files.set('tiny.pdf', buildPdf())
  files.set('tiny.png', buildPng())
  return files
}

const main = async () => {
  const argv = process.argv.slice(2)
  const checkOnly = argv.includes('--check')
  const asJson = argv.includes('--json')
  const unknown = argv.filter((a) => !['--check', '--json'].includes(a))
  if (unknown.length > 0) {
    console.error(`不认识的参数：${unknown.join(' ')}（支持 --check / --json）`)
    process.exit(2)
  }

  // 幂等自检第 1 层：同一进程生成两遍，字节必须完全一致
  const files = buildAll()
  const again = buildAll()
  for (const [name, bytes] of files) {
    if (!bytes.equals(again.get(name)))
      throw new Error(`[selfcheck] ${name}：两次生成的字节不同（不幂等）`)
    if (bytes.length >= MAX_BYTES)
      throw new Error(`[selfcheck] ${name}：${bytes.length} 字节，超过 ${MAX_BYTES} 上限`)
  }

  const summary = structuralCheck(files)
  const statuses = []
  for (const [name, bytes] of files) {
    const target = path.join(HERE, name)
    const existing = existsSync(target) ? await readFile(target) : null
    let action = 'unchanged'
    if (existing === null) action = 'created'
    else if (!existing.equals(bytes)) action = 'updated'
    if (!checkOnly && action !== 'unchanged') await writeFile(target, bytes)
    if (checkOnly && action !== 'unchanged')
      throw new Error(
        `[selfcheck] ${name}：磁盘上的产物与生成结果不一致（跑一次不带 --check 的生成）`
      )
    statuses.push({ name, bytes: bytes.length, action })
  }

  const parsers = await parserCheck(files)

  if (asJson) {
    console.log(JSON.stringify({ fixtures: statuses, structural: summary, parsers }, null, 2))
    return
  }
  console.log(`夹具目录：${path.relative(ROOT, HERE)}`)
  for (const entry of statuses) {
    console.log(`  ${entry.name.padEnd(10)} ${String(entry.bytes).padStart(5)} B  ${entry.action}`)
  }
  console.log('结构自检：')
  console.log(`  tiny.txt    ${summary.txt.paragraphs} 段（中英混排）`)
  console.log(
    `  tiny.docx   zip ${summary.docx.entries} 条目 / 表格 ${summary.docx.table} / CRC 全部通过`
  )
  console.log(
    `  tiny.pdf    ${summary.pdf.pages} 页 / xref 偏移与 /Length 自洽 / 文本层 ${summary.pdf.textLines.join(' + ')}`
  )
  console.log(`  tiny.png    ${summary.png.width}×${summary.png.height} 纯色 / chunk CRC 全部通过`)
  console.log('真解析器自检：')
  for (const item of parsers) {
    if (item.status === 'pass') console.log(`  ✓ ${item.parser}(${item.fixture}) → ${item.detail}`)
    else console.log(`  SKIP ${item.parser}(${item.fixture}) → ${item.reason}`)
  }
  const skipped = parsers.filter((p) => p.status === 'skip').length
  if (skipped > 0)
    console.log(`（${skipped}/${parsers.length} 条真解析器自检 SKIP —— 见上面的原因，不是通过）`)
  console.log('OK：夹具生成完成，结构与幂等自检通过。')
}

await main()

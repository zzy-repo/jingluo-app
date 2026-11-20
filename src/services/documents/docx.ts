/**
 * DOCX 本地解析（Issue #570 / 母单 #480）。
 *
 * 纯函数：输入 `Uint8Array`，输出 `{ text, warnings, meta }`。不碰 DOM、不发请求，
 * Node 单测直接 import（`tests/unit/doc-570-docx.test.mjs`）。
 *
 * ## 为什么自己写一个 60 行的 XML 扫描器
 *
 * 环境里没有 `DOMParser`（Node 单测要能跑），也不能引新的 XML 库（`package.json` 不在本单范围内）。
 * `document.xml` 是我们自己解出来的、只用来读 `w:p` / `w:tbl` / `w:t` 的**数据**，不是要执行的 XML，
 * 所以只需要一个「按标签切树」的容错扫描器：不处理命名空间语义、不解析 DTD、不做外部实体 ——
 * 这恰好也是安全上的正确答案（见下面「安全三条」）。
 *
 * ## 输出形态（Markdown）
 *
 * - `w:p` 且有 `w:pPr/w:pStyle` 命中 `Heading1/2/3`（或 `w:outlineLvl`）→ `#` / `##` / `###`
 * - `w:p` 且带 `w:pPr/w:numPr` → `- ` 列表项
 * - 其它 `w:p` → 正文段落原样
 * - `w:tbl` → Markdown 表格，保留行列，**首行当表头**，不足的列补空
 * - 块与块之间空一行；空段落不产生块（块间空行已经承担了分隔）
 *
 * ## 安全三条（关闭条件第 4 条，每条都有单测）
 *
 * 1. **XML 外部实体（XXE）**：`<!DOCTYPE` / `<!ENTITY` 出现在 `document.xml` 里就整包拒绝
 *    （`xxe-blocked`）。OOXML 的 `document.xml` 合法内容里**不存在**这两样，所以命中不是「不支持」，
 *    而是有人往里塞了外部实体。选择拒绝而不是剥离：剥离就多一条「剥不干净」的路径，收益为零。
 * 2. **解压后总大小上限**：按中央目录**声明的**解压尺寸累计（`MAX_UNCOMPRESSED_TOTAL_BYTES`），
 *    所以在解压第一个字节之前就能拒掉 zip bomb；解出来之后再核一次实际字节数，防声明尺寸撒谎。
 * 3. **路径穿越**：条目名里出现 `../`、绝对路径、Windows 盘符、NUL、超长路径 → 整包拒绝
 *    （`path-traversal`）。不「跳过那条继续解」，因为能造出穿越名的包本身就是恶意包。
 */

import { strFromU8, unzipSync } from 'fflate'

/** 解析结果。与 `txt.ts` 同形；#572 的 `documents/index.ts` 会把两个实现收口成一套类型。 */
export type ParsedDocument = {
  text: string
  warnings: string[]
  meta: DocxMeta
}

export type DocxMeta = {
  /** 原始归档字节数 */
  byteLength: number
  /** ZIP 条目数（含被忽略的 `word/media/**`） */
  entryCount: number
  /** 中央目录声明的解压后总字节数（大小闸按它判，见 `MAX_UNCOMPRESSED_TOTAL_BYTES`） */
  declaredUncompressedBytes: number
  /** 真正解出来的 `word/document.xml` 字节数 */
  documentBytes: number
  paragraphCount: number
  headingCount: number
  listItemCount: number
  tableCount: number
  /** 被忽略的图片条目数（`word/media/**`，按边界不解析图片） */
  mediaCount: number
  /** 被忽略的嵌入对象（`w:drawing` / `w:pict` / `w:object`）个数 */
  objectCount: number
}

export type DocxErrorCode =
  | 'invalid-zip'
  | 'path-traversal'
  | 'zip-bomb'
  | 'missing-document'
  | 'xxe-blocked'
  | 'malformed-xml'

/** 解析失败。`code` 是稳定码（UI 按码取文案），`message` 只给日志看。 */
export class DocxParseError extends Error {
  readonly code: DocxErrorCode

  constructor(code: DocxErrorCode) {
    super(`Invalid DOCX document: ${code}`)
    this.name = 'DocxParseError'
    this.code = code
  }
}

/** 警告码（稳定字符串常量） */
export const DOCX_WARNING = {
  /** 归档里有图片条目，已忽略（不支持嵌图 OCR） */
  mediaIgnored: 'docx.media-ignored',
  /** 文档里有嵌入对象（图表 / OLE / 文本框），已忽略 */
  objectsIgnored: 'docx.objects-ignored',
  /** 修订痕迹里的删除内容已跳过 */
  revisionsSkipped: 'docx.revisions-skipped',
  /** 正文解析完是空的：不是静默返回空串，调用方必须拿到这条 */
  emptyBody: 'docx.empty-body',
} as const

/**
 * 解压上限。
 *
 * 取值依据（实测口径：一份 300 页、含 40 张 200KB 截图的 docx）：
 * `word/document.xml` 约 6~8MB，解压后全包约 20MB。
 * - 单条目 **32MiB**：正常 `document.xml` 的 4 倍余量。
 * - 总量 **64MiB**：正常包解压后的 3 倍余量。
 * - 条目数 **2048**：正常 docx 是「正文 1 条 + 每张图 1~3 条」的量级，2048 只拦构造包。
 *
 * 关键在「按声明尺寸算」：炸弹（200MB 全零 = 1000:1 压缩比）在解压前就被拒，不用先吃满内存。
 */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_UNCOMPRESSED_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 2048
/** 条目名长度上限：整条路径 1024 字节（落盘路径单段 ext4/Android 上限 255 字节） */
const MAX_PATH_BYTES = 1024

const DOCUMENT_ENTRY = 'word/document.xml'
const MEDIA_PREFIX = 'word/media/'
/** XML 外部实体声明。无 `g` 标志 → 无 lastIndex 状态，可反复 `.test` */
const XXE_PATTERN = /<!(?:DOCTYPE|ENTITY)/i
/** 标题样式 id：`Heading1` / `Heading 2` / `标题3`（Word 中文版内置样式的 id 仍是 HeadingN，手写文档可能用中文） */
const HEADING_PATTERN = /^(?:heading|标题)\s*([1-9])$/i
/** Markdown 标题最多 6 级；`outlineLvl` 9 表示正文，不算标题 */
const MAX_HEADING_LEVEL = 6

const isUnsafeEntryPath = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_PATH_BYTES) {
    return true
  }
  if (name.includes('\u0000')) {
    return true
  }
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    // 绝对路径（含 UNC `\\server\share` 归一化后的 `//server/share`）
    return true
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    return true
  }
  return normalized.split('/').some((segment) => segment === '..')
}

const hasZipSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

type ZipScan = {
  documents: Record<string, Uint8Array>
  entryCount: number
  declaredUncompressedBytes: number
  mediaCount: number
}

/**
 * 解包 + 安全闸。**只解** `word/document.xml`：图片只数条目、不落内存。
 * 任何结构问题都收成 `DocxParseError`，fflate 的原始异常不漏出去。
 */
const readZip = (bytes: Uint8Array): ZipScan => {
  if (!hasZipSignature(bytes)) {
    throw new DocxParseError('invalid-zip')
  }

  const scan: ZipScan = { documents: {}, entryCount: 0, declaredUncompressedBytes: 0, mediaCount: 0 }
  let violation: DocxErrorCode | null = null
  let unzipped: Record<string, Uint8Array>

  try {
    unzipped = unzipSync(bytes, {
      filter: (entry) => {
        if (violation !== null) {
          return false
        }
        if (isUnsafeEntryPath(entry.name)) {
          violation = 'path-traversal'
          return false
        }
        scan.entryCount += 1
        if (scan.entryCount > MAX_ENTRIES) {
          violation = 'zip-bomb'
          return false
        }
        if (entry.originalSize > MAX_ENTRY_BYTES) {
          violation = 'zip-bomb'
          return false
        }
        scan.declaredUncompressedBytes += entry.originalSize
        if (scan.declaredUncompressedBytes > MAX_UNCOMPRESSED_TOTAL_BYTES) {
          violation = 'zip-bomb'
          return false
        }
        if (entry.name.startsWith(MEDIA_PREFIX)) {
          scan.mediaCount += 1
          return false
        }
        return entry.name === DOCUMENT_ENTRY
      },
    })
  } catch (error) {
    // 乱码字节 / 截断 / 加密 / 不支持的压缩方式：统一是「这个 ZIP 读不了」
    if (error instanceof DocxParseError) {
      throw error
    }
    throw new DocxParseError('invalid-zip')
  }

  if (violation !== null) {
    throw new DocxParseError(violation)
  }
  scan.documents = unzipped
  return scan
}

/** `document.xml` 按 OOXML 默认是 UTF-8；少数工具写 UTF-16LE 带 BOM。两种都认。 */
const decodeXml = (bytes: Uint8Array): string => {
  const xml =
    bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder('utf-16le').decode(bytes.subarray(2))
      : strFromU8(bytes)
  return xml.startsWith('\uFEFF') ? xml.slice(1) : xml
}

type XmlNode = {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** 直接文本内容（只在 `w:t` 这类叶子节点上有意义） */
  text: string
}

const ENTITY_NAMES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g

/** 只认 XML 预定义的五种 + 数值引用；其它命名实体原样留着（OOXML 里不该出现） */
const decodeEntities = (source: string): string =>
  source.replace(ENTITY_PATTERN, (whole: string, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITY_NAMES[body] ?? whole
  })

const ATTR_PATTERN = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

const parseAttrs = (source: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  ATTR_PATTERN.lastIndex = 0
  let match = ATTR_PATTERN.exec(source)
  while (match !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '')
    match = ATTR_PATTERN.exec(source)
  }
  return attrs
}

/** 找标签结尾的 `>`：跳过属性值里的 `>`（`w:val="a>b"` 这种） */
const findTagEnd = (source: string, from: number): number => {
  let quote = ''
  for (let index = from + 1; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== '') {
      if (character === quote) {
        quote = ''
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') {
      return index
    }
  }
  return -1
}

/** 容错收尾：弹到同名节点为止；栈里根本没这个名字就忽略这个闭合标签（真实文档偶有未闭合段落） */
const closeNode = (stack: XmlNode[], name: string): void => {
  for (let depth = stack.length - 1; depth > 0; depth -= 1) {
    if (stack[depth].name === name) {
      stack.length = depth
      return
    }
  }
}

/**
 * 按标签切树的容错扫描器。
 * 处理 `<!-- -->`、`<![CDATA[]]>`、`<?xml ?>`、自闭合标签、单双引号属性、实体；
 * 不处理 DTD（`<!DOCTYPE` / `<!ENTITY` 在上游被拒），不认命名空间语义（标签名原样保留 `w:` 前缀）。
 */
const parseXml = (source: string): XmlNode => {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open < 0) {
      stack[stack.length - 1].text += decodeEntities(source.slice(index))
      break
    }
    if (open > index) {
      stack[stack.length - 1].text += decodeEntities(source.slice(index, open))
    }

    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4)
      if (end < 0) {
        throw new DocxParseError('malformed-xml')
      }
      index = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9)
      if (end < 0) {
        throw new DocxParseError('malformed-xml')
      }
      stack[stack.length - 1].text += source.slice(open + 9, end)
      index = end + 3
      continue
    }
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2)
      if (end < 0) {
        throw new DocxParseError('malformed-xml')
      }
      index = end + 2
      continue
    }

    const end = findTagEnd(source, open)
    if (end < 0) {
      throw new DocxParseError('malformed-xml')
    }
    const inner = source.slice(open + 1, end)
    index = end + 1

    if (inner.startsWith('!')) {
      // `<!DOCTYPE ...>` 之类：上游已拒绝 XXE，这里兜底跳过
      continue
    }
    if (inner.startsWith('/')) {
      closeNode(stack, inner.slice(1).trim())
      continue
    }

    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const splitAt = body.search(/\s/)
    const name = splitAt < 0 ? body : body.slice(0, splitAt)
    const node: XmlNode = {
      name,
      attrs: parseAttrs(splitAt < 0 ? '' : body.slice(splitAt)),
      children: [],
      text: '',
    }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) {
      stack.push(node)
    }
  }

  return root
}

const findChild = (node: XmlNode, name: string): XmlNode | null => {
  for (const child of node.children) {
    if (child.name === name) {
      return child
    }
  }
  return null
}

const findDescendant = (node: XmlNode, name: string): XmlNode | null => {
  for (const child of node.children) {
    if (child.name === name) {
      return child
    }
    const found = findDescendant(child, name)
    if (found !== null) {
      return found
    }
  }
  return null
}

const attributeOf = (node: XmlNode | null, name: string): string | null => {
  if (node === null) {
    return null
  }
  const value = node.attrs[name]
  return value === undefined ? null : value
}

/** 这些子树里的文字不算正文：段落/字符属性、域代码、修订痕迹里的删除内容、嵌套表格 */
const INLINE_SKIP = new Set(['w:pPr', 'w:rPr', 'w:instrText', 'w:delText', 'w:tbl', 'w:sdtPr'])

type DocxCounters = {
  paragraphs: number
  headings: number
  listItems: number
  tables: number
  revisions: number
  objects: number
}

/**
 * 收集一个段落（或表格单元格）里的可见文字。
 * 只认 `w:t` 的文本内容 —— 直接文本节点不算，因为他们属于属性/样式，不是正文。
 */
const readInlineText = (node: XmlNode, counters: DocxCounters): string => {
  let out = ''
  for (const child of node.children) {
    if (child.name === 'w:t') {
      out += child.text
      continue
    }
    if (child.name === 'w:tab') {
      out += ' '
      continue
    }
    if (child.name === 'w:br' || child.name === 'w:cr') {
      out += '\n'
      continue
    }
    if (child.name === 'w:noBreakHyphen') {
      out += '-'
      continue
    }
    if (child.name === 'w:del' || child.name === 'w:moveFrom') {
      counters.revisions += 1
      continue
    }
    if (child.name === 'w:drawing' || child.name === 'w:pict' || child.name === 'w:object') {
      counters.objects += 1
      continue
    }
    if (INLINE_SKIP.has(child.name)) {
      continue
    }
    out += readInlineText(child, counters)
  }
  return out
}

/** 标题级别：样式 id 优先，其次 `w:outlineLvl`（0 基）。返回 0 表示不是标题。 */
const headingLevelOf = (styleId: string, outline: string | null): number => {
  const matched = HEADING_PATTERN.exec(styleId)
  if (matched !== null) {
    return Math.min(Number.parseInt(matched[1], 10), MAX_HEADING_LEVEL)
  }
  if (outline !== null) {
    const level = Number.parseInt(outline, 10)
    if (Number.isFinite(level) && level >= 0 && level <= MAX_HEADING_LEVEL - 1) {
      return level + 1
    }
  }
  return 0
}

/** 单元格内容：段落之间用空格连（Markdown 表格里不能有换行），管道符转义，否则会把列切断 */
const readTableCell = (node: XmlNode, counters: DocxCounters): string => {
  const parts: string[] = []
  for (const child of node.children) {
    if (child.name === 'w:p' || child.name === 'w:tbl') {
      parts.push(readInlineText(child, counters))
    }
  }
  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\|/g, '\\|')
}

/** `w:tbl` → Markdown 表格：首行当表头，列数取最宽行，短行补空 */
const renderTable = (node: XmlNode, counters: DocxCounters): string => {
  const rows: string[][] = []
  for (const row of node.children) {
    if (row.name !== 'w:tr') {
      continue
    }
    const cells: string[] = []
    for (const cell of row.children) {
      if (cell.name !== 'w:tc') {
        continue
      }
      cells.push(readTableCell(cell, counters))
    }
    if (cells.length > 0) {
      rows.push(cells)
    }
  }
  if (rows.length === 0) {
    return ''
  }
  const columns = rows.reduce((widest, row) => Math.max(widest, row.length), 1)
  const pad = (row: string[]): string[] => {
    const filled = [...row]
    while (filled.length < columns) {
      filled.push('')
    }
    return filled
  }
  const lines = [
    `| ${pad(rows[0]).join(' | ')} |`,
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
  ]
  for (const row of rows.slice(1)) {
    lines.push(`| ${pad(row).join(' | ')} |`)
  }
  return lines.join('\n')
}

/** 按文档顺序走 `w:body` 的子块；`w:sdt`（内容控件）里包着的段落也算 */
const collectBlocks = (nodes: XmlNode[], counters: DocxCounters, blocks: string[]): void => {
  for (const child of nodes) {
    if (child.name === 'w:p') {
      counters.paragraphs += 1
      const properties = findChild(child, 'w:pPr')
      const styleId = attributeOf(properties === null ? null : findChild(properties, 'w:pStyle'), 'w:val') ?? ''
      const outline = attributeOf(
        properties === null ? null : findChild(properties, 'w:outlineLvl'),
        'w:val',
      )
      const heading = headingLevelOf(styleId, outline)
      const text = readInlineText(child, counters)
      if (heading > 0) {
        const inner = text.trim()
        if (inner !== '') {
          counters.headings += 1
          blocks.push(`${'#'.repeat(heading)} ${inner}`)
        }
        continue
      }
      const isListItem = properties !== null && findChild(properties, 'w:numPr') !== null
      if (isListItem) {
        counters.listItems += 1
      }
      // 空段落不产生块：块之间本来就用空行分隔，再插一个空块只会产生连续空行
      const inner = text.replace(/\s+$/, '')
      if (inner.trim() === '') {
        continue
      }
      blocks.push(isListItem ? `- ${inner.trim()}` : inner)
      continue
    }
    if (child.name === 'w:tbl') {
      const table = renderTable(child, counters)
      if (table !== '') {
        counters.tables += 1
        blocks.push(table)
      }
      continue
    }
    if (child.name === 'w:sdt') {
      const content = findChild(child, 'w:sdtContent')
      if (content !== null) {
        collectBlocks(content.children, counters, blocks)
      }
    }
  }
}

/**
 * 解析 DOCX。
 *
 * @throws {DocxParseError} `invalid-zip` / `path-traversal` / `zip-bomb` / `missing-document` /
 *   `xxe-blocked` / `malformed-xml`。绝不把 fflate 的原始异常漏给调用方。
 */
export const parseDocx = (bytes: Uint8Array): ParsedDocument => {
  const scan = readZip(bytes)
  const documentBytes = scan.documents[DOCUMENT_ENTRY]
  if (documentBytes === undefined) {
    throw new DocxParseError('missing-document')
  }
  // 安全②的补充：声明尺寸可能撒谎，解出来的实际字节数再核一次
  if (documentBytes.length > MAX_ENTRY_BYTES) {
    throw new DocxParseError('zip-bomb')
  }

  const xml = decodeXml(documentBytes)
  // 安全①：外部实体。合法 OOXML 的 document.xml 不会有 DOCTYPE / ENTITY
  if (XXE_PATTERN.test(xml)) {
    throw new DocxParseError('xxe-blocked')
  }

  const tree = parseXml(xml)
  const document = findDescendant(tree, 'w:document')
  const body = document === null ? null : findChild(document, 'w:body')
  if (body === null) {
    throw new DocxParseError('malformed-xml')
  }

  const counters: DocxCounters = { paragraphs: 0, headings: 0, listItems: 0, tables: 0, revisions: 0, objects: 0 }
  const blocks: string[] = []
  collectBlocks(body.children, counters, blocks)

  // 段内的 `w:br` 会带来单换行；和块间空行叠在一起时最多留一个空行
  const text = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()

  const warnings: string[] = []
  if (scan.mediaCount > 0) {
    warnings.push(DOCX_WARNING.mediaIgnored)
  }
  if (counters.objects > 0) {
    warnings.push(DOCX_WARNING.objectsIgnored)
  }
  if (counters.revisions > 0) {
    warnings.push(DOCX_WARNING.revisionsSkipped)
  }
  if (text === '') {
    warnings.push(DOCX_WARNING.emptyBody)
  }

  return {
    text,
    warnings,
    meta: {
      byteLength: bytes.length,
      entryCount: scan.entryCount,
      declaredUncompressedBytes: scan.declaredUncompressedBytes,
      documentBytes: documentBytes.length,
      paragraphCount: counters.paragraphs,
      headingCount: counters.headings,
      listItemCount: counters.listItems,
      tableCount: counters.tables,
      mediaCount: scan.mediaCount,
      objectCount: counters.objects,
    },
  }
}

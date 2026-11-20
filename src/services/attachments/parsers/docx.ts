/**
 * DOCX 解析器（#480 §5.2）：ZIP + OOXML → Markdown（标题 / 段落 / 列表 / 表格）。
 *
 * ## 为什么自己解析，而不是上 mammoth
 * Chatbox 与 Cherry Studio 的 docx 链路都以 mammoth（docx → HTML → 文本）为主，我们不用它：
 * 1. 体积与语法：mammoth 自带 zip 与 html 处理，产物体积在几百 KB 量级，而本机老内核基线是
 *    Chromium 83（见 package.json browserslist）；我们只需要「阅读顺序 + 标题 / 列表 / 表格」，
 *    这点活儿不值得一个大库；
 * 2. 结构信息：mammoth 走 HTML，表格的行列关系要靠再解析一遍 HTML 才拿得回来，反而不如直接读
 *    OOXML 的 `w:tbl`/`w:tr`/`w:tc` 清楚；
 * 3. 零新增依赖：ZIP 读取直接复用仓库已有的 `chat/history/zipReader.ts`（基于 fflate，已带 CRC
 *    校验、结构校验与解压炸弹闸），XML 侧只需要一个白名单扫描器。
 *
 * 参考实现（只借鉴思路，不复制源码）：
 * - Chatbox `src/shared/mobile-work/worker/office-text.ts`：fflate 解包 + 只取
 *   `word/document.xml` + 按 `w:p` 逐段取 `w:t`，并在解析前拒绝 `<!DOCTYPE|<!ENTITY`。
 *   它的短板正是我们要补的：不认表格与列表；DOMParser 走 linkedom；只能整包解压后再剪文本。
 * - Cherry Studio：同样 mammoth 路线，表格与列表同样退化。
 *
 * ## 提取策略（§5.2：禁止「简单拼接所有 XML 文本节点」）
 * 按 `document.xml` 的**文档顺序**单遍扫描，用元素栈把结构还原出来：
 * - `w:p` → 段落；带 `w:pStyle`（Heading1–6，或 styles.xml 里带 outlineLvl 的样式）→ `#`–`######`；
 *   带 `w:numPr` → 列表项（`-` / `1.`，按 numbering.xml 的 `numFmt` 判有序/无序，按 `ilvl` 缩进）；
 * - `w:tbl`/`w:tr`/`w:tc` → Markdown 表格（保留行列关系；跨列 gridSpan 只留首列文本、跨行
 *   vMerge 留空，并在 warnings 里报数）；单元格里再套的表格无法用 Markdown 表达 → 压平并报数；
 * - `w:drawing` / `w:pict` / `w:object` → 图片与嵌入对象**不提取**，只计数，最后进 warnings；
 * - `mc:AlternateContent` 的 `mc:Fallback` 与 `mc:Choice` 描述同一个对象，整段跳过，避免同一张
 *   图片被数两遍。
 *
 * ## 安全（§5.2 与 §9 的硬要求）
 * - 体积：`docxMaxBytes`（20 MiB）在解包前拒绝，超限直接 `failed`，**不静默截断**；
 * - 解压：条目数 `maxZipEntries`、解压总量 `maxZipUncompressedBytes`，边读边累计、超限立刻中止
 *   （zipReader 自身还有一层 800 MiB / 200:1 的炸弹闸作兜底）；
 * - XXE：**不引入任何 XML 解析器**。扫描前剥离 `<!DOCTYPE`/`<!ENTITY`（含内部子集），实体只认
 *   XML 预定义的五个 + 数字字符引用，未知名实体原样保留 —— 结构上不存在外部实体解析路径；
 * - 路径穿越：只按固定白名单取 `word/document.xml`、`word/numbering.xml`、`word/styles.xml`、
 *   `word/_rels/document.xml.rels` 四个条目，**不解压到磁盘**，条目名不参与任何路径拼接。
 *
 * 老内核：目标 ES2017 / Chromium 83，不用 `??=` / `||=` / 私有字段 / 顶层 await。
 */
import { readArchive, readEntry, skipEntry } from '../../chat/history/zipReader.js'
import { ATTACHMENT_LIMITS } from '../limits.js'
import type { ParsedDocument, ParseOptions } from '../types.js'

/**
 * 解析器版本：与文件 sha256 一起构成缓存去重键（§6）。
 * **改动提取逻辑必须同时升级这个版本**，否则老缓存会继续命中旧结果。
 */
export const DOCX_PARSER_VERSION = 'docx-parser/1.0.0'

/** 白名单条目：只读这四个，其余一律跳过（不落盘，条目名不参与任何路径拼接）。 */
const DOCUMENT_PATH = 'word/document.xml'
const NUMBERING_PATH = 'word/numbering.xml'
const STYLES_PATH = 'word/styles.xml'
const RELS_PATH = 'word/_rels/document.xml.rels'
const WANTED_PATHS = new Set([DOCUMENT_PATH, NUMBERING_PATH, STYLES_PATH, RELS_PATH])

/** 标题最大层级（`######` 是 Markdown 的上限） */
const MAX_HEADING_LEVEL = 6
/** 列表最大缩进层级（再深也没人看得懂，同时防畸形文档把缩进拉爆） */
const MAX_LIST_LEVEL = 8
/** 单个单元格最多展开的列数（gridSpan 声称 100000 列属于恶意构造） */
const MAX_CELL_SPAN = 64
/** 样式继承链最多跟这么深（防 styles.xml 里 basedOn 成环） */
const MAX_STYLE_CHAIN = 6
const NEWLINE = '\n'
const BLANK_LINE = '\n\n'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** 解析失败的原因码：调用方据此决定文案（超限要说清上限，别混成「解析失败」）。 */
export type DocxErrorCode =
  | 'too_large'
  | 'empty'
  | 'not_docx'
  | 'corrupt_archive'
  | 'too_many_entries'
  | 'uncompressed_too_large'
  | 'missing_document'
  | 'aborted'

/** 解析失败统一抛这个：message 本身就是给用户看的（含实测值与上限）。 */
export class DocxParseError extends Error {
  readonly code: DocxErrorCode

  constructor(code: DocxErrorCode, message: string) {
    super(message)
    this.name = 'DocxParseError'
    this.code = code
  }
}

export const isDocxParseError = (error: unknown): error is DocxParseError =>
  error instanceof DocxParseError

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

const toInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const clamp = (value: number, min: number, max: number): number => {
  if (value < min) {
    return min
  }
  return value > max ? max : value
}

/** XML 预定义实体；未知实体原样保留（绝不展开外部实体）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

const decodeEntities = (value: string): string => {
  if (value.indexOf('&') < 0) {
    return value
  }
  return value.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body: string) => {
    if (body.charCodeAt(0) === 35) {
      const hexadecimal = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88
      const code = Number.parseInt(hexadecimal ? body.slice(2) : body.slice(1), hexadecimal ? 16 : 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    const named = NAMED_ENTITIES[body]
    return named === undefined ? whole : named
  })
}

const localName = (qualified: string): string => {
  const colon = qualified.indexOf(':')
  return colon < 0 ? qualified : qualified.slice(colon + 1)
}

/* ------------------------------------------------------------------ *
 * XML 扫描器（白名单式，不构造 DOM）
 * ------------------------------------------------------------------ */

type XmlEvent =
  | { kind: 'open'; name: string; attrs: Map<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string }

/** 找到声明结尾的 `>`（跳过引号内与 `[ … ]` 内部子集）。 */
const endOfDeclaration = (xml: string, start: number): number => {
  let quote = ''
  let depth = 0
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index]
    if (quote !== '') {
      if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') {
      depth += 1
      continue
    }
    if (char === ']') {
      depth = depth > 0 ? depth - 1 : 0
      continue
    }
    if (char === '>' && depth === 0) {
      return index + 1
    }
  }
  return -1
}

/**
 * 剥离 `<!DOCTYPE …>` / `<!ENTITY …>`。
 *
 * 扫描器本身只认元素与文本，留着声明也不会有实体展开；之所以还要剥，是因为「声明留在原地」
 * 会让下一个人以为这里能安全换成 DOMParser —— 那才是真正的 XXE 通道。剥掉并记 warning，
 * 让这件事在数据里可见。
 */
const stripDeclarations = (xml: string): { xml: string; stripped: boolean } => {
  let stripped = false
  let output = ''
  let index = 0
  while (index < xml.length) {
    const at = xml.indexOf('<!', index)
    if (at < 0) {
      output += xml.slice(index)
      break
    }
    output += xml.slice(index, at)
    if (xml.startsWith('<![CDATA[', at)) {
      const end = xml.indexOf(']]>', at + 9)
      if (end < 0) {
        output += xml.slice(at)
        break
      }
      output += xml.slice(at, end + 3)
      index = end + 3
      continue
    }
    const end = endOfDeclaration(xml, at)
    if (end < 0) {
      // 未闭合的声明：原样交回，扫描器会当普通字符忽略
      output += xml.slice(at)
      break
    }
    if (/^<!\s*(DOCTYPE|ENTITY)/i.test(xml.slice(at, end))) {
      stripped = true
    }
    index = end
  }
  return { xml: output, stripped }
}

/** 找到标签的 `>`（跳过引号内的 `>`）；遇到下一个 `<` 说明标签畸形，返回 -1。 */
const endOfTag = (xml: string, start: number): number => {
  let quote = ''
  for (let index = start; index < xml.length; index += 1) {
    const char = xml[index]
    if (quote !== '') {
      if (char === quote) {
        quote = ''
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') {
      return index
    }
    if (char === '<') {
      return -1
    }
  }
  return -1
}

const ATTRIBUTE_PATTERN = /([A-Za-z_][\w.\-:]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'))?/g

/** 属性按**本地名**入表（`w:val` → `val`），值做实体反转义。 */
const parseAttributes = (source: string): Map<string, string> => {
  const attrs = new Map<string, string>()
  ATTRIBUTE_PATTERN.lastIndex = 0
  let match = ATTRIBUTE_PATTERN.exec(source)
  while (match !== null) {
    const quoted = match[2] !== undefined ? match[2] : match[3]
    attrs.set(localName(match[1]), decodeEntities(quoted === undefined ? '' : quoted))
    match = ATTRIBUTE_PATTERN.exec(source)
  }
  return attrs
}

/** 单遍切 token：注释 / CDATA / 处理指令 / 声明都被吞掉，只吐 open / close / text。 */
function* tokenize(xml: string): Generator<XmlEvent> {
  let index = 0
  while (index < xml.length) {
    const lt = xml.indexOf('<', index)
    if (lt < 0) {
      yield { kind: 'text', text: decodeEntities(xml.slice(index)) }
      return
    }
    if (lt > index) {
      yield { kind: 'text', text: decodeEntities(xml.slice(index, lt)) }
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      index = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      const raw = end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end)
      if (raw !== '') {
        yield { kind: 'text', text: raw }
      }
      index = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2)
      index = end < 0 ? xml.length : end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = endOfDeclaration(xml, lt)
      index = end < 0 ? xml.length : end
      continue
    }
    const gt = endOfTag(xml, lt + 1)
    if (gt < 0) {
      return
    }
    if (xml[lt + 1] === '/') {
      yield { kind: 'close', name: localName(xml.slice(lt + 2, gt).trim()) }
      index = gt + 1
      continue
    }
    let body = xml.slice(lt + 1, gt)
    let selfClosing = false
    if (body.endsWith('/')) {
      selfClosing = true
      body = body.slice(0, -1)
    }
    const space = body.search(/\s/)
    const name = localName(space < 0 ? body : body.slice(0, space))
    const attrs = space < 0 ? new Map<string, string>() : parseAttributes(body.slice(space))
    if (name !== '') {
      yield { kind: 'open', name, attrs, selfClosing }
    }
    index = gt + 1
  }
}

/* ------------------------------------------------------------------ *
 * numbering.xml：numId → (ilvl → numFmt)
 * ------------------------------------------------------------------ */

type NumberingMap = Map<string, Map<number, string>>

const parseNumbering = (xml: string | undefined): NumberingMap => {
  const abstractLevels = new Map<string, Map<number, string>>()
  const overrides = new Map<string, Map<number, string>>()
  const numToAbstract = new Map<string, string>()
  if (xml === undefined) {
    return new Map()
  }
  let context: 'none' | 'abstract' | 'num' = 'none'
  let abstractId = ''
  let abstractLevelsOfCurrent: Map<number, string> | null = null
  let numId = ''
  let overrideLevels: Map<number, string> | null = null
  let level = -1
  for (const event of tokenize(xml)) {
    if (event.kind === 'text') {
      continue
    }
    if (event.kind === 'close') {
      if (event.name === 'abstractNum') {
        if (abstractLevelsOfCurrent !== null && abstractId !== '') {
          abstractLevels.set(abstractId, abstractLevelsOfCurrent)
        }
        abstractLevelsOfCurrent = null
        context = 'none'
      } else if (event.name === 'num') {
        if (overrideLevels !== null && overrideLevels.size > 0 && numId !== '') {
          overrides.set(numId, overrideLevels)
        }
        overrideLevels = null
        context = 'none'
      } else if (event.name === 'lvl') {
        level = -1
      }
      continue
    }
    switch (event.name) {
      case 'abstractNum':
        context = 'abstract'
        abstractId = event.attrs.get('abstractNumId') ?? ''
        abstractLevelsOfCurrent = new Map()
        break
      case 'num':
        context = 'num'
        numId = event.attrs.get('numId') ?? ''
        overrideLevels = new Map()
        break
      case 'abstractNumId':
        if (context === 'num') {
          numToAbstract.set(numId, event.attrs.get('val') ?? '')
        }
        break
      case 'lvl':
      case 'lvlOverride':
        level = toInt(event.attrs.get('ilvl'), -1)
        break
      case 'numFmt': {
        const format = event.attrs.get('val') ?? ''
        if (level >= 0) {
          if (context === 'abstract' && abstractLevelsOfCurrent !== null) {
            abstractLevelsOfCurrent.set(level, format)
          } else if (context === 'num' && overrideLevels !== null) {
            overrideLevels.set(level, format)
          }
        }
        break
      }
      default:
        break
    }
  }
  const result: NumberingMap = new Map()
  numToAbstract.forEach((abstractKey, key) => {
    const abstractMap = abstractLevels.get(abstractKey)
    const levels = abstractMap === undefined ? new Map<number, string>() : new Map(abstractMap)
    const override = overrides.get(key)
    if (override !== undefined) {
      override.forEach((format, ilvl) => levels.set(ilvl, format))
    }
    result.set(key, levels)
  })
  return result
}

/* ------------------------------------------------------------------ *
 * styles.xml：styleId → 名称 / basedOn / outlineLvl（标题识别）
 * ------------------------------------------------------------------ */

type StyleRecord = { id: string; name: string; basedOn: string; outlineLevel: number | null }

const parseStyles = (xml: string | undefined): Map<string, StyleRecord> => {
  const styles = new Map<string, StyleRecord>()
  if (xml === undefined) {
    return styles
  }
  let current: StyleRecord | null = null
  for (const event of tokenize(xml)) {
    if (event.kind === 'open') {
      if (event.name === 'style') {
        const id = event.attrs.get('styleId') ?? ''
        current = id === '' ? null : { id, name: '', basedOn: '', outlineLevel: null }
        continue
      }
      if (current === null) {
        continue
      }
      if (event.name === 'name') {
        current.name = event.attrs.get('val') ?? ''
      } else if (event.name === 'basedOn') {
        current.basedOn = event.attrs.get('val') ?? ''
      } else if (event.name === 'outlineLvl') {
        const value = toInt(event.attrs.get('val'), -1)
        current.outlineLevel = value >= 0 ? value : null
      }
      continue
    }
    if (event.kind === 'close' && event.name === 'style' && current !== null) {
      const record = current
      current = null
      styles.set(record.id, record)
    }
  }
  return styles
}

const HEADING_TEXT_PATTERN = /(?:heading|标题|标題)\s*([1-6])(?![0-9])/i
const HEADING_ID_PATTERN = /^heading\s*([1-6])$/i

/** 样式 → 标题层级：先认 `Heading1` 这类 ID/名称，再沿 `basedOn` 找 `outlineLvl`。 */
const resolveHeadingLevel = (styleId: string, styles: Map<string, StyleRecord>): number | null => {
  let id = styleId
  for (let depth = 0; depth < MAX_STYLE_CHAIN && id !== ''; depth += 1) {
    const byId = HEADING_ID_PATTERN.exec(id)
    if (byId !== null) {
      return clamp(Number(byId[1]), 1, MAX_HEADING_LEVEL)
    }
    const record = styles.get(id)
    if (record === undefined) {
      return null
    }
    const byName = HEADING_TEXT_PATTERN.exec(record.name)
    if (byName !== null) {
      return clamp(Number(byName[1]), 1, MAX_HEADING_LEVEL)
    }
    if (record.outlineLevel !== null) {
      return clamp(record.outlineLevel + 1, 1, MAX_HEADING_LEVEL)
    }
    id = record.basedOn
  }
  return null
}

/* ------------------------------------------------------------------ *
 * document.xml：文档顺序 → 块列表
 * ------------------------------------------------------------------ */

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; level: number; text: string }
  | { kind: 'table'; rows: string[][] }

type ParagraphState = {
  parts: string[]
  styleId: string
  outlineLevel: number | null
  numId: string
  listLevel: number
}

type CellFrame = {
  kind: 'cell'
  keep: boolean
  blocks: Block[]
  /** 跨列数（gridSpan），> 1 时其余列留空 */
  span: number
  /** vMerge 的续行：内容为空，只占位 */
  merged: boolean
  /** vMerge 的起始行：内容保留，但同样属于「合并单元格」 */
  anchor: boolean
}
type RowFrame = { kind: 'row'; keep: boolean; cells: CellFrame[] }
type TableFrame = { kind: 'table'; keep: boolean; rows: RowFrame[] }
type BodyFrame = { kind: 'body'; keep: true; blocks: Block[] }
type StructuralFrame = BodyFrame | CellFrame | RowFrame | TableFrame

/** 抑制子树：里面的文字不进正文（修订删除、图形 / 文本框、OLE 对象、AlternateContent 的旧版副本…）。 */
const SUPPRESSED_ELEMENTS = new Set([
  'drawing', // w:drawing —— 图片 / 图表 / 文本框
  'pict', // w:pict —— 老式 VML 图形
  'object', // w:object —— OLE 嵌入对象
  'Fallback', // mc:Fallback —— 与 mc:Choice 同一对象的副本，跳过防重复计数
  'del', // w:del —— 修订删除的文字
  'moveFrom', // w:moveFrom
  'tabs', // w:tabs —— 制表位定义（不是正文里的 \t）
])

const BULLET_FORMATS = new Set(['bullet', 'none'])

type DocxStats = {
  images: number
  charts: number
  embeddedObjects: number
  textboxes: number
  altChunks: number
  footnotes: number
  mergedCells: number
  nestedTables: number
  unknownNumbering: number
  tables: number
  strippedDeclarations: boolean
}

const createStats = (): DocxStats => ({
  images: 0,
  charts: 0,
  embeddedObjects: 0,
  textboxes: 0,
  altChunks: 0,
  footnotes: 0,
  mergedCells: 0,
  nestedTables: 0,
  unknownNumbering: 0,
  tables: 0,
  strippedDeclarations: false,
})

/**
 * 一段 run 文本的空白归一：正文按 Markdown 段落输出，多空格 / 制表 / 软换行都收成一个空格。
 * （表格单元格另外走 escapeCell，避免 `|` 与换行把表格撑破。）
 */
const normalizeText = (value: string): string => value.replace(/[\s\u00a0]+/g, ' ').trim()

const escapeCell = (value: string): string => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()

/**
 * 扫描 `document.xml`，按文档顺序产出块。
 * 全部状态（帧栈 + 段落栈）在一个函数里是刻意的：任何「先收集再排序」的做法都会破坏阅读顺序。
 */
const extractBlocks = (
  xml: string,
  numbering: NumberingMap,
  styles: Map<string, StyleRecord>,
  stats: DocxStats
): Block[] => {
  const body: BodyFrame = { kind: 'body', keep: true, blocks: [] }
  const frames: StructuralFrame[] = [body]
  /** 段落栈：图形 / 文本框里会再出现 `w:p`，被抑制的段落压 null 占位，保证开闭配对 */
  const paragraphs: (ParagraphState | null)[] = []
  const drawings: { kind: 'drawing' | 'pict' | 'object'; stats: DocxStats }[] = []
  let suppressCount = 0
  let insideText = false

  const top = (): StructuralFrame | null =>
    frames.length === 0 ? null : frames[frames.length - 1]

  const nearestCell = (): CellFrame | null => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index]
      if (frame.kind === 'cell') {
        return frame
      }
    }
    return null
  }

  const currentContainer = (): BodyFrame | CellFrame => {
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index]
      if (frame.kind === 'cell' || frame.kind === 'body') {
        return frame
      }
    }
    return body
  }

  const activeParagraph = (): ParagraphState | null =>
    paragraphs.length === 0 ? null : paragraphs[paragraphs.length - 1]

  const pushText = (text: string) => {
    if (suppressCount > 0) {
      return
    }
    const state = activeParagraph()
    if (state !== null) {
      state.parts.push(text)
    }
  }

  /** 单元格里的块 → 一行文本（Markdown 表格单元格不能换行） */
  const renderCellText = (blocks: Block[]): string => {
    const parts: string[] = []
    for (const block of blocks) {
      if (block.kind === 'table') {
        block.rows.forEach((row) => parts.push(row.join(' / ')))
        continue
      }
      if (block.text === '') {
        continue
      }
      const prefix = block.kind === 'list' ? (block.ordered ? '1. ' : '- ') : ''
      parts.push(prefix + block.text)
    }
    return normalizeText(parts.join(' '))
  }

  /** 表格 → 行 × 列：跨列只留首列文本、跨行留空（Markdown 无法表达合并） */
  const buildTableRows = (table: TableFrame): string[][] => {
    const rows: string[][] = []
    for (const row of table.rows) {
      const cells: string[] = []
      for (const cell of row.cells) {
        const span = clamp(cell.span, 1, MAX_CELL_SPAN)
        cells.push(cell.merged ? '' : renderCellText(cell.blocks))
        for (let extra = 1; extra < span; extra += 1) {
          cells.push('')
        }
        if (span > 1 || cell.merged || cell.anchor) {
          stats.mergedCells += 1
        }
      }
      if (cells.length > 0) {
        rows.push(cells)
      }
    }
    return rows
  }

  const finishTable = (table: TableFrame) => {
    if (!table.keep) {
      return
    }
    const rows = buildTableRows(table)
    if (rows.length === 0) {
      return
    }
    const container = currentContainer()
    if (container.kind === 'cell') {
      // 嵌套表格：Markdown 表格塞不进单元格，压平成一行文本并报数
      stats.nestedTables += 1
      const flattened = rows.map((row) => row.join(' / ')).join('；')
      if (flattened !== '') {
        container.blocks.push({ kind: 'paragraph', text: flattened })
      }
      return
    }
    stats.tables += 1
    container.blocks.push({ kind: 'table', rows })
  }

  const finishParagraph = (state: ParagraphState) => {
    const text = normalizeText(state.parts.join(''))
    if (text === '') {
      // 空段落（Word 用它拉开间距）不进 Markdown，否则正文全是空行
      return
    }
    if (state.outlineLevel !== null) {
      const level = clamp(state.outlineLevel + 1, 1, MAX_HEADING_LEVEL)
      currentContainer().blocks.push({ kind: 'heading', level, text })
      return
    }
    const headingLevel = resolveHeadingLevel(state.styleId, styles)
    if (headingLevel !== null) {
      currentContainer().blocks.push({ kind: 'heading', level: headingLevel, text })
      return
    }
    if (state.numId !== '' && state.numId !== '0') {
      const levels = numbering.get(state.numId)
      const format = levels === undefined ? undefined : levels.get(state.listLevel)
      if (format === undefined) {
        stats.unknownNumbering += 1
      }
      currentContainer().blocks.push({
        kind: 'list',
        ordered: format !== undefined && !BULLET_FORMATS.has(format),
        level: clamp(state.listLevel, 0, MAX_LIST_LEVEL),
        text,
      })
      return
    }
    currentContainer().blocks.push({ kind: 'paragraph', text })
  }

  const beginDrawing = (name: 'drawing' | 'pict' | 'object') => {
    const frame = createStats()
    if (name === 'object') {
      frame.embeddedObjects = 1
    }
    drawings.push({ kind: name, stats: frame })
  }

  const endDrawing = () => {
    const frame = drawings.pop()
    if (frame === undefined) {
      return
    }
    // OLE 对象自带的预览图不是「文档里的一张图」，别重复计数
    const images = frame.kind === 'object' ? 0 : frame.stats.images
    const parent = drawings.length === 0 ? null : drawings[drawings.length - 1]
    if (parent === null) {
      stats.images += images
      stats.charts += frame.stats.charts
      stats.textboxes += frame.stats.textboxes
      stats.embeddedObjects += frame.stats.embeddedObjects
      return
    }
    if (parent.kind !== 'object') {
      parent.stats.images += images
    }
    parent.stats.charts += frame.stats.charts
    parent.stats.textboxes += frame.stats.textboxes
    parent.stats.embeddedObjects += frame.stats.embeddedObjects
  }

  for (const event of tokenize(xml)) {
    if (event.kind === 'text') {
      if (insideText) {
        pushText(event.text)
      }
      continue
    }

    const name = event.name

    if (event.kind === 'close') {
      if (SUPPRESSED_ELEMENTS.has(name) && suppressCount > 0) {
        suppressCount -= 1
      }
      if (name === 'drawing' || name === 'pict' || name === 'object') {
        endDrawing()
        continue
      }
      if (name === 't') {
        insideText = false
        continue
      }
      if (name === 'p') {
        const state = paragraphs.pop()
        if (state !== null && state !== undefined) {
          finishParagraph(state)
        }
        continue
      }
      if (name === 'tc' || name === 'tr' || name === 'tbl') {
        const frame = frames.pop()
        if (frame === undefined) {
          continue
        }
        if (frame.kind === 'cell') {
          const row = top()
          if (row !== null && row.kind === 'row') {
            row.cells.push(frame)
          }
        } else if (frame.kind === 'row') {
          const table = top()
          if (table !== null && table.kind === 'table') {
            table.rows.push(frame)
          }
        } else if (frame.kind === 'table') {
          finishTable(frame)
        }
      }
      continue
    }

    // open
    // 已经在被抑制的子树里（例如 mc:Fallback 的旧版副本）：这里只做「看到过」的记录，
    // 不再新开图形帧，否则同一个对象会被数两遍。
    const nested = suppressCount > 0
    const drawing = drawings.length === 0 ? null : drawings[drawings.length - 1]
    if (drawing !== null) {
      if (name === 'blip' || name === 'imagedata') {
        drawing.stats.images = 1
      } else if (name === 'chart') {
        drawing.stats.charts = 1
      } else if (name === 'txbxContent') {
        drawing.stats.textboxes = 1
      } else if (name === 'OLEObject') {
        drawing.stats.embeddedObjects = 1
      }
    }
    if (!nested && (name === 'footnoteReference' || name === 'endnoteReference')) {
      stats.footnotes += 1
    }
    if (!nested && name === 'altChunk') {
      stats.altChunks += 1
    }
    if (!nested && (name === 'drawing' || name === 'pict' || name === 'object')) {
      beginDrawing(name)
    }
    if (SUPPRESSED_ELEMENTS.has(name)) {
      suppressCount += 1
    }

    switch (name) {
      case 't':
        // 自闭合的 `<w:t/>` 没有文字，也不能把 insideText 打开
        if (!event.selfClosing) {
          insideText = true
        }
        break
      case 'pStyle': {
        const state = activeParagraph()
        if (state !== null) {
          state.styleId = event.attrs.get('val') ?? ''
        }
        break
      }
      case 'outlineLvl': {
        const state = activeParagraph()
        if (state !== null) {
          const value = toInt(event.attrs.get('val'), -1)
          state.outlineLevel = value >= 0 ? value : null
        }
        break
      }
      case 'numId': {
        const state = activeParagraph()
        if (state !== null) {
          state.numId = event.attrs.get('val') ?? ''
        }
        break
      }
      case 'ilvl': {
        const state = activeParagraph()
        if (state !== null) {
          state.listLevel = clamp(toInt(event.attrs.get('val'), 0), 0, MAX_LIST_LEVEL)
        }
        break
      }
      case 'gridSpan': {
        const cell = nearestCell()
        if (cell !== null) {
          cell.span = clamp(toInt(event.attrs.get('val'), 1), 1, MAX_CELL_SPAN)
        }
        break
      }
      case 'vMerge': {
        const cell = nearestCell()
        if (cell !== null) {
          // 没有 val 或 val="continue" 表示「接着上一行」，这一格内容为空
          const start = event.attrs.get('val') === 'restart'
          cell.merged = !start
          cell.anchor = start
        }
        break
      }
      case 'tab':
        pushText(' ')
        break
      case 'br':
      case 'cr':
        pushText(NEWLINE)
        break
      case 'noBreakHyphen':
        pushText('-')
        break
      case 'p':
        if (!event.selfClosing) {
          paragraphs.push(
            suppressCount === 0
              ? { parts: [], styleId: '', outlineLevel: null, numId: '', listLevel: 0 }
              : null
          )
        }
        break
      case 'tbl':
        if (!event.selfClosing) {
          frames.push({ kind: 'table', keep: suppressCount === 0, rows: [] })
        }
        break
      case 'tr':
        if (!event.selfClosing) {
          frames.push({ kind: 'row', keep: suppressCount === 0, cells: [] })
        }
        break
      case 'tc':
        if (!event.selfClosing) {
          frames.push({
            kind: 'cell',
            keep: suppressCount === 0,
            blocks: [],
            span: 1,
            merged: false,
            anchor: false,
          })
        }
        break
      default:
        break
    }
  }

  return body.blocks
}

/* ------------------------------------------------------------------ *
 * 渲染：块 → Markdown
 * ------------------------------------------------------------------ */

const renderTable = (rows: string[][]): string => {
  const width = rows.reduce((max, row) => (row.length > max ? row.length : max), 0)
  if (width === 0) {
    return ''
  }
  const lines: string[] = []
  for (const row of rows) {
    const cells: string[] = []
    for (let index = 0; index < width; index += 1) {
      const value = row[index]
      cells.push(escapeCell(value === undefined ? '' : value))
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  const separators: string[] = []
  for (let index = 0; index < width; index += 1) {
    separators.push('---')
  }
  return [lines[0], `| ${separators.join(' | ')} |`, ...lines.slice(1)].join(NEWLINE)
}

/** 块序列 → Markdown：连续列表项之间不插空行（否则列表会被拆成多个段落）。 */
const renderMarkdown = (blocks: Block[]): string => {
  const chunks: string[] = []
  let listChunk: string[] | null = null
  let listOrdered = false
  const flushList = () => {
    if (listChunk !== null) {
      chunks.push(listChunk.join(NEWLINE))
      listChunk = null
    }
  }
  for (const block of blocks) {
    if (block.kind === 'list') {
      // 有序 / 无序切换时断开：`- 项` 紧跟 `1. 项` 会被 Markdown 当成同一个列表
      if (listChunk !== null && listOrdered !== block.ordered) {
        flushList()
      }
      if (listChunk === null) {
        listChunk = []
        listOrdered = block.ordered
      }
      const indent = '  '.repeat(block.level)
      listChunk.push(`${indent}${block.ordered ? '1.' : '-'} ${block.text}`)
      continue
    }
    flushList()
    if (block.kind === 'heading') {
      chunks.push(`${'#'.repeat(block.level)} ${block.text}`)
    } else if (block.kind === 'paragraph') {
      chunks.push(block.text)
    } else {
      const table = renderTable(block.rows)
      if (table !== '') {
        chunks.push(table)
      }
    }
  }
  flushList()
  return chunks.join(BLANK_LINE)
}

const buildWarnings = (stats: DocxStats): string[] => {
  const warnings: string[] = []
  if (stats.strippedDeclarations) {
    warnings.push('已剥离 XML 文档类型声明（DOCTYPE/ENTITY），用于防止外部实体注入')
  }
  if (stats.images > 0) {
    warnings.push(`已忽略 ${stats.images} 张图片（本阶段不做图像识别）`)
  }
  if (stats.charts > 0) {
    warnings.push(`已忽略 ${stats.charts} 个图表对象（图表未转成文本）`)
  }
  if (stats.embeddedObjects > 0) {
    warnings.push(`已忽略 ${stats.embeddedObjects} 个嵌入对象（OLE/ActiveX，如嵌入的 Excel、公式对象）`)
  }
  if (stats.textboxes > 0) {
    warnings.push(`已忽略 ${stats.textboxes} 个文本框/图形，其中的文字未提取`)
  }
  if (stats.altChunks > 0) {
    warnings.push(`已忽略 ${stats.altChunks} 个 altChunk 嵌入文档`)
  }
  if (stats.footnotes > 0) {
    warnings.push(`已忽略 ${stats.footnotes} 处脚注/尾注引用（其正文不在 document.xml 内）`)
  }
  if (stats.mergedCells > 0) {
    warnings.push(
      `表格中有 ${stats.mergedCells} 处合并单元格，已按空单元格处理（跨列只保留首列文本，跨行只保留首行文本）`
    )
  }
  if (stats.nestedTables > 0) {
    warnings.push(`已把 ${stats.nestedTables} 个嵌套表格压平为单元格内的一行文本`)
  }
  if (stats.unknownNumbering > 0) {
    warnings.push(`有 ${stats.unknownNumbering} 处列表编号定义缺失，已按无序列表输出`)
  }
  if (stats.tables > 0) {
    warnings.push(`已把 ${stats.tables} 个表格转为 Markdown 表格`)
  }
  return warnings
}

/* ------------------------------------------------------------------ *
 * 关系表：只做数量核对，避免「正文没数到但确实存在」的嵌入对象被静默丢掉
 * ------------------------------------------------------------------ */

type RelationCounts = { images: number; embeddedObjects: number; charts: number; notes: number }

const countRelations = (xml: string): RelationCounts => {
  const counts: RelationCounts = { images: 0, embeddedObjects: 0, charts: 0, notes: 0 }
  for (const event of tokenize(xml)) {
    if (event.kind !== 'open' || event.name !== 'Relationship') {
      continue
    }
    const type = event.attrs.get('Type') ?? ''
    if (/\/image$/i.test(type)) {
      counts.images += 1
    } else if (/\/(oleObject|package)$/i.test(type)) {
      counts.embeddedObjects += 1
    } else if (/\/chart$/i.test(type)) {
      counts.charts += 1
    } else if (/\/(footnotes|endnotes)$/i.test(type)) {
      counts.notes += 1
    }
  }
  return counts
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/** XML 字节 → 字符串：Word 正常写 UTF-8（可能带 BOM），老文档偶有 UTF-16。 */
const decodeXml = (bytes: Uint8Array): string => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes)
  }
  const start =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  return new TextDecoder('utf-8').decode(bytes.subarray(start))
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]
const ZIP_EMPTY_MAGIC = [0x50, 0x4b, 0x05, 0x06]

const hasZipMagic = (bytes: Uint8Array): boolean => {
  if (bytes.length < 4) {
    return false
  }
  const matches = (magic: number[]) => magic.every((byte, index) => bytes[index] === byte)
  return matches(ZIP_MAGIC) || matches(ZIP_EMPTY_MAGIC)
}

/**
 * 解析 DOCX（全组统一入口，见 manager.ts）。
 *
 * 失败一律抛 {@link DocxParseError}（带 code + 用户可见文案），由上层落成 `failed`；
 * 成功但有不完整之处**不抛错**，而是进 `warnings`（上层据此标 `partial`）。
 */
export const parseDocxFile = async (
  file: Blob,
  options?: ParseOptions
): Promise<ParsedDocument> => {
  const progress = options?.onProgress
  const checkAbort = () => {
    if (options?.signal?.aborted) {
      throw new DocxParseError('aborted', '文档解析已取消')
    }
  }

  progress?.({ stage: 'validate' })
  if (file.size === 0) {
    throw new DocxParseError('empty', '文件为空，无法解析')
  }
  if (file.size > ATTACHMENT_LIMITS.docxMaxBytes) {
    throw new DocxParseError(
      'too_large',
      `DOCX 文件超过大小上限（上限 ${megabytes(ATTACHMENT_LIMITS.docxMaxBytes)} MiB，当前 ${megabytes(file.size)} MiB）`
    )
  }
  checkAbort()

  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (!hasZipMagic(head)) {
    throw new DocxParseError(
      'not_docx',
      '不是有效的 DOCX 文件（ZIP 容器签名不符）。旧版 .doc 二进制格式请先另存为 .docx'
    )
  }

  progress?.({ stage: 'unzip' })
  const entries = new Map<string, Uint8Array>()
  let entryCount = 0
  let declaredBytes = 0
  try {
    // readArchive 只用到 slice / size，Blob 完全够用：这里只做类型收窄，不复制数据。
    for await (const entry of readArchive(file as File)) {
      checkAbort()
      entryCount += 1
      if (entryCount > ATTACHMENT_LIMITS.maxZipEntries) {
        throw new DocxParseError(
          'too_many_entries',
          `DOCX 压缩包条目数超过上限（上限 ${ATTACHMENT_LIMITS.maxZipEntries} 个，已读到 ${entryCount} 个）`
        )
      }
      declaredBytes += entry.size
      if (declaredBytes > ATTACHMENT_LIMITS.maxZipUncompressedBytes) {
        throw new DocxParseError(
          'uncompressed_too_large',
          `DOCX 解压后总量超过上限（上限 ${megabytes(ATTACHMENT_LIMITS.maxZipUncompressedBytes)} MiB），已中止解析`
        )
      }
      if (!WANTED_PATHS.has(entry.path)) {
        // 不需要的条目也要读完：zipReader 靠逐条 CRC 校验判定「整包完整」
        await skipEntry(entry)
        continue
      }
      if (entries.has(entry.path)) {
        throw new DocxParseError('corrupt_archive', 'DOCX 压缩包内存在重复条目，拒绝解析')
      }
      const blob = await readEntry(entry)
      entries.set(entry.path, new Uint8Array(await blob.arrayBuffer()))
    }
  } catch (error) {
    if (isDocxParseError(error)) {
      throw error
    }
    throw new DocxParseError(
      'corrupt_archive',
      'DOCX 压缩包结构损坏、使用了不支持的特性（ZIP64 分卷 / 加密 / 非常规压缩方法），或压缩比异常（疑似 ZIP 炸弹），已拒绝解析'
    )
  }

  const documentBytes = entries.get(DOCUMENT_PATH)
  if (documentBytes === undefined) {
    throw new DocxParseError(
      'missing_document',
      'DOCX 内未找到 word/document.xml，可能不是 Word 文档，或使用了非常规的主文档路径'
    )
  }

  progress?.({ stage: 'parse' })
  checkAbort()

  const stats = createStats()
  const document = stripDeclarations(decodeXml(documentBytes))
  stats.strippedDeclarations = document.stripped

  const numberingBytes = entries.get(NUMBERING_PATH)
  const stylesBytes = entries.get(STYLES_PATH)
  const relsBytes = entries.get(RELS_PATH)

  const numbering = parseNumbering(
    numberingBytes === undefined ? undefined : stripDeclarations(decodeXml(numberingBytes)).xml
  )
  const styles = parseStyles(
    stylesBytes === undefined ? undefined : stripDeclarations(decodeXml(stylesBytes)).xml
  )
  const relations =
    relsBytes === undefined
      ? null
      : countRelations(stripDeclarations(decodeXml(relsBytes)).xml)

  const blocks = extractBlocks(document.xml, numbering, styles, stats)

  if (relations !== null) {
    // 正文里数到的与关系表登记的取较大者：宁可多报一句「已忽略」，也不静默丢内容
    stats.images = Math.max(stats.images, relations.images)
    stats.embeddedObjects = Math.max(stats.embeddedObjects, relations.embeddedObjects)
    stats.charts = Math.max(stats.charts, relations.charts)
    if (relations.notes > 0 && stats.footnotes === 0) {
      stats.footnotes = relations.notes
    }
  }

  progress?.({ stage: 'render' })
  checkAbort()
  const text = renderMarkdown(blocks)
  const warnings = buildWarnings(stats)
  if (text.trim() === '') {
    warnings.push('未从文档中提取到任何文本（可能是纯图片、扫描件或空文档）')
  }

  const result: ParsedDocument = {
    text,
    // #544：docx 的 text 是纯 Markdown 渲染结果，没有解析器插入的标记 —— 两个字段恒等。
    characterCount: text.length,
    rawLength: text.length,
    parserVersion: DOCX_PARSER_VERSION,
  }
  if (warnings.length > 0) {
    result.warnings = warnings
  }
  return result
}

/**
 * 字节版入口：给「已经从 IndexedDB / 导入流程拿到 ArrayBuffer」的调用方用。
 * 与 {@link parseDocxFile} 是同一份实现，只是包一层 Blob（零拷贝视图，不复制数据）。
 */
export const parseDocx = (
  bytes: Uint8Array,
  filename: string,
  options?: ParseOptions
): Promise<ParsedDocument> => {
  if (/\.doc$/i.test(filename)) {
    return Promise.reject(
      new DocxParseError('not_docx', '旧版 .doc 二进制格式不受支持，请先另存为 .docx')
    )
  }
  // 与 zipReader 一致：Blob 只接受 ArrayBuffer 背书的视图，这里显式标注（不复制数据）
  return parseDocxFile(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: DOCX_MIME }), options)
}

/**
 * TXT 本地解析（Issue #570 / 母单 #480）。
 *
 * 纯函数：输入 `Uint8Array`，输出 `{ text, warnings, meta }`。不碰 DOM、不碰上游、不发请求，
 * 所以 Node 单测可以直接 import 它跑（`tests/unit/doc-570-txt.test.mjs`）。
 *
 * ## 判定顺序（每一步都有对应的单测，改顺序就会挂）
 *
 *   1. **BOM 优先**：UTF-8 BOM / UTF-16LE `FF FE` / UTF-16BE `FE FF`；UTF-32 的 BOM（`FF FE 00 00`
 *      / `00 00 FE FF`）直接报 `unsupported-encoding` —— TextDecoder 没有 utf-32，硬解只会出乱码。
 *   2. **无 BOM 先试 BOM-less UTF-16 的字节图样**（Windows 上脚本导出的「Unicode 文本」常常不带 BOM）。
 *   3. **再做二进制判定**（NUL 占比 / 控制字符占比）。这一条必须排在 2 之后：ASCII 为主的
 *      UTF-16LE 文本满地都是 `0x00`，先判二进制会把正常记事本文件误杀。
 *   4. **UTF-8 严格解码**成功 → UTF-8；失败则甩给 **GB18030**（GBK 的超集）严格解码，
 *      再按字节结构区分「这到底是 GBK 还是 GB18030」。
 *   5. 都失败 → 降级 UTF-8（非严格）+ `txt.encoding-undetermined` 警告。**不静默返回空串**。
 *
 * ## 文本归一
 *
 * `\r\n` / `\r` 一律转 `\n`；段内空行原样保留（是段间分隔的一部分）；**末尾多余空白行去掉**。
 * 除此之外不动正文：不 trim 行首、不折叠空格 —— 这些是内容，不是噪声。
 *
 * ## 为什么不用 iconv
 *
 * `TextDecoder` 的 `'gbk'` / `'gb18030'` / `'utf-16le'` / `'utf-16be'` 在 Chrome（含 Android WebView）
 * 与 Node 的 ICU 构建里都可用，而打包体里多一个 iconv 就是多几百 KB 和一张码表。老环境缺某个编码时
 * 走 `txt.encoding-unsupported` 降级，见 `decodeLenient`。
 */

/** 解析结果。与 `docx.ts` 同形；#572 的 `documents/index.ts` 会把两个实现收口成一套类型。 */
export type ParsedDocument = {
  /** 归一化后的纯文本：换行统一 `\n`，尾巴多余空白行已去掉 */
  text: string
  /** 稳定「码」而非给人看的译文：UI 侧按码取 i18n 文案（本模块不引 i18n，保持纯函数可单测） */
  warnings: string[]
  meta: TxtMeta
}

export type TxtEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'gb18030'

/**
 * 判定依据。
 * - `bom` / `utf16-pattern`：结构证据（最可靠）
 * - `utf8-strict` / `gb18030`：试解码成功（严格模式，不会把非法字节解成替换字符）
 * - `fallback`：全都判不出来，降级 UTF-8
 */
export type TxtEncodingSource = 'bom' | 'utf16-pattern' | 'utf8-strict' | 'gb18030' | 'fallback'

export type TxtMeta = {
  encoding: TxtEncoding
  source: TxtEncodingSource
  /** 原始字节数（含 BOM） */
  byteLength: number
  /** 归一化后的字符数（按 UTF-16 code unit 计，即 JS 的 `String#length`） */
  charLength: number
  /** 行数：空文本为 0，否则按 `\n` 切 */
  lineCount: number
  /** 原文开头带 BOM */
  bom: boolean
  /** 全文 NUL 字节占比（0~1）。> 1% 直接按二进制报错；0 < x ≤ 1% 只给 `txt.nul-bytes` 警告 */
  nulRatio: number
}

export type TxtErrorCode = 'empty-file' | 'binary' | 'unsupported-encoding'

/** 解析失败。`code` 是稳定码，调用方按码决定提示（本模块不产出中文文案）。 */
export class TxtParseError extends Error {
  readonly code: TxtErrorCode

  constructor(code: TxtErrorCode) {
    super(`Invalid text document: ${code}`)
    this.name = 'TxtParseError'
    this.code = code
  }
}

/** 警告码（稳定字符串常量，测试与 UI 都按它比对） */
export const TXT_WARNING = {
  /** 归一化后正文为空（纯空白文件）：不是静默返回空串，调用方必须拿到这条 */
  emptyContent: 'txt.empty-content',
  /** UTF-8 / GB18030 严格解码都失败，降级 UTF-8（文本里会出现替换字符） */
  encodingUndetermined: 'txt.encoding-undetermined',
  /** 无 BOM 的 UTF-16，靠字节图样认出来的一类文件 */
  noBomUtf16: 'txt.no-bom-utf16',
  /** 文本里混了少量 NUL（未达二进制阈值），这些字节已被剔除 */
  nulBytes: 'txt.nul-bytes',
  /** 解码结果含 U+FFFD：文件可能在中间被截断，或前后半段是不同编码 */
  replacementChars: 'txt.replacement-chars',
  /** 当前环境缺这个编码的解码器（老 Safari），已降级 UTF-8 */
  encodingUnsupported: 'txt.encoding-unsupported',
} as const

/**
 * 二进制阈值。
 * - NUL 占比 **1%**：正常文本（代码 / JSON / 日志 / CSV）几乎为 0；ELF、PNG、EXE 都在 5% 以上。
 *   给到 1% 是为了放过「文本里混进几个 `\0`」的脏文件 —— 那种情况只给警告。
 * - 控制字符占比 **5%**：抓「没有 NUL 的二进制」（压缩流、加密块）。
 */
const NUL_RATIO_BINARY = 0.01
const CONTROL_RATIO_BINARY = 0.05

/**
 * BOM-less UTF-16 的判据：文本里「应该恒为 0x00」的那一半高位字节中，> 30% 真的是 `0x00`。
 * ASCII 为主的 UTF-16 文本这个比值接近 100%，而普通的单字节文本接近 0（偶发 NUL 达不到 30%）。
 */
const UTF16_ZERO_RATIO = 0.3

const BOM_UTF8 = [0xef, 0xbb, 0xbf]
const BOM_UTF16LE = [0xff, 0xfe]
const BOM_UTF16BE = [0xfe, 0xff]
const BOM_UTF32LE = [0xff, 0xfe, 0x00, 0x00]
const BOM_UTF32BE = [0x00, 0x00, 0xfe, 0xff]

const startsWith = (bytes: Uint8Array, prefix: number[]): boolean => {
  if (bytes.length < prefix.length) {
    return false
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) {
      return false
    }
  }
  return true
}

/** 某个字节在全文里的占比（0~1） */
const byteRatio = (bytes: Uint8Array, target: number): number => {
  let hits = 0
  for (const value of bytes) {
    if (value === target) {
      hits += 1
    }
  }
  return bytes.length === 0 ? 0 : hits / bytes.length
}

/**
 * 控制字符占比：`\t \n \r \f` 之外、小于 `0x20` 的字节数占比。
 * 文本里偶发 `0x1b`（终端配色转义）不算，5% 阈值放得过。
 */
const controlRatio = (bytes: Uint8Array): number => {
  let hits = 0
  for (const value of bytes) {
    if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d && value !== 0x0c) {
      hits += 1
    }
  }
  return bytes.length === 0 ? 0 : hits / bytes.length
}

const decoderFor = (label: string, fatal: boolean): TextDecoder | null => {
  try {
    return new TextDecoder(label, { fatal })
  } catch {
    // 环境不认这个编码名（老 Safari / 精简版 ICU）
    return null
  }
}

/** 严格解码：数据非法、或环境不认这个编码名，都返回 null（调用方据此挑下一个候选） */
const decodeStrict = (label: string, bytes: Uint8Array): string | null => {
  const decoder = decoderFor(label, true)
  if (decoder === null) {
    return null
  }
  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

/** 宽松解码：编码已定，只负责解出来。环境缺解码器时返回 null，由调用方降级并告警。 */
const decodeLenient = (encoding: TxtEncoding, bytes: Uint8Array): string | null => {
  const decoder = decoderFor(encoding, false)
  return decoder === null ? null : decoder.decode(bytes)
}

/**
 * GBK 兼容性扫描（用来区分 GBK / GB18030）。
 *
 * GB18030 是 GBK 的超集，所以「GB18030 严格解码成功」并不代表原文就是 GB18030。字节结构才能分辨：
 * ASCII，或「lead `0x81`-`0xFE` + trail `0x40`-`0xFE`（去 `0x7F`）」的双字节序列 → GBK；
 * 出现 `0x81`-`0xFE` + `0x30`-`0x39` 的四字节序列（GB18030 独有的扩展区）或其它越界 → GB18030。
 */
const isGbkCompatible = (bytes: Uint8Array): boolean => {
  let index = 0
  while (index < bytes.length) {
    const lead = bytes[index]
    if (lead < 0x80) {
      index += 1
      continue
    }
    if (lead < 0x81 || lead > 0xfe) {
      return false
    }
    if (index + 1 >= bytes.length) {
      return false
    }
    const trail = bytes[index + 1]
    if (trail < 0x40 || trail > 0xfe || trail === 0x7f) {
      return false
    }
    index += 2
  }
  return true
}

/**
 * BOM-less UTF-16 的字节图样 sniff。
 *
 * Windows 记事本存「Unicode」是带 BOM 的，但很多导出工具（旧版 Excel、脚本、部分安卓 App）不带。
 * 判据：长度为偶数，且「应该恒为 `0x00`」的那一半高位字节里 > 30% 真的是 `0x00`。
 *
 * 只认得出 ASCII 为主的文本：纯中文的 BOM-less UTF-16 没有 `0x00` 特征，会落到 GB18030 分支
 * （列在 PR 的「未测边界」里，不是这条判据的 bug，而是这类字节本身歧义）。
 */
const sniffUtf16Pattern = (bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null => {
  if (bytes.length < 4 || bytes.length % 2 !== 0) {
    return null
  }
  const pairs = bytes.length / 2
  let evenZero = 0
  let oddZero = 0
  for (let index = 0; index < bytes.length; index += 2) {
    if (bytes[index] === 0) {
      evenZero += 1
    }
    if (bytes[index + 1] === 0) {
      oddZero += 1
    }
  }
  if (oddZero / pairs > UTF16_ZERO_RATIO) {
    return 'utf-16le'
  }
  if (evenZero / pairs > UTF16_ZERO_RATIO) {
    return 'utf-16be'
  }
  return null
}

type SniffResult = {
  encoding: TxtEncoding
  source: TxtEncodingSource
  /** BOM 字节数：解码前要跳过 */
  offset: number
  bom: boolean
  warnings: string[]
}

/** 编码判定（不碰文本，只认字节） */
const sniffEncoding = (bytes: Uint8Array, nulRatio: number): SniffResult => {
  if (startsWith(bytes, BOM_UTF8)) {
    return { encoding: 'utf-8', source: 'bom', offset: 3, bom: true, warnings: [] }
  }
  // UTF-32 的 BOM 必须在 UTF-16LE 之前判：`FF FE 00 00` 的前两字节也是 UTF-16LE 的 BOM
  if (startsWith(bytes, BOM_UTF32LE) || startsWith(bytes, BOM_UTF32BE)) {
    throw new TxtParseError('unsupported-encoding')
  }
  if (startsWith(bytes, BOM_UTF16LE)) {
    return { encoding: 'utf-16le', source: 'bom', offset: 2, bom: true, warnings: [] }
  }
  if (startsWith(bytes, BOM_UTF16BE)) {
    return { encoding: 'utf-16be', source: 'bom', offset: 2, bom: true, warnings: [] }
  }

  const utf16 = sniffUtf16Pattern(bytes)
  if (utf16 !== null) {
    return { encoding: utf16, source: 'utf16-pattern', offset: 0, bom: false, warnings: [TXT_WARNING.noBomUtf16] }
  }

  if (nulRatio > NUL_RATIO_BINARY || controlRatio(bytes) > CONTROL_RATIO_BINARY) {
    throw new TxtParseError('binary')
  }

  if (decodeStrict('utf-8', bytes) !== null) {
    return { encoding: 'utf-8', source: 'utf8-strict', offset: 0, bom: false, warnings: [] }
  }
  if (decodeStrict('gb18030', bytes) !== null) {
    return {
      encoding: isGbkCompatible(bytes) ? 'gbk' : 'gb18030',
      source: 'gb18030',
      offset: 0,
      bom: false,
      warnings: [],
    }
  }
  return { encoding: 'utf-8', source: 'fallback', offset: 0, bom: false, warnings: [TXT_WARNING.encodingUndetermined] }
}

/**
 * 换行归一 + 去尾巴空白行。段内空行是段落分隔，必须留着；结尾的空白行（含只由空格 / 制表符组成的行）
 * 没有任何信息，一律去掉。先剥掉残留的 `U+FEFF`（有的文件 BOM 后面还跟一个，或 `TextDecoder` 不吞）。
 */
const normalizeText = (raw: string): string =>
  raw
    .replace(/^\uFEFF+/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(?:\n[ \t]*)+$/, '')

/**
 * 解析 TXT 文件。
 *
 * @throws {TxtParseError} `empty-file`（0 字节）/ `binary`（含 NUL 比例超阈值）/ `unsupported-encoding`（UTF-32）
 */
export const parseTxt = (bytes: Uint8Array): ParsedDocument => {
  if (bytes.length === 0) {
    // 空文件不是「空文档」，是「拿错文件了」：返回空串会让上层以为导入成功
    throw new TxtParseError('empty-file')
  }

  const nulRatio = byteRatio(bytes, 0)
  const sniffed = sniffEncoding(bytes, nulRatio)
  const warnings = [...sniffed.warnings]

  const body = sniffed.offset === 0 ? bytes : bytes.subarray(sniffed.offset)
  let decoded = decodeLenient(sniffed.encoding, body)
  if (decoded === null) {
    decoded = new TextDecoder('utf-8').decode(body)
    warnings.push(TXT_WARNING.encodingUnsupported)
  }

  let text = normalizeText(decoded)
  // 零星的 `\0` 剔掉并告警。按**解码后**的字符判，不按原始字节比例判：
  // UTF-16 的字节里满是 `0x00`（那是高位字节），但解出来并没有 NUL 字符，不该报这一条。
  if (text.includes('\u0000')) {
    // 不用正则：`\u0000` 写在正则字面量里会命中 no-control-regex
    text = text.split('\u0000').join('')
    warnings.push(TXT_WARNING.nulBytes)
  }
  if (text.includes('\uFFFD') && !warnings.includes(TXT_WARNING.encodingUndetermined)) {
    warnings.push(TXT_WARNING.replacementChars)
  }
  if (text.trim() === '') {
    warnings.push(TXT_WARNING.emptyContent)
  }

  return {
    text,
    warnings,
    meta: {
      encoding: sniffed.encoding,
      source: sniffed.source,
      byteLength: bytes.length,
      charLength: text.length,
      lineCount: text === '' ? 0 : text.split('\n').length,
      bom: sniffed.bom,
      nulRatio,
    },
  }
}

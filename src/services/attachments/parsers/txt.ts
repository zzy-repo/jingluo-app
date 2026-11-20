/**
 * #480 §5.1 TXT 解析器：编码识别 → 解码 → 规范化 → 统一 ParsedDocument。
 *
 * 设计取舍（PR 里要写清「参考了谁、为什么这么定」）：
 *  - Chatbox（`src/main/file-parser.ts`）在 Electron 主进程用 `chardet` + `iconv-lite`：先读 4KB
 *    样本判编码，再整文件转码。那两个包是 Node 侧的（iconv-lite 带全部编码表 + Buffer），
 *    我们跑在 Android WebView 里，拉进来等于把 300KB+ 的表塞进 APK，为一份 TXT 不值。
 *  - 浏览器原生 `TextDecoder` 就带 WHATWG Encoding 全表（utf-8 / utf-16le / utf-16be / gbk /
 *    gb18030 全在列），Chromium 83 已支持（`scripts/compat/matrix-scan.mjs` 记 TextDecoder
 *    chrome 38，属「无风险」）。所以这里**不引任何第三方库**，用原生能力 + 自带启发式。
 *  - 只有一种情况原生帮不上忙：运行环境根本没有 `TextDecoder`（异常 WebView / 测试环境）。
 *    那时降级为手写 UTF-8 解码，并**明确告警**说 GBK / GB18030 可能乱码，绝不假装成功。
 *
 * 老内核硬约束（`config/compat.json` baselineChromium=83，目标 ES2017）：
 * 本文件不用 `??` / `?.` / `??=` / `||=` / 私有字段 `#x` / 顶层 await / `Array#at` /
 * `String#replaceAll` / `Object.hasOwn` / `structuredClone`。
 *
 * 失败语义（#480 §3.7「禁止静默截断/忽略解析失败」）：
 *  - 空文件、二进制、超限、编码无法解码 → **抛 TxtParseError**（带 code），由 AttachmentManager
 *    落 `status: 'failed'` + `errorMessage`；
 *  - 解码有损（乱码）、超长提示 → **不抛**，走 `warnings`，由 manager 落 `status: 'partial'`；
 *  - 无论哪种情况都不截断正文：`text` 是完整解析结果，裁剪交给 ContextBuilder 按预算做。
 */
import { formatImportBytes } from '../../chat/history/importLimit.js'
import { ATTACHMENT_LIMITS } from '../limits.js'
import type { ParsedDocument, ParseOptions } from '../types.js'

/** 解析器版本（与文件 sha256 一起构成缓存去重键；输出格式变了就升这个号） */
export const TXT_PARSER_VERSION = 'txt-1.0.0'

/** 识别出的编码（对外展示用，UI 直接显示这个字符串） */
export type TxtEncoding = 'UTF-8' | 'UTF-8 BOM' | 'UTF-16LE' | 'UTF-16BE' | 'GBK' | 'GB18030'

/** 解析失败的机器可读原因；文案在异常 message 里，manager 只负责展示 */
export type TxtParseFailureCode =
  | 'empty'
  | 'too-large'
  | 'binary'
  | 'unsupported-encoding'
  | 'decode-failed'
  | 'cancelled'

/** TXT 解析失败（空文件 / 二进制 / 超限 / 编码不可解）——一律 fail-fast，不做降级猜测 */
export class TxtParseError extends Error {
  readonly code: TxtParseFailureCode
  readonly filename: string

  constructor(code: TxtParseFailureCode, message: string, filename: string) {
    super(message)
    this.name = 'TxtParseError'
    this.code = code
    this.filename = filename
  }
}

/** `parseTxtFile` 的返回值：统一结构 + 识别出的编码（供附件卡片展示） */
export interface ParsedTxtDocument extends ParsedDocument {
  encoding: TxtEncoding
}

/** 判定用的采样上限：只看头部 64KiB，避免 5MiB 文件反复全量扫描 */
const SAMPLE_BYTES = 64 * 1024
/** 控制字符（除 \t \n \f \r）占比超过此值 → 判定二进制 */
const CONTROL_RATIO_MAX = 0.3
/** 解码后 NUL 字符占比超过此值 → 判定二进制（UTF-16 分支已先排除） */
const NUL_RATIO_MAX = 0.02
/** 替换字符 U+FFFD 的绝对告警阈值 */
const REPLACEMENT_WARN_COUNT = 10
/** 替换字符 U+FFFD 的相对告警阈值（2‰） */
const REPLACEMENT_WARN_RATIO = 0.002
/** 「少量非法 UTF-8 序列」判据：低于此比例时仍按 UTF-8 解码并告警，不改判 GBK */
const UTF8_LOSSY_RATIO_MAX = 0.002
/** 绝对容忍量：短文件里 1~3 个坏字节不该把整篇中文改判成 GBK（比例判据在短文件上会失真） */
const UTF8_BAD_BYTES_TOLERANCE = 3
/** 无 BOM 的 UTF-16 猜测：某一侧 NUL 占比下限 / 另一侧上限 */
const UTF16_NUL_MIN = 0.6
const UTF16_NUL_MAX = 0.1

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd)
const BOM_CHAR = 0xfeff

const BOM_UTF8 = [0xef, 0xbb, 0xbf]
const BOM_UTF16LE = [0xff, 0xfe]
const BOM_UTF16BE = [0xfe, 0xff]
const BOM_UTF32LE = [0xff, 0xfe, 0x00, 0x00]
const BOM_UTF32BE = [0x00, 0x00, 0xfe, 0xff]

const hasPrefix = (bytes: Uint8Array, prefix: readonly number[]): boolean => {
  if (bytes.length < prefix.length) {
    return false
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) {
      return false
    }
  }
  return true
}

const sampleOf = (bytes: Uint8Array): Uint8Array =>
  bytes.length > SAMPLE_BYTES ? bytes.subarray(0, SAMPLE_BYTES) : bytes

/** 去掉解码后残留的行首 BOM（`ignoreBOM: false` 下原生解码器本就会剥，这里只是兜底） */
const stripLeadingBom = (text: string): string =>
  text.length > 0 && text.charCodeAt(0) === BOM_CHAR ? text.slice(1) : text

/** 该运行环境是否认识这个编码标签（Chromium 83 认得 gbk / gb18030 / utf-16be） */
const supportsEncoding = (label: string): boolean => {
  if (typeof TextDecoder === 'undefined') {
    return false
  }
  try {
    const decoder = new TextDecoder(label)
    return decoder.encoding.length > 0
  } catch {
    return false
  }
}

/** 解码；返回 null = 编码标签不可用，或 fatal 模式下遇到非法字节序列 */
const decodeWith = (label: string, bytes: Uint8Array, fatal: boolean): string | null => {
  if (!supportsEncoding(label)) {
    return null
  }
  try {
    return new TextDecoder(label, { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * 手写 UTF-8 解码（仅在完全没有 TextDecoder 的环境兜底）。
 * 非法序列输出 U+FFFD，与原生 `fatal: false` 语义一致，不抛错、不吞字节。
 */
const decodeUtf8Fallback = (bytes: Uint8Array): string => {
  let out = ''
  let index = 0
  while (index < bytes.length) {
    const first = bytes[index]
    if (first < 0x80) {
      out += String.fromCharCode(first)
      index += 1
      continue
    }
    let extra = 0
    let point = 0
    if (first >= 0xc2 && first <= 0xdf) {
      extra = 1
      point = first & 0x1f
    } else if (first >= 0xe0 && first <= 0xef) {
      extra = 2
      point = first & 0x0f
    } else if (first >= 0xf0 && first <= 0xf4) {
      extra = 3
      point = first & 0x07
    }
    if (extra === 0 || index + extra >= bytes.length) {
      out += REPLACEMENT_CHAR
      index += 1
      continue
    }
    let valid = true
    for (let k = 1; k <= extra; k += 1) {
      const next = bytes[index + k]
      if ((next & 0xc0) !== 0x80) {
        valid = false
        break
      }
      point = (point << 6) | (next & 0x3f)
    }
    if (!valid) {
      out += REPLACEMENT_CHAR
      index += 1
      continue
    }
    out += String.fromCodePoint(point)
    index += extra + 1
  }
  return out
}

/** U+FFFD 出现次数（不做正则，避免控制字符/大文件回溯问题） */
const replacementCount = (text: string): number => {
  let count = 0
  let index = text.indexOf(REPLACEMENT_CHAR)
  while (index >= 0) {
    count += 1
    index = text.indexOf(REPLACEMENT_CHAR, index + 1)
  }
  return count
}

const nulRatio = (text: string): number => {
  if (text.length === 0) {
    return 0
  }
  let count = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0) {
      count += 1
    }
  }
  return count / text.length
}

/**
 * 二进制判定：NUL 字节，或高比例不可打印控制字符（`\t \n \f \r` 不算）。
 * 只看采样，0x80 以上字节不计入控制字符 —— 否则整篇 GBK 中文会被误判成二进制。
 */
const looksBinary = (sample: Uint8Array): boolean => {
  if (sample.length === 0) {
    return false
  }
  let nul = 0
  let control = 0
  for (let i = 0; i < sample.length; i += 1) {
    const byte = sample[i]
    if (byte === 0) {
      nul += 1
    } else if (byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d)) {
      control += 1
    }
  }
  if (nul > 0) {
    return true
  }
  return control / sample.length > CONTROL_RATIO_MAX
}

/**
 * 采样里是否出现 GB18030 四字节序列（`lead 81-FE` + `30-39` + `lead 81-FE` + `30-39`）。
 *
 * 为什么要单独测：ICU 的 GBK 解码器**顺带**认得 GB18030 四字节序列，标 `gbk` 也不报错，
 * 于是一篇含生僻字的 GB18030 文件会被标成 GBK。既然编码标签是给用户看的，就按字节结构判准。
 */
const hasGb18030FourByte = (sample: Uint8Array): boolean => {
  for (let i = 0; i + 3 < sample.length; i += 1) {
    const b0 = sample[i]
    const b1 = sample[i + 1]
    const b2 = sample[i + 2]
    const b3 = sample[i + 3]
    if (
      b0 >= 0x81 &&
      b0 <= 0xfe &&
      b1 >= 0x30 &&
      b1 <= 0x39 &&
      b2 >= 0x81 &&
      b2 <= 0xfe &&
      b3 >= 0x30 &&
      b3 <= 0x39
    ) {
      return true
    }
  }
  return false
}

/**
 * 解码结果是否「像人读的文本」：孤立代理项、U+FFFD、私用区、非常见控制字符一律否决。
 *
 * 为什么需要：ICU / 各内核的 GBK 解码器对个别非法字节序列是**宽松**的（不抛错，塞进一个
 * 孤立代理项或私用区字符），只靠 `fatal: true` 会把「GB18030 四字节序列」误判成 GBK。
 * 所以严格解码成功后还要过这一关，过不了就当这个候选不成立，继续往下试。
 */
const isPlausibleText = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next < 0xdc00 || next > 0xdfff) {
        return false
      }
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
    if (code === 0xfffd) {
      return false
    }
    if (code >= 0xe000 && code <= 0xf8ff) {
      return false
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) {
      return false
    }
    if (code === 0x7f) {
      return false
    }
  }
  return true
}

/**
 * 无 BOM 的 UTF-16 猜测：ASCII 文本的字面量在 UTF-16 里有一半字节是 0。
 * 偶数位大量为 0 → 大端；奇数位大量为 0 → 小端。
 * 已知局限：**纯中文**的 UTF-16 没有这种 0 字节结构，无 BOM 时无法可靠区分字节序，
 * 这类文件会落到后面的 UTF-8 → GBK → GB18030 链路（PR 里写明）。
 */
const guessUtf16 = (sample: Uint8Array): TxtEncoding | null => {
  const pairs = Math.floor(sample.length / 2)
  if (pairs < 8) {
    return null
  }
  let evenZero = 0
  let oddZero = 0
  for (let i = 0; i < pairs; i += 1) {
    if (sample[i * 2] === 0) {
      evenZero += 1
    }
    if (sample[i * 2 + 1] === 0) {
      oddZero += 1
    }
  }
  const evenRatio = evenZero / pairs
  const oddRatio = oddZero / pairs
  if (oddRatio >= UTF16_NUL_MIN && evenRatio <= UTF16_NUL_MAX) {
    return 'UTF-16LE'
  }
  if (evenRatio >= UTF16_NUL_MIN && oddRatio <= UTF16_NUL_MAX) {
    return 'UTF-16BE'
  }
  return null
}

/**
 * 规范化（#480 §5.1「统一换行符、保留段落结构」）：
 *  - `\r\n` / `\r` → `\n`；
 *  - 逐行去掉行尾空白（保留行首缩进）；
 *  - 连续空行最多保留一个（空行 = 去掉行尾空白后为空的行走）；
 *  - 去掉首尾空行；
 *  - 段落之间的相对顺序、内部空格一字不动。
 */
const normalizeText = (raw: string): string => {
  const body = raw.indexOf('\r') >= 0 ? raw.split('\r\n').join('\n').split('\r').join('\n') : raw
  const lines = body.split('\n')
  const kept: string[] = []
  let blankRun = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/[ \t]+$/, '')
    if (line === '') {
      blankRun += 1
      if (blankRun > 1) {
        continue
      }
      kept.push('')
      continue
    }
    blankRun = 0
    kept.push(line)
  }
  let start = 0
  let end = kept.length
  while (start < end && kept[start] === '') {
    start += 1
  }
  while (end > start && kept[end - 1] === '') {
    end -= 1
  }
  return kept.slice(start, end).join('\n')
}

/** 是否已经就「乱码」告过警（有损解码分支已经写过一条，别叠加重复文案） */
const warnedAboutMojibake = (warnings: readonly string[]): boolean => {
  for (let i = 0; i < warnings.length; i += 1) {
    if (warnings[i].indexOf('乱码') >= 0) {
      return true
    }
  }
  return false
}

/** 识别结果 */
interface DetectedText {
  text: string
  encoding: TxtEncoding
  warnings: string[]
}

const unsupportedRuntime = (bytes: Uint8Array, filename: string): DetectedText => {
  if (hasPrefix(bytes, BOM_UTF16LE) || hasPrefix(bytes, BOM_UTF16BE)) {
    throw new TxtParseError(
      'decode-failed',
      `当前运行环境缺少 TextDecoder，无法解码 UTF-16 编码的「${filename}」；请另存为 UTF-8 后再上传`,
      filename
    )
  }
  const body = hasPrefix(bytes, BOM_UTF8) ? bytes.subarray(BOM_UTF8.length) : bytes
  return {
    encoding: 'UTF-8',
    text: decodeUtf8Fallback(body),
    warnings: [
      `当前环境不支持 TextDecoder，已按 UTF-8 尽力解码「${filename}」；GBK / GB18030 编码的文本可能出现乱码`,
    ],
  }
}

/** 按 BOM → 无 BOM 启发式的顺序判定编码并解码 */
const detectAndDecode = (bytes: Uint8Array, filename: string): DetectedText => {
  if (!supportsEncoding('utf-8')) {
    return unsupportedRuntime(bytes, filename)
  }
  if (hasPrefix(bytes, BOM_UTF32LE) || hasPrefix(bytes, BOM_UTF32BE)) {
    throw new TxtParseError(
      'unsupported-encoding',
      `「${filename}」是 UTF-32 编码的文本，暂不支持；请另存为 UTF-8 后再上传`,
      filename
    )
  }
  if (hasPrefix(bytes, BOM_UTF8)) {
    const text = decodeWith('utf-8', bytes, false)
    if (text === null) {
      throw new TxtParseError('decode-failed', `无法解码「${filename}」的 UTF-8 BOM 内容`, filename)
    }
    return { encoding: 'UTF-8 BOM', text: stripLeadingBom(text), warnings: [] }
  }
  if (hasPrefix(bytes, BOM_UTF16LE) || hasPrefix(bytes, BOM_UTF16BE)) {
    const little = hasPrefix(bytes, BOM_UTF16LE)
    const label = little ? 'utf-16le' : 'utf-16be'
    const encoding: TxtEncoding = little ? 'UTF-16LE' : 'UTF-16BE'
    const text = decodeWith(label, bytes, false)
    if (text === null) {
      throw new TxtParseError('decode-failed', `无法解码「${filename}」的 ${encoding} 内容`, filename)
    }
    return { encoding, text: stripLeadingBom(text), warnings: [] }
  }

  const sample = sampleOf(bytes)

  const guessed = guessUtf16(sample)
  if (guessed !== null) {
    const label = guessed === 'UTF-16LE' ? 'utf-16le' : 'utf-16be'
    const text = decodeWith(label, bytes, false)
    if (text !== null && nulRatio(text) <= NUL_RATIO_MAX && isPlausibleText(text)) {
      return { encoding: guessed, text: stripLeadingBom(text), warnings: [] }
    }
  }

  if (looksBinary(sample)) {
    throw new TxtParseError(
      'binary',
      `「${filename}」看起来不是文本文件（含 NUL 字节或大量不可打印字符），无法作为 TXT 解析`,
      filename
    )
  }

  const fourByteGb = hasGb18030FourByte(sample)

  const strictUtf8 = decodeWith('utf-8', bytes, true)
  if (strictUtf8 !== null) {
    return { encoding: 'UTF-8', text: stripLeadingBom(strictUtf8), warnings: [] }
  }

  // UTF-8 严格解码失败：先看是不是「只有零星几个坏字节」，是的话仍按 UTF-8 出结果 + 告警，
  // 不要因为几个坏字节就把整篇 UTF-8 中文（字节串恰好也能当 GBK 解）改判成 GBK 的乱码。
  //
  // 已知取舍：既不合法 UTF-8、又没有 GB18030 四字节特征、还短到坏字节数 ≤ 3 的文件（例如
  // 4 字节的 81 30 81 30 混合少量 ASCII），可能被当成「UTF-8 + 若干坏字节」——这种情况一定带
  // 乱码告警（status=partial），不会静默出错；正常长度的 GBK / GB18030 中文不会走到这一支。
  const lossyUtf8 = decodeWith('utf-8', bytes, false)
  if (lossyUtf8 !== null && !fourByteGb) {
    const bad = replacementCount(lossyUtf8)
    if (bad <= UTF8_BAD_BYTES_TOLERANCE || (lossyUtf8.length > 0 && bad / lossyUtf8.length <= UTF8_LOSSY_RATIO_MAX)) {
      return {
        encoding: 'UTF-8',
        text: stripLeadingBom(lossyUtf8),
        warnings: [
          `「${filename}」有 ${bad} 处非法 UTF-8 字节序列，可能存在乱码，已按 UTF-8 尽力解码`,
        ],
      }
    }
  }

  // 中文编码候选：默认先 GBK（更常见的标签），出现 GB18030 四字节序列时反过来先试 GB18030。
  const legacyCandidates: { encoding: TxtEncoding; label: string }[] = fourByteGb
    ? [
        { encoding: 'GB18030', label: 'gb18030' },
        { encoding: 'GBK', label: 'gbk' },
      ]
    : [
        { encoding: 'GBK', label: 'gbk' },
        { encoding: 'GB18030', label: 'gb18030' },
      ]
  for (let i = 0; i < legacyCandidates.length; i += 1) {
    const candidate = legacyCandidates[i]
    const text = decodeWith(candidate.label, bytes, true)
    if (text !== null && isPlausibleText(text)) {
      return { encoding: candidate.encoding, text, warnings: [] }
    }
  }

  // 两条严格解码都不成立：用 GB18030（几乎不会抛）与 UTF-8 的替换字符数做仲裁，取损失小的。
  const lossyGb18030 = decodeWith('gb18030', bytes, false)
  const gbWarnings: string[] = []
  const gbBad = lossyGb18030 === null ? Number.MAX_SAFE_INTEGER : replacementCount(lossyGb18030)
  const utfBad = lossyUtf8 === null ? Number.MAX_SAFE_INTEGER : replacementCount(lossyUtf8)
  if (lossyGb18030 !== null && gbBad <= utfBad) {
    gbWarnings.push(`「${filename}」可能存在乱码，已用 GB18030 尽力解码`)
    return { encoding: 'GB18030', text: lossyGb18030, warnings: gbWarnings }
  }
  if (lossyUtf8 !== null) {
    return {
      encoding: 'UTF-8',
      text: stripLeadingBom(lossyUtf8),
      warnings: [`「${filename}」可能存在乱码，已用 UTF-8 尽力解码`],
    }
  }
  // 该环境既没有 gb18030 也解不动 UTF-8（极少见）：仍然给出明确失败，不返回半成品。
  if (!supportsEncoding('gb18030') && !supportsEncoding('gbk')) {
    throw new TxtParseError(
      'decode-failed',
      `当前运行环境不支持 GBK / GB18030 解码，无法解析「${filename}」；请另存为 UTF-8 后再上传`,
      filename
    )
  }
  throw new TxtParseError('decode-failed', `「${filename}」无法解码，请确认文件编码`, filename)
}

/**
 * 解析 TXT 字节流（同步核心，全部判定逻辑都在这里）。
 *
 * - 成功：`warnings` 为空数组；
 * - 部分成功（有损解码 / 超出注入预算提示）：`warnings` 非空，正文完整不截断；
 * - 失败：抛 {@link TxtParseError}（`status` 由 manager 落 `failed`）。
 *
 * @param bytes 原始字节（调用方已按扩展名/大小初筛，这里仍然自己再判一次上限）
 * @param filename 原始文件名，仅用于拼错误与告警文案
 */
export const parseTxtBytes = (bytes: Uint8Array, filename: string): ParsedTxtDocument => {
  if (bytes.length === 0) {
    throw new TxtParseError('empty', `「${filename}」文件是空的`, filename)
  }
  if (bytes.length > ATTACHMENT_LIMITS.txtMaxBytes) {
    throw new TxtParseError(
      'too-large',
      `「${filename}」有 ${formatImportBytes(bytes.length)}，超过 TXT 单文件上限 ${formatImportBytes(
        ATTACHMENT_LIMITS.txtMaxBytes
      )}，请拆分后再上传`,
      filename
    )
  }

  const detected = detectAndDecode(bytes, filename)
  const warnings = detected.warnings.slice()

  if (nulRatio(detected.text) > NUL_RATIO_MAX) {
    throw new TxtParseError(
      'binary',
      `「${filename}」看起来不是文本文件（解码后仍含大量 NUL 字符），无法作为 TXT 解析`,
      filename
    )
  }

  const text = normalizeText(detected.text)
  if (text === '') {
    throw new TxtParseError('empty', `「${filename}」文件是空的`, filename)
  }

  const damaged = replacementCount(text)
  if (
    damaged > 0 &&
    (damaged >= REPLACEMENT_WARN_COUNT || damaged / text.length >= REPLACEMENT_WARN_RATIO) &&
    !warnedAboutMojibake(warnings)
  ) {
    warnings.push(
      `「${filename}」可能存在乱码，已用 ${detected.encoding} 尽力解码（${damaged} 处无法解码的字节序列）`
    )
  }

  // #544：txt 不插入任何结构标记，所以「正文」与「注入文本」是同一段字符串 ——
  // characterCount 与 rawLength 恒等（PDF 那边两者不等，见 parsers/pdf.ts）。
  const characterCount = text.length
  if (characterCount > ATTACHMENT_LIMITS.maxExtractedChars) {
    warnings.push(
      `「${filename}」解析出 ${characterCount} 字符，超过单次注入上限 ${ATTACHMENT_LIMITS.maxExtractedChars} 字符；` +
        '正文已完整保留，注入时由上下文预算裁剪'
    )
  }

  return {
    text,
    characterCount,
    rawLength: text.length,
    warnings,
    parserVersion: TXT_PARSER_VERSION,
    encoding: detected.encoding,
  }
}

/** Blob 上没有 name（File 才有）；无名字时用中性文案，不在错误里编造文件名 */
const filenameOf = (file: Blob): string => {
  const named = file as Blob & { name?: unknown }
  return typeof named.name === 'string' && named.name !== '' ? named.name : '所选 TXT 文件'
}

const assertNotAborted = (signal: AbortSignal | undefined, filename: string): void => {
  if (signal !== undefined && signal.aborted) {
    throw new TxtParseError('cancelled', `「${filename}」解析已取消`, filename)
  }
}

/**
 * TXT 解析器对外入口（#480 全组统一契约）：manager 静态 import 这个名字。
 *
 * 入参是 `Blob`（`File` 也可，`File extends Blob`）：内部 `arrayBuffer()` 取字节再走同步核心。
 * 即使是小文件也保持 `async`，保证 manager 拿到的一律是 Promise（不出现同步抛/异步抛两种形态）。
 *
 * 失败一律 reject {@link TxtParseError}；有损解码走 `warnings`，不 reject。
 */
export const parseTxtFile = async (
  file: Blob,
  options?: ParseOptions
): Promise<ParsedTxtDocument> => {
  const filename = filenameOf(file)
  assertNotAborted(options === undefined ? undefined : options.signal, filename)
  if (options !== undefined && options.onProgress) {
    options.onProgress({ stage: 'read' })
  }
  const buffer = await file.arrayBuffer()
  assertNotAborted(options === undefined ? undefined : options.signal, filename)
  if (options !== undefined && options.onProgress) {
    options.onProgress({ stage: 'decode' })
  }
  const parsed = parseTxtBytes(new Uint8Array(buffer), filename)
  if (options !== undefined && options.onProgress) {
    options.onProgress({ stage: 'done' })
  }
  return parsed
}

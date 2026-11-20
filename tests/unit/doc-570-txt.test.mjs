// [layer: unit | dependencies: none | no build, browser, network or Android]
//
// Issue #570（母单 #480）：TXT 本地解析 —— 编码嗅探（BOM / GBK / GB18030 / BOM-less UTF-16）、
// 换行归一、以及「二进制 / 空文件 / 编码无法判定」三种情况**不许静默返回空串**。
//
//   node tests/run-layer.mjs unit --only doc-570
//
// 直接跑 `src/services/documents/txt.ts`（Node 22 原生剥类型，纯函数、无 DOM、无网络）。
// 覆盖的每一格都能对应到 #570 的关闭条件：
//   [1] UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GBK / GB18030 六种编码各自正确解码
//   [2] 换行统一 `\n`，段落空行保留，末尾多余空白行去掉
//   [3] 二进制（NUL 占比 / 控制字符占比）、空文件、编码无法判定三种异常都明确报错或警告
//   [4] meta 里的编码判定依据、字节数、行数、NUL 占比可用
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { parseTxt, TxtParseError, TXT_WARNING } = await import('../../src/services/documents/txt.ts')

const encoder = new TextEncoder()
const utf8 = (text) => encoder.encode(text)

/** 'd6d0cec4' → Uint8Array([0xd6, 0xd0, 0xce, 0xc4])；GBK / GB18030 没有内置编码器，只能手写字节 */
const hex = (source) => Uint8Array.from(source.match(/../g).map((pair) => Number.parseInt(pair, 16)))

/** 按 UTF-16 手工编码（TextEncoder 只有 UTF-8） */
const utf16 = (text, littleEndian, withBom) => {
  const body = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    const high = littleEndian ? index * 2 + 1 : index * 2
    const low = littleEndian ? index * 2 : index * 2 + 1
    body[high] = code >> 8
    body[low] = code & 0xff
  }
  if (!withBom) {
    return body
  }
  const withMarker = new Uint8Array(body.length + 2)
  if (littleEndian) {
    withMarker[0] = 0xff
    withMarker[1] = 0xfe
  } else {
    withMarker[0] = 0xfe
    withMarker[1] = 0xff
  }
  withMarker.set(body, 2)
  return withMarker
}

// ── 关闭条件 1：六种编码 ─────────────────────────────────────────────────────

test('UTF-8 无 BOM：严格解码成功，判定依据记 utf8-strict', () => {
  const parsed = parseTxt(utf8('纯文本，没有 BOM。'))
  assert.equal(parsed.text, '纯文本，没有 BOM。')
  assert.equal(parsed.meta.encoding, 'utf-8')
  assert.equal(parsed.meta.source, 'utf8-strict')
  assert.equal(parsed.meta.bom, false)
  assert.deepEqual(parsed.warnings, [])
})

test('UTF-8 BOM：识别为 utf-8、bom=true，正文不带 U+FEFF', () => {
  const parsed = parseTxt(utf8('\uFEFF第一行\n第二行'))
  assert.equal(parsed.meta.encoding, 'utf-8')
  assert.equal(parsed.meta.source, 'bom')
  assert.equal(parsed.meta.bom, true)
  assert.equal(parsed.text, '第一行\n第二行')
  assert.equal(parsed.text.includes('\uFEFF'), false)
  // byteLength 是含 BOM 的原始字节数，charLength 是归一化后的字符数
  assert.equal(parsed.meta.byteLength, utf8('\uFEFF第一行\n第二行').length)
  assert.equal(parsed.meta.charLength, '第一行\n第二行'.length)
})

test('UTF-16LE（带 BOM）：中文正确解码', () => {
  const parsed = parseTxt(utf16('中文测试\n第二段', true, true))
  assert.equal(parsed.meta.encoding, 'utf-16le')
  assert.equal(parsed.meta.source, 'bom')
  assert.equal(parsed.text, '中文测试\n第二段')
  assert.deepEqual(parsed.warnings, [])
})

test('UTF-16BE（带 BOM）：中文正确解码', () => {
  const parsed = parseTxt(utf16('中文测试\n第二段', false, true))
  assert.equal(parsed.meta.encoding, 'utf-16be')
  assert.equal(parsed.meta.source, 'bom')
  assert.equal(parsed.text, '中文测试\n第二段')
})

test('GBK（无 BOM）：按 gb18030 严格解码成功，再按字节结构报 gbk', () => {
  // 'd6d0 cec4' 是「中文」的 GBK 编码；整段只有双字节 GBK 区，所以报 gbk 而不是 gb18030
  const parsed = parseTxt(hex('d6d0cec4'))
  assert.equal(parsed.text, '中文')
  assert.equal(parsed.meta.encoding, 'gbk')
  assert.equal(parsed.meta.source, 'gb18030')
})

test('GB18030 四字节扩展区：报 gb18030，不冒充 gbk', () => {
  // 41 | 90 30 81 30（GB18030 四字节，U+10000）| 42
  const parsed = parseTxt(hex('419030813042'))
  assert.equal(parsed.text, 'A\u{10000}B')
  assert.equal(parsed.meta.encoding, 'gb18030')
  assert.equal(parsed.meta.source, 'gb18030')
})

test('无 BOM 的 UTF-16LE：按字节图样认出来并给 no-bom-utf16 警告', () => {
  const parsed = parseTxt(utf16('Hello Node 文档', true, false))
  assert.equal(parsed.meta.encoding, 'utf-16le')
  assert.equal(parsed.meta.source, 'utf16-pattern')
  assert.equal(parsed.text, 'Hello Node 文档')
  assert.deepEqual(parsed.warnings, [TXT_WARNING.noBomUtf16])
})

test('无 BOM 的 UTF-16BE：同上，并且不会被 NUL 占比误判成二进制', () => {
  const parsed = parseTxt(utf16('Hello Node 文档', false, false))
  assert.equal(parsed.meta.encoding, 'utf-16be')
  assert.equal(parsed.text, 'Hello Node 文档')
  assert.deepEqual(parsed.warnings, [TXT_WARNING.noBomUtf16])
  // 字节层面 NUL 很多（高位字节），但那是 UTF-16 的正常形态
  assert.ok(parsed.meta.nulRatio > 0.3)
})

test('UTF-32 BOM：明确报 unsupported-encoding，不硬解成乱码', () => {
  for (const bytes of [hex('fffe0000'), hex('0000feff')]) {
    assert.throws(
      () => parseTxt(bytes),
      (error) => error instanceof TxtParseError && error.code === 'unsupported-encoding',
    )
  }
})

// ── 关闭条件 2：换行与空行 ───────────────────────────────────────────────────

test('换行统一 \\n：CRLF 与单独的 CR 都转，段落空行保留', () => {
  const parsed = parseTxt(utf8('第一段\r\n\r\n第二段\r第三段\n'))
  assert.equal(parsed.text, '第一段\n\n第二段\n第三段')
  assert.equal(parsed.meta.lineCount, 4)
})

test('末尾多余空白行去掉，段内空行不动', () => {
  const parsed = parseTxt(utf8('A\n\nB\n\n\n   \n\n'))
  assert.equal(parsed.text, 'A\n\nB')
  assert.equal(parsed.text.includes('\n\n\n'), false)
})

test('缩进与行内空格原样保留（只做换行归一，不做 trim）', () => {
  const parsed = parseTxt(utf8('  缩进两格\n\tTab 开头'))
  assert.equal(parsed.text, '  缩进两格\n\tTab 开头')
})

// ── 关闭条件 3：三种异常都要明确报错或警告 ───────────────────────────────────

test('二进制文件：NUL 占比超阈值（>1%）抛 binary', () => {
  const bytes = new Uint8Array(512)
  bytes.fill(0x41)
  for (let index = 0; index < 20; index += 1) {
    bytes[index] = 0
  }
  assert.throws(
    () => parseTxt(bytes),
    (error) => error instanceof TxtParseError && error.code === 'binary',
  )
})

test('二进制文件：没有 NUL 但控制字符占比超阈值（>5%）也抛 binary', () => {
  const bytes = new Uint8Array(100).fill(0x01)
  assert.throws(
    () => parseTxt(bytes),
    (error) => error instanceof TxtParseError && error.code === 'binary',
  )
})

test('空文件（0 字节）抛 empty-file，不返回空串', () => {
  assert.throws(
    () => parseTxt(new Uint8Array(0)),
    (error) => error instanceof TxtParseError && error.code === 'empty-file',
  )
})

test('纯空白文件：text 为空但带 empty-content 警告（不是静默空串）', () => {
  const parsed = parseTxt(utf8('\n\n   \n\t\n'))
  assert.equal(parsed.text, '')
  assert.ok(parsed.warnings.includes(TXT_WARNING.emptyContent))
  assert.equal(parsed.meta.lineCount, 0)
})

test('编码无法判定：降级 UTF-8 并给 encoding-undetermined 警告', () => {
  // 0xFF 在 UTF-8 与 GB18030 里都非法 → 只能兜底
  const parsed = parseTxt(hex('41ff42'))
  assert.equal(parsed.meta.source, 'fallback')
  assert.equal(parsed.meta.encoding, 'utf-8')
  assert.ok(parsed.warnings.includes(TXT_WARNING.encodingUndetermined))
  assert.equal(parsed.text, 'A\uFFFDB')
})

test('零星 NUL（未达阈值）：剥掉并给 nul-bytes 警告，正文其余不动', () => {
  const body = `${'a'.repeat(1000)}\u0000b`
  const parsed = parseTxt(utf8(body))
  assert.equal(parsed.text, `${'a'.repeat(1000)}b`)
  assert.ok(parsed.warnings.includes(TXT_WARNING.nulBytes))
  assert.ok(parsed.meta.nulRatio > 0 && parsed.meta.nulRatio <= 0.01)
})

test('meta：byteLength / charLength / lineCount 三个口径各自独立', () => {
  const parsed = parseTxt(utf8('甲乙\n丙'))
  assert.equal(parsed.meta.byteLength, 10) // 3 个汉字 ×3 字节 + 1 个 \n
  assert.equal(parsed.meta.charLength, 4)
  assert.equal(parsed.meta.lineCount, 2)
  assert.equal(parsed.meta.nulRatio, 0)
})

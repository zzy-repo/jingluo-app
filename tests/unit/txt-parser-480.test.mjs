// [layer: unit | 依赖: 无（纯 Node：TextDecoder 走 Node 自带 ICU，无 DOM / 无网络） | 耗时: ~1s]
//
// Issue #570（母单 #480）：TXT 本地解析的**关闭条件**逐条落成断言。
//
// 为什么要单独一个文件：仓库里原本只有 `docx-parser-480.test.mjs` 和 #544 的字数口径用例，
// `txt.ts` 的六种编码与异常分支**一条用例都没有**（golden `g13` 只跑 UTF-8 的 tiny.txt）——
// #570 第 5 个 checkbox（「单测覆盖上述每一格」）在 TXT 这一半其实是空的。本文件补齐：
//
//   [1] UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GBK / GB18030 六种编码各自正确解码；
//   [2] 换行统一 `\n`、段落空行保留、行尾空白去掉（行首缩进不动）；
//   [3] 二进制（NUL / 控制字符超阈值）、空文件、编码无法判定三种情况都**明确报错或告警**，
//       不静默返回空串；另外补 UTF-32 BOM、超体积、取消三条既有分支；
//   [4] `characterCount` 与 `rawLength` 恒等（txt 不插入任何结构标记，#544 口径）。
//
// 编码夹具：UTF-8 用 `TextEncoder`，UTF-16 手写字节序，GBK / GB18030 **手写十六进制字节**
// （Node 没有 GBK 编码器；`d6d0 cec4` 是「中文」的 GBK，`90 30 81 30` 是 GB18030 四字节区的
// U+10000 —— 这两串是本文件唯一「事实性输入」，来源是 GBK/GB18030 码表，不是从实现里抄的）。
//
//   node --test tests/unit/txt-parser-480.test.mjs
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

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

const { parseTxtFile, parseTxtBytes, TxtParseError, TXT_PARSER_VERSION } = await import(
  '../../src/services/attachments/parsers/txt.ts'
)
const { ATTACHMENT_LIMITS } = await import('../../src/services/attachments/limits.ts')

const encoder = new TextEncoder()

/** `'d6d0cec4'` → Uint8Array；GBK / GB18030 没有内置编码器，只能直接写字节 */
const hex = (source) => Uint8Array.from(source.match(/../g).map((pair) => Number.parseInt(pair, 16)))

/** 按 UTF-16 手工编码（`TextEncoder` 只有 UTF-8）；`bom` 控制是否加 FF FE / FE FF */
const utf16 = (text, littleEndian, bom) => {
  const body = new Uint8Array(text.length * 2)
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (littleEndian) {
      body[index * 2] = code & 0xff
      body[index * 2 + 1] = code >> 8
    } else {
      body[index * 2] = code >> 8
      body[index * 2 + 1] = code & 0xff
    }
  }
  if (!bom) {
    return body
  }
  const withMarker = new Uint8Array(body.length + 2)
  withMarker.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff], 0)
  withMarker.set(body, 2)
  return withMarker
}

/** 带文件名地断言失败码（错误文案里带文件名，UI 直接展示，所以顺带验一下不乱码） */
const rejectsWithCode = (promiseOrBytes, code) =>
  assert.rejects(async () => {
    if (promiseOrBytes instanceof Uint8Array) {
      return parseTxtBytes(promiseOrBytes, '样本.txt')
    }
    return promiseOrBytes
  }, (error) => {
    assert.ok(error instanceof TxtParseError, `期望 TxtParseError，实际 ${error && error.name}: ${error && error.message}`)
    assert.equal(error.code, code)
    return true
  })

const parseBlob = (bytes) => parseTxtFile(new Blob([bytes]))

// ── [1] 六种编码 ───────────────────────────────────────────────────────────

test('#570 UTF-8（无 BOM）：正文一字不差，encoding = UTF-8，无告警', async () => {
  const parsed = await parseBlob(encoder.encode('纯文本，没有 BOM。'))
  assert.equal(parsed.text, '纯文本，没有 BOM。')
  assert.equal(parsed.encoding, 'UTF-8')
  assert.deepEqual(parsed.warnings, [])
  assert.equal(parsed.parserVersion, TXT_PARSER_VERSION)
})

test('#570 UTF-8 BOM：encoding = UTF-8 BOM，正文不带 U+FEFF', async () => {
  const parsed = await parseBlob(encoder.encode('\uFEFF第一行\n第二行'))
  assert.equal(parsed.encoding, 'UTF-8 BOM')
  assert.equal(parsed.text, '第一行\n第二行')
  assert.equal(parsed.text.includes('\uFEFF'), false, 'BOM 必须剥掉，不许混进正文')
})

test('#570 UTF-16LE / UTF-16BE（带 BOM）：中文正确解码，不出现替换字符', async () => {
  for (const [littleEndian, expected] of [[true, 'UTF-16LE'], [false, 'UTF-16BE']]) {
    const parsed = await parseBlob(utf16('中文测试\n第二段', littleEndian, true))
    assert.equal(parsed.encoding, expected)
    assert.equal(parsed.text, '中文测试\n第二段')
    assert.equal(parsed.text.includes('\ufffd'), false)
    assert.deepEqual(parsed.warnings, [])
  }
})

test('#570 UTF-16（无 BOM）：按字节图样认出来，不被「NUL 很多」误判成二进制', async () => {
  for (const [littleEndian, expected] of [[true, 'UTF-16LE'], [false, 'UTF-16BE']]) {
    const parsed = await parseBlob(utf16('Hello Node 文档', littleEndian, false))
    assert.equal(parsed.encoding, expected)
    assert.equal(parsed.text, 'Hello Node 文档')
  }
})

test('#570 GBK：d6d0 cec4 → 「中文」，encoding = GBK（不是 UTF-8 乱码）', async () => {
  const parsed = await parseBlob(hex('d6d0cec4'))
  assert.equal(parsed.text, '中文')
  assert.equal(parsed.encoding, 'GBK')
  assert.deepEqual(parsed.warnings, [])
})

test('#570 GB18030 四字节扩展区：encoding = GB18030，生僻字不丢、不冒充 GBK', async () => {
  // 41 | 90 30 81 30（U+10000，GB18030 四字节）| 42
  const parsed = await parseBlob(hex('419030813042'))
  assert.equal(parsed.text, 'A\u{10000}B')
  assert.equal(parsed.encoding, 'GB18030')
})

// ── [2] 换行与空行 ─────────────────────────────────────────────────────────

test('#570 换行统一为 \\n：CRLF 与单独 CR 都转，段落空行保留', async () => {
  const parsed = await parseBlob(encoder.encode('第一段\r\n\r\n第二段\r第三段\n'))
  assert.equal(parsed.text, '第一段\n\n第二段\n第三段')
  assert.equal(parsed.text.includes('\r'), false)
})

test('#570 行尾空白去掉、行首缩进保留、首尾空行去掉', async () => {
  const parsed = await parseBlob(encoder.encode('\n\n  缩进两格   \n\tTab 开头\t\n\n'))
  assert.equal(parsed.text, '  缩进两格\n\tTab 开头')
})

// ── [3] 三种「不静默」的异常 + 三条既有分支 ─────────────────────────────────

test('#570 二进制（NUL 超阈值）：抛 binary，不返回空串', async () => {
  const bytes = new Uint8Array(512).fill(0x41)
  for (let index = 0; index < 20; index += 1) {
    bytes[index] = 0
  }
  await rejectsWithCode(bytes, 'binary')
})

test('#570 二进制（无 NUL 但控制字符超阈值）：同样抛 binary', async () => {
  await rejectsWithCode(new Uint8Array(200).fill(0x01), 'binary')
})

test('#570 空文件：抛 empty（0 字节与「只有空白」两种都算）', async () => {
  await rejectsWithCode(new Uint8Array(0), 'empty')
  await rejectsWithCode(encoder.encode('\n\n   \n\t\n'), 'empty')
})

test('#570 编码无法判定：降级 UTF-8 解码并**明确告警**（不静默出乱码）', async () => {
  // 0xFF 在 UTF-8 / GBK / GB18030 里都不是合法起始字节，只能尽力解码 + 告警
  const parsed = await parseBlob(hex('41ff42'))
  assert.equal(parsed.text, 'A\ufffdB')
  assert.equal(parsed.encoding, 'UTF-8')
  assert.equal(
    (parsed.warnings ?? []).some((warning) => warning.includes('乱码')),
    true,
    `必须留下乱码告警，实际 ${JSON.stringify(parsed.warnings)}`
  )
})

test('#570 UTF-32 BOM：明确报 unsupported-encoding，不硬解成乱码', async () => {
  await rejectsWithCode(hex('fffe0000'), 'unsupported-encoding')
  await rejectsWithCode(hex('0000feff'), 'unsupported-encoding')
})

test('#570 超体积：超过 txtMaxBytes 抛 too-large，且错误里带上限（不是静默截断）', async () => {
  const oversized = new Uint8Array(ATTACHMENT_LIMITS.txtMaxBytes + 1).fill(0x41)
  // `parseTxtBytes` 是**同步**核心（同步抛错），assert.rejects 只吃 promise，所以包一层 async
  await assert.rejects(async () => parseTxtBytes(oversized, '大文件.txt'), (error) => {
    assert.equal(error.code, 'too-large')
    assert.match(error.message, /单文件上限/)
    return true
  })
})

test('#570 取消：signal 已 abort 时抛 cancelled（一个字节都不解析）', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    parseTxtFile(new Blob([encoder.encode('不该被读到')]), { signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'cancelled')
      return true
    }
  )
})

// ── [4] 字数口径（#544 的 txt 半边）─────────────────────────────────────────

test('#570 / #544 txt 不插结构标记：characterCount === rawLength === text.length', async () => {
  const parsed = await parseBlob(encoder.encode('甲乙\n丙'))
  assert.equal(parsed.text, '甲乙\n丙')
  assert.equal(parsed.characterCount, 4)
  assert.equal(parsed.rawLength, 4)
  assert.equal(parsed.characterCount, parsed.text.length)
})

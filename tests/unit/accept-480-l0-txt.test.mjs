// [layer: unit | dependencies: none | no build, browser, network or Android | 预算: ≤0.5s]
//
// #528 L0 验收：**TXT 解析器**（#522 契约）。夹具是 `tests/fixtures/480/enc/` 与 `txt/` 下的
// 真实字节文件（由 `build-fixtures.mjs` 生成，见同目录 README）。
//
// 断言分三组，对应 #528 清单：
//  A. 6 种编码各 1 行：UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GBK / GB18030（**编码标签**
//     与**正文**都要对；只对正文会让「标签写死成 UTF-8」这种实现蒙过去）；
//  B. 4 条异常分支：空 / 二进制 / 乱码（有损但可读 → warnings，不静默）/ 超限（5 MiB + 1）；
//  C. 与下游的契约面：`text` 完整不截断、`characterCount === text.length`、parserVersion 参与缓存键。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '../fixtures/480')

const { parseTxtFile, parseTxtBytes, TxtParseError } = await import(
  '../../src/services/attachments/parsers/txt.ts'
)
const { ATTACHMENT_LIMITS } = await import('../../src/services/attachments/limits.ts')

/** 夹具 → File（带 name，`parseTxtFile` 的 error 文案靠它） */
const fileOf = (relative) => {
  const bytes = readFileSync(path.join(FIXTURES, relative))
  return new File([bytes], path.basename(relative), { type: 'text/plain' })
}

/** 6 种编码的期望正文：中文部分逐字对齐，GBK/GB18030 侧用同一个解码器算期望值 */
const ENCODING_CASES = [
  { file: 'enc/utf8.txt', encoding: 'UTF-8', text: '编码样本 480 验收：第一行文本' },
  { file: 'enc/utf8-bom.txt', encoding: 'UTF-8 BOM', text: '编码样本 480 验收：第一行文本' },
  { file: 'enc/utf16le.txt', encoding: 'UTF-16LE', text: '编码样本 480 验收：第一行文本' },
  { file: 'enc/utf16be.txt', encoding: 'UTF-16BE', text: '编码样本 480 验收：第一行文本' },
  {
    file: 'enc/gbk.txt',
    encoding: 'GBK',
    text: new TextDecoder('gbk').decode(readFileSync(path.join(FIXTURES, 'enc/gbk.txt'))),
  },
  {
    file: 'enc/gb18030.txt',
    encoding: 'GB18030',
    text: new TextDecoder('gb18030').decode(
      readFileSync(path.join(FIXTURES, 'enc/gb18030.txt'))
    ),
  },
]

for (const item of ENCODING_CASES) {
  test(`[L0-TXT] ${item.file} → 识别为 ${item.encoding} 且正文逐字一致`, async () => {
    const parsed = await parseTxtFile(fileOf(item.file))
    assert.equal(parsed.encoding, item.encoding, `编码标签错了：${item.file}`)
    assert.equal(parsed.text, item.text)
    assert.equal(parsed.warnings.length, 0, `干净的样本不该有 warning：${parsed.warnings}`)
    assert.equal(parsed.characterCount, parsed.text.length)
    assert.equal(parsed.parserVersion, 'txt-1.0.0')
    // BOM 必须被剥掉：留着的话首字符是 U+FEFF，注入进上下文后上游会当成正文
    assert.notEqual(parsed.text.charCodeAt(0), 0xfeff, 'BOM 没剥干净')
  })
}

test('[L0-TXT] GBK 与 GB18030 的判定不是「都当 GBK」：四字节序列必须判成 GB18030', () => {
  // 反向断言：拿 GB18030 样本按 gbk 严格解码拿不到同样的正文（否则两个用例是同一条）
  const gb18030Bytes = readFileSync(path.join(FIXTURES, 'enc/gb18030.txt'))
  const asGbk = parseTxtBytes(new Uint8Array(gb18030Bytes), 'gb18030.txt')
  assert.equal(asGbk.encoding, 'GB18030', '含四字节序列的样本被判成了 GBK')
  assert.notEqual(
    asGbk.text.indexOf('GB18030 sample'),
    -1,
    'ASCII 前缀必须完整保留'
  )
})

test('[L0-TXT] 空文件 → TxtParseError(empty)，不返回空正文冒充成功', async () => {
  await assert.rejects(
    () => parseTxtFile(fileOf('txt/empty.txt')),
    (error) => {
      assert.ok(error instanceof TxtParseError)
      assert.equal(error.code, 'empty')
      return true
    }
  )
})

test('[L0-TXT] 二进制（含 NUL / 控制字符）→ TxtParseError(binary)', async () => {
  await assert.rejects(
    () => parseTxtFile(fileOf('txt/binary.txt')),
    (error) => {
      assert.ok(error instanceof TxtParseError)
      assert.equal(error.code, 'binary')
      return true
    }
  )
})

test('[L0-TXT] 乱码（个别非法 UTF-8 字节）→ 不抛错，正文完整 + 乱码 warning（不静默）', async () => {
  const parsed = await parseTxtFile(fileOf('txt/mojibake.txt'))
  assert.ok(parsed.text.length > 0)
  assert.ok(
    parsed.warnings.some((warning) => warning.includes('乱码')),
    `有损解码必须显式告警：${JSON.stringify(parsed.warnings)}`
  )
  // 「不静默」的反面：坏字节不能把整篇吞掉，前后可读正文都还在
  assert.ok(parsed.text.startsWith('乱码样本：'))
  assert.ok(parsed.text.endsWith('尾行'))
})

test('[L0-TXT] 超过 5 MiB 上限 → TxtParseError(too-large)，文案里带实测值与上限', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-480-txt-'))
  const oversized = path.join(dir, 'oversize.txt')
  // 上限 +1 字节就够：不必造一个真 5 MiB 文本进仓库
  const size = ATTACHMENT_LIMITS.txtMaxBytes + 1
  await writeFile(oversized, Buffer.alloc(size, 0x41))
  const bytes = readFileSync(oversized)
  await assert.rejects(
    () => parseTxtFile(new File([bytes], 'oversize.txt', { type: 'text/plain' })),
    (error) => {
      assert.ok(error instanceof TxtParseError)
      assert.equal(error.code, 'too-large')
      assert.ok(error.message.includes('5.0MB'), `文案要有实测值：${error.message}`)
      return true
    }
  )
})

test('[L0-TXT] 取消（signal 已 abort）→ TxtParseError(cancelled)，读字节前就停', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => parseTxtFile(fileOf('enc/utf8.txt'), { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof TxtParseError)
      assert.equal(error.code, 'cancelled')
      return true
    }
  )
})

test('[L0-TXT] 不改写正文：CRLF→LF 归一，但不截断、不折叠段内空格', async () => {
  const raw = '第一行 内容\r\n第二行  保留双空格\r\r第三行\n\n\n\n第四行'
  const parsed = parseTxtBytes(new Uint8Array(Buffer.from(raw, 'utf8')), 'normalize.txt')
  assert.equal(
    parsed.text,
    // 行尾空白去掉、连续空行最多留一个、首尾空行去掉；段内空格一字不动
    '第一行 内容\n第二行  保留双空格\n\n第三行\n\n第四行'
  )
})

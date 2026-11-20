// [layer: unit | dependencies: none (fflate 已是产品依赖) | 预算: ≤1s]
//
// #528 L0 验收：**DOCX 解析器**（#532 契约）。夹具是 `tests/fixtures/480/docx/` 下的真 ZIP 包
// （`build-fixtures.mjs` 生成，`unzip -l` 可见真实条目，不是内存里临时拼的）。
//
// 覆盖 #528 清单：
//  A. 结构：标题 / 段落 / 列表 / 表格 → GFM，且**按文档顺序**（反向断言「不是把所有文本节点拼起来」）；
//  B. 图片：只计数进 warnings，正文里不出现图片内部的任何东西（含 alt/关系表 target）；
//  C. 安全三闸：XXE（DOCTYPE/ENTITY 剥离、不展开外部实体）/ 路径穿越（`..` 条目 fail-closed）/
//     解压炸弹（压缩比异常直接拒绝），三条都必须**拒绝或剥离**，绝不静默继续。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const FIXTURES = path.join(HERE, '../fixtures/480/docx')

const { parseDocxFile, DocxParseError } = await import(
  '../../src/services/attachments/parsers/docx.ts'
)

const blobOf = (name) => new Blob([readFileSync(path.join(FIXTURES, name))])

test('[L0-DOCX] 标题/段落/列表/表格按文档顺序转 GFM（不是文本节点拼接）', async () => {
  const parsed = await parseDocxFile(blobOf('minimal.docx'))
  assert.equal(
    parsed.text,
    [
      '# 480 验收报告',
      '',
      '这是第一段正文，用于断言段落提取。',
      '',
      '## 1.1 小节标题',
      '',
      '- 无序列表项甲',
      '  - 无序列表项甲的子项',
      '',
      '1. 有序列表项一',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| A2 | B2 |',
      '',
      '图片之后的收尾段落。',
    ].join('\n')
  )
  // 反向断言：拼接实现会把「列一」「列二」变成同一行的普通文本，丢掉 `|` 行列关系
  assert.ok(parsed.text.includes('| 列一 | 列二 |'), '表格必须保留行列关系')
  assert.ok(parsed.text.indexOf('# 480 验收报告') < parsed.text.indexOf('- 无序列表项甲'), '阅读顺序')
})

test('[L0-DOCX] 图片被忽略：只计数进 warnings，正文里没有任何图片内容', async () => {
  const parsed = await parseDocxFile(blobOf('minimal.docx'))
  assert.ok(
    parsed.warnings.some((warning) => warning.includes('已忽略 1 张图片')),
    `图片必须显式提示被忽略：${JSON.stringify(parsed.warnings)}`
  )
  // 关系表里的 target（media/image1.png）不能漏进正文；PNG 的 base64/魔数更不能
  assert.equal(parsed.text.includes('image1.png'), false)
  assert.equal(parsed.text.includes('iVBORw0KGgo'), false)
  assert.equal(parsed.text.includes('docPr'), false)
  assert.equal(parsed.characterCount, parsed.text.length)
})

test('[L0-DOCX] XXE：DOCTYPE/ENTITY 被剥离，外部实体不展开，正文里的未知实体原样保留', async () => {
  const parsed = await parseDocxFile(blobOf('xxe.docx'))
  // 结构上不存在外部实体解析路径：/etc/passwd 的任何内容都不许出现
  assert.equal(parsed.text.includes('root:x:0:0'), false, '外部实体被展开了')
  assert.equal(parsed.text.includes('file:///etc/passwd'), false)
  // 剥离动作本身要留痕（不许静默）
  assert.ok(
    parsed.warnings.some((warning) => warning.includes('DOCTYPE')),
    `剥离声明必须告警：${JSON.stringify(parsed.warnings)}`
  )
  // 未知名实体原样保留（宁可让用户看到 &xxe;，也不要假装展开成功）
  assert.ok(parsed.text.startsWith('&xxe; '), parsed.text)
  assert.ok(parsed.text.includes('XXE 后的普通段落'), '剥离声明后正文照常提取')
})

test('[L0-DOCX] 路径穿越（条目名含 `..`）→ 整包拒绝（fail-closed），不读穿越路径下的内容', async () => {
  // 这一包里同时有正常主文档和 `../../../../etc/passwd`，还藏了一份「穿越路径下的假主文档」
  const error = await parseDocxFile(blobOf('path-traversal.docx')).then(
    () => assert.fail('含路径穿越条目的包必须被拒绝'),
    (caught) => caught
  )
  assert.ok(error instanceof DocxParseError, `应抛 DocxParseError，实际：${error}`)
  assert.equal(error.code, 'corrupt_archive')
  assert.ok(error.message.includes('已拒绝解析'), error.message)

  // 反向断言：如果哪天实现改成「按文件名后缀找主文档」，traversal-only 就会被当成合法文档——
  // 这一包只有穿越路径下的 document.xml，必须同样拒绝，而不是偷偷解析出「只有穿越路径的主文档」
  const onlyTraversal = await parseDocxFile(blobOf('traversal-only.docx')).then(
    () => assert.fail('只有穿越路径主文档的包必须被拒绝'),
    (caught) => caught
  )
  assert.ok(onlyTraversal instanceof DocxParseError)
  assert.equal(onlyTraversal.code, 'corrupt_archive')
})

test('[L0-DOCX] 解压炸弹（40 MiB 零字节，压缩比 ~1000:1）→ 拒绝解析', async () => {
  const error = await parseDocxFile(blobOf('zip-bomb.docx')).then(
    () => assert.fail('炸弹包必须被拒绝'),
    (caught) => caught
  )
  assert.ok(error instanceof DocxParseError, `应抛 DocxParseError，实际：${error}`)
  assert.equal(error.code, 'corrupt_archive')
  assert.ok(/炸弹|压缩比/.test(error.message), `文案要点明是炸弹/压缩比：${error.message}`)
})

test('[L0-DOCX] 非 ZIP 与空文件 → 各自的 code，不静默返回空正文', async () => {
  const notZip = await parseDocxFile(new Blob([new Uint8Array([1, 2, 3, 4, 5])])).then(
    () => assert.fail('非 ZIP 必须拒绝'),
    (caught) => caught
  )
  assert.equal(notZip.code, 'not_docx')
  assert.ok(notZip.message.includes('.doc'), '要提示旧版 .doc 该另存为 docx')

  const empty = await parseDocxFile(new Blob([])).then(
    () => assert.fail('空文件必须拒绝'),
    (caught) => caught
  )
  assert.equal(empty.code, 'empty')
})

test('[L0-DOCX] 取消（解析中途 abort）→ aborted，不产出半份文档', async () => {
  const controller = new AbortController()
  await assert.rejects(
    () =>
      parseDocxFile(blobOf('minimal.docx'), {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.stage === 'unzip') {
            controller.abort()
          }
        },
      }),
    (error) => {
      assert.equal(error.code, 'aborted')
      return true
    }
  )
})

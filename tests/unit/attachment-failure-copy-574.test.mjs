// [layer: unit | 依赖: fake-indexeddb（只为 import 真 manager，纯 Node 内存实现） | 耗时: <3s]
//
// Issue #574：附件失败面板**按码给文案**。缺口是「码在到达界面之前就丢了」：
//
//   解析器抛 `PdfParseError(code, message)` → manager 的 `describeError()` 只留 `message`
//   → `viewModel.failureOf()` 按 `码: 人话` 找表，找不不到码 → 落 `attachFailUnknown`
//   → 界面上「扫描版 PDF」「页数超限」显示成「解析过程中出现了未知问题」，
//     真正的成因被降级成「技术信息」。
//
// 本文件把这个缺口钉成回归基线（**表驱动，每行一个码**）：
//
//   [1] 全量映射：`PdfParseErrorCode`（从源码里读联合类型，解析器以后加码这里立刻红）
//       + manager 的 7 个 `AttachmentError.reason`，每个码都有一行 → 一个文案 key；
//   [2] 核心断言：**已知码一个都不许落 `attachFailUnknown` / `attachFailUnknown` 兜底**；
//   [3] 码不丢：`manager.describeAttachmentError(PdfParseError)` 的输出必须以码开头，
//       且这条输出喂给 `failureOf()` 能直接得到那句人话（端到端的那一段链）；
//   [4] zh / en 成对：同一个码两种语言的标题都非空、en 里不出现中文、占位符全部填上
//       （`{pages}` / `{limit}` 不许原样端给用户）；
//   [5] 技术信息不删：`failureOf().raw` 仍是解析器原文（排障依据）；
//   [6] 解析超时按 #571 的语义**不是**失败码（partial + warning），所以它没有
//       `parseTimeout` 码 —— 这条也钉住：那个数字（已提取 N/M 页）作为 warning 原样展示。
//
// 负向对照（本单要求）：删掉 `viewModel.ts` 里任意一条映射 → 对应用例立刻红
// （`ATTACHMENT_FAILURE_KEYS` 是 `Record<AttachmentErrorReason, …>`，删了 `npx tsc` 也先红）；
// 文件末尾还有一条**自动化**负向对照：把表里某一行挖掉，探测器必须点名那个码。
//
//   node --test --import ./tests/helpers/injected.mjs tests/unit/attachment-failure-copy-574.test.mjs
import 'fake-indexeddb/auto'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ROOT, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'

installTsResolve()

const pdf = await loadTsModule('src/services/attachments/parsers/pdf.ts')
const manager = await loadTsModule('src/services/attachments/manager.ts')
const viewModel = await loadTsModule('src/components/attachments/viewModel.ts')
const limits = await loadTsModule('src/services/attachments/limits.ts')
const { zh } = await loadTsModule('src/i18n/zh.ts')
const { en } = await loadTsModule('src/i18n/en.ts')

const readSrc = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

/**
 * 与 `src/i18n/index.ts` 的 `fill()` 同一条填充规则（`{name}` → 参数）。
 * 这里不复用那份实现：它会把 `useSettings`（zustand）拖进 L0 进程，而本文件要验的只是
 * 「这个码最终给用户看的那句话」，填充规则三条正则足够。
 */
const fill = (template, params) =>
  template.replace(/\{(\w+)\}/g, (placeholder, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })

/** 两种语言的 `t()`：直接查表 + 填充（缺 key 就抛出，免得「空字符串也算过」） */
const translator = (table) => (key, params) => {
  const template = table[key]
  assert.equal(typeof template, 'string', `文案表里没有 key \`${key}\``)
  return fill(template, params)
}
const tZh = translator(zh)
const tEn = translator(en)

/** 一条 `failed` 的视图模型（面板只读这么几个字段，其余给中性值） */
const failedView = (errorMessage) => ({
  id: 'att-574',
  filename: '样本.pdf',
  size: 1024,
  status: 'failed',
  progress: null,
  warnings: [],
  injectionWarnings: [],
  ...(errorMessage === undefined ? {} : { errorMessage }),
})

const failureOf = (errorMessage, t) => viewModel.failureOf(failedView(errorMessage), t)

// ---------------------------------------------------------------- 表：每行一个码
//
// `message` 取自解析器/管理器的**真实**文案（函数里的模板字面量），不是随手编的：
// 这条链的下一环（manager 的 `码: 人话`）就是把它原样拼上去的。
//
// `zh` / `en` 是用户最终看到的**标题**（人话 + 出路），逐字写死 —— 改文案必须改这里，
// 免得「文案被换成了另一个兜底句」还能绿。
const PDF_MAX_PAGES = limits.ATTACHMENT_LIMITS.pdfMaxPages

const CODES = [
  {
    code: 'noTextLayer',
    message: pdf.PDF_NO_TEXT_LAYER_MESSAGE,
    key: 'attachPdfErrNoTextLayer',
    route: true,
    zh: '该 PDF 未检测到可提取的文本，暂不支持扫描版 PDF，请上传包含文本层的 PDF 文件',
    en: 'This PDF has no extractable text. Scanned PDFs are not supported yet, so please upload a PDF with a text layer',
  },
  {
    code: 'tooManyPages',
    message: `该 PDF 有 800 页，超过 ${PDF_MAX_PAGES} 页上限，请拆分后再上传`,
    key: 'attachPdfErrTooManyPages',
    route: true,
    zh: `PDF 共 800 页，超过上限 ${PDF_MAX_PAGES} 页，请拆分后再上传`,
    en: `This PDF has 800 pages, over the ${PDF_MAX_PAGES}-page limit. Split it and upload again`,
  },
  {
    code: 'encryptedPdf',
    message: '不支持加密 PDF',
    key: 'attachPdfErrEncrypted',
    route: true,
    zh: '不支持加密 PDF，请先解除密码保护后再上传',
    en: 'Encrypted PDFs are not supported yet. Remove the password protection and upload again',
  },
  {
    code: 'notPdfFile',
    message: '文件内容不是有效的 PDF（缺少 %PDF- 文件头）',
    key: 'attachPdfErrNotPdf',
    route: true,
    zh: '这个文件不是有效的 PDF（内容与扩展名对不上），请确认文件后重新上传',
    en: 'This file is not a valid PDF (its content does not match the extension). Check the file and upload again',
  },
  {
    code: 'fileTooLarge',
    message: 'PDF 文件超过 50 MiB 上限',
    key: 'attachPdfErrFileTooLarge',
    route: true,
    zh: 'PDF 超过该类型的体积上限，请压缩或拆分后再上传',
    en: 'This PDF is over the size limit for its type. Compress or split it and upload again',
  },
  {
    code: 'libUnavailable',
    message: 'PDF 解析组件加载失败，请重试',
    key: 'attachPdfErrLibUnavailable',
    route: true,
    zh: 'PDF 解析组件没有加载成功，请重试；反复失败请检查网络后刷新页面',
    en: 'The PDF parser component failed to load. Try again; if it keeps failing, check your network and reload the page',
  },
  {
    code: 'openFailed',
    message: 'PDF 打开失败，文件可能已损坏',
    key: 'attachPdfErrOpenFailed',
    route: true,
    zh: 'PDF 打不开，文件可能已损坏，请重新导出后再上传',
    en: 'This PDF cannot be opened — the file may be corrupt. Export it again and upload',
  },
  // manager 的 `AttachmentError.reason`（同一张表、同一个命名空间；#574 之前它们是对的，
  // 列在这里是为了「全量映射」真的全量 —— 也是下面「不许落兜底」断言的覆盖面）
  {
    code: 'too-large',
    message: 'attachment is too large',
    key: 'attachFailTooLarge',
    route: true,
    zh: '文件超过该类型的大小上限，请压缩或拆分后重新上传',
    en: 'The file is over the size limit for its type. Compress or split it and upload again',
  },
  {
    code: 'unsupported-format',
    message: 'unsupported attachment format: .xls',
    key: 'attachFailUnsupportedFormat',
    zh: '文件类型不受支持（当前仅支持 TXT、DOCX、PDF）',
    en: 'Unsupported file type (only TXT, DOCX and PDF are supported)',
  },
  {
    code: 'mime-mismatch',
    message: 'attachment mime text/html does not match .pdf',
    key: 'attachFailMimeMismatch',
    zh: '文件内容与扩展名不一致，可能被改过扩展名',
    en: 'The file content does not match its extension; it may have been renamed',
  },
  {
    code: 'empty-file',
    message: 'attachment is empty',
    key: 'attachFailEmpty',
    zh: '文件为空，没有可解析的内容',
    en: 'The file is empty, so there is nothing to parse',
  },
  {
    code: 'not-found',
    message: 'attachment att-574 not found',
    key: 'attachFailNotFound',
    zh: '找不到这条附件记录，请重新添加',
    en: 'This attachment record no longer exists. Add the file again',
  },
  {
    code: 'source-missing',
    message: 'attachment source is no longer in local storage',
    key: 'attachFailSourceMissing',
    zh: '本地原件已不存在，请重新添加该文件',
    en: 'The local copy is gone. Add the file again',
  },
  {
    code: 'no-parser',
    message: 'no parser registered for .pdf',
    key: 'attachFailNoParser',
    zh: '该格式的解析器尚未就绪，暂时无法解析',
    en: 'The parser for this format is not ready yet, so it cannot be parsed',
  },
]

/** 源码里的 `PdfParseErrorCode` 联合成员（解析器以后加码而这里没补 → 下面的用例红） */
const pdfCodesInSource = () => {
  const source = readSrc('src/services/attachments/parsers/pdf.ts')
  const block = /export type PdfParseErrorCode =([\s\S]*?)\n\n/u.exec(source)
  assert.ok(block !== null, 'pdf.ts 里找不到 `PdfParseErrorCode` 联合类型（名字改了就更新本用例）')
  return Array.from(block[1].matchAll(/'([A-Za-z]+)'/g)).map((match) => match[1])
}

/** 与 `failureOf()` 同一条查表规则：返回会落到兜底标题的码（空数组 = 全量映射成立） */
const codesFallingBack = (keys, codes) =>
  codes.filter((code) => keys[code] === undefined || keys[code] === 'attachFailUnknown')

// ---------------------------------------------------------------- [1] 全量映射
test('每个已知码都有独立文案 key（表驱动，每行一个码）', () => {
  for (const row of CODES) {
    assert.equal(
      viewModel.ATTACHMENT_FAILURE_KEYS[row.code],
      row.key,
      `码 \`${row.code}\` 映射到了 \`${viewModel.ATTACHMENT_FAILURE_KEYS[row.code]}\`，期望 \`${row.key}\``
    )
  }
})

test('PdfParseErrorCode 联合里的每个码都在表里（解析器加码而映射没跟上就红）', () => {
  const codes = pdfCodesInSource()
  assert.ok(codes.length >= 7, `从源码解析出的 PDF 码只有 ${codes.length} 个：${codes.join(', ')}`)
  for (const code of codes) {
    assert.ok(
      CODES.some((row) => row.code === code),
      `解析器新增了码 \`${code}\`，本表（以及 viewModel 的映射）没跟上`
    )
    assert.notEqual(
      viewModel.ATTACHMENT_FAILURE_KEYS[code],
      undefined,
      `码 \`${code}\` 在 ATTACHMENT_FAILURE_KEYS 里没有条目`
    )
  }
  // 反向：表里的 PDF 码不许是源码里不存在的（防止本用例自称覆盖了某个已删的码）
  const pdfRows = CODES.filter((row) => codes.includes(row.code)).map((row) => row.code)
  assert.deepEqual([...pdfRows].sort(), [...codes].sort())
})

// ---------------------------------------------------------------- [2] 核心回归：不落兜底
test('已知码一个都不许落「未知问题」兜底（本单核心断言）', () => {
  const allCodes = CODES.map((row) => row.code)
  assert.deepEqual(codesFallingBack(viewModel.ATTACHMENT_FAILURE_KEYS, allCodes), [])
})

test('用户看到的是那句人话，而不是兜底标题（逐码核对标题与「技术信息」）', () => {
  for (const row of CODES) {
    const result = failureOf(`${row.code}: ${row.message}`, tZh)
    assert.equal(result.title, row.zh, `码 \`${row.code}\` 的标题不对`)
    assert.notEqual(result.title, zh.attachFailUnknown, `码 \`${row.code}\` 落到了「未知问题」兜底`)
    // 「说人话 + 给出路」（issue §5.3 / 关闭条件 3）：这些成因的标题里必须有一句下一步动作
    if (row.route === true) {
      assert.match(
        result.title,
        /(上传|拆分|重试|刷新页面|重新添加|重新导出)/u,
        `码 \`${row.code}\` 的标题没给出路：${result.title}`
      )
    }
    // [5] 技术信息原样保留（排障依据），不是被标题吃掉
    assert.equal(result.raw, row.message, `码 \`${row.code}\` 的技术信息被改写了`)
  }
})

test('真正不认识的码才落兜底（兜底只留给未知）', () => {
  const result = failureOf('someFutureCode: 来自更新版本解析器的原始报错', tZh)
  assert.equal(result.title, zh.attachFailUnknown)
  assert.equal(result.raw, '来自更新版本解析器的原始报错')
})

test('没有 errorMessage 时仍是兜底标题（失败卡片不会空白）', () => {
  assert.equal(failureOf(undefined, tZh).title, zh.attachFailUnknown)
})

// ---------------------------------------------------------------- [3] 码不丢（真实链路）
test('manager 的失败原文以码开头 —— PdfParseError.code 不再被吞掉', () => {
  for (const row of CODES.filter((item) => pdfCodesInSource().includes(item.code))) {
    const described = manager.describeAttachmentError(new pdf.PdfParseError(row.code, row.message))
    assert.equal(described, `${row.code}: ${row.message}`, `码 \`${row.code}\` 在 manager 这一层丢了`)
    // 这条原文就是落库 / 进视图的 `errorMessage`：直接喂给面板 → 拿到那句人话
    assert.equal(failureOf(described, tZh).title, row.zh)
  }
})

test('真实抛出的硬失败也带得住码（体积 / 文件头 / 加密三条真实入口）', () => {
  const cases = [
    ['fileTooLarge', () => pdf.assertPdfSize(limits.ATTACHMENT_LIMITS.pdfMaxBytes + 1)],
    ['notPdfFile', () => pdf.assertPdfAcceptable(new Uint8Array([0x68, 0x69]), 2)],
    [
      'encryptedPdf',
      () =>
        pdf.assertPdfAcceptable(
          // `%PDF-` 头 + `/Encrypt` 字典标记 —— 解析器判定加密 PDF 用的就是这两个字节序列
          new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]),
          13
        ),
    ],
  ]
  for (const [code, run] of cases) {
    let thrown
    try {
      run()
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown !== undefined, `\`${code}\` 这条入口没有抛错`)
    assert.equal(thrown.code, code, `抛出的码不对：${String(thrown.code)}`)
    const described = manager.describeAttachmentError(thrown)
    assert.ok(described.startsWith(`${code}: `), `manager 把码吞了：${described}`)
    const title = failureOf(described, tZh).title
    assert.equal(title, CODES.find((row) => row.code === code).zh)
    assert.notEqual(title, zh.attachFailUnknown)
  }
})

// ---------------------------------------------------------------- [4] zh / en 成对
test('同一个码在中英两种语言下都有自己的文案（en 不出现中文、占位符都填上）', () => {
  for (const row of CODES) {
    const zhTitle = failureOf(`${row.code}: ${row.message}`, tZh).title
    const enTitle = failureOf(`${row.code}: ${row.message}`, tEn).title
    assert.equal(zhTitle, row.zh, `码 \`${row.code}\` 的中文标题不对`)
    assert.equal(enTitle, row.en, `码 \`${row.code}\` 的英文标题不对`)
    assert.doesNotMatch(enTitle, /[\u4e00-\u9fff]/u, `码 \`${row.code}\` 的英文文案里混进了中文：${enTitle}`)
    assert.doesNotMatch(zhTitle, /\{\w+\}/u, `码 \`${row.code}\` 的中文文案有没填上的占位符：${zhTitle}`)
    assert.doesNotMatch(enTitle, /\{\w+\}/u, `码 \`${row.code}\` 的英文文案有没填上的占位符：${enTitle}`)
  }
})

test('页数取不到时退化成不带数字的那句（不猜、不写 0 页）', () => {
  const title = failureOf('tooManyPages: 页数太多', tZh).title
  assert.equal(title, fill(zh.attachPdfErrTooManyPagesPlain, { limit: PDF_MAX_PAGES }))
  assert.doesNotMatch(title, /\{\w+\}/u)
  assert.doesNotMatch(title, /undefined|NaN|\{\w+\}/u)
})

// ---------------------------------------------------------------- [6] 解析超时不是失败码
test('解析超时按 #571 语义走 partial + warning，不新增失败码', () => {
  assert.ok(
    !pdfCodesInSource().includes('parseTimeout'),
    'PDF 码里出现了 `parseTimeout`：超时是 partial + warnings，不是失败态（#571），改这条要另开单'
  )
  // 超时那句话由解析器产出，原样进 warnings —— 它在卡片/面板上仍然看得见
  const timeoutWarning = '解析超时，已提取 3/12 页'
  const partialView = {
    ...failedView('parseTimeout: x'),
    status: 'partial',
    warnings: [timeoutWarning],
    totalPages: 12,
    extractedPages: 3,
  }
  assert.ok(
    viewModel.attachmentWarnings(partialView, tZh).includes(timeoutWarning),
    '超时告警没有原样出现在 warnings 里（用户在界面上就看不到「超时」了）'
  )
  assert.equal(viewModel.statusLine(partialView, tZh), fill(zh.attachStatusPartial, { count: 1 }))
})

// ---------------------------------------------------------------- 负向对照（自动化）
test('负向对照：把映射删掉一条，探测器必须点名那个码', () => {
  const allCodes = CODES.map((row) => row.code)
  const without = { ...viewModel.ATTACHMENT_FAILURE_KEYS }
  delete without.noTextLayer
  assert.deepEqual(codesFallingBack(without, allCodes), ['noTextLayer'])

  const degraded = { ...viewModel.ATTACHMENT_FAILURE_KEYS, tooManyPages: 'attachFailUnknown' }
  assert.deepEqual(codesFallingBack(degraded, allCodes), ['tooManyPages'])
})

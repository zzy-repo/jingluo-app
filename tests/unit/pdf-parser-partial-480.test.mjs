// [layer: unit | 依赖: 无（桩 pdfjs，不加载 2 MB 产物、不碰真文件） | 耗时: ~1s]
//
// Issue #571 关闭条件 4：「部分页失败的 PDF 如实返回 partial + 受影响页码，不当作完整文档」。
// 这一条**没法用真 PDF 测**：正常 PDF 里造「第 2 页炸了」很难稳定（pdfjs 对坏内容流相当宽容 ——
// 把 `/Contents` 指到不存在的对象、给内容流塞坏 Flate 数据，它都只是取到空字符串，不抛错，
// 已在探针里逐种验过）。所以这里注入一个**桩 pdfjs**：同一个 `window.pdfjsLib` 入口、同样的
// `getDocument / getPage / getTextContent` 形状，只让指定的页 reject 或永不返回。
//
// 另外两条同源用例：
//   · 卡住的页（`getTextContent` 永不 resolve）→ 超时必须**真的**把它放掉（`Promise.race`），
//     否则本文件会挂在这里 —— 这就是超时实现的负向对照；
//   · `outcomeOf()`（manager 的落库判定）把「缺页」「有 warnings」映射成 `status: 'partial'`，
//     保证解析器的 partial 结论不会在落库时被当成 success（#480 §5.3 的硬要求）。
//
//   node --test tests/unit/pdf-parser-partial-480.test.mjs
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

/** 一页正文，故意超过「无文本层」阈值（否则这批用例会被判成扫描件，那是另一条判定） */
const pageBody = (pageNumber) =>
  `第 ${pageNumber} 页正文：桩数据，用来验证页码对齐与部分失败的合并语义，字符数要超过无文本层阈值。`

/**
 * 桩文档：只实现 `parsePdfFile` 真正用到的成员（`numPages` / `getPage` / `destroy`），
 * `calls` 记录翻页顺序与 destroy —— 「取消之后有没有继续读页」靠它判。
 */
const stubDocument = (options) => {
  const pages = options.pages
  const failOn = options.failOn === undefined ? [] : options.failOn
  const hangOn = options.hangOn === undefined ? null : options.hangOn
  const calls = []
  return {
    calls,
    numPages: pages,
    getPage(pageNumber) {
      calls.push(pageNumber)
      if (pageNumber === hangOn) {
        // 永不 settle：只有真的中断（race 抢跑 / worker destroy）才能让用例结束
        return new Promise(() => undefined)
      }
      if (failOn.indexOf(pageNumber) >= 0) {
        return Promise.reject(new Error(`第 ${pageNumber} 页内容流损坏`))
      }
      return Promise.resolve({
        getTextContent: async () => ({ items: [{ str: pageBody(pageNumber), hasEOL: true }] }),
        cleanup() {},
      })
    },
    destroy() {
      calls.push('destroy')
      return Promise.resolve()
    },
  }
}

// 必须在 import pdf.ts 之前挂上：`loadPdfJs()` 只在第一次调用时读全局（单飞缓存）
const pending = []
globalThis.window = {
  pdfjsLib: {
    version: '2.16.105-stub',
    getDocument: () => ({ promise: Promise.resolve(pending.shift()), destroy: () => Promise.resolve() }),
    GlobalWorkerOptions: {},
  },
}

const { parsePdfFile } = await import('../../src/services/attachments/parsers/pdf.ts')
const { outcomeOf } = await import('../../src/services/attachments/manager.ts')

/**
 * 每次解析用它自己的桩文档：`loadPdfJs` 缓存的是**库对象**，`getDocument()` 每次现取一份文档。
 * 返回 `{ parsed, stub }` —— `stub.calls` 记着翻页顺序与 destroy，是「取消/超时之后有没有
 * 继续读页」的唯一证据。
 */
const parseWith = async (options, parseOptions) => {
  const stub = stubDocument(options)
  pending.push(stub)
  const parsed = await parsePdfFile(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])]), parseOptions)
  return { parsed, stub }
}

test('#571 部分页失败：失败页不占位、不伪造页标记，extractedPages < pages 且 warnings 点名页码', async () => {
  const { parsed } = await parseWith({ pages: 3, failOn: [2] })

  assert.equal(parsed.pages, 3)
  assert.equal(parsed.extractedPages, 2, '失败页不占 extractedPages')
  assert.deepEqual(parsed.pageChars, [pageBody(1).length, 0, pageBody(3).length], '失败页在 pageChars 里记 0（页码仍对齐）')
  assert.equal(parsed.characterCount, pageBody(1).length + pageBody(3).length)
  assert.equal(parsed.text, `[第1页]\n${pageBody(1)}\n[第3页]\n${pageBody(3)}`)
  assert.equal(parsed.text.includes('[第2页]'), false, '失败页不许编造空标记（否则看起来像完整文档）')
  assert.deepEqual(parsed.warnings, ['第 2 页提取失败'])
})

test('#571 部分页失败落库口径：outcomeOf 把「缺页」判成 partial，不冒充 success', () => {
  const partialOutcome = outcomeOf({
    text: '正文',
    characterCount: 2,
    rawLength: 2,
    pages: 3,
    extractedPages: 2,
    pageChars: [2, 0, 0],
    warnings: ['第 2 页提取失败'],
    parserVersion: 'stub',
  })
  assert.equal(partialOutcome.status, 'partial')
  assert.equal(partialOutcome.totalPages, 3)
  assert.equal(partialOutcome.extractedPages, 2)

  // 只有「页数齐 + 无 warnings」才是 success；有 warnings（如取消/超时）也算 partial
  const complete = outcomeOf({
    text: '正文',
    characterCount: 2,
    rawLength: 2,
    pages: 3,
    extractedPages: 3,
    pageChars: [1, 1, 0],
    parserVersion: 'stub',
  })
  assert.equal(complete.status, 'success', '页数齐且无 warnings 才算完整')

  const warned = outcomeOf({
    text: '正文',
    characterCount: 2,
    rawLength: 2,
    pages: 3,
    extractedPages: 3,
    pageChars: [1, 1, 0],
    warnings: ['已取消'],
    parserVersion: 'stub',
  })
  assert.equal(warned.status, 'partial', '带 warnings 一律 partial')

  // txt / docx 没有 pages：只按 warnings 判，不许因为「没有页数」就降级
  const noPages = outcomeOf({ text: 'abc', characterCount: 3, rawLength: 3, parserVersion: 'stub' })
  assert.equal(noPages.status, 'success')
})

test('#571 卡住的页：超时真的中断，不把整篇提取拖死（负向对照）', async () => {
  const startedAt = Date.now()
  const { parsed, stub } = await parseWith({ pages: 3, hangOn: 2 }, { timeoutMs: 200 })
  const elapsed = Date.now() - startedAt

  // 第 2 页永不返回：若超时没生效，这条断言会挂住（而不是失败）—— 正因如此才写成「必须 < 5s」
  assert.ok(elapsed < 5000, `超时没有真正生效，实际 ${elapsed} ms`)
  assert.equal(parsed.pages, 3)
  assert.equal(parsed.extractedPages, 1, '第 1 页读到了，卡住的第 2 页不算提取成功')
  assert.deepEqual(parsed.pageChars, [pageBody(1).length, 0, 0])
  assert.ok(
    (parsed.warnings ?? []).some((warning) => warning.includes('第 2 页提取失败')),
    `warnings 要点名卡住的页，实际 ${JSON.stringify(parsed.warnings)}`
  )
  assert.ok(
    (parsed.warnings ?? []).some((warning) => warning.includes('解析超时')),
    `warnings 也要写明超时，实际 ${JSON.stringify(parsed.warnings)}`
  )
  assert.equal(stub.calls.indexOf(3), -1, '卡住之后不再继续翻页')
  assert.equal(stub.calls[stub.calls.length - 1], 'destroy', '超时路径必须销毁 worker')
})

test('#571 单页失败但仍有文本层：不因某一页坏了就判成「扫描版 PDF」', async () => {
  const { parsed } = await parseWith({ pages: 2, failOn: [1] })
  assert.equal(parsed.extractedPages, 1)
  assert.equal(parsed.text, `[第2页]\n${pageBody(2)}`)
  // 判「无文本层」用的是「实际读到的页」的平均值：1 页正常文本 ≫ 阈值，所以不抛 noTextLayer
  assert.equal(outcomeOf(parsed).status, 'partial')
})

test('#571 全部页都失败：落 failed（抛 openFailed），不返回空文档当成功', async () => {
  await assert.rejects(parseWith({ pages: 2, failOn: [1, 2] }).then(({ parsed }) => parsed), (error) => {
    assert.equal(error.code, 'openFailed')
    return true
  })
})

// 兜底自检：桩本身可用（否则上面几条全都会因「桩坏了」而不是「产品坏了」变红）
test('#571 桩自检：正常桩文档能拿到全部页', async () => {
  const { parsed } = await parseWith({ pages: 3 })
  assert.equal(parsed.extractedPages, 3)
  assert.equal(parsed.warnings, undefined)
})

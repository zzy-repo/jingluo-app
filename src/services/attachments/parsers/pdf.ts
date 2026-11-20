/**
 * PDF 文本解析（Issue #480）：**只处理有文本层的 PDF**。
 *
 * 契约（lead 定，全组一致）：`parsePdfFile(file: Blob, options?: ParseOptions): Promise<ParsedDocument>`
 * - 入参是 Blob（内部 `arrayBuffer()` 交给 pdfjs），不是原始字节数组：附件存的是 Blob；
 * - 限制值全部来自 `../limits.js`（`pdfMaxBytes` / `pdfMaxPages` / `pdfMinCharsPerPage` / `pdfTimeoutMs`），
 *   本文件不写阈值；
 * - 逐页输出格式与 #480 正文一致：
 *
 *   ```
 *   [第1页]
 *   正文……
 *   [第2页]
 *   正文……
 *   ```
 *
 * ## 失败怎么表达（重要）
 *
 * `ParsedDocument`（`../types.ts`）只有 text / characterCount / rawLength / pages / extractedPages /
 * pageChars / warnings，**没有 status 字段**，所以「硬失败」只能靠**抛 `PdfParseError`**
 * （带 `code` + 中文 `message`），由 manager 落成 `status: 'failed'` + `errorMessage`：
 *
 * | code | 触发条件 | message |
 * | --- | --- | --- |
 * | `fileTooLarge` | 超过 `pdfMaxBytes`（50 MiB） | PDF 文件超过 50 MiB 上限 |
 * | `notPdfFile` | 缺 `%PDF-` 文件头 / 空文件 | 文件内容不是有效的 PDF… |
 * | `encryptedPdf` | 字节里有 `/Encrypt`，或 pdfjs 抛 PasswordException | 不支持加密 PDF |
 * | `tooManyPages` | 页数超过 `pdfMaxPages`（500） | 该 PDF 有 N 页，超过 500 页上限… |
 * | `noTextLayer` | 平均每页可提取字符数 < `pdfMinCharsPerPage`（20） | 该 PDF 未检测到可提取的文本… |
 * | `libUnavailable` | pdfjs 经典脚本加载失败 | PDF 解析组件加载失败，请重试 |
 * | `openFailed` | pdfjs 打不开 / 全部页提取失败 | PDF 打开失败，文件可能已损坏 |
 *
 * 「部分成功」**不抛错**，而是在返回值里同时给出 `warnings` + `extractedPages < pages`：
 * 调用方必须按 `extractedPages` 与 `warnings` 展示 `status: 'partial'`。
 * **不允许**把 `extractedPages < pages` 的结果当完整文档（#480 第 5.3 节的硬要求）。
 *
 * ## 已知边界（不在本单范围）
 *
 * - 扫描版 PDF / OCR：不打分、不兜底，直接 `noTextLayer`；
 * - 取消 / 超时的粒度是**页**：pdfjs 的 `getTextContent()` 单页内不可中断（超时用 `Promise.race`
 *   抢跑，随后 `document.destroy()` 终止 worker，卡住的那一页放弃）；
 * - 版面判读只到「行」这一层（见 pdfLayout.ts）：双栏 PDF 的行序可能交错；
 * - `/Encrypt` 是**字节扫描**（PDF 加密字典的名字就长这样），理论上正文流里出现同一串字节会误判；
 *   真加密的 PDF 无论如何都解不开，所以宁严不宽；
 * - **随包带 `cmaps/`（1.7 MB）但不带 `standard_fonts/`（0.87 MB）**：CJK 的预定义 CMap 缺了
 *   直接取不到中文，必须带；standard fonts 只影响 base-14 字体（Helvetica/Times…）的字形回退，
 *   实测取文本不依赖它（pdfjs 只会打一条 fetchStandardFontData 警告），先省这 0.87 MB。
 *   若后续出现「有文本层但提取出来是空/乱码」的真实案例，再把它加进 `config/pdfjs.json` 拷进来。
 */
import { recordError } from '../../diagnostics/collector.js'
import { ATTACHMENT_LIMITS } from '../limits.js'
import type { ParsedDocument, ParseOptions } from '../types.js'
import {
  PDFJS_ASSET,
  PDFJS_VERSION,
  loadPdfJs,
  pdfAssetUrl,
  type PdfDocumentProxy,
  type PdfJsLib,
} from './pdfLoader.js'
import { textItemsToLines } from './pdfLayout.js'

/**
 * 解析器版本：pdfjs 版本 + 本文件的解析逻辑版本（2），一起进缓存去重键。
 *
 * - `1` → `2`（#544）：`ParsedDocument.characterCount` 从「实现自定」改成**正文口径**，
 *   缓存里 `StoredAttachmentText.characterCount` 的口径也跟着变；不升版本会让老记录继续命中
 *   旧口径的缓存全文记录，同一份 PDF 在「首次解析」与「缓存命中」两条路径上给出不同字数。
 */
export const PDF_PARSER_VERSION = `pdfjs-${PDFJS_VERSION}-2`

/** 硬失败的错误码，见文件头的表 */
export type PdfParseErrorCode =
  | 'fileTooLarge'
  | 'notPdfFile'
  | 'encryptedPdf'
  | 'tooManyPages'
  | 'noTextLayer'
  | 'libUnavailable'
  | 'openFailed'

/** 硬失败：`message` 是可以直接展示给用户的中文文案（短、无文档内容） */
export class PdfParseError extends Error {
  readonly code: PdfParseErrorCode

  constructor(code: PdfParseErrorCode, message: string) {
    super(message)
    this.name = 'PdfParseError'
    this.code = code
  }
}

/** 判断某个异常是不是本模块的硬失败（manager 用它挑 errorMessage） */
export const isPdfParseError = (error: unknown): error is PdfParseError =>
  error instanceof PdfParseError

/** 无文本层提示文案（#480 第 5.3 节原文，别改字） */
export const PDF_NO_TEXT_LAYER_MESSAGE =
  '该 PDF 未检测到可提取的文本，暂不支持扫描版 PDF，请上传包含文本层的 PDF 文件'

/** `%PDF-`：PDF 规范规定的文件头，用来挡「扩展名是 pdf、内容不是」的文件 */
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]

/** `/Encrypt`：PDF 加密字典的键名 */
const ENCRYPT_MARKER = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]

const startsWithBytes = (bytes: Uint8Array, expected: number[]): boolean => {
  if (bytes.length < expected.length) {
    return false
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[index] !== expected[index]) {
      return false
    }
  }
  return true
}

/**
 * 字节里是否出现某个 ASCII 串。
 * 只在首字节命中时逐字节比较，50 MiB 的最坏情况也是线性一遍，不解码成字符串（省一份内存）。
 */
const containsBytes = (bytes: Uint8Array, needle: number[]): boolean => {
  const last = bytes.length - needle.length
  const first = needle[0]
  for (let index = 0; index <= last; index += 1) {
    if (bytes[index] !== first) {
      continue
    }
    let matched = true
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) {
      return true
    }
  }
  return false
}

/** pdfjs 抛的密码错误（2.x 用 name 区分，没有可 import 的类） */
const isPasswordError = (error: unknown): boolean =>
  Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'PasswordException'

/** 硬失败的统一出口：落一条诊断日志（只记计数，不记文档内容）再抛 */
const hardFail = (
  code: PdfParseErrorCode,
  message: string,
  meta: { sizeBytes: number; totalPages: number; failedPageCount: number },
  error?: unknown
): PdfParseError => {
  recordError('pdf 解析失败', { code, sizeBytes: meta.sizeBytes, totalPages: meta.totalPages, failedPageCount: meta.failedPageCount }, error)
  return new PdfParseError(code, message)
}

/** 「第 3、7 页提取失败」里的页码串 */
const formatPageList = (pages: number[]): string => pages.join('、')

/** 取一页的文本；失败由调用方记账，所以这里只抛不改状态 */
const extractPageText = async (document: PdfDocumentProxy, pageNumber: number): Promise<string> => {
  const page = await document.getPage(pageNumber)
  try {
    const content = await page.getTextContent()
    const lines = textItemsToLines(content.items)
    return lines.join('\n')
  } finally {
    // 页级缓存要主动释放：几十页的 PDF 不释放会一路涨到 OOM（#480 性能要求）
    if (page.cleanup) {
      page.cleanup()
    }
  }
}

/**
 * 单页超时的内部信号：只在本文件里用来「记一笔」并停止翻页，**不是**对外错误码
 * （超时按 #571 的语义走 partial + warnings，不落 `failed`）。
 */
class PdfPageTimeoutError extends Error {
  constructor() {
    super('pdf page timeout')
    this.name = 'PdfPageTimeoutError'
  }
}

/** 判断某个异常是不是单页超时（`instanceof` 判不到跨 realm，这里同时认 `name`） */
const isPageTimeout = (error: unknown): boolean =>
  error instanceof PdfPageTimeoutError ||
  (Boolean(error) && typeof error === 'object' && (error as { name?: unknown }).name === 'PdfPageTimeoutError')

/**
 * 给一个 promise 套时间预算：超时先返回，把卡住的页放掉，由调用方决定怎么记账。
 *
 * 原 promise **不会**被取消 —— pdfjs 的 `getTextContent()` 没有中断接口。真正停下 worker 的
 * 是循环之后（或 finally 里）的 `document.destroy()`；原 promise 晚到的 settle 结果被丢弃，
 * 所以两条 `then` 分支里都要挡 `settled`，且超时后仍保留 then 的处理函数（吃掉 rejection，
 * 不让它变成 unhandled rejection 冒到全局）。
 */
const raceWithTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      reject(new PdfPageTimeoutError())
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })

/** 体积检查：**在读字节之前**就要挡住，别为了报「太大」把一个 51 MiB 的文件读进内存。 */
export const assertPdfSize = (sizeBytes: number): void => {
  if (sizeBytes > ATTACHMENT_LIMITS.pdfMaxBytes) {
    // 1024 × 1024 是 MB → 字节换算，不是阈值本身（阈值来自 limits.ts）
    const limitMiB = Math.round(ATTACHMENT_LIMITS.pdfMaxBytes / (1024 * 1024))
    throw hardFail('fileTooLarge', `PDF 文件超过 ${limitMiB} MiB 上限`, {
      sizeBytes,
      totalPages: 0,
      failedPageCount: 0,
    })
  }
}

/**
 * 解析 PDF 的前置检查（大小 / 文件头 / 加密），逐项给出可展示的文案。
 * 抽出来是为了让 manager 在真正解析前也能复用同一套判定（例如导入时先挡大文件）。
 */
export const assertPdfAcceptable = (bytes: Uint8Array, sizeBytes: number): void => {
  assertPdfSize(sizeBytes)
  if (bytes.length === 0 || !startsWithBytes(bytes, PDF_HEADER)) {
    throw hardFail('notPdfFile', '文件内容不是有效的 PDF（缺少 %PDF- 文件头）', {
      sizeBytes,
      totalPages: 0,
      failedPageCount: 0,
    })
  }
  if (containsBytes(bytes, ENCRYPT_MARKER)) {
    throw hardFail('encryptedPdf', '不支持加密 PDF', { sizeBytes, totalPages: 0, failedPageCount: 0 })
  }
}

/**
 * 解析 PDF（只在有文本层的场景可用）。
 *
 * 进度：每页开始前 `onProgress({ page, totalPages, stage: 'page' })`；打开文档后先报一次
 * `{ totalPages, stage: 'open' }`（此时还不知道页数之外的信息）。
 *
 * 取消：`options.signal.aborted` 为真时**停止继续取页**并返回已取到的部分（`warnings` 含「已取消」）。
 * 注意 pdfjs 的 `getTextContent()` 单页内不可中断 —— 取消的粒度是「页」。
 *
 * 页数上限：`pages > pdfMaxPages` 时在**取任何一页之前**抛 `tooManyPages`（不截断、不静默）。
 *
 * 超时：`options.timeoutMs`（缺省 `pdfTimeoutMs`）是**整篇**预算，检查点是「每页开始前」；
 * 单页用 `Promise.race` 抢跑，卡住的那一页记为失败页并停止翻页，已提取的页照常交付。
 */
export const parsePdfFile = async (file: Blob, options: ParseOptions = {}): Promise<ParsedDocument> => {
  const sizeBytes = file.size
  // 先挡体积再读字节：超限文件连 arrayBuffer 都不该调用
  assertPdfSize(sizeBytes)
  const bytes = new Uint8Array(await file.arrayBuffer())
  assertPdfAcceptable(bytes, sizeBytes)

  const signal = options.signal
  const aborted = (): boolean => Boolean(signal && signal.aborted)

  let lib: PdfJsLib
  try {
    lib = await loadPdfJs()
  } catch (error) {
    throw hardFail(
      'libUnavailable',
      'PDF 解析组件加载失败，请重试',
      { sizeBytes, totalPages: 0, failedPageCount: 0 },
      error
    )
  }

  const loadingTask = lib.getDocument({
    data: bytes,
    // 中文/日文 PDF 常用预定义 CMap，缺 cMapUrl 时取不到文本（#480 中文场景）
    cMapUrl: pdfAssetUrl(`${PDFJS_ASSET.cmapsDir}/`),
    cMapPacked: true,
    // 老内核上 `new Function` 容易被 CSP / 引擎限制，取文本用不到它
    isEvalSupported: false,
  })

  let document: PdfDocumentProxy
  try {
    document = await loadingTask.promise
  } catch (error) {
    // 打开失败也要把 worker 关掉，否则失败的解析会留下一个常驻 worker
    await loadingTask.destroy().catch(() => undefined)
    const code: PdfParseErrorCode = isPasswordError(error) ? 'encryptedPdf' : 'openFailed'
    const message = code === 'encryptedPdf' ? '不支持加密 PDF' : 'PDF 打开失败，文件可能已损坏'
    throw hardFail(code, message, { sizeBytes, totalPages: 0, failedPageCount: 0 }, error)
  }

  const totalPages = document.numPages
  options.onProgress?.({ totalPages, stage: 'open' })

  // 页数上限：取任何一页之前就拒绝（#571「支持页数上限」）。截断前 N 页当成功是禁止的 ——
  // 用户会以为整份文档都进了上下文（#480 §3.7 禁止静默截断）。
  if (totalPages > ATTACHMENT_LIMITS.pdfMaxPages) {
    await document.destroy().catch(() => undefined)
    throw hardFail(
      'tooManyPages',
      `该 PDF 有 ${totalPages} 页，超过 ${ATTACHMENT_LIMITS.pdfMaxPages} 页上限，请拆分后再上传`,
      { sizeBytes, totalPages, failedPageCount: 0 }
    )
  }

  const timeoutMs =
    options.timeoutMs === undefined ? ATTACHMENT_LIMITS.pdfTimeoutMs : options.timeoutMs
  // 整篇预算的起点在「开始翻页」这一刻（打开文档的耗时由 pdfjs 自己控制，不计入 —— 那里没有
  // 可中断的粒度，硬掐只会让好文件在慢设备上莫名失败）。
  const deadline = Date.now() + timeoutMs

  const pageTexts = new Map<number, string>()
  const failedPages: number[] = []
  let cancelled = false
  let timedOut = false

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (aborted()) {
        cancelled = true
        break
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        // 预算用光：停止翻页，已提取的页照常交付（partial），不抛错
        timedOut = true
        break
      }
      options.onProgress?.({ page: pageNumber, totalPages, stage: 'page' })
      try {
        const text = await raceWithTimeout(extractPageText(document, pageNumber), remaining)
        pageTexts.set(pageNumber, text)
      } catch (error) {
        // 单页失败不中断整篇：记页码，最后以 partial + warnings 交付
        failedPages.push(pageNumber)
        recordError(
          'pdf 单页提取失败',
          { page: pageNumber, totalPages, failedPageCount: failedPages.length, sizeBytes },
          error
        )
        if (isPageTimeout(error)) {
          // 卡住的那一页不值得继续：后面的页大概率同样卡在同一个坏流/坏字体上
          timedOut = true
          break
        }
      }
    }
  } finally {
    // worker 在 destroy 后终止：不复用，避免几十 MB 的 worker 常驻内存
    await document.destroy().catch(() => undefined)
  }

  const processedPages = pageTexts.size
  // #544：`characterCount` 是**正文**口径 —— 只累加每页提取出来的正文，
  // 不含下面拼接时插入的 `[第N页]` 标记与页间分隔换行。这样同一段文字走 txt / pdf
  // 两个解析器得到同一个数（txt/docx 的 text 本来就没有标记）。
  // 需要「注入文本总长度」的调用方看 `rawLength`（= text.length，含标记），别拿这个字段换算。
  let characterCount = 0
  for (const text of pageTexts.values()) {
    characterCount += text.length
  }

  const warnings: string[] = []
  if (failedPages.length > 0) {
    warnings.push(`第 ${formatPageList(failedPages)} 页提取失败`)
  }
  if (cancelled) {
    warnings.push('已取消')
  }
  if (timedOut) {
    // 文案带上「已提取 N/M 页」：只说「超时」的话，用户不知道还能不能看到内容
    warnings.push(`解析超时，已提取 ${processedPages}/${totalPages} 页`)
  }

  if (processedPages === 0) {
    if (cancelled || timedOut) {
      // 一页都没读完就被取消 / 超时：返回空 partial，别让「已取消」「超时」伪装成「扫描版 PDF」
      return {
        text: '',
        characterCount: 0,
        rawLength: 0,
        pages: totalPages,
        extractedPages: 0,
        pageChars: emptyPageChars(totalPages),
        warnings,
        parserVersion: PDF_PARSER_VERSION,
      }
    }
    throw hardFail(
      'openFailed',
      'PDF 打开失败，文件可能已损坏',
      { sizeBytes, totalPages, failedPageCount: failedPages.length },
      new Error(`all pages failed: ${formatPageList(failedPages)}`)
    )
  }

  // 无文本层判定：分母用**实际读到的页数**（不是总页数）。
  // 全部页失败以外的场景里两者相等；有失败页时用总页数会把「有文本但有几页坏了」误判成扫描版。
  const charsPerPage = characterCount / processedPages
  if (charsPerPage < ATTACHMENT_LIMITS.pdfMinCharsPerPage) {
    throw hardFail('noTextLayer', PDF_NO_TEXT_LAYER_MESSAGE, {
      sizeBytes,
      totalPages,
      failedPageCount: failedPages.length,
    })
  }

  // 逐页拼接：`[第N页]` 只出现在**取到文本**的页上；失败页不编造空标记（否则看起来像完整文档），
  // 页码缺口由 warnings 与 extractedPages < pages 共同暴露。
  const ordered = Array.from(pageTexts.keys()).sort((a, b) => a - b)
  const text = ordered.map((pageNumber) => `[第${pageNumber}页]\n${pageTexts.get(pageNumber)}`).join('\n')

  return {
    text,
    // 正文口径（不含页标记）：与 txt / docx 一致
    characterCount,
    // 注入文本总长度（含页标记与分隔换行）：PDF 上恒大于 characterCount
    rawLength: text.length,
    pages: totalPages,
    extractedPages: processedPages,
    // 每页字符数（#571）：长度 = pages、按页码对齐，未取到文本的页记 0。
    // 与 characterCount 同一把尺子，所以 pageChars 求和 === characterCount（测试断言这一条）。
    pageChars: pageCharsOf(pageTexts, totalPages),
    ...(warnings.length > 0 ? { warnings } : {}),
    parserVersion: PDF_PARSER_VERSION,
  }
}

/** 全 0 的页字符数组（取消 / 超时导致一页都没读到时用） */
const emptyPageChars = (totalPages: number): number[] => {
  const chars: number[] = []
  for (let index = 0; index < totalPages; index += 1) {
    chars.push(0)
  }
  return chars
}

/**
 * 按页码拼 `pageChars`：长度恒等于 `pages`，索引 `i` = 第 `i+1` 页。
 * 没取到文本的页（失败 / 取消 / 超时之后没轮到）记 0 —— 页码对齐是为了让调用方不用自己拼，
 * 「0」不代表「空白页」，区分靠 `extractedPages < pages` 与 `warnings`（见 types.ts 的字段注释）。
 */
const pageCharsOf = (pageTexts: Map<number, string>, totalPages: number): number[] => {
  const chars: number[] = []
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    const text = pageTexts.get(pageNumber)
    chars.push(text === undefined ? 0 : text.length)
  }
  return chars
}

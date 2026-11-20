/**
 * PDF 本地文本提取（Issue #571，母单 #480）。纯函数模块：`parsePdf(bytes) → { text, pages, ... }`。
 *
 * ## 为什么锁 `pdfjs-dist@2.16.105` 的 legacy 构建（不要"顺手升级"）
 *
 * 运行环境的语法下限是 **Chromium 83**（Android 11 出厂镜像的 WebView，见 rspack.config.ts 里
 * `chrome >= 83` 那段注释）。PDF.js 的版本与它是一一对应的硬约束，不是口味问题：
 *
 * - **3.x（3.11.174）** 的产物含 ES2021 逻辑赋值（`??=`），需要 Chromium ≥ 84；在 83 上
 *   `<script>` 一加载就抛 `SyntaxError: Unexpected token '='`，整个 PDF 能力不可用。
 * - **4.x（4.10.38）** 只发 ESM（`pdf.mjs`），没有 UMD/经典脚本入口；WebView 里用
 *   `<script src>` 直接 404，而我们的产物是经典脚本、`publicPath: 'auto'`、还需要 `file://`
 *   下能跑，接入方式根本对不上。
 * - **2.16.105** 的 `legacy/build/*.min.js` 是 UMD + ES5 语法，四档实测（Chromium 74 / 79 /
 *   83 / 109）全部 `ok: true`；50 页 PDF 提取 84 309 字符耗时 350–414 ms、峰值 PSS 54–85 MiB。
 *
 * 所以 import 路径写死 `pdfjs-dist/legacy/build/pdf.min.js`（**经典脚本/UMD，不是 ESM**），
 * 依赖版本在 package.json 里锁死为精确版本 `2.16.105`（不带 `^` / `~`）。
 *
 * ## Worker
 *
 * PDF.js 默认把解析放进 Worker，且要求 Worker **同源**。这里不自造 Worker：产物里由 Rspack 把
 * `pdfjs-dist/legacy/build/pdf.worker.min.js` 原样拷到 `static/pdf/pdf.worker.min.js`（见
 * rspack.config.ts 里该 CopyRspackPlugin 条目与理由），运行时按 `document.baseURI` 相对解析，
 * 于是 Capacitor 的 `file://` / `https://localhost` 与本地 8090 都一样是同源路径。
 * Worker 地址可覆盖：`parsePdf(bytes, { workerSrc })` 或 `setPdfWorkerSrc(src)`。
 *
 * 已知限制（不粉饰）：
 * - `file://` 下 Chromium 可能直接拒绝 `new Worker()`（SecurityError），此时 PDF.js 会自行
 *   退回**主线程 fake worker** —— 能出结果，但会卡 UI，且没有 worker 的内存隔离。真机未验证这一条。
 * - Node 下每条解析会打一行 `fetchStandardFontData: failed to fetch ... FoxitSans.pfb` 的
 *   warn：标准字体是**渲染**用的，文本提取不需要它们，而 Node 的 fetch 又不支持 `file://`，
 *   所以这条 warn 在服务端/单测里属于正常噪音，不影响 `pageChars` 与文本内容。
 */

// 只借类型（`pdfjs-dist` 的 types 入口指向 types/src/pdf.d.ts）；运行时不走这个路径。
import type * as PdfJsTypes from 'pdfjs-dist'

// legacy UMD 构建没有配套的 .d.ts（包内只有 `legacy/build/pdf.d.ts`，文件名对不上
// `pdf.min.js`），TypeScript 会报 TS7016；类型统一从上面的 `pdfjs-dist` 入口借。
// @ts-expect-error 见上一行：这是**刻意**用无类型声明文件的 UMD 构建
import * as pdfjsModule from 'pdfjs-dist/legacy/build/pdf.min.js'

/** PDF.js 对外 API 的结构（实际对象来自 legacy UMD 构建的 `module.exports`） */
type PdfJsApi = typeof PdfJsTypes

/**
 * UMD 与 ESM 的互操作：Node 下 `import()` 一个 CJS 模块得到 `{ default: module.exports }`；
 * Rspack（webpack 语义）对压缩过的 UMD 通常只填 `default`。两者都用 `.default` 兜底。
 */
const pdfjs: PdfJsApi = ((pdfjsModule as unknown as { default?: PdfJsApi }).default ??
  (pdfjsModule as unknown as PdfJsApi)) as PdfJsApi

/** 无文本层时的固定提示（关闭条件原文，别改文案） */
export const PDF_NO_TEXT_MESSAGE = '该 PDF 未检测到可提取的文本，暂不支持扫描版 PDF'

/**
 * 「无文本层」阈值（单位：整份文档的**非空白**字符数）。
 *
 * 阈值不是拍脑袋，是拿两个真实端夹出来的（fixture 见 `tests/fixtures/doc571/`）：
 * - 真扫描型 `big-50p-noText.pdf`（50 页，34 MB，纯图像）：PDF.js 逐页 `pageChars` 全 0，
 *   合计 **0** 字符；PyMuPDF `extract_text()` 同样是 0（交叉验证，排除"只是 PDF.js 读不出"）。
 * - 真实文本层样本：`sample-5p.pdf` 2 480 字符 / 5 页、`table-mixed.pdf` 2 302 字符 / 3 页、
 *   `big-50p.pdf` 84 309 字符 / 50 页（Spike 口径 84 309）。
 *
 * 取 **8**，落在 0 与 2 302 之间，且刻意靠近 0 端 —— 误判代价不对称：
 * - 把"只有零星几个字符"的 PDF 判成扫描件，代价是少一个用不上的能力（8 个字符喂给模型也没意义）；
 * - 把扫描件判成"有文本"，上层就会拿到空文本继续往下走 —— 正是本单明令禁止的行为。
 * 留 8 而不是 1，是为了让扫描件上常见的页码 / 水印这类零星字符（1–2 个）也落到"无文本层"。
 */
export const DEFAULT_MIN_TOTAL_CHARS = 8

/** 默认页数上限：50 页实测峰值 PSS 54–85 MiB，500 页给移动端留了一档余量，超出直接拒绝 */
export const DEFAULT_MAX_PAGES = 500

/** 默认整体超时（加载 + 逐页提取），毫秒 */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Worker 在产物里的固定路径（Rspack 原样拷贝，见 rspack.config.ts） */
export const PDF_WORKER_ASSET = 'static/pdf/pdf.worker.min.js'

/** `/v1/...` 这类错误码给上层按 code 分流，不靠 message 字符串匹配 */
export type PdfExtractErrorCode =
  | 'PDF_NO_TEXT_LAYER'
  | 'PDF_TOO_MANY_PAGES'
  | 'PDF_TIMEOUT'
  | 'PDF_ABORTED'
  | 'PDF_LOAD_FAILED'

/** 结构化的 PDF 提取错误：`code` 用于分流，`message` 给用户看 */
export class PdfExtractError extends Error {
  readonly code: PdfExtractErrorCode

  readonly details: Record<string, unknown>

  constructor(code: PdfExtractErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'PdfExtractError'
    this.code = code
    this.details = details
  }
}

/**
 * 提取结果。
 *
 * - `pages`：文档总页数（PDF 自己声明的）
 * - `extractedPages`：真正取到文本的页数（= `pageChars.length`；页失败时不占位）
 * - `pageChars`：逐页字符数，与成功提取的页一一对应、按页序；失败页不占位，页码见 `failedPages`
 * - `status`：`'partial'` 表示**至少一页提取失败**，这份文本不能当成完整文档用
 */
export interface PdfExtractResult {
  status: 'ok' | 'partial'
  text: string
  pages: number
  extractedPages: number
  pageChars: number[]
  failedPages: number[]
  warnings: string[]
}

/** PDF.js 页对象的最小结构（只用到取文本），桩对象也能喂进来做单测 */
export interface PdfTextPageLike {
  getTextContent(): Promise<{ items: ReadonlyArray<{ str?: string; hasEOL?: boolean }> }>
  cleanup?(): void
}

/** PDF.js 文档对象的最小结构（`getDocument()` 的 promise 结果） */
export interface PdfDocumentLike {
  numPages: number
  getPage(pageNumber: number): Promise<PdfTextPageLike>
  destroy?(): void | Promise<void>
}

export interface ParsePdfOptions {
  /** 页数上限，默认 {@link DEFAULT_MAX_PAGES}，超出抛 `PDF_TOO_MANY_PAGES` */
  maxPages?: number
  /** 整体超时，默认 {@link DEFAULT_TIMEOUT_MS}，超时抛 `PDF_TIMEOUT` */
  timeoutMs?: number
  /** 取消信号：中断在飞的逐页提取并抛 `PDF_ABORTED`（不是"跑完再丢结果"） */
  signal?: AbortSignal
  /** 进度回调：每成功提取一页回调一次 */
  onProgress?: (info: { page: number; pages: number }) => void
  /** Worker 地址覆盖；默认按 {@link PDF_WORKER_ASSET} 相对 `document.baseURI` 解析 */
  workerSrc?: string
  /** 「无文本层」阈值覆盖，默认 {@link DEFAULT_MIN_TOTAL_CHARS} */
  minTotalChars?: number
  /** @internal 复用 `parsePdf` 建立的超时/取消守卫（避免加载阶段与提取阶段各算一次 deadline） */
  guard?: InterruptGuard
}

let workerSrcOverride = ''

/** 全局指定 Worker 地址（打包环境 worker 不好接时的逃生口；`workerSrc` 选项优先级更高） */
export function setPdfWorkerSrc(src: string): void {
  workerSrcOverride = src
  if (src) {
    pdfjs.GlobalWorkerOptions.workerSrc = src
  }
}

/** 测试/排查用：读当前生效的 Worker 覆盖值（空串表示走默认解析） */
export function getPdfWorkerSrcOverride(): string {
  return workerSrcOverride
}

/**
 * 解析 Worker 地址：显式选项 > 全局覆盖 > 相对 `document.baseURI` 的产物路径 > 空串（Node）。
 * 空串时 PDF.js 走主线程 fake worker —— 这是 Node 单测能跑的原因，也是浏览器里的兜底。
 */
function resolveWorkerSrc(explicit?: string): string {
  if (explicit) {
    return explicit
  }
  if (workerSrcOverride) {
    return workerSrcOverride
  }
  const base = typeof document === 'undefined' ? '' : document.baseURI
  if (!base) {
    return ''
  }
  return new URL(PDF_WORKER_ASSET, base).href
}

/**
 * 超时 / 取消守卫。
 *
 * 关键点：它不是"每页开始前看一眼 signal"那种软检查 —— 那样一个卡住的 `getPage()` 能把
 * 取消拖到天荒地老，等于"跑完再丢结果"。这里用一个 `interrupted` promise 让**正在 await
 * 的那一步**立刻 reject，`parsePdf` 的 finally 再把 PDF.js 文档 `destroy()` 掉，
 * 真正停掉后台解析。
 */
export interface InterruptGuard {
  /** 把任意 promise 与超时/取消赛跑；先到者决定结果 */
  race<T>(work: Promise<T>): Promise<T>
  /** 同步检查：已经超时/已取消就直接抛（循环里用，避免多跑一页） */
  check(): void
  /** 清掉定时器与事件监听 */
  dispose(): void
}

function createInterruptGuard(options: ParsePdfOptions): InterruptGuard {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = options.signal
  let settled: PdfExtractError | null = null

  const timeoutError = (): PdfExtractError =>
    new PdfExtractError('PDF_TIMEOUT', `PDF 文本提取超时（>${timeoutMs} ms）`, { timeoutMs })
  const abortError = (): PdfExtractError => new PdfExtractError('PDF_ABORTED', 'PDF 文本提取已取消', {})

  let fire: (err: PdfExtractError) => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    fire = (err) => {
      settled = settled ?? err
      reject(err)
    }
  })
  // 没人 race 的时候也不能变成 unhandled rejection
  interrupted.catch(() => {})

  // 注意：这个定时器**不能 unref**。挂起的 `getPage()` 是一个永不 settle 的 promise，
  // 它自己不会让 Node 的事件循环保持活跃；定时器一旦 unref，进程就可能先退出，
  // 表现为 `Promise resolution is still pending but the event loop has already resolved`。
  const timer = setTimeout(() => fire(timeoutError()), timeoutMs)
  const onAbort = (): void => fire(abortError())
  if (signal) {
    if (signal.aborted) {
      fire(abortError())
    } else {
      signal.addEventListener('abort', onAbort)
    }
  }

  return {
    race<T>(work: Promise<T>): Promise<T> {
      if (settled) {
        return Promise.reject(settled)
      }
      return Promise.race([work, interrupted]) as Promise<T>
    },
    check(): void {
      if (settled) {
        throw settled
      }
      if (signal?.aborted) {
        throw abortError()
      }
    },
    dispose(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** 从 PDF.js 文本项拼一页的文本：`hasEOL` 补换行，其余原样拼接（不重排版式） */
function joinTextItems(items: ReadonlyArray<{ str?: string; hasEOL?: boolean }>): string {
  let out = ''
  for (const item of items) {
    if (typeof item.str === 'string') {
      out += item.str
    }
    if (item.hasEOL) {
      out += '\n'
    }
  }
  // 页尾空白去掉，但页内换行保留
  return out.replace(/[ \t]+$/u, '').replace(/\n+$/u, '')
}

/** 非空白字符数（阈值口径：空格/换行不算"可提取的文本"） */
function countVisibleChars(text: string): number {
  return text.replace(/\s/gu, '').length
}

/**
 * 逐页提取（核心，`parsePdf` 的加载步骤之外唯一做的事）。
 *
 * 导出是为了单测能注入桩文档 —— 「部分页失败」在真实 PDF 上很难稳定构造，
 * 而这条关闭条件不能靠"看起来实现了"交付。
 */
export async function extractFromDocument(
  doc: PdfDocumentLike,
  options: ParsePdfOptions = {}
): Promise<PdfExtractResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const minTotalChars = options.minTotalChars ?? DEFAULT_MIN_TOTAL_CHARS
  const total = doc.numPages
  const guard = options.guard ?? createInterruptGuard(options)
  const ownsGuard = !options.guard

  try {
    guard.check()
    if (!Number.isFinite(total) || total <= 0) {
      throw new PdfExtractError('PDF_LOAD_FAILED', 'PDF 不含任何页面', { pages: total })
    }
    // 页数上限在**取第一页之前**判掉：500 页的文档不该先跑一半再报错
    if (total > maxPages) {
      throw new PdfExtractError('PDF_TOO_MANY_PAGES', `PDF 页数 ${total} 超过上限 ${maxPages} 页`, {
        pages: total,
        maxPages,
      })
    }

    const chunks: string[] = []
    const pageChars: number[] = []
    const failedPages: number[] = []
    const warnings: string[] = []
    let visible = 0

    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      guard.check()
      try {
        const body = await guard.race(
          (async (): Promise<string> => {
            const page = await doc.getPage(pageNumber)
            try {
              const content = await page.getTextContent()
              return joinTextItems(content.items)
            } finally {
              page.cleanup?.()
            }
          })()
        )
        const chars = countVisibleChars(body)
        visible += chars
        pageChars.push(chars)
        // 页码头始终写上：页码与页面内容严格对齐，空白页也保留占位
        chunks.push(`[第${pageNumber}页]\n${body}`)
      } catch (err) {
        // 超时/取消是整体失败，不是"这一页坏了"——继续跑就违背了取消的语义
        if (err instanceof PdfExtractError) {
          throw err
        }
        failedPages.push(pageNumber)
        warnings.push(`第 ${pageNumber} 页提取失败：${err instanceof Error ? err.message : String(err)}`)
      }
      options.onProgress?.({ page: pageNumber, pages: total })
    }

    // 无文本层：整份文档几乎没有可提取的字符 → 明确报错，绝不返回空串蒙混过关
    if (visible < minTotalChars) {
      throw new PdfExtractError('PDF_NO_TEXT_LAYER', PDF_NO_TEXT_MESSAGE, {
        pages: total,
        visibleChars: visible,
        minTotalChars,
        failedPages,
      })
    }

    return {
      status: failedPages.length > 0 ? 'partial' : 'ok',
      // 页间空行 = 两个换行；每页以 `[第N页]` 开头
      text: chunks.join('\n\n'),
      pages: total,
      extractedPages: pageChars.length,
      pageChars,
      failedPages,
      warnings,
    }
  } finally {
    if (ownsGuard) {
      guard.dispose()
    }
  }
}

/**
 * PDF 字节 → 结构化文本。
 *
 * 失败一律抛 {@link PdfExtractError}（带 `code`），**不返回空文本**：
 * 无文本层 `PDF_NO_TEXT_LAYER`、超页数 `PDF_TOO_MANY_PAGES`、超时 `PDF_TIMEOUT`、
 * 取消 `PDF_ABORTED`、打不开 `PDF_LOAD_FAILED`。部分页失败不抛错，返回 `status: 'partial'`。
 */
export async function parsePdf(
  input: ArrayBuffer | Uint8Array,
  options: ParsePdfOptions = {}
): Promise<PdfExtractResult> {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input)
  const workerSrc = resolveWorkerSrc(options.workerSrc)
  // 同源 Worker：地址在这里落到 PDF.js 的全局配置上（不设则走主线程 fake worker）
  if (workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
  }

  const guard = createInterruptGuard(options)
  let doc: PdfDocumentLike | null = null
  try {
    guard.check()
    const task = pdfjs.getDocument({
      data,
      // WebView 里不需要渲染，关掉字体/求值相关能力：更小的攻击面 + 更快
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    })
    // 加载阶段也要能被超时/取消打断（大文件解析可能卡在这儿）
    doc = (await guard.race(task.promise as Promise<PdfDocumentLike>)) as PdfDocumentLike
    return await extractFromDocument(doc, { ...options, guard })
  } catch (err) {
    if (err instanceof PdfExtractError) {
      throw err
    }
    throw new PdfExtractError('PDF_LOAD_FAILED', `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`, {
      cause: err instanceof Error ? err.name : typeof err,
    })
  } finally {
    guard.dispose()
    // 无论成功、超时还是取消，都把 PDF.js 文档销毁 —— 这是"真的中断"的落点
    try {
      await doc?.destroy?.()
    } catch {
      // 销毁失败不影响已经得出的结果
    }
  }
}

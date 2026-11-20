/**
 * pdfjs-dist 的**版本 + 加载方式唯一入口**（Issue #480 PDF 文本解析）。
 *
 * ## 为什么钉死 2.16.105、为什么用经典 `<script src>`
 *
 * 硬基线是 `config/compat.json` 的 `baselineChromium: 83`（Android 11 出厂镜像的 WebView 停在
 * Chromium 83），探测档位 79 / 83 / 91 / 109。#480 的 spike（felix4396）三个版本结论：
 *
 * - `3.11.174`：产物是原生 ES2021（329 处 `?.`、17 处 `??`、63 处逻辑赋值）→ 79 / 83 上
 *   **解析期** SyntaxError，polyfill 救不了；
 * - `4.10.38`：legacy 产物只发 ESM（`legacy/build/pdf.min.js` 404）→ 老内核没有可用的经典脚本；
 * - `2.16.105`：唯一能过 79 / 83 的版本 → 本模块只加载它的 UMD 产物。
 *
 * 因此这里**不做 `import 'pdfjs-dist'`**（ESM / 打包器会把产物语法交给当前 targets，而且 4.x
 * 之后没有经典脚本可用），而是运行时注入 `<script src>` 拿全局 `pdfjsLib`。换版本时只改两处：
 * `package.json` 的依赖版本（版本号由构建期从装好的包里读，注入 `__PDFJS_ASSET__.version`）
 * 与 `config/pdfjs.json` 的文件名；加载方式本身不变。
 *
 * ## 产物实测（本分支复核）
 *
 * - `pdf.min.js` 366,111 B；`pdf.worker.min.js` 1,111,587 B；
 * - acorn 逐文件解析：`pdf.min.js` 用 `ecmaVersion: 2017` **失败**（唯一 ES2018 构造是第 22 行的
 *   对象展开 `{...t}`，Chromium 60+ 支持）、`2018` 通过；worker `2017` 即通过。
 *   也就是说产物语法下限是 ES2018，79 / 83 都能解析，spike 的 ES2017 说法略微保守，结论不变；
 * - `getDocument({ data })` 走 `postMessage` 的 structured clone（`pdf.min.js` 的 GetDocRequest
 *   没有 transfer list），**不会 detach 调用方的 ArrayBuffer**，但会复制一份。
 */

/** 构建期注入的静态资源描述（来源 `config/pdfjs.json` + 实际安装版本，见 rspack.config.ts） */
export type PdfJsAssetConfig = {
  readonly version: string
  readonly assetDir: string
  readonly script: string
  readonly worker: string
  readonly cmapsDir: string
}

/**
 * 非打包环境（`node --test` 直接 import .ts、类型检查之外的脚本）的兜底值。
 * 只用于让模块可加载，不代表线上产物：线上一定走 `__PDFJS_ASSET__`。
 */
const FALLBACK_ASSET: PdfJsAssetConfig = {
  version: 'unknown',
  assetDir: 'static/pdfjs',
  // 与构建期注入同形：`assetDir` 下的**文件名**（不是包内相对路径 `legacy/build/...`）。
  // 口径不一致会让真产物去取 `static/pdfjs/legacy/build/*.js`（404），见 rspack.config.ts 的注入注释。
  script: 'pdf.min.js',
  worker: 'pdf.worker.min.js',
  cmapsDir: 'cmaps',
}

/**
 * pdfjs 静态资源描述。`typeof` 判 undefined 是刻意的：DefinePlugin 会把这里的标识符替换成字面量，
 * 非打包环境（没有注入）时 `typeof` 不会抛 ReferenceError。
 */
export const PDFJS_ASSET: PdfJsAssetConfig =
  typeof __PDFJS_ASSET__ === 'undefined' ? FALLBACK_ASSET : __PDFJS_ASSET__

/** 当前 pdfjs 版本；进 `ParsedDocument.parserVersion`，与内容指纹一起做解析缓存键 */
export const PDFJS_VERSION: string = PDFJS_ASSET.version

// ── 运行期最小类型（只声明本模块真正用到的部分） ────────────────────────────────
// 不 import pdfjs-dist 的 .d.ts：那个包只作为静态资源来源存在，源码不消费它的模块导出。

export type PdfTextItem = {
  str?: unknown
  transform?: unknown
  width?: unknown
  height?: unknown
  hasEOL?: unknown
}

export type PdfPageProxy = {
  getTextContent(): Promise<{ items?: unknown[] }>
  cleanup?(): void
}

export type PdfDocumentProxy = {
  numPages: number
  getPage(pageNumber: number): Promise<PdfPageProxy>
  destroy(): Promise<void>
}

export type PdfGetDocumentParams = {
  data: Uint8Array
  /** 有些 PDF 把 CMaps 指向外部资源，中文/日文 PDF 缺它时取不到文本 */
  cMapUrl?: string
  cMapPacked?: boolean
  isEvalSupported?: boolean
}

export type PdfLoadingTask = {
  promise: Promise<PdfDocumentProxy>
  destroy(): Promise<void>
}

export type PdfJsLib = {
  version?: string
  getDocument(params: PdfGetDocumentParams): PdfLoadingTask
  GlobalWorkerOptions: { workerSrc: string }
}

/** 应用根目录（`index.html` 所在目录）：dev 是 `http://localhost:8090/`，Android 上是 `https://localhost/` */
const appRootUrl = (): URL =>
  new URL('./', typeof document === 'undefined' ? 'https://localhost/' : document.baseURI)

/** 静态资源的绝对地址；`assetDir` / 文件名来自上面的集中配置，别处不许再拼路径 */
export const pdfAssetUrl = (file: string): string =>
  new URL(`${PDFJS_ASSET.assetDir}/${file}`, appRootUrl()).href

/** worker 地址（导出让测试与诊断可以直接核对） */
export const pdfWorkerUrl = (): string => pdfAssetUrl(PDFJS_ASSET.worker)

const readGlobalLib = (): PdfJsLib | null => {
  const scope = typeof window === 'undefined' ? null : (window as unknown as { pdfjsLib?: PdfJsLib })
  const lib = scope && scope.pdfjsLib
  return lib ? lib : null
}

/**
 * worker 必须在 `getDocument` 之前配好：漏配时 pdfjs 2.x 会走 fake worker（主线程同步解析），
 * 大文件直接卡住 UI 线程 —— 这正是本单要避免的（#480「解析不得阻塞 UI 主线程」）。
 */
const configureWorker = (lib: PdfJsLib): void => {
  if (!lib.GlobalWorkerOptions) {
    return
  }
  lib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl()
}

/** 单飞：同一个页面里重复调用只注入一次脚本 */
let loadPromise: Promise<PdfJsLib> | null = null

/**
 * 加载 pdfjs（经典脚本，老内核可用）。失败不缓存，调用方可以重试。
 * 不加超时：这里读的是包内静态资源，`onload` / `onerror` 必然会到其中一个。
 */
export const loadPdfJs = (): Promise<PdfJsLib> => {
  if (loadPromise) {
    return loadPromise
  }
  const existing = readGlobalLib()
  if (existing) {
    configureWorker(existing)
    loadPromise = Promise.resolve(existing)
    return loadPromise
  }
  loadPromise = new Promise<PdfJsLib>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('pdfjs: 没有 document，无法注入经典脚本'))
      return
    }
    const url = pdfAssetUrl(PDFJS_ASSET.script)
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => {
      const lib = readGlobalLib()
      if (!lib) {
        reject(new Error(`pdfjs: ${url} 加载完成但没有全局 pdfjsLib`))
        return
      }
      configureWorker(lib)
      resolve(lib)
    }
    script.onerror = () => {
      reject(new Error(`pdfjs: 无法加载 ${url}`))
    }
    document.head.appendChild(script)
  }).catch((error: unknown) => {
    // 失败不缓存：一次网络/资源异常不该把这个页面的 PDF 解析能力永久判死
    loadPromise = null
    throw error
  })
  return loadPromise
}

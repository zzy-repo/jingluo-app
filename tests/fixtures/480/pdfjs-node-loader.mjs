// [fixture | #480 验收测试 | L0 专用：把浏览器侧的 pdfjs 加载口换成 Node 侧的「同一份 pdfjs」]
//
// `src/services/attachments/parsers/pdf.ts` 只通过 `./pdfLoader.js` 拿 pdfjs：
// 那个文件负责「运行期插入 <script src> 取全局 pdfjsLib」，**在 Node 里没有 document**，
// 所以 L0 用例用 node:module 的 resolve hook 把这一层换成本文件 —— 换的只是**加载方式**，
// 解析逻辑（`pdf.ts` 的逐页循环 / `[第N页]` 拼装 / 无文本层阈值 / 取消语义）全是真代码。
//
// 用的是**同一个版本**（pdfjs-dist@2.16.105 的 legacy UMD 产物，与线上 `<script src>` 同一份），
// 所以 L0 断言的是真实的 pdfjs 文本抽取结果，不是替身。
//
// 两处 Node 侧适配（都只影响「能不能在 Node 里跑起来」，不影响解析结果）：
//   1. `dommatrix` 是 pdfjs 的可选依赖（只在 Node 分支 require），仓库没装 —— 这里给它一个
//      最小替身，只实现 pdfjs 用到的那几个恒等方法；
//   2. 关掉 standard font 回退（`standardFontDataUrl` 缺失时 pdfjs 会打一条 warning），
//      #480 已明确「不带 standard_fonts/ 不影响取文本」，见 pdf.ts 文件头的已知边界。
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let loaded = null

const shimDomMatrix = () => {
  const Module = require('node:module')
  const original = Module._load
  Module._load = function load(request, parent, isMain) {
    if (request === 'dommatrix/dist/dommatrix.js' || request === 'dommatrix') {
      return {
        __esModule: true,
        default: class DOMMatrix {
          multiplySelf() {
            return this
          }
          translateSelf() {
            return this
          }
          scaleSelf() {
            return this
          }
          rotateSelf() {
            return this
          }
          invertSelf() {
            return this
          }
        },
      }
    }
    return original.call(this, request, parent, isMain)
  }
}

/** 真实 pdfjs（2.16.105） */
const realPdfJs = () => {
  if (loaded) {
    return loaded
  }
  shimDomMatrix()
  loaded = require('pdfjs-dist/legacy/build/pdf.js')
  return loaded
}

export const PDFJS_ASSET = {
  version: 'node-test',
  assetDir: '',
  script: '',
  worker: '',
  cmapsDir: '',
}

export const PDFJS_VERSION = realPdfJs().version

export const pdfAssetUrl = (file) => `file:///node-test/${file}`

export const pdfWorkerUrl = () => pdfAssetUrl('worker')

/**
 * 故障注入（只用于「部分页失败」这一条 L0 断言：合法 PDF 极少有单页坏掉的样本）：
 * `globalThis.__480_PDF_FAULTS__ = { failPages: [2] }` 时，第 2 页的 `getPage()` 抛错，
 * 其它一切照真 pdfjs 走。
 */
const faultOf = (pageNumber) => {
  const faults = globalThis.__480_PDF_FAULTS__
  if (!faults || !Array.isArray(faults.failPages)) {
    return false
  }
  return faults.failPages.indexOf(pageNumber) >= 0
}

/** 与线上 `loadPdfJs()` 同形的返回值：`getDocument()` → `{ promise, destroy }` */
export const loadPdfJs = async () => {
  const lib = realPdfJs()
  return {
    version: lib.version,
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: (params) => {
      const task = lib.getDocument({
        data: params.data,
        // Node 里没有 worker 可用：走 fake worker（与「老内核上直接主线程解析」同一路径）
        disableWorker: true,
        isEvalSupported: params.isEvalSupported !== true,
        // 不请求 standard fonts（目录没随包）——取文本不依赖它
        useSystemFonts: false,
      })
      return {
        promise: task.promise.then((document) => ({
          numPages: document.numPages,
          getPage: async (pageNumber) => {
            if (faultOf(pageNumber)) {
              throw new Error(`injected page failure: page ${pageNumber}`)
            }
            return document.getPage(pageNumber)
          },
          destroy: () => document.destroy(),
        })),
        destroy: () => task.destroy(),
      }
    },
  }
}

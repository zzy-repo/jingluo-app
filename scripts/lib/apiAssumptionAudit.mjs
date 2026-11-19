/**
 * 类别 1：JS 内置 API / 语言特性假设的**纯判定模块**（GitHub issue #209 的盘点工具）。
 *
 * 为什么需要它：`rspack` 的 `target=chrome83` 只降**语法**，运行时 API 一个都不补。所以
 * 「这句 `Object.hasOwn` 在 WebView 83 上到底跑不跑得动」只能靠人对着一张版本表判断，
 * 而这正是 issue #209「能力探测替代一切假设」要消灭的东西 —— 判断必须变成可复算的代码。
 *
 * 判定规则只有三条（与 docs/capabilities/api.md 的「风险」列一一对应）：
 *
 *   1 `firstSupported <= 83`                  → `baseline`        低风险：Android WebView 83
 *                                                                 出厂自带，不需要任何兜底。
 *   2 `firstSupported > 83` 且入口 polyfill 装了 → `entry-polyfill`  中风险：能用，但正确性
 *                                                                 押在 `src/polyfills/legacy.ts`
 *                                                                 是 main.tsx 第一个 import 上。
 *   3 `firstSupported > 83` 且没人补          → `uncovered`       高风险：真漏洞，必须拆单。
 *
 * 三个出口的分工（仓库既有约定，`scripts/lib/hardcodedIpAudit.mjs` 同款）：
 * 本模块只做「文本 → 命中 + 判定」的纯函数，不读盘、不遍历、不打印；
 * 遍历与输出留给调用方（CLI / 测试 / 后续 scripts/check-capabilities.mjs）。
 *
 * ── 已知边界（宁可承认也不硬猜） ─────────────────────────────────────────────
 * a) 文本近似，不是 AST。注释与字符串字面量由一个手写状态机遮成空格（保留换行与列位置），
 *    因此注释里写的 `Object.hasOwn` 不会误报；代价是**模板字符串 `${}` 里的表达式也会被遮掉**
 *    —— 那一处若真写了裸调用会漏报，属保守漏报，需要精确结论时走 scripts/check-bundle-syntax.mjs
 *    的 acorn 路径。
 * b) 正则字面量**不遮**（要留着眼睛找 `(?<=` 与 `d` 标志），所以正则里出现引号可能让状态机
 *    多吞几行；这是已知代价，命中结果需人工复核。
 * c) `top-level await` 靠文本判不出（函数内的 `await` 与顶层 `await` 长得一样），本模块**不做**
 *    近似，交给 check-bundle-syntax.mjs 的 `findForbiddenSyntax`（acorn 判定）。同理
 *    `import.meta` 只做字面匹配，不判断它是不是真的在模块顶层。
 * d) `Array.prototype.at` 与 `String.prototype.at` 版本号相同（都是 92），但兜底语义不同
 *    （String 版按 UTF-16 码元取值，见 legacy.ts 的已知边界），文本层无法区分 receiver 类型，
 *    统一记作 `prototype-at`。
 * e) 版本号来源：优先仓库内已有权威表（`scripts/check-bundle-syntax.mjs` 的
 *    `LEGACY_RUNTIME_APIS`、`scripts/compat/matrix-scan.mjs` 的 `RUNTIME_APIS`/`FEATURE_EVIDENCE`），
 *    表外条目一律回 MDN browser-compat-data 现查并写进 `source` 字段，**不靠记忆填**。
 */

import { BASELINE_CHROMIUM } from './compatBaseline.mjs'

/** Android WebView 83（Chromium 83.0.4103.106）——本仓库的兼容下限。数字唯一来源是 config/compat.json（issue #276），这里只转出。 */
export const BASELINE_CHROME = BASELINE_CHROMIUM

/** 入口 polyfill 里真正会装上的 API 键（与 src/polyfills/legacy.ts 的 install* 一一对应） */
export const ENTRY_POLYFILLED = [
  'Object.hasOwn',
  'Array.prototype.at',
  'String.prototype.at',
  'Array.prototype.findLast',
  'Array.prototype.findLastIndex',
  'Array.prototype.toSorted',
  'Array.prototype.toReversed',
  'Array.prototype.toSpliced',
  'Array.prototype.with',
  'structuredClone',
  'crypto.randomUUID',
  'String.prototype.replaceAll',
  'Intl.Segmenter',
]

/** polyfill 自己的源码目录：这里出现的是**定义**而不是**假设**，判定时统一算已兜底 */
export const POLYFILL_DIR = 'src/polyfills/'

// 方法类调用的前缀：`x.at(` / `x?.at(` / `x[0].at(` / `(a||[]).at(` 都要抓得到
const RECEIVER = '[A-Za-z0-9_$\\])?]'

const callPattern = (name) => new RegExp(`${RECEIVER}\\s*\\.\\s*${name}\\s*\\(`, 'g')
const staticPattern = (owner, name) => new RegExp(`\\b${owner}\\s*\\.\\s*${name}\\s*\\(`, 'g')

/**
 * 版本表 + 匹配规则。`id` 是稳定标识（测试与文档都按它对齐），`source` 注明版本号出处：
 * `check-bundle-syntax` / `matrix-scan` 表示仓库内已有权威表，`mdn` 表示本轮现查 bcd。
 */
export const API_RULES = [
  // ── 应用真在用、且入口已补的（中风险：依赖入口顺序） ─────────────────────
  {
    id: 'object-hasOwn',
    api: 'Object.hasOwn',
    kind: 'api',
    firstSupported: 93,
    source: 'check-bundle-syntax',
    pattern: staticPattern('Object', 'hasOwn'),
  },
  {
    id: 'prototype-at',
    api: 'Array.prototype.at / String.prototype.at',
    kind: 'api',
    firstSupported: 92,
    source: 'check-bundle-syntax',
    pattern: callPattern('at'),
  },
  {
    id: 'array-findLast',
    api: 'Array.prototype.findLast',
    kind: 'api',
    firstSupported: 97,
    source: 'check-bundle-syntax',
    pattern: callPattern('findLast'),
  },
  {
    id: 'array-findLastIndex',
    api: 'Array.prototype.findLastIndex',
    kind: 'api',
    firstSupported: 97,
    source: 'check-bundle-syntax',
    pattern: callPattern('findLastIndex'),
  },
  {
    id: 'array-toSorted',
    api: 'Array.prototype.toSorted',
    kind: 'api',
    firstSupported: 110,
    source: 'check-bundle-syntax',
    pattern: callPattern('toSorted'),
  },
  {
    id: 'array-toReversed',
    api: 'Array.prototype.toReversed',
    kind: 'api',
    firstSupported: 110,
    source: 'check-bundle-syntax',
    pattern: callPattern('toReversed'),
  },
  {
    id: 'array-toSpliced',
    api: 'Array.prototype.toSpliced',
    kind: 'api',
    firstSupported: 110,
    source: 'check-bundle-syntax',
    pattern: callPattern('toSpliced'),
  },
  {
    id: 'array-with',
    api: 'Array.prototype.with',
    kind: 'api',
    firstSupported: 110,
    source: 'check-bundle-syntax',
    pattern: callPattern('with'),
  },
  {
    id: 'structuredClone',
    api: 'structuredClone',
    kind: 'api',
    firstSupported: 98,
    source: 'check-bundle-syntax',
    pattern: /\bstructuredClone\s*\(/g,
  },
  {
    id: 'crypto-randomUUID',
    api: 'crypto.randomUUID',
    kind: 'api',
    firstSupported: 92,
    source: 'check-bundle-syntax',
    pattern: /(?:crypto|globalThis\s*\.\s*crypto|window\s*\.\s*crypto)\s*\.\s*randomUUID\s*\(/g,
  },
  {
    id: 'string-replaceAll',
    api: 'String.prototype.replaceAll',
    kind: 'api',
    firstSupported: 85,
    source: 'check-bundle-syntax',
    pattern: callPattern('replaceAll'),
  },
  {
    id: 'intl-segmenter',
    api: 'Intl.Segmenter',
    kind: 'api',
    firstSupported: 87,
    source: 'check-bundle-syntax',
    pattern: /\bIntl\s*\.\s*Segmenter\b/g,
  },

  // ── 81 及以下：WebView 83 自带，不需要兜底（列出来是为了避免重复劳动） ────
  {
    id: 'intl-displayNames',
    api: 'Intl.DisplayNames',
    kind: 'api',
    firstSupported: 81,
    source: 'matrix-scan',
    pattern: /\bIntl\s*\.\s*DisplayNames\b/g,
  },
  {
    id: 'intl-listFormat',
    api: 'Intl.ListFormat',
    kind: 'api',
    firstSupported: 72,
    source: 'matrix-scan',
    pattern: /\bIntl\s*\.\s*ListFormat\b/g,
  },
  {
    id: 'intl-relativeTimeFormat',
    api: 'Intl.RelativeTimeFormat',
    kind: 'api',
    firstSupported: 71,
    source: 'matrix-scan',
    pattern: /\bIntl\s*\.\s*RelativeTimeFormat\b/g,
  },
  {
    id: 'intl-pluralRules',
    api: 'Intl.PluralRules',
    kind: 'api',
    firstSupported: 63,
    source: 'mdn',
    pattern: /\bIntl\s*\.\s*PluralRules\b/g,
  },
  {
    id: 'promise-allSettled',
    api: 'Promise.allSettled',
    kind: 'api',
    firstSupported: 76,
    source: 'matrix-scan',
    pattern: staticPattern('Promise', 'allSettled'),
  },
  {
    id: 'array-flat',
    api: 'Array.prototype.flat',
    kind: 'api',
    firstSupported: 69,
    source: 'mdn',
    pattern: callPattern('flat'),
  },
  {
    id: 'array-flatMap',
    api: 'Array.prototype.flatMap',
    kind: 'api',
    firstSupported: 69,
    source: 'mdn',
    pattern: callPattern('flatMap'),
  },
  {
    id: 'string-trimStart',
    api: 'String.prototype.trimStart',
    kind: 'api',
    firstSupported: 66,
    source: 'mdn',
    pattern: callPattern('trimStart'),
  },
  {
    id: 'string-trimEnd',
    api: 'String.prototype.trimEnd',
    kind: 'api',
    firstSupported: 66,
    source: 'mdn',
    pattern: callPattern('trimEnd'),
  },

  // ── > 83 且**没人补**：出现即真漏洞（本轮的「高风险」桶） ─────────────────
  {
    id: 'object-groupBy',
    api: 'Object.groupBy',
    kind: 'api',
    firstSupported: 117,
    source: 'check-bundle-syntax',
    pattern: staticPattern('Object', 'groupBy'),
  },
  {
    id: 'array-fromAsync',
    api: 'Array.fromAsync',
    kind: 'api',
    firstSupported: 121,
    source: 'mdn',
    pattern: staticPattern('Array', 'fromAsync'),
  },
  {
    id: 'promise-any',
    api: 'Promise.any',
    kind: 'api',
    firstSupported: 85,
    source: 'check-bundle-syntax',
    pattern: staticPattern('Promise', 'any'),
  },
  {
    id: 'promise-withResolvers',
    api: 'Promise.withResolvers',
    kind: 'api',
    firstSupported: 119,
    source: 'mdn',
    pattern: staticPattern('Promise', 'withResolvers'),
  },
  {
    id: 'aggregate-error',
    api: 'AggregateError',
    kind: 'api',
    firstSupported: 85,
    source: 'check-bundle-syntax',
    pattern: /\bnew\s+AggregateError\s*\(/g,
  },
  {
    id: 'error-cause',
    api: 'Error 的 cause 选项',
    kind: 'api',
    firstSupported: 93,
    source: 'mdn',
    // 只认 `new XError(..., { cause: ... })` 这一种形状；局部同名状态字段（{ cause } 形状的
    // React state）不会命中，那是本轮踩过的假阳性。
    pattern: /\bnew\s+[A-Za-z_$][\w$]*\s*\([^\n]*\bcause\s*:/g,
  },

  // ── 语言特性 / 语法：> 83 且不可 polyfill，只能靠构建降级或改写法 ──────────
  {
    id: 'regexp-lookbehind',
    api: '正则后行断言 (?<= / (?<!',
    kind: 'syntax',
    firstSupported: 62,
    source: 'matrix-scan',
    pattern: /\(\?<[=!]/g,
  },
  {
    id: 'regexp-hasIndices',
    api: '正则 d 标志（hasIndices）',
    kind: 'syntax',
    firstSupported: 90,
    source: 'mdn',
    pattern: /\/(?:[^/\\\n]|\\.)+\/[dgimsuvy]*d[dgimsuvy]*\b/g,
  },
  {
    id: 'private-field',
    api: '类私有字段 #x',
    kind: 'syntax',
    firstSupported: 74,
    source: 'matrix-scan',
    // 后面跟 `(` 的是私有方法/访问器，交给下面的 private-method 规则，避免一条写法算两次；
    // `(?![\w$])` 是必须的 —— 否则正则会退一步只吃到 `#secre` 再绕开那个前瞻。
    pattern: /(?:^|[;{}\n])\s*(?:static\s+)?#[\w$]+(?![\w$])(?!\s*\()/g,
  },
  {
    id: 'private-method',
    api: '类私有方法 / 私有访问器',
    kind: 'syntax',
    firstSupported: 84,
    source: 'matrix-scan',
    pattern: /(?:^|[;{}\n])\s*(?:static\s+|get\s+|set\s+|async\s+)*#[\w$]+\s*\(/g,
  },
  {
    id: 'private-in',
    api: '私有字段 in 判断 #x in obj',
    kind: 'syntax',
    firstSupported: 91,
    source: 'matrix-scan',
    pattern: /#[\w$]+\s+in\s+/g,
  },
  {
    id: 'class-static-block',
    api: '类静态初始化块 static { }',
    kind: 'syntax',
    firstSupported: 94,
    source: 'matrix-scan',
    pattern: /\bstatic\s*\{/g,
  },
  {
    id: 'import-meta',
    api: 'import.meta',
    kind: 'syntax',
    firstSupported: 64,
    source: 'matrix-scan',
    pattern: /\bimport\s*\.\s*meta\b/g,
  },
]

const CODE = 'code'
const LINE_COMMENT = 'line-comment'
const BLOCK_COMMENT = 'block-comment'
const SINGLE_QUOTE = 'single-quote'
const DOUBLE_QUOTE = 'double-quote'
const TEMPLATE = 'template'

/**
 * 把注释与字符串字面量遮成空格（换行原样保留，因此行号/列号不变），返回等长文本。
 * 正则字面量**不遮**（见已知边界 b）。纯函数，不读盘。
 *
 * @param {string} text 源码文本
 * @returns {string} 与入参等长的遮蔽文本
 */
export const maskLiteralsAndComments = (text) => {
  const out = []
  const templateStack = []
  let state = CODE
  let braceDepth = 0
  let index = 0
  while (index < text.length) {
    const ch = text[index]
    const next = text[index + 1]
    if (state === CODE) {
      if (ch === '/' && next === '/') {
        state = LINE_COMMENT
        out.push('  ')
        index += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = BLOCK_COMMENT
        out.push('  ')
        index += 2
        continue
      }
      if (ch === "'") {
        state = SINGLE_QUOTE
        out.push(' ')
        index += 1
        continue
      }
      if (ch === '"') {
        state = DOUBLE_QUOTE
        out.push(' ')
        index += 1
        continue
      }
      if (ch === '`') {
        state = TEMPLATE
        out.push(' ')
        index += 1
        continue
      }
      if (ch === '{') braceDepth += 1
      if (ch === '}') {
        if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
          templateStack.pop()
          braceDepth -= 1
          state = TEMPLATE
          out.push(' ')
          index += 1
          continue
        }
        braceDepth -= 1
      }
      out.push(ch)
      index += 1
      continue
    }
    if (state === LINE_COMMENT) {
      if (ch === '\n') {
        state = CODE
        out.push('\n')
      } else {
        out.push(' ')
      }
      index += 1
      continue
    }
    if (state === BLOCK_COMMENT) {
      if (ch === '*' && next === '/') {
        state = CODE
        out.push('  ')
        index += 2
        continue
      }
      out.push(ch === '\n' ? '\n' : ' ')
      index += 1
      continue
    }
    if (state === TEMPLATE) {
      if (ch === '\\') {
        out.push('  ')
        index += 2
        continue
      }
      if (ch === '`') {
        state = CODE
        out.push(' ')
        index += 1
        continue
      }
      if (ch === '$' && next === '{') {
        braceDepth += 1
        templateStack.push(braceDepth)
        state = CODE
        out.push('  ')
        index += 2
        continue
      }
      out.push(ch === '\n' ? '\n' : ' ')
      index += 1
      continue
    }
    // 单/双引号字符串
    if (ch === '\\') {
      out.push('  ')
      index += 2
      continue
    }
    if ((state === SINGLE_QUOTE && ch === "'") || (state === DOUBLE_QUOTE && ch === '"')) {
      state = CODE
      out.push(' ')
      index += 1
      continue
    }
    out.push(ch === '\n' ? '\n' : ' ')
    index += 1
  }
  return out.join('')
}

/** 1-based 行号 */
const lineOf = (text, offset) => {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/
const HTML_FILE = /\.html?$/i

/** 整段换成空格，只留换行（长度与行数都不变） */
const blank = (chunk) => chunk.replace(/[^\n]/g, ' ')

/**
 * 只留下真正会被 JS 引擎执行的代码：脚本文件原样返回；HTML 只留 `<script>` 里的内联脚本；
 * 其余（css / md / json）整篇抹空。不这么做的话 `src/app/global.css` 的 `#root {` 会被当成
 * 类私有字段、`src/index.html` 的 HTML 注释会被当成代码 —— 都是本轮真踩到的假阳性。
 *
 * @param {string} file 仓库相对 POSIX 路径
 * @param {string} text 文件原文
 * @returns {string} 与入参等长的可审计文本
 */
export const maskToScript = (file, text) => {
  if (SCRIPT_FILE.test(file)) return text
  if (!HTML_FILE.test(file)) return blank(text)
  const pattern = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi
  let out = ''
  let cursor = 0
  let matched = pattern.exec(text)
  while (matched) {
    const openEnd = matched.index + matched[0].indexOf('>') + 1
    const inner = matched[1] ?? ''
    out += blank(text.slice(cursor, openEnd)) + inner
    out += blank(text.slice(openEnd + inner.length, matched.index + matched[0].length))
    cursor = matched.index + matched[0].length
    matched = pattern.exec(text)
  }
  return out + blank(text.slice(cursor))
}

/** 判定单条命中：三条规则，别在这里加例外 —— 例外要进 docs/capabilities/api.md 说明 */
export const classifyHit = (rule, file) => {
  const covered = rule.firstSupported > BASELINE_CHROME && ENTRY_POLYFILLED.includes(rule.api.split(' / ')[0])
  if (rule.firstSupported <= BASELINE_CHROME) {
    return { covered: false, verdict: 'baseline' }
  }
  if (file.startsWith(POLYFILL_DIR)) {
    // polyfill 自己的实现文件：这里写的是「定义」，天然算已兜底
    return { covered: true, verdict: 'entry-polyfill' }
  }
  return { covered, verdict: covered ? 'entry-polyfill' : 'uncovered' }
}

/**
 * 审计一批源文件。
 *
 * @param {Array<{path: string, text: string}>} files 路径用仓库相对 POSIX 写法
 * @returns {{filesScanned: number, hits: Array<{file: string, line: number, api: string, firstSupported: number, covered: boolean, verdict: string}>}}
 */
export const auditApiAssumptions = (files) => {
  const hits = []
  for (const file of files) {
    const masked = maskLiteralsAndComments(maskToScript(file.path, file.text))
    for (const rule of API_RULES) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)
      let matched = pattern.exec(masked)
      while (matched) {
        const { covered, verdict } = classifyHit(rule, file.path)
        hits.push({
          file: file.path,
          line: lineOf(masked, matched.index),
          api: rule.api,
          firstSupported: rule.firstSupported,
          covered,
          verdict,
        })
        matched = pattern.exec(masked)
      }
    }
  }
  hits.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  return { filesScanned: files.length, hits }
}

/**
 * 汇总（文档的「按 API 命中统计」表与「按类别合计」都从它出，不许手写数字）。
 *
 * @param {{filesScanned: number, hits: Array<object>}} result auditApiAssumptions 的返回
 * @returns {{filesScanned: number, total: number, byVerdict: Record<string, number>, byApi: Array<object>}}
 */
export const summarize = (result) => {
  const byVerdict = { baseline: 0, 'entry-polyfill': 0, uncovered: 0 }
  const buckets = new Map()
  for (const hit of result.hits) {
    byVerdict[hit.verdict] = (byVerdict[hit.verdict] ?? 0) + 1
    const key = hit.api
    const bucket = buckets.get(key) ?? {
      api: hit.api,
      firstSupported: hit.firstSupported,
      covered: hit.covered,
      verdict: hit.verdict,
      count: 0,
      files: new Set(),
    }
    bucket.count += 1
    bucket.files.add(hit.file)
    buckets.set(key, bucket)
  }
  const byApi = [...buckets.values()]
    .map((bucket) => ({ ...bucket, files: [...bucket.files].sort() }))
    .sort((a, b) => (b.count === a.count ? a.api.localeCompare(b.api) : b.count - a.count))
  return {
    filesScanned: result.filesScanned,
    total: result.hits.length,
    byVerdict,
    byApi,
  }
}

export { ENTRY_POLYFILLED as ENTRY_POLYFILL_KEYS }

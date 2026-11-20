#!/usr/bin/env node
// 产物语法/DOM 单位下限检查（GitHub issue #13「低内核白屏」）。
//
//   node scripts/check-bundle-syntax.mjs            # 默认检查 dist/
//   node scripts/check-bundle-syntax.mjs dist-xxx   # 检查别的产物目录
//   npm run check:legacy                            # 同上（release 前跑）
//
// 背景：Android WebView 版本跟系统镜像走，Android 11 出厂镜像停在 Chromium 83。构建 target
// 一旦被改回去（或某个第三方依赖带进更新的语法 / API），低内核用户就是整包解析失败或运行时
// TypeError = 静默白屏，而且这类问题在 Chrome/Playwright 上永远测不出来。所以要在产物层面卡死下限。
//
// 检查分三层：
//   1) 词法层：先把字符串/模板/正则/注释剥成空格（保持长度与换行），再找
//      ES2021+ 才有的语法记号。剥字面量是必须的 —— prismjs 的语言定义里就有一条
//      /--|\+\+|\*\*=?|=>|&&=?|\|\|=?|…/ 正则，直接 grep '&&=' 必然误报。
//      剥离边界必须来自 acorn 的 AST（issue #156）：手写状态机在正则密集的压缩 chunk 上会把
//      成片真实代码当成字面量吃掉，运行时 API 层跟着漏报（假绿）。
//   2) 语法层：用 acorn 真解析每个文件，AST 里断言没有逻辑赋值 / 类静态块 / 私有类成员，并给出精确行列。
//      仓库没把 acorn 列进 devDependencies（它是 @rspack 的传递依赖），但 1) 的剥离边界也来自它的
//      AST，所以 acorn 拿不到时 **整条检查明确失败**（AcornUnavailableError / CLI exit 2），
//      不存在「退化成只有词法层、然后假绿」这条路。
//   3) 运行时 API 层（issue #39）：1)、2) 只管语法，`s.replaceAll('/','-')` 这种**内置 API 缺失**
//      它们完全无感。这一层扫产物里出现的、Chrome 83 没有的内置 API，再去入口脚本里找
//      legacy polyfill 标记；没补上就阻断。
//
// CSS 一并检查：dvh（Chrome 108+）必须带 vh 回退，否则低内核上弹层高度直接失效。
//
// ## 覆盖范围（issue #480 集成轮补齐的真实缺口）
//
// 扫的是**产物目录下全部 `*.js`**，不只是入口 chunk：
//
// | 位置 | 是什么 | 怎么加载 |
// | --- | --- | --- |
// | `dist/static/js/**` | 打包器产物（入口 main + `async/*` 懒加载 chunk） | index.html / 动态 import |
// | `dist/static/pdfjs/**` | 第三方经典脚本（`pdfjs-dist` 的 `pdf.min.js` / `pdf.worker.min.js`） | 运行期插入 `<script src>` |
//
// 旧实现只扫 `static/js`，于是 `static/pdfjs/` 这两份**从来没被这道门量过** —— rpm 的
// `rspack.config.ts` 把 pdfjs 拷到 `static/pdfjs/` 时写的理由就是「避开语法门禁」，等于
// 自己给自己开了一张免检单（#480 的 pdfjs 是 1.3 MB 运行期脚本，低内核白屏一样致命）。
// 现在两份一起扫，并按来源分开报数：`bundled` 与 `vendored`。
//
// ## 门禁语义：**Chromium 83 的能力集**，不是「ES2017 规范」
//
// 判据是「这份产物在 WebView 83 上能不能被解析 / 能不能跑」，不是「写法是否超越某个 ES 版本」：
// - **语法**：只禁 Chrome 83 解析不了的那几样（ES2021 逻辑赋值 / ES2022 类静态块 /
//   私有类方法）——**能力集里的白名单式放行**，不是按年份卡规范；
//   因此 `?.` / `??`（Chrome 80）**不需要单独放行**，它们本来就在 83 的能力集里，
//   实测 pdfjs 也确实在用（`legacy/build` 打的就是「Chrome 79+」这一档）；
// - **运行时 API**：Chrome 83 没有的内置 API 要么被 `src/polyfills/legacy.ts` 补上
//   （产物里能查到 polyfill 标记），要么整份产物判红。
//
// `VENDORED_SYNTAX_ALLOWANCES` 是给「第三方经典脚本确实用到了 83 能力集里、但如果哪天
// 打包器/依赖升级把更激进的东西带进来」留的口子：显式登记「哪个文件允许哪种语法 + 为什么
// 83 能跑」。**现在是空的** —— 空 = 一份也不放行，这比写一堆 `if (file.includes('pdfjs'))` 安全。
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 逻辑赋值运算符：ES2021，Chrome 85 才有；WebView 83 上是一个 SyntaxError */
const LOGICAL_ASSIGNMENT = ['||=', '&&=', '??=']

/** 词法层的禁用记号（附带人话原因，命中时直接打进报告） */
const FORBIDDEN_PATTERNS = [
  { kind: 'logical-assignment', test: (stripped) => hitsOf(stripped, LOGICAL_ASSIGNMENT) },
  {
    kind: 'class-static-block',
    test: (stripped) => patternHits(stripped, /static\s*\{/g, 'static {'),
  },
]
// 私有类「字段」（static #x = 1 / #x = 1）Chrome 74 就支持，WebView 83 没问题，不在这里卡；
// 私有类「方法 / 访问器」（#m(){} / get #x(){}）是 Chrome 84，只能在 AST 层分辨（见 findForbiddenAst）。

const WHY = {
  'logical-assignment': '逻辑赋值（ES2021 / Chrome 85）',
  'class-static-block': '类静态初始化块（ES2022 / Chrome 94）',
  'private-class-member': '私有类方法/访问器（ES2022 / Chrome 84）',
}

const hitsOf = (stripped, tokens) => {
  const hits = []
  for (const token of tokens) {
    let index = stripped.indexOf(token)
    while (index >= 0) {
      hits.push({ token, index })
      index = stripped.indexOf(token, index + token.length)
    }
  }
  return hits
}

const patternHits = (stripped, pattern, label) => {
  const hits = []
  pattern.lastIndex = 0
  let match = pattern.exec(stripped)
  while (match) {
    hits.push({ token: label, index: match.index })
    pattern.lastIndex = match.index + match[0].length
    match = pattern.exec(stripped)
  }
  return hits
}

/* ── 字面量遮蔽（issue #156：边界只信 AST，不再手写状态机） ────────────────────
 *
 * 契约：stripLiterals(code) 返回与原文**等长、换行位置不变**的字符串；
 * 字符串 / 模板片段 / 正则字面量 / 注释的内容一律换成空格，真实代码（标识符、成员访问、
 * 点号、括号、运算符）原样保留。等长是为了让 positionOf() 能直接回算原文行列。
 *
 * 为什么不再手写状态机：压缩 chunk 里 '/' 既可能是正则也可能是除号，手写规则表一旦猜错，
 * 后面成片的真实代码就被当成字面量吃掉（实测 main 包 10 691 段、单段最长 9 338 字符），
 * 于是 Intl.Segmenter / Object.fromEntries / structuredClone 这类**真实调用点**在词法与
 * 运行时 API 层一起消失，check:legacy 假绿。AST 不需要猜：解析器自己知道哪里是字面量。
 */

/**
 * acorn 拿不到时的显式失败。绝不退回手写状态机 —— 那正是 issue #156 的假绿来源。
 * CLI 在 main() 里提前拦一次（exit 2 + 人话提示），这里是给库调用方（测试、matrix-scan）用的。
 */
export class AcornUnavailableError extends Error {
  constructor() {
    super(
      'acorn 不可用：无法做 AST 级字面量剥离。手写状态机在压缩 chunk 上会误吞真实代码（issue #156），' +
        '所以这里不再降级，直接失败。修复：pnpm install（acorn 是 @rspack 的传递依赖）'
    )
    this.name = 'AcornUnavailableError'
    this.code = 'ACORN_UNAVAILABLE'
  }
}

/** 解析缓存：同一份产物代码在一次运行里会被词法层 / 语法层 / 运行时 API 层各问一遍，只解析一次 */
const PARSE_CACHE = new Map()
const PARSE_CACHE_LIMIT = 16

/**
 * 用 acorn 解析一次产物代码并缓存（含注释区间）。
 * ecmaVersion 2022 + sourceType script 与语法层完全一致：能通过解析的文件，遮蔽口径和
 * 语法层口径必须来自同一次解析，否则两层会打架。
 */
const parseBundle = (code) => {
  const acorn = loadAcorn()
  if (!acorn) throw new AcornUnavailableError()
  const cached = PARSE_CACHE.get(code)
  if (cached) return cached
  const comments = []
  let result
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowHashBang: true,
      locations: true,
      onComment: (block, text, start, end) => comments.push([start, end]),
    })
    result = { ok: true, ast, comments, version: acorn.version, error: null }
  } catch (error) {
    result = { ok: false, ast: null, comments: [], version: acorn.version, error }
  }
  if (PARSE_CACHE.size >= PARSE_CACHE_LIMIT) PARSE_CACHE.delete(PARSE_CACHE.keys().next().value)
  PARSE_CACHE.set(code, result)
  return result
}

/** AST 里所有「内容不该被 grep 看到」的区间：字符串/正则字面量、模板片段、注释 */
const collectMaskRanges = (ast, comments) => {
  const ranges = comments.map(([start, end]) => [start, end])
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Literal') {
      // 数字 / 布尔 / null 里不可能藏语法记号或 API 名，只有字符串和正则需要抹
      if (node.regex || typeof node.value === 'string') ranges.push([node.start, node.end])
    } else if (node.type === 'TemplateElement') {
      ranges.push([node.start, node.end])
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') walk(item)
      } else if (child && typeof child.type === 'string') walk(child)
    }
  }
  walk(ast)
  return ranges
}

/**
 * 把字符串/模板/正则/注释的内容替换成空格（长度与换行保持不变，便于回算行列）。
 * 只抹 AST 认出来的字面量边界：标识符、成员访问（Intl.Segmenter、.replaceAll( …）不会被碰到。
 *
 * 解析不了的文件（理论上产物都该能解析）：**整份不遮蔽**。这样字符串/注释里的同名文本会多报
 * （假红），但绝不会少报（假绿）；而且这份文件本身已经会被语法层报 parse-error 扣红。
 */
/**
 * 遮蔽结果缓存（#366）：词法层（findForbiddenSyntax）与运行时 API 层（checkRuntimeApis）会对
 * **同一份**产物代码各问一遍 stripLiterals，而剥离要遍历 AST 区间 + 逐字符重写，是这三层里最贵的
 * 一步。之前每次重算 = 全量产物被剥两遍。缓存只存「剥好的字符串」（约等于源码大小，90 个文件
 * 合计数 MB），不像 AST 那样吃内存，所以上限可以比 PARSE_CACHE 大得多。
 */
const STRIP_CACHE = new Map()
const STRIP_CACHE_LIMIT = 256

export const stripLiterals = (code) => {
  const cached = STRIP_CACHE.get(code)
  if (cached !== undefined) {
    return cached
  }
  const stripped = stripUncached(code)
  if (STRIP_CACHE.size >= STRIP_CACHE_LIMIT) STRIP_CACHE.delete(STRIP_CACHE.keys().next().value)
  STRIP_CACHE.set(code, stripped)
  return stripped
}

const stripUncached = (code) => {
  const parsed = parseBundle(code)
  if (!parsed.ok) return code
  const out = code.split('')
  for (const [start, end] of collectMaskRanges(parsed.ast, parsed.comments)) {
    for (let index = start; index < end && index < out.length; index += 1) {
      if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' '
    }
  }
  return out.join('')
}

export const positionOf = (code, index) => {
  const upto = code.slice(0, index)
  const line = upto.split('\n').length
  const column = index - (upto.lastIndexOf('\n') + 1) + 1
  return { line, column }
}

/** 词法层：返回 [{kind, why, token, line, column}] */
export const findForbiddenSyntax = (code) => {
  const stripped = stripLiterals(code)
  const findings = []
  for (const { kind, test } of FORBIDDEN_PATTERNS) {
    for (const hit of test(stripped)) {
      const { line, column } = positionOf(stripped, hit.index)
      findings.push({ kind, why: WHY[kind], token: hit.token, line, column })
    }
  }
  return findings
}

/** 语法层：AST 里断言没有低内核解析不了的节点。返回 {version, findings} 或 null（没有 acorn） */
export const findForbiddenAst = (code) => {
  const acorn = loadAcorn()
  if (!acorn) return null
  // 与 stripLiterals 共用同一次解析（ecmaVersion 2022 才能解析类字段，Chrome 72 起就支持，
  // 属于允许范围；禁用项由下面的 AST 断言逐个卡，不靠 parser 版本号兜）
  const parsed = parseBundle(code)
  if (!parsed.ok) {
    return {
      version: parsed.version,
      findings: [
        {
          kind: 'parse-error',
          why: '产品文件无法解析',
          token: parsed.error.message,
          line: 0,
          column: 0,
        },
      ],
    }
  }
  const ast = parsed.ast
  const findings = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (typeof node.type === 'string') {
      if (node.type === 'AssignmentExpression' && LOGICAL_ASSIGNMENT.includes(node.operator)) {
        findings.push({
          kind: 'logical-assignment',
          why: WHY['logical-assignment'],
          token: node.operator,
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
        })
      }
      if (node.type === 'StaticBlock') {
        findings.push({
          kind: 'class-static-block',
          why: WHY['class-static-block'],
          token: 'static {',
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
        })
      }
      const key = node.key
      const privateKey = key && key.type === 'PrivateIdentifier'
      const isMethod = node.type === 'MethodDefinition'
      const isAccessor =
        node.type === 'PropertyDefinition' && (node.kind === 'get' || node.kind === 'set')
      if (privateKey && (isMethod || isAccessor)) {
        findings.push({
          kind: 'private-class-member',
          why: WHY['private-class-member'],
          token: '#' + key.name,
          line: node.loc.start.line,
          column: node.loc.start.column + 1,
        })
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range') continue
      walk(node[key])
    }
  }
  walk(ast)
  return { version: acorn.version, findings }
}

let acornCache
/** acorn 是 @rspack 的传递依赖，不在 package.json 里；按 pnpm 的落盘位置找一遍 */
export const loadAcorn = () => {
  if (acornCache !== undefined) return acornCache
  acornCache = null
  const require = createRequire(import.meta.url)
  const candidates = []
  try {
    candidates.push(require.resolve('acorn'))
  } catch {
    /* 不是直接依赖，继续找 pnpm store */
  }
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
  try {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith('acorn@'))
        candidates.push(path.join(pnpmDir, entry, 'node_modules', 'acorn'))
    }
  } catch {
    /* 没有 pnpm store（npm/yarn 安装）时忽略 */
  }
  for (const candidate of candidates) {
    try {
      acornCache = require(candidate)
      return acornCache
    } catch {
      /* 试下一个 */
    }
  }
  return acornCache
}

/** 打包器产物目录（相对产物根）：入口 main 与 `async/*` 懒加载 chunk 都在这里 */
const BUNDLED_DIR = path.join('static', 'js')

/**
 * vendored（第三方经典脚本）语法放行表：**当前为空**。
 *
 * 形状：`{ file: 'static/pdfjs/pdf.min.js', kind: 'optional-chaining', why: '…' }`。
 * 立表的原则：只有当某个第三方产物用到了「Chromium 83 支持、但本门禁的禁用清单误伤」的语法时
 * 才登记，并在 `why` 里写清「83 为什么能跑」（引 caniuse / Chrome 版本）。**按文件登记**，
 * 不许写「整个 static/pdfjs 免检」这种整目录豁免 —— 那又变成免检单。
 *
 * 现在空着是因为实测不需要：`pdf.min.js` / `pdf.worker.min.js`（pdfjs-dist legacy build）
 * 在词法层与 AST 层都是 0 违规（`?.` / `??` 属于 ES2020，Chrome 80 就有，本门禁本来就不禁）。
 */
const VENDORED_SYNTAX_ALLOWANCES = []

/** 按来源把产物 JS 分开：打包器产物 vs vendored 经典脚本 */
const partitionJsFiles = (distDir, files) => {
  const bundled = []
  const vendored = []
  for (const file of files) {
    const relative = path.relative(distDir, file)
    if (relative.startsWith(BUNDLED_DIR + path.sep)) bundled.push(file)
    else vendored.push(file)
  }
  return { bundled, vendored }
}

/**
 * 套用 vendored 放行表：只滤掉登记过的 (文件, 违规类型)。
 * 未登记的一律保留 —— 放行是白名单，不是「vendored 就放行」。
 */
const applyVendoredAllowances = (distDir, findings) => {
  if (VENDORED_SYNTAX_ALLOWANCES.length === 0) {
    return findings
  }
  const allow = new Set(
    VENDORED_SYNTAX_ALLOWANCES.map(
      (entry) => `${path.join(distDir, entry.file)}::${entry.kind}`
    )
  )
  return findings.filter((finding) => !allow.has(`${path.resolve(ROOT, finding.file)}::${finding.kind}`))
}

const walkFiles = (dir, suffix, accumulator = []) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return accumulator
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, suffix, accumulator)
    else if (entry.name.endsWith(suffix)) accumulator.push(full)
  }
  return accumulator
}

/** 检查一堆 JS 文件。返回 {files, lexical, ast, acornVersion} */
export const checkJavaScript = (files) => {
  const lexical = []
  const ast = []
  let acornVersion = null
  for (const file of files) {
    const code = readFileSync(file, 'utf8')
    const relative = path.relative(ROOT, file).split(path.sep).join('/')
    for (const finding of findForbiddenSyntax(code)) lexical.push({ file: relative, ...finding })
    const astResult = findForbiddenAst(code)
    if (astResult) {
      acornVersion = astResult.version
      for (const finding of astResult.findings) ast.push({ file: relative, ...finding })
    }
  }
  return { files: files.length, lexical, ast, acornVersion }
}

/** CSS：每个 dvh 都必须有同值的 vh 回退（顺序无所谓，浏览器只认最后一个能解析的） */
export const checkCssUnits = (files) => {
  const problems = []
  let dvhTotal = 0
  let fallbackTotal = 0
  for (const file of files) {
    const css = readFileSync(file, 'utf8')
    const relative = path.relative(ROOT, file).split(path.sep).join('/')
    const dvhValues = css.match(/\d+(?:\.\d+)?dvh/g) ?? []
    dvhTotal += dvhValues.length
    for (const value of dvhValues) {
      const fallback = value.replace(/dvh$/, 'vh').replace(/^(\d+(?:\.\d+)?)/, '$1')
      const expected = new RegExp(`${value.replace('.', '\\.')}\\b`)
      if (!expected.test(css)) problems.push({ file: relative, value, kind: 'unparsable-dvh' })
      const vhPattern = new RegExp(`(^|[^\\d.])${value.replace('dvh', 'vh')}(?![\\d.])`)
      if (!vhPattern.test(css)) {
        problems.push({ file: relative, value, kind: 'missing-vh-fallback', expected: fallback })
      } else {
        fallbackTotal += 1
      }
    }
  }
  return { dvhTotal, fallbackTotal, problems }
}

// ── 第三层：运行时 API 层（GitHub issue #39）──────────────────────────────────
//
// 上面两层只管**语法**：产物里没有 ||= / static {} 就算过。但 Chrome 83 缺的不只是语法，
// 还有一大票**内置 API**（String.prototype.replaceAll / Object.hasOwn / .at() / structuredClone …）——
// 语法检查器对 `s.replaceAll('/','-')` 完全无感，它在 WebView 83 上跑起来是
// `TypeError: s.replaceAll is not a function`，一个未捕获异常就把整屏 React 卸掉（issue #27 的白屏）。
//
// 所以这一层做**产物级 API 白名单扫描**：
//   1) 扫每个产物 JS（先剥掉字符串/注释，避免把文案里的 "replaceAll" 当成调用）；
//   2) 命中「Chrome 83 之后才有的内置 API」后，再去 dist/index.html 直接加载的入口脚本里找
//      legacy polyfill 的标记（__DEEPSEEK_LEGACY_POLYFILL__）；
//   3) 补了 → 合规（main 上业务代码本来就保留裸调用，靠 polyfill 兜，见 issue #39 第 4 条）；
//      没补 → 阻断，因为低内核必白屏。

/** polyfill 装没装上的标记，与 src/polyfills/legacy.ts 的 LEGACY_POLYFILL_FLAG 必须一致 */
export const POLYFILL_FLAG = '__DEEPSEEK_LEGACY_POLYFILL__'

/**
 * 目标运行时（Chromium 83）之后才有的内置 API。
 *
 * `covered` 表示 src/polyfills/legacy.ts 是否**真的**补了它：
 *   - true  → 允许裸调用，但产物里必须能在入口脚本找到 polyfill 标记；
 *   - false → 没有补丁覆盖，产物里出现就是必拦（例如 Promise.any / AggregateError，Chrome 85，
 *             legacy.ts 至今没补，低内核上必 TypeError）。
 * 改这张表时同步核对 legacy.ts 的 define(...) 清单，别凭印象写。
 */
const LEGACY_RUNTIME_APIS = [
  // JS 补丁覆盖（legacy.ts 的 define 清单）
  {
    id: 'object-hasOwn',
    api: 'Object.hasOwn',
    chrome: 93,
    covered: true,
    pattern: /Object\.hasOwn\s*\(/g,
  },
  {
    id: 'prototype-at',
    api: 'Array/String.prototype.at',
    chrome: 92,
    covered: true,
    pattern: /\.at\s*\(/g,
  },
  {
    id: 'array-findLast',
    api: 'Array.prototype.findLast',
    chrome: 97,
    covered: true,
    pattern: /\.findLast\s*\(/g,
  },
  {
    id: 'array-findLastIndex',
    api: 'Array.prototype.findLastIndex',
    chrome: 97,
    covered: true,
    pattern: /\.findLastIndex\s*\(/g,
  },
  {
    id: 'array-toSorted',
    api: 'Array.prototype.toSorted',
    chrome: 110,
    covered: true,
    pattern: /\.toSorted\s*\(/g,
  },
  {
    id: 'array-toReversed',
    api: 'Array.prototype.toReversed',
    chrome: 110,
    covered: true,
    pattern: /\.toReversed\s*\(/g,
  },
  {
    id: 'array-toSpliced',
    api: 'Array.prototype.toSpliced',
    chrome: 110,
    covered: true,
    pattern: /\.toSpliced\s*\(/g,
  },
  {
    id: 'array-with',
    api: 'Array.prototype.with',
    chrome: 110,
    covered: true,
    pattern: /\.with\s*\(/g,
  },
  {
    id: 'structuredClone',
    api: 'structuredClone',
    chrome: 98,
    covered: true,
    pattern: /structuredClone\s*\(/g,
  },
  {
    id: 'crypto-randomUUID',
    api: 'crypto.randomUUID',
    chrome: 92,
    covered: true,
    pattern: /crypto\s*\.\s*randomUUID\s*\(/g,
  },
  {
    // issue #167：src 里没人直接调，但 mermaid 的标签换行带进来（chunk-62K37W7T.mjs）：
    // 有 Intl.Segmenter 就按字素簇切，没有就退回 [...text] 按码点切。legacy.ts 补了。
    id: 'intl-segmenter',
    api: 'Intl.Segmenter',
    chrome: 87,
    covered: true,
    pattern: /Intl\.Segmenter\b/g,
  },
  {
    // issue #79：src 里没人直接调，但第三方依赖（数学/mermaid 那条链）的 async chunk 带进来
    // 三十来处裸调用，WebView 83 上必白屏 —— legacy.ts 补了，这里跟着改成已覆盖。
    id: 'string-replaceAll',
    api: 'String.prototype.replaceAll',
    chrome: 85,
    covered: true,
    pattern: /\.replaceAll\s*\(/g,
  },
  // 没有补丁覆盖：出现即拦
  // 注意：Array.prototype.group 故意不列。它最终以 Object.groupBy 发布（Chrome 117），`.group(` 在
  // 真实产物里更可能命中第三方库的自定义方法（例如 d3.group 写成 `d3.group(...)`），误报会随依赖升级
  // 随机把发布门禁打红。这张表只收「名字足够独特、不可能是同名自定义方法」的 API。
  {
    id: 'object-groupBy',
    api: 'Object.groupBy',
    chrome: 117,
    covered: false,
    pattern: /Object\.groupBy\s*\(/g,
  },
  {
    id: 'promise-any',
    api: 'Promise.any',
    chrome: 85,
    covered: false,
    pattern: /Promise\.any\s*\(/g,
  },
  {
    id: 'aggregate-error',
    api: 'AggregateError',
    chrome: 85,
    covered: false,
    pattern: /new\s+AggregateError\s*\(/g,
  },
]

/** 扫产物里出现的「目标运行时没有的内置 API」。返回 [{id, api, chrome, covered, token, line, column}] */
export const findLegacyRuntimeApis = (code) => {
  const stripped = stripLiterals(code)
  const hits = []
  for (const entry of LEGACY_RUNTIME_APIS) {
    entry.pattern.lastIndex = 0
    let match = entry.pattern.exec(stripped)
    while (match) {
      const { line, column } = positionOf(stripped, match.index)
      hits.push({
        id: entry.id,
        api: entry.api,
        chrome: entry.chrome,
        covered: entry.covered,
        token: match[0].trim(),
        line,
        column,
      })
      entry.pattern.lastIndex = match.index + match[0].length
      match = entry.pattern.exec(stripped)
    }
  }
  return hits
}

/** dist/index.html 里 <script src> 直接加载的脚本（相对产物目录）。没有 index.html 返回 null */
export const readEntryScripts = (distDir) => {
  let html
  try {
    html = readFileSync(path.join(distDir, 'index.html'), 'utf8')
  } catch {
    return null
  }
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(
    (match) => match[1].replace(/^\.?\//, '').split('?')[0]
  )
}

/**
 * 运行时 API 层判定。
 * 返回 { usage, violations, entryScripts, polyfillInEntries, polyfillFiles }
 */
export const checkRuntimeApis = (distDir, jsFiles) => {
  const usage = []
  for (const file of jsFiles) {
    const code = readFileSync(file, 'utf8')
    const relative = path.relative(ROOT, file).split(path.sep).join('/')
    for (const hit of findLegacyRuntimeApis(code)) usage.push({ file: relative, ...hit })
  }

  // polyfill 落在哪个产物文件里（标记是字符串字面量，必须查原文，不能查剥过字面量的代码）
  const polyfillFiles = []
  const codeByFile = new Map()
  for (const file of jsFiles) {
    const code = readFileSync(file, 'utf8')
    codeByFile.set(file, code)
    if (code.includes(POLYFILL_FLAG)) polyfillFiles.push(file)
  }

  const entryScripts = readEntryScripts(distDir)
  const polyfillInEntries = (entryScripts ?? []).filter((src) => {
    const code = codeByFile.get(path.resolve(distDir, src))
    return code !== undefined && code.includes(POLYFILL_FLAG)
  })

  const violations = []
  for (const hit of usage) {
    if (!hit.covered) {
      violations.push({
        ...hit,
        reason: `${hit.api} 是 Chrome ${hit.chrome}+ 才有的，src/polyfills/legacy.ts 没有补丁覆盖`,
      })
      continue
    }
    if (entryScripts === null) {
      violations.push({ ...hit, reason: `产物缺少 index.html，无法确认 polyfill 是否在入口脚本里` })
      continue
    }
    if (polyfillInEntries.length === 0) {
      const where = polyfillFiles.length
        ? `polyfill 只在 ${polyfillFiles.map((file) => path.relative(ROOT, file).split(path.sep).join('/')).join(', ')}，不在入口脚本里（懒加载 chunk 里补等于没补）`
        : '产物里根本没有 polyfill 标记'
      violations.push({ ...hit, reason: `${hit.api} 需要 polyfill，但${where}` })
    }
  }

  return {
    usage,
    violations,
    entryScripts,
    polyfillInEntries: polyfillInEntries.map((src) =>
      path.relative(ROOT, path.resolve(distDir, src)).split(path.sep).join('/')
    ),
    polyfillFiles: polyfillFiles.map((file) => path.relative(ROOT, file).split(path.sep).join('/')),
  }
}

/** 同一 (file, id) 只报一次，行号取第一次出现 —— 产物里 replaceAll 常有几十处，别刷屏 */
const summarizeRuntimeUsage = (usage) => {
  const grouped = new Map()
  for (const hit of usage) {
    const key = `${hit.file}::${hit.id}`
    const existing = grouped.get(key)
    if (existing) existing.count += 1
    else grouped.set(key, { ...hit, count: 1 })
  }
  return [...grouped.values()].sort((a, b) => (a.file === b.file ? 0 : a.file < b.file ? -1 : 1))
}

const formatFindings = (findings) =>
  findings
    .map(
      (finding) =>
        `  ✗ ${finding.file}:${finding.line}:${finding.column} ${finding.kind}（${finding.why}）${finding.token ? ` ${finding.token}` : ''}`
    )
    .join('\n')

const main = () => {
  // issue #156：词法层的遮蔽边界来自 acorn 的 AST，语法层也要 acorn。拿不到就明确失败退出，
  // 不给「只剩词法层然后假绿」这条路（exit 2 = 环境不具备检查能力，与「产物不合格」区分开）。
  if (!loadAcorn()) {
    console.error('✗ 找不到 acorn：无法做 AST 级字面量剥离 + 语法解析，本次检查不成立（issue #156）')
    console.error('  以前这里会自动退化成手写状态机，而它在压缩 chunk 上会误吞真实代码、把违规查成合格，')
    console.error('  所以现在一律判失败，绝不静默降级。')
    console.error('  修复：pnpm install（acorn 是 @rspack 的传递依赖，不在 package.json 里）')
    process.exit(2)
  }
  const distDir = path.resolve(ROOT, process.argv[2] ?? 'dist')
  const bundledFiles = walkFiles(path.join(distDir, 'static', 'js'), '.js')
  const cssFiles = walkFiles(path.join(distDir, 'static', 'css'), '.css')
  if (bundledFiles.length === 0) {
    console.error(`没有找到产物：${path.relative(ROOT, distDir)}/static/js（先 npm run build）`)
    process.exit(2)
  }
  /**
   * 覆盖范围（#480）：**产物目录下全部 `*.js`**。
   * 旧实现只扫 `static/js`，把 `static/pdfjs/`（pdfjs 的经典脚本，运行期 `<script src>` 加载）
   * 整块漏在外面 —— 门禁对 pdfjs 等于不存在。懒加载 chunk（`static/js/async/*`）本来就在
   * `static/js` 里、一直是覆盖的；真正漏的只有 vendored 目录，这里一并扫进来并分开报数。
   */
  const jsFiles = partitionJsFiles(distDir, walkFiles(distDir, '.js'))
  const allJsFiles = [...jsFiles.bundled, ...jsFiles.vendored]
  const js = checkJavaScript(allJsFiles)
  const css = checkCssUnits(cssFiles)
  const runtime = checkRuntimeApis(distDir, allJsFiles)
  // vendored 放行表（当前为空）：只滤掉登记过的项，其余照旧判红
  js.lexical = applyVendoredAllowances(distDir, js.lexical)
  js.ast = applyVendoredAllowances(distDir, js.ast)
  const vendoredNames = jsFiles.vendored.map(
    (file) => path.relative(distDir, file).split(path.sep).join('/')
  )
  console.log(`产物兼容性检查（语法 + 运行时 API）：${path.relative(ROOT, distDir) || '.'}`)
  console.log(
    `  扫描范围：全部 *.js 共 ${js.files} 个（打包产物 ${jsFiles.bundled.length} 个含懒加载 chunk` +
      `${vendoredNames.length ? ` + vendored 经典脚本 ${vendoredNames.length} 个：${vendoredNames.join(', ')}` : ''}）`
  )
  console.log(
    `  语法：词法层违规 ${js.lexical.length} 个；AST 层违规 ${js.ast.length} 个（acorn ${js.acornVersion ?? '缺失'}, ecmaVersion 2022 + 禁用项断言；字面量遮蔽 = acorn AST 边界）`,
  )
  console.log(
    `  dvh 声明 ${css.dvhTotal} 处；带 vh 回退 ${css.fallbackTotal} 处；问题 ${css.problems.length} 个`
  )
  const usageSummary = summarizeRuntimeUsage(runtime.usage)
  console.log(
    `  运行时 API：命中 Chrome 83 缺的内置 API ${runtime.usage.length} 处（${usageSummary.length} 个文件/API 组合）；违规 ${runtime.violations.length} 个；polyfill 标记 ${runtime.polyfillFiles.length ? '已打进产物' : '不在产物里'}${runtime.entryScripts === null ? '（缺 index.html）' : `，入口脚本命中 ${runtime.polyfillInEntries.length}/${runtime.entryScripts.length}`}`
  )
  const fails = js.lexical.length + js.ast.length + css.problems.length + runtime.violations.length
  if (js.lexical.length) console.log(formatFindings(js.lexical))
  if (js.ast.length) console.log(formatFindings(js.ast))
  for (const problem of css.problems)
    console.log(`  ✗ ${problem.file} ${problem.value}（${problem.kind}）`)
  if (usageSummary.length && !runtime.violations.length) {
    console.log('  运行时 API 清单（有 polyfill 兜底，记录不阻断）：')
    for (const hit of usageSummary)
      console.log(`    · ${hit.file}:${hit.line} ${hit.api}（Chrome ${hit.chrome}+）×${hit.count}`)
  }
  for (const violation of runtime.violations)
    console.log(
      `  ✗ ${violation.file}:${violation.line}:${violation.column} ${violation.id}（${violation.reason}）${violation.token}`
    )
  if (fails) {
    const parts = []
    if (js.lexical.length + js.ast.length) parts.push('Chrome 83 解析不了的语法（issue #13）')
    if (css.problems.length) parts.push('无 vh 回退的 dvh')
    if (runtime.violations.length) parts.push('Chrome 83 没有、产物里也没补的内置 API（issue #39）')
    console.error(`\n结论：不合格 —— 产物里有 ${parts.join(' + ')}，低内核上会白屏`)
    process.exit(1)
  }
  console.log(
    '\n结论：合格 —— 全部产物（含懒加载 chunk 与 vendored 经典脚本）落在 Chromium 83 能力集内' +
      '（无 83 解析不了的语法 / 无 dvh 裸用 / 内置 API 有 polyfill 兜底）'
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

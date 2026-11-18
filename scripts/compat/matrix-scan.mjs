#!/usr/bin/env node
/**
 * 静态兼容矩阵扫描器（GitHub issue #143「静态兼容矩阵」分支）
 *
 * 目的：不开模拟器、不上真机，只用**语法解析 + API 探针**回答一个问题 ——
 * 「WebView 79 / 83 / 91 / 109 分别会在哪一层挂：整包白屏，还是掉功能？」
 *
 * 它不是另一套检查器，是 scripts/check-bundle-syntax.mjs（pnpm run check:legacy）的**扩展**：
 * 复用那边的 acorn 加载（loadAcorn）、字面量剥离（stripLiterals）、位置换算（positionOf）、
 * polyfill 标记（POLYFILL_FLAG）与入口脚本读取（readEntryScripts）。
 * check:legacy 回答「有没有越过 Chrome 83 这条线」（二值：合格 / 不合格）；
 * 这里回答「每个产物文件的最低 ES 版本是多少、对应哪个 Chromium、四个档位各挂在哪一层」。
 *
 * 输出四层：
 *   1. 语法层：每个 .js 用 acorn 从 ES5 逐级升到 ES2022 试解析，记录最低通过版本 + 首个卡住的语法点；
 *   2. API 层：内置 API **调用点**（不是定义点）→ 最低 Chromium → 有 polyfill 兜底 / 裸调无兜底；
 *   3. CSS 层：dvh/svh/lvh、flex gap、:has()、color-mix()、@container、inset → 最低 Chromium + 有没有回退；
 *   4. 结论层：四档 WebView 逐层判定（入口解析 / 异步 chunk 解析 / 启动期裸 API / CSS 降级）。
 *
 * 边界（必须跟着结论一起读）：**这些全是静态推断，不是运行时验证**。
 *   - ES 语法 → Chromium 版本号取自各特性首次落地的 Chromium 版本（见 FEATURE_EVIDENCE 里的 MDN 链接）；
 *   - 「白屏」是按「入口包解析失败 → 整包不执行」推出来的，不是真机看到的；
 *   - 真机可能更差（内核厂商回移/剥离特性、WebView 被应用禁用等），也可能更好（OEM 升级了 WebView）。
 *
 * 用法：
 *   node scripts/compat/matrix-scan.mjs                 # 扫 ./dist
 *   node scripts/compat/matrix-scan.mjs <distDir>       # 扫指定产物目录
 *   node scripts/compat/matrix-scan.mjs <distDir> --json docs/compat/matrix/es-floor.json
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadAcorn,
  positionOf,
  stripLiterals,
  POLYFILL_FLAG,
  readEntryScripts,
} from '../check-bundle-syntax.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** acorn 的 ecmaVersion 阶梯（数字年份；5 是 ES5）。每个文件从低到高试，第一个通过的即语法下限 */
export const ES_LADDER = [5, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022]

/** 要回答的 WebView 档位（Android System WebView 跟系统镜像走，这四档覆盖 5.0~最新典型分布） */
export const WEBVIEW_TARGETS = [79, 83, 91, 109]

// ── 语法特性 → 最低 Chromium ────────────────────────────────────────────────
//
// 每条都给证据链接。判断口径：**该特性首次在 Chromium 稳定版可用**的版本号。
// 语法特性是「硬门槛」：低于它，整个脚本解析失败、一行都不执行（try/catch 抓不到）。
export const FEATURE_EVIDENCE = {
  'arrow-function': { chrome: 45, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Functions/Arrow_functions' },
  'let-const': { chrome: 49, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/let' },
  'class-declaration': { chrome: 49, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes' },
  'object-method': { chrome: 43, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Functions/Method_definitions' },
  'object-shorthand': { chrome: 43, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Object_initializer#property_definitions' },
  'computed-property': { chrome: 46, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Object_initializer#computed_property_names' },
  'regexp-flag-y': { chrome: 49, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/RegExp/sticky' },
  'regexp-flag-u': { chrome: 50, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/RegExp/unicode' },
  'regexp-flag-s': { chrome: 62, es: 2018, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/RegExp/dotAll' },
  'regexp-lookbehind': { chrome: 62, es: 2018, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Regular_expressions/Lookbehind_assertion' },
  'regexp-unicode-property': { chrome: 64, es: 2018, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Regular_expressions/Unicode_character_class_escape' },
  'template-literal': { chrome: 41, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Template_literals' },
  generator: { chrome: 39, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/function*' },
  'for-of': { chrome: 51, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/for...of' },
  'spread-call': { chrome: 46, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Spread_syntax' },
  'default-param': { chrome: 49, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Functions/Default_parameters' },
  destructuring: { chrome: 49, es: 2015, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Destructuring_assignment' },
  exponentiation: { chrome: 52, es: 2016, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Exponentiation' },
  'async-function': { chrome: 55, es: 2017, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/async_function' },
  'object-rest-spread': { chrome: 60, es: 2018, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Spread_syntax#spread_in_object_literals' },
  'for-await-of': { chrome: 63, es: 2018, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/for-await...of' },
  'regexp-named-group': { chrome: 64, es: 2018, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Regular_expressions/Named_capturing_group' },
  'optional-catch-binding': { chrome: 66, es: 2019, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/try...catch#optional_catch_binding' },
  'optional-chaining': { chrome: 80, es: 2020, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Optional_chaining' },
  'nullish-coalescing': { chrome: 80, es: 2020, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Nullish_coalescing' },
  'dynamic-import': { chrome: 63, es: 2020, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/import' },
  'bigint-literal': { chrome: 67, es: 2020, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/BigInt' },
  'logical-assignment': { chrome: 85, es: 2021, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/Logical_OR_assignment' },
  'numeric-separator': { chrome: 75, es: 2021, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Lexical_grammar#numeric_separators' },
  'class-field': { chrome: 72, es: 2022, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes/Public_class_fields' },
  'private-field': { chrome: 74, es: 2022, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes/Private_properties' },
  'private-method': { chrome: 84, es: 2022, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes/Private_properties#private_methods' },
  'private-in': { chrome: 91, es: 2022, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/in#private_in' },
  'class-static-block': { chrome: 94, es: 2022, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes/static_initialization_blocks' },
  'top-level-await': { chrome: 89, es: 2022, doc: 'https://developer.mozilla.org/docs/Web/JavaScript/Reference/Operators/await#top_level_await' },
}

/** 只有 ES 版本、没有解析到具体特性的兜底下限（取该版本最便宜特性的 Chromium 版本） */
const ES_BASELINE_CHROME = { 5: 4, 2015: 41, 2016: 52, 2017: 55, 2018: 60, 2019: 66, 2020: 63, 2021: 75, 2022: 72 }

// ── 运行时 API → 最低 Chromium ──────────────────────────────────────────────
//
// 与语法层不同，API 缺失是**运行期 TypeError**：能解析、能执行到那一行，然后抛。
// `polyfilled` 表示 src/polyfills/legacy.ts 真的补了它（补了也要产物入口里能找到 POLYFILL_FLAG 才算数）。
export const RUNTIME_APIS = [
  // issue #143 指定的探针清单（前 18 条）
  { id: 'fetch', api: 'fetch()', chrome: 42, pattern: /(?<![.\w$])fetch\s*\(/g },
  { id: 'abort-controller', api: 'AbortController', chrome: 66, pattern: /(?<![.\w$])AbortController\b/g },
  { id: 'readable-stream', api: 'ReadableStream', chrome: 43, pattern: /(?<![.\w$])ReadableStream\b/g },
  { id: 'text-decoder', api: 'TextDecoder', chrome: 38, pattern: /(?<![.\w$])TextDecoder\b/g },
  { id: 'promise-allsettled', api: 'Promise.allSettled', chrome: 76, pattern: /\.allSettled\s*\(/g },
  { id: 'object-fromentries', api: 'Object.fromEntries', chrome: 73, pattern: /Object\.fromEntries\s*\(/g },
  { id: 'string-replaceall', api: 'String.prototype.replaceAll', chrome: 85, pattern: /\.replaceAll\s*\(/g, polyfilled: true, polyfillKeys: ['String.prototype.replaceAll'] },
  { id: 'array-at', api: 'Array/String.prototype.at', chrome: 92, pattern: /\.at\s*\(/g, polyfilled: true, polyfillKeys: ['Array.prototype.at', 'String.prototype.at'] },
  { id: 'structured-clone', api: 'structuredClone', chrome: 98, pattern: /(?<![.\w$])structuredClone\s*\(/g, polyfilled: true, polyfillKeys: ['structuredClone'] },
  { id: 'weakref', api: 'WeakRef', chrome: 84, pattern: /(?<![.\w$])WeakRef\b/g },
  { id: 'intl-segmenter', api: 'Intl.Segmenter', chrome: 87, pattern: /Intl\.Segmenter\b/g },
  { id: 'intl-relativetimeformat', api: 'Intl.RelativeTimeFormat', chrome: 71, pattern: /Intl\.RelativeTimeFormat\b/g },
  { id: 'navigator-clipboard', api: 'navigator.clipboard', chrome: 66, pattern: /navigator\.clipboard\b/g },
  { id: 'resize-observer', api: 'ResizeObserver', chrome: 64, pattern: /(?<![.\w$])ResizeObserver\b/g },
  { id: 'intersection-observer', api: 'IntersectionObserver', chrome: 51, pattern: /(?<![.\w$])IntersectionObserver\b/g },
  { id: 'request-idle-callback', api: 'requestIdleCallback', chrome: 47, pattern: /(?<![.\w$])requestIdleCallback\s*\(/g },
  { id: 'show-open-file-picker', api: 'showOpenFilePicker', chrome: 86, pattern: /(?<![.\w$])showOpenFilePicker\s*\(/g },
  { id: 'file-picker-fs', api: 'FileSystemFileHandle', chrome: 86, pattern: /(?<![.\w$])FileSystemFileHandle\b/g },
  // 额外的 83+ 常见裸调风险点（同一条流水线顺手测的）
  { id: 'object-hasown', api: 'Object.hasOwn', chrome: 93, pattern: /Object\.hasOwn\s*\(/g, polyfilled: true, polyfillKeys: ['Object.hasOwn'] },
  { id: 'array-findlast', api: 'Array.prototype.findLast', chrome: 97, pattern: /\.findLast(?:Index)?\s*\(/g, polyfilled: true, polyfillKeys: ['Array.prototype.findLast', 'Array.prototype.findLastIndex'] },
  { id: 'array-tosorted', api: 'Array.prototype.toSorted/toReversed/toSpliced', chrome: 110, pattern: /\.(?:toSorted|toReversed|toSpliced)\s*\(/g, polyfilled: true, polyfillKeys: ['Array.prototype.toSorted', 'Array.prototype.toReversed', 'Array.prototype.toSpliced'] },
  { id: 'array-with', api: 'Array.prototype.with', chrome: 110, pattern: /(?<![.\w$])(?<![\w$])\.\s*with\s*\(/g, polyfilled: true, polyfillKeys: ['Array.prototype.with'] },
  { id: 'crypto-randomuuid', api: 'crypto.randomUUID', chrome: 92, pattern: /crypto\s*\.\s*randomUUID\s*\(/g, polyfilled: true, polyfillKeys: ['crypto.randomUUID'] },
  { id: 'promise-any', api: 'Promise.any', chrome: 85, pattern: /\.any\s*\(/g },
  { id: 'aggregate-error', api: 'AggregateError', chrome: 85, pattern: /(?<![.\w$])AggregateError\b/g },
  { id: 'object-groupby', api: 'Object.groupBy', chrome: 117, pattern: /Object\.groupBy\s*\(/g },
  { id: 'abort-signal-timeout', api: 'AbortSignal.timeout', chrome: 103, pattern: /AbortSignal\.timeout\b/g },
  { id: 'abort-signal-any', api: 'AbortSignal.any', chrome: 116, pattern: /AbortSignal\.any\b/g },
  { id: 'intl-displaynames', api: 'Intl.DisplayNames', chrome: 81, pattern: /Intl\.DisplayNames\b/g },
  { id: 'intl-listformat', api: 'Intl.ListFormat', chrome: 72, pattern: /Intl\.ListFormat\b/g },
]

/** src/polyfills/legacy.ts 实际 define() 的 API 清单（改了那边就同步这里） */
export const LEGACY_POLYFILLED = [
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
]

/**
 * 调用点附近的「有兜底」证据（静态启发式，只能降噪，最终要人眼确认）。
 * 命中的写进 hint 字段；`strong` 为 true 时才敢标 guarded。
 */
const GUARD_HINTS = [
  { id: 'typeof-function', strong: true, re: /typeof\s+(?:window\.|globalThis\.|Intl\.|navigator\.)?[\w$.]+\s*(?:===?|!==?)\s*["']function["']/ },
  { id: 'typeof-undefined-rev', strong: true, re: /["']undefined["']\s*(?:===?|!==?)\s*typeof/ },
  { id: 'in-operator', strong: true, re: /["'][\w$]+["']\s+in\s+(?:window|globalThis|Intl|navigator|CSS|[A-Za-z_$][\w$]*)/ },
  { id: 'existence-ternary', strong: true, re: /[\w$.]+\s*\?\s*[\[(]/ },
  { id: 'nullish-compare', strong: true, re: /(?:===?|!==?)\s*(?:null|void 0|undefined)|(?:null|void 0|undefined)\s*(?:===?|!==?)/ },
  { id: 'try-catch', strong: false, re: /try\s*\{/ },
  { id: 'optional-chain', strong: false, re: /\?\./ },
]

// ── CSS 特性 → 最低 Chromium ────────────────────────────────────────────────
export const CSS_FEATURES = [
  { id: 'dvh', api: 'dvh（动态视口高度）', chrome: 108, unit: 'dvh', fallbackUnit: 'vh', doc: 'https://developer.mozilla.org/docs/Web/CSS/length#dynamic_viewport_units' },
  { id: 'svh', api: 'svh（最小视口高度）', chrome: 108, unit: 'svh', fallbackUnit: 'vh', doc: 'https://developer.mozilla.org/docs/Web/CSS/length#dynamic_viewport_units' },
  { id: 'lvh', api: 'lvh（最大视口高度）', chrome: 108, unit: 'lvh', fallbackUnit: 'vh', doc: 'https://developer.mozilla.org/docs/Web/CSS/length#dynamic_viewport_units' },
  { id: 'has-selector', api: ':has()', chrome: 105, pattern: /:has\(/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/:has' },
  { id: 'color-mix', api: 'color-mix()', chrome: 111, pattern: /color-mix\(/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/color_value/color-mix' },
  { id: 'container-query', api: '@container', chrome: 105, pattern: /@container\b/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/CSS_containment/Container_queries' },
  { id: 'inset', api: 'inset / inset-inline / inset-block', chrome: 87, pattern: /(?:^|[;{}\s])inset(?:-(?:inline|block)(?:-(?:start|end))?)?\s*:/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/inset' },
  { id: 'flex-gap', api: 'flex 容器里的 gap', chrome: 84, special: 'flex-gap', doc: 'https://developer.mozilla.org/docs/Web/CSS/gap#browser_compatibility' },
  { id: 'focus-visible', api: ':focus-visible', chrome: 86, pattern: /:focus-visible/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/:focus-visible' },
  { id: 'is-where', api: ':is() / :where()', chrome: 88, pattern: /:(?:is|where)\(/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/:is' },
  { id: 'aspect-ratio', api: 'aspect-ratio', chrome: 88, pattern: /(?:^|[;{}\s])aspect-ratio\s*:/g, doc: 'https://developer.mozilla.org/docs/Web/CSS/aspect-ratio' },
]

// ── 语法层 ──────────────────────────────────────────────────────────────────

const parseAt = (acorn, code, ecmaVersion) => {
  for (const sourceType of ['script', 'module']) {
    try {
      const comments = []
      const ast = acorn.parse(code, {
        ecmaVersion,
        sourceType,
        allowHashBang: true,
        locations: true,
        onComment: (block, text, start, end) => comments.push([start, end]),
      })
      return {
        ok: true,
        sourceType,
        ast,
        comments,
      }
    } catch (error) {
      if (sourceType === 'module') {
        return { ok: false, error, sourceType, ast: null, comments: [] }
      }
    }
  }
  return { ok: false, error: null, sourceType: 'script', ast: null, comments: [] }
}

const snippetAt = (code, index, radius = 48) =>
  code
    .slice(Math.max(0, index - radius), Math.min(code.length, index + radius))
    .replace(/\s+/g, ' ')
    .trim()

/** 走一遍 AST，把「只在某版本之后才有的语法」逐个标出来（比正则准，能区分 public/private 字段与静态块） */
const collectFeatures = (ast) => {
  const found = new Map()
  const note = (id, node) => {
    if (found.has(id)) {
      found.get(id).count += 1
      return
    }
    found.set(id, { id, count: 1, line: node.loc?.start.line ?? 0, column: (node.loc?.start.column ?? 0) + 1 })
  }
  let functionDepth = 0
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'ArrowFunctionExpression':
        note('arrow-function', node)
        break
      case 'VariableDeclaration':
        if (node.kind !== 'var') note('let-const', node)
        break
      case 'ClassDeclaration':
      case 'ClassExpression':
        note('class-declaration', node)
        break
      case 'TemplateLiteral':
        note('template-literal', node)
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
        if (node.generator) note('generator', node)
        if (node.async) note('async-function', node)
        break
      case 'ForOfStatement':
        note(node.await ? 'for-await-of' : 'for-of', node)
        break
      case 'SpreadElement':
        if (node.__parentType === 'ObjectExpression') note('object-rest-spread', node)
        else note('spread-call', node)
        break
      case 'RestElement':
        if (node.__parentType === 'ObjectPattern') note('object-rest-spread', node)
        break
      case 'AssignmentPattern':
        note('default-param', node)
        break
      case 'ObjectPattern':
      case 'ArrayPattern':
        note('destructuring', node)
        break
      case 'BinaryExpression':
        if (node.operator === '**') note('exponentiation', node)
        if (node.operator === 'in' && node.left?.type === 'PrivateIdentifier') note('private-in', node)
        break
      case 'LogicalExpression':
        if (node.operator === '??') note('nullish-coalescing', node)
        break
      case 'AssignmentExpression':
        if (node.operator === '&&=' || node.operator === '||=' || node.operator === '??=') note('logical-assignment', node)
        break
      case 'ChainExpression':
        note('optional-chaining', node)
        break
      case 'Literal':
        if (typeof node.bigint === 'string') note('bigint-literal', node)
        else if (typeof node.raw === 'string' && /^\d[\d_]*_/.test(node.raw)) note('numeric-separator', node)
        else if (node.regex) {
          if (/\(\?<[A-Za-z_$]/.test(node.regex.pattern)) note('regexp-named-group', node)
          if (/\(\?<[=!]/.test(node.regex.pattern)) note('regexp-lookbehind', node)
          if (/\\[pP]\{/.test(node.regex.pattern)) note('regexp-unicode-property', node)
          if (node.regex.flags.includes('y')) note('regexp-flag-y', node)
          if (node.regex.flags.includes('u')) note('regexp-flag-u', node)
          if (node.regex.flags.includes('s')) note('regexp-flag-s', node)
        }
        break
      case 'Property':
        if (node.method) note('object-method', node)
        if (node.shorthand) note('object-shorthand', node)
        if (node.computed) note('computed-property', node)
        break
      case 'ImportExpression':
        note('dynamic-import', node)
        break
      case 'MetaProperty':
        if (node.meta?.name === 'import') note('dynamic-import', node)
        break
      case 'CatchClause':
        if (!node.param) note('optional-catch-binding', node)
        break
      case 'PropertyDefinition':
        if (node.key?.type === 'PrivateIdentifier') note('private-field', node)
        else note('class-field', node)
        break
      case 'MethodDefinition':
        if (node.key?.type === 'PrivateIdentifier') note('private-method', node)
        break
      case 'StaticBlock':
        note('class-static-block', node)
        break
      case 'AwaitExpression':
        if (functionDepth === 0) note('top-level-await', node)
        break
      default:
        break
    }
    const isFunction =
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    if (isFunction) functionDepth += 1
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === 'string') {
            item.__parentType = node.type
            visit(item)
          }
        }
      } else if (child && typeof child.type === 'string') {
        child.__parentType = node.type
        visit(child)
      }
    }
    if (isFunction) functionDepth -= 1
  }
  visit(ast)
  return [...found.values()].map((entry) => ({
    ...entry,
    chrome: FEATURE_EVIDENCE[entry.id]?.chrome ?? null,
    es: FEATURE_EVIDENCE[entry.id]?.es ?? null,
    doc: FEATURE_EVIDENCE[entry.id]?.doc ?? null,
  }))
}

/**
 * 用 AST 精确抹掉字符串 / 正则 / 模板字面量 / 注释的内容（保留长度与换行），
 * 得到"代码骨架"。check-bundle-syntax.mjs 里的 stripLiterals 是手写状态机，
 * 在正则密集的压缩 chunk 上会把成片真实代码当成字面量吃掉（实测单文件 82 段、
 * 最长 5.3 万字符），所以 API 层这里改用 AST 口径，避免漏报。
 */
const buildCodeMask = (code, ast, comments) => {
  const ranges = [...comments]
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'Literal') {
      if (node.regex || typeof node.value === 'string') ranges.push([node.start, node.end])
    } else if (node.type === 'TemplateElement') {
      ranges.push([node.start, node.end])
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === 'string') walk(item)
        }
      } else if (child && typeof child.type === 'string') {
        walk(child)
      }
    }
  }
  walk(ast)
  const chars = code.split('')
  for (const [start, end] of ranges) {
    for (let i = start; i < end && i < chars.length; i += 1) {
      if (chars[i] !== String.fromCharCode(10)) chars[i] = ' '
    }
  }
  return chars.join('')
}

/** 语法层：一个文件的 ES 阶梯 + 首个卡住的语法点 + 最低 Chromium */
export const scanFileSyntax = (acorn, code) => {
  const ladder = []
  let esFloor = null
  let decisive = null
  for (const version of ES_LADDER) {
    const attempt = parseAt(acorn, code, version)
    if (attempt.ok) {
      ladder.push({ version, ok: true, sourceType: attempt.sourceType })
      esFloor = version
      break
    }
    const error = attempt.error
    const at = typeof error.pos === 'number' ? positionOf(code, error.pos) : { line: 0, column: 0 }
    const entry = {
      version,
      ok: false,
      message: error.message,
      line: at.line,
      column: at.column,
      snippet: typeof error.pos === 'number' ? snippetAt(code, error.pos) : '',
    }
    ladder.push(entry)
    decisive = entry
  }

  if (esFloor === null) {
    return { esFloor: null, chromeFloor: null, decisive, features: [], ladder, mask: null, unparsable: true }
  }

  // 用最高版本再解析一次拿 AST 做特性清点（esFloor 已证明能过，2022 必然也能过）
  const top = parseAt(acorn, code, 2022)
  const features = top.ok ? collectFeatures(top.ast) : []
  const known = features.filter((feature) => typeof feature.chrome === 'number')
  const chromeFloor = known.length
    ? Math.max(...known.map((feature) => feature.chrome))
    : (ES_BASELINE_CHROME[esFloor] ?? 4)
  const drivers = known.filter((feature) => feature.chrome === chromeFloor)
  return {
    esFloor,
    chromeFloor,
    decisive,
    features: known.sort((a, b) => b.chrome - a.chrome || b.count - a.count),
    // 把语法下限顶上去的那个特性（可能不止一个）
    drivers: drivers.map((feature) => feature.id),
    ladder,
    mask: top.ok ? buildCodeMask(code, top.ast, top.comments ?? []) : null,
  }
}

// ── API 层 ──────────────────────────────────────────────────────────────────

const guardHints = (stripped, index) => {
  const window = stripped.slice(Math.max(0, index - 200), Math.min(stripped.length, index + 60))
  const hits = GUARD_HINTS.filter((hint) => hint.re.test(window)).map((hint) => hint.id)
  const strong = GUARD_HINTS.some((hint) => hint.strong && hint.re.test(window))
  return { hints: hits, guarded: strong }
}

export const scanApisInFile = (relative, raw, mask, polyfillInEntry) => {
  const hits = []
  const polyfilledSet = new Set(LEGACY_POLYFILLED)
  for (const api of RUNTIME_APIS) {
    api.pattern.lastIndex = 0
    let match
    let count = 0
    let first = null
    while ((match = api.pattern.exec(mask))) {
      count += 1
      if (first === null) first = match.index
    }
    if (!count) continue
    const at = positionOf(mask, first)
    const guard = guardHints(mask, first)
    const covered =
      Boolean(api.polyfilled) && (api.polyfillKeys ?? [api.api]).some((key) => polyfilledSet.has(key))
    hits.push({
      file: relative,
      id: api.id,
      api: api.api,
      chrome: api.chrome,
      count,
      line: at.line,
      column: at.column,
      snippet: snippetAt(raw, first, 60),
      polyfilled: covered,
      polyfillInEntry,
      guard: guard.guarded ? 'feature-detected' : 'none-detected',
      guardHints: guard.hints,
    })
  }
  return hits
}

/**
 * 把一次调用点命中按「这一档 WebView 上到底会不会炸」归类：
 * - baseline：该版本内核自带，不算风险
 * - polyfilled：入口里打进了对应 polyfill，可覆盖
 * - polyfill-not-in-entry：声明了 polyfill 但入口没打进去（打包配置问题）
 * - naked-guarded：裸调用，但前面有特性探测，走另一条路
 * - naked-unprotected：裸调用且没有探测 —— 真正的风险点
 */
export const classifyApiRisk = (hit, webview) => {
  if (hit.chrome <= webview) return 'baseline'
  if (hit.polyfilled) return hit.polyfillInEntry ? 'polyfilled' : 'polyfill-not-in-entry'
  if (hit.guard === 'feature-detected') return 'naked-guarded'
  return 'naked-unprotected'
}

// ── CSS 层 ──────────────────────────────────────────────────────────────────
/** 拆成「声明块」级别的片段，够用来判 flex 容器里有没有 gap */
const cssBlocks = (css) => css.split('}')

const countPattern = (css, pattern) => {
  pattern.lastIndex = 0
  let count = 0
  while (pattern.exec(css)) count += 1
  return count
}

const unitFallback = (css, unit, fallbackUnit) => {
  const occurrences = css.match(new RegExp(`\\d+(?:\\.\\d+)?${unit}\\b`, 'g')) ?? []
  const values = [...new Set(occurrences)]
  const missing = []
  let covered = 0
  for (const value of values) {
    const expected = value.replace(new RegExp(`${unit}$`), fallbackUnit)
    const pattern = new RegExp(`(^|[^\\d.])${expected.replace('.', '\\.')}(?![\\d.])`)
    if (pattern.test(css)) covered += 1
    else missing.push(expected)
  }
  return { occurrences: occurrences.length, distinct: values.length, covered, missing }
}

export const scanCss = (files) => {
  const results = []
  for (const file of files) {
    const css = readFileSync(file, 'utf8')
    const blocks = cssBlocks(css)
    for (const feature of CSS_FEATURES) {
      let count = 0
      let fallback = null
      let missingFallback = null
      if (feature.unit) {
        const found = unitFallback(css, feature.unit, feature.fallbackUnit)
        count = found.occurrences
        fallback = found.covered ? `${feature.fallbackUnit} 回退 ${found.covered}/${found.distinct}（${found.occurrences} 处）` : null
        missingFallback = found.missing
      } else if (feature.special === 'flex-gap') {
        // flex 容器里的 gap 是 Chrome 84 才有的（老版本只支持 grid gap），命中即无回退
        for (const block of blocks) {
          const isFlex = /display:\s*(?:inline-)?flex/.test(block)
          const hasGap = /(?:^|[{;])\s*(?:gap|row-gap|column-gap)\s*:/.test(block)
          if (isFlex && hasGap) count += 1
        }
      } else {
        count = countPattern(css, feature.pattern)
      }
      if (!count) continue
      results.push({
        file,
        id: feature.id,
        api: feature.api,
        chrome: feature.chrome,
        count,
        fallback,
        missingFallback,
        doc: feature.doc,
        // 有回退的单一属性（dvh+vh）算降级不致命；其余命中的都是「要么生效要么整条忽略」
        severity: fallback ? 'degraded-with-fallback' : 'no-fallback',
      })
    }
  }
  return results
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

const rel = (distDir, file) => path.relative(distDir, file).split(path.sep).join('/')

const readdirJs = (dir, accumulator = []) => {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return accumulator
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) readdirJs(full, accumulator)
    else if (entry.name.endsWith('.js')) accumulator.push(full)
  }
  return accumulator
}

const readdirCss = (dir, accumulator = []) => {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return accumulator
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) readdirCss(full, accumulator)
    else if (entry.name.endsWith('.css')) accumulator.push(full)
  }
  return accumulator
}

export const buildMatrix = (distDir) => {
  const acorn = loadAcorn()
  if (!acorn) throw new Error('找不到 acorn（先 pnpm install；它是 @rspack 的传递依赖）')
  const jsFiles = readdirJs(path.join(distDir, 'static', 'js')).sort()
  if (!jsFiles.length) throw new Error(`没有找到产物：${path.join(distDir, 'static', 'js')}（先 pnpm run build）`)
  const cssFiles = readdirCss(path.join(distDir, 'static', 'css')).sort()
  const entryScripts = readEntryScripts(distDir) ?? []
  const polyfillFiles = jsFiles.filter((file) => readFileSync(file, 'utf8').includes(POLYFILL_FLAG))
  const polyfillInEntry = entryScripts.some((entry) =>
    polyfillFiles.some((file) => rel(distDir, file) === entry),
  )

  const files = []
  const apiHits = []
  for (const file of jsFiles) {
    const code = readFileSync(file, 'utf8')
    const relative = rel(distDir, file)
    const { mask, ...syntax } = scanFileSyntax(acorn, code)
    files.push({
      file: relative,
      kind: entryScripts.includes(relative) ? 'entry' : 'async-chunk',
      bytes: Buffer.byteLength(code),
      ...syntax,
    })
    apiHits.push(...scanApisInFile(relative, code, mask ?? stripLiterals(code), polyfillInEntry))
  }
  const cssHits = scanCss(cssFiles).map((hit) => ({ ...hit, file: rel(distDir, hit.file) }))

  const entry = files.find((file) => file.kind === 'entry') ?? files[0]
  const asyncChunks = files.filter((file) => file.kind === 'async-chunk')

  const verdicts = WEBVIEW_TARGETS.map((webview) => {
    const entryParseOk = entry.chromeFloor !== null && entry.chromeFloor <= webview
    const brokenChunks = asyncChunks.filter((file) => file.chromeFloor !== null && file.chromeFloor > webview)
    const bootApiRisk = apiHits
      .filter((hit) => hit.file === entry.file && classifyApiRisk(hit, webview) === 'naked-unprotected')
      .map((hit) => `${hit.api}(Chrome ${hit.chrome}+)`)
    const chunkApiRisk = apiHits.filter(
      (hit) => hit.file !== entry.file && classifyApiRisk(hit, webview) === 'naked-unprotected',
    )
    const cssBroken = cssHits.filter((hit) => hit.chrome > webview)
    const cssNoFallback = cssBroken.filter((hit) => hit.severity === 'no-fallback')
    const cssWithFallback = cssBroken.filter((hit) => hit.severity === 'degraded-with-fallback')
    return {
      webview,
      entryParse: entryParseOk ? 'ok' : `fail(${entry.chromeFloor})`,
      whiteScreen: !entryParseOk,
      brokenChunkCount: brokenChunks.length,
      brokenChunks: brokenChunks.map((file) => `${file.file}(ES${file.esFloor}/Chrome${file.chromeFloor})`),
      bootApiRisk,
      chunkApiRiskCount: chunkApiRisk.length,
      chunkApiRisk: [...new Set(chunkApiRisk.map((hit) => hit.api))],
      cssBroken: cssBroken.map((hit) => `${hit.api}(Chrome ${hit.chrome}+)`),
      cssNoFallback: [...new Set(cssNoFallback.map((hit) => `${hit.api}(Chrome ${hit.chrome}+)`))],
      cssWithFallback: [...new Set(cssWithFallback.map((hit) => `${hit.api}(Chrome ${hit.chrome}+，有回退，仅降级)`))],
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    distDir,
    acornVersion: acorn.version,
    caveat: '全部结论为静态推断（语法解析 + API 调用点探针），未在任何 WebView 上运行验证',
    ladder: ES_LADDER,
    webviewTargets: WEBVIEW_TARGETS,
    entry: entry.file,
    polyfill: { flag: POLYFILL_FLAG, inEntry: polyfillInEntry, files: polyfillFiles.map((file) => rel(distDir, file)), coveredApis: LEGACY_POLYFILLED },
    counts: { js: files.length, css: cssFiles.length, asyncChunks: asyncChunks.length },
    files,
    api: apiHits,
    css: cssHits,
    verdicts,
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────────

const table = (rows) => {
  const widths = []
  for (const row of rows) row.forEach((cell, index) => (widths[index] = Math.max(widths[index] ?? 0, String(cell).length)))
  return rows.map((row) => row.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')).join('\n')
}

const byEs = (matrix) => {
  const buckets = new Map()
  for (const file of matrix.files) {
    const key = file.esFloor === null ? 'unparsable' : String(file.esFloor)
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(file)
  }
  return [...buckets.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))
}

export const printReport = (matrix) => {
  const lines = []
  lines.push(`静态兼容矩阵（acorn ${matrix.acornVersion}）`)
  lines.push(`产物：${matrix.distDir}`)
  lines.push(`规模：JS ${matrix.counts.js} 个（入口 ${matrix.entry} + 异步 chunk ${matrix.counts.asyncChunks} 个）；CSS ${matrix.counts.css} 个`)
  lines.push('口径：静态推断，非运行时验证')
  lines.push('')

  lines.push('── 语法层：最低 ES 版本分布 ──')
  const dist = byEs(matrix).map(([es, files]) => {
    const min = Math.min(...files.map((file) => file.chromeFloor ?? 999))
    return [es, files.length, `Chrome ${min === 999 ? '?' : min}+`, files.slice(0, 3).map((file) => file.file).join(', ')]
  })
  lines.push(table([['ES 下限', '文件数', '最低 Chromium', '示例'], ...dist]))
  lines.push('')

  const topDrivers = matrix.files
    .filter((file) => file.chromeFloor !== null && file.chromeFloor > 4)
    .sort((a, b) => (b.chromeFloor ?? 0) - (a.chromeFloor ?? 0))
    .slice(0, 8)
  const entryFile = matrix.files.find((file) => file.kind === 'entry')
  if (entryFile) {
    lines.push(
      `入口包 ${entryFile.file}：ES${entryFile.esFloor} / Chrome ${entryFile.chromeFloor}+（顶门槛特性：${(entryFile.drivers ?? []).join('+') || '-'}）`,
    )
    lines.push('')
  }

  lines.push('── 抬门槛最狠的文件（语法） ──')
  for (const file of topDrivers) {
    lines.push(`  ${file.file}  ES${file.esFloor} / Chrome ${file.chromeFloor}+  ${(file.drivers ?? []).join('+') || '-'}`)
    if (file.decisive) lines.push(`      首个卡点 ${file.decisive.line}:${file.decisive.column} (ES${file.decisive.version} 解析) ${file.decisive.snippet.slice(0, 90)}`)
  }
  lines.push('')

  lines.push('── API 层：调用点命中 ──')
  const apiSummary = new Map()
  for (const hit of matrix.api) {
    const key = `${hit.api} (Chrome ${hit.chrome}+)`
    const bucket = apiSummary.get(key) ?? { count: 0, files: new Set(), classification: {} }
    bucket.count += hit.count
    bucket.files.add(hit.file)
    for (const webview of WEBVIEW_TARGETS) {
      const klass = classifyApiRisk(hit, webview)
      bucket.classification[webview] = bucket.classification[webview] ?? new Set()
      bucket.classification[webview].add(klass)
    }
    apiSummary.set(key, bucket)
  }
  const apiRows = [...apiSummary.entries()]
    .sort((a, b) => Number(b[0].match(/Chrome (\d+)/)[1]) - Number(a[0].match(/Chrome (\d+)/)[1]))
    .map(([key, value]) => [
      key,
      value.count,
      value.files.size,
      WEBVIEW_TARGETS.map((webview) => [...value.classification[webview]].sort().join('/')).join(' | '),
    ])
  lines.push(table([['API', '调用点', '文件', `@${WEBVIEW_TARGETS.join(' @')}`], ...apiRows]))
  lines.push(`polyfill 标记：${POLYFILL_FLAG} ${matrix.polyfill.inEntry ? '已打进入口' : '未打进入口'}（${matrix.polyfill.files.join(', ') || '无'}）`)
  lines.push('')

  lines.push('── CSS 层 ──')
  const cssRows = matrix.css.map((hit) => [
    hit.file,
    hit.api,
    `Chrome ${hit.chrome}+`,
    hit.count,
    hit.fallback ?? '无回退',
  ])
  lines.push(cssRows.length ? table([['文件', '特性', '最低', '处', '回退'], ...cssRows]) : '  （无命中）')
  lines.push('')

  lines.push('── 四档结论 ──')
  for (const verdict of matrix.verdicts) {
    lines.push(
      `WebView ${verdict.webview}：入口解析 ${verdict.entryParse} → ${verdict.whiteScreen ? '白屏' : '不白屏'}；` +
        `异步 chunk 解析失败 ${verdict.brokenChunkCount} 个；启动期裸 API 风险 ${verdict.bootApiRisk.length ? verdict.bootApiRisk.join('、') : '无'}；` +
        `chunk 内裸 API 风险 ${verdict.chunkApiRiskCount ? verdict.chunkApiRisk.join('、') : '无'}；` +
        `CSS 无回退特性 ${verdict.cssNoFallback.length ? verdict.cssNoFallback.join('、') : '无'}；` +
        `CSS 有回退仅降级 ${verdict.cssWithFallback.length ? verdict.cssWithFallback.join('、') : '无'}`,
    )
  }
  return lines.join('\n')
}

const main = () => {
  const args = process.argv.slice(2)
  const distArg = args.find((arg) => !arg.startsWith('--'))
  const jsonIndex = args.indexOf('--json')
  const jsonPath = jsonIndex >= 0 ? args[jsonIndex + 1] : null

  let distDir = distArg ? path.resolve(distArg) : path.join(ROOT, 'dist')
  if (!path.isAbsolute(distDir)) distDir = path.resolve(ROOT, distDir)

  const matrix = buildMatrix(distDir)
  console.log(printReport(matrix))
  if (jsonPath) {
    const target = path.resolve(ROOT, jsonPath)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(matrix, null, 2)}\n`)
    console.log(`\nJSON 已写入：${target}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(`扫描失败：${error.message}`)
    process.exit(2)
  }
}

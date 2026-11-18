#!/usr/bin/env node
// 产物语法/DOM 单位下限检查（GitHub issue #13「低内核白屏」）。
//
//   node scripts/check-bundle-syntax.mjs            # 默认检查 dist/
//   node scripts/check-bundle-syntax.mjs dist-xxx   # 检查别的产物目录
//   npm run check:legacy                            # 同上（release 前跑）
//
// 背景：Android WebView 版本跟系统镜像走，Android 11 出厂镜像停在 Chromium 83。构建 target
// 一旦被改回去（或某个第三方依赖带进更新的语法），低内核用户就是整包解析失败 = 静默白屏，
// 而且这类问题在 Chrome/Playwright 上永远测不出来。所以要在产物层面卡死语法下限。
//
// 检查分两层：
//   1) 词法层（零依赖）：先把字符串/模板/正则/注释剥成空格（保持长度与换行），再找
//      ES2021+ 才有的语法记号。剥字面量是必须的 —— prismjs 的语言定义里就有一条
//      /--|\+\+|\*\*=?|=>|&&=?|\|\|=?|…/ 正则，直接 grep '&&=' 必然误报。
//   2) 语法层（有 acorn 就跑）：用 acorn 真解析每个文件，AST 里断言没有逻辑赋值 / 类静态块 /
//      私有类成员，并给出精确行列。仓库没把 acorn 列进 devDependencies（它是 @rspack 的传递依赖），
//      拿不到时自动退化成只有词法层，并在报告里标注。
//
// CSS 一并检查：dvh（Chrome 108+）必须带 vh 回退，否则低内核上弹层高度直接失效。
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

const isWordChar = (char) => char !== undefined && /[A-Za-z0-9_$]/.test(char)

/** 正则字面量允许出现在这些字符/关键字之后（否则 '/' 就是除号） */
const REGEX_AFTER_CHAR = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  '<',
  '>',
  '',
])
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'throw',
])

/**
 * 把字符串/模板/正则/注释的内容替换成空格（长度与换行保持不变，便于回算行列）。
 * 只做词法剥离，不追求完整解析 —— 目的是让 grep 只看到真正的语法记号。
 */
export const stripLiterals = (code) => {
  const out = code.split('')
  const blank = (from, to) => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n' && out[index] !== '\r') out[index] = ' '
    }
  }
  // 模板字面量里可以再嵌 ${ ... }，用栈记录「回到模板字符串」的位置
  const templateStack = []
  let index = 0
  let lastChar = ''
  let lastWord = ''

  while (index < code.length) {
    const char = code[index]
    const next = code[index + 1]

    if (char === '/' && next === '/') {
      const end = code.indexOf('\n', index)
      const stop = end < 0 ? code.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2)
      const stop = end < 0 ? code.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }
    if (char === "'" || char === '"') {
      let cursor = index + 1
      while (cursor < code.length) {
        if (code[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (code[cursor] === char) break
        cursor += 1
      }
      blank(index + 1, cursor)
      index = cursor + 1
      lastChar = char
      lastWord = ''
      continue
    }
    if (char === '`') {
      templateStack.push('template')
      index += 1
      lastChar = '`'
      lastWord = ''
      continue
    }
    if (char === '$' && next === '{' && templateStack.length) {
      // 进入模板里的表达式：正常解析，直到配对的 '}'
      templateStack.push('expression')
      index += 2
      lastChar = '{'
      lastWord = ''
      continue
    }
    if (
      char === '}' &&
      templateStack.length &&
      templateStack[templateStack.length - 1] === 'expression'
    ) {
      templateStack.pop()
      index += 1
      lastChar = '}'
      lastWord = ''
      continue
    }
    if (templateStack.length && templateStack[templateStack.length - 1] === 'template') {
      // 模板字面量正文：跳到下一个 ` 或 ${
      let cursor = index
      while (cursor < code.length) {
        if (code[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (code[cursor] === '`') break
        if (code[cursor] === '$' && code[cursor + 1] === '{') break
        cursor += 1
      }
      if (code[cursor] === '`') {
        blank(index, cursor)
        templateStack.pop()
        index = cursor + 1
      } else {
        blank(index, cursor)
        index = cursor
      }
      lastChar = '`'
      lastWord = ''
      continue
    }
    if (char === '/') {
      const regexAllowed = isWordChar(lastChar)
        ? REGEX_AFTER_WORD.has(lastWord)
        : REGEX_AFTER_CHAR.has(lastChar)
      if (regexAllowed) {
        let cursor = index + 1
        let inClass = false
        while (cursor < code.length) {
          const inner = code[cursor]
          if (inner === '\\') {
            cursor += 2
            continue
          }
          if (inner === '[') inClass = true
          else if (inner === ']') inClass = false
          else if (inner === '/' && !inClass) break
          else if (inner === '\n') break
          cursor += 1
        }
        blank(index + 1, cursor)
        // 跳过 flags
        let flagsEnd = cursor + 1
        while (flagsEnd < code.length && /[a-z]/i.test(code[flagsEnd])) flagsEnd += 1
        blank(cursor + 1, flagsEnd)
        index = flagsEnd
        lastChar = '/'
        lastWord = ''
        continue
      }
    }

    if (isWordChar(char)) {
      let cursor = index
      while (cursor < code.length && isWordChar(code[cursor])) cursor += 1
      lastWord = code.slice(index, cursor)
      lastChar = code[cursor - 1]
      index = cursor
      continue
    }
    if (!/\s/.test(char)) {
      lastChar = char
      lastWord = ''
    }
    index += 1
  }
  return out.join('')
}

const positionOf = (code, index) => {
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
  let ast
  try {
    // ecmaVersion 2022 才能解析类字段（Chrome 72 起就支持，属于允许范围），
    // 禁用项由下面的 AST 断言逐个卡，不靠 parser 版本号兜。
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowHashBang: true,
      locations: true,
    })
  } catch (error) {
    return {
      version: acorn.version,
      findings: [
        { kind: 'parse-error', why: '产品文件无法解析', token: error.message, line: 0, column: 0 },
      ],
    }
  }
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
const loadAcorn = () => {
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

const formatFindings = (findings) =>
  findings
    .map(
      (finding) =>
        `  ✗ ${finding.file}:${finding.line}:${finding.column} ${finding.kind}（${finding.why}）${finding.token ? ` ${finding.token}` : ''}`
    )
    .join('\n')

const main = () => {
  const distDir = path.resolve(ROOT, process.argv[2] ?? 'dist')
  const jsFiles = walkFiles(path.join(distDir, 'static', 'js'), '.js')
  const cssFiles = walkFiles(path.join(distDir, 'static', 'css'), '.css')
  if (jsFiles.length === 0) {
    console.error(`没有找到产物：${path.relative(ROOT, distDir)}/static/js（先 npm run build）`)
    process.exit(2)
  }
  const js = checkJavaScript(jsFiles)
  const css = checkCssUnits(cssFiles)
  console.log(`产物语法下限检查：${path.relative(ROOT, distDir) || '.'}`)
  console.log(
    `  JS 文件 ${js.files} 个；词法层违规 ${js.lexical.length} 个；AST 层违规 ${js.ast.length} 个${js.acornVersion ? `（acorn ${js.acornVersion}, ecmaVersion 2022 + 禁用项断言）` : '（没有 acorn，只做了词法层）'}`
  )
  console.log(
    `  dvh 声明 ${css.dvhTotal} 处；带 vh 回退 ${css.fallbackTotal} 处；问题 ${css.problems.length} 个`
  )
  const fails = js.lexical.length + js.ast.length + css.problems.length
  if (js.lexical.length) console.log(formatFindings(js.lexical))
  if (js.ast.length) console.log(formatFindings(js.ast))
  for (const problem of css.problems)
    console.log(`  ✗ ${problem.file} ${problem.value}（${problem.kind}）`)
  if (fails) {
    console.error(`\n结论：不合格 —— 产物里有 Chrome 83 解析不了的东西（issue #13 会白屏）`)
    process.exit(1)
  }
  console.log('\n结论：合格 —— 全部产物可用 Chrome 83（ES2020 语法 / 无 dvh 裸用）解析')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

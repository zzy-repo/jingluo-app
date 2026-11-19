#!/usr/bin/env node
/**
 * check-guard-es5.mjs —— `src/index.html` 里的兜底页内联守卫必须是 ES5（issue #104）。
 *
 * 为什么要有它：这段内联脚本是唯一一条「业务包整包解析失败时还能跑」的路径。
 * 它一旦混进可选链 / 空值合并 / 箭头函数 / 模板串，WebView < 80 上就是**守卫自己也是白屏** ——
 * 而这恰好是最需要它的时候。以前的守门员是单测里三条正则（禁 `?.`、禁 `=>`、禁 `let/const`），
 * 那只能拦住写法眼熟的几类；真正可靠的判据是「用 ES5 解析器解析一遍」。
 *
 * 做法：从 HTML 里抽出所有内联 `<script>`（带 src 的跳过），逐段用 acorn 的
 * `ecmaVersion: 5` 解析。能解析 = 老内核至少能把这段**读进去**；解析失败就逐条打印 `行:列`。
 * acorn 复用 `scripts/check-bundle-syntax.mjs` 的 `loadAcorn()`（它已经知道 pnpm 的落盘位置，
 * 不需要把 acorn 加进 package.json）。
 *
 * 用法：
 *   node scripts/check-guard-es5.mjs                    # src/index.html + dist/index.html（存在时）
 *   node scripts/check-guard-es5.mjs path/to/index.html
 *   pnpm run check:guard                                # package.json 里加这一行即可
 *
 * 退出码：
 *   0  合格（每段内联脚本都能被 ES5 解析）
 *   1  有 ES6+ 语法（逐条打印 `文件:行:列`），或 HTML 里一段内联脚本都没有
 *   2  环境不具备（acorn 没装 / 指定的文件不存在）
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadAcorn } from './check-bundle-syntax.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认检查的入口：源码一份；构建产物存在就一起查（防压缩器把 ES6 塞进内联脚本） */
export const DEFAULT_TARGETS = ['src/index.html', 'dist/index.html']

/** 内联 `<script>` 的抽取规则：整段源码里只有一段守卫，但别指望永远只有一段 */
const SCRIPT_TAG = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi

/** 抽出一段 HTML 里的全部内联脚本（带 src 的标签抓出来是空串，会被跳过） */
export const inlineScripts = (html) => {
  const scripts = []
  SCRIPT_TAG.lastIndex = 0
  let match = SCRIPT_TAG.exec(html)
  while (match !== null) {
    scripts.push({ source: match[1], offset: match.index })
    match = SCRIPT_TAG.exec(html)
  }
  return scripts
}

/**
 * 用 ES5 解析一段 HTML 里的内联脚本。返回 findings，空数组 = 合格。
 * 纯函数：不读盘、不打印，方便单测直接喂字符串。
 */
export const checkInlineScripts = (acorn, html) => {
  const findings = []
  for (const script of inlineScripts(html)) {
    if (!script.source.trim()) continue
    const bytes = Buffer.byteLength(script.source, 'utf8')
    try {
      acorn.parse(script.source, { ecmaVersion: 5, sourceType: 'script' })
    } catch (error) {
      const line = error.loc && Number.isInteger(error.loc.line) ? error.loc.line : null
      const column = error.loc && Number.isInteger(error.loc.column) ? error.loc.column + 1 : null
      findings.push({
        line,
        column,
        bytes,
        message: String(error.message || error),
      })
      continue
    }
    findings.push({ line: null, column: null, bytes, message: null, ok: true })
  }
  return findings
}

/** 读文件 + 解析，返回 { findings, scripts }；方便 CLI 与单测共用一份口径 */
export const checkHtmlFile = (acorn, file) =>
  checkInlineScripts(acorn, readFileSync(file, 'utf8')).map((finding) => ({ ...finding, file }))

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/') || file

const main = () => {
  const acorn = loadAcorn()
  if (!acorn) {
    console.error('找不到 acorn：先跑 pnpm install（它随 @rspack 一起进 node_modules/.pnpm）')
    return 2
  }
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  const targets = args.length
    ? args.map((arg) => path.resolve(process.cwd(), arg))
    : DEFAULT_TARGETS.map((file) => path.join(ROOT, file)).filter((file) => existsSync(file))

  if (targets.length === 0) {
    console.error(`没有可检查的入口：${DEFAULT_TARGETS.join(' / ')} 都不存在`)
    return 2
  }
  const missing = targets.filter((file) => !existsSync(file))
  if (missing.length) {
    console.error(`文件不存在：${missing.map((file) => relative(file)).join(' / ')}`)
    return 2
  }

  const failures = []
  let inlineCount = 0
  for (const file of targets) {
    let findings
    try {
      findings = checkHtmlFile(acorn, file)
    } catch (error) {
      console.error(`读不了 ${relative(file)}：${error.message}`)
      return 2
    }
    const inline = findings.filter((finding) => finding.ok)
    const broken = findings.filter((finding) => !finding.ok)
    inlineCount += inline.length + broken.length
    if (broken.length === 0) {
      const total = inline.reduce((sum, finding) => sum + finding.bytes, 0)
      console.log(`✓ ${relative(file)}：内联脚本 ${inline.length} 段、${total} B，全部能被 ES5 解析`)
      continue
    }
    failures.push({ file, broken })
  }

  if (inlineCount === 0) {
    console.error('一段内联脚本都没找到：入口被改了？（门禁空转比报红更危险）')
    return 1
  }

  if (failures.length === 0) {
    console.log(`结论：合格 —— 兜底守卫没有 ES6+ 语法（acorn ${acorn.version}, ecmaVersion 5）`)
    return 0
  }

  for (const { file, broken } of failures) {
    for (const finding of broken) {
      const at = finding.line === null ? '' : `:${finding.line}:${finding.column}`
      console.error(`✗ ${relative(file)}${at} ${finding.message}`)
    }
  }
  console.error(
    '\n结论：不合格 —— 兜底页内联脚本里有 ES6+ 语法（issue #104）。' +
      '这段必须在 WebView < 80 上也能解析：只用 var / function / 字符串拼接。'
  )
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}

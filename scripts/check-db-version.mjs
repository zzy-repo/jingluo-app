#!/usr/bin/env node
/**
 * check-db-version.mjs —— 「测试与源码里不许写死 IndexedDB 版本号」门禁（Issue #547）。
 *
 * 为什么要有它：#547 把附件存储的库结构从 v12 升到 v13，`src/services/chat/db.ts` 里
 * `DB_VERSION` 改一行，两个 L1 用例却各自硬编码了 `indexedDB.open('chat-demo', 12)`：
 *
 *     VersionError: The requested version (12) is less than the existing version (13)
 *
 * 结果是 **CI 真红**（不是假红，重跑也红）——用例的职责是「验行为」，却在替源码记住一个
 * 只该由 `db.ts` 说了算的常量。它的失败信息还很误导：看上去像用例坏了，其实是版本漂了。
 * 三条主线（文件 / 图片 / 支付）都要碰这套存储，**图片线可能还要升 v14**，所以这不是
 * 一次性的手工修复，而是一条必须机械化的规矩：
 *
 *     DB 版本只有一个事实来源（`src/services/chat/db.ts` 的 `DB_VERSION`）；
 *     任何第二处出现「数字字面量版本」都是下一次 VersionError 的种子。
 *
 * 判据（只有一条，宁窄不宽）：
 *   `indexedDB.open(...)` 或 `openDB(...)` 的**第二个实参是数字字面量** → 违规。
 *
 *     违规： indexedDB.open('chat-demo', 12)          openDB('chat-demo', 13, {...})
 *     放行： indexedDB.open('chat-demo')              // 不传版本 = 打开当前版本，用例本来就该这样
 *            indexedDB.open('chat-demo', DB_VERSION)  // 唯一正确写法：从 db.ts 导入
 *            indexedDB.open('chat-demo', version)     // 变量（例如从 DB_VERSION 推出来的边界值）
 *
 * 为什么只认「数字字面量」而不认「变量」：变量可能正是 `DB_VERSION` 或由它算出来的边界
 * （`copy-limit.test.mjs` 就是 `version` 变量）；静态区分不了就等于逼人写豁免注释，豁免一多
 * 门禁就形同虚设。硬编码的危险恰恰在于「一眼看上去只是个 12」—— 那是可以被 grep 出来的形状。
 *
 * 扫描范围：
 *   tests/**  （`.mjs` / `.ts` / `.js`）—— 事故现场在这一层（L1 用例）
 *   src/**    （`.ts` / `.tsx` / `.js` / `.mjs`）—— 源码里同样不允许第二处版本号
 *
 * 不扫 `tests/gates/fixtures/`：那是「坏输入的仓库」，里面本来就该有一份坏样例，它不是被测代码
 * （不 import 任何真实现、也不被 `run-layer` 执行）。同理不扫 `dist*` / `node_modules`。
 *
 * 用法：
 *   node scripts/check-db-version.mjs            # 有硬编码版本 → exit 1
 *   node scripts/check-db-version.mjs --verbose  # 额外打印扫描计数
 *   node scripts/check-db-version.mjs --selftest # 只用合成文本验判据（不读仓库）
 *   pnpm run check:db-version
 *
 * 退出码：0 干净 / 1 发现硬编码版本 / 2 用法或环境错误
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 扫这两个目录（相对仓库根） */
const SCAN_DIRS = ['src', 'tests']

/** 进来也不看的目录名（任意层级）—— fixture 仓库不是被测代码，见文件头 */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-standard',
  'dist-scroll',
  'dist-internal',
  '.git',
  '.workflow-lite',
  'coverage',
  'fixtures',
])

/** 只看代码文件；文档/JSON 里写版本号不参与运行 */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx'])

/** 版本号的唯一正确来源 */
const DB_MODULE = 'src/services/chat/db.ts'
const DB_CONST = 'DB_VERSION'

/** 打开库的两个入口：浏览器原生 API + idb 的包装（`openDB<ChatDB>('chat-demo', DB_VERSION, …)`） */
const OPEN_CALL = /\b(?:indexedDB\s*\.\s*open|openDB)\s*(?:<[^;()]*?>)?\s*\(/g

/** 数字字面量（十进制 / 十六进制 / 数字分隔符都算） */
const NUMERIC_LITERAL = /^(?:0[xX][0-9a-fA-F_]+|\d[\d_]*)$/

/**
 * 把「不参与运行」的字符抹成空格，**长度与行号保持不变**：
 *   · 注释（`//` 到行尾、`/* … *\/`）—— 文档与注释里必须允许写反例（本文件头就写了两个），
 *     否则门禁逼着人把「错长什么样」从注释里删掉，比误报本身更伤；
 *   · 字符串 / 模板字符串的**内部**（引号保留）—— `'indexedDB.open(x, 12)'` 这种引号里的
 *     文本不是调用；保留引号是为了后面按实参解析时还能按「顶层逗号」切分。
 *
 * 为什么不用正则直接扫原文：`indexedDB.open('chat-demo', 12)` 与
 * `// indexedDB.open('chat-demo', 12)` 在字符层面无法区分，而后者是注释、是历史说明。
 */
export const maskSource = (text) => {
  const out = text.split('')
  let quote = null
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i]
    if (quote) {
      if (ch === '\\') {
        out[i] = ' '
        if (i + 1 < out.length && out[i + 1] !== '\n') out[i + 1] = ' '
        i += 1
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch !== '\n') out[i] = ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '/' && out[i + 1] === '/') {
      while (i < out.length && out[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      i -= 1
      continue
    }
    if (ch === '/' && out[i + 1] === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < out.length) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 1
      }
      continue
    }
  }
  return out.join('')
}

/**
 * 从一个 `(` 之后解析实参列表，返回顶层实参（已 trim，未去注释）。
 *
 * 为什么不用正则「逗号 + 数字」：`openDB('chat-demo', DB_VERSION, { upgrade(db, oldVersion) {…} })`
 * 里到处都是逗号和数字，只有**顶层**第二个参数才是版本。这里做一遍真正的括号/字符串配对。
 */
export const parseArgs = (text, start) => {
  const args = []
  let depth = 0
  let current = ''
  let quote = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      current += ch
      if (ch === '\\') {
        current += text[i + 1] ?? ''
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    // 注释已在 maskSource 里抹成空格，所以这里不必再处理（也不要再处理：两处各判一次就会漂）
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1
      current += ch
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        if (current.trim()) args.push(current.trim())
        return args
      }
      depth -= 1
      current += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  // 没闭合：把已解析出来的部分返回，交给调用方按「解析到多少算多少」处理
  if (current.trim()) args.push(current.trim())
  return args
}

/** 一行一条：`文件:行 硬编码版本 12 → 改用 DB_VERSION` 所需的原始信息 */
export const scanText = (text, file = '<text>') => {
  // 先抹注释与字符串内部，再做调用识别（长度不变 → 行号仍是原文行号）
  const masked = maskSource(text)
  const hits = []
  OPEN_CALL.lastIndex = 0
  for (const match of masked.matchAll(OPEN_CALL)) {
    const openParen = match.index + match[0].length - 1
    const args = parseArgs(masked, openParen + 1)
    if (args.length < 2) continue
    const version = args[1]
    if (!NUMERIC_LITERAL.test(version)) continue
    const line = masked.slice(0, match.index).split('\n').length
    hits.push({ file, line, version, call: match[0].replace(/\s+/g, '').replace(/\($/, '') })
  }
  return hits
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/')

const collectFiles = (dir, out) => {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectFiles(full, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!CODE_EXT.has(path.extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
}

const SELFTEST_CASES = [
  // 违规
  ["indexedDB.open('chat-demo', 12)", 12],
  ["indexedDB.open('chat-demo', 13, )", 13],
  ["openDB<ChatDB>('chat-demo', 13, { upgrade() {} })", 13],
  ["indexedDB.open('chat-demo', /* v12 */ 12)", 12],
  ["indexedDB.open('chat-demo', 0x0c)", 12],
  // 放行
  ["indexedDB.open('chat-demo')", null],
  ["indexedDB.open('chat-demo', DB_VERSION)", null],
  ["indexedDB.open('chat-demo', version)", null],
  ["openDB<ChatDB>('chat-demo', DB_VERSION, { upgrade(db, oldVersion) { db.createObjectStore('a', { keyPath: 'id', autoIncrement: 12 }) } })", null],
  ["await Promise.all([indexedDB.open('chat-a'), indexedDB.open('chat-b', DB_VERSION)])", null],
  ["// 旧写法：indexedDB.open('chat-demo', 12) —— 注释里的反例必须放行", null],
  ["/* indexedDB.open('chat-demo', 12) */", null],
  ["const doc = \"indexedDB.open('chat-demo', 12)\"", null],
]

const runSelftest = () => {
  const failures = []
  for (const [source, expected] of SELFTEST_CASES) {
    const hits = scanText(source)
    const got = hits.length ? Number(hits[0].version) : null
    if (got !== expected) failures.push({ source, expected, got, hits })
  }
  if (failures.length) {
    console.error(`[check:db-version] 自检失败 ${failures.length}/${SELFTEST_CASES.length}：判据本身错了`)
    for (const failure of failures) {
      console.error(`  输入 ${JSON.stringify(failure.source)}`)
      console.error(`    期望 ${failure.expected === null ? '放行' : `命中 ${failure.expected}`}，实际 ${failure.got === null ? '放行' : `命中 ${failure.got}`}`)
    }
    return 1
  }
  console.log(`[check:db-version] 自检通过：${SELFTEST_CASES.length} 条（硬编码必报 / 变量与默认版本必放行）`)
  return 0
}

const main = () => {
  const argv = process.argv.slice(2)
  const unknown = argv.filter((arg) => !['--verbose', '--selftest'].includes(arg))
  if (unknown.length) {
    console.error(`[check:db-version] 未知参数：${unknown.join(' ')}（支持 --verbose / --selftest）`)
    return 2
  }
  if (argv.includes('--selftest')) return runSelftest()

  const files = []
  for (const dir of SCAN_DIRS) collectFiles(path.join(ROOT, dir), files)
  if (!files.length) {
    console.error(`[check:db-version] 扫描到 0 个文件（${SCAN_DIRS.join(' / ')} 不存在？）—— 空扫描不算通过`)
    return 2
  }

  const hits = []
  for (const file of files) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    hits.push(...scanText(text, rel(file)))
  }

  if (argv.includes('--verbose')) {
    console.log(`[check:db-version] 扫描 ${files.length} 个文件（${SCAN_DIRS.join(' / ')}），命中 ${hits.length} 处`)
  }

  if (!hits.length) {
    console.log(
      `[check:db-version] 通过：${files.length} 个文件里没有写死的 DB 版本号（版本只来自 ${DB_MODULE} 的 ${DB_CONST}）`,
    )
    return 0
  }

  console.error('[check:db-version] 发现写死的 IndexedDB 版本号（#547：库版本升到 v13 时两个 L1 用例当场 VersionError）：')
  for (const hit of hits) console.error(`  ${hit.file}:${hit.line} 硬编码版本 ${hit.version} → 改用 ${DB_CONST}`)
  console.error('')
  console.error(`  正确写法：import { ${DB_CONST} } from '<指向 ${DB_MODULE} 的相对路径>'`)
  console.error(`            然后 ${'indexedDB.open'}(<db 名>, ${DB_CONST})`)
  console.error(`  不传第二个参数也可以（打开当前版本）；要测边界值就传由 ${DB_CONST} 推出来的变量。`)
  console.error(`  版本号只有一个事实来源：${DB_MODULE}。第二处数字就是下一次 VersionError。`)
  return 1
}

process.exitCode = main()

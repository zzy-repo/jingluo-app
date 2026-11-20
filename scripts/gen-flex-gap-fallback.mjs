/** 生成 flex gap 的 WebView 83 兜底样式（issue #173）。
 *
 * 为什么不能用 `@supports (gap: 1rem)` 兜底：WebView 83 上 gap 作为 grid/多列属性是支持的，
 * `@supports (gap: …)` 判定为真，兜底分支根本不会命中（和 CSS.supports 是同一个假阳性）。
 * 所以兜底样式统一挂在 `html[data-flex-gap-fallback]`（由 src/utils/flexGap.ts 实测决定）
 * 之下，用 margin 实现，支持 gap 的内核上这个属性不存在 → 不会出现双份间距。
 *
 * 两种作用域写法（issue #233）：
 *  - `*.module.css`：`:global(html[data-flex-gap-fallback]) .foo > *:not(:last-child)`
 *    —— CSS Module 会把裸写的作用域哈希掉，必须用 `:global()` 逃逸。
 *  - 其余普通 `.css`：`html[data-flex-gap-fallback] .foo > *:not(:last-child)`
 *    —— `:global()` 在非 module 文件里是非法伪类，整条规则会被浏览器丢掉，
 *    所以作用域只能裸写。`check:gap` 自 #217 起扫全部 `.css`，判定层
 *    （`gapFallbackRequirement()`）本来就不区分文件类型，之前卡住的只是这里的生成层。
 *
 * 用法：`node scripts/gen-flex-gap-fallback.mjs`（`pnpm run gen:gap`）
 * 幂等：先删旧块再按当前 CSS 重新生成。
 * 共存：文件里已经有人工写的兜底块（标记注释与生成块不同、不会被清掉）时，
 * 该选择器不再重复生成，只保留人工那一份。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SKIP, parseRules, readGap, renderFallback } from './lib/flexGapRules.mjs'
import { isVendored } from './lib/vendoredPaths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const START = '/* #173-fallback:start —— 由 node scripts/gen-flex-gap-fallback.mjs 生成，勿手改（issue #173） */'
const END = '/* #173-fallback:end */'

/** 全部 `.css`（含非 module 的普通 CSS）：#217 起 `check:gap` 就是这个口径，生成器必须一致 */
const walk = async (dir) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    // vendored 第三方目录不生成兜底（#417）：不去改写上游 CSS，也就不会让
    // 「已有产物再跑不该改文件」在 memory/style.css 上失守。
    if (isVendored(full)) continue
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

/** 删掉上一次生成的块（幂等）。人工块用的是另一段标记注释，不会被这里删掉。 */
const stripGenerated = (css) => {
  let out = css
  for (;;) {
    const start = out.indexOf(START)
    if (start === -1) return out
    const end = out.indexOf(END, start)
    if (end === -1) return out.slice(0, start)
    out = `${out.slice(0, start)}${out.slice(end + END.length)}`.replace(/\n{3,}$/u, '\n')
  }
}

/** 已经存在的兜底块（人工写的，或别的文件里的）覆盖了哪些选择器 —— 这些不重复生成 */
const PREEXISTING_RE = /(?::global\(\s*)?html\[data-flex-gap-fallback\]\s+([^{,}\n]+?)\s*>\s*\*?:not\(:last-child\)/gu

const coveredSelectorsIn = (css) => {
  const found = new Set()
  PREEXISTING_RE.lastIndex = 0
  for (const match of css.matchAll(PREEXISTING_RE)) found.add(match[1].trim())
  return found
}

const indent = (text, pad) => text.split('\n').map((line) => `${pad}${line}`).join('\n')

/** 兜底块的作用域：module 里要 `:global()` 逃逸，普通 CSS 裸写（`:global()` 会被整条丢掉） */
const scopeOf = (selector, module) =>
  selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      module
        ? `:global(html[data-flex-gap-fallback]) ${part} > *:not(:last-child)`
        : `html[data-flex-gap-fallback] ${part} > *:not(:last-child)`,
    )
    .join(',\n')

const buildSection = (file, rules, { module, existing }) => {
  const blocks = []
  const skipped = []
  // 同一个选择器可能在另一条规则里才声明 display:flex（gap 单独写在后面），
  // 所以先收集"本文件里已知是 flex 容器的选择器"。非 flex 容器上的 gap 本来就不生效，
  // 不需要兜底 —— 给它们加 margin 反而会改到不相关的布局。
  const flexSelectors = new Set()
  for (const rule of rules) {
    const display = rule.body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/i)
    if (display && /flex/u.test(display[1])) {
      for (const part of rule.selector.split(',')) flexSelectors.add(part.trim())
    }
  }
  const gapInfo = new Map()
  for (const rule of rules) {
    const gap = readGap(rule)
    if (gap === null) continue
    if (gap.grid) continue
    if (!flexSelectors.has(rule.selector.trim())) {
      skipped.push({ selector: rule.selector, why: '本文件里没有任何规则把它声明成 flex 容器，gap 本身不生效' })
      continue
    }
    const key = `${file}:${rule.selector}`
    if (SKIP[key]) {
      skipped.push({ selector: rule.selector, why: SKIP[key] })
      continue
    }
    gapInfo.set(rule.selector.trim(), { rowGap: gap.rowGap, colGap: gap.colGap, wrap: gap.wrap, column: gap.column })
    if (existing.has(rule.selector.trim())) {
      skipped.push({ selector: rule.selector, why: '已有人工兜底块（#173-fallback 标记写法），不重复生成' })
      continue
    }
    if (rule.selector.includes('>') || rule.selector.includes('&')) {
      skipped.push({ selector: rule.selector, why: '选择器里已经有子代组合符，无法机械加一层 > *' })
      continue
    }
    const block = renderFallback(rule.selector, gap, { global: module })
    if (block === null) continue
    blocks.push({ media: rule.media, block })
  }
  // 第二遍：`.navigation` 这类选择器在桌面是 column、窄屏 @media 里改成 row，
  // 但改方向的那条规则自己不写 gap —— 按源方向生成的兜底到了窄屏就不成立（margin-bottom 换不来横向间距）。
  // 所以"只改方向"的规则也要按它自己的方向补一条，并把另一条边距清零，避免两个方向同时生效。
  for (const rule of rules) {
    const direction = rule.body.match(/(?:^|;)\s*flex-(?:direction|flow)\s*:\s*([^;]+)/iu)
    if (!direction) continue
    if (readGap(rule) !== null) continue
    const base = gapInfo.get(rule.selector.trim())
    if (base === undefined) continue
    if (existing.has(rule.selector.trim())) continue
    const column = /column/u.test(direction[1])
    if (column === base.column) continue
    const main = column ? (base.rowGap ?? base.colGap) : (base.colGap ?? base.rowGap)
    if (main === null || /^0(?:px|rem|em)?$/u.test(main)) continue
    const side = column ? 'margin-bottom' : 'margin-right'
    const other = column ? 'margin-right' : 'margin-bottom'
    blocks.push({
      media: rule.media,
      block: `${scopeOf(rule.selector, module)} {\n  ${other}: 0;\n  ${side}: ${main};\n}`,
    })
  }
  if (blocks.length === 0) return { text: '', skipped }
  // 按源文件顺序输出：后面的 @media 覆盖写在后面，层叠顺序和原文件一致
  const body = blocks
    .map(({ media, block }) => {
      if (media.length === 0) return block
      return media.map((prelude) => `${prelude} {`).join('\n') + `\n${indent(block, '  ')}\n` + '}'.repeat(media.length)
    })
    .join('\n\n')
  return { text: `${START}\n${body}\n${END}\n`, skipped }
}

/** 生成（或刷新）某个 src 目录下的全部兜底块。测试用临时目录调它，CLI 用 `src/`。 */
export const generateGapFallback = async (srcDir = SRC) => {
  const files = await walk(srcDir)
  let total = 0
  let touched = 0
  const skips = []
  const changed = []
  for (const path of files) {
    const raw = readFileSync(path, 'utf8')
    const cleaned = stripGenerated(raw)
    const { rules } = parseRules(cleaned)
    const name = relative(srcDir, path).split(sep).join('/').split('/').pop()
    const { text, skipped } = buildSection(name, rules, {
      module: name.endsWith('.module.css'),
      existing: coveredSelectorsIn(cleaned),
    })
    const count = (text.match(/data-flex-gap-fallback/gu) ?? []).length
    total += count
    for (const item of skipped) skips.push({ file: name, ...item })
    const next = text === '' ? cleaned.replace(/\s+$/u, '\n') : `${cleaned.replace(/\s+$/u, '\n')}\n${text}`
    if (next !== raw) {
      writeFileSync(path, next)
      touched += 1
      changed.push(relative(srcDir, path).split(sep).join('/'))
    }
  }
  return { files: files.length, total, touched, changed, skips }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const result = await generateGapFallback(SRC)
  for (const item of result.skips) console.log(`  skip  ${item.file} ${item.selector} —— ${item.why}`)
  console.log(`gap 兜底规则 ${result.total} 条，改动 ${result.touched} 个文件`)
}

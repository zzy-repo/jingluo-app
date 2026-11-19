/** #216 的机械审计：`scrollbar-gutter`（首支持 Chromium 94）每一处都必须有不依赖它的等价实现。
 *
 * 背景：`scrollbar-gutter: stable both-edges` 的作用是「滚动条出现/消失时内容框宽度不变」。
 * 运行时下限是 WebView 83（Chromium 83），这条声明在那里是未知声明 → 整条丢弃 → 槽位退回动态，
 * 消息列表从短变长、开始出现滚动条的那一刻，内容横向跳一个滚动条宽度。
 *
 * 什么算「等价回退」：
 *  - `overflow-y: scroll`（滚动条常驻，槽位恒宽）算 —— 这是唯一不需要量滚动条宽度的等价实现；
 *  - `padding-right` / `padding-inline-end` **不算**。classic（非 overlay）滚动条是从容器内容框里
 *    挖掉宽度的，padding 只是把内容再往里推，滚动条出现的那一刻宽度照样变，跳动照旧；
 *  - `overflow: hidden` 在「本布局分支根本不滚动」时算（见下面 C）。
 *
 * 三种合格形状（A / B 二选一，C 单独成立）：
 *  A. 兜底与声明并存 + `@supports` 收回：同一规则里既有 `overflow-y: scroll` 又有
 *     `scrollbar-gutter: stable…`，另有 `@supports (scrollbar-gutter: …)` 块把同一选择器的
 *     `overflow-y` 收回 `auto`（现代内核不常显滚动条）。
 *  B. `@supports` 分层（与仓库里 `dvh` 的写法一致）：`scrollbar-gutter` 只出现在
 *     `@supports (scrollbar-gutter: …)` 块内，块外同一选择器有一条 `overflow-y: scroll` 兜底。
 *     禁止的是「只在 `@supports` 里写新属性、块外什么都不写」——那正是 #173 教育过的错法。
 *  C. `scrollbar-gutter: auto` 是 CSS 初始值，低内核丢掉它等于什么都没做，但它所在规则必须显式
 *     写死 `overflow` / `overflow-y`，否则 A / B 留下的常驻滚动条会漏进这个布局分支（例如窄屏下
 *     容器本来不该滚动）。
 *
 * 被两处使用：
 *  - `scripts/check-scrollbar-gutter-fallback.mjs`（`pnpm run check:gutter`，给人和 CI 看）
 *  - `tests/unit/scrollbar-gutter-fallback.test.mjs`（进 pnpm test 基线，改归零就红）
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const GUTTER_RE = /\bscrollbar-gutter\s*:\s*([^;}]+)/gu

/** `overflow-y: scroll` / `overflow: hidden auto` / `overflow: scroll` 之类「槽位恒宽」的声明 */
const SCROLL_RESERVE_RE = /(?:^|[;\s])overflow(?:-y)?\s*:\s*([^;}]+)/gu
/** 收回常驻滚动条：`overflow-y: auto`（现代内核由 scrollbar-gutter 接管槽位） */
const SCROLL_AUTO_RE = /(?:^|[;\s])overflow(?:-y)?\s*:\s*auto\b/iu
/** 显式写死 overflow 轴（C 类要求） */
const SCROLL_EXPLICIT_RE = /(?:^|[;\s])overflow(?:-[xy]|-block|-inline)?\s*:/iu

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, ' ')

const short = (root, path) => relative(root, path).split(sep).join('/')

/** 极简 CSS 块解析：只要能回答「这条声明属于哪条规则、外面套了哪些 at-rule」。
 *  返回的 `ownText` 是去掉子块之后的直接正文，用来只扫属于这条规则自己的声明。 */
export const parseCssBlocks = (css) => {
  const blocks = []
  const stack = []
  let cursor = 0
  let preludeStart = 0
  while (cursor < css.length) {
    const ch = css[cursor]
    if (ch === '{') {
      const node = {
        prelude: css.slice(preludeStart, cursor).trim().replace(/\s+/gu, ' '),
        ancestors: stack.map((item) => item.prelude),
        open: cursor,
        close: -1,
        children: [],
        ownText: '',
      }
      if (stack.length > 0) stack[stack.length - 1].children.push(node)
      blocks.push(node)
      stack.push(node)
      preludeStart = cursor + 1
      cursor += 1
      continue
    }
    if (ch === '}') {
      const node = stack.pop()
      if (node) node.close = cursor
      preludeStart = cursor + 1
      cursor += 1
      continue
    }
    cursor += 1
  }
  for (const node of blocks) {
    let text = ''
    let pos = node.open + 1
    for (const child of node.children) {
      text += css.slice(pos, child.open)
      pos = child.close === -1 ? css.length : child.close + 1
    }
    text += css.slice(pos, node.close === -1 ? css.length : node.close)
    node.ownText = text
  }
  return blocks
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

const isAtRule = (prelude) => prelude.startsWith('@')
const isSupportsGutter = (prelude) => /^@supports\b/u.test(prelude) && /\bscrollbar-gutter\s*:/u.test(prelude)
const isNotSupports = (prelude) => /^@supports\s+not\b/u.test(prelude)

/** 把一条规则（含 `&` 嵌套）的选择器归一成可比较的串 */
const normalizeSelector = (prelude) => prelude.trim().replace(/\s+/gu, ' ')

const ownDeclarations = (ownText) => {
  const decls = []
  for (const [, value] of ownText.matchAll(SCROLL_RESERVE_RE)) decls.push(value)
  return decls
}

const reservesScrollTrack = (ownText) =>
  ownDeclarations(ownText).some((value) => /\bscroll\b/iu.test(value) && !/\bauto\b/iu.test(value.replace(/\bscroll\b/giu, '')))

/** 审计单个文件正文，返回本文件里的 scrollbar-gutter 出现位置与缺失回退 */
export const auditCssText = (text) => {
  const clean = stripComments(text)
  const blocks = parseCssBlocks(clean)
  const occurrences = []
  const missing = []

  const rules = blocks.filter((block) => !isAtRule(block.prelude))

  for (const rule of blocks) {
    if (isAtRule(rule.prelude)) continue
    const matches = [...rule.ownText.matchAll(GUTTER_RE)]
    if (matches.length === 0) continue
    const selector = normalizeSelector(rule.prelude)
    const supportsAncestors = rule.ancestors.filter(isSupportsGutter)
    for (const match of matches) {
      const value = match[1].trim().replace(/\s+/gu, ' ')
      const line = lineOf(clean, rule.open + 1 + rule.ownText.indexOf(match[0]))
      const occurrence = { line, value, selector, shape: '' }
      const siblings = rules.filter((item) => normalizeSelector(item.prelude) === selector)
      const bare = siblings.filter((item) => !item.ancestors.some(isSupportsGutter))
      const bareReserve = bare.some((item) => reservesScrollTrack(item.ownText))
      const supportedReserve = supportsAncestors.length > 0

      if (/^auto$/iu.test(value)) {
        if (!SCROLL_EXPLICIT_RE.test(rule.ownText)) {
          missing.push({
            ...occurrence,
            why: '`scrollbar-gutter: auto` 虽是初始值（低内核丢弃等于没写），但这条规则没显式写 `overflow`/`overflow-y`，'
              + '别的规则留下的常驻滚动条会漏进这个布局分支',
          })
          occurrences.push({ ...occurrence, shape: 'missing' })
          continue
        }
        occurrences.push({ ...occurrence, shape: 'initial-value' })
        continue
      }

      const supportsWithdraw = blocks.some((block) => {
        if (!isSupportsGutter(block.prelude)) return false
        if (isNotSupports(block.prelude)) return false
        return block.children.some(
          (child) => normalizeSelector(child.prelude) === selector && SCROLL_AUTO_RE.test(child.ownText),
        )
      })

      if (supportedReserve) {
        // B：gutter 落在 @supports 里 → 块外的裸规则必须有常驻滚动条兜底
        if (!bareReserve) {
          missing.push({
            ...occurrence,
            why: '`scrollbar-gutter` 只在 `@supports` 块里，块外同一选择器没有 `overflow-y: scroll` 兜底'
              + '（#173 的错法：分层只写了新属性，低内核上什么都不生效）',
          })
          occurrences.push({ ...occurrence, shape: 'missing' })
        } else {
          occurrences.push({ ...occurrence, shape: 'supports-layered' })
        }
        continue
      }

      // A：兜底与声明在同一规则里，另由 @supports 收回常驻滚动条
      if (!reservesScrollTrack(rule.ownText)) {
        missing.push({
          ...occurrence,
          why: '`scrollbar-gutter` 没有等价回退：需要同一规则里的 `overflow-y: scroll`（滚动条常驻），'
            + '`padding-right` 不算（classic 滚动条仍然吃宽度）',
        })
        occurrences.push({ ...occurrence, shape: 'missing' })
        continue
      }
      if (!supportsWithdraw) {
        missing.push({
          ...occurrence,
          why: '有 `overflow-y: scroll` 兜底，但缺 `@supports (scrollbar-gutter: …)` 把同一选择器的 '
            + '`overflow-y` 收回 `auto`，现代内核会被迫常显滚动条',
        })
        occurrences.push({ ...occurrence, shape: 'missing' })
        continue
      }
      occurrences.push({ ...occurrence, shape: 'fallback-plus-supports' })
    }
  }

  return {
    occurrences: occurrences.sort((a, b) => a.line - b.line),
    missing: missing.sort((a, b) => a.line - b.line),
  }
}

const walk = async (dir, match) => {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, match)))
    else if (match(entry.name)) out.push(full)
  }
  return out
}

/** 扫描 `src/**` 里所有可能写 CSS 的文件（含内联样式与 `.html`），返回汇总 */
export const auditScrollbarGutter = async (srcDir) => {
  const files = await walk(srcDir, (name) => /\.(?:css|html|tsx?|jsx?|mjs)$/u.test(name))
  const occurrences = []
  const missing = []
  let scannedWithHit = 0
  for (const path of files) {
    const text = readFileSync(path, 'utf8')
    if (!/\bscrollbar-gutter\s*:/u.test(stripComments(text))) continue
    scannedWithHit += 1
    const result = auditCssText(text)
    for (const item of result.occurrences) occurrences.push({ ...item, file: short(srcDir, path) })
    for (const item of result.missing) missing.push({ ...item, file: short(srcDir, path) })
  }
  return { files: files.length, scannedWithHit, occurrences, missing }
}

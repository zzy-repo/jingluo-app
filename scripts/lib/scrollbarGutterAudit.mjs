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
 * #236 补的第四个维度（A/B/C 都只看「写着 `scrollbar-gutter` 的那条规则」，看不见换手的容器）：
 *  D. **媒体查询里靠 `overflow-y: auto` 才长滚动条的容器**。窄屏下滚动这件事从 `.container`
 *     换手给了 `.scroll`，`.scroll` 自己不写 `scrollbar-gutter`，于是 A/B/C 一眼扫过去「本文件
 *     每处 gutter 都有兜底」，缺陷却还在：classic 滚动条环境（Windows/Linux 桌面窗口）里滚动条
 *     出现的那一刻，`.scroll` 的内容框少一个滚动条宽度，已经渲染的行整批重新折行。
 *     要求：同一选择器在**指针作用域**（`(hover: hover) and (pointer: fine)`，判据见下）内补一条
 *     `overflow-y: scroll` 常驻槽位，并在同一指针作用域里用 `@supports (scrollbar-gutter: …)` 收回 `auto`。
 *     为什么必须限定指针作用域：overlay 滚动条（Android WebView / macOS / Win11 自动隐藏）宽度是 0，
 *     常驻与否都不吃宽度，电话上没必要替桌面窗口的问题付代价；`hover` / `pointer` 媒体特性
 *     Chromium 41 起就有，83 上判得出来。
 *     只在「文件里确实有 `scrollbar-gutter`」时启用 —— 没参与槽位决策的文件（别处的 `overflow-y: auto`
 *     面板）不该被这条规则拖进来。
 *
 * 被两处使用：
 *  - `scripts/check-scrollbar-gutter-fallback.mjs`（`pnpm run check:gutter`，给人和 CI 看）
 *  - `tests/unit/scrollbar-gutter-fallback.test.mjs`（进 pnpm test 基线，改归零就红）
 */

import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const GUTTER_RE = /\bscrollbar-gutter\s*:\s*([^;}]+)/gu
/** 本文件是否在为滚动条槽位做决定（维度 D 的启用开关；不带 `g`，避免 lastIndex 副作用） */
const GUTTER_PRESENT_RE = /\bscrollbar-gutter\s*:/u

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
    // 维度 D：媒体查询里换手的滚动容器（可能一条 gutter 声明都没有，所以单独列）
    ...auditNarrowScrollContainers(clean, blocks),
  }
}

/** `@media` 前奏里出现指针/悬停媒体特性 → 这一档是「按输入设备分流」，不是「按宽度分流」 */
const POINTER_SCOPE_RE = /(?:^|[\s(])(?:any-)?(?:hover|pointer)\s*:/iu
const MEDIA_PRELUDE_RE = /^@media[\s(]/u
const isSupportsAtRule = (prelude) => /^@supports[\s(]/u.test(prelude)

/**
 * 维度 D（#236）：媒体查询里「靠 `auto` 才长滚动条」的容器，有没有为 classic 滚动条环境做过处置。
 *
 * 只回答一件事：这批容器里，哪些还缺「指针作用域内的 `overflow-y: scroll` 常驻槽位 + 同作用域
 * `@supports` 收回」这一对。文件里没有 `scrollbar-gutter` 就整段跳过（不归它管）。
 */
export const auditNarrowScrollContainers = (text, blocks = parseCssBlocks(stripComments(text))) => {
  const clean = stripComments(text)
  if (!GUTTER_PRESENT_RE.test(clean)) return { containers: [], uncovered: [] }

  const rules = blocks.filter((block) => !isAtRule(block.prelude))
  const containers = []
  const uncovered = []

  for (const rule of rules) {
    // `@supports` 块内的规则是 A/B 的收回侧，交给上面判
    if (rule.ancestors.some(isSupportsAtRule)) continue
    const mediaAncestors = rule.ancestors.filter((prelude) => MEDIA_PRELUDE_RE.test(prelude))
    // 只管媒体查询里换手的容器：没有媒体查询约束的容器滚动条从一开始就在，不会「出现」
    if (mediaAncestors.length === 0) continue
    // 只管靠 `auto` 才长滚动条的容器；已经 `overflow-y: scroll` 的容器槽位本来就恒宽
    if (!SCROLL_AUTO_RE.test(rule.ownText)) continue
    if (reservesScrollTrack(rule.ownText)) continue

    const selector = normalizeSelector(rule.prelude)
    const media = mediaAncestors[mediaAncestors.length - 1]
    const line = lineOf(clean, rule.open)
    // 作用域必须同时满足两件事：落在被审计的这一档宽度上，且按输入设备分流（指针/悬停媒体特性）。
    // 不能只在别的断点上做了处置就算过。按「祖先链」判而不是按单条前奏判，因为两层嵌套
    // （`@media 窄屏 { @media (hover: hover) and (pointer: fine) { … } }`）才是可靠写法：
    // `not all and (min-width: 768px) and (pointer: fine)` 里的 `not` 否定整条查询，
    // 放宽到触屏上也会成立，限定等于没写。
    const inScopeChain = (ancestors) => {
      const medias = ancestors.filter((prelude) => MEDIA_PRELUDE_RE.test(prelude))
      return medias.some((prelude) => prelude.includes(media))
        && medias.some((prelude) => POINTER_SCOPE_RE.test(prelude))
    }

    const scopedReserve = rules.some(
      (item) =>
        normalizeSelector(item.prelude) === selector
        && inScopeChain(item.ancestors)
        && reservesScrollTrack(item.ownText),
    )
    const scopedWithdraw = blocks.some(
      (block) =>
        isSupportsGutter(block.prelude)
        && !isNotSupports(block.prelude)
        && inScopeChain(block.ancestors)
        && block.children.some(
          (child) => normalizeSelector(child.prelude) === selector && SCROLL_AUTO_RE.test(child.ownText),
        ),
    )

    const container = { line, selector, media, scopedReserve, scopedWithdraw }
    containers.push(container)
    if (!scopedReserve) {
      uncovered.push({
        ...container,
        why: '媒体查询里的滚动容器靠 `overflow-y: auto` 才长滚动条：classic 滚动条环境下滚动条出现的一刻'
          + '内容框少一个滚动条宽度，已经渲染的行会整批重新折行（Chromium 83 上 `scrollbar-gutter` 被丢弃，'
          + '这条容器也没写它）。需要在「会出现占位式滚动条」的环境里补一条 `overflow-y: scroll`：'
          + '用 `(hover: hover) and (pointer: fine)` 之类的指针媒体特性限定，别让 overlay 滚动条的手机也常驻槽位',
      })
    } else if (!scopedWithdraw) {
      uncovered.push({
        ...container,
        why: '指针作用域里有了 `overflow-y: scroll` 常驻槽位，但缺同一作用域内的 `@supports (scrollbar-gutter: …)`'
          + '把 `overflow-y` 收回 `auto`，支持槽位的现代内核会被迫常显一条空滚动条',
      })
    }
  }

  return { containers, uncovered }
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
  const containers = []
  const uncoveredContainers = []
  let scannedWithHit = 0
  for (const path of files) {
    const text = readFileSync(path, 'utf8')
    if (!GUTTER_PRESENT_RE.test(stripComments(text))) continue
    scannedWithHit += 1
    const result = auditCssText(text)
    for (const item of result.occurrences) occurrences.push({ ...item, file: short(srcDir, path) })
    for (const item of result.missing) missing.push({ ...item, file: short(srcDir, path) })
    for (const item of result.containers) containers.push({ ...item, file: short(srcDir, path) })
    for (const item of result.uncovered) uncoveredContainers.push({ ...item, file: short(srcDir, path) })
  }
  return { files: files.length, scannedWithHit, occurrences, missing, containers, uncoveredContainers }
}

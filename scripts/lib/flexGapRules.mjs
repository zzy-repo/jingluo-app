/** 解析 CSS 里「声明了 gap 的 flex 规则」，供 #173 兜底生成器与检查脚本共用。
 *
 * 只做机械匹配，不追求通用 CSS 解析器：仓库里的 CSS 是手写文件，
 * 规则体里没有嵌套（有嵌套的会被跳过并在生成器里报出来）。
 *
 * #217：扫描口径从 `*.module.css` 扩到全部 `.css`（`markdown.css` 这类普通 CSS
 * 没有 CSS Module 的局部作用域，漏扫等于没有守卫）；`flex-wrap` 上的交叉轴 gap
 * 不再一律排除，见 `gapFallbackRequirement`。
 */

/** 有意不加兜底的规则：key = `文件名:选择器`，value = 原因 */
export const SKIP = {
  'Settings.module.css:.backgroundRow': 'issue #159 的窄屏修复自己用 margin 排版，这里再加一层会变成双份间距',
}

const GAP_RE = /(^|;)\s*gap\s*:\s*([^;]+)/i
const ROW_GAP_RE = /(^|;)\s*row-gap\s*:\s*([^;]+)/i
const COL_GAP_RE = /(^|;)\s*column-gap\s*:\s*([^;]+)/i
const DISPLAY_RE = /(^|;)\s*display\s*:\s*([^;]+)/i
const DIRECTION_RE = /(^|;)\s*flex-direction\s*:\s*([^;]+)/i
const WRAP_RE = /(^|;)\s*flex-wrap\s*:\s*([^;]+)/i
const FLOW_RE = /(^|;)\s*flex-flow\s*:\s*([^;]+)/i

const decl = (body, re) => {
  const match = body.match(re)
  return match ? match[2].trim() : null
}

const isZero = (value) => /^0(?:px|rem|em)?$/.test(String(value).trim())

/** 叶子规则（顶层、@media 内都算）；带嵌套的父规则只用嵌套之前的声明 */
export const parseRules = (css) => {
  const rules = []
  const nestedParents = []
  const frames = [{ prelude: '', body: '', tail: '', nested: false }]
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      i = end === -1 ? css.length : end + 1
      continue
    }
    const frame = frames[frames.length - 1]
    if (ch === '{') {
      // tail 里既有本层已写完的声明，也有紧跟的子规则前导文本，按最后一个 ; 或 } 切开
      const cut = Math.max(frame.tail.lastIndexOf(';'), frame.tail.lastIndexOf('}'))
      frame.body += frame.tail.slice(0, cut + 1)
      const prelude = frame.tail.slice(cut + 1).trim()
      frame.tail = ''
      if (prelude !== '') frame.nested = true
      frames.push({ prelude, body: '', tail: '', nested: false })
      continue
    }
    if (ch === '}') {
      const done = frames.pop()
      if (done && done.tail !== '') done.body += done.tail
      const parents = frames.slice(1).map((parent) => parent.prelude)
      if (done && done.prelude !== '' && !done.prelude.startsWith('@')) {
        // 只认 @media 作为生效条件；其余 at-rule（@supports 等）一律当"不可机械生成"跳过
        if (parents.every((prelude) => prelude.startsWith('@media'))) {
          rules.push({ media: parents, selector: done.prelude, body: done.body })
        }
      }
      if (done && done.nested && done.prelude !== '') nestedParents.push({ selector: done.prelude, media: parents })
      continue
    }
    frame.tail += ch
  }
  return { rules, nestedParents }
}

/** 一条规则里的 gap 事实 */
export const readGap = (rule) => {
  const gap = decl(rule.body, GAP_RE)
  let rowGap = null
  let colGap = null
  if (gap !== null) {
    const parts = gap.split(/\s+/).filter(Boolean)
    rowGap = parts[0]
    colGap = parts.length > 1 ? parts[1] : parts[0]
  }
  const rowOnly = decl(rule.body, ROW_GAP_RE)
  const colOnly = decl(rule.body, COL_GAP_RE)
  if (rowOnly !== null) rowGap = rowOnly
  if (colOnly !== null) colGap = colOnly
  if (rowGap === null && colGap === null) return null
  const display = decl(rule.body, DISPLAY_RE)
  const direction = decl(rule.body, DIRECTION_RE)
  const flow = decl(rule.body, FLOW_RE)
  const wrap = decl(rule.body, WRAP_RE)
  const column = /column/.test(direction ?? '') || /column/.test(flow ?? '')
  const wraps = /wrap/.test(wrap ?? '') || /wrap/.test(flow ?? '')
  return {
    rowGap,
    colGap,
    grid: /grid/.test(display ?? ''),
    column,
    wrap: wraps,
  }
}

/**
 * 这条 gap 在「不认 flex gap 的内核」上是不是真的会丢间距 —— 需要兜底吗？丢哪些轴？
 *
 * 判断依据（issue #217 重新审视 `flex-wrap` 排除规则时定下）：
 *  - **主轴**上的 gap（row 方向的 `column-gap` / column 方向的 `row-gap`）在**任何** flex
 *    容器上都有视觉作用，丢了一律要兜底。
 *  - **交叉轴**上的 gap（row 方向的 `row-gap` / column 方向的 `column-gap`）只在容器**会换行**
 *    （`flex-wrap: wrap`）时才撑出行与行之间的间距。单行 flex 容器上它本就不生效，低内核丢了
 *    也没有任何差别 —— 这才是「按设计排除」成立的那一半。
 *
 * 所以原来的排除规则错在把交叉轴 gap 一律排除：`.toolBody` 是 `display:flex; flex-wrap:wrap;
 * row-gap:6px`，换行后的行间距**完全靠**这个 `row-gap`，排除即等于无兜底。
 */
export const gapFallbackRequirement = (gap) => {
  const mainAxis = gap.column ? gap.rowGap : gap.colGap
  const crossAxis = gap.column ? gap.colGap : gap.rowGap
  const live = (value) => value !== null && !isZero(value)
  const main = live(mainAxis) ? mainAxis : null
  const cross = gap.wrap && live(crossAxis) ? crossAxis : null
  return { main, cross, required: main !== null || cross !== null }
}

/** 兜底块内容：只写 margin，绝不写 gap */
export const renderFallback = (selector, gap) => {
  const { main, cross } = gapFallbackRequirement(gap)
  // 只给「除最后一个子元素之外」加边距：不碰 margin-left，才能让 margin-left:auto 的
  // 右对齐子元素（如 ChatInput .right）继续工作。
  const mainSide = gap.column ? 'margin-bottom' : 'margin-right'
  const crossSide = gap.column ? 'margin-right' : 'margin-bottom'
  const lines = []
  if (main !== null) lines.push(`  ${mainSide}: ${main};`)
  // 会换行的容器才有交叉轴间距：`.toolBody` 就是只有 row-gap、没有 column-gap 的那一类，
  // 主轴什么都不写，只补换行后的行间距。
  if (cross !== null) lines.push(`  ${crossSide}: ${cross};`)
  if (lines.length === 0) return null
  const scope = selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `:global(html[data-flex-gap-fallback]) ${part} > *:not(:last-child)`)
    .join(',\n')
  return `${scope} {\n${lines.join('\n')}\n}`
}

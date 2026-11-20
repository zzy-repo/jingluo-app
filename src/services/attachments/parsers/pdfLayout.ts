/**
 * pdfjs TextItem → 按行聚类的纯文本（Issue #480「尽可能保持阅读顺序」）。
 *
 * pdfjs 的 `getTextContent()` 给的是**按内容流顺序**铺开的文本片段，不是行：一个段落可能是十几个
 * item，左右栏、页眉页脚还会交叉出现。直接用 `items.map(i => i.str).join('')` 会得到一坨没有
 * 换行的文本，所以这里按几何位置重组：
 *
 *   1. 取每个 item 的基线 `transform[5]`（y）与起点 `transform[4]`（x）；
 *   2. 先按 **y 降序**（PDF 坐标系原点在左下，y 越大越靠上）、**x 升序**排序；
 *   3. 相邻 item 的 y 差在 `0.5 × 字号`（至少 1）内视为同一行，同行内按 x 升序拼接；
 *   4. 拼接时按版面间隙补空格，中文（CJK）之间不补。
 *
 * 这是**版面启发式**，不是真正的列检测：双栏 PDF 仍可能把左右栏的行交错输出。本模块只做
 * 行聚类这一层，列/段落判读留给后续单子（#480 明确「尽可能」）。
 *
 * 纯函数、不碰 DOM，可直接单测。
 */

/** 单行容差的下限（PDF 用户单位）：字号极小时防止把行内微小抖动当成新行 */
const MIN_LINE_TOLERANCE = 1

/** 行内补空格的相对阈值：间隙超过 0.25 个字号且两侧都没有空白时补一个空格 */
const SPACE_GAP_RATIO = 0.25

/** CJK 字符（含全角标点、假名、注音）：这些字符之间不使用空格分词 */
const CJK_CHAR = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/

type LayoutItem = {
  text: string
  x: number
  /** 行末位置（左边界 + 宽度），用于算与下一个 item 的间隙 */
  end: number
  y: number
  /** 字号（`transform[3]` 的绝对值；取不到时退回 item.height） */
  size: number
}

const toFiniteNumber = (value: unknown): number => (typeof value === 'number' && isFinite(value) ? value : 0)

/**
 * 把一条 pdfjs item 归一成排版用的最小结构；不是文本 item（标记内容、缺 str、纯空白）返回 null。
 * 用 unknown 入参而不是 pdfjs 的类型：产物是外部脚本，字段形状变化不能变成编译期假绿。
 */
const toLayoutItem = (raw: unknown): LayoutItem | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const item = raw as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown }
  if (typeof item.str !== 'string' || item.str.length === 0) {
    return null
  }
  const transform = Array.isArray(item.transform) ? item.transform : []
  const x = toFiniteNumber(transform[4])
  const y = toFiniteNumber(transform[5])
  const size = Math.abs(toFiniteNumber(transform[3])) || toFiniteNumber(item.height) || MIN_LINE_TOLERANCE * 10
  const width = toFiniteNumber(item.width)
  return { text: item.str, x, end: x + width, y, size }
}

/** 同一行的两条 item 之间要不要补空格 */
const needsSpace = (previous: LayoutItem, next: LayoutItem): boolean => {
  const gap = next.x - previous.end
  if (gap <= next.size * SPACE_GAP_RATIO) {
    return false
  }
  const left = previous.text.charAt(previous.text.length - 1)
  const right = next.text.charAt(0)
  if (/\s/u.test(left) || /\s/u.test(right)) {
    return false
  }
  return !CJK_CHAR.test(left) && !CJK_CHAR.test(right)
}

/** 一行的 items（可能乱序）→ 一行文本 */
const joinLine = (items: LayoutItem[]): string => {
  const sorted = items.slice().sort((a, b) => a.x - b.x)
  let line = ''
  let previous: LayoutItem | null = null
  for (const item of sorted) {
    if (previous && needsSpace(previous, item)) {
      line += ' '
    }
    line += item.text
    previous = item
  }
  // 行末多余空白：pdfjs 常在行尾塞空格，留着会让下游按行比较时误判
  return line.replace(/[ \t]+$/u, '')
}

/**
 * 一页的 text content items → 按阅读顺序排列的非空行。
 *
 * 返回 `string[]` 而不是拼好的整段：调用方要按页加 `[第N页]` 标记，也需要知道行数。
 */
export const textItemsToLines = (items: unknown[] | undefined): string[] => {
  if (!items || items.length === 0) {
    return []
  }
  const layout: LayoutItem[] = []
  for (const raw of items) {
    const item = toLayoutItem(raw)
    if (item) {
      layout.push(item)
    }
  }
  if (layout.length === 0) {
    return []
  }
  // y 降序（上 → 下）、同 y 按 x 升序（左 → 右）。y 完全相等时比较 x，保证排序稳定可复现。
  layout.sort((a, b) => (a.y === b.y ? a.x - b.x : b.y - a.y))

  const lines: string[] = []
  let current: LayoutItem[] = []
  let currentY = 0
  const flush = (): void => {
    if (current.length === 0) {
      return
    }
    const line = joinLine(current)
    if (line !== '') {
      lines.push(line)
    }
    current = []
  }
  for (const item of layout) {
    if (current.length === 0) {
      current = [item]
      currentY = item.y
      continue
    }
    const tolerance = Math.max(MIN_LINE_TOLERANCE, Math.min(item.size, current[0].size) * 0.5)
    if (Math.abs(item.y - currentY) <= tolerance) {
      current.push(item)
      continue
    }
    flush()
    current = [item]
    currentY = item.y
  }
  flush()
  return lines
}

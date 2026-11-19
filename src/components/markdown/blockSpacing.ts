/**
 * 标题 / 段落与其后列表的间距状态 —— issue #213。
 *
 * 原来这件事靠 `h4:has(+ ul)` 这类关系选择器表达。`:has()` 首支持 Chromium 105，
 * 而本项目运行时下限是 WebView 83（Chromium 83）。更糟的是 `:has()` 写在
 * **选择器列表**里，83 上它是未知伪类，浏览器会把整条选择器判为无效并丢掉
 * **整条规则** —— 连同列表里其它本来合法的选择器一起丢。
 *
 * 所以这里不再让 CSS 去「看兄弟」，而是在**渲染期**就知道状态：mdast 里当前节点
 * 的下一个块级兄弟是什么，一眼就能看出来。知道状态了就打显式类名，
 * 低内核上照样生效，不依赖任何新 CSS 特性（也就不用 `@supports selector(:has(*))`
 * —— 那条在 83 上本身就可能解析异常）。
 *
 * 类名只管「语义 = 下一个实际渲染出来的兄弟是列表」，具体间距写在各 CSS 文件里：
 *   src/components/markdown/markdown.css        h4..h6 → 8px
 *   src/components/messages/thinking.markdown.css h3..h6 → 4px，段落（后接 ol）→ 4px
 */

/** 下一个兄弟是列表时打上的显式状态类；按 ul / ol 分开，保持与旧 `:has(+ ul|ol)` 逐条等价 */
export const BEFORE_LIST_CLASS = Object.freeze({
  ul: 'ds-markdown-before-ul',
  ol: 'ds-markdown-before-ol',
} as const)

export type BeforeListKind = keyof typeof BEFORE_LIST_CLASS

/** 会产出 DOM 元素的块级节点类型（其余走 renderer 的 default 分支 → null） */
const RENDERED_TYPES = new Set([
  'math',
  'thematicBreak',
  'blockquote',
  'html',
  'heading',
  'paragraph',
  'code',
  'table',
  'list',
])

type BlockLike = { type: string; ordered?: boolean | null; children?: readonly unknown[] }

/** 该节点在 DOM 里是否真的留下一个元素 —— 决定「相邻兄弟」到底是谁 */
const rendersElement = (node: BlockLike): boolean => {
  if (!RENDERED_TYPES.has(node.type)) {
    return false
  }
  if (node.type === 'heading') {
    return (node.children?.length ?? 0) > 0
  }
  return true
}

/**
 * 返回 `nodes[index]` 之后**实际渲染出来的**第一个兄弟若是列表则给出种类，否则 null。
 * 跳过不产出元素的行内定义 / 空标题，避免类名打在「隔了一层空气」的节点上。
 */
export function beforeListClass(
  nodes: readonly BlockLike[],
  index: number
): BeforeListKind | null {
  for (let i = index + 1; i < nodes.length; i += 1) {
    const next = nodes[i]
    if (!next || !rendersElement(next)) {
      continue
    }
    if (next.type !== 'list') {
      return null
    }
    return next.ordered ? 'ol' : 'ul'
  }
  return null
}

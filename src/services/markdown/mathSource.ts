/**
 * 公式源码（issue #486 P0-2）。
 *
 * KaTeX 把 TeX 原文放在隐藏的 MathML 子树里：`.katex-mathml annotation[encoding="application/x-tex"]`。
 * 直接框选复制拿到的是排版后的字形碎片（官方 Web 也有这个缺口，社区插件就是为读这个节点而写的），
 * 所以「复制公式」必须从这棵子树取原文，而不是读可见 DOM 的 textContent。
 */

/** TeX 原文所在的节点；只在 KaTeX 的 MathML 输出里存在 */
export const MATH_TEX_SELECTOR = '.katex-mathml annotation[encoding="application/x-tex"]'

/** 从渲染结果里取 TeX 原文；取不到（没有 MathML 输出 / 尚未渲染完）返回 null */
export const readMathTexSource = (host: HTMLElement | null): string | null => {
  if (!host || typeof host.querySelector !== 'function') {
    return null
  }
  const annotation = host.querySelector(MATH_TEX_SELECTOR)
  const text = annotation ? annotation.textContent : null
  return text && text.trim() !== '' ? text.trim() : null
}

/**
 * 去掉外层的 `$…$` / `$$…$$`。
 *
 * 复制出去的必须是**纯 TeX**（issue #486 验收口径）：行内 / 行间由使用位置决定，
 * 带上定界符反而会让「粘到 `$$` 里」的人得到 `$$$$…`。mdast 的 `value` 本来就不带定界符，
 * 这里只是防一手「注释里的 annotation 已经带上了定界符」的渲染器变体，仅在首尾**成对**时剥掉。
 */
export const stripMathDelimiters = (tex: string): string => {
  const value = tex.trim()
  if (value.length > 4 && value.startsWith('$$') && value.endsWith('$$')) {
    return value.slice(2, -2).trim()
  }
  if (value.length > 2 && value.startsWith('$') && value.endsWith('$')) {
    return value.slice(1, -1).trim()
  }
  return value
}

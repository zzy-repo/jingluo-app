/** flex gap 能力探测 + 兜底开关（issue #173）。
 *
 * 为什么不能用 CSS.supports：`gap` 从 Chrome 66 起就作为**多列布局 / grid** 属性存在，
 * WebView 83 上 `CSS.supports('gap', '12px')` 和 `@supports (gap: 12px)` 都返回 true，
 * 但 flex 容器里的 gap 到 Chromium 84 才生效 —— 于是「探测通过、间距为 0」。
 * 能力只能**量**：造一个离屏 flex 容器（真实 gap: 8px），看两个子元素是否真的分开。
 *
 * 兜底样式全部写在 `html[data-flex-gap-fallback]` 之下，只有这里判定「不支持」时才开；
 * 支持 gap 的内核上这个属性根本不会出现，所以不存在「gap + margin 双份间距」。
 */

import { verifyCss } from './capabilities.js'

const PROBE_GAP = 8

/** 探针容器的固定样式：离屏、定宽，横排不换行（gap 由 verifyCss 写，这里不重复声明） */
const PROBE_STYLE =
  'position:absolute;left:-9999px;top:0;width:100px;height:10px;overflow:hidden;' +
  'display:flex;flex-direction:row;flex-wrap:nowrap'

/**
 * 真机/模拟器上量一次 flex gap 是否生效。
 *
 * 量法交给 `utils/capabilities.ts` 的 `verifyCss`（#209）：它负责造离屏元素、写样式、摘元素、缓存结论，
 * 这里只负责「怎么读回来」—— 几何。量出来的间距 ≈ PROBE_GAP 才算生效，0 就是没生效。
 */
export const detectFlexGap = (doc: Document): boolean =>
  verifyCss(
    'column-gap',
    `${PROBE_GAP}px`,
    (host) => {
      const first = doc.createElement('div')
      const second = doc.createElement('div')
      first.style.cssText = 'width:10px;height:10px;flex:0 0 auto'
      second.style.cssText = 'width:10px;height:10px;flex:0 0 auto'
      host.append(first, second)
      const left = first.getBoundingClientRect()
      const right = second.getBoundingClientRect()
      // 允许亚像素误差：支持时实测间距 ≈ 8，不支持时是 0
      return right.left - left.right >= PROBE_GAP - 0.5
    },
    { doc, baseStyle: PROBE_STYLE }
  )

/** 在首屏渲染前调用：不支持 flex gap 时挂 `html[data-flex-gap-fallback]` */
export const setupFlexGapFallback = (doc: Document = document): boolean => {
  const supported = detectFlexGap(doc)
  if (supported) {
    doc.documentElement.removeAttribute('data-flex-gap-fallback')
  } else {
    doc.documentElement.setAttribute('data-flex-gap-fallback', '')
  }
  return supported
}

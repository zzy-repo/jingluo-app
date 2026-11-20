/**
 * 消息列表「阅读位置锚定」的纯计算（Issue #610 症状二）。
 *
 * 为什么需要：虚拟列表（#45）的行高是**实测**出来的，没实测的用估值占位。窗口里新挂上一行、
 * 或者某一行长高（流式回答 / 进入编辑 / 切换版本），上下占位（`topPad` / `bottomPad`）就会跟着变，
 * 于是同一份 `scrollTop` 下，用户正在读的那一行在屏幕上跳一段 —— 长会话上滑「滚到某个位置被弹回去」
 * 就是这么来的。浏览器的 scroll anchoring 反而会帮倒忙：它盯的是一个 DOM 节点，占位 div 一变高变矮
 * 就按自己的判断改 `scrollTop`（实测能一次跳 900+ px），所以滚动容器上已经关掉它（`overflow-anchor: none`，
 * 见 `MessageList.module.css`），改由这里自己算。
 *
 * 坐标系：**内容坐标**（相对滚动内容顶部，与 `scrollTop` 无关）。这样用户滚动不会让锚点失效，
 * 也不需要给 scroll 事件挂任何额外逻辑。
 *
 * 本文件零 DOM、零 React、零依赖，`tests/unit` 可直接 import（ES2017 语法）。
 */

/** 一行在内容坐标系里的位置：`top` = 行顶距内容顶部，`height` = 行高 */
export type RowSpan = {
  id: string
  top: number
  height: number
}

/** 锚点：行 id + 该行顶部在内容坐标系里的偏移 */
export type ScrollAnchor = {
  /** 消息 id，不是下标 —— 编辑会让后面的消息消失、下标会整体前移 */
  id: string
  top: number
}

const finite = (value: number): boolean => Number.isFinite(value)

/**
 * 取「第一条还露出视口顶」的行当锚点（屏幕上看到的第一行）。
 *
 * @param viewportTop 视口顶在**内容坐标**里的位置，即滚动容器的 `scrollTop`
 * @returns 没有行、或者所有行都已经滚到视口上方时返回 null（这时不做修正）
 */
export const pickAnchor = (rows: readonly RowSpan[], viewportTop: number): ScrollAnchor | null => {
  const top = finite(viewportTop) && viewportTop > 0 ? viewportTop : 0
  for (const row of rows) {
    if (!finite(row.top) || !finite(row.height)) {
      continue
    }
    if (row.top + row.height > top) {
      return { id: row.id, top: row.top }
    }
  }
  return null
}

/**
 * 锚点行在新布局里移动了多少像素 —— 也就是需要补进 `scrollTop` 的量。
 *
 * >0：内容被顶下去了（要跟着往下滚）；<0：内容缩短了（要跟着往上收）。
 * 锚点行已经不在传进来的行里（滚出挂载窗口 / 消息被删）时返回 0：宁可不修正，也不要乱跳。
 */
export const anchorShift = (anchor: ScrollAnchor | null, rows: readonly RowSpan[]): number => {
  if (!anchor) {
    return 0
  }
  for (const row of rows) {
    if (row.id === anchor.id) {
      const shift = row.top - anchor.top
      return finite(shift) ? shift : 0
    }
  }
  return 0
}

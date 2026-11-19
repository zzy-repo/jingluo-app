import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

/** 窄于 768px 按移动端布局 */
const query = window.matchMedia('not all and (min-width: 768px)')

const subscribe = (onChange: () => void) => {
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export const useIsMobile = () => useSyncExternalStore(subscribe, () => query.matches)

/** 声明了可滚动的 overflow —— 注意它只说明「溢出时允许滚」，不说明此刻真的存在可滚距离 */
const SCROLLABLE_OVERFLOW = /auto|scroll/

/** 可滚判定：element 是祖先链上第一处声明了可滚的容器，proven 是几何回读给出的证据 */
export type ScrollableAncestor = { element: Element; proven: boolean }

/**
 * 几何回读：声明命中之后再量这条轴上的真实可滚距离。
 *
 * 纵向 `scrollHeight - clientHeight`，横向 `scrollWidth - clientWidth` —— 与
 * `src/components/session/scrollToFirstMessage.ts:30` 的判据同形（issue #218）。
 * 回读**只用来证明能滚，不用来证明不能滚**：读数为 0 时可能只是内容还没填满、
 * 或者盒子还没被撑成有界高度，那不算「不可滚」的证据。
 */
const hasScrollDistance = (element: Element, vertical: boolean, horizontal: boolean) =>
  (vertical && element.scrollHeight - element.clientHeight > 0) ||
  (horizontal && element.scrollWidth - element.clientWidth > 0)

/**
 * 从 target 往上找第一处声明了可滚的容器（含 target 自身，不含 body），并带上几何回读。
 *
 * 为什么不再只认声明（issue #218，与 #173 同形）：`overflow-y: auto` 是**声明值**，
 * 高度链断开时盒子没有有界高度、内容把盒子撑满，`scrollHeight === clientHeight`，
 * 声明照样命中 —— 判定说「这里能滚」，实际手指在动、内容一像素不动、零报错。
 *
 * 为什么读到 0 也不反过来当「不可滚」（issue #30）：真能滚的容器在高度链退化时读数同样是 0，
 * 一旦把 0 当作否证，祖先链上就再也不会有可滚容器，每一次 touchmove 都会被 preventDefault ——
 * 触摸全到、内容一像素不动、零报错。两种错法的代价不对等：
 *
 *   - 回读为 0 时信「声明」（本函数的做法）：极端布局下这块区域不滚，页面照常滚 ——
 *     局部失效、可恢复、用户还有别的路走；
 *   - 回读为 0 时判「不可滚」再去拦：整页锁死、零报错、用户无路可走，就是 #30 ——
 *     全局失效、不可恢复。
 *
 * 所以 `proven === false` 只表示「这一刻没证明它能滚」，调用方仍按 fail-open 放行。
 */
export const findScrollableAncestor = (target: Element): ScrollableAncestor | null => {
  for (
    let element: Element | null = target;
    element && element !== document.body;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element)
    const vertical = SCROLLABLE_OVERFLOW.test(style.overflowY)
    const horizontal = SCROLLABLE_OVERFLOW.test(style.overflowX)
    if (!vertical && !horizontal) {
      continue
    }
    return { element, proven: hasScrollDistance(element, vertical, horizontal) }
  }
  return null
}

/**
 * 这条 touchmove 要不要拦。
 *
 * 条件锁 + 默认 fail-open：只有同时满足
 *   1. 单指（多指是双指缩放，交给浏览器）；
 *   2. target 落在锁范围内（默认整页；锁范围外的浮层目标一律放行）；
 *   3. 祖先链上没有任何声明了 auto|scroll 的容器（findScrollableAncestor 判空）；
 * 才 preventDefault。其余一律放行 —— 静默锁死比漏拦一次糟得多。
 *
 * 第 3 条只看「有没有这样的容器」，**不看回读是否证明它此刻真能滚**（`proven`）：
 * 回读为 0 只说明没证明它能滚，反过来拦的代价是 #30 那种整页锁死（详见 findScrollableAncestor）。
 * 真正的修复要在布局层把高度链接起来 —— 判定层只负责不撒谎。
 */
export const shouldPreventTouchMove = (
  event: TouchEvent,
  lockRoot: Element | null = document.body
) => {
  if (event.touches.length !== 1) {
    return false
  }
  const target = event.target instanceof Element ? event.target : null
  if (!target || !lockRoot || !lockRoot.contains(target)) {
    return false
  }
  if (findScrollableAncestor(target)) {
    // 找到容器就放行：proven 为 false 也不拦（未证明 ≠ 不可滚，见 findScrollableAncestor 注释）。
    return false
  }
  return true
}

const onTouchMove = (event: TouchEvent) => {
  if (shouldPreventTouchMove(event)) {
    event.preventDefault()
  }
}

/** 阻止移动端整页滚动，保留内部可滚动区域的滚动和双指缩放。 */
export const usePreventPageScroll = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => document.removeEventListener('touchmove', onTouchMove)
  }, [enabled])
}

/**
 * 把真实可视高度写进浮层。
 *
 * `--modal-viewport-height` 是 .feedbackDialog 高度链的唯一来源（见 Settings.module.css），
 * 缺了它内容区就不溢出 → 不可滚。所以这个变量**无条件下发**，包括双指缩放
 * （visualViewport.scale !== 1）的时候：按真实可视高度写，总比不写安全。
 * top / height 的像素值仍然只在未缩放时跟 —— 缩放中跟着改会让浮层随视觉视口乱跳。
 */
export const syncModalViewport = (overlay: HTMLElement | null, viewport: VisualViewport | null) => {
  if (!overlay) {
    return
  }
  const height = viewport?.height ?? window.innerHeight
  overlay.style.setProperty('--modal-viewport-height', `${height}px`)
  if (viewport && viewport.scale !== 1) {
    return
  }
  overlay.style.top = `${viewport?.offsetTop ?? 0}px`
  overlay.style.height = `${height}px`
}

/** 移动端页面跟随视觉视口，键盘弹出后顶栏和输入框仍留在可见区域。 */
export const useMobileViewport = (enabled: boolean) => {
  const frameRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!enabled || !frame) {
      return
    }
    const viewport = window.visualViewport
    const inputSelector = 'textarea, input:not([type="file"])'
    let animationFrame = 0
    const reset = () => {
      frame.style.removeProperty('--app-viewport-height')
      frame.style.removeProperty('--app-viewport-top')
    }
    const update = () => {
      // 双指缩放由浏览器处理，保持当前布局尺寸。
      if (viewport && viewport.scale !== 1) {
        return
      }
      // 失焦后直接恢复 CSS 的全高布局，不等 Safari 收键盘后的 resize。
      if (!document.activeElement?.matches(inputSelector)) {
        reset()
        return
      }
      frame.style.setProperty(
        '--app-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`
      )
      frame.style.setProperty('--app-viewport-top', `${viewport?.offsetTop ?? 0}px`)
    }
    const scheduleFrame = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(update)
    }
    const schedule = () => {
      // 先同步跟上键盘动画，下一帧再校准 Safari 延迟更新的视口读数。
      update()
      scheduleFrame()
    }
    const onFocusIn = () => {
      if (document.activeElement?.matches(inputSelector)) {
        schedule()
      }
    }

    update()
    viewport?.addEventListener('resize', schedule)
    viewport?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    document.addEventListener('focusin', onFocusIn)
    // 等点击和焦点切换完成，避免按钮移动、或切换输入框时短暂恢复全高。
    document.addEventListener('focusout', scheduleFrame)
    return () => {
      cancelAnimationFrame(animationFrame)
      viewport?.removeEventListener('resize', schedule)
      viewport?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', scheduleFrame)
      reset()
    }
  }, [enabled])

  return frameRef
}

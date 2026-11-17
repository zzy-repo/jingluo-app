import { useEffect, useRef, useState } from 'react'

/**
 * 与 `src/app/motion.css` 的 `--motion-duration-*` 对齐的退出时长（ms）。
 * 比 CSS 里的动画时长多留一帧余量，保证 DOM 一定撑到最后一帧再卸载。
 */
export const MOTION_EXIT = {
  /** 侧边栏抽屉：transform 280ms + 遮罩 180ms */
  drawer: 320,
  /** 设置弹窗：桌面 220ms / 移动端 280ms + 遮罩 180ms */
  modal: 320,
} as const

/** 系统是否要求减少动态效果：为 true 时直接切状态，不排帧也不等退出动画 */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 保留退出动画所需的挂载状态。
 *
 * `mounted` 为 false 时调用方返回 null；`visible` 为 false 时由 CSS 播放退出动画。
 * 关闭后 DOM 不会立刻卸载，而是等 `exitMs` 之后再卸载，避免「啪」一下消失。
 * 动画期间不影响交互：可见性只由 class 决定，点击逻辑与打开时完全一致。
 */
export const usePresence = (open: boolean, exitMs: number) => {
  const [mounted, setMounted] = useState(open)
  // 初始一律 invisible：挂载后下一帧再切到可见，保证进入动画有起点（自动打开的弹窗也有过渡）
  const [visible, setVisible] = useState(false)
  const mountedRef = useRef(open)

  useEffect(() => {
    if (open) {
      if (!mountedRef.current) {
        mountedRef.current = true
        setMounted(true)
      }
      if (prefersReducedMotion()) {
        // 减少动态效果：不排帧，直接到位
        setVisible(true)
        return
      }
      // 双 rAF：第一帧让浏览器先算好「关闭」样式，第二帧再切到「打开」，过渡才会真正跑起来
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true))
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }

    if (prefersReducedMotion()) {
      // 减少动态效果：没有退出动画，立刻卸载
      setVisible(false)
      mountedRef.current = false
      setMounted(false)
      return
    }

    setVisible(false)
    if (!mountedRef.current) {
      return
    }
    const timer = setTimeout(() => {
      mountedRef.current = false
      setMounted(false)
    }, exitMs)
    return () => clearTimeout(timer)
  }, [open, exitMs])

  return { mounted, visible }
}

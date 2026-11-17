import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 与 `src/app/motion.css` 的 `--motion-duration-drawer`（240ms）对齐的退出时长（ms）。
 * 面板与遮罩同一条曲线、同一个时长，多留约 2 帧余量；真实结束由 `finishExit`
 * （transitionend / animationend）提前触发，这里的定时器只做兜底。
 */
export const MOTION_EXIT = {
  /** 侧边栏抽屉：transform 240ms + 遮罩 240ms */
  drawer: 280,
  /** 设置弹窗：桌面卡片 240ms / 移动端底部弹层 240ms + 遮罩 240ms */
  modal: 280,
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
 * 关闭后 DOM 不会立刻卸载，而是等退出动画结束（`finishExit`）或 `exitMs` 超时再卸载，
 * 避免「啪」一下消失，也不会因为掉帧把动画切在半路。
 *
 * 打开时**不再排双 rAF**：进场由 CSS `@keyframes` + `animation-fill-mode: both` 负责首帧，
 * 双 rAF 只保证两次回调，并不保证中间真的发生过一次样式重算 —— 主线程忙时会退化成
 * 「挂载即终态」，transition 从未创建，于是「一击到位」（闪现）。
 */
export const usePresence = (open: boolean, exitMs: number) => {
  const [mounted, setMounted] = useState(open)
  // 与 mounted 同步初值：挂载即目标态，首帧交给 CSS animation 兜住
  const [visible, setVisible] = useState(open)
  const mountedRef = useRef(open)
  const exitTimer = useRef<ReturnType<typeof setTimeout>>()

  /** 退出动画真正结束（transitionend / animationend）：立刻卸载，不等定时器 */
  const finishExit = useCallback(() => {
    if (!mountedRef.current) {
      return
    }
    clearTimeout(exitTimer.current)
    mountedRef.current = false
    setMounted(false)
  }, [])

  useEffect(() => {
    if (open) {
      mountedRef.current = true
      setMounted(true)
      setVisible(true)
      return
    }

    if (prefersReducedMotion()) {
      // 减少动态效果：没有退出动画，立刻卸载
      clearTimeout(exitTimer.current)
      setVisible(false)
      mountedRef.current = false
      setMounted(false)
      return
    }

    setVisible(false)
    if (!mountedRef.current) {
      return
    }
    // 事件兜底：调用方把 finishExit 接在 transitionend / animationend 上会先卸载
    exitTimer.current = setTimeout(finishExit, exitMs)
    return () => clearTimeout(exitTimer.current)
  }, [open, exitMs, finishExit])

  return { mounted, visible, finishExit }
}

import { create } from 'zustand'
import type { LinkedMessage, TranslationKey } from '../../i18n/index.js'

/**
 * 提示条上的**应用内动作**（#793）：与 `LinkedMessage.link`（外链、新窗口）分开一格 ——
 * 那种「跳设置某个面板」的动作不能做成 `<a href>`，必须是点了就执行的按钮。
 */
export type ToastAction = { key: TranslationKey; run: () => void }

/** 轻提示：同一时间只显示一条，新的替换旧的，到时自动消失；文案在渲染时按当前语言翻译 */
type ToastState = { id: number; message: LinkedMessage | string | null; action: ToastAction | null }

export const useToast = create<ToastState>(() => ({ id: 0, message: null, action: null }))

const DURATION = 3000
/** 带链接时多留一些时间，方便点击 */
const LINK_DURATION = 5000
/**
 * 带动作按钮时再放宽一些（#793）：3 秒里读完一句话、再找到并点中按钮太赶，
 * 而这个按钮正是「被拦下之后唯一的出路」，点不到就等于没有入口。
 */
const ACTION_DURATION = 8000
let timer = 0

/**
 * 弹一条轻提示。
 *
 * `options.action` 是**应用内动作**（#793）：给了就在提示条末尾画一个按钮，点了执行 `run()`。
 * 每次调用都会把 `action` 一起写进 store（不给就是 null）—— 否则上一条带动作的提示消失后，
 * 按钮会挂在下一条纯文字提示上。
 */
export const showToast = (
  message: LinkedMessage | string,
  options: { action?: ToastAction } = {}
) => {
  window.clearTimeout(timer)
  useToast.setState((state) => ({ id: state.id + 1, message, action: options.action ?? null }))
  const duration =
    options.action !== undefined
      ? ACTION_DURATION
      : typeof message !== 'string' && message.link
        ? LINK_DURATION
        : DURATION
  timer = window.setTimeout(() => useToast.setState({ message: null, action: null }), duration)
}

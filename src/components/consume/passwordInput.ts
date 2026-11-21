/**
 * 可复用的「密码输入 + 眼睛按钮」组件（Issue #797）。
 *
 * 为什么要单独一个文件：注册 tab 有 **两个** 密码框（密码 / 确认密码），登录 tab 有一个 ——
 * 三处都要「默认隐藏、点眼睛切明文、图标与可见性对应、带 `aria-label` / `aria-pressed`」。
 * 抄三遍必然会漂移（其中一处忘了 `aria-pressed` 或忘了遵守「切换不重挂载」），所以只留一份。
 *
 * 三条实现口径（每一条都对应 #797 的一条要求）：
 *
 *  1. **可见性由外层持有**（受控）：`visible` 只是父级状态里的一个布尔值，这里不自己存。
 *     所以「提交后 / 切 tab / 离开卡片恢复隐藏」= 父级把那个布尔值置 false（不持久化、不写
 *     localStorage），本组件不需要任何卸载钩子。
 *  2. **切换只改 `type`，不重挂载**：输入框始终是**同一个** DOM 节点、始终受控（`value` 由外层给），
 *     切换时只把 `type` 在 `password` / `text` 之间换一次 —— 否则浏览器会认为「换了个输入框」，
 *     内容与光标都会丢。
 *  3. **光标单独兜底**：即便同一个节点，部分内核在改 `type` 时会把 selection 归零，所以切换前记一次
 *     `selectionStart/End`，切换后（仍持有焦点时）`setSelectionRange` 放回去。`setSelectionRange`
 *     在个别 WebView 上会抛（类型不支持），一律吞掉 —— 光标是体验优化，不该让输入框炸掉。
 *
 * 为什么是 `createElement` 而不是 JSX：本仓库的 L1 单测用裸 Node + `renderToStaticMarkup` 真渲染视图
 * （见 `tests/helpers/auth-panels-env.mjs`），`.tsx` 不在 Node 的类型擦除范围内、import 不进来。同理，
 * 两枚眼睛图标（`base/icons.tsx` 是 `.tsx`）由**容器注入**：真机传设计系统图标，单测传等价替身 ——
 * 与 `Button` 的注入方式一样，不为了「少两个 prop」把视图挡在测试之外。
 */

import { createElement, Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'

import type { TranslationKey } from '../../i18n/index.js'

/** 输入框的 `type`：可见 = `text`（明文），隐藏 = `password`（圆点）。 */
export const passwordInputType = (visible: boolean): 'text' | 'password' => (visible ? 'text' : 'password')

/** 点一次眼睛：可见性取反（**只动这一个布尔值**，不碰内容）。 */
export const nextPasswordVisibility = (visible: boolean): boolean => !visible

/**
 * 眼睛按钮的可访问名 —— 说的是「点了会发生什么」：
 * 现在可见 → 「隐藏密码」；现在隐藏 → 「显示密码」。
 *
 * 图标则对应**当前状态**（睁眼 = 正在显示 / 闭眼 = 已隐藏），两者故意不同向：
 * 图标回答「现在是什么状态」，`aria-label` 回答「按下去会怎样」。
 */
export const passwordToggleLabelKey = (
  visible: boolean
): Extract<TranslationKey, 'settingsAuthShowPassword' | 'settingsAuthHidePassword'> =>
  visible ? 'settingsAuthHidePassword' : 'settingsAuthShowPassword'

/** 样式注入（真机是 CSS Module 的类名表，单测是 `Proxy` 替身 —— 同 `PanelClassNames`） */
export type PasswordFieldClassNames = {
  row: string | undefined
  input: string | undefined
  toggle: string | undefined
  error: string | undefined
}

export type PasswordFieldProps = {
  /** 受控值：内容始终由外层持有，切换可见性时**一个字符都不动** */
  value: string
  visible: boolean
  placeholder: string
  /** 输入框自身的可访问名（「密码」/「确认密码」） */
  ariaLabel: string
  /** 眼睛按钮的可访问名（用 `t(passwordToggleLabelKey(visible))` 取） */
  toggleLabel: string
  autoComplete: 'current-password' | 'new-password'
  /** 输入框与眼睛按钮的测试 id：`<testId>` / `<testId>-toggle` */
  testId: string
  c: PasswordFieldClassNames
  /** 睁眼图标（正在显示）。由容器注入，见文件头第 3 段 */
  EyeIcon: () => ReactNode
  /** 闭眼图标（已隐藏）。由容器注入 */
  EyeOffIcon: () => ReactNode
  /** 校验失败的红字（已翻译）；不给就不渲染错误行 */
  errorText?: string | undefined
  /** 错误行的测试 id */
  errorTestId?: string | undefined
  onChange: (value: string) => void
  onToggle: () => void
  onBlur?: (() => void) | undefined
  onKeyDown?: ((event: KeyboardEvent<HTMLInputElement>) => void) | undefined
}

/** 当前是否持有焦点（非浏览器环境 / SSR 一律 false，直接跳过光标恢复） */
const isFocused = (element: HTMLInputElement): boolean =>
  typeof document !== 'undefined' && document.activeElement === element

export const PasswordField = (props: PasswordFieldProps): ReactNode => {
  const { value, visible, c } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  /** 切换前的光标位置；`start === null` = 还没有可恢复的位置 */
  const caret = useRef<{ start: number | null; end: number | null }>({ start: null, end: null })
  const pendingRestore = useRef(false)

  const rememberCaret = (element: HTMLInputElement): void => {
    caret.current = { start: element.selectionStart, end: element.selectionEnd }
  }

  // 只在「刚点过眼睛」的那一次渲染里恢复光标；首次挂载不碰（那时没有位置可言）
  useEffect(() => {
    if (!pendingRestore.current) {
      return
    }
    pendingRestore.current = false
    const element = inputRef.current
    if (element === null || !isFocused(element)) {
      return
    }
    const { start, end } = caret.current
    if (start === null || end === null) {
      return
    }
    try {
      element.setSelectionRange(start, end)
    } catch {
      // 个别 WebView 对 `setSelectionRange` 挑类型：光标丢了不影响内容，静默跳过
    }
  }, [visible])

  const toggle = (): void => {
    const element = inputRef.current
    if (element !== null) {
      rememberCaret(element)
    }
    pendingRestore.current = true
    props.onToggle()
  }

  const input = createElement('input', {
    ref: inputRef,
    className: c.input,
    // ①只有 `type` 变：同一个节点、同一个受控 value → 内容与光标都不丢
    type: passwordInputType(visible),
    autoComplete: props.autoComplete,
    spellCheck: false,
    placeholder: props.placeholder,
    'aria-label': props.ariaLabel,
    'aria-invalid': props.errorText === undefined ? undefined : true,
    'data-testid': props.testId,
    value,
    onChange: (event: { currentTarget: HTMLInputElement }) => {
      rememberCaret(event.currentTarget)
      props.onChange(event.currentTarget.value)
    },
    onBlur: props.onBlur,
    onKeyDown: props.onKeyDown,
  })

  const toggleButton = createElement(
    'button',
    {
      type: 'button',
      className: c.toggle,
      'data-testid': `${props.testId}-toggle`,
      // 图标看状态、文案看动作（见 `passwordToggleLabelKey` 的注释）
      'aria-label': props.toggleLabel,
      'aria-pressed': visible,
      onClick: toggle,
    },
    createElement(visible ? props.EyeIcon : props.EyeOffIcon)
  )

  const error =
    props.errorText === undefined
      ? null
      : createElement(
          'p',
          { className: c.error, role: 'alert', 'data-testid': props.errorTestId },
          props.errorText
        )

  return createElement(
    Fragment,
    null,
    createElement('div', { className: c.row }, input, toggleButton),
    error
  )
}

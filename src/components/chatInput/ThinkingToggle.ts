import { createElement, type ReactNode } from 'react'
import type { ProviderCaps } from '../../services/api/providers.js'

/**
 * 输入行「深度思考」开关（issue #297 抽出来的一层，#341 起入口恒常驻）。
 *
 * **入口始终渲染**：四个渠道外观逐像素一致，不置灰、不带 `disabled` / `aria-disabled`。
 * `caps.thinking` 不再决定「渲不渲染」，只表示这一档是否**真生效**：
 * - 有效（anthropic 协议，或 oai 的 `reasoning_effort` / `thinking_enabled` 档）：
 *   点击改本地档位，请求真的带思考字段；
 * - 无效（openai / ours 默认 `reasoningParam: 'none'`）：点击同样改本地档位、高亮照常翻转，
 *   请求侧由 `REQUEST_GATES.reasoning_param` 拦下，一个思考字段都不发。
 *
 * 渠道差异只落在不可见的 `data-thinking-effective` 上（供验收与单测断言），不参与视觉分支。
 *
 * 为什么是 `.ts` + `createElement` 而不是 `.tsx`：纯 Node 的 `node --test` 认不出 JSX
 * （沿用 `PurchaseRecordsView.ts` / `PaymentTrailView.ts` 的做法）。这样
 * `tests/unit/thinking-adapters.test.mjs` 能用 `react-dom/server` 对**真的开关组件**
 * 断言「节点在不在、`aria-pressed` 是 true 还是 false」，而不是靠读源码正则。
 *
 * 样式类名、文案与 tooltip 容器都由调用方注入：这里不 import CSS Module，
 * 单测才能在不打包的环境里渲染它。
 */
export type ThinkingToggleProps = {
  /** 当前渠道的能力表（只用到 thinking；不参与显隐，只标记是否真生效） */
  caps: ProviderCaps
  /** 当前是否开启：settings.thinking 的镜像，恒等于 chatMode === 'expert' */
  thinking: boolean
  /** 点击要做的动作：真机就是 `setThinking(!thinking)`（写 settings + localStorage） */
  onToggle: () => void
  /** 按钮文案（aria-label 与可见文字同一个，保持无障碍名一致） */
  label: string
  /** 悬停提示文案 */
  tooltip: string
  /** 图标节点（设计系统图标，由调用方传） */
  icon: ReactNode
  className?: string
  /** 开启态附加的类名（视觉高亮） */
  selectedClassName?: string
  labelClassName?: string
  /**
   * tooltip 容器：真机传设计系统的 `Tooltip`，单测传透传包装。
   * 不传则直接渲染按钮，不外包一层。
   */
  wrap?: (content: ReactNode, children: ReactNode) => ReactNode
}

/** 按钮上的定位标记：DOM 层断言（有 / 无）与真机排障都靠它 */
export const THINKING_TOGGLE_ATTR = 'data-thinking-toggle'

export const ThinkingToggle = ({
  caps,
  thinking,
  onToggle,
  label,
  tooltip,
  icon,
  className,
  selectedClassName,
  labelClassName,
  wrap,
}: ThinkingToggleProps): ReactNode => {
  // 入口恒常驻（#341）：能力位只用来标记「这一档是否真生效」，不做早退、不改样式。
  const effective = caps.thinking
  const button = createElement(
    'button',
    {
      type: 'button',
      [THINKING_TOGGLE_ATTR]: '',
      // 不可见标记：四渠道唯一差异，供验收/单测断言；视觉与交互完全一致
      'data-thinking-effective': effective ? 'true' : 'false',
      className: [className, thinking ? selectedClassName : undefined]
        .filter(Boolean)
        .join(' '),
      'aria-label': label,
      // 开关语义：真机点击后由调用方写 settings，下一次渲染这里就跟着翻
      'aria-pressed': thinking,
      onClick: onToggle,
    },
    icon,
    createElement('span', { className: labelClassName }, label)
  )
  return wrap ? wrap(tooltip, button) : button
}

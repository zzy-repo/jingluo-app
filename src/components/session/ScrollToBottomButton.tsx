import { IconChevronDownOutline14 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { useTranslate } from '../../i18n/index.js'
import { useScrollToBottomState } from '../messages/scrollContext.js'
import styles from './ScrollToBottomButton.module.css'

/**
 * 输入框上方的「回到底部」小圆形箭头按钮（Issue #386）。
 *
 * 为什么挂在输入区而不是消息区：按钮要贴着输入框上沿、跟着输入框的宽度走，
 * 挂在输入区里天然满足（相对输入区 `bottom: 100%`）；状态由 `MessageList` 经
 * `ScrollToBottomStateContext` 送下来，这里只管画和转发点击，不碰滚动 DOM。
 *
 * 只在 `visible`（离底部超过 200px）时挂载 —— 隐藏时不留一个能 Tab 到的透明按钮。
 * 挂载即淡入（`@keyframes` + `backwards`，只动 opacity / transform），系统开了
 * 「减少动态效果」时动画令牌归零，等于直接出现。
 */
export const ScrollToBottomButton = () => {
  const t = useTranslate()
  const { visible, hasNew, jump } = useScrollToBottomState()
  if (!visible) {
    return null
  }
  // 流式期间用户翻上去看旧内容：按钮带一个小圆点，读屏名称也说清「有新内容」
  const label = hasNew ? t('scrollToBottomHasNew') : t('scrollToBottom')
  return (
    <IconButton
      className={styles.toBottom}
      size="m"
      icon={
        <>
          <IconChevronDownOutline14 />
          {hasNew ? <span className={styles.dot} aria-hidden="true" /> : null}
        </>
      }
      aria-label={label}
      onClick={jump}
      data-scroll-to-bottom
    />
  )
}

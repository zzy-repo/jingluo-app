import { type KeyboardEvent, type ReactNode, useCallback, useRef } from 'react'
import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { scrollToFirstMessage } from './scrollToFirstMessage.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话。
 *
 * Issue #106：长会话滚到很下面之后，一路往上滑很久才能回到开头。标题区支持**双击回到首条
 * 消息**（键盘 Enter / 空格等价）。单击不绑定任何行为，所以双击不会连带触发单击逻辑；
 * 没有标题（欢迎页）时不渲染标题区，手势自然不生效。
 */
export const MobileHeader = ({
  title,
  badge,
}: {
  title?: string
  /** #831：会话来源徽标（分支会话才有）。放在标题右边，太挤时由 CSS 隐藏文字只留图标 */
  badge?: ReactNode
}) => {
  const t = useTranslate()
  const headerRef = useRef<HTMLDivElement>(null)
  const onTitleDoubleClick = useCallback(() => {
    // 从标题栏往上找会话页，再在子树里定位消息滚动层（见 scrollToFirstMessage）
    scrollToFirstMessage(headerRef.current)
  }, [])
  const onTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      // 双击手势的键盘等价物：标题区只能单击聚焦，Enter / 空格直接回到首条
      if (event.key !== 'Enter' && event.key !== ' ') {
        return
      }
      event.preventDefault()
      onTitleDoubleClick()
    },
    [onTitleDoubleClick],
  )
  return (
    <div className={styles.header} ref={headerRef}>
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined ? null : (
        <>
          <button
            type="button"
            className={styles.titleButton}
            aria-label={t('scrollToFirstMessage')}
            title={t('scrollToFirstMessage')}
            onDoubleClick={onTitleDoubleClick}
            onKeyDown={onTitleKeyDown}
          >
            <span className={styles.title}>{title}</span>
            <span className={styles.titleHint} aria-hidden="true">
              {t('scrollToFirstMessageHint')}
            </span>
          </button>
          {badge === undefined ? null : <span className={styles.badgeSlot}>{badge}</span>}
          <IconButton
            size="xl"
            tone="primary"
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
    </div>
  )
}

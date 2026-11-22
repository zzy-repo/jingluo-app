import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { parentTitleOf } from '../../services/chat/sessionBranch.js'
import { selectSession, useChatStore } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { SessionBranchAttachments } from './BranchAttachmentNotice.js'
import { SessionBranchBadge } from './SessionBranchBadge.js'
import { MobileHeader } from './MobileHeader.js'
import { ScrollToBottomButton } from './ScrollToBottomButton.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const title = session.title || t('untitledChat')
  /**
   * #831 详情页的「来源徽标 + 跳回父会话」：父会话标题从当前列表里取（不在本机 → 降级态）。
   * 徽标做成可点的按钮，点它 `selectSession(父 id)` —— 这就是票面第 5 条「详情可跳回父会话」。
   */
  const sessions = useChatStore((state) => state.sessions)
  const parentTitle = parentTitleOf(session.branchOf, sessions)
  const badge = (
    <SessionBranchBadge
      origin={session.branchOf}
      parentTitle={parentTitle}
      onOpenParent={selectSession}
    />
  )
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} badge={badge} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          {badge}
        </div>
      )}
      {/* #831 附件降级：分支会话里有附件在本机拿不到时，一条明确的说明（不报错、不挡对话） */}
      {session.branchOf === undefined ? null : (
        <div className={styles.branchNoticeWrap}>
          <SessionBranchAttachments session={session} />
        </div>
      )}
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            {/* #386：回到底部按钮贴在输入框上沿之上（离底部超过 200px 才挂载） */}
            <ScrollToBottomButton />
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
    </div>
  )
}

/**
 * #527 附件卡片列表：输入区与消息内共用，只负责排列与转发动作。
 */
import clsx from 'clsx'
import { AttachmentCard, type AttachmentCardHandlers } from './AttachmentCard.js'
import type { AttachmentView } from './viewModel.js'
import styles from './AttachmentList.module.css'

export const AttachmentList = ({
  attachments,
  variant = 'draft',
  className,
  onCancel,
  onRetry,
  onRemove,
}: {
  attachments: AttachmentView[]
  variant?: 'draft' | 'message'
  className?: string
} & AttachmentCardHandlers) => {
  if (attachments.length === 0) {
    return null
  }
  return (
    <div className={clsx(styles.list, styles[variant], className)}>
      {attachments.map((view) => (
        <AttachmentCard
          key={view.id}
          view={view}
          variant={variant}
          onCancel={onCancel}
          onRetry={onRetry}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}

/**
 * #527 附件卡片：输入区（`draft`）与消息内（`message`）复用同一个组件。
 *
 * **外观复用 `files/FileCard`**（图标 / 文件名 / 「扩展名 大小」/ 动作位 / 圆角 / 尺寸 / 焦点环
 * 全是既有那一份），本文件只负责「附件才有的语义」：
 *  - 五态（`pending`/`parsing`/`success`/`partial`/`failed`）+ UI 独有的 `cancelled` → 映射到
 *    `FileCardStatus`，颜色与虚线在 `FileCard.module.css` 的状态类里，不另建一套卡片皮肤；
 *  - `parsing` 的进度条、`partial` 的黄色警告角标、点卡片弹出的详情面板；
 *  - 取消 / 移除两个动作交给既有 `IconButton`。
 *
 * 卡片**只显示元信息**，不显示文档正文（§3.5）。
 */
import clsx from 'clsx'
import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseFill14, IconStopFill16, IconWarningOutline16 } from '../base/icons.js'
import { FileCard, type FileCardStatus } from '../files/FileCard.js'
import { AttachmentPanel } from './AttachmentPanel.js'
import {
  attachmentWarnings,
  parsePercent,
  statusLine,
  type AttachmentView,
  type AttachmentViewStatus,
} from './viewModel.js'
import styles from './Attachments.module.css'

/** 视图五态 + `cancelled` → 卡片状态（`failed` 与上传失败共用红色那一套视觉） */
const CARD_STATUS: Record<AttachmentViewStatus, FileCardStatus> = {
  pending: 'pending',
  parsing: 'parsing',
  success: 'done',
  partial: 'partial',
  failed: 'error',
  cancelled: 'cancelled',
}

export type AttachmentCardHandlers = {
  onCancel?: (id: string) => void
  onRetry?: (id: string) => void
  onRemove?: (id: string) => void
}

export const AttachmentCard = memo(function AttachmentCard({
  view,
  variant = 'draft',
  onCancel,
  onRetry,
  onRemove,
}: {
  view: AttachmentView
  variant?: 'draft' | 'message'
} & AttachmentCardHandlers) {
  const t = useTranslate()
  const warnings = attachmentWarnings(view, t)
  const parsing = view.status === 'parsing'
  const percent = parsing ? parsePercent(view.progress) : null
  const cancellable = parsing && onCancel !== undefined

  return (
    <AttachmentPanel view={view} onRemove={onRemove} onRetry={onRetry}>
      {({ open, toggle }) => (
        <FileCard
          name={view.filename}
          size={view.size}
          status={CARD_STATUS[view.status]}
          statusText={statusLine(view, t)}
          progress={parsing ? percent : undefined}
          className={clsx(
            variant === 'message' && styles.messageCard,
            open && styles.opened
          )}
          corner={
            view.status === 'partial' ? (
              <span
                className={styles.warnCorner}
                title={t('attachDetailWarnings', { count: warnings.length })}
              >
                <IconWarningOutline16 />
                <span>{warnings.length}</span>
              </span>
            ) : undefined
          }
          activator={{ label: t('attachOpenDetail'), expanded: open, onActivate: toggle }}
          actions={
            cancellable || onRemove !== undefined ? (
              // 动作位在卡片内部（卡片整块可点开详情），所以必须掐掉冒泡，别一点「取消」顺带开面板
              <>
                {cancellable ? (
                  <IconButton
                    size="xs"
                    icon={<IconStopFill16 />}
                    tooltip={t('attachCancel')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onCancel(view.id)
                    }}
                  />
                ) : null}
                {onRemove === undefined ? null : (
                  <IconButton
                    size="xs"
                    icon={<IconCloseFill14 />}
                    tooltip={t('attachRemove')}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemove(view.id)
                    }}
                  />
                )}
              </>
            ) : undefined
          }
        />
      )}
    </AttachmentPanel>
  )
})

/**
 * 附件卡片列表：输入区与消息内共用，只负责排列与转发动作。
 */
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

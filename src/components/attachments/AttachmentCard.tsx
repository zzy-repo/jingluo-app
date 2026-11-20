/**
 * #527 附件卡片：输入区（`draft`）与消息内（`message`）复用同一个组件。
 *
 * 五种状态各自有不同的视觉，**不靠文案去区分**：
 *  - `pending`   虚线边框 + 中性「等待解析」；
 *  - `parsing`   品牌色进度条 + 百分比 + 取消按钮（不确定进度时走滑动条）；
 *  - `success`   常规边框 + 绿色「已就绪」；
 *  - `partial`   琥珀色边框 + 右上角黄色警告角标（带条数）；
 *  - `failed`    红色边框 + 红色「解析失败」，点卡片看原因；
 *  - `cancelled` 虚线边框 + 中性「解析已取消」（UI 独有，见 viewModel 注释）。
 *
 * 卡片**只显示元信息**，不显示文档正文（§3.5）。点击 → `AttachmentPanel`。
 */
import clsx from 'clsx'
import { memo } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize } from '../../services/attachments.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseFill14, IconStopFill16, IconWarningOutline16 } from '../base/icons.js'
import { AttachmentPanel } from './AttachmentPanel.js'
import { AttachmentTypeIcon } from './AttachmentTypeIcon.js'
import {
  attachmentWarnings,
  metaLine,
  parsePercent,
  statusLine,
  type AttachmentView,
} from './viewModel.js'
import styles from './AttachmentCard.module.css'

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
        <div
          className={clsx(styles.card, styles[variant], styles[view.status], open && styles.opened)}
        >
          {view.status === 'partial' ? (
            <span
              className={styles.warnCorner}
              title={t('attachDetailWarnings', { count: warnings.length })}
            >
              <IconWarningOutline16 />
              <span className={styles.warnCount}>{warnings.length}</span>
            </span>
          ) : null}
          <button
            type="button"
            className={styles.open}
            aria-label={t('attachOpenDetail')}
            aria-expanded={open}
            onClick={toggle}
          >
            <span className={styles.icon}>
              <AttachmentTypeIcon extension={view.extension} />
            </span>
            <span className={styles.body}>
              <span className={styles.filename}>{view.filename}</span>
              <span className={styles.meta}>{metaLine(view, formatSize)}</span>
              <span className={styles.status}>{statusLine(view, t)}</span>
              {parsing ? (
                <span className={styles.progress}>
                  <span
                    className={clsx(
                      styles.progressBar,
                      percent === null && styles.progressIndeterminate
                    )}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                  />
                </span>
              ) : null}
            </span>
          </button>
          {cancellable || onRemove !== undefined ? (
            <span className={styles.actions}>
              {cancellable ? (
                <IconButton
                  size="xs"
                  icon={<IconStopFill16 />}
                  tooltip={t('attachCancel')}
                  onClick={() => onCancel(view.id)}
                />
              ) : null}
              {onRemove === undefined ? null : (
                <IconButton
                  size="xs"
                  icon={<IconCloseFill14 />}
                  tooltip={t('attachRemove')}
                  onClick={() => onRemove(view.id)}
                />
              )}
            </span>
          ) : null}
        </div>
      )}
    </AttachmentPanel>
  )
})

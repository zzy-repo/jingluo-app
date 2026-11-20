import clsx from 'clsx'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { formatSize, getExtension } from '../../services/attachments.js'
import { IconCloseFill14, IconRefreshOutline16 } from '../base/icons.js'
import { FileIcon } from './FileIcon.js'
import styles from './FileCard.module.css'

/**
 * 卡片状态：
 *  - `uploading` / `done` / `error` —— Files API 那套上传（输入区草稿 + 消息内历史附件）；
 *  - `pending` / `parsing` / `partial` / `cancelled` —— #480 文档解析（输入区草稿 + 消息内附件）。
 *
 * 两套共用同一张卡片：布局、图标、大小、进度、动作位都在这里，谁也不再另写一份。
 */
export type FileCardStatus =
  | 'uploading'
  | 'done'
  | 'error'
  | 'pending'
  | 'parsing'
  | 'partial'
  | 'cancelled'

/** 只有解析态需要额外视觉；上传态保持原样（`undefined` 即不加类） */
const STATE_CLASS: Record<FileCardStatus, string | undefined> = {
  uploading: undefined,
  done: styles.done,
  error: undefined,
  pending: styles.pending,
  parsing: styles.parsing,
  partial: styles.partial,
  cancelled: styles.cancelled,
}

/** 让整张卡片可点、可用键盘激活时的无障碍属性（不带它时卡片是普通 div） */
export type FileCardActivator = {
  /** 无障碍名称 */
  label: string
  /** 展开态（aria-expanded），如详情面板是否打开 */
  expanded: boolean
  onActivate: () => void
}

/**
 * 文档文件卡片：图标 + 文件名 + 「扩展名 大小」+（可选）状态行与进度条。
 *
 * 输入框内失败时描边和说明标红；可重试时显示刷新图标，不可重试时常显红色删除按钮。
 * 消息里的不可重试文件保留普通边框和状态说明。
 *
 * #480 只加了四个可选槽位（`statusText` / `progress` / `corner` / `actions`）与 `activator`，
 * 布局与既有上传卡片完全同一份，没有第二套尺寸与圆角。
 */
export const FileCard = ({
  name,
  size,
  status = 'done',
  error,
  statusText,
  progress,
  corner,
  actions,
  activator,
  onRetry,
  onRemove,
  onOpen,
  className,
}: {
  name: string
  size: number
  status?: FileCardStatus
  error?: string
  /** 第三行：状态文案（解析中 45% / 部分内容已就绪…），不传就没有这一行 */
  statusText?: string
  /** 进度百分比；`null` 为不确定态（来回滑的进度块），不传则整条不出 */
  progress?: number | null
  /** 右上角角标（如 `partial` 的黄色警告条数），由调用方给样式 */
  corner?: ReactNode
  /** 末尾动作位（取消 / 移除），由调用方给按钮；给了就不再出右上角的删除小圆点 */
  actions?: ReactNode
  activator?: FileCardActivator
  onRetry?: () => void
  onRemove?: () => void
  onOpen?: () => void
  className?: string
}) => {
  const t = useTranslate()
  const ext = getExtension(name)
  let icon: ReactNode = <FileIcon ext={ext} />
  let description = [ext, formatSize(size)].filter(Boolean).join(' ')
  if (status === 'uploading') {
    icon = <span className={styles.spinner} />
    description = t('uploadFileStatusUploading')
  } else if (status === 'error') {
    // 不可重试（过大、格式不支持）时保留文件图标并显示原因
    if (onRetry) {
      icon = <IconRefreshOutline16 />
    }
    description = error ?? t('uploadFileStatusFailed')
  }
  const failed = status === 'error'
  const onClick =
    activator !== undefined
      ? activator.onActivate
      : failed
        ? onRetry
        : status === 'done'
          ? onOpen
          : undefined
  // 有面板可开时标题就是文件名；否则沿用「失败原因 / 重试提示」的既有口径
  const title =
    activator !== undefined
      ? name
      : failed
        ? onRetry
          ? t('uploadRetry', { message: description })
          : description
        : name
  const onKeyDown =
    activator === undefined
      ? undefined
      : (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activator.onActivate()
          }
        }
  return (
    <div
      className={clsx(
        styles.card,
        className,
        onRemove && styles.editable,
        failed && (onRemove || onRetry || activator !== undefined) && styles.failed,
        onClick && styles.clickable,
        activator !== undefined && styles.activatable,
        STATE_CLASS[status]
      )}
      title={title}
      onClick={onClick}
      role={activator === undefined ? undefined : 'button'}
      tabIndex={activator === undefined ? undefined : 0}
      aria-label={activator === undefined ? undefined : activator.label}
      aria-expanded={activator === undefined ? undefined : activator.expanded}
      onKeyDown={onKeyDown}
    >
      {corner}
      <div className={clsx(styles.icon, status === 'error' && onRetry && styles.retry)}>{icon}</div>
      <div className={styles.content}>
        <div className={styles.caption}>{name}</div>
        <div className={styles.subCaption}>{description}</div>
        {statusText === undefined ? null : <div className={styles.statusText}>{statusText}</div>}
        {progress === undefined ? null : (
          <span className={styles.progress}>
            {/* 进度只改 transform（#480 / #527）：`width` 是布局属性，过渡它每帧重排、必然掉帧。
                轨道占满，条子用 scaleX 表达百分比（条子本身宽度固定 100%，见 .progressBar） */}
            <span
              className={clsx(
                styles.progressBar,
                progress === null && styles.progressIndeterminate
              )}
              style={progress === null ? undefined : { transform: `scaleX(${progress / 100})` }}
            />
          </span>
        )}
      </div>
      {actions === undefined ? null : <div className={styles.actions}>{actions}</div>}
      {onRemove ? (
        <button
          type="button"
          className={clsx(styles.remove, failed && !onRetry && styles.invalidRemove)}
          aria-label={t('delete')}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <IconCloseFill14 />
        </button>
      ) : null}
    </div>
  )
}

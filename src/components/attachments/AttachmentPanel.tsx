/**
 * #527 附件详情小面板：点卡片弹出来，回答「这条附件到底怎么了」。
 *
 * 内容严格按 §3.5「不展示文档全文」：
 *  - 元信息（类型 / 大小 / 字符数 / 页数）；
 *  - warnings 列表（解析器原文 + 注入侧告警 + 截断说明）；
 *  - `failed` 时给出失败原因（按 manager 的 reason 码出人话）+ 技术信息原文；
 *  - 动作：「重新解析」（仅失败/取消）与「移除」。
 *
 * 定位与关闭复用 `base/anchored.ts`（与 `Menu` 同一套：视口边缘收口、Esc / 点外部关闭）。
 */
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { formatSize, getExtension } from '../../services/attachments.js'
import { useTranslate } from '../../i18n/index.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconCloseFill14,
  IconRefreshOutline16,
  IconTrashOutline16,
  IconWarningOutline16,
} from '../base/icons.js'
import { attachmentWarnings, failureOf, type AttachmentView } from './viewModel.js'
import styles from './Attachments.module.css'

export type AttachmentPanelTriggerProps = { open: boolean; toggle: () => void }

export const AttachmentPanel = ({
  view,
  onRemove,
  onRetry,
  children,
}: {
  view: AttachmentView
  onRemove?: (id: string) => void
  onRetry?: (id: string) => void
  /** 触发元素：由卡片提供（面板自己负责把它包进 float 锚点） */
  children: (props: AttachmentPanelTriggerProps) => ReactNode
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  const warnings = attachmentWarnings(view, t)
  const failure = view.status === 'failed' ? failureOf(view, t) : null
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    {
      align: 'start',
      offset: 6,
      // 内容会随 warnings 变化，同步重测一次，别让面板停在旧位置回弹
      measureKey: `${view.status}:${warnings.length}:${failure === null ? '' : failure.title}`,
      maxHeight: 340,
      minSpace: 200,
      // 锚点本身是 display: contents（不产生盒子），测量交给卡片那一层
      measureFirstChild: true,
    }
  )
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })

  // 与卡片副标题同源（`FileCard` 也是「扩展名 + formatSize」），不再各写一份
  const typeAndSize = [getExtension(view.filename), formatSize(view.size)].filter(Boolean).join(' ')
  const details: string[] = [typeAndSize]
  if (view.characterCount !== undefined) {
    details.push(
      t('attachDetailCharacters', {
        chars: view.characterCount,
        tokens: view.estimatedTokens === undefined ? 0 : view.estimatedTokens,
      })
    )
  }
  if (view.totalPages !== undefined) {
    details.push(
      t('attachDetailPages', {
        extracted: view.extractedPages === undefined ? 0 : view.extractedPages,
        total: view.totalPages,
      })
    )
  }

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? undefined}
              role="dialog"
              aria-label={t('attachOpenDetail')}
            >
              <div className={styles.header}>
                <span className={styles.title} title={view.filename}>
                  {view.filename}
                </span>
                <IconButton
                  size="xs"
                  icon={<IconCloseFill14 />}
                  tooltip={t('close')}
                  onClick={close}
                />
              </div>
              <div className={styles.meta}>{details.join(' · ')}</div>

              {failure !== null ? (
                <div className={styles.failure}>
                  <div className={styles.sectionTitle}>{t('attachDetailFailure')}</div>
                  <div className={styles.failureTitle}>{failure.title}</div>
                  {failure.raw === undefined ? null : (
                    <div className={styles.raw}>
                      <span className={styles.rawLabel}>{t('attachDetailRaw')}</span>
                      <span className={styles.rawText}>{failure.raw}</span>
                    </div>
                  )}
                </div>
              ) : null}

              {warnings.length > 0 ? (
                <div className={styles.warnings}>
                  <div className={styles.sectionTitle}>
                    {t('attachDetailWarnings', { count: warnings.length })}
                  </div>
                  <ul className={styles.warningList}>
                    {warnings.map((warning, index) => (
                      <li className={styles.warning} key={`${index}:${warning}`}>
                        <span className={styles.warningIcon}>
                          <IconWarningOutline16 />
                        </span>
                        <span className={styles.warningText}>{warning}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {onRemove === undefined && onRetry === undefined ? null : (
                <div className={styles.actions}>
                  {onRetry === undefined ||
                  (view.status !== 'failed' && view.status !== 'cancelled') ? null : (
                    <Button
                      variant="outlined"
                      size="s"
                      className={styles.action}
                      onClick={() => {
                        setOpen(false)
                        onRetry(view.id)
                      }}
                    >
                      <IconRefreshOutline16 />
                      {t('attachRetry')}
                    </Button>
                  )}
                  {onRemove === undefined ? null : (
                    <Button
                      variant="dangerOutlined"
                      size="s"
                      className={clsx(styles.action, styles.remove)}
                      onClick={() => {
                        setOpen(false)
                        onRemove(view.id)
                      }}
                    >
                      <IconTrashOutline16 />
                      {t('attachRemove')}
                    </Button>
                  )}
                </div>
              )}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

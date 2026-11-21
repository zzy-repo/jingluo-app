import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { IconEditOutline16 } from '../base/icons.js'
import { editMessage, retryUpload } from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { UserMessage as UserMessageType } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageAttachments, isAttachmentRefId } from '../attachments/index.js'
import { MessageFile } from './MessageFile.js'
import { CopyButton } from './CopyButton.js'
import { asArray } from '../../utils/safeArray.js'
import styles from './UserMessage.module.css'

/**
 * 在 textarea 光标处插入一个换行（#610）。
 *
 * 换行档的回车要「彻底吃掉」：先 `preventDefault()`，再自己插 —— 这样上层不可能再把它当快捷键。
 * 插入走 `execCommand('insertLineBreak')`：它被标了废弃，但仍是唯一插完还保留**原生撤销栈**的接口，
 * 老内核（Chromium 83 / Android WebView）都认。不支持时退回 `setRangeText` + 派发 `input`，
 * 让 React 的受控值跟着更新（否则 `value={draft}` 会在下一次渲染把插入的换行覆盖掉）。
 */
const insertLineBreak = (textarea: HTMLTextAreaElement) => {
  if (typeof document.execCommand === 'function' && document.execCommand('insertLineBreak')) {
    return
  }
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? start
  textarea.setRangeText('\n', start, end, 'end')
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 存储里的 files 可能被写成 null（半写入 / 导入中断 / 外部改库）：兜底成空数组，
  // 否则 message.files.length 直接抛 TypeError → 整屏白屏（issue #28）
  const files = asArray(message.files)
  /**
   * #379：这条消息**发送时**因源缺失被跳过的附件（导入的历史会话只有元信息）。
   * 它不是错误态 —— 消息已经按剩下的内容发出去了，这里只负责「说清楚是哪几个附件没跟着发」。
   * 用持久的一行提示而不是 toast：用户回看这条消息时，原因必须还在。
   */
  const unavailable = asArray(message.unavailable)
  /**
   * 文档附件（#480 / #527）与图片附件共用 `files` 这一个字段，靠 `att-` 前缀区分
   * （attachmentService 的 `isAttachmentRefId`，与 manager 的 `isAttachmentId` 同一套约定）。
   *
   * 为什么要分开渲染：图片是「缩略图 + 补传重试」，文档附件是「元信息卡片 + 解析状态 + 警告」，
   * 而且卡片**不渲染正文**（§3.5）——正文只按需送到请求里，从不进界面。
   */
  const documents = files.filter((file) => isAttachmentRefId(file.id))
  const uploads = files.filter((file) => !isAttachmentRefId(file.id))
  const canSend = !busy && (draft.trim() !== '' || files.length > 0)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  /**
   * #610：进编辑态时自己聚焦，**禁止原生 scroll-into-view**。
   *
   * 原来靠 `autoFocus`：浏览器的聚焦滚动会把视口甩到被编辑的那条消息上（长会话里实测一次
   * 跳 900+ px），用户看到的就是「进入编辑/按回车，屏幕滑到上面去了」；跳得太远时那一行还会
   * 被虚拟列表回收，编辑态跟着整个消失。光标放到末尾，与直接聚焦 textarea 的默认一致。
   */
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!editing || !textarea) {
      return
    }
    textarea.focus({ preventScroll: true })
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [editing])

  const sendEdit = () => {
    if (canSend && ensureApiKey() && editMessage(sessionId, message.id, draft.trim())) {
      stopReadAloud()
      setEditing(false)
    }
  }

  return (
    <div className={clsx(styles.container, isFirst && styles.isFirst)}>
      {documents.length > 0 ? (
        <MessageAttachments ids={documents.map((file) => file.id)} />
      ) : null}
      {uploads.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            uploads.some((file) => !file.isImage) && styles.filesWithDocuments
          )}
        >
          {uploads.map((file) => (
            <MessageFile
              key={file.id}
              file={file}
              onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
            />
          ))}
        </div>
      ) : null}
      {unavailable.length > 0 ? (
        <div className={styles.unavailable} role="note">
          {t('attachUnavailableSent', {
            names: unavailable.map((item) => item.name).join('、'),
          })}
        </div>
      ) : null}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            rows={1}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            enterKeyHint="enter"
            onKeyDown={(event) => {
              // 输入法选词期间的 Enter 是「上屏」，一概交给输入法（#108 / #610）：
              // keyCode 229 是部分 Android 输入法在合成中报的键码，和 isComposing 一起判。
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                return
              }
              if (event.key === 'Escape') {
                event.stopPropagation()
                setEditing(false)
                return
              }
              if (event.key !== 'Enter') {
                return
              }
              // #610：编辑框是多行文本，**回车只换行**，发送走按钮（桌面端 Ctrl / Cmd + Enter 也能发）。
              // 以前桌面端把纯 Enter 当「发送」：用户在段首按回车想换行，结果整段退出编辑并重新提问。
              // stopPropagation：换行档的回车不许冒到上层被当成全局快捷键（切会话 / 退编辑）。
              event.stopPropagation()
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault()
                sendEdit()
                return
              }
              // 换行档：吃掉默认行为（否则上层或输入法还能对这次回车另做解释），换行自己插。
              event.preventDefault()
              insertLineBreak(event.currentTarget)
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={sendEdit}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? <div className={styles.bubble}>{message.content}</div> : null}
          <div className={styles.bottom}>
            <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
              {message.content ? <CopyButton text={message.content} /> : null}
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => {
                  setDraft(message.content)
                  setEditing(true)
                }}
              />
            </div>
            <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          </div>
        </>
      )}
    </div>
  )
})

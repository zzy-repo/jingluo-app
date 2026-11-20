/**
 * #527 附件选择入口：输入框那一排的按钮 + 隐藏 `<input type="file">`。
 *
 * 三条行为约定：
 *  1. `accept` 只写 `.txt,.docx,.pdf`（来自 `SUPPORTED_EXTENSIONS`），多选；
 *  2. `accept` 只是对话框的过滤建议 —— 用户切到「所有文件」时照样能选中别的东西，
 *     所以**真正的类型判定在 `onFiles` 之后的 `classifyAttachmentFiles()`**，
 *     不合格的一条条提示并拒绝，不做静默过滤（issue #527 第 1 条）；
 *  3. 拖入 / 粘贴进输入框的文件走同一个 `onFiles`：ChatInput 已有 `DragMask` 收集 `File[]`，
 *     接线时把那个数组直接转给 `useAttachmentDrafts().addFiles` 即可。
 */
import { useRef, type ReactNode } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconButton } from '../base/IconButton.js'
import { IconPaperclipOutline16 } from '../base/icons.js'
import { ACCEPT_DOCUMENTS } from './attachmentService.js'

export const AttachmentPicker = ({
  onFiles,
  disabled,
  className,
  tooltip,
  icon,
}: {
  /** 选中（或拖入）的文件原样传出去，由调用方统一分拣 + 提示 */
  onFiles: (files: File[]) => void
  disabled?: boolean
  className?: string
  /** 缺省「添加文档（TXT / DOCX / PDF）」 */
  tooltip?: string
  /** 入口图标；缺省回形针。输入区还有「图片」入口时用它区分两个入口的语义 */
  icon?: ReactNode
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <IconButton
        size="m"
        tone="primary"
        className={className}
        icon={icon === undefined ? <IconPaperclipOutline16 /> : icon}
        tooltip={tooltip === undefined ? t('attachPickButton') : tooltip}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      />
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={ACCEPT_DOCUMENTS}
        onChange={(event) => {
          const files = Array.from(event.target.files === null ? [] : event.target.files)
          // 清空 value：同一个文件删掉后再选一次，才还会触发 change
          event.target.value = ''
          if (files.length > 0) {
            onFiles(files)
          }
        }}
      />
    </>
  )
}

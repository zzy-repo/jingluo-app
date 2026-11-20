import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { pinSession, renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  selecting = false,
  selected = false,
  onToggle,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  /** #390：列表处于「选择」模式时，整条会话变成可勾选项，点击切换勾选而不是打开会话。 */
  selecting?: boolean
  selected?: boolean
  onToggle?: (id: string) => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  if (selecting) {
    return (
      <div
        role="checkbox"
        aria-checked={selected}
        aria-label={displayTitle}
        className={clsx(styles.item, styles.selectable, selected && styles.selected)}
        onClick={() => onToggle?.(session.id)}
      >
        <span className={clsx(styles.check, selected && styles.checkOn)} aria-hidden="true">
          {selected ? <IconCheckOutline16 /> : null}
        </span>
        <div className={styles.title}>{displayTitle}</div>
      </div>
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      {session.pinnedAt !== undefined ? <span className={styles.pin} title={t('sessionPinnedLabel')} aria-label={t('sessionPinnedLabel')}><IconPinOutline16 /></span> : null}
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'pin',
              label: session.pinnedAt === undefined ? t('sessionItemMenuPinOption') : t('sessionItemMenuUnpinOption'),
              icon: <IconPinOutline16 />,
              onSelect: () => pinSession(session.id),
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})

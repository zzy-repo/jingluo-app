import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { IconPanelLeftOutline16, IconSettingsOutline16, NewChatIcon } from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { BackupError, exportHistory } from '../../services/chat/backup.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import { sweepOrphanAttachmentsAfterDelete } from '../attachments/index.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { downloadBlob } from '../../utils/downloadBlob.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => {
    const pinned = sessions.filter((session) => session.pinnedAt !== undefined)
    const unpinned = sessions.filter((session) => session.pinnedAt === undefined)
    const result = groupSessions(unpinned, now, t)
    return pinned.length > 0 ? [{ key: 'pinned', label: t('sessionPinnedGroup'), sessions: pinned }, ...result] : result
  }, [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  // #390 选择性导出：进入「选择」模式后逐条勾选，只导出勾中的会话（包格式与全量导出一致）。
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const exitSelection = () => {
    setSelecting(false)
    setSelected([])
  }
  const toggleSelected = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    )
  const selectAll = () => setSelected(sessions.map((session) => session.id))
  const invertSelection = () =>
    setSelected(
      sessions.filter((session) => !selectedSet.has(session.id)).map((session) => session.id)
    )

  /** 导出勾选的会话：空选择要给明确提示，不能静默什么都不发生。 */
  const exportSelected = async () => {
    const ids = sessions.filter((session) => selectedSet.has(session.id)).map((session) => session.id)
    if (ids.length === 0) {
      showToast({ key: 'historyExportSelectedEmpty', type: 'error' })
      return
    }
    setExporting(true)
    try {
      const { name, blob, sessions: exported } = await exportHistory({ sessionIds: ids })
      downloadBlob(blob, name)
      showToast({ key: 'historyExportedSelectedCount', params: { count: exported } })
      exitSelection()
    } catch (error) {
      showToast(
        error instanceof BackupError
          ? { key: error.key, params: error.params, type: 'error' }
          : {
              key: 'historyExportFailed',
              params: { message: error instanceof Error ? error.message : String(error) },
              type: 'error',
            }
      )
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      {sessions.length > 0 ? (
        <div className={styles.selectionToggleRow}>
          <button
            type="button"
            className={styles.selectionToggle}
            onClick={() => (selecting ? exitSelection() : setSelecting(true))}
          >
            {t(selecting ? 'historySelectModeExit' : 'historySelectModeEnter')}
          </button>
        </div>
      ) : null}
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  selecting={selecting}
                  selected={selectedSet.has(session.id)}
                  onToggle={toggleSelected}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {selecting ? (
        // 选择模式的底栏：已选 N 条 + 全选 / 反选 / 导出选中（移动端也在同一处，不另做一套）
        <div className={styles.selectionBar}>
          <div className={styles.selectionCount}>
            {t('historyExportSelectedCount', { count: selectedSet.size })}
          </div>
          <div className={styles.selectionActions}>
            <button type="button" className={styles.selectionAction} onClick={selectAll}>
              {t('historySelectAll')}
            </button>
            <button type="button" className={styles.selectionAction} onClick={invertSelection}>
              {t('historySelectInvert')}
            </button>
            <Button
              variant="outlined"
              size="m"
              disabled={exporting}
              onClick={() => void exportSelected()}
            >
              {t('historyExportSelected')}
            </Button>
          </div>
        </div>
      ) : null}
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                      /**
                       * 文档附件孤儿清扫（#480 / #527）：会话删除事务提交**之后**再扫，
                       * 先收集「当前仍被任一消息引用的附件 id」，再连元数据 / 全文 / 原件一起回收。
                       * 不 await：清理失败不该让「删除会话」这条主流程看起来失败（失败会自己 toast）。
                       */
                      void sweepOrphanAttachmentsAfterDelete()
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。关闭时保留 DOM 播完滑出动画再卸载。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const { mounted, visible, finishExit } = usePresence(open, MOTION_EXIT.drawer)
  // 进场键帧只在「本次挂载的第一次打开」播放：关闭中途再打开要走 transition 从当前值反向，
  // 否则键帧会从 -100% 重新起跑（先跳回屏外再滑出来）。
  // 用 layout effect 而不是普通 effect：卸载/关闭的那一刻就把标记改好，下次提交前不再残留。
  const [enterAnim, setEnterAnim] = useState(true)
  // 合成层提示（will-change）只在动画期间挂，动画结束后摘掉，避免常驻占显存
  const [motionActive, setMotionActive] = useState(true)

  useLayoutEffect(() => {
    if (!mounted) {
      // 已卸载：下一次挂载要重新播一次进场
      setEnterAnim(true)
      return
    }
    if (!visible) {
      // 本次挂载的进场周期结束，之后的「反向打开」都走 transition
      setEnterAnim(false)
    }
  }, [mounted, visible])

  useEffect(() => {
    setMotionActive(true)
    const timer = setTimeout(() => setMotionActive(false), MOTION_EXIT.drawer + 80)
    return () => clearTimeout(timer)
  }, [visible])

  /** 退出过渡/动画真正结束才卸载（比纯定时器更贴「播完再摘」），子元素的过渡不算 */
  const onMotionEnd = (event: { target: EventTarget; currentTarget: EventTarget }) => {
    if (event.target !== event.currentTarget || open) {
      return
    }
    finishExit()
  }

  if (!mounted) {
    return null
  }
  return (
    <>
      <div
        className={clsx(styles.drawerMask, visible ? styles.drawerMaskOpen : styles.drawerHidden)}
        onClick={closeMobileSider}
        aria-hidden="true"
      />
      <div
        className={clsx(styles.drawer, visible ? styles.drawerOpen : styles.drawerClosed)}
        data-motion-state={visible ? 'open' : 'closed'}
        data-enter={enterAnim ? 'true' : undefined}
        data-motion-active={motionActive ? 'true' : undefined}
        onTransitionEnd={onMotionEnd}
        onAnimationEnd={onMotionEnd}
      >
        <Sider mobile />
      </div>
    </>
  )
}

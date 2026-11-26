import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { filterSessionGroups } from '../../services/chat/sessionFilter.js'
import { parentTitleOf } from '../../services/chat/sessionBranch.js'
import { BackupError, exportHistory } from '../../services/chat/backup.js'
import { saveHistoryArchive } from '../../services/chat/history/saveArchive.js'
import { newChat, removeSession, useChatStore } from '../../services/chat/store.js'
import { sweepOrphanAttachmentsAfterDelete } from '../attachments/index.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { AnnouncementBadge } from '../announcements/AnnouncementBadge.js'
import { useAnnouncements } from '../announcements/useAnnouncements.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  // 未读公告数：设置入口与「公告栏」那一行的徽标同源（`services/announcements/store.ts`）
  const unreadAnnouncements = useAnnouncements().unreadCount
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => {
    const pinned = sessions.filter((session) => session.pinnedAt !== undefined)
    const unpinned = sessions.filter((session) => session.pinnedAt === undefined)
    const result = groupSessions(unpinned, now, t)
    return pinned.length > 0 ? [{ key: 'pinned', label: t('sessionPinnedGroup'), sessions: pinned }, ...result] : result
  }, [sessions, now, t])
  /**
   * 侧栏「按标题搜索会话」（设计稿 2026-11，搜索框在「开启新对话」与「历史对话」之间）。
   *
   * 口径在 `services/chat/sessionFilter.ts`：**只匹配标题**（消息正文另属全文搜索）、`trim` + 大小写不敏感、
   * 空查询返回全量、某时间分组过滤后为空则整组不显示。这里只负责把查询串接进去。
   *
   * 查询串是**纯展示态**：不写 settings、不入 IndexedDB —— 侧栏关掉/重开就回到默认全量列表，
   * 不会出现「下次打开 App 列表只剩上次搜的那几条」这种莫名其妙的存量。
   */
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const filteredGroups = useMemo(() => filterSessionGroups(groups, query), [groups, query])
  /**
   * #831：分支来源徽标要显示的父会话标题（`null` = 父会话不在本机 → 降级「来源已不在本机」）。
   * 一次 `Map` 算好传给每一行，比让每行自己订阅整个列表便宜：列表里 N 条会话时不会 N 次线性扫。
   */
  const parentTitles = useMemo(() => {
    const titles = new Map<string, string | null>()
    for (const session of sessions) {
      if (session.branchOf !== undefined) {
        titles.set(session.id, parentTitleOf(session.branchOf, sessions))
      }
    }
    return titles
  }, [sessions])
  const [deleting, setDeleting] = useState<string[] | null>(null)
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
  /**
   * 「全选」按**当前可见**的会话算：搜索时列表只剩命中的几条，若仍按全量勾选，
   * 用户会导出一批屏幕上根本看不见的会话。空查询时 `filteredGroups` 覆盖全部会话（含置顶组），
   * 行为与以前完全一致。
   */
  const selectAll = () =>
    setSelected(filteredGroups.flatMap((group) => group.sessions.map((session) => session.id)))

  /**
   * 导出勾选的会话：空选择要给明确提示，不能静默什么都不发生。
   *
   * 落盘走 `saveHistoryArchive`（#536）—— 与设置页的「导出所有历史对话」**同一个出口**：
   * Android 走原生 SAF（能真的写出文件），Web 走锚点下载。以前这里直接调 `downloadBlob`，
   * 在 WebView 里对 blob URL 的 `<a download>` 会静默失败（点了没反应、也没有错误提示）。
   */
  const exportSelected = async () => {
    const ids = sessions.filter((session) => selectedSet.has(session.id)).map((session) => session.id)
    if (ids.length === 0) {
      showToast({ key: 'historyExportSelectedEmpty', type: 'error' })
      return
    }
    setExporting(true)
    try {
      const { name, blob, sessions: exported } = await exportHistory({ sessionIds: ids })
      const outcome = await saveHistoryArchive({ filename: name, blob })
      // 用户在系统「保存到」面板上点了取消：不是失败，勾选保留着，方便他再点一次
      if (outcome.kind === 'cancelled') {
        return
      }
      if (outcome.kind === 'failed') {
        showToast(
          outcome.params === undefined
            ? { key: outcome.key, type: 'error' }
            : { key: outcome.key, params: outcome.params, type: 'error' }
        )
        return
      }
      // 落盘成功才说「已导出」：`name` 是真正写下去的文件名（SAF 可能改过名）
      showToast({ key: 'historyExportSelectedSaved', params: { count: exported, name: outcome.name } })
      exitSelection()
    } catch (error) {
      // 这里只剩「打包」阶段的失败（`exportHistory` 抛的）：落盘失败已经在出口里归一过了
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

  const confirmDelete = async () => {
    if (!deleting || deletePending) {
      return
    }
    setDeletePending(true)
    try {
      const failed: string[] = []
      for (const id of deleting) {
        if (!(await removeSession(id))) {failed.push(id)}
      }
      if (failed.length < deleting.length) {void sweepOrphanAttachmentsAfterDelete()}
      if (failed.length > 0) {
        setDeleting(failed)
        if (selecting) {setSelected(failed)}
        showToast({ key: 'sessionDeleteFailed', type: 'error' })
      } else {
        setDeleting(null)
        if (selecting) {exitSelection()}
      }
    } finally {
      setDeletePending(false)
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
    <div className={clsx(styles.sider, mobile && styles.mobile)} data-testid="sider">
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
      {/* 多选态下「开启新对话」禁用（设计稿右图第一项）：视觉与语义都得是不可点状态 */}
      <button
        type="button"
        className={styles.newChat}
        data-testid="sider-new-chat"
        disabled={selecting}
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
      {/*
        搜索框（设计稿 2026-11）：胶囊圆角、与「开启新对话」同宽，左放大镜、右侧「×」只在有内容时出现。
        用原生 `<input type="text">` + `inputMode="search"`，**不用 `type="search"`** ——
        iOS 会再画一个自带的清除按钮，和右侧我们自己的「×」并排出现两个，点哪个都可能不是用户想要的。
        没有会话时不渲染（搜一个空列表没有意义，且此时「历史对话」那一行本来也不显示）。
      */}
      {sessions.length > 0 ? (
        <div className={styles.searchRow}>
          <span className={styles.searchIcon} aria-hidden="true">
            <IconSearchOutline16 />
          </span>
          <input
            ref={searchRef}
            type="text"
            inputMode="search"
            className={styles.searchInput}
            data-testid="sider-search"
            value={query}
            placeholder={t('sessionSearchPlaceholder')}
            aria-label={t('sessionSearchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {/* 「×」只在有内容时出现；点它清空查询并把焦点留在输入框（否则要再点一次才能接着输入） */}
          {query.length > 0 ? (
            <button
              type="button"
              className={styles.searchClear}
              data-testid="sider-search-clear"
              aria-label={t('sessionSearchClear')}
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
            >
              <IconCloseOutline16 />
            </button>
          ) : null}
        </div>
      ) : null}
      {/*
        「历史对话」那一行：默认态 = 标题 + 右侧蓝色「选择」；多选态整行换成「全选 + 取消」。
        两个态共用同一个容器，行高一致，切换时列表不跳动。
      */}
      {sessions.length > 0 ? (
        <div className={styles.listHeader} data-testid="sider-list-header">
          {selecting ? (
            <>
              <button
                type="button"
                className={styles.listHeaderLink}
                data-testid="sider-select-all"
                onClick={selectAll}
              >
                {t('historySelectAll')}
              </button>
              <button
                type="button"
                className={styles.listHeaderCancel}
                data-testid="sider-selection-cancel"
                onClick={exitSelection}
              >
                {t('cancel')}
              </button>
            </>
          ) : (
            <>
              <span className={styles.listHeaderTitle}>{t('historySiderTitle')}</span>
              <button
                type="button"
                className={styles.listHeaderLink}
                data-testid="sider-select-toggle"
                onClick={() => setSelecting(true)}
              >
                {t('historySelectModeEnter')}
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className={styles.listWrap}>
        <div className={styles.list} data-testid="sider-list">
          {/*
            一条都没命中时给一行明确提示：不能只剩一个空白的列表（用户会以为会话丢了，
            而不是「我搜的词没有匹配」）。只在**真的搜了**（trim 后非空）时出现。
          */}
          {query.trim() !== '' && filteredGroups.length === 0 ? (
            <div className={styles.searchEmpty} data-testid="sider-search-empty">
              {t('sessionSearchEmpty')}
            </div>
          ) : null}
          {filteredGroups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  parentTitle={parentTitles.get(session.id)}
                  selecting={selecting}
                  selected={selectedSet.has(session.id)}
                  onToggle={toggleSelected}
                  onDelete={() => setDeleting([session.id])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {selecting ? (
        /*
         * 多选态底部操作条（设计稿右图第 4 项）：与列表之间一条分隔线，左「已选 N 项」+ 次要的「导出选中」，
         * 右红色「🗑 删除」为主操作。它是 `.sider` 的 flex 子项、在滚动容器 `.listWrap` **之外**，
         * 所以列表滚到哪一行它都在屏幕底部可见（不需要 sticky，也不会因滚动被推走）。
         */
        <div className={styles.selectionBar} data-testid="sider-selection-footer">
          <div className={styles.selectionFooterLeft}>
            <span className={styles.selectionCount} data-testid="sider-selection-count">
              {t('historyExportSelectedCount', { count: selectedSet.size })}
            </span>
            {/* 功能保留：「导出选中」降级为操作条左侧的次要文字按钮（主视觉仍是计数 + 红色删除） */}
            <button
              type="button"
              className={styles.selectionExport}
              disabled={exporting}
              data-testid="sider-export-selected"
              onClick={() => void exportSelected()}
            >
              {t('historyExportSelected')}
            </button>
          </div>
          <button
            type="button"
            className={styles.selectionDelete}
            disabled={exporting || selected.length === 0}
            data-testid="sider-delete-selected"
            onClick={() => {
              const ids = sessions.filter((session) => selectedSet.has(session.id)).map((session) => session.id)
              if (ids.length > 0) {setDeleting(ids)}
            }}
          >
            <span className={styles.selectionDeleteIcon} aria-hidden="true">
              <IconTrashOutline16 />
            </span>
            {t('delete')}
          </button>
        </div>
      ) : null}
      <div className={styles.bottom}>
        <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
          <span className={styles.settingsIcon}>
            <IconSettingsOutline16 />
          </span>
          <span className={styles.settingsLabel}>{t('settings')}</span>
          {/* 有未读公告时在设置入口上也挂红点：用户不进设置也能知道有新公告（与「公告栏」那一行的徽标同源） */}
          {unreadAnnouncements > 0 ? (
            <span className={styles.settingsBadge}>
              <AnnouncementBadge count={unreadAnnouncements} />
            </span>
          ) : null}
        </button>
      </div>
      {deleting ? (
        <Modal
          title={t(selecting ? 'historyDeleteSelected' : 'deleteSessionModalContentTitle')}
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
                onClick={() => void confirmDelete()}
              >
                {t(selecting ? 'historyConfirmDelete' : 'delete')}
              </Button>
            </>
          }
        >
          {selecting ? t('historyDeleteSelectedWarning', { count: deleting.length }) : t('deleteSessionWithFilesDescription')}
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
        data-sider-swipe="close"
        className={clsx(styles.drawerMask, visible ? styles.drawerMaskOpen : styles.drawerHidden)}
        onClick={closeMobileSider}
        aria-hidden="true"
      />
      <div
        data-sider-swipe="close"
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

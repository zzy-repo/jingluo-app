import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslate, type TranslationKey, type TranslationParams } from '../../i18n/index.js'
import { setAutoBackup, useSettings } from '../../services/settings.js'
import {
  getStatus,
  listBackups,
  restoreBackup,
  runBackup,
  type BackupItem,
  type BackupStatus,
} from '../../services/backup/backupApi.js'
import {
  BACKUP_LIST_PREVIEW,
  canRestoreBackup,
  canRunBackup,
  failureOf,
  formatSize,
  formatWhen,
  itemLine,
  lastBackupText,
  restoreListWindow,
  spaceValue,
  spaceView,
  statusView,
  type BackupPhase,
  type FailureRecord,
  type StatusView,
} from '../../services/backup/backupView.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './Settings.module.css'

/**
 * 设置页「数据备份与恢复」（#993 任务 3）。
 *
 * 界面只回答四件事：**有没有备份 / 什么时候备份的 / 占了多少空间 / 怎么恢复**。
 * 视觉全部复用设置页现成的卡片与行（`Settings.module.css` 的 `.cell / .row / .text /
 * .label / .description / .cellActions / .progress*`），不新增设计系统、不动别的区域。
 *
 * 两条硬约束：
 *  1. **文案里不许出现技术词**（存储实现名 / 表结构与版本 / 文件路径 / 校验算法名 / 原始英文报错）。
 *     状态与失败原因一律走 `services/backup/backupView.ts` 的映射，技术细节只进诊断日志。
 *  2. 恢复**先确认再动手**，并且明确告诉用户「恢复前会先保护当前数据」；失败时按
 *     `currentDataIntact` 分档说话 —— 不许无条件承诺「原有数据安全」。
 */

/** 设置页通用行：标签 + 说明（可带进度条）+ 右侧动作。与其它设置行同一套 class。 */
const Cell = ({
  label,
  description,
  action,
  testId,
  children,
}: {
  label: string
  description?: string
  action?: ReactNode
  testId?: string
  children?: ReactNode
}) => (
  <div className={clsx(styles.cell, styles.row)} data-testid={testId}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      {description === undefined ? null : <div className={styles.description}>{description}</div>}
      {children}
    </div>
    {action === undefined ? null : <div className={styles.cellActions}>{action}</div>}
  </div>
)

/** 状态句：失败标红；其余按次要文字 */
const StatusText = ({ view }: { view: StatusView }) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.description, view.error && styles.error)}>
      {t(view.key, view.params)}
    </div>
  )
}

/** 进度条：复用「导入历史」那条进度条的样式（`scaleX` 驱动，不写新样式） */
const ProgressBar = ({ percent }: { percent: number }) => (
  <div className={styles.progressTrack}>
    <div className={styles.progressFill} style={{ transform: `scaleX(${percent / 100})` }} />
  </div>
)

/**
 * 恢复流程（选一份 → 确认 → 执行 → 结果）。
 *
 * 单独抽成 hook + 弹层，是为了让「设置页里的恢复按钮」和「启动丢库入口」共用同一套流程，
 * 不写第二份确认文案（确认里那两句是产品承诺，只能有一个来源）。
 */
export const useBackupRestore = ({ onFinished }: { onFinished?: () => void } = {}) => {
  const [picking, setPicking] = useState(false)
  const [items, setItems] = useState<BackupItem[] | null>(null)
  const [pending, setPending] = useState<BackupItem | null>(null)
  const [phase, setPhase] = useState<BackupPhase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [failure, setFailure] = useState<FailureRecord | null>(null)
  const [finished, setFinished] = useState(false)
  /** 防重复点击：`state` 是异步的，连点会在同一帧里进来两次，必须用 ref 拦 */
  const busy = useRef(false)

  const load = useCallback(async () => {
    try {
      setItems(await listBackups())
    } catch {
      setItems([])
    }
  }, [])

  const open = () => {
    setFailure(null)
    setFinished(false)
    setProgress({ done: 0, total: 0 })
    setPicking(true)
    void load()
  }

  const close = () => {
    if (busy.current) {
      return
    }
    setPicking(false)
  }

  /** 选一份可用备份：不完整的（`checksumOk === false`）点不动 */
  const pick = (item: BackupItem) => {
    if (!item.checksumOk) {
      return
    }
    setPicking(false)
    setPending(item)
  }

  const cancel = () => {
    if (busy.current) {
      return
    }
    setPending(null)
  }

  const confirm = async () => {
    if (busy.current || pending === null) {
      return
    }
    busy.current = true
    setPhase('restore')
    setProgress({ done: 0, total: 0 })
    setFailure(null)
    setFinished(false)
    try {
      await restoreBackup(pending.id, (done, total) => setProgress({ done, total }))
      setFinished(true)
      onFinished?.()
    } catch (error) {
      setFailure({ ...failureOf(error), action: 'restore', atUtc: new Date().toISOString() })
    } finally {
      busy.current = false
      setPhase('idle')
      setPending(null)
    }
  }

  return {
    picking,
    items,
    pending,
    phase,
    progress,
    failure,
    finished,
    open,
    close,
    pick,
    cancel,
    confirm,
  }
}

export type BackupRestoreFlow = ReturnType<typeof useBackupRestore>

/** 恢复流程的两个弹层：选择列表 + 风险确认（确认里含「会先保护当前数据」） */
export const RestoreModals = ({ flow }: { flow: BackupRestoreFlow }) => {
  const t = useTranslate()
  const busy = flow.phase !== 'idle'
  /**
   * 列表默认露 5 条（这里不是管理页，一屏铺满不是它的职责），**但差额必须能被点开**。
   *
   * 设置页「备份占用空间」一格显示的是**盘上真实份数**（`spaceValue` 的 `count`，核心侧扫描结果）。
   * 界面上那两处一旦不一致，用户看到的结论就是「备份丢了」——#1007 缺陷 1 的设备现场是
   * 盘上 7 份、恢复列表 5 条，那两行「就是这么看起来消失的」。所以「露几条」可以截，
   * 「有没有」不许截：截断只发生在 `restoreListWindow` 里，并且它同时算出「还有 N 份」的 N。
   */
  const [expanded, setExpanded] = useState(false)
  const list = restoreListWindow(flow.items ?? [], expanded)
  // 每次关掉列表都回到默认的「5 条 + 还有 N 份」：把上次展开的状态带到下一次，
  // 会让用户以为列表本来就这么长
  useEffect(() => {
    if (!flow.picking) {
      setExpanded(false)
    }
  }, [flow.picking])
  return (
    <>
      {flow.picking ? (
        <Modal
          title={t('backupRestorePickTitle')}
          className={styles.deleteConfirm}
          onClose={flow.close}
          testId="backup-restore-pick"
        >
          {flow.items === null ? (
            <div className={styles.description}>{t('sessionLoading')}</div>
          ) : list.shown.length === 0 ? (
            <div className={styles.description}>{t('backupRestoreEmpty')}</div>
          ) : (
            <div>
              {list.shown.map((item) => (
                <div
                  key={item.id}
                  className={clsx(styles.cell, styles.row)}
                  data-testid="backup-restore-item"
                >
                  <div className={styles.text}>
                    <div className={styles.label}>{t(itemLine(item).key, itemLine(item).params)}</div>
                    {item.checksumOk ? null : (
                      <div className={clsx(styles.description, styles.error)}>
                        {t('backupRestoreUnusable')}
                      </div>
                    )}
                  </div>
                  <div className={styles.cellActions}>
                    <Button
                      variant="outlined"
                      size="m"
                      className={styles.cellButton}
                      disabled={!item.checksumOk}
                      data-testid="backup-restore-select"
                      onClick={() => flow.pick(item)}
                    >
                      {t('backupRestore')}
                    </Button>
                  </div>
                </div>
              ))}
              {list.hiddenCount > 0 ? (
                <div className={styles.cellActions}>
                  <Button
                    variant="outlined"
                    size="m"
                    className={styles.cellButton}
                    data-testid="backup-restore-more"
                    onClick={() => setExpanded(true)}
                  >
                    {t('backupRestoreMore', { count: list.hiddenCount })}
                  </Button>
                </div>
              ) : expanded && list.shown.length > BACKUP_LIST_PREVIEW ? (
                <div className={styles.cellActions}>
                  <Button
                    variant="outlined"
                    size="m"
                    className={styles.cellButton}
                    data-testid="backup-restore-less"
                    onClick={() => setExpanded(false)}
                  >
                    {t('backupRestoreCollapse')}
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </Modal>
      ) : null}
      {flow.pending === null ? null : (
        <Modal
          title={t('backupRestoreConfirmTitle')}
          className={styles.deleteConfirm}
          onClose={flow.cancel}
          zIndex={1100}
          footer={
            <div className={styles.deleteActions} aria-busy={busy}>
              <Button variant="outlined" disabled={busy} onClick={flow.cancel}>
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void flow.confirm()}>
                {t('backupRestoreConfirmAction')}
              </Button>
            </div>
          }
        >
          <div data-testid="backup-restore-confirm">
            <div>{t('backupRestoreConfirmReplace')}</div>
            {/* 产品承诺：先说清「有退路」，用户才敢点 */}
            <div className={styles.description}>{t('backupRestoreConfirmSafety')}</div>
            <div className={styles.description}>
              {t('backupRestoreConfirmTime', { time: formatWhen(flow.pending.createdAtUtc) })}
            </div>
            <div className={styles.description}>
              {t('backupRestoreConfirmSize', { size: formatSize(flow.pending.sizeBytes) })}
            </div>
            {flow.pending.sessionCount > 0 ? (
              <div className={styles.description}>
                {t('backupRestoreConfirmCount', { count: flow.pending.sessionCount })}
              </div>
            ) : null}
            <div className={styles.description}>{t('backupRestoreConfirmIntegrity')}</div>
            {/* 只在真的在跑 / 真的失败了才占一行：idle 时 statusView 会因为 status=null
                返回「暂时读不到备份情况」，那句话在确认弹窗里与上面「完整性检查：通过」自相矛盾 */}
            {flow.phase !== 'idle' || flow.failure !== null ? (
              <div className={styles.progressBlock}>
                <StatusText
                  view={statusView({
                    status: null,
                    phase: flow.phase,
                    done: flow.progress.done,
                    total: flow.progress.total,
                    failure: flow.failure,
                  })}
                />
              </div>
            ) : null}
          </div>
        </Modal>
      )}
    </>
  )
}

/** 设置页里的「数据备份与恢复」区域本体 */
export const BackupField = () => {
  const t = useTranslate()
  const autoBackup = useSettings((state) => state.autoBackup)
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [phase, setPhase] = useState<BackupPhase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [failure, setFailure] = useState<FailureRecord | null>(null)
  /**
   * 本会话里**最近一次成功操作**的时间（备份成功 / 恢复成功都算）。
   *
   * 只为了把早于它的那次失败判成旧话：设备现场是「低空间备份失败 → 恢复成功」之后，
   * 状态行同时挂着「存储空间不足，暂时无法备份」和「已恢复完成」，盘上 `status.json` 的
   * `last_error` 却早已是 null —— 盘上事实是好的，UI 在说旧话（#1007 缺陷 2）。
   * 判据在 `backupView.failureIsStale` 里，这里只负责把证据（成功时间）传下去。
   */
  const [succeededAtUtc, setSucceededAtUtc] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ key: TranslationKey; params?: TranslationParams } | null>(
    null
  )
  const busy = useRef(false)
  const restore = useBackupRestore({
    onFinished: () => {
      setSucceededAtUtc(new Date().toISOString())
      setNotice({ key: 'backupRestoreDone' })
      void refresh()
    },
  })

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runNow = async () => {
    // 防重复点击：连点时第二次直接返回（状态是异步的，只靠 disabled 拦不住同一帧的两次点击）
    if (busy.current) {
      return
    }
    busy.current = true
    setPhase('backup')
    setProgress({ done: 0, total: 0 })
    setFailure(null)
    setNotice(null)
    try {
      const item = await runBackup('manual', (done, total) => setProgress({ done, total }))
      setSucceededAtUtc(new Date().toISOString())
      setNotice({ key: 'backupNowDone', params: { size: formatSize(item.sizeBytes) } })
    } catch (error) {
      setFailure({ ...failureOf(error), action: 'backup', atUtc: new Date().toISOString() })
    } finally {
      busy.current = false
      setPhase('idle')
      await refresh()
    }
  }

  const view = statusView({
    status,
    phase,
    done: progress.done,
    total: progress.total,
    failure: failure ?? restore.failure,
    succeededAtUtc,
  })
  const space = spaceView(status)
  const last = lastBackupText(status)
  const used = spaceValue(status)
  const running = phase !== 'idle' || restore.phase !== 'idle'

  return (
    <>
      <div className={styles.cardLabel}>{t('backupSectionTitle')}</div>
      <Cell
        label={t('backupAutoLabel')}
        description={t('backupAutoDescription')}
        testId="backup-auto"
        action={
          <>
            <span className={styles.description}>
              {t(autoBackup ? 'backupAutoOn' : 'backupAutoOff')}
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label={t('backupAutoLabel')}
              data-testid="backup-auto-toggle"
              checked={autoBackup}
              onChange={(event) => setAutoBackup(event.currentTarget.checked)}
            />
          </>
        }
      />
      <Cell label={t('backupLastLabel')} testId="backup-last">
        <div className={styles.description}>
          {'key' in last ? t(last.key) : last.text}
        </div>
      </Cell>
      <Cell label={t('backupStatusLabel')} testId="backup-status">
        <StatusText view={view} />
        {view.percent === null ? null : <ProgressBar percent={view.percent} />}
        {notice === null ? null : (
          <div className={styles.description} data-testid="backup-notice">
            {t(notice.key, notice.params)}
          </div>
        )}
      </Cell>
      <Cell label={t('backupSpaceLabel')} testId="backup-space">
        <div className={styles.description}>{t(used.key, used.params)}</div>
        {space === null ? null : (
          <div
            className={clsx(styles.description, space.level === 'blocked' && styles.error)}
            data-testid="backup-space-notice"
          >
            {t(space.key, space.params)}
          </div>
        )}
      </Cell>
      <Cell
        label={t('backupNow')}
        testId="backup-now"
        action={
          <Button
            size="m"
            className={styles.cellButton}
            disabled={running || !canRunBackup(status, phase)}
            data-testid="backup-now-button"
            onClick={() => void runNow()}
          >
            {t(phase === 'backup' ? 'backupNowBusy' : 'backupNow')}
          </Button>
        }
      />
      <Cell
        label={t('backupRestore')}
        testId="backup-restore"
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={running || !canRestoreBackup(status, restore.phase, restore.items)}
            data-testid="backup-restore-button"
            onClick={restore.open}
          >
            {t('backupRestore')}
          </Button>
        }
      />
      <RestoreModals flow={restore} />
    </>
  )
}
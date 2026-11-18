import clsx from 'clsx'
import { useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
} from '../../services/chat/backup.js'
import {
  canImportFromUrl,
  importHistoryFromUrl,
  UrlImportCancelled,
  type ImportTraceEntry,
  type UrlImportProgress,
} from '../../services/chat/history/urlImport.js'
import { copyText } from '../../utils/clipboard.js'
import { useIsMobile } from '../../app/viewport.js'
import { useChatStore } from '../../services/chat/store.js'
import {
  setLocale,
  setThemePreference,
  setTtsVoice,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import { useTranslate, type TranslationKey, type TranslationMessage } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { ApiConfigFields, ApiKeyConfirm, useApiKeyEditor } from './ApiConfigFields.js'
import { AppUpdateField } from './AppUpdateField.js'
import { ChatBackgroundField } from './ChatBackgroundField.js'
import { OursServicesRow } from './OursServicesDialog.js'
import { FeedbackDialog } from './FeedbackDialog.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（服务配置、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  // 关闭时先留 DOM 播完退出动画（移动端底部滑落 / 桌面端缩小淡出）再卸载
  const { mounted, visible } = usePresence(open, MOTION_EXIT.modal)
  return mounted ? <SettingsContent visible={visible} /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = ({ visible }: { visible: boolean }) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 打开时按调用方指定的分组选中，之后在弹窗内切换
  const [section, setSection] = useState(() => useSettingsDialog.getState().section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyImport = useHistoryImport()
  const historyDelete = useHistoryDelete()
  // 反馈弹窗：integrity=true 表示从「检查日志完整性」进入，自检面板默认展开
  const [feedback, setFeedback] = useState({ open: false, integrity: false })
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy = historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable
        visible={visible}
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyDelete.busy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => setSection(item.value)}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <AppUpdateField />
              {/* 「位置信息」已从设置页移除（1.4.0-beta.1）：location 仍在 store 里读取，
                  只用于 latest_reminder 快照，界面上不再暴露入口。 */}
            </>
          ) : (
            <>
              <ApiConfigFields editor={apiKeyEditor} />
              {/* 额度查询 / 套餐 / 卡密兑换 / 订单状态：只在「我们的渠道」下出现 */}
              <OursServicesRow />
              <ChatBackgroundField />
              <ImportHistory historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <SettingCell
                label={t('feedbackCellLabel')}
                description={t('feedbackCellDescription')}
                status={null}
                action={
                  <>
                    <Button
                      variant="outlined"
                      size="m"
                      className={styles.cellButton}
                      onClick={() => setFeedback({ open: true, integrity: false })}
                    >
                      {t('feedbackCellAction')}
                    </Button>
                    {/* 用户反馈前可先自检：条数 / 时间跨度 / 事件类型覆盖 / 缺失项 */}
                    <Button
                      variant="outlined"
                      size="m"
                      className={styles.cellButton}
                      onClick={() => setFeedback({ open: true, integrity: true })}
                    >
                      {t('feedbackIntegrityCheck')}
                    </Button>
                  </>
                }
              />
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
              {isMobile ? <ApiKeyConfirm editor={apiKeyEditor} /> : null}
            </>
          )}
        </div>
      </Modal>
      {historyImport.source ? <ImportConfirm historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
      <FeedbackDialog
        open={feedback.open}
        integrity={feedback.integrity}
        onClose={() => setFeedback((current) => ({ ...current, open: false }))}
      />
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

/**
 * 覆盖导入的二次确认，叠在设置弹窗上。
 * 链接导入在这一步之后还要下载 → 解析 → 导入，全程不关闭弹窗：
 * 逐阶段显示「已下载 8.4MB/20.2MB（42%）」这类真实进度，任何时候都能取消。
 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const progress = historyImport.progress
  const percent = progressPercent(progress)
  return (
    <Modal
      title={t('historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant="dangerOutlined"
            size="m"
            disabled={progress !== null}
            onClick={() => void historyImport.confirm()}
          >
            {t(progress === null ? 'historyImportConfirm' : 'historyImportUrlDownloading')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        {progress === null ? (
          t('historyImportConfirmDescription')
        ) : (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>{progressLabel(t, progress)}</div>
            {percent === null ? null : (
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ transform: `scaleX(${percent / 100})` }}
                />
              </div>
            )}
            <div className={styles.description}>{t('historyImportUrlDownloadingHint')}</div>
          </div>
        )}
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导入状态带来源：文件导入的提示只显示在「导入历史对话」行，链接导入只显示在「从链接导入」行。 */
type ImportStatus = { target: 'file' | 'url'; message: Status }

/** 失败附带原因：预期的错误用对应文案（连同其占位符参数）作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key, params: error.params }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

/** 状态的最终文案（含失败原因），供显示与复制共用。 */
const statusText = (t: ReturnType<typeof useTranslate>, status: Status): string =>
  status === null
    ? ''
    : t(status.key, {
        ...status.params,
        ...(status.reason ? { message: t(status.reason, status.params) } : {}),
      })

/** 说明文字：有状态就显示状态（失败标红），否则显示静态说明。 */
const CellText = ({ status, description }: { status: Status; description?: string }) => {
  const t = useTranslate()
  if (!status && !description) {
    return null
  }
  return (
    <div className={clsx(styles.description, status?.error && styles.error)}>
      {status ? statusText(t, status) : description}
    </div>
  )
}

/** 失败原因一眼能看完的字符数；更长的（带服务端原文）折叠到 4 行，可展开、可复制。 */
const DETAIL_CLAMP_CHARS = 60

/**
 * 失败提示：默认最多 4 行（360dp 宽也不会被裁切），可展开看全文，
 * 并可一键复制（长按选中复制同样可用）——用户反馈问题时要能把原文贴出来。
 */
const ErrorNotice = ({ text }: { text: string }) => {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > DETAIL_CLAMP_CHARS
  return (
    <div className={styles.errorBox}>
      <div className={clsx(styles.error, long && !expanded && styles.errorClamped)}>{text}</div>
      {long || text.includes('403') ? (
        <div className={styles.errorActions}>
          {long ? (
            <button
              type="button"
              className={styles.errorAction}
              onClick={() => setExpanded((value) => !value)}
            >
              {t(expanded ? 'detailsCollapse' : 'detailsExpand')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.errorAction}
            onClick={() => void copyText(text).then((ok) => !ok && showToast(t('copyFailed')))}
          >
            {t('copy')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 详情条数上限：再多也没人看，且避免长会话把内存撑大。 */
const MAX_TRACE_ENTRIES = 100

/** 相对时间：mm:ss.S（少数几十秒的导入够用，也方便用户对着截图说“卡在这里”）。 */
const traceTime = (ms: number): string => {
  const total = Math.max(0, ms)
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const tenth = Math.floor((total % 1000) / 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenth}`
}

/**
 * 复制到剪贴板前的兜底脱敏：
 * 详情里本来就不存完整导URL（只有 redactUrl 后的路径），这里再把可能漏进来的
 * 签名/密钥/查询串与超链接抹掉，避免用户把私密导出链接贴到反馈里。
 */
const redactTraceText = (text: string): string =>
  text
    .replace(/\b(Signature|AccessKeyId|Expires|X-Amz-[A-Za-z-]+)=[^&\s)]*/gi, '$1=***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/https?:\/\/[^\s)]+/gi, (match) => {
      try {
        const url = new URL(match)
        return `${url.protocol}//${url.host}/***`
      } catch {
        return '***'
      }
    })

/** 一条详情的人话文案；拿不到总数/字节时不编数字。 */
const traceLine = (t: ReturnType<typeof useTranslate>, entry: ImportTraceEntry): string => {
  switch (entry.kind) {
    case 'start':
      return t('importTraceStart')
    case 'download':
      return entry.totalBytes === undefined
        ? t('importTraceDownload', { done: formatBytes(entry.bytes ?? 0) })
        : t('importTraceDownloadTotal', {
            done: formatBytes(entry.bytes ?? 0),
            total: formatBytes(entry.totalBytes),
          })
    case 'heartbeat':
      // 心跳：这一段没有任何新字节，只用来证明「最后活着的时刻」+ 已下载多少
      return entry.totalBytes === undefined
        ? t('importTraceHeartbeatUnknown', { done: formatBytes(entry.bytes ?? 0) })
        : t('importTraceHeartbeat', {
            done: formatBytes(entry.bytes ?? 0),
            total: formatBytes(entry.totalBytes),
          })
    case 'check':
      return entry.totalSessions === undefined
        ? t('importTraceCheckUnknown')
        : t('importTraceCheck', { total: entry.totalSessions })
    case 'session':
      return entry.totalSessions === undefined
        ? t('importTraceSessionUnknown', { done: entry.sessions ?? 0 })
        : t('importTraceSession', { done: entry.sessions ?? 0, total: entry.totalSessions })
    case 'image':
      return t('importTraceImage', { count: entry.images ?? 0 })
    case 'done':
      return t('importTraceDone', { count: entry.sessions ?? 0 })
    case 'cancel':
      return t('importTraceCancel')
    case 'error':
    default: {
      const reason =
        entry.message === 'unreachable'
          ? t('importTraceReasonUnreachable')
          : entry.message === 'interrupted'
            ? t('importTraceReasonInterrupted')
            : entry.message === 'timeout'
              ? t('importTraceReasonTimeout')
              : entry.message === 'expired'
                ? t('importTraceReasonExpired')
                : entry.message === 'signature'
                  ? t('importTraceReasonSignature')
                  : entry.message === 'forbidden'
                    ? t('importTraceReasonForbidden')
                    : entry.message === 'stalled'
                      ? t('importTraceReasonStalled', { done: formatBytes(entry.bytes ?? 0) })
                      : entry.status !== undefined && entry.status > 0
                        ? t('importTraceReasonHttp', { status: entry.status })
                        : t('importTraceReasonNetwork')
      const stage =
        entry.status === undefined || entry.status === 0
          ? t('importTraceStageDownload')
          : t('importTraceStageDownload')
      return t('importTraceError', { stage, reason })
    }
  }
}

/**
 * 「导入详情」：默认折叠，展开后是带时间的少量人话事件（下载真实字节/校验/会话/图片/完成/取消/失败）。
 * 事实来自 urlImport 的 onTrace（与 diagnostics 同一处产生），最多 100 条，复制时再脱敏一遍。
 */
const ImportTraceDetails = ({ entries }: { entries: ImportTraceEntry[] }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (entries.length === 0) {
    return null
  }
  const last = entries[entries.length - 1]
  const copy = async () => {
    const body = entries
      .map((entry) => `${traceTime(entry.at)}  ${traceLine(t, entry)}`)
      .join('\n')
    const ok = await copyText(redactTraceText(`DeepSeek import details\n${body}`))
    if (!ok) {
      showToast(t('copyFailed'))
    }
  }
  return (
    <div className={styles.traceBox}>
      <div className={styles.traceHeader}>
        <button type="button" className={styles.errorAction} onClick={() => setOpen((value) => !value)}>
          {open ? t('detailsCollapse') : t('detailsExpand')}
        </button>
        <span className={styles.traceTitle}>{t('importTraceTitle', { count: entries.length })}</span>
        <span className={styles.traceElapsed}>{t('importTraceElapsed', { time: traceTime(last.at) })}</span>
        <button type="button" className={styles.errorAction} onClick={() => void copy()}>
          {t('importTraceCopy')}
        </button>
      </div>
      {open ? (
        <ol className={styles.traceList}>
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={styles.traceRow}>
              <span className={styles.traceTime}>{traceTime(entry.at)}</span>
              <span className={styles.traceText}>{traceLine(t, entry)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** 字节数：弱网下「已下载 16KB」这种小数值也要看得见，所以 KB 之前不换算成小数。 */
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 分阶段文案：下载（字节/百分比）→ 解析 → 导入（n/总数），取代原来恒定的「下载中...」。 */
const progressLabel = (
  t: ReturnType<typeof useTranslate>,
  progress: UrlImportProgress
): string => {
  if (progress.phase === 'downloading') {
    const done = formatBytes(progress.downloadedBytes)
    if (progress.totalBytes === undefined || progress.totalBytes === 0) {
      return t('historyImportUrlDownloadingBytes', { done })
    }
    const percent = Math.min(99, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
    return t('historyImportUrlDownloadingProgress', {
      done,
      total: formatBytes(progress.totalBytes),
      percent,
    })
  }
  if (progress.phase === 'decoding') {
    return t('historyImportUrlDecoding')
  }
  return progress.totalSessions === undefined
    ? t('historyImportUrlImportingCount', { processed: progress.processed })
    : t('historyImportUrlImporting', {
        processed: progress.processed,
        total: progress.totalSessions,
      })
}

/** 进度条百分比：只在能算出比例时显示（下载有总大小 / 导入有会话总数）。 */
const progressPercent = (progress: UrlImportProgress | null): number | null => {
  if (!progress) {
    return null
  }
  if (progress.phase === 'downloading') {
    if (!progress.totalBytes) {
      return null
    }
    return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
  }
  if (progress.phase === 'importing' && progress.totalSessions) {
    return Math.min(100, Math.round((progress.processed / progress.totalSessions) * 100))
  }
  return null
}

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => (
  <div className={clsx(styles.cell, styles.row, className)}>
    <div className={styles.text}>
      <div className={styles.label}>{label}</div>
      <CellText status={status} description={description} />
    </div>
    <div className={styles.cellActions}>{action}</div>
  </div>
)

/** 导入源：本地文件，或原生端的直链（先下载再走同一条导入链路）。 */
type ImportSource = { kind: 'file'; file: File } | { kind: 'url'; url: string }

/** 进度刷新的最小间隔：块之间本来就有 ~1s，这层节流保证不会每条进度都 setState。 */
const PROGRESS_MIN_INTERVAL_MS = 100

/** 链接导入的失败原因：直接展示原因本身（不再套「从链接导入失败：」前缀），关键信息在前半句。 */
const urlErrorStatus = (error: unknown): Status =>
  error instanceof BackupError
    ? { key: error.key, params: error.params, error: true }
    : {
        key: 'historyImportFromUrlFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        error: true,
      }

/**
 * 导入状态：选中来源后先提示覆盖，确认后才真正导入。
 * 链接导入多一段「分阶段进度」：下载（字节/百分比）→ 解析 → 导入 n/总数；
 * 进度节流 100ms，取消后界面上立刻回到可重试状态（下载结果被丢弃，不写任何数据）。
 */
const useHistoryImport = () => {
  const [source, setSource] = useState<ImportSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<UrlImportProgress | null>(null)
  const [trace, setTrace] = useState<ImportTraceEntry[]>([])
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [url, setUrl] = useState('')
  const importing = useRef(false)
  // 取消后仍可能有已发出的下载在跑：用自增的 run 标记作废旧结果，不影响新的一轮导入。
  const run = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const latest = useRef<UrlImportProgress | null>(null)
  const lastEmit = useRef(0)

  /** 节流后的进度写入：阶段变化立即生效，同一阶段最多 100ms 一次。 */
  const emitProgress = (next: UrlImportProgress) => {
    const previous = latest.current
    const phaseChanged = previous === null || previous.phase !== next.phase
    const now = Date.now()
    if (!phaseChanged && now - lastEmit.current < PROGRESS_MIN_INTERVAL_MS) {
      return
    }
    lastEmit.current = now
    latest.current = next
    setProgress(next)
  }

  const resetProgress = () => {
    latest.current = null
    lastEmit.current = 0
    setProgress(null)
  }

  /** 详情只保留最近 100 条；节流在上游（urlImport）做过，这里只做上限与顺序。 */
  const pushTrace = (entry: ImportTraceEntry) => {
    setTrace((previous) => {
      const next = [...previous, entry]
      return next.length > MAX_TRACE_ENTRIES ? next.slice(next.length - MAX_TRACE_ENTRIES) : next
    })
  }

  const finish = (id: number) => {
    if (run.current === id) {
      importing.current = false
      setBusy(false)
      resetProgress()
    }
  }

  const importFile = async (file: File) => {
    try {
      const count = await importHistory(file)
      setStatus({
        target: 'file',
        message: { key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } },
      })
    } catch {
      setStatus({ target: 'file', message: { key: 'historyImportFailed', error: true } })
    }
  }

  /** 下载 + 解析 + 导入；取消后 (signal.aborted) 不提示、不写入。 */
  const importLink = async (link: string) => {
    const controller = new AbortController()
    abort.current = controller
    setTrace([])
    emitProgress({ phase: 'downloading', downloadedBytes: 0 })
    try {
      const count = await importHistoryFromUrl(link, {
        signal: controller.signal,
        onProgress: emitProgress,
        onTrace: pushTrace,
      })
      setSource(null)
      setStatus({
        target: 'url',
        message: { key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } },
      })
    } catch (error) {
      if (controller.signal.aborted || error instanceof UrlImportCancelled) {
        // 取消：不提示失败，界面上什么错误都不留。
        setSource(null)
        resetProgress()
        return
      }
      setSource(null)
      setStatus({ target: 'url', message: urlErrorStatus(error) })
    }
  }

  const confirm = async () => {
    if (!source || importing.current) {
      return
    }
    importing.current = true
    const id = run.current
    setBusy(true)
    setStatus(null)
    try {
      if (source.kind === 'file') {
        setSource(null)
        await importFile(source.file)
      } else {
        await importLink(source.url)
      }
    } finally {
      abort.current = null
      finish(id)
    }
  }

  /** 取消：关闭弹窗并丢弃结果（CapacitorHttp 不能 abort，只能不发新块、不再采用它的返回值）。 */
  const cancel = () => {
    run.current += 1
    importing.current = false
    abort.current?.abort()
    abort.current = null
    resetProgress()
    setBusy(false)
    setSource(null)
  }

  /** 重试：从当前链接重新走一遍完整流程（下载 → 解析 → 导入）。 */
  const retry = () => {
    if (importing.current || url.trim() === '') {
      return
    }
    setStatus(null)
    setSource({ kind: 'url', url })
  }

  return {
    source,
    busy,
    progress,
    trace,
    status,
    url,
    setUrl,
    selectFile: (file: File) => setSource({ kind: 'file', file }),
    selectUrl: () => setSource({ kind: 'url', url }),
    cancel,
    retry,
    confirm,
  }
}

/** 导入 = 覆盖：用选中文件或链接替换本地全部会话与附件。 */
const ImportHistory = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  // 网页端没有原生 HTTP（导出桶无 CORS），不渲染链接入口，只在说明里给出替代做法。
  const native = canImportFromUrl()

  return (
    <>
      <SettingCell
        label={t('historyImport')}
        description={
          native
            ? t('historyImportDescription')
            : `${t('historyImportDescription')} ${t('historyImportUrlWebHint')}`
        }
        status={historyImport.status?.target === 'file' ? historyImport.status.message : null}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={clsx(styles.cellButton, styles.uploadButton)}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('upload')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  historyImport.selectFile(file)
                }
              }}
            />
          </>
        }
      />
      {native ? <ImportHistoryUrl historyImport={historyImport} disabled={disabled} /> : null}
    </>
  )
}

/** 原生专享：粘贴导出链接，由 App 下载 ZIP 后导入。 */
const ImportHistoryUrl = ({
  historyImport,
  disabled,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const blocked = disabled || historyImport.url.trim() === ''
  const status = historyImport.status?.target === 'url' ? historyImport.status.message : null
  const running = historyImport.progress !== null
  return (
    <div className={clsx(styles.cell, styles.row, styles.linkCell)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('historyImportFromUrl')}</div>
        {status?.error ? (
          // 失败原因可能很长（带服务端原文）：换行 + 最多 4 行 + 可展开、可复制。
          <ErrorNotice text={statusText(t, status)} />
        ) : (
          <CellText status={status} description={t('historyImportUrlDescription')} />
        )}
        <ImportTraceDetails entries={historyImport.trace} />
      </div>
      <div className={styles.linkActions}>
        <div className={clsx(styles.apiKeyInput, styles.linkInput)}>
          <input
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('historyImportFromUrl')}
            placeholder={t('historyImportUrlPlaceholder')}
            value={historyImport.url}
            disabled={disabled}
            onChange={(event) => historyImport.setUrl(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !blocked) {
                historyImport.selectUrl()
              }
            }}
          />
        </div>
        {status?.error ? (
          // 失败后不必回设置页重来：点一下就从这个链接重走完整流程。
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.retryButton)}
            disabled={blocked || running}
            onClick={() => historyImport.retry()}
          >
            {t('retry')}
          </Button>
        ) : null}
        <Button
          variant="outlined"
          size="m"
          className={clsx(styles.cellButton, styles.uploadButton)}
          disabled={blocked || running}
          onClick={() => historyImport.selectUrl()}
        >
          {t(running ? 'historyImportUrlDownloading' : 'historyImportUrlStart')}
        </Button>
      </div>
    </div>
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}

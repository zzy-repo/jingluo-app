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
} from '../../services/chat/history/urlImport.js'
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
 * 链接导入在这一步之后还要下载，所以下载期间弹窗不关闭、按钮显示「下载中...」，可随时取消。
 */
const ImportConfirm = ({
  historyImport,
}: {
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const downloading = historyImport.downloading
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
            disabled={downloading}
            onClick={() => void historyImport.confirm()}
          >
            {t(downloading ? 'historyImportUrlDownloading' : 'historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        {t(downloading ? 'historyImportUrlDownloadingHint' : 'historyImportConfirmDescription')}
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

/** 说明文字：有状态就显示状态（失败标红），否则显示静态说明。 */
const CellText = ({ status, description }: { status: Status; description?: string }) => {
  const t = useTranslate()
  if (!status && !description) {
    return null
  }
  return (
    <div className={clsx(styles.description, status?.error && styles.error)}>
      {status
        ? t(status.key, {
            ...status.params,
            ...(status.reason ? { message: t(status.reason, status.params) } : {}),
          })
        : description}
    </div>
  )
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
    {action}
  </div>
)

/** 导入源：本地文件，或原生端的直链（先下载再走同一条导入链路）。 */
type ImportSource = { kind: 'file'; file: File } | { kind: 'url'; url: string }

/**
 * 导入状态：选中来源后先提示覆盖，确认后才真正导入。
 * 链接导入多一段下载：下载期间 modal 保持打开（按钮「下载中...」），取消后丢弃结果、界面立即恢复。
 */
const useHistoryImport = () => {
  const [source, setSource] = useState<ImportSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [url, setUrl] = useState('')
  const importing = useRef(false)
  // 取消后仍可能有已发出的下载在跑：用自增的 run 标记作废旧结果，不影响新的一轮导入。
  const run = useRef(0)
  const abort = useRef<AbortController | null>(null)

  const finish = (id: number) => {
    if (run.current === id) {
      importing.current = false
      setBusy(false)
      setDownloading(false)
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

  /** 下载 + 导入；取消后 (signal.aborted) 不提示、不写入。 */
  const importLink = async (link: string) => {
    const controller = new AbortController()
    abort.current = controller
    setDownloading(true)
    try {
      const count = await importHistoryFromUrl(link, { signal: controller.signal })
      setSource(null)
      setStatus({
        target: 'url',
        message: { key: count === 1 ? 'historyImportedOne' : 'historyImported', params: { count } },
      })
    } catch (error) {
      if (controller.signal.aborted || error instanceof UrlImportCancelled) {
        return
      }
      setSource(null)
      setStatus({ target: 'url', message: errorStatus('historyImportFromUrlFailed', error) })
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

  /** 取消：关闭弹窗并丢弃结果（CapacitorHttp 不能 abort，只能不再采用它的返回值）。 */
  const cancel = () => {
    run.current += 1
    importing.current = false
    abort.current?.abort()
    abort.current = null
    setDownloading(false)
    setBusy(false)
    setSource(null)
  }

  return {
    source,
    busy,
    downloading,
    status,
    url,
    setUrl,
    selectFile: (file: File) => setSource({ kind: 'file', file }),
    selectUrl: () => setSource({ kind: 'url', url }),
    cancel,
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
  return (
    <div className={clsx(styles.cell, styles.row, styles.linkCell)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('historyImportFromUrl')}</div>
        <CellText
          status={historyImport.status?.target === 'url' ? historyImport.status.message : null}
          description={t('historyImportUrlDescription')}
        />
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
        <Button
          variant="outlined"
          size="m"
          className={clsx(styles.cellButton, styles.uploadButton)}
          disabled={blocked}
          onClick={() => historyImport.selectUrl()}
        >
          {t(historyImport.downloading ? 'historyImportUrlDownloading' : 'historyImportUrlStart')}
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

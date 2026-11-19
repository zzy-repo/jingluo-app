import clsx from 'clsx'
import { Capacitor } from '@capacitor/core'
import { saveFeedbackText } from '../../services/diagnostics/save.js'
import { saveFeedbackExport } from '../../services/diagnostics/export.js'
import { clearFeedbackDraft, readFeedbackDraft, writeFeedbackDraft } from '../../services/feedbackDraft.js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_LOG_ENTRIES } from '../../services/diagnostics/config.js'
import {
  buildLogView,
  formatEntryForCopy,
  isFilterActive,
  kindsPresent,
  toggleSelection,
  type LogFamily,
  type LogView,
} from './logView.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  clearDiagnostics,
  getDiagnosticsSnapshot,
  getFeedbackTransportName,
  inspectLogCoverage,
  prepareScreenshot,
  submitFeedback,
  type LogCoverage,
} from '../../services/diagnostics/index.js'
import type {
  EventKind,
  FeedbackCategory,
  FeedbackErrorCode,
  LogEntry,
  LogLevel,
  LogSnapshot,
  ValidationWarning,
} from '../../services/diagnostics/types.js'
import { copyText } from '../../utils/clipboard.js'
import { MOTION_EXIT, usePresence } from '../../utils/usePresence.js'
import { Button } from '../base/Button.js'
import { IconCopyOutline16, IconUploadOutline14 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

/**
 * 「反馈与日志」弹窗：问题描述 + 分类 + 日志预览 + 可选截图，提交后显示工单号。
 * 日志与上传都在 services/diagnostics（采集层 / 上传层分离），这里只负责界面。
 */

/**
 * 日志预览最多渲染的条数。
 *
 * 改前是 20 且不可调（#305）：一次网络失败前后的 `net_request` / `net_response` 很容易被挤出尾部，
 * 用户拿到的「证据」就不完整。现在放宽到 50，并且**口径写死在预览区顶部**（显示最近 N 条 / 共 M 条 /
 * 提交上限 MAX_LOG_ENTRIES），不让用户猜「看到的这 20 行是不是全部」。
 * 真正的提交集合不受这个数字影响（采集层按 500 条 / 30 分钟双限给快照）。
 */
const PREVIEW_LIMIT = 50

/** 级别筛选项（三档固定，不随数据变化） */
const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info']

/** 分组表头文案：族 → i18n key */
const GROUP_LABEL_KEYS: Record<LogFamily, TranslationKey> = {
  chat: 'feedbackLogGroupChat',
  net: 'feedbackLogGroupNet',
  import: 'feedbackLogGroupImport',
  misc: 'feedbackLogGroupMisc',
}

const readInitialSnapshot = (): LogSnapshot => {
  try {
    return getDiagnosticsSnapshot()
  } catch {
    return {
      schemaVersion: 1,
      app: {
        version: typeof __APP_VERSION__ === 'undefined' ? 'unknown' : __APP_VERSION__,
        versionCode: 0,
        buildType: 'unknown',
        platform: 'unknown',
      },
      device: {
        model: 'unknown',
        androidVersion: 'unknown',
        webviewVersion: 'unknown',
        screen: 'unknown',
        locale: 'unknown',
      },
      client: { clientId: '', sessionId: '' },
      logs: [],
    }
  }
}
const readInitialCoverage = (): LogCoverage => {
  try {
    return inspectLogCoverage()
  } catch {
    return { count: 0, spanMs: 0, kinds: [], missing: [], warnings: [], actions: [] }
  }
}

/** 错误码 → 文案 key：区分网络 / 超时 / 体积 / 限流 / 服务端 / 凭证 */
const ERROR_KEYS: Record<FeedbackErrorCode, TranslationKey> = {
  network: 'feedbackErrorNetwork',
  timeout: 'feedbackErrorTimeout',
  too_large: 'feedbackErrorTooLarge',
  unauthorized: 'feedbackErrorUnauthorized',
  rate_limited: 'feedbackErrorRateLimited',
  server: 'feedbackErrorServer',
  rejected: 'feedbackErrorRejected',
  unknown: 'feedbackErrorUnknown',
}

/** 提交前自检提示 → 文案 key */
const WARNING_KEYS: Record<ValidationWarning, TranslationKey> = {
  few_logs: 'feedbackWarningFewLogs',
  no_network: 'feedbackWarningNoNetwork',
  short_span: 'feedbackWarningShortSpan',
}

type Phase =
  | { kind: 'edit' }
  | { kind: 'submitting' }
  | { kind: 'done'; id: string; logSize?: number }
  | { kind: 'failed'; code: FeedbackErrorCode; description: string; at: number }

const categories: { value: FeedbackCategory; label: TranslationKey }[] = [
  { value: 'bug', label: 'feedbackCategoryBug' },
  { value: 'feature', label: 'feedbackCategoryFeature' },
  { value: 'other', label: 'feedbackCategoryOther' },
]

const formatTime = (t: number) => {
  const date = new Date(t)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 时间跨度：不足 1 分钟按秒，其余按「分秒」 */
const formatSpan = (spanMs: number): string => {
  const seconds = Math.round(spanMs / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** 关闭时留 DOM 播退出动画，再卸载（与设置弹窗同一套动效） */
export const FeedbackDialog = ({
  open,
  integrity = false,
  onClose,
}: {
  open: boolean
  /** 从「检查日志完整性」直接打开时，自检面板默认展开 */
  integrity?: boolean
  onClose: () => void
}) => {
  const { mounted, visible } = usePresence(open, MOTION_EXIT.modal)
  return mounted ? <FeedbackForm visible={visible} integrity={integrity} onClose={onClose} /> : null
}

const FeedbackForm = ({
  visible,
  integrity,
  onClose,
}: {
  visible: boolean
  integrity: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  // 草稿回填（Issue #31）：上次点「取消」关掉时留下的内容，这次打开直接带出来
  const [initialDraft] = useState(readFeedbackDraft)
  const [description, setDescription] = useState(initialDraft?.description ?? '')
  const [contact, setContact] = useState(initialDraft?.contact ?? '')
  const [category, setCategory] = useState<FeedbackCategory>(initialDraft?.category ?? 'bug')
  // 打开时取一次快照：预览与提交用同一批日志，用户看到的就是要上传的
  const [snapshot, setSnapshot] = useState<LogSnapshot>(readInitialSnapshot)
  // 提交前自检（条数 / 时间跨度 / 事件类型覆盖 / 缺失项）
  const [coverage, setCoverage] = useState<LogCoverage>(readInitialCoverage)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [integrityOpen, setIntegrityOpen] = useState(integrity)
  /**
   * 日志预览的筛选状态（#305）：只在本地展示层生效，**不影响提交内容**。
   * 打开弹窗时取的那份快照既是预览也是提交来源，所以这里筛选掉的条目照样会被提交。
   */
  const [logQuery, setLogQuery] = useState('')
  const [logKinds, setLogKinds] = useState<EventKind[]>([])
  const [logLevels, setLogLevels] = useState<LogLevel[]>([])
  const [logGrouped, setLogGrouped] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  // 上次带过截图但图片对象没留下来：重开时提示需要重新选择（草稿只保留文本字段）
  const [draftHadScreenshot, setDraftHadScreenshot] = useState(initialDraft?.hadScreenshot === true)
  const [clearDraftConfirm, setClearDraftConfirm] = useState(false)
  const [shotBusy, setShotBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' })
  const [copied, setCopied] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNotice, setExportNotice] = useState('')
  const exportInProgress = useRef(false)

  /**
   * 草稿随输入实时落在内存里（Issue #31）：取消 / Esc / 点遮罩 / 右上角 × 走的都是同一条
   * 卸载路径，只要状态下沉到模块内存，就不必给每个关闭入口都挂一遍「保存」。
   * 提交成功后（phase=done）不再写回：已送达的内容留着会被误以为还没提交。
   */
  useEffect(() => {
    if (phase.kind === 'done') {
      return
    }
    writeFeedbackDraft({
      description,
      contact,
      category,
      hadScreenshot: screenshot !== null || draftHadScreenshot,
    })
  }, [description, contact, category, screenshot, draftHadScreenshot, phase.kind])

  const onExport = async () => {
    if (exportInProgress.current) {
      return
    }
    exportInProgress.current = true
    setExportBusy(true)
    setExportNotice('')
    try {
      const result = await saveFeedbackExport(
        snapshot,
        {
          category,
          ...(phase.kind === 'failed' ? { failure: { code: phase.code, at: phase.at } } : {}),
        },
        saveFeedbackText
      )
      if (result.status === 'saved') {
        setExportNotice(
          [
            t(
              Capacitor.isNativePlatform() ? 'feedbackExportNativeSaved' : 'feedbackExportWebSaved',
              { filename: result.filename }
            ),
            result.snapshotReadFailed ? t('feedbackExportReadFailed') : '',
            result.truncated ? t('feedbackExportTruncated') : '',
          ]
            .filter(Boolean)
            .join(' ')
        )
      } else {
        setExportNotice(
          t(result.status === 'cancelled' ? 'feedbackExportCancelled' : 'feedbackExportFailed')
        )
      }
    } finally {
      setExportBusy(false)
      exportInProgress.current = false
    }
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  const total = snapshot.logs.length
  /**
   * 预览视图：过滤 → 取最近 PREVIEW_LIMIT 条 → 分组。
   * 「显示最近 N 条，共 M 条」里的 N 就是这里的 shownCount，保证文案与真实行数永远一致。
   */
  const logView: LogView = useMemo(
    () =>
      buildLogView(
        snapshot.logs,
        { kinds: logKinds, levels: logLevels, query: logQuery },
        PREVIEW_LIMIT
      ),
    [snapshot.logs, logKinds, logLevels, logQuery]
  )
  /** 类型筛选只列当前缓冲区真实出现过的 kind（21 个全列出来只会是一排永远命中 0 的按钮） */
  const kindOptions = useMemo(() => kindsPresent(snapshot.logs), [snapshot.logs])
  const filterActive = isFilterActive({ kinds: logKinds, levels: logLevels, query: logQuery })
  const clearLogFilter = () => {
    setLogQuery('')
    setLogKinds([])
    setLogLevels([])
  }
  const transportName = getFeedbackTransportName()
  const canSubmit = description.trim() !== '' && phase.kind !== 'submitting'
  /** 有没有可清空的草稿内容（决定「清空已填内容」按钮是否可点） */
  const draftDirty = description.trim() !== '' || contact.trim() !== '' || screenshot !== null

  const refresh = () => {
    // A failed refresh must not replace the existing preview with empty logs.
    try {
      const nextSnapshot = getDiagnosticsSnapshot()
      const nextCoverage = inspectLogCoverage()
      setSnapshot(nextSnapshot)
      setCoverage(nextCoverage)
    } catch {
      setExportNotice(t('feedbackExportReadFailed'))
    }
  }

  const onPickScreenshot = async (file: File) => {
    setShotBusy(true)
    try {
      setScreenshot(await prepareScreenshot(file))
      setDraftHadScreenshot(false)
    } catch {
      showToast({ key: 'feedbackScreenshotFailed', type: 'error' })
    } finally {
      setShotBusy(false)
    }
  }

  const onSubmit = async () => {
    if (submitting.current || description.trim() === '') {
      if (description.trim() === '') {
        showToast({ key: 'feedbackDescriptionRequired', type: 'error' })
      }
      return
    }
    submitting.current = true
    setPhase({ kind: 'submitting' })
    try {
      const result = await submitFeedback({
        description,
        category,
        contact,
        ...(screenshot ? { screenshot } : {}),
      })
      if (result.ok) {
        // 已送达：草稿作废，别再回填（否则用户会以为没提交成功）
        clearFeedbackDraft()
        setDraftHadScreenshot(false)
        setPhase({
          kind: 'done',
          id: result.id,
          ...(typeof result.logSize === 'number' ? { logSize: result.logSize } : {}),
        })
        refresh()
      } else {
        setPhase({
          kind: 'failed',
          code: result.error,
          description: result.message,
          at: Date.now(),
        })
        refresh()
      }
    } catch {
      setPhase({
        kind: 'failed',
        code: 'unknown',
        description: t('feedbackErrorUnknown'),
        at: Date.now(),
      })
      refresh()
    } finally {
      submitting.current = false
    }
  }

  const onClearLogs = async () => {
    await clearDiagnostics()
    refresh()
    setPreviewOpen(false)
    showToast({ key: 'feedbackLogsCleared' })
  }

  /** 主动丢弃草稿：清表单 + 清内存，下次打开是空白表单（二次确认后才走到这里） */
  const onClearDraft = () => {
    clearFeedbackDraft()
    setDescription('')
    setContact('')
    setCategory('bug')
    setScreenshot(null)
    setDraftHadScreenshot(false)
    setClearDraftConfirm(false)
    showToast({ key: 'feedbackDraftCleared' })
  }

  const copyTicket = async (id: string) => {
    const ok = await copyText(id)
    setCopied(ok)
    if (ok) {
      showToast({ key: 'copied' })
    } else {
      showToast({ key: 'copyFailed', type: 'error' })
    }
  }

  /**
   * 复制单条日志：正文 + **完整 meta**（时间到毫秒，能和服务端日志对齐）。
   * 只有时间 + msg 的「复制」等于让用户抄一句人话，meta 里的 `requestId` / `http.status` 才是能对上号的证据。
   */
  const copyLogEntry = async (entry: LogEntry) => {
    const ok = await copyText(formatEntryForCopy(entry))
    showToast(ok ? { key: 'feedbackLogCopied' } : { key: 'copyFailed', type: 'error' })
  }

  /** 一行的渲染：时间 / kind / level / msg + 单条复制（触控目标 44px，见 Settings.module.css） */
  const renderLogRow = (entry: LogEntry, key: string) => (
    <li key={key} className={styles.feedbackLogRow} data-testid="log-row">
      <span className={styles.feedbackLogTime}>{formatTime(entry.t)}</span>
      <span className={styles.feedbackLogKind}>{entry.kind}</span>
      <span
        className={clsx(
          styles.feedbackLogLevel,
          entry.level === 'error' && styles.error,
          entry.level === 'warn' && styles.feedbackLogLevelWarn
        )}
      >
        {entry.level}
      </span>
      <span className={styles.feedbackLogMsg}>{entry.msg}</span>
      <button
        type="button"
        className={styles.feedbackLogCopy}
        data-testid="log-copy"
        aria-label={t('feedbackLogCopyEntry')}
        title={t('feedbackLogCopyEntry')}
        onClick={() => void copyLogEntry(entry)}
      >
        <IconCopyOutline16 />
      </button>
    </li>
  )

  const missingText =
    coverage.missing.length === 0 ? t('feedbackIntegrityNone') : coverage.missing.join(', ')

  return (
    <Modal
      title={t('feedbackDialogTitle')}
      closable
      visible={visible}
      className={styles.feedbackDialog}
      mainClassName={styles.feedbackMain}
      onClose={phase.kind === 'submitting' ? () => undefined : onClose}
      footer={
        <div className={styles.feedbackFooterColumn}>
          {phase.kind === 'done' ? (
            <div className={styles.feedbackFooter}>
              <Button variant="primary" onClick={onClose}>
                {t('feedbackDone')}
              </Button>
            </div>
          ) : (
            <div className={styles.feedbackFooter}>
              <Button variant="outlined" disabled={phase.kind === 'submitting'} onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button variant="primary" disabled={!canSubmit} onClick={() => void onSubmit()}>
                {t(phase.kind === 'submitting' ? 'feedbackSubmitting' : 'feedbackSubmit')}
              </Button>
            </div>
          )}
        </div>
      }
    >
      <div className={styles.feedbackBody}>
        {phase.kind === 'done' ? (
          <div className={styles.feedbackTicket} role="status">
            <div className={styles.feedbackTicketText}>
              <div className={styles.feedbackTicketLine}>
                <span className={styles.feedbackHint}>{t('feedbackTicketLabel')}</span>
                <code className={styles.feedbackTicketId}>{phase.id}</code>
                {typeof phase.logSize === 'number' ? (
                  <span className={styles.feedbackHint}>
                    {t('feedbackTicketLogSize', { size: `${Math.round(phase.logSize / 1024)}KB` })}
                  </span>
                ) : null}
              </div>
            </div>
            <Button variant="outlined" size="m" onClick={() => void copyTicket(phase.id)}>
              <IconCopyOutline16 />
              {t(copied ? 'copied' : 'copy')}
            </Button>
          </div>
        ) : null}

        {phase.kind === 'failed' ? (
          <div className={clsx(styles.error, styles.feedbackStatus)} role="alert">
            {t(ERROR_KEYS[phase.code])}
            {phase.description && phase.description !== t(ERROR_KEYS[phase.code])
              ? `（${phase.description}）`
              : ''}
          </div>
        ) : null}

        <section className={styles.feedbackField} aria-label={t('feedbackExport')}>
          <div className={styles.feedbackLabel}>{t('feedbackExport')}</div>
          <div className={styles.feedbackHint}>{t('feedbackExportHint')}</div>
          <Button variant="outlined" disabled={exportBusy} onClick={() => void onExport()}>
            {t(exportBusy ? 'feedbackExportBusy' : 'feedbackSaveFile')}
          </Button>
          {exportNotice ? (
            <div className={styles.feedbackHint} role="status">
              {exportNotice}
            </div>
          ) : null}
        </section>

        <div className={styles.feedbackField}>
          <label className={styles.feedbackLabel} htmlFor="feedback-description">
            {t('feedbackDescriptionLabel')}
            <span className={styles.feedbackRequired}>*</span>
          </label>
          <textarea
            id="feedback-description"
            className={styles.feedbackTextarea}
            rows={5}
            maxLength={1000}
            placeholder={t('feedbackDescriptionPlaceholder')}
            value={description}
            disabled={phase.kind === 'submitting'}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          {initialDraft && phase.kind !== 'done' ? (
            <div className={styles.feedbackHint} data-testid="feedback-draft-restored">
              {t('feedbackDraftRestored')}
            </div>
          ) : null}
        </div>

        {/* 联系方式：后端会把回复发到这里，可选 */}
        <div className={styles.feedbackField}>
          <label className={styles.feedbackLabel} htmlFor="feedback-contact">
            {t('feedbackContactLabel')}
          </label>
          <input
            id="feedback-contact"
            className={styles.feedbackInput}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            placeholder={t('feedbackContactPlaceholder')}
            value={contact}
            disabled={phase.kind === 'submitting'}
            onChange={(event) => setContact(event.currentTarget.value)}
          />
        </div>

        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{t('feedbackCategoryLabel')}</div>
          </div>
          <Select
            ariaLabel={t('feedbackCategoryLabel')}
            value={category}
            options={categories.map((item) => ({ value: item.value, label: t(item.label) }))}
            onChange={setCategory}
            disabled={phase.kind === 'submitting'}
          />
        </div>

        <div className={styles.feedbackField}>
          <button
            type="button"
            className={styles.feedbackPreviewToggle}
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((open) => !open)}
          >
            <span>{t('feedbackLogPreview')}</span>
            <span className={styles.feedbackHint}>{t('feedbackLogCount', { count: total })}</span>
          </button>
          {previewOpen ? (
            <div className={styles.feedbackLogViewer} data-testid="log-viewer">
              {/* 口径：预览条数 / 总条数 / 提交上限三者写死在一行里，别让用户猜「看到的是不是全部」 */}
              <div className={styles.feedbackHint} data-testid="log-summary">
                {t('feedbackLogSummary', {
                  shown: logView.shownCount,
                  total: logView.total,
                  limit: MAX_LOG_ENTRIES,
                })}
              </div>
              {logView.total > 0 ? (
                <div className={styles.feedbackLogToolbar}>
                  <input
                    type="search"
                    className={styles.feedbackLogSearch}
                    data-testid="log-search"
                    aria-label={t('feedbackLogSearchLabel')}
                    placeholder={t('feedbackLogSearchPlaceholder')}
                    value={logQuery}
                    // 上限 200：够长到能贴一个 requestId，又不至于让人以为自己在编辑日志
                    maxLength={200}
                    onChange={(event) => setLogQuery(event.currentTarget.value)}
                  />
                  <div
                    className={styles.feedbackLogChipRow}
                    data-testid="log-level-filter"
                    role="group"
                    aria-label={t('feedbackLogFilterLevel')}
                  >
                    {LOG_LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={clsx(
                          styles.feedbackLogChip,
                          logLevels.includes(level) && styles.feedbackLogChipOn
                        )}
                        data-level={level}
                        aria-pressed={logLevels.includes(level)}
                        onClick={() => setLogLevels(toggleSelection(logLevels, level))}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                  <div
                    className={styles.feedbackLogChipRow}
                    data-testid="log-kind-filter"
                    role="group"
                    aria-label={t('feedbackLogFilterKind')}
                  >
                    {kindOptions.map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={clsx(
                          styles.feedbackLogChip,
                          logKinds.includes(kind) && styles.feedbackLogChipOn
                        )}
                        data-kind={kind}
                        aria-pressed={logKinds.includes(kind)}
                        onClick={() => setLogKinds(toggleSelection(logKinds, kind))}
                      >
                        {kind}
                      </button>
                    ))}
                  </div>
                  <div className={styles.feedbackLogToolbarRow}>
                    <label className={styles.feedbackLogGroupToggle}>
                      <input
                        type="checkbox"
                        data-testid="log-group-toggle"
                        checked={logGrouped}
                        onChange={(event) => setLogGrouped(event.currentTarget.checked)}
                      />
                      <span>{t('feedbackLogGroupToggle')}</span>
                    </label>
                    {filterActive ? (
                      <Button variant="outlined" size="m" onClick={clearLogFilter}>
                        {t('feedbackLogFilterClear')}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {logGrouped ? (
                <div className={styles.feedbackHint} data-testid="log-group-note">
                  {t('feedbackLogGroupNote')}
                </div>
              ) : null}
              {logView.total === 0 ? (
                <div className={styles.feedbackHint} data-testid="log-empty">
                  {t('feedbackLogEmpty')}
                </div>
              ) : logView.matchedCount === 0 ? (
                <div className={styles.feedbackHint} data-testid="log-nomatch">
                  {t('feedbackLogNoMatch')}
                </div>
              ) : (
                <ol className={styles.feedbackLogs} data-testid="log-list">
                  {logGrouped
                    ? logView.groups.map((group) => (
                        <li
                          key={group.key}
                          className={styles.feedbackLogGroup}
                          data-testid="log-group"
                          data-family={group.family}
                        >
                          <div className={styles.feedbackLogGroupHeader}>
                            <span>{t(GROUP_LABEL_KEYS[group.family])}</span>
                            <span>
                              {t('feedbackLogGroupCount', { count: group.items.length })}
                            </span>
                          </div>
                          <ol className={styles.feedbackLogGroupItems}>
                            {group.items.map((entry, index) =>
                              renderLogRow(entry, `${group.key}-${index}`)
                            )}
                          </ol>
                        </li>
                      ))
                    : logView.entries.map((entry, index) =>
                        renderLogRow(entry, `${entry.t}-${index}`)
                      )}
                </ol>
              )}
              {logView.truncated ? (
                <div className={styles.feedbackHint} data-testid="log-truncated">
                  {t('feedbackLogTruncated', {
                    matched: logView.matchedCount,
                    shown: logView.shownCount,
                  })}
                </div>
              ) : null}
              {logView.total > 0 && logView.total < 5 ? (
                <div className={styles.feedbackHint} data-testid="log-few">
                  {t('feedbackLogFew', { count: logView.total })}
                </div>
              ) : null}
              <div className={styles.feedbackHint}>{t('feedbackLogPreviewHint')}</div>
            </div>
          ) : null}
        </div>

        {/* 日志完整性自检：用户反馈前可以先自己看一眼「日志有没有覆盖到关键证据」 */}
        <div className={styles.feedbackField}>
          <button
            type="button"
            className={styles.feedbackPreviewToggle}
            aria-expanded={integrityOpen}
            onClick={() => {
              setIntegrityOpen((open) => !open)
              refresh()
            }}
          >
            <span>{t('feedbackIntegrityCheck')}</span>
            <span className={styles.feedbackHint}>{t('feedbackLogCount', { count: total })}</span>
          </button>
          {integrityOpen ? (
            <div className={styles.feedbackIntegrity} data-testid="feedback-integrity">
              <div className={styles.feedbackHint}>{t('feedbackIntegrityTitle')}</div>
              <div>{t('feedbackIntegrityCount', { count: coverage.count })}</div>
              <div>{t('feedbackIntegritySpan', { span: formatSpan(coverage.spanMs) })}</div>
              <div>
                {t('feedbackIntegrityKinds', { count: coverage.kinds.length })}
                {coverage.kinds.length > 0
                  ? `　${t('feedbackIntegrityKindList', { kinds: coverage.kinds.join(', ') })}`
                  : ''}
              </div>
              <div>{t('feedbackIntegrityMissing', { kinds: missingText })}</div>
              <div>{t('feedbackActionsLabel', { actions: coverage.actions.length })}</div>
            </div>
          ) : null}
        </div>

        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{t('feedbackScreenshot')}</div>
            {screenshot ? (
              <div className={styles.feedbackHint}>{t('feedbackScreenshotReady')}</div>
            ) : null}
            {!screenshot && draftHadScreenshot ? (
              <div className={styles.feedbackHint} data-testid="feedback-draft-screenshot-hint">
                {t('feedbackDraftScreenshotHint')}
              </div>
            ) : null}
          </div>
          {screenshot ? (
            <img className={styles.feedbackShotPreview} src={screenshot} alt="" />
          ) : null}
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={shotBusy || phase.kind === 'submitting'}
            onClick={() => fileRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t('feedbackScreenshotPick')}
          </Button>
          {screenshot ? (
            <Button
              variant="dangerOutlined"
              size="m"
              className={styles.cellButton}
              disabled={shotBusy || phase.kind === 'submitting'}
              onClick={() => setScreenshot(null)}
            >
              {t('feedbackScreenshotRemove')}
            </Button>
          ) : null}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              event.currentTarget.value = ''
              if (file) {
                void onPickScreenshot(file)
              }
            }}
          />
        </div>

        <div className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{t('feedbackClearLogs')}</div>
            <div className={styles.feedbackHint}>
              {t('feedbackTransport', { name: transportName })}
            </div>
          </div>
          <Button
            variant="dangerOutlined"
            size="m"
            className={styles.cellButton}
            disabled={phase.kind === 'submitting' || total === 0}
            onClick={() => void onClearLogs()}
          >
            {t('feedbackClearLogs')}
          </Button>
        </div>

        {/* 草稿（描述 / 联系方式 / 截图）取消后不丢，所以给一个明确的丢弃入口，二次确认 */}
        {phase.kind !== 'done' ? (
          <div className={clsx(styles.cell, styles.row)}>
            <div className={styles.text}>
              <div className={styles.label}>{t('feedbackDraftClear')}</div>
              <div className={styles.feedbackHint}>
                {clearDraftConfirm ? t('feedbackDraftClearConfirm') : t('feedbackDraftClearHint')}
              </div>
            </div>
            {clearDraftConfirm ? (
              <>
                <Button
                  variant="outlined"
                  size="m"
                  className={styles.cellButton}
                  onClick={() => setClearDraftConfirm(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  variant="dangerOutlined"
                  size="m"
                  className={styles.cellButton}
                  onClick={onClearDraft}
                >
                  {t('confirm')}
                </Button>
              </>
            ) : (
              <Button
                variant="dangerOutlined"
                size="m"
                className={styles.cellButton}
                disabled={phase.kind === 'submitting' || !draftDirty}
                onClick={() => setClearDraftConfirm(true)}
              >
                {t('feedbackDraftClear')}
              </Button>
            )}
          </div>
        ) : null}
        {phase.kind !== 'done' && coverage.warnings.length > 0 ? (
          <div className={styles.feedbackWarnings} role="note">
            <div className={styles.feedbackHint}>{t('feedbackWarningsTitle')}</div>
            <ul>
              {coverage.warnings.map((warning) => (
                <li key={warning}>{t(WARNING_KEYS[warning])}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}

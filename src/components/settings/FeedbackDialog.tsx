import clsx from 'clsx'
import { Capacitor } from '@capacitor/core'
import { saveFeedbackText } from '../../services/diagnostics/save.js'
import { saveFeedbackExport } from '../../services/diagnostics/export.js'
import { useRef, useState } from 'react'
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
  FeedbackCategory,
  FeedbackErrorCode,
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

/** 日志预览最多显示的条数（实际提交的是最近 500 条 / 30 分钟，见 collector.ts） */
const PREVIEW_LIMIT = 20

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
  const [description, setDescription] = useState('')
  const [contact, setContact] = useState('')
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  // 打开时取一次快照：预览与提交用同一批日志，用户看到的就是要上传的
  const [snapshot, setSnapshot] = useState<LogSnapshot>(readInitialSnapshot)
  // 提交前自检（条数 / 时间跨度 / 事件类型覆盖 / 缺失项）
  const [coverage, setCoverage] = useState<LogCoverage>(readInitialCoverage)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [integrityOpen, setIntegrityOpen] = useState(integrity)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [shotBusy, setShotBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'edit' })
  const [copied, setCopied] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [exportNotice, setExportNotice] = useState('')
  const exportInProgress = useRef(false)

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
  const preview = total > PREVIEW_LIMIT ? snapshot.logs.slice(-PREVIEW_LIMIT) : snapshot.logs
  const transportName = getFeedbackTransportName()
  const canSubmit = description.trim() !== '' && phase.kind !== 'submitting'

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

  const copyTicket = async (id: string) => {
    const ok = await copyText(id)
    setCopied(ok)
    if (ok) {
      showToast({ key: 'copied' })
    } else {
      showToast({ key: 'copyFailed', type: 'error' })
    }
  }

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
            <>
              {preview.length === 0 ? (
                <div className={styles.feedbackHint}>{t('feedbackLogEmpty')}</div>
              ) : (
                <ol className={styles.feedbackLogs}>
                  {preview.map((entry, index) => (
                    <li key={`${entry.t}-${index}`} className={styles.feedbackLogRow}>
                      <span className={styles.feedbackLogTime}>{formatTime(entry.t)}</span>
                      <span className={styles.feedbackLogKind}>{entry.kind}</span>
                      <span
                        className={clsx(
                          styles.feedbackLogLevel,
                          entry.level === 'error' && styles.error
                        )}
                      >
                        {entry.level}
                      </span>
                      <span className={styles.feedbackLogMsg}>{entry.msg}</span>
                    </li>
                  ))}
                </ol>
              )}
              <div className={styles.feedbackHint}>{t('feedbackLogPreviewHint')}</div>
            </>
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

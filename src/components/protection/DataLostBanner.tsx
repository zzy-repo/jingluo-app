import { Capacitor } from '@capacitor/core'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { dismissDataLost, restoreFromSnapshot, useChatStore } from '../../services/chat/store.js'
import { getDiagnosticsSnapshot } from '../../services/diagnostics/index.js'
import { saveFeedbackExport } from '../../services/diagnostics/export.js'
import { saveFeedbackText } from '../../services/diagnostics/save.js'
import {
  protectionCheckAtStartup,
  protectionListRestorable,
  type RestorableSnapshot,
  type RestoreProgress,
  type RestoreResult,
} from '../../services/protection/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'

type Phase =
  | { step: 'list' }
  | { step: 'confirm'; snapshot: RestorableSnapshot }
  | { step: 'running'; progress: RestoreProgress | null }

/**
 * #909：启动时判定「本机库从有到无」后的横幅，也是「从快照恢复」的入口。
 * 它出现时欢迎页下面**不能**装作什么都没发生：dataLost 非空期间一直在，直到用户确认或恢复成功。
 * 流程：列出快照（时间 + 会话数）→ 选一份 → 明示后果并确认 → 进度（可取消）→ 结果。
 * 恢复本身走整包替换通道，失败 / 取消都不改动现有数据。
 *
 * 场景 7（迁移后异常）补齐的两个只读入口：
 *  · 「重新检测」：再走一次启动检测（`protectionCheckAtStartup`）。它被 `guarded()` 包着，
 *    读失败时返回 `null`，而「真的没丢数据」也返回 `null` —— 两者**不可混为一谈**，
 *    这里一律按「检测不出来」处理（横幅不消失、不动任何数据、提示用户走反馈），
 *    绝不把 `null` 当成「没问题」。
 *  · 「问题反馈」：走已有的脱敏诊断**离线导出**通道（`saveFeedbackExport` + `saveFeedbackText`），
 *    不新建上报通道、不上传；导出失败 / 取消同样只提示，不改动数据。
 * 红线：恢复按钮的可用条件仍是 `snapshot.valid`（下方 `usable`），一个字符都没放松。
 */
export const DataLostBanner = ({ className }: { className?: string }) => {
  const t = useTranslate()
  const dataLost = useChatStore((state) => state.dataLost)
  const [snapshots, setSnapshots] = useState<RestorableSnapshot[] | null>(null)
  const [phase, setPhase] = useState<Phase>({ step: 'list' })
  const [notice, setNotice] = useState<string | null>(null)
  const [controller, setController] = useState<AbortController | null>(null)
  const [busy, setBusy] = useState<'recheck' | 'feedback' | null>(null)
  const lost = dataLost !== null

  useEffect(() => {
    if (!lost) {
      return
    }
    let cancelled = false
    void protectionListRestorable().then((list) => {
      if (!cancelled) {
        setSnapshots(list)
      }
    })
    return () => {
      cancelled = true
    }
  }, [lost])

  if (dataLost === null) {
    return null
  }

  const resultKey = (result: RestoreResult) => {
    switch (result.status) {
      case 'cancelled':
        return 'dataLostRestoreCancelled'
      case 'corrupt':
        return 'dataLostRestoreCorrupt'
      case 'incompatible':
        return 'dataLostRestoreIncompatible'
      case 'backup-failed':
        return 'dataLostRestoreBackupFailed'
      default:
        return 'dataLostRestoreFailed'
    }
  }

  const run = async (snapshot: RestorableSnapshot) => {
    const abort = new AbortController()
    setController(abort)
    setNotice(null)
    setPhase({ step: 'running', progress: null })
    const result = await restoreFromSnapshot(snapshot.name, {
      signal: abort.signal,
      onProgress: (progress) => setPhase({ step: 'running', progress }),
    })
    setController(null)
    setPhase({ step: 'list' })
    if (result.status === 'restored') {
      // store 在整包替换提交后已清掉 dataLost，横幅随之消失
      showToast(t('dataLostRestored', { count: result.sessions }))
      return
    }
    setNotice(t(resultKey(result)))
  }

  /**
   * 重新检测：再走一次启动检测（`checkAtStartup` 现成入口，不新写判定逻辑）。
   *
   * `protectionCheckAtStartup()` 内部是被 `guarded()` 包着的 `checkAtStartup()`：**读失败返回 `null`**，
   * 而「确实没丢数据」也返回 `null` —— 返回值上分不开。横幅还在 = 之前已判定过丢失，所以这里
   * 把 `null` 一律当「检测不出来」：横幅不消失、`dataLost` 不清、任何数据都不动，只如实提示用户走反馈。
   * 只有拿到非 null 的判定，才说「仍检测到数据缺失」。
   */
  const recheck = async () => {
    if (busy !== null) {
      return
    }
    setBusy('recheck')
    setNotice(null)
    try {
      const found = await protectionCheckAtStartup()
      // 顺手刷新快照列表：恢复入口可不可用仍然只由 `snapshot.valid` 决定，这里只是让它反映当下。
      // 列不出来就保持原样——刷新失败绝不放宽恢复条件（`valid` 依旧来自逐份校验）。
      try {
        setSnapshots(await protectionListRestorable())
      } catch {
        // 保持上一次列出的结果
      }
      setNotice(
        found === null
          ? t('dataLostRecheckUnknown')
          : t('dataLostRecheckStillLost', { count: found.expectedSessions })
      )
    } finally {
      setBusy(null)
    }
  }

  /**
   * 问题反馈：走已有的「反馈与日志」脱敏诊断**离线导出**通道（本机保存 JSON，不上传、不新建通道）。
   * 成功 / 取消 / 失败都只落到横幅的一行提示上，不改动任何本机数据。
   */
  const sendFeedback = async () => {
    if (busy !== null) {
      return
    }
    setBusy('feedback')
    setNotice(null)
    try {
      const result = await saveFeedbackExport(
        getDiagnosticsSnapshot(),
        { category: 'bug' },
        saveFeedbackText
      )
      if (result.status === 'saved') {
        setNotice(
          t(
            Capacitor.isNativePlatform() ? 'feedbackExportNativeSaved' : 'feedbackExportWebSaved',
            { filename: result.filename }
          )
        )
      } else {
        setNotice(t(result.status === 'cancelled' ? 'feedbackExportCancelled' : 'feedbackExportFailed'))
      }
    } catch {
      setNotice(t('feedbackExportFailed'))
    } finally {
      setBusy(null)
    }
  }

  const usable = (snapshots ?? []).filter((snapshot) => snapshot.valid)
  const column = { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', flexBasis: '100%' } as const
  const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', marginTop: 8 } as const
  const gap = { marginLeft: 8 } as const

  return (
    <div className={className} role="alert" data-testid="data-lost-banner">
      <div style={column}>
        <strong>{t('dataLostTitle', { count: dataLost.expectedSessions })}</strong>
        {snapshots !== null && usable.length === 0 ? <span>{t('dataLostNoSnapshot')}</span> : null}
        {notice !== null ? <span role="status">{notice}</span> : null}

        {phase.step === 'list' && snapshots !== null && snapshots.length > 0 ? (
          <>
            <span style={{ marginTop: 8 }}>{t('dataLostRestoreHeading')}</span>
            {snapshots.map((snapshot) => {
              const time = new Date(snapshot.at).toLocaleString()
              return (
                <div key={snapshot.name} style={row} data-testid="data-lost-snapshot">
                  <span>
                    {snapshot.valid
                      ? t('dataLostSnapshotRow', { time, count: snapshot.sessions ?? 0 })
                      : t('dataLostSnapshotBroken', { time })}
                  </span>
                  {snapshot.valid ? (
                    <span style={gap}>
                      <Button variant="outlined" size="s" onClick={() => setPhase({ step: 'confirm', snapshot })}>
                        {t('dataLostRestore')}
                      </Button>
                    </span>
                  ) : null}
                </div>
              )
            })}
          </>
        ) : null}

        {phase.step === 'confirm' ? (
          <>
            <span style={{ marginTop: 8 }}>{t('dataLostConfirm')}</span>
            <div style={row}>
              <Button variant="primary" size="s" onClick={() => void run(phase.snapshot)}>
                {t('dataLostConfirmYes')}
              </Button>
              <span style={gap}>
                <Button variant="outlined" size="s" onClick={() => setPhase({ step: 'list' })}>
                  {t('cancel')}
                </Button>
              </span>
            </div>
          </>
        ) : null}

        {phase.step === 'running' ? (
          <div style={row} role="status">
            <span>
              {t('dataLostRestoring', {
                done: phase.progress?.done ?? 0,
                total: phase.progress?.total ?? 0,
              })}
            </span>
            <span style={gap}>
              <Button variant="outlined" size="s" onClick={() => controller?.abort()}>
                {t('cancel')}
              </Button>
            </span>
          </div>
        ) : null}

        {phase.step === 'list' ? (
          <div style={row}>
            <Button
              variant="outlined"
              size="s"
              disabled={busy !== null}
              data-testid="data-lost-recheck"
              onClick={() => void recheck()}
            >
              {t('dataLostRecheck')}
            </Button>
            <span style={gap}>
              <Button
                variant="outlined"
                size="s"
                disabled={busy !== null}
                data-testid="data-lost-feedback"
                onClick={() => void sendFeedback()}
              >
                {t('dataLostFeedback')}
              </Button>
            </span>
            <span style={gap}>
              <Button variant="outlined" size="s" onClick={() => void dismissDataLost()}>
                {t('dataLostDismiss')}
              </Button>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

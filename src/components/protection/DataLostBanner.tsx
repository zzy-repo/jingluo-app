import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { dismissDataLost, restoreFromSnapshot, useChatStore } from '../../services/chat/store.js'
import {
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
 */
export const DataLostBanner = ({ className }: { className?: string }) => {
  const t = useTranslate()
  const dataLost = useChatStore((state) => state.dataLost)
  const [snapshots, setSnapshots] = useState<RestorableSnapshot[] | null>(null)
  const [phase, setPhase] = useState<Phase>({ step: 'list' })
  const [notice, setNotice] = useState<string | null>(null)
  const [controller, setController] = useState<AbortController | null>(null)
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
            <Button variant="outlined" size="s" onClick={() => void dismissDataLost()}>
              {t('dataLostDismiss')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { copyText } from '../../utils/clipboard.js'
import { mbOf } from '../../services/limits.js'
import {
  continueWithLegacy,
  ensureStorageReady,
  getGateView,
  retryMigration,
  subscribeGate,
  type GateView,
} from '../../services/storage/gate.js'
import styles from './MigrationGate.module.css'

/**
 * 启动闸门的迁移页（#916 / #910 D1）。放在 `<App/>` 之外：闸门 `ready` 之前 App 不挂载，
 * 因此 store 第一次读库一定发生在真源确定之后。
 *
 *  - `checking`：什么都不画（一次异步判定，没有注册迁移运行时时是同一个微任务内结束）。
 *  - `migrating`：阻塞页 + 阶段 + 百分比（+ 超过警告线时的体积与空间提示）。
 *  - `failed`：明确原因，「重试 / 继续使用（原数据未丢失）」。
 *  - `blocked`：明确说明 + 重载 / 复制诊断信息；**绝不**落到空白欢迎页。
 */
export const MigrationGate = ({ children }: { children: ReactNode }) => {
  const view = useSyncExternalStore(subscribeGate, getGateView, getGateView)
  useEffect(() => {
    void ensureStorageReady()
  }, [])
  if (view.kind === 'ready') {
    return <>{children}</>
  }
  if (view.kind === 'checking') {
    return null
  }
  return (
    <MigrationView
      view={view}
      onRetry={() => void retryMigration()}
      onContinue={() => void continueWithLegacy()}
    />
  )
}

const PHASE_KEY: Record<string, TranslationKey> = {
  idle: 'storageMigrationPhasePreflight',
  preflight: 'storageMigrationPhasePreflight',
  'backing-up': 'storageMigrationPhaseBackup',
  'backup-verified': 'storageMigrationPhaseBackup',
  copying: 'storageMigrationPhaseCopy',
  verifying: 'storageMigrationPhaseVerify',
  verified: 'storageMigrationPhaseCommit',
  committed: 'storageMigrationPhaseCommit',
}

type Visible = Exclude<GateView, { kind: 'ready' } | { kind: 'checking' }>

/** 纯展示（便于截图与测试直接喂视图状态）。 */
export const MigrationView = ({
  view,
  onRetry,
  onContinue,
}: {
  view: Visible
  onRetry: () => void
  onContinue: () => void
}) => {
  const t = useTranslate()
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')

  const onCopy = async () => {
    const detail = view.kind === 'blocked' ? `${view.reason}${view.detail ? `: ${view.detail}` : ''}` : view.kind
    const ok = await copyText(`storage-gate: ${detail}`)
    setCopy(ok ? 'done' : 'failed')
  }

  if (view.kind === 'migrating') {
    const hint = view.preflight?.warn
      ? t('storageMigrationSizeHint', {
          size: mbOf(view.preflight.estimateBytes),
          need: mbOf(view.preflight.requiredBytes),
        })
      : undefined
    return (
      <div className={styles.screen} role="status" aria-live="polite" data-testid="migration-gate-migrating">
        <div className={styles.card}>
          <div className={styles.title}>{t('storageMigrationTitle')}</div>
          <div className={styles.description}>{t('storageMigrationDescription')}</div>
          <div className={styles.phase}>{t(PHASE_KEY[view.phase] ?? 'storageMigrationPhaseCopy')}</div>
          <div
            className={styles.track}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.percent}
          >
            <div className={styles.bar} style={{ transform: `scaleX(${view.percent / 100})` }} />
          </div>
          <div className={styles.percent} data-testid="migration-gate-percent">
            {t('storageMigrationPercent', { percent: view.percent })}
          </div>
          {hint !== undefined && <div className={styles.hint}>{hint}</div>}
        </div>
      </div>
    )
  }

  if (view.kind === 'failed') {
    const code = view.failure.code
    const reason =
      code === 'insufficient-space'
        ? t('storageMigrationFailSpace')
        : code === 'unsupported' && view.failure.message.startsWith('source-too-large')
          ? t('storageMigrationFailTooLarge')
          : code === 'unsupported'
            ? t('storageMigrationFailUnknownSpace')
            : t('storageMigrationFailGeneric', { message: view.failure.message })
    return (
      <div className={styles.screen} role="alert" data-testid="migration-gate-failed">
        <div className={styles.card}>
          <div className={styles.title}>{t('storageMigrationFailedTitle')}</div>
          <div className={styles.description}>{t('storageMigrationFailedBody')}</div>
          <code className={styles.detail}>{reason}</code>
          <div className={styles.actions}>
            <Button size="m" block data-testid="migration-gate-retry" onClick={onRetry}>
              {t('storageMigrationRetry')}
            </Button>
            <Button variant="outlined" size="m" block data-testid="migration-gate-continue" onClick={onContinue}>
              {t('storageMigrationContinue')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const body =
    view.reason === 'sqlite-unavailable-after-commit'
      ? t('storageMigrationBlockedAfterCommit')
      : view.reason === 'needs-user-decision'
        ? t('storageMigrationBlockedDecision')
        : t('storageMigrationBlockedMigrating')
  return (
    <div className={styles.screen} role="alert" data-testid="migration-gate-blocked">
      <div className={styles.card}>
        <div className={styles.title}>{t('storageMigrationBlockedTitle')}</div>
        <div className={styles.description}>{body}</div>
        {view.detail !== undefined && (
          <code className={styles.detail}>{t('storageMigrationBlockedDetail', { detail: view.detail })}</code>
        )}
        <div className={styles.actions}>
          <Button size="m" block data-testid="migration-gate-reload" onClick={() => window.location.reload()}>
            {t('errorScreenReload')}
          </Button>
          <Button variant="outlined" size="m" block data-testid="migration-gate-copy" onClick={() => void onCopy()}>
            {t(
              copy === 'done'
                ? 'errorScreenCopied'
                : copy === 'failed'
                  ? 'errorScreenCopyFailed'
                  : 'errorScreenCopyDiagnostics',
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

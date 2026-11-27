import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { copyText } from '../../utils/clipboard.js'
import {
  acknowledgeGateNotice,
  continueWithLegacy,
  ensureStorageReady,
  getGateView,
  recheckStorage,
  retryMigration,
  subscribeGate,
  type GateView,
  type MigrationSpaceShortfall,
} from '../../services/storage/gate.js'
import styles from './MigrationGate.module.css'

/**
 * 启动闸门的迁移页（#916 / #910 D1）。放在 `<App/>` 之外：闸门 `ready` 之前 App 不挂载，
 * 因此 store 第一次读库一定发生在真源确定之后。
 *
 *  - `checking`：什么都不画（一次异步判定，没有注册迁移运行时时是同一个微任务内结束）。
 *  - `migrating`：阻塞页 + 阶段 + 百分比 + 体积/空间数字 + 「保持前台」提醒。
 *  - `succeeded`：**真校验通过后**的一次性成功提示（「已完成迁移并通过完整性校验」），确认或短暂停留后进 App。
 *  - `failed`：明确原因；`interrupted` 与 `insufficient-space` 各有专属说明与出路（继续升级 / 重新检测 / 继续用原数据）。
 *  - `unsupported`：本机暂不支持存储升级，明确告知一次（仍用 IndexedDB，不影响使用），确认后进 App。
 *  - `blocked`：明确说明 + 重载 / 复制诊断信息；**绝不**落到空白欢迎页。
 */

/** 成功提示自动进入 App 的停留时间：够读完两行，又不至于让用户以为卡住。 */
const SUCCESS_DWELL_MS = 3000

export const MigrationGate = ({ children }: { children: ReactNode }) => {
  const view = useSyncExternalStore(subscribeGate, getGateView, getGateView)
  useEffect(() => {
    void ensureStorageReady()
  }, [])
  // 成功提示「只出现一次」的另一半：停下 3 秒就自动放行（也可以点按钮立刻进）。
  // 依赖只取 kind：迁移结束后视图不会在 succeeded 与其它态之间来回跳。
  useEffect(() => {
    if (view.kind !== 'succeeded') {
      return
    }
    const timer = setTimeout(() => {
      acknowledgeGateNotice()
    }, SUCCESS_DWELL_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [view.kind])
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
      onRecheck={() => void recheckStorage()}
      onAcknowledge={() => void acknowledgeGateNotice()}
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

const GIGABYTE = 1024 * 1024 * 1024
const MEGABYTE = 1024 * 1024

/** 人话体积：≥ 1 GB 用 GB，其余用 MB，都保留 1 位小数（不四舍五入成整数，别让 1.4GB 显示成「1 GB」）。 */
const formatBytes = (bytes: number): string => (bytes >= GIGABYTE ? `${(bytes / GIGABYTE).toFixed(1)} GB` : `${(bytes / MEGABYTE).toFixed(1)} MB`)

/** 「建议清理」留的余量：刚好补平差额的用户第二天又会卡住，多留 64MB。 */
const CLEANUP_MARGIN_BYTES = 64 * MEGABYTE

/** 建议清理量 = 所需 − 可用（不足时再加余量）；已经够就不给数字，别凭空调大。 */
const cleanupBytesOf = (space: MigrationSpaceShortfall): number | undefined => {
  if (space.freeBytes === undefined) {
    return undefined
  }
  const shortfall = space.requiredBytes - space.freeBytes
  return shortfall > 0 ? shortfall + CLEANUP_MARGIN_BYTES : undefined
}

type Visible = Exclude<GateView, { kind: 'ready' } | { kind: 'checking' }>

/** 纯展示（便于截图与测试直接喂视图状态）。 */
export const MigrationView = ({
  view,
  onRetry,
  onContinue,
  onRecheck,
  onAcknowledge,
}: {
  view: Visible
  onRetry: () => void
  onContinue: () => void
  onRecheck: () => void
  onAcknowledge: () => void
}) => {
  const t = useTranslate()
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle')

  const onCopy = async () => {
    const detail = view.kind === 'blocked' ? `${view.reason}${view.detail ? `: ${view.detail}` : ''}` : view.kind
    const ok = await copyText(`storage-gate: ${detail}`)
    setCopy(ok ? 'done' : 'failed')
  }

  if (view.kind === 'migrating') {
    const preflight = view.preflight
    // 体积与空间数字：普通用户也要看得见（以前只在 >200MB 的警告线以上才说，且只说体积不说可用）。
    const spaceLine =
      preflight === undefined
        ? undefined
        : preflight.freeBytes === undefined
          ? t('storageMigrationSizeHint', { size: formatBytes(preflight.estimateBytes), need: formatBytes(preflight.requiredBytes) })
          : t('storageMigrationProgressSpace', {
              size: formatBytes(preflight.estimateBytes),
              need: formatBytes(preflight.requiredBytes),
              free: formatBytes(preflight.freeBytes),
            })
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
          {spaceLine !== undefined && <div className={styles.hint}>{spaceLine}</div>}
          <div className={styles.warning} data-testid="migration-gate-foreground-hint">
            {t('storageMigrationKeepForeground')}
          </div>
        </div>
      </div>
    )
  }

  if (view.kind === 'succeeded') {
    return (
      <div className={styles.screen} role="status" aria-live="polite" data-testid="migration-gate-succeeded">
        <div className={styles.card}>
          <div className={styles.title}>{t('storageMigrationSuccessTitle')}</div>
          <div className={styles.description}>{t('storageMigrationSuccessBody')}</div>
          <div className={styles.hint}>{t('storageMigrationSuccessNext')}</div>
          <div className={styles.actions}>
            <Button size="m" block data-testid="migration-gate-succeeded-action" onClick={onAcknowledge}>
              {t('storageMigrationSuccessAction')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (view.kind === 'unsupported') {
    return (
      <div className={styles.screen} role="alert" data-testid="migration-gate-unsupported">
        <div className={styles.card}>
          <div className={styles.title}>{t('storageMigrationUnsupportedTitle')}</div>
          <div className={styles.description}>{t('storageMigrationUnsupportedBody')}</div>
          <div className={styles.hint}>{t('storageMigrationUnsupportedHint')}</div>
          <div className={styles.actions}>
            <Button size="m" block data-testid="migration-gate-unsupported-action" onClick={onAcknowledge}>
              {t('storageMigrationUnsupportedAction')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (view.kind === 'failed') {
    const code = view.failure.code
    // 场景 2：空间不足。三个数字 + 清理指引 + 「重新检测」（独立入口，重新走 ensureStorageReady/preflight）。
    if (code === 'insufficient-space') {
      const space = view.space
      const cleanup = space === undefined ? undefined : cleanupBytesOf(space)
      const spaceLines: string[] = []
      if (space !== undefined && space.freeBytes !== undefined) {
        spaceLines.push(t('storageMigrationSpaceFree', { free: formatBytes(space.freeBytes) }))
        spaceLines.push(t('storageMigrationSpaceNeed', { need: formatBytes(space.requiredBytes) }))
        if (cleanup !== undefined) {
          spaceLines.push(t('storageMigrationSpaceCleanup', { cleanup: formatBytes(cleanup) }))
        }
      }
      const onCopyGuide = async () => {
        const ok = await copyText([...spaceLines, t('storageMigrationSpaceGuide')].join('\n'))
        setCopy(ok ? 'done' : 'failed')
      }
      return (
        <div className={styles.screen} role="alert" data-testid="migration-gate-failed">
          <div className={styles.card}>
            <div className={styles.title}>{t('storageMigrationSpaceTitle')}</div>
            <div className={styles.description}>{t('storageMigrationSpaceBody')}</div>
            <div className={styles.numbers} data-testid="migration-gate-space-numbers">
              {spaceLines.length > 0
                ? spaceLines.map((line) => <div key={line}>{line}</div>)
                : <div>{t('storageMigrationFailSpace')}</div>}
            </div>
            <div className={styles.guide} data-testid="migration-gate-space-guide">
              <div className={styles.guideTitle}>{t('storageMigrationSpaceGuideTitle')}</div>
              <div className={styles.guideBody}>{t('storageMigrationSpaceGuide')}</div>
            </div>
            <div className={styles.actions}>
              <Button size="m" block data-testid="migration-gate-recheck" onClick={onRecheck}>
                {t('storageMigrationRecheck')}
              </Button>
              <Button variant="outlined" size="m" block data-testid="migration-gate-copy-guide" onClick={() => void onCopyGuide()}>
                {t(
                  copy === 'done'
                    ? 'storageMigrationSpaceGuideCopied'
                    : copy === 'failed'
                      ? 'storageMigrationSpaceGuideCopyFailed'
                      : 'storageMigrationSpaceGuideCopy',
                )}
              </Button>
              <Button variant="outlined" size="m" block data-testid="migration-gate-defer" onClick={onContinue}>
                {t('storageMigrationSpaceDefer')}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    // 场景 4：迁移被中断（abort / 进程被杀后的重入）。专属说明 + 明确「不要卸载 / 不要清除数据」。
    if (code === 'interrupted') {
      return (
        <div className={styles.screen} role="alert" data-testid="migration-gate-interrupted">
          <div className={styles.card}>
            <div className={styles.title}>{t('storageMigrationInterruptedTitle')}</div>
            <div className={styles.description}>{t('storageMigrationInterruptedBody')}</div>
            <div className={styles.danger} data-testid="migration-gate-interrupted-warning">
              {t('storageMigrationInterruptedWarning')}
            </div>
            <div className={styles.actions}>
              <Button size="m" block data-testid="migration-gate-retry" onClick={onRetry}>
                {t('storageMigrationInterruptedAction')}
              </Button>
              <Button variant="outlined" size="m" block data-testid="migration-gate-continue" onClick={onContinue}>
                {t('storageMigrationInterruptedLater')}
              </Button>
            </div>
          </div>
        </div>
      )
    }

    const reason =
      code === 'unsupported' && view.failure.message.startsWith('source-too-large')
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
            <Button variant="outlined" size="m" block data-testid="migration-gate-recheck" onClick={onRecheck}>
              {t('storageMigrationRecheck')}
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

import { useSyncExternalStore } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getGateView, retryMigration, subscribeGate } from '../../services/storage/gate.js'
import { isStorageAvailable } from '../../services/storage/index.js'
import { getEngineChoice, getStorageRuntime } from '../../services/storage/migration/runtime.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconDataOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { SettingsCard, SettingsCardInfoRow } from './CardRow.js'
import styles from './Settings.module.css'
import { readStorageStatus, type StorageMigrationStatus } from './storageStatusView.js'

/**
 * 设置页「本地存储状态」（内测自查用）：真源是谁 + 迁移到哪一步 + 一个主动重试入口。
 *
 * 纯只读：订阅启动闸门的视图（`subscribeGate` / `getGateView`，与「启动迁移页」同一份状态）、
 * 读一次路由结论与两项能力探测。**不触发迁移、不重跑路由、不改任何设置**。
 *
 * 「主动重试」复用既有的 `retryMigration()`（`gate.ts`）——那里自带前提：「只在视图是 failed 时动作」，
 * 所以这里仅当 `canRetry` 为真才可点，非失败态按钮是 disabled 并把原因写在同一行的说明里，
 * 不做「点了没反应」的假入口。
 */
const MIGRATION_KEYS: Record<StorageMigrationStatus, TranslationKey> = {
  migrated: 'storageStatusMigrated',
  'not-migrated': 'storageStatusNotMigrated',
  migrating: 'storageStatusMigrating',
  unavailable: 'storageStatusUnavailable',
  unknown: 'storageStatusUnknown',
}

export const StorageStatusSection = () => {
  const t = useTranslate()
  const view = useSyncExternalStore(subscribeGate, getGateView, getGateView)
  // 路由结论在每次 publish 之前写入（`gate.ts` 的 settle()），所以跟着上面的订阅一起刷新
  const choice = getEngineChoice()
  const status = readStorageStatus({
    view,
    choice,
    runtimeRegistered: getStorageRuntime() !== undefined,
    storageAvailable: isStorageAvailable(),
  })

  /**
   * 后端名直接用引擎名：`SQLite` / `IndexedDB` 是产品里写死的后端标识，不是需要翻译的句子；
   * 其余状态（不可用 / 未知）才走词条。
   */
  const backendText =
    status.backend === 'sqlite'
      ? 'SQLite'
      : status.backend === 'indexeddb'
        ? 'IndexedDB'
        : t(status.backend === 'unavailable' ? 'storageStatusUnavailable' : 'storageStatusUnknown')

  return (
    <SettingsCard>
      <div className={styles.cardLabel}>{t('storageStatusSection')}</div>
      <SettingsCardInfoRow
        testId="storage-status-backend"
        icon={<IconDataOutline16 />}
        label={t('storageStatusBackendLabel')}
        description={t('storageStatusDescription')}
        value={backendText}
      />
      <SettingsCardInfoRow
        testId="storage-status-migration"
        icon={<IconCheckOutline16 />}
        label={t('storageStatusMigrationLabel')}
        value={t(MIGRATION_KEYS[status.migration])}
      />
      <SettingsCardInfoRow
        testId="storage-status-retry"
        icon={<IconRefreshOutline16 />}
        label={t('storageStatusRetryLabel')}
        description={
          view.kind === 'failed'
            ? t('storageMigrationFailGeneric', { message: view.failure.message })
            : t('storageStatusRetryHint')
        }
        value={
          <Button
            variant="outlined"
            size="m"
            testId="storage-status-retry-button"
            disabled={!status.canRetry}
            onClick={() => void retryMigration()}
          >
            {t('storageMigrationRetry')}
          </Button>
        }
      />
    </SettingsCard>
  )
}

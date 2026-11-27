import { useSyncExternalStore } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { getGateView, retryMigration, subscribeGate } from '../../services/storage/gate.js'
import { copyPlanOf } from '../../services/storage/migration/failure-class.js'
import { isStorageAvailable } from '../../services/storage/index.js'
import { getEngineChoice, getStorageRuntime } from '../../services/storage/migration/runtime.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16, IconRefreshOutline16 } from '../base/icons.js'
import { SettingsCard, SettingsCardInfoRow } from './CardRow.js'
import styles from './Settings.module.css'
import { readStorageStatus, type StorageMigrationStatus } from './storageStatusView.js'

/**
 * 设置页「本地存储」这一节（面向普通用户）：**只回答一件事 —— 我的数据升级好了没有。**
 *
 * 刻意**不展示**底层存储引擎（SQLite / IndexedDB）与「实际保存在哪里」这类技术细节：
 *  · 普通用户看不懂后端名，也无法据此做任何决定；
 *  · 换存储实现是要能悄悄换掉的，写进界面等于给自己上锁；
 *  · 排查需要的信息在诊断日志里（`readDiagnosticsFacts()` 写入 `storage.engine`），不需要放在用户面前。
 *
 * 「重新尝试升级」这一行**只在确实可重试时才渲染**（`canRetry` 且分类器判为 `allowRetry`，即启动迁移失败
 * 且重试不会撞同一面墙，见 `services/storage/migration/failure-class.ts`）。
 * 升级成功后保留一个置灰按钮是纯噪音 —— 用户点不动，还得猜为什么；不满足条件就整行不出现。
 *
 * 纯只读：订阅启动闸门的视图（`subscribeGate` / `getGateView`，与「启动迁移页」同一份状态）、
 * 读一次路由结论与两项能力探测。**不触发迁移、不重跑路由、不改任何设置**。
 * 重试复用既有的 `retryMigration()`，它自带前提：只在视图是 failed 时动作。
 */
const MIGRATION_KEYS: Record<StorageMigrationStatus, TranslationKey> = {
  migrated: 'storageStatusMigrated',
  'not-migrated': 'storageStatusNotMigrated',
  failed: 'storageStatusFailed',
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
  // 不可重试的档位（数据损坏 / 本机不支持）连这一行都不出现：闸门那边 `retryMigration()`
  // 也会拒绝，摆一个点了没反应的按钮等于骗用户点（#940）。
  const allowRetry = view.kind === 'failed' && view.classification.allowRetry

  return (
    <SettingsCard>
      <div className={styles.cardLabel}>{t('storageStatusSection')}</div>
      <SettingsCardInfoRow
        testId="storage-status-migration"
        icon={<IconCheckOutline16 />}
        label={t('storageStatusMigrationLabel')}
        value={t(MIGRATION_KEYS[status.migration])}
      />
      {status.canRetry && allowRetry ? (
        <SettingsCardInfoRow
          testId="storage-status-retry"
          icon={<IconRefreshOutline16 />}
          label={t('storageStatusRetryLabel')}
          // #940：原因只说分类器给的**档位标题**（「数据读取失败」这类人话），
          // 原始异常原文留在诊断日志里，不上界面。
          description={view.kind === 'failed' ? t(copyPlanOf(view.classification).titleKey) : undefined}
          value={
            <Button
              variant="outlined"
              size="m"
              testId="storage-status-retry-button"
              onClick={() => void retryMigration()}
            >
              {t('storageMigrationRetry')}
            </Button>
          }
        />
      ) : null}
    </SettingsCard>
  )
}

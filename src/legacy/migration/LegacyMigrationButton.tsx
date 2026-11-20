/**
 * 「迁移历史额度」按钮（Issue #498 §四 的 UI 那一列）。
 *
 * @remove-after 1.6.0 —— 临时尾巴，见 ./README.md。
 *
 * 这个组件**只管一件事**：把 `ClaimResult` 翻译成「显示什么 / 还能不能点」。
 * 它自己不发「登录后那一次」调用（那一次在接线点，见 README），只在用户点按钮时重试
 * —— 这是 #498 §六 第 4 条的落地：**不做自动重试，重试只能由用户点击触发**。
 *
 * 状态 → 界面的映射（一列都不能改，改之前先读 #498 §四 那张表）：
 *
 * | 结果 | 界面 |
 * | --- | --- |
 * | 还没跑过 / `failed:retryable=true` | 按钮「迁移历史额度」，可再点 |
 * | `migrated` | 「历史额度已迁移：$X」，没有按钮 |
 * | `already_migrated` + `amount > 0` | **什么都不渲染**（永久，幂等命中） |
 * | `already_migrated` + `amount` 0 / 缺省 | 「已迁移过，如未到账请联系客服」+「仍要迁移」（见下） |
 * | `no_legacy` | **什么都不渲染**（静默） |
 * | `need_manual` | 「如需迁移历史额度，请联系客服」，**永不出现重试** |
 * | `expired` | 「迁移已结束」，**永不出现重试** |
 * | `failed:retryable=false` | 失败原因，**永不出现重试** |
 *
 * 三条硬约束：
 *   1. **开关第 3 处**：`migration.enabled !== true` 时直接返回 `null`（不显示按钮）。
 *      另外两处在 `claim.ts`（不请求）与 `collect.ts`（调用前置：不采集）。
 *   2. **不缓存 token**：`getToken()` 每次点击现取，组件里不存副本 —— 凭据副本是 #387 的起点。
 *   3. **不把任何凭据交给 DOM**：这里只渲染服务端给的金额与 reason；`oldApiKey` 全程只存在于
 *      `claim.ts` 的请求体里，本文件连 import 都不 import 它。
 *
 * 自包含：不读写全局 store、不 import 页面级组件，只用 `components/base/Button` 与 i18n。
 * 接线方按路径直接 import（`./legacy/migration/LegacyMigrationButton.js`），见 README「挂载方式」。
 */

import { useCallback, useState } from 'react'

import { Button } from '../../components/base/Button.js'
import { useTranslate } from '../../i18n/index.js'
import { claimLegacyMigration, isMigrationEnabled } from './claim.js'
import type { ClaimResult } from './types.js'

export type LegacyMigrationButtonProps = {
  /**
   * 「登录后那一次」调用的结果。缺省 = 还没跑过（按「可迁移」显示按钮）。
   * 只作为**初始值**读取：之后的重试结果由组件自己维护（换账号时请给这个组件换 `key` 重挂）。
   */
  initial?: ClaimResult
  /** 取当前 sub2api access token；拿不到就当作没登录（不发请求、不改界面） */
  getToken: () => string | undefined
  className?: string
}

type Translate = ReturnType<typeof useTranslate>

/**
 * 金额只做展示：服务端给的 `{amount, currency}` 直接上屏，**不做换算**（#498 §3.4）。
 *
 * 真实契约（`sub2api-private@8b12ab2`）的单位是**元**（`100 积分 = 1 元`），币种在 `currency` 里
 * （当前是 `CNY`）。所以符号**按币种选**，绝不硬编码 `$`：认不出的币种就显示「数字 + 代码」，
 * 连币种都没给就只显示数字 —— 宁可少一个符号，也不能把人民币写成美元。
 */
const CURRENCY_SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' }

const moneyText = (amount: number | undefined, currency: string | undefined): string => {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return '—'
  }
  const code = (currency ?? '').trim().toUpperCase()
  const symbol = CURRENCY_SYMBOLS[code]
  if (symbol !== undefined) {
    return `${symbol}${amount.toFixed(2)}`
  }
  return code === '' ? amount.toFixed(2) : `${amount.toFixed(2)} ${code}`
}

type MigrationView =
  | { kind: 'hidden' }
  | { kind: 'retry' }
  | { kind: 'done'; text: string }
  | { kind: 'note'; text: string; reason?: string }
  /** 文案 + 一个**手动**入口（不自动调用）：只给「说迁过了但金额是 0」这一种情况用 */
  | { kind: 'noteWithRetry'; text: string }

/**
 * 六状态 → 视图。抽成纯函数是为了让人能一眼对完 #498 §四 的表；
 * 它刻意不导出（对外只有 index.ts 的两个函数）。
 */
const viewOf = (result: ClaimResult | undefined, t: Translate): MigrationView => {
  if (result === undefined) {
    return { kind: 'retry' }
  }
  switch (result.status) {
    case 'migrated':
      return { kind: 'done', text: t('legacyMigrateDone', { amount: moneyText(result.amount, result.currency) }) }
    // 幂等命中 = 之前迁过了：金额 > 0 才算真的到账，契约要求**永久**不显示按钮（§四 第二行）。
    // ⚠ 实测坑：后端 `legacy_sync_log` 有 `UNIQUE(sub2api_user_id)`，用户认领**第二个**老账号时
    // 会回 `{status:'already_migrated', amount:0}`，而那个账号根本没迁。这时候永久隐藏按钮
    // 等于骗用户「已经完成了」—— 所以给「如未到账请联系客服」+ 一个手动入口，**但不自动调用**。
    case 'already_migrated': {
      const settled = typeof result.amount === 'number' && result.amount > 0
      return settled ? { kind: 'hidden' } : { kind: 'noteWithRetry', text: t('legacyMigrateAlreadyUnsettled') }
    }
    // 没有旧账号：静默。这里若弹一句「没有可迁移额度」，等于给每个新用户加一条噪音
    case 'no_legacy':
      return { kind: 'hidden' }
    case 'need_manual':
      return { kind: 'note', text: t('legacyMigrateManual') }
    case 'expired':
      return { kind: 'note', text: t('legacyMigrateExpired') }
    case 'failed':
      // 只有 retryable 的失败才留按钮；其余把原因摆出来，不再给重试（§四 最后两行）
      if (result.retryable) {
        return { kind: 'retry' }
      }
      // `device_mismatch`（后端 8b12ab2 的真实语义：deviceId 与老账号不一致 → 拒绝）用固定文案，
      // 不把服务端原文端给用户：那句话对用户没有行动价值，且不同服务端版本措辞不一样。
      if (result.reason === 'device_mismatch') {
        return { kind: 'note', text: t('legacyMigrateDeviceMismatch') }
      }
      return { kind: 'note', text: t('legacyMigrateFailed'), reason: result.reason }
  }
}

export const LegacyMigrationButton = ({ initial, getToken, className }: LegacyMigrationButtonProps) => {
  const t = useTranslate()
  const [result, setResult] = useState<ClaimResult | undefined>(initial)
  const [busy, setBusy] = useState(false)

  const retry = useCallback(async (): Promise<void> => {
    const token = getToken()
    if (token === undefined || token.trim() === '') {
      return
    }
    setBusy(true)
    try {
      // claimLegacyMigration 自己保证不抛；这里再包一层只是不让「按钮转圈卡死」发生
      setResult(await claimLegacyMigration(token))
    } finally {
      setBusy(false)
    }
  }, [getToken])

  // 开关第 3 处：关掉时不显示按钮（#498 §一：不采集、不请求、不显示）
  if (!isMigrationEnabled()) {
    return null
  }

  const view = viewOf(result, t)

  if (view.kind === 'hidden') {
    return null
  }

  if (view.kind === 'retry') {
    return (
      <Button
        size="m"
        variant="outlined"
        className={className}
        disabled={busy}
        onClick={() => {
          void retry()
        }}
      >
        {t('legacyMigrateTitle')}
      </Button>
    )
  }

  if (view.kind === 'done') {
    return <p className={className}>{view.text}</p>
  }

  if (view.kind === 'noteWithRetry') {
    return (
      <div>
        <p className={className}>{view.text}</p>
        <Button
          size="m"
          variant="outlined"
          disabled={busy}
          onClick={() => {
            void retry()
          }}
        >
          {t('legacyMigrateRetryAnyway')}
        </Button>
      </div>
    )
  }

  return (
    <p className={className}>
      {view.text}
      {view.reason === undefined ? null : <span>{`（${view.reason}）`}</span>}
    </p>
  )
}

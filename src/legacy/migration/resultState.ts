/**
 * 「登录后那一次」迁移结果的存放处（#498 §四 的界面缺口）。
 *
 * @remove-after 1.6.0 —— 临时尾巴，见 ./README.md。
 *
 * 为什么需要它：`applySession()` 里那一次 `claimLegacyMigration()` 的返回值原来被**直接丢掉**，
 * 于是「服务端已经自动迁了 ¥X」这件事用户永远看不见 —— 他打开「我的钱包」也只会看到一个
 * 还能点的「迁移历史额度」按钮，点下去服务端回 `already_migrated` + 金额 > 0，
 * 而那个状态按契约**什么都不显示**（幂等命中，永久隐藏）。结果就是**钱到了、用户不知道**。
 *
 * 所以登录后那一次的结果必须落到一个界面读得到的地方，再由
 * `LegacyMigrationButton` 的 `initial` 传进去（组件按 `status` 决定显示什么，这一层不推导）。
 *
 * 三条约束：
 *   1. **只存结果，不存凭据**：`ClaimResult` 里只有状态 / 金额 / 币种 / 服务端 `reason`
 *      （`reason` 已经在 `claim.ts` 的 `readReason()` 里收敛过）。token、`oldApiKey` 一律不进这里。
 *   2. **不缓存、不重放**：这是一次性的展示值，不是「迁移状态机」；要不要重发只由用户点按钮决定。
 *   3. **切号要清**：`store.ts` 的 `clearSession()` 会在退出 / 刷新被拒时调
 *      {@link clearLegacyMigrationResult} —— 否则 A 的「已迁移 ¥50」会留在 B 的钱包页上。
 */

import { create } from 'zustand'

import type { ClaimResult } from './types.js'

type LegacyMigrationResultState = {
  /** 登录后那一次的结论；`null` = 还没跑过（启动恢复不走迁移，所以这时是「可手动迁移」） */
  result: ClaimResult | null
}

export const useLegacyMigrationResult = create<LegacyMigrationResultState>(() => ({ result: null }))

/** 写入结论（只由 `afterLogin.ts` 在 claim 落地后调用） */
export const setLegacyMigrationResult = (result: ClaimResult): void => {
  useLegacyMigrationResult.setState({ result })
}

/** 清空（切号 / 退出登录；幂等、不抛） */
export const clearLegacyMigrationResult = (): void => {
  useLegacyMigrationResult.setState({ result: null })
}

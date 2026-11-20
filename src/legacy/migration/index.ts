/**
 * 老账号额度迁移（Issue #498）的**唯一对外出口**。
 *
 * @remove-after 1.6.0 —— 这是临时债，不是新功能。整目录删掉就是「下线」，
 * 删除方法见 ./README.md（删本目录 + 删两处调用 + 删 `config/endpoints.json` 的 `migration` 组
 * + 删 `rspack.config.ts` 里那 3 行注入）。
 *
 * 对外**只有两个函数**：
 *
 * ```ts
 * import { collectLegacyIdentity, claimLegacyMigration } from './legacy/migration/index.js'
 *
 * const identity = collectLegacyIdentity()        // 从本地存储捞老账号线索（不抛，缺了就省）
 * void claimLegacyMigration(accessToken)          // 登录成功后一次；失败静默，不阻断登录
 * ```
 *
 * 别在这里再加东西：
 *   - 界面（`LegacyMigrationButton.tsx`）由接线方按路径直接 import，**不走这个出口**
 *     —— 它要跟着 UI 线一起挂，而不是让「对外只要两个函数」这句话失真；
 *   - 类型（`types.ts`）、配置读取（`claim.ts` 的 `readMigrationConfig`）都只给同目录的内部实现用；
 *   - 想加自动重试 / 队列 / 埋点，先读 claim.ts 顶部那六条约定（都有事故单号）。
 */

export { collectLegacyIdentity } from './collect.js'
export { claimLegacyMigration } from './claim.js'

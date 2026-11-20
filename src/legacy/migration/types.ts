/**
 * 老账号额度迁移的**返回契约**（Issue #498 §四）。
 *
 * @remove-after 1.6.0 —— 这是临时的迁移尾巴，不是新功能（见 ./README.md 的「删除方法」）。
 *
 * 服务端返回的六种状态**全部**由这里建模，界面只按 `status` 分支，不自己推导：
 *
 * | status | 含义 | 客户端 |
 * | --- | --- | --- |
 * | `migrated` | 本次迁移成功 | 「历史额度已迁移：$X」 |
 * | `already_migrated` | 幂等命中（之前迁过） | 金额 > 0 → **永久不显示按钮**；金额 0 → 见下方第 ⚠ 条 |
 * | `no_legacy` | 没有旧账号 | 静默不提示 |
 * | `need_manual` | 缺持有证明，走人工 | 提示联系客服，**不再给重试** |
 * | `expired` | 迁移窗口已关 | 「迁移已结束」+ 永久隐藏 |
 * | `failed` | 失败 | `retryable` 决定还能不能再点 |
 *
 * 三条建模取舍（改这个类型前先读）：
 *   1. **判别联合而不是 `{ status: string; ... }`**：`retryable` 只在 `failed` 上出现，
 *      `usdAmount` 只在两种「迁过 / 迁成」上出现 —— 写成可选字段会让界面拿
 *      `result.retryable === true` 当真值判断，写错也不报错（正是 #498 §四那张表的坑）。
 *   2. **金额只做展示**：`amount` + `currency` 是服务端算好的数，客户端**不做任何换算**
 *      （#498 §3.4：折算口径服务端定死写进文档）。后端真实契约（`sub2api-private@8b12ab2`
 *      的 `tools/kunming-migration/legacy-sync/server.py`）给的是 **`{amount, currency}`，单位是元**
 *      （100 积分 = 1 元），不是美元 —— 所以界面**按 `currency` 选符号**（`CNY` → `¥`），
 *      绝不硬编码 `$`。
 *   ⚠ **`already_migrated` 的金额可能是 0（实测坑）**：后端 `legacy_sync_log` 上有
 *      `UNIQUE(sub2api_user_id)`，用户认领**第二个**老账号时会回
 *      `{status:"already_migrated", amount:0}` 而那个账号其实没迁。所以「金额 > 0」才算真的到账，
 *      金额 0 / 缺省时界面**不能永久隐藏**，要给「如未到账请联系客服」+ 一个「仍要迁移」入口。
 *   3. **`reason` 是不可信文本**：来自服务端响应，只允许截断后进 DOM，**绝不进日志 / 埋点**
 *      （`src/legacy/migration/claim.ts` 的 `readReason` 负责收敛形状）。
 */

/** 服务端认的六个状态值（`claim.ts` 用它做响应校验：不认识的一律按契约破坏处理） */
export const CLAIM_STATUSES = [
  'migrated',
  'already_migrated',
  'no_legacy',
  'need_manual',
  'expired',
  'failed',
] as const

export type ClaimStatus = (typeof CLAIM_STATUSES)[number]

/**
 * 迁移成功 / 幂等命中：服务端算好的金额与币种。
 * 缺省 = 服务端没给，界面显示占位（`—`），**不猜币种**（后端 `currency` 现在是 `CNY`）。
 */
type ClaimWithAmount = { amount?: number; currency?: string }

/** 一次性结果：客户端**只读不缓存**，要不要再点由界面按 `retryable` 决定 */
export type ClaimResult =
  | ({ status: 'migrated' } & ClaimWithAmount)
  | ({ status: 'already_migrated' } & ClaimWithAmount)
  | { status: 'no_legacy'; reason?: string }
  | { status: 'need_manual'; reason?: string }
  | { status: 'expired'; reason?: string }
  /**
   * `retryable:false` = 再点也没意义（窗口关、凭据不对、契约不符），界面不再显示按钮。
   * 真实契约里的典型值：`device_mismatch`（`deviceId` 与老账号不一致 → 后端**拒绝**，
   * 不是 `need_manual`），界面按「设备信息不匹配，请联系客服」显示，且不给重试。
   */
  | { status: 'failed'; retryable: boolean; reason?: string }

/**
 * 从设备本地收集到的「老账号线索」（#498 §二 的前三项）。
 *
 * 全部可选：某一项存不存在取决于用户的设备历史，**缺了就不传** ——
 * 服务端按「有没有 `oldApiKey`」决定能不能自动迁移（#498 §3.2：`deviceId` / `deviceFp`
 * 都不可单独作为凭据，只有 `oldApiKey` 是持有证明）。
 */
export type LegacyIdentity = {
  /** 设备上还留着的旧 `sk-` Key（明文凭据：不进日志 / 埋点 / 剪贴板 / DOM） */
  oldApiKey?: string
  /** 老服务里的设备码（即老账号标识；本地 `chat-demo:ours-device-id`） */
  deviceId?: string
  /** 老服务里的设备指纹（本地缓存位；拿不到就省略，绝不用常量/全零占位，见 #395） */
  deviceFp?: string
}

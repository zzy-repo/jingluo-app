/**
 * 「我的卡密」tab 的**兑换后动作**（#676 §五 / §九 第 3 条）—— 纯函数，裸 Node 可测。
 *
 * 契约（`#676` 五）写得很直：
 *
 * > 成功后余额直接进 `user.balance`，**不再是某把 Key 的 quota**。客户端要重新拉 `/user/profile` 刷新余额。
 *
 * 所以兑换成功后**必须**做的只有一件事：`GET /api/v1/user/profile`。
 *   - **不是** `GET /v1/usage`（那是**用某把 Key 自己**鉴权的额度接口，老 Key 的 `quota` 已被置 0、
 *     额度迁进了 `balance`，拿它当余额会显示成「不限」或 0）；
 *   - **不是** `GET /api/v1/usage`（那是用量列表，不回答「还剩多少钱」）。
 *
 * 为什么抽成函数而不是写在组件的 `useCallback` 里：组件里那几行 `setState` 在裸 Node 里断言不了，
 * 「兑换成功后到底有没有拉 profile」这条契约就会变成口头承诺。这里给一个输入（兑换结局）、
 * 一个输出（余额 / 要不要刷新），测试直接钉住**发了哪个请求、带没带 JWT**。
 *
 * 三条不许破的约定：
 *  1. **只对 `redeemed` 发**：`pending` / `processing` / `failed` 一律不拉 —— 那三种结局下余额没变，
 *     多打一发只是把「一次超时」放大成「一串请求」（#484 §4.3）；
 *  2. **只发一次**：没有重试、没有轮询；
 *  3. **失败不改变结论**：profile 读不到就让 `balance` 缺席（界面不显示余额），
 *     绝不把「兑换成功」翻成「失败」——那会让用户以为卡没兑换、再输一次（重复兑换）。
 */

import type {
  ConsumeCallResult,
  ConsumeRedeemOutcome,
  ConsumeUser,
} from '../../services/consume/index.js'

/** 只需要「读一次账号资料」这一个能力（组件传 `consume.auth`，测试给假实现） */
export type RedeemRefreshSource = { profile: () => Promise<ConsumeCallResult<ConsumeUser>> }

/**
 * 兑换后的动作结果：
 *  - `refresh: false` → 这次结局不需要刷新（不是 `redeemed`）；
 *  - `refresh: true`  → **已经**拉了 `/user/profile`；`balance` 有值才代表读到了余额。
 */
export type RedeemAftermath =
  | { refresh: false }
  | { refresh: true; balance?: number }

/**
 * 兑换成功 → 重拉一次 `/user/profile`，把 `balance`（元）带出来。
 *
 * 非 `redeemed` 结局**一次请求都不发**（返回 `refresh: false`）。
 */
export const afterRedeemed = async (
  outcome: ConsumeRedeemOutcome,
  source: RedeemRefreshSource
): Promise<RedeemAftermath> => {
  if (outcome.kind !== 'redeemed' || outcome.refreshProfile !== true) {
    return { refresh: false }
  }
  let profile: ConsumeCallResult<ConsumeUser>
  try {
    profile = await source.profile()
  } catch {
    // 配置缺失这类「连请求都没发出去」的意外也按「没读到余额」处理（结论仍是兑换成功）
    return { refresh: true }
  }
  if (!profile.ok) {
    return { refresh: true }
  }
  const aftermath: { refresh: true; balance?: number } = { refresh: true }
  if (typeof profile.data.balance === 'number' && Number.isFinite(profile.data.balance)) {
    aftermath.balance = profile.data.balance
  }
  return aftermath
}

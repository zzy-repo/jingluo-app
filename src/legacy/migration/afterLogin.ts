/**
 * 登录 / 注册成功后的**那一次**迁移，以及它的固定顺序（#498 §六 第 3 条）。
 *
 * @remove-after 1.6.0 —— 临时尾巴，见 ./README.md。
 *
 * 为什么单独一层：`applySession()` 是**同步**函数（`signIn` / `signUp` 拿到 session 就落盘 + setState，
 * 不等任何 I/O）。补指纹写入之后，链上多了一步异步 —— 若把 `applySession` 改成 `async` 并 `await`，
 * 「登录有多快」就取决于指纹解析有多快，等于用一个临时尾巴拖慢主路径。所以顺序收在这里：
 *
 *     ① 开关关着 → 立刻返回（不解析指纹、不碰 localStorage、不发请求：默认关的构型零痕迹）
 *     ② await ensureLegacyDeviceFp()  ← **先写指纹**（内部 1.5s 上限，失败静默）
 *     ③ await claimLegacyMigration(token)  ← **再发那一次请求**（`collect.ts` 这时才读得到 deviceFp）
 *     ④ 结果写进 `resultState`（钱包页据此显示「历史额度已迁移：¥X」）
 *
 * ①③ 的顺序是硬要求：`collect.ts` 只认缓存位里**已有**的那一份指纹（它不做异步现算），
 * 所以「先写再发」是 `deviceFp` 能进请求体的唯一保证；反过来发出去的就永远是缺字段的请求。
 *
 * `applySession` 侧只做一件事：`void migrateLegacyAfterLogin(...)`（外加 try/catch 双保险）——
 * 登录不等这一段；跑多久都只影响迁移自己。
 */

import { claimLegacyMigration, isMigrationEnabled } from './claim.js'
import { ensureLegacyDeviceFp } from './deviceFpSlot.js'
import { setLegacyMigrationResult } from './resultState.js'

/**
 * 登录成功后跑一次迁移。
 *
 * @param token 当前会话的 access token（服务端拿它换 `user_id` 当迁移目标）
 * @param isStale 可选：调用方用来回答「这一代会话还算不算数」。中途退出 / 切号后
 *   `store.ts` 会 `sessionEpoch + 1`，回调随之变真 → 这里**不发请求、也不写结果**
 *   （否则 A 的迁移结果会落到 B 的钱包页上，正是 #740 ④ 那类「切号串数据」）。
 *
 * **永不抛**：`isMigrationEnabled` / `ensureLegacyDeviceFp` / `claimLegacyMigration` 都保证不抛，
 * 这里不 catch 是为了让类型保持 `Promise<void>`；调用点仍然 `void` + try/catch（双保险）。
 */
export const migrateLegacyAfterLogin = async (
  token: string,
  isStale: () => boolean = () => false
): Promise<void> => {
  if (!isMigrationEnabled()) {
    return
  }
  // ② 先写指纹：`collect.ts` 是同步只读，请求体里能不能带上 `deviceFp` 全看这一步有没有落盘
  await ensureLegacyDeviceFp()
  if (isStale()) {
    return
  }
  // ③ 再发那一次（只发一次、不重试：重试只能由用户点按钮触发）
  const result = await claimLegacyMigration(token)
  if (isStale()) {
    return
  }
  // ④ 结果给界面（钱包页把 `result` 当 `initial` 传给 `LegacyMigrationButton`）
  setLegacyMigrationResult(result)
}

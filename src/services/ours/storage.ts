/**
 * 最小可注入存储形状：业务层只用到 localStorage 的这三个方法。
 *
 * 为什么单独一个文件：`customerId.ts`（cid 缓存）与 `paymentRecords.ts`（记录页的 cid）
 * 都要用它，而两边都不能 import 对方的业务模块（会成模块环）。
 *
 * Issue #331：这一段原本住在 `orderStore.ts`（未完成订单存档：单号 + order_token）。
 * 支付切到联动小铺后我们不再建单、不再查单，整份订单存档一起删除，
 * 只剩下这层「存储形状」还有用，所以搬到独立文件。
 */

/** 只用到 localStorage 的三个方法：注入假的实现即可在 Node 里测 */
export type OrderStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

/** 浏览器里的 localStorage；没有（Node / 隐私模式抛错）就返回 null，调用方按「没有缓存」处理 */
export const browserStorage = (): OrderStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

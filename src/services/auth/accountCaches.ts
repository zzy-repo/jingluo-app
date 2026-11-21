/**
 * 「这台设备上**跟着账号走**的缓存」清单（Issue #740 ④：A 退出 → B 登录，A 的数据必须全清）。
 *
 * 为什么单独一个文件而不是写在 `store.ts` 里：身份层不该认识每个业务模块的缓存实现
 * （它只认 {@link registerSessionCache} 这张表），而「哪些缓存属于账号」是业务事实 ——
 * 由这份清单集中回答，加缓存的人只改这里一行，`store.ts` 一行都不用动。
 *
 * 现在实际登记的只有**客户编号（cid）**：
 *   - 余额 / 卡密 / 消费记录在当前实现里**没有持久缓存** —— 面板每次挂载都现取服务端
 *     （#484 §4.5 第 10 条：额度只以服务端为准，不缓存、不推导），所以切号时不会看到别人的数字；
 *   - cid（`chat-demo:ours-customer-id` + 内存里那份）是唯一「拿到过就记住」的账号维度数据，
 *     它决定「付款记录里的订单是谁的」—— 不清它，B 登录后会拿 A 的 cid 去查 A 的历史订单。
 *
 * 谁将来加了「余额快照 / 卡密列表缓存 / 消费记录缓存」，**必须**在这里登记；不登记 = 切号串数据。
 * 设备码（`services/invite/device.ts`）**不在**这份清单里：它是设备标识，换账号仍然是同一台设备。
 */

import { cacheCustomerId, resetCustomerIdCache } from '../ours/customerId.js'

import { registerSessionCache } from './sessionCache.js'

/**
 * 登记全部账号级缓存。由 `store.ts` 在模块初始化时调一次
 * （幂等：同一个名字再登记只是覆盖）。
 */
export const registerAccountScopedCaches = (): void => {
  registerSessionCache({
    name: 'ours-customer-id',
    purge: () => {
      // 内存那份（`resolved`）与 localStorage 那份（cid 缓存键）一起清 —— 只清一个等于没清：
      // 下一次 `ensureCustomerId()` 先去读 localStorage，读不到还会去用内存里的旧值。
      resetCustomerIdCache()
      cacheCustomerId(null)
    },
  })
}

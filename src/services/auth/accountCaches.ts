/**
 * 「这台设备上**跟着账号走**的缓存」清单（Issue #740 ④：A 退出 → B 登录，A 的数据必须全清）。
 *
 * 为什么单独一个文件而不是写在 `store.ts` 里：身份层不该认识每个业务模块的缓存实现
 * （它只认 {@link registerSessionCache} 这张表），而「哪些缓存属于账号」是业务事实 ——
 * 由这份清单集中回答，加缓存的人只改这里一行，`store.ts` 一行都不用动。
 *
 * 现在实际登记的有两样：**客户编号（cid）** 与 **内置渠道那把服务端下发的 Key（+下发标记）**。
 *
 * 关于客户编号（cid）：
 *   - 余额 / 卡密 / 消费记录在当前实现里**没有持久缓存** —— 面板每次挂载都现取服务端
 *     （#484 §4.5 第 10 条：额度只以服务端为准，不缓存、不推导），所以切号时不会看到别人的数字；
 *   - cid（`chat-demo:ours-customer-id` + 内存里那份）是唯一「拿到过就记住」的账号维度数据，
 *     它决定「付款记录里的订单是谁的」—— 不清它，B 登录后会拿 A 的 cid 去查 A 的历史订单。
 *
 * 谁将来加了「余额快照 / 卡密列表缓存 / 消费记录缓存」，**必须**在这里登记；不登记 = 切号串数据。
 * 设备码（`services/invite/device.ts`）**不在**这份清单里：它是设备标识，换账号仍然是同一台设备。
 */

import {
  clearServerKeyMark,
  getApiKey,
  getProviderKind,
  setApiKey,
} from '../api/apiConfig.js'
import { usesManagedKey } from '../api/managedKey.js'
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

  /**
   * 「我们的渠道」那把服务端下发的 Key + 下发标记（Issue #803 第 7 条：切号不许带着旧 Key）。
   *
   * 为什么它算账号级：这把 Key **挂在账号上**（`POST /api/v1/keys` 用当前 JWT 建，归属那个账号）。
   * A 退出、B 登录后如果还留着 A 的 Key，B 的每一条消息都会用 A 的 Key 发出去 —— 扣费扣到 A 头上、
   * 失败时用户只看到 401（#596 第 3 条事故就是这个形状）。所以退出登录时**连标记一起清**：
   * 只清 Key 不清标记，下次发送前那道闸会拿旧标记判出一个假的 `stale`。
   *
   * 两条边界：
   *  1. **只在当前渠道是内置服务（`ours`）时清** —— 另外三个渠道的 Key 是用户自己的
   *     （同一格 `chat-demo:api-key`），退出登录把它抹掉等于把人手填的 Key 删了；
   *  2. **幂等、不抛**：本来就没有 Key / 没有标记时也必须算清成功（`sessionCache.purge` 的约定）。
   *
   * 「进行中 / 失败」那块界面状态由 `managedKeyRuntime` 自己登记（`ours-managed-key-ensure`），
   * 这里不越界去清别人的状态。
   */
  registerSessionCache({
    name: 'ours-managed-key',
    purge: () => {
      if (!usesManagedKey(getProviderKind())) {
        return
      }
      if (getApiKey().trim() !== '') {
        setApiKey('')
      }
      clearServerKeyMark()
    },
  })
}

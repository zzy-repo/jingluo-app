/**
 * **账号级缓存**的登记与一键清空（Issue #740 ④「清理与切号」）。
 *
 * 要解决的问题只有一句话：**A 退出、B 登录之后，B 不能看到 A 的余额 / 卡密 / 消费记录**。
 * 这类数据散在各业务模块里（有的在内存、有的在 localStorage），身份层不可能逐个 import 去清 ——
 * 那样每加一个缓存入口就要改一次 `store.ts`，漏一次就是一个「切号串数据」的生产事故。
 * 所以这里做一张**登记表**：谁的缓存属于「某个账号」，谁在模块初始化时 `registerSessionCache()`，
 * 身份层清态（退出 / 刷新被拒）时只调 `purgeSessionCaches()` 一次。
 *
 * 三条约定，都是硬要求：
 *  1. **清态的唯一出口是 `store.ts` 的 `clearSession`**：别在别处自己调 `purgeSessionCaches()`
 *     （两处出口 = 总有一天有一处漏掉）；`signOut` / 刷新被拒 / 凭据损坏都走 `clearSession`。
 *  2. **`purge` 必须幂等、不许抛**：这里对每个缓存做了 try/catch，但缓存自己也不该依赖「第二次调用
 *     的时候数据还在」—— 清一个本来就不存在的东西必须是成功的。
 *  3. **`name` 只用于排查与断言**：不许把 token / 邮箱 / 余额写进 `name`（#387 红线：日志与埋点里
 *     不放凭据类与可识别信息）。
 *
 * 什么该登记、什么不该：
 *   - 该：从服务端取回来、**跟着账号走**的数据（本机余额快照、卡密列表缓存、消费记录、cid …）；
 *   - 不该：设备级标识（`services/invite/device.ts` 的设备码：换账号它还是同一台设备）、
 *     服务端下发的全局开关（`settings/public`）、用户自己的界面偏好（主题 / 字号）、
 *     **本地聊天记录**（那是这台机器上的会话草稿，与账号无关，也不上云）。
 */

/** 一个「属于某个账号」的缓存：名字只用于排查，`purge` 负责把它彻底清掉（幂等、不抛） */
export type SessionCache = {
  name: string
  purge: () => void
}

const registry = new Map<string, () => void>()

/**
 * 登记一个账号级缓存（同一个 `name` 重复登记 = 覆盖，便于热更新与测试反复装配）。
 * 在模块初始化时调一次即可（见 `accountCaches.ts`）。
 */
export const registerSessionCache = (cache: SessionCache): void => {
  registry.set(cache.name, cache.purge)
}

/** 撤掉登记（测试 / 模块卸载用；产品路径不需要） */
export const unregisterSessionCache = (name: string): void => {
  registry.delete(name)
}

/** 已登记的缓存名（排查 / 断言用；**不含任何用户数据**） */
export const sessionCacheNames = (): string[] => [...registry.keys()]

/**
 * 清空全部已登记的账号级缓存，返回真正清掉的缓存名。
 *
 * 单个缓存清失败**不中断**其余缓存：能清一个是一个，而且清态是「退出登录」这条路上的必经步骤 ——
 * 不能因为某个业务的缓存实现有 bug，就让整条退出流程抛错、把用户留在登录态里。
 */
export const purgeSessionCaches = (): string[] => {
  const purged: string[] = []
  for (const [name, purge] of registry) {
    try {
      purge()
      purged.push(name)
    } catch {
      // 清不掉就算了：下次登录读到的是**新的**账号数据（缓存键都带账号维度或每次现取）
    }
  }
  return purged
}

/** 测试用：清空登记表（不进产品路径） */
export const resetSessionCacheRegistry = (): void => {
  registry.clear()
}

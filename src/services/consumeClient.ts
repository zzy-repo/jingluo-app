/**
 * 全应用**共用的** sub2api 消费层客户端（W1-B 后半，Issue #487）。
 *
 * 为什么要有这个文件：消费层客户端需要两个「每次请求现取」的凭据提供者 ——
 * JWT（`src/services/auth/store.ts`）与 sk- Key（`src/services/api/apiConfig.ts`）。
 * 谁先需要谁 new 一个 `createConsumeClient(...)` 也能跑，但那样每个界面模块各持一份传输实例，
 * 排查问题时很难说清「这条请求是哪份实例发的」。这里只留一个懒加载单例，接线处
 * （`src/main.tsx`）与界面（设置页额度）拿到的是同一个。
 *
 * 三条边界，都是有意为之：
 *  1. **不在本文件放业务逻辑**：只有「组装 + 复用」，请求命中哪些端点在 `services/consume/**`；
 *  2. **凭据只在调用瞬间取**：传的是函数不是值，JWT 续期 / 换 Key 之后下一条请求立刻生效；
 *  3. **不碰存储**：凭据存哪儿是 store / apiConfig 的事，这里连 localStorage 都不 import。
 *
 * 第四个参数 `onUnauthorized` 是 Issue #740 的接线（401 → 单飞刷新 → 重放）：
 * 传输层只认状态码，刷新策略与单飞都在身份层（`auth/store.ts` 的 `handleUnauthorized`），
 * 本文件只负责把两边接起来 —— **不接这一行就等于没做 #740**（401 会照旧直接抛给界面）。
 */

import { getApiKey } from './api/apiConfig.js'
import { getAccessToken, handleUnauthorized } from './auth/store.js'
import { createConsumeClient, type ConsumeClient } from './consume/index.js'

let client: ConsumeClient | null = null

/** 取共享客户端（首次调用时创建）。凭据提供者在每次请求时求值，不会把旧 token 缓存下来。 */
export const getConsumeClient = (): ConsumeClient => {
  client ??= createConsumeClient({
    accessToken: getAccessToken,
    apiKey: getApiKey,
    onUnauthorized: handleUnauthorized,
  })
  return client
}

/** 测试 / 特殊场景替换实现；传 null 则下次 `getConsumeClient()` 重新按默认参数创建 */
export const setConsumeClient = (next: ConsumeClient | null): void => {
  client = next
}

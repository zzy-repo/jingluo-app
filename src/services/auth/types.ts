/**
 * 身份层（JWT 账号）的类型 —— W1-B 前半，Issue #487（执行）/ #482（定调：身份从 `device_id` 改为 JWT 账号）/
 * #484 §3.1（账号与身份端点白名单）。
 *
 * 三条边界（本文件只放类型，不放行为）：
 *  1. **凭据只走 header**：`Authorization: Bearer <access_token>`，JWT 与 `sk-` Key 是**两条独立通道**，
 *     互相不认（#484 §二）。所以这里只有 token，没有 device_id、没有 cookie 相关字段。
 *  2. **金额 / 状态一律服务端说了算**：`AuthUser` 只做展示，不在客户端推导额度（#484 §七 第 6 条）。
 *  3. **上了屏的东西必须是 i18n key**：`AuthError.message` 只进日志，`AuthError.messageKey` 才是界面文案。
 *
 * 真实响应依据（2026-11-20 本地实例 `127.0.0.1:18000`，0.2.22 同版本，curl 实测）：
 *   POST /api/v1/auth/login → `{"code":0,"message":"success","data":{
 *     "access_token":"eyJ…","refresh_token":"rt_…","expires_in":86400,"token_type":"Bearer",
 *     "user":{"id":2,"email":"…","username":"","role":"user","balance":100,"concurrency":5,"status":"active"}}}`
 *   POST /api/v1/auth/refresh → 同上但**没有 `user`**（只有 token 三件套）
 *   GET  /api/v1/user/profile → 用户对象（`identities.email.bound` 表示邮箱已绑；#676 §二：没有 `/auth/me`）
 *   401 → `{"code":401,"message":"invalid refresh token","reason":"REFRESH_TOKEN_INVALID"}`
 */

import type { TranslationKey } from '../../i18n/index.js'
import type { ConsumeErrorKind } from '../consume/errors.js'

/**
 * 访问凭据（JWT）。
 *
 * **只允许出现在两处**：`store.ts` 的内存快照、以及安全存储的落盘值（与 API Key 同级，见 store.ts 的
 * `AuthTokenStorage`）。不许进 IndexedDB 明文、不许进日志 / 埋点 / DOM 文本（#484 §二、§七 第 4 条）。
 */
export type AccessToken = {
  accessToken: string
  /** 刷新凭据；服务端不给时为 undefined（那就到点直接回登录页，不做静默重试） */
  refreshToken?: string
  /** 服务端原样给的 `token_type`（实测 `Bearer`），拼 header 时用，不自己写死 */
  tokenType: string
  /**
   * 到期时刻（epoch ms），由 `expires_in`（**秒**）换算。
   * `null` = 服务端没给有效期 → 不主动预刷新，只在 401 后按会话过期处理。
   */
  expiresAt: number | null
}

/**
 * 当前账号。字段名与 sub2api 的 `User` DTO 对齐（camelCase），snake_case 只在传输层出入口转换一次。
 *
 * 注意：登录 / 注册的成功体里**没有** `emailVerified`，只有 `/user/profile` 的
 * `identities.email.bound` 能给；所以它可能是「还不知道」——用 `null` 表达，不要拿 `false` 冒充。
 */
export type AuthUser = {
  id: number
  email: string
  username?: string
  role?: string
  /** 邮箱是否已验证 / 已绑定：`null` = 本次响应没给这个信息 */
  emailVerified: boolean | null
  /** 注册时间（服务端 ISO 字符串，原样展示 / 排查用） */
  createdAt?: string
}

/**
 * 登录态四态（**没有** `idle` / `loading`：加载与提交是 `store` 的 `submitting` / `restored`，
 * 这里只描述「身份本身处于哪一步」，避免界面按状态字符串猜）。
 */
export type AuthState =
  /** 没有凭据 → 该显示登录页 */
  | 'unauthenticated'
  /** 正在登录 / 注册 / 启动恢复中 */
  | 'authenticating'
  /** 有凭据且可用 → 放行主界面 */
  | 'authenticated'
  /** 有过凭据但已失效（过期 / 刷新失败 / 被踢下线）→ 回登录页，且值得给一句「需要重新登录」 */
  | 'expired'

/**
 * 归一化后的失败类别。**按 code 分派，不按服务端 message 分派**（#484 §四：中英文案随版本改）。
 *
 * 直接复用 W1-A 的 `ConsumeErrorKind`（`auth | quota | rate_limit | redeem | key | server | network |
 * bad_request | unknown`）—— 两套并存只会让「同一个 401 在两层里叫两个名字」：
 *   - `auth`：JWT 不认（过期 / 被踢 / 账号停用）→ **清态回登录页**（`store.ts` 只认这一条）
 *   - `rate_limit` / `network`：`retryable` 为 true 的那一类，可以让用户再点一次
 *   - `unavailable` 是本层自己加的：传输层还没接线，**不是**用户的错，文案也不该说「账号或密码错误」
 */
export type AuthErrorKind = ConsumeErrorKind | 'unavailable'

/**
 * 归一化失败。界面上只读 `messageKey`；`code` / `message` / `status` 只用于日志与排查。
 *
 * `messageKey` 由传输层（W1-A 的 `src/services/consume/auth.ts`）从 `Sub2ApiError.i18nKey`
 * 映射过来，值域就是已经合并的 `sub2auth*` 词条（commit `9a0e470`）—— 界面不自己拼文案。
 */
export type AuthError = {
  kind: AuthErrorKind
  /** 服务端原样给的码（`TOKEN_EXPIRED` / `INVALID_TOKEN` / `REFRESH_TOKEN_INVALID`…）；没拿到时是 `HTTP_<status>` / `NETWORK` */
  code: string
  /** 服务端原始 message：**只进日志，不上屏** */
  message: string
  /** HTTP 状态码；0 = 没拿到响应 */
  status: number
  /** 重试是否有意义（限流 / 网络）；`unauthorized` 恒为 false —— 刷新失败就清态回登录，不静默重试 */
  retryable: boolean
  /** 唯一该上屏的东西 */
  messageKey: TranslationKey
}

/** 「没有返回体」的成功态（logout / sendCode）：用它代替 `void` 作泛型参数 */
export type AuthDone = undefined

/**
 * 传输层统一返回形状：**不抛异常**。
 *
 * 与 W1-A 的 `ConsumeCallResult<T>`（`{ok:true,data,…}` / `{ok:false,error,…}`）结构兼容，
 * 接线时只需去掉 `status` / `raw` 两个排查字段（见 `transport.ts` 的 TODO(W1-A)）。
 */
export type AuthResult<T> = { ok: true; data: T } | { ok: false; error: AuthError }

/** 一次成功登录 / 注册拿到的完整会话 */
export type AuthSession = {
  token: AccessToken
  user: AuthUser
}

# 消费层（`src/services/consume/**`）客户端契约

> Issue #484（约束）→ Issue #487 W1-A（实现）。**这份文档是 W1-B / W1-C 依赖的公开接口说明**：
> 谁要用消费侧后端，只走这一层；层外的任何 `fetch` / 手拼地址都是违规（`pnpm check:consume-api` 会红）。

## 一、两个后端，职责不重叠（#482 定调）

| 后端 | 干啥 | 客户端怎么用 |
| --- | --- | --- |
| **sub2api**（`consume.baseUrl`） | 账号、额度、卡密兑换、Key 管理 | 本层 `auth` / `keys` / `usage` / `redeem` / `aff` / `email` |
| **apia**（`pay.baseUrl`） | **只负责买**：套餐、收款页、订单、卡密溯源 | 仍走 `src/services/ours/**`（W1-E 收口），地址从 `__ENDPOINTS__.pay.baseUrl` 取 |

**当前 `consume.baseUrl` = `http://127.0.0.1:18000`（本地联调实例）**。这是 `https` 规则的**唯一例外**
（只对回环成立）；真机 / 正式包的 https 域名**待维护者提供**，出包前必须替换，否则手机上连的是它自己。

## 二、怎么用（W1-B / W1-C 的唯一入口）

```ts
import { createConsumeClient } from '../services/consume/index.js'

const consume = createConsumeClient({
  accessToken: () => session.accessToken, // JWT 提供者（登录态存哪由 W1-B 决定）
  apiKey: () => localApiKey,              // 只给 /v1/** 用
})

await consume.settings.get()                       // 启动时读功能开关
await consume.auth.login({ email, password })      // → { accessToken, refreshToken, user, … }
await consume.keys.list({ page: 1, pageSize: 20 }) // → ConsumePage<ConsumeApiKey>
await consume.usage.gateway()                      // sk- Key → /v1/usage（额度唯一入口）
await consume.redeem.redeem({ code })              // 幂等补偿版兑换
```

每个函数也可以单独 import（`import { login } from '../services/consume/auth.js'`），第一个参数是
`createConsumeHttp(...)` 的产物。**所有函数都返回 `ConsumeCallResult<T>`**：

```ts
type ConsumeCallResult<T> =
  | { ok: true; data: T; status: number; raw: ConsumeRawResponse }
  | { ok: false; error: Sub2ApiError; raw: ConsumeRawResponse }
```

不抛异常（配置错误除外：`ConsumeConfigError` 是启动期问题，应当早死）。

## 三、公开接口清单

| 模块 | 导出 | 端点 | 鉴权 | 可重试 |
| --- | --- | --- | --- | --- |
| `auth` | `getPublicSettings` | `GET /api/v1/settings/public` | 无 | ✅ 只读 |
| | `register` | `POST /api/v1/auth/register` | 无 | ❌ 无幂等键 |
| | `login` / `loginWithTwoFactor` | `POST /api/v1/auth/login`、`/login/2fa` | 无 | ⚠️ 仅传输层，≤1 次 |
| | `sendVerifyCode` | `POST /api/v1/auth/send-verify-code` | 无 | ❌ 靠服务端频控 |
| | `refresh` | `POST /api/v1/auth/refresh` | refresh_token | ❌ 失败即清登录态 |
| | `forgotPassword` / `resetPassword` | `POST /api/v1/auth/forgot-password`、`/reset-password` | 无 | ❌ |
| | `me` / `getProfile` | `GET /api/v1/auth/me`、`/user/profile` | JWT | ✅ |
| | `revokeAllSessions` | `POST /api/v1/auth/revoke-all-sessions` | JWT | ⚠️ |
| `keys` | `listKeys` / `getKey` | `GET /api/v1/keys`、`/keys/:id` | JWT | ✅ |
| | `createKey` | `POST /api/v1/keys` | JWT | ❌ 先查重（`dedupe`，默认开） |
| | `updateKey` | `PUT /api/v1/keys/:id` | JWT | ⚠️（无 `key` 字段，换值只能新建再删） |
| | `deleteKey` | `DELETE /api/v1/keys/:id` | JWT | ✅ 404 视为已完成 |
| `usage` | `getGatewayUsage` | `GET /v1/usage` | **sk- Key** | ✅ |
| | `listUsage` / `getUsageStats` / `getUsageDashboard` / `getKeyDailyUsage` | `GET /api/v1/usage*`、`/user/api-keys/:id/usage/daily` | JWT | ✅ |
| `redeem` | `redeemCode` | `POST /api/v1/redeem` | JWT | ❌ **绝不盲重试** |
| | `getRedeemHistory` / `verifyCredited` | `GET /api/v1/redeem/history` | JWT | ✅ |
| `aff` | `validateInvitationCode` | `POST /api/v1/auth/validate-invitation-code` | 无 | ❌ |
| | `getAffiliate` | `GET /api/v1/user/aff` | JWT | ✅ |
| `email` | `sendBindEmailCode` / `bindEmail` / `unbindProvider` | `POST /api/v1/user/account-bindings/email/send-code`、`…/email`、`DELETE …/:provider` | JWT | ❌ / ⚠️ |

白名单**之外**一律禁止（含 `/api/v1/admin/**`、`/api/v1/payment/**`）。新增能力走 #484 重新评审。

## 三点五、写操作的「效果确认」：2xx ≠ 生效（#679）

判据只看 HTTP 状态是本层以前最贵的一类错（#660 的邮箱绑定 200 + 空体 → 界面说「已绑定」，
实际没落库）。现在所有写操作统一走 `confirmEffect.ts`：

```
accept(响应体) → 仍无证据 → probe() 回查一次 → 仍无证据 → confirmed: false
```

- **回查最多一次**：`confirmEffect` 内部只调一次 `probe`，没有循环、没有重试（写后查询放大是 #484 §4.3 的教训）；
- **不认识证据就当没证据**：`accept` 返回 `undefined` = 这个响应体里没有可信证据，不是「大概成了」；
- **回查失败 ≠ 生效**：结论是「未知」，文案要给下一步（重试 / 重新登录验证 / 去账号页核对）；
- 每个调用点的判据、理由、例外都登记在 `CONSUME_EFFECT_POLICIES`（`confirmEffect.ts`），
  `tests/unit/consume-confirm-effect-679.test.mjs` 有一条 drift 守卫：**标了例外的点不许调 `confirmEffect`**、
  其余点必须调。

| 调用 | 已确认的判据 | 回查 |
| --- | --- | --- |
| `revokeAllSessions` | 同一个 JWT 打 `GET /user/profile` 回 401/403（凭据确实失效） | ✅ 一次 |
| `unbindProvider` | `identities[provider].bound === false` | ✅ 一次 |
| `updateKey` | `GET /keys/:id` 的可验证字段（name / group_id / status / quota / ip_* / expires_at）全一致 | ✅ 一次 |
| `deleteKey` | `GET /keys/:id` 回 404（还 200 = 没删，**继续计费**） | ✅ 一次 |
| `sendBindEmailCode` / `sendVerifyCode` / `forgotPassword` / `resetPassword` | **例外**：纯通知类，无实体、无回查手段、重发无副作用 → 只信 2xx | — |

「未确认」一律 `ok: false` + 专门的 `consumeErr*Unconfirmed` 文案，界面**不许**把它显示成成功；
`revokeAllSessions` 这条是**安全语义**（撤销失败却说「已退出所有设备」），文案还必须给出下一步。

## 四、卡密兑换的四态（`ConsumeRedeemOutcome`）

sub2api 的兑换**没有幂等键**（请求体只有 `{code}`），所以：

| 结果 | 含义 | 界面该怎么显示 |
| --- | --- | --- |
| `redeemed` | 成功；`credited: 'response'` 直连成功，`'history'` 是超时后查历史确认已到账 | 成功 + 提示刷新额度（`refreshUsage: true`） |
| `processing` | `409 REDEEM_CODE_LOCKED`：服务端正在处理 | **不是失败**，禁止提示换卡 |
| `pending` | 超时 / 5xx 且历史里查不到：结果不明 | 提示「请稍后到账，若未到账可重试」；重试要用户手动确认（`retryAfterConfirm: true`） |
| `failed` | 明确的业务失败（码不存在 / 过期 / 已用） | 按 `error.i18nKey` 出文案；`REDEEM_CODE_USED` 必须补一句「若余额已增加，无需重复兑换」 |

## 五、错误信封：**四套 JSON + 一套纯文本**

`parseSub2ApiError(res)` 按形状分派（细节与真实样本见 `src/services/consume/errors.ts` 文件头）：

| 形状 | 例子 | `envelope` |
| --- | --- | --- |
| 面板整数 `code` | `{"code":404,"message":"redeem code not found","reason":"REDEEM_CODE_NOT_FOUND"}` | `panel` |
| 中间件字符串 `code` | `{"code":"UNAUTHORIZED","message":"Authorization header is required"}` | `middleware` |
| 网关 `{error:{…}}` | `{"error":{"code":"model_not_found",…}}`；**也可能只有 `type`**（`permission_error`） | `gateway` |
| 429 `{error:"<字符串>"}` | `{"error":"rate limit exceeded","message":"…"}` + `Retry-After: 42`，**没有 `code`** | `error_string` |
| **纯文本** | 未知路径 `404 page not found`（`text/plain`）；边缘反代 Basic 401 | `text` |

三条硬规则：

1. **先看 `content-type` 再 `JSON.parse`**（纯文本响应解析会抛）；
2. **只按 `code` 分支，永不匹配 `message`**（401 有用户 / admin / 网关三种 message，code 相同）；
3. **429 没有 `code`** —— 按状态码分支，并按 `Retry-After` 倒计时（`error.retryAfterMs`）。

归一化结果 `Sub2ApiError = { kind, code, reason?, message, status, retryable, envelope, retryAfterMs?, i18nKey }`。
`i18nKey` 是 `ConsumeMessageKey`（`consumeErr*` 一族）——**W1-C 负责把这些 key 补进 `src/i18n/*.ts`**，
本层不拼文案、不碰 DOM。映射表覆盖不到的服务端码会进缺口清单（`unmappedConsumeCodes()`），
诊断层可用 `setConsumeGapReporter()` 接上报。

## 六、字段真值：哪些是实测、哪些仍是推测

| 数据 | 来源 | 状态 |
| --- | --- | --- |
| `POST /api/v1/auth/login` 200 | 本地实例 0.2.20 | ✅ 实测：`access_token` / `refresh_token` / `expires_in` / `token_type` / `user` |
| `GET /api/v1/auth/me`、`/user/profile` 200 | 本地实例 | ✅ 实测：`User` + `identities{provider:{bound,can_bind,can_unbind,…}}` |
| `GET /api/v1/keys` 200 | 本地实例 | ✅ 实测：`PaginatedData{items,total,page,page_size,pages}` + `APIKey` 全字段 |
| `GET /api/v1/usage` 200 | 本地实例 | ✅ 实测：分页信封（`items` 字段因无用量未观测到） |
| `POST /api/v1/redeem` 404 | 本地实例 | ✅ 实测：`{code:404,message,reason:"REDEEM_CODE_NOT_FOUND"}` |
| `GET /v1/usage` 200 | 本地 + 线上 | ✅ 实测：**无 `rate_limits` 键**；`quota.used` 恒 0，真实花费用 `usage.total.actual_cost` |
| `POST /auth/register`、`/auth/refresh` 200 | — | ⚠️ **推测**（按同一 `AuthResponse` 处理；本地实例允许注册，但为验字段没建账号） |
| `POST /api/v1/keys` 200 | 本地实例 | ✅ 实测（与 `GET /keys` 的单条同形） |
| `DELETE /api/v1/keys/:id` 200 | 本地实例 | ✅ 实测：`{code:0,data:{message}}`（不是 204） |
| `POST /api/v1/user/account-bindings/email*` | — | ⚠️ **推测**（实测环境邮箱已验证、不允许解绑，未发真实邮件） |

⚠️ `/health` **不可依赖**：本地 0.2.20 有 `{"status":"ok"}`，线上 0.2.22 是 404。它也不在白名单里。

## 七、鉴权与传输

- **两条独立通道**：`/api/v1/**` 用 JWT（`Authorization: Bearer <access_token>`），`/v1/**` 用 sk- Key。
  两套之间**没有重写规则**，不许混用（JWT 打 `/v1/usage` → 401 `INVALID_API_KEY`）。
- **JWT 只进 header**：本地实例 CORS 实测 `Access-Control-Allow-Origin: *` 但**没有**
  `Allow-Credentials`，所以浏览器侧靠 cookie 带身份是不可能的；也不许把 Key / JWT 放进 query
  （sub2api 直接 400 `api_key_in_query_deprecated`）。
- **必须走原生 `CapacitorHttp`**：CORS 默认配置下 WebView 裸 `fetch` 会失败；本层没有 fetch 兜底，
  非原生环境返回 `kind: 'unsupported'`。
- **超时只从配置读**：`consume.timeoutMs.read / write / redeem`（默认 10s / 20s / 30s）。调用点写死毫秒数会被 review 打回。
- **Token 存哪儿**：W1-B 决定，但底线是「与 Key 同一安全等级，不许明文进 IndexedDB，不进日志 / 埋点 / DOM」。

## 八、门禁

```
pnpm check:consume-api            # 白名单 + 地址零副本 + 废弃域 + 明文 http + device_id + query 凭据 + 原生注入
node scripts/check-consume-api.mjs --strict    # 连「旧路径豁免」也算红（W1-D 清理完后切这个）
node scripts/check-consume-api.mjs --selftest  # 负向对照：塞一条 pay.baseUrl → 必红，删掉 → 必绿
```

构建期另有一道 fail-fast：`scripts/build.mjs` 在打包前用同一套判据校验 `config/endpoints.json`
（缺字段 / 未知键 / 明文 http / 两个 base 相同 → 直接 exit 1，报**键名 + 行号**）。
原生侧 `android/app/build.gradle` 生成 `BuildConfig.CONSUME_BASE` / `BuildConfig.PAY_BASE`
（`buildFeatures { buildConfig true }` 是必须项，AGP 8 默认关闭）。

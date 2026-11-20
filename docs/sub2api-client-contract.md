# sub2api 客户端接口契约（约束文档）

> **本文件是约束，不是实现；客户端调用集合必须是本文白名单的子集。**
> 任何一行 `src/**` 里出现的后端路径，都必须能在 §3 白名单里找到对应行；找不到就是违规。
>
> 本文由 Issue #484（约束正文）成文而来，证据来自对 `felix4396/sub2api-private`（private，
> LGPL-3.0，`main` @ `6b4b37d`）的接口面研究。**sub2api 是他人仓库，本客户端不改它、不向它提 PR。**

| 项 | 值 |
| --- | --- |
| 约束来源 | Issue #484 §一～§七（原文口径，不增删语义） |
| 实施单 | Issue #487（W1-A 配置与消费层 / W1-B 身份层 / W1-C UI / W1-D 清理 / W1-E 支付） |
| 证据基线 | sub2api-private `main` @ `6b4b37d`（`chore: sync VERSION to 0.2.20`）；研究文档附录 A 给全部代码位置 |
| 证据写法 | 本文「来源」列的 `routes/…`、`handler/…`、`middleware/…`、`service/…`、`server/…` 等**均相对于被研究对象 `sub2api-private` 仓库根**，不是本仓库路径；本仓库路径一律以 `docs/`、`config/`、`src/`、`scripts/` 开头 |
| 作用域 | 客户端（Web + Android 原生壳）对 apia / sub2api 的**全部**出站 HTTP 调用 |
| 不作用域 | 分发包下载（见 `config/endpoints.json` 的 `download`，机制见 #269）；第三方 OAuth 跳转页 |

**怎么用这份文档**

1. 写调用点之前先查 §3；表里没有的路径，**先去改本文**（流程见 §8），再写代码。
2. 传输层/配置问题查 §6；跨切面的红线查 §7。
3. 本文与 Issue #484 冲突时以本文为准（本文是成文版，差异在 #484 的评论里记录）；与 sub2api 代码冲突时以**代码**为准，并回来改本文。

---

## 1. 后端边界（唯一事实）

| 后端 | base | 用途 | 客户端可调 |
| --- | --- | --- | --- |
| **apia** | `https://apia.ecsafe.cn` | **只负责买**：套餐、下单、支付、发卡密、订单查询 | ✅ 仅白名单内（§3.5） |
| **sub2api** | 由 `config/endpoints.json` 的 `consume.baseUrl` 提供（host 待维护者定） | **账号 / 额度 / 卡密兑换 / Key 管理 / 用量** | ✅ 仅白名单内（§3.1～§3.4、§3.6） |
| 旧池域 | `140.210.13.146:60013` | **废弃** | ❌ **一律禁止调用**（源码出现即门禁红） |

三条推论（不是建议，是约束）：

1. **两套后端职责不许混**：`consume.baseUrl` 与 `pay.baseUrl` 不得相同，构建期校验（§6.3 第 3 条）。
2. **一个 host 承载两套前缀**：sub2api 的 `/api/v1`（JWT）与 `/v1`（sk- Key）在**同一个 host** 上，中间没有重写规则（`server/router.go` 的 `v1 := r.Group("/api/v1")` 与网关 group 是两处独立注册）。所以配置里只需要一个 `baseUrl` + 两个前缀常量。
3. **旧池域没有过渡期**：`device_id` 体系随旧池域一起废弃（§7 第 3 条）。要读额度只能走 `/v1/usage` 或 `/api/v1/user/profile`。

---

## 2. 鉴权（两条独立通道，不许混用）

| 通道 | 路径前缀 | 认证头 | 用在哪 |
| --- | --- | --- | --- |
| **JWT** | `/api/v1/**` | `Authorization: Bearer <access_token>`，**仅 header**（cookie 无效） | 登录/注册、账号、Key 管理、卡密兑换、用量列表 |
| **API Key** | `/v1/**` | `Authorization: Bearer sk-…`（备选 `x-api-key`，再备选 `x-goog-api-key`） | 聊天转发、`/v1/usage` |

来源：JWT 只认 header 见 `middleware/jwt_auth.go:40-52`；API Key 三段退化顺序与「拒绝写进 query」见
`middleware/api_key_auth.go:56-101`；Key 由 `POST /api/v1/keys` 发放（`sk-` + 32 字节 hex，
`service/api_key_service.go:395-400`，长度上限 128B 见同文件 `api_key_service.go:50`）。

**硬性**

- **`.well-known` 之外不许把 key 放 query**：`?key=` / `?api_key=` 直接 400 `api_key_in_query_deprecated`（`middleware/api_key_auth.go:56-60`）。
- **不许把 JWT 存进 IndexedDB 明文**：用现有安全存储，或至少与 Key 同一等级；JWT 与 Key 分开存、分别清理。
- **token 过期用 `POST /api/v1/auth/refresh` 刷新；刷新失败就清登录态并回登录页**，不要静默重试、不要在弹窗里自动轮询。
- **两套不许互串**：拿 JWT 打 `/v1/usage` → `401 INVALID_API_KEY`；拿 sk- Key 打 `/api/v1/keys` → `401 INVALID_TOKEN`。串了就是客户端 bug，不是用户错。
- Key/卡密只露尾：Key 6 位、卡密 4 位（既有 `mask` 约定，见 `src/services/ours/mask.ts`）。

---

## 3. 端点白名单（客户端**只允许**调这些）

匹配口径：**方法 + 路径模板**精确匹配。表中 `:id` 是单段占位符，`*` 是前缀通配且**只通配到本文列出的层级**
（例：`/api/v1/usage/dashboard/*` 允许 `/usage/dashboard/model`，不允许 `/usage/dashboard/../../admin`）。
查询串不受限（除 §2 禁止把 key 放 query）。**表外的任何端点禁止调用**，包括「看起来应该有」的那些（清单见 §3.7）。

### 3.1 账号与身份（JWT）

| 方法 | 路径 | 用途 | 来源 |
| --- | --- | --- | --- |
| GET | `/api/v1/settings/public` | 启动时读功能开关（`registration_enabled` / `email_verify_enabled` / `api_base_url`） | `routes/auth.go:246`；响应 DTO `handler/dto/settings.go:367-407` |
| POST | `/api/v1/auth/register` | 注册（可带 `verify_code` / `invitation_code` / `aff_code`；限流 5/min） | `routes/auth.go:35`；`handler/auth_handler.go:50-60,94-100` |
| POST | `/api/v1/auth/login` | 登录（限流 20/min） | `routes/auth.go:38`；`handler/auth_handler.go:77-83` |
| POST | `/api/v1/auth/login/2fa` | 2FA（限流 20/min） | `routes/auth.go:41` |
| POST | `/api/v1/auth/send-verify-code` | 发邮箱验证码（无鉴权，5/min） | `routes/auth.go:50`；`handler/auth_handler.go:63-68` |
| POST | `/api/v1/auth/refresh` | 刷新 token（限流 30/min） | `routes/auth.go:54` |
| POST | `/api/v1/auth/forgot-password` | 找回密码第一步（5/min） | `routes/auth.go:68` |
| POST | `/api/v1/auth/reset-password` | 找回密码第二步（10/min） | `routes/auth.go:72` |
| GET | `/api/v1/auth/me` | 当前用户 | `routes/auth.go:257` |
| POST | `/api/v1/auth/revoke-all-sessions` | 退出所有设备 | `routes/auth.go:259` |
| GET | `/api/v1/user/profile` | 账号资料 / 邮箱绑定态 / 余额（USD） | `routes/user.go:31`；`handler/user_handler.go:533-565` |

### 3.1b 邀请体系（复用 sub2api，本地仅 UI）

| 方法 | 路径 | 鉴权 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/validate-invitation-code` | 无（10/min） | 注册前预校验邀请码（返回 `valid` / `error_code`；`INVITATION_CODE_DISABLED` = 功能未开） | `routes/auth.go:64`；`handler/auth_handler.go:539-560` |
| POST | `/api/v1/auth/register`（带 `invitation_code` / `aff_code`） | 无（5/min） | **邀请关系只能在注册时一次填定** | `routes/auth.go:35`；`service/auth_service.go:281,994`（`BindInviterByCode`） |
| GET | `/api/v1/user/aff` | JWT | 我的邀请：`aff_code` / `aff_count` / `aff_quota`（返利按 USD） | `routes/user.go:41`；`service/affiliate_service.go:87-100` |

**语义变化（UI 跟着改）**

- 旧：「填别人的邀请码 → 我立刻得积分」。新：邀请码在**注册时**填，返利按 USD 比例结算，入口在「我的邀请」页展示（`effective_rebate_rate_percent`，`service/affiliate_service.go:293-328`）。
- `circular_invite` / `already_redeemed` 这类旧文案**不再适用，删掉**。
- **未找到**「登录后补填邀请码」的端点 —— 不要试图用别的方式实现它（研究结论，见 §3.7）。

### 3.1c 邮箱体系（复用 sub2api，本地仅 UI）

| 方法 | 路径 | 鉴权 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/auth/send-verify-code` | 无（5/min） | 注册验证码 | `routes/auth.go:50` |
| POST | `/api/v1/user/account-bindings/email/send-code` | JWT | 绑定/换绑邮箱发码 | `routes/user.go:43` |
| POST | `/api/v1/user/account-bindings/email` | JWT | 提交 `{email, code}` 完成绑定 | `routes/user.go:44` |
| DELETE | `/api/v1/user/account-bindings/:provider` | JWT | 解绑 | `routes/user.go:45` |

**功能开关**：注册是否必须验邮箱由 `GET /api/v1/settings/public` 的 `email_verify_enabled` 决定，
**本地不写死**（DTO 见 `handler/dto/settings.go:367-407`）。

### 3.1d 功能开关（启动时必读）

`GET /api/v1/settings/public` → `registration_enabled` / `email_verify_enabled` / `invitation_code_enabled` /
`turnstile_enabled` / `turnstile_site_key` / `tencent_captcha_enabled` / `site_name` / `api_base_url` …
**客户端所有「入口是否显示」都由它决定**，本地不维护第二份开关（§7 第 7 条）。

### 3.2 Key 管理（JWT）

| 方法 | 路径 | 用途 | 来源 |
| --- | --- | --- | --- |
| GET | `/api/v1/keys` | 列表（分页 `page` / `page_size` / `search` / `status` / `group_id` / `sort_*`） | `routes/user.go:85`；分页形状 `pkg/response/response.go:25-32` |
| POST | `/api/v1/keys` | 创建（`name` 必填；`quota`(USD, 0=不限)、`expires_in_days`、`group_id`、可选 `custom_key`） | `routes/user.go:87`；`handler/api_key_handler.go:34-47` |
| GET | `/api/v1/keys/:id` | 详情 | `routes/user.go:86` |
| PUT | `/api/v1/keys/:id` | 改名/停用/改额度（**请求体没有 `key` 字段**，无法原位换值） | `routes/user.go:88`；`handler/api_key_handler.go:50-59` |
| DELETE | `/api/v1/keys/:id` | 删除 | `routes/user.go:89` |

`APIKey` DTO 关键字段（`handler/dto/types.go:56-75`）：`{id, user_id, key, name, group_id, status,
quota(USD，0=不限), quota_used(USD), expires_at, last_used_at, …}`。**`quota:0` = 不限，不是零额度。**

### 3.3 额度与用量

| 方法 | 路径 | 鉴权 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| GET | `/v1/usage` | **sk- Key** | 额度/余额（**扁平 JSON，不套 `data` 外壳**） | `routes/gateway.go:210`；`handler/gateway_handler.go:1592-1655,1706-1861` |
| GET | `/api/v1/usage` | JWT | 用量列表 | `routes/user.go:109-119` |
| GET | `/api/v1/usage/stats` | JWT | 用量汇总 | 同上 |
| GET | `/api/v1/usage/dashboard/*` | JWT | 面板式统计 | 同上 |
| GET | `/api/v1/user/api-keys/:id/usage/daily` | JWT | 单 Key 日用量 | `routes/user.go:47` |

`GET /v1/usage` 的三种形态（**解析器必须全兼容**，来源 `handler/gateway_handler.go:1706-1861`）：

- `mode:"quota_limited"` → `quota:{limit,used,remaining,unit:"USD"}` + `rate_limits[]`（`gateway_handler.go:1706-1790`）
- 订阅组 Key → `mode:"unrestricted"` + `subscription:{daily_usage_usd,…}`（`gateway_handler.go:1799-1837`）
- 钱包余额模式 → `mode:"unrestricted"` + `remaining` / `balance`（USD）（`gateway_handler.go:1839-1861`）

### 3.4 卡密兑换

| 方法 | 路径 | 鉴权 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/redeem` | JWT | **兑换卡密 → 余额**（请求体只有 `{code}`） | `routes/user.go:132`；`handler/redeem_handler.go:28-34,43-62` |
| GET | `/api/v1/redeem/history` | JWT | 兑换历史（**幂等补偿用**，见 §5） | `routes/user.go:133`；`handler/redeem_handler.go:66-118` |

响应 `{message, type, value, new_balance?, new_concurrency?}`；`type ∈ {balance, concurrency, subscription, invitation}`
（`service/redeem_service.go:455-590`）。**没有 `request_id` 幂等键**（`handler/redeem_handler.go:28-34` 只收 `code`）——
这是 §5 全部规则的前提。

### 3.5 支付（apia，保持不变）

| 方法 | 路径（apia） | 用途 | 来源 |
| --- | --- | --- | --- |
| GET | `/api/plans` | 套餐列表 | 客户端既有契约注释（`src/services/ours/api.ts` 文件头）；研究文档 §3.0 / §3.2（A1 保留） |
| POST | `/api/pay-link` | 拿收款页链接（App 内打开） | 同上（A2 保留）；sub2api **未找到**等价能力 |
| GET | `/api/orders` | 订单/付款记录 | 同上 |
| GET | `/api/card/trail` | 按卡号反查（可选保留） | 同上 |
| POST | `/api/redeem`（**旧**） | ❌ 不再由客户端调用：卡密一律由用户在 sub2api 面板兑换（§7 第 4 条） | 研究文档 §3.2（A3 迁到 `POST /api/v1/redeem`） |

**禁止使用 sub2api 的支付接口**（`/api/v1/payment/*`、`/payment/webhook/*`）：那是它自己的商品表与订单表，
语义不等价于 apia 的套餐（研究文档 §3.2 A1/A2 的结论）。

### 3.6 网关（聊天）

| 方法 | 路径 | 鉴权 | 来源 |
| --- | --- | --- | --- |
| POST | `/v1/chat/completions`（及各家兼容路径 `/v1/messages`、`/v1/responses`、`/v1/embeddings`…） | sk- Key | `routes/gateway.go:192-249` |

网关 group 挂了 `clientRequestID` 中间件（`routes/gateway.go:180-185`）→ 重试请**复用同一 id**（§5）。

### 3.7 白名单之外：典型幻觉清单（**都不存在**，禁止出现）

`/api/v1/device/apply`、`/api/v1/balance`、`/api/v1/invite/redeem`、`/api/v1/keys/rotate`、
`/api/v1/email/status`、`/api/v1/user/points`、`/api/v1/quota`、`/v1/credits`、`/api/v1/admin/**`（全部管理台）、
`/api/v1/payment/**`（sub2api 自建支付）。

来源：研究文档 §4.5 第 1 条 + §5.3「未找到」清单。这些名字都符合直觉、都能「猜得很像」，
所以 §3.7 的作用不是备忘，而是**当门禁和 review 发现它们时，判定口径是「不存在」而不是「待确认」**。

---

## 4. 错误信封：三套形状必须分派解析

| 来源 | 形状 | 出处 |
| --- | --- | --- |
| 面板 `/api/v1/**` 成功 | `{code:0, message:"success", data:{…}}`；创建 `201`、异步 `202`（`message:"accepted"`） | `pkg/response/response.go:16-24,34-57` |
| 面板 `/api/v1/**` 失败 | `{code:<http 状态，整数>, message, reason?, metadata?}` | `pkg/response/response.go:61-96` |
| 中间件（鉴权 / 限流 / 网关拒绝） | `{code:"UPPER_SNAKE", message}`（`code` 是**大写字符串**） | `middleware/middleware.go:64-81` |
| 网关 `/v1/**` 错误 | `{error:{message, type?, param?, code?}}` | `middleware/middleware.go:84-120` |
| `/v1/usage`、`/v1/sub2api/billing` | **不套 `data` 外壳**，扁平对象 | `handler/gateway_handler.go:1790` 直接 `c.JSON` |

**要求**

1. 写一个 `parseSub2ApiError(res)`（消费层统一出口）→ 归一成 `{kind, code, message, retryable}`；
   `kind` 取 `auth | quota | rate_limit | redeem | key | server | unknown`。
2. 建**错误码 → i18n key 映射表**（下表）。判序：`reason` → `code`（字符串） → HTTP 状态码 → `unknown`。
3. **不允许「未知错误」大面积兜底**：映射表覆盖不到时打日志（不含 key/卡密/URL）并上报缺口，不静默吞。
4. **`message` 不许直接上屏**：sub2api 的 message 是英文句子，且随版本改。

### 4.1 错误码 → i18n key 映射表

| sub2api 错误 | HTTP | 客户端 key（建议名，随消费层落地登记） | 备注 |
| --- | --- | --- | --- |
| `UNAUTHORIZED` / `INVALID_AUTH_HEADER` / `EMPTY_TOKEN` | 401 | `consumeErrUnauthorized` | 会话缺失/格式错 → 引导登录 |
| `TOKEN_EXPIRED` / `INVALID_TOKEN` / `TOKEN_REVOKED` | 401 | `consumeErrUnauthorized` | 先 `refresh`，失败再登录 |
| `SESSION_BINDING_MISMATCH` | 401/409 | `consumeErrUnauthorized` | 会话绑定校验失败 → 重新登录 |
| `USER_INACTIVE` | 401/403 | `consumeErrAccountDisabled` | 新语义（现状无文案） |
| `USER_NOT_FOUND` / `FORBIDDEN` / `ACCESS_DENIED` | 403/404 | `consumeErrForbidden` | |
| `INVALID_API_KEY` | 401 | `consumeErrKeyInvalid` | Key 探测失败 |
| `API_KEY_REQUIRED` | 401 | `consumeErrKeyMissing` | 未填 Key |
| `API_KEY_DISABLED` | 403 | `consumeErrKeyInvalid` | 新语义：Key 被停用 |
| `API_KEY_EXPIRED` | 403 | `consumeErrKeyExpired` | 新语义 |
| `API_KEY_QUOTA_EXHAUSTED` | 403 | `consumeErrKeyQuotaExhausted` | 新语义：USD 额度用完 |
| `API_KEY_AUTH_OVERLOADED` | 429 | `consumeErrRateLimited` | Key 爆破保护 |
| `INSUFFICIENT_BALANCE` | 402/403 | `consumeErrInsufficientBalance` | 新语义：账户余额不足（USD） |
| `GROUP_NOT_ALLOWED` | 403 | `consumeErrGroupNotAllowed` | 新语义：分组不匹配 |
| `RATE_LIMITED` / `INVALID_AUTH_RATE_LIMITED` | 429（带 `Retry-After`） | `consumeErrRateLimited` | 只认 `Retry-After` 秒数 |
| `reason:"REDEEM_CODE_NOT_FOUND"` | 404 | `consumeErrCardNotFound` | 与「过期」不同码 |
| `reason:"REDEEM_CODE_EXPIRED"` | 409 | `consumeErrCardNotFoundOrExpired` | 新语义：过期 ≠ 已使用 |
| `reason:"REDEEM_CODE_USED"` | 409 | `consumeErrCardUsed` | ⚠️ **可能是自己上次成功**，文案必须写「若余额已增加无需重复兑换」 |
| `reason:"REDEEM_CODE_LOCKED"` | 409 | `consumeRedeemProcessing` | 新语义：正在处理，**不是失败**，禁止提示换卡 |
| `reason:"REDEEM_RATE_LIMITED"` | 429 | `consumeErrRateLimited` | |
| `reason:"API_KEY_EXISTS"` | 409 | `consumeErrKeyExists` | `custom_key` 撞车 |
| `reason:"API_KEY_TOO_SHORT"` / `"API_KEY_INVALID_CHARS"` | 400 | `consumeErrBadRequest` | 自定义 Key 格式 |
| `code:"api_key_in_query_deprecated"` | 400 | `consumeErrBadRequest` | **这是客户端 bug**，埋点上报，不当用户错 |
| 面板 400 `message:"Invalid request: …"` | 400 | `consumeErrBadRequest` | |
| 任何 5xx / `INTERNAL_ERROR` | 5xx | `consumeErrServerUnavailable` | 可重试（写接口仍走 §5 补偿判定） |

错误码清单来源：中间件层 `grep AbortWithError`（`middleware/*.go`）；业务层 `*_REASON`
见 `service/redeem_service.go:19-24`、`service/api_key_service.go:30,405-423`；映射建议见研究文档 §4.4。

---

## 5. 重试与幂等（最重要的一条）

| 接口 | 规则 | 依据 |
| --- | --- | --- |
| **`POST /api/v1/redeem`** | **绝不盲目重试**。没有幂等键；超时后重试会拿 `409 REDEEM_CODE_USED`（可能正是自己上次成功）。**正确做法**：超时 → 先 `GET /api/v1/redeem/history` 或 `GET /v1/usage` 确认是否已到账 → 未到账才允许重试，且**要用户手动确认** | `handler/redeem_handler.go:28-34`；`service/redeem_service.go:414-460` |
| `GET /**`（白名单内） | 可重试：网络错/超时/5xx，指数退避，**最多 3 次** | 只读，天然幂等 |
| `POST /api/v1/auth/login`、`/refresh` | 仅**传输层**失败可重试 ≤1 次；业务失败（401/403）**绝不重试**（否则 `INVALID_AUTH_RATE_LIMITED`）；遵守 20/min、30/min | `routes/auth.go:38,54` |
| `POST /api/v1/auth/register` | **不可重试**（无幂等键）；超时后改用 `login` 确认 | `routes/auth.go:35` |
| `POST /api/v1/keys` | **不可重试**；重试前先 `GET /api/v1/keys?search=<name>` 防重复创建 | `routes/user.go:85,87` |
| `DELETE /api/v1/keys/:id` | 可重试（近似幂等）；已删除再删按 404 处理，不当致命错 | `routes/user.go:89` |
| `POST …/email/send-code`、`/auth/send-verify-code` | 靠服务端频控；429 按 `Retry-After` 倒计时，**不自行另算间隔** | `middleware/panel_rate_limit.go:188-189` |
| 支付 `POST /api/pay-link` | **不自动重试**（会生成新单），失败让用户手动点 | apia 侧行为 |
| 全部 `/v1/*` 模型调用 | 可重试，但**复用同一 `client_request_id`** | `routes/gateway.go:180-185` |

**统一超时**：只读 10s；写 15s/20s；兑换 30s（取值只从 `config/endpoints.json` 的
`consume.timeoutMs` 读，见 §6.1）。**禁止**无限重试、禁止在弹窗里自动轮询写接口。

---

## 6. 传输与配置（base URL 必须配置化，源码零字面量）

### 6.1 配置文件：`config/endpoints.json`（沿用 #269 机制，新增 `consume` / `pay` 两组）

```jsonc
{
  // 已有：下载分发（不要动）
  "download": { "primaryBase": "...", "fallbackBase": "..." },

  // 新增：消费侧（sub2api）
  "consume": {
    "baseUrl": "https://<sub2api-host>",        // 维护者待定；一个 host 同时承载 /api/v1 与 /v1
    "apiV1Prefix": "/api/v1",                   // JWT 通道
    "gatewayPrefix": "/v1",                     // sk- Key 通道
    "timeoutMs": { "read": 10000, "write": 20000, "redeem": 30000 }
  },

  // 新增：支付侧（apia，保持现状）
  "pay": {
    "baseUrl": "https://apia.ecsafe.cn",
    "timeoutMs": { "read": 10000, "write": 20000 }
  }
}
```

字段含义与「谁消费 / 改它要重新打包」见 `config/README.md` 的对应小节。

### 6.2 注入方式（与 #269 一致，不许另造一套）

| 层 | 注入点 | 说明 |
| --- | --- | --- |
| Web/TS | `__ENDPOINTS__.consume.baseUrl` 等 | 构建期由 `scripts/build.mjs`（rspack 配置）从 `config/endpoints.json` 替换 |
| 原生 Java | `BuildConfig.CONSUME_BASE` / `BuildConfig.PAY_BASE` | `android/app/build.gradle` 读同一份 JSON 生成 `buildConfigField`（**必须显式 `buildFeatures { buildConfig true }`**，AGP 8 默认关闭） |
| 打包覆盖 | `-PconsumeBase=…` | 临时覆盖，仅用于内测/灰度（步骤见 `docs/RELEASE-MANUAL.md` 换 host 小节） |

### 6.3 构建期校验（fail-fast，不许留到运行时）

`scripts/build.mjs` 与 `android/app/build.gradle` 都必须在**打包前**校验：

1. 每个 base 必须 **https**（明文 http 直接中止构建）。
2. base 不得命中**废弃域黑名单**：`140.210.13.146`、`:60013`、旧池域任何地址。
3. `consume.baseUrl` 与 `pay.baseUrl` **不得相同**（两个后端职责不能混）。
4. 缺字段 / 空值 / 未知键 → 中止并打印**具体键名与文件行号**。

### 6.4 运行时要求

1. **必须走原生 `CapacitorHttp`**：sub2api 的 `cors.allowed_origins` 默认空数组（部署样例
   `config.example.yaml` 的 `cors` 段），空数组时中间件**拒绝所有跨域请求**
   （`middleware/cors.go:31-35` 会打 "CORS allowed_origins not configured" 警告）。WebView 裸 `fetch()` 必然失败。
2. 超时按 §6.1 的 `timeoutMs` 读，**不许在各调用点硬编码毫秒数**。
3. **base 只从配置读**：`src/**` 出现任何后端地址字面量 → 门禁红。
4. `check:ip`（`scripts/check-hardcoded-ip.mjs`）的扫描范围扩展到 `config/endpoints.json` 的 `consume` / `pay`。
5. **待维护者提供**：sub2api 真实 host + CORS 是否放行 Capacitor origin（`capacitor://localhost` / `https://localhost`）。
   在拿到这两条之前，任何「已经接通」的结论都不成立。

### 6.5 门禁 `check:consume-api` 覆盖项（#484 交付物 2，尚未落地）

- `src/**` 无 base 字面量（`https?://` + 已知后端域名 / 旧 IP）。
- `config/endpoints.json` 的 `consume` / `pay` 字段齐全且为 https。
- 白名单外路径零出现（以本文 §3 为唯一名单来源）。
- 负向对照：往 `src` 塞一条 `https://apia.ecsafe.cn` → 必须 exit 1。

**注意**：本文（约束）先于门禁（执行）落地；门禁未上线期间，「白名单」靠 review 守，
所以 review 时**必须**逐条对照 §3 的「来源」列，不接受「sub2api 应该有这个接口」这类理由。

---

## 7. 禁止事项（门禁要拦）

1. 源码出现 `140.210.13.146` / `:60013` / 旧池域任何地址。
2. 源码出现白名单（§3）之外的 sub2api 路径。
3. 把 `device_id` 作为鉴权参数（该体系已废弃；研究结论：sub2api 侧**未找到**任何 device 语义的对外端点）。
4. key / JWT / 卡密进日志、埋点、剪贴板、DOM 全文、URL。
5. 明文 HTTP 调用（含「先跑通再加 TLS」）。
6. 客户端自建「额度账本」（本地缓存余额并据此判断能否发送）；`quota:0` 不许当零额度。
7. **本地维护功能开关副本**（是否显示注册/邀请/邮箱入口，必须读 `/api/v1/settings/public`）。
8. 客户端在支付成功后自动 `POST /api/v1/redeem`（卡密只展示/复制，由用户自己去面板兑换）。
9. 调用 `/api/v1/admin/**`（含 `x-api-key` 型受限管理密钥）与 sub2api 的 `/api/v1/payment/**`。
10. 用「通用解包器」处理所有响应（§4 有三套形状，必须按接口分派）。
11. 把「空列表」当错误（`/api/v1/keys`、`/subscriptions/active` 返回空数组是正常态）。
12. 把 `message` 直接上屏。

---

## 8. 变更流程

**要新增端点 → 先改本文 + review，再改代码。**

1. 在本文 §3 加一行（或改一行），**必须填写「来源」列**：sub2api 代码位置（相对其仓库根）或研究文档章节。
   填不出来 = 这个端点不存在或没研究过 → 不许写代码。
2. 同一 PR 里同步：§4 错误码映射（有新的 `reason` / `code` 才需要）、§5 重试类别（GET/POST 待遇不同）。
3. review 通过后，才允许在消费层写调用点；`check:consume-api` 上线后，白名单会随之变成硬门禁。
4. 删除端点（能力下线）同样走这套流程：先删本文那一行，再删调用点，最后清 i18n key。
5. **文档与代码不一致时，PR 必须一起改**：不允许「代码先上，文档下一单补」。

关联文档：`config/README.md`（`consume` / `pay` 字段与消费方）、`docs/RELEASE-MANUAL.md`（换 host 步骤）、
`docs/server-migration.md`（旧地址切换的既有教训）、`docs/baseurl-config-research.md`（base 配置化背景）。

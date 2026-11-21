# #676 契约逐节核对表（客户端侧）

> 对象：`zzy-repo/deepseek-app` 的客户端（`src/**`）
> 依据：issue **#676**《[契约] 邮箱注册改造：客户端需对接的全部外部接口》（八节）+ #651 的「发版铁律」前置门第 1 条
> 核对日期：2026-11-21｜基线：`origin/main@8d87347`
> 服务端实例：`http://140.210.13.146:16000`（staging，`sub2api_staging`，`settings/public.version = 0.2.20`）

## 零、怎么核对的（不是凭印象）

1. **先搜再打开**：`grep -rn "auth/login\|auth/me\|/keys\|/redeem\|user/aff\|legacy/claim\|user/profile\|platform-quotas\|/v1/usage" src/ shared/ config/`，
   命中的每个文件都整段读过（不是只看命中行）。
2. **每个端点都落到 `文件:符号`**，行号是本分支上的真行号。
3. **staging 实测**（只读 + 一次 `POST /keys` 领一把 Key，取完即用完；账号是 #676 正文给的那个）：
   `curl` 打到 `140.210.13.146:16000` 上逐个端点确认「在不在、回什么形状」。
4. 客户端行为断言由 `tests/unit/consume-676-*.test.mjs` 钉住（见第七节）。

判定口径：

| 判定 | 含义 |
| --- | --- |
| ✅ 已对接 | 客户端真会发这个请求，并且在界面上有落点 |
| 🟡 层内已接 / UI 未接 | `src/services/consume/**` 有实现，但没有任何界面/流程调用它 |
| 🔴 路径或字段不符 | 客户端调的路径/字段与契约不一致（**本单要修的就是这一类**） |
| ⛔ 未接 | 客户端没有任何代码 |
| 🚫 明确不做 | 按 #676 第八节**刻意不做**，非缺口 |

---

## 一、认证（替代旧 `/apply`、`/me`）

| 端点 | 客户端现在调什么（证据） | 判定 |
| --- | --- | --- |
| `POST /api/v1/auth/send-verify-code` | `src/services/consume/auth.ts:351 sendVerifyCode`；注册页「发送验证码」`src/components/auth/RegisterPage.tsx:173` | ✅ 已对接（按 `settings.public.email_verify_enabled` 决定显不显示） |
| `POST /api/v1/auth/register` | `src/services/consume/auth.ts:304 register` + `toRegisterBody`；`{email, password, verify_code?, invitation_code?, promo_code?}`；`password` 在 `src/components/auth/authForm.ts:92` 先本地拦，阈值 `MIN_PASSWORD_LENGTH = 8`（`authForm.ts:20`） | ✅ 已对接（**`password` 必填已实现**，#676 §九 第 2 条不需要再等）。⚠️ 本地阈值 **8 位 > 契约的 6 位**：客户端更严，不会放过非法密码，只在「7 位密码」上会把请求挡在前面 —— 要不要放宽到 6 由 UI 决定，不影响发版 |
| `POST /api/v1/auth/login` | `src/services/consume/auth.ts:322 login`；`src/components/auth/LoginPage.tsx` | ✅ 已对接 |
| `POST /api/v1/auth/login/2fa` | `src/services/consume/auth.ts:334 loginWithTwoFactor` + `src/services/consume/index.ts login2fa`；**`src/services/auth/transport.ts:58` 明写「2FA 属于后半，暂不接」**，登录页没有二次校验步骤 | 🟡 层内已接 / UI 未接（staging `totp_enabled=false`，本期开不了 2FA 账号，**不阻塞**） |
| `POST /api/v1/auth/refresh` | `src/services/consume/auth.ts:355 refresh`（`auth: null`，不带旧 token） | ✅ 已对接 |
| `POST /api/v1/auth/logout` | 客户端**不调**它；退出走 `src/services/consume/auth.ts:429 revokeAllSessions` → `POST /api/v1/auth/revoke-all-sessions`（`src/services/auth/store.ts` 的 `signOut`） | 🔴 路径不符 **但不改**，理由见下 |

**关于 `logout`（判定要写清楚，别改成更糟的）**
- staging 实测：`POST /api/v1/auth/logout` → **502**（nginx 502，连打两次都一样）；`POST /api/v1/auth/revoke-all-sessions` → **200**。
- 客户端那条 `revokeAllSessions` 还带 #679 的「2xx ≠ 生效」探针（回查 `/user/profile`，仍是 200 就报「未确认」）。**staging 实测正好命中这个洞**：revoke 回了 200，但同一个 JWT 再读 `/user/profile` 仍然 **200** —— 撤销没生效，客户端（正确地）会说「已提交、结果未确认」。
- 所以这里**不改**：改成契约里的 `/auth/logout` 只会把「能跑 + 会如实报未确认」换成「502」。已作为**契约侧待澄清项**提给后端（见第六节 D-676-2）。

**注册返回的 `user` 字段**

| 字段 | 客户端 | 判定 |
| --- | --- | --- |
| `balance` | `toConsumeUser`（`src/services/consume/auth.ts:144`）→ `ConsumeUser.balance`；账号页 `statRow(consumeBalanceLabel, formatCurrency(balance))`（`src/components/consume/accountPanelModel.ts:415`）→ 渲染成 **¥2.02** | ✅ 已用，单位按**元**（`formatCurrency` 默认 `CNY`，`src/components/consume/panels.ts:170`） |
| `concurrency` | 映射进 `ConsumeUser.concurrency`，**界面没有任何地方显示** | 🟡 字段已接、未展示（不影响功能） |
| `status` | 映射进 `ConsumeUser.status`，未展示；`status` 只在 **Key** 上被用（`accountPanelModel.ts:257`） | 🟡 同上 |
| `total_recharged` | 映射进 `ConsumeUser.totalRecharged`，未展示 | 🟡 同上 |
| 旧 `remaining_points` / `quota_points` / `used_points` / `invite_code` / `redeemed` | `grep -rn "remaining_points\|quota_points\|used_points" src/` → **0 命中** | ✅ 已彻底退场 |

---

## 二、账户信息（替代旧 `/me`）

| 端点 | 客户端现在调什么（证据） | 判定 |
| --- | --- | --- |
| `GET /api/v1/user/profile` | `src/services/consume/auth.ts:404 getProfile`；`consume.auth.profile()`（`src/services/consume/index.ts:196`）；账号页 `runLoadAccount`（`src/components/consume/accountPanelModel.ts:223`） | ✅ 已对接 |
| `PUT /api/v1/user` | `grep -rn "'/api/v1/user'" src/` → **0 命中** | ⛔ 未接（改用户名/资料：本期无入口） |
| `PUT /api/v1/user/password` | **0 命中** | ⛔ 未接（改密码；staging `password_reset_enabled=false`，找回密码也关着） |
| `GET /api/v1/user/platform-quotas` | **0 命中** | ⛔ 未接（各平台额度：客户端没有这个概念，额度只有「账户余额 + Key 额度」两处） |
| **`/api/v1/auth/me` 不存在 → 必须用 `/user/profile`** | **本单修掉**：`me()` 原来打的是 `consume.auth.me()` → `GET /api/v1/auth/me`。现在 `consume.auth.me` 已删，`me()` 直接走 `consume.auth.profile()`（`src/services/auth/transport.ts:248` 就是改完的那一行） | 🔴 **已修正**（路径不符） |

**为什么「实测 200 也要改」**：staging 上 `GET /api/v1/auth/me`（有效 JWT）回 **200**、字段与 `/user/profile` 同形，
未知路径回 `404 page not found` —— 也就是说这条**不是线上已经坏了**，而是客户端依赖一条**契约里没有**的路径。
它只在 `restoreAuth()`（启动恢复）里被调，一旦服务端按契约摘掉，症状是「一启动就掉线，重新登录又能进」——
最难查的那一类。收口到 `/user/profile` 后只有一条路（证据见 `tests/unit/consume-676-profile-path.test.mjs` 的 P1–P4）。

---

## 三、API Key

| 端点 | 客户端现在调什么（证据） | 判定 |
| --- | --- | --- |
| `GET /api/v1/keys` | `src/services/consume/keys.ts:177 listKeys`（分页 + `search` 防重复创建）；账号页列表 `accountPanelModel.runLoadAccount:223` | ✅ 已对接 |
| `POST /api/v1/keys` | `src/services/consume/keys.ts:209 createKey`（默认 `dedupe: true`：先按 `name` 查一遍，命中就回那把）；「领取 Key」= `src/services/api/managedKey.ts:159` | ✅ 已对接（创建不可重试这条也落在这里） |
| `PUT /api/v1/keys/:id` | `src/services/consume/keys.ts:258 updateKey`（改名/停用；**没有 `key` 字段**）；回查确认写在里面 | ✅ 已对接 |
| `DELETE /api/v1/keys/:id` | `src/services/consume/keys.ts:324 deleteKey`（404 视为已完成；其余靠回查确认） | ✅ 已对接 |
| `GET /api/v1/user/api-keys/:id/usage/daily` | `src/services/consume/usage.ts:209 getKeyDailyUsage` + `consume.usage.keyDaily`；**`grep -rn keyDaily src/components/` → 0 命中** | 🟡 层内已接 / UI 未接 |
| **`quota = 0` 表示不限额** | 类型上写明「0 = 不限」（`src/services/consume/keys.ts` 的 `ConsumeApiKey.quota` 注释）；界面**不显示 Key 的 quota**（账号页只显示名称/状态/操作），额度只在「我的额度」面板里，且那一处判 `quota.limit === 0 → 不限`（`src/components/consume/quotaPanelModel.ts:105`，函数 `quotaSummaryOf:95`） | ✅ 没有「拿 quota 当剩余额度」的地方（staging 实测领到的 Key 就是 `quota:0, quota_used:0`） |

---

## 四、额度与用量（**两个不同接口别混**）

| 端点 | 鉴权 | 客户端现在调什么（证据） | 判定 |
| --- | --- | --- | --- |
| `GET /v1/usage` | **Bearer `sk-…`** | `src/services/consume/usage.ts:85 getGatewayUsage`（`unwrap: 'bare'`，因为**不套** `{code,message,data}`）；「我的额度」面板 `quotaPanelModel.loadQuota:119` | ✅ 已对接（通道正确：`http.ts` 按前缀选凭据，`/v1/**` 只认 Key） |
| `GET /api/v1/usage` | access_token | `src/services/consume/usage.ts:168 listUsage`；面板下半部分 `quotaPanelModel.loadUsagePage:127` | ✅ 已对接（**没有混用**：`/v1/usage` 与 `/api/v1/usage` 在同一文件里是两个函数、两种 `unwrap`） |
| `GET /api/v1/usage/stats` | access_token | `src/services/consume/usage.ts:172 getUsageStats`；**无 UI 调用** | 🟡 层内已接 / UI 未接 |
| `GET /api/v1/usage/dashboard/*` | access_token | `src/services/consume/usage.ts:179 getUsageDashboard`；**无 UI 调用** | 🟡 同上 |

| `unit` / `currency`（响应字段） | `getGatewayUsage` 读 `unit`（`str(body.unit)` / `quota.unit`），**不读 `currency`** | 🟡 字段未读：展示统一走 `formatCurrency`（默认 `CNY`），不按响应切换币种；契约说两者都是 `CNY`，所以现状不会显示错币种 |

**口径提醒（写进表的理由）**：「我的额度」面板显示的三行是 `balance`（钱包模式）/ `spent`（= `usage.total.actual_cost`，
**不是**恒为 0 的 `quota.used`）/ `remaining`，`quota.limit === 0` 判「不限」。这是 `/v1/usage` 自己的口径，
与账号页那行 `balance`（来自 `/user/profile`）**不是同一个数**：前者是**那把 Key** 的视角，后者是**账户**的视角。
staging 上两者会打架（账户 `balance=2.02`，Key 侧 403，见第五节结论），已列为裁决项 D-676-1。

---

## 五、卡密兑换

| 端点 | 客户端现在调什么（证据） | 判定 |
| --- | --- | --- |
| `POST /api/v1/redeem` | `src/services/consume/redeem.ts:278 redeemCode` → `postRedeem` 的 body **只有 `{code}`**；`grep -rn "api_key\|request_id" src/services/consume/redeem.ts` → 唯一命中是 `:274` 的一行注释（「sub2api 不收 `request_id`」），**请求体里没有这两个字段** | ✅ 已对接（不再传 `api_key` / `request_id`） |
| `GET /api/v1/redeem/history` | `src/services/consume/redeem.ts:127 getRedeemHistory`，由 `verifyCredited:204` 用于「超时 / 409 / 202 后核对到账」 | ✅ 已对接 |
| **兑换后重拉 `/user/profile` 刷余额**（不再是某把 Key 的 quota） | **本单修掉**：`redeemed` 结局原来带的是 `refreshUsage: true`（指向 `/v1/usage` = Key 的 quota），而且**没有任何代码消费这个标志**。现在字段改为 `refreshProfile`，并由 `src/components/consume/myCardsModel.ts afterRedeemed()` 真的去拉一次 `GET /api/v1/user/profile`，把 `balance` 上屏 | 🔴 **已修正**（字段语义不符 + 没人执行） |
| 旧 `POST /api/redeem {card_no, api_key, request_id}` | 仍留在 `src/services/ours/api.ts:490 redeemCard`；**`grep -rn redeemCard src/` → 0 个调用点**（只有单测 `tests/unit/ours-api.test.mjs`） | 🟡 死代码（不阻塞：界面上已无入口；随 W1-D 清理，**本单不删**，删它会连带删既有单测 = 降断言） |

---

## 六、邀请

| 端点 | 客户端现在调什么（证据） | 判定 |
| --- | --- | --- |
| `GET /api/v1/user/aff` | `src/services/consume/aff.ts:70 getAffiliate`；「我的邀请」`src/components/consume/invitePanelModel.ts:83 loadInvite`（`invitation_code_enabled=false` 时整块隐藏） | ✅ 已对接（staging 该开关 = false → 入口隐藏，契约预期内） |
| `POST /api/v1/user/aff/transfer` | **0 命中** | 🚫 明确不做（#676 六：本期不启用） |
| 注册时邀请码放 `aff_code` | 客户端放的是 **`invitation_code`**（`src/components/auth/RegisterPage.tsx:97`），`aff_code` 只有类型占位（`consume/auth.ts` 的 `ConsumeRegisterInput.affCode`）**没人传** | 🟡 字段名与 #676 写法不同，**先不改**：服务端两个字段都收（`backend/internal/handler/auth_handler.go:58-59` `InvitationCode` + `AffCode` 并列），改错一边反而会把「绑定奖励」换「比例返利」通道。列 D-676-3 等后端一句话定性 |
| `POST /api/v1/auth/validate-invitation-code` | `src/services/consume/aff.ts:49 validateInvitationCode`；**无 UI 调用**（注册页不做预校验） | 🟡 层内已接 / UI 未接 |

---

## 七、老账号额度迁移（独立服务）

| 项 | 客户端现在什么样（证据） | 判定 |
| --- | --- | --- |
| `POST /legacy/claim` | `src/legacy/migration/claim.ts:236 claimLegacyMigration`（body 四字段、`jwt` **在 body**、只发一次、绝不抛） | 🟡 层内已接 |
| `GET /legacy/health` | 客户端**没有**探活调用（`grep -rn legacy/health src/` → 0） | ⛔ 未接 |
| 登录/注册后调一次 | `src/services/auth/store.ts:236` 登录成功后 `void claimLegacyMigration(...)` | 🟡 接线在，但**开关关着就等于不跑**：`config/endpoints.json` 的 `migration.enabled=false`、`baseUrl=""`（`readMigrationConfig` 直接返回 `null`） |
| 7 种 status 的 UI 处理 | `src/legacy/migration/types.ts:35 CLAIM_STATUSES` = `migrated / already_migrated / no_legacy / need_manual / expired / failed`，`failed` 再按 `retryable` 二分（共 7 种）+ `src/legacy/migration/LegacyMigrationButton.tsx` | 🟡 逻辑齐了，**按钮没有挂载点**：`grep -rn "LegacyMigrationButton" src/ \| grep -v legacy/migration/` → **0 命中** |
| 整体 | 模块自包含、可单独挂载，但「没挂 + 没开 + 没有 https base」 | ⛔ **实际未接**（#676 七「需另外接」） |

---

## 八、本期明确不接的（照抄 + 客户端现状）

| 能力 | #676 状态 | 客户端现状（证据） | 判定 |
| --- | --- | --- | --- |
| 支付（`/api/v1/payment/*` 全套：plans、orders、checkout） | **不接**，充值只走卡密 | `grep -rn "api/v1/payment" src/` → **0 命中**。但**旧的 apia 购买链路还在**：`src/components/consume/BuyTab.tsx:21` 调 `fetchPlans` / `fetchPayLink` → `POST /api/plans`、`/api/pay-link`（`src/services/ours/api.ts`，base = `__ENDPOINTS__.pay.baseUrl` = `https://apia.ecsafe.cn`） | 🚫 对 sub2api 支付：明确不做 ✅；⚠️ **但 staging 包里的「购买」tab 会打生产 apia**（见第五节 D-676-4） |
| 比例返利（`aff_quota` 转余额） | **不启用**，本期只有绑定奖励 | `getAffiliate` 只**展示** `aff_quota` / `aff_frozen_quota`（`invitePanelModel.toInviteDetail`），**没有** transfer 调用 | 🚫 明确不做 ✅ |
| 首付奖励 | **已删除**，不做 | `grep -rn "首付\|first_pay\|firstPay" src/` → 0 命中 | 🚫 明确不做 ✅ |
| OAuth 登录（linuxdo / github / google / wechat） | 后端有，客户端本期不接 | `settings/public` 里的 `*_oauth_enabled` 字段**没有被读**（`ConsumePublicSettings` 里只挑了 `totp/payment/affiliate/...`），登录页只有邮箱+密码 | 🚫 明确不做 ✅ |

---

## 九、结论：按现在的客户端状态，`v1.4.4-staging` 能不能用？

**四个功能逐个回答**（在「包能装、能起」的前提下）：

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| **能登录吗** | **能**（代码层面） | `LoginPage` → `consume.auth.login` → `POST /api/v1/auth/login`；staging 实测该端点 200，`{access_token, refresh_token, expires_in, user}` 与 `toAuthSession` 的字段一一对上。**但前提是**把 base 指向 16000（见下「阻塞项」）—— 现状下这个前提**做不到** |
| **能领 Key 吗** | **能**（代码层面） | `POST /api/v1/keys` 在账号页有入口（`accountPanelModel` 的 create）+ 「设置 → 数据管理」的领取链路；staging 实测 `POST /keys {name}` → 200 并返回 `sk-…`（`quota:0` = 不限，符合契约） |
| **能看余额吗** | **能** | 账号页读 `GET /api/v1/user/profile`（JWT），staging 实测 `balance=2.02` → 渲染 `¥2.02` |
| **能兑换卡密吗** | **能** | `POST /api/v1/redeem {code}`（登录态、不传 api_key）；staging 实测 `/redeem/history` 里有真实兑换记录（`admin_balance 0.01`），端点与信封都对得上 |

**但是 —— 这四个「能」全部被同一个前提挡住：staging 包做不出来。**

### 阻塞项（**必须裁决，否则前置门第 2 条无法执行**）

铁律要求 `-PconsumeBase=http://140.210.13.146:16000`「走仓库既有例外通道，不改 `config/endpoints.json` 的生产值」。
核对结论：**这条路今天不存在**，三层拦截 + 一层没接线：

| # | 拦截点 | 证据 | 后果 |
| --- | --- | --- | --- |
| 1 | **构建前 fail-fast**（web 包） | `scripts/lib/consumeEndpoints.mjs:166`「必须是 https（明文 http 直接中止构建）」；`:185` 命中 `DEPRECATED_MARKERS`（含 `140.210.13.146`，`:45`） | `pnpm build` 直接中止 |
| 2 | **gradle（原生侧）** | `android/app/build.gradle:210`「必须是 https（唯一例外是本机回环）」；`:214`「命中废弃域黑名单」；黑名单本体 `:141 CONSUME_DEPRECATED_MARKERS = ['140.210.13.146', ':60013']` | `assembleRelease` 直接 FAILURE |
| 3 | **运行时**（真机上） | `src/services/consume/http.ts:179-183` 同一条规则 → 抛 `ConsumeConfigError`；`src/main.tsx:100` 是**模块级** `getConsumeClient()` | 万一绕过前两层出了包，App **启动即抛**（白屏），不是「登录失败」 |
| 4 | **`-PconsumeBase` 根本到不了 web 包** | `-PconsumeBase` 只写 `BuildConfig.CONSUME_BASE`（`android/app/build.gradle:594`），而 `grep -rn CONSUME_BASE android/app/src/main/java/` → **0 命中**（java 侧没人读）；WebView 里的 `__ENDPOINTS__.consume.baseUrl` 是 **rspack 打包时**从 `config/endpoints.json` 注入的（`rspack.config.ts:432-437`） | 即使解开前三条，WebView 仍然打**生产** `https://sub2api.rose7.cn` |

**本单实测复现（第 3 层）**：

```
# node -e + tests/helpers/contract.mjs 的解析钩子，把 __ENDPOINTS__.consume.baseUrl 设成 staging 地址
THROW -> ConsumeConfigError | __ENDPOINTS__.consume.baseUrl 必须是 https（明文 http 一律拒绝，#484 §6.3）：http://140.210.13.146:16000
```

**可选处置（都需要你点头，我没有擅自改）**

| 方案 | 要动什么 | 代价 |
| --- | --- | --- |
| **A（推荐）后端侧加 https** | 后端在 16000 前面挂一个带证书的域名（自签也行，客户端不校验证书链），客户端**零改动**，铁律原文可以不改 | 需要后端同学做；`140.210.13.146` 仍在废弃域黑名单里（按 IP 匹配），必须用**域名** |
| B 给 rspack 开「构建期 base 覆盖」通道 | `rspack.config.ts` + `scripts/build.mjs`（构建链），并把 `-PconsumeBase` 传进去 | 动构建链；且要同时放开 http/黑名单三处判定 = **削弱安全线**，按 #651 二·3 需要你明确放行 |
| C `adb reverse` + 回环地址 | 用既有回环例外 + `-PallowLoopbackConsume=true` | 产物带「不可分发」标记，闸 2（deploy/dl-release）会 400 拒收 → **发不了 Release**，与铁律「只发 GitHub Release」冲突 |

> 一句话：**前置门第 1 条（#676 契约）我这边已经能交；前置门第 2 条现在是红的，而且红的不是客户端代码，是「明文 http + 废弃域黑名单 + `-P` 不影响 web 包」这三件事叠在一起。**

---

## 十、未接 / 部分接清单（**不擅自开大工程，等你裁决**）

```
未接 / 部分接：GET /api/v1/user/platform-quotas — 客户端零代码（无「平台额度」概念）— 影响：不阻塞（额度=账户余额+Key 额度已能覆盖）— 建议：本期明确不做
未接 / 部分接：PUT /api/v1/user — 客户端零代码 — 影响：不阻塞（用户名可不改）— 建议：本期明确不做
未接 / 部分接：PUT /api/v1/user/password — 客户端零代码 — 影响：不阻塞（staging password_reset_enabled=false）— 建议：本期明确不做
未接 / 部分接：POST /api/v1/auth/login/2fa — 层内有 loginWithTwoFactor，UI/传输层不接（transport.ts:58 明写暂不接）— 影响：只在账号开了 TOTP 时锁死；staging totp_enabled=false → 不阻塞 — 建议：等有 2FA 用户再开单
未接 / 部分接：POST /auth/logout — 客户端改用 /auth/revoke-all-sessions（能跑）— 影响：不阻塞（且契约那条在 staging 是 502）— 建议：契约侧澄清语义（D-676-2）
未接 / 部分接：GET /api/v1/user/api-keys/:id/usage/daily — 层内有 getKeyDailyUsage，无 UI — 影响：不阻塞 — 建议：本期不做（面板已有账户级用量）
未接 / 部分接：GET /api/v1/usage/stats、/usage/dashboard/* — 层内有，无 UI — 影响：不阻塞 — 建议：本期不做
未接 / 部分接：POST /api/v1/auth/validate-invitation-code — 层内有 validateInvitationCode，注册页不预校验 — 影响：不阻塞（提交时服务端会校验）— 建议：本期不做
未接 / 部分接：第七节老账号迁移（/legacy/claim + /legacy/health + 7 种 status UI）— 模块自包含、按钮无挂载点、config migration.enabled=false/baseUrl=""、无 health 探活 — 影响：**不阻塞 staging**（staging 数据不作数，没有老账号要迁）— 建议：需要迁移老用户时再挂（挂载点 + https base + 探活三件事一起做）
```

### 需要后端/维护者一句话的 5 条

| # | 事项 | 我建议 |
| --- | --- | --- |
| D-676-1 | 「我的额度」面板用 `/v1/usage`（Key 视角）显示余额/已用/剩余，账号页用 `/user/profile`（账户视角）。staging 实测两者打架：账户 `balance=2.02`，而新建 Key 打 `/v1/usage` → **403 `API Key is not assigned to any group`** | 面板保留（它是 Key 的视角），但**文案要写清「这把 Key」**；另外 staging 请给 Key 配一个 group，否则领到的 Key 无法用于网关（**这条是环境问题，不是客户端 bug**） |
| D-676-2 | `POST /api/v1/auth/logout` 在 staging **502**；`revoke-all-sessions` 回 200 但同一个 JWT 仍能读 `/user/profile`（撤销未生效，客户端的探针如实报「未确认」） | 后端修 logout/撤销；客户端保持现状 |
| D-676-3 | 注册时邀请码走 `invitation_code`（客户端现状）还是 `aff_code`（#676 六 原文）？后端两个字段都收 | 由后端说明「哪个给绑定奖励」，客户端再决定是否切换 |
| D-676-4 | staging 包的「购买」tab 仍打**生产** `https://apia.ecsafe.cn`（`pay.baseUrl`，`-PpayBase` 没人传） | 发 staging 包时同时传 `-PpayBase=<staging pay 或不可达地址>`，或本期把购买入口在 staging 构建里隐藏（需你定） |
| D-676-5 | 前置门第 2 条（`-PconsumeBase=http://140.210.13.146:16000`）**执行不了** | 选 A/B/C（见第九节），我按你选的方案再动手 |

---

## 十一、本单（#676）改了哪些代码

只改「路径/字段对不上」这一类，**不动大流程**，每处都有测试钉住：

| # | 文件 | 改动 | 钉住它的用例 |
| --- | --- | --- | --- |
| 1 | `src/services/consume/auth.ts` | 删掉 `me()`（`GET /api/v1/auth/me`），「当前用户」只剩 `getProfile()`（`/api/v1/user/profile`） | `tests/unit/consume-676-profile-path.test.mjs` P1/P3/P4 |
| 2 | `src/services/consume/index.ts` | 导出与 `consume.auth.me` 一起删掉；注释指向唯一入口 | 同上 P3 |
| 3 | `src/services/auth/transport.ts` | `me()` 改调 `consume.auth.profile()`（启动恢复不再依赖契约外路径） | 同上 P2 |
| 4 | `src/services/consume/redeem.ts` | `redeemed.refreshUsage` → `refreshProfile`：兑换后该刷的是 `/user/profile` 的 `balance`，不是某把 Key 的 quota | `tests/unit/consume-676-redeem-profile-refresh.test.mjs` F1–F7 + 既有 `consume-redeem-compensation.test.mjs` / `contract-c11-redeem-no-blind-retry.test.mjs`（只换字段名，**断言变多不变少**） |
| 5 | `src/components/consume/myCardsModel.ts`（新增） | `afterRedeemed()`：`redeemed` 后**真的**拉一次 `/user/profile`，只拉一次，失败不翻结论 | 同上 F1–F6 |
| 6 | `src/components/consume/MyCardsTab.tsx` | 兑换成功后调用 `afterRedeemed()`，把余额显示在成功文案里 | F6（模型层）+ 静态渲染 |
| 7 | 文档 | `docs/consume-layer.md`（`me` 行删掉、实测表注明只用 `/user/profile`）、`docs/sub2api-client-contract.md`（`/auth/me` 一行加标注）、本文件 | `check:doc-refs` / `gen-capabilities-docs --check` |

**没做的事（有意）**：没动 `config/endpoints.json` 的生产值、没动 `ci.yml`、没动 `tests/golden/**`、没动 `scripts/` 发布链路、
没删 `src/services/ours/api.ts` 的旧 `redeemCard`（删它要连带删既有单测）、没有新增第二套 HTTP/脱敏（全部复用
`src/services/consume/http.ts` 的 `createConsumeHttp` 与既有 `redact`）。

**验收**（本分支）：

```
npx tsc -p tsconfig.json --noEmit                     → 0 error
node tests/run-layer.mjs unit                         → 212 文件 / PASS 209 / FAIL 3
  · capabilities-docs-sync（本次新增文件导致计数漂移）→ 已跑 gen:capabilities-docs 重生成，复跑 PASS
  · quota-exhausted / attachment-endpoint-303         → 在干净 origin/main 上同样 FAIL（存量/环境），与本单无关
node scripts/check-consume-api.mjs                    → 通过（路径白名单 34 条、明文 http 0 处、废弃域 0 处）
node scripts/check-doc-refs.mjs                       → 合格
node scripts/gen-capabilities-docs.mjs --check        → 一致
npx oxlint src rspack.config.ts                       → 0 warning / 0 error
```

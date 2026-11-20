# 重构后重建回归基准（阶段③输入，W1-D #487）

> **这份文件是阶段③的作业单**：重构（W1-A 消费层 / W1-B JWT 身份 / W1-C 三弹层合一 / W1-E 支付归属）做完、
> #484 §九 A1–A7 验收通过后，按本文件把「支付 / 额度 / 邀请」这一片的回归基准**重新写一遍**。
> 编写口径同 #453：**只测用户会遇到的路径与失败态**，不测「只在测试里存在的分支」，不重复测 L0 已覆盖的纯逻辑。
>
> 本文件列的测试文件**都已经删掉了**，所以只写文件名（写全路径会让 `check:doc-refs` 判「文件不存在」）。
>
> 本文件由 W1-D（分支 `chore/remove-legacy-billing`）落地。维护者口径（#487）：
> **重构期间不维护两套测试** —— 旧基准先删掉，重构完按新链路重建。所以这里是「真的删了」，不是注释掉。

## 0. 一句话现状

| 项 | 值 |
| --- | --- |
| 删除的测试文件 | **12 个**（L0 11 + 黄金 1）＋ 1 个 0 引用 fixture |
| 删除行数 | **3,639 行**（测试 3,577 + fixture 62） |
| 删除的**生产代码** | **0 行** —— 旧体系每一处都还有 UI 调用方（见 §3 的证据表），按 #487「引用不为 0 的不要硬删」全部登记为待清理 |
| 门禁变化 | 无放宽、无 `continue-on-error`、无新增豁免；`check:test-layout --strict` / `check:test-duplication` / `check:doc-refs` 全绿 |
| 黄金套件 | 10 → 9 条（G7 额度+购买 删除），其余 9 条实测 PASS |

## 1. 删掉了哪些测试、原本覆盖什么、重建时应怎么写

### 1.1 L0（unit）11 个

| 已删文件 | 行数 | 原本覆盖什么 | 为什么必须删 | 阶段③怎么重建 |
| --- | --- | --- | --- | --- |
| `domain06-claim-identity-matrix.test.mjs` | 463 | 「这台设备到底是谁」三张表：领取幂等 / 换 device 同指纹 / 指纹大小写 / 换 IP 限流 / 设备自愈一次；「我已有 Key」绑定；换 Key 失败不清旧 Key | 全部建立在 `device_id` + `X-Device-Fp` 身份上，#487 已定该体系整体废弃，改 JWT | 改成「登录态矩阵」：`auth/login` 成功 / 刷新失败清态回登录页 / `auth/me` 401 → 回登录页 / 换机登录；**不再有 device_id** |
| `domain06-claim-ui-orchestration.test.mjs` | 453 | 弹层内「点击 → 请求序列 → 落盘 → 余额刷新 → 文案」跨层编排：领取后直接落地 Key、已领过不说「领取成功」、绑定成功走保存→刷新→关弹层、换 Key 二次确认 | 编排主体（`OursServicesDialog` 里的领取/绑定/换 Key 分支）随体系删除，W1-C 会重写弹层 | 在新的「账户与消费」弹层上重写同样四条顺序断言：登录成功后落 Key、状态来自 `settings/public`、Key CRUD 后刷新用量、二次确认 |
| `domain06-device-backup-hint.test.mjs` | 163 | 设备码可见/可复制、一次性备份提示只弹一次、坏值重建、服务端 `/me` 回填 device_id 写回 | 判断标准即「是否依赖 device_id」——四条全部依赖 | **不重建**：设备码 = 账号这个模型消失，改成「邮箱账号 + 邀请码」；备份提示的**同类风险**（登录态丢失无提示）可并入上面的登录态矩阵 |
| `domain06-dialog-open-readonly.test.mjs` | 221 | 打开弹层只读（有 Key 只发 1 条 `GET /me` / 无 Key 一条不发）、`/me` 404 不补 `/apply`、刷新额度、关收款页后恰好一条 `/me` 且不说「支付成功」 | 断言的请求序列（`/me` `/apply` `/pay-link`）在新链路上不存在 | 重建「打开弹层发了几条请求」这条**唯一能验的编排**：`settings/public` + `user/profile`（或 `v1/usage`）；关收款页后刷新**用量**一次、不说「支付成功」 |
| `domain06-redeem-matrix.test.mjs` | 358 | 兑换结果矩阵 11 行：成功（含 duplicate）/ 202 处理中两种信封 / 409 已用 / 404 无此卡 / 400 Key 无效 / 503 / 429 / 超时 / 池路由不存在兜底旧接口 | 断的是 `POST /redeem-card`（本机池 60013）+ 旧 `/api/redeem` 兜底，两条都在 #484 里被禁 | 按 **A5** 重写：`POST /api/v1/redeem` 成功 / `REDEEM_CODE_USED` / `REDEEM_CODE_NOT_FOUND` / 限流 / 超时后**先查 `redeem/history` 再决定重试**（这条是新的重点，旧用例没有） |
| `domain07-buy-chain.test.mjs` | 464 | 购买链路 plans → pay-link → App 内打开 → 关页刷新；外加「已下线能力的哨兵表」（下单/覆盖单号/轮询/过期必须一条订单请求都不发） | 主链路上游（额度/弹层）重写；哨兵表的对象（`startCheckout` / `pollOrder`）早已不存在，#331 之后就靠这条维持 | 保留**方向**：仍要一条「App 侧没有订单接口」的哨兵断言（现在针对 `POST /api/orders` 等 apia 写路径零调用）；主链路改成 `GET /api/plans` → `POST /api/pay-link` → 内嵌浏览器 → 关页刷用量 |
| `domain07-cid-matrix.test.mjs` | 191 | cid（订单归属客户）脏值矩阵：只认正整数 / 有缓存不打扰网络 / 失败不记忆 / 拿不到不阻断 | cid 是「按 device_id 认客户」的产物 | **不重建**：客户身份改 `auth/me`，`customerId` 缓存整体走 §3 清理清单 |
| `domain07-payment-records-view.test.mjs` | 371 | 付款记录 / 我的购买 正常渲染矩阵（金额、状态、本地时间、卡密后 4 位、筛选 tab、分页、主操作） | 断的是 `PaymentRecordsDialog` / `PurchaseRecordsView` 的现状；两个入口在 W1-C 合并进「账户与消费」，DOM 会变 | 合并成一条渲染矩阵（在合并后的页面上）：订单行字段 / 卡密只露后 4 位 / 状态与时间 / 空筛选 |
| `domain07-payment-records-empty-error.test.mjs` | 212 | 付款记录 / 我的购买 空态与错误态矩阵（无订单 vs 加载失败、401 重填 Key、503 可刷新、筛选后为空） | 同上（DOM 会变） | 与上条**合成一张表的两半**（正常 / 空错互斥），仍是 6 行；401 分支改判「JWT 过期 → 回登录页」，不是「重填 Key」 |
| `contract-c4-order-state.test.mjs` | 207 | C4 契约：订单状态枚举闭合（认不出归 failed）/ 终态不可回退 / 不重复建单（#135 #157） | #331 之后 App 侧**没有订单**，这条契约守的是已经不存在的东西 | **降级为 3 行**：`purchaseStatusOf` 非法值归 failed、终态不轮询、`GET /api/orders` 只读不写；或者并入 `ours-purchases` 的现有表 |
| `contract-c6-quota-key.test.mjs` | 177 | C6 契约：额度口径（1 元 = 100 积分、缺 `remaining_points` 报「查不到」不当 0）+ Key 语义（换 Key 额度带走、指纹上报口径） | 额度来源从 `/me` 改成 sub2api `/v1/usage`（单位元，1 元 = 1 额度），Key 由 `/api/v1/keys` 管理；契约语义整体变了 | 重写成「用量契约」：额度单位是元、缺字段报「查不到」不当 0、Key 停用后聊天 401 的可读文案、JWT 与 `sk-` 两条通道不串味（A3） |

### 1.2 黄金回归（golden）1 条

| 已删文件 | 行数 | 原本覆盖什么 | 重建建议 |
| --- | --- | --- | --- |
| `g07-quota-purchase.test.mjs` | 297 | 一条弹层路径串起「领取 → 刷新额度 → 兑换 +300 → 套餐 → 前往购买（现取 pay-link）→ App 内打开 → 关页再刷新额度」，后端全桩、不产生资金流 | 仍需**一条**黄金主路径（域 6+7 合并的理由不变：同一弹层、同一套桩、用户连着点）：`settings/public` → JWT 登录 → `GET /v1/usage` 显示额度 → `POST /api/v1/redeem` 兑换后额度变化 → `POST /api/pay-link` 打开收款页 → 关页后额度/用量刷新一次。仍是全桩，仍断言「不产生资金流」 |

### 1.3 fixture

| 已删 | 行数 | 说明 |
| --- | --- | --- |
| `domain06-07/fakes.mjs` | 62 | 只被上面三个矩阵用例 import；删完即 0 引用 |

**没有删**的 fixture（`harness.mjs` / `jsx-transform.mjs` / `mini-react.mjs` / `ours-trail.mjs` / `stubs/`）：
删完 12 个用例后它们仍有活引用 —— `harness.mjs` 被 `domain11-email-entry` / `domain11-email-conflict` 用、
`ours-trail.mjs` 被 `ours-trail` / `payment-trail-*` 与 `scripts/shot-mobile.mjs` 用。
按 #487「引用不为 0 的不要硬删」，**整个目录不删**；阶段③重建完成后如果 email 那两条也换掉，再回头清。

## 2. 保留了什么（及为什么）

| 保留 | 为什么 |
| --- | --- |
| `tests/unit/ours-*.test.mjs`、`pay-link`、`purchases-ui`、`payment-trail-*` | 断的是 **apia 支付侧**（plans / pay-link / orders / card trail），#487 明确 W1-E「保留 apia，只改 UI 归属」 |
| `tests/unit/domain11-email-*.test.mjs`、`contract-c9-email` | 邮箱体系由 sub2api 复用（#484 §3.1c），语义未废弃；不在本单删除清单内 |
| `tests/unit/quota-exhausted.test.mjs` | 断的是**对话链路的 402 / `insufficient_quota` 分类与不重试**，与旧额度账本无关 |
| `tests/unit/format-points-i18n.test.mjs` | `formatPoints` 仍被保留下来的支付/轨迹视图使用 |
| `tests/unit/key-identity-451.test.mjs` | Key 身份记录（#451）+ 发送前格式拦截，属保留能力；**其中 `/rotate` 文案那段随 W1-B 更换时一起改** |
| `tests/unit/redeem-pool.test.mjs`、`invite-*.test.mjs`、`bind-key`、`rotate-key`、`ours-invite`、`issue-234-invite-copy` | **旧体系但仍绿**：它们断的是 `/apply` `/me` `/bind` `/rotate` `/redeem` 与池 `/redeem-card`。这些端点正是 #487 表格里「W1-D 清理」的目标，但对应生产代码还有 UI 调用方（见 §3），单删测试会让生产代码**裸奔到 W1-B/C 落地**。处置：**随 W1-B/C 一起删**，见 §4 清单第 1 组 |

> 一句话：**代码删不掉的，测试也先留着**；代码能删的，测试已经删了。

## 3. 为什么「生产代码 0 行」—— 引用数证据（#487 要求先 `git grep` 再删）

被点名的四类目标，逐个查外部引用（`src/` 内除自身文件外的命中数）：

| 目标（#487 表格） | 符号 | `src/` 引用 | 结论 |
| --- | --- | --- | --- |
| `invite/api.ts` 的 `/apply` | `applyForKey` | 2（`OursServicesDialog.tsx`） | 不能删 |
| `invite/api.ts` 的 `/me` | `fetchInviteProfile` | 3（`openFlow.ts`） | 不能删 |
| `invite/api.ts` 的 `/redeem`（邀请码） | `redeemInviteCode` | 2（`OursServicesDialog.tsx`） | 不能删 |
| 卡密（旧链路） | `redeemCardMigrated` | 2（`OursServicesDialog.tsx`） | 不能删 |
| `/bind` | `bindExistingKey` / `bindSuccessKey` | 2 / 9 | 不能删 |
| `/rotate` | `rotateKey` / `rotateSuccessKey` | 3 / 3 | 不能删 |
| `invite/device.ts` 的 device_id | `createDeviceId` / `loadOrCreateDeviceId` / `adoptServerDeviceId` / `ensureDeviceId` | 8 / 2 / 12 / 4 | 不能删 |
| 设备备份提示 | `shouldShowDeviceBackupHint` / `markDeviceBackupHintSeen` / `localStorageFlagStorage` | 2 / 2 / 3 | 不能删 |
| `invite/fingerprint.ts` | `resolveDeviceFp` / `DEVICE_FP_HEADER` | 3 / 2 | 不能删 |
| `ours/mask.ts` | `maskTail` / `maskKey` / `maskCard` / `maskDeviceId` | 9 / 4 / 9 / 4（含 `diagnostics/redact.ts`） | **不能删**（引用数 0 才删，这里 4–9） |
| `ours/**` 的额度账本 | `remaining_points` / `pointsCache` / `remainingPoints` 缓存 | 账本**不存在**：额度只来自 `/me` 的响应，界面不落盘 | 无需删（#484 A4 只需保证重构后仍无本地账本） |

结论：**旧体系的生产代码与 UI 是一对一绑死的**（`OursServicesDialog.tsx` 2100+ 行是唯一调用方）。
真正的删除动作在 W1-B/C 改写这个弹层的那一次提交里，早删只会让 `tsc` 红，或者逼着在 W1-D 里先写一个半成品 UI
—— 与「效率优先、不在重构期间维护两套实现」的口径相反。

## 4. 待后续清理清单（阶段③之前 / 其间必须清掉）

> 判据仍是「引用数 0 才删」。每条都注明现在谁在引用，等到那一天有人接手时不用重新查一遍。

### 4.1 第 1 组：随 W1-B/C 一起删（有 UI 调用方，删 UI 的同一提交里删代码 + 删测试）

| # | 代码 | 现引用的 UI / 服务 | 同批应删的测试 |
| --- | --- | --- | --- |
| 1 | `invite/api.ts`：`applyForKey`、`fetchInviteProfile`、`classifyClaim`、`claimMessageKeyFor`、`runWithDeviceSelfHeal` | `OursServicesDialog.tsx`、`openFlow.ts`、`fingerprint.ts` | `domain06-claim-*`（已删）、`dialog-open-no-apply`、`invite-261-fp-already-claimed`、`invite-device-fingerprint` |
| 2 | `invite/api.ts`：`redeemInviteCode`、`normalizeInviteCode`、`isInviteCodeShape`、`parseInviteRules` | `OursServicesDialog.tsx`、`copy.ts` | `ours-invite`、`issue-234-invite-copy` |
| 3 | `invite/api.ts`：`redeemCardAtPool`、`redeemCardMigrated`、`REDEEM_POOL_URL`、`POOL_ERROR_KEYS`（本机池 60013） | `OursServicesDialog.tsx`；**目标态改为 `POST /api/v1/redeem`** | `redeem-pool` |
| 4 | `invite/bind.ts` 整文件（`/bind`） | `OursServicesDialog.tsx` | `bind-key` |
| 5 | `invite/rotate.ts` 整文件（`/rotate`） | `OursServicesDialog.tsx` | `rotate-key`、`rotate-copy-357`、`key-identity-451`（其中 `/rotate` 文案那段） |
| 6 | `invite/device.ts` 整文件（device_id 生成 / 持久化 / 备份提示 / 服务端回填） | `OursServicesDialog.tsx`、`main.tsx`、`bind.ts`、`email.ts`、`index.html` | 已随 §1 删除 |
| 7 | `invite/fingerprint.ts` 整文件（`X-Device-Fp`） | `OursServicesDialog.tsx`、`api.ts` | `invite-device-fingerprint`、`invite-fp-invalid` |
| 8 | `invite/copy.ts`、`invite/openFlow.ts`、`invite/emailCooldown.ts` | `OursServicesDialog.tsx` | 随 1–3 |
| 9 | `ours/customerId.ts` 整文件（cid，按 device_id 认客户） | `paymentRecords.ts`、`main.tsx`、`api/apiConfig.ts` | `domain07-cid-matrix`（已删）、`ours-inapp-buy`、`ours-payment-logs-312` 里的 cid 段 |

### 4.2 第 2 组：重构后按 A1/A4 复核的死代码（现在没人调，但还挂在 apia 侧）

| # | 符号 | 现状 | 处置 |
| --- | --- | --- | --- |
| 10 | `ours/api.ts` `fetchPlans` / `formatPlanMeta` / `requestIdForCard` | `src/` 引用 **0**，只有测试在调 | W1-E 定案后二选一：要么接回「套餐」入口，要么连测试一起删 |
| 11 | `ours/api.ts` `redeemCard`（旧 `/api/redeem`） | 仅被 `invite/api.ts` 的兜底路径调用 | A5 落地（走 `api/v1/redeem`）后删 |
| 12 | `invite/api.ts` 的 `INVITE_API_BASE`（`config/endpoints.json` 的 `inviteBaseUrl` = `140.210.13.146:60013`） | 8 处（`main.tsx` / `bind.ts` / `rotate.ts` / `email.ts`…） | **A1 的门槛**：`consume` 落地后 `inviteBaseUrl` 必须从配置里消失 |
| 13 | `ours/mask.ts` | **4 个函数仍有 4–9 处引用**（`diagnostics/redact.ts` 也要用） | 不删；#487 的「引用数 0 才删」正是不删的理由 |
| 14 | `ours/storage.ts` / `ours/trail.ts` / `ours/paymentRecords.ts` | 支付侧保留（W1-E） | 不删 |

### 4.3 第 3 组：本单已同步、但阶段③重建时要再改一次的地方

| # | 位置 | 现在写了什么 | 重建时要做什么 |
| --- | --- | --- | --- |
| 15 | `tests/domain-map.json`（domain06 / domain07） | 新增 `note`：旧基准已删、待重建；已移除 11 条指向已删文件的引用 | 把新用例路径补回去，删掉 `note` |
| 16 | `tests/golden/README.md` | G7 行删除 + 「为什么现在没有这条」的说明 | 新黄金用例写好后补齐表格、耗时与负向验证 |
| 17 | `docs/testing/coverage/domain-06-07.md` | 顶部 W1-D 状态块 + §4.1/§4.4 增列「W1-D 状态=旧体系，待重构后重建」 | 按实现重写 §4，删掉状态列 |
| 18 | `docs/testing/coverage/feature-coverage.md` | 顶部 W1-D 说明块；F6-10/F6-12/F6-13/F7-16 与 C1–C9 已标注 | 重建后重算 §1.1 域 6/7 计数（本单没动计数：删测试不等于功能点消失） |
| 19 | `docs/testing/report.md` | §6 变异表 A2/A3 标注「守卫已删」（**该文件由 `pnpm test:report` 生成，§6 是手写节，重跑会覆盖 —— 见文件内 follow-up**） | 等生成器保留手写节后再更新 |

## 5. 重建时必须覆盖的新链路（按 #484 白名单）

| 域 | 端点 | 重建用例要验什么（只验用户会遇到的路与失败态） |
| --- | --- | --- |
| 启动 | `GET /api/v1/settings/public` | 注册 / 邀请 / 邮箱入口是否显示**只由它决定**（本地不维护第二份开关） |
| 身份 | `POST /api/v1/auth/login`、`/refresh`、`GET /auth/me` | 登录成功落态；刷新失败清态回登录页；401 回登录页；token 不明文进 IndexedDB |
| 额度 | `GET /v1/usage`（sk-）、`GET /api/v1/user/profile` | 额度**只来自后端**；缺字段报「查不到」，不当 0；无本地账本 |
| 卡密 | `POST /api/v1/redeem`、`GET /api/v1/redeem/history` | 成功到账；超时**先查 history 再决定重试**；`REDEEM_CODE_USED` 与「自己上次成功」区分 |
| Key | `/api/v1/keys` CRUD | 创建防重复、改名/停用、删后用旧 Key 聊天 401 的可读文案 |
| 邀请 | `POST /api/v1/auth/validate-invitation-code`、`GET /api/v1/user/aff` | 邀请码只在注册时一次填定；返利按比例（单位元）；`circular_invite` / `already_redeemed` 旧文案不得出现 |
| 邮箱 | `/api/v1/auth/send-verify-code`、`/user/account-bindings/email` | 绑定/换绑/解绑；`email_verify_enabled` 决定注册是否强制验邮箱 |
| 支付（保留） | apia `GET /api/plans`、`POST /api/pay-link`、`GET /api/orders`、`GET /api/card/trail` | 三个入口合并成一个「账户与消费」后的读取与空/错态；**不自动重试 pay-link** |

**不要重建的**：device_id / 指纹 / 本机池 `/redeem-card` / 邀请「填码立刻得积分」/ 订单状态机（本地）/ `cid`。
它们在新链路里没有对应物 —— 这一点请在本文件被下次修改时仍然保留。

## 6. 验收自查（本单已跑，2026-11-20）

```bash
npx tsc -p tsconfig.json                      # exit 0
npx oxlint src rspack.config.ts               # 0 warnings / 0 errors（217 files）
node tests/run-layer.mjs unit                   # 174 文件全 PASS
node --test tests/unit/contract-*.test.mjs      # 17 条全绿（C8 证据可执行 21/21）
node tests/run-golden.mjs                       # 9 条全 PASS（墙钟 13.5s）
node scripts/check-test-layout.mjs --strict     # 孤儿 0 / 命名 0 / 落位 0 / 散放 0
node scripts/check-test-duplication.mjs         # 逐字重复 0 组，基线豁免 3 组（未变）
node scripts/check-doc-refs.mjs                 # 合格（仅 WARN）
```

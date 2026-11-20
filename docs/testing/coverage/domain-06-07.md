# 域 6（额度与卡密）+ 域 7（购买与订单）功能点盘点与覆盖映射

> ## ⚠️ W1-D 状态（#487，2026-11-20）：本章的自动化用例已整体删除，待阶段③重建
>
> 域 6 / 域 7 的旧回归基准（`device_id` 身份、本地额度口径 `remaining_points`、卡密兑换池
> `/redeem-card`、邀请码 `/redeem`、领取 `/apply`、`/me`、订单状态与购买链路）**已随旧体系一起删除**，
> 不是注释掉：
>
> | 已删除用例 | 现在本该覆盖什么 |
> | --- | --- |
> | `tests/unit/domain06-claim-identity-matrix.test.mjs` | 领取 / 绑定 / 换 Key 的身份与落盘矩阵 |
> | `tests/unit/domain06-claim-ui-orchestration.test.mjs` | 弹层内领取 / 绑定 / 换 Key / 兑换的跨层编排 |
> | `tests/unit/domain06-device-backup-hint.test.mjs` | 设备码展示 / 复制 / 一次性备份提示 |
> | `tests/unit/domain06-dialog-open-readonly.test.mjs` | 打开弹层只读 + 刷新额度 + 关收款页刷新 |
> | `tests/unit/domain06-redeem-matrix.test.mjs` | 兑换结果矩阵（202 / 409 / 404 / 503 / 429 / 超时） |
> | `tests/unit/domain07-buy-chain.test.mjs` | 购买链路 plans → pay-link → App 内打开 → 关页刷新 |
> | `tests/unit/domain07-cid-matrix.test.mjs` | cid（订单归属客户）与脏值矩阵 |
> | `tests/unit/domain07-payment-records-view.test.mjs` | 付款记录 / 我的购买 正常渲染矩阵 |
> | `tests/unit/domain07-payment-records-empty-error.test.mjs` | 付款记录 / 我的购买 空态与错误态 |
> | `tests/unit/contract-c4-order-state.test.mjs` | 兑换 / 订单状态机语义（C4） |
> | `tests/unit/contract-c6-quota-key.test.mjs` | 额度与 Key 语义（C6） |
> | `tests/golden/g07-quota-purchase.test.mjs` | 额度 + 购买 黄金主路径（G7） |
>
> 下表里凡标注「旧体系，待重构后重建」的行，指的就是这些用例覆盖过的东西 —— 表本身保留作
> **重构后的功能点清单**（哪些点还在、哪些随体系消失）。重建要求与替代路径见
> `docs/testing/rebuild-after-refactor.md`。

> ## ⚠️ #487 收口追加（2026-11-20）：旧支付 UI 的 5 个用例已随之删除
>
> 三弹层合一（设置页三个入口 → 一个「账户与消费」页）合并完之后，旧弹层本体与时间线数据层
> 一并下线，测它们的用例也一起删（测的是已不存在的 DOM / 已删的模块，留着只会红）：
>
> | 已删除用例 | 原本测什么 |
> | --- | --- |
> | `tests/unit/ours-trail.test.mjs` | 时间线数据层（`ours/trail.ts`，已删）的解析 / 分页 / 重试 |
> | `tests/unit/payment-trail-ui.test.mjs` | 时间线视图（`PaymentTrailView.ts`，已删）的渲染与筛选 |
> | `tests/unit/payment-trail-paging.test.mjs` | 时间线「加载更多」/ 空筛选（同上，已删） |
> | `tests/unit/payment-trail-card-lookup.test.mjs` | 卡密溯源面板（同上，已删） |
> | `tests/unit/purchases-ui.test.mjs` | 「我的购买」列表视图（`PurchaseRecordsView.ts`，已删） |
>
> 仍然保留并继续覆盖本域：`ours-api` / `ours-purchases` / `ours-payment-records` / `ours-inapp-buy` /
> `pay-link` / `ours-payment-logs-312`（时间线那两个 stage 已从断言里去掉）与
> `tests/integration/ours-services.test.mjs`。下表「覆盖状态」列里提到这几个已删用例的行，
> 以本块为准。


> 归属：Issue #362「功能点收集与分层测试覆盖盘点」。本文件只做**盘点与映射**，不写测试、不改源码、不产生资金流。
> 表格格式、分层定义（L0/L1/L2/L3）、`覆盖状态` 取值均按 #362 原文；额外增加一列 `需真实后端?`（资损域专用口径）。
>
> ⚠️ **覆盖状态以实际用例为准，改动后必须同步更新本表**：`覆盖状态` 列说的是**当前仓库里真实存在、
> 且能跑绿的用例**，不是 #362 汇编当时的判定。#362 的盘点结论随时会过期（例：#452 的 P1–P4 落地后
> 这几条已从「部分覆盖」变为「已覆盖（含异常）」）。用例新增 / 删除 / 失效后，**必须在同一个 PR 内**
> 同步改本表（含 §7 计数）；只改用例不改表 = 本表立刻过期，等于没有本表。

## 0. 审计基线与方法

| 项 | 内容 |
| --- | --- |
| 代码基线 | `372703b`（feat(release): buildType 收敛为枚举… #330/#350）。已用 `git diff --stat 372703b origin/main(f182748)` 核对：`src/services/invite/**`、`src/services/ours/**`、`OursServicesDialog.tsx`、`PaymentRecordsDialog.tsx`、`PurchaseRecordsDialog.tsx`、`PaymentTrailDialog.tsx` 在两者间**零差异**，故基线不影响本表结论 |
| 审计对象 | `src/services/invite/{api,bind,copy,device,fingerprint,openFlow,rotate}.ts`、`src/services/ours/{api,customerId,mask,paymentRecords,purchases,storage,trail,transport}.ts`、`src/components/settings/{OursServicesDialog,PaymentRecordsDialog,PurchaseRecordsDialog,PaymentTrailDialog,PurchaseRecordsView,PaymentTrailView}` |
| 分层判定依据 | 逐条读源码 + 逐条读用例断言（不是看文件名），再对 `tests/unit` 逐文件实跑取证 |
| 实跑证据 | 本域 18 个 unit 文件全部 PASS（单文件 191–500ms）：`ours-invite` `ours-api` `ours-purchases` `ours-payment-records` `ours-trail` `ours-inapp-buy` `pay-link` `purchases-ui` `payment-trail-ui` `rotate-key` `bind-key` `redeem-pool` `dialog-open-no-apply` `invite-261` `invite-device-fingerprint` `issue-234-invite-copy` `format-points-i18n` `provider-ours`；`quota-exhausted` 在基线即 FAIL（属对话链路域，非本单） |
| 实跑证据（L1） | `tests/integration/ours-services.test.mjs` 在基线**实测 FAIL（33.2s）**：卡在 `helpers.selectProviderKind` 的渠道按钮（`aria-disabled=true`）；`tests/integration/ours-order-overwrite.test.mjs` **实测 TIMEOUT（180s）**：`scenarioWebReturn` 里等不到已删除的 `/buy` 回跳 |
| 结论 | 本域自动化**只有 L0**；L1/L2 现存 4 个文件断言的是 #331 已删除的 `/buy` 建单链路，`tests/regression` 整层未接线（见 §5） |

### 0.1 必须先说清的一件事：#331 之后「购买与订单」不再是「下单 + 轮询」

任务书给的参考功能点里有「下单带 cid / native 购买跳转系统浏览器 / 网页版顶层跳转 / 回跳参数解析 / 订单轮询 / 重新下单覆盖单号(#157) / `latest_fulfilled` 兜底 / 订单过期 / 支付后未回调」。按**实际代码**这些**已经整体下线**：

- `42a3a68 chore(pay): 停用 /api/buy 与 pollOrder，套餐空态收敛（#331）(#343)` 删除了 `startCheckout`、`pollOrder`、`orderStore.ts`、`returnParams.ts`、`withBuyCustomerId`、`CheckoutBrowser.resolveLocation`；
- 现在的购买链路是：`GET /api/plans`（通常返回 `{"plans":[]}` 空态）→ `GET /api/pay-link` 现取联动小铺地址 → `Browser.open` **App 内**打开 → 关页面回调 `refreshBalance()`；App 侧**没有订单、不轮询、不显示「支付成功」**；
- 因此本表把这些点如实记为 `不适用（已下线 #331）`，而不是假装「未覆盖」——**否则会催生一批测已删代码的用例**（现存 4 个 integration 文件正是这个坑）。

## 1. 图示

```
覆盖状态：已覆盖 / 部分覆盖 / 未覆盖 / 不适用（已下线）
L0 / L1 / L2：✓ = 有断言   △ = 有但为静态体检（源码正则/match）   — = 无
L3：— = 无需要  需真机 = 只能在真机/模拟器验
需真实后端?：是 = 结论依赖服务端真实行为（打桩测不出真相）；否 = 打桩即可判定
```

## 2. 域 6：额度与卡密（17 个功能点）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 需真实后端? | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F6-01 | 打开「我们的服务」弹层（本机已有 Key）→ 看到额度与设备码 | 设置 → 我们的渠道 → 我们的服务 | 只发 `GET /me`，显示「N 元」（100 积分 = 1 元折算，#487）；不自动领取、不覆盖已有 Key | 只读失败给可读文案 + 可重试；`device_not_found` 提示「本机未绑定，请领取或绑定」 | ✓ `dialog-open-no-apply[2b]` ★`ours-invite[3]` | △ `ours-services[C]`（实测红） | — | 需真机 | 已覆盖 | 否 | #100 #75 |
| F6-02 | 打开弹层（本机无 Key）→ 给「领取新 Key / 我已有 Key」二选一 | 同上 | **一条写请求都不发**，停在选择态 | 不发请求，无错误提示（这是正常态） | ✓ `dialog-open-no-apply[1]` ★`openFlow` | △ 同上 | — | 需真机 | 已覆盖 | 否 | #100 |
| F6-03 | 点「领取新 Key」→ 服务端发一把 Key 并送 100 积分，同时上报设备指纹 | 选择态 → 领取新 Key | `POST /apply` 201，Key 落盘、余额刷新；请求头带 `X-Device-Fp` | 网络/超时文案可重试（同 device_id 幂等，重试安全）；`KEY_MISSING` 当失败不落空 Key | ✓ `ours-invite[2]` `fingerprint[3]` `dialog-open[4]` | △ `ours-services[C]`（红） | — | 需真机（指纹） | 部分覆盖（缺组件级端到端） | **是**（真实发 Key/100 分） | #21 #243 |
| F6-04 | 同一台设备重复点「领取」→ 仍是同一把 Key、不重复发额度 | 同上 | 200 已申请，`firstTime=false`，Key 不变 | 不报错（幂等）；仍按成功展示 | ✓ `ours-invite[2]` | — | — | — | 部分覆盖（服务端幂等未验） | **是** | #21 |
| F6-05 | 同一指纹换 device_id 再领 → 不再新发一份额度（回到原账号） | 清数据/换设备码后再次领取 | 200 + `already_claimed:true` + 原账号原额度；本地写回服务端给的 device_id | 老 build 静默建新号（201 + `new_user_granted:false` + 另一个 device_id）时**不许显示成功** | ✓ `invite-261[1][2][4]` `invite-device-fingerprint[3]` | — | — | 需真机 + 真后端 | 部分覆盖（仅客户端判定） | **是** | #243 #261 #264 |
| F6-06 | 弹层内点「刷新额度」 | 弹层 → 刷新 | `GET /me` 重取 `remaining_points` 并刷新显示 | 失败保留旧值 + 文案；`device_not_found` 不静默补发 Key | ✓ `openFlow.refreshProfile`（`dialog-open[2b]` 同函数） | — | — | — | 部分覆盖（UI 按钮点击无自动化） | 否 | #75 #100 |
| F6-07 | 额度按元显示「N 元」（旧积分 100:1 折算），不显示 token | 弹层额度行 | 文案只有元（两位小数）；1 元 = 1 额度，无 USD | 不得出现 `$`/`USD`/`token` | ✓ `ours-api[2]` `format-points-i18n` | — | — | — | 已覆盖 | 否 | #75 → #487 |
| F6-08 | 填别人的邀请码 → 建立绑定关系（奖励文案按 `reward_points` 区分） | 弹层 → 邀请 → 输入码 → 提交 | `reward_points>0` → 「绑定成功，+N 元」；`=0` → 「邀请关系已绑定」（不显示 +0）；规则行来自 `invite_rules` | 规则缺失整行隐藏，不回落「双方各得 1 元」 | ✓ `ours-invite[4]` `issue-234-invite-copy` ★`copy.ts` | ✓ `issue-234-invite-copy`（浏览器桩，未随 #331 失效） | — | 需真机 | 已覆盖 | **是**（奖励真实入账） | #234 |
| F6-09 | 邀请码全部错误态（无效/自己的码/已绑过/次数用尽/限流/互填） | 同上 | 六类 + `circular_invite` 各有专属中文，绝不出英文码 | 各自文案 + 是否可重试区分（限流可重试，语义错误不可） | ✓ `ours-invite[5]` `issue-234-invite-copy[5]` | ✓ `issue-234[5]` | — | — | 已覆盖 | 否 | #21 #234 |
| F6-10 | 输入卡密兑换 → 额度到账并刷新额度 | 弹层 → 卡密兑换 | `POST /redeem-card` 200 `ok:true`，显示 +N 元，清空输入、刷新余额 | 失败保留输入可重试；卡密只露后 4 位 | ✓ `ours-api[5]` `redeem-pool[1][2][10]` | △ `ours-services[H]`（红） | — | 需真机 | **已覆盖（含异常）**：~~`domain06-claim-ui-orchestration`~~（旧体系，待重构后重建） P4（兑换成功、`/me` 失败不得说成「兑换失败」）；真实入账仍需后端 | **是**（真实入账） | #21 |
| F6-11 | 兑换失败四态：卡已用 / 卡不存在 / Key 无效 / 服务不可用 | 同上 | 409 已用、404 无此卡、400 Key 无效、503 可重试，各一句可读文案 | 不把 409 说成「网络错误」；不提示换卡当成功 | ✓ `ours-api[6]` `redeem-pool[3][4]` | — | — | — | 已覆盖 | 否 | #21 |
| F6-12 | 兑换 202「处理中」→ 不是失败、不催重试 | 同上 | 显示「处理中」，清空输入，提示稍后刷新 | 文案里**不能出现「失败」** | ✓ `redeem-pool[5]` `ours-api[5]` ★~~`domain06-claim-ui-orchestration`~~（旧体系，待重构后重建） P1 | — | — | — | **已覆盖（含异常）**：P1（3 行：202+CREDIT_PENDING / 200+CREDIT_PENDING / 202 空 body） | 否 | #21 #259 #452 |
| F6-13 | 同一张卡超时后重发 → 仍是同一笔（幂等） | 同上 | `request_id`/卡号即幂等键；`duplicate:true` 按成功 | 重发不产生第二笔记账 | ✓ `redeem-pool[2]` `ours-api[5]` | — | — | — | **已覆盖（含异常）**：~~`domain06-redeem-matrix`~~（旧体系，待重构后重建） P2（3 行：2 并发 / 3 并发 / 两张不同卡）；池侧唯一约束本身仍需真后端 | **是** | #21 #452 |
| F6-14 | 更换 Key（二次确认）→ 换出新 Key，旧 Key 立即失效 | 弹层 → 更换 Key → 确认 | 确认文案写明「旧 Key 立即失效、换出后无法找回」；成功立刻落盘并刷新额度 | **失败绝不清掉本地旧 Key**；`device_not_found` 不补 `/apply`；置灰防连点 | ✓ `rotate-key[1]–[9]` △`[10][10b]`（源码正则） | — | — | 需真机 | 部分覆盖（二次确认仅静态体检） | **是** | #90 #100 |
| F6-15 | 「我已有 Key」→ 把已有 Key 绑到本机设备码 | 选择态 → 我已有 Key → 粘贴 → 绑定 | `POST /bind`；`already_bound:true` 也显示「绑定成功」（不说「已绑过」） | 四类错误各有文案；仅链路不通才换备用域名重试一次 | ✓ `bind-key[1]–[7]` `dialog-open[3]` | — | — | 需真机 | 部分覆盖（缺组件级端到端） | **是** | #86 |
| F6-16 | 设备码展示 / 复制 / 一次性备份提示 / 服务端回填写回本地 | 弹层 → 设备码行 | 完整可见可复制；首次提示「设备码=账号」一次后不再弹；`/me` 回填的合法 device_id 写回本地 | 存储不可用时仍可见可复制；坏值当没回，绝不写坏本地 | ✓ `ours-invite[1]` `invite-261[5]` `redeem-pool[8]` | △ `ours-services[B]`（红） | — | 需真机（剪贴板/跨启动持久化） | 部分覆盖 | 否 | #72 #261 |
| F6-17 | 设备记录丢了（`device_not_found` / `invalid_device`）→ 自愈一次 | 兑换 / 刷新时自动 | `POST /apply` 补一把 Key 落盘后重试一次原请求；`invalid_device` 重建设备码后只读重查 | 只重试一次，绝不循环；`/rotate` 与弹层打开**不做**这种自愈 | ✓ `redeem-pool[6][7]` `invite-261[6]` `dialog-open[2]` | — | — | 需真机 | 已覆盖 | **是** | #261 #100 |

## 3. 域 7：购买与订单（16 个功能点）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 需真实后端? | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F7-01 | 打开购买区 → 看到套餐（名称 / ¥价格 / 积分） | 弹层 → 购买 | `GET /api/plans`，价格与积分一律取服务端，客户端不写死 | 非 2xx / 非法 JSON → 「套餐加载失败」可重试 | ✓ `ours-api[1]` | △ `ours-services[F]`（红） | — | — | 已覆盖 | 否 | #135 #331 |
| F7-02 | 套餐全线下架 → 空态，但购买入口照常可用 | 同上 | `{"plans":[]}` → `status:'empty'`，空态块 + 「前往购买」仍可点 | **不得报「加载失败」**（会让用户以为网络坏了反复重试） | ✓ `ours-api[1]`（空/全 disabled）★`ours-inapp-buy[A]`（`ours-plans-empty`） | — | — | 需真机 | 已覆盖 | 否 | #331 |
| F7-03 | 点「前往购买」→ 现取联动小铺收款页地址 | 弹层 → 前往购买 | `GET /api/pay-link` 每次现取，只接受 `https` | 503 / `ok:false` / 非法 JSON / 非 https → 「收款通道暂不可用」；网络/超时另给可重试文案 | ✓ `pay-link[A][B]` `ours-api[isOpenableCheckout]` | — | — | — | 部分覆盖（真实地址必须真后端） | **是** | #331 |
| F7-04 | 收款页在 **App 内**打开，关掉即回原页面 | 同上 | `Browser.open`（`presentationStyle=popover`）；关闭回调恰好一次 | 插件缺失 / Web 环境 → 返回 false，提示「没能在 App 内打开」且**不整页跳走** | ✓ `pay-link[C][D]` `ours-inapp-buy[C][E]` | — | — | 需真机（真实 WebView/插件） | 部分覆盖 | **是** | #331 |
| F7-05 | 关掉收款页 → 回到 App 时刷新一次额度 | 收款页关闭 | 触发 `refreshBalance()`，额度按服务端最新值变 | **绝不显示「支付成功」**（没有订单可查，结果以买家拿到的卡密为准） | △ `pay-link[C]`（只测回调触发一次） | — | — | 需真机 | **未覆盖**（组合行为零断言） | 否 | #331 |
| F7-06 | 付款记录：累计实付 + 每笔金额/状态/时间/卡密后 4 位 | 弹层 → 付款记录 | 只读 `GET /api/orders`；`total_paid_yuan` 一直按账号级展示（不受筛选影响） | 401 提示重填 Key（不给重试）；503 可重试；空列表给空态 | ✓ `ours-payment-records`（数据层） ★`formatRecordTime` | — | — | — | 部分覆盖（**弹层 DOM 零测试**） | 否 | #115 |
| F7-07 | 我的购买：状态筛选 tab（全部 / 已发卡 / 待支付 / 已过期） | 弹层 → 我的购买 | tab 映射后端 `status`；切换回第一页；只有当前 tab `aria-selected` | 筛选态空列表 → 「换个筛选看看」，与「还没买过」区分 | ✓ `purchases-ui[5][5b]` `ours-purchases[status]` | — | — | — | 已覆盖 | 否 | #158 |
| F7-08 | 我的购买：分页（每页 20，上一页/下一页） | 同上 | `limit` 恒定 20、`offset` 透传；翻页可用态跟 `hasNextPage` 一致 | 脏 limit/offset（0、负数、NaN、1000）夹取到 20/100/0，不崩 | ✓ `purchases-ui[4]` `ours-purchases[clamp/hasNextPage]` | — | — | — | 已覆盖 | 否 | #158 |
| F7-09 | 卡密只露后 4 位；点「查看完整卡号」才展开 | 付款记录 / 我的购买列表 | 列表恒为掩码；完整卡密只在展开后进 DOM 与内存，不进 localStorage/日志 | 收起后从 DOM 消失；`null`/短卡号不整条泄露 | ✓ `ours-purchases[maskCardNo]` `purchases-ui[1][6c]` `payment-trail-ui` | — | — | — | 已覆盖 | 否 | #115 #158 |
| F7-10 | 卡片上的下一步动作：已发卡→去兑换；待支付→去支付 | 我的购买列表 | 已发卡只给「去兑换」；`pending` 给「去支付」；已兑换显示「已兑换」；过期/失败无主操作 | 不给错动作、不给展开卡号 | ✓ `purchases-ui[6][6b][6c][6d]` | — | — | — | 已覆盖（渲染+回调分支） | 否 | #158 |
| F7-11 | 订单/卡密轨迹时间线（五状态、事件轴、卡密溯源） | 订单详情 → 轨迹 | `GET /api/orders/<no>/trail`；EXPIRED ≠ FAILED；已支付未发卡给「等几秒」；已兑换显示积分/时间/Key 尾号/是否本人 | 404 单号查不到 → 「没有找到这笔记录」；503 → 「服务暂时不可用」+ 可重试，绝不说成「没有记录」；未知事件用服务端文本兜底 | ✓ `ours-trail` `payment-trail-ui`（18 条） | — | — | — | 已覆盖 | 否 | #189 |
| F7-12 | 收款通道各类失败都不白屏、不整页跳走 | 前往购买 | 所有失败留在弹层内给中文文案 | 非 https 地址绝不打开；非法 JSON 当通道不可用 | ✓ `pay-link[B]` | — | — | — | 已覆盖 | 否 | #331 |
| F7-13 | 订单归属：只看到「属于自己」的历史订单（cid） | 付款记录 / 我的购买 | cid 来自 `/api/orders` 的 `customer_id`，落缓存复用；脏值（0/负数/非数字）当「不知道」 | 拿不到 cid **只是看不到历史**，不再阻断付款（#331 后） | ✓ `ours-payment-records[2]` `ours-purchases[customerId]` | — | — | — | 部分覆盖（`ensureCustomerId` 的 `/me` 通道与 provider 注入零测试） | **是** | #115 #135 |
| F7-14 | 网页版购买 = 顶层跳转 `/buy`，回跳参数 `?no=&order_token=` 解析后查单 | 网页版点「去支付」 | ~~浏览器顶层导航到 `/buy?plan=&cid=`；回跳自动查单~~ | ~~无回跳参数则不查单~~ | — | ✗ 过期（`ours-webpay` 仍断言） | — | — | **不适用（已下线 #331）** | — | #36 #331 |
| F7-15 | 重新下单覆盖本地单号（#157）+ `latest_fulfilled` 兜底展示 | 再次点「去支付」 | ~~第二单覆盖存档；服务端兜底字段直接展示已发卡~~ | ~~不守着旧单轮询~~ | — | ✗ 过期（`ours-order-overwrite` 仍断言） | — | — | **不适用（已下线 #331）** | — | #157 #331 |
| F7-16 | 订单轮询 / 支付后未回调 / 订单过期 | 收银台返回 | ~~2s 轮询到 fulfilled 显示卡密尾号~~；现存唯一轮询是轨迹页 PAID 状态 3–5s、上限 2 分钟 | ~~超时不回调查不到单~~ → 现在没有订单可查 | ✓ 轨迹页轮询 `payment-trail-ui`（"PAID 每 3~5 秒，最多 2 分钟"） | — | — | — | **已覆盖（含异常）**：~~`domain07-buy-chain`~~（旧体系，待重构后重建） P3（3 行：过期单 0 定时器 / paid 单 4 秒到点只再拉一条 / 切筛选清定时器）；下单侧仍不适用（已下线 #331） | 否 | #157 #189 #331 #452 |

## 4. 拟定用例（9 条，表驱动优先；覆盖全部 33 个功能点）

口径（维护者 2026-11-19 修正）：**测试点尽可能少、覆盖尽可能全**。一张表跑多行，不逐场景堆用例；下方每条都注明它覆盖哪些功能点 ID。

### 4.1 拟定用例表

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点 ID | 覆盖分支数 | 需真实后端? | 不可合并原因 | W1-D 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 兑换结果矩阵 | L0 | 是（1 表 9 行） | F6-10 F6-11 F6-12 F6-13 | 9 | 否 | — | 旧体系，待重构后重建（原落位用例已删） |
| C2 领取 / 绑定 / 换 Key 身份与落盘矩阵 | L0 | 是（1 表 10 行） | F6-03 F6-04 F6-05 F6-14 F6-15 F6-17 | 10 | 否 | 与 C1 分表：C1 的输入是「卡密 + Key、写账本」，C2 是「设备码 + Key、换发/落盘」，断言对象与副作用完全不同 | 旧体系，待重构后重建（原落位用例已删） |
| C3 弹层只读与选择态 + 关收款页刷新 | L1（组件级，假 transport / 假 Browser） | 是（1 表 6 行） | F6-01 F6-02 F6-06 F7-05 | 6 | 否 | 唯一能断言「打开弹层到底发了几条请求」的位置（#100 的历史 bug 就在这层），纯函数测不到 | 旧体系，待重构后重建（原落位用例已删） |
| C4 领取 / 绑定 / 换 Key 的 UI 编排 | L1 | 否（1 场景串 3 路径） | F6-03 F6-14 F6-15 F6-16 | 5 | 否 | 验「点击 → 请求序列 → 落盘 → 余额刷新」的跨层顺序，L0 单函数无法表达 | 旧体系，待重构后重建（原落位用例已删） |
| C5 设备码与一次性备份提示 | L1 | 是（1 表 6 行） | F6-16 F6-01 | 6 | 否 | 依赖 storage 生命周期（跨会话标记、坏值重建），与 C3 的请求序列无关 | 旧体系，待重构后重建（原落位用例已删） |
| C6 购买链路 plans → pay-link → Browser.open → 关闭刷新 | L1（**替换 4 个过期 integration 文件**） | 是（1 表 7 行） | F7-01 F7-02 F7-03 F7-04 F7-05 F7-12 | 7 | 否 | 必须按真实顺序串起来（先取地址、后开页、关页再刷新），拆开就测不到顺序错误 | 旧体系，待重构后重建（原落位用例已删） |
| C7 付款记录 / 我的购买 正常渲染矩阵 | L0（视图层 `.ts` + renderToStaticMarkup） | 是（1 表 5 行） | F7-06 F7-07 F7-08 F7-09 F7-10 | 5 | 否 | — | 旧体系，待重构后重建（原落位用例已删） |
| C8 付款记录 / 我的购买 空态与错误态矩阵 | L0（视图层） | 是（1 表 5 行） | F7-06 F7-07 | 5 | 否 | 空/错态断言的是「不渲染列表 / 不给无意义重试 / 不出英文原文」，与 C7 的正常态断言互斥，同一 DOM 快照测不了两头 | 旧体系，待重构后重建（原落位用例已删） |
| C9 cid 归属与脏值矩阵 | L0 | 是（1 表 5 行） | F7-13 | 5 | 否 | 历史订单可见性独立于渲染（C7/C8），且用于重建已死的 `issue-135` 回归 | 旧体系，待重构后重建（原落位用例已删） |

无需新增用例（L0 已足，勿重复测）：F6-07 额度只显示积分、F6-08 邀请文案、F6-09 邀请错误码、F7-11 轨迹时间线。

### 4.2 先做减法：可合并 / 可删的现有用例

| 对象 | 现状 | 处置 | 预计削减 |
| --- | --- | --- | --- |
| 4 个 integration 文件（ours-services 682 行 / ours-webpay 479 / ours-buy-native 407 / ours-order-overwrite 594） | 断言 #331 已删的 `/buy` + 轮询，`pay-link` 出现 0 次；ours-services **实测 FAIL 33.2s**，ours-order-overwrite **实测 TIMEOUT 180s** | 全部停用，由 C6 单文件替代 | **4 文件 / 2162 行** |
| `redeem-pool[3]` 与 `ours-api[6]` | 两处都逐字断言「五类兑换文案」 | 合并进 C1 表驱动 | −1 处重复 |
| `rotate-key[8]`、`bind-key[3]`、`ours-invite[5]` | 三处各自逐字断言错误码文案（与 i18n parity 用例重复） | 合并进 C2 表驱动 | **−10 条断言组** |
| `payment-trail-ui`（18 条 test） | 多为单字段渲染断言 | 压成 6 行表驱动 | **−12 条** |
| `purchases-ui`（17 条 test） | 同上 | 压成 C7/C8 两表 | **−11 条** |
| `ours-invite[1]` 与 `invite-device-fingerprint[1]` | 都测设备码 / 指纹形状 | 合并进 C5 | −1 处重复 |
| `tests/regression/`（12 文件） | 不在 `run-layer` 的 LAYERS、CI 不引用 → 整层从未执行；`issue-135` 还 import 了已删的 `startCheckout` | C9 重建该回归；其余 11 个需接线或删（域外，仅报数） | 12 文件待接线 |

净效果：**−4 个集成文件（2162 行）− 约 35 条重复 test 块 + 9 条新用例 ≈ 净减 26 条**。

### 4.3 缺口 → 用例映射（风险分级）

| 缺口 | 风险 | 由哪条用例覆盖 |
| --- | --- | --- |
| G1 域 7 的 L1/L2 整体失效（4 个文件断言已删链路） | P0 | C6 |
| G2 余额刷新编排（领取 / 换 Key / 兑换成功后） | P0 | C3 + C4 |
| G3 关收款页 → 刷新额度组合零断言 | P0 | C3（已并入表内） |
| G4 付款记录弹层组件级零测试 | P1 | C7 + C8 |
| G5 换 Key 二次确认只有源码正则断言 | P1 | C4 |
| G6 `ensureCustomerId` 无测试 + 回归层已死 | P1 | C9 |
| G7 202「处理中」的 UI 组合 | P1 | C1（判定）+ C7（展示） |
| G8 设备码复制 / 备份提示只一次 | P2 | C5（+ 真机 M3/M4） |
| G9 邀请规则行降级组合 | P2 | 无需新增（`issue-234-invite-copy` L0 已覆盖，表里补 1 行数据即可） |
| G10 轨迹页轮询上限 2 分钟计时 | P2 | 无需新增（`payment-trail-ui` 表驱动时保留该行） |

**合计：新增 9 条用例，其中 0 条需要真实后端**；需真实后端的 12 个功能点全部落在 §6 的人工 / 真机清单，不混入这个数字。

### 4.4 异常分支补充（#452 支付 P1–P4，2026-11-20）

#452 只补**异常分支**（不追求把「部分覆盖」全变「完全覆盖」）。支付侧四条落在已有的域批次文件里，
表驱动：4 个 `test()` / 11 行，合计 +0.7s。

| 分支 | 覆盖功能点 | 落位（文件 → 用例） | 断言点 | 仍不可自动化 | W1-D 状态 |
| --- | --- | --- | --- | --- | --- |
| P1 兑换返回 202「处理中」 | F6-12（+F6-13 语义） | `tests/unit/domain06-claim-ui-orchestration.test.mjs` → `P1/F6-12`（3 行：202+CREDIT_PENDING / 200+CREDIT_PENDING / 202 空 body） | 进入「处理中」态且文案不含「失败」；请求在飞时提交按钮与输入框禁用（禁止重复提交）；无「重试」按钮；只有「刷新额度」→ 再打一条 `GET /me` 后按服务端新值显示（确认到账靠手动刷新，不是轮询） | 服务端真正的「稍后入账」时序（M8 弱网） | 旧体系，待重构后重建（原落位用例已删） |
| P2 并发兑换同一张卡 | F6-13 | `tests/unit/domain06-redeem-matrix.test.mjs` → `P2/F6-13`（3 行：2 并发 / 3 并发 / 两张不同卡） | 同一张卡只成功一次、另一笔 409 `card_used`（文案「不要重复提交」、不可重试、不是网络错误）；账本**只加一次**；并发锁只按卡号 | 池侧唯一约束本身（M6/M7 真后端） | 旧体系，待重构后重建（原落位用例已删） |
| P3 订单过期后重新下单 | F7-16（+F7-11） | `tests/unit/domain07-buy-chain.test.mjs` → `P3/F7-16`（3 行：过期单 / paid 单 4 秒到点 / 切「已关闭」筛选） | 过期单 0 个轮询定时器、不显示「正在准备卡密」；paid 单恰好 1 个、4 秒到点只再拉一条（定时器不叠加）；切筛选与关闭弹层后定时器清零 | 「本地单号覆盖 / 不重复建单」子项随 #331 整条下线（App 侧已无订单，见 §0.1 与 C6/6、C6/7 哨兵表）——本行只钉仍在的轮询残留 | 旧体系，待重构后重建（原落位用例已删） |
| P4 兑换成功但额度刷新失败 | F6-10 F6-06 | `tests/unit/domain06-claim-ui-orchestration.test.mjs` → `P4/F6-10`（2 行：`/me` 超时 / 断网） | 兑换结果区仍是「兑换成功 +100」，界面不出现「兑换失败」；额度区如实报「刷新」失败并留「刷新额度」；手动刷新成功后额度更新，且**不重发** `/redeem-card` | `/me` 真实超时行为（M8） | 旧体系，待重构后重建（原落位用例已删） |

负向对照（每条分支改坏 → 用例红，证据见 #452 评论）：202 不再当 pending、兑换按钮不按 busy 禁用、
池 4xx 当成功、轮询 cleanup 不清定时器、`/me` 失败改写兑换结论。

**状态回填（2026-11-20，随 #455 合并）**：§2/§3 的 `覆盖状态` 已按上表改到位 ——
F6-12 → `已覆盖（含异常）`（P1）、F6-13 → `已覆盖（含异常）`（P2，池侧唯一约束仍需真后端）、
F7-16 → `已覆盖（含异常）`（P3，下单侧仍不适用 #331）、F6-10 → `已覆盖（含异常）`（P4，
真实入账仍需后端）。**没有把「部分覆盖」整片改成「已覆盖」**：仍有 `需真实后端?=是` 的 12 项
与 §5 的 6 项零断言，它们照旧留在 §5/§6。

## 5. 完全没有任何测试的清单

| # | 对象 | 说明 |
| --- | --- | --- |
| N1 | `F7-05` 关收款页 → 刷新额度 | 组合行为零断言（`openPayLinkInApp` 单测只验回调触发一次，未验「回调里真的发了一次 `/me`」） |
| N2 | `PaymentRecordsDialog.tsx` 整块 DOM | 数据层 `paymentRecords.ts` 有测，弹层组件无任何测试（对比：`PurchaseRecordsDialog`/`PaymentTrailDialog` 都把视图抽成 `.ts` 才有测） |
| N3 | `OursServicesDialog.tsx` 的按钮编排（领取/绑定/兑换/换 Key/刷新） | 只有 `ours-inapp-buy[A]`、`rotate-key[10]` 这类**源码字符串体检**，没有任何真跑点击 |
| N4 | `customerId.ensureCustomerId` / `setCustomerIdProvider` / `fetchCustomerIdFromProfile` | 无测试；`tests/regression/issue-135-buy-customer-id.test.mjs` 引用了已删除的 `startCheckout`，且 `tests/regression/` **不在 `run-layer` 的 LAYERS（unit/integration/e2e/device）里、CI 也不引用** → 该整层是死的（12 个文件、含本域唯一 cid 回归） |
| N5 | `copyText`（剪贴板写入，`utils/clipboard`） | 仅 `copy-limit` 覆盖长度截断逻辑，真实写入路径零测试 |
| N6 | 邀请码「复制」按钮（`ours-invite-copy`） | 同上，按钮 → `copyText` 的编排无测试 |

> 说明：F6-01/02 的「弹层打开只读」、F6-09 的错误码矩阵等虽无 L1/L2，但 L0 已覆盖其**判定逻辑**，故不列入本清单（属「部分覆盖」）。

## 6. 只能人工 / 真机验证的清单

| # | 项 | 为什么自动化不了 |
| --- | --- | --- |
| M1 | `X-Device-Fp` 真实上报（`ANDROID_ID` → `sha256(id+包名)`） | 依赖原生 `DeviceFingerprintPlugin`；浏览器桩只能造 64 位十六进制，验不了真值来源与「明文不过 JS」 |
| M2 | 同指纹换 device_id 的服务端判定矩阵（#261/#264） | 结论由服务端「指纹 ∪ IP」限流与账号归属决定；客户端只是如实上报。必须真后端 + 真机（#261 记录的矩阵也只能人工复测） |
| M3 | 剪贴板真实写入（设备码/邀请码/卡密） | WebView `navigator.clipboard` 行为按内核/权限而异 |
| M4 | 设备码跨启动持久化 / 清站点数据即丢账号 | 需真机安装态与 SAF/WebView 存储生命周期 |
| M5 | `Browser.open` 收款页真实打开与关闭回跳（#331） | 原生插件 + 系统 WebView；桩里只能验调用参数 |
| M6 | 真实发卡与额度入账（领取 100 分、邀请奖励/返现、卡密兑换、换 Key 后额度不丢） | 涉及真实资金/账本，禁止在自动化里建真单 |
| M7 | `/rotate` 后旧 Key 立即失效、`/bind` 的 `already_bound` 语义 | 服务端状态机，只能真后端 curl 探针或真机 |
| M8 | 弱网 / 超时 / 429 下的重试与「幂等重发仍是一笔」 | 需真实网络抖动与服务端去重 |
| M9 | 老 WebView 内核差异（事件/剪贴板/Browser 插件缺失的降级） | L3 设备层定义 |

## 7. 计数汇总

| 域 | 功能点 | 已覆盖 | 部分覆盖 | 未覆盖 | 不适用（下线） |
| --- | --- | --- | --- | --- | --- |
| 域 6 额度与卡密 | 17 | 10 | 7 | 0 | 0 |
| 域 7 购买与订单 | 16 | 9 | 4 | 1 | 2 |
| 合计 | 33 | 19 | 11 | 1 | 2 |

> 计数口径（2026-11-20，随 #452 P1–P4 回填后按**行级状态重算**）：本表原先自报「域 6 = 7/10」与行级
> 实况（8/9）不符（#362 汇编 §6-C13 已登记）；本次直接按 §2/§3 的 `覆盖状态` 列逐行重算，
> 不再手填。改任何一行状态都必须重算本表。

- 完全没有任何测试：**6 项**（N1–N6，其中 N4 含一整层失效的 `tests/regression`）
- 需真实后端才能定论（表内 `需真实后端?=是`）：**12 项** = 域 6 的 F6-03/04/05/08/10/13/14/15/17（9 项）+ 域 7 的 F7-03/04/13（3 项）
- 域 6 已有 L0：**17/17**；域 7 已有 L0：**13/13 有效功能点**（不含 3 个下线项）
- L1/L2 有效覆盖：**域 6 为 0**（唯一 L1 文件实测红）；**域 7 为 0**（4 个文件全部断言已删链路）
- **拟定新增用例：9 条（C1–C9），其中需真实后端 0 条**；同时可削减 4 个集成文件（2162 行）+ 约 35 条重复 test 块（净减约 26 条）
- 只能人工 / 真机验证：**9 项**（M1–M9，见 §6）

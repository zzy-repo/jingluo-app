# 域 11：邮箱账号（绑定 / 换机登录）—— 功能点盘点与覆盖映射

| 项 | 值 |
| --- | --- |
| 母单 | #438（为 #421 建回归基准，按五层落位）；上游 #410（测试体系 epic） |
| 被测功能 | #421 邮箱账号适配（客户端部分）——实现已合并（#426，`feat/email-adapt`） |
| 本文件范围 | **域 11 邮箱账号**的功能点盘点 + 五层落位 + 负向验证记录；只盘点与映射，不改源码 |
| 读码基准 | 本仓 `main` @ `dfe6db0`（含 #426 合并）；行号均指此树 |
| 盘点日期 | 2026-11-20 |
| 涉及代码 | 客户端 `src/services/invite/{api,email,emailCooldown,device,bind}.ts`、`src/components/settings/OursServicesDialog.tsx`（邮箱段）、`src/i18n/{zh,en}.ts`（`oursEmail*` / `oursInviteErrEmail*` 共 13+ 条） |

**本域特点**：整条链路都是「判断 + 状态机」，**没有一个分支需要真实后端才能判定**——服务端邮箱功能在生产仍未启用（#421 正文），所以全部用例打桩；`/email/*` 的响应体形状就是唯一契约。
反过来，这一域最贵的失效是**静默走错分支**：409 落到「已绑定过邀请码」、登录后没覆盖 `device_id`、`not_found` 被当成 `device_not_found`、`has_email` 缺字段被当成 `false`。四条都不会报错，只会让用户看到一句错的文案或者一个空账号。

## 0. 口径

### 0.1 分层映射（仓库分层 ↔ #438 的分层）

| 仓库层 | 依赖 | 本文登记为 | 备注 |
| --- | --- | --- | --- |
| `tests/unit`（纯函数 / 映射 / 判定） | 零浏览器、零网络、假 transport | **L0** | `domain11-email-parse`、`contract-c9-email` |
| `tests/unit`（组件级：真弹层 + mini-react + 假 transport） | 零浏览器、假定时器 | **L0 组件** | `domain11-email-entry`、`domain11-email-conflict` |
| `tests/integration` | playwright + chromium + 标准产物 `dist-standard` + `page.route` 打桩 | **L1** | `domain11-email-flow` |
| `tests/golden` | playwright + 标准产物 `dist` + 原生桥桩 | **golden** | `g11-email`（主路径哨兵） |
| 真机 / 真服务端 | AVD + 真实 `/email/*` | **L3** | 服务端未上线，**不适用（当前无法执行）** |

`✓` 该层有断言；`部分` 只覆盖部分分支；`—` 无；`不适用` 无自动化手段或前提不存在。

### 0.2 覆盖状态取值（照 #362）

`已覆盖` / `部分覆盖（缺异常分支）` / `未覆盖` / `不适用（无自动化）`。

---

## 1. 功能点表（11 项）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F11-01 | 服务端没开邮箱功能时，设置页**看不到**这一块 | 设置 → 数据管理 → 我们的服务 | 探测 `GET /email/status` 回 `404 + error.code:"not_found"` → 邮箱整块不渲染，旧流程一字不变（设备码 / 额度 / 邀请码照旧） | 老部署上多出一个点了必然报错的按钮 | ✓ `parse[T4]` `entry[E1]` | — | — | — | **已覆盖** | #421 |
| F11-02 | 没绑过 → 只给「绑定邮箱」；已绑 → 显示脱敏邮箱、不再给绑定入口 | 同上 | `has_email:false` → 「绑定邮箱」；`true` → 显示 `email_masked`，绑定按钮消失 | 已绑用户被允许再绑一次（服务端必然 409） | ✓ `entry[E2]` | ✓ `flow[F1]` | — | — | **已覆盖** | #421 |
| F11-03 | 发验证码：6 位数字码 + 频控倒计时 | 弹层邮箱区 → 发送验证码 | `POST /email/send-code` body 只有 `device_id+email`；`resend_after` / `retry_after` **逐秒递减**，倒计时期间按钮 disabled、归零可点 | 只显示一句静态「稍后再试」，按钮仍可连点 → 用户反复撞频控 | ✓ `conflict[D1/D2]` `parse[T2]` | ✓ `flow[F1]` | — | — | **已覆盖** | #421 验收 D3 |
| F11-04 | 提交验证码 → 绑定到本机（`action:"bound"`） | 弹层邮箱区 → 提交验证码 | 显示脱敏邮箱；设备码 / Key 一个字不动；结果行「绑定成功，Key 已保存到本机」 | 绑完仍显示「绑定邮箱」；或顺手把凭据改了 | ✓ `parse[T2]` `contract[C9-E3]` | ✓ `flow[F1]` | — | — | **已覆盖** | #421 |
| F11-05 | 换机登录（`action:"login"`）：用邮箱登上原账号 | 同上（服务端判定为登录） | 响应里的 `device_id` 走 `adoptServerDeviceId` 写回本地、`key` 走 `saveKey` 落盘；文案「已用邮箱登录，本机设备码与 Key 已切换到原账号」 | **最坏的一种绿**：界面说「已登录」，本地还挂在旧设备码上 → 之后 `/me`、兑换全查错账号 | ✓ `contract[C9-E3]` | ✓ `flow[F2]` | — | — | **已覆盖** | #421 #261 |
| F11-06 | 本机已有账号时的冲突选择（`device_has_account`） | 提交验证码后弹冲突面板 | 展示本机原账号剩余额度 + 要换上的邮箱 + 「切换后额度暂时用不了、需客服处理」；选「用邮箱账号」后**带同一个验证码 + choice** 重发；选「保留本机账号」则凭据不动 | 落到中性的「操作失败，请稍后重试」，`device_remaining_points` 被丢弃，用户无从选择 | ✓ `conflict[C1–C3]` `parse[T3]` | ✓ `flow[F3]` | — | — | **已覆盖** | #421 第 3 点 |
| F11-07 | 13 条错误码各自给出能看懂的下一步 | 发码 / 提交 / 探测 | `bad_email` … `account_frozen` 逐条映射到自己的文案（zh + en，占位符对齐）；频控类可重试、语义类不可重试 | 全部落到「操作失败，请稍后重试」；或 429 与 400 共用一句 | ✓ `parse[T3]` `contract[C9-E5]` | — | — | — | **已覆盖** | #421 |
| F11-08 | 409 必须先按 `error.code` 匹配 | 提交验证码 | `customer_has_email` → 「本账号已经绑定过邮箱」；不认识 / 缺 code → 中性文案。**绝不**落到 `/redeem` 的「已绑定过邀请码」 | 用户被告诉「邀请码已绑定」——与他做的事毫无关系 | ✓ `parse[T3]` `contract[C9-E2]` | — | — | — | **已覆盖** | #421 验收 B2 |
| F11-09 | 三态字段：`null`（未开启）≠ `false`（明确没绑） | 全部路径（`/me` 与 `/email/status` 两条来源） | 缺字段 / 非布尔 / 空串 → `null`；界面只在 `true` 时认为「已绑」 | 老服务端上渲染出「绑定邮箱」；或已绑判成未绑、反复催绑 | ✓ `parse[T1]` `contract[C9-E1]` | — | — | — | **已覆盖** | #261 #421 验收 A2 |
| F11-10 | 探测失败与「功能没开」必须分开：`device_not_found` 不是 `not_found` | 打开弹层时的一次只读探测 | 只有 `404 + not_found` → `disabled`；`device_not_found` / 裸 404 / 网络 / 超时 → 真错误，但同样不出入口 | 设备没记录被当成「功能没开」，用户永远等不到入口，也没人知道该自愈 | ✓ `parse[T4]` `contract[C9-E4]` | — | — | — | **已覆盖** | #421 验收 D2 |
| F11-11 | 已绑邮箱后不再催「复制设备码备份」 | 设置 → 我们的服务 → 设备码区 | 已绑（探测或档案任一为 `true`）→ 提示消失；未绑 / 未开启 → 提示照旧（#72 行为不变） | 错的前提（账号已能靠邮箱找回）继续催用户备份，制造多余焦虑 | ✓ `entry[E5]` | ✓ `flow[F1]` | — | — | **已覆盖** | #72 #421 第 5 点 |

**计数：11 项 —— 已覆盖 11 / 部分覆盖 0 / 未覆盖 0 / 不适用 0。**
层级：**L0 有断言 11 项**、**L1 4 项**、L2 0 项、L3 0 项（服务端未上线，真机端到端**当前不可执行**，见 §4）。

---

## 2. 五层落位（#438 的核心要求）

| 层 | 文件 | 条数 | 覆盖 | 耗时（实测） |
| --- | --- | --- | --- | --- |
| L0（纯函数） | `tests/unit/domain11-email-parse.test.mjs` | 5 条（4 张表：三态 / 请求形态 / 错误码 + 附加字段 / 探测判定） | F11-03（请求形态）、F11-07、F11-08、F11-09、F11-10 | ~0.44s |
| L0（组件级） | `tests/unit/domain11-email-entry.test.mjs` | 10 条 | F11-01、F11-02、F11-09、F11-11（未绑侧） | ~0.9s |
| L0（组件级） | `tests/unit/domain11-email-conflict.test.mjs` | 10 条 | F11-03（秒级倒计时）、F11-06（冲突弹窗三分支 + 纯函数边界） | ~0.9s |
| 契约 | `tests/unit/contract-c9-email.test.mjs` | 1 条（5 行表驱动多断言） | 三态 / 错误码优先级 / 登录后账号切换 / 未开启隐藏入口 / 文案边界 | ~0.9s |
| L1 | `tests/integration/domain11-email-flow.test.mjs` | 3 条（绑定 / 登录覆盖 / 冲突选择） | F11-02、F11-03、F11-04、F11-05、F11-06、F11-11（绑定后） | ~12s |
| golden | `tests/golden/g11-email.test.mjs` | 1 条（未绑定 → 绑定成功 → 显示 masked） | F11-02、F11-04 主路径 | ~2.1s |

**总量**：#438 表格要求 7–9 条新用例 —— 实际新增 **10 条**（L0 5 + 契约 1 + L1 3 + golden 1），其余沿用既有 `email-421-*` 的 20 条（**改名并入 `domain11-*`，断言一条未删**，见下）。

### 2.1 与既有 `email-421-*` 的关系（不重复、不丢失）

| 原文件 | 去向 | 说明 |
| --- | --- | --- |
| `tests/unit/email-421-contract.test.mjs` | 拆成 `domain11-email-parse.test.mjs`（R1/R2/R3/R4）+ `contract-c9-email.test.mjs`（R5/R6） | 纯函数留在 L0；「登录后必须切换账号」与「文案 zh/en 对齐」升为跨端语义，进契约层 |
| `tests/unit/email-421-entry.test.mjs` | 改名为 `tests/unit/domain11-email-entry.test.mjs` | 断言零改动（入口显隐 + 备份提示分流） |
| `tests/unit/email-421-conflict-countdown.test.mjs` | 改名为 `tests/unit/domain11-email-conflict.test.mjs` | 断言零改动（冲突三分支 + 逐秒倒计时 + 纯函数边界） |

命名统一 `domain11-*` 后，`check:test-layout --strict` 与 `check:test-duplication` 仍 exit 0（逐字重复组 3 → 3，**未新增**）。

---

## 3. 负向验证（5 组破坏，逐组在 `src/` 现场注入 → 跑 → 还原）

| # | 破坏方式（临时改 `src/`，跑完 `git checkout` 还原） | 期望变红的用例 | 实测结果 |
| --- | --- | --- | --- |
| N1 | `hasEmail` 缺字段处理成 `false`（`readOptionalBoolean` → `readBoolean`） | L0 三态 | ✅ 红：`domain11-email-parse` D11-T1（"缺字段必须解析成 null"）+ `contract-c9` C9-E1 |
| N2 | 409 改回「按状态码优先」（`EMAIL_STATUS_KEYS[status]` 先查，且 409 落回 `oursInviteErrAlreadyRedeemed`） | L0 + 契约 | ✅ 红：D11-T3 两张表（13 条码表 + 附加字段表）+ C9-E2（"409 绝不落到已绑定邀请码"） |
| N3 | 登录成功后不调 `adoptServerDeviceId`（`email.ts` 里 `deviceId = current`，Key 照旧落盘） | L1 + 契约 | ✅ 红：L1 `F2`（"必须把原账号的 device_id 写回本地"）与 `F3`（切换后设备码仍是旧的）+ C9-E3 |
| N4 | 把 `not_found` 当 `device_not_found`（`fetchEmailStatus` 的 disabled 分支判据互换） | L0 探测 + golden | ✅ L0 红：D11-T4（"404 + not_found → disabled"）。**golden 不变红 —— 该破坏在 UI 上不可观测**：两条 404 分支都让 `shouldShowEmailEntry` 为假、入口同样不渲染，只有服务层返回的 `kind` 不同。所以这一条由 L0（`parse[T4]`）+ 契约（`C9-E4`）守，黄金层不重复（黄金层只守主路径，见下方口径） |
| N5 | 让绑定成功后仍提示「复制设备码备份」 | L1 UI 状态 | ✅ 红：L1 `F1`（"绑定成功后必须收起备份提示"）。**注意：这条行为有两道独立保护** —— 渲染条件 `showBackupHint && !emailBound` 与绑定成功后 `setShowBackupHint(false)`；单独拆掉任一道都被另一道兜住（实测全绿），**两道同时拆掉**才变红。这是刻意的冗余（改一处不至于让用户立刻看到错提示），也说明这条断言值得留在 L1 |

**口径说明（N4）**：Issue #438 的预期表把 N4 也指向 golden。实测下来这条破坏在**界面上没有可观测差异**（`disabled` 与 `error` 都让入口整块不渲染），golden 捕获不到；把它写成「golden 也变红」的作者口径其实是把「隐藏入口」与「探测判定的 `kind`」当成了同一件事。真正的守卫点在服务层返回值，因此落在 L0 + 契约，而不是黄金层。

## 4. 预算与耗时（本机实测，2026-11-20）

| 项 | 预算 | 实测 |
| --- | --- | --- |
| L0 增量（`domain11-email-parse`） | ≤1s | **0.44s**（5 条） |
| L0 增量（entry + conflict + contract-c9） | — | 1.8s / 1.8s / 0.9s |
| L1 增量（`domain11-email-flow`，3 条真浏览器路径） | ≤15s | **12.0s** |
| golden 增量（`g11-email`） | ≤5s | **2.4s** |
| golden 整层（10 条） | ≤5 分钟（单条 ≤60s） | **10.8s** 墙钟，10/10 PASS |
| `pnpm test:fast` | ≤60s | **47.9s**（tsc 1.5s + L0 快速子集 29.8s + golden 16.5s，本机 150 文件 / 1064 用例） |

`test:fast` 前后对照的可比性说明：仓库里记录的上一版是 **24.9s**（#409 在空闲机上的实测，当时 unit 154 文件 / golden 4 条）。本机在同一时段用 `main @dfe6db0`（不含本 PR）跑同一条命令是 **69.3s**（超预算，机器同时在跑别的任务），本分支 **47.9s** —— 两台不同时刻的数字不能直接相减；本 PR 自身的增量可以逐项读：L0 新增 4 个文件合计 **~4.9s**、golden 新增 1 条 **~2.4s**。

## 5. 缺口与未测边界

1. **真机端到端（L3）不适用**：服务端 `/email/*` 只在开发分支，生产未启用。发码 → 真的收到信 → 换机登录这条链**无法在真机上验证**；本域所有结论都是「客户端按契约走对了分支」，不是「功能真的可用」。
2. **邮件内容 / 送达**：`oursEmailSentHint` 已如实写明「当前只写入服务端日志，暂时不会真的收到邮件」——这是服务端未上线的**已知局限**，不是客户端缺陷。
3. **服务端 `options` 新增第三个取值**：客户端只认 `use_email` / `keep_device` 两个字面量，其余丢弃（`parseEmailChoices`）。服务端若加 `merge` 之类的新语义，需要客户端同步实现，届时本表 F11-06 要补分支。
4. **小时级限流的秒级倒计时**：`retry_after > 300` 不做秒级倒计时（只给静态「稍后再试」），因为一小时的数字对用户没意义。此边界由 L0 的 P3 纯函数断言覆盖，UI 侧只保证「不倒计时也不锁死按钮」。

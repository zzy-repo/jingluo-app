# 阶段③ 测试重建方案（sub2api 消费侧）

> **本文件只有方案，没有用例。** 它是 #487 阶段③（验收通过后「全量重建回归基准」）的输入，
> 不是施工记录：一个用例都还没写，一条既有测试也没改。
>
> - 上游：#484（客户端约束 + A1–A7 方向验收）、#487（三阶段执行顺序 + 删除口径）、#482（后端拆分定调）
> - 收敛口径：#453（停止「为数字写测试」，只测用户会遇到的路径与失败态）
> - 机械前置：`scripts/check-refactor-direction.mjs`（A1–A6，阶段②收口用），A7 人工截图
> - 生效条件：**A1–A6 全绿之后**才开工。方向没验收就重建，等于把测试钉在会再改一遍的接口上。

---

## 1. 为什么重建（以及删了什么）

#487 的要求是「重构期间不维护两套测试」：支付/兑换相关的旧回归基准**先删**，等新链路定型后按新语义重建。
删掉的不是「覆盖」，是**旧语义的断言**——它们断言的东西（积分折算、`device_id` 身份、客户端账本、
apia 兑换）在新链路里已经不存在了，留着只会以「known-red」的形式腐蚀基线。

### 1.1 删除清单（阶段①，W1-D 归属）

> 下表删除线里的路径（`~~…~~`）= **已经删掉的文件**。`check:doc-refs` 把删除线认作「已删除」
> 标记（计数、不判「文件不存在」），所以这张清单在 #492 落地后不会把 CI 判红。

| 删除对象 | 为什么删 |
| --- | --- |
| ~~`tests/golden/g07-quota-purchase.test.mjs`~~ | 主路径是「领取额度 → 刷新 → 兑换」，兑换打的是池域/apia；新链路里没有「领取」，兑换改打 sub2api |
| ~~`tests/unit/contract-c4-order-state.test.mjs`~~ | 锁的是 apia 订单状态机；客户端不再持有订单状态（#482：不做双写、不做旧端点兼容） |
| ~~`tests/unit/contract-c6-quota-key.test.mjs`~~ | 锁「1 元 = 100 积分」「换 Key 额度不丢」「同指纹不重复发新人额度」——全部是旧邀请/额度体系语义 |
| ~~`tests/unit/domain06-*.test.mjs` / `domain07-*.test.mjs`~~ | 域 6/7 的批次用例，主体是兑换矩阵、邀请领取、额度换算 |
| ~~`tests/unit/ours-*.test.mjs` / `invite-*.test.mjs` 里依赖旧语义的部分~~ | 同上；**只删依赖旧语义的**，纯解析/脱敏/格式化的行保留 |

同步要求（#487 明文）：删测试的同一个 PR 要改 `.github/workflows/ci.yml` 与门禁登记的引用，
保持 CI 绿；**不许用 `continue-on-error` 或放宽门禁换绿**。

### 1.2 保留与「不删」的判据

一条用例只要**断言的是旧语义**才删。判据：

1. 它断言的字段名在新链路上不存在（`remaining_points` / `quota_points` / `carried_used_points` / `device_id`）→ 删；
2. 它断言的行为在新链路上被明确取消（客户端账本、双读兼容、旧数据迁移）→ 删；
3. 它测的是**与链无关的公共能力**（清单解析、导入导出、脱敏规则、门禁负向对照、i18n 门禁）→ **保留**，不动。

---

## 2. 分层与预算

### 2.1 四层，按「用例粒度」分（不是 `docs/TESTING-POLICY.md` 的门禁档位）

| 层 | 是什么 | 落哪 | 跑法 | 本方案增量 |
| --- | --- | --- | --- | --- |
| **L0** | 纯逻辑：一个模块 + 假 transport，无浏览器、无产物、无网络 | `tests/unit/` | `node tests/run-layer.mjs unit` | **≤ 1s** |
| **契约** | 对外语义不变量（调用方观察到的行为），与 L0 同层同跑 | `tests/unit/` | 同上 | 计入上一行的 1s |
| **L1** | 流程级：按用户点击顺序把服务层串起来（假 transport + 内存态），**仍在 Node 里跑** | `tests/unit/` | 同上 | **≤ 15s** |
| **golden** | 真实 dist 产物 + 真浏览器 + 桩后端，只跑主路径 | `tests/golden/` | `node tests/run-golden.mjs` | **≤ 2s** |

**为什么 L1 不放 `tests/integration/`**：现有 integration 层一条 10~60s、整层 8~15 分钟（`docs/TESTING-POLICY.md`
的域门预算只有 5 分钟）。消费侧要的是「流程别断」，不是「浏览器里别断」——浏览器里那一层由 golden 兜。
把流程级放进 unit 层（纯 Node、假 transport），才能同时拿到 ≤15s 和「跑得够勤」。
**本方案不新增任何 `tests/integration/` 用例。**

### 2.2 总预算

| 层 | 文件数 | 用例 / 表行 | 预估耗时（增量） | 预算 |
| --- | --- | --- | --- | --- |
| L0 | 4 | 42 行 | 0.4~0.5s | ≤ 1s |
| 契约 | 4 | 18 行 | 0.3~0.5s | （与 L0 合计 ≤ 1s） |
| L1 | 6 | 27 条 | 10~15s | ≤ 15s |
| golden | 1 文件 / 2 条主路径 | 2 条路径（约 14 条断言） | 1.2~2s | ≤ 2s |
| **合计** | **15 个文件** | **≈ 87 用例 / 表行 + 2 条主路径** | **≈ 12~18s** | 见上 |

**「增量」的含义**：相对「阶段①删完测试后的基线」的差值，不是「这一层总共跑多久」。量法见第 8 节。
被删的旧用例本身也占时间（`domain06-*` / `domain07-*` / g07 合计约 6~9s），所以**净增量很可能更低**。

---

## 3. L0（纯逻辑，4 个文件 / 42 行）

### L0-1 `consume-errors-envelope` —— 三套信封分派

| 项 | 内容 |
| --- | --- |
| 层级 | L0（`tests/unit/`，假 transport） |
| 覆盖什么 | `parseSub2ApiError` 对三套形状的分派：①面板 `/api/v1/**` 的 `{code:<int>, message, reason?}`；②中间件的 `{code:"UPPER_SNAKE"}`；③网关 `/v1/**` 的 `{error:{message,type?,code?}}`；以及 `/v1/usage`、`/v1/sub2api/billing` **不套 `data` 外壳**这条特例。输出统一归一成 `{kind, code, message, retryable}`，`kind ∈ {panel, middleware, gateway, usage-raw, transport, unknown}`，`retryable` 按「GET 可重试 / redeem 不可重试」给出 |
| 负向验证怎么做 | 每条样本再配一条**错位样本**：把网关形状喂给面板解析器、把整数 `code` 当字符串码、`{error:{}}` 缺 `message`、`{"code": "E_1", "message": ""}`；再塞三种「不是 JSON」的体（HTML 502 页、空 body、abort 超时）→ 断言**不抛异常**且 `kind∈{unknown,transport}`、`message` 非空。删掉任一分派分支必须变红 |
| 预估耗时 | ≤ 0.2s（表驱动 14 行） |

### L0-2 `consume-errors-mapping` —— 错误码 → 文案（i18n key）

| 项 | 内容 |
| --- | --- |
| 层级 | L0 |
| 覆盖什么 | 错误码表的**覆盖口径**：表里每个码都映射到一个**存在的** i18n key；`reason` 字段（面板/中间件带回来的 `UPPER_SNAKE`）优先于 `code`；表外码走**兜底 key** 并记一条「映射缺口」日志（`stage` / `reason` / `retryable` 字段符合 `docs/diagnostics-spec.md` 的最小字段集）；`INVITATION_CODE_DISABLED` / `EMAIL_VERIFY_REQUIRED` / `REDEEM_CODE_USED` / `INSUFFICIENT_BALANCE` / `RATE_LIMITED` / `INVALID_TOKEN` 六条必须在表里 |
| 负向验证怎么做 | ① 塞一条表外的码 → 必须走兜底 key 且**打一条缺口日志**（断言日志字段，不断言具体文案）；② 把表里某个 key 改成不存在的 i18n key → 必须红（两层：用例断言 key 能在 `src/i18n` 里解析到 + `pnpm check:i18n` 的孤儿/缺失检查）；③ 把 `reason` 分支删掉、只按 `code` 走 → 必须红 |
| 预估耗时 | ≤ 0.1s（表驱动 12 行） |

### L0-3 `consume-redeem-compensation` —— 兑换幂等补偿

| 项 | 内容 |
| --- | --- |
| 层级 | L0（假 transport，可编程超时/顺序应答） |
| 覆盖什么 | `POST /api/v1/redeem` **没有幂等键**这一事实下的正确流程：超时 → **不重试**，先 `GET /api/v1/redeem/history` 比对本次 code；history 里已有该 code → 记成功（不再 POST）；没有 → 允许**一次** POST 重试；重试仍失败 → 明确「未到账，请稍后核对」态；`409 REDEEM_CODE_USED` 既不判成功也不判失败，必须回查 history 才给结论；history 自身失败（5xx/超时）→ 停手报「待确认」，**不许**再 POST |
| 负向验证怎么做 | ① 首次超时 + history 命中 → 断言 POST 次数 == **1**（把补偿逻辑删掉会变成 2 → 红）；② 首次超时 + history 未命中 → 断言 POST == 2 且第二次前有 history 调用；③ history 500 → 断言 POST 仍为 1；④ 把 history 查询挪到重试**之后** → 断言顺序的用例必须红（顺序用调用序列断言，不只数次数） |
| 预估耗时 | ≤ 0.2s（8 行） |

### L0-4 `consume-auth-refresh` —— JWT refresh 失败清态

| 项 | 内容 |
| --- | --- |
| 层级 | L0 |
| 覆盖什么 | 401 → `POST /api/v1/auth/refresh` 一次 → 成功则**重放原请求一次**；refresh 失败（4xx/5xx/网络）→ 清登录态（token + profile + 任何派生态）并置「回登录页」标记，**不静默重试**；并发 3 个 401 只 refresh **一次**（single-flight）；refresh 成功但重放仍 401 → 不再 refresh（防死循环）；`sk-` 通道的 401 **不触发** JWT refresh |
| 负向验证怎么做 | ① refresh 返回 500 → 断言清态发生且 refresh 调用次数 == 1；② refresh 返回新 token 但重放仍 401 → 断言 refresh 次数仍 == 1（把「重放后不再刷新」删掉会无限循环 → 用例超时/次数断言红）；③ 三个并发 401 → 断言 refresh == 1（去掉 single-flight 变 3 → 红）；④ 网关 `Bearer sk-…` 的 401 → 断言 refresh 次数 == 0 |
| 预估耗时 | ≤ 0.2s（8 行） |

---

## 4. L1（流程级，6 个文件 / 27 条）

统一形态：假 transport（按路径应答）+ 内存存储替身，按**用户的点击顺序**串起来；每个文件 3~6 条，
单文件 ≤ 3s。**不碰浏览器、不碰 dist、不碰真实网络**。

### L1-1 `consume-flow-login` —— 登录 / 注册

| 项 | 内容 |
| --- | --- |
| 覆盖什么 | 启动读 `GET /api/v1/settings/public` → 按 `registration_enabled` / `email_verify_enabled` / `invitation_code_enabled` 决定入口显不显示（**本地不维护第二份开关**）；注册（可带 `verify_code` / `invitation_code`）→ 登录 → `GET /api/v1/auth/me` 拿到身份；登录失败文案走错误码表；2FA 分支单独一条 |
| 负向验证怎么做 | ① 开关全关 → 断言注册入口不渲染（把开关写死成 `true` 必须红）；② 登录返回 `code: 401` 面板信封 → 断言文案来自映射表、且**不清**已有登录态；③ 注册 `429`（5/min）→ 断言提示限流而不是「未知错误」；④ 邀请码非法（`error_code: "INVALID_INVITATION_CODE"`）→ 断言停在注册页且不发出登录请求 |
| 预估耗时 | ≤ 2.5s（5 条） |

### L1-2 `consume-flow-keys` —— Key CRUD

| 项 | 内容 |
| --- | --- |
| 覆盖什么 | 列表（分页参数透传）、创建（`name` / `quota`(USD) / `expires_in_days`）、详情、改名/停用/改额度（`PUT` **无** `key` 字段）、删除；创建超时 → 重试前先 `GET /api/v1/keys?search=<name>` 防重复创建；Key 明文只在创建响应里出现一次 |
| 负向验证怎么做 | ① 创建超时 + search 命中同名 → 断言 POST 次数 == 1（去掉 search 保护变 2 → 红）；② `PUT` 请求体里带上 `key` 字段 → 断言被拒（用例断言序列化后的 body 不含 `key`）；③ 删除返回 404 → 断言列表刷新且提示「已不存在」而不是崩溃 |
| 预估耗时 | ≤ 3s（5 条） |

### L1-3 `consume-flow-quota` —— 额度读取

| 项 | 内容 |
| --- | --- |
| 覆盖什么 | 两条通道各一条：sk- Key → `GET /v1/usage`（不套 `data` 外壳，直接读字段）；JWT → `GET /api/v1/user/profile`；额度**只来自后端**，读不到就显示「查不到」而不是 0；刷新一次不产生本地缓存写入 |
| 负向验证怎么做 | ① 后端返回 5xx → 断言界面是「查不到」且**不是** 0（把兜底改成 0 → 红）；② 断言整个流程**没有**存储写入调用（storage 替身记录调用 → 断言为空，这条是 A4 的运行时对照）；③ 把 `/v1/usage` 的响应外面多套一层 `data` → 断言解析失败并被归到 `kind:'unknown'`（防「自以为读到了」） |
| 预估耗时 | ≤ 2s（4 条） |

### L1-4 `consume-flow-redeem` —— 卡密兑换（成功 / 409 / 超时补偿）

| 项 | 内容 |
| --- | --- |
| 覆盖什么 | 三条路径端到端（服务层）：**成功**（`POST /api/v1/redeem` → 余额刷新一次 → 新额度上屏）；**409 `REDEEM_CODE_USED`**（回查 `redeem/history` → 若命中就是自己上次成功 → 显示「已到账」而不是报错）；**超时补偿**（不重试 → history 命中 → 已到账；未命中 → 一次重试）。补一条「重复点击兑换按钮」只发一次请求（按钮态 + single-flight） |
| 负向验证怎么做 | ① 把补偿逻辑整个删掉 → 超时路径必须红；② 409 直接判失败 → 红；③ 成功后不刷新余额 → 断言「新额度上屏」红；④ 连点两次 → 断言 POST == 1（去掉 single-flight → 2，红） |
| 预估耗时 | ≤ 3s（5 条） |

### L1-5 `consume-flow-email` —— 邮箱绑定

| 项 | 内容 |
| --- | --- |
| 覆盖什么 | `POST /api/v1/user/account-bindings/email/send-code` → `POST /api/v1/user/account-bindings/email`（`{email, code}`）→ `DELETE /api/v1/user/account-bindings/:provider` 解绑；`email_verify_enabled` 关时不显示入口；验证码错误走错误码表；改绑（旧邮箱 → 新邮箱）不产生两个绑定 |
| 负向验证怎么做 | ① 开关关 → 断言入口不渲染；② 验证码错 → 断言文案来自映射表且输入框保留；③ 解绑返回 `code: 404` → 断言幂等（本地态清掉、不报「未知错误」）；④ 把 send-code 与 bind 的开关判断混成一处 → 该条红（两条路径的限流不同：5/min vs JWT） |
| 预估耗时 | ≤ 2.5s（4 条） |

### L1-6 `consume-flow-invite` —— 邀请码校验

| 项 | 内容 |
| --- | --- |
| 覆盖什么 | 注册前 `POST /api/v1/auth/validate-invitation-code` 预校验：`valid:true` / `valid:false + error_code` / `INVITATION_CODE_DISABLED`（= 后台没开，UI 提示「当前未开放」而不是「邀请码错误」）；**邀请关系只能在注册时一次填定**，注册后再填不给入口；`GET /api/v1/user/aff` 的 `aff_code` / `aff_count` / `aff_quota`（返利按 USD）只做展示 |
| 负向验证怎么做 | ① `INVITATION_CODE_DISABLED` 被渲染成「邀请码无效」→ 必须红（这是旧文案残留的典型）；② 注册成功后再调 validate 并期望「补填生效」→ 用例必须断言**没有**补填入口；③ 把 `aff_quota` 当积分显示（USD ↔ 积分混淆）→ 断言单位文案的用例红；④ 旧文案 `circular_invite` / `already_redeemed` 出现 → 断言 i18n key 集合不含它们（与 `check:i18n` 孤儿检查对齐） |
| 预估耗时 | ≤ 2s（4 条） |

---

## 5. 契约（替代被删的 C4 / C6，4 个文件 / 18 行）

契约层只锁「**调用方观察到的对外语义**」——不锁函数名、不锁文件结构、不锁重试算法。沿用既有约定
（一契约一文件、`tests/helpers/contract.mjs` 的装配、失败一句话定位），编号从 **C10** 起（C4 / C6 已删，
不复用旧编号，避免历史台账串味）。

### 契约-C10 `contract-c10-consume-envelope` —— 错误 envelope 三分派

| 项 | 内容 |
| --- | --- |
| 层级 | 契约（`tests/unit/`） |
| 对外语义 | 不管错误来自面板、中间件还是网关，消费层抛给界面的是**同一个形状**：`{kind, code, message, retryable}`；界面不需要知道「这是哪一层返回的」就能决定「重试 / 换 Key / 去登录 / 提示已到账」 |
| 负向验证怎么做 | 分别构造三套信封 + 三种非 JSON 体，断言归一结果同构（同 key 集合、`retryable` 有判定）；删掉任一分派 → 红；把 `kind` 改成「源码层名字」→ 红（契约锁的是语义不是来源） |
| 预估耗时 | ≤ 0.15s（5 行） |

### 契约-C11 `contract-c11-redeem-no-blind-retry` —— redeem 绝不盲目重试

| 项 | 内容 |
| --- | --- |
| 层级 | 契约 |
| 对外语义 | **任何**超时/未知结果下：redeem 的 POST 次数 ≤ 2，且第二次之前一定有一次 `redeem/history` 查询；`409` 永远不以「兑换失败」的形式告诉用户（要么已到账，要么待确认） |
| 负向验证怎么做 | 用调用序列断言的表（超时×{history 命中/未命中/失败}×{409, 500}）覆盖 7 行；把「先查 history」改成「先重试」→ 顺序断言红；把 409 判成失败 → 红。与 L0-3 的分工：L0-3 测**实现**分支，本契约测**接口承诺**（换实现也要过） |
| 预估耗时 | ≤ 0.15s（7 行） |

### 契约-C12 `contract-c12-balance-from-backend` —— 余额只来自后端

| 项 | 内容 |
| --- | --- |
| 层级 | 契约 |
| 对外语义 | 额度只有一个来源（`/v1/usage` 或 `/user/profile`）；读不到就是「查不到」；客户端**不写**任何余额持久化；不存在「本地账本 → 判断能不能发送」这条路径 |
| 负向验证怎么做 | ① 让额度接口失败 → 断言读额度 API 返回「查不到」而不是 0；② 用 storage 替身记录整个流程的写入 → 断言没有任何余额/额度键（这条同时是 #484 A4 的运行时对照）；③ 在源码里 grep 级断言（`remaining_points` / `pointsCache` 零命中）由 `pnpm check:refactor-direction` 的 A4 提供，契约文件里只断言**行为** |
| 预估耗时 | ≤ 0.15s（3 行） |

### 契约-C13 `contract-c13-base-from-config` —— base 只能来自配置

| 项 | 内容 |
| --- | --- |
| 层级 | 契约 |
| 对外语义 | `consume` / `pay` 两个 base 只能来自构建期注入的 `__ENDPOINTS__`；注入缺失时**fail-fast**（抛错），不静默回落到任何默认地址；源码零域名/零 IP |
| 负向验证怎么做 | ① 用假 `__ENDPOINTS__` 注入不同 base → 断言请求 URL 前缀跟着变（把 base 写死 → 红）；② 删掉 `__ENDPOINTS__.consume` → 断言抛错而不是回落到 `pay` 或空串；③ 机械证据由 A6（`scripts/check-refactor-direction.mjs --json`）提供：`src/` 零字面量 + `config/endpoints.json` 两组齐备 |
| 预估耗时 | ≤ 0.15s（3 行） |

---

## 6. golden（替代被删的 g07：1 个文件 / 2 条主路径）

| 项 | 内容 |
| --- | --- |
| 层级 | golden（`tests/golden/`，真实 dist + Chromium + 桩后端，单条 ≤60s、单文件两条共用一个浏览器会话） |
| 文件 | `tests/golden/g07-consume-*.test.mjs`（沿用域 7 的槽位：域 7 = 「账户与消费」；文件在阶段③才建） |
| 主路径 1 | **登录 → 看余额 → 兑换卡密 → 余额变化**：桩 `settings/public` → 登录 → 打开「账户与消费」→ 额度区显示 0 → 输入卡密 → 兑换 → 额度区显示 300（桩后端固定轨迹 0 → 300，不做中间态断言） |
| 主路径 2 | **购买 → 拿卡密 → 复制**：套餐区 → 前往购买（桩返回收款页地址，`@capacitor/browser` 替身只记录打开地址）→ 关页 → 「我的卡密」出现新卡密 → 点复制 → 断言剪贴板内容 == 卡密原文，且卡密**不**出现在页面全文/DOM 之外的任何地方（`brief()` 快照不含卡密） |
| 只测什么 | 「主路径没断」。所有失败分支（409、超时、限流、验证码错）留在 L0 / L1，**不在 golden 里重复**（判据沿用 `tests/golden/README.md`：删掉这条断言后 L1 里没有别的用例会因此变红） |
| 负向验证怎么做 | 手搓三次变异，必须各自变红：① 把「兑换成功后刷新额度」删掉 → 路径 1 红；② 把复制按钮接到错误的字段 → 路径 2 红；③ 让 `/v1/usage` 桩返回 500 → 路径 1 必须红（而不是静默显示 0）。另外重建 `dist` 后必须重跑：陈旧产物守卫已由 `tests/helpers/golden.mjs` 提供，别绕过 |
| 预估耗时 | 增量 **≤ 2s**（两条路径共用一个 `serveGoldenApp` + 一个 page；桩后端就是既有 `CapacitorHttp` 替身，不新增浏览器实例） |

同步：`tests/golden/README.md` 的域表要同时更新（g07 那一行改写为「账户与消费」两条路径），
否则下次「改了哪个域跑哪条」的对照表就是错的。

---

## 7. 明确不建（四条红线）

1. **不测 sub2api 内部行为。** 客户端只承诺「按 #484 §三 的白名单调用、按 §四 的三套信封解析」。
   后端业务规则（并发兑换串行化、额度分配算法、后台对账、限流窗口的精确边界）不是客户端的契约，
   测了只会把后端实现细节焊进客户端仓库。所有用例的打点都止于**请求形状 + 响应解析 + 界面状态**；
   桩后端按 #484 的接口表应答，不模仿后端内部状态机。
2. **不为覆盖率写用例。** 每一条用例必须能回答「它坏了，用户会遇到什么」；答不上来的不写。
   覆盖率数字（`docs/testing/coverage/**`）只在变更后重新采集，**不作为阶段③的完成判据**（#453 口径）。
3. **不复用旧语义、也不新造 harness。** 装配一律走既有件：`tests/helpers/contract.mjs`（契约装配 +
   `.js→.ts` 钩子）、`tests/helpers/runtime.mjs`（`runCase` / `serveDist`）、`tests/helpers/golden.mjs`
   （`runGolden` / `openGoldenPage`）、`tests/helpers/injected.mjs`（`__ENDPOINTS__` 兜底）、
   `tests/helpers/ours-check.mjs`（自查断言骨架）。桩放 `tests/fixtures/consume/`（新目录）或原位改造
   `tests/fixtures/domain06-07/`，**不往 `tests/fixtures/` 根目录扔文件**（`check:test-layout --strict` 会红）。
4. **不建「旧链路兼容」与「已砍功能」的用例。** 旧数据迁移、双写/双读、apia 兑换、`device_id` 身份、
   积分↔人民币折算——#482 已明确不做，重建它们等于把删掉的东西请回来。UI 的布局/配色/文案措辞也一律不测
   （A7 只验「三个入口合成一个」这一件事，靠人工截图）。

---

## 8. 预算怎么量（阶段③收尾时照这个做，不靠自报）

```bash
# 1) 基线：阶段① 删完测试后跑一次，落一份 timing-baseline
node scripts/test-report.mjs --measure
# 2) 重建完成后同口径再跑一次，读 tests/timing-baseline.json 的差值
node scripts/test-report.mjs --measure
# 3) 门禁侧证据（一次跑完 A1–A6，机器可读）
node scripts/check-refactor-direction.mjs --report --json direction.json
```

- 三个预算都是**增量**：`unit` 层前后耗时差 ≤ (1s + 15s)、`golden` 层差 ≤ 2s。
- 数字只由 `--measure` 写入 `tests/timing-baseline.json`，**不手填**（该文件的 `what` 字段已经这么写着）。
- 超预算的处理顺序：先砍用例（回到「用户会不会遇到」），**不许**放宽预算或改用 `--warn` 门禁。

---

## 9. 落地顺序（阶段③开工时按此执行）

| 步 | 做什么 | 判据 |
| --- | --- | --- |
| 1 | 确认 A1–A6 全绿（`pnpm check:refactor-direction`）+ A7 截图 | exit 0，A7 有图 |
| 2 | L0 四个文件（错误分派 / 映射 / 补偿 / refresh） | unit 层增量 ≤ 1s |
| 3 | 契约四个文件（C10–C13） | 同上（与 L0 合计 ≤ 1s） |
| 4 | L1 六个流程文件 | 增量 ≤ 15s |
| 5 | golden `g07-consume-account` + 更新 `tests/golden/README.md` 域表 | 增量 ≤ 2s，整层仍 ≤ 5 分钟 |
| 6 | 门禁同步：`check:test-layout --strict` 孤儿 0 / 命名合规；`check:test-duplication` 不新增；`check:i18n` 无新孤儿；`.github/workflows/ci.yml` 引用补齐 | 全绿 |
| 7 | 手工变异 3 次（第 5 节的负向验证），逐条记录「注入 → 变红 → 还原 → 变绿」 | 三次都红过 |

---

## 10. 完成判据（阶段③「重建完成」= 这五条同时成立）

1. 15 个文件按第 2 节的层落位，`node tests/run-layer.mjs unit` 与 `node tests/run-golden.mjs` 全绿；
2. 预算三条都达标（L0 含契约 ≤1s、L1 ≤15s、golden 增量 ≤2s），数字来自 `--measure`；
3. 每个文件都有**可复述的负向验证**记录（注入什么 → 哪条红），并写在 PR 正文里；
4. `check:test-layout --strict` / `check:test-duplication` / `check:i18n` / `check:doc-refs` 全绿，
   且**没有**用 `continue-on-error`、没有新增基线条目；
5. 旧语义的遗留为零：`pnpm check:refactor-direction` 的 A4 仍 PASS（没有账本回来）、
   `grep` 不到 `remaining_points` / `device_id` 鉴权 / 旧池域地址（A1 仍 PASS）。

---

## 附：用例数预算（一句话版）

> L0 4 文件 42 行 + 契约 4 文件 18 行 + L1 6 文件 27 条 + golden 1 文件 2 条主路径
> = **15 个文件 / ≈ 87 条用例·表行 / 增量 ≤ 18s**（L0+契约 ≤1s · L1 ≤15s · golden ≤2s）。

# 域 3（渠道与模型）+ 域 4（会话管理）功能点盘点 → 最小充分集

Issue: #362（[TRACK] 功能点收集与分层测试覆盖盘点）
本文只做盘点、映射与用例规划，不含测试代码、不改源码。

## 0. 一页结论

| 项 | 值 |
| --- | --- |
| 功能点 | **22**（域 3 十三个 / 域 4 九个） |
| 新增用例（上一版） | 27 条（域 3 九条 + 域 4 十八条） |
| **新增用例（本版，合并后）** | **6 条**（域 3 三条 + 域 4 三条），降幅 **−78%** |
| 覆盖分支 | 70 个分支 / 6 条用例（≈ 12 分支每条） |
| 功能点覆盖 | **22 / 22** —— 新增用例**补齐** 11 点（F3-06/07/08/09、F4-01～F4-06、F4-09）、**加固** 5 点（F3-01/03/05/13、F4-07）、不涉及 6 点（F3-02/04/10/11/12、F4-08，现有用例已充分） |
| 现有测试可削减 | ≈ **53 条重复检查**（域 3 45 + 域 4 8）、**5 个执行入口**、**≈ 515 行**（其中 `full-acceptance` 860 → ~400 行，−53%） |
| 完全没有任何测试的功能点 | 2 个（F4-03 会话置顶、F4-05 删除会话）→ 由 N4-A / N4-C 一并覆盖，不单独增用例 |
| 不可合并项 | 6 条里 **5 条有硬边界**（N3-B、N3-C、N4-A、N4-B、N4-C），只有 N3-A 是纯合并体；边界共 5 类，见 §5 末列与 §6 |

> 收敛原则：**一条用例 = 一张表**。同一函数的分支、同一组件的状态、同一操作的正常/异常/边界，全部压进同一个用例的表格行；只有当**层级不同且下层无法表达**或**源码边界不允许下沉**时才单列。

## 1. 盘点基线

| 项 | 值 |
| --- | --- |
| 仓库 / 工作区 | `zzy-repo/deepseek-app`，工作区 `issue-336` |
| 分支 / 提交 | `ci/wire-manifest-log-gates` @ `3de42e3`（2026-11-19 盘点） |
| 测试文件存量 | unit 116 / integration 35 / e2e 2 / device 1 / regression 12 / adversarial 1 |
| 统一入口 | `node tests/run-layer.mjs <unit\|integration\|e2e\|device\|all>` |
| 取证方法 | 每个功能点 `grep -rln "<关键词>" tests/`；命中文件必须**是断言**（不是测试内打桩）才计覆盖；无反证写「grep 无命中 → 未覆盖」 |

### 分层口径（沿用 #362，并给本仓落点）

| 层 | #362 定义 | 本仓落点 | 单条预算 |
| --- | --- | --- | --- |
| **L0 单元** | 纯函数、解析器、校验器、状态机；异常分支 | `tests/unit/*.test.mjs`（纯 Node，零浏览器） | 全量 < 30s |
| **L1 集成** | 模块间契约、真实 dist 产物、请求/响应序列（可打桩） | 真 mock 上游 / stub `fetch` 断言收包与请求体；`tests/regression/*`、`tests/adversarial/*` | 单文件 < 90s |
| **L2 端到端** | 用户主路径，真实 DOM 交互 | `tests/integration/*`（Playwright + Chromium） | 单场景 < 60s |
| **L3 设备** | 真机/模拟器特有 | `tests/device/*` | 手动/按需，不进 CI |

`覆盖状态`（#362）：`已覆盖` / `部分覆盖（缺异常分支）` / `未覆盖` / `不适用（无自动化）`。

---

## 2. 域 3：渠道与模型

### 2.1 功能点表（13 点）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F3-01 | 四渠道切换（deepseek / anthropic / openai / ours） | 设置 → 数据管理 → 「服务类型」 | 切换后输入行、请求目标、能力入口随之变化；选择落盘；切回仍保留该渠道自填值；API Key 不丢 | 渠道值非法/未存 → 回落构建默认（内测 `ours` / 标准 `deepseek`），不得白屏或发空渠道请求 | ✓ | — | ✓ | 需真机 | **已覆盖** | #56 #181 #274 #341 · `provider-ours`、`provider-channels`[1]–[6]、`internal-build`[F] |
| F3-02 | 能力入口随渠道显隐 | 切渠道 → 回到输入区 | deepseek 全开；anthropic 仅对话+思考；openai/ours 仅基础对话；思考与快速/专家入口四渠道**恒常驻**（#341），不支持的能力「不渲染」而非置灰 | 露出点了就 404 的入口（历史：`/v1/chat/completions/files` 2 小时 2059 条 404） | ✓ | ✓ | ✓ | 需真机 | **已覆盖** | #324 #341 #56 · `provider-caps-lock`、`thinking-entry-consistency`、`provider-channels`（四渠道×四入口矩阵）、`full-acceptance`[6] |
| F3-03 | 请求路径与鉴权头按渠道 | 发消息 / 点「测试」 | deepseek → `/anthropic/v1/messages`+`x-api-key`+`anthropic-version`；anthropic → `/v1/messages`+`x-api-key`（不带 version）；openai/ours → `/v1/chat/completions`+`Bearer` | 地址自带版本段拼成 `/v1/v1/...` → 上游裸 404；第三方中转多带 `anthropic-version` → CORS 预检失败 | ✓ | ✓ | ✓ | 需真机 | **已覆盖** | #56 #303 #37 #274 · `attachment-endpoint-303`（`joinUrl`）、`probe-auth-protocols`[1][2]、`provider-anthropic`、`request-body` |
| F3-04 | 请求体按渠道裁剪扩展字段 | 发消息 | 裸 Anthropic 不带 `safety_check`/`title`/`tools`/`role:'latest_reminder'`；官方原样保留；openai/ours 零思考字段 | 未知顶层字段 / 非法 role → 上游 400，整轮中断 | ✓ | ✓ | ✓ | — | **已覆盖** | #324 #297 #340 · `thinking-adapters`[1]–[8]（mock 收包）、`request-body` |
| F3-05 | API Key 校验与探测 | 设置 → 填 Key → 「测试」 | 用**输入框当前值**探测 `GET {baseUrl}{paths.models}`，鉴权头按渠道；未填 Key/地址本地拦下不发请求；结果给一句可读结论 | 未保存就发空 `Bearer`；Key 被判死后仍反复自动打上游 | — | ✓ | ✓ | 需真机 | **已覆盖** | #56 #59 #303 · `probe-auth`、`probe-nokey`、`probe-auth-protocols`、`key-rejection-303`[1][4] |
| F3-06 | 探测失败文案分类（六档） | 同上 | `invalid`/`timeout`/`network`/`html`/`json`/`http` 各有专用文案；成功档区分「有列表」与「通了但空」 | 网络错误写成 HTTP 状态码；HTML 当接口数据；只丢上游原文 | ✗ | ✗ | ½ | — | **部分覆盖（缺异常分支）** | #56 #303 · 仅 `probe-auth-protocols`[3]（401 文案）、[4]（网络文案）。`settingsTestTimeout`/`Html`/`BadJson`/`OkEmpty`/`BaseUrlInvalid` **grep 无命中** |
| F3-07 | 模型列表拉取与选择 | 设置 → 模型行 | 解析 `data`/`models`/`model_list`/`result` 四种形状；下拉可选；选中写回并落盘；空列表提示「暂无模型」 | 解析失败当空列表；401 显示「列表加载失败」而非「Key 无效」 | ✓ | ✗ | ✗ | — | **部分覆盖（缺异常分支）** | #6 #56 #303 · `model-picker-parser`（解析器）。`model-probe-status` 在用例内自实现 status→reason 映射、**不 import `probeProvider`**（附录 B-2）；`grep -rln listbox tests/` → 仅 `feedback-draft` |
| F3-08 | 模型/地址默认值与自填校验 | 设置 → 地址行、模型行 | 内置渠道不渲染地址与模型行、值只来自 `spec.defaults`、setter 拒写；自填渠道必须填；地址须 `http(s)` 可解析并去尾斜杠；模型不得为空 | 内置渠道把地址/模型写进 localStorage；非法地址「保存后没反应」；空模型当有效值 | ✓ | — | ✓ | — | **部分覆盖** | #303 #339 · 默认值/锁定：`provider-ours`、`provider-caps-lock`；自填落盘：`provider-channels`[3][4]。缺口：`grep -rln "normalizeBaseUrl" tests/` **无命中**；三个校验文案 0 断言 |
| F3-09 | 模型/地址配置迁移与旧残留清理 | 升级后冷启动 | 无 `provider-kind` 的老用户按 deepseek 处理并沿用旧共享 `chat-demo:base-url`/`model`；下线主机读到即忽略；锁定渠道旧值被内置默认覆盖、Key 保留 | 残留模型名永久生效且设置页看不见、`setModel` 拒写 → 每请求 400「The supported API model names are …」（#339） | ✓ | — | ✓ | — | **部分覆盖** | #181 #274 #339 · `legacy-config`、`provider-ours`（两代旧 IP、locked 覆盖、自填不误迁）。`grep -rln "339" tests/` **无命中**；`configMigration.ts` 不在本检出（附录 B-3） |
| F3-10 | 快速 / 专家模式 | 空态首页「快速 / 专家」 | 两档可点、档位真翻转并落盘；专家档请求体带思考字段、快速档不带；刷新后仍在；不动输入区按钮清单 | 非法/缺省档位未 fail-closed；只改 UI 不改请求 | ✓ | ✓ | ✓ | 需真机 | **已覆盖** | #25 #341 · `mode-switch`、`mode-switch-request`（请求体逐字节对比 + 刷新后生效）、`mode-switch-plain`、`thinking-entry-consistency`[2] |
| F3-11 | 深度思考开关与档位 | 输入区「深度思考」 | 四渠道恒常驻、无 `disabled`、`data-thinking-effective` 只标生效；点击后真翻转；`reasoningParam` 三档与请求体一致 | 开关在但请求不带参数（或反之）；非法档位把不认识的字段发给中转 | ✓ | ✓ | ✓ | 需真机 | **已覆盖** | #297 #308 #341 · `thinking-adapters`[1]–[11]、`thinking-entry-consistency`[1][3] |
| F3-12 | 思考过程折叠与隐藏 | 助手消息思考标题 / 设置项 | 默认折叠（正文不挂 DOM）；可展开；可完全隐藏（无标题无正文不占位）；流式中自动展开、结束后收敛；老数据照样识别 | 默认全展开；隐藏档仍占位；折叠后正文仍在 DOM | ✓ | — | — | — | **已覆盖** | #46 #80 · `thinking-display`[A]–[G] |
| F3-13 | 渠道间凭证隔离 | 两渠道间来回切 + 改 Key | API Key **共用一把**；地址与模型**按渠道分开存**；Key 判死指纹 = host + Key 短哈希，换 Key/换地址自动失效不串台；换 Key 丢弃旧 cid（#135） | A 渠道地址带给 B；A 网关的判死拦住 B 网关的新 Key；换 Key 后仍用旧 cid 下单 | ✓ | ✓ | ✓ | — | **已覆盖** | #135 #303 #181 · `provider-channels`[3]、`internal-build`[F]、`provider-ours`、`key-rejection-303`[2] |

### 2.2 先做减法（域 3）

| 处置 | 对象 | 依据（为什么是重复） | 削减 |
| --- | --- | --- | --- |
| **删** | `tests/integration/caps.test.mjs`（63 行） | 只断言 anthropic 的 search/upload/voice 三入口降级；`provider-channels` 已有**四渠道 × 四入口**矩阵（`expectCaps('Anthropic 协议', {search:false, vision:false, asr:false, thinking:true})` 等 4 处调用），且判定更严（要求 DOM 无节点，caps 允许置灰） | 1 入口 / 3 条检查 / 一次 Chromium 启动 |
| **删** | `full-acceptance` [3][4]（322–368 行） | 用子进程重跑 `tests/unit/openai-adapter.test.mjs` 再断言 `PASS` = 同一批断言跑两遍 | ~47 行 / 1 子进程 / 2 条检查 |
| **删** | `full-acceptance` [7a]（369–487） | 与 `request-body`[B]（官方保留字段）+ `provider-channels`[2]（路径/鉴权/入口）重复 | ~119 行 / 5 条检查 |
| **删** | `full-acceptance` [2/3]（488–555） | 与 `request-body`[A]（字段剥离）+ `provider-anthropic`（`/v1/*` 路径）重复 | ~68 行 / 4 条检查 |
| **删** | `full-acceptance` [5]anthropic 能力降级（556–607） | 与 caps→`provider-channels` 矩阵重复 | ~52 行 / 3 条检查 |
| **删** | `full-acceptance` [4] 上游返回 HTML（608–627） | 已有独立 `tests/integration/upstream-html.test.mjs` 专门覆盖 | ~20 行 / 2 条检查 |
| **删** | `full-acceptance` [1/2]openai（628–726） | 与 `request-body` + `provider-channels`[4] 重复 | ~99 行 / 5 条检查 |
| **删** | `full-acceptance` [6a][6b]（771–834） | 与 `provider-channels`[4][6]（入口显隐 + 切回恢复）重复 | ~64 行 / 2 条检查 |
| **合** | `probe-auth` + `probe-auth-protocols` + `probe-nokey`（52 + 41 + 另 1 个） | 同一被测对象（点「测试」→ 看 `/models` 请求），三份重复的 `openApp`/`openSettingsDataSection`/`captureProbeRequests` setup | 3 → 1 入口 / 省 2 次启动 / 6 条重复检查 |
| **合** | `model-picker-parser` + `model-probe-status`（33 + 19 行） | 同一模块两个文件；后者 4 条断言打在测试内自实现的映射上，对产品代码零约束 | 2 → 1 / 删 4 条无效检查 |
| **收窄** | `legacy-config.test.mjs`（101 行） | 与 `provider-ours` 的「共享 `chat-demo:base-url` 在 deepseek 下生效」重复；只保留 L0 表达不了的那一条（真实请求打到老地址），并入 `provider-channels` 作第 5 个 setup 行 | 1 文件 / 3 条检查 |
| **删** | 各功能点各自重写的 i18n「zh/en 成对」断言（`thinking-display`[F]、`mobile-header-scroll-top`[J]、`auto-title-prompt-i18n`[1]） | `tests/regression/issue-94-i18n-parity.test.mjs` 已按 `Object.keys(zh)` 全键双向对齐，新增键自动纳入 | 6 条检查 |

**域 3 削减合计：5 个执行入口（删 `caps`、`probe-*` 3→1、`model-*` 2→1、并入 `legacy-config`）、`full-acceptance` 860 → ~400 行（−53%）、约 45 条重复检查。**

### 2.3 域 3 缺口 → 归入哪条用例

| 缺口 | 风险 | 建议层级 | 归入用例 | 合并后用例数 |
| --- | --- | --- | --- | --- |
| `describeProbe` 六档文案零断言（timeout/html/json/invalid/okEmpty） | 主流程 | L0（可导出）或 L2（现状） | **N3-C** | 计入 1 |
| 真 `probeProvider` 的 reason 分支无直接单测（现有为自实现桩） | 主流程 | L1 | **N3-B** | 计入 1 |
| `probeProvider` 的 native（`CapacitorHttp`）/ web 双传输分支无断言 | 主流程 | L1 | **N3-B** | 计入 1 |
| 模型下拉 `listbox/option` 渲染、选中写回、下次请求用该模型 | 主流程 | L2 | **N3-C** | 计入 1 |
| `normalizeBaseUrl` 校验/尾斜杠、`setModel` 空值拒写、锁定渠道拒写、`#339` 残留守卫、`LEGACY_HOSTS` 忽略 | 主流程 | L0 | **N3-A** | 计入 1 |
| 「切渠道 → 沿用旧 Key 被新上游 401 → 可读提示 → 停自动探测 → 换 Key 恢复」串联 | 主流程 | L2 | **N3-C** | 计入 1 |

域 3 合并后新增：**3 条**（N3-A / N3-B / N3-C）。

---

## 3. 域 4：会话管理

### 3.1 功能点表（9 点）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F4-01 | 新建会话 | 侧边栏「开启新对话」 | 回空态首页，`activeId = null`；首次发送才建会话并落盘；旧会话仍在列表 | 点了没反应/空白页；新建后旧会话被覆盖；草稿丢失 | ½ | — | ✗ | 需真机 | **部分覆盖（缺异常分支）** | #45 · 数据层经 `sendMessage(null)` 被 6 处单测间接覆盖；UI 入口 `grep -rln "newChat\|开启新对话" tests/` **无命中** |
| F4-02 | 切换会话 | 侧边栏点会话 | 打开会话、移动端侧栏自动收起、按需加载；旧请求不把界面切回（epoch 守卫）；同 id 并发读取合并 | 切了还停在上一条；切太快被旧响应覆盖；重复读打两次存储 | — | — | ½ | 需真机 | **部分覆盖（缺异常分支）** | #45 · 仅 `motion`[5]（点会话后侧栏收起）。`grep -rln "selectSession" tests/` **无命中**；epoch/并发/转圈/`sessionLoadFailed` 0 断言 |
| F4-03 | 会话置顶 / 取消置顶与排序 | 「更多」→ 置顶会话 / 取消置顶 | 写 `pinnedAt` 并落盘；列表按「置顶优先、再按 `updatedAt` 倒序」重排；显示「已置顶」标记；再点取消 | 置顶后不重排/刷新即丢；位序与 `updatedAt` 错乱；取消后不回原位 | ✗ | ✗ | ✗ | ✗ | **未覆盖** | —（无独立单；`store.ts` `pinSession`/`sortSessions`、`SessionItem.tsx`）。`grep -rln "pinnedAt" tests/` **无命中**；`pinSession` 7 处命中全是测试内假 db 打桩（附录 B-1） |
| F4-04 | 重命名会话 | 「更多」→ 重命名 → 输入 → Enter/失焦 | 标题写回摘要并落盘；Enter 提交、Escape 取消、空白不提交；改名后本轮自动标题不再覆盖、也不再发标题请求 | 改名又被自动标题盖回；Escape 仍提交；空白标题变「新对话」 | — | — | ✓ | 需真机 | **部分覆盖（缺异常分支）** | #18 #93 #112 · `auto-title`[7]。缺口：Escape 取消、空白/纯空格、`db.renameSession` 失败提示 0 断言 |
| F4-05 | 删除会话（含删除当前会话） | 「更多」→ 删除 → 确认弹窗 | 删除会话与摘要、清理仅被它引用的原件与草稿；删当前会话则回空态且不残留流式；删除前先中止流并等收尾，避免又被写回 | 删除后还在/白屏；删当前会话后停在已删会话；失败无提示（应「删除对话失败，请重试」）；删完又被收尾写回 | ✗ | ✗ | ✗ | ✗ | **未覆盖** | —（`store.ts` `removeSession`/`removeSessionData`、`Sider.tsx` 确认弹窗）。`grep -rln "removeSession" tests/` **无命中**；两个文案 0 断言 |
| F4-06 | 长会话加载与分页 | 打开长会话、反复切换 | 长会话能打开不卡死；最多缓存 5 条（`SESSION_CACHE_LIMIT`），超出按 LRU 卸载且不卸载在飞/未落盘/删除中；长历史靠虚拟列表只挂视口附近 | 一直转圈（#45 线上形态）；加载出来空白；缓存无限增长；读到一半被切走又把界面切回 | ✓ | ✓ | ✗ | 需真机 | **部分覆盖（缺异常分支）** | #45 #122 #133 #19 · 渲染：`message-list-virtual`[1]–[7]、`b2-history-scale`；请求裁剪：`chat-context-budget-long-session`、`context-budget`。**加载链路 0 断言**（`SESSION_CACHE_LIMIT`/`sessionLoadErrors` grep 无命中）。**分页子能力 `不适用`**：代码无分页（`db.loadSession` 全量 `get`，附录 B-4） |
| F4-07 | 双击标题回顶 | 移动端标题栏（双击） | 平滑滚回首条（逐帧偏移单调递减到 0）；流式追加不抢回底部；已在首条/短会话无副作用；长会话首条不在 DOM 也能回顶；连击后者接管 | 双击没反应；滚一半被拽回底部；虚拟化下回不到首条；欢迎页抛错 | ✓ | — | ✗ | 需真机 | **已覆盖** | #106 #121 · `mobile-header-scroll-top`[A]–[J]。真实触摸双击的 L2 场景并入 **N4-C** |
| F4-08 | 会话标题自动生成 | 首轮结束后自动 | 成功即写回且只请求一次；8s 超时/500/空串/脏输出/finish 异常一律回退本地截取；并发 2 + 队列 6 + 溢出计数；429 记 `throttled`；拿到标题行即断连；en 下不泄漏中文 | 标题永不出现；整段生成完才拿（费 token 占槽）；回退为空导致 UI 空白；中文 prompt 泄漏给 en 用户 | ✓ | ✓ | ✓ | — | **已覆盖** | #93 #112 #18 · `auto-title`[1]–[11]、`auto-title-stream`、`auto-title-backpressure`、`auto-title-prompt-i18n` |
| F4-09 | 损坏会话隔离 | 打开写坏的会话 / 导入含损坏条目的包 | `messages`/`files`/`blocks` 为 `null` 修成 `[]` 并报 `damage.*`；该会话仍能渲染；导入时坏会话进 `skipped[]` 不整包回滚；不影响其他会话与列表 | 一条坏数据整页白屏（#28 线上形态）；一条坏会话让整次导入失败；坏会话静默消失无定位 | ✓ | — | ½ | 需真机 | **部分覆盖（缺异常分支）** | #28 #49 #111 · `session-repair`[1]–[6]、`error-boundary`[1]、`import-partial-skip`[1][2]。缺口：**读取期**损坏 → 只该会话「对话加载失败」、其他照常（`sessionLoadErrors` 0 断言）；列表失败文案 `sessionListLoadFailed` 0 断言 |

### 3.2 先做减法（域 4）

| 处置 | 对象 | 依据 | 削减 |
| --- | --- | --- | --- |
| **收窄** | `error-boundary`[1] 的修复细节断言 | 与 `session-repair`[1]（`files=null → []`）重复；L2 只留「不白屏 + 诊断 `stage=session.normalize` 存在」 | 4 条检查 |
| **删** | `auto-title`[8]（deepseek 带 `title:{enabled:true}`） | 与 `request-body`[B]（官方字段原样保留）重复 | 1 段 / ~15 行 |
| **收窄** | `motion.test.mjs`[5] 功能冒烟（发消息/点会话/设置开关） | 与 N4-C 主路径闭环重复；motion 只留动效断言 | ~30 行 / 省 1 次 15s 等待 |
| **收窄** | `adversarial/cases/b2-history-scale` 的正确性断言 | 与 `message-list-virtual`[1][2][6]（窗口窗口计算/高度实测）重复；b2 只留「4000 行耗时有上界」 | 3 条检查 |
| **不合** | `message-list-virtual` 与 `chat-context-budget-long-session` | 一个是渲染侧（DOM 节点数）、一个是请求侧（字节与 token），**不可合并** | — |

**域 4 削减合计：约 8 条重复检查、~45 行、1 次 15s 等待；无执行入口消失。**

### 3.3 域 4 缺口 → 归入哪条用例

| 缺口 | 风险 | 建议层级 | 归入用例 | 合并后用例数 |
| --- | --- | --- | --- | --- |
| 置顶/取消置顶/排序/持久化（**零覆盖**） | 主流程 | L1 + L2 | **N4-A**（状态机）+ **N4-C**（菜单与刷新后仍在） | 计入 2 |
| 删除会话整链（**零覆盖**）：确认弹窗、删当前会话回空态、中止流、清理原件/草稿、失败提示 | 白屏 + 资损 | L1 + L2 | **N4-A**（状态机与失败注入）+ **N4-C**（弹窗闭环） | 计入 2 |
| 新建会话 UI 入口（点按钮 → 空态、`activeId=null`、旧会话保留） | 主流程 | L1 + L2 | **N4-A**（数据层）+ **N4-C**（UI） | 计入 2 |
| 切换会话的加载/失败态：转圈、加载中切走、并发合并、`sessionLoadFailed` | 白屏（#45） | L1 | **N4-B** | 计入 1 |
| 长会话加载与 LRU 淘汰（`SESSION_CACHE_LIMIT=5`，保护在飞/未落盘/删除中） | 白屏 / 内存 | L1 | **N4-B** | 计入 1 |
| 加载超时兜底（#133：弱网/弱机型首屏无限转圈） | 白屏 | L1（+ L3 按需取证） | **N4-B** | 计入 1 |
| 损坏会话的**会话级隔离** + 列表加载失败文案 | 白屏 | L1 + L2 | **N4-B**（隔离）+ **N4-C**（文案） | 计入 2 |
| 重命名异常分支：Escape 取消、空白不提交、落盘失败提示 | 主流程 | L1 | **N4-A** | 计入 1 |
| 双击回顶的真实交互（触摸双击、长会话回顶） | 体验 | L2 | **N4-C** | 计入 1 |

域 4 合并后新增：**3 条**（N4-A / N4-B / N4-C）。

---

## 4. 完全没有任何测试的功能点

严格口径：每个失败态与主路径都 `grep` 无命中，或命中仅为测试内打桩。

| 域 | ID | 功能点 | 现状证据 | 风险 | 由谁覆盖 |
| --- | --- | --- | --- | --- | --- |
| 域 4 | **F4-03** | 会话置顶 / 取消置顶与排序 | `grep -rln "pinnedAt" tests/` 无命中；`grep -rln "置顶" tests/` 无命中；`pinSession` 7 处命中全是假 db 空实现 | 主流程 | N4-A + N4-C |
| 域 4 | **F4-05** | 删除会话（含删除当前会话） | `grep -rln "removeSession" tests/` 无命中；`deleteSessionWithFilesDescription`/`sessionDeleteFailed` 无命中 | 白屏 + 资损 | N4-A + N4-C |

域 3 无「完全没有任何测试」的功能点（最弱的是 F3-06 / F3-07，各有 1–2 条断言，已由 N3-B / N3-C 补齐）。

---

## 5. 拟定用例总表（新增 6 条）

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点ID | 覆盖分支数 | 不可合并原因 |
| --- | --- | --- | --- | --- | --- |
| **N3-A** 渠道配置解析与迁移矩阵<br>`tests/unit/provider-config-matrix.test.mjs` | L0 | ✓ 一张表 12 行 | F3-01、F3-08、F3-09、F3-13 | 12 | 无（本身就是 8 个纯函数分支的合并体） |
| **N3-B** 探测协议矩阵<br>`tests/unit/provider-probe-matrix.test.mjs` | L1 | ✓ 一张表 14 行 | F3-03、F3-05、F3-06、F3-07 | 14 | **下沉不了 L0**：`probeProvider` 有 `Capacitor.isNativePlatform()` 两条传输分支 + `AbortController` 超时，纯 Node 只能覆盖 web 一支；**上浮不了 L2**：DOM 只呈现一句话，读不出六档 `reason` 精确值 |
| **N3-C** 设置页探测面板 + 模型行闭环<br>`tests/integration/settings-probe-model.test.mjs` | L2 | ✓ 一张表 10 行（4 场景） | F3-05、F3-06、F3-07、F3-08、F3-13 | 10 | **下沉不了 L0**：`describeProbe` 是 `ApiConfigFields.tsx` 内部 `const`（未导出），文案只能从 DOM 读；导出它属于改源码，超出本单边界 |
| **N4-A** 会话增删改 + 持久化<br>`tests/unit/session-crud-matrix.test.mjs` | L1 | ✓ 一张表 14 行 | F4-01、F4-03、F4-04、F4-05 | 14 | **上浮不了 L2**：L2 无法注入「落盘失败」「流式中删除」这两种状态，而它们正是资损与白屏来源 |
| **N4-B** 会话加载三态 + 缓存<br>`tests/unit/session-load-matrix.test.mjs` | L1 | ✓ 一张表 9 行 | F4-02、F4-06、F4-09 | 9 | **合不进 N4-A**：需要 never-resolve / 按 id 抛错的假 db 语义，与 CRUD 的同步状态断言不同构，合成一个 test 即等于两条；**上浮不了 L2**：超时与并发合并要在 promise 边界控制时序 |
| **N4-C** 会话列表闭环 + 降级<br>`tests/integration/session-list-flow.test.mjs` | L2 | ✓ 一张表 11 行（2 场景） | F4-01、F4-02、F4-03、F4-04、F4-05、F4-07、F4-09 | 11 | **合不进 N4-A/B**：菜单、弹窗、刷新后持久化只能在真 DOM + 真 IndexedDB 验证；**不再拆细**：一次启动跑完闭环比 7 条小用例省 6 次浏览器启动 |

**合计：6 条用例 / 70 个覆盖分支 / 22 个功能点全覆盖。** 分支密度 ≈ 12 条/用例，远高于现有仓内「1 文件 1 场景」的惯例（`caps` 3 条断言、`probe-nokey` 2 条断言）。

## 6. 为什么不能再少（不可合并项清单）

| # | 不能合并的边界 | 具体理由 |
| --- | --- | --- |
| 1 | **L0 ↔ L1 不可互换**（N3-A vs N3-B） | `probeProvider` 的 native 分支依赖 `Capacitor`，L0 环境不存在；反过来 L1 引入真 `fetch`/`AbortController` 后，"纯函数分支"的失败定位会变模糊。按 #362「能用 L0 表达的绝不写 L2」——这里能用 L0 的已经都在 N3-A 里了 |
| 2 | **源码未导出 → 只能 L2**（N3-C） | `describeProbe` 是组件内 `const`，TSX 不能被裸 Node 解析；要下沉 L0 必须先 `export`（改源码）。本单边界「不改源码」，故唯一合法落点是 L2 表驱动 |
| 3 | **状态注入能力不同**（N4-A vs N4-B） | N4-A 需要「落盘抛错/流式中删除」，N4-B 需要「never-resolve/按 id 抛错」。两种假 db 语义放同一 test 里，等于把两条用例写进一个 `test()`，只是把行数搬了个位置，并不减少执行成本 |
| 4 | **失败注入 vs 真持久化**（N4-A/B vs N4-C） | L1 验证得了状态机但验证不了「刷新后还在」（需要真 IndexedDB 跨 reload）；L2 反过来注入不了失败。二者不是重复，是互补的唯一来源 |
| 5 | **L3 真机项不进 CI**（双击回顶触摸精度、WebView 渲染差异） | 不计入上述 6 条；按 #362 边界「不把 L3 塞进 CI」，按需手动 |

---

## 附录 A：逐功能点 grep 证据

命令：`cd <repo> && grep -rln "<关键词>" tests/`。

| ID | 关键词 | 命中（断言用） | 备注 |
| --- | --- | --- | --- |
| F3-01 | `selectProviderKind` | `provider-channels`、`provider-anthropic`、`internal-build`、`ours-services`、`request-body`、`caps`、`issue-234-invite-copy` | `getSpec`/`PROVIDER_SPECS` 命中 4 个单测 |
| F3-02 | `data-thinking-toggle` / `thinkingAvailable` | `thinking-entry-consistency`、`thinking-adapters`、`mode-switch` | 能力矩阵锁定：`provider-caps-lock` |
| F3-03 | `clickTest` / 鉴权头 / `joinUrl` | `probe-auth-protocols`、`attachment-endpoint-303`、`provider-anthropic` | `joinUrl` 仅 `attachment-endpoint-303` 有断言 |
| F3-04 | `REQUEST_GATES` / 请求体字段 | `thinking-adapters`、`request-body`、`full-acceptance` | 以 mock 收包断言 JSON，不读源码正则 |
| F3-05 | `clickTest` / `captureProbeRequests` | `probe-auth`、`probe-nokey`、`probe-auth-protocols` | — |
| F3-06 | `settingsTestTimeout`/`Html`/`BadJson`/`Http`/`Ok`/`OkEmpty`/`BaseUrlInvalid` | **全部无命中** | 仅 401 与网络两档在 `probe-auth-protocols`[3][4] 用正则断言界面原文 |
| F3-07 | `parseModelPayload` / `pickModelIds` | `model-picker-parser`、`model-probe-status` | `listbox` → 仅 `feedback-draft`（无关） |
| F3-08 | `normalizeBaseUrl` / `settingsModelInvalid` / `settingsBaseUrlRequired` | **全部无命中** | 默认值断言在 `provider-ours`/`provider-caps-lock` |
| F3-09 | `LEGACY_HOSTS` / `chat-demo:base-url` / `chat-demo:model` | `legacy-config`、`provider-ours`、`provider-channels` | `339` → 无命中 |
| F3-10 | `chatMode` / `setChatMode` / 快速 / 专家 | `mode-switch`、`mode-switch-request`、`mode-switch-plain`、`thinking-entry-consistency` | — |
| F3-11 | `reasoning_effort` / `thinking_enabled` / `data-thinking-toggle` | `thinking-adapters`、`thinking-entry-consistency` | — |
| F3-12 | `thinkingDisplay` / `collapsed` / `hidden` | `thinking-display` | — |
| F3-13 | `chat-demo:base-url:anthropic` / `chat-demo:model:anthropic` / `isKeyRejected` | `provider-channels`、`provider-ours`、`internal-build`、`key-rejection-303` | — |
| F4-01 | `newChat` / `开启新对话` / `New chat` | **无命中** | 数据层经 `sendMessage(null)` 6 处间接覆盖 |
| F4-02 | `selectSession` | **无命中** | 仅 `motion`[5] 以 DOM 点击间接覆盖 |
| F4-03 | `pinnedAt` / `pinSession` / `置顶` | **无真实断言** | 7 处 `pinSession` 为假 db 打桩 |
| F4-04 | `renameSession` / `重命名` | `auto-title`[7] | 7 处字面命中全是打桩（附录 B-1） |
| F4-05 | `removeSession` / 删除文案 | **无命中** | `deleteSession` 命中均为打桩 |
| F4-06 | `SESSION_CACHE_LIMIT` / `sessionLoadErrors` / `virtualRows` | `message-list-virtual`、`chat-context-budget-long-session`、`b2-history-scale` | 加载链路关键词无命中 |
| F4-07 | `双击` / `scrollToFirstMessage` | `mobile-header-scroll-top` | — |
| F4-08 | `autoTitle` / `标题` | `auto-title`、`auto-title-stream`、`auto-title-backpressure`、`auto-title-prompt-i18n` | — |
| F4-09 | `normalizeSession` / `损坏会话` / `sessionLoadErrors` | `session-repair`、`error-boundary`、`import-partial-skip` | `sessionLoadErrors` → 无命中 |

## 附录 B：方法学坑（本域盘点实际踩到）

**B-1 grep 命中 ≠ 覆盖。** `grep -rln "pinSession" tests/` 返回 7 个文件，看着「置顶早有测试」，实际全是测试里为绕开 IndexedDB 内联的假 db：

```js
// tests/unit/key-rejection-303.test.mjs:25（另有 6 个单测同款）
export const pinSession = async () => {}
export const renameSession = async () => {}
```

`renameSession` 同理：7 处字面命中全是打桩，真断言在 `auto-title`[7]——那一处**根本不含 `renameSession` 字样**（走「菜单→重命名→输入→Enter→读 IndexedDB」）。所以判定覆盖必须**双向核对**：既防「打桩冒充覆盖」，也防「有断言但不含关键词」。

**B-2 自实现的桩让「看起来测了」的用例对产品代码零约束。**

```js
// tests/unit/model-probe-status.test.mjs:5-15 —— 用例内自建映射，不 import probeProvider
const probe = async (response, timeoutMs = 25) => { … if (value.status < 200 || value.status >= 300) return { ok: false, status: value.status, reason: 'http', models: [] } … }
```

文件标题里的「401/404/200/timeout」断言的是用例自己写的映射；真 `probeProvider`（`src/services/api/client.ts:651`）的四条分支仍未被约束。故这 4 条计入「减法」而非「覆盖」。

**B-3 功能在分支上、不在检出上。** #339 修复提交 `27bef71` 在 `origin/fix/deepseek-model-residue-339`；`git merge-base --is-ancestor 27bef71 HEAD` 在本检出（`ci/wire-manifest-log-gates`）为假，`src/services/api/configMigration.ts` 不存在。因此 F3-09 的「残留清理」在当前分支**既无实现也无测试**，N3-A 写的是「先写用例（红）→ 随 #339 合入转绿」，不按「已实现未覆盖」记。

**B-4 全量读取 ≠ 分页。** `db.loadSession` 是一次 `get('sessions', id)`（整条），`loadSessionSummaries` 是一次 `getAll()`（全部），`store.ts:67` 的 `SESSION_CACHE_LIMIT = 5` 只做内存 LRU。**代码里没有任何分页实现**，故「分页」子能力记 `不适用`；真正风险是「全量读取的耗时与失败终态」（#45/#133），已归入 N4-B。

**B-5 入口恒常驻 ≠ 能力生效。** #341 后深度思考入口四渠道恒常驻，`caps.thinking` 只是 `thinkingAvailable(spec)` 的派生值、仅体现为不可见的 `data-thinking-effective`。判覆盖要同时看 DOM（在不在）与收包（发不发）——只有 `thinking-entry-consistency` 同时断言两侧，`caps.test.mjs` 只看 DOM（这也是它可被删的原因之一）。

**B-6 一条用例的注释与断言互相矛盾，需真环境复核。** `tests/integration/probe-auth.test.mjs` 第 2 行写着「FIXME: Test 按钮读的是 store 里已保存的 apiKey，而非输入框当前值」，但同一文件的断言要求「输入框的值必须生效」；当前实现（`ApiConfigFields.tsx` 的 `ConnectionTestField.test`：`editor.form.value.trim() || editor.apiKey`）符合断言，FIXME 大概率已过期。本文按「断言存在」计入 F3-05，但**本次盘点未跑 Playwright**（需预构建产物 + Chromium）。若该文件实为红，F3-05 应从「已覆盖」降为「部分覆盖」，N3-B/N3-C 顺带把它并掉。

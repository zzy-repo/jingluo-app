# 域 1（启动与可用性）+ 域 2（对话主链路）功能点与分层覆盖映射

> 母单：Issue #362「[TRACK] 功能点收集与分层测试覆盖盘点」。
> 本文只做**盘点与映射**，不含测试代码、不改源码。
>
> **证据基线**：`origin/main` @ `a757bec`（2026-11-19）。本机主工作树 `HEAD` 落后且存在大批暂存删除，
> 因此 `src/`、`tests/` 的行号与文件清单全部取自 `git archive origin/main` 快照后 grep 得到，不靠推测。
> 每一条「已覆盖」都能指到具体文件；每一条「未覆盖」都写了 grep 无命中的关键词。
>
> ⚠️ **覆盖状态以实际用例为准，改动后必须同步更新本表**：`覆盖状态` / L0–L3 列说的是**当前仓库里
> 真实存在、且能跑绿的用例**，不是上面那条证据基线当时的判定 —— 基线之后的每一批用例（例如 #452 的
> C1–C4）都会让旧判定过期。用例新增 / 删除 / 失效后，**必须在同一个 PR 内**同步改本表；只改用例不改表
> = 本表立刻过期，等于没有本表。

## 0. 口径与分层映射

| 层 | 本文对应目录 | 说明 |
| --- | --- | --- |
| **L0 单元** | `tests/unit/`（纯 Node / `vm` 跑内联脚本，零浏览器） | `tests/adversarial/` 不在 `run-layer.mjs` 的 `LAYERS` 里，不计入覆盖 |
| **L1 集成** | `tests/integration/`（真实 dist + Chromium + 打桩上游） | 单文件可 >90s，部分文件已超预算 |
| **L2 端到端** | `tests/e2e/`（真上游 + 真 UI，需 `E2E_API_KEY`） | 不在 CI，发版前手动跑 |
| **L3 设备** | `tests/device/` + `scripts/compat/*`（AVD / 真机） | 手动按需，不进 CI |

**系统性前提（影响下面所有判定）**：`.github/workflows/ci.yml:52-57` 只跑 `pnpm test`（= unit 层）。
本文所有 **L1/L2/L3 覆盖都不在门禁里**——「已覆盖」= 有可执行用例，不等于「回归会被拦住」。

覆盖状态四档按母单定义：`已覆盖` / `部分覆盖（缺异常分支）` / `未覆盖` / `不适用（无自动化）`。
本文对「功能本身不存在」的项用 `不适用`，并在备注写明原因。

---

## 1. 域 1：启动与可用性

### 1.1 功能点表

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1-01 | 冷启动打开 App，首屏可用：桌面看到侧栏会话列表、移动端可拉开抽屉、主区显示欢迎页 | 启动应用 / 刷新 | 秒级出现可交互界面；已有历史时能点开 | 白屏，或永久停在「正在加载对话...」 | — | ✓ | ✓ | 手动 | **部分覆盖（仅作前置隐式验证，无显式首屏断言）** | #13 #62 |
| F1-02 | 重进 App / 渲染进程重建后**回到上次那个会话** | 冷启动、后台回收后回前台 | 恢复到上次会话与位置 | 落回空白欢迎页（**现状即如此**） | — | — | — | — | **不适用（功能未实现）** | #44 #62 |
| F1-03 | 首屏加载等待态 + **会话列表读失败**时给可读文案与重试 | 启动（IndexedDB 慢/损坏） | 「正在加载对话...」→ 失败时「对话列表加载失败，请重试」+ 重试按钮，点了真重读 | 空白、永久转圈、无重试 | — | — | — | — | **未覆盖** | — |
| F1-04 | **单条会话打不开**（本地缺数据/读失败）时给可读文案与重试 | 点侧栏任一历史会话 | 「对话加载失败」+ 重试，其余会话仍可用 | 主区一直 loading / 整页白 | — | — | — | — | **未覆盖** | — |
| F1-05 | **白屏兜底页**：缺能力 / 脚本解析报错 / 12 秒未启动，都不给纯白屏 | 启动（老内核或资源坏） | 兜底卡：一句人话 + 五项环境信息 + 一键复制诊断 + 重试/升级指引 | 纯白屏、只有转圈 | ✓ | — | — | 手动 | **已覆盖**（L0 充分，L1/L2 无） | #13 #104 #180 #219 |
| F1-06 | **内核过低明确提示**与升级路径 | 启动（WebView 主版本 < 83） | 「本机系统浏览器内核过旧」+ 设置 → 应用 → Android System WebView → 更新 | 通用报错、误报（内核够用也弹） | ✓ | — | — | 手动 | **已覆盖**（L0 充分，L3 为模拟器手动） | #104 #209 #276 |
| F1-07 | **渲染进程被回收/被杀后自动恢复**，App 不闪退 | 系统 OOM、后台回收、`kill` 渲染进程 | 接管事件（恒 `true`）→ 重建 WebView → 回到可用状态 | 整个 App 进程消失（`aw_browser_terminator` 杀进程） | ✓ | — | — | 手动 | **部分覆盖（缺自动化设备用例）** | #44 #291 |
| F1-08 | **损坏数据/渲染异常兜底**：不白屏，给错误页 | 打开被写坏的会话 / 任意渲染期抛错 | 能修就修（`files=null` 等）；修不了给错误页：人话 + 重载 + 复制诊断 | 整棵树卸载 → 整屏纯白 | ✓ | ✓ | — | — | **已覆盖** | #28 |
| F1-09 | **清数据后首启**：无 Key 时自动引导输入，不卡住 | 首次安装、设置里清除数据后启动 | 自动打开设置（数据管理/API Key），保存后可直接发消息 | 停在欢迎页无引导；点发送无反应 | — | ✓ | ✓ | 手动 | **部分覆盖（隐式前置，无断言）** | #86 |

### 1.2 覆盖证据（按 ID）

- **F1-01**：`tests/helpers/helpers.mjs:11` `openApp()`（全部 integration 用例的前置）、`tests/integration/copy-limit.test.mjs:228`（等「首次 hydration 的侧栏」）、`tests/integration/url-import-web.test.mjs:105`（侧栏出现导入会话）、`tests/e2e/real-upstream.test.mjs:264`、`scripts/compat/p1-chat.mjs`（模拟器进主界面）。**无任何用例显式断言「首屏不空白 + 列表渲染 + 欢迎页」**。
- **F1-02**：`src/services/chat/store.ts:130` `activeId: null`；全仓 `grep -rn "chat-demo:active\|lastActive\|lastSession"` **0 命中**；`android/.../MainActivity.java:131` 恢复方式是 `recreate()` 整层重建 → 前端重新初始化必然回欢迎页。功能不存在，故不适用。
- **F1-03**：实现 `src/app/App.tsx:113-131`、`src/services/chat/store.ts:388-411`（`initChat` catch → `initError`）。`grep -rn "sessionListLoadFailed" tests/` → **0 命中**（只命中 `src/app/App.tsx:116`、`src/i18n/zh.ts:12`）。
- **F1-04**：实现 `src/app/App.tsx:45-46,115-131`、`src/services/chat/store.ts:438-478`（`ensureSessionLoaded` catch → `sessionLoadErrors[id]`）。`grep -rn "sessionLoadFailed" tests/` → **0 命中**。
- **F1-05**：`tests/unit/legacy-boot-guard.test.mjs`（7 例：三出口 + 反向「不许误报」）、`tests/unit/compat-guard-diagnostics.test.mjs`（11 例：三出口的结构化诊断/UA 解析）、`tests/unit/compat-env-fields.test.mjs`（15 例：五项环境信息/一键复制/低内核指引，按渲染文本断言）、`tests/unit/compat-guard-baseline.test.mjs`（4 例：内联常量与唯一来源对齐）、`tests/unit/issue-219-displaynames-boot-guard.test.mjs`（3 例）、`tests/unit/guard-es5-gate.test.mjs`（6 例：守卫自身必须 ES5 可解析）。L3 手动：`scripts/compat/p0-fallback.mjs` + `docs/compat/compat-old/README.md`（WebView 69/74 命中出口②、113/124/133 不误触发）。
- **F1-06**：同上 + `tests/unit/compat-baseline.test.mjs`、`tests/unit/legacy-webview-compat.test.mjs`、`tests/unit/container-query-fallback.test.mjs`、`tests/unit/has-fallback.test.mjs`、`tests/unit/flex-gap-fallback.test.mjs`、`tests/unit/legacy-replace-all.test.mjs`、`tests/unit/legacy-bundle-target.test.mjs`。L3：`scripts/compat/matrix-scan.mjs`、`docs/compat/matrix/README.md`。
- **F1-07**：`tests/unit/render-process-gone.test.mjs`（5 例：Java 源码契约 + 断言 JVM 测试存在）、`android/app/src/test/java/com/example/deepseekchat/RenderProcessGoneGuardTest.java`（**存在但没有任何 runner/CI 调用**，见下）。L3 手动：`scripts/compat/p1-chat.mjs`（pid 不变）、`docs/repro/g6-issue-45-46-25-44.md`、`docs/compat/compat-old/*/logcat-*.txt`（「渲染进程接管已安装」）。
- **F1-08**：`tests/unit/session-repair.test.mjs`（8 例：`files/messages/blocks=null`、脏元素、分支会话）、`tests/unit/error-report.test.mjs`（7 例：报告字段与脱敏）、`tests/integration/error-boundary.test.mjs`（3 条链：`files=null` 正常渲染 + 渲染抛错出错误页 + 复制诊断）。该文件头自己写明「未覆盖 Android WebView 真机、低内核边界页」。
- **F1-09**：`tests/helpers/helpers.mjs:25-26`（每个 integration 用例都 `localStorage.clear()` 后 reload）、`tests/helpers/helpers.mjs:44-49`（`openSettingsDataSection` 允许「已自动弹出」也算通过）、`tests/e2e/real-upstream.test.mjs:271-298`（有弹层就切分组，没有就点设置）。**没有一条断言「无 Key 时设置必须自动弹出」**。

### 1.3 先做减法：现有用例的合并/删除建议

| 现有文件 | 现用例数 | 覆盖的功能点ID | 建议动作 | 合并后 | 可削减 |
| --- | --- | --- | --- | --- | --- |
| `unit/legacy-boot-guard` + `unit/compat-guard-diagnostics` + `unit/compat-env-fields` + `unit/compat-guard-baseline` | 37 | F1-05,F1-06 | 四个文件用**同一套 `vm` 造环境方式 + 同一段内联脚本**，改成「一张表：出口①/②/③ × 内核版本 × 缺哪个 API × 期望文案/字段」；常量与文案断言作为表的列，不另立用例 | 15 | **-22** |
| `unit/render-process-gone` | 5 | F1-07 | 前 3 例是对 Java 源码的正则/存在性断言。建议把 `RenderProcessGoneGuardTest.java` 接进 gradle `testDebugUnitTest`（现在**零 runner 调用**），接线后删掉这 3 条源码断言 | 2（接 gradle 后） | -3（有条件） |
| `integration/copy-limit`（域 2 文件，但含首屏前置） | 1 文件 / 6 断言 | F1-01,F2-12 | 保留；它的「等首次 hydration 的侧栏」可抽到 `helpers`，避免每个文件自写等待 | 不变 | 0 |

> 减法只针对**同一逻辑被同层重复断言**；跨层重复（L0 契约 + L1 真实 DOM）不删，删了会失去「接线是否断了」的唯一证据。

### 1.4 拟定用例：最小充分集（加法）

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点 | 覆盖分支数 | 不可合并原因(若有) |
| --- | --- | --- | --- | --- | --- |
| `storage-failure.test.mjs`：启动阶段注入 IndexedDB 故障，表驱动跑「列表读抛错 / 单会话读抛错 / 会话缺失 / 重试成功 / 正常首屏」 | L1 | **是**（5 行同一夹具） | **F1-01,F1-03,F1-04** | 5 | — |
| `first-run.test.mjs`：清空 localStorage 冷启动 → 断言自动弹设置、无白屏、存 Key 后能发一条 | L1 | 否（单场景，3 分支串行） | **F1-09,F1-01** | 3 | 唯一需要「真实首启 + 设置弹层 + 发送」串起来的场景；表驱动会掩盖时序 |
| `render-process-recover`（脚本：`adb shell kill <renderer pid>` → 进程存活 + 界面重建 + 落诊断） | L3 手动 | 否 | **F1-07,F1-02** | 2 | **需真实 WebView 渲染进程被杀 + `recreate()` 时序**，浏览器与桩都造不出来 |
| **小计** | | 2 / 3 表驱动 | 覆盖 F1-01,03,04,07,09（+F1-02 现状取证） | 10 | **新增 3 个用例（L1 2 + L3 1）** |

> F1-05/F1-06/F1-08 已足够，不新增；F1-02 需产品先决定「要不要恢复上次会话」，在此之前不写用例。

---

## 2. 域 2：对话主链路

### 2.1 功能点表

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F2-01 | 发一条消息（按钮/回车，可带附件） | 输入框 → 发送 | 用户消息上屏、请求体按渠道正确、开始流式 | 发不出去 / 请求体被上游 400 | ✓ | ✓ | ✓ | 手动 | **已覆盖** | #105 #303 |
| F2-02 | 流式接收并逐字渲染 | 发送后 | 增量上屏、正文/思考分块、结束后回到可发送态 | 卡住不动、空回答、整段一次性蹦出 | ✓ | ✓ | ✓ | 手动 | **已覆盖（含异常）**：`domain02-stop-regenerate` A4（#452 C2：上一轮被 abort 的流不得污染新回答） | #41 #93 #452 |
| F2-03 | 生成中**停止** | 生成中点「停止」 | 立刻停、已收内容保留、状态=已停止、可直接重新生成 | 停不下来 / 半句被丢 / 误报「连接中断」 | ✓ | ✓ | — | — | **已覆盖（含异常）**：`domain02-stop-regenerate` A1/A2/A3（真点 `.click()` 停止：停得下来 / 半句保留 / 不误报「连接中断」）+ A4（#452 C2 取消后立即重发） | #41 #452 |
| F2-04 | **重新生成** | 回答底部刷新图标 | 原回答保留为版本可切回，新回答流式生成 | 覆盖旧回答、切不回去、不发请求 | ✓ | — | — | — | **部分覆盖（仅被间接调用）** | #41 #122 |
| F2-05 | Key 无效（401） | 发送（Key 错/过期） | 「Key 无效或已过期」+ 去设置换 Key；只发 1 次；停自动探测 | 反复打接口 / 显示上游英文 | ✓ | — | — | — | **部分覆盖（缺 L1 界面断言）** | #303 #324 |
| F2-06 | 额度/余额不足 | 发送（耗尽） | 「余额或额度不足」+ 充值入口；不重试 | 被当成限流/网络/未知错误 | ✓ | ✓ | — | — | **已覆盖** | #299 #105 |
| F2-07 | 限流 / 服务端繁忙 / 断网 / 超时 + **自动重试** | 发送（429/5xx/断网/超时） | 各自分类文案；有上限自动重试并提示「正在第 N 次重试」 | 无限转圈、静默重试、额度类被重试 | ✓ | ✓ | — | — | **已覆盖（含异常）**：`domain02-chat-anomaly` C1 行 1/行 2（#452 C1：断流按上限重试后仍失败的终态与「可重试」判定；403 只发 1 次）+ C1 收尾（「正在第 N 次重试」必须撤下）；429/5xx 的界面文案在 `domain02-reply-error-ui` 行 2/行 3 | #105 #324 #452 |
| F2-08 | 上下文超长 | 长会话继续提问 | 「对话太长，开新会话或删几条」；不重试 | 未知错误 / 无脑重试 | ✓ | ✓ | — | — | **已覆盖（含异常）**：`domain02-chat-anomaly` C3（#452 C3：长会话先被预算裁剪、裁剪后仍超限 → 给可操作建议且**只发 1 次**不重试）；413 界面文案另见 `domain02-reply-error-ui` 行 4 | #122 #452 |
| F2-09 | 断流 / 空闲超时 | 生成中网络断、上游不动 | 两种文案分开；半句保留；可重新生成 | 永远 streaming / 冒充网络异常 | ✓ | ✓ | — | — | **已覆盖（含异常）**：`domain02-chat-anomaly` C1 行 1（#452 C1：断流终态文案必须说「上游这次什么都没返回、属于临时故障、可重试」，不许糊成「未知错误」）+ `domain02-reply-error-ui` 行 5/行 6（断流与空闲超时两种文案分开、半句保留） | #41 #150 #45 #452 |
| F2-10 | 首字等待分级提示 | 发送后 5/30/60s 无响应 | 逐级提示；60s 档给停止/重新生成 | 干等无反馈 | ✓ | ✓ | — | — | **已覆盖（含异常）**：`domain02-wait-thinking-ui` 表 A 行 1–3（5/30/60s 三档真出现在 DOM，60s 档给「停止生成」出口）+ 表 C（#452 C4：首字等待期间切后台再回来 → 提示不消失、秒数不回退不重算、回前台流式照常收尾、全程只发 1 次） | #41 #328 #452 |
| F2-11 | 思考过程折叠/隐藏 | 设置 →「思考过程显示方式」；回答里的思考区 | 默认折叠、可展开、可完全隐藏不占位；流式时自动展开 | 思考常驻、隐藏后空白 | ✓ | — | — | — | **部分覆盖（缺 L1 真实交互）** | #46 #297 #341 |
| F2-12 | 长文本复制 | 回答底部复制 | ≤512 KiB 直接复制；超限弹「保存为 TXT」，成功/失败都有反馈 | 复制被截断 / 静默失败 | ✓ | ✓ | — | 未测 | **已覆盖**（Android 剪贴板/SAF 手动未测） | #2 |

### 2.2 覆盖证据（按 ID）

- **F2-01**：`tests/unit/enter-key-mode.test.mjs`（回车三档）、`tests/unit/key-rejection-303.test.mjs`（真实 store `sendMessage`）、`tests/unit/attachment-endpoint-303.test.mjs`、`tests/integration/request-body.test.mjs`（按协议剥字段）、`tests/integration/full-acceptance.test.mjs`（点发送 → mock SSE）、`tests/e2e/real-upstream.test.mjs:330-360`（真键盘 + 真上游）、`scripts/compat/p1-chat.mjs`。
- **F2-02**：`tests/unit/openai-adapter.test.mjs`（事件序列 + 脏数据）、`tests/unit/chat-stream-interrupt.test.mjs`、`tests/integration/full-acceptance.test.mjs` 第 5 组（逐字渲染 + 结束态）、`tests/e2e/real-upstream.test.mjs`（TTFB/首字/结束）、`tests/unit/diagnostics-stream-timing.test.mjs`。**#452 C2**：`tests/integration/domain02-stop-regenerate.test.mjs` A4（停止后立刻重发 → 上一轮被 abort 的流不污染新回答，新回答逐字上屏）。
- **F2-03**：L0 有 `tests/unit/chat-retry-retryable.test.mjs:291-303`（`stopReply` → `calls===1`、`status==='stopped'`、无重试提示）、`chat-stream-interrupt.test.mjs:218`（中止不误报断流）。**#452 C2 已补**：`tests/integration/domain02-stop-regenerate.test.mjs` A1/A2/A3 真的 `.click()` 点「停止生成」（停得下来、半句保留、不误报「连接中断」），A4 管取消后立即重发。（该「缺口」一段是 #362 基线时的结论，已过期。）
- **F2-04**：`tests/unit/chat-context-budget-long-session.test.mjs:276` 调 `regenerateReply` 只是取请求体；`tests/integration/full-acceptance.test.mjs:788` 只把「重新生成」算进入口按钮计数。无版本保留/切回/新请求历史断言。
- **F2-05**：`tests/unit/key-rejection-303.test.mjs`（4 组：记住 401、换 Key 失效判定、403/500 不算、真实 store 只 1 次 + 「Key 无效或已过期」）、`tests/unit/official-error-classify.test.mjs:186`（401 不回退）、`tests/unit/chat-retry-retryable.test.mjs:280`。
- **F2-06**：`tests/unit/quota-exhausted.test.mjs`（14 例）、`tests/integration/quota-exhausted.test.mjs`（402 / 429+`insufficient_quota` / 502 与普通 400 负向 / 额度正常，且断言「只发 1 次」与充值入口）。
- **F2-07**：`tests/unit/chat-retry-retryable.test.mjs`（7 例：断网、5xx、超时、4xx 不重试、用户停止、重试提示文案、纯函数判定）、`tests/unit/official-error-classify.test.mjs:223`、`tests/integration/quota-exhausted.test.mjs:240-253`（502 仍按上限重试）。**#452 C1**：`tests/unit/domain02-chat-anomaly.test.mjs` C1 行 1（断流每次都在首字前断掉 → 按上限重试后收敛，请求次数 = 1 + 上限；终态文案与「可重试」判定）、行 2（403 只发 1 次）、C1 收尾（收尾后「正在第 N 次重试」必须撤下）。429/5xx 的**界面**文案另见 `tests/integration/domain02-reply-error-ui.test.mjs` 行 2/行 3（L1）。
- **F2-08**：`tests/unit/chat-context-limit-error.test.mjs`（10 例：识别模式、413、不可重试、文案、真实 store 只发 1 次）、`tests/unit/official-error-classify.test.mjs:180`（真实样本不回退）。**#452 C3**：`tests/unit/domain02-chat-anomaly.test.mjs` C3（预算调到 maxTokens 150 / maxRounds 3 攒 6 轮 → 第 7 轮请求体已裁剪仍回 400 context_length_exceeded → 给「开新会话 / 删几条较早的消息」且**只发 1 次**不重试）。**L1**：`tests/integration/domain02-reply-error-ui.test.mjs` 行 4（413 界面文案 + 只 1 次 + 明确「重发没用」）。
- **F2-09**：`tests/unit/chat-stream-interrupt.test.mjs`（5 例）、`tests/unit/stream-idle-timeout.test.mjs`（4 例：空闲收口、反例不误杀、半句保留、阈值可配）、`tests/unit/api-request-timeout.test.mjs`。**#452 C1**：`tests/unit/domain02-chat-anomaly.test.mjs` C1 行 1（断流终态必须说「上游这次什么都没返回，属于临时故障，可以重试」，不许糊成「未知错误」也不许说成「不要重试」）。**L1**：`tests/integration/domain02-reply-error-ui.test.mjs` 行 5（断流）/ 行 6（空闲超时）两种文案分开 + 半句保留。
- **F2-10**：`tests/unit/chat-wait-notice.test.mjs`（6 例：4.9s 不提示、5/30/60s 分档、60s 档给出口、中英文案、定时器清单、挂载点契约）、`tests/unit/chat-retry-retryable.test.mjs:215`（hints 收尾清空）。**#452 C4**：`tests/integration/domain02-wait-thinking-ui.test.mjs` 表 C（首字等待期间切到后台再回前台：5s 档提示不消失、秒数不回退不归零、回前台后正文照常流式收尾、全程只发 1 次请求）。该文件表 A 行 1–3 另有 5/30/60s 三档在**真实 DOM** 上的出现与 60s 档「停止生成」出口断言（原先「无真实 DOM 用例」一段随之过期）。
- **F2-11**：`tests/unit/thinking-display.test.mjs`（7 例 A–G：默认折叠、正文不挂 DOM、流式自动展开、隐藏档、老数据、i18n、接线）、`tests/unit/thinking-adapters.test.mjs:472`（hidden 时请求仍带思考参数）、`tests/unit/thinking-entry-consistency.test.mjs`。`tests/integration/caps.test.mjs` 只验「深度思考入口可用」，不验折叠。
- **F2-12**：`tests/unit/copy-limit.test.mjs`（UTF-8 字节阈值）、`tests/integration/copy-limit.test.mjs`（6 条：超限弹窗、emoji 字节、512 KiB 边界、保存成功、保存失败、console error=0）。文件头自述 Android Binder / SAF 未测。

### 2.3 先做减法：现有用例的合并/删除建议

| 现有文件 | 现用例数 | 覆盖的功能点ID | 建议动作 | 合并后 | 可削减 |
| --- | --- | --- | --- | --- | --- |
| `unit/chat-context-limit-error` | 10 | F2-08 | 前 6 例（分类 + 文案）与 `official-error-classify` 的「分类 → 文案 → 可重试」是同一张判定表，并入后者做数据行；保留 4 条「真实 store 只发 1 次」的全链路断言 | 4 | **-6** |
| `unit/chat-stream-interrupt` | 5 | F2-02,F2-03,F2-09 | 2 条分类用例并入 `official-error-classify` 的断流/空流表；保留「读到一半报错」「用户中止」「正常流」3 条 | 3 | **-2** |
| `unit/thinking-adapters` 第 13 例 | 1（该文件共 17） | F2-11 | 与 `thinking-display` 的 D 档（hidden 不渲染）重复，删本文件的这一例 | 0 | -1 |
| `integration/full-acceptance` 第 3/4/6/7 组 | 1 文件 / 84 断言 | F2-01,F2-02 | 3/4 组（翻译器子进程）与 `unit/openai-adapter` 重复；6 组与 `integration/caps` 重复；7 组与 `request-body`/`provider-channels` 重复。删 4 组 | 保留 4 组 | 约 **-30 断言**（文件从 860 行降到 ~550 行） |
| `unit/render-process-gone`（域 1） | 5 | F1-07 | 见域 1 减法表 | 2 | -3（接 gradle 后） |

> **合计（单元层）**：本文涉及文件 112 个 `test()` → 78，**可削减约 34 个用例（-30%）**（其中 3 条需先把 JVM 测试接进 gradle），外加 `full-acceptance` 约 30 条重复断言。
> 全部为「同层同逻辑重复」，不动跨层证据。

### 2.4 拟定用例：最小充分集（加法）

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点 | 覆盖分支数 | 不可合并原因(若有) |
| --- | --- | --- | --- | --- | --- |
| `stop-and-regenerate.test.mjs`：同一会话内先「流到一半点停止」再「点重新生成」，表驱动断言请求次数/内容保留/版本可切回 | L1 | **是**（2 组 × 3 行） | **F2-03,F2-04,F2-02** | 6 | — |
| `reply-error-ui.test.mjs`：`page.route` 一张表回放 401 / 429 / 502 / 上下文超长 / 断流 / 空闲超时 / 额度不足，逐行断言「文案 + 请求次数 + 是否可重试 + 出口动作」 | L1 | **是**（7 行，同一夹具、同一断言函数） | **F2-05,F2-06,F2-07,F2-08,F2-09** | 7 | — |
| `wait-and-thinking-ui.test.mjs`：慢响应 + 假时钟，一张表跑「5s/30s/60s 提示」与「折叠/展开/隐藏」两组状态 | L1 | **是**（2 组 × 3 行） | **F2-10,F2-11** | 6 | — |
| **小计** | | 3 / 3 表驱动 | 覆盖 F2-02~F2-11 全部 10 条 | 19 | **新增 3 个用例** |

> F2-01/F2-02 正常路径与 F2-12 已有充分覆盖，不新增。
> F2-06 的额度分支已在 `integration/quota-exhausted` 覆盖，新表里只保留 1 行做回归，**不重复断言细节**。

---

## 3. 「完全没有任何测试」的功能点

| ID | 功能点 | 现状 | grep 证据 |
| --- | --- | --- | --- |
| **F1-03** | 会话列表加载失败 → 文案 + 重试 | 0 用例（任何层） | `grep -rn "sessionListLoadFailed" tests/` → 0 命中 |
| **F1-04** | 单条会话打开失败 → 文案 + 重试 | 0 用例（任何层） | `grep -rn "sessionLoadFailed" tests/` → 0 命中 |
| F1-02 | 恢复上次会话 | **功能不存在**（非「没测」） | `activeId` 默认 `null` 且无持久化键；无测试可写 |

域 2 **没有**「完全零测试」的功能点：12 条每条至少有一条 L0 用例；缺的是 **L1/L2 的界面与接线断言**。

## 4. 汇总

| 指标 | 域 1 | 域 2 | 合计 |
| --- | --- | --- | --- |
| 功能点数 | 9 | 12 | 21 |
| 已覆盖 | 3 | 4 | 7 |
| 部分覆盖（缺异常分支/缺上层） | 3 | 8 | 11 |
| 未覆盖 | 2 | 0 | 2 |
| 不适用（功能未实现） | 1 | 0 | 1 |
| 完全无测试 | 2 | 0 | 2 |
| **合并后新增用例（最小充分集）** | **3**（L1×2 + L3×1） | **3**（L1×3） | **6** |
| 新增用例覆盖分支 | 10 | 19 | 29 |
| 现有用例可削减 | 约 25（含条件性 3） | 约 9 用例 + 30 断言 | **约 34 用例** |

> 效率口径：**6 个新用例覆盖 15 条功能点、29 条分支**（平均 1 个用例覆盖 2.5 条功能点），
> 且 5 个自动化用例里 4 个是表驱动；同时先削掉约 34 个重复用例。净变化：**用例数基本不增，空白补上**。

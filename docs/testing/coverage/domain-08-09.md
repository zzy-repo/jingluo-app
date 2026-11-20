# 域 8（反馈与诊断）+ 域 9（设置与持久化）功能点盘点与覆盖映射

| 项 | 值 |
| --- | --- |
| 母单 | #362（功能点收集与分层测试覆盖盘点） |
| 本文件范围 | 域 8 反馈与诊断、域 9 设置与持久化；**只盘点与文档，不写测试、不改源码** |
| 读码基准 | `origin/main` = `372703b`（2026-11-19 20:13）。本地 `main` 检出在 `aab386d`，落后 149 个提交，本文件一律按 `origin/main` 读码，符号与路径均为该树 |
| 盘点日期 | 2026-11-19 |
| 涉及代码 | `src/services/diagnostics/**`（`collector` / `fields` / `redact` / `export` / `transport.*`）、`src/components/settings/**`（`FeedbackDialog` / `SettingsDialog` / `logView` / `ApiConfigFields` / `AppUpdateField`）、`src/services/feedbackDraft.ts`、`src/services/settings.ts`、`src/services/api/apiConfig.ts`、`src/services/api/configMigration.ts`、`src/i18n/index.ts` |

## 0. 口径

> ⚠️ **覆盖状态以实际用例为准，改动后必须同步更新本表**：`覆盖状态` / L0–L3 列说的是**当前仓库里
> 真实存在、且能跑绿的用例**，不是上表那条读码基准（`372703b`, 2026-11-19）当时的判定 ——
> 本文件已经踩过一次：F8-12 / F9-12 曾标「未覆盖 / 仅有间接证据」，实际早已有用例且破坏验证会变红
> （#453 指出，见 `docs/testing/report.md` §6.5）。用例新增 / 删除 / 失效后，**必须在同一个 PR 内**
> 同步改本表（含域计数）；只改用例不改表 = 本表立刻过期。

### 0.1 分层映射（仓库分层 ↔ #362 分层）

仓库只有 `tests/run-layer.mjs` 定义的 `unit / integration / e2e / device` 四层，与 #362 的 L0–L3 不是一一对应，本文件按下面的映射登记，避免和 runner 口径打架：

| 仓库层 | 依赖 | 本文登记为 | 备注 |
| --- | --- | --- | --- |
| `tests/unit` | 纯 Node，零浏览器 | **L0** | 直接 `import` 源码 `.ts`（Node 22 type stripping） |
| `tests/integration` | Playwright + 真实 dist + 打桩上游 | **L1** | 按 #362 口径这些用例多数已具 L2 性质（真实 DOM 交互、1–3 分钟），登记在 L1 列时代表「真实产物 + 真实 DOM 的集成断言」 |
| `tests/e2e` | 真上游 / 真反馈后端（需 `E2E_API_KEY`） | **L2** | 仅 2 个文件 |
| `tests/device`、`scripts/compat/p4-layout.mjs`、`docs/ui/**` 取证脚本 | AVD / 真机 / CDP | **L3** | 手动按需，不进 CI。`tests/device/` 目前只有 `url-import-device.test.mjs`（域 5），**域 8/9 的 L3 用例为空** |

`✓` = 该层存在断言此功能点的用例；`—` = 该层无；`条件` = 用例存在但缺产物/服务时 `SKIP(env)`。

### 0.2 覆盖状态取值（照 #362）

`已覆盖` / `部分覆盖（缺异常分支）` / `未覆盖` / `不适用（无自动化）`。

### 0.3 用例最小化原则（本文所有建议的唯一账本）

维护者口径：**测试点要尽可能少、覆盖要尽可能全**。因此本文的缺口一律不按「一条缺口一个用例」记账，而是先做减法再归并：

1. 同一逻辑被多层重复断言 → 只在**最省的一层**留一条，其余删；
2. 天生条目多的域（域 9 的设置项、域 8 的敏感字段）→ **一张表跑全表**，禁止一项一条；
3. 每条拟定用例必须注明**覆盖哪些功能点 ID**、覆盖多少个分支，以及**为什么不能并进别的用例**；
4. 总量红线：域 8 + 域 9 **新增用例 ≤ 6–8 条**。本次拟定 **7 条**（见 §8），另加 1 处门禁扩展（0 用例）与 1 项 L3 按需检查（0 用例）。

### 0.4 判定方式

逐条读源码行为 → 找所有引用该行为的用例 → 读用例文件头 + 逐条 `assert`，确认断言的是**该功能点的结果**而不是同名字符串。门禁类实跑：`node scripts/check-log-coverage.mjs --selftest`（本次通过，3 个反例全部被拦住）。

---

## 1. 域 8：反馈与诊断（15 个功能点）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F8-01 | 打开「反馈与日志」弹窗，看到本次运行的日志预览 | 设置 → 数据管理 → 写反馈 | 弹窗打开；预览按口径显示 N 条并标截断；可展开、可筛选 | 弹窗打不开 / 条数口径与渲染行数不一致 | ✓ | ✓ | — | — | **已覆盖** | #301 #305 |
| F8-02 | 填了一半点取消/Esc/遮罩关掉，**重开内容还在** | 同上（关闭后重开） | 描述、联系方式、分类回填；截图只提示「需重新选择」 | 重开全空 = 用户白填一遍 | ✓ | ✓ | — | — | **已覆盖** | #31 |
| F8-03 | 主动「清空已填内容」必须二次确认 | 弹窗底部按钮 | 先出确认，确认后才清；分类回默认「问题反馈」 | 一点就清 = 误删用户输入 | ✓ | ✓ | — | — | **已覆盖** | #31 |
| F8-04 | 反馈附件（截图）：相册选图 → 压缩 → 随提交上传 | 弹窗「上传图片」 | 预览出现；超限压到最长边 ≤1280；`images` 随请求发出 | 非图片/相册权限拒绝/压缩失败时的提示 | ✓ | ✓ | — | — | **部分覆盖（缺异常分支）** | #301 #313 |
| F8-05 | 复制单条日志（含完整 meta）、复制工单号 | 日志行「复制」按钮 / 成功页 | 文本含毫秒时间、level、kind、正文、完整 meta；脱敏结果原样保留 | 剪贴板失败应提示，不能静默 | ✓ | ✓ | — | — | **部分覆盖（缺异常分支）** | #301 #305 |
| F8-06 | 「检查日志完整性」自检：条数 / 跨度 / 覆盖事件类型 / 缺失项 | 弹窗内按钮 | 四个数字与真实缓冲区一致；缺项列出来；只提示不阻断上传 | 自检数字与预览不一致 | — | ✓ | — | — | **部分覆盖（缺 L0）** | #301 |
| F8-07 | 提交反馈：成功显示工单号；失败按原因给可读文案；413 给「体积过大」 | 弹窗「提交」 | 工单号渲染；网络/超时/413 文案分档；超大日志自动裁剪并降级重试 | 未知错误 / 静默失败 | ✓ | ✓ | ✓ | — | **已覆盖** | #301 #313 |
| F8-08 | 离线导出反馈日志（保存成 JSON 文件，不联网） | 弹窗「保存日志文件」 | 断网也能存；文件名带版本号；导出不含描述/联系方式/截图 | 联网才可导出 / 导出里混进用户正文 | ✓ | ✓ | — | — | **已覆盖** | #301 |
| F8-09 | 反馈弹窗滚动：触摸滑动到底、字号放大、软键盘弹出、旧内核无 `dvh` | 弹窗内滚动区 | 触摸能滚到底、提交键可见可达；关闭后 body 无滚动锁残留 | 滚不动 / 提交键被键盘挡住 / 主页触控被锁死 | — | ✓ | — | — | **部分覆盖（缺 L3 真机）** | #30 #57 #63 |
| F8-10 | 诊断采集：环形缓冲 500 条、刷新后仍在、hook 捕获 console.error/未捕获异常/未处理 rejection/fetch 失败 | 全应用后台 | 超过 500 只留最新 500；刷新后从 IndexedDB 恢复；四类失败都有记录 | 日志丢失 / 崩溃现场没记录 | — | ✓ | — | — | **已覆盖** | #301 |
| F8-11 | 脱敏：`sk-` / `Bearer` / `token=` / `Signature=` / `AccessKeyId=` → `***`；完整 URL → 只剩 path | 采集层自动 | 日志、错误页报告、导出文件三处都脱敏 | Key 原样进日志 → 泄漏 | ✓ | ✓ | ✓ | — | **已覆盖** | #301 #28 #313 |
| F8-12 | **设备码（device_id）与卡密原文绝不进日志/导出** | 采集层 + 导出层 | 任何日志 meta、导出 JSON 里都没有 device_id / 完整卡号 | 丢账号 / 卡密被用户随手贴进工单 | ✓ | ✓ | — | — | **部分覆盖（值维度已直断，键名维度有洞）**：`tests/unit/domain08-sensitive-fields.test.mjs` N1（设备码 / 卡密 / 卡号 / 订单号 / 手机号等 8 类敏感值 × 采集层 / 导出层 / 错误页 3 个边界，31 断言，#387 后严格全绿）+ `tests/integration/domain08-feedback-negative.test.mjs`；破坏验证：删掉 `redact.ts` 的 `deviceId` 值规则 → 变红。**残留**：键名维度（白名单收下 `deviceId` + 删掉密钥段）组合变异全绿，见 `docs/testing/report.md` §6.2 D2，已登记缺口 | #261 #90 #189 #387 #453 |
| F8-13 | `sanitizeMeta` 白名单：白名单外的键**静默丢弃**（#301 的坑） | 采集层 `record()` | 合法键原样落库；越界/非法值丢弃；白名单外键丢弃且不抛 | 埋点「写了但生产里没有」= 排查证据凭空消失 | ✓ | — | — | — | **部分覆盖（缺调用点对账）** | #301 #306 #313 |
| F8-14 | i18n 缺 key 兜底：不抛错、给中文兜底、留结构化日志 | 任意界面 | 缺 key 不换页、文案不跨语言借用、30 分钟内同 key 只报一次 | 白屏（ErrorBoundary 接管）/ 中文用户看到英文原文 | ✓ | — | — | — | **已覆盖** | #314 |
| F8-15 | 埋点覆盖面门禁 `check:log-coverage` | `pnpm run check:log-coverage` | R1 死枚举 / R2 关键链路 / R3 meta 贫瘠；`--selftest` 三个反例必须被拦 | 新埋点只有一句人话也进主干 | ✓（脚本自检） | — | — | — | **部分覆盖（未接线 CI）** | #301 #315 #316 |

**域 8 计数：15 个功能点 → 已覆盖 8 / 部分覆盖 7 / 未覆盖 0 / 不适用 0。**

> 2026-11-20 按行级状态重算（原「未覆盖 1 = F8-12，仅有间接证据」是**过期信息**：`domain08-sensitive-fields` N1 矩阵早已在测、且破坏验证会变红，见 F8-12 行的说明与 `docs/testing/report.md` §6.5）。

### 1.1 域 8 现有用例证据（按功能点）

| ID | 用例文件（层） | 关键断言 / 说明 |
| --- | --- | --- |
| F8-01 | `tests/unit/log-viewer.test.mjs`（L0）、`tests/integration/log-viewer.test.mjs`（L1）、`tests/integration/diagnostics.test.mjs`（L1，[7]） | 「预览视图：口径文案的三个数字与真实渲染行数一致」；L1 用「弹窗快照 = 缓冲区前缀」自算应显示条数，不依赖产品过滤实现 |
| F8-02 | `tests/unit/feedback-draft.test.mjs`（L0）、`tests/integration/feedback-draft.test.mjs`（L1，390/360 两档 + 截图） | 读回是副本、只有截图也算草稿、空草稿等于没草稿；L1 断言关掉再开后输入框内容仍在 |
| F8-03 | 同上 | `clearFeedbackDraft` 清空；L1 断言点「清空已填内容」先出「确定清空已填内容」，确认后描述/联系方式为空、分类回「问题反馈」 |
| F8-04 | `tests/unit/feedback-images.test.mjs`（L0，6 例）、`tests/integration/feedback-scroll.test.mjs`（L1）、`tests/integration/diagnostics.test.mjs`（L1，[6]） | 单图映射、UTF-8 body 预算、413/network/timeout 降级保留同一截图、大图有界重压缩、超预算明确报错且零请求、原生 `CapacitorHttp` 沿用 `images`；L1 断言 `setInputFiles` 后 `img` 出现、截图压到最长边 ≤1280 |
| F8-05 | `tests/unit/log-viewer.test.mjs`（L0，4 例）、`tests/integration/log-viewer.test.mjs`（L1） | 复制文本含毫秒时间/level/kind/正文/**完整** meta；无 meta 不写空段；meta 换行折成 `\n`；超长 meta 与非法时间戳不崩；L1 断言复制内容里的 `sk-***` 原样保留 |
| F8-06 | `tests/integration/diagnostics.test.mjs`（L1，[9][10]） | 三条提示（少日志 / 没网络 / 跨度<1s）+ 缺 `state_snapshot` 时自动补一条；「检查日志完整性」实测条数/跨度/覆盖类型数/缺失项 + 截图 |
| F8-07 | `tests/unit/feedback-images.test.mjs`（L0）、`tests/integration/diagnostics.test.mjs`（L1，[7]）、`tests/e2e/diagnostics-upload.test.mjs`（L2，[1][2][6]） | L2 真后端：`logSize` 等于发出字节数、body 只有五字段、413 给「体积过大」；L1 mock transport 下显示工单号 |
| F8-08 | `tests/unit/feedback-export.test.mjs`（L0，6 例）、`tests/integration/feedback-export.test.mjs`（L1） | L0：离线不调 fetch、二道脱敏、500 条不被上传预算裁、超限 JSON 合法且标 `omittedLogCount`、快照读失败保留最后可见快照；L1：`setOffline(true)` 后仍能下载，文件名带产物版本号，导出不含描述/联系方式 |
| F8-09 | `tests/integration/feedback-scroll.test.mjs`（L1，5 组合 × 390/360） | `after.top > 0`、能滚到底、提交键在视口内、导出可回滚、展开后仍到底、关闭后 `body` 无 `data-scroll-lock` 且 `overflow` 回基线、父级设置面板与主会话触控恢复。**必带 `--timeout-ms 600000`**（实测 ~200s） |
| F8-10 | `tests/integration/diagnostics.test.mjs`（L1，[1][3][4]） | 600 条只留最新 500；刷新后 `app_launch` 仍在（IndexedDB）；单条 msg 截断 2000；console.error / 未捕获异常 / 未处理 rejection / fetch 失败都被记录 |
| F8-11 | 见 §6.1（L0 `diagnostics-log-fields` C、L1 `diagnostics` [2]、L2 `diagnostics-upload` [5]、导出二道 `feedback-export`、错误页 `error-report`） | 见 §6.1 断言原文 |
| F8-12 | ⚠️**本格已过期**（2026-11-20）：现为 `tests/unit/domain08-sensitive-fields.test.mjs`（N1 矩阵，8 类敏感值 × 3 边界，31 断言，严格全绿）+ `tests/integration/domain08-feedback-negative.test.mjs`；旧的间接证据（`ours-invite[1][6]`、`bind-key[7]`）不再作为唯一依据 | 断言的是「日志 payload / 导出文本 / 错误页报告里原文不出现 + 打码形态出现」；**键名维度仍是洞**（见 G8-01 末与 `docs/testing/report.md` §6.2 D2） |
| F8-13 | `tests/unit/diagnostics-log-fields.test.mjs`（B/C/E）、`tests/unit/log-313-attachment-import.test.mjs`（10 场景） | 白名单外键/密钥键/非原始值必须被丢弃；键数上限；stage 枚举只读兼容。`log-313` 明确「写入的 meta 走真实的 `sanitizeMeta`」，断言的就是后端会收到的那份 |
| F8-14 | `tests/unit/i18n-missing-key.test.mjs`（5 组）、`tests/unit/format-points-i18n.test.mjs`、`tests/unit/auto-title-prompt-i18n.test.mjs`（配套文案） | 缺 key 不抛错、不借 en 原文、一条 `warning` + `i18nKey/locale/reason`；30 分钟去重（50 次只留 1 条）；缺占位符保留 `{total}` 且只记参数名 |
| F8-15 | `scripts/check-log-coverage.mjs`（门禁，`--selftest` 本次实跑通过） | 三个反例（死枚举 / 关键链路零埋点 / meta 贫瘠）全部被拦住；**未接进 `.github/workflows/ci.yml`** |

## 2. 域 8 缺口小表

| 编号 | 缺口（对应功能点） | 风险 | 现有测试 | 建议层级 | 归属（拟定用例） | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| G8-01 | **脱敏失败：device_id / 卡密原文可能进日志或导出**（F8-12） | **P0 资损/丢账号** | ⚠️**「只有间接证据 / 没有任何用例断言」已过期**（2026-11-20；值维度已由 N1 直断，且破坏 `redact.ts` 的 `deviceId` 规则后会变红）。原判据：`ours-invite` 断言「整条链路一条 console 都没写」；`export.ts` 的 `PRIVATE_KEY` 正则按**键名**过滤 `card`/`payment`/`receipt`；`SECRET_SEGMENTS`（`fields.ts`）**不含** `deviceId` / `card`。当时结论是「没有任何用例断言日志 payload 或导出文件里不出现 device_id 与完整卡号」——**该结论已被 N1 推翻**。现在真正剩下的洞只有**键名维度**（白名单收下 `deviceId` + 删掉密钥段 → 组合变异全绿），见 `docs/testing/report.md` §6.2 D2 | L0（取 N1）；L2 取 **不新增**（N1 已断言导出文本边界，真往返由现有 `e2e/diagnostics-upload` 承担） | **N1** | 拆单：把账号凭据键纳入密钥语义（`SECRET_SEGMENTS` 加 `deviceid`/`cardno`/`cardnumber`，或写「疑似账号凭据键整条丢弃」表驱动），再加一条真提交路径的 payload 快照断言 |
| G8-02 | 白名单与调用点无法对账（F8-13） | P1 证据静默丢失 | `diagnostics-log-fields` 测 `sanitizeMeta` 本身；`log-313` 用真实 `sanitizeMeta` 测 10 个场景；**但没有「所有调用点写的键 ⊆ 白名单」的静态对账**。#313 已实证 `resume` 键「早已在写、一直被清洗丢掉」 | 门禁（0 用例） | **N1 之外：扩 `check:log-coverage` R4** | 并入 `check:log-coverage` 作 R4（扫 `record*` 的 meta 字面量键 vs `META_KEYS ∪ EXTRA_KEYS`） |
| G8-03 | 门禁未接线 CI（F8-15） | P1 重演「靠人记得跑」 | `package.json` 有 `check:log-coverage`，`--selftest` 通过；`.github/workflows/ci.yml` 只跑 `check:legacy` / `check:matrix` / `check:ip` | 配置（0 用例） | — | 加一行 CI（先非 `--strict`，随 knownGaps 收口再转严格） |
| G8-04 | 提交前自检无 L0（F8-06） | P1 主流程 | `analyze()` 的三条阈值（<10 条 / 无网络 / 跨度<1s）与 `EXPECTED_KINDS` 只在 L1 断言 | L0 | **N4** | 把 `inspectLogCoverage` / `validatePayload` 做成表驱动纯函数用例 |
| G8-05 | 复制失败分支（F8-05） | P2 体验 | 只有成功路径 | L1 | **N5**（并入负向表，不单列） | 剪贴板抛错 → `copyFailed` toast |
| G8-06 | 反馈附件异常分支（F8-04） | P2 体验 | 只测「选出图片后能预览」 | L1 | **N5**（并入负向表，不单列） | 非图片 / 权限拒绝 / 压缩失败 |
| G8-07 | 反馈弹窗滚动缺 L3（F8-09） | P2 体验（旧机 P1） | `feedback-scroll` 覆盖 5 组合 × 2 档宽，但全在桌面 Chromium 上模拟字号/键盘/无 `dvh` | L3（按需，0 自动化用例） | — | 真机 WebView 83/91 各一档，进 `docs/ui/**` 取证 |
| G8-08 | i18n 无全局键集对账（F8-14） | P2 | 只有逐功能「zh/en 成对」断言（`reading-settings` / `enter-key-mode` / `thinking-display` / `rotate-key` 等） | L0 或门禁（0–1 用例，跨域复用） | **N1 之外：并入门禁或全局 1 条** | `Object.keys(zh)` vs `Object.keys(en)` 全等 + 占位符集合一致 |

---

## 3. 域 9：设置与持久化（14 个功能点）

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F9-01 | 主题：浅色 / 深色 / 跟随系统，选择持久化、系统切换实时跟随 | 设置 → 通用 → 外观 | 选中即生效；`system` 跟随 `prefers-color-scheme`；重启保留 | 重启后回默认 / 系统切深色界面不跟 | — | — | — | — | **未覆盖** | — |
| F9-02 | 字号 / 字重 / 行距各档持久化，冷启动读回，脏值回落默认 | 设置 → 通用 → 阅读设置 | 三档立即生效（根元素 `data-*`）；重启保留；非法值回 `standard/regular/standard` | 重启回默认 / 脏值渲染出畸形字号 | ✓ | — | — | — | **已覆盖** | #102 |
| F9-03 | 思考过程显示：折叠（默认）/ 展开 / 隐藏，持久化 | 设置 → 通用 | 折叠态思考正文**不挂 DOM**；隐藏档不占位；重启保留 | 长历史里思考正文全量渲染（内存/卡顿） | ✓ | — | — | — | **已覆盖** | #46 |
| F9-04 | 快速 / 专家模式（思考档位）持久化、进请求体、刷新后保持 | 输入行 / 欢迎页 / 设置 | 切换即写 `chat-mode` + 兼容 `thinking`；请求体 `thinking` 随之变；刷新后仍生效；四渠道入口恒常驻 | 切换无效 / 刷新回默认 / 某渠道入口消失 | ✓ | ✓ | — | — | **已覆盖** | #25 #341 |
| F9-05 | 回车键行为三档（回车发送 / 修饰键发送 / 只换行）持久化 | 设置 → 通用 | 立即生效；`enterKeyHint` 随档变；输入法合成期任何档位都不发送；重启保留 | 中文输入法选词时误发 | ✓ | — | — | — | **已覆盖** | #108 |
| F9-06 | 界面语言（zh/en）持久化；未选过时按浏览器语言 | 设置 → 通用 → 语言 | 重启保留；首次按 `navigator.language` | 重启回默认 / 中文系统给英文界面 | — | — | — | — | **未覆盖** | #94 #314 |
| F9-07 | TTS 音色 / 智能搜索开关 / 侧边栏收起状态持久化 | 设置 / 侧边栏 | 重启保留 | 每次重启都回默认 | — | — | — | — | **未覆盖** | — |
| F9-08 | 更新渠道切换（稳定版 ↔ 稳定+预发布）+ 变体隔离 + 切渠道后自动重查 | 设置 → 关于 → 检查更新 | 预发布行只在选「稳定+预发布」时可升；`internal`/`standard` 变体互不串；切档立即重查 | 升到不该升的包 / 切档后还显示旧结论 | ✓ | — | — | — | **部分覆盖（UI 层无断言，且**不持久化**）** | #310 #330 |
| F9-09 | 渠道选择（官方 / Anthropic / OpenAI / 自营）持久化，能力入口随渠道显隐 | 设置 → 模型服务 | 刷新后渠道仍在；不支持的能力入口从 DOM 消失（不是置灰） | 刷新回默认渠道 / 入口点了报错 | — | ✓ | — | — | **已覆盖** | #274 #341 |
| F9-10 | **切换渠道后凭证隔离**：Key 四渠道共用不丢；`base-url:<渠道>` / `model:<渠道>` 按渠道分开存不互串 | 设置 → 模型服务 | 切 A→B→A，A 的地址/模型还在；内置渠道（官方/自营）不渲染也不接受写地址与模型 | A 的中转地址/模型被带进 B（#339 的根因） | — | ✓ | — | — | **部分覆盖（缺 L0）** | #339 #341 |
| F9-11 | 配置迁移：`chat-demo:config-schema` 1→2 清 `#339` 残留共享 model；幂等；老中转在用则不动；诊断留痕 | 升级后首次启动（`main.tsx` → `migrateConfigOnce`） | 残留键被删、版本号落盘、官方渠道发内置模型、留一条 `config_change/legacy-model` | **迁移误删用户仍有效的配置（不可回滚）** | ✓ | ✓ 条件 | — | — | **已覆盖** | #339 |
| F9-12 | 「删除所有对话」及清数据后的行为：设置、设备码、日志、草稿的保留/清理口径 | 设置 → 数据管理 | 只删会话与附件；`chat-demo:*` 设置、`ours-device-id`、诊断日志不受影响 | **设备码被清 = 丢账号**；设置被清 = 用户重配 | ✓ | ✓ | — | — | **已覆盖（含异常）**：`tests/integration/domain09-delete-all-retention.test.mjs`（8 行保留口径表：会话摘要 / 正文 / 附件必须清空；设备码 / API Key / 设置 / 诊断日志 / 草稿按口径保留，逐行对账，表在 `tests/fixtures/domain08-09/delete-retention.mjs`）；破坏验证：`clearHistory()` 里补一句 `localStorage.clear()` → T4「设备码从 `d-0123…cdef` 变成 `null`」变红 | #261 #453 |
| F9-13 | 脏 localStorage 容错：非法枚举值回落默认，不把非法值渲染/发出去 | 冷启动 | `settings.ts` 13 个 `chat-demo:*` 键各自有白名单回落（`location` 走 `JSON.parse` + `normalizeLocation`），写不进去也不崩 | 畸形值进 UI / 进请求体 | ✓ | — | — | — | **部分覆盖（6/13 键，另 `provider-kind`）** | — |
| F9-14 | 设置项在窄屏与旧内核下的布局：#57 文本列塌成单字宽、#190「对话背景」行、#159 三列截断 | 设置页 390/360、WV83/91 | 文本列有下限、按钮区整行下移、无横向溢出 | 标题逐字竖排 / 按钮被裁 | — | — | — | ✓ 手动 | **不适用（无自动化）** | #57 #159 #190 |

**域 9 计数：14 个功能点 → 已覆盖 7 / 部分覆盖 3 / 未覆盖 3 / 不适用 1。**

> 2026-11-20 按行级状态重算（原把 F9-12 记作「未覆盖」是**过期信息**：`domain09-delete-all-retention` 8 行保留口径表早已在测、且破坏验证会变红，见 F9-12 行与 `docs/testing/report.md` §6.5）。

> F9-08 的补充事实：更新渠道**不是持久化设置**——`AppUpdateField.tsx` 用 `useState`，初值由 `bundledApp().version` 是否含 `-` 推断（预发布包默认「稳定+预发布」）。即重启后渠道选择回到推断值。当前没有任何文档或断言把这个行为写成契约。
>
> F9-14 的补充事实：`docs/compat/regression/README.md` 自述 #30 / #57 / #102 的「CSS 像素布局」部分**无法自动覆盖**；可执行证据是 `scripts/compat/p4-layout.mjs`（390/360 溢出实测清单，需 AVD）与 `docs/ui/settings-cell-wrap/`（#57 关单记录）、`docs/ui/190-backup-row/`（WV83/91 三档 JSON + 截图 + `measure.mjs`）。这些脚本不在 `tests/run-layer.mjs` 里，只能按需手动跑。

### 3.1 域 9 现有用例证据（按功能点）

| ID | 用例文件（层） | 关键断言 / 说明 |
| --- | --- | --- |
| F9-01 | **无** | `tests/` 内 `chat-demo:theme-preference` 0 命中；唯一相邻断言是 `tests/integration/motion.test.mjs`「reduced-motion 下主题淡入动画未关闭 → FAIL」 |
| F9-02 | `tests/unit/reading-settings.test.mjs`（L0，A–F 7 例） | 默认档 = 改造前现状；三档改动立即生效 + 冷启动读回 + 脏值回落；CSS token 默认档逐值不变；只作用于消息区；根元素 `data-*` 接线；zh/en 成对 |
| F9-03 | `tests/unit/thinking-display.test.mjs`（L0，A–G） | 默认 collapsed + 冷启动读回；折叠态正文**不挂 DOM**；流式中自动展开、结束收敛；hidden 不占位且从时间线剔除；老数据兼容；ReplyArea 真接线 |
| F9-04 | `tests/unit/thinking-entry-consistency.test.mjs`（L0）、`tests/integration/mode-switch-request.test.mjs`（L1）、`tests/integration/mode-switch.test.mjs`（L1） | 四渠道 × 2 入口恒常驻、点击后 `chatMode/thinking/localStorage` 真翻转；刷新后模式仍在且请求体差异含 `thinking` |
| F9-05 | `tests/unit/enter-key-mode.test.mjs`（L0，A–F） | 三档语义、跨重启持久化、脏值回落、输入法合成期不发送、`enterKeyHint` 随档变、设置面板追加不重排 |
| F9-06 | **无**（`chat-demo:locale` 只作为无关字段出现在 `tests/unit/compat-*`） | 冷启动读回与浏览器语言回退无断言 |
| F9-07 | **无** | `chat-demo:tts-voice` / `chat-demo:search` / `chat-demo:sider-collapsed` 均 0 命中 |
| F9-08 | `tests/unit/app-update.test.mjs`（L0）、`tests/unit/releases-manifest-buildtype.test.mjs`（L0）、`tests/unit/update-failure.test.mjs`（L0） | `selectUpdate` 的 variant 隔离与 stable/prerelease 独立、同 code 歧义 fail-closed、相对路径与 base 拼接、失败分类文案；**UI 的渠道下拉与切档重查无断言，且 `channel` 是 `useState`（不持久化）** |
| F9-09 | `tests/integration/provider-channels.test.mjs`（L1，[1]–[8]） | 标准构建默认官方渠道；四渠道各渲染哪些输入项；能力入口随渠道从 DOM 消失；刷新后渠道选择持久化；console error = 0 |
| F9-10 | `tests/integration/provider-channels.test.mjs`（L1，[3][5][6]）、`tests/integration/probe-auth-protocols.test.mjs`（L1，按渠道 seed `base-url:<kind>`） | `stored['chat-demo:base-url:anthropic'] === BASE_A && stored['chat-demo:model:anthropic'] === MODEL_A`；切渠道后 Key 不丢（提示可重填）；自营渠道界面不出现后端地址与内置模型名 |
| F9-11 | 见 §6.2（L0 `config-migration` 6 例 + L1 `legacy-config` + L0 `provider-deepseek-model`） | 见 §6.2 断言原文 |
| F9-12 | ⚠️**本格已过期**（2026-11-20，原写「无」）：现为 `tests/integration/domain09-delete-all-retention.test.mjs`（8 行保留口径表，表在 `tests/fixtures/domain08-09/delete-retention.mjs`） | 逐行断言「删完后还剩什么」：会话摘要/正文/附件清空；设备码/API Key/设置/诊断日志/草稿按口径保留；破坏验证（`clearHistory()` 补 `localStorage.clear()`）→ T4 设备码变 `null` 时变红 |
| F9-13 | `tests/unit/reading-settings.test.mjs`、`tests/unit/enter-key-mode.test.mjs`、`tests/unit/thinking-display.test.mjs`、`tests/unit/thinking-entry-consistency.test.mjs` | 覆盖 `chatMode`、`thinkingDisplay`、三个阅读档、`enterKeyMode`；其余 6 键 + `provider-kind` 无断言 |
| F9-14 | `scripts/compat/p4-layout.mjs`（L3 手动）、`docs/ui/settings-cell-wrap/`（#57 关单记录）、`docs/ui/190-backup-row/`（WV83/91 三档 JSON + 截图 + `measure.mjs`） | 逐元素 `getBoundingClientRect().right` 越界清单 + 视口宽/可滚动宽实测；不在 `tests/run-layer.mjs` 内，需手动跑 |

## 4. 域 9 缺口小表

| 编号 | 缺口（对应功能点） | 风险 | 现有测试 | 建议层级 | 归属（拟定用例） | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| G9-01 | **迁移契约只覆盖 #339 一个场景，缺「迁移不许动用户有效配置」的结构性不变量**（F9-11） | **P0（配置不可回滚）** | `tests/unit/config-migration.test.mjs` 6 例（残留清除 / ours 渠道同样清 / 幂等 / 老中转不清 / 无残留只落版本 / 版本到顶一个键都不碰）+ `tests/integration/legacy-config.test.mjs` 端到端（版本号=2、残留被删）。**已有测试，但只针对 schema 2 这一次**；schema 升到 3 时没有任何「允许删除的键清单之外一个都不动」的断言 | L0 | **N3** | 把每次 schema 升级写成「版本 → 允许删除的键集合」白名单表驱动，并断言表外键（设置/设备码/`provider-kind`/API Key）一个都不被删 |
| G9-02 | 迁移的唯一端到端证据会静默失效（F9-11） | P0（同上） | `legacy-config.test.mjs` 依赖 `APP_URL`/本地 dist，缺失时 `SKIP(env)`；CI 里不会跑 integration 层 | 配置（0 用例） | **N3 的现有 L1 复用** | 发布前门禁用「SKIP 即 FAIL」模式跑一次迁移用例 |
| G9-03 | ~~「删除所有对话」与清数据后行为无任何断言~~（F9-12）**已落地** | P1（`device_id` 丢＝丢账号） | ⚠️**本行已过期**（2026-11-20）：N7 已落地为 `tests/integration/domain09-delete-all-retention.test.mjs`，不再 0 命中 | L1（L0 半边的读取断言并入 N2） | **N7**（必须单列） | L1：点删除 → 会话空、`chat-demo:*` 设置、`ours-device-id`、诊断日志仍在 |
| G9-04 | 脏值容错只覆盖 6/13 键（F9-13） | P1 | 有断言：`chatMode`、`thinkingDisplay`、`readingFontSize/Weight/LineHeight`、`enterKeyMode`（`reading-settings` / `thinking-display` / `thinking-entry-consistency` / `enter-key-mode`）。**无断言：`locale` / `location` / `themePreference` / `ttsVoice` / `search` / `siderCollapsed`，另加 `apiConfig.getProviderKind()` 的 `provider-kind` 回落** | L0 | **N2**（并入设置矩阵，不单列） | 表驱动：每个键 × {非法枚举, 空串, 大小写变体, 非字符串} |
| G9-05 | 主题完全没有测试（F9-01） | P1（体验，且是首屏观感） | `tests/` 下 `chat-demo:theme-preference` **0 命中**；仅 `motion.test.mjs` 断言「减少动态效果下主题淡入动画关闭」 | L0 取 N2（持久化/脏值）；跨系统跟随取 N6（UI 生效） | **N2 + N6** | 主题并入设置矩阵与重载用例，不单列 |
| G9-06 | 语言持久化无测试（F9-06） | P2 | `chat-demo:locale` 只在 `compat-*` 用例里作为无关字段出现 | L0 | **N2**（并入设置矩阵） | 冷启动读回 + 浏览器语言回退 |
| G9-07 | TTS / 智能搜索 / 侧边栏收起（F9-07） | P2 | 0 命中 | L0 | **N2**（并入设置矩阵） | 表驱动持久化 |
| G9-08 | 更新渠道 UI 与「不持久化」契约（F9-08） | P2 | `selectUpdate` 的 channel/variant 隔离有 L0；UI 切档自动重查与「重启回推断值」无断言 | L0 | **N4 之外：并入 N2 一行 + 文档**（把「不持久化」写成契约，0 新用例） | 二者取一：补持久化，或把「不持久化」写成显式契约 |
| G9-09 | 渠道凭证隔离缺 L0（F9-10） | P2（#339 根因在读取侧） | `apiConfig.ts` 的 `base-url:<kind>` / `model:<kind>` 分离只有 L1 断言（`stored['chat-demo:base-url:anthropic']`） | L0 取 N2（存储键/脏值）；跨渠道读写取 N6 | **N2 + N6** | 纯函数级：切渠道读回、内置渠道拒绝写、共享键在非老中转时被忽略 |
| G9-10 | 设置页窄屏/旧内核布局无自动化（F9-14） | P2（旧机 P1） | 仅 L3 手动脚本与取证目录 | L3（登记为不适用，0 用例） | — | 把 `p4-layout.mjs` 与 `docs/ui/190-backup-row/measure.mjs` 组成「UI 改动后必跑清单」 |

---

## 5. 「完全没有任何测试」清单

判定口径：仓库内不存在任何层级的用例断言该行为（不是「覆盖不全」，是**零断言**）。

| # | 功能点 | 证据（0 命中的检索） | 风险 | 归属（拟定用例） |
| --- | --- | --- | --- | --- |
| 1 | 主题偏好（浅色/深色/跟随系统）与持久化（F9-01） | `chat-demo:theme-preference` 在 `tests/**` 0 命中；`theme.ts` 的 `resolveTheme` / `useTheme` 无引用 | P1 | **N2**（持久化/脏值）+ **N6**（UI 生效、跟随系统） |
| 2 | 界面语言持久化（F9-06） | `chat-demo:locale` 无持久化断言（只在 compat 用例里当无关字段） | P2 | **N2** |
| 3 | TTS 音色持久化（F9-07） | `chat-demo:tts-voice` 0 命中 | P2 | **N2** |
| 4 | 智能搜索开关持久化（F9-07） | `chat-demo:search` 0 命中 | P2 | **N2** |
| 5 | 侧边栏收起状态持久化（F9-07） | `chat-demo:sider-collapsed` 0 命中 | P2 | **N2** |
| 6 | 「删除所有对话」与清数据后的保留口径（F9-12） | `deleteAllSessions` 在 `tests/**` 0 命中 | **P1（丢账号）** | **N7**（必须单列） |
| 7 | 更新渠道切换的 UI 行为与其「不持久化」契约（F9-08 的 UI 半边） | `AppUpdateField` 的 `channel` 状态与切档重查无断言 | P2 | **N2 一行 + 文档契约**（合并持久化矩阵的表头说明，0 新用例） |
| 8 | device_id / 卡密「不进入日志与导出」（F8-12）——**有间接证据、无直接断言** | 无 payload/导出级的否定断言（见 G8-01） | **P0（泄漏）** | **N1**（敏感字段矩阵里 device_id / 卡号 / 键名三行） |

第 8 项单独标注：它不是「零相关用例」，而是「零直接断言」——`ours-invite` 只证明邀请链路不写 console，`export.ts` 只按**键名**过滤 `card`/`payment`，二者都不能证明一次真实的「购买记录 + 设备码」操作之后，日志与导出里没有原文。

---

## 6. 脱敏与迁移的现有测试证据

### 6.1 脱敏：**已有测试**（key / token / 签名 / URL 四类，L0+L1+L2 三层齐）

| 层 | 文件 | 断言（原文摘录） |
| --- | --- | --- |
| L0 | `tests/unit/diagnostics-log-fields.test.mjs`（C 负向用例） | `assert.equal(meta['url.path'], '/v1/messages', '只剩 path（host / query / 签名全丢）')`；`assert.ok(!/https?:\/\//.test(String(meta['url.path'])))`；对 `['apiKey','provider.token','随便一个键','nonsense']` 逐个 `assert.ok(!(key in meta), '不该出现的键必须被丢弃')`；超长值截断到 `META_VALUE_MAX`；`sanitizeMeta` 对 `undefined/null/42/'text'/[]/函数` 一律返回 `{}` 且不抛 |
| L1 | `tests/integration/diagnostics.test.mjs`（[2] 脱敏） | `line1.includes('sk-***') && !line1.includes('abcdefghijklmnop') && line1.includes('Bearer ***')`；`line2.includes('Signature=***') && line2.includes('AccessKeyId=***')`；`line3.includes('token=***')`；`redacted.pathOnly === '/bucket/file.zip' && redacted.relative === '/v1/messages'` |
| L2 | `tests/e2e/diagnostics-upload.test.mjs`（[5]） | `out.includes('sk-***') && out.includes('Bearer ***') && out.includes('Signature=***') && out.includes('AccessKeyId=***')`（真实反馈后端往返后的 log 文本） |
| L0（导出二道） | `tests/unit/feedback-export.test.mjs` | `for (const value of ['abcdefghijklmnop1234567890','BEARER_SECRET','TOKEN_SECRET','SIGNED_SECRET','FRAGMENT','META_SECRET','ERR_SECRET','CHAT_SECRET','PAYMENT_SECRET','BODY_SECRET','RECEIPT_SECRET','CONSOLE_SECRET']) assert.ok(!file.text.includes(value))` |
| L1（导出二道） | `tests/integration/feedback-export.test.mjs` | `assert.ok(!firstText.includes('PRIVATE_TOKEN'))`、`assert.ok(!firstText.includes('PRIVATE_CHAT'))`、`assert.ok(!text.includes('private@example.org'))`（离线 + 失败重试两种导出） |
| L0（错误页复制诊断） | `tests/unit/error-report.test.mjs` | `for (const secret of ['abcdefghijklmnop1234567890','BEARER_SECRET','TOKEN_SECRET','SIGNED_SECRET','AK_SECRET','STACK_SECRET','frag']) assert.ok(!report.includes(secret))`；`assert.ok(report.includes('https://oss.example.com/***'))`（host 保留、path/query 丢）；`scrubReportText` 作为复制时第二道边界另有断言 |
| L1（展示层不重复脱敏也不漏） | `tests/integration/log-viewer.test.mjs` | `assert.ok(copiedSecret.includes('sk-***'), '采集层的 sk- 打码结果应保留')` |
| L0（错误分类文本） | `tests/unit/official-error-classify.test.mjs` | `assert.match(scrubbed, /sk-\*\*\*/)`、`assert.doesNotMatch(scrubbed, /sign=abc/, 'URL query 里的签名不进诊断')` |
| L0（凭据不进 console / 返回值） | `tests/unit/bind-key.test.mjs` | `assert.ok(!line.includes(API_KEY), 'Key 不进日志')`、`assert.ok(!line.includes(DEVICE_ID), '设备码不进日志')` |
| L0（邀请链路静默） | `tests/unit/ours-invite.test.mjs` | `eq(leaked.length, 0, '整条链路一条 console 都没写')`；`eq(DEVICE_ID_STORAGE_KEY, 'chat-demo:ours-device-id', '存储 key 固定（不随渠道切换变化）')` |

**结论**：`sk-` / `Bearer` / `token=` / `Signature=` / `AccessKeyId=` / 完整 URL 的脱敏有 L0+L1+L2 三层硬证据，且导出与错误页各有第二道边界。**device_id 与卡密的「不泄漏」只有键名过滤与 console 静默两条间接证据，缺 payload 级否定断言** → G8-01 保持 P0。

### 6.2 迁移：**已有测试**（L0 6 例 + L1 端到端 1 条，但只覆盖 schema 2 这一次）

| 层 | 文件 | 断言（原文摘录） |
| --- | --- | --- |
| L0 | `tests/unit/config-migration.test.mjs` ① | `assert.equal(store.has('chat-demo:model'), false, '残留键必须被删掉')`；`assert.equal(store.get('chat-demo:config-schema'), '2')`；`assert.equal(cfg.getModel(), 'deepseek-flash')`；`assert.equal(cfg.useApiConfig.getState().model, '', '界面 state 也要同步')`；诊断 `action.fields.result === 'migrated'`、`action.fields.model === RESIDUE`、`Object.keys(action.fields).length >= 2` |
| L0 | 同上 ①（ours 渠道） | 切到 `ours` 时残留同样被清，`cfg.getModel() === 'deepseek-v4.1-flash'`（内置模型） |
| L0 | 同上 ② 幂等 | `assert.equal(second.clearedModel, null)`；`assert.equal(store.get('chat-demo:model'), 'another-old-model', '幂等：版本号到顶后不再清理')`；`assert.equal(globalThis.__log.actions.length, before, '也不该重复写诊断')` |
| L0 | 同上 ③ 老中转 | `assert.equal(store.get('chat-demo:model'), 'legacy-relay-model', '1.2.3 老用户的模型必须留着')`；`assert.equal(store.get('chat-demo:base-url'), RELAY, 'base-url 一律不删')`；`migrated` 诊断 0 条 |
| L0 | 同上 ④/⑤ | 无残留 → 只落版本号、0 条诊断；版本号已 2 → `assert.deepEqual(result, { clearedModel: null, from: 2, to: 2 })` 且 `chat-demo:model` 原样保留 |
| L1 | `tests/integration/legacy-config.test.mjs` | 删掉 `chat-demo:config-schema`、只留 `chat-demo:model = deepseek-v4.1-flash` → reload 后 `schema === '2'`、`chat-demo:model === null`（「升级启动时清掉了残留」）；同一文件另有 1.2.3 老用户无 `provider-kind` 的兼容断言（路径不变、继续用已存的服务地址与模型） |
| L0（读取侧配套） | `tests/unit/provider-deepseek-model.test.mjs` | 共享 `chat-demo:model` 在官方渠道不再作为模型来源；「残留键本身还在（清理由 configMigration 一次性做）」 |

**结论**：迁移**已有测试且质量高**（幂等、老中转不误删、诊断留痕都钉住了），但它是 #339 的**单场景**回归，不是迁移机制的不变量：schema 3 出现时，「只允许删已知废弃键、表外键一个都不动」没有任何断言兜底 → G9-01 保持 P0（配置破坏不可回滚）。

---

## 7. 本域内的重复覆盖观察（供 #362「重复覆盖清单」收口）

| 重复点 | 出现位置 | 建议 |
| --- | --- | --- |
| `sk-***` 打码 | `unit/diagnostics-log-fields`（C）、`integration/diagnostics`（[2]）、`e2e/diagnostics-upload`（[5]）、`integration/log-viewer`、`unit/feedback-export`、`unit/error-report` | 保留 L0 一处（规则本体）+ L2 一处（真实往返）；L1 的逐条正则可只留「采集层接到了 redact」一条，其余交由 L0 |
| 预览条数口径 | `unit/log-viewer`（三个数字一致）+ `integration/log-viewer`（同断言在 DOM 上重跑） | L0 已足够表达口径，L1 只留「弹窗打开时快照=缓冲区前缀」这一条跨层性质 |
| zh/en 成对 | `reading-settings`、`enter-key-mode`、`thinking-display`、`rotate-key`、`payment-trail-ui`、`import-skipped-ui` … 各自一份 | 合并为一条全局键集/占位符对账（G8-08），逐功能只留「文案语义」断言 |
| 迁移「版本号落盘」 | `unit/config-migration` 的 ①②③④⑤ 每例都含 `config-schema` 断言 + `integration/legacy-config` 一次 | 版本号落盘在 L0 保留 1 条即可，其余用例只断言「本次是否动键/写诊断」 |

---

## 8. 拟定新增用例（7 条）与先做减法

### 8.1 拟定用例总表

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点 ID | 覆盖分支数 | 不可合并原因 |
| --- | --- | --- | --- | --- | --- |
| **N1** 敏感字段矩阵：同一张表喂 3 个边界（`redact` / `sanitizeMeta` / `redactExportText`），并断言键名维度整条丢弃 | L0 | ✓ 一张表 × 3 边界 | F8-11 F8-12：**2 条**（导出二道与复制文本是同一张表的附加断言，不新增功能点） | 9 输入 × 3 边界 + 4 键名 = **31** | 唯一能在零浏览器下把 device_id / 卡号 / order_token / 手机号逐项钉死的形态；L1 看不到 meta 与导出文本，L2 只覆盖真实往返一种输入 |
| **N2** 设置项持久化矩阵：`设置项 → 存储键 → 合法值 / 脏值 / 冷启动读回` 一张表跑完全部键 | L0 | ✓ 一行一个设置项 | F9-01 F9-02 F9-03 F9-04（持久化半边）F9-05 F9-06 F9-07 F9-08（渠道选择不持久化契约）F9-13：**9 条** | 14 行 × 3 列（生效 / 脏值回落 / 重载读回）= **42** | 域 9 条目天生多，一项一条会炸；这也是吸收现有 3 处「持久化+脏值」断言的归并容器 |
| **N3** 迁移不变量表：`schema 版本 → 允许删除的键集合`，断言表外键（设置 / 设备码 / `provider-kind` / API Key）一个都不动 + 幂等 | L0 | ✓ 一行一个版本 | F9-11：**1 条** | 6（v1 无残留 / v1 有残留 / v1 老中转在用 / v2 已迁移 / 表外键不动 / 第二次调用不写诊断） | 迁移是唯一会删用户数据的动作，需独立 fake localStorage 与「删了什么」的账本；与 N2 只读语义不同 |
| **N4** 日志自检表：`缓冲区形态 → 三条 warning + 缺失 kind 列表 + 自动补 state_snapshot` | L0 | ✓ 一行一种缓冲区 | F8-06：**1 条** | 5（<10 条 / 无网络 / 跨度<1s / 缺 state_snapshot / 全覆盖无提示） | 纯函数（`analyze` / `validatePayload`），现有断言只在浏览器里；并进 N2 会混淆存储与日志两个模块 |
| **N5** 反馈弹窗负向表：`操作 → 期望提示` 一张表跑完（非图片 / 超大图 / 相册拒绝 / 剪贴板失败 / 空描述导出） | L1 | ✓ 一行一个负向场景 | F8-04 F8-05：**2 条**（F8-01 / F8-08 的入口在同场景被复用，但不计覆盖） | 5 | 需真实文件选择、剪贴板权限与 DOM 提示，L0 表达不了；并进 N6 会共享失败态截图，定位成本高 |
| **N6** 设置重载 + 渠道凭证隔离：seed 一张表 → 一次 reload → 断言主题 / 阅读 `data-*` / 思考折叠 / 回车档 / 渠道 / `base-url:<kind>` 不互串 | L1 | ✓ 一张 seed 表 | F9-01 F9-09 F9-10 F9-13（UI 半边）：**4 条** | 10 | 需要真实 dist + reload 才能证明「UI 真的消费了这些键」；N2 只证明模块读回，证不到界面 |
| **N7** 删除所有对话 / 清站点数据后的保留口径 | L1 | ✗（单一破坏性场景） | F9-12：**1 条** | 2 | 破坏性动作必须与其它断言隔离，否则同场景数据被清会让别的断言连带失真 |
| **X1**（非用例）扩展 `check:log-coverage` 增 R4：调用点 meta 键 ⊆ `META_KEYS ∪ EXTRA_KEYS` | 门禁 | ✓ 静态扫描 | F8-13：**1 条** | 全部调用点 | 静态扫描，用例层表达不了；0 新增测试文件 |
| **X2**（非用例）`check:log-coverage` 接进 `.github/workflows/ci.yml` | 配置 | — | F8-15 | — | 0 用例 |
| **X3**（非用例）L3 按需复核：`p4-layout.mjs` + `docs/ui/190-backup-row/measure.mjs` | L3 | — | F8-09 F9-14 | — | 需 AVD/真机，不进 CI |

**合计：新增测试用例 7 条**（N1–N7）。覆盖账：N1–N7 直接覆盖 **18** 个功能点；X1–X3（0 用例）再覆盖 **4** 个（F8-13 / F8-15 / F8-09 真机半边 / F9-14）；余下 **7** 个（F8-01 / F8-02 / F8-03 / F8-07 / F8-08 / F8-10 / F8-14）已由现有 L0–L2 用例覆盖。域 8+9 共 **29** 个功能点全部有断言落点。红线 6–8 条，符合。

### 8.2 N1 敏感字段矩阵（表内容，实施时直接照抄）

| # | 输入（值） | `redact()` / `sanitizeMeta()` 期望 | `redactExportText()` 期望 | 现状 | 覆盖 |
| --- | --- | --- | --- | --- | --- |
| 1 | `sk-abcdefghijklmnopqrstuvwxyz012345` | `sk-***` | `[API_KEY]` | ✅ 通过 | F8-11 |
| 2 | `Authorization: Bearer abc.def.ghi` | `Bearer ***` | `Bearer [REDACTED]` | ✅ 通过 | F8-11 |
| 3 | `?token=SECRET&y=2` / `access_token=ERR` | `token=***` | `$1[REDACTED]` | ✅ 通过 | F8-11 |
| 4 | `?Signature=S&AccessKeyId=A` | `Signature=***` / `AccessKeyId=***` | `[QUERY_REDACTED]` / `[REDACTED]` | ✅ 通过 | F8-11 |
| 5 | 完整 URL（带 path+query+fragment） | 只剩 path | `scheme://host/path` | ✅ 通过 | F8-11 |
| 6 | **device_id**（`d-` + 32 hex） | **期望 `[DEVICE_ID]` 或只留尾 4 位** | 同上 | ❌ **会红**（`SECRET_SEGMENTS` 不含 `deviceid`） | F8-12 |
| 7 | **卡号**（`MUSE-3CYP-5NA3-AHSE-A3SR` / 16 位数字） | **期望只留尾 4 位** | 期望 `[CARD]` | ❌ **会红**（`redact` 无卡号规则；导出只按键名 `card` 过滤） | F8-12 |
| 8 | **order_token / out_trade_no** | 期望 redact | ✅（键名命中 `token`/`order`） | ⚠️ 值内出现时无规则 | F8-12 |
| 9 | **手机号**（11 位大陆号） | **期望只留尾 4 位** | 期望 `[PHONE]` | ❌ **会红** | F8-12 |
| 键 | **键名维度**：`deviceId` / `cardNo` / `orderToken` / `phone` | **期望整条丢弃**（同 `apiKey` / `token`） | 期望被 `PRIVATE_KEY` 拦掉 | ❌ **会红**（`deviceId` / `cardNo` / `phone` 不在 `SECRET_SEGMENTS`） | F8-12 |

> 这张表的价值就是把 G8-01 从「没人知道会不会漏」变成「9 行里 5 行是红的，先修规则再转绿」。规则可复用 `src/services/ours/mask.ts` 的 `maskCard()`（尾 4 位）与 `device.ts` 的「只用尾 4 位」约定。

### 8.3 N2 设置项持久化矩阵（行清单）

| 设置项 | 存储键 | 合法值（生效） | 脏值（期望回落） | 重载后 |
| --- | --- | --- | --- | --- |
| 主题 | `chat-demo:theme-preference` | `light` / `dark` / `system` | 任意其它 → `system` | 保持 |
| 语言 | `chat-demo:locale` | `zh-CN` / `en-US` | 任意其它 → 按 `navigator.language` | 保持 |
| 位置 | `chat-demo:location` | 合法 JSON | 坏 JSON / 形状不对 → `null` | 保持 |
| TTS 音色 | `chat-demo:tts-voice` | `stella` / `tide` | 其它 → `stella` | 保持 |
| 模式 | `chat-demo:chat-mode` + 兼容 `chat-demo:thinking` | `fast` / `expert` | 其它 → `thinking === 'true'` 兜底再 `fast` | 保持 |
| 思考显示 | `chat-demo:thinking-display` | `collapsed` / `expanded` / `hidden` | 其它 → `collapsed` | 保持 |
| 字号 | `chat-demo:reading-font-size` | `small` / `standard` / `large` / `xlarge` | 其它 → `standard` | 保持 |
| 字重 | `chat-demo:reading-font-weight` | `regular` / `medium` / `bold` | 其它 → `regular` | 保持 |
| 行距 | `chat-demo:reading-line-height` | `compact` / `standard` / `relaxed` | 其它 → `standard` | 保持 |
| 回车行为 | `chat-demo:enter-key-mode` | `enter-send` / `modifier-send` / `button-only` | 其它 → `enter-send` | 保持 |
| 智能搜索 | `chat-demo:search` | `'true'` / `'false'` | 其它 → `false` | 保持 |
| 侧边栏 | `chat-demo:sider-collapsed` | `'true'` / `'false'` | 其它 → `false` | 保持 |
| 更新渠道 | **无键**（`AppUpdateField` 的 `useState`，由版本号含 `-` 推断） | — | — | **重启回推断值**：本行断言的是「契约」，不是持久化 |
| 渠道 | `chat-demo:provider-kind` | `deepseek` / `anthropic` / `openai` / `ours` | 其它 → 构建默认 | 保持 |

### 8.4 先做减法：现有用例的合并 / 删除清单

| 现有用例（文件 :: 用例） | 动作 | 理由 | 削减 |
| --- | --- | --- | --- |
| `unit/reading-settings` :: `B 三项可改动 + 跨重启持久化 + 脏值回落` | **删**，并入 N2 | 与 N2 同逻辑、同断言目标（存储键 + 回落） | −1 |
| `unit/enter-key-mode` :: `B 三档持久化 + 脏值回落` | **删**，并入 N2（保留 C 三档语义 / D IME / E enterKeyHint / F i18n） | 同上 | −1 |
| `unit/thinking-display` :: `A` 里的「冷启动读回 / 脏值」段 | **删该段**，并入 N2（保留默认值 collapsed 与 B–G） | 同上 | −1 |
| `unit/log-viewer` :: 单条复制 4 条负向（换行 / 超长 meta / 非法时间 / 无 meta） | **合并为 1 条表驱动** | 同一函数 4 个输入 | −3 |
| `unit/diagnostics-log-fields` :: `C` 里的脱敏子断言（URL / 密钥键） | **收敛为 1 条「与 redact 同源」**，细目交 N1 | 与 N1 重复 | −1 |
| `unit/feedback-export` :: 12 个 secret 串的逐个断言 | 保留用例，**断言收敛为「导出文本里不存在 N1 表中的任一敏感值」** | 与 N1 重复维护两份清单 | −1（断言级） |
| `unit/error-report` :: secret 列表 7 项 | 同上，收敛为对 `scrubReportText` 边界的引用 | 与 N1 重复 | −1（断言级） |
| `integration/log-viewer` :: 复制内容含 `sk-***` | **删** | 打码值由 N1 钉住，展示层不必再证 | −1 |
| `unit/config-migration` :: 6 例 | **合并为 N3 的表驱动 + 保留 1 条「① 完整链路含诊断留痕」** | 六例共享同一 fake 存储与断言形状 | −4 |
| 各功能文件的「zh/en 成对」断言（`reading-settings` F / `enter-key-mode` F / `thinking-display` F / `rotate-key` 8c / `payment-trail-ui` / `import-skipped-ui` …） | **合并为 1 条全局键集 + 占位符对账**（可放 L0 或门禁） | 同一逻辑被 5+ 个文件重复 | −5（跨域收益） |

**削减合计 ≈ 19 条**（其中跨域 i18n 键集约 5 条）。与新增 7 条相抵，**域 8+9 的净变化 ≈ −12 条用例**；同时把 5 个零断言功能点（F8-12、F9-01、F9-06、F9-07、F9-12）全部纳入断言范围——即「用例更少、覆盖更全」。
（落地进度，2026-11-20：F8-12 的 N1 与 F9-12 的 N7 已落地并有破坏变红证据；F9-01 / F9-06 / F9-07 见 `docs/testing/coverage/feature-coverage.md` 的域 9 行。）

### 8.5 不新增自动化的三条（明账）

| 项 | 为什么不新增用例 |
| --- | --- |
| F8-09 反馈弹窗滚动 / F9-14 设置窄屏布局的真机半边 | 需要 AVD/真机；现有 `p4-layout.mjs` 已能给出越界清单，按 UI 改动触发复核即可 |
| F8-15 门禁接线 | 配置一行，无断言可写 |
| F9-08 更新渠道「不持久化」 | 用 N2 的一行 + 一处文档契约代替（若要真持久化，属于产品改动而非测试缺口） |

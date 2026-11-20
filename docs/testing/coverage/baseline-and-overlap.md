# 测试耗时基线 & 重复覆盖清单（Issue #362 横向交付物）

- 采集基线：`origin/main` @ `f182748`（`feat(chat): 分阶段等待提示…（#328）(#361)`）
- 采集环境：`/root/worktrees/deepseek-internal-beta10`，Node `v24.22.0`，pnpm `11.24.0`，`LANG=zh_CN.UTF-8`
- 采集方式：**全部实测**，无估算。单次命令一律 `timeout` 保护；单文件 >180s 记为「超时/需环境」并跳过。
- 约束遵守：未改任何测试文件、未改源码、未启动 AVD/模拟器（`tests/device/*` 未执行）。

> 口径更正：本单下发的任务书写「112 个 L0 用例」，以实测为准是 **121 个 L0 文件 / 926 个用例**
> （107 个 `node:test` 文件共 863 条 `ℹ tests`，14 个自执行脚本共 63 个 `[n]` 分节）。
> 下文所有比例都按 **926** 计算分母。

---

## ① 耗时基线

### 1.1 命令与准备（实测耗时）

```bash
export PATH="/opt/node24/bin:$PATH"; export LANG=zh_CN.UTF-8
git checkout origin/main                    # 工作区干净，f182748
pnpm install --frozen-lockfile              # 0.65s（node_modules 已就绪）
pnpm build:internal                         # 3.4s，dist/ variant=internal
DIST_OUT=dist-standard pnpm build           # 4.7s，集成层要的标准产物（gitignore 内）
node tests/run-layer.mjs unit --json …      # L0 全量，见下
node tests/run-layer.mjs integration --case tests/integration/<x>.test.mjs   # L1 抽样
```

### 1.2 L0（单元层）总账

| 项 | 实测值 |
| --- | --- |
| 文件数 | **121**（`tests/unit/*.test.mjs`） |
| 用例数 | **926**（863 条 `node:test` 用例 + 63 个自执行脚本分节） |
| 第 1 次全量耗时 | **68.0s**（`elapsed 67998ms`，整条命令 wall 1m8.1s） |
| 第 2 次全量耗时 | **63.9s**（`elapsed 63944ms`，wall 1m4.0s） |
| 结果 | 121 PASS / 0 FAIL / 0 SKIP(env) / 0 NODE-SKIP（两次一致） |
| 平均单文件 | 561ms（其中约 86ms 是 Node 进程启动固定开销，121 个进程合计 **≈10.4s**） |
| 子进程内实际执行时长合计 | 57.6s（`ℹ duration_ms` 求和），剩余是 runner 的 spawn/回收开销 |

时间分布是**长尾**：13 个 ≥1s 的文件吃掉 **34.1s（50%）**；另有 23 个 <200ms 的文件合计仅 3.7s。

### 1.3 L0 最慢文件 Top 10（按耗时倒序，第 2 列是复跑复核）

| # | 文件 | 第 1 次 | 第 2 次 | 文件内用例 | 为什么慢 |
| --- | --- | --- | --- | --- | --- |
| 1 | `legacy-bundle-target.test.mjs` | **7496ms** | 6290ms | 7 | 把 `tests/helpers/runtime.mjs` 拷进临时目录另开进程跑沙箱；E-1/E-2 扫全量 dist 每个 JS 文件 |
| 2 | `chat-context-budget-long-session.test.mjs` | **5318ms** | 4686ms | 4 | 长会话预算：造大上下文 + 逐轮判定，纯计算量 |
| 3 | `test-runtime.test.mjs` | **3313ms** | 3291ms | 8 | 测 runner 自己：反复 spawn 子进程验证超时/信号/清理 |
| 4 | `check-capabilities.test.mjs` | **3207ms** | 3180ms | 11 | 扫 `android/` + `src/` 全仓能力盘点 |
| 5 | `openai-adapter.test.mjs` | **3142ms** | 3136ms | 2（自执行） | 大量真实 fetch 解析断言，单文件 106 条 `ok` |
| 6 | `stream-idle-timeout.test.mjs` | **2199ms** | 2134ms | 4 | 真实定时器等待空闲超时窗口 |
| 7 | `import-error-copy.test.mjs` | **2084ms** | 2072ms | 6 | 起本地桩服务跑四档网络错误 |
| 8 | `url-import-stall.test.mjs` | **1807ms** | 1695ms | 12 | 停滞/续传/取消，多个真实时间窗（300ms/600ms 级） |
| 9 | `import-budget-vs-stall.test.mjs` | **1190ms** | 1192ms | 4 | 预算 vs 停滞两档的时间推演 |
| 10 | `import-network-classification.test.mjs` | **1179ms** | 1159ms | 4 | 与 #7 同一套桩（重复搭台，见 §2） |

Top10 合计 **30.9s = L0 全量的 45.5%**。

### 1.4 L1（集成层）抽样实测

集成层 35 个文件、12 406 行，全部是「自执行脚本 + Playwright/Chromium + 本地静态服务」，
单文件都要起一次浏览器。按任务要求只抽 5 个代表性文件（每个都用 runner 注入产物服务，串行跑）：

| 文件 | 类型 | 实测耗时 | 结果 | 用例/检查项 |
| --- | --- | --- | --- | --- |
| `caps.test.mjs` | runner 注入共享标准产物（APP_URL） | **3.5s** | PASS | 4 |
| `request-body.test.mjs` | 同上 | **6.9s** | PASS | 9 |
| `url-import-web.test.mjs` | 同上 | **2.6s** | PASS | 3 |
| `feedback-export.test.mjs` | 自起服务（标准产物） | **2.0s** | PASS | 1 场景 |
| `provider-channels.test.mjs` | 自起服务（标准产物） | **39.3s** | **FAIL** | 26（跑到 [4] 崩） |

- `provider-channels` 的 39.3s **里 30s 是一次 locator 超时**：见 §3.4，属测试选择器脆性，不是产品慢。
  修好选择器后该文件正常应在 9s 量级。
- 未跑的一类（需环境/重型）：`apps` 之外的 `tests/device/*`（需 AVD，本单禁止）、
  `copy-limit`（自建 `dist-copy-limit`，注释自述 512 KiB 文本首渲染在本机 92~96s）、
  `feedback-scroll`（要 `dist-scroll` 专用产物）、`full-acceptance`（888 行，全链路）、
  `motion`（848 行，逐帧断言）。这些一律记为**「未实测 / 需产物或环境」**，不塞进预算对比。

### 1.5 各层真实耗时 vs Issue #362 预算

| 层 | Issue 预算 | 实测 | 结论 |
| --- | --- | --- | --- |
| **L0 全量** | **<30s** | **68.0s / 63.9s**（926 用例，121 进程） | ❌ **超预算 2.1~2.3 倍**；连 `docs/TESTING-POLICY.md` 自己写的「L0 目标 <60s」也已破 |
| **L1 单文件** | <90s | 抽样 2.0 / 2.6 / 3.5 / 6.9 / 39.3s | ✅ 达标（最慢的那次红，其中 30s 是超时重试） |
| **L2 单场景** | <60s | 未测（`tests/e2e` 仅 2 个文件，需真实 DOM 全链路；CI 与 release 都不跑） | ⏸ 未实测 |
| L3 设备 | 手动/按需 | 未执行（禁止开 AVD） | ⏸ |

**L0 超预算的构成**（可据此做减法）：进程启动 10.4s（121×86ms，无法靠删用例省，只能合并文件）+
13 个 ≥1s 文件 34.1s + 其余 108 个文件约 24s。要回到 <30s，必须把「≥1s 文件」降到 3~4 个或合并进程。

---

## ② 重复覆盖识别与删除/合并清单

判定口径：**同一逻辑被两处断言 = 一处零边际**。删除建议一律落在**重复的那一侧**（保留层给理由），
并附**风险判断**（删掉会不会降低保护）。

### 2.1 跨层重复（L1 在重复测 L0 已覆盖的纯逻辑）—— 最典型浪费

| # | 主题 | L0 位置（保留） | L1 位置（重复） | 重复的断言内容 | 建议 | 削减 | 风险判断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | 复制 512 KiB 阈值按 UTF-8 字节判定 | `tests/unit/copy-limit.test.mjs:51-80`（`[1]`-`[4]`：1/3/4 字节、正好 512KiB、+1 字节超限、586 KiB 向上取整） | `tests/integration/copy-limit.test.mjs:254-308`（`[2]` emoji 560000 字节 → 547 KiB、`[3]` 精确 524288 字节边界） | 「按字节不是按字符」「边界正好/多 1 字节」的同一批常量与同一函数 `exceedsCopyLimit` | 删 L1 `[2]`、`[3c]`；L1 只留 `[1]` 超限弹窗链路 + `[3a]` 剪贴板确实被写入 + `[4][5]` 保存成功/失败 | **2** | 低。判定是纯函数，L0 已钉死边界；L1 保留一次真实剪贴板写入，仍能发现「超限不弹窗」类回归 |
| D2 | #234 邀请奖励文案五档 | `tests/unit/issue-234-invite-copy.test.mjs:88-230`（`[1]`-`[6]`） | `tests/integration/issue-234-invite-copy.test.mjs:216-270`（`[1]`-`[5]` 同主题同口径） | 「被邀请人 0 分不显示积分」「邀请人 +100 逐字不变」「invite_rules 缺失不写死金额」「409 circular_invite 专属文案」 | 删 L1 `[2][3][5]`；L1 只留 `[1]`（0 分渲染到 DOM）+ `[4]`（整行隐藏，UI 可见性 L0 测不到） | **3** | 中低。文案字符串本身 L0 已逐字锁死；L1 的价值在「字符串真的进 DOM」，留 1 条足够。`[4]` 必须留（条件渲染只有真 DOM 能验） |
| D3 | 反馈导出：二次脱敏 / local-only / 不含表单原文 | `tests/unit/feedback-export.test.mjs:21-59`（6 条断言：脱敏、4MiB 上限、省略标记、UTF-8 边界） | `tests/integration/feedback-export.test.mjs:64-86`（`!includes('PRIVATE_TOKEN')`、`!includes('PRIVATE_CHAT')`、`!includes(表单文本)`、`delivery === 'local-only-not-submitted'`） | 同一份 redaction 规则与同一份「本地不提交」语义 | 删 L1 的 4 条重复断言，保留 `lastSubmissionFailure.code === 'network'` + 下载文件名带版本号；并把 `no feedback-accepted 事件` 降为 1 条 | **2** | 低。脱敏规则在 L0 用真实 export 源码 + 注入 mock 测过；L1 只剩「下载文件真的产出」这一条独有价值 |
| D4 | 反馈草稿状态机（取消保留 / 提交后作废 / 空草稿等于没有） | `tests/unit/feedback-draft.test.mjs:39-90`（8 条） | `tests/integration/feedback-draft.test.mjs:105-160`（重开回填、提交后空表单） | 「取消不丢草稿」「送达后草稿作废」「空内容不留壳」 | 删 L1 中「提交成功后重开为空」「首次打开无旧草稿」两条；保留「主动清空有二次确认」与 390/360 双档截图 | **2** | 低。草稿模块是纯内存 store，L0 全覆盖；L1 独有价值是二次确认弹窗的交互 |
| D5 | 日志查看器：过滤 / 搜索 / 分组 / 单条复制文本 | `tests/unit/log-viewer.test.mjs:39-205`（15 条，测的就是 `src/components/settings/logView.ts` 生产代码） | `tests/integration/log-viewer.test.mjs:214-340`（约 30 条：`rowCount` 精确条数、搜索命中、kind/level 交集、分组数、复制首行格式） | 同一模块的同一批函数：`filterLogs` / `groupLogs` / `formatLogLine`；连「显示最近 N 条，共 M 条，提交上限 500 条」口径都两边各算一遍 | 删 L1 `:246-294`（搜索/过滤/空态条数）与 `:309-316`（分组归属）、`:332-334`（复制文本首行格式）；L1 只保留「行不溢出（`overflow`/`wideRows`）」「分组开关可点」「需脱敏 URL 原样显示打码结果」 | **8** | 中。删掉的是**纯逻辑的重复验证**；L1 独有且必须留的是布局不撑破、真实点击绑定、快照前缀口径。若担心 `logView.ts` 与组件接线漂移，用 1 条「筛 error 后行数 = 预期」作冒烟即可 |
| D6 | 额度不足分类（402 / 429+`insufficient_quota` / 400+code / 流内 error 帧） | `tests/unit/quota-exhausted.test.mjs:216-272`（`classifyApiError` + `isRetryableApiError` 表驱动） | `tests/integration/quota-exhausted.test.mjs:172-296`（`[1]` 402、`[2]` 429、`[3a]` 502、`[3b]` 400） | 同样的「哪档归额度、哪档不算」判定，只是穿过 UI 再看一遍文案 | 删 L1 `[2]`、`[3a]`、`[3b]`；L1 只留 `[1]`（一条端到端文案 + 充值动作）与 `[4]`（额度正常时不误报） | **3** | 低。分类逻辑 L0 已有正向/负向/流内帧全覆盖；L1 留 1 正 1 负即可守住「界面没说错话」 |
| D7 | 链接导入：停滞/超时/Range 连续性/断流 分类 | `tests/unit/url-import-stall.test.mjs:260-629`（12 条）、`tests/unit/url-import-content-range.test.mjs`（272 行） | `tests/integration/url-import-stages.test.mjs:408-419`（用例 4 超时带百分比）、`:566-611`（用例 12 Range 忽略、用例 13 Range 连续）、`:618-642`（用例 14 416）、`:386-407`（用例 3b 断流） | 「预算耗尽判超时不是停滞」「服务端忽略 Range 只消费一次」「Range 无重叠无空洞」「断流 ≠ 断网」 | 删 L1 用例 12、13、14、3b；保留用例 1（阶段进度）、4（带百分比超时文案）、9/10（取消）、11（360dp 布局）、17/18（详情复制脱敏） | **5** | 中。Range 连续性与 416 已在 L0 用真实 mock 字节流验证；L1 留「阶段进度 + 取消 + 布局」这些只有浏览器才暴露的部分。若 L0 将来删掉 content-range 文件，这 3 条要回补 |
| D8 | 诊断：环形缓冲 500 / 脱敏 / msg 截断 2000 | `tests/unit/diagnostics-log-fields.test.mjs:109-199`（B 取值收紧、C 超长/带密钥 URL、截断丢弃） | `tests/integration/diagnostics.test.mjs:203-260`（`[1]` 塞 600 留 500、`[2]` sk-/Bearer/Signature 打码、`[3]` 5000→2000 截断） | 同一份字段契约与截断/打码规则 | 删 L1 `[2]`、`[3]`；`[1]` 只保留「刷新后仍在（IndexedDB 落盘）」一句 | **3** | 低。脱敏/截断是纯函数契约，L0 已逐字段测；L1 独有只有「跨刷新持久化」和「真实 Capacitor/fetch 拦截」 |
| D9 | 自动标题：脏输出清洗 / 失败回退 | `tests/unit/auto-title-prompt-i18n.test.mjs:120-130`（`sanitizeTitle` 逐例）、`tests/unit/auto-title-stream.test.mjs:210-230`（流内错误帧回退）、`auto-title-backpressure.test.mjs:164-196`（429/取消回退） | `tests/integration/auto-title.test.mjs:466-512`（`[3]` 500 回退、`[4]` 空串回退、`[5]` 脏输出只取标题、`[6]` finish 异常回退） | 「Markdown 星号被剥掉」「异常 finish 视为失败」「空串回退本地截取」 | 删 L1 `[3][4][5][6]`；L1 只留 `[1][2][7][8][10]`（成功+请求形状、超时 8s、改名不覆盖、官方模式零影响、协议分流） | **4** | 中低。清洗与回退是纯函数分支；但 `[2]` 8s 超时是**真实时间窗**，必须留在 L1（L0 用假定时器测过，真时钟行为只有 L1 能验） |
| D10 | 领取 `/apply` 幂等重放 | `tests/unit/invite-261-fp-already-claimed.test.mjs:167-173`（同 `device_id` 重放不带 `already_claimed`） | `tests/integration/ours-services.test.mjs:434-439`（点两次领取，断言 `calls.apply === 1`） | 「重放不重复发放、不误报已领取」 | 二选一：保留 L0 的解析口径，L1 只留 `calls.apply === 1` 的**点击级**断言（删掉文案/字段重算部分） | **1** | 低。幂等判定在 store 层，L0 覆盖；L1 留一条点击级断言即够 |

跨层小计：**可削减 33 个 L1 检查项/用例**，L0 不动。

### 2.2 层内重复（L0 内部同一逻辑测两遍）——这是「零边际覆盖」的正主

| # | 主题 | 位置 A | 位置 B（重复） | 重复内容 | 建议 | 削减 | 风险判断 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | 首字等待提示 5s/30s/60s 三档 + 60s 才给出口 | `tests/unit/chat-wait-stage.test.mjs:207-233`（`composeWaitNotice` 表驱动 + 阶段回落）、`:277`（store 三档升级） | `tests/unit/chat-wait-notice.test.mjs:25-39`（5s 不打扰 / 逐级升级 / 60s 出口）、`:48`（中英文案）、`:61`（定时器清单） | **完全同一批三档判定**：`chat-wait-stage` 的 `waitDeadlines` 就是 `startedAt + 既有三档`，等于把 notice 的分档又验了一遍 | 删 `chat-wait-notice.test.mjs:25-39` 三条（分档/出口），把 `:48` 文案 key 断言并进 stage 的 `:174` 表驱动；`chat-wait-notice` 只留 `:70` 挂载点契约（或直接整文件并入 `chat-wait-stage`） | **3~5** | 低。stage 文件（#328）已把三档做成表驱动并显式复用 notice 的常量与函数；两份文件同时存在只会在改档位时**两处一起红**，不增加保护。挂载点契约两边都有（notice:70 / stage:424），留一份 |
| E2 | 链接导入错误四档分类 + 文案互不相同 + en 无中文 | `tests/unit/import-error-copy.test.mjs:143-199`（`②`-`⑥`，含「四档文案互不相同」「en 字典无中文」「纯函数分类」） | `tests/unit/import-network-classification.test.mjs:134-199`（`①`-`④`）、`tests/unit/import-unreachable-copy.test.mjs:122-190`（`#18` 三档 + en 字典 + 端到端三档） | 「offline / unreachable / refused / server 四档互不覆盖」「en 下不出现中文」「按 `navigator.onLine` 分档」——三个文件各写一遍 | 合并为 **1 个表驱动文件**（四档 × zh/en × 分类/文案/可重试 一张表）；删掉另外两份里重复的「互不相同 / en 无中文 / 纯函数分类」断言，只保留各自独有的端到端桩（各 1 条） | **3** | 低。三份文件的 setup（各 40+ 行 resolve hook + 桩服务）也一起省掉；断言矩阵不变，只是从三处散落变一处表驱动，改档位时不会再漏改。若担心合并后单文件过长，可保留 E2 的三个文件但把公共矩阵抽到 `tests/helpers/` |
| E3 | 下载「预算耗尽 vs 真停滞」两档判定 | `tests/unit/import-budget-vs-stall.test.mjs:151-204`（`①` 预算先耗尽 → 超时、`②` 零字节增长 → 停滞） | `tests/unit/url-import-stall.test.mjs:434-456`（「防御性总上限：字节一直在增长但超过上限 → 判下载超时，不是 stalled」）、`:289-357`（真停滞） | 同一对判定的正反两面，两个文件各测一遍 | 删 `url-import-stall.test.mjs:434-456` 一条（保留 budget 文件的 `③` 文案差异 + `④` 常量推导） | **2** | 低。`import-budget-vs-stall` 已把两档 + 文案 + 常量来源全覆盖；url-import-stall 里这条是它的超集重复。**但** `url-import-stall:289` 的真停滞带「已下载/总数」文案占位符，属文案级，保留 |

层内小计：**可削减 8~10 个 L0 用例**。

### 2.3 结构重复（不省用例数，但省维护与耗时）

1. **121 个 L0 文件里 90 个各自重写同一套 `.js→.ts` resolve hook / 动态 import 装配**（`grep -l 'resolveSync\|register('` = 90）。
   抽取到 `tests/helpers/` 可省下 90 × ≈35 行 ≈ **3000 行样板**，且不影响任何断言。
2. **每个文件一个 Node 进程**：121 次冷启动 ≈ **10.4s**（占 L0 的 15%）。把同域的 3~5 个文件并成一个进程
   （`node --test tests/unit/<dir>`）能直接吃掉这部分，是把 L0 拉回 30s 以内最省力的一刀。
3. **导入域 13 个文件 4000+ 行**（`import-*` / `url-import-*`）测的是同一个 `urlImport.ts`；
   合并成 2~3 个文件（分类矩阵 / 传输与续传 / 归档解析）即可，断言总数不变。

### 2.4 汇总：零边际覆盖数量

| 口径 | 数量 | 占 L0 926 用例 |
| --- | --- | --- |
| **严格层内零边际**（删掉不损失任何保护，§2.2） | **8~10** | **0.9%~1.1%**（占 L0 926 用例） |
| 结构重复可省的样板行 | ≈3000 行 | —（不涉用例） |
| **L1 侧可删的重复检查项**（§2.1） | **33** | L1 全层实测共 **533 条断言**（`check/assert/ok/eq` 行计数），**可削 6.2%** |
| **合计可安全削减** | **41~43 个用例/检查项** | 两层合计 926 + 533 = **1459**，**可削 2.8%~2.9%** |

> 结论比预期「温和」：**重复断言不是最大的浪费**（L0 里只有 1% 是零边际）。
> 真正的大头是**结构**：每文件一进程的 10.4s、90 份重写的装配样板、以及 §3 的「L1 根本没人跑」。

---

## ③ 补充核对：CI 只跑 L0，L1/L2 事实上不执行

维护者问的这件事，实测确认属实，而且比「重复」更值得先处理：

| 事实 | 证据 |
| --- | --- |
| CI 只跑 unit | `.github/workflows/ci.yml:59-64`：`Unit tests → pnpm test`（= `node tests/run-layer.mjs unit`），其后只有构建 + `check:*` 静态门禁，**无 `pnpm test:integration`** |
| release 流水线也不跑 | `.github/workflows/release.yml` 全文无 `test:integration` / `run-layer` 字样 |
| 唯一的执行路径是人手敲 | `tests/which.mjs` 会打印「建议命令」，`docs/TESTING-POLICY.md` §3 要求「按输出的建议命令串行执行」——没有强制执行点 |
| 基线已经腐烂 | `tests/integration-baseline.json` 里 `provider-channels.test.mjs: expected=pass`，但本单在 `origin/main@f182748` 上实测 **FAIL**（§3.4），却没人发现 → 说明 L1 长期未被执行 |
| 维护成本却是真的 | 12 406 行 / 35 文件，近 60 天 **9 次**提交改到 `tests/integration/`（同期 `tests/unit/` 47 次）；每次全量 9~15 分钟（`TESTING-POLICY` §1 自述），且要 2 份产物（`dist-standard` + internal） |

### 3.4 实测到的具体红（供维护者派单，本单不改）

`tests/integration/provider-channels.test.mjs:160` 用
`getByRole('button', { name: /渠道|Channel/ }).first()` 找渠道切换按钮。
`src/i18n/zh.ts:269` 新增的「附件入口不可用」按钮其 `aria-label="当前渠道不支持文件上传，附件入口已不可用"`
**含「渠道」二字**，且 DOM 顺序在前，于是 `.first()` 命中了这个 `aria-disabled="true"` 的按钮 →
`locator.click` 重试 30s 后抛 `Timeout 30000ms exceeded`。

- 影响：一个文件白烧 30s，且基线判 `pass` → 只要是「人手跑一次」就会看到红，但没人跑。
- 建议（不在本单执行）：选择器改用稳定的 `data-testid` 或精确 `aria-label` 锚点；顺带给
  integration 一条「不新增失败」的 CI 触发点（哪怕只在 nightly 或 release 前置）。

### 3.5 L1/L2 的存在价值 vs 维护成本（结论）

- **值得留的**（L0 物理上测不到）：真 DOM 布局不撑破 / 溢出、真实定时器时间窗（8s 超时、取消即刻恢复）、
  产物变体守卫（`build-info.json` variant）、跨刷新持久化（IndexedDB）、原生桥 mock（Capacitor/Range 分块）、
  双视口截图回归（360/390）、`dist` 层面的注入（`__ENDPOINTS__`）。
- **不值得按现状留的**：把 L0 的纯逻辑分支再验一遍的那部分（§2.1，33 项）。
- **成本问题不在写得差，而在「写了但不跑」**：12 406 行 L1 代码 + 9~15 分钟人工成本，
  却没有任何自动触发点，等于**用维护成本买了一个不会自动兑现的保险**。
  要么给 L1 一个自动触发点（nightly / release 前置 / 改动域子集），要么按 §2.1 削掉它的逻辑重复部分，
  让它值得被跑。这两件事都比继续加用例更急。

---

## ④ 一句话结论

**当前测试套件的最大效率问题不是「重复断言」（L0 内真正零边际的只有约 1%），而是结构错配：
121 个 L0 文件各起一个 Node 进程（10.4s 固定开销）+ 90 份重写的装配样板把 L0 拖到 68s（预算 30s），
而 12 406 行、9~15 分钟的 L1 集成层在 CI 与 release 里都没有触发点、事实上无人执行（基线里
`provider-channels` 已红却没人知道）——慢的那层天天跑却超预算，贵的那层从不跑却还在长。**

---

## 附：复现命令

```bash
export PATH="/opt/node24/bin:$PATH"; export LANG=zh_CN.UTF-8
cd /root/worktrees/deepseek-internal-beta10
git checkout origin/main && pnpm install --frozen-lockfile
pnpm build:internal                        # 3.4s
DIST_OUT=dist-standard pnpm build          # 4.7s（L1 需要标准产物）

# L0 全量（实测 68.0s / 63.9s，121 文件 926 用例）
node tests/run-layer.mjs unit --json /tmp/unit.json

# L1 抽样（每个 <90s，串行）
node tests/run-layer.mjs integration --case tests/integration/provider-channels.test.mjs
node tests/run-layer.mjs integration --case tests/integration/request-body.test.mjs

# 单文件计时（本单 Top10 用，超 180s 跳过）
for f in tests/unit/*.test.mjs; do
  /usr/bin/time -f "%e $f" timeout 180 node --experimental-transform-types --test \
    --import ./tests/helpers/injected.mjs "$f" >/dev/null 2>>/tmp/unit-times.txt
done
```

# 全量验证报告：main@`7d5c3eb`（2026-11-20，阶段② 验证）

> **结论先写**：**全绿，新增红 0 条。**
> 六个可执行层（类型/静态、unit、regression、server、golden、integration）全部 PASS；
> 集成层 45 个文件 **0 FAIL / 0 SKIP**，相对 `integration-baseline.json` 无新增失败，
> baseline 里 **known-red 剩 0 条**（38 条全部 expected=pass）。
> 31 道 `check-*.mjs` 里 3 道非 0：2 道**跑不起来**（缺本机文件 / 缺 apk 参数，`exit 2`，等于零覆盖，
> 非产品红）+ 1 道**设计性红**（`check-refactor-direction`，A1/A4/A6 未收口，`exit 1`，CI 明确推迟接线）。
> 本地串行总耗时 **≈20 分 50 秒**；同 commit 的 CI 并行墙钟 **4 分 31 秒**（runner 分钟 24 分 06 秒）。

## 1. 环境与复现

| 项 | 值 |
| --- | --- |
| 代码 | `origin/main` @ `7d5c3eb646d6af04b9474b2b049f0ea6d73a6ccd`（干净 worktree，`git status` 除测试产物截图外无改动） |
| 命令前置 | `export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 ANDROID_HOME=/root/android-sdk` |
| Node / pnpm | `v24.22.0` / `11.24.0`（CI 用 Node 22，见 §5 的差异说明） |
| 机器 | 4 核 / 15.8 GB，负载档 `normal`，runner 身份 `local:zzy-EQ.localdomain#normal` |
| 登录接缝 | 集成层与黄金层**必须** `TEST_AUTH_SEAM=1` 构建（否则 `AuthGate` 拦在登录页 → 整批假红，#547 记录过这个坑） |
| 产物 | `dist/`=internal、`dist-standard/`、`dist-scroll/`（均带接缝）；门禁前**重置** `dist/` 为**不带接缝**的 internal 产物（与 CI checks job 顺序一致：`Build (internal)` → 门禁） |

复现（按序）：

```bash
# 1 类型与静态
npx tsc -p tsconfig.json
npx oxlint src rspack.config.ts

# 2 单测（含运行器自检）
node tests/run-layer.mjs unit
node tests/run-layer.mjs unit --jobs 1

# 3 回归层 / server 层
node tests/run-layer.mjs regression
node tests/run-layer.mjs server

# 4 黄金（需要 standard 产物）
TEST_AUTH_SEAM=1 pnpm build && node --test tests/golden/*.test.mjs

# 5 集成层（全量串行；三份变体按 ci.yml 构建）
TEST_AUTH_SEAM=1 pnpm run build:internal
TEST_AUTH_SEAM=1 DIST_OUT=dist-standard pnpm run build
TEST_AUTH_SEAM=1 DIST_OUT=dist-scroll   pnpm run build
TEST_AUTH_SEAM=1 STANDARD_DIST_DIR=$PWD/dist-standard \
  node tests/run-layer.mjs integration --baseline --timeout-ms 420000 --json l1.json

# 6 静态门禁
for f in scripts/check-*.mjs; do printf "%-46s " "$f"; timeout 180 node "$f" >/dev/null 2>&1; echo "exit=$?"; done
```

## 2. 各层结果

计数口径：`run-layer` 以**文件**为工作单元（`Total N` = N 个文件），黄金层用 `node --test`（10 个文件 11 条用例）。

| # | 层 | 用例/文件数 | PASS | FAIL | SKIP | 耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 类型 `tsc -p tsconfig.json` | 全仓 | ✅ exit 0 | 0 | 0 | 2.1 s |
| 1 | 静态 `oxlint src rspack.config.ts` | 268 文件 / 100 规则 | ✅ 0 warning 0 error | 0 | 0 | 0.2 s |
| 2 | unit（自适应并发，4 车道 / 39 进程） | 190 | 190 | 0 | 0 | 54.8 s |
| 2 | unit `--jobs 1`（运行器自检：单车道逐文件） | 190 | 190 | 0 | 0 | 94.0 s |
| 3 | regression（纯 Node） | 12 | 12 | 0 | 0 | 3.6 s |
| 3 | server（`deploy/dl-release/test`，37 条断言） | 5 | 5 | 0 | 0 | 2.8 s |
| 4 | golden（`tests/golden/*.test.mjs`，10 文件 11 条） | 11 | 11 | 0 | 0 | 11.0 s（+ 构建 3.0 s） |
| 5 | integration（全量，1 车道串行） | 45 | 45 | 0 | 0 | 1055.3 s |
| 6 | 静态门禁（`scripts/check-*.mjs`） | 31 | 28（exit 0） | 3（1×exit 1、2×exit 2） | 0 | 11.5 s |

集成层明细（`l1.json`）：

```
selected 45 / executed 45 / passed 45 / failed 0 / skipped 0 / degraded 0
flaky 重跑次数 0；quarantined 0；timedOut 0
baseline 比对：本次失败 0 / 基线登记红 0 / 新增失败 0 / 已转绿 0 / 跳过(env) 0（共 45 个文件）
```

单测层的 190 个文件里含运行器自检（`gate-negative-controls` 10 条「门禁确实会咬」的负向对照，
以及 `flaky-registry` / 车道调度 / 崩溃降级等 runner 自身用例），因此 `--jobs 1` 这一遍是
「同一批用例在单车道下结论不漂移」的复算：190/190 一致。

## 3. 门禁结果（31 道逐条 exit code）

口径说明：本次 main 上实际有 **31** 个 `scripts/check-*.mjs`。任务书写的是 28 道 —— 差的 3 道是
`docs/testing/gates-audit-2026-11-20.md` 表里还没有的三道新门禁：`check-case-collision`（+负向对照）、
`check-consume-api`（+负向对照）、`check-test-seam`（+负向对照），本次一并跑了。

| # | 门禁 | exit | 耗时 | CI 接线 |
| --- | --- | --- | --- | --- |
| 1 | check-apk-debuggable | **2** | 38 ms | ✗（release.yml 按产物逐个数跑；裸跑需 apk 参数） |
| 2 | check-bundle-syntax (`check:legacy`) | 0 | 2987 ms | ✓ checks |
| 3 | check-bundle-target | 0 | 2529 ms | ✓ checks |
| 4 | check-capabilities | 0 | 1193 ms | ✓ checks（warn 档） |
| 5 | check-case-collision | 0 | 76 ms | ✓ checks（+负向对照） |
| 6 | check-compat-baseline | 0 | 59 ms | ✗（matrix 相关，CI 走 `check:matrix`） |
| 7 | check-consume-api | 0 | 302 ms | ✓ checks（+负向对照） |
| 8 | check-container-query-fallback | 0 | 74 ms | ✗ |
| 9 | check-css-gap-fallback | 0 | 119 ms | ✗ |
| 10 | check-doc-refs | 0 | 188 ms | ✓ checks（+负向对照） |
| 11 | check-duplicate-impl | 0 | 93 ms | ✓ checks |
| 12 | check-endpoints | 0 | 221 ms | ✓ checks（+负向对照） |
| 13 | check-focus-visible-fallback | 0 | 108 ms | ✗ |
| 14 | check-guard-es5 | 0 | 88 ms | ✓ checks（负向对照在 checks 内） |
| 15 | check-hardcoded-ip | 0 | 106 ms | ✓ checks |
| 16 | check-hardcoded-ports | 0 | 418 ms | ✗ |
| 17 | check-i18n | 0 | 115 ms | ✓ checks（+负向对照） |
| 18 | check-icon-edges | 0 | 98 ms | ✗ |
| 19 | check-identity | 0 | 151 ms | ✗ |
| 20 | check-issue-close-keywords | 0 | 37 ms | ✗（未接任何入口） |
| 21 | check-keystore-config | **2** | 44 ms | ✗（§3.2） |
| 22 | check-limits | 0 | 62 ms | ✗ |
| 23 | check-log-coverage | 0 | 102 ms | ✓ checks |
| 24 | check-manifest-fixtures | 0 | 423 ms | ✓ checks |
| 25 | check-redact | 0 | 82 ms | ✓ checks（+负向对照） |
| 26 | check-refactor-direction | **1** | 400 ms | ✗（#487 明确推迟到阶段②之后） |
| 27 | check-repo-hygiene | 0 | 104 ms | ✓ checks |
| 28 | check-scrollbar-gutter-fallback | 0 | 73 ms | ✗ |
| 29 | check-test-duplication | 0 | 553 ms | ✓ checks |
| 30 | check-test-layout | 0 | 628 ms | ✓ checks |
| 31 | check-test-seam | 0 | 58 ms | ✓ checks（+负向对照） |

### 3.1 三道非 0 逐条定性（都不是「重构弄坏了什么」）

| 门禁 | exit | 定性 | 依据 | 结论 |
| --- | --- | --- | --- | --- |
| `check-apk-debuggable` | 2 | **未跑（用法/环境缺）** | 裸跑打印用法：`node scripts/check-apk-debuggable.mjs <apk> ...`；本次没有待检 apk 产物 | 零覆盖，不是产品红。真实入口在 `release.yml`（按发版产物逐个跑） |
| `check-keystore-config` | 2 | **未跑（环境缺）** | `[FAIL] 找不到签名属性文件: android/keystore/keystore.properties` —— 该文件**按设计不入库**，新机器必须手工放 | 零覆盖，不是产品红。与 `gates-audit-2026-11-20.md` §3.3 结论一致 |
| `check-refactor-direction` | 1 | **设计性红（有意的）** | `A1 FAIL / A4 FAIL / A6 FAIL`：`src/` 里旧池域 IP `140.210.13.146` 命中 7 处（其中 2 处代码行、11 处仅注释）、`:60013` 命中 6 处、后端域名字面量 10 处（1 处真常量 `src/services/ours/api.ts:42` + 9 处注释）；`device_id` 当鉴权参数命中 10 处 | 脚本自己写着「重构期请用 `--report`，CI 接线推迟到阶段②之后」。**这是 #487 的待清理清单，不是回归**；本次不动代码 |

## 4. known-red 清单

`tests/integration-baseline.json`：**38 个文件登记，38 条全部 `expected=pass` → known-red 剩 0 条。**

历史收敛路径（记录在 baseline 的 `reverified` 字段里）：
#365 接线时实测 7 条既有红 → #406 逐条复核：6 条判定为「断言过时 / 测试自身 bug」，改测试后转绿并删条目；
1 条 `upstream-html` 判定为真实产品缺陷（C 类）并开 follow-up **#432** → #434 修好后转绿、条目已删。

另有 **7 个集成文件不在 baseline 里**（baseline 38 / 实际 45）：`diagnostics-contract`、`feedback-scroll`、
`full-acceptance`、`log-viewer`、`mode-switch`、`url-import-stages`（#406 删条目后未回写新条目）
以及本次新增的 `ours-services`（#562 改写成「入口只在自有渠道出现 + 点开即新页」，runner 注入共享标准产物服务）。
它们本次**全部 PASS**，无需登记。建议后续把 baseline 覆盖口径补齐到 45 条（另开单，不在本次范围）。

## 5. 新增红

**0 条。** 六层全绿，集成层相对 baseline「新增失败 0 / 已转绿 0」，无需定性。

## 6. 总耗时

| 口径 | 值 | 说明 |
| --- | --- | --- |
| 本地串行（本单实跑） | **≈1250 s ≈ 20 分 50 秒** | tsc 2.1 + oxlint 0.2 + unit 54.8 + unit(--jobs 1) 94.0 + regression 3.6 + server 2.8 + 标准产物构建 3.0 + golden 11.0 + 三变体构建 8.0 + integration 1055.3 + 门禁前构建 4.0 + 门禁 11.5 |
| CI 并行墙钟（同 commit） | **271 s ≈ 4 分 31 秒** | [run 44742857267](https://github.com/zzy-repo/deepseek-app/actions/runs/44742857267)，`2026-11-20T13:16:23Z → 13:20:57Z`，结论 success |
| CI runner 分钟合计 | 1446 s ≈ 24 分 06 秒 | 9 个 job 的时长之和（含各 job 自己的 setup/install） |

CI 各 job 时长（最近一次 main run）：

| job | 时长 | 结论 |
| --- | --- | --- |
| type / lint / unit / 产物兼容门禁（含 regression、server、18 道门禁） | 104 s | success |
| L1 集成层 1/6 | 164 s | success |
| L1 集成层 2/6 | 194 s | success |
| L1 集成层 3/6 | 206 s | success |
| L1 集成层 4/6 | 230 s | success |
| L1 集成层 5/6 | 219 s | success |
| L1 集成层 6/6 | 256 s | success |
| 黄金回归（≤5 分钟） | 61 s | success |
| flaky 三态与跨 runner 判定 | 12 s | success |

**串行 vs 并行的差**：本地串行 20 分 50 秒里 **84% 是集成层**（1055 s / 45 文件 ≈ 23.5 s/文件，
最慢 `copy-limit` 115 s、`feedback-scroll` 与 `copy-limit` 两条自带构建+滚动截图）。CI 把这一层切成 6 片
（每片 164–256 s，含 install 与三变体构建），于是整条流水线的关键路径从「集成层全长」变成「最慢那一片」。

## 7. 结论与遗留

1. **重构的功能代码在 `7d5c3eb` 上是全绿的**：类型、静态、单测（含单车道复算）、回归、server、黄金、集成六层全 PASS，新增红 0。
2. **门禁不是全绿，但红的三道都与本次重构无关**：2 道零覆盖（缺 apk 参数 / 缺本机 keystore.properties）、
   1 道设计性红（`check-refactor-direction` 的 A1/A4/A6，等 #487 清理项收口）。
3. 遗留（**本单只跑不改**，建议另开单）：
   - `check-keystore-config` 至今无自动入口 → 谁改坏 `keystore.properties` 形状只有发版当天才知道；
   - `check-apk-debuggable` 裸跑必 `exit 2` → 建议加一条「无参数时按 SKIP(env) 而非用法错」的约定；
   - `check-issue-close-keywords` 未接任何入口（游离门禁）；
   - `check-refactor-direction` 的 A1/A4/A6 清理项（旧池域 IP/端口字面量、后端域名字面量、`device_id` 当凭据）
     是 #487 阶段②之后的收口清单；A7 需人工 390 宽截图（脚本不判）。
4. **环境踩坑留档**（供下一个人少走弯路）：首次集成层实跑时把 `DIST_DIR` 指到了 `$PWD/dist-internal`
   —— 而 `build:internal` 的产物落点是 `dist/`（CI 里干脆不设 `DIST_DIR`，走默认值）。结果 21 个文件
   整批 `Missing prebuilt index.html ... dist-internal` 假红。删掉 `DIST_DIR` 重跑后 45/45 全绿。
   baseline 的 `howToRun` 里那句 `DIST_DIR=$PWD/dist-internal` 是这个坑的源头，建议改成不带 `DIST_DIR`。

---

*报告由阶段②验证单生成；本次**未修改任何代码**，唯一新增文件是本报告。*

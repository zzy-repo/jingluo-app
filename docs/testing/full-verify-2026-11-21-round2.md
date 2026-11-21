# 全量验证报告（第二轮）：main@`9378d6a` vs 首轮 main@`7d5c3eb`

> **结论先写**：**没有回归。**
> 六个可执行层（类型/静态、unit、regression、server、golden、integration）全部 PASS；
> 集成层 48 个文件 **0 FAIL / 0 SKIP**，相对 `integration-baseline.json` **新增失败 0 / 已转绿 0**；
> **新增红 0 条**。门禁 37 道里 2 道非 0 —— 与首轮完全同两道、同一原因（缺参数 / 缺本机 keystore，`exit 2` = 零覆盖），
> 且**首轮那道设计性红 `check-refactor-direction` 已经转绿**（A1–A6 PASS，A7 MANUAL）。
> `pnpm build` OK；`assembleRelease -PartifactVariant=internal` 本机**实跑出包**（6.57 MiB），
> `debuggable=false（attr_absent）`、`aapt2 ... grep -c application-debuggable` = **0**、`verify:apk` **5/5 PASS**。
> 同 commit 的 main CI（run [44879309351](https://github.com/zzy-repo/deepseek-app/actions/runs/44879309351)）**9 个 job 全 success**。
> 本地测试层串行 **≈24 分 17 秒**（首轮 ≈20 分 50 秒，**+3 分 27 秒全部来自新增用例**：unit +27 文件、integration +3 文件、golden +3 文件、server +6 文件、门禁 +6 道）。

---

## 1. 环境与复现

| 项 | 值 |
| --- | --- |
| 被测代码 | `origin/main` @ `9378d6a0`（`test(identity): … (#714)`），**干净 worktree** `/root/worktrees/fv-round2`（`git status` 除测试产物截图外无改动） |
| 对照基线 | 首轮 `docs/testing/full-verify-2026-11-20.md`（main@`7d5c3eb`）；**两次之间 84 个 commit**（`git rev-list --count 7d5c3eb..9378d6a0`） |
| 命令前置 | `export PATH="/opt/node24/bin:$PATH" LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8 ANDROID_HOME=/root/android-sdk` |
| Node / pnpm / JDK | `v24.22.0` / `11.24.0` / OpenJDK `21.0.13.1`（与首轮同机同版本） |
| 机器 | 4 核 / 15.8 GB，build-tools `36.0.0` |
| 登录接缝 | 集成层 + golden 层一律 `TEST_AUTH_SEAM=1` 构建（首轮记录的坑：不带接缝会掉进登录页 → 整批假红） |
| 产物顺序 | 与 CI checks job 一致：先 `TEST_AUTH_SEAM=1` 三变体 → 跑完集成层后**把 `dist/` 重建成不带接缝的 internal 产物**（`pnpm run build:internal`）→ 再跑静态门禁 |

实际执行顺序（每步计时，日志 `/root/未分组/fv2-logs/`）：

```bash
npx tsc -p tsconfig.json
npx oxlint src rspack.config.ts
node tests/run-layer.mjs unit
node tests/run-layer.mjs unit --jobs 1          # 单车道复算（运行器自检）
node tests/run-layer.mjs regression
node tests/run-layer.mjs server
pnpm build                                       # DoD：能否出包
TEST_AUTH_SEAM=1 pnpm build && node --test tests/golden/*.test.mjs
TEST_AUTH_SEAM=1 pnpm run build:internal
TEST_AUTH_SEAM=1 DIST_OUT=dist-standard pnpm run build
TEST_AUTH_SEAM=1 DIST_OUT=dist-scroll   pnpm run build
TEST_AUTH_SEAM=1 STANDARD_DIST_DIR=$PWD/dist-standard \
  node tests/run-layer.mjs integration --baseline --timeout-ms 420000 --json l1.json
pnpm run build:internal                          # 重置 dist/ 为「不带接缝」的 internal 产物（门禁前）
for f in scripts/check-*.mjs; do printf "%-46s " "$f"; timeout 180 node "$f" >/dev/null 2>&1; echo "exit=$?"; done
```

> **注意（首轮踩过、本轮照做）**：`dist/` 的落点是 `build:internal` 的产物，**不要**再给 `DIST_DIR` 指 `dist-internal`（`integration-baseline.json` 的 `howToRun` 里那句仍未改，属已知文档坑）。

## 2. 逐层对比表

计数口径同首轮：`run-layer` 以**文件**为工作单元；golden 层用 `node --test`（以**用例**计）。

| # | 层 | 首轮 `7d5c3eb` | 本轮 `9378d6a` | 变化 |
| --- | --- | --- | --- | --- |
| 1 | 类型 `tsc -p tsconfig.json` | exit 0，2.1 s | **exit 0**，1.5 s | 持平（快 0.6 s） |
| 1 | 静态 `oxlint src rspack.config.ts` | 268 文件，0 warning / 0 error，0.2 s | **279 文件，0 warning / 0 error**，0.5 s | 文件 +11，结论不变 |
| 2 | unit（自适应并发，4 车道） | 190 / 190 PASS，54.8 s | **217 / 217 PASS**，80.3 s | 文件 **+27**，耗时 +25.5 s（≈0.37 s/文件，线性，无异常） |
| 2 | unit `--jobs 1`（单车道复算） | 190 / 190 PASS，94.0 s | **217 / 217 PASS**，140.3 s | 同上；两遍结论一致，REVERSE-SAMPLE ok 3/3 与 4/4 |
| 3 | regression | 12 / 12 PASS，3.6 s | **12 / 12 PASS**，4.1 s | 文件数不变 |
| 3 | server（`deploy/dl-release/test`） | 5 / 5 PASS，2.8 s | **11 / 11 PASS**，11.1 s | 文件 **+6**（dl-release 拆分与私有根相关用例） |
| 4 | golden（`tests/golden/*.test.mjs`） | 11 用例 / 10 文件 PASS，11.0 s（+构建 3.0 s） | **14 用例 / 13 文件 PASS**，17.7 s（+构建 2.7 s） | 文件 **+3**（`g13-documents` / `g14-vision` / `g16-account-optional`）、用例 +3 |
| 5 | integration（全量，1 车道串行） | 45 / 45 PASS，1055.3 s | **48 / 48 PASS**，1147.0 s | 文件 **+3**，耗时 +91.7 s（+8.7%，与文件数 +6.7% 同量级） |
| 6 | 静态门禁 `scripts/check-*.mjs` | 31 道：28×exit 0，1×exit 1，2×exit 2，11.5 s | **37 道：35×exit 0，0×exit 1，2×exit 2**，31.1 s | 新增 6 道（全绿）、**1 道红转绿**、红变绿 0 道 |

集成层明细（`l1.json`）：

```
selected 48 / executed 48 / passed 48 / failed 0 / skipped 0 / degraded 0
flaky 自动登记 0；quarantined 0；INFRA-RETRIED 0 / INFRA-FAIL 0
baseline 比对：本次失败 0 / 基线登记红 0 / 新增失败 0 / 已转绿 0 / 跳过(env) 0（共 48 个文件）
```

最慢 6 个文件（首轮同两个是第一、第二，绝对值同量级）：

| 文件 | 本轮 | 说明 |
| --- | --- | --- |
| `copy-limit.test.mjs` | 157.0 s | 自建产物 + 滚动截图（首轮最慢 115 s） |
| `feedback-scroll.test.mjs` | 123.0 s | 同上 |
| `url-import-stages.test.mjs` | 85.5 s | 导入分阶段 |
| `domain03-settings-probe-model.test.mjs` | 84.1 s | |
| `domain02-wait-thinking-ui.test.mjs` | 80.1 s | |
| `domain02-reply-error-ui.test.mjs` | 76.9 s | |

**新增的 3 个集成文件**（首轮没有）：`chat-newline-enter-610`、`imported-attachment-source-379`、`update-dialog-517` —— 三个**首跑即绿**。

## 3. 门禁对比（37 道，逐条 exit code）

**哪 6 道是新增**：`check-db-version`、`check-eol`、`check-private-publish-root`、`check-retention`、`check-ui-shots`、`check-webroot-hygiene` —— 全部 `exit 0`（其中 `check-retention` 尚未接 CI，其余 5 道已接线）。

**绿→红：0 道。红→绿：1 道**（`check-refactor-direction`，见 §3.2）。

| # | 门禁 | 首轮 | 本轮 | 本轮耗时 | CI 接线 |
| --- | --- | --- | --- | --- | --- |
| 1 | check-apk-debuggable | 2 | **2** | 65 ms | ✓（`release.yml` 按产物带参跑；裸跑 `exit 2`） |
| 2 | check-bundle-syntax | 0 | 0 | 4307 ms | ✓ |
| 3 | check-bundle-target | 0 | 0 | 4944 ms | ✓ |
| 4 | check-capabilities | 0 | 0 | 3314 ms | ✓ |
| 5 | check-case-collision | 0 | 0 | 143 ms | ✓ |
| 6 | check-compat-baseline | 0 | 0 | 131 ms | ✗（CI 走 `check:matrix`） |
| 7 | check-consume-api | 0 | 0 | 518 ms | ✓ |
| 8 | check-container-query-fallback | 0 | 0 | 147 ms | ✗ |
| 9 | check-css-gap-fallback | 0 | 0 | 344 ms | ✗ |
| 10 | **check-db-version** | — | **0** | 945 ms | ✓（新增） |
| 11 | check-doc-refs | 0 | 0 | 285 ms | ✓ |
| 12 | check-duplicate-impl | 0 | 0 | 129 ms | ✓ |
| 13 | check-endpoints | 0 | 0 | 395 ms | ✓ |
| 14 | **check-eol** | — | **0** | 1467 ms | ✓（新增） |
| 15 | check-focus-visible-fallback | 0 | 0 | 365 ms | ✗ |
| 16 | check-guard-es5 | 0 | 0 | 271 ms | ✗ |
| 17 | check-hardcoded-ip | 0 | 0 | 297 ms | ✓ |
| 18 | check-hardcoded-ports | 0 | 0 | 724 ms | ✗ |
| 19 | check-i18n | 0 | 0 | 362 ms | ✓ |
| 20 | check-icon-edges | 0 | 0 | 170 ms | ✗ |
| 21 | check-identity | 0 | 0 | 513 ms | ✗ |
| 22 | check-issue-close-keywords | 0 | 0 | 115 ms | ✗（仍游离） |
| 23 | check-keystore-config | 2 | **2** | 114 ms | ✓（裸跑缺本机 properties → `exit 2`） |
| 24 | check-limits | 0 | 0 | 173 ms | ✗ |
| 25 | check-log-coverage | 0 | 0 | 322 ms | ✓ |
| 26 | check-manifest-fixtures | 0 | 0 | 1006 ms | ✓ |
| 27 | **check-private-publish-root** | — | **0** | 88 ms | ✓（新增） |
| 28 | check-redact | 0 | 0 | 131 ms | ✓ |
| 29 | check-refactor-direction | **1** | **0** | 969 ms | ✓（**红转绿**） |
| 30 | check-repo-hygiene | 0 | 0 | 292 ms | ✓ |
| 31 | **check-retention** | — | **0** | 49 ms | ✗（新增，未接线） |
| 32 | check-scrollbar-gutter-fallback | 0 | 0 | 113 ms | ✗ |
| 33 | check-test-duplication | 0 | 0 | 1179 ms | ✓ |
| 34 | check-test-layout | 0 | 0 | 1050 ms | ✓（`--strict`） |
| 35 | check-test-seam | 0 | **0** | 96 ms | ✓（见 §3.3 的过程性假红） |
| 36 | **check-ui-shots** | — | **0** | 5476 ms | ✓（新增） |
| 37 | **check-webroot-hygiene** | — | **0** | 134 ms | ✓（新增） |

### 3.1 两道非 0（与首轮同两道、同原因，仍不是产品红）

| 门禁 | exit | 定性 | 依据 |
| --- | --- | --- | --- |
| `check-apk-debuggable` | 2 | **裸跑＝未跑（用法缺）** | 裸跑打印用法 `node scripts/check-apk-debuggable.mjs <apk> …`；**带参跑是真绿**：本轮拿 `assembleRelease` 的实包跑 → `[OK] … debuggable=false (attr_absent)`，`exit 0`（§6） |
| `check-keystore-config` | 2 | **未跑（环境缺）** | `[FAIL] 找不到签名属性文件: android/keystore/keystore.properties`；该文件按设计不入库。**本轮我为了出包手工放了一份指向已发布证书的 properties（§6.3），但门禁这一遍跑在“干净 worktree”状态下，故仍 `exit 2`** |

### 3.2 `check-refactor-direction`：首轮的设计性红 → 本轮 PASS

```
[A1] PASS 旧体系已断：旧池域 IP 140.210.13.146 命中 0 处 / :60013 命中 0 处 /
     device_id 与 Authorization 同行 0 处 / device_id 作请求参数或请求头 0 处
[A2] PASS 调用归位白名单   [A3] PASS   [A4] PASS   [A5] PASS   [A6] PASS base 配置化
[A7] MANUAL UI 收敛（需人工 390 宽截图，脚本不判）
—— 汇总：PASS 6 · FAIL 0 · SKIP 0 · MANUAL 1；结论：方向验收通过
```

首轮同一道门禁的结论是 `A1 FAIL / A4 FAIL / A6 FAIL`（`140.210.13.146` 7 处、`:60013` 6 处、后端域名 10 处、`device_id` 当凭据 10 处）。
区间内的收口 commit：`3bde55e9 chore: C 线方向验收收口——修扫描口径 + A1/A4/A6 清零 + A7 截图（#590） (#604)`。
**这是"红变绿"，不是"红被放宽"**：`src/` 里现在 `grep -rn "140.210.13.146" src/` = 0 命中（本机实测），
且 `check-hardcoded-ip`、`check-consume-api`、`check-doc-refs` 等相邻门禁同时为 0 —— 判据没动、命中项真被清掉了。

### 3.3 一道**我自己造出来的**假红（必须写明，否则会被误读成回归）

第一遍门禁（跑在 `dist/` 还是**带接缝**产物的时候）里 `check-test-seam` = `exit 1`：

```
[check:test-seam] ✗ 生产产物里出现了登录接缝标记（1 处）：
  - test-token-not-real：dist/static/js/main.98d36abd.js
```

原因是我为了 golden / 集成层先 `TEST_AUTH_SEAM=1 pnpm build`（落点就是 `dist/`），门禁读的正是这份带接缝的 `dist/`。
按首轮记录的顺序**先把 `dist/` 重建成不带接缝的 internal 产物**（`pnpm run build:internal`，9.4 s，`grep -c test-token-not-real dist/static/js/*.js` = 0）后重跑，
`check-test-seam` = **`exit 0`**。**结论：这是跑法顺序问题（我自己的操作），不是 main 的回归**；首轮同样规定"门禁前重置 dist/"。
上表采用**第二遍（干净 dist/）**的 37 道 exit code。

## 4. 新增红

**0 条。** 六层全绿；集成层相对 baseline「新增失败 0 / 已转绿 0」；门禁无绿→红。

为免"没红=没细看"，本轮仍做了 3 项自证：

1. **单车道复算**：unit 217 个文件在 `--jobs 1` 下逐文件重跑，217/217 一致（结论不随并发漂移）；
2. **门禁不是空跑**：`check-apk-debuggable` 用实包复跑为绿（§6.2），`check-keystore-config` 的手工 properties 形状被它自己的负向对照与 `release-check` 复用（§6.3），说明这两道"exit 2"确属参数/环境缺，不是"啥也没检查还报 0"；
3. **门禁跑了两遍**：第一遍暴露了 §3.3 的假红并被我定位到"跑法"而非"代码"，第二遍才进表 —— 即"看起来红→查出是跑法→纠正后绿"的完整链条留痕，而不是直接把红删掉。

## 5. known-red 与 flaky

| 项 | 首轮 | 本轮 |
| --- | --- | --- |
| `tests/integration-baseline.json` | 38 条登记，全部 `expected=pass` → known-red **0** 条 | **38 条登记，全部 `expected=pass` → known-red 仍 0 条** |
| 集成层文件数 vs 登记数 | 45 vs 38（7 个未登记） | **48 vs 38（10 个未登记）** |
| 本次 flaky 自动登记 | 0 | **0**（`flaky: []`、`quarantined: []`） |
| INFRA（#611） | 未触发 | **`retried: []` / `fail: []`**（未触发） |
| `tests/flaky-registry.json` 当前内容 | — | **1 条 `tests` 条目 + 1 条 `infraSignatures`** |

**registry 当前内容（逐条）**：

1. `tests/unit/capabilities-docs-sync.test.mjs` —— `kind=cross-runner`，`firstSeen 2026-11-20`，`count 2`，`streak 0`，`quarantinedAt null`，evidence 4 条（`normal` 红 / `busy` 绿，同 commit `6ecc08b`）；本轮 unit 层首次即绿，**未新增 evidence**。
2. `infraSignatures[0]` = `runner-ipc-deserialize-611`（`tests: []` 恒空）—— 登记的是"runner 自己崩了"的证据串，不属于任何文件放行条。

**⚠ 事实纠正（任务书里的已知坑与本轮现状不一致）**：任务书提到 registry 里有 `diagnostics-stream-timing` 这个 cross-runner flake —— **现在 registry 里没有这一条**。
`diagnostics-stream-timing` 目前只出现在 `tests/fast-subset.json`（"流式时序打点，按真实时间推进"，743 ms）与 `tests/unit-merge-weights.json` 的权重表里，是**慢用例提示**，不是 flaky 放行条。
本轮它按常规跑过（unit 层 217/217 包含它），未红。

**registry 还原**：跑完 `git status` 显示 `tests/flaky-registry.json` 被 runner 自动改了 1 行（`lastSeen: 2026-11-20 → 2026-11-21`，即上面第 1 条），
已 `git checkout -- tests/flaky-registry.json` 还原，`md5sum` 与开工前快照一致（`71c757e4bd76a8a157ec8beaf86c1d94`）。**报告与本 PR 不含该文件的改动。**

## 6. 构建与出包（DoD 第二条）

### 6.1 `pnpm build`

```
$ pnpm build
[build] consume=https://sub2api.rose7.cn (/api/v1 | /v1)
[build] pay=https://apia.ecsafe.cn
[build] variant=standard NODE_ENV=production
[build] out=dist rspack=@rspack/cli@2.0.2 config=rspack.config.ts node=v24.22.0
Rspack compiled successfully in 2.29 s
[build] OK dist/ 已生成                      # exit 0，3.2 s
```

### 6.2 `assembleRelease -PartifactVariant=internal` —— **本机实跑出包**

```
$ cd android && ./gradlew assembleRelease -PartifactVariant=internal
BUILD SUCCESSFUL in 1m 30s
165 actionable tasks: 165 executed                       # exit 0，90.5 s
产物：android/app/build/outputs/apk/release/app-release.apk  （6891899 字节 / 6.57 MiB）

$ node scripts/check-apk-debuggable.mjs <apk>
[OK] app-release.apk package=com.example.deepseekchat versionName=1.4.4 versionCode=23 debuggable=false (attr_absent)
通过：1 个 APK 均无 android:debuggable 标记，可以发布。   # exit 0

$ aapt2 dump badging <apk> | grep -c application-debuggable
0                                                        # 门禁口径：必须输出 0 ✅

$ node scripts/verify-release-apk.mjs <apk> --variant internal
1  debuggable 不存在或 false        PASS  attr_absent
2  ARTIFACT_VARIANT 与期望一致      PASS  internal
3  LOOPBACK_CONSUME 不存在或 false  PASS  false
4  签名证书 SHA-256 与期望一致      PASS  e7c5baee517ca2b2258950e934521f2fad448d00f72f2ff7297bdf4fa00aa8a1
5  INSECURE_CONSUME 不存在或 false  PASS  false
versionName=1.4.4  versionCode=23
sha256=963630be6433651af206ad36db4860adbc9c883238b7c2cd55fa60804f75e71e  size=6.57 MiB
结论：PASS（5/5 项通过）—— 可以发布。                     # exit 0
```

（出包前的产物链：`pnpm run build:internal` → `npx cap sync android`（`dist → android/app/src/main/assets/public`，0.16 s）→ `./gradlew assembleRelease`。）

### 6.3 签名：本机是怎么过 `EXPECTED_CERT_SHA256` 这道闸的（**重要，别照抄结论**）

- worktree 里仓库自带的 `android/keystore/release.keystore` 是**另一把证书**：`SHA256 63:66:93:93:58:36:DD:BF:65:65:AD:2E:A1:1B:85:38:CB:9F:C3:40:25:1E:32:35:C4:1A:19:2B:17:32:55:E4`；
- `config/appIdentity.json` 的 `expectedCertSha256` 是 `e7c5baee…aa8a1`（= 历史发布证书，也就是 `/root/.android/debug.keystore`，别名 `androiddebugkey`）；
- 所以我按 `build.gradle` 报错提示里给的正路，在本机放了**不入库**的 `android/keystore/keystore.properties`，把 `storeFileRelease` 指向 `/root/.android/debug.keystore`。
  若照仓库里那把 `release.keystore` 出包，构建会按 `#705/#713` 的 fail-closed 判据**直接中止**（这正是那两单要的行为，不是缺陷）。
- **结论口径**：本轮"能出包 + debuggable=0 + 证书指纹=已发布证书"是**在补齐本机 keystore 的前提下**验到的；换一台新机器，第一道坎仍然是"手工放 keystore.properties"（与首轮遗留项一致）。

### 6.4 main CI（同 commit `9378d6a`）

| 项 | 值 |
| --- | --- |
| run | [44879309351](https://github.com/zzy-repo/deepseek-app/actions/runs/44879309351)（attempt 1） |
| 结论 | **success**（9 / 9 job success，`2026-11-21T07:14:28Z → 07:20:12Z`） |
| 并行墙钟 | **344 s ≈ 5 分 44 秒** |
| runner 分钟合计 | **1933 s ≈ 32 分 13 秒** |

| job | 时长 | 结论 |
| --- | --- | --- |
| type / lint / unit / 产物兼容门禁 | 309 s | success |
| L1 集成层 1/6 … 6/6 | 205 / 238 / 243 / 248 / 267 / 308 s | success ×6 |
| 黄金回归（≤5 分钟） | 103 s | success |
| flaky 三态与跨 runner 判定 | 12 s | success |

## 7. 总耗时

| 口径 | 首轮 `7d5c3eb` | 本轮 `9378d6a` | 变化 |
| --- | --- | --- | --- |
| 本地测试层串行 | ≈1250 s（20 分 50 秒） | **≈1457 s（24 分 17 秒）** | **+207 s（+16.6%）** |
| 其中 integration | 1055.3 s | 1147.0 s | +91.7 s（+8.7%，文件 +6.7%） |
| 其中 unit + unit(--jobs 1) | 148.8 s | 220.6 s | +71.8 s（文件 +14.2%） |
| 其中 golden | 14.0 s（含构建） | 20.4 s（含构建） | +6.4 s |
| 其中 server | 2.8 s | 11.1 s | +8.3 s |
| 其中门禁 | 11.5 s | 31.1 s | +19.6 s（+6 道，`check-ui-shots` 单道 5.5 s） |
| 另：`assembleRelease` 出包 | 未跑 | +90.5 s | 本轮新增验证项 |
| **本地合计（含出包）** | — | **≈1548 s（25 分 48 秒）** | |
| CI 并行墙钟（同 commit） | 271 s | **344 s** | +73 s（集成层 6 片各 +40~50 s，与文件数/新增门禁同向） |

拆分说明：本轮 269.8 s（类型/静态/unit/unit-jobs1/regression/server/build/golden/三变体构建）+ 1147.0 s（集成层）+ 9.4 s（门禁前重建 `dist/`）+ 31.1 s（门禁 37 道）。
**性能没有退化**：单文件平均耗时与首轮同量级（integration 23.9 s/文件 vs 首轮 23.4 s/文件；unit 0.37 s/文件 vs 0.29 s/文件）。
`unit` 的 +28% 单文件均值我做了核对：新增的 27 个文件里含若干 0.5–1.5 s 的重用例（如 `capabilities-docs-sync` 1.5 s 级），耗时增长方向与文件数一致、无单个用例量级异常；如需更硬的证据，下次可在 `run-layer unit --json` 里按文件列出（本次未存 json）。

## 8. 结论与遗留

1. **今天多轮合并（84 commit / #672 #684 #689 #691 #700 #702 #704 #707 #713 …）没有带来回归**：六层全绿、新增红 0、门禁无绿→红、build 与出包均 OK（debuggable=0）。**DoD 两条在本机与 CI 上都成立。**
2. **相对首轮的唯一"状态变化"是变好**：`check-refactor-direction` 从设计性红（A1/A4/A6 FAIL）转为 A1–A6 全 PASS（A7 仍 MANUAL，需 390 宽截图）。
3. **门禁从 31 → 37 道**，新增 6 道全绿；其中 `check-retention` 尚未接任何 CI 入口，`check-issue-close-keywords` 仍游离（首轮遗留项，未变）。
4. 遗留（**本单只跑不改**）：
   - `check-keystore-config` / `check-apk-debuggable` 裸跑仍 `exit 2`（零覆盖）。本轮已证明 `check-apk-debuggable` **带参一定咬**，建议把"裸跑 → SKIP(env) 而非用法错"作为口径收口（首轮同建议）；
   - `integration-baseline.json` 覆盖口径仍是 38 / 48（10 个文件未登记，本轮新增 3 个已绿）；`howToRun` 里 `DIST_DIR=$PWD/dist-internal` 这句仍是坑；
   - 集成层时序告警：41 个文件 / 277 处 `waitForTimeout`·`fixed-sleep`（警告级，不阻塞；首轮报告未记录这一项，本轮首次量出，建议单开一单做"等终态"收敛）。

---

*本单未修改任何代码；唯一新增文件是本报告。`tests/flaky-registry.json` 已被还原（md5 与开工前一致），`docs/ui/**` 下 49 个被集成用例重写的截图为测试副产物，未入库。*

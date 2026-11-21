# 测试分级门禁（TESTING POLICY）

本文件定义「什么改动该跑哪些测试、什么时候算过」。配套实现：

- `tests/which.mjs` —— 改动文件 → 该跑的用例（含回落规则，`--self-test` 自证）
- `tests/integration-baseline.json` —— 集成层基线失败清单（L2 只判「不新增失败」）
- `tests/run-layer.mjs --baseline` —— 按基线清单比对并输出差异
- `docs/testing.md` —— 集成层怎么跑、产物/端口/夹具要求
- `tests/unit/gate-negative-controls.test.mjs` + `tests/gates/` —— 门禁自身的负向对照（见第 9 节）
- [`docs/diagnostics-spec.md`](diagnostics-spec.md) —— 诊断日志的**最小字段集**（`stage` / `status` / `reason` /
  `retryable` / `durationMs` + `meta` ≥ 2 键）与 `reason` 字典口径；新增埋点前先读它，`pnpm check:log-coverage` 只挡退化、不判合格

一句话原则：**门禁要快，慢检查只在发版前跑一次；失败要可比，只和基线比，不追「全绿」幻想。**

---

## 1. 为什么分级

历史做法是「每次改动都跑全量 integration」：20 个文件、每个起一次 Chromium、部分还要重新构建一份 dist，
单次 9~15 分钟，且本机内存有限（compat 模拟器 + 发布构建同时存在时 MemAvailable 常年在 4~6 GiB）。
结果是不跑、跑一半、或者跑出红也不知道是新引入的还是基线本来就红（见 Issue #19）。

所以拆成三档：**L0 每次提交、L1 合并候选、L2 仅发版前**。档次越高越慢，覆盖越全，但频率越低。

---

## 2. L0 快速门（每次提交，目标 < 60s）

```bash
npx tsc -p tsconfig.json                      # 类型
npx oxlint src rspack.config.ts               # lint
node tests/which.mjs --git --layer unit       # 受影响文件的单测（按改动映射）
```

- **只跑受影响文件的单测**，不跑整层。映射由 `tests/which.mjs` 给出：
  改动文件 → 规则命中（`RULES`）或单测 import 反查 → 用例清单。
- 映射不出来时**回落 unit 全量**并打印原因（`! <文件>：… 回落 N 个用例`），不静默跳过。
- 纯文档改动 → 0 个用例（L0 只剩 tsc + lint）。
- 目标耗时：单测都是毫秒级，实际 < 20s；给 60s 上限是留给 tsc 冷启动。
- 例：

```bash
$ node tests/which.mjs --git --layer unit
! src/services/diagnostics/export.ts：命中规则 /^src\/services\/diagnostics\// → 3 个用例
将执行 1 个用例：
  tests/unit/feedback-export.test.mjs
```

## 3. L1 域门（合并候选，目标 < 5min）

```bash
node tests/which.mjs --git              # 默认 both：该域单测 + 该域 1~2 个集成用例
# 按输出的「建议命令」串行执行（集成层一次只跑一个文件）
```

- 集成用例只挑 **该域 1~2 个**（例如渠道 spec 改动 → `provider-channels` / `internal-build`；
  设置页 → `provider-channels` / `feedback-export`），不跑全层。
- 集成层需要标准构建产物挂在 `APP_URL` 上（见 `docs/testing.md`）；一次改动最多重建一次产物。
- 目标耗时：单测 < 20s + 1~2 个集成文件 1~2 分钟，合计 < 5 分钟。

## 4. L2 全量门（仅发版前一次）

```bash
npm test                                        # unit 全量
npm run test:integration -- --baseline          # 集成全量与基线比对，只判「不新增失败」
```

- **判定规则：不新增失败**，不要求全新的「全绿」。基线清单是 `tests/integration-baseline.json`：
  每个文件声明 `expected`（`pass` / `known-red`）与 `reason`；`known-red` 必须写原因与关联 Issue。
- 输出三种结果：
  - `OK`：期望通过且通过，或期望红且确实红（历史红未扩大）；
  - `NEW FAIL`：期望通过但失败 → 非零退出，**必须修或改基线并写理由**；
  - `FIXED?`：基线记为红但这次通过 → 非零退出提醒更新基线（防止基线永久腐烂）。
- 发布前仍要跑一次 L2，并把「相对基线无新增失败」写进 Issue/CHANGELOG。

## 5. 明确禁止

1. **禁止每次改动跑全量集成。** 一次提交跑 20 个文件 ≈ 10 分钟，等于把门禁变成「没人跑」。
2. **禁止重复构建多份 dist。** 一轮验证只允许一份标准构建（标准包）或一份内测构建；
   需要两套产物的用例（`mode-switch-plain`）自己按需构建到 `dist-plain/`，不许手工复制目录。
3. **禁止真机/模拟器测试混入门禁。** `device/` 层需要 AVD，只人工跑；CI 与本门禁不启动模拟器、不做 APK 构建
   （`assembleRelease` / `assembleDebug` 都不进门禁）。
   例外只有一条：`checks` job 里的 `cd android && ./gradlew help` —— 它只做**配置阶段求值**（不编译、不打包、
   不需要模拟器），用来拦「gradle 脚本坏了 → 打不出包」，见第 9.6 节。
4. **禁止为无关用例反复重建产物。** 改 `docs/`、改单测时重建 dist 属于浪费，L0/L1 不做。
5. **禁止用 skip 掩盖失败。** 期望红的用例照常执行，只在基线清单里标注 `known-red` + 原因；
   `known-red` 条目必须关联 Issue，修好后从清单删除。
6. **禁止并发跑多个集成文件。** 内存有限，多个 Chromium + 多份静态服务会 OOM；串行。

## 6. 超时与中止规则

- **单步 > 8 分钟且无输出 → 中止该步，记为基线失败**，并记录「命令 + 最后一行输出 + 时间戳」。
- **不重试同配置。** 同一条命令同一配置第二次仍超时/失败，说明是稳定问题，进基线或开 Issue；
  重试只允许「换配置」（例如换端口 / 换产物 / 换并发度）并写明换了什么。
- 单个集成文件 > 5 分钟视为异常（正常 10~60s），先查是否连到了别人的静态服务或产物陈旧。

## 7. 与 Issue 规范的关系

- 修红用例（改断言对齐现状 / 改为可注入 / 加夹具）→ 归 `docs/ISSUE-STANDARD.md` 的「修复」类型：
  要有修复前失败输出 + 修复后同路径回归输出。
- 真实产品缺陷不许在测试里打圆场：写进 Issue，测试保持红并登记进基线 `known-red`。
- 每次门禁改造都要能用一条命令复现结论，不接受「我本机跑过是绿的」。

## 8. 一页速查

| 场景 | 跑什么 | 预期耗时 |
| --- | --- | --- |
| 改一个 `.ts` 逻辑 | `tests/which.mjs --git --layer unit` | < 20s |
| 改 UI / 设置页 / 渠道 | `tests/which.mjs --git`（域内 1~2 个集成） | 1~2min |
| 改构建脚本 / 产物注入 | `internal-build` + `auto-title` | 2~3min |
| 改 `android/` 的 gradle 脚本（`build.gradle` / `variables.gradle`） | `pnpm exec cap sync android && cd android && ./gradlew help --no-daemon`（先看第 9.6 节） | 20~40s（warm 缓存） |
| 改 `deploy/dl-release/`（发布服务端 / APK 门禁 / 变体） | `pnpm run test:dl-release`（37 条）或 `node tests/run-layer.mjs server` | < 15s |
| **新增 / 修改一道 CI 门禁** | `node tests/run-layer.mjs unit --only gate-negative-controls`（先看第 9 节） | < 30s |
| **判断一条红是 flaky / 真红 / runner-dependent** | `node tests/run-layer.mjs --cross-runner-scan`（先看第 11.5 节） | < 10s |
| **改跨 runner 判据本身** | `node tests/run-layer.mjs --selftest-cross-runner`（四拍自证 + 两条负向对照） | < 10s |
| **改合并批次 / 逐文件判定本身**（`merged-*` / `tap.mjs` / `merge-verdict.mjs`） | `node --test tests/unit/runner-verdict-self-check.test.mjs`（必失败→FAIL / 体外的失败→FAIL / 改回旧逻辑→自检红，先看第 11.8 节） | < 5s |
| 合并候选 | L0 + L1 | < 5min |
| 发版前一次 | `npm test` + `npm run test:integration -- --baseline` | 10~15min |
| 真机 / 链接导入原生 | `npm run test:device`（人工，需 AVD） | 3~8min |

---

## 9. 门禁自身的负向对照（Issue #369）

**一条硬规矩：新增或修改一道门禁时，必须同时提交一条负向对照。没有负向对照的门禁不许进 CI。**

### 9.1 为什么这条规矩必须写死

门禁的两种坏法症状完全一样 —— **都表现为 CI 绿**：

| | 坏法 | 例子 |
| --- | --- | --- |
| A | 门禁**脚本**坏了：规则被删、被改宽、只对眼熟写法生效 | 删掉一条脱敏规则、把 `>=20` 行重复判据改成 `>=200` |
| B | 门禁**命令行**被改软：换成 `true`、悄悄加 `--warn`、少传一个扫描目录 | `"lint": "echo ok"`、`"check:test-layout": "… -- --warn"` |

只测「注入缺陷 → exit≠0」只能钉住 A。B 更隐蔽：脚本一个字没改，但已经什么都不检查了。
所以负向对照必须同时钉住 script **字符串**（见下文的 `scriptExpect`）。

这条规矩不是洁癖：#369 立项的起因就是 `check:legacy` —— beta.8 漏了 polyfill，WebView ≤92 整包解析失败
（静默白屏），而所有门禁都是绿的；而 #362 盘点 12 道 CI 门禁时，有 6 道连一条负向对照都没有。

### 9.2 统一模板（四拍，缺一不可）

```
① 正例：干净仓库 → exit=0          （没有这一拍，「注入→红」可能只是门禁恒红）
② 注入：把 fixture 拷成真文件       （门禁只认真实路径，落在它真会扫的位置）
③ 红：exit≠0 **且报错点出注入物**   （红在别的原因上不算数）
④ 还原 → exit=0                     （证明「红」是注入引起的，不是恒红）
```

实现只有一份：`tests/gates/lib/gate-negative-harness.mjs` 的 `assertNegativeControl()`。
用例表 `tests/unit/gate-negative-controls.test.mjs` 里**一行 = 一道门禁**，加门禁 = 加一行。

两个细节容易漏，写在这里省得再踩：

- **命令行从 `package.json` 解析，不在测试里抄一份**：`scriptExpect` 断言 script 字符串没被改软，
  改了就先红。测试里抄一份命令，等于两处各写一遍真相，改一处另一处永远绿。
- **还原必须写在 `finally` 里**：用例失败也不能把仓库留在「有违规文件」的状态。否则下一个人跑
  `check:hygiene` / `check:test-layout` 会看到一条和他毫无关系的红 —— 那是最容易被"顺手注释掉"的红。
  收尾还有一条自检用例，专门查注入物有没有残留。

### 9.3 用例为什么在 `tests/unit/`，fixture 为什么在 `tests/gates/`

- `scripts/check-test-layout.mjs` 只允许 `tests/{unit,integration,regression,device,e2e}/` 放
  `*.test.mjs`，且层级目录内不许建子目录 —— `tests/gates/*.test.mjs` 会被它判成
  `layer-placement` + `orphan`（硬规则、不可基线化）。给门禁开一个它自己拦不住的口子，以后人人都能照着开。
- CI 的单元层只跑 `pnpm test`（`node tests/run-layer.mjs unit`）。不在 `LAYERS` 里的目录写多少用例都是
  #368 那个坑：**写了、没人跑、不会红**。这条 issue 治的就是这个病。

所以：**用例进 `tests/unit/`（`run-layer` 枚举得到、CI 每次跑），必错输入与骨架进 `tests/gates/`。**

### 9.4 现状清单（2026-11-21，#697 后 ci.yml 里的 32 道门禁）

> 口径：ci.yml 里每一条 `run: pnpm run <gate>` 算一道。单元层那一步是 `run: pnpm test`（整层），不在此列。

| 门禁 | 负向对照 | 注入 / 反例 | 落在哪 |
| --- | --- | --- | --- |
| `check:hygiene` | ✅ 注入 | Windows 盘符绝对路径（文件里写死本机路径） | `tests/unit/domain10-release-gate-matrix.test.mjs` |
| `check:dup-impl` | ✅ 注入 | 整份复制已有实现 | 同上 |
| `check:bundle-target` | ✅ 注入 | 产物里追加 `?.` / `??=` | 同上 |
| `check:manifest` | ✅ 自带 | `invalid-*.json` 反例 + 事故清单逐条报出 | 同上 |
| `check:matrix` | ✅ 自带 | 截断档位 / AVD 版本不符 / 路径缺失 | `tests/unit/matrix-config.test.mjs` |
| `check:ip` | ✅ 自带 | 版本号不报 vs 真写死地址照报 | `tests/unit/check-ip-version.test.mjs` |
| `check:legacy` | ✅ CI 注入 | CI 往产物副本追加 `?.` / `??=` | `.github/workflows/ci.yml` |
| `check:redact` | ✅ CI 自检 | CI 跑 `check-redact.mjs --selftest` | `.github/workflows/ci.yml` |
| `check:test-layout` | ✅ 注入（#369） | 造一个跑不到的用例（孤立子目录）；**#408 起 CI 带 `--strict`**（fixture 散放 / 基线失真也阻塞） | `tests/unit/gate-negative-controls.test.mjs` |
| `check:test-duplication` | ✅ 注入（#369） | 整份复制一份用例文件；**#408 起阻塞**（R1 逐字 ≥20 行，存量 21 组登记在 `tests/test-duplication-baseline.json`，只减不增） | 同上 |
| `type` | ✅ 注入（#369） | fixture 里的 TS2322 拷进 `src/` | 同上 |
| `lint` | ✅ 注入（#369） | fixture 里的 `debugger` 拷进 `src/` | 同上 |
| `build:internal` | ✅ 注入（#369） | 临时副本里注入语法错模块并让 entry 真的 import | 同上 |
| `build`（黄金 job 的标准包） | ✅ 注入（#369） | 同上，N3 对**两条命令**都断言「注入后必红」（共用 `scripts/build.mjs`） | 同上 |
| `test:golden` | ⚠️ **缺口**（自带硬门，非检测对照） | 缺产物 / 产物种类不对 → 直接红、不 SKIP；端到端负向对照要真浏览器，见 `KNOWN_GAPS` | `tests/run-golden.mjs` |
| `check:log-coverage` | ⚠️ **缺口** | 脚本自带 `--selftest`（3 个反例），但 CI 调用没带 flag | `scripts/check-log-coverage.mjs` |
| `check:i18n`（#413 接线） | ✅ CI 注入 | CI 删掉 zh 的一条真实文案（`compatBootTitle`）→ R1「只在 en 里」必红，还原后绿 | `.github/workflows/ci.yml` |
| `check:endpoints`（#413 接线） | ✅ CI 注入 | CI 往 `src/` 塞一份端点地址字面量（从 `config/endpoints.json` 读）→ 必红，删掉后绿 | `.github/workflows/ci.yml` |
| `check:capabilities`（#413 接线） | ⚠️ **缺口** | 默认 warn 档永远 `exit 0`（10 处能力假设缺陷在案，见 `KNOWN_GAPS`）；`--strict` 档才有红可打 | `scripts/check-capabilities.mjs` |
| `test:dl-release`（#415 接线） | ✅ 注入（#415） | 往 `deploy/dl-release/test` 拷一条**必红**用例 → `node --test deploy/dl-release/test/*.test.mjs` 必须 exit≠0，删掉后 exit 0（N7；同时钉住「入口被加 `\|\| true` / `continue-on-error` / glob 改窄」三种软化） | `tests/unit/gate-negative-controls.test.mjs` |
| `check:doc-refs`（本轮接线） | ✅ CI 注入 | CI 往 `docs/` 塞一份写着不存在路径的 md → 必 exit 1，删掉后 exit 0 | `.github/workflows/ci.yml` |
| `check:case-collision`（#557 新建） | ✅ CI 注入 + 自带 `--selftest` | CI 在 `src/` 下造一对仅大小写不同的模块文件（同一个名字、只差大小写）→ 必 exit 1，删掉后 exit 0；脚本 `--selftest` 另有 4 条反例（R1 路径 / R2 目录 / R3 模块 stem / `.d.ts`）+ 2 条正例 | `.github/workflows/ci.yml` / `scripts/check-case-collision.mjs` |
| `check:db-version`（#547 新建） | ✅ CI 注入 | CI 往 `tests/unit/check-ip-version.test.mjs` 追加一行 `indexedDB.open('chat-demo', 99)` → 必 exit 1，且必须报出「文件:行 硬编码版本 99」并指到注入文件（两条都查，防止扫描目录被改窄后仍然 exit≠0），还原后 exit 0；脚本另有 `--selftest`（13 条：注释/字符串放行、变量放行、`openDB<…>` 泛型必报） | `.github/workflows/ci.yml` / `scripts/check-db-version.mjs` |
| `check:keystore`（#697 修 + 接线） | ✅ 注入 + CI 注入 | 形状四拍：键名错 / 路径错 / 口令错 / 别名错 → exit 1 且点名；缺文件 → exit 2；**指纹不符 → exit 1 且点名「期望 X 实际 Y（来源 config/appIdentity.json）」**（#697 之前这条是死代码：期望值还去 `android/app/build.gradle` 找字面量，而 #271 之后它只记在 `config/appIdentity.json`，于是比较分支永不进入） | `tests/unit/gate-negative-controls.test.mjs`（N8）/ `.github/workflows/ci.yml` |
| `check:consume-api`（#487 接线） | ✅ CI 注入 | CI 往 `src/` 塞一条**白名单外**的 `/api/v1/**` 路径字面量（`/api/v1/__gate_neg_not_whitelisted`）→ R3 必 exit 1 且指到注入文件，删掉后 exit 0（不用脚本自带的 `--selftest`：那条只证明 R2，白名单 R3 才是主判据） | `.github/workflows/ci.yml` |
| `check:public-artifact-redaction`（#745 第 3 步新建） | ✅ 自带（单测五拍） | **不在 ci.yml**（发布前手动跑，需要已构建的 APK；不计入本节 32 道计数，见 `docs/RELEASE-CHECKLIST.md` B3b）：临时产物目录里塞内网 IP → exit 1 且点名到 config 字段；端口表从配置动态派生（换配置后旧端口不报、新端口才报）；`--allow-host` + `--allow-port` 双给 → exit 0 且打印放行清单，**只给主机仍然红**；非 zip / 空目录 / 无输入 → exit 2；XML 命名空间与 `redacted.local` 跳过并计数、不误报 | `tests/unit/public-artifact-redaction.test.mjs` |

「登记」不是给人看的注释：`tests/unit/gate-negative-controls.test.mjs` 的 `N6` 用例会读
`.github/workflows/ci.yml`，**每出现一条 `run: pnpm run <gate>`，登记表里就必须有一条**，否则这个用例红，
并直接告诉你「该在哪里补一条负向对照」。缺口写进同一个文件的 `KNOWN_GAPS`（要带原因、关联 Issue、修法），
缺口一旦补上，`N6` 会再红一次提醒你删条目 —— 缺口可以存在，但不许静默。

**C8 的判据是派生的，不是手写清单（#407，第 3 次复发后改）。**
`tests/unit/contract-c8-gate-negative.test.mjs` 原先维护一张「门禁名 → 正则」的手写表（`CI_MARKERS`）：
每多一道登记在 ci.yml 上的门禁，就得有人记得回来补一行。而「记得」正是这一族门禁全部失效的原因本身 ——
同一形状在一天内红了三次（#413 `check:endpoints` / #413 `check:i18n` / #463 `check:doc-refs`），
三次都不是门禁坏了，而是那张清单少一行。现在改成现场派生，每一环都从盘上读：

    ci.yml 的 `pnpm run <gate>` → package.json 那条 script 命令 → 命令里的 `scripts/*.mjs`
      → ci.yml 里**真在跑这个脚本、且带判定**的步骤（`if …; then … exit 1` 或 `--selftest`）

任何一环断了直接红，报错指到**该补的那一环**（补 ci.yml 的对照步骤），而不是回来补测试里的一行正则。
"只 echo 不判定"的步骤不算对照：`exit 1` 必须是独立命令行，文案里出现 `exit 1` 不算数。

### 9.5 `build` 为什么**能**做负向对照（成本实测，别再当"不适用"）

`build`（`node scripts/build.mjs --internal`）曾被登记为"慢，可能不适用"。实测**没必要放弃**：

| 口径 | 实测耗时 |
| --- | --- |
| 单次内测构建（`build:internal`） | ~2.5s |
| 负向对照全套（临时副本 + 正例构建 + 注入构建 + 还原构建） | ~6s |

代价这么低是因为两条口径：

1. **注入在仓库的临时副本里做**，不碰工作树：只拷 `src/`、`shared/`、`config/`、`scripts/`、
   `package.json`、`rspack.config.ts`、`tsconfig.json`、`LICENSE`（约 8 MB），`node_modules` 用软链
   （305 MB 不复制）。
2. **注入必须让 entry 真的 import 那个坏模块**：rspack 只编译**进图**的模块，孤立丢一个语法错文件到
   `src/` 底下不会红（实测：编译成功、`[build] OK`）。所以用例往副本的 `src/main.tsx` 末尾加一行
   `import './…-probe'` —— 这一步才是"注入"。

因此 `build` 有真负向对照，不再登记为"不适用"。ci.yml 里的**两条**构建命令（`build:internal` 与黄金 job 的
`build`）共用同一个包装脚本，N3 对两条都做了一遍，避免出现「内测包有对照、标准包没有」的半覆盖。

### 9.6 `gradle help`：**JS 侧全绿 ≠ 出得了包**（Issue #563）

**这句话是这条门禁唯一的存在理由，请照着念一遍**：`type` / `lint` / `pnpm test` / 产物扫描全绿，
**不等于**这个仓库出得了包。

证据是 #557：main 上 22 道门禁全绿，`./gradlew` 直接 FAILURE —— `android/app/build.gradle:148`
把 Groovy 闭包的箭头写在了 `}` 外面（`{ String name, int from } ->`），gradle 在**配置阶段**
就 `Unexpected input: '->' @ line 148` 退出，APK 根本走不到编译。这一行**没有任何 JS 侧门禁看得见**：
tsc 不读 `.gradle`、oxlint 只扫 `src`、单测不碰 Android、产物扫描只看 `dist/`。
所以补的这一条不在「JS 门禁」的延长线上，它补的是一个**盲区**：

| 项 | 值 |
| --- | --- |
| 步骤 | `cd android && ./gradlew help --no-daemon --console=plain`（`checks` job，排在 `Build (internal)` 之后） |
| 前置 | `pnpm exec cap sync android`（`android/capacitor-cordova-android-plugins/` 与 assets 是 **cap 生成物、不入库**；不加这一步，干净 checkout 上必然红在 `Could not read script …/cordova.variables.gradle`——那是假红，不是门禁在工作） |
| 缓存 | `~/.gradle/caches` + `~/.gradle/wrapper`（`actions/cache`，key 含 wrapper / gradle 脚本的 hash） |
| 上限 | `timeout-minutes: 5`（冷缓存首跑要下 `gradle-8.14.3-all`）；超时即红，不静默拖慢 PR |
| 实测（CI，冷缓存首跑：`~/.gradle` 全空，gradle 发行版是真下的） | **34s**（run `44741030036`，`13:05:17 → 13:05:51`）；同 job 全程 142s → 远低于「>3 分钟才退到只在 main 跑」的阈值，故 PR 与 main 都跑 |
| 实测（本机 warm 缓存，Linux + JDK 21） | 首次 35.6s / 二次 19.9s；**注入 #557 那个语法错后 12.7s FAILED**，报错逐字复现 `151: Unexpected input: '->'`；还原后 19.9s OK |
| 为什么不用 `assembleRelease` | 太贵（真下 AGP 依赖 + 打 dex，分钟级）。`help` 属于 configuration 阶段，`build.gradle` / `app/build.gradle` / `capacitor.build.gradle` / `settings.gradle` 都会被求值——语法错、`apply from` 到不存在的文件、未知属性全在这一步红 |

**它不是一道 `pnpm run <gate>`，所以**
（1）不进 9.4 的 25 道计数；
（2）不走 C8 的「gate → script → 真判定步骤」派生链（那套链条的起点是 `package.json` 的 script）；
（3）负向对照因此**不进 ci.yml**（每加一次注入就要多跑一次 gradle，成本与收益不成比例），
而是以「本机四拍 + 结论写进 #563」的形式留证：**正例 OK → 注入 #557 那种闭包语法错 → 必红且报错点对 → 还原 → OK**。
以后要加第二条 gradle 类门禁（例如 `./gradlew tasks --all`），先把这条的负向对照补成 CI 步骤，再加新的。


---


## 10. 单命令入口：`test:fast` / `test:full` / `test:affected` / `test:report`（Issue #409）

第 2~4 节讲的是「分几档、判红口径」；这一节讲**手该敲哪一条**。四个脚本都在 `scripts/` 下，
读的是同一份域划分（`tests/domain-map.json`）与同一份实测台账（`tests/timing-baseline.json`），
所以「命令跑的」与「看板写的」不会各说各话。

### 10.1 什么时候用哪个

| 场景 | 命令 | 声明预算 | 实际做了什么 |
| --- | --- | --- | --- |
| 提交前 / 推送前 | `pnpm test:fast` | **≤60s（超出 exit 1）** | `tsc` + L0 快速子集（`tests/unit` 减去 `tests/fast-subset.json` 登记的 20 个慢文件，默认并发 3）+ 黄金套件 4 条主路径 |
| 改完一处、想知道「就这一处该跑什么」 | `pnpm test:affected -- <改动路径...>` | 秒级~1min | 按 `tests/domain-map.json` 的 10 个域挑 unit + regression + golden，并把选中的用例真的跑掉；集成用例只列出、要 `--with-integration` 才跑 |
| 合并前 / 发版前 | `pnpm test:full` | 分钟~20 分钟 | unit 全量 + regression + golden + integration（集成层 `--baseline`，只判「不新增失败」） |
| 想知道「现在整体长什么样」 | `pnpm test:report` | < 2s | 生成 `docs/testing/report.md`（各层文件数/用例数/上次实测耗时、每域功能点覆盖、known-red/flaky 清单） |

三条「为什么这么定」：

1. **快速子集不是「挑重要的」，是「整层减去实测最慢的」**。被去掉的 20 个文件（合计 ≈59s，占 L0 61%）
   仍在 `pnpm test`（CI 每次跑）、`test:full`、`test:affected` 里照跑；名单与逐条理由见
   `tests/fast-subset.json`。用「挑重要的」做子集，第一次改到没挑中的模块就没人拦；
   用「减去最慢的」做子集，覆盖是连续的、可解释的，而且慢下来的原因写在名单里。
2. **60s 是声明值，超了判红**。历史上「L0 目标 <60s」就是这么变成 68s、再没人看的
   —— 所以 `test:fast` 自己比对预算并 exit 1（`--no-budget` 只在排查时用）。
3. **`test:affected` 默认不跑集成层**。集成单文件 3~120s，且基线里有 7 条 known-red；
   默认跑它等于让「快速反馈」变成「等两分钟看一条已知红」。需要时 `--with-integration` 显式打开。
4. **快速子集默认并发 3，而整层 `pnpm test` 仍然串行**。单元用例本来就各有自己的 `mkdtemp`
   与 `TEST_TMP_DIR`，端口一律 `listen(0)` 原子分配；唯一会往仓库里写「坏文件」再还原的是
   `gate-negative-controls`（四道门禁的注入/还原），**它不在快速子集里** —— 所以并发跑法没有共享写入。
   并发时子进程输出按条缓冲、跑完补打，不会交错。要复现串行行为：`pnpm test:fast -- --concurrency 1`。
5. **黄金套件固定吃 `dist-standard/`**（`GOLDEN_DIST_DIR`），不去动集成层要的 `dist/`（内测变体）；
   缺产物才构建一次。这样 `test:fast` / `test:full` / CI 黄金 job 三处用的是同一份产物口径。

### 10.2 `test:affected` 的挑选用例口径

- 映射表：`tests/domain-map.json`，**10 个域**（与 `docs/testing/coverage/domain-*.md` 的域划分一致），
  每个域一节 `paths`：`src 侧 glob → 用例 glob`。
- 一条路径可以命中多个域 → 取**并集**（宁可多跑，不漏跑）；命中几个域会逐条打印出来。
- 挑不出来时不静默跳过：`src/` 下未命中任何域 → 回落 unit 全量并说明原因（与 `tests/which.mjs` 同口径）；
  文档改动 → 0 个用例；改用例本身 → 只跑它自己。
- 输出一定包含一行 `命中 N 个文件`，后面跟分层明细（unit / regression / golden / integration）。

与已有的 `tests/which.mjs` 的分工：`which.mjs` 靠「单测 import 反查 + 人工规则」，
适合**未知变更**（改了哪个文件都能找回 import 它的单测）；`test:affected` 靠**域级 glob 映射**，
适合「我知道改的是哪个域，要把这个域的用例一次挑全」（含 regression / golden / integration）。

### 10.3 看板（`docs/testing/report.md`）

- 生成器：`scripts/test-report.mjs`；**不接 CI（本单）**，接线留 follow-up（`ci.yml` 同时有别的改动在进行）。
- 文件数**实时**清点；用例数与耗时只来自 `tests/timing-baseline.json` 的上次实测（逐条带 `measuredAt` 与采集命令）。
- 重测：`pnpm test:report -- --measure`（重跑 unit / regression / golden / gates 并写回台账；
  集成层 ≈20 分钟，不在本地重测，保留 #365 的全量实测值并注明来源）。
- 每域功能点覆盖**只汇总** `docs/testing/coverage/feature-coverage.md` 的行级状态，不重新判定覆盖。

---

## 11. flaky 与重跑（Issue #406 / #456）

一句话：**重跑只允许用来「区分偶发与稳定红」，不允许用来「把红洗白」；重跑也看不见「换台机器才红」，所以还有第二条判据（跨 runner）。**

> **#456 修的盲区**：#406 的判据只有一条 ——「同 runner 上红 → 重跑 → 绿 = flaky」。
> 而最常见的 flake 是**同机怎么跑都绿、换 runner 就红**（机器快慢/负载把时序窗口拉开或压扁）。
> 这类在同一台机器上必然复现，所以旧判据**永远登记不到**它：`tests/flaky-registry.json` 长期为空
> 不是「我们没有 flaky」，是「判据看不见这个变量」。实证见 #406（`url-import-stages` case 10：
> 窗口 ≈ 2.4s，慢机连跑 10/10 绿、注入 3s 延迟即 1/1 红）。

### 11.1 机制（已落在 `tests/run-layer.mjs`，不需要改 ci.yml）

| 环节 | 行为 | 证据出口 |
| --- | --- | --- |
| 失败用例 | 自动**重跑 1 次**（`--no-retry` 可关） | 终端 `↻ 红了…按 flaky 判据重跑一次` |
| 重跑通过 | 标 `PASS(flaky)`，当绿放行，但**必须登记** | 终端 `FLAKY <文件>` / `--json` 的 `flaky` 字段 / job summary |
| 重跑仍红 | 真红，照旧失败 | `--json` 的 `results[].ok=false` |
| 连续 3 次 flaky | 进 **quarantine**：默认跳过该用例（`--include-quarantined` / `--case` 可强制跑） | 终端 `QUARANTINED`、job summary |
| quarantine 期间 | **每 7 天**提醒一次修复（同一天只提醒一次） | 终端 `⏰ flaky 每周提醒` |
| 修好（一次就绿） | 连续计数清零、quarantine **自动解除** | `recordPass` 写 `lastGreen` |
| 重跑通过但 21 天内**复发 ≥2 次** | **当红处理**（不再当 flaky 放行，也不进隔离区） | 终端 `⚠ … 按真红处理` |
| **同 commit 换 runner 结论不同**（#456） | 登记 `kind: "cross-runner"`，**当 runner-dependent 上报**（不进隔离区、跑绿不销账） | 终端 `CROSS-RUNNER <文件>` / `--json` 的 `crossRunner` / job summary |
| 每次 run | 写一份**运行记录**（commit + runner 身份 + 负载快照 + 逐文件结果） | `.flaky-runs/*.json`（CI 作为 artifact 上传） |
| 每次 run | **三态**判定（真红 / flaky / runner-dependent）落到终态、`--json` 与 job summary | job summary 的「三态」表 |
| 每次 run | 时序窗口**静态提示**（`waitForTimeout` / 固定 sleep / 依赖动画时长），警告级、不阻塞 | 终端 `⚠ 时序窗口静态提示` / `--json` 的 `timingWarnings` |

登记簿：`tests/flaky-registry.json`，每条 `{ test, kind, firstSeen, count, lastSeen, runners[], evidence[] }`
+ `streak` / `history` / `quarantinedAt` / `lastGreen` / `lastRedAt`
（`kind` = `"same-runner"` | `"cross-runner"`；形状与判据见 `scripts/flaky-registry.mjs` 文件头）。
**别手改字段**：只能通过跑测试更新；唯一需要人介入的是把 quarantine 里的用例修掉、把 cross-runner 的用例改成等终态。

判据的单测：`tests/unit/flaky-registry.test.mjs`（16 条：8 条 #406 的复发/隔离规则 + 8 条 #456 的跨 runner /
三态 / 静态提示，其中 5 条是「不该命中」的负向对照）。

### 11.2 什么算 flaky，什么不算

- **算**：同一份产物、同一台机器上「第一次红、重跑绿」，且第一次失败里没有稳定的断言结论
  （时序、首帧、端口竞态、动画帧数）。
- **不算**：`SKIP(env)`（产物缺失/端口撞车是环境，重跑只会再 SKIP 一次，所以**不重跑**）；
  合并批次的单文件兜底（那是「批内串扰」，已有独立重跑，见 `UNIT_SOLO`）。
- **禁止**：为了让 CI 变绿而放宽断言、加 `--retry 3`、把红登记成 known-red。写死端口 → 直接改
  `serveDist(dir, { port: 0 })` 或读 `process.env`（静态检查见 §11.3）。

### 11.3 假绿治理的两个静态门禁

| 门禁 | 命令 | 口径 |
| --- | --- | --- |
| 硬编码端口 | `node scripts/check-hardcoded-ports.mjs`（`pnpm run check:hardcoded-ports`） | 测试里出现 5181 / 5291~5296 / 5399 / 5418 / 8090 且**没有 env 出口** → 警告；`--strict` 时退 1 |
| 产物一致性 | 各用例的 `verifyAppUrl()` / `verifyDist()`（见 docs/testing.md §4） | 端口上 serve 的不是这份产物 → `SKIP(env)`，不是通过 |

硬编码端口门禁自带负向对照（`tests/unit/check-hardcoded-ports.test.mjs`：裸端口/ env / 注释 / 栈帧夹具四类
各一条 + 「仓库现状零警告」回归锁），并且**只警告不阻断**——接线到 CI 的 `checks` job 要改 `ci.yml`，
留在 #406 的 PR 描述里给 diff。

### 11.4 known-red 的处置纪律（本单把 7 条清零时的口径）

每一条 known-red 必须先归因，再动手，四类互斥：

| 类 | 判据 | 处置 |
| --- | --- | --- |
| **A 断言过时** | 产品契约已经改了（有提交/注释为证），测试没跟上 | 改断言、删基线条目 |
| **B 测试自身 bug** | 夹具与产品契约冲突、选择器命中错元素、子进程缺预加载、手势预算不足 | 修测试、删基线条目 |
| **C 真实产品缺陷** | 契约明确要求、产品确实没做到 | **不在测试 PR 里改产品**：保留基线 + 开 `[bug]` issue，基线 `followUp` 指向它 |
| **D 功能下线/重复** | 功能已删，或该契约已有专用文件覆盖 | 删测试（段）、删基线条目，并在注释里写明覆盖去哪了 |

**删条目的硬要求**：跑绿 ⇒ `--baseline` 会报 `FIXED?` 并要求删条目；反过来说，条目没删就等于没修好。
 (test: known-red 清零（7→1）+ flaky 自动登记 + 硬编码端口检查（#406）)

### 11.5 三种结论的定义与处置（三态，#456）

失败**必须**被归到下面三种之一。含糊成「红了」是本单要治的病：同样一条红，「真红」要改产品/断言，
「flaky」要登记并观察，「runner-dependent」要改**等终态**——三种处置互斥，判错方向就是白干一天。

| 三态 | 定义 | 判据（代码里怎么判） | 处置 |
| --- | --- | --- | --- |
| **真红** | 同一台 runner 上重跑**仍红** | `result.ok === false` 且重跑也 false（`attempts=2` 都红） | 修产品或修断言。**不是 flake，别重跑洗白** |
| **flaky**（same-runner） | 同一台 runner 上第一次红、**重跑绿** | `result.flaky === true` | 自动重跑 + 登记；连续 3 次进 quarantine（每周提醒） |
| **runner-dependent** | **跨 runner 结论不一致**：同 commit 同用例，A 机器红、B 机器绿 | `scanCrossRunner()` 命中 → `kind: "cross-runner"` | **必须改成等终态（`until` 轮询终态），不允许加 `sleep` / 提高超时** |

**红线（本单的核心规矩）**：

> **`cross-runner dependent` 的用例必须改成「等终态」，禁止用 `sleep` / `waitForTimeout` / 调大超时把窗口撑开。**

理由不是洁癖，是**它根本不解决问题**：窗口是产品侧的速度，机器越快窗口越窄；把等待时间调大只是让
快机器上更容易输，慢机器上继续掩盖竞态。`#406` 的 case 10 就是范例 —— 判据是「等终态轮询 + 前置断言
`取消落在导入中段`」，删掉了固定 `waitForTimeout(3000)`，窗口万一没兜住就**当场报红说明原因**，
而不是静默变绿。可复用的写法见 `tests/integration/url-import-stages.test.mjs` 的 `until()` / `gate`。

两条配套纪律：

- **cross-runner 条目不进 quarantine**：隔离＝跳过＝不再产生证据，等于把这条 flake 从视野里删掉。
- **cross-runner 条目跑绿不销账**（不写 `lastGreen`）：红的是别的 runner，你本地跑绿只说明「这台本来就绿」。

### 11.6 跨 runner 判据：记录 → 聚合 → 登记

判据只有一句话：**同 commit + 同用例 + 结果不同 + runner 不同 → `kind: "cross-runner"`**。
落地分三步，缺一步判据就不成立：

| 步 | 做什么 | 在哪 |
| --- | --- | --- |
| 1 记录 | 每次 run 写一份 `{ commit, runner, results[] }`；runner 身份 = CI 的 `runner.name`（本地 = hostname + 负载档），附负载快照 `loadavg/cpus/freeMem` | `tests/run-layer.mjs` → `.flaky-runs/`（`FLAKY_RUNS_DIR` 可改） |
| 2 聚合 | 把同一 commit 的记录放到一起，逐用例比结论 | `node tests/run-layer.mjs --cross-runner-scan --record-dir <dir>`（纯 Node、不跑用例、< 1s） |
| 3 登记 | 命中的写进 `tests/flaky-registry.json`（`kind`/`runners`/`evidence`），并出 job summary | 同上；同一份证据不重复计数（幂等） |

「runner 不同」的口径（为什么要给本地也编个身份）：CI 每个 job 一台新 VM，`runner.name` 不同就是不同机器；
本地只有一台机器，但它在「空载 / 正常 / 满载」三种状态下就是三种执行环境 —— 这正是要看见的变量，
所以本地身份是 `local:<hostname>#<负载档>`（档位按 `load1/cpus` 分：<0.5 空载 / <1.5 正常 / 否则满载；
`TEST_RUNNER_LOAD=idle|normal|busy` 可显式注入）。`SKIP(env)` **不算绿**：拿它当绿会把「产物没构建」说成 flake。

不命中的四条边界（都有单测钉住）：同 runner 的红→绿（那是 flaky）、跨 commit（那是修好了）、结论一致
（都红/都绿）、只有 `SKIP(env)` 的差异。

**自证**（这个判据本身怎么证明不是空跑）：

```bash
node tests/run-layer.mjs --selftest-cross-runner
```

它造一个**只在慢环境红**的临时用例（可注入延迟 `SELFTEST_CLICK_DELAY_MS` vs 固定的中间态窗口
`SELFTEST_WINDOW_MS`），在同一台机器上用两个负载档各跑一次，然后过 6 拍：快 runner 绿 / 慢 runner 红 /
判据命中并登记（`kind: "cross-runner"`、`runners` 两条、`evidence` 两条）/ **两个 runner 都红 → 不登记** /
**同一 runner 红→绿 → 不算 cross-runner** / 静态提示必须命中。临时用例跑完即删，**不进仓库**
（它本身就是一条「坏用例」，留着等于用错误示范教人写测试）。

### 11.7 时序窗口的静态提示（警告级，不阻塞）

每次跑任意层都会顺手扫一遍选中用例的源码，把「靠时间而不是靠终态」的写法列进终端与 job summary：
`waitForTimeout(...)` / `sleep(...)` / `setTimeout(..., N)` / 依赖动画时长（`animationend`、
`transitionDuration` 等）。注释里的写法与字符串里的文本不算（本仓大量注释在解释「为什么删掉它」，
误报会把警告变成噪音）。

- **是警告不是门禁**：这类写法要「改」，不是要「卡」。卡住它只会让人把断言写得更松。
- 现状（2026-11-20）：`tests/{unit,integration,e2e,device}` 里 54 个文件、317 处命中 —— 存量清了才谈得上
  把它升级成阻塞门禁（那属于后续单，不在 #456）。
- 全量清单在 `--json` 报告的 `timingWarnings` 里（终端只打前 8 个文件，避免刷屏）。

### 11.8 合并批次的判定：**不许**只看 `test()` 的 promise（Issue #501，P0）

一句话：**合并批次里「这条用例红了没有」只能取 `node:test` 自己给出的结构化结果；`test()` 返回的
promise 兑不兑现，与用例过没过无关。**

`node:test` 的 `test()` 在**断言失败时依然 fulfilled**（红只体现在 node 自己的报告与进程退出码上）。
`tests/helpers/merged-tracker.mjs` 原来就靠它判绿，于是合并批次里：

```text
assert.equal(1, 2)   →  << FILE … PASS tests=1 pass=1 fail=0   退出码 0
```

一个进程跑 N 个文件时又没有「单文件退出码」可比，失败就被彻底吞掉 —— unit 层「全绿」的结论
整个建立在这个看不见断言失败的运行器上。#501 的修法是三层，缺一层都不算修好：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| ① 用例体记账 | `tests/helpers/merged-node-test.mjs` + `merged-tracker.mjs` | 包住用例体/嵌套 `t.test`/钩子，捕获**抛出来的错误** → 能指名道姓「哪条红了」 |
| ② node 的判定（**权威**） | `tests/helpers/tap.mjs` + `merge-verdict.mjs`，runner 用 `--test-reporter=tap --test-reporter-destination=<file>` 取 | 钩子抛错、超时、`t.plan` 数量不符、未捕获异常挂到用例上……**用例体里看不见的失败只有这层能抓** |
| ③ 整批复核 | `tests/helpers/runtime.mjs`（`runMergedBatch`） | 逐文件计数之和必须等于 TAP 总数、失败数不许少于 TAP 报的；对不上 ⇒ `unreliable` ⇒ 整批退到单文件进程复核（退出码是权威），**绝不放绿** |

三条硬规矩：

1. **不许用「用例数」之外的信号替代判定**：只看进程退出码 → 归因不到文件；只看 promise → 看不见断言
   失败；两者都会被判成假绿。
2. **对不上就红，不许降级成绿**：TAP 与逐文件记账不一致时，正确动作是「退到单文件进程复核」，
   不是「按批内结果放绿」。
3. **自检必须咬住**：`tests/unit/runner-verdict-self-check.test.mjs` 三拍 —— 必失败用例必须 FAIL、
   用例体外的失败（`t.plan`/钩子）必须 FAIL、**把判定改回旧逻辑必须变红**。改 `merged-*` / `tap.mjs` /
   `merge-verdict.mjs` 时这条必须绿；它红了说明判定被改软了，不是「用例过时」。

> 顺带钉住的另一个假绿（#501 自检时发现）：`NODE_TEST_CONTEXT` 会被子进程继承。合并入口继承它就不走
> 自己的 reporter；单文件 `node --test` 继承它会打印「run() is being called recursively…skipping running
> files」然后 **exit 0**（一条用例没跑却报绿）。`helpers/runtime.mjs` 现在统一剥掉这两个 env。

### 11.9 INFRA：runner 自己崩了，不算用例失败（Issue #611 / 裁决 #614）

一句话：**`node --test` 的 IPC 反序列化失败是真红的一种，但它不是「用例失败」；判定要把它认出来、
单独重跑一次，然后**仍然按红上报**（裁决 #614），只是结论必须写清是哪一种红。**

CI 曾出现过这种红，同一份代码本地三种跑法（单跑 / `run-layer --case` / 整层 186 文件）全绿：

```text
>> tests/unit/domain05-download-state-machine.test.mjs
#   ✓ 206 连续分块…                                  ← 用例已经跑出 ✓
failureType: 'uncaughtException'
error: 'Unable to deserialize cloned data due to invalid or unsupported version.'
stack: … node:internal/test_runner/runner:354 → FileTest.parseMessage
```

红在 `node --test` **父进程反序列化子进程消息**这一层，不是任何一条断言。判据是**三条同时命中**
（`tests/helpers/merge-verdict.mjs` 的 `INFRA_IPC_SIGNATURE`，也是 `tests/flaky-registry.json`
里 `infraSignatures` 登记的那份定义）：

| # | 判据 | 断言失败为什么不会命中 |
| --- | --- | --- |
| ① | 文案 `Unable to deserialize cloned data due to invalid or unsupported version` | 文案本身可能被抄进断言信息（本仓库的对照用例就这么干），所以单靠它不算 |
| ② | `failureType: 'uncaughtException'` | 断言失败是 `testCodeFailure` |
| ③ | stack 含 `node:internal/test_runner` | 断言的 stack 落在 `tests/…`（reporter 帧也可能带 `node:internal/test_runner`，所以①③之外必须②） |

行为（`withInfraRetry`，在 `tests/run-layer.mjs` 的单文件判定处调用）：

| 情形 | 判定 | 处置 |
| --- | --- | --- |
| 三条命中 + 单文件重跑**通过** | `PASS(INFRA-RETRIED)` | 绿，但**不进 flaky 登记簿**（这不是碰运气的 flake）；终端 / `--json` / job summary 各留一份名单 |
| 三条命中 + 重跑**仍同一签名** | `FAIL(INFRA)` | **CI 红**（#614），结论写「不是用例失败，属 runner IPC 崩」+ 指向 #611 |
| 三条命中 + 重跑变成**断言红** | `FAIL`（TEST_FAIL） | 按真红上报：INFRA 不许顺手把真红洗成基础设施问题 |
| 未命中 | 原判定 | 一步都不省（`#406` 重跑 / `#487` 降级 / 基线比对照旧） |

三条硬规矩：

1. **登记的是签名，不是文件**：`tests/flaky-registry.json` 的 `infraSignatures[].tests` 恒为空数组，
   `mustNotMask` 写明「这是 runner 问题，不许用来掩盖断言失败」。谁把某个用例加进去换绿都是违规。
2. **负向对照是这条规矩的载体**：`tests/unit/runner-infra-classify-611.test.mjs` 八拍，其中三拍是
   负向对照 —— 真断言失败（`assert.equal(1, 2)`）必须仍判 TEST_FAIL、把 IPC 文案抄进断言信息仍判
   TEST_FAIL、INFRA 之后重跑出断言红必须回落成 TEST_FAIL。**改了判定先跑它**。
3. **降复发选的是「减小日志体积」而不是「排除出合并批次」**：这条 IPC 通道只在 `node --test`
   （单文件跑法）里存在，合并批次是同一进程内顺序 `import`、根本没有这条通道 —— 把该族排除出批次
   只会让它**更常**走 `node --test`，复发概率是升不是降。所以改的是 `tests/fixtures/domain05/table.mjs`：
   表驱动用例**绿时只打一行汇总**，红了才逐行打失败行（含期望/实际，诊断能力不减），
   把常态日志从「行数 × 一行」压到 1 行。

### 11.10 合并批次的跨文件串扰与 `DEGRADED` 阈值（Issue #513）

一句话：**`DEGRADED > 5` 视为回归，去查串扰，不许当常态。** `DEGRADED` 记的是「结论靠换个进程
再跑一次才对」的文件数，两种成因分开写理由：**批次资源不足**（崩溃/超时 → 串行重跑绿）与
**批次跨文件串扰**（批内红 → 单文件重跑绿）。串扰型从前不计入 `DEGRADED`（summary 里恒为 0），
于是「23 个文件批内红、单跑复核绿」被计数口径直接抹掉 —— 本单第一件事就是把它记进账。

#### 为什么会有串扰（三类机制，都有实测证据）

合并批次（#366）是「一个进程顺序 `import` 十几个文件」。`registerHooks()` 装的解析 hook
**没有反注册 API**、ESM 模块缓存也不会回滚，所以：

| # | 机制 | 实测形态 |
| --- | --- | --- |
| ① | **替身泄漏** | `api-key-failure-374` 调 `installChatBridge()`，把 `diagnostics/collector` 这个模块说明符（解析到 `src/services/diagnostics/collector.ts`）换成 `chat-stubs/collector.mjs`（没有 `recordError`）。同批后面的 4 个 `attachment-*` 加载即失败：`does not provide an export named 'recordError'`。单跑必绿 |
| ② | **hook 链抢占条件路由** | `api-request-timeout` 的 `catch` 兜底先把 `./db.js` 解析成 `./db.ts` 成功返回，于是 `chat-retry-retryable` 那套「按 parentURL 换假 db」的分支**根本没进去** → `sendMessage()` 返回 false（`草稿非空时应能发出去`） |
| ③ | **模块缓存首写者胜 / 模块级单例** | `pdf-parser-480` 先把 `pdfjs-dist` 换成替身，`pdf-parser-partial-480` 拿到同一份实例（`PDF 打开失败`）；`reading-settings` 装上的 settings 订阅活到后面 thinking-* 文件里（`document is not defined`） |

#### 三层处置（按「能不能在进程内修」分）

| 层 | 位置 | 覆盖什么 |
| --- | --- | --- |
| ① **文件级状态复位** | `tests/helpers/merged-tracker.mjs` 的 `resetAllTestState()`（合并入口逐文件调用） | `globalThis` 差异、`process.env` 改动、文件漏掉的 `setTimeout/setInterval/setImmediate`、以及用 `onTestStateReset()` **登记**的清场函数。复位动了什么会打 `·· reset <文件>：…`，是「谁在污染」的证据 |
| ② **分组键认得全** | `tests/run-layer.mjs` 的 `harnessKey()` | 「替身家族」必须从**三处**认出来：字面量 `tests/fixtures/<目录>/`、`fixtureUrl('<目录>/…')` / `new URL('…/fixtures/<目录>/…')`、以及 **helpers 里装上的整族替身**（`installChatBridge` / `installChatEnv` / `installSessionMatrixEnv` / `chatStub`）。少认一处，那一族就会落进 `no-fixture` 桶跟别人抢替身（#513 的 ① 类串扰就是这么来的） |
| ③ **`UNIT_SOLO` 独占进程** | `tests/run-layer.mjs` 的 `UNIT_SOLO` | ②③ 类（模块缓存 / 模块级单例）在**进程内不可修**：复位清不掉已加载的模块实例与已注册的 hook。登记时必须写清**机制类别 + 实测症状**，而不是塞进某个桶里赌邻居不变 |

#### 反向抽样：批次不许把真红洗成绿

原有兜底是单向的（批内红 → 单文件复核）；「**批内绿、单跑红**」没人看得见。所以每轮从
`merged: true && ok` 的文件里随机抽 3~5 个，用单文件进程复核：

- 单跑绿 → 一致（印 ✓ + 耗时，作为「批次判定可信」的抽样证据）；
- 单跑红 → **判定 runner 不可信，本轮判红**（`REVERSE-SAMPLE UNTRUSTWORTHY`），把两边结论都打出来。

口径：抽样种子打在终端上（`REVERSE_SAMPLE_SEED=<seed>` 可原样复现同一批名单）；
`--reverse-sample N` 改条数；`--no-reverse-sample` 只允许在**明确知道自己在放弃这条保护**时用，
CI 里不要加。负向对照（不入库，需要时手动跑一遍）：造两个探针 —— A 在 `tmpdir()` 写一个带
`process.pid` 的标记文件、B 断言该文件存在 —— 两个文件同批跑，B 批内绿、单跑必红；
`node tests/run-layer.mjs unit --only zz-513probe` 应当打出 `REVERSE-SAMPLE UNTRUSTWORTHY(1)` 且 `exit 1`。

#### 四条硬规矩

1. **`DEGRADED > 5` 就是回归**：先看名单里是「资源型」还是「串扰型」。资源型调 `--jobs` /
   `TEST_CHILD_HEAP_MB`；串扰型查 `harnessKey` 分组键、把脆弱文件登记 `UNIT_SOLO`，
   **不许**靠「反正会兜底」把它留在账外。
2. **不许用改断言的方式治串扰**：批内红单跑绿就是串扰的证据，改断言等于把测试改软。
3. **新文件并进批次前先跑两次**：`--jobs 1` 跑一遍、`--case` 单跑一遍，结论必须一致。
   不一致就把**受害者**（依赖条件路由 / 真模块 / 模块级单例只能一个写者）登记 `UNIT_SOLO`。
4. **抽样与复位都是「保护」，不是「结论」**：抽样一致 ≠ 批次零串扰；`·· reset` 打得再多也不代表
   复位成功（模块级单例复位不了）。真正可核对的只有：`DEGRADED ≤ 5`、抽样无 UNTRUSTWORTHY、
   连续三次 `node tests/run-layer.mjs unit` 结果一致。

---

### 11.11 超时不算断言失败（Issue #733）

**现象**：`tests/unit/gate-negative-controls.test.mjs` 空载 ~15s（`tests/timing-baseline.json` 的 `layers.gates`），
负载下实测 157–340s，撞穿 runner 的批内默认超时 180s。超时后进程被停掉、没有 TAP 收尾行，
报告里只剩一句「批内没跑到收尾行」，**与「断言真红」长得一模一样** —— 单跑 15/15 全绿，
却骗着人去改一个没坏的断言。这是 #611（INFRA）的同一个病：**「进程怎么死的」和「断言怎么红的」是两件事。**

分类（`tests/run-layer.mjs`）：

| 结局 | 输出 | 汇总 | 处置 |
| --- | --- | --- | --- |
| 超时 → 单跑复核**通过** | `<< TIMEOUT <文件>` + `TIMEOUT-PASSED-ON-RERUN` 段 | 独立计数，**不进 FAIL**、不进 PASS | 绿，但绿在复核上：说明档位偏紧，**不要**去改断言 |
| 超时 → 单跑复核**仍超时** | `<< TIMEOUT <文件>` + `TIMEOUT` 段 | `TIMEOUT n`，**判红**（没定性不许当绿） | 查它是不是真卡死；只是慢就拆小/调档 |
| 超时 → 单跑复核是**断言红** | `<< FAIL` | 计入 `FAIL` | 超时只是把真红藏起来了，**不许挂在 TIMEOUT 名下蒙混** |
| 断言失败（与超时无关） | `<< FAIL` | 计入 `FAIL` | 照旧（这条从 #501 起就没变过） |

三条硬约束：

1. **超时的文件必须自动单跑一次**，复核预算取 `max(档位 × 2, 默认档)` —— 用「被判超时的那个数」再跑一遍
   是循环论证：它必然再超时，什么也证明不了。
2. **超时档只有一份数据源**：`tests/timing-baseline.json` 的 `timeoutClasses`（`default` 180s / `gate-selfcheck` 600s）
   与 `fileTimeoutClasses`（逐文件标注）。**不新建第二份基线**，也不许顺手放宽默认档。
   标注了非默认档的文件**不进合并批次**：批内超时按「一个进程」算，它一慢就会把同批十几个无辜文件一起拖死。
3. **超时被杀的副作用要认得**：门禁负向对照是「往仓库里塞坏输入 → 必红 → 还原」，进程被 SIGKILL 掐在中间，
   注入物就留在仓库里（实测：`tests/unit/__gate-neg-*.test.mjs` 这一类注入物），下一次跑会在**正例**上红。
   所以「档位要给够」不只是为了快 —— 掐断一次会污染下一次。发现残留先 `git status` 清干净再下结论。


---

## 12. `server` 层与 `deploy/dl-release/test` 白名单（Issue #415）

**一句话：`deploy/dl-release/test` 那 34 条用例现在有入口、有 CI 步骤、也有门禁盯着「会不会又被摘掉」。**

### 12.1 接线前的状态（为什么这算一条 bug 而不是一条优化）

`deploy/dl-release/test/*.test.mjs`（变体解析 / APK debuggable / 服务端 buildType / 上传契约矩阵）
实测 34 pass，但三处入口全空：

- 不在 `tests/run-layer.mjs` 的 `LAYERS` 里 → `node tests/run-layer.mjs <任何层>` 都跑不到；
- CI 没有对应 step → PR 上不会出现它的红；
- 结果：**全绿、零执行**。删掉这四个文件，没有任何人会收到信号（和 #368 的 `regression` 层、
  #365 的 `integration` 层是同一个病）。

### 12.2 两条路，选了哪条（以及为什么不选另一条）

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| A 搬进 `tests/<层>/`（推荐给**新**用例） | 把 4 个文件挪到 `tests/server/` 或 `tests/integration/` | 这 4 个文件与被测实现**同目录**：`import ... from '../apk-manifest.mjs'`、`path.resolve(HERE, '..', 'server.mjs')` 起真服务、读同目录 `xmltree-fixtures/`（真 aapt2 输出）。搬家要同时改断这些相对引用 + `deploy/README.md` + 域10 覆盖文档（`docs/testing/coverage/` 下）的路径引用 |
| **B 留在原地 + 白名单 + 真入口（本单采用）** | `LAYERS += server`；`LAYER_DIRS.server` 指向 `deploy/dl-release/test`；`check-test-layout.mjs` 开一条带理由的 `EXTRA_TEST_DIRS` 条目并**一起扫描**该目录 | 多一条白名单条目；用例目录不在 `tests/` 下，`test:affected` 的域映射暂时覆盖不到（见 12.5） |

选 B 的判据：**A 的收益只是目录好看，代价是把一批「现在能跑」的相对路径改成「改一处就断」**。
但 B 有一个前提条件 —— 白名单**不许是免检区**，所以：

- 白名单目录被 `check-test-layout.mjs` 一起扫（`walkTests` 追加根），孤儿 / 落位 / 命名三条硬规则照判；
- 新增一条硬规则 `layer-unwired`：白名单目录名下的 `server` 层从 `LAYERS` 里消失 → 直接红
  （「用例在这、层没了」和「层在这、用例没人枚举」是同一种失效，不许降级成 warning）；
- 负向对照（`tests/unit/gate-negative-controls.test.mjs` 的 N4）现在往**两处**注入：
  `tests/unit/__gate-neg-layout-probe/`（层级目录里的子目录）和
  `deploy/dl-release/test/__gate-neg-layout-probe/`（白名单目录里的子目录），
  两处都必须报 `layer-placement` + `orphan`。白名单目录变免检，N4 会红。
- CI 那一步本身也有负向对照：同一文件的 **N7** 往 `deploy/dl-release/test` 拷一条必红用例，
  断言 `pnpm run test:dl-release` exit≠0、删掉后 exit 0（顺带钉住「入口被加 `|| true` /
  `continue-on-error` / glob 改窄」，见第 9.4 节的登记表）。

### 12.3 两个入口（都跑同一批 34 条）

| 入口 | 命令 | 用途 |
| --- | --- | --- |
| 层入口（测试体系的统一口径） | `node tests/run-layer.mjs server`（也含在 `--all` 里） | 枚举口径 / `--list` / `--case` / `--json` / flaky 重跑与留痕；CI 的布局门禁就是实跑它的 `--list` 判孤儿 |
| npm script（CI 用这个） | `pnpm run test:dl-release`（= `node --test deploy/dl-release/test/*.test.mjs`） | 直接打印 `# pass 34`；纯 Node、不依赖 `dist`、不开浏览器 |

CI 位置：`.github/workflows/ci.yml` 的 `checks` job，紧跟 `check:manifest` 之后（该 job 里其余都是
< 10s 的静态检查，这一步实测 ~3-7s，不占 L1 的 4 分钟预算）。**没有 `continue-on-error`**。
`server` 层不进 L1 分片：它不需要产物、也没有浏览器，进分片只会给 6 个 job 各加一次 checkout 成本。

### 12.4 跑法与红线

- 单跑这批用例：`pnpm run test:dl-release`；只跑某一份：`node tests/run-layer.mjs server --only variant`。
- 单文件直跑仍然有效：`node --test deploy/dl-release/test/variant.test.mjs`（用例自己可独立执行）。
- **不许**为了让它变绿删掉 `package.json` 的 `test:dl-release`、`LAYERS` 里的 `server`、CI 那一步或
  `EXTRA_TEST_DIRS` 条目：前两处有 L0 断言（`tests/unit/domain10-gate-wiring.test.mjs` W2 +
  用例末尾那条「本目录有执行入口」），第三处有布局门禁（`layer-unwired` / 孤儿），删任何一处都会红。

### 12.5 已知缺口（不在本单范围，别当成已覆盖）

1. `check-test-duplication` 只扫 `tests/{unit,integration,regression,e2e,device}`，
   `deploy/dl-release/test` **不在扫描范围**（`tests/server` 若将来出现同理）——这两份 APK 最小编码器
   本来就同源，接进重复门禁要先抽 helper，属独立批次。
2. `tests/domain-map.json` + `test:affected` 的层推断基于 `tests/<层>/` 前缀，覆盖不到 `deploy/`；
   `deploy/dl-release/**` 的改动目前只能靠 `test:dl-release` 手动/CI 跑。
3. `offline-check.sh`（8 组手工断言，要真 APK + 真 aapt2）仍是手工，不在任何自动入口里。

## 13. 登录接缝：`__TEST_AUTH_STATE__`（Issue #487 W1-B 后半 / #510）

**一句话：登录墙接进入口（`src/main.tsx` 把 `<App/>` 包进 `<AuthGate>`）之后，「启动即进主界面」的浏览器用例需要一条**构建期**的接缝；它是构建期常量，不是运行期开关，且产物扫描盯着它。**

### 13.1 为什么需要它

`AuthGate` 未登录冷启动只画登录页，于是所有「打开 App 就点侧栏 / 输入框」的用例
（黄金回归 G1~G11、L1 的 `feedback-scroll` 等）都拿不到被测界面。它们的被测对象是聊天 / 导入 /
导出 / 诊断 / 更新这些主路径，**不是**登录流程 —— 登录流程自己有一层用例（登录 / 注册 / 恢复 / 过期）。

### 13.2 为什么不用运行期办法

| 方案 | 为什么不行 |
| --- | --- |
| URL 参数（`?test-auth=1`） | 分支会原样留在线上 bundle：任何人拿到包都能绕过登录墙 |
| localStorage / IndexedDB 标记 | 同上，而且「读到标记就放行」比 URL 还容易被利用；也会和真实凭据落盘混在一起 |
| 把 `diag-debug` 那套调试入口复用过来 | 调试入口是**诊断**用的只读钩子；让它能改登录态等于把 `?diag-debug` 升级成后门 |
| 测试里真去点登录表单 | 每条浏览器用例都要搭一个能登录的假后端（含 `settings/public`、`login`、`me`、`refresh`），把 45 条主路径用例全绑在一个和被测对象无关的链路上，且登录页一改全红 |

### 13.3 现在的做法（构建期内联）

- **取值**：`scripts/lib/testAuthSeam.mjs` 是唯一来源（假 token `test-token-not-real`、假会话、开关名、拦截标记）；
- **注入**：`rspack.config.ts` 的 DefinePlugin 里 `__TEST_AUTH_STATE__` 默认是 `'undefined'`（→ 内联成
  `undefined` → `AuthGate` 的守卫整段被死代码消除），只有 `TEST_AUTH_SEAM=1` 的**测试构建**注入假会话；
- **用**：`src/components/auth/AuthGate.tsx` 里 `typeof __TEST_AUTH_STATE__ !== 'undefined' ? … : undefined`
  —— 有值就把会话灌进 store 并**短路放行**（不读盘、不续期、不调 `me()`）；
- **谁能开**：CI 的**黄金 job**（G1~G11 要已登录产物）与 **L1 job**（三份变体都要）在构建那一步带
  `TEST_AUTH_SEAM=1`；`pnpm build` / `pnpm build:internal` / 发版链路一律不带。

`typeof` 写法是为了**没有打包器的场合**（`node --test` 直接 import `.ts`）：未声明标识符上写 `typeof`
不抛 ReferenceError。它**不是**运行期兜底 —— 产物里那里已经是 `typeof undefined`，没有任何代码去读全局变量
（`tests/unit/auth-seam.test.mjs` 有一条源码断言钉「`src/**` 不许出现 `globalThis.__TEST_AUTH_STATE__`」）。

### 13.4 三条守卫（缺一条就等于把开关交给运气）

1. **构建时自扫**：`scripts/build.mjs` 每次构建结束立刻扫产物；不带 `TEST_AUTH_SEAM` 的构建里出现标记 → **构建直接失败**。
2. **CI 门禁**：`pnpm run check:test-seam` 扫 `dist/`（`__TEST_AUTH_STATE__` 或假 token 命中即 exit 1），
   ci.yml 里紧跟一条负向对照（往产物塞假 token → 必红）；黄金 job 另跑 `--expect-seam` **正向对照**
   （接缝构建的产物里必须扫得到 —— 否则扫描器恒绿，G1~G11 会以「被登录页挡住」的形式假红）。
3. **L0 覆盖**：`tests/unit/auth-seam.test.mjs` 钉默认关闭、短路顺序、扫描器对脏目录必红 / 干净目录必绿。

### 13.5 已知边界

- 带接缝的产物（`dist/` 在 golden / L1 job 里）**不是**发版输入的等价物：它多一个假会话分支，
  但那条分支以外的代码逐字相同（同一份 `rspack.config.ts`，只差一个 DefinePlugin 常量）。
- 接缝只改**启动判定**：`restoreAuth` 的续期 / `me()` 语义、登录 / 注册 / 退出登录全在别的用例里测，不受它影响。
- 接缝**不许**在带 `TEST_AUTH_SEAM=1` 的构建上跑「未登录」语义的用例（登录页、注册入口显隐、过期提示）：
  那些用例必须用不带开关的产物（`DIST_OUT=... pnpm build`）。
- ci.yml 里 `TEST_AUTH_SEAM` 挂在**job 级**（golden / integration），不是挂在那一步的 `build` 上：
  `copy-limit` / `update-stuck-button-373` 这类用例会自己 spawn rspack 打 `dist-copy-limit` /
  `dist-update-373`，它们继承 `process.env` —— 挂在 build 步骤上的话这些自建产物是「未登录」包，
  用例会以「拿不到侧栏」的形式假红（#510 实测踩过一次）。

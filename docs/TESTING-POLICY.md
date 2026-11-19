# 测试分级门禁（TESTING POLICY）

本文件定义「什么改动该跑哪些测试、什么时候算过」。配套实现：

- `tests/which.mjs` —— 改动文件 → 该跑的用例（含回落规则，`--self-test` 自证）
- `tests/integration-baseline.json` —— 集成层基线失败清单（L2 只判「不新增失败」）
- `tests/run-layer.mjs --baseline` —— 按基线清单比对并输出差异
- `docs/testing.md` —— 集成层怎么跑、产物/端口/夹具要求
- `tests/unit/gate-negative-controls.test.mjs` + `tests/gates/` —— 门禁自身的负向对照（见第 9 节）

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
3. **禁止真机/模拟器测试混入门禁。** `device/` 层需要 AVD，只人工跑；CI 与本门禁不启动模拟器、不跑 Gradle。
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
| **新增 / 修改一道 CI 门禁** | `node tests/run-layer.mjs unit --only gate-negative-controls`（先看第 9 节） | < 30s |
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

### 9.4 现状清单（2026-11-20，ci.yml 里的 16 道门禁）

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
| `check:test-layout` | ✅ 注入（#369） | 造一个跑不到的用例（孤立子目录） | `tests/unit/gate-negative-controls.test.mjs` |
| `check:test-duplication` | ✅ 注入（#369） | 整份复制一份用例文件 | 同上 |
| `type` | ✅ 注入（#369） | fixture 里的 TS2322 拷进 `src/` | 同上 |
| `lint` | ✅ 注入（#369） | fixture 里的 `debugger` 拷进 `src/` | 同上 |
| `build:internal` | ✅ 注入（#369） | 临时副本里注入语法错模块并让 entry 真的 import | 同上 |
| `build`（黄金 job 的标准包） | ✅ 注入（#369） | 同上，N3 对**两条命令**都断言「注入后必红」（共用 `scripts/build.mjs`） | 同上 |
| `test:golden` | ⚠️ **缺口**（自带硬门，非检测对照） | 缺产物 / 产物种类不对 → 直接红、不 SKIP；端到端负向对照要真浏览器，见 `KNOWN_GAPS` | `tests/run-golden.mjs` |
| `check:log-coverage` | ⚠️ **缺口** | 脚本自带 `--selftest`（3 个反例），但 CI 调用没带 flag | `scripts/check-log-coverage.mjs` |

「登记」不是给人看的注释：`tests/unit/gate-negative-controls.test.mjs` 的 `N6` 用例会读
`.github/workflows/ci.yml`，**每出现一条 `run: pnpm run <gate>`，登记表里就必须有一条**，否则这个用例红，
并直接告诉你「该在哪里补一条负向对照」。缺口写进同一个文件的 `KNOWN_GAPS`（要带原因、关联 Issue、修法），
缺口一旦补上，`N6` 会再红一次提醒你删条目 —— 缺口可以存在，但不许静默。

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


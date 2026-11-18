# 测试分级门禁（TESTING POLICY）

本文件定义「什么改动该跑哪些测试、什么时候算过」。配套实现：

- `tests/which.mjs` —— 改动文件 → 该跑的用例（含回落规则，`--self-test` 自证）
- `tests/integration-baseline.json` —— 集成层基线失败清单（L2 只判「不新增失败」）
- `tests/run-layer.mjs --baseline` —— 按基线清单比对并输出差异
- `docs/testing.md` —— 集成层怎么跑、产物/端口/夹具要求

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
| 合并候选 | L0 + L1 | < 5min |
| 发版前一次 | `npm test` + `npm run test:integration -- --baseline` | 10~15min |
| 真机 / 链接导入原生 | `npm run test:device`（人工，需 AVD） | 3~8min |

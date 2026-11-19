# 测试覆盖与耗时看板（自动生成）

> 本文件由 `pnpm test:report` 生成，**不要手改**（手改会在下一次生成时被覆盖）。
> 生成时间：2026-11-19T18:06:31.920Z
> 数据来源：`tests/timing-baseline.json`（上次实测，逐条带 measuredAt）+ 目录实时清点 + `docs/testing/coverage/feature-coverage.md`（#362 功能点总表）。
> 重测：`pnpm test:report -- --measure`（重跑 unit / regression / golden / gates 并更新实测值；集成层约 20 分钟，交给 CI）。

## 0. 一页结论

| 项 | 值 |
| --- | --- |
| 五层文件数 | unit=154 / integration=45 / regression=11 / golden=4 / gates=5 |
| 功能点（#362 十域） | 160 条：已覆盖 75 / 部分覆盖 57 / 未覆盖 22 / 不适用 6 |
| known-red（集成层基线） | 7 条（每个文件都在 tests/integration-baseline.json 里有 reason + followUp） |
| flaky registry | 暂无（仓库里没有 registry 文件） |
| 改动-用例映射 | 10 个域 / 86 条 src glob → 246 个用例文件（tests/domain-map.json） |

## 1. 各层文件数 / 用例数 / 上次实测耗时

| 层 | 文件数（实时） | 用例数（实测） | 上次实测耗时 | 实测时间（本地） | 采集命令 |
| --- | --- | --- | --- | --- | --- |
| unit（L0） | 154 | 1160 | 105.8s | 2026-11-20 | `node tests/run-layer.mjs unit` |
| integration（L1） | 45 | — | 1188.0s | 2026-11-19 | `node tests/run-layer.mjs integration（逐文件全量重测）` |
| regression | 11 | 50 | 3.2s | 2026-11-20 | `node tests/run-layer.mjs regression` |
| golden（每域主路径） | 4 | 4 | 3.3s | 2026-11-20 | `node tests/run-golden.mjs` |
| gates（门禁负向对照） | 5 | 9 | 15.1s | 2026-11-20 | `node --test tests/unit/gate-negative-controls.test.mjs` |

口径说明：

- **文件数**每次生成时重新清点，不会和仓库漂移。
- **用例数 / 耗时**是「上次实测」，不是本次生成时现测的；`unit` 的用例数 = node:test 用例 + 自执行脚本分节。
- **gates** 的「文件数」是 `tests/gates/` 下的 fixture/lib 文件数（这一层不放可执行用例，用例在 `tests/unit/gate-negative-controls.test.mjs`，随 unit 层一起跑）。

## 2. 每域功能点覆盖（读 `docs/testing/coverage/feature-coverage.md`）

| 域 | 名称 | 功能点 | 已覆盖 | 部分覆盖 | 未覆盖 | 不适用 | domain-map 映射到的用例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 启动与可用性 | 9 | 3 | 3 | 2 | 1 | 36 个文件 |
| 2 | 对话主链路 | 12 | 4 | 8 | 0 | 0 | 40 个文件 |
| 3 | 渠道与模型 | 13 | 9 | 4 | 0 | 0 | 24 个文件 |
| 4 | 会话管理 | 9 | 2 | 5 | 2 | 0 | 15 个文件 |
| 5 | 历史导入 / 导出 | 33 | 19 | 4 | 10 | 0 | 40 个文件 |
| 6 | 额度与卡密 | 17 | 8 | 9 | 0 | 0 | 24 个文件 |
| 7 | 购买与订单 | 16 | 8 | 4 | 1 | 3 | 14 个文件 |
| 8 | 反馈与诊断 | 15 | 8 | 6 | 1 | 0 | 23 个文件 |
| 9 | 设置与持久化 | 14 | 6 | 3 | 4 | 1 | 12 个文件 |
| 10 | 发布与更新 | 22 | 8 | 11 | 2 | 1 | 18 个文件 |
| **合计** | | **160** | **75** | **57** | **22** | **6** | 246 个文件 |

这张表**只汇总** `feature-coverage.md` 的行级状态，不重新判定覆盖；判定口径（L0/L1/L2/L3、四档状态）见该文件 §2.0。

## 3. known-red 与 flaky

### 3.1 known-red（7 条，来源 `tests/integration-baseline.json`）

| 文件 | 为什么红 | 跟进 |
| --- | --- | --- |
| `diagnostics-contract.test.mjs` | import_error 事件的 meta 字段不全：403 下载失败那条（import download failed: forbidden）缺断言要求的字段，被「字段不全」判红 | 缺的字段在 src/services/diagnostics 侧补齐（与 #387 脱敏单分开做），补完删本条 |
| `feedback-scroll.test.mjs` | 360×640 键盘态下 expanded bottom 断言失败（软键盘遮挡与展开高度契约不符） | 窄屏键盘态布局单独派单；本文件是集成层最慢的一个，分片权重按 195s 记 |
| `full-acceptance.test.mjs` | 翻译器单测无输出 / __ENDPOINTS__ is not defined / 脏数据三类断言失败（老的大而全验收脚本，契约已与现状漂移） | 该文件是 #362 判定的「L1 重测 L0」重点，建议按域拆分后删减，而不是逐条修 |
| `mode-switch.test.mjs` | 切模式时仍写入 chat-demo:provider-kind 等额外 localStorage 键，与「只改模式键」的断言冲突 | 模式切换的持久化键收敛到单一 key，单独派单 |
| `upstream-html.test.mjs` | 上游返回网页（HTML）而非接口数据时，「上游返回网页而非接口数据」的用户文案没出现 | 错误分类到文案的映射缺失，单独派单 |
| `url-import-stages.test.mjs` | 断网阶段的两条断言：断网文案不出现，且失败要 40s 才报（阈值 15s）—— 阶段竞态/超时策略与用例契约不一致 | url-import 阶段超时与断网文案单独派单；本文件是集成层最慢的两个之一 |
| `log-viewer.test.mjs` | 采集层 token 打码结果丢失：日志行里的已脱敏 URL 被再次处理成空，断言「打码结果应保留」失败 | log-viewer 的 redact 幂等性（对已脱敏串重复脱敏）单独派单，修完删本条 |

另有 38 条登记为 expected=pass。判红规则：只判「相对基线没有新增失败」；known-red 跑绿会报 FIXED? 要求删条目（防基线永久腐烂）。

### 3.2 flaky

暂无 flaky registry：仓库里没有 `tests/flaky-registry.json`，所以「已知不稳定用例」目前没有登记处。
真遇到时按 `tests/integration-baseline.json` 的形状新建一份 registry（每条写 reason + 关联 issue + 复跑次数），本脚本会自动读进来。

## 4. 改动 → 用例映射（`tests/domain-map.json`）

| 域 | 名称 | src glob 数 | 映射到的用例文件数 | 盘点文档 |
| --- | --- | --- | --- | --- |
| domain01 | 启动与可用性 | 7 | 36 | `docs/testing/coverage/domain-01-02.md` |
| domain02 | 对话主链路 | 22 | 40 | `docs/testing/coverage/domain-01-02.md` |
| domain03 | 渠道与模型 | 3 | 24 | `docs/testing/coverage/domain-03-04.md` |
| domain04 | 会话管理 | 7 | 15 | `docs/testing/coverage/domain-03-04.md` |
| domain05 | 历史导入 / 导出 | 6 | 40 | `docs/testing/coverage/domain-05.md` |
| domain06 | 额度与卡密（邀请 / 领取） | 7 | 24 | `docs/testing/coverage/domain-06-07.md` |
| domain07 | 购买与订单 | 7 | 14 | `docs/testing/coverage/domain-06-07.md` |
| domain08 | 反馈与诊断 | 5 | 23 | `docs/testing/coverage/domain-08-09.md` |
| domain09 | 设置与持久化 | 7 | 12 | `docs/testing/coverage/domain-08-09.md` |
| domain10 | 发布与更新 | 15 | 18 | `docs/testing/coverage/domain-10.md` |
| **合计** | **10 个域** | **86** | **246** | |

用法：`pnpm test:affected -- <改动路径...>`（默认 unit + regression + golden；`--with-integration` 才跑集成层）。

## 5. 单命令入口

| 命令 | 声明预算 | 最近实测 | 跑什么 | 什么时候用 |
| --- | --- | --- | --- | --- |
| `pnpm test:fast` | ≤60s | 24.9s（2026-11-20，预算内） | tsc + L0 快速子集（134/154 个单元文件）+ 黄金套件 | 每次提交前 |
| `pnpm test:full` | 分钟~20 分钟 | 未记录 | unit + regression + golden + integration（集成层按基线判「不新增失败」） | 合并前 / 发版前 |
| `pnpm test:affected` | 秒级~1 分钟 | 未记录 | 按 `tests/domain-map.json` 挑用例并执行 | 改完一处、想知道「就这一处」该跑什么 |
| `pnpm test:report` | <2s | 未记录 | 生成本文件（`--measure` 会重测 unit/regression/golden/gates） | 想知道「现在整体长什么样」 |

快速子集排除了 20 个实测最慢的单元文件（合计 59.1s）；它们仍在 `pnpm test` / `test:full` / CI 里跑，名单与理由见 `tests/fast-subset.json`。

## 6. 这张看板怎么保持可信

1. **文件数实时**：不会出现「文档说 121 个文件，实际 154 个」。
2. **耗时带日期与命令**：分不清「现在」和「上次」的看板等于没有看板。
3. **不接 CI（本单）**：`.github/workflows/ci.yml` 同时有别的改动在进行，接线留 follow-up；
   本单只保证 `pnpm test:report` 在本地一条命令可复现（生成器无网络、无隐式构建、<2s）。
4. **数字对不上就是红**：`pnpm test:report --measure` 会真的跑一遍并覆盖实测值，不手填。


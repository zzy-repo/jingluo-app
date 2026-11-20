# 测试覆盖与耗时看板（自动生成）

> 本文件由 `pnpm test:report` 生成，**不要手改**（手改会在下一次生成时被覆盖）。
> 生成时间：2026-11-20T02:10:48.016Z
> 数据来源：`tests/timing-baseline.json`（上次实测，逐条带 measuredAt）+ 目录实时清点 + `docs/testing/coverage/feature-coverage.md`（#362 功能点总表）。
> 重测：`pnpm test:report -- --measure`（重跑 unit / regression / golden / gates 并更新实测值；集成层约 20 分钟，交给 CI）。

## 0. 一页结论

| 项 | 值 |
| --- | --- |
| 五层文件数 | unit=178 / integration=46 / regression=11 / golden=10 / gates=6 |
| 功能点（#362 十域） | 160 条：已覆盖 84 / 部分覆盖 51 / 未覆盖 20 / 不适用 5 |
| known-red（集成层基线） | 0 条（每个文件都在 tests/integration-baseline.json 里有 reason + followUp） |
| flaky registry | 1 份 |
| 改动-用例映射 | 11 个域 / 90 条 src glob → 254 个用例文件（tests/domain-map.json） |

## 1. 各层文件数 / 用例数 / 上次实测耗时

| 层 | 文件数（实时） | 用例数（实测） | 上次实测耗时 | 实测时间（本地） | 采集命令 |
| --- | --- | --- | --- | --- | --- |
| unit（L0） | 178 | 1160 | 105.8s | 2026-11-20 | `node tests/run-layer.mjs unit` |
| integration（L1） | 46 | — | 1188.0s | 2026-11-19 | `node tests/run-layer.mjs integration（逐文件全量重测）` |
| regression | 11 | 50 | 3.2s | 2026-11-20 | `node tests/run-layer.mjs regression` |
| golden（每域主路径） | 10 | 4 | 3.3s | 2026-11-20 | `node tests/run-golden.mjs` |
| gates（门禁负向对照） | 6 | 9 | 15.1s | 2026-11-20 | `node --test tests/unit/gate-negative-controls.test.mjs` |

口径说明：

- **文件数**每次生成时重新清点，不会和仓库漂移。
- **用例数 / 耗时**是「上次实测」，不是本次生成时现测的；`unit` 的用例数 = node:test 用例 + 自执行脚本分节。
- **gates** 的「文件数」是 `tests/gates/` 下的 fixture/lib 文件数（这一层不放可执行用例，用例在 `tests/unit/gate-negative-controls.test.mjs`，随 unit 层一起跑）。

## 2. 每域功能点覆盖（读 `docs/testing/coverage/feature-coverage.md`）

| 域 | 名称 | 功能点 | 已覆盖 | 部分覆盖 | 未覆盖 | 不适用 | domain-map 映射到的用例 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 启动与可用性 | 9 | 3 | 3 | 2 | 1 | 36 个文件 |
| 2 | 对话主链路 | 12 | 9 | 3 | 0 | 0 | 42 个文件 |
| 3 | 渠道与模型 | 13 | 9 | 4 | 0 | 0 | 24 个文件 |
| 4 | 会话管理 | 9 | 2 | 5 | 2 | 0 | 15 个文件 |
| 5 | 历史导入 / 导出 | 33 | 19 | 4 | 10 | 0 | 40 个文件 |
| 6 | 额度与卡密 | 17 | 10 | 7 | 0 | 0 | 24 个文件 |
| 7 | 购买与订单 | 16 | 9 | 4 | 1 | 2 | 14 个文件 |
| 8 | 反馈与诊断 | 15 | 8 | 7 | 0 | 0 | 23 个文件 |
| 9 | 设置与持久化 | 14 | 7 | 3 | 3 | 1 | 12 个文件 |
| 10 | 发布与更新 | 22 | 8 | 11 | 2 | 1 | 18 个文件 |
| **合计** | | **160** | **84** | **51** | **20** | **5** | 254 个文件 |

这张表**只汇总** `feature-coverage.md` 的行级状态，不重新判定覆盖；判定口径（L0/L1/L2/L3、四档状态）见该文件 §2.0。

## 3. known-red 与 flaky

### 3.1 known-red（0 条，来源 `tests/integration-baseline.json`）

无。

### 3.2 flaky

- `tests/flaky-registry.json`：0 条

## 4. 改动 → 用例映射（`tests/domain-map.json`）

| 域 | 名称 | src glob 数 | 映射到的用例文件数 | 盘点文档 |
| --- | --- | --- | --- | --- |
| domain01 | 启动与可用性 | 7 | 36 | `docs/testing/coverage/domain-01-02.md` |
| domain02 | 对话主链路 | 22 | 42 | `docs/testing/coverage/domain-01-02.md` |
| domain03 | 渠道与模型 | 3 | 24 | `docs/testing/coverage/domain-03-04.md` |
| domain04 | 会话管理 | 7 | 15 | `docs/testing/coverage/domain-03-04.md` |
| domain05 | 历史导入 / 导出 | 6 | 40 | `docs/testing/coverage/domain-05.md` |
| domain06 | 额度与卡密（邀请 / 领取） | 7 | 24 | `docs/testing/coverage/domain-06-07.md` |
| domain07 | 购买与订单 | 7 | 14 | `docs/testing/coverage/domain-06-07.md` |
| domain08 | 反馈与诊断 | 5 | 23 | `docs/testing/coverage/domain-08-09.md` |
| domain09 | 设置与持久化 | 7 | 12 | `docs/testing/coverage/domain-08-09.md` |
| domain10 | 发布与更新 | 15 | 18 | `docs/testing/coverage/domain-10.md` |
| domain11 | 邮箱账号（绑定 / 换机登录） | 4 | 6 | `docs/testing/coverage/domain-11.md` |
| **合计** | **11 个域** | **90** | **254** | |

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

---

> ⚠️ 下面第 6 节是**手写节**（#453 的收敛期 KPI），不是生成器的产物。当前 `scripts/test-report.mjs`
> 整文件重写 `report.md`，所以下一次 `pnpm test:report` 会把它覆盖掉 —— 已登记 follow-up（让生成器
> 保留这段，或把本节挪到独立文件）。在它被保住之前，请以本节的 `实测机器/日期` 一行为准复现。

## 6. 变异击杀率（#453 · 收敛期 KPI）

> 口径：手工把**实现改坏**（语义级，不改断言），跑对应层看是否变红。变异点选在「用户能看见的差异」上，
> 不选「只在测试里存在的分支」。记录机器：干净 worktree `main@ae4e2a3`（shard 口吻见 §1）、
> 4 vCPU / 15 GiB，实测时 load avg 2.7–6.5（同时有另一路全量集成在跑，只取方向）。
> **抓到的写「谁抓的」比写「抓到了」有用**：它说明这条防线以后能不能被信任。

### 6.1 三个域 · 12 个变异（3 域 × 4）

| # | 域 | 变异（改坏什么） | 结果 | 抓到它的用例 | 备注 |
| --- | --- | --- | --- | --- | --- |
| A1 | 支付/额度 | `maskTail` 打码方向反转（`slice(-tail)` → `slice(0, tail)`：露头部、隐尾部，形态仍是 `••••xxxx`） | ✅ 抓到 | `tests/unit/ours-api.test.mjs`（`maskCard(CARD) === '••••A3SR'` 逐字）、`ours-payment-records.test.mjs` | **专门的脱敏矩阵（`contract-c5` / `domain08-sensitive-fields`）全绿**——它们只断言「原文不出现」，方向反了照样不出现原文。见 6.3-① |
| A2 | 支付/额度 | `purchaseStatusOf`：认不出的状态归 `fulfilled`（原 `failed`） | ✅ 抓到 | `contract-c4-order-state`「状态大小写无关；非法状态归 failed 且保留后端中文」、`ours-purchases` | 白送「已完成」错觉的分支有人守 |
| A3 | 支付/额度 | `shouldKeepPolling`：终态（`expired`/`failed`）也继续轮询 | ✅ 抓到 | `contract-c4-order-state`（T2 不可回退）、`payment-trail-ui`「#189 其它状态不轮询」 | |
| A4 | 支付/额度 | `parsePurchaseOrders`：`total` 缺失时用 `orders.length + 1`（凭空「还有下一页」） | ✅ 抓到 | `ours-purchases`、`payment-trail-ui` | #326 的分页边界 |
| B1 | 导入 | 本地文件导入丢掉大小上限（`if (false && file.size > maxBytes)`，#34 的原点） | ✅ 抓到 | `import-size-limit`、`domain05-import-limit-table` | |
| B2 | 导入 | 停滞判死失效（`stallVerdict` 恒 `null`）：连续 40s 无新字节也不再判 stalled（#38 唯一的失败判据） | ⚠️ 抓到，但**形态是挂死** | `tests/unit/url-import-stall.test.mjs`「真正停滞：N 秒后判 stalled」 | `fail 0 / cancelled 2`：断言 `error.key === 'historyImportUrlStalled'` 存在，但**永远等不到 reject**，只能靠 90s `--test-timeout` 判死。见 6.3-② |
| B3 | 导入 | 导入时 `USER`/`ASSISTANT` 角色互换（用户提问渲染成 AI 回答） | ✅ 抓到 | `import-partial-skip`、`issue-49-import-skip-tiers`、`import-skipped-ui` | |
| B4 | 导入 | 直链导入「下载中超过上限」守卫删除（`state.downloaded > maxBytes` 短路成 false） | ✅ 抓到 | `import-size-limit`、`domain05-import-limit-table` | 与 B1 是两条链路，各自有人守 |
| C1 | 清单更新 | `parseManifest` 删掉 `buildType` 枚举校验（#330 的复发形态：`buildType:"release"` 的清单被收下） | ✅ 抓到 | `contract-c1-releases-schema` | |
| C2 | 清单更新 | `selectUpdate` 的 `eligible` 去掉 `artifactVariant === variant`（#377 的复发形态：internal 用户被塞 standard 包） | ✅ 抓到 | `contract-c2-select-update`、`domain10-variant-matrix`（5 例红） | |
| C3 | 清单更新 | 进度事件跨下载串台（去掉 `event.id === id` 判定，#373 的邻域） | ✅ 抓到 | `contract-c7-download-terminal` | |
| C4 | 清单更新 | 变体断链时 `reason` 退回 `'up-to-date'`（#377 的另一半：断链也说「已是最新」） | ✅ 抓到 | `contract-c2-select-update`、`domain10-variant-matrix`（4 例红） | |

**首轮数字：3 域 / 12 变异 / 12 抓到（12/12）**。按域：支付/额度 4/4、导入 4/4（其中 1 个只靠超时）、
清单更新 4/4。**变异点在契约层的地盘上，契约层确实守得住** —— 与 #453 §6 的结论一致（`contract-c3`
在 20MB / 2GB 两处变红、`contract-c5` 删 `phone` 规则变红）。
但「抓到」不等于「抓得好」：12 个里只有 10 个是**断言红**，1 个是挂死（B2），1 个是靠邻域逐字断言、
专属矩阵失明（A1）。这两条才是本轮真正要登记的缺口（6.3）。

### 6.2 反例：真有洞的地方 —— 域 8 敏感字段的**键名维度**

| # | 变异 | 结果 | 说明 |
| --- | --- | --- | --- |
| D1 | 只把 `SECRET_SEGMENTS` 里的 `'deviceid'` 删掉 | ⚪ 不变红 | **等价变异**：`sanitizeMeta()` 先过白名单（`isAllowedKey`），`deviceId` 根本不在 `EXTRA_KEYS` 里 → 这条规则在当前白名单下**不可达** |
| D2 | 组合变异：白名单收下 `deviceId`（加进 `EXTRA_KEYS`）+ 删掉密钥段 `'deviceid'` | ❌ **全绿** | 实测 `sanitizeMeta({deviceId:'vendor-778899-abcdef'})` → `{"deviceId":"vendor-778899-abcdef"}`（明文进日志）；`d-<32hex>` 形状仍被值维度打码，所以现有用例（`domain08-sensitive-fields` 177 unit 全量 + `domain08-feedback-negative` + `feedback-export`）**一条都不红** |
| D3 | 值维度：删掉 `redact.ts` 的 `deviceId` 正则（`d-[0-9a-f]{32}` 不再打码） | ✅ 抓到 | `domain08-sensitive-fields`、`domain08-redact-negative` —— F8-12 的「破坏后变红」证据这一格是**有**的 |

结论：F8-12 的值维度有直断，**键名维度（`deviceId` 白名单 × 密钥段）没有任何用例**，
而它恰好是 #313 踩过的坑型（为了让字段「能查到」把键加进白名单）—— 已登记为缺口单。

### 6.3 击杀质量：两条不是「红」而是「不算红」的

① **A1 只被邻域抓到**：打码方向反转时，`contract-c5-redact-rules` 与 `domain08-sensitive-fields`
（专门钉脱敏的两处）全绿。它们断的是「原文不出现 + 打码形态出现」，而方向反转后「原文」确实不出现。
真正抓住它的是域 7 的一条**逐字断言**（`maskCard(CARD) === '••••A3SR'`）。
建议（不本单做）：脱敏矩阵补一列「保留的是尾 4 位」，把「形态」钉成「位置」。
—— 这不算硬缺口（有人抓），登记在 #453 台账里。

② **B2 是挂死**：`url-import-stall` 的断言写得很到位（`error.key`、`reason: 'stalled'`、`stall.ms`），
但一旦停滞判死失效，用例不是「断言失败」而是**永久 await**；`node --test <file>` 的默认形态没有超时
（文件头注释也是这么教人跑的）。也就是说：**这条防线真实失效时，本地会挂到天荒地老，CI 靠 25 分钟
job 超时兜住**。建议（不本单做）：给「等一个一定会来的终态」的用例加 deadline race（`Promise.race`
+ 假定时器推进），让它在 5s 内红。—— 已登记为缺口单。

### 6.4 复现

```bash
# 干净 worktree，pnpm install --frozen-lockfile --offline
node scripts/build.mjs                                    # dist/         internal
DIST_OUT=dist-standard node scripts/build.mjs             # dist-standard/ standard
DIST_OUT=dist-scroll   node scripts/build.mjs             # dist-scroll/   standard

# 变异 → 跑层 → 还原（每个变异都单独跑、单独还原）
node tests/run-layer.mjs unit --only contract             # 契约层 10 文件 / ~1s
node --test tests/unit/url-import-stall.test.mjs --test-timeout=90000
DIST_DIR=$PWD/dist-standard node tests/integration/domain01-session-load.test.mjs
```

### 6.5 四个 P0 功能点的「破坏后变红」

覆盖状态先说清：**四条在 `main@ae4e2a3` 上都已作用例**（#438/#442 落位），
`docs/testing/coverage/feature-coverage.md` 曾长期写着「未覆盖 / 仅间接证据」，那是**过期口径**
（该文件的判定没跟着 #442 更新）—— 本表以实测为准。**已于 2026-11-20 回填**：总表 F8-12 改为
`部分`（值维度已直断 / 键名维度仍有洞）、F9-12 改为 `已覆盖`，§1.1–§1.2 计数按行级状态重算（84/51/20/5）。

| 功能点 | 现作用例 | 破坏方式 | 结果 |
| --- | --- | --- | --- |
| **F9-12** 删除所有对话的保留口径 | `tests/integration/domain09-delete-all-retention.test.mjs`（8 行保留口径表） | `clearHistory()` 里补一句 `localStorage.clear()`（设备码/Key/设置一起清） | ✅ 红：`T4 设备码（chat-demo:ours-device-id，丢了 = 丢账号）：从 "d-0123…cdef" 变成 null` |
| **F8-12** device_id / 卡密不进日志与导出 | `tests/unit/domain08-sensitive-fields.test.mjs`（N1 矩阵 × 3 边界） | 删掉 `redact.ts` 的 `deviceId` 值规则（D3） | ✅ 红（值维度）；键名维度 ❌ 全绿 → 缺口单 |
| **F1-03** 会话列表读失败给文案 + 重试 | `tests/integration/domain01-session-load.test.mjs` 行 2 / 行 5 | 失败态恒显示「正在加载」，文案与重试按钮都不出现 | ✅ 红（7 条 ✗） |
| **F1-04** 单条会话打不开给文案 + 重试 | 同上 行 3 / 行 4 | 重试按钮 `onClick` 改空函数（点了不重读） | ✅ 红（「点重试后真的重读，会话内容出来了」等 3 条 ✗ + 行 5 用例异常） |

复测说明：四条都是「改坏 → 红 → `git checkout` 还原」，还原后同文件复跑绿（未在白名单里放宽任何断言）。

# Native SQLite 安全迁移：架构与分工（#910）

目标：Native 端无损从 IndexedDB 迁到 SQLite，现有用户更新后继承全部历史数据；之后的写入可靠持久。Web 继续 IndexedDB。
统一规范见 `docs/client-infra-standards.md`；存储接口见 `docs/storage-abstraction.md`。本文只写本期决策。

## 1. 已定决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 迁移在**启动期、业务 UI 挂载之前**跑，期间显示阻塞的迁移页；路由层对写入另设防线（`StorageMigratingError`） | 「暂停业务写入」靠启动顺序保证，不靠各调用方自觉 |
| D2 | 源 = IDB 原始行（`RawStoreSource`，保留全部字段与 Blob），不经过业务仓储接口读 | 业务接口可能不暴露某些历史字段，经它复制会丢字段 |
| D3 | 二进制原件存 SQLite 的**分块 BLOB**（每块 ≤512KiB，带 sha256 与总长），不存外部文件 | Android `CursorWindow` 单行约 2MB 上限，整块大 BLOB 读不出来；单库文件让备份（`VACUUM INTO`）与事务一致。代价是库体积，由磁盘预检承担 |
| D4 | 迁移状态机权威副本在原生私有目录 `storage-engine/state.json`（经 `AppFileSystem.writeAtomic`）；SQLite `meta` 表是第二见证人 | 高水位同口径：不依赖 WebView 存储 |
| D5 | `committed` 之前真源 = IDB，之后 = SQLite，**永不回退**。`committed` 后 SQLite 打不开 → `blocked`，不静默读旧 IDB | 旧 IDB 在 committed 后不再更新，读它等于丢数据 |
| D6 | 本期**不删除**旧 IDB，不改它的 schema，不写入它 | 用户要求；删除需单独确认 |
| D7 | 能力判定走 `capability/probe.ts`：原生 + 插件已注册 + 方法齐全 + `AppFileSystem` 可用 + 可用空间足够。任一不满足留在 IDB，并记录原因，不报错 | 统一规范第 3 条 |
| D8 | SQLite 配置：WAL、`synchronous=FULL`、`foreign_keys=ON`、`busy_timeout>=5000`；打开后回读，不符就拒绝打开 | 强持久化 |
| D9 | `runAtomic` 回调类型收窄为 `AtomicRepos`（已提交 `2e124daa`） | 接口不承诺后端做不到的事务 |

## 2. 开放决策（需要用户拍板，本期先不替用户定）

- O1：迁移**默认开启还是默认关闭**（单一常量开关）。默认关闭时合并不改变线上行为，等真机验证后再开。
- O2：`committed` 之后 SQLite 不可用时，是否提供「从备份恢复」的用户入口（本期只实现机制与明确提示）。

## 3. 模块与所有权

每个子代理一个独立 worktree、一条分支，**只改自己名下的路径**；改别人的文件只能通过消息请求所有者改。

| 模块 | 分支 | 名下路径 |
|---|---|---|
| sqlite-schema | `feat/910-schema` | `docs/sqlite-schema.md`、`storage/sqlite/{schema,backend,raw,mapping}*.ts`、`storage/sqlite/repos/**`、`tests/helpers/storage-sqlite/**` |
| native-sqlite（先 Android；iOS 待有空闲名额再接） | `feat/910-native` | `android/**` 的 AppSqlite 插件、`ios/**`、`storage/sqlite/native/**`、`docs/sqlite-native-checklist.md` |
| migration-engine | `feat/910-engine` | `storage/migration/{copy,verify,hash}.ts`、`storage/idb/raw.ts` |
| switch-recovery | `feat/910-switch` | `storage/migration/{state,backup,orchestrator,recovery}.ts`、`storage/{router,index}.ts`、迁移页组件与 i18n |
| storage-callers | `feat/910-callers` | 14 个调用方文件、`tests/unit/storage-boundary*.test.mjs`、门禁台账条目 |
| migration-audit | `feat/910-audit` | `tests/helpers/migration-faults/**`、`tests/unit/migration-*.test.mjs`、`docs/sqlite-upgrade-audit.md` |
| contract-suite | `refactor/906-contract` | `tests/helpers/storage-contract/**` |
| protection | `feat/909-protection` | `storage/../protection/**` |

共享契约（只由 lead 改）：`storage/types.ts`、`storage/sqlite/driver.ts`、`storage/migration/types.ts`。需要改它们的子代理先发消息给 lead。

## 4. 迁移流程（`orchestrator`）

`preflight → backing-up → backup-verified → copying → verifying → verified → committed`；任何一步失败 → `failed`（真源仍是 IDB，带原因，下次启动可重试，也可手动重试）。

- preflight：可用空间 ≥ `(源估算体积 × 2) + 备份体积 + 余量`；记录源指纹（各 store 计数 + 主键集合哈希）。
- backup：把 9 个 store 原样导出成独立备份（清单含每个文件的 sha256），读回校验后才进入下一步。备份放在 `storage-engine/backup-<ts>/`，**不自动删除**。
- copy：按 store、按主键升序分批 upsert（幂等），每批后写检查点；中断后从检查点续。续跑前重算源指纹，变了判 `source-changed` 重来。
- verify：全量对比计数、主键集合、内容哈希（Blob 比字节 sha256，其余比规范化后的字段）、引用关系与语义不变量。
- commit：校验通过后，先写 SQLite `meta`，再写状态文件 `committed`。两处见证不一致按 D4/D5 规则收敛。

## 5. 故障注入点（`migration-audit` 负责）

每一步前后各注入：源读取失败、目标写入失败、`ENOSPC`、进程在任意检查点被杀（丢弃内存状态重建协调器）、备份文件损坏、状态文件损坏或缺失、SQLite 文件被删、源数据在迁移间隙变化、部分行损坏（无法克隆/缺字段）、超大附件、重复迁移、跳过中间版本升级。每一条断言：旧 IDB 数据未变；不出现「半迁移但被当作真源」。

## 6. 技术债登记

- `UNIT_SOLO` 新增的 storage 测试登记（`storage-char-*`、`storage-idb-backend`）：原因是共享 `db.ts` 模块级连接与全局 `indexedDB`。**根治办法**：`db.ts` 提供可重置的连接工厂，测试各自拿独立实例。迁移调用方（storage-callers）完成后再评估能否撤销。
- 不在本期：旧 IDB 的清理、iOS 真机、Web 端 SQLite（wasm）。

## 7. 子代理通则

- 基线：`feat/910-base`（已含 #906 基线 + IDB 后端 + #907 FileSystem + 本文）。自己建 worktree：`git -C /root/deepseek-app worktree add -b <分支> /root/worktrees/<名字> feat/910-base`，再 `ln -s /root/deepseek-app/node_modules /root/worktrees/<名字>/node_modules`。**只在自己的 worktree 里改**，不碰别人的 worktree、不碰 `/root/deepseek-app`。
- 不 push、禁止 `git add -A`、LF、提交中文、末尾 `Refs #910`（禁止 closing keyword）。`tests/flaky-registry.json` 弄脏就 `git restore`。
- git 不走代理（127.0.0.1:7897 不通）。
- 只改「名下路径」。要改共享契约或别人的文件 → `send_message` 给 lead，写清要改什么、为什么。
- 不得弱化断言来让测试变绿；红了先分清是实现 bug 还是用例写错。新测试做负向对照（改坏→变红→还原）。
- 新单测若碰 `db.ts` 模块级单例或改写 `globalThis.indexedDB`，合批会串扰：登记 `tests/run-layer.mjs` 的 `UNIT_SOLO` 并写明机制（技术债，见第 6 节）；否则必须在 `node tests/run-layer.mjs unit --only <前缀>` 合批下 DEGRADED=0。
- 原生 API 只经 Adapter；`@capacitor/*` 只能在 `native/` 目录；业务层与 `storage/**` 其余文件不得出现 `isNativePlatform` / `getPlatform`；能力探测只用 `capability/probe.ts`，错误只用 `InfraError`；禁止把持久化降级到内存后返回成功。
- Android 构建**串行**（机器 15G 内存、4 核）：任何 gradle 命令必须 `flock /tmp/android-build.lock <命令>` 包住，并设 `--no-daemon -Dorg.gradle.jvmargs=-Xmx2g`；不要启动模拟器（由 lead 统一安排）。Android SDK 在 `/root/android-sdk`，JDK 21。
- 真机验证不阻塞合并，但回复里必须如实列出「未验证范围」，不得把模拟/桩测试说成真机通过。
- 回复 40 行内：提交、文件清单、你亲眼看到的门禁结果、与共享契约的偏差、风险与未验证清单、需要 lead 决策的点。
- 门禁最低线：`npx tsc --noEmit`、`npx oxlint src`、`node scripts/dev-check.mjs --content`、`check:test-layout`、`check:test-duplication`、`check:eol`、你的测试在 `run-layer unit --case/--only` 下绿。

# Native SQLite 无损迁移：验收报告（#910）

日期：2026-11-27　分支：`feat/910-base`　PR：[#931](https://github.com/zzy-repo/jingluo-app/pull/931)
被测环境：Android 11 / API 30 模拟器（`compat30`，x86_64），WebView CDP 驱动；**未在真机验证**。

结论一句话：**模拟器上「旧版本覆盖安装 → 历史数据完整 → 实际使用 SQLite」成立**，满盘/强杀/冷启动/迁移中断四条主链路通过；真机、iOS、掉电耐久性未验证。

## 1. 逐条结论

| 验收项 | 结论 | 证据 |
|---|---|---|
| 新旧版本覆盖安装后历史数据完整 | **通过（模拟器）** | 旧 APK（`origin/main`）播种 9 个 store → `adb install -r` 覆盖安装 → 迁移 committed → 独立脚本逐行逐字段比对 `ok=true` |
| 确认实际使用 SQLite | **通过（模拟器）** | `files/storage-engine/deepseek-app.db` 存在且被写入；`PRAGMA journal_mode=wal`、`synchronous=FULL`（插件 `info()` 回读）；迁移后 IDB 版本 15→16 且不再被读写 |
| 迁移开关默认关闭 | **通过（单测钉住）** | `migration-switch-*` 用例断言 `NATIVE_SQLITE_MIGRATION_ENABLED === false`；验收用临时构建置 true 后已还原源码 |
| 协议/契约：两个后端跑同一套契约 | **通过（有登记）** | IDB 185 通过 + 3 条已知偏离；SQLite 123 通过 / 14 skip / 25 条 `knownDeviations`（#930） |
| 全量 unit | **通过** | `run-layer unit --jobs 2`：PASS 314 / FAIL 1 / DEGRADED 1；唯一红 `math-blocks-821` 是批内串扰（单跑绿），与基线同性质 |
| 类型 / lint / 内容门禁 | **通过** | `tsc --noEmit` 0；`oxlint src` 0/0；`dev-check --content` 28 条中 27 绿 + 1 条 `main` 既有红（`check:doc-refs`） |
| Android 完整构建 | **通过** | `gradlew assembleDebug` BUILD SUCCESSFUL；`dexdump` 命中 `AppSqlitePlugin` 542 处；manifest 含 `fullBackupContent` + `dataExtractionRules` |
| 满盘 | **通过（模拟器）** | 填到 87MB 剩余 → 预检拒绝：`{"phase":"failed","failure":{"code":"insufficient-space","message":"need 270404245 bytes free, have 89653248"}}`；IDB 数据完好；释放空间后重启自动重跑 → committed |
| 进程强杀 | **通过（模拟器 + 程序化）** | 迁移 `copying` 阶段 `kill -9`：state 停在 `verified` 不误判完成；冷启动续迁 → committed；另有真 `node:sqlite` 子进程 SIGKILL 12 例 |
| 冷启动 | **通过（模拟器）** | force-stop 后重启：仍列 5 条会话、`state.json` 保持 committed、库文件不变 |
| 迁移中断 | **通过（模拟器）** | 同上（kill 后从检查点续迁，已复制批次不重读） |
| 防降级屏障（committed 后装回旧 APK） | **通过（模拟器）** | 旧 APK 打开得到 `VersionError`，界面「本地数据来自更新版本的应用，请更新」，不读过期数据、不删数据 |
| 掉电耐久性（`FULL` vs `NORMAL`） | **未验证** | SIGKILL 杀进程 ≠ 掉电，Node 层区分不出；需真机掉电或 `PRAGMA` 回读 + 长时间压测 |
| 设备上「正常保存途中」强杀 | **未验证** | 设备侧只做了迁移期强杀；单条保存的强杀只有程序化用例 |
| 灾难恢复（快照恢复入口端到端） | **未验证（设备）** | #909 的快照/恢复有单测与浏览器视口截图；设备端未跑（见 #924） |
| iOS | **未验证（未开始）** | 本机无 Xcode；#914 未启动；iOS 上开关强制 IDB |
| 真机 | **未验证** | 全部结论来自模拟器 |

## 2. 本轮修掉的真实缺陷（都由本机验证暴露，不是推测）

1. **迁移运行时从未注册** —— `configureStorageRuntime` 没有调用方，闸门恒判「无运行时」，迁移永不执行。新增 `src/services/storage/wiring.ts` + `main.tsx` 接线。
2. **能力探测把「插件没实现 checkPermissions」判成运行时故障** —— Capacitor 插件 Proxy 上永远有该方法，未实现时 reject `Cannot convert undefined or null to object`。真机后果：文件系统模块整体不可用、迁移停在「状态文件读不了」。改为只认明确拒绝（`code=PERMISSION` / 文案 denied），并补回归用例。
3. **原生库名/备份路径口径不一致** —— 迁移层传 `deepseek-app.db`、`storage-engine/backup-*.db`，插件白名单是 `[a-z0-9-]+` 且以 `storage-engine/` 为根 → `illegal database name`。驱动侧规范化（basename、去 `.db`、去前缀），主库名改 `deepseek-app`。
4. **`node:async_hooks` 进 Web 包** —— rspack 解析不了，Web 端直接构建失败。`runAtomic` 嵌套守卫改布尔深度（SQLite 单写连接，语义等价）。
5. **防降级屏障升版被自己挡住** —— 未先关本进程的 IDB 连接，`open(…,16)` 永远 `blocked`（真机 `verified` 卡死）。改为升版前先关自身连接。
6. **SQLite 测试驱动 `splitAt` 顺序错** —— 先校验参数再剥 `{__at}` 标记，导致每条带标记的写都报「参数不是合法 SqlValue」，SQLite 契约全红。
7. **备份排除漏了状态目录** —— state.json 在 `files/app-fs/`、库在 `files/storage-engine/`，只排除后者会让「库不备份、状态被备份」在换机后不一致；两份规则都补上 `app-fs`。

## 3. 已知未对齐（记录在 #930，不影响本次迁移结论）

SQLite 后端与 `types.ts` 注释不一致的 14 组：`unavailable`/`unknown` 错误档映射、`save` 的事务边界与 `degradedFiles` 降级路径、两条自愈、`putMany`/`memory.put`/`clearSession` 的事务化、`staging.commit/merge` 的回滚与搬原件范围、`runAtomic` 回调面收窄。契约套件里以 `knownDeviations` 登记（只减不增），转绿会报 `FIXED?`。

## 4. 安全边界（本 PR 遵守）

- 迁移开关**默认关闭**；合并不改变线上行为。
- **不删除**旧 IndexedDB、**不删除**迁移备份、不自动执行不可逆操作。
- committed 之后 SQLite 打不开 → `blocked` 明示并提供「继续使用（原数据安全）」，**绝不回退到过期 IDB**。
- 旧库只读：`createIdbRawSource()` 只用 readonly 事务（有单测把写方法打桩成抛错后仍能读全）。

## 5. 复跑命令

```bash
# 单测 / 契约
node tests/run-layer.mjs unit --jobs 2
node --test tests/unit/storage-contract-idb.test.mjs
node --test tests/unit/storage-contract-sqlite.test.mjs

# 类型 / lint / 内容门禁
npx tsc --noEmit && npx oxlint src && pnpm dev-check -- --content

# Android 构建（必须加锁串行）
pnpm build && npx cap sync android
cd android && flock /tmp/android-build.lock ./gradlew assembleDebug --no-daemon -Dorg.gradle.jvmargs=-Xmx2g

# 设备验收（模拟器）
#   1) 装旧版 APK 并播种：见 PR 正文里的 CDP 片段
#   2) adb install -r <新 APK>
#   3) adb shell "run-as com.example.deepseekchat cat files/storage-engine/deepseek-app.db" > /tmp/devdb/deepseek-app.db
node scripts/migration-device-verify.mjs
```

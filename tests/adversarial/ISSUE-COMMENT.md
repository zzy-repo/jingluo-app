## D 类（红队 / 对抗用例）盘点：15 条落地，5 条真缺陷

全部结论为**静态推断 / 单元级模拟**，无模拟器、无真机。基线 50/50 PASS 未受影响（`tests/run-layer.mjs` 的 `LAYERS` 不含本目录）。

```bash
node tests/adversarial/run-adversarial.mjs          # 合计 15：PASS 10，KNOWN-DEFECT 5，REGRESSION 0
node tests/adversarial/cases/a3-duplicate.mjs       # 单条排查
node scripts/compat/probe.mjs --target chromium83   # 探针
```

### 用例（构造方式 → 期望 → 实际，见 `tests/adversarial/baseline.json`）

| 桶 | 用例 | 结果 |
| --- | --- | --- |
| A 畸形归档 | a1 截断 ZIP / 声明尺寸撒谎 | 绿：`backupArchiveDamaged` / `backupArchiveUnreadable`，无半导入 |
| | a2 条目顺序异常 | **红**：index 排在会话之前即 `backupIncomplete`「内容不完整」 |
| | a3 重复条目名 | **红**：报「ZIP 结构损坏…可能被截断」，不提重复 |
| | a4 路径穿越 / 绝对路径 / 反斜杠 / 空名 | 绿：12/12 拒绝 |
| | a5 超长名 / BOM 前缀 / UTF-16 体 | 绿：259B 与 60019B 名均接受（无长度上限）；UTF-16 → `backupInvalidJson` |
| | a6 空 ZIP / 目录项 / 只有 manifest | 绿：`backupUnrecognized` / `backupEmptyArchive` / `backupManifestNotFirst` |
| | a7 ZIP 炸弹 1004:1 + 4GB 撒谎尺寸 | 绿：32MB 条目 646ms、ΔRSS 174MB；撒谎尺寸 `backupArchiveDamaged`、ΔRSS 0MB |
| | a8 manifest 类型错 / 缺失 / 0 字节 / 版本越界 | 绿：11/11 |
| B 巨大输入 | b1 单条 10MB 消息 + 100 万字符单行 | 绿：导入 186ms、长度一致；单轮 10MB `kept=1 reason=none` |
| | b2 2000 轮 / 4000 行 / 500 会话 / 重复 id | 绿：`kept=200 reason=rounds`；`total=512760px`；500 条进暂存 |
| | b3 10 万 emoji / 10 万组合字符 | 绿：两端均 200000 码元；`Intl.Segmenter`/grapheme 命中 0 |
| C 极端环境 | c1 滴流下载 | **红**：见缺陷 1 |
| | c2 系统时间前跳 / 回拨 | **红**：见缺陷 2 |
| | c3 离线 / 不可用端口 | **红**：见缺陷 3 |
| D 探针 | d1 `scripts/compat/probe.mjs` | 绿：9/9 |

### 真缺陷（保持红，不改产品代码、不放宽断言）

1. **总预算与包体上限不自洽 + 停滞后文案失真**（medium，`urlImport.ts`，全部 WebView 版本，与 WebView 版本无关）：`DOWNLOAD_TOTAL_BUDGET_MS=120_000` 对 `DEFAULT_MAX_IMPORT_BYTES=200MB`，要求稳定 ≥1.67MB/s；实测 4KB/600ms 的慢链路在 1216ms 报 `historyImportUrlStalled`「长时间无响应」，而期间一直在稳定收到字节。停滞判据是墙上时钟总量，不是「多久没有新字节」。
2. **时钟异常即误判超时**（medium，`urlImport.ts`）：`Date.now` 前跳 1 小时 → 健康链路被判 `historyImportUrlStalled`（3600004ms）；回拨 1 小时 → `trace` 出现 5 条负 `durationMs`（最负 −3600000ms）。
3. **离线/永久不可用错误未分类**（low-medium，`urlImport.ts`，`readNetworkStatus` 已有 `navigator.onLine` 但判据没用）：`TypeError: Failed to fetch` 且 `navigator.onLine=false` → `historyImportUrlNetwork`（未判离线）；`net::ERR_UNSAFE_PORT` 也会重试 2 次。
4. **导入对条目顺序敏感**（low-medium，`importArchive.ts`）：`chat_session_index.json` 排在会话文件之前即 `backupIncomplete`「文件内容不完整，无法导入」——顺序不是格式的一部分。
5. **错误提示不可自查**（low）：重复条目名 / 声明尺寸不符都塌缩成「ZIP 结构损坏 / 读不到文件目录」；索引重复 id 只报「内容不完整」。另：`zipReader.ts` **没有解压尺寸或压缩比上限**（32MB@1004:1 正常导入，只有内存兜底）；`location.ts` 模块顶层直接 `new Intl.DisplayNames`（Chrome 81+，无 try/catch，当前 src 内无人 import）。

### 探针：哪一版 WebView 会出问题（静态推断，46 条特性）

| 目标 | 不可用 | 打头的高版本项 |
| --- | --- | --- |
| chromium79 | 23 | `object-groupby`(117)、`css-nesting`(112)、`array-tosorted`(110)、`css-dvh`(108)、`css-has`(105)、`abort-signal-timeout`(103) |
| chromium83（本项目下限） | 20 | 同上 |
| chromium91 | 13 | 同上 |
| chromium109 | 3 | `object-groupby`、`css-nesting`、`array-tosorted` |
| chromium120 | 0 | — |

`--scan src` 把使用点直接点到文件行：`src/polyfills/legacy.ts`（`Array.prototype.toReversed` 等）、`drafts.ts`、`App.module.css`（CSS 嵌套）。每条特性在 `probe.mjs` 里都带 MDN/caniuse 依据与 `静态推断` 标记。退出码 0/1/2 已由 d1 锁定为契约。

### 未覆盖 / 未测边界

- 无模拟器、无真机：上述全部是 Node 侧单元级静态推断，**不能**当作真机结论。
- API 23/24/26/28 各档镜像缺失，未测；WebView 版本只在 probe 里做了版本下线判定，没有实体 WebView 跑过。
- 真实网络抖动 / 运营商劫持 / 证书错误未覆盖（httptest 只模拟了三种错误形态）。
- 大屏/窄屏与滚动性能未做视觉验证。

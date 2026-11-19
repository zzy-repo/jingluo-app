# 域 5：历史导入 / 导出 —— 功能点盘点与测试覆盖映射

> 归属：Issue #362（[TRACK] 功能点收集与分层测试覆盖盘点）第 5 个域。本文件**只做盘点与映射，不写测试、不改源码**。
> 盘点基线：`372703b`（`feat(release): buildType 收敛为枚举…（#330）(#350)`）。
> 代码范围：`src/services/chat/history/**`、`src/services/chat/backup.ts`、`src/services/chat/store.ts`（替换事务）、
> `src/components/settings/SettingsDialog.tsx`（数据管理 UI）、`src/services/exportText.ts` +
> `android/app/src/main/java/com/example/deepseekchat/ExportTextPlugin.java`（TXT 导出桥）、`src/services/limits.ts`。

## 一、分层口径（读表前先看这段）

按 #362 的四层定义，本域的实际形态与典型域不同，**必须按下面口径读 L 列，否则会误判成「覆盖很好」**：

| 层 | 本域对应目录 | 实际做了什么 | 缺口 |
| --- | --- | --- | --- |
| **L0** 单元 | `tests/unit/import-*.test.mjs`、`tests/unit/url-import-*.test.mjs`、`tests/unit/limits-config.test.mjs`、`tests/unit/export-text-bridge.test.mjs`、`tests/regression/issue-{32,34,38,49,111}-*.test.mjs`、`tests/adversarial/cases/**`（15 条红队用例） | 纯函数 / 分类器 / ZIP 读写 / 下载状态机（打桩 `CapacitorHttp` + 假时钟） | 导出侧**一条都没有** |
| **L1** 集成 | `tests/integration/url-import-native.test.mjs`、`url-import-stages.test.mjs`（18 个用例）、`url-import-web.test.mjs`、`error-boundary.test.mjs`（借导入造数据） | 真实 `dist` + Playwright，只把 `CapacitorHttp` 原生桥与 OBS 响应打桩 | 导出 UI（导出按钮 / 下载 / 置灰）无任何 L1 |
| **L2** 端到端 | **空**（`tests/e2e/` 只有 `real-upstream` / `diagnostics-upload`） | — | 本域 L2 覆盖率为 0：没有一条用例走真实原生 HTTP 拉真实 OBS 包 |
| **L3** 设备 | `tests/device/url-import-device.test.mjs`（模拟器 + adb + 真 `APK`，手动跑） | 真 WebView 下的直链导入、`CapacitorHttp` data 类型实测 | 只有「链接导入」一条主路径；导出、TXT 桥、SAF 全部无真机用例 |

**判读要点**

- 本域 L1 覆盖率显著高于其他域（因为下载链路可以在 Playwright 里打桩），但 **L2/L3 几近空白**，所以「绿色」只证明「打桩下正确」。
- `tests/adversarial/`（红队 15 条）**不在 `tests/run-layer.mjs` 的 LAYERS 里**，不进门禁，容易被当成已覆盖而实际无人值守。
- 导出侧（ZIP 导出 + TXT 导出桥的原生半边）是本域最大的盲区，见第四节。

## 二、功能点表（33 项）

> 本表是**盘点全集**；落地时按维护者口径收敛为 **9 条表驱动用例**（见第六节），一行功能点不等于一条用例。

| ID | 功能点（用户视角） | 入口 | 期望结果 | 失败表现 | L0 | L1 | L2 | L3 | 覆盖状态 | 关联 | 现有用例证据（`grep -rln` 命中文件） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-05-01 | 从链接导入整包成功 | 设置→数据管理→「从链接导入」→粘链接→确认导入 | 分块下载→ZIP 校验→逐会话写暂存→原子替换；提示「已导入 N 个会话」，侧栏出现会话 | 见 F-05-08 | — | ✓ | — | 需真机 | **已覆盖** | #34 #313 | `tests/integration/url-import-native.test.mjs`、`tests/integration/url-import-stages.test.mjs`、`tests/device/url-import-device.test.mjs` |
| F-05-02 | Range 206 分块下载（块自适应、块间无缝） | 同上（链路内部） | 每块从上一块结束字节起、无重叠无空洞、覆盖到末尾；进度约每秒一刷 | 短读 / 空洞 → 判「连接被中断」并报已下载百分比 | ✓ | ✓ | — | 需真机 | **已覆盖** | #24 #38 | `tests/unit/url-import-content-range.test.mjs`、`tests/integration/url-import-stages.test.mjs`（用例 2/13） |
| F-05-03 | 服务端忽略 Range（回 200 整包）时重下 | 同上（OBS / CDN 行为差异） | 丢弃本地已下字节、从头重下，详情写「已重新开始」，绝不把整包接在旧字节后面 | 拼接错 → 包体翻倍/CRC 失败 | ✓ | ✓ | — | — | **已覆盖** | #38 | `tests/unit/url-import-stall.test.mjs`（用例「服务端不支持 Range（回 200 整包）」）、`tests/integration/url-import-stages.test.mjs`（用例 12） |
| F-05-04 | 416 收尾（请求越界 = 上一块正好是最后一块） | 同上 | 收到 416 即视为下载完成并继续校验入库 | 中途 416 → 终止、报「连接被中断」，不写脏数据 | ✓ | ✓ | — | — | **部分覆盖（缺异常分支）**：现有两条用例只钉住「416 → 终止/报错」这一侧，**没有任何断言验证「416 落在 from>0 且字节已齐 → 正常成功」** | #38 | `tests/integration/url-import-stages.test.mjs`（用例 14）、`tests/unit/url-import-stall.test.mjs`（mock 用 416 表示服务端收敛） |
| F-05-05 | 停滞判定：连续 40s 无新字节 | 同上（弱网 / 对端挂死） | 判 `stalled`，文案带「已下载 x / 共 y」与秒数；慢但在推进的链路**不判死** | 误杀合法大包（#38 史）；文案「长时间无响应」 | ✓ | ✓ | — | — | **已覆盖** | #38 #152 #151 | `tests/unit/url-import-stall.test.mjs`、`tests/unit/import-budget-vs-stall.test.mjs`、`tests/regression/issue-38-stall-vs-progress.test.mjs`、`tests/adversarial/cases/c1-trickle.mjs` |
| F-05-06 | 断点续传（同链接重试从已下字节继续） | 失败后点「重试」 | 第二次请求 Range 从 `downloaded` 起，不再从 0；坏包 / 超限 / 403 不留续传点 | 续传拼错包 / 坏包反复从中间续 | ✓ | — | — | — | **已覆盖**（缺「换链接必须丢弃旧续传点」的断言） | #38 | `tests/unit/url-import-stall.test.mjs`（「重试续传」「坏包（非 ZIP）不保留续传点」） |
| F-05-07 | 超时预算：40s 停滞 vs 30min 防御性总上限 | 同上 | 两档终态文案可区分；预算耗尽的诊断带推导出的「最低带宽」`min.bytes.per.sec` | 两档混为一谈（#152）、把预算耗尽写成「长时间无响应」 | ✓ | — | — | — | **已覆盖** | #152 #151 #275 | `tests/unit/import-budget-vs-stall.test.mjs`、`tests/unit/limits-config.test.mjs`（「导入上限 ÷ 总预算 ≥ 最低可接受带宽」）、`tests/unit/import-clock-monotonic.test.mjs` |
| F-05-08 | 失败原因分档与文案（8 类） | 同上（各类网络 / 服务端 / 包问题） | offline / unreachable / refused / server / 超时（有/无已下载）/ 连接中断 / 非 ZIP / 403（过期·签名·其他）各一句不同人话；重试按钮可用 | 「网络已断开」背三种原因（#111）；英文 DOMException 直出（#195） | ✓ | ✓ | — | — | **部分覆盖（缺异常分支）**：服务层「非原生平台 → `historyImportUrlNativeOnly`」无断言（L1 只断言网页版 UI 不给入口）；`historyImportUrlBlocked` 仍是 follow-up 未落地 | #111 #18 #154 #195 #40 | `tests/unit/import-error-copy.test.mjs`、`tests/unit/import-unreachable-copy.test.mjs`、`tests/unit/import-network-classification.test.mjs`、`tests/unit/import-refuse-before-download.test.mjs`、`tests/regression/issue-111-import-error-tiers.test.mjs`、`tests/integration/url-import-stages.test.mjs`（用例 3/3b/4/5/6/7/16）、`tests/integration/url-import-native.test.mjs`（用例 3/7/8）、`tests/integration/url-import-web.test.mjs` |
| F-05-09 | 导入进度反馈 | 确认导入后的弹窗 | 「正在下载… 已下载/总大小（%）」→「正在解析…」→「正在导入 n/总数」→「已导入 N 个会话」；节流 100ms；详情最多 100 条 | 纯转圈（无进度）、进度跳变 | — | ✓ | — | — | **已覆盖**（L0 只断言回调被调，UI 节流/上限只在 L1） | #306 #313 | `tests/integration/url-import-stages.test.mjs`（用例 1/2/15/17） |
| F-05-10 | 取消导入（下载中 / 入库中） | 进度弹窗「取消」 | 下载中取消：不发新块、丢弃结果、界面恢复、无错误提示；入库中取消：条目边界中断、暂存清空、正式数据不变 | 取消被记成失败；取消后残留脏数据 | ✓ | ✓ | — | — | **已覆盖** | — | `tests/unit/url-import-stall.test.mjs`（「取消：立刻给出取消终态」）、`tests/integration/url-import-stages.test.mjs`（用例 9/10）、`tests/integration/url-import-native.test.mjs`（用例 5） |
| F-05-11 | 本地 ZIP 文件导入（网页版 / 手动下载） | 设置→数据管理→选择文件→确认导入 | 与链接导入共用 `importHistory`，导入成功后侧栏出现会话 | 见 F-05-08 / F-05-12 | ✓ | ✓ | — | — | **已覆盖** | #32 #34 | `tests/unit/archive-fixture-roundtrip.test.mjs`、`tests/integration/url-import-web.test.mjs`、`tests/integration/error-boundary.test.mjs` |
| F-05-12 | 损坏条目逐条跳过并给出位置 | 导入结果提示 / 「查看跳过详情」 | 坏的一条消息只丢这条、坏到整个会话才丢整个会话；skipped 带会话标题 / 消息 id / 原因文案；索引里列了却缺文件仍整包失败 | 一条坏消息拖垮整包（#49）；跳过原因不可读 | ✓ | — | — | — | **已覆盖** | #49 | `tests/unit/import-partial-skip.test.mjs`、`tests/unit/import-skipped-ui.test.mjs`、`tests/regression/issue-49-import-skip-tiers.test.mjs` |
| F-05-13 | 重复条目名 / 重复路径 | 导入即失败 | `backupEntryDuplicated` 点名冲突路径，提示含「重复」；目录与同名文件、NFC/NFD 重名同样拒绝 | 塌缩成「ZIP 结构损坏 / 可能被截断」（#153） | ✓ | — | — | — | **已覆盖** | #153 | `tests/unit/import-hardening.test.mjs`（缺口 2 ×4）、`tests/adversarial/cases/a3-duplicate.mjs` |
| F-05-14 | 条目顺序不是格式的一部分（index 在前 / 交错 / 中央目录乱序） | 导入即失败或成功 | manifest 必须首条；index 与会话的相对顺序任意；多余未引用条目只跳过 | `backupIncomplete`「内容不完整」（#32 / #153 缺口 1） | ✓ | — | — | — | **已覆盖** | #153 #32 | `tests/unit/import-hardening.test.mjs`（缺口 1 ×3）、`tests/regression/issue-32-archive-entry-order.test.mjs`、`tests/adversarial/cases/a2-order.mjs` |
| F-05-15 | 解压总量 / 压缩比上限（ZIP 炸弹） | 导入即失败 | 按中央目录声明尺寸累计 800MiB 总量闸 + 200:1 比值闸（≥16MiB 才生效）；声明尺寸撒谎直接拒，不按声明预分配 | 几十 KB 解出几 GB（#153 缺口 3）；误杀正常高压缩文本 | ✓ | — | — | — | **已覆盖** | #153 | `tests/unit/import-hardening.test.mjs`（缺口 3 ×4）、`tests/adversarial/cases/a7-bomb.mjs` |
| F-05-16 | 条目名长度上限（1024 字节） | 导入即失败 | 259 字节正常长名照常接受；60019 字节名直接拒绝；BOM 前缀名归一化后按同名处理 | 超长名一路走到路径校验才炸（#153 缺口 4）；误杀正常附件名 | ✓ | — | — | — | **已覆盖** | #153 | `tests/unit/import-hardening.test.mjs`（缺口 4 ×3）、`tests/adversarial/cases/a5-names.mjs` |
| F-05-17 | 归档结构校验（manifest 首条 / 版本 / 空包 / 截断 / 路径穿越 / ZIP64 / 加密 / UTF-16 名） | 导入即失败 | 每类给可读原因与条目定位（`backupManifestNotFirst` / `backupEmptyArchive` / `backupArchiveDamaged` / `backupArchiveUnreadable` / `backupInvalidJson`） | 一律折叠成 `backupIncomplete`（#40）；半导入 | ✓ | — | — | — | **已覆盖** | #40 #153 | `tests/unit/import-archive-manifest.test.mjs`、`tests/adversarial/cases/a1-truncated.mjs`、`a4-traversal.mjs`、`a6-empty.mjs`、`a8-manifest.mjs` |
| F-05-18 | 单张图片 / 附件异常降级 | 导入结果 | 图片身份按 `is_image`（不靠 magic）、magic 只补 MIME、识别不出仍按图片；引用越界 → 该会话 `backupInvalidFiles` 跳过；缺原件 → 保留文件名与大小、不进请求 | 一张图坏掉整包失败；图片串会话 | ✓ | — | — | — | **部分覆盖（缺异常分支）**：只有「图片引用跑到别的会话」有断言；**「缺原件的图片只留文件名」「MIME 识别失败仍按图片」「单张图片条目 CRC 坏」均无断言** | #49 | `tests/regression/issue-49-import-skip-tiers.test.mjs` |
| F-05-19 | 索引完整性校验 | 导入即失败 | 索引与会话一一对应；索引列了但缺文件 → `backupIncomplete`；多余未引用条目 → `backupEntryUnreferenced`（带序号/条目名）；索引重复 id 拒绝 | 「跳过也允许」把缺失也放过（假成功） | ✓ | — | — | — | **已覆盖** | #32 #40 | `tests/unit/import-skipped-ui.test.mjs`（[4]）、`tests/unit/import-archive-unclassified.test.mjs`、`tests/adversarial/cases/b2-history-scale.mjs`、`a6-empty.mjs` |
| F-05-20 | 上限边界：**恰好** 200MB | 导入入口 | 恰好等于上限必须放行（边界不缩水），照常走校验与解析 | 边界误拒（>= 写成 >） | ✓ | — | — | — | **已覆盖**（仅 L0，L1/L2 无边界用例） | #34 | `tests/unit/import-size-limit.test.mjs`（B）、`tests/regression/issue-34-import-size-limit.test.mjs` |
| F-05-21 | 上限行为：**略超** 200MB | 导入入口 | 按默认上限拒绝，且**在解析 / 写暂存之前**；提示「文件过大（{size}MB），实测 {actual}」；落一条 `import_error` | 先下载/先解析再报错（#195 白下载） | ✓ | ✓ | — | — | **已覆盖** | #34 #195 | `tests/unit/import-size-limit.test.mjs`（A/E）、`tests/unit/import-refuse-before-download.test.mjs`（①）、`tests/integration/url-import-native.test.mjs`（用例 4，Content-Length=300MB） |
| F-05-22 | `Content-Range` / `Content-Length` 缺失或不可信时的总长判定 | 链路内部 | 只认 206 的 `bytes a-b/total`（`total=*` 视为未知）与**首次整包 200** 的 `Content-Length`；206 缺 `Content-Range` 绝不拿块长当总长 | 4KB 块被判成「已下完」、上限拿 4KB 比（#24） | ✓ | ✓ | — | — | **已覆盖** | #24 | `tests/unit/url-import-content-range.test.mjs`（A/B/C/E）、`tests/unit/import-refuse-before-download.test.mjs`（②）、`tests/integration/url-import-stages.test.mjs`（用例 15） |
| F-05-23 | 导出全部历史为 ZIP | 设置→数据管理→「导出所有历史对话」→「下载」 | 生成 `deepseek_data-日期.zip`（manifest→会话 JSON→index→图片，STORE 写入，可再次导入），触发下载 | `historyExportFailed`「导出失败：{message}」（如导出途中会话被删 → 整次失败） | — | — | — | — | **未覆盖** | #336 | **无**（`grep -rln "exportHistory\|exportArchive\|zipWriter\|writeArchive" tests` 只命中 `tests/fixtures/archive-fixture.mjs` —— 那是独立用 `fflate` 造包的夹具，**不经过生产导出代码**） |
| F-05-24 | 导出进度反馈 | 导出按钮 | 期望：导出中给出会话/图片处理进度（#336 目标） | 现状：只有按钮 busy 灰化，**功能缺失** | — | — | — | — | **未覆盖（功能缺失）** | #336（open） | 无（`ExportHistory` 组件内无 progress 状态） |
| F-05-25 | 导出中途取消 | 导出按钮 | 期望：可取消且不产半份文件（#336 目标） | 现状：**无取消入口**，`exportHistory()` 无 `AbortSignal` | — | — | — | — | **未覆盖（功能缺失）** | #336（open） | 无 |
| F-05-26 | 空历史置灰 | 导出按钮 | `disabled = disabled \|\| busy \|\| empty`，空历史不可点（#336 还要补「置灰说明」文案） | 空历史点了导出得到空包 | — | — | — | — | **未覆盖**（代码已有 disabled，但零断言；文案侧随 #336 补） | #336（open） | 无 |
| F-05-27 | 导出上限与导入对齐（200MB） | 导出按钮 | 期望：导出侧与导入同一把尺子（#336 目标） | 现状：`exportArchive` **无业务上限**，只有 `zipWriter` 的 ZIP32/ZIP64 硬限（单条目 4GiB、65535 条目）；导出的包可能大于导入上限 → 自己做出来的包自己导不进来 | — | — | — | — | **未覆盖（功能缺失）** | #336（open）、#34 | 无 |
| F-05-28 | 导出后立即导入（往返一致性） | 导出 → 再导入 | 导出的包必须能被自己导入，会话数/标题/消息树/图片一一对上 | 导出包不合法（顺序/路径/CRC/NFC）→ 自己导入失败 | — | — | — | — | **未覆盖** | — | 无（`tests/unit/archive-fixture-roundtrip.test.mjs` 是「夹具→导入」单向，**不经过导出**） |
| F-05-29 | TXT 导出（ExportText 原生桥 + SAF） | 会话「导出为 TXT」/ 诊断导出 | 48KiB UTF-8 分块写入，SAF 选位置→保存；用户取消 → `cancelled` 不落文件；写失败 → abort 且绝不返回 `saved` | 原生 `MAX_BYTES` 8MB → `TOO_LARGE`；`INVALID_MIME` / `NO_EXPORT` / `START_FAILED` / `WRITE_FAILED` | ✓ | — | — | 需真机 | **部分覆盖（缺异常分支）**：JS 侧桥全绿；**Java 侧 8MB 上限、`ACTION_CREATE_DOCUMENT` 取消、`openFileDescriptor` 失败、`.part` 临时文件清理无任何自动化** | — | `tests/unit/export-text-bridge.test.mjs` |
| F-05-30 | 磁盘空间不足（配额耗尽） | 导入 / 导出 | 期望：明确提示「存储空间不足」并可重试，不回滚成半份数据 | 现状：`db.reportStorageError` 只 `console.error`，**无用户文案、无 i18n key、无降级**；导入失败会冒成通用「导入失败」 | — | — | — | — | **未覆盖（功能缺失 + 无测试）** | — | 无（`grep -rn "QuotaExceeded\|ENOSPC" src` 无命中） |
| F-05-31 | 进程被杀后的孤儿临时文件（暂存） | 下次导入 | `replaceHistory` 在写入前 `db.clearStaging()`；提交失败 / 取消同样清暂存，正式数据不变 | 上次残留的半份暂存被当成本次结果；正式库被污染 | — | — | — | — | **未覆盖**（代码路径存在，**无任何断言**：没有「模拟崩溃 → 下次导入前暂存为空」的用例） | — | 无（`clearStaging` 只在其它测试的 stub 里出现，未被断言） |
| F-05-32 | 清空历史后再导入 | 设置→「清空全部历史对话」→再导入 | `clearHistory()` 以空历史原子替换，**保留 API Key 与设置**；之后导入正常 | 清空把 Key/设置一起清掉；清空后导入串行冲突 | — | — | — | — | **未覆盖** | — | 无（`grep -rln "clearHistory" tests` 无命中） |
| F-05-33 | 导入 / 导出 / 清空的串行互斥 | 内部（`enqueueBackup` + `importingHistory` 守卫） | 三者排队执行；导入进行中再次导入 → 抛「History replacement is already in progress」；导入期间禁止改会话、先停生成 | 两个替换事务交错 / 边读边清 | — | — | — | — | **未覆盖**（守卫与队列无断言；`import-partial-skip` 只是把 `importingHistory` 置 false 当 setup） | — | 无 |

## 三、缺口小表（未覆盖 + 部分覆盖，按「资损 > 白屏 > 主流程 > 体验」排序）

> **计量口径提醒**：「预计用例数」一列是**表驱动的行数**，不是独立用例条数。按维护者口径（测试点尽量少、覆盖尽量全），
> 这些行最终被收敛进 **9 条用例**，见 [第六节](#六最小充分集9-条新增用例覆盖全部-33-个功能点)；不要把本列直接相加当成要写的用例数。

| 优先级 | ID | 缺口 | 建议层级 | 预计用例数 | 说明 |
| --- | --- | --- | --- | --- | --- |
| **P0** | F-05-23 | 导出 ZIP 全链路零测试 | L0（3）+ L1（2） | 5 | 导出是唯一「用户会把数据带走」的入口，写坏了用户当场丢数据（导出包无法再导入）；现在连「导出产物能过自己的校验」都没人证明 |
| **P0** | F-05-28 | 导出 → 导入往返 | L0（表驱动 3：纯文本 / 含图片 / 含跳过） | 3 | 与上一条共用夹具，等价成本最低、收益最高；能一次锁住 manifest 首条、条目名 NFC、图片路径、CRC |
| **P0** | F-05-30 | 磁盘空间不足无提示、无测试 | L0（2：quota 注入）+ L1（1） | 3 | 导入 200MB 包时最可能撞配额；现在只有 `console.error`，用户看到的是通用「导入失败」，且半份暂存的处理无断言 |
| **P0** | F-05-31 | 孤儿暂存清理无断言 | L0（2：崩溃残留 → 下次导入前清空；提交失败 → 正式库不变） | 2 | 与 P0 上面两条同一现场（写库失败）；一旦失效就是「导入后会话变少/变乱」这类不可解释反馈 |
| **P1** | F-05-27 | 导出上限未与导入对齐 | 先功能后 L0（1） | 1 | 现状可能出现「自己导出的包自己导不进来」；#336 正在做，测试要跟着落 |
| **P1** | F-05-24 | 导出进度 | 先功能后 L1（1） | 1 | #336 已在排期，属体验项但缺进度时用户会重复点导出 |
| **P1** | F-05-25 | 导出取消 | 先功能后 L0/L1（1） | 1 | 无 `AbortSignal`，大历史导出只能等 |
| **P1** | F-05-04 | 416「正常收尾」正向分支 | L0（1） | 1 | 现在只钉住失败侧；`if (status === 416 && from > 0) break` 这条**成功路径无人验证**，退化成「416 即失败」不会被发现 |
| **P1** | F-05-18 | 图片/附件降级三分支 | L0（3：缺原件 / MIME 不可识别 / 图片条目 CRC 坏） | 3 | 图片是导出包里最大的部分，也是最容易坏的部分 |
| **P2** | F-05-26 | 空历史置灰 + 说明文案 | L1（1） | 1 | 代码已有 disabled，属回归保护型用例 |
| **P2** | F-05-32 | 清空历史后再导入 | L0（1） | 1 | 兼验「清空不碰 API Key/设置」 |
| **P2** | F-05-33 | 串行互斥 | L0（2：并发导入、导入中清空） | 2 | 事务交错类缺陷难复现，但一旦出现就是数据丢失 |
| **P2** | F-05-29 | TXT 桥原生半边（8MB / SAF 取消 / 临时文件） | L3（手动，1） | 1 | JS 侧已绿，剩下的只能真机；至少把 8MB 上限写成 L0 常量断言 |
| **P2** | F-05-08 | `historyImportUrlNativeOnly` 服务层拒绝 | L0（1） | 1 | 现在只有 UI 层「不给入口」，服务层守卫无人守 |

## 四、「完全没有任何测试」清单（10 项）

定义：`grep -rln` 在整个 `tests/`（含 `unit/ integration/ e2e/ regression/ adversarial/ device/ fixtures/`）里**找不到任何一条针对该行为路径的断言**。

| ID | 功能点 | 现状 | 需要先做 |
| --- | --- | --- | --- |
| F-05-23 | 导出全部历史为 ZIP | 代码完整（`exportArchive` + `zipWriter`），**零测试** | 直接补测试（功能已在） |
| F-05-24 | 导出进度反馈 | **功能缺失** | 功能单（#336）→ 再补测试 |
| F-05-25 | 导出中途取消 | **功能缺失**（无 `AbortSignal`） | 功能单（#336）→ 再补测试 |
| F-05-26 | 空历史置灰 | 代码有 `disabled`，零断言 | 直接补 L1 |
| F-05-27 | 导出上限与导入对齐 | **功能缺失**（只有 ZIP64 硬限） | 功能单（#336）→ 再补测试 |
| F-05-28 | 导出后立即导入（往返） | 无任何往返用例 | 先有 F-05-23 的用例骨架 |
| F-05-30 | 磁盘空间不足 | **功能缺失**（只有 console 留痕） | 功能单（文案 + 降级）→ 再补测试 |
| F-05-31 | 进程被杀后的孤儿暂存 | 代码有 `clearStaging`，零断言 | 直接补 L0 |
| F-05-32 | 清空历史后再导入 | 无 | 直接补 L0/L1 |
| F-05-33 | 导入/导出/清空串行互斥 | 代码有 `enqueueBackup` 与 `importingHistory` 守卫，零断言 | 直接补 L0 |

> **这 10 项全部集中在「导出侧」与「写库失败/生命周期」两侧**，而「下载与解析」侧几乎条条有测试——这是本域覆盖形状的真相：**入口做了 90 分的防守，出口只做了 0 分**。

## 五、这个域里最脆弱的 3 个点（按历史 bug 密度）

统计口径：`git log --oneline -- src/services/chat/history src/services/chat/backup.ts src/components/settings/SettingsDialog.tsx` 中标题为 `fix(import)` / `fix(history)` / `fix(i18n)` 且指向本域的修复提交，共 **14 个**修复提交（另加 2 个无单号的热修 `e5c78fd` / `a2290c5`）。分布极不均匀：

### 1. 下载终态判定：停滞 / 总预算 / 墙钟跳变（`urlImport.ts`，1434 行）

**修复史**：#38（120s 总预算误杀 164.5MB 合法包，三次在 47.4/54.3/65.4MB 处被判死，且重试从 0 开始）→ #151（`Date.now` 前跳一小时即判超时；回拨产生 −3600000ms 耗时）→ #152（预算耗尽被写成「长时间无响应」；200MB÷120s 要求 ≥1.67MB/s 的常量不自洽）→ 热修 `e5c78fd`（wall-clock 总预算兜底终态 + 心跳）、`a2290c5`（15s 静默默认看门狗）。红队 `c1-trickle` / `c2-clock` 至今在基线里是 **known-defect**。

**为什么最脆弱**
- 判据是「时间 × 字节 × 并发信号」的三元耦合：`lastProgressAt` + `stallMs` + `deadline` + 原生 Promise 可能永不 settle，任何一处算术或时钟口径错就变成「合法包被判死」。
- 三个常量互相牵连（200MB / 30min / 40s），#152 已经证明它们会不自洽；现在靠 `minRequiredBytesPerSec` 推导 + 断言兜住，但**只要有人改一个数、不动另一个，就是又一次线上误杀**。
- 弱网不可复现：只能在 L0 用假时钟 + 假 `CapacitorHttp` 复现，L1 也只能近似。而真实答案是「慢」，测试写「快」，天然有缝。

### 2. 失败原因分档与文案（`importFailure.ts` + `urlImport.ts` 分类块 + i18n）

**修复史**：#111（`ECONNREFUSED` 被说成「网络已断开」；三档塌成一句）→ #18（补 `unreachable` 档：有网但够不到服务）→ #154（`navigator.onLine === false` 未参与判定；禁用端口空转重试 2 次）→ #203（离线/不可达文案再分档）→ #195（读取失败把英文 DOMException 原文抛给用户）。同一句用户可见提示，**改了 5 轮**。

**为什么最脆弱**
- 分类输入是「异常字符串匹配」，而 WebView 各版本、各厂商 ROM 措辞不同（`Failed to fetch` / `ERR_UNSAFE_PORT` / `ERR_NAME_NOT_RESOLVED` …）。每来一个新机型就可能多一条漏网串，而 `classifyImportFailure` 认不出来时返回 `null` → 退化成通用文案，**不会报错、也不会红**，只会在用户反馈里出现。
- 文案与 L1 断言逐句绑定（`url-import-stages.test.mjs` 里 8 个用例直接断言中文原文），改文案就红一片——于是修文案的成本高到让人倾向「不改」，问题被冻结而不是被修好。
- 三分之二的分支只靠 L0 纯函数钉住，**端到端只有 7 条**，且全部基于打桩错误串，真机上的「真错误串」从未被采集入库。

### 3. 归档结构容错：顺序 / 重名 / 解压上限 / 条目名长度 / 单条跳过（`importArchive.ts` + `zipReader.ts` + `toLocal.ts`）

**修复史**：#32（夹具按真实导出顺序写图片，导入兜底带条目定位）→ #40（manifest 校验错误折叠成 `backupIncomplete`）→ #49（单条失败整包回滚；跳过条目不可见）→ #153（四处缺口一次修：条目顺序敏感、重名塌缩、无解压上限、文件名无长度上限）。红队 `a2` / `a3` 曾经就是这三条的红灯。

**为什么最脆弱**
- 容错规则是**矩阵式**的：谁先到（manifest/index/会话/图片）× 谁重复（文件/目录/NFC）× 谁超限（总量/比值/名字长），组合数远大于用例数；#153 一次补四处说明这块是「按缺陷长出来的」，不是按设计长出来的。
- 导入是**单遍流式 + 边写暂存**：任何一条分支写错，结果不是「报错」而是「半导入」，而半导入的用户感知是「我的会话变少了」——最贵的一类投诉。
- 容错与严格性互相拉扯：#49 放宽成「能导的先导」，但索引完整性又必须严格（`import-skipped-ui` [4] 专门守住「放宽但不放水」）。这个张力的边界只写在一个测试文件的注释里。

### 补充：本域最该被当成「第 4 个脆弱点」的东西

**导出侧（`exportArchive.ts` / `zipWriter.ts` / `ExportHistory` 组件）**：它不脆弱在「修过很多次」，而脆弱在**从来没被验证过**——同一份格式定义，导入侧被 14 个修复单打成了筛子，导出侧一行测试都没有；而 #336 正在改它（进度、置灰说明、上限对齐）。**改动正在发生 + 覆盖为零 = 当前风险最高的位置**。

## 六、最小充分集：9 条新增用例覆盖全部 33 个功能点

> 口径（维护者口径）：**测试点尽量少、覆盖尽量全**。本域分支最多，所以下面不是「再补 33 条」，而是
> **先做减法（第六.3 节，淘汰 147 条），再用 9 条表驱动用例把 33 个功能点全部吃掉**。

### 6.1 三条主轴：用一张表吃掉一族分支

| 主轴 | 一张表的行 = 一族分支 | 为什么能合并 |
| --- | --- | --- |
| **A. 归档失败矩阵** | 每行 = 一种「坏包」构造（manifest 非首条 / 空包 / 截断 / CRC 错 / 路径穿越 / 重名 / index 在前 / 图片在会话前 / 多余未引用 / 索引缺会话 / 索引重复 id / 解压总量超 / 压缩比超 / 声明尺寸撒谎 / 条目名超长 / 超长名放行），列 = 期望错误码 + 是否写暂存 + 文案定位 | 全部走同一个入口 `checkArchiveFormat`/`importArchive`，只换 ZIP 构造器与期望值；现有 34 条用例的分支差异**只有输入和期望码** |
| **B. 下载状态机表** | 每行 = 一种服务端行为（206 连续 / 206 缺 `Content-Range` / 206 `total=*` / 200 忽略 Range / 416 落在末尾且字节已齐 / 416 中途 / 40s 无字节 / 30min 预算耗尽 / 同链接续传 / 换链接丢续传点 / 时钟前跳回拨），列 = 期望终态 + 文案 key + 是否留续传点 + 发出几次请求 | 同一套 `CapacitorHttp` stub + 假时钟，只换「第 N 次请求返回什么」；现有 23 条用例全是同一 stub 的不同剧本 |
| **C. 导出 + 导出失败** | 成功路径一张表（纯文本 / 含图片 / 含跳过 / 空历史 / 超 200MB 待 #336），失败路径一张表（会话中途被删 / 无配额 / TXT 桥四态） | 导出侧**零覆盖**，没有存量要迁，天然可以一次写成表驱动 |

### 6.2 拟定用例小表（9 条）

| 拟定用例 | 层级 | 表驱动? | 覆盖功能点 ID | 覆盖分支数 | 不可合并原因 |
| --- | --- | --- | --- | --- | --- |
| **N1 下载状态机表**（复用现有 `url-harness` stub） | L0 | ✅ 11 行 | F-05-02、03、04、05、06、07、22 | 11 | 与 N2 不可合并：N1 观察「下载层状态与请求序列」，N2 观察「分类器输出与文案」，桩不同层 |
| **N2 失败档位矩阵表** | L0 | ✅ 14 行 | F-05-08（含 8 类原因 + 403 三档 + 非原生平台） | 14 | 同上；且它是纯函数 + 文案断言，不需要网络桩 |
| **N3 归档失败矩阵表** | L0 | ✅ 16 行 | F-05-13、14、15、16、17、19、18（图片引用越界行） | 16 | 与 N5 不可合并：N3 断言「整包被拒」，N5 断言「跳过 N 条、其余照常入库」，一个期望抛错一个期望成功 |
| **N4 上限与总长判定表** | L0 | ✅ 8 行 | F-05-20、21、22 | 8 | 与 N1 不可合并：本篇验「拒绝时机（解析前）+ 边界不缩水」，行数少但断言面是 `stages()` 调用序列，塞进状态机会让 N1 行数翻倍 |
| **N5 跳过与降级矩阵表** | L0 | ✅ 7 行 | F-05-12、18、19 | 7 | 见 N3；新增 3 行补「缺原件只留文件名」「MIME 不可识别仍按图片」「单张图片 CRC 坏」 |
| **N6 导入→导出→再导入 往返表** | L0 | ✅ 3 行 | F-05-23、28（+ 复用 F-05-17 校验） | 3 | 与 N3 不可合并：N3 是「坏包必须被拒」，N6 是「自产包必须被接受」，反向契约；共用夹具但断言相反，合并会把「导出写坏了」伪装成「导入变严了」 |
| **N7 导出器契约 + TXT 桥表** | L0 | ✅ 5 行（4 行 ZIP + 4 行 TXT 子表压成 1 条） | F-05-23、26、27、29（JS 侧） | 9 | TXT 桥与 ZIP 导出不可合并成两条（产物/契约不同），但可放同一文件的两张子表 → 仍算 **1 条** |
| **N8 存储失败与生命周期表** | L0 | ✅ 6 行 | F-05-30、31、32、33 | 6 | 与 N5 不可合并：N8 的失败点是 **IndexedDB 事务/配额** 而不是归档内容，桩在 db 层；这是本域唯一测「写库失败」的地方 |
| **N9 UI 单通路（导入 + 导出 + 置灰）** | L1 | ⚠️ 半表（1 条用例、2 个动作、共享同一 page 上下文） | F-05-01、09、10、11、23、26、28 | 7 | 不可下放 L0：需要真实 DOM（确认弹窗、进度文案、`disabled` 态），且必须验「同一页面里先导出再导入」 |

**合计：9 条新增**（上限 8–10 内）。其中 N4/N5/N7/N8 行数均 ≤ 8，N3 最多 16 行，**总断言量 ≈ 81 行表驱动**，替换掉现有 147 条独立用例。

**F-05-24 / F-05-25（导出进度、导出取消）现在无法写**：功能缺失（#336 open）。落实后在 N7 表尾各加 1 行、N9 加 1 个 `disabled`/进度断言即可，**不新增用例条数**。

### 6.3 先做减法：现有用例的去向与削减量

现有本域用例规模（`grep -cE "^test\(" + integration 用例块 + adversarial case 文件）：

| 现有资产 | 条数 | 去向 | 削减 |
| --- | --- | --- | --- |
| `unit/import-error-copy`(6) + `import-unreachable-copy`(6) + `import-network-classification`(4) + `regression/issue-111`(10) | 26 | → **N2** 一张 14 行表 | −26 |
| `unit/url-import-stall`(12) + `import-budget-vs-stall`(4) + `import-clock-monotonic`(2) + `regression/issue-38`(2) + `adversarial/c1,c2,c3`(3) | 23 | → **N1** 一张 11 行表 | −23 |
| `unit/import-size-limit`(6) + `regression/issue-34`(3) + `import-refuse-before-download`(6) + `url-import-content-range`(6) | 21 | → **N4**（8 行）+ N1 两行 | −21 |
| `unit/import-hardening`(14) + `import-archive-manifest`(6) + `import-archive-unclassified`(3) + `regression/issue-32`(3) + `adversarial/a1–a8`(8) | 34 | → **N3** 一张 16 行表（保留 `adversarial/lib/**` 造包工具与 `baseline.json` 说明） | −34 |
| `unit/import-partial-skip`(4) + `import-skipped-ui`(5) + `regression/issue-49`(7) | 16 | → **N5** 一张 7 行表 | −16 |
| `unit/archive-fixture-roundtrip`(2) | 2 | → 并入 **N6**（保留 8 会话真实夹具那一行） | −2 |
| `unit/export-text-bridge`(4) | 4 | → 并入 **N7** TXT 子表 | −4 |
| `integration/url-import-stages`（18 用例 / 79 断言） | 18 | 分支细节全部下沉到 N1–N5，只留 **4** 条跨层必需的：分阶段进度文案、原生桥契约与 data 形态、取消后界面恢复、详情脱敏复制 | −14 |
| `integration/url-import-native`（8 用例 / 34 断言） | 8 | 与 stages **合并为同一文件**（超限、取消、403、非 ZIP 两边各测一遍），留 2 条 | −6 |
| `integration/url-import-web`（1 流程） | 1 | → 并入 **N9** | −1 |
| `adversarial/b1,b2,b3`（10MB 单条 / 2000 轮 500 会话 / 10 万 emoji） | 3 | **保留**：验的是规模与耗时，不是分支，不可表驱动 | 0 |
| `device/url-import-device`（1 脚本 / 32 断言） | 1 | **保留**：L3 真机，不进 CI | 0 |
| `unit/limits-config` 中本域 2 条（上限唯一来源、上限÷预算关系断言） | 2 | **保留**：这是常量不自洽的门禁，删了就回到 #152 | 0 |

**削减合计 = 147 条**（本域现有 159 条计入项 → 保留 12 条 + 新增 9 条 = **21 条**，用例条数 −87%，覆盖的功能点从 23 项升到 33 项）。
注：另有 `adversarial/d1` 一条属兼容探针（WebView 特性下线判定），不属本域计数。
**净收益**：功能点覆盖 23 → 33（+10），用例条数 159 → 21（−87%），新增的 10 项全部落在现在零覆盖的出口侧与失败侧。

**必须保留、不可合并的三处（含理由）**

1. `adversarial/b1–b3`：验「10MB 单条消息 / 2000 轮 500 会话 / 10 万 emoji」的**规模与耗时**，结论是数值（186ms、512760px）不是布尔分支，表驱动会把规模变成行内参数从而掩盖退化。
2. `device/url-import-device`：唯一真 WebView + 真 `CapacitorHttp` 的用例（L3），它验的是「内核差异」，L0/L1 永远替代不了。
3. `unit/limits-config` 的本域 2 条：它们断言的是**常量之间的关系**（`200MB ÷ 30min ≥ 最低带宽`），是本域唯一防「改一个数不改另一个」的闸门，与任何行为用例都不同层。

### 6.4 覆盖核对（33 个 ID → 用例）

| 用例 | 功能点 |
| --- | --- |
| N1 | 02 03 04 05 06 07 22 |
| N2 | 08 |
| N3 | 13 14 15 16 17 19 (+18 越界行) |
| N4 | 20 21 22 |
| N5 | 12 18 19 |
| N6 | 23 28 |
| N7 | 23 26 27 29 |
| N8 | 30 31 32 33 |
| N9 | 01 09 10 11 23 26 28 |
| 存量保留（stages 4 + native 2 + b1–b3 + device + limits 2） | 01 08 09 10 11 29（真机侧） |
| **仍无任何用例** | **24 25**（功能缺失，#336 落地后**在 N7/N9 加行，不加用例**） |

**结论：33 个功能点全部有用例归属，其中 31 项由 9 条新增用例承担，2 项因功能未实现而暂缓（不新增用例、不新开条数）。**

## 七、复现本盘点的命令

```bash
# 代码范围与规模
wc -l src/services/chat/history/*.ts src/services/chat/backup.ts src/services/limits.ts

# 本域用例全量（L0）
grep -rln "url-import\|urlImport\|importArchive\|exportArchive\|zipReader\|zipWriter\|importLimit\|importFailure\|backup.js" tests | sort
# L1
grep -rln "从链接导入\|确认导入历史对话\|input\[type=\"file\"\]\[accept\*=\"zip\"\]" tests
# 导出侧（预期：只命中夹具）
grep -rln "exportHistory\|exportArchive\|zipWriter\|writeArchive" tests
# 10 条零测试项的关键词（预期：无命中）
grep -rln "clearHistory" tests; grep -rn "QuotaExceeded\|ENOSPC" src; grep -rn "导出了\|导出全部" tests

# 修复史（脆弱点依据）
git log --oneline -- src/services/chat/history src/services/chat/backup.ts src/components/settings/SettingsDialog.tsx

# 红队基线（注意：不进 run-layer 门禁）
node tests/adversarial/run-adversarial.mjs
```

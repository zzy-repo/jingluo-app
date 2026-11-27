# Storage Protection：快照覆盖范围、RPO 与不可恢复边界（#909）

供 #924 验收。事实来源是 `src/services/protection/` 与对应单测；「实测」一栏只写单测里亲眼看到的结果，
**没有任何一项经过真机或模拟器验证**。

## 1. 保护机制一览

| 机制 | 存放位置 | 触发 | 失败时 |
| --- | --- | --- | --- |
| 高水位标记 | Native：应用私有目录下 protection 子目录里的 highwater 标记文件（带 sha256）；Web：localStorage | 每次保存成功后（只升不降） | Native 写失败抛 `InfraError`（不降级 localStorage / 内存）；Web 写失败返回 `failed` |
| 瘦快照 | `snapshots/<ts>.json`，保留最近 5 份；恢复前备份 `snapshots/pre-restore-<ts>.json`，另留 2 份 | 保存成功后，节流 15s；切后台 / pagehide 绕过节流；节流命中时补一次尾部快照 | 返回 `quota` / `failed` 并记一条诊断，不影响保存 |
| 满盘预检 | 读 `AppFileSystem.freeBytes()`（缓存 10s） | 每次保存前 | 读不到记 `unknown`，不当成「足够」，不升档 |
| 摘要自愈 | IndexedDB `sessionSummaries` | 启动 | 失败整体回滚，列表保持原样 |
| 恢复 | 整包替换通道（`importHistoryInto` overwrite → `commitStaging`，单事务） | 仅用户在横幅里确认后 | 取消 / 校验失败 / 备份失败 / 提交失败都不改动现有数据 |

## 2. 快照覆盖范围

| 数据 | 在快照里 | 说明 |
| --- | --- | --- |
| 会话标题、创建 / 更新时间、置顶、自定义系统提示 | 是 | |
| 用户消息文本 | 是 | |
| 助手回复的**文本块** | 是 | 思考块、联网搜索块、引用、用量、错误详情**不在** |
| 消息树结构（parentId / selectedChildId / rootMessageId） | 是 | 分支版本的选择保留 |
| 会话级分支来源（branchOf） | 是 | |
| 附件**元信息**（id / 名称 / 大小 / 是否图片） | 是 | 恢复后 `serverId=null`、`mimeType=''`，界面按「附件不可用」处理 |
| 图片与文档附件**原件**（`files` store） | **否** | 见 ADR 0910-blob-storage |
| 附件解析全文（`attachmentTexts`）、附件元数据表（`attachments`） | **否** | |
| 会话记忆（`sessionMemory`） | **否** | 派生数据，丢了可重算；恢复后为空 |
| 聊天背景等应用素材（`appAssets`） | **否** | |
| 设置、API Key、登录态、诊断日志 | **否** | 不在 IndexedDB 会话库里，也不属于本机制 |
| 恢复时「正在生成」的回复 | 恢复为「已停止」 | 不会凭空变回生成中 |

## 3. RPO（恢复点目标）

- **上界 = 节流间隔 15s + 一次快照写入耗时**（`SNAPSHOT_MIN_INTERVAL_MS`，集中在 `protection/constants.ts`）。
  依据：保存成功 → 若距上次快照 ≥15s 立即写；否则排一个 15s 后的补写（`T1` 用例：连续被节流只排一个，补写的快照包含最后一次保存的数据）。
- 切后台 / pagehide 绕过节流立即补写，所以「用户离开」这一最常见的杀进程前一刻 RPO ≈ 0。
- **进程被直接杀死**（不经过切后台）：最坏丢失最近 ≤15s 的会话文本。
- 快照是**整库文本**的全量副本（不是增量），所以任意一份有效快照都能独立恢复到它的时间点。
- Web 与 iOS：没有私有目录，**没有快照，RPO 不适用**（`supported=false`，返回 `unsupported`）。
- 实测（单测，内存文件系统，非真机）：S3 节流窗口内第二次写返回 `throttled`，`force` 绕过；T1 尾部补写覆盖最后一次保存。**真机上的写入耗时与 I/O 抖动未测**，所以 RPO 里的「一次快照写入耗时」没有真机数字。

## 4. 不可恢复边界（诚实清单）

1. **最近 ≤15s 内、且未经过切后台的会话文本**（上面 RPO）。
2. **所有二进制原件**：聊天图片、文档附件原文。快照不含它们；库被清后这些文件不可恢复，只能重新上传。
3. **没有快照的情形**：全新安装后尚未保存过；Web / iOS；Native 但私有目录写入一直失败（会有诊断记录）；快照目录被用户清了应用数据。
4. **应用数据被一并清除**：「清除应用数据」会同时删掉 IndexedDB 与私有目录，高水位和快照都没了，无从判断也无从恢复。
5. **Web 端 localStorage 被清**：高水位失效，库被清时**不会提示**（已知盲区，Native 端以私有目录标记为准）。
6. **库没被清、只是部分会话损坏**：不在本机制范围；坏的会话由现有读取路径（`normalizeSession`）处理，快照不会自动覆盖它。
7. **快照与库之间的 schema 差异**：来自更新库版本的快照拒绝恢复（`incompatible`），提示先更新应用。
8. 恢复本身不可逆的部分：替换后现有会话被快照内容取代。**恢复前一定先备份当前状态**（`pre-restore-<ts>.json`，保留 2 份）；备份失败则不恢复。

## 5. 灾难场景与行为（对应 #924 六类）

| 场景 | 行为 | 单测 |
| --- | --- | --- |
| 库整个消失（Chromium 判损坏后整库删除） | 启动判定 `dataLost`，不显示干净欢迎页；横幅明示「本机的聊天记录已被系统清除」；有快照给恢复入口，没有则说明 | `protection-highwater-909` D3 |
| 库损坏读不出来（blocked / version） | 沿用现有 `initFailure` 路径（#916 范围），本机制不介入 | 既有用例 |
| 快照文件损坏（校验和 / 半截 / 未知版本） | 读成 null、记诊断；列表里标「已损坏」且不给恢复按钮；恢复返回 `corrupt`，不碰数据 | `protection-snapshot-909` F3，`protection-restore-909` R3 / L1 |
| 快照写入中途中断（ENOSPC / 崩溃） | 旧快照完好、无半成品；返回 `quota` / `failed` | `protection-snapshot-909` F1 / F2 / F4 |
| `sessionSummaries` 缺失 / 不一致 | 启动自愈，原子重建，失败回滚 | `protection-heal-909` H1–H7 |
| 附件原件缺失 | 引用方按现有「附件不可用」状态展示；快照恢复后的附件即此状态 | `protection-restore-909` R1（元信息保留、`serverId=null`） |

任何路径都**不自动删除数据库或备份**，也不自动覆盖恢复；恢复必须由用户在横幅里确认。

**D3 的界面证据**（浏览器视口截图，**不是真机**）：`docs/ui/909-protection/360/01-data-lost-banner.png`、
`docs/ui/909-protection/390/01-data-lost-banner.png` —— 只覆盖「库从有到无 + 本机没有快照」这一态，
看到的是横幅文案与「没有恢复入口」的分支；恢复列表 / 确认 / 进度需要原生私有目录里的真快照，
本目录没有对应截图。逐帧说明见 `docs/ui/909-protection/README.md`。

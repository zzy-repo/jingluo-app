# 存储抽象（Issue #906，阶段 A：接口）

阶段 A 只定义接口与本文档，**不改** `src/services/chat/db.ts`、不改任何调用方、不引入 SQLite。
类型在 [`src/services/storage/types.ts`](../src/services/storage/types.ts) 与
[`src/services/storage/openStorage.ts`](../src/services/storage/openStorage.ts)，两个文件都只有类型，
没有运行时逻辑。

现状的事实来源是 `src/services/chat/db.ts`（1440 行，库 `chat-demo`，`DB_VERSION = 15`，9 个 store）。
本文每条「现状」都指得到具体函数，便于后续阶段核对「薄适配是否真的零行为变化」。

## 1. 接口总览

七个接口，外加一个工厂签名。

| 接口 | 管什么 | 对应现状 |
| --- | --- | --- |
| `SessionRepo` | 会话、摘要、置顶/重命名/删除、按引用反查、按分支来源反查 | `db.ts` 的会话四个写函数 + 两个读函数 |
| `BlobRepo` | 二进制原件（聊天图片与文档附件原件**共用键空间**） | `files` store |
| `AssetRepo` | 应用级素材（聊天背景） | `appAssets` store |
| `AttachmentRepo` | 附件元数据 + 解析全文 + 引用计数删除 + 清孤儿 | `attachments/store.ts` 全部 |
| `MemoryRepo` | 窗口记忆（按会话隔离） | `memory/sessionMemory.ts` 的五个存储操作 |
| `StagingRepo` | 导入暂存、整包替换、增量合并 | `db.ts` 的 `clearStaging` 到 `mergeStaging` |
| `StorageBackend` | 上面六个的聚合 + `runAtomic` / `close` / `health` / `probe` | `getChatDB()` 这一层 |

工厂签名是 `OpenStorage = () => Promise<StorageBackend>`（`openStorage.ts`）。
失败时 reject 的类型与今天 `getChatDB()` 相同：`StorageUnavailableError` /
`StorageBlockedError` / `StorageVersionTooNewError`，三个类继续从 `db.ts` 导出，接口层不另定义。

### 设计原则（逐条）

**a. 按需求设计，不按 IndexedDB 的形状设计。**
接口里没有 index 名、cursor、`IDBKeyRange`、`IDBPDatabase`、事务对象。
今天用游标的地方一律换成下面两种之一：

- 分页：`Page<T> = { items, next }`，`next` 是上一页最后一条的**主键**（不是偏移量，
  偏移量在并发写时会漏行或重复行），见 `SessionRepo.listFull`、`BlobRepo.listKeys`；
- 按条件查询：`SessionRepo.listReferencing(fileId)` 取代 `sessionSummaries.fileIds` 索引的 `count()`，
  `SessionRepo.listBranchesOf(parentId)` 取代 `sessionSummaries.branchOf` 索引。

排序由方法自己规定并写在注释里，不由调用方传排序键（排序键是实现细节）。

**b. 原子批是一等公民。**
两种表达，都用：

- `StorageBackend.runAtomic(work, options?)`：回调里对本实例各仓储的写，要么全提交要么全回滚。
  SQLite 端是 `BEGIN IMMEDIATE`（`AtomicOptions.immediate` 缺省 `true`），IDB 端是一个 `readwrite` 事务。
  不允许嵌套，回调抛错则回滚并原样抛出。
- 各仓储方法的注释里写明「此方法是一个原子单元」以及**单元的边界**（含哪些、不含哪些）。
  第 3 节是完整的一张表。

**c. 错误模型沿用现状，不新造。**
四类 `StorageFailureKind`（`quota` / `clone` / `unavailable` / `unknown`）与三个错误类保持不变，
判定仍然只认 `error.name`（`db.ts` 的 `classifyStorageFailure`，各引擎的 `message` 写法不一致）。
接口层只抛这些；各后端负责把底层错误映射进来，映射表在第 4 节。

**d. Blob 与文本分层，不假设同事务。**
`BlobRepo` 允许单独一个后端实例（将来原件落原生文件系统，文本留 SQLite）。
因此**没有任何接口方法承诺「blob 与会话文本在同一个事务里」**。
今天实际依赖这个承诺的路径共三条，逐条的等价表达在第 3 节末尾。
`SaveSessionOutcome.degradedFiles`（`FileDegradation`）这套「原件写失败只降级、会话已落盘」的语义原样保留。

**e. 现状的每个导出都能被薄适配还原。**
第 2 节把 `db.ts` 的每一个导出对应到新接口的一个方法（或明确标成「不进接口，留在兼容层」）。
后续阶段把调用方迁走时，旧导出保留为「调新接口」的薄包装，行为不变。

## 2. `db.ts` 导出 → 新接口映射表

`db.ts` 共 54 个导出：41 个值（函数/常量/类）、13 个类型（任务书说 38，与实际口径差在是否数类型与常量；本表按全部 54 个逐个核对，已用脚本确认没有遗漏）。
分三组：业务操作 18 个值、错误模型与纯函数 14 个值、存储机制 9 个值，加 13 个类型。

### 2.1 业务操作（18 个值）—— 17 个有对应方法，`reportStorageError` 留兼容层

| 现状导出 | 新接口方法 | 说明 |
| --- | --- | --- |
| `loadSessionSummaries` | `SessionRepo.listSummaries` | 语义相同，排序仍由调用方做 |
| `loadSession` | `SessionRepo.get` | |
| `saveSession` | `SessionRepo.save` | 返回值类型不变（`SaveSessionOutcome`） |
| `pinSession` | `SessionRepo.pin` | |
| `renameSession` | `SessionRepo.rename` | |
| `deleteSession` | `SessionRepo.delete` | 原子边界见第 3 节 |
| `saveFiles` | `BlobRepo.putMany` | |
| `loadFile` | `BlobRepo.get` | |
| `clearStaging` | `StagingRepo.clear` | |
| `addStagingSession` | `StagingRepo.addSession` | 键冲突抛错（现状是 `add` 不是 `put`） |
| `saveStagingFiles` | `StagingRepo.putFiles` | |
| `updateStagingFileTypes` | `StagingRepo.updateFileTypes` | |
| `commitStaging` | `StagingRepo.commit` | |
| `mergeStaging` | `StagingRepo.merge` | 入参 `MergePolicy`、返回 `MergePlan` 不变 |
| `loadAppAsset` | `AssetRepo.get` | |
| `saveAppAsset` | `AssetRepo.put` | `updatedAt` 仍由实现填 |
| `deleteAppAsset` | `AssetRepo.delete` | |
| `reportStorageError` | （不进接口） | 它是 `console.error` 的薄包装，与存储后端无关，留在兼容层 |

### 2.2 错误模型与纯函数（14 个值 + 类型）—— 不进接口，留在兼容层

这些是**纯函数或常量**，不碰存储，后端无关：`StorageFailureKind`、`StorageFailure`、
`STORAGE_FAILURE_KINDS`、`isStorageFailureKind`、`classifyStorageFailure`、`storageFailureOf`、
`normalizeStorageFailure`、`SaveBannerTier`、`saveBannerTierOf`、`selectSaveBannerTier`、
`SaveBannerMessageKey`、`SAVE_BANNER_MESSAGE`、`saveBannerRetryable`、`stripNonCloneableFields`、
`FileDegradation`、`SaveSessionOutcome`、`SaveSessionOptions`。

外加三个错误类与两个常量：`StorageUnavailableError`、`StorageBlockedError`、
`StorageVersionTooNewError`、`BLOCKED_TIMEOUT_MS`、`StorageInitFailure`。

`types.ts` 把调用方需要的那几个类型 **re-export** 了一遍（`StorageFailure`、`SaveSessionOutcome`、
`StoredFile`、`StoredAsset`、`StoredAttachmentText`、`StoredSessionMemory`、`FileDegradation`、
`StorageInitFailure`），这样新代码可以只 import `services/storage`。**定义仍在 `db.ts`**，
不搬 —— 搬了就是改调用方的 import，超出本阶段范围。

### 2.3 存储机制（9 个值 + 5 个 Stored* 类型）—— 收进 `StorageBackend`，或明确留在 IDB 后端内部

| 现状导出 | 去向 | 理由 |
| --- | --- | --- |
| `getChatDB` | `OpenStorage`（工厂） | 返回值从 `IDBPDatabase` 换成 `StorageBackend`，IDB 句柄不再出边界 |
| `openChatTransaction` | `StorageBackend.runAtomic` | 事务对象不出边界 |
| `runChatStoreRequest` | 各仓储的单操作方法 | 单表请求是仓储方法的内部实现 |
| `isIndexedDBAvailable` | `StorageBackend.health` | 能力探测是后端的事，调用方只看 `health` |
| `ensurePersistentStorage` | `OpenStorage` 的实现内部 | 今天它由 `getChatDB()` 顺带触发、幂等、不阻塞；工厂实现照做 |
| `isStoragePersisted` | `StorageBackend.probe` 的 `persisted` 字段 | |
| `DB_VERSION` / `DB_NAME` | 留在 `db.ts` | 测试夹具 `tests/helpers/chat-db.mjs` 从这里取（#547），且 `check:db-version` 门禁认定版本号只有这一个来源。换后端后 SQLite 没有这个概念，不该进接口 |
| `upgradeChatDB` | 留在 IDB 后端内部 | 签名里全是 `IDBPDatabase` / `IDBPTransaction`，正是原则 a 要藏起来的东西。迁移不变量用例直接 import 它，所以它继续导出 |
| `StoredFile` / `StoredAsset` / `StoredAttachment` / `StoredAttachmentText` / `StoredSessionMemory` | 类型，re-export（见 2.2） | `StoredAttachment` 就是 `DocumentAttachment` 的别名，接口直接用 `DocumentAttachment` |

### 2.4 不在 `db.ts` 但属于同一层的操作

这些今天散在别的文件里，直接碰 IDB 原语，接口把它们收进来（第 5 节列了每处怎么迁）：

| 现状 | 新接口方法 |
| --- | --- |
| `attachments/store.ts` 的 `saveNewAttachment` | `AttachmentRepo.add` |
| `putAttachment` / `getAttachment` / `listAttachments` | `AttachmentRepo.put` / `get` / `list` |
| `readAttachmentTextRecord` / `writeAttachmentTextRecord` | `AttachmentRepo.readText` / `writeText` |
| `removeAttachment` | `AttachmentRepo.remove` |
| `sweepOrphanStorage` | `AttachmentRepo.sweepOrphans` |
| `removeUnreferencedAttachments` | `AttachmentRepo.removeUnreferenced` |
| `memory/sessionMemory.ts` 的 `readMemoryEntry` | `MemoryRepo.get` |
| `listMemoryEntries` | `MemoryRepo.listBySession` |
| `saveMemoryEntry` 的事务部分 | `MemoryRepo.put`（容量策略不进仓储，见下） |
| `deleteMemoryEntry` | `MemoryRepo.delete` |
| `clearSessionMemory` | `MemoryRepo.clearSession` |
| `attachments/manager.ts` 的 `collectReferencedAttachmentIds` | `SessionRepo.listFull` 分页 + 调用方自己滤 `att-` 前缀 |

`saveMemoryEntry` 拆成两半是有意的：容量上限、超限拒绝、淘汰提示（toast + 诊断日志）是产品策略，
不是存储原语。仓储只保证「写新行 + 删调用方指定的老行」在一个原子单元里。

## 3. 原子边界表

「原子单元」= IDB 端一个 `readwrite` 事务，SQLite 端一个 `BEGIN IMMEDIATE`。
下表每个写方法一条，含**现状的事务参与者**与**接口承诺的边界**。两者不一致的地方单独标出。

| 方法 | 原子单元含 | 原子单元不含 | 现状依据 |
| --- | --- | --- | --- |
| `SessionRepo.save` | `sessions` + `sessionSummaries`（事务 A） | `files`（事务 B，失败只进 `degradedFiles`） | `db.ts` `writeSessionRecordOnce` 与 `writeAttachmentBlobs` 是两个事务，注释写明「不再是一个原子事务」 |
| `SessionRepo.pin` / `rename` | 读旧会话 + 写会话 + 写摘要 | — | `db.ts` 各自一个事务 |
| `SessionRepo.delete` | 会话 + 摘要 + 归零引用的聊天原件 + 本会话全部记忆 | 文档原件、附件元数据、解析全文、其它会话的记忆 | `db.ts` `deleteSession`：事务 store 是 `sessions, sessionSummaries, files, sessionMemory` |
| `BlobRepo.putMany` | 这一批原件 | 任何会话写入 | `db.ts` `putFiles` |
| `BlobRepo.clearExcept` | 一次清空（保留命中 `keep` 的键） | — | 今天没有独立函数，是 `commitStaging` 内部的 `clearFilesKeepingAttachmentBlobs`；抽出后仍要求单事务 |
| `AssetRepo.put` / `delete` | 单条 | — | `db.ts` `runChatStoreRequest` |
| `AttachmentRepo.add` | 原件去重写入 + 元数据插入 | 解析全文（另一次写） | `store.ts` `saveNewAttachment` |
| `AttachmentRepo.writeText` | 单条全文 | 元数据 | `store.ts` `writeAttachmentTextRecord` |
| `AttachmentRepo.remove` | 元数据 + 归零引用的全文 + 归零引用的原件 | — | `store.ts` `removeAttachment`，引用数在事务内现数 |
| `AttachmentRepo.sweepOrphans` | 全文清扫 + 文档原件清扫 | 聊天图片、元数据 | `store.ts` `sweepOrphanStorage` |
| `AttachmentRepo.removeUnreferenced` | **每条 `remove` 各自一个单元，整体不是** | — | `store.ts` 逐条 `await removeAttachment`，中途失败只影响后面的条 |
| `MemoryRepo.put` | 写新行 + 删 `evictIds` | 容量判定本身（调用前已完成） | `sessionMemory.ts` `saveMemoryEntry` 的事务 |
| `MemoryRepo.clearSession` | 本会话全部记忆行 | 其它会话 | `sessionMemory.ts` `clearSessionMemory` |
| `StagingRepo.clear` | 两个暂存区一起清 | 正式数据 | `db.ts` `clearStaging` |
| `StagingRepo.updateFileTypes` | 全部暂存会话的改写 | — | `db.ts` `updateStagingFileTypes` 单个游标事务 |
| `StagingRepo.commit` | 清会话/摘要/记忆 + 换聊天原件 + 搬入 + 清暂存 | 文档原件（保留）、附件元数据与全文 | `db.ts` `commitStaging` |
| `StagingRepo.merge` | 判定 + 写会话/摘要 + 搬原件 + 清暂存 | **记忆**（增量导入不删会话，不动记忆） | `db.ts` `mergeStaging`，注释明确「不碰记忆」 |
| `StorageBackend.runAtomic` | 回调里写到的、**本实例**的全部仓储 | 另一个实例（见下） | 新增能力，现状没有跨 store 的通用事务入口 |

### 3.1 今天「会话与 blob 同事务」、接口不再这么承诺的三条路径

原则 d 要求接口不假设 blob 与文本同库。这三条是现状里真正跨在两边的，逐条给等价表达：

1. **`deleteSession`**：删会话时把「引用归零的聊天原件」一起删，同一个事务，失败整体回滚
   （不会出现「会话没了、原件还在被计数」的窗口）。
   等价表达：`SessionRepo.delete` 的契约把这件事**写进方法本身**，而不是让调用方用 `runAtomic`
   拼出来。实现时，若 blob 与文本分属两个后端，这一条做不到严格原子 —— 见第 6 节的开放问题 1，
   默认决定是「文本先提交，blob 清理失败则记 `StorageFailure` 并留给清扫」，因为方向反了会更糟
   （先删原件再删会话失败 = 用户的图丢了而会话还在）。

2. **`commitStaging`**：替换聊天原件与替换会话在同一个事务，失败则正式数据完全不变。
   等价表达：`StagingRepo.commit` 的契约同样把边界写进方法。分库时的默认决定见开放问题 1：
   先写文本侧（会话/摘要/记忆/暂存），成功后再换 blob 侧；blob 侧失败**不回滚文本**，
   而是返回明确的失败（调用方今天靠「抛错 = 什么都没发生」判断，所以这一步必须改成返回值，
   不能偷偷吞掉）。这是本设计里**唯一一处接口语义比现状弱**的地方，单独标出来。

3. **`mergeStaging`**：同 2，且只搬「判定为写入」的会话的原件。处理方式与 2 相同。

`saveSession` **不在这三条里**：它已经是两个事务（P0 的改动，`db.ts` 1098 行的注释），
`degradedFiles` 就是为这个窗口设计的，接口原样保留。

## 4. 错误映射表

分类只有四个，判定只看名字（沿用 `classifyStorageFailure` 的理由：`message` 各引擎写法不一致）。

| 底层错误 | `StorageFailureKind` | 谁映射 |
| --- | --- | --- |
| IDB `QuotaExceededError`、Firefox `NS_ERROR_DOM_QUOTA_REACHED` | `quota` | IDB 后端 |
| SQLite `SQLITE_FULL`（数据库或磁盘满） | `quota` | SQLite 后端 |
| IDB `DataCloneError` | `clone` | IDB 后端 |
| SQLite 无对应（绑定参数不存在「克隆」这回事） | — | 结构化失败在入库前由 `stripNonCloneableFields` 处理，不进后端 |
| IDB `UnknownError`（WebKit 写 blob，不区分因）、`NotSupportedError`、`SecurityError` | `unavailable` | IDB 后端 |
| SQLite `SQLITE_CORRUPT`、`SQLITE_NOTADB`、打开即失败 | `unavailable` | SQLite 后端 |
| IDB `InvalidStateError`（连接正在关闭）、`AbortError` | `unknown`（可重试） | IDB 后端 |
| SQLite `SQLITE_BUSY`、`SQLITE_LOCKED` | `unknown`（可重试） | SQLite 后端 |
| 宿主无此能力（无 IndexedDB / 打不开库文件） | 抛 `StorageUnavailableError` | 两个后端 |
| 升级被其它连接挡住超时 | 抛 `StorageBlockedError` | IDB 后端（SQLite 无此概念，不抛） |
| 库版本比代码新 | 抛 `StorageVersionTooNewError` | 两个后端 |

重试策略不变：`quota` 清一次孤儿再试一次，`clone` 剔一次字段再试一次，其余不重试
（`db.ts` `writeSessionRecord` 的两条自愈）。**【决定 2026-11-26】`SessionRepo.save` 内含这两次自愈**，
`SaveSessionOutcome` 原样返回；孤儿清扫（`sweepOrphanFiles`）是 IDB 实现的内部细节，不进接口。
理由：目标是行为零变化，且 `save` 的返回值本来就是「自愈之后的结果」；SQLite 实现按同样口径自带自愈。

## 5. `db.ts` 之外泄漏 IDB 语义的位置

只列**直接碰 IDB 原语**的（`openChatTransaction` / `runChatStoreRequest` / cursor / `objectStore` / `index`）。
import 了 `db.ts` 的业务函数（`loadFile`、`saveSession` 等）不算泄漏，它们走的是已有的函数边界。

| 位置 | 泄漏了什么 | 迁移办法 |
| --- | --- | --- |
| `src/services/attachments/store.ts` 全文（6 个导出函数直接开事务） | 事务对象、`index('sha256').count()`、`index('parsedTextPath').count()`、`openKeyCursor()` | 整体变成 `AttachmentRepo` 的 IDB 实现；引用计数改走 `SessionRepo.listReferencing` 与仓储内部的计数，索引名不出实现文件 |
| `src/services/attachments/manager.ts:511` `collectReferencedAttachmentIds` | 对 `sessions` 手写 `openCursor()`，把全表逐条扫一遍 | 改为分页调用 `SessionRepo.listFull`，`att-` 前缀过滤留在这里（它是附件层的知识，不该进会话仓储） |
| `src/services/memory/sessionMemory.ts:236、341、362、384` | 四个函数各自 `openChatTransaction` / `runChatStoreRequest`，并用 `index('sessionId')` | 变成 `MemoryRepo` 的 IDB 实现；`sessionId` 索引变成 `listBySession` 的内部细节 |
| `src/services/attachments/blobKeys.ts` | 不碰 IDB，但它存在的原因是 `db.ts` 与 `store.ts` 不能互相 import | 抽象后 `commit` 的实现自己拿得到「哪些键是文档原件」的判定，这个文件的循环依赖理由消失；文件本身保留（判定口径仍只能有一份） |
| `src/services/diagnostics/collector.ts:160` | 另开一套库 `chat-diagnostics`（`DB_VERSION = 1`，单 store） | **不迁。** 诊断日志是独立库、独立生命周期，不在 #906 的九个 store 里。记在这里只为说明「仓库里还有第二份 IDB」，免得后面有人以为漏了 |

import 了 `db.ts` 的文件共 14 个（任务书列了 12 个，另有 `chat/history/importArchive.ts`、
`chat/history/exportArchive.ts`，它们用 `db.clearStaging` / `saveStagingFiles` / `addStagingSession` /
`updateStagingFileTypes` / `loadFile`，都在第 2.1 节映射内）：`App.tsx`、`MessageFile.tsx`、
`useAttachmentDrafts.ts`、`SettingsDialog.tsx`、`chat/backup.ts`、`chat/store.ts`、
`chat/branchAttachments.ts`、`chat/background.ts`、`chat/appAssets.ts`、上面的 `attachments/manager.ts`、
`attachments/store.ts`、`memory/sessionMemory.ts`在后续阶段改为依赖 `StorageBackend`，
本阶段不动。其中 `store.ts` 与 `useAttachmentDrafts.ts` 只用了错误模型的纯函数，
迁移时可以继续直接从 `db.ts` 取，不必绕接口。

## 6. 开放问题与默认决定

1. **分库后跨后端的原子性**（第 3.1 节的三条）。
   默认决定：文本侧先提交，blob 侧后清理；blob 侧失败不回滚文本，改为**返回失败**而不是抛「什么都没发生」。
   理由：反方向（先删 blob）在失败时会丢用户的原件而会话还在，比「多留一份可清扫的原件」更难恢复。
   这条只在真的拆成两个后端时生效；单后端（今天的 IDB、以及 SQLite 单库）保持现状的严格原子。

2. **`MemoryRepo.put` 让调用方传 `evictIds`，容量策略留在外面。**
   默认决定：仓储不做容量判定。
   理由：淘汰规则（条数上限、字节上限、不淘汰刚写的那条、toast 与诊断日志）今天全在 `sessionMemory.ts`，
   且有测试钉住；放进仓储会让两个后端各实现一次策略。代价是调用方要先读再写，
   「读」与「写」之间不再原子 —— 只在并发写同一会话的记忆时有差别。**未核实**今天的写入口是否保证串行，实现阶段需要先查 `saveMemoryEntry` 的调用方；若不能保证，改为 `MemoryRepo.put` 接受容量参数、仓储内部算淘汰集。

3. **分页的默认 `limit`。**
   默认决定：不传 `limit` 时返回全部，由各方法注释写明。
   理由：现状的 `getAll()` 就是这个语义，薄适配才能零改动；真要防大结果集，调用方显式传。

4. **`AttachmentRepo.removeUnreferenced` 不是单个原子单元。**
   默认决定：保持现状（逐条 `remove`），不升级成大事务。
   理由：它跨了元数据、全文、原件三个 store 还要逐条现数引用，卷成一个事务会把所有附件的写都堵住；
   而它本来就是「删除会话后的收尾」，跑到一半失败再跑一次是安全的（每条 `remove` 自己幂等）。

5. **工厂如何选择后端。**
   默认决定：本阶段不写选择逻辑，只留 `StorageBackendKind` 这个类型。
   理由：选择依赖运行环境（Capacitor 壳里 WebView 也有 IndexedDB），而环境探测属于实现阶段。

6. **自愈（清孤儿重试、剔字段重试）放哪。**
   **决定（覆盖原默认）：进 `SessionRepo.save`**（第 4 节末尾）。原默认「留兼容层」会让 `save` 的返回值与
   现状 `saveSession` 不一致，违背零行为变化；`sweepOrphanFiles` 因此不需要进接口。

## 7. 架构门禁（#910 storage-callers）

`tests/unit/storage-boundary.test.mjs`（单元测试形态，**不是**新增 CI 步骤）断言：`src/` 里除
`src/services/storage/**`、`src/services/chat/db.ts` 自身与豁免清单之外，没有任何文件
import `chat/db.ts` / `attachments/store.ts` 的存取导出，或直接使用 `indexedDB` /
`openChatTransaction` / `runChatStoreRequest` / `getChatDB` / `idb`。纯函数、错误类、常量、
类型与原件键口径（见测试里的 `PURE_DB_EXPORTS` / `PURE_STORE_EXPORTS`）可以继续直接取。

豁免清单：`tests/fixtures/storage/storage-boundary-exemptions.json`，只许缩不许涨
（测试里 `MAX_EXEMPTIONS`），条目不再违规时测试判红要求删条目。当前两条：
`attachments/store.ts`（IDB 后端的实现细节，SQLite 后端落地后并入 `storage/idb/`）、
`diagnostics/collector.ts`（独立诊断库，不迁，见第 5 节）。

### 台账登记草稿（供 lead 决定，**未改** `docs/testing/gates-ledger.md`）

门禁形态是 `tests/unit` 下的一个用例，不新增 `scripts/check-*.mjs`、`package.json` 别名与 `ci.yml` 步骤，
所以台账第 3.2 节五样里只适用第 5、2 两项；是否仍要登记由 lead 定。若登记，按第 3.1 节四问：

| 问 | 草稿 |
| --- | --- |
| Q1 事故 | 因为曾经有人在业务文件里直调 `db.ts` / 直开 IDB 事务，Native 迁到 SQLite 后这些调用仍读写旧 IDB，用户新写的数据落进「不再是真源」的库，更新后历史对不上（D5：`committed` 之后真源只有 SQLite）。 |
| Q2 证据 | 迁移前 `src/` 有 12 个文件直调 `db.ts`/`store.ts`（#906 第 5 节列 14 个，含 2 个只用纯函数的）；本 PR 逐个迁走。尚无线上事故，这是**预防性**门禁，按 Q2 口径可能被打回，请 lead 判断是否登记。 |
| Q3 为什么现有门禁防不住 | `infra-boundary.test.mjs` 只管 `native/` 与 `storage/**` 内部的依赖方向，不管业务层绕过 `getStorage()`；`check:db-version` 只守版本号来源。 |
| Q4 自证伪 | 用例内含检测器自检（违规写法必须被抓到，合规写法不许误报）；人工负向对照：往 `appAssets.ts` 注入 `import { loadFile } from './db.js'` 与往 `MessageFile.tsx` 注入 `indexedDB` 记号，均变红并点名文件，还原后转绿。 |
| 归属 / 红了第一件事 | storage-callers（#910）。点名的文件改走 `getStorage()`；确属实现细节的才进豁免清单并写原因。 |
| 豁免载体（台账 5.2 补一行） | `tests/fixtures/storage/storage-boundary-exemptions.json`：到期判据 = 条目不再违规即判红；只许缩不许涨（`MAX_EXEMPTIONS`）。 |

## 7. #926 语义定案（2026-11-27，收敛阶段，原则：保持现有业务行为、不引入静默截断/扩大删除/虚报持久化）

| # | 条目 | 决定 | 理由 |
|---|---|---|---|
| 1 | `PageQuery.limit` 缺省 | 实现可自定上限（IDB 现状是一次给全；SQLite 用 999），**调用方不得依赖「不传就全给」**，要全量就顺着 `next` 读完 | 契约套件已按此改写（顺 `next` 读），两个后端都能过 |
| 2 | `listKeys` / `listFull` 的「主键升序」 | 按 **UTF-16 码元序**（JS 字符串 `<` 的序）。IDB 原生如此；SQLite 主键列用 UTF-16BE BLOB 编码，`memcmp` 序与之一致 | 换后端不改调用方；避免 `WHERE key > ?` 在含 BMP 外字符时漏行/重复（#921 实测） |
| 3 | `close()` 之后 | 仓储读写与 `runAtomic` 一律 reject `StorageUnavailableError`；`health()` 返回 `{ok:false,initFailure:'unavailable'}`，`probe()` 不抛 | 「不得静默返回空结果」优先；把 `health/probe` 排除在「一律抛」之外是因为它们是探针 |
| 4 | `runAtomic` 参与的 store | 实现自定（IDB 固定 9 个 store 的 readwrite；SQLite 一个 `BEGIN IMMEDIATE`）。**回调只拿到 `AtomicRepos`**，7 个自带事务边界的方法类型上不存在 | 接口不承诺后端做不到的事 |
| 5 | `runAtomic` 内的读写可见性 | read-your-writes 在本批内可见；嵌套 `runAtomic` 必须被拒绝（IDB 与 SQLite 均已实现拒绝）；并发批的排队顺序不作承诺 | 与现状一致，且两个后端可做到 |
| 6 | 空包 `commit` / `merge` 覆盖语义 | **保持现状**（IDB 行为）：空暂存的 `commit` 会清空正式会话/摘要/记忆/聊天原件并返回 `[]`；`merge` 覆盖是整条替换（本地 `pinnedAt` 丢失、旧原件成孤儿） | 这是现状事实，改它会改变业务行为；已作为「看似 bug」登记，需要单独决策 |
| 7 | `StorageProbe.persisted` | 宿主没有 `navigator.storage` 时为 `undefined`；有则是布尔 | 与 IDB 现状一致 |

**两条 IDB 后端偏离（不是契约写错）**：`blobs.putMany` 非全成全败、`runAtomic` 嵌套未拒绝 → 已修复嵌套拒绝（`AtomicRepos` + 实现拒绝）；`putMany` 的非原子性登记在契约的 `knownDeviations`，收口到 #930。

> 结论：除「空包 commit/merge」按现状保留外，其余六条在 IDB 与 SQLite 两侧均已对齐；契约套件的 `knownDeviations` 只减不增。

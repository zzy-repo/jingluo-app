# SQLite Schema 与 IDB 字段映射（#910）

审计对象：`chat/db.ts` 的 9 个 store（`DB_VERSION = 15`，库名 `chat-demo`）。
口径：每个字段都要能无损往返，历史/可选/已废弃字段不例外；**不改业务语义**。

## 1. 哪些值 JSON 装不下

依据：读 `chat/types.ts`、`attachments/types.ts`、`db.ts`、`store.ts`、`sessionMemory.ts`、`branches.ts`
的写入路径（静态审计），加 Node 22 上对 `structuredClone` 的直接实测（`undefined` 值保留键、稀疏数组保留洞）。
**没有**对真机 IDB 里的存量数据做过扫描，所以下表「没有写入路径产出」的结论只对当前代码成立，
存量行里是否有别的形态要靠迁移时的编码器兜底（不认识就抛错）。

| 类型 | 实测出现处 | 结论 |
|---|---|---|
| `Blob` | `files.blob`、`filesStaging.blob`、`appAssets.blob` | 唯一的二进制字段，走分块 BLOB（§3），不进 JSON |
| 缺键 vs 值为 `undefined` 的键 | 可选字段（`pinnedAt`、`branchOf`、`vec` …）通常是缺键；但 `selectedChildId: messages[i+1]?.id` 这类写法（`branches.ts`）会产出**值为 `undefined` 的键** | 实测 `structuredClone({a: undefined})` **保留键 `a`**（Node 22），IDB 读回同样带这个键。所以两者必须区分：缺键保持缺键，`undefined` 值保持 `undefined` 值 |
| `Date` / `NaN` / `Infinity` / `Map` / `Set` / `ArrayBuffer` / `Uint8Array` / 稀疏数组 | 静态审计未发现产出它们的写入路径 | 编码仍支持并往返（见 §4），因为「今天没有」不等于「迁移那天没有」：IDB 不校验形状，旧版本或外部改动都可能留下 |
| 函数 / symbol / `WeakMap` 等 | 写不进 IDB（`DataCloneError`，`stripNonCloneableFields` 会先剔） | 编码遇到**不认识的类型直接抛错**，不静默丢 |

时间字段（`createdAt` / `updatedAt` / `pinnedAt` …）全部是 `number` 毫秒时间戳，不是 `Date`。

## 2. 表设计（每 store 一张表）

统一形状：主键列 + 被查询/索引用到的派生列 + `doc` TEXT（该行完整原值的无损 JSON，Blob 字段除外）。

为什么派生列而不是生成列：`doc` 是带类型标签的编码（§4），不是裸 JSON，SQLite 的
`json_extract` 取不到原值；派生列在写入时由代码填，读回时以 `doc` 为准重建原值
（派生列只服务查询与索引，不参与还原）。

| 表 | 主键 | 派生列（只为查询/索引） | 对应 IDB store |
|---|---|---|---|
| `sessions` | `id TEXT` | — | `sessions`（keyPath `id`） |
| `session_summaries` | `id TEXT` | `branch_of TEXT`（`branchOf.sessionId`，可空） | `sessionSummaries` |
| `files` | `id TEXT` | — | `files` |
| `sessions_staging` | `id TEXT` | — | `sessionsStaging` |
| `files_staging` | `id TEXT` | — | `filesStaging` |
| `app_assets` | `key TEXT` | — | `appAssets`（keyPath `key`） |
| `attachments` | `id TEXT` | `sha256 TEXT`、`parsed_text_path TEXT`（可空） | `attachments` |
| `attachment_texts` | `key TEXT` | `sha256 TEXT` | `attachmentTexts`（keyPath `key`） |
| `session_memory` | `id TEXT` | `session_id TEXT`、`created_at INTEGER` | `sessionMemory` |

索引（与 IDB 一一对应，另加记忆排序所需的一列）：

- `session_summary_file_ids(file_id, summary_id)`：IDB `sessionSummaries.fileIds` 的 **multiEntry** 索引。
  SQLite 没有多值索引，拆成关联表；一行摘要的 `fileIds` 有几个元素就有几行，**重复值保留重复行**
  （IDB multiEntry 对重复值建多个索引项，`count(fileId)` 会计多次，这里对齐）。
- `session_summaries(branch_of) WHERE branch_of IS NOT NULL`：IDB `branchOf`（keyPath `branchOf.sessionId`，
  缺字段的记录不进索引，这里用部分索引对齐）。
- `attachments(sha256)`、`attachments(parsed_text_path) WHERE parsed_text_path IS NOT NULL`：
  缺 `parsedTextPath` 的记录 IDB 不进索引，查询按等值匹配不受影响，部分索引只是对齐这个事实。
- `attachment_texts(sha256)`。
- `session_memory(session_id, created_at, id)`：IDB `sessionId` 索引只承担「按会话取全量」，
  排序在 JS 里做（`createdAt` 升序、同毫秒按主键升序）；这里把排序键放进索引，结果相同。

**没有外键，也没有 `ON DELETE CASCADE`。** 逐条核对过引用关系，级联都会改变行为：

| 引用 | 现状的删除行为 | 级联会破坏什么 |
|---|---|---|
| 会话 → 摘要（同 id，应用层成对写） | 只在 `delete` / `commit` 里成对删 | 没有「删会话行就该删摘要」的数据库级规则可挂（两张表互不引用） |
| 摘要 `fileIds` → `files` | `delete` 时**现数引用**，归零才删；`save` 失败的原件留着（`degradedFiles`） | CASCADE 会在摘要更新时删掉仍被引用或待重试的原件 |
| 摘要 `branchOf.sessionId` → 会话 | **不删**：父会话删除后分支会话照常存在，只是徽标降级 | CASCADE 会把分支会话一起删掉 |
| 记忆 `sessionId` → 会话 | `delete` 删本会话记忆；但 `merge` 明确不碰记忆，单独的 `clearSession` 也不删会话 | 外键方向反了：记忆行不该因会话行变化被级联 |
| 附件 `localPath` → `files` | `remove` 时按 `sha256` **现数**，归零才删；`add` 的旧版字节序兼容会让 `sha256` 与键不一致 | CASCADE 按键删，数不对；且会误删 `attachment-` 前缀之外的键 |
| 附件 `parsedTextPath` → `attachmentTexts` | 同口径现数 | 同上 |
| `appAssets` 的 `chat-background:session:<id>` → 会话 | 应用层在删会话时另行清理，**不在 `deleteSession` 的事务里** | CASCADE 会把它卷进会话删除，改变原子边界 |

引用计数因此全部在仓储方法里现数（SQL `COUNT(*)`），与 IDB 的「事务内 `index.count()`」同口径。

## 3. 二进制：分块 BLOB（plan D3）

`files` / `files_staging` / `app_assets` 的 blob 不进 `doc`，进 `blobs` 表：

```sql
CREATE TABLE blobs (
  owner    TEXT NOT NULL,   -- 'files' | 'files_staging' | 'app_assets'
  id       TEXT NOT NULL,   -- 该行主键
  seq      INTEGER NOT NULL, -- 0 起的块序号
  data     BLOB NOT NULL,   -- 每块 ≤ 512 KiB（最后一块可以更短）
  total    INTEGER NOT NULL, -- 全部块字节之和，每行冗余一份便于校验
  sha256   TEXT NOT NULL,   -- 整体 sha256（hex，小写）
  mime     TEXT NOT NULL,   -- Blob.type；空串 = 无类型
  PRIMARY KEY (owner, id, seq)
);
```

- 读回按 `seq` 升序拼装，校验块数连续、字节总和等于 `total`、整体 sha256 一致，任一不符抛错
  （不把损坏数据当成读成功）。
- MIME 随块保存：`doc` 里的 blob 字段只留类型标签 `{"$t":"blob","mime":"..."}`，字节不进 JSON。
- 写是「先删旧块再写新块」，与所在行的 upsert 在同一事务里，不留半份块。
- 为什么三张表共用一张块表：备份是 `VACUUM INTO` 整库，分表没有收益；`owner` 把清表的范围圈死。

## 4. `doc` 的编码（带类型标签，往返相等）

编码只为「结构化克隆能存、JSON 不能存」的值服务。标签是 `{"$t":...}`：

| 值 | 编码 | 往返 |
|---|---|---|
| `undefined` 值（对象键的值、数组元素） | `{"$t":"undefined"}` | 还原为 `undefined`，键保留（`Object.keys` 与源一致） |
| 数组洞（稀疏数组） | `{"$t":"hole"}` | 还原为洞（`i in arr` 为 false），长度一致；与显式 `undefined` 元素区分 |
| `Date` | `{"$t":"date","v":<epoch ms>}` | `new Date(v)`，非法日期编码成 `null` 毫秒并还原成 Invalid Date |
| `NaN` | `{"$t":"nan"}` | `Object.is` 相等 |
| `Infinity` / `-Infinity` | `{"$t":"inf","v":1|-1}` | 同上 |
| `-0` | `{"$t":"negzero"}` | `Object.is` 相等 |
| `bigint` | `{"$t":"bigint","v":"<十进制>"}` | 往返相等 |
| `Map` | `{"$t":"map","v":[[k,v],...]}` | 插入顺序保留 |
| `Set` | `{"$t":"set","v":[...]}` | 插入顺序保留 |
| `ArrayBuffer` | `{"$t":"ab","v":"<base64>"}` | 字节相等 |
| `Uint8Array` 及其它 TypedArray / `DataView` | `{"$t":"ta","c":"<构造器名>","v":"<base64>"}` | 类型与字节都相等 |
| `RegExp` | `{"$t":"re","s":"<source>","f":"<flags>"}` | source 与 flags 相等 |
| `Blob` / `File` | `{"$t":"blob","mime":"..."}`（字节在 `blobs` 表；File 另带 `name` / `lastModified`） | 见 §3 |
| 对象上的非数字键、键顺序 | JSON 对象 | 键顺序保留 |

**不认识的类型抛 `SqliteCodecError`（kind `clone`），不编码。** 包括：函数、symbol、`WeakMap` /
`WeakSet`、带原型的类实例、循环引用。这些 IDB 本来就存不进去，迁移期遇到说明源行损坏，
按 plan §5「部分行损坏」处理（该行失败，不丢字段装成功）。

数字范围：超过 `2^53-1` 的整数 IDB 结构化克隆会丢精度，这里同样以 number 传递，不升级成 bigint。

## 5. 逐 store 字段清单

「历史」= 旧版本写入过、当前类型里仍保留或读路径仍认的字段。全部进 `doc`，一个不丢。

### 5.1 `sessions`（主键 `id`）

`Session`（`chat/types.ts`）全字段：

| 字段 | 类型 | 备注 |
|---|---|---|
| `id` `title` | string | 必有 |
| `createdAt` `updatedAt` | number | 毫秒时间戳 |
| `messages` | `Message[]` | 见下表；含全部分支，按创建顺序 |
| `rootMessageId` | `string \| null`，可缺 | 缺省 = 线性列表（旧数据）；`null` = 空会话 |
| `pinnedAt` | number，可缺 | 缺省 = 未置顶；置顶/取消由 `pin` 删键或写值 |
| `customSystemPrompt` | string，可缺 | |
| `userIdentity` | string，可缺 | **已废弃**：读取时 `normalizeSession` 把它并进 `customSystemPrompt`。库里的旧行仍可能带它，迁移必须原样保留（归一是读路径的事，不是存储的事） |
| `background` | `{style, opacity, blur}`，可缺 | 图片本体不在这里，在 `appAssets` |
| `branchOf` | `{sessionId, messageId?, createdAt}`，可缺 | #831；缺省 = 不是分支 |

`Message` 是 `UserMessage | AssistantMessage`，共有 `id` / `role` / `createdAt` / `parentId?` /
`selectedChildId?`。其余：

- user：`content`、`files`（`{id, serverId, name, size, isImage, mimeType}`，`serverId` 可为 null，
  `mimeType` 可为 `''`）、`unavailable?`（`{id, name, reason}`，#379）、`availableAtSend?`。
- assistant：`model`（可为 null）、`thinking?`、`search?`、`latestReminder?`、`prefix`、`status`
  （`pending|streaming|done|stopped|error`）、`blocks`、`stopReason?`、`stopDetails?`、`usage?`、`error?`。
- `blocks` 三种：`thinking`（`thinking` / `signature?` / `startedAt?` / `endedAt?` / `elapsedSeconds?`）、
  `text`（`text` / `citations?` / `isTemplate?`）、`ServerToolBlock`（`server_tool_use` /
  `web_search_tool_result` / `web_fetch_tool_result`，字段见 `api/types.ts`，含可 null 的
  `title` / `site_icon` / `site_name` / `page_age` / `published_at` 与可缺的 `image_url` / `signature`）。
- `error`：`kind`、`message`、`status?`、`upstreamCode?`、`code?`、`localMessage?`、`detail?`、
  `keyFailure?`（`{kind, source, tail}`）、`retryable?`。
- `usage`：四个 token 计数 + 可缺的 `server_tool_use`。

旧数据形态（读路径认、写路径不再产出，**库里可能仍在**）：没有 `rootMessageId` 的线性会话、
带 `userIdentity` 的会话、没有 `parentId` 的消息、`error` 缺新字段的旧行。全部原样进 `doc`。

### 5.2 `sessionSummaries`（主键 `id`）

IDB 值是 `StoredSessionSummary = SessionSummary & { fileIds: string[] }`，**不是** `SessionSummary`：
`loadSessionSummaries` 读出后才用 `toSessionSummary` 剥掉 `fileIds`。迁移读的是原值，所以 `fileIds` 必须在。

| 字段 | 备注 |
|---|---|
| `id` `title` `createdAt` `updatedAt` | 必有 |
| `pinnedAt?` | 与会话同步；缺键 = 未置顶 |
| `branchOf?` | `{sessionId, messageId?, createdAt}`；派生列 `branch_of` 取 `sessionId` |
| `fileIds` | **派生字段**，由 `referencedFileIds` 计算：全部 user 消息 `files[].id` 去重后的数组。多值索引用它。旧行可能没有这个键（`?? []` 口径），读回保持原样，查询按「没有 = 不引用」处理 |

### 5.3 `files` 与 `filesStaging`（主键 `id`）

`StoredFile = { id: string, blob: Blob }`。`blob` 进 `blobs` 表（owner 分别为 `files` / `files_staging`），
`doc` 只留 `{"id":"...","blob":{"$t":"blob","mime":"..."}}`。

键空间两条：聊天图片用附件本地 id；文档原件用 `attachment-<sha256>`（`blobKeys.ts` 的
`ATTACHMENT_BLOB_PREFIX`，判定只认这一份）。两者同表，靠前缀区分，**仓储不内置前缀规则**
（`clearExcept` 的 `keep` 由调用方给）。

### 5.4 `sessionsStaging`（主键 `id`）

值就是 `Session`，字段同 §5.1。与正式会话的差别只在写入方式：`add` 键冲突**抛错**而不是覆盖
（IDB 的 `add` vs `put`）。

### 5.5 `appAssets`（主键 `key`）

`StoredAsset = { key: string, blob: Blob, updatedAt: number }`。blob 进 `blobs`（owner `app_assets`）。

已知的 key（应用层知识，仓储不解释）：`chat-background`（全局默认图）、
`chat-background:session:<sessionId>`（每会话自定义图）。生命周期独立于会话：
`SessionRepo.delete` 不碰它（与 `deleteSession` 的事务范围一致）。

### 5.6 `attachments`（主键 `id`）

`DocumentAttachment` 全字段：`id`、`filename`、`mimeType`、`size`、`sha256`、`localPath`、
`parsedTextPath?`、`status`（`pending|parsing|success|partial|failed`）、`characterCount?`、
`estimatedTokens?`、`totalPages?`、`extractedPages?`、`warnings?`、`errorMessage?`、
`parserVersion?`、`createdAt`。

派生列：`sha256`（引用计数）、`parsed_text_path`（可空，缺键 = NULL，与 IDB「缺字段不进索引」一致）。
`localPath` 是 `files` 的键，口径是 `attachmentBlobKey` = `attachment-` + sha256；旧版 WebCrypto
字节序兼容会让它变成 `attachment-` + 反序摘要（`store.ts` 的 `legacyHash`），所以**不能**由
`sha256` 列反推 `localPath`，以 `doc` 里的原值为准。

### 5.7 `attachmentTexts`（主键 `key`）

`StoredAttachmentText`：`key`（`${sha256}:${parserVersion}`）、`sha256`、`parserVersion`、`text`、
`characterCount`、`status`（只可能是 `success|partial`）、`totalPages?`、`extractedPages?`、
`warnings?`、`createdAt`。

`pageChars` **不在这里**：它是 `ParsedDocument` 的返回字段，写缓存时没有落库（`writeAttachmentTextRecord`
的字段清单里没有它）。迁移不补、不丢（源行没有就没有）。

### 5.8 `sessionMemory`（主键 `id`）

`StoredSessionMemory`：`id`（`${sessionId}:${key}`，会话 ID 不许含 `:`）、`sessionId`、`key`、`text`、
`vec?`（`number[]`，关闭 embedding 时整键不写）、`model?`、`dim?`、`bytes`、`createdAt`、`updatedAt`。

派生列 `session_id` + `created_at` 服务 `listBySession` 的排序（`createdAt` 升序、同毫秒按 `id` 升序）。

## 6. 无损论证（每个字段 IDB → SQLite → 读回）

1. 结构化字段全部进 `doc`，编码对 §1 实测到的与 §4 列出的类型往返相等；不认识的类型抛错而不是丢。
2. Blob 走分块表，读回校验长度与 sha256，MIME 保留；`File`（带 `name` / `lastModified`）还原成 `File`。
3. 派生列（`fileIds` 关联表、`branch_of`、`sha256`、`parsed_text_path`、`session_id`）从**同一个原值**
   计算，与 IDB 写路径的计算口径相同（`referencedFileIds`、keyPath 取值）；读回以 `doc` 重建，
   不从派生列反推，所以派生列的取整/截断不可能污染原值。
4. 缺键保持缺键、`undefined` 值保持 `undefined` 值：编码不把 `undefined` 补成 `null`，读回 `Object.keys` 与源一致（Node 22 实测 `structuredClone` 保留 `undefined` 值的键，见 §1）。
5. 键顺序保留（JSON.stringify 的插入顺序）；IDB 结构化克隆同样保留字符串键顺序。

验证（测试尚未写，随交付 6 提交）：往返用例（tests/unit 下的 storage-sqlite-roundtrip，随交付提交）将用覆盖 §5 全部字段、含旧字段与边界值的
9 个 store 样本走 `sink.writeBatch → source.readBatch`，与原值深度相等（Blob 比字节、Date 比时间、
`undefined` 比缺键）。

## 7. SQL 层面的已知限制

| 限制 | 值（Node 22 自带 SQLite，编译期常量） | 我们的位置 |
|---|---|---|
| `SQLITE_MAX_VARIABLE_NUMBER` | 32766（实测 Node 22 / SQLite 3.53.4：32767 个绑定参数报 `too many SQL variables`；旧版 SQLite 默认 999，原生插件的版本以 `info().sqliteVersion` 为准，不假设） | 单条 SQL 的绑定参数不超过它。批量 upsert 按行分批，每行参数数 ≤ 10，单批 ≤ 90 行（按 999 的旧下限留余量，不依赖具体 SQLite 版本） |
| `SQLITE_MAX_LENGTH`（单行/单 blob/单 SQL） | 1_000_000_000 字节 | 一个块 ≤ 512 KiB，远低于它；`doc` 是整行 JSON，理论上限约 1 GB |
| `SQLITE_MAX_COLUMN` | 2000 | 全部表 ≤ 10 列 |
| 页数 × 页大小 = 库最大体积 | 默认约 1 TB 量级，实际先撞磁盘 | 磁盘满由 `SQLITE_FULL` → `quota` 报告，不静默截断 |
| Android `CursorWindow` 单行约 2 MB | 原生侧限制，不是 SQLite 的 | 块 ≤ 512 KiB 就是为它留的余量（plan D3）；JS 侧一次只取一块 |

`doc` 过大的处理：写入前不截断、不压缩（压缩会让「读回 == 原值」多一层可失败的环节）。
单行超过 `SQLITE_MAX_LENGTH` 时 SQLite 抛 `SQLITE_TOOBIG`，映射为 `unknown` 并带上主键，
该行失败、其余行不受影响——与 plan §5「部分行损坏」的口径一致（宁可该行迁移失败，也不截断用户的会话）。
按现有数据形状，一个会话要超过 1 GB 的 JSON 才碰得到这条，实际先撞磁盘配额。

## 8. `meta` 与版本

`meta(key TEXT PRIMARY KEY, value TEXT)` 预留给 switch-recovery：`engine_version`（迁移引擎版本）、
`migrated_from`（源库指纹/版本）、`committed_at`（切换时间，毫秒字符串）。
`PRAGMA user_version` 是**库结构**版本，当前 = 1；前向迁移表在 `schema.ts`，现在只有 v1 一条。
两者不是一回事：`user_version` 管 DDL，`meta.engine_version` 管迁移引擎。

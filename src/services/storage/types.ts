/**
 * 存储抽象的公共类型（Issue #906 阶段 A）。
 *
 * 本目录只有类型与接口，**零运行时逻辑**：任何函数、类、常量都不许出现在这里。
 * 现有实现仍在 `src/services/chat/db.ts` 与 `attachments/store.ts`、`memory/sessionMemory.ts`；
 * 迁移（把调用方从那些导出改到这里的接口）是后续阶段的事，本阶段不改任何调用方。
 *
 * 设计原则见 `docs/storage-abstraction.md`。这里只重复一条，因为它决定了本文件能 import 什么：
 * **接口按需求设计，不按 IndexedDB 的形状设计**。所以这里不出现 index 名、cursor、
 * `IDBKeyRange`、`IDBPDatabase`、事务对象 —— 需要「一批一批读」的地方是 `Page<T>`，
 * 需要「要么全成要么全不成」的地方是 `StorageBackend.runAtomic`。
 */
import type { MergePlan, MergePolicy } from '../chat/history/mergeSessions.js'
import type { DocumentAttachment } from '../attachments/types.js'
import type { Session, SessionSummary } from '../chat/types.js'
import type {
  FileDegradation,
  SaveSessionOptions,
  SaveSessionOutcome,
  StorageFailure,
  StorageFailureKind,
  StorageInitFailure,
  StoredAsset,
  StoredAttachmentText,
  StoredFile,
  StoredSessionMemory,
} from '../chat/db.js'

export type {
  FileDegradation,
  SaveSessionOptions,
  SaveSessionOutcome,
  StorageFailure,
  StorageFailureKind,
  StorageInitFailure,
  StoredAsset,
  StoredAttachmentText,
  StoredFile,
  StoredSessionMemory,
}

// ---------------------------------------------------------------- 分页

/**
 * 一页结果。`after` 是**上一页最后一条的主键**（不是偏移量）：
 * 偏移量在「读的过程中有人插入/删除」时会漏行或重复行，而主键游标不会。
 * `next` 为 `null` 表示没有下一页。
 *
 * 排序由各方法自己规定（写在该方法的注释里），不由调用方传排序键 ——
 * 排序键是实现细节，换后端不该让调用方改代码。
 */
export type Page<T> = {
  items: readonly T[]
  next: string | null
}

export type PageQuery = {
  /** 上一页最后一条的主键；缺省 = 从头开始 */
  after?: string
  /** 本页最多多少条；缺省由实现定（文档里写明），调用方不该依赖「不传就全给」 */
  limit?: number
}

// ---------------------------------------------------------------- 原子批

/**
 * 一次原子批里能做的事。
 *
 * 约束（写进类型，免得实现时再发明）：
 * - 回调里**只能**调用各仓储方法，不能再调 `runAtomic`（嵌套事务各后端语义不同，IDB 没有嵌套）；
 * - 回调抛出的任何错误 → 本批整体回滚，错误原样抛给 `runAtomic` 的调用方；
 * - 回调的返回值在提交成功后原样返回。
 */
export type AtomicWork<T> = (repos: StorageRepos) => Promise<T>

/**
 * 原子批的选项。
 *
 * `immediate`：SQLite 端对应 `BEGIN IMMEDIATE`（一开始就拿写锁，避免升级死锁）。
 * IDB 端没有这个区别（`readwrite` 事务本来就在开始时定死参与的 store），忽略即可。
 * 缺省 `true`：本仓库的写事务全部是「上来就要写」，没有「先读再决定要不要写」的长事务。
 */
export type AtomicOptions = {
  immediate?: boolean
}

// ---------------------------------------------------------------- 健康探测

/** 打开 / 启动期失败的两档（沿用 `db.ts` 的 `StorageInitFailure`，不另起一套）。 */
export type StorageHealth =
  | { ok: true }
  | { ok: false; initFailure: StorageInitFailure | 'unavailable' }

/** `probe()` 的结论：比 `health()` 多「库是否比代码新」「是否已被持久化」两项。 */
export type StorageProbe = {
  health: StorageHealth
  /** 库版本比本构建新（回滚到旧代码）：对应 `StorageVersionTooNewError` */
  versionTooNew: boolean
  /** 宿主是否已批准持久化存储；`undefined` = 这个宿主没有这套 API */
  persisted: boolean | undefined
}

// ---------------------------------------------------------------- 会话

export type SessionRepo = {
  /** 全部摘要。排序不保证，调用方沿用现有 `sortSessions`。单次只读，非原子批的一部分。 */
  listSummaries(): Promise<SessionSummary[]>

  /** 按主键读一条完整会话；不存在返回 `undefined`。 */
  get(id: string): Promise<Session | undefined>

  /**
   * 保存会话与其摘要，并（尽力）写入附件原件。
   *
   * **原子边界：会话与摘要是一个原子单元；原件不是。**
   * 这是对现状的忠实记录，不是新设计：`saveSession`（`db.ts`）自 P0 起就拆成了
   * 事务 A（`sessions` + `sessionSummaries`，必须成功）与事务 B（`files`，失败只降级）。
   * 原因见 `db.ts` 该函数的注释 —— 几个 MB 的 blob 写失败不该让几个 KB 的会话一个字都不落盘。
   *
   * 所以本方法**即使在 `runAtomic` 里调用，也不保证 `files` 与会话同成同败**：
   * `outcome.failure === null` 只表示会话与摘要已提交，`outcome.degradedFiles` 表示哪些原件没写进去。
   * SQLite 端同理：事务 A 一个 `BEGIN IMMEDIATE`，事务 B 另一个，两者之间允许崩溃窗口。
   */
  save(session: Session, files?: readonly StoredFile[], options?: SaveSessionOptions): Promise<SaveSessionOutcome>

  /**
   * 置顶 / 取消置顶。**原子单元：会话与摘要一起改**（读-改-写在同一个事务里）。
   * 会话不存在时什么都不做，不抛错（与现状一致）。
   */
  pin(id: string, pinnedAt: number | undefined): Promise<void>

  /** 重命名。原子边界同 `pin`。 */
  rename(id: string, title: string): Promise<void>

  /**
   * 删除会话。**原子单元：会话 + 摘要 + 已无其它会话引用的聊天原件 + 本会话的全部记忆。**
   *
   * 注意边界的两边：
   * - 包含：`files` 里被本会话引用、且删除后引用数归零的**聊天图片**原件；
   * - **不包含**：`attachment-` 前缀的文档原件（引用关系在 `attachments`，不在摘要的 `fileIds` 里，
   *   见 #531）、其它会话的记忆、附件元数据与解析全文。
   *   附件的收尾是另一条路径：`AttachmentRepo.removeUnreferenced`，由调用方在删除之后单独跑。
   *
   * 这是对现状的忠实记录：`deleteSession` 的事务含 `files`，但不含 `attachments` / `attachmentTexts`。
   */
  delete(id: string): Promise<void>

  /**
   * 列出引用了某个原件 id 的会话 id。替代现状里对 `sessionSummaries.fileIds` 索引的 `count()`，
   * 让「删原件前先数引用」不必暴露索引名。
   */
  listReferencing(fileId: string): Promise<readonly string[]>

  /**
   * 列出从某条会话分叉出来的分支（#831）。替代 `sessionSummaries.branchOf` 索引。
   * 排序不保证。
   */
  listBranchesOf(parentSessionId: string): Promise<readonly SessionSummary[]>

  /**
   * 逐条读全部会话（主键升序）。替代 `attachments/manager.ts` 里
   * 为「收集仍被消息引用的附件 id」手写的 `openCursor()`。
   * 一次只给一页，避免把整库历史读进内存（那正是现状写游标的理由）。
   */
  listFull(query?: PageQuery): Promise<Page<Session>>
}

// ---------------------------------------------------------------- 原件（blob）

/**
 * 二进制原件：聊天图片与文档附件原件**共用一个键空间**（现状如此，键前缀 `attachment-` 区分两者）。
 *
 * **本仓储允许独立后端实例**：将来原件可以落在原生文件系统，而会话文本留在 SQLite。
 * 因此接口里没有任何方法假设「blob 与会话在同一个事务里」。
 * 今天确实有三条路径把 `files` 卷进了更大的事务（`deleteSession` / `commitStaging` / `mergeStaging`），
 * 它们的原子性由 `SessionRepo.delete` 与 `StagingRepo` 的方法保证，**不由本仓储保证**。
 */
export type BlobRepo = {
  /** 读一个原件；不存在返回 `undefined`。 */
  get(id: string): Promise<Blob | undefined>

  /**
   * 批量写入（覆盖）。**原子单元：这一批要么全写入要么全不写入**（与现状 `putFiles` 一致：
   * 同一个事务里逐条 `put`，一条失败整体回滚）。
   * 不与任何会话写入共享事务。
   */
  putMany(files: readonly StoredFile[]): Promise<void>

  /** 只读键、不读 blob 本体。替代 `openKeyCursor()`（清扫时不能把所有图片读进内存）。 */
  listKeys(query?: PageQuery): Promise<Page<string>>

  /** 删除一个原件。不存在不抛错。 */
  delete(id: string): Promise<void>

  /**
   * 清空原件，但保留键命中 `keep` 的那些。**原子单元。**
   * 替代 `commitStaging` 里的 `clearFilesKeepingAttachmentBlobs()`（#531）：
   * 整包替换要换掉聊天图片，但不能换掉文档附件原件。
   * `keep` 由调用方给（今天就是 `isAttachmentBlobKey`），仓储不内置任何键前缀规则。
   */
  clearExcept(keep: (key: string) => boolean): Promise<void>
}

// ---------------------------------------------------------------- 应用素材

/** 应用级素材（聊天背景等）：按固定 key 存取，生命周期独立于会话与附件。 */
export type AssetRepo = {
  get(key: string): Promise<StoredAsset | undefined>
  /** 覆盖写。`updatedAt` 由实现填（调用方不传时钟）。原子单元：单条写入。 */
  put(key: string, blob: Blob): Promise<void>
  /** 不存在不抛错。 */
  delete(key: string): Promise<void>
}

// ---------------------------------------------------------------- 附件

export type AttachmentTextDraft = {
  sha256: string
  parserVersion: string
  text: string
  /** 缺省时按 `text.length`（与现状一致）；PDF 必须显式传，页标记不能算进字数（#544） */
  characterCount?: number
  status: StoredAttachmentText['status']
  totalPages?: number
  extractedPages?: number
  warnings?: string[]
}

export type AttachmentRepo = {
  /**
   * 新增一个附件：去重、写原件、写元数据在**一个原子单元**里提交。
   *
   * 与现状 `saveNewAttachment` 一致，包括它的两个副作用：
   * - 旧版 WebCrypto 的字节序摘要兼容（已有旧键则沿用旧键，见 `store.ts` 注释）；
   * - 并发添加/删除按存储串行。
   *
   * 返回实际落库的记录（`sha256` / `localPath` 可能与入参不同，正是因为上面的兼容）。
   */
  add(draft: Omit<DocumentAttachment, 'localPath'>, blob: Blob): Promise<DocumentAttachment>

  /** 覆盖写元数据。原子单元：单条。不碰原件与全文。 */
  put(record: DocumentAttachment): Promise<void>

  get(id: string): Promise<DocumentAttachment | undefined>

  /** 全部元数据。数量有上限（见 `limits.ts`），不分页。 */
  list(): Promise<readonly DocumentAttachment[]>

  /** 读一条解析全文缓存；键缺省或不存在返回 `undefined`。 */
  readText(key: string | undefined): Promise<StoredAttachmentText | undefined>

  /**
   * 写一条解析全文缓存（同键覆盖，幂等）。原子单元：单条。
   * 返回落库的记录（含实现填的 `key` 与 `createdAt`）。
   */
  writeText(draft: AttachmentTextDraft): Promise<StoredAttachmentText>

  /**
   * 删除一个附件。**原子单元：元数据 + （无其它引用时）全文 + （无其它引用时）原件。**
   * 引用数在同一单元内现数（与现状一致，不维护会漂移的计数字段）。
   * 返回实际删掉的条目数；id 不存在返回 0。
   */
  remove(id: string): Promise<number>

  /**
   * 清「没有附件指向」的解析全文与文档原件。**原子单元**（与现状 `sweepOrphanStorage` 一致）。
   * 不碰附件元数据，也不碰聊天图片原件。返回删掉的条目数。
   */
  sweepOrphans(): Promise<number>

  /**
   * 删除不在 `referenced` 里的附件元数据（每个走一遍 `remove` 的完整删除）。
   * **不是单个原子单元**：现状就是逐条 `removeAttachment`，一条失败只影响该条之后的。
   * `referenced` 必须由调用方给（来自消息模型）；不提供默认值，空集合 = 全部删除。
   */
  removeUnreferenced(referenced: ReadonlySet<string>): Promise<number>
}

// ---------------------------------------------------------------- 记忆

export type MemoryRepo = {
  /** 读一条；`key` 只在 `sessionId` 内解析（隔离靠主键里带 sessionId，见 `StoredSessionMemory`）。 */
  get(sessionId: string, key: string): Promise<StoredSessionMemory | undefined>

  /** 一个会话的全部记忆，按 `createdAt` 升序、同毫秒按主键升序（与现状一致）。 */
  listBySession(sessionId: string): Promise<readonly StoredSessionMemory[]>

  /**
   * 覆盖写一条，并在**同一个原子单元**里淘汰本会话超出容量的最老条目。
   *
   * 这是现状 `saveMemoryEntry` 的事务边界：读旧值、写新值、收候选、删淘汰项要么全成要么全不成。
   * 容量判定与「超限直接拒绝」不在仓储里 —— 那是 `sessionMemory.ts` 的策略，仓储只提供这个原子写。
   * 淘汰哪些由调用方算好后通过 `evictIds` 传入（仓储不做容量策略）。
   */
  put(entry: StoredSessionMemory, evictIds: readonly string[]): Promise<void>

  /** 删一条。返回是否真的删掉了。原子单元：单条。 */
  delete(sessionId: string, key: string): Promise<boolean>

  /** 清空一个会话的全部记忆，返回删掉的条数。原子单元：本会话的全部行。其它会话一条不碰。 */
  clearSession(sessionId: string): Promise<number>
}

// ---------------------------------------------------------------- 导入暂存

export type StagingRepo = {
  /** 清空两个暂存区。**原子单元：会话暂存与原件暂存一起清**（与现状 `clearStaging` 一致）。 */
  clear(): Promise<void>

  /** 追加一条暂存会话。键冲突**抛错**（现状用 `add` 而不是 `put`，重复导入同一条应当失败而不是静默覆盖）。 */
  addSession(session: Session): Promise<void>

  /** 批量写暂存原件（覆盖）。原子单元：这一批。 */
  putFiles(files: readonly StoredFile[]): Promise<void>

  /**
   * 回填暂存会话里各文件的 MIME。**原子单元：全部暂存会话的改写一起提交**
   * （与现状 `updateStagingFileTypes` 的单个游标事务一致）。
   * `types` 的键是文件 id；不在表里的文件写成空串（与现状 `types.get(id) ?? ''` 一致）。
   */
  updateFileTypes(types: ReadonlyMap<string, string>): Promise<void>

  /**
   * 用暂存**整包替换**正式数据。
   * **原子单元：会话、摘要、聊天原件、暂存区、以及全部记忆。** 任一失败整体回滚，正式数据不变。
   *
   * 与现状 `commitStaging` 一致的三条行为，实现时不许丢：
   * - 会话与摘要先清空再搬入；记忆**整表清空**（被替换的会话 id 全部作废，记忆失去归属，#399）；
   * - 聊天原件清空，但 `attachment-` 前缀的文档原件保留（#531，判定口径仍是 `blobKeys.ts` 那一份）；
   * - 两个暂存区最后清空。
   *
   * 返回本次写入的摘要，调用方不必再读一次库。
   */
  commit(): Promise<SessionSummary[]>

  /**
   * 把暂存**合并**进正式数据（不清空本地）。
   * **原子单元：判定、写入、搬原件、清暂存在一起。** 失败整体回滚（与现状 `mergeStaging` 一致）。
   *
   * 与 `commit` 的两个差别：不删除任何已有会话，也**不碰记忆**。
   * 被跳过的会话不搬它的原件（避免制造孤儿）。
   */
  merge(policy: MergePolicy): Promise<MergePlan>
}

// ---------------------------------------------------------------- 聚合

/** `runAtomic` 回调与 `StorageBackend` 上各仓储的同一批成员。 */
export type StorageRepos = {
  sessions: SessionRepo
  blobs: BlobRepo
  assets: AssetRepo
  attachments: AttachmentRepo
  memory: MemoryRepo
  staging: StagingRepo
}

/**
 * 一个打开的存储后端。Web 上是 IndexedDB，将来 Native 上是 SQLite。
 * 同一个进程里可以有**两个实例**：文本一个、原件一个（见 `BlobRepo` 的注释）。
 * 此时 `runAtomic` 只覆盖本实例里的仓储，跨实例没有原子性 —— 这是接口层的明确约定，
 * 不是实现的缺陷。
 */
export type StorageBackend = StorageRepos & {
  /**
   * 跑一个原子批：回调里对**本实例**各仓储的写，要么全提交要么全回滚。
   *
   * SQLite 端就是一个 `BEGIN IMMEDIATE` … `COMMIT`（见 `AtomicOptions`）。
   * IDB 端是一个 `readwrite` 事务，参与的 store 由回调实际写到的仓储决定。
   *
   * 回调抛错（包括业务错误）→ 回滚后把该错误原样抛出。
   * 不允许嵌套：回调里再调 `runAtomic` 是实现必须拒绝的用法。
   */
  runAtomic<T>(work: AtomicWork<T>, options?: AtomicOptions): Promise<T>

  /** 关闭连接。之后任何方法调用都应抛 `StorageUnavailableError`。幂等。 */
  close(): Promise<void>

  /** 现在能不能用。不抛错。 */
  health(): Promise<StorageHealth>

  /** 启动期探测：比 `health` 多版本与持久化两项。不抛错。 */
  probe(): Promise<StorageProbe>
}

/**
 * 打开存储。
 *
 * 失败模型（与现状 `getChatDB()` 一致，调用方已按这个写了）：
 * - 宿主没有存储能力 → reject `StorageUnavailableError`；
 * - 其它连接挡住升级、超时 → reject `StorageBlockedError`；
 * - 库版本比代码新 → reject `StorageVersionTooNewError`。
 *
 * 三个错误类都从 `src/services/chat/db.ts` 引入（那里是现有实现，也是现有调用方的类型来源）。
 * 接口层**只抛这三种**加运行期的 `StorageFailure` 分类；底层错误（IDB 的
 * `QuotaExceededError` / `DataCloneError` / `InvalidStateError`，SQLite 的
 * `SQLITE_FULL` / `SQLITE_CORRUPT` / `SQLITE_BUSY`）由各后端映射进这套分类，
 * 映射表见 `docs/storage-abstraction.md` 第 4 节。
 */
export type OpenStorage = () => Promise<StorageBackend>

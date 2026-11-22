import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb'
import {
  planMerge,
  type MergePlan,
  type MergePolicy,
  type SessionRef,
} from './history/mergeSessions.js'
import { isAttachmentBlobKey } from '../attachments/blobKeys.js'
import type { DocumentAttachment } from '../attachments/types.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/**
 * IndexedDB 存储结构版本；新增或调整存储、索引时递增。
 *
 * v12 → v13（#480）：只**新增**两个文档附件存储（`attachments` / `attachmentTexts`）与它们的索引，
 * 不迁移、不改写、不清空任何已有的会话 / 摘要 / 原件数据 —— 升级回调里全部是 `contains()` 守卫，
 * 老用户升级后打开旧会话得到的内容与升级前逐字节相同。
 *
 * v13 → v14（#399）：只**新增**一个窗口记忆存储（`sessionMemory`）与它的 `sessionId` 索引，
 * 同样不迁移、不改写、不清空任何已有数据。记忆是**派生数据**（丢了能重算），
 * 所以升级时**不从消息重建**：老用户升上来记忆是空的，第一次写记忆时才建条目。
 * 「旧 store / 旧数据一条不动」由 `tests/unit/memory-session-scope-399.test.mjs` 的 T7 钉住。
 *
 * v14 → v15（#831 会话级分支）：只**新增**一个索引 —— `sessionSummaries` 上的 `branchOf`
 * （keyPath `branchOf.sessionId`），让「从哪条会话分叉出来的」在列表层可查（徽标降级判定、
 * 跳回父会话、以及将来的「本会话的分支」列表），不必把全部摘要读进内存再扫。
 *
 * 为什么**不**新建 store、也不回填旧记录：分支来源是会话记录上一个**可选字段**（`branchOf`，
 * 见 `types.ts`），IndexedDB 是 schemaless 的 —— 老记录没有这个字段照样读得出来，只是不进这条索引
 * （IndexedDB 对缺键的记录天然跳过索引项）。因此升级不搬家、不改写、不需要「补字段」这一步。
 *
 * 升级回调全程 `objectStoreNames.contains()` / `indexNames.contains()` 守卫（#209）：
 * 同一个回调**重复执行**不会抛错（`createIndex` 重复建会抛 ConstraintError），
 * v12 → v15 的跨版本升级也能一步到位 —— 由 `tests/unit/session-branch-831.test.mjs` 的 ⑦ 钉住。
 *
 * **导出给测试用**（#547）：`tests/helpers/chat-db.mjs` 从这里取 `DB_VERSION` / `DB_NAME`，
 * L1 集成用例的 fixture 不再各写一份「12」「13」—— 版本号只有这一处来源，加 store 时改这里就够了。
 */
export const DB_VERSION = 15

/** IndexedDB 库名；只在这里出现一次，测试夹具同样从这里取（#547）。 */
export const DB_NAME = 'chat-demo'

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

/** 应用级素材（如聊天背景图）：按固定 key 存取，与会话/附件数据互不影响。 */
export type StoredAsset = { key: string; blob: Blob; updatedAt: number }

/**
 * #480 文档附件元数据：字段与 `attachments/types.ts` 的 `DocumentAttachment` 完全一致。
 * `localPath` 是**内容寻址**的 blob key（`attachment-<sha256>`，存在上面的 `files` 存储里），
 * 同一份文件被多次添加时共用一份原件；`parsedTextPath` 指向 `attachmentTexts` 的主键。
 */
export type StoredAttachment = DocumentAttachment

/**
 * #480 附件解析全文：按 `sha256 + parserVersion` 内容寻址（主键 `key`），
 * 同一文件同一解析器版本只解析一次、只存一份。除正文外还带解析结论（页数 / 警告 / 状态），
 * 这样缓存命中时能还原出与首次解析完全一致的结果对象，而不是「有正文、没结论」的半份数据。
 */
export type StoredAttachmentText = {
  /** `${sha256}:${parserVersion}` */
  key: string
  sha256: string
  parserVersion: string
  text: string
  /**
   * **正文字符数**（#544）：不含 PDF 的 `[第N页]` 标记与页间分隔换行，
   * 与 `ParsedDocument.characterCount` 同口径；`text` 本身可能带标记，两者不要互相换算。
   */
  characterCount: number
  status: Extract<DocumentAttachment['status'], 'success' | 'partial'>
  totalPages?: number
  extractedPages?: number
  warnings?: string[]
  createdAt: number
}

/**
 * #399 窗口记忆：**按会话隔离**的一条记忆（原文片段 / 摘要片段，附带可选向量）。
 *
 * `id = `${sessionId}:${key}`` —— **会话 ID 是主键的一部分**，这是隔离的落点：两个会话用同一个
 * `key` 写记忆，落在两条不同的记录上，谁也读不到谁的。反过来说，把 `sessionId` 从主键里去掉
 * （改成全局键 `key`）会让 `tests/unit/memory-session-scope-399.test.mjs` 的隔离用例当场变红 ——
 * 那条用例就是这条不变量的负向对照。
 *
 * `sessionId` 索引只服务两件事：① 删会话时按会话整批清理（`deleteSession`）；② 按会话取全量。
 * 读写都走主键，索引不参与「按 key 取某一条」。
 */
export type StoredSessionMemory = {
  /** `${sessionId}:${key}` */
  id: string
  sessionId: string
  /** 会话内的记忆键（chunk 序号 / 摘要块 id 等，由写入口决定） */
  key: string
  /** 记忆正文 */
  text: string
  /**
   * 向量：**只有 embedding 开关打开且请求成功时才有**（#398/#399）。
   * 关闭态一条都不写 —— 那既保证了「关闭即零请求」，也保证关闭态的记忆不占向量字节，
   * 召回退回到本地 BM25（`recall.js` 的 `recallSync` 本来就是这条路）。
   */
  vec?: number[]
  /** 向量模型名（换模型后旧向量不该被当成同一空间比较） */
  model?: string
  /** 向量维度（缺席 = 没有向量） */
  dim?: number
  /**
   * 预计算的字节数（正文 UTF-8 字节 + 向量 4 字节/分量）：容量判定不必把整批正文读进内存再算。
   * 口径的唯一实现在 `memory/sessionMemory.ts` 的 `memoryEntryBytes()`。
   */
  bytes: number
  createdAt: number
  /** 最近一次写入时间：容量淘汰按它排序（规则见 `memory/sessionMemory.ts` 的 `evictOldest`） */
  updatedAt: number
}

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    /** fileIds：删会话时判断原件是否还有主；branchOf：#831 按「来源父会话」查分支 */
    indexes: { fileIds: string; branchOf: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 应用素材：聊天背景等全局资源，主键是固定 key，不随会话删除 */
  appAssets: { key: string; value: StoredAsset }
  /** #480 文档附件元数据：与会话/消息分表，消息里只留附件 id */
  attachments: {
    key: string
    value: StoredAttachment
    /** sha256：同一内容被多次添加时据此判断原件是否还有人引用 */
    indexes: { sha256: string; parsedTextPath: string }
  }
  /** #480 附件解析全文：主键 `sha256:parserVersion` */
  attachmentTexts: { key: string; value: StoredAttachmentText; indexes: { sha256: string } }
  /**
   * #399 窗口记忆（v14）：**按会话隔离**，主键里带 `sessionId`，`sessionId` 索引用于按会话
   * 整批读写 / 删除。与 `sessions` 在同一个库里，删会话时同一个事务里一起清（不新开第二套 DB）。
   */
  sessionMemory: {
    key: string
    value: StoredSessionMemory
    indexes: { sessionId: string }
  }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

/** 会话引用的本地原件 id（去重）：删除会话时判断原件是否还有主，增量导入时判断要搬哪些原件。 */
const referencedFileIds = (session: Session): string[] => [
  ...new Set(
    session.messages.flatMap((message) =>
      message.role === 'user' ? message.files.map((file) => file.id) : []
    )
  ),
]

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: referencedFileIds(session),
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

/**
 * 库结构升级回调：**只新增、不迁移、不清空**（#399 起的口径，v12→v13、v13→v14 都是这样）。
 *
 * 为什么从 `getDB()` 里提出来单独导出：迁移不变量用例（
 * `tests/unit/memory-session-scope-399.test.mjs` 的 T7）需要在**一个历史版本的真库**上跑
 * **同一个**回调，才能证明「旧 store / 旧数据一条不动」。用例里另写一份 schema 就等于把被验的
 * 东西换成替身 —— 那份替身漂移时不会报错，只会让用例在「库长得和真机不一样」的前提下变绿
 * （#547 的教训，见 `tests/helpers/chat-db.mjs` 文件头）。这里导出的就是这个回调本体，
 * 版本号仍然只有 `openDB(DB_NAME, DB_VERSION, …)` 那一处。
 */
export const upgradeChatDB = (
  db: IDBPDatabase<ChatDB>,
  _oldVersion: number,
  _newVersion: number | null,
  tx: IDBPTransaction<ChatDB, StoreNames<ChatDB>[], 'versionchange'>
): void => {
  // 初始化当前格式需要的存储与索引，不迁移旧消息。
  for (const name of ['sessions', 'files', 'sessionsStaging', 'filesStaging'] as const) {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name, { keyPath: 'id' })
    }
  }
  const summaries = db.objectStoreNames.contains('sessionSummaries')
    ? tx.objectStore('sessionSummaries')
    : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
  if (!summaries.indexNames.contains('fileIds')) {
    summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
  }
  /**
   * #831 会话级分支（v14 → v15）：`branchOf.sessionId` 索引。
   *
   * 用 `indexNames.contains()` 守卫是**可重复执行**的前提（#209：不假设字段 / 索引存在）；
   * 老记录没有 `branchOf` 字段 → 不进索引，读起来与升级前完全一样，不需要回填。
   */
  if (!summaries.indexNames.contains('branchOf')) {
    summaries.createIndex('branchOf', 'branchOf.sessionId')
  }
  // 应用素材（聊天背景等）单独一个 store：只新增，不重建、不清空已有会话/原件
  if (!db.objectStoreNames.contains('appAssets')) {
    db.createObjectStore('appAssets', { keyPath: 'key' })
  }
  // #480 文档附件（v12 → v13）：同样只新增。
  // `sha256` 索引用于「同内容的原件/全文还有没有人引用」的计数，`parsedTextPath` 索引用于
  // 「这段全文还有没有附件指向它」的计数 —— 都走索引计数，不扫全表。
  if (!db.objectStoreNames.contains('attachments')) {
    const attachments = db.createObjectStore('attachments', { keyPath: 'id' })
    attachments.createIndex('sha256', 'sha256')
    // 未解析的附件没有 parsedTextPath，IndexedDB 会自然跳过这类记录，正是想要的行为
    attachments.createIndex('parsedTextPath', 'parsedTextPath')
  }
  if (!db.objectStoreNames.contains('attachmentTexts')) {
    const texts = db.createObjectStore('attachmentTexts', { keyPath: 'key' })
    texts.createIndex('sha256', 'sha256')
  }
  // #399 窗口记忆（v13 → v14）：同样只新增，不动任何已有 store。
  // 主键里带会话 ID（`sessionId:key`），`sessionId` 索引只用于「按会话取全量 / 整批删除」。
  if (!db.objectStoreNames.contains('sessionMemory')) {
    const memory = db.createObjectStore('sessionMemory', { keyPath: 'id' })
    memory.createIndex('sessionId', 'sessionId')
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>(DB_NAME, DB_VERSION, { upgrade: upgradeChatDB }).catch(
    (error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      dbPromise = null
      throw error
    }
  ))

/**
 * 同一份 `chat-demo` 连接给库内其它存储层复用（#480 的 `attachments/store.ts`）：
 * 附件数据与会话数据在同一个数据库里，升级只能有一个 `upgrade` 回调，不能各自 openDB。
 */
export const getChatDB = getDB

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  (await (await getDB()).getAll('sessionSummaries')).map(toSessionSummary)

export const loadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

export const saveSession = async (session: Session, files: StoredFile[] = []): Promise<void> => {
  const summary = storedSummary(session)
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.objectStore('files').put(file)
        }
        await tx.objectStore('sessions').put(session)
        await tx.objectStore('sessionSummaries').put(summary)
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const pinSession = async (id: string, pinnedAt: number | undefined): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          if (pinnedAt === undefined) {
            delete session.pinnedAt
          } else {
            session.pinnedAt = pinnedAt
          }
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) { abortTransaction(tx); throw error }
    })(),
    tx.done,
  ])
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/**
 * 删除会话，仅清理已无会话引用的本地原件；远端文件不删。
 *
 * #399：该会话的**窗口记忆在同一个事务里一起清掉** —— 用的是与聊天图片原件同一套思路
 * （先按索引数出「还有谁引用」，再决定删不删），记忆这边更简单：`sessionId` 索引就是「本会话的
 * 全部记忆」，删完即 0，孤儿不可能留下（事务失败则整体回滚，不会出现「会话没了、记忆还在」）。
 * **只删本会话的键**：别的会话的记忆一条都不碰，这条由
 * `tests/unit/memory-session-scope-399.test.mjs` 的 T5 钉住。
 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionMemory'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
        // #399：先收齐键再删（边删边 continue 的游标语义依赖实现细节）
        const memory = tx.objectStore('sessionMemory')
        const memoryKeys: string[] = []
        for (
          let cursor = await memory.index('sessionId').openKeyCursor(sessionId);
          cursor;
          cursor = await cursor.continue()
        ) {
          memoryKeys.push(String(cursor.primaryKey))
        }
        for (const key of memoryKeys) {
          await memory.delete(key)
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  const tx = (await getDB()).transaction(store, 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
        let changed = false
        for (const message of session.messages) {
          if (message.role !== 'user') {
            continue
          }
          for (const file of message.files) {
            const type = types.get(file.id) ?? ''
            if (file.mimeType !== type) {
              file.mimeType = type
              changed = true
            }
          }
        }
        if (changed) {
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后用暂存替换正式数据：同一事务中替换会话、摘要和原件，并清空暂存。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 *
 * **附件原件不在替换范围内**（#531）：`files` 里 `attachment-<sha256>` 前缀的 blob 在替换后仍然留着，
 * 见下面 `clearFilesKeepingAttachmentBlobs()`。
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    // #399：整包替换会换掉**全部**会话（连 id 一起换），旧会话的记忆全部失去归属，
    // 所以在同一个事务里一起清空 `sessionMemory` —— 这是「不留孤儿」的另一半：
    // 删单个会话走 `deleteSession`，整包替换走这里，两条路都清在同一事务里，不另造清扫机制。
    // 增量导入（`mergeStaging`）不删任何会话，因此**不**碰记忆。
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'sessionMemory'],
    'readwrite'
  )
  /**
   * 清空 `files`，但**保留**附件原件（#531）。附件原件是用户上传的原始文件，与「聊天历史包」
   * 是两个生命周期：整包导入只该换聊天数据，不该让用户之前的附件变成「无法解析」且无法重试。
   *
   * 为什么逐键删除而不是「挑出来 → clear() → 写回」：写回要把每条 blob **整份读进内存**再写一遍，
   * 几 MB 的 PDF 在替换事务里白白搬一次；逐键删除只读键（`openKeyCursor`），原件原地不动。
   *
   * 为什么只按前缀、不判引用：没被任何附件元数据引用的 `attachment-` 键在这里**不清理** ——
   * 分不清「导入前刚加、还没来得及引用」与「真孤儿」，而清孤儿是 `attachments/store.ts`
   * 的 `sweepOrphans()` 的职责（它按索引实时数引用数）。两件事不许混在一个事务里。
   */
  const clearFilesKeepingAttachmentBlobs = async () => {
    const files = tx.objectStore('files')
    const doomed: string[] = []
    for (let cursor = await files.openKeyCursor(); cursor; cursor = await cursor.continue()) {
      if (typeof cursor.key === 'string' && isAttachmentBlobKey(cursor.key)) {
        continue
      }
      doomed.push(cursor.key)
    }
    // 先收齐再删：边删边 continue 的游标语义依赖实现细节，两遍扫描没有这个前提
    for (const key of doomed) {
      await files.delete(key)
    }
  }
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      if (to === 'files') {
        // #531：聊天图片照常被替换，附件原件留下
        await clearFilesKeepingAttachmentBlobs()
      } else {
        await target.clear()
        await tx.objectStore('sessionSummaries').clear()
        // #399：会话整批被替换 = 旧会话全部没了，它们（按 sessionId 存的）记忆一并清掉
        await tx.objectStore('sessionMemory').clear()
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 暂存会话的判定元数据：冲突只看 id 与更新时间，附件 id 用于判断要搬哪些原件。 */
type StagedRef = SessionRef & { files: string[] }

/**
 * 增量导入（#390）：把暂存里的会话**合并**进当前数据，一个本地会话都不清空。
 *
 * 与 `commitStaging` 的区别只在「写哪些」：这里逐条按 `planMerge` 的判定结果写入，
 * 被跳过的会话既不落库，也不搬运它的图片原件（避免留下没人引用的孤儿原件）。
 * 会话、摘要、原件仍然在同一个事务里写，中途失败整体回滚，本地数据保持导入前的样子。
 */
export const mergeStaging = async (policy: MergePolicy): Promise<MergePlan> => {
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const run = async (): Promise<MergePlan> => {
    const sessions = tx.objectStore('sessions')
    // 第一遍：只读元数据（一条一条过游标，不把整个包读进内存）
    const staged: StagedRef[] = []
    for (
      let cursor = await tx.objectStore('sessionsStaging').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      const session = cursor.value
      staged.push({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        files: referencedFileIds(session),
      })
    }
    // 本地同 id 会话的更新时间先查完（全部是 IDB 请求，事务保持活跃），再纯同步地判定：
    // 事务里不 await 非 IDB 的 Promise。
    const localUpdatedAt = new Map<string, number>()
    for (const item of staged) {
      const local = await sessions.get(item.id)
      if (local !== undefined) {
        localUpdatedAt.set(item.id, local.updatedAt)
      }
    }
    const plan = planMerge(staged, (id) => localUpdatedAt.get(id), policy)
    const written = new Set(plan.written)
    const filesToMove = new Set(staged.filter((item) => written.has(item.id)).flatMap((item) => item.files))
    // 第二遍：只写判定为「新增 / 覆盖」的会话及其摘要
    for (
      let cursor = await tx.objectStore('sessionsStaging').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      const session = cursor.value
      if (!written.has(session.id)) {
        continue
      }
      await sessions.put(session)
      await tx.objectStore('sessionSummaries').put(storedSummary(session))
    }
    for (
      let cursor = await tx.objectStore('filesStaging').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      if (filesToMove.has(cursor.value.id)) {
        await tx.objectStore('files').put(cursor.value)
      }
    }
    await tx.objectStore('sessionsStaging').clear()
    await tx.objectStore('filesStaging').clear()
    return plan
  }
  try {
    const [plan] = await Promise.all([run(), tx.done])
    return plan
  } catch (error) {
    // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只合并了一部分。
    abortTransaction(tx)
    throw error
  }
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}

/** 读取应用素材（如聊天背景）：未设置时返回 undefined。 */
export const loadAppAsset = async (key: string): Promise<StoredAsset | undefined> =>
  (await getDB()).get('appAssets', key)

/** 写入/覆盖应用素材；固定 key 保证全局只有一份背景图。 */
export const saveAppAsset = async (key: string, blob: Blob): Promise<void> => {
  await (await getDB()).put('appAssets', { key, blob, updatedAt: Date.now() })
}

export const deleteAppAsset = async (key: string): Promise<void> => {
  await (await getDB()).delete('appAssets', key)
}

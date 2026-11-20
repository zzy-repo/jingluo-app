import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import {
  planMerge,
  type MergePlan,
  type MergePolicy,
  type SessionRef,
} from './history/mergeSessions.js'
import type { DocumentAttachment } from '../attachments/types.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

/**
 * IndexedDB 存储结构版本；新增或调整存储、索引时递增。
 *
 * v12 → v13（#480）：只**新增**两个文档附件存储（`attachments` / `attachmentTexts`）与它们的索引，
 * 不迁移、不改写、不清空任何已有的会话 / 摘要 / 原件数据 —— 升级回调里全部是 `contains()` 守卫，
 * 老用户升级后打开旧会话得到的内容与升级前逐字节相同。
 *
 * **导出给测试用**（#547）：`tests/helpers/chat-db.mjs` 从这里取 `DB_VERSION` / `DB_NAME`，
 * L1 集成用例的 fixture 不再各写一份「12」「13」—— 版本号只有这一处来源，加 store 时改这里就够了。
 */
export const DB_VERSION = 13

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

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
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

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>(DB_NAME, DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
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
    },
  }).catch((error: unknown) => {
    // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
    dbPromise = null
    throw error
  }))

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

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries', 'files'], 'readwrite')
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
 */
export const commitStaging = async (): Promise<SessionSummary[]> => {
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      await target.clear()
      if (to === 'sessions') {
        await tx.objectStore('sessionSummaries').clear()
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

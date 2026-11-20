/**
 * #480 文档附件：本地存储 / 缓存层。
 *
 * 三个存储，各管一件事（都在既有的 IndexedDB `chat-demo` 里，v13 起）：
 *  1. `attachments`：附件元数据（`DocumentAttachment`），**与消息表分开**，消息里只留附件 id；
 *  2. `attachmentTexts`：解析全文，主键 `sha256:parserVersion` —— 内容寻址的缓存，
 *     同一份文件 + 同一个解析器版本只解析一次、只存一份；
 *  3. `files`：原始文件的 blob —— **复用**已有机制（`db.saveFiles` / `db.loadFile`），
 *     键用 `attachment-<sha256>`，与聊天图片共用同一个 store 和同一套读写代码，不另起一套。
 *
 * 为什么原件键是 `attachment-<sha256>` 而不是附件 id：同一个文件被添加两次（改了名字、
 * 或同一文件进了两个会话）只应占一份空间。附件 id 是「引用」，sha256 是「内容」，
 * 一份内容可以被多个附件引用 —— 删除时在**同一事务里按索引实时 count 引用数**，
 * 数到 0 才真删，因此不需要维护会漂移的冗余计数字段。
 *
 * 已知副作用（#480 PR 里同样写明）：整包导入的 `commitStaging()` 会 `files.clear()`，
 * 附件原件会随之消失（解析全文在 `attachmentTexts` 里还在）。所以读正文一律经过
 * `readAttachmentText` + 缺件降级，不假设原件一定在。
 */
import { getChatDB, loadFile, saveFiles, type StoredAttachmentText } from '../chat/db.js'
import type { DocumentAttachment } from './types.js'

/** 原件 blob 键前缀：内容寻址，与聊天图片的 `files` 键（图片 id）互不干扰 */
export const ATTACHMENT_BLOB_PREFIX = 'attachment-'

export const attachmentBlobKey = (sha256: string): string => `${ATTACHMENT_BLOB_PREFIX}${sha256}`

/** 是否本模块写进 `files` 的键（清理孤儿时据此圈定范围，不误删聊天图片） */
export const isAttachmentBlobKey = (key: string): boolean => key.startsWith(ATTACHMENT_BLOB_PREFIX)

/** 解析全文的缓存键：`sha256 + parserVersion`。（去重键，改动会使已有缓存全部失效） */
export const attachmentTextKey = (sha256: string, parserVersion: string): string =>
  `${sha256}:${parserVersion}`

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

/** 同内容原件是否已经存过：只查键，不把 blob 读进内存 */
const hasBlob = async (key: string): Promise<boolean> =>
  (await (await getChatDB()).count('files', key)) > 0

/**
 * 保存原始文件，返回它的 blob 键（即 `DocumentAttachment.localPath`）。
 * 同内容已存在时直接复用，不重写 —— 这是「同内容只存一份」的唯一入口。
 */
export const saveAttachmentBlob = async (sha256: string, blob: Blob): Promise<string> => {
  const key = attachmentBlobKey(sha256)
  if (!(await hasBlob(key))) {
    await saveFiles([{ id: key, blob }])
  }
  return key
}

/** 读原始文件；键不存在时返回 undefined（整包导入会清空 `files`，缺件是预期情况之一） */
export const readAttachmentBlob = (key: string): Promise<Blob | undefined> => loadFile(key)

export const putAttachment = async (record: DocumentAttachment): Promise<void> => {
  await (await getChatDB()).put('attachments', record)
}

export const getAttachment = async (id: string): Promise<DocumentAttachment | undefined> =>
  (await getChatDB()).get('attachments', id)

export const listAttachments = async (): Promise<DocumentAttachment[]> =>
  (await getChatDB()).getAll('attachments')

/** 读缓存全文记录（含解析结论）；键缺省或不存在时返回 undefined */
export const readAttachmentTextRecord = async (
  key: string | undefined
): Promise<StoredAttachmentText | undefined> =>
  key === undefined ? undefined : (await getChatDB()).get('attachmentTexts', key)

/** 写缓存全文；同一 `sha256:parserVersion` 重复写入是幂等的覆盖（解析结论一致） */
export const writeAttachmentTextRecord = async (params: {
  sha256: string
  parserVersion: string
  text: string
  status: Extract<DocumentAttachment['status'], 'success' | 'partial'>
  totalPages?: number
  extractedPages?: number
  warnings?: string[]
}): Promise<StoredAttachmentText> => {
  const record: StoredAttachmentText = {
    key: attachmentTextKey(params.sha256, params.parserVersion),
    sha256: params.sha256,
    parserVersion: params.parserVersion,
    text: params.text,
    characterCount: params.text.length,
    status: params.status,
    createdAt: Date.now(),
  }
  if (params.totalPages !== undefined) {
    record.totalPages = params.totalPages
  }
  if (params.extractedPages !== undefined) {
    record.extractedPages = params.extractedPages
  }
  if (params.warnings !== undefined && params.warnings.length > 0) {
    record.warnings = params.warnings
  }
  const db = await getChatDB()
  const tx = db.transaction('attachmentTexts', 'readwrite')
  await Promise.all([tx.store.put(record), tx.done])
  return record
}

/**
 * 删除一个附件：元数据 + （无其它附件引用时）全文 + （无其它附件引用时）原件。
 *
 * 三件事在**同一个事务**里做，引用数用索引实时数（删完元数据再数，自己不会被算进去）：
 *  - 原件按 `sha256` 数：同内容被两个附件引用时，删掉其中一个不删 blob；
 *  - 全文按 `parsedTextPath` 数：同文件同解析器版本共享一份正文，同上。
 * 事务中途失败整体回滚，不会出现「元数据没了、正文还在」的半删状态。
 *
 * 返回实际删掉的存储条目数（元数据 1 条 + 可能删掉的全文 / 原件），供 `sweepOrphans` 汇报。
 */
export const removeAttachment = async (id: string): Promise<number> => {
  const db = await getChatDB()
  const tx = db.transaction(['attachments', 'attachmentTexts', 'files'], 'readwrite')
  const run = async (): Promise<number> => {
    const attachments = tx.objectStore('attachments')
    const record = await attachments.get(id)
    if (record === undefined) {
      return 0
    }
    await attachments.delete(id)
    let removed = 1
    if (isAttachmentBlobKey(record.localPath)) {
      const blobRefs = await attachments.index('sha256').count(record.sha256)
      if (blobRefs === 0) {
        await tx.objectStore('files').delete(record.localPath)
        removed += 1
      }
    }
    if (record.parsedTextPath !== undefined) {
      const textRefs = await attachments.index('parsedTextPath').count(record.parsedTextPath)
      if (textRefs === 0) {
        await tx.objectStore('attachmentTexts').delete(record.parsedTextPath)
        removed += 1
      }
    }
    return removed
  }
  try {
    const [removed] = await Promise.all([run(), tx.done])
    return removed
  } catch (error) {
    abortTransaction(tx)
    throw error
  }
}

/**
 * 清存储层孤儿（不碰仍然存在的附件元数据）：
 *  1. `attachmentTexts` 里没有任何附件 `parsedTextPath` 指向的全文；
 *  2. `files` 里 `attachment-` 前缀、没有任何附件 `sha256` 对应的原件。
 *
 * 两处都用索引计数判定；扫 `files` 用 `openKeyCursor` 只读键，不会把聊天图片的 blob 读进内存。
 * 返回删掉的条目数。
 */
export const sweepOrphanStorage = async (): Promise<number> => {
  const db = await getChatDB()
  const tx = db.transaction(['attachments', 'attachmentTexts', 'files'], 'readwrite')
  const run = async (): Promise<number> => {
    const attachments = tx.objectStore('attachments')
    let removed = 0
    const texts = tx.objectStore('attachmentTexts')
    for (let cursor = await texts.openCursor(); cursor; cursor = await cursor.continue()) {
      if ((await attachments.index('parsedTextPath').count(cursor.key)) === 0) {
        await cursor.delete()
        removed += 1
      }
    }
    const files = tx.objectStore('files')
    const orphanKeys: string[] = []
    for (let cursor = await files.openKeyCursor(); cursor; cursor = await cursor.continue()) {
      if (typeof cursor.key === 'string' && isAttachmentBlobKey(cursor.key)) {
        orphanKeys.push(cursor.key)
      }
    }
    for (const key of orphanKeys) {
      const sha256 = key.slice(ATTACHMENT_BLOB_PREFIX.length)
      if ((await attachments.index('sha256').count(sha256)) === 0) {
        await files.delete(key)
        removed += 1
      }
    }
    return removed
  }
  try {
    const [removed] = await Promise.all([run(), tx.done])
    return removed
  } catch (error) {
    abortTransaction(tx)
    throw error
  }
}

/**
 * 清「没有任何会话/消息引用」的附件元数据（删除会话后的收尾，走 `removeAttachment` 的完整删除）。
 *
 * `referenced` 必须由**调用方**给出当前还活着的附件 id 集合：这个集合来自消息模型
 * （`UserMessage.files[].id`），存储层不猜。空集合 = 一个附件都不留，因此这里刻意不提供默认值 ——
 * 把「扫哪个字段」的判断留在知道消息结构的那一层，避免这里悄悄把用户附件全清掉。
 */
export const removeUnreferencedAttachments = async (
  referenced: ReadonlySet<string>
): Promise<number> => {
  const all = await listAttachments()
  let removed = 0
  for (const record of all) {
    if (!referenced.has(record.id)) {
      removed += await removeAttachment(record.id)
    }
  }
  return removed
}

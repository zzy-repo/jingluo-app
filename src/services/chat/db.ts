import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPObjectStore,
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

export const storedSummary = (session: Session): StoredSessionSummary => ({
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

// ---------------------------------------------------------------- 存储写失败分级（P0 事故修复）

/**
 * 本机写失败的**四类**。判定只认 `error.name`（`message` 各引擎写法不一致，靠它猜必错），
 * 分类决定两件事：**要不要重试 / 要不要自愈**、以及**横幅说什么**。
 *
 * | kind | 触发 | 自愈动作 | 用户能做什么 |
 * | --- | --- | --- | --- |
 * | `quota` | `QuotaExceededError`（超配额）、Firefox 的 `NS_ERROR_DOM_QUOTA_REACHED` | 清孤儿 blob 后重试一次 | 清理 / 导出备份后重试 |
 * | `clone` | `DataCloneError`：会话里混进了函数 / symbol 等不可结构化克隆的值 | 剔除坏字段后重试一次 | 重试（程序自己会修） |
 * | `unavailable` | 宿主没有 IndexedDB（`StorageUnavailableError`）、WebKit 写 blob 抛的 `UnknownError`、`NotSupportedError`、`StorageVersionTooNewError` | 无 | 换 App / 换环境，重试没用 |
 * | `unknown` | 其余，含 `InvalidStateError`（连接正在关闭，重连后能再试）与 `StorageBlockedError` | 重连后再试 | 重试 |
 *
 * 为什么 `UnknownError` 归 `unavailable` 而不是 `unknown`：WebKit 在写 blob 时抛
 * `UnknownError`（配额 / 权限 / 沙箱三者它都不区分），实测**同一份数据重试一万次也一样失败**，
 * 把它当「可重试」只会让用户反复点重试。这正是「清后台后记录消失、Web 端与手表端同时复现」的
 * 现场：写不进去 + 库被系统淘汰，两个原因叠在一起。
 */
export type StorageFailureKind = 'quota' | 'clone' | 'unavailable' | 'unknown'

/** 一次写失败的结构化描述（**只含元数据**：分类 / error.name / message / store，不含会话内容）。 */
export type StorageFailure = {
  kind: StorageFailureKind
  /** 原始 `error.name`（`DataCloneError` / `QuotaExceededError` / `UnknownError` …） */
  name?: string
  /** 原始 `error.message`，截断到 200 字符；引擎给的都是固定句式，不带用户正文 */
  message?: string
  /** 失败涉及的 object store（逗号分隔）：定级时「哪一段没写进去」比「失败了」有用 */
  stores?: string
  at?: number
}

export const STORAGE_FAILURE_KINDS: readonly StorageFailureKind[] = [
  'quota',
  'clone',
  'unavailable',
  'unknown',
]

export const isStorageFailureKind = (value: unknown): value is StorageFailureKind =>
  typeof value === 'string' && (STORAGE_FAILURE_KINDS as readonly string[]).includes(value)

const errorNameOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.length > 0) {
      return name
    }
  }
  return undefined
}

const errorMessageOf = (error: unknown): string | undefined => {
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) {
      return message
    }
  }
  if (typeof error === 'string' && error.length > 0) {
    return error
  }
  return undefined
}

/** 纯函数（L0 可单测）：`error` → 四类之一。不碰 DOM、不碰 IndexedDB，只看 `name`。 */
export const classifyStorageFailure = (error: unknown): StorageFailureKind => {
  switch (errorNameOf(error)) {
    case 'DataCloneError':
      return 'clone'
    case 'QuotaExceededError':
    case 'NS_ERROR_DOM_QUOTA_REACHED':
      return 'quota'
    // WebKit 写 Blob 失败：不区分配额 / 权限 / 沙箱，只能整体判成「这个环境写不进去」
    case 'UnknownError':
    case 'NotSupportedError':
    case 'SecurityError':
    case 'StorageUnavailableError':
    case 'StorageVersionTooNewError':
      return 'unavailable'
    default:
      // 含 InvalidStateError（连接正在关闭：重连后可以再试）与 StorageBlockedError（另一标签页占着：
      // 关掉它再试就行）—— 两者都**不是**环境缺能力，别拿「建议用 App 打开」赶人
      return 'unknown'
  }
}

const FAILURE_MESSAGE_MAX = 200

/** `error` → 可直接落库 / 进诊断包的 `StorageFailure`（纯函数）。 */
export const storageFailureOf = (error: unknown, stores?: string): StorageFailure => {
  const failure: StorageFailure = { kind: classifyStorageFailure(error), at: Date.now() }
  const name = errorNameOf(error)
  if (name) {
    failure.name = name
  }
  const message = errorMessageOf(error)
  if (message) {
    failure.message = message.slice(0, FAILURE_MESSAGE_MAX)
  }
  if (stores) {
    failure.stores = stores
  }
  return failure
}

/**
 * 读旧值兼容：P0 之前的 `sessionSaveErrors` 是 `Record<id, boolean>`，
 * `true` 只表示「这条会话没存上」，没有分类。**旧值一律当可重试档**（`unknown`）读 ——
 * 不能因为「不知道原因」就把用户的会话判成「当前环境无法保存」（那个档位不给重试按钮）。
 */
export const normalizeStorageFailure = (value: unknown): StorageFailure | undefined => {
  if (value === true) {
    return { kind: 'unknown' }
  }
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = value as Partial<StorageFailure>
  return {
    ...candidate,
    kind: isStorageFailureKind(candidate.kind) ? candidate.kind : 'unknown',
  } as StorageFailure
}

/** 横幅档位（三档，与文案一一对应；`unavailable` 不给重试按钮） */
export type SaveBannerTier = 'retry' | 'quota' | 'unavailable'

export const saveBannerTierOf = (kind: StorageFailureKind): SaveBannerTier =>
  kind === 'unavailable' ? 'unavailable' : kind === 'quota' ? 'quota' : 'retry'

/** 严重度：会话级失败同时有多种原因时，**最严重的那条**决定文案（`unavailable` > `quota` > 可重试） */
const TIER_SEVERITY: Record<SaveBannerTier, number> = { retry: 0, quota: 1, unavailable: 2 }

/** 纯函数（L0 可单测）：从 `sessionSaveErrors`（含旧布尔值）里选出横幅档位。 */
export const selectSaveBannerTier = (
  errors: Record<string, StorageFailure | boolean | undefined> | null | undefined
): SaveBannerTier | null => {
  if (!errors) {
    return null
  }
  let tier: SaveBannerTier | null = null
  for (const value of Object.values(errors)) {
    const failure = normalizeStorageFailure(value)
    if (!failure) {
      continue
    }
    const next = saveBannerTierOf(failure.kind)
    if (tier === null || TIER_SEVERITY[next] > TIER_SEVERITY[tier]) {
      tier = next
    }
  }
  return tier
}

export type SaveBannerMessageKey =
  | 'sessionSaveFailedRetryable'
  | 'sessionSaveFailedQuota'
  | 'sessionSaveFailedUnavailable'

/** 档位 → i18n key（zh/en 成对存在，`check-i18n` 的 R1/R4 会盯住） */
export const SAVE_BANNER_MESSAGE: Record<SaveBannerTier, SaveBannerMessageKey> = {
  retry: 'sessionSaveFailedRetryable',
  quota: 'sessionSaveFailedQuota',
  unavailable: 'sessionSaveFailedUnavailable',
}

/** `unavailable` 档位**不显示重试按钮**：环境写不进去，点了也是同一个结果。 */
export const saveBannerRetryable = (tier: SaveBannerTier): boolean => tier !== 'unavailable'

// ---------------------------------------------------------------- 不可克隆字段的兜底剔除

/** 兜底剔除的路径上限：坏字段多到几十个时，说明数据早就坏了，不必逐个试完 */
const STRIP_PATHS_MAX = 24

const isNonCloneableValue = (value: unknown): boolean =>
  typeof value === 'function' || typeof value === 'symbol'

/**
 * 「下一层」里该被剔掉的成员：函数 / symbol，**以及**克隆不了的**非数组对象**
 * （`WeakMap` / `Proxy` / 带 getter 的宿主对象这些）。
 *
 * 为什么连「非函数对象」也剔：剔除的判定标准是「`structuredClone` 一定失败」，不是「看起来像代码」。
 * 一个 `new WeakMap()` 挂在某条消息上，后果和不小心挂了个函数完全一样 —— 整条会话存不上。
 * 反过来，**数组一律不动**（消息正文、`blocks` 都在数组里）：宁可这一级修复失败、整条会话上报，
 * 也不许把用户的对话内容当成「可疑对象」删掉。
 */
const isStrippableMember = (value: unknown): boolean => {
  if (isNonCloneableValue(value)) {
    return true
  }
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isCloneable(value)
  )
}

/**
 * `structuredClone` 能不能克隆它。**不能**克隆时返回 false；宿主没有 `structuredClone` 时返回 true
 * （老 WebView：这里没有判据，交给 IndexedDB 自己抛 `DataCloneError`，别凭空删字段）。
 */
const isCloneable = (value: unknown): boolean => {
  if (typeof structuredClone !== 'function') {
    return true
  }
  try {
    structuredClone(value)
    return true
  } catch {
    return false
  }
}

/**
 * 「会话里混进不可克隆字段」的兜底：**先顶层浅扫，再逐字段试一次**。
 *
 * 三级顺序（每一级都只在上一级失败后才走）：
 *  1. 顶层浅扫：值是 `function` / `symbol` 的字段直接剔掉（这就是 `DataCloneError` 的典型来源）；
 *  2. 逐个顶层字段 `structuredClone` 试一次：克隆不了的字段再试一次**只往下一层**的修复
 *     （数组逐元素 / 对象逐属性剔掉坏成员）—— 这一级是为了「宁可少一个字段，也别整条会话不落盘」；
 *  3. 修不动的**关键字段**（`messages` / `id` / `title` …）**不删**：宁可直接失败并上报，
 *     也不能存一条「标题在、消息没了」的空壳把用户的对话抹掉。
 *
 * 返回值里的 `removed` 只有**字段路径**（`messages[2].onDone` 这种），不含任何正文 —— 直接可进诊断包。
 */
export const stripNonCloneableFields = <T extends object>(value: T): { value: T; removed: string[] } => {
  if (isCloneable(value)) {
    return { value, removed: [] }
  }
  const removed: string[] = []
  // ① 顶层浅扫：不可克隆的原始值（函数 / symbol）直接不进副本
  const scanned = omitKeys(value as Record<string, unknown>, (key, item) => {
    if (!isNonCloneableValue(item)) {
      return false
    }
    removed.push(key)
    return true
  })
  if (isCloneable(scanned)) {
    return { value: scanned as T, removed }
  }
  // ② 逐个顶层字段试一次；克隆不了的先试「只往下一层」的修复
  const next: Record<string, unknown> = {}
  for (const key of Object.keys(scanned)) {
    const item = scanned[key]
    if (isCloneable(item)) {
      next[key] = item
      continue
    }
    const repaired = repairOneLevel(key, item)
    if (repaired !== null && isCloneable(repaired.value)) {
      next[key] = repaired.value
      removed.push(...repaired.removed)
      continue
    }
    if (PROTECTED_SESSION_KEYS.has(key)) {
      // ③ 关键字段修不动也不删（见上面第 3 条）：带着它返回，让上层如实失败并上报
      next[key] = item
      continue
    }
    removed.push(key)
    if (removed.length >= STRIP_PATHS_MAX) {
      break
    }
  }
  return { value: next as T, removed }
}

/**
 * 按判定函数过滤对象键，返回**新对象**（不改调用方传入的那个）。
 * 为什么不用 `delete`：兜底剔字段是「造一份干净副本去重试」，不是就地改用户的会话对象 ——
 * 就地 delete 会把内存里那份会话也改掉（用户正在看的消息可能因此少字段）。
 */
const omitKeys = (
  source: Record<string, unknown>,
  shouldOmit: (key: string, value: unknown) => boolean
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (!shouldOmit(key, source[key])) {
      out[key] = source[key]
    }
  }
  return out
}

/** 删掉就等于抹掉用户对话的字段：修不动时宁可失败，也不产出空壳 */
const PROTECTED_SESSION_KEYS = new Set(['id', 'messages', 'title', 'createdAt', 'updatedAt', 'rootMessageId'])

/**
 * 只往下一层：数组逐元素、对象逐属性剔掉不可克隆成员；修不动返回 null。
 * 同样是**造新对象**而不是就地删（用户的会话正文不许被兜底逻辑改动）。
 */
const repairOneLevel = (
  key: string,
  value: unknown
): { value: unknown; removed: string[] } | null => {
  const removed: string[] = []
  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      if (isCloneable(item) || item === null || typeof item !== 'object') {
        return item
      }
      const copy = omitKeys(item as Record<string, unknown>, (member, memberValue) => {
        if (!isStrippableMember(memberValue)) {
          return false
        }
        removed.push(`${key}[${index}].${member}`)
        return true
      })
      return isCloneable(copy) ? copy : item
    })
    return { value: items, removed }
  }
  if (typeof value === 'object' && value !== null) {
    const copy = omitKeys(value as Record<string, unknown>, (member, memberValue) => {
      if (!isStrippableMember(memberValue)) {
        return false
      }
      removed.push(`${key}.${member}`)
      return true
    })
    return isCloneable(copy) ? { value: copy, removed } : null
  }
  return null
}

// ---------------------------------------------------------------- 持久化存储（防整库被淘汰）

/**
 * 申请「持久化存储」：`navigator.storage.persist()`。
 *
 * 不申请的话整库是 *best-effort* 的，系统在空间紧张时可以直接把整个 IndexedDB 清掉 ——
 * 界面表现是「清后台再打开，列表空的、连横幅都没有」，而代码里一条报错都不会有。
 * 这正是「网页端 / 手表端也丢」那条现场：不是我们写失败，是数据被系统淘汰了。
 *
 * 三条纪律：
 *  1. **幂等**：只问一次，结果缓存；重复调用返回同一个 promise；
 *  2. **失败静默**：没有 `storage.persist`（老 WebView / 部分内嵌浏览器）或用户拒绝，都不抛错；
 *  3. **不阻塞首屏**：调用方 `void` 掉它，绝不 `await`。
 */
let persistRequest: Promise<boolean> | undefined

const storageManager = (): StorageManager | undefined => {
  if (typeof navigator === 'undefined') {
    return undefined
  }
  const storage = (navigator as Navigator & { storage?: StorageManager }).storage
  return storage && typeof storage === 'object' ? storage : undefined
}

export const ensurePersistentStorage = (): Promise<boolean> => {
  if (persistRequest) {
    return persistRequest
  }
  const storage = storageManager()
  if (!storage || typeof storage.persist !== 'function') {
    persistRequest = Promise.resolve(false)
    return persistRequest
  }
  persistRequest = (async () => {
    try {
      if (typeof storage.persisted === 'function' && (await storage.persisted())) {
        return true
      }
      return await storage.persist()
    } catch {
      return false
    }
  })()
  return persistRequest
}

/** 当前是否已被批准持久化（`undefined` = 这个宿主没有这套 API）：诊断包用 */
export const isStoragePersisted = async (): Promise<boolean | undefined> => {
  const storage = storageManager()
  if (!storage || typeof storage.persisted !== 'function') {
    return undefined
  }
  try {
    return await storage.persisted()
  } catch {
    return undefined
  }
}

const estimateStorage = async (): Promise<{ usage?: number; quota?: number } | undefined> => {
  const storage = storageManager()
  if (!storage || typeof storage.estimate !== 'function') {
    return undefined
  }
  try {
    const estimate = await storage.estimate()
    return { usage: estimate.usage, quota: estimate.quota }
  } catch {
    return undefined
  }
}

/**
 * 库结构升级回调：**只新增、不迁移、不清空**（#399 起的口径，v12→v13、v13→v14 都是这样）。
 *
 * 为什么从 `getChatDB()` 里提出来单独导出：迁移不变量用例（
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

const forgetConnection = (connection: Promise<IDBPDatabase<ChatDB>>) => {
  if (dbPromise === connection) {
    dbPromise = null
  }
}

/**
 * 能力探测：宿主到底有没有 IndexedDB（#209 口径 —— 能力探测替代一切假设）。
 *
 * 三种环境会没有它：Safari 无痕窗口、WebView 关闭了存储、第三方 iframe 的分区存储被拦。
 * 不探测的后果不是「慢」，而是**反复失败**：每次读写都会再 `openDB()` 一次、必然抛错，
 * 横幅永远消不掉、日志被刷满 —— 根因是「这台机器没有这个能力」，重试一万次也一样。
 */
export class StorageUnavailableError extends Error {
  constructor() {
    super('IndexedDB is not available in this environment')
    this.name = 'StorageUnavailableError'
  }
}

/**
 * 另一个标签页攥着旧连接、升级被挡住（`blocked` 事件）。
 *
 * 之前 `openDB` 的 `blocked` **完全没处理**：请求既不成功也不失败，`getChatDB()` 的 promise
 * 永远 pending，界面就永远停在「正在加载对话…」——用户以为是卡死，其实是另一个页面没关。
 */
export class StorageBlockedError extends Error {
  /** 界面档位（store 直接读这个字段，因此不必 import 本类、测试替身也不必实现它） */
  readonly initFailure = 'blocked' as const

  constructor() {
    super('Another tab holds an older database connection')
    this.name = 'StorageBlockedError'
  }
}

/**
 * 库版本比代码新（`VersionError`）：`requested version < existing version`。
 *
 * 只会出现在「装过更新的构建 / 别的标签页先升过库」之后又回滚到老代码的场景。
 * 它**不是**「加载失败」：重试一万次也一样，必须让用户更新应用 —— 所以文案单独一条，
 * 不许复用「加载失败请重试」（那会把用户引进死循环）。
 */
export class StorageVersionTooNewError extends Error {
  readonly initFailure = 'version' as const

  constructor(message = 'The stored database version is newer than this app expects') {
    super(message)
    this.name = 'StorageVersionTooNewError'
  }
}

/** `blocked` 之后等多久判「对方不配合」：5s 足够让一次正常升级跑完，又不至于让用户盯着转圈 */
export const BLOCKED_TIMEOUT_MS = 5000

/** 启动期读库失败的两种「换文案」情形（其余仍走「加载失败请重试」） */
export type StorageInitFailure = 'blocked' | 'version'

/** 运行期能力探测：宿主有没有 IndexedDB。每次调用都问一遍，成本可忽略 */
export const isIndexedDBAvailable = (): boolean => typeof indexedDB !== 'undefined'

/**
 * 打开库，并给 `blocked` 补上**超时兜底**：`blocked` 触发后开始计时，超时就以
 * `StorageBlockedError` 失败（而不是让调用方永远 pending）。
 *
 * 超时判负之后底层请求可能还会成功 —— 那时连接已经没人要了，必须 `close()` 掉，
 * 否则它会一直占着升级锁，把**下一个**标签页也堵死。
 */
const openWithBlockedGuard = (onTerminated: () => void): Promise<IDBPDatabase<ChatDB>> => {
  let armBlocked = () => {}
  const raw = openDB<ChatDB>(DB_NAME, DB_VERSION, {
    upgrade: upgradeChatDB,
    // 连接被浏览器单方面关掉（`terminated`）时必须忘掉缓存，否则后续每次读写都拿到死连接。
    // 注意：忘掉的是 `getChatDB()` **缓存的那个** promise（由调用方传入），不是这里的包装 promise ——
    // 两者不是同一个对象，用错一个就会「terminated 之后仍然重开不了」。
    terminated: () => onTerminated(),
    blocked: () => armBlocked(),
  })
  let opening: Promise<IDBPDatabase<ChatDB>>
  opening = new Promise<IDBPDatabase<ChatDB>>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const closeQuietly = (db: IDBPDatabase<ChatDB>) => {
      try {
        db.close()
      } catch {
        // 已经关掉 / 已被 terminated：没有可做的
      }
    }
    armBlocked = () => {
      if (settled || timer !== undefined) {
        return
      }
      timer = setTimeout(() => {
        if (settled) {
          return
        }
        settled = true
        void raw.then(closeQuietly, () => {})
        reject(new StorageBlockedError())
      }, BLOCKED_TIMEOUT_MS)
    }
    raw.then(
      (db) => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        if (settled) {
          closeQuietly(db)
          return
        }
        settled = true
        resolve(db)
      },
      (error: unknown) => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        if (settled) {
          return
        }
        settled = true
        reject(
          errorNameOf(error) === 'VersionError' ? new StorageVersionTooNewError(errorMessageOf(error)) : error
        )
      }
    )
  })
  return opening
}

export const getChatDB = (): Promise<IDBPDatabase<ChatDB>> => {
  // 缺能力时**不**写进 `dbPromise`：能力是环境属性、不是瞬时故障，
  // 缓存一个 rejected promise 只会让这里变成永久的坑，而每次新建一个
  // rejected promise 既不尝试打开、也不会被后来的消费者误当成"可用连接"。
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new StorageUnavailableError())
  }
  if (dbPromise) {
    return dbPromise
  }
  // P0：真要碰库之前先申请「持久化存储」。放在这里而不是某个组件的 useEffect 里，是因为
  // **任何**读库路径（首屏、诊断、导入）都会经过这里 —— 申请一次就够，且绝不阻塞（`void` 掉）。
  // 幂等：`ensurePersistentStorage()` 内部只问一次，重复调用返回同一个 promise。
  void ensurePersistentStorage()
  let opening: Promise<IDBPDatabase<ChatDB>>
  opening = openWithBlockedGuard(() => forgetConnection(opening)).catch((error: unknown) => {
    forgetConnection(opening)
    throw error
  })
  dbPromise = opening
  return opening
}

// 显式 close() 没有 terminated 事件。只在创建事务时重连，已经开始的业务事务不会重放。
export const openChatTransaction = async <
  const Names extends readonly StoreNames<ChatDB>[],
  Mode extends 'readonly' | 'readwrite' = 'readonly',
>(stores: Names, mode?: Mode) => {
  for (let attempt = 0; ; attempt++) {
    const opening = getChatDB()
    const db = await opening
    try {
      return db.transaction(stores, mode)
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) {
        throw error
      }
      forgetConnection(opening)
      if (attempt === 1) {
        throw error
      }
    }
  }
}

/** 单表请求也走同一事务入口，并把提交失败传给调用方。 */
export const runChatStoreRequest = async <
  Name extends StoreNames<ChatDB>,
  Mode extends 'readonly' | 'readwrite',
  Result,
>(
  name: Name,
  mode: Mode,
  request: (store: IDBPObjectStore<ChatDB, readonly [Name], Name, Mode>) => Promise<Result>
): Promise<Result> => {
  const tx = await openChatTransaction([name], mode)
  const [result] = await Promise.all([request(tx.store), tx.done])
  return result
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const rows = await runChatStoreRequest('sessionSummaries', 'readonly', (store) => store.getAll())
  return rows.map(toSessionSummary)
}

export const loadSession = async (id: string): Promise<Session | undefined> =>
  runChatStoreRequest('sessions', 'readonly', (store) => store.get(id))

/** 会话记录（事务 A）涉及的 store */
const STORES_SESSION = 'sessions,sessionSummaries'
/** 附件原件（事务 B）涉及的 store */
const STORES_FILES = 'files'

/**
 * 会话记录（事务 A）写失败：带上分类与「兜底剔掉了哪些字段」。
 *
 * **不导出**：失败一律通过 `saveSession()` 的返回值（`outcome.failure`）交给调用方 ——
 * 抛异常会让「catch 里忘了标红」重新变成静默丢数据的老路（这正是本单要治的病）。
 */
class SessionWriteError extends Error {
  readonly failure: StorageFailure
  readonly strippedFields: readonly string[]

  constructor(failure: StorageFailure, strippedFields: readonly string[] = []) {
    super(failure.message ?? failure.name ?? failure.kind)
    this.name = 'SessionWriteError'
    this.failure = failure
    this.strippedFields = strippedFields
  }
}

/** 单个附件的降级结论：只有 id / 字节数 / 分类，**不读正文、不读文件名**。 */
export type FileDegradation = { id: string; bytes: number; failure: StorageFailure }

export type SaveSessionOutcome = {
  /** 事务 A 的结论：`null` = 会话与摘要**已提交** */
  failure: StorageFailure | null
  /** 事务 B 的结论：只有这些附件没写进去（会话本身已经落盘） */
  degradedFiles: FileDegradation[]
  /** `DataCloneError` 兜底剔除的字段路径（不含任何正文） */
  strippedFields: string[]
}

export type SaveSessionOptions = {
  /**
   * 清理孤儿 blob 时要**避开**的原件 id：调用方手上「刚排队、还没写进去」的附件。
   * 不清的话会把用户刚发的附件当成孤儿删掉，等于用腾空间的动作制造新的丢数据。
   */
  keepFileIds?: readonly string[]
}

/** 备注型留痕（配额预判这类「不是错误、但要能查」的事实），与 `reportStorageError` 分开 */
const reportStorageNote = (action: string, detail: string) => {
  // eslint-disable-next-line no-console
  console.info(`[storage] ${action}: ${detail}`)
}

const blobBytesOf = (file: StoredFile): number =>
  typeof file.blob === 'object' && file.blob !== null && typeof file.blob.size === 'number'
    ? file.blob.size
    : 0

const putFilesOnce = async (files: StoredFile[]): Promise<void> => {
  const tx = await openChatTransaction(['files'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        for (const file of files) {
          await tx.store.put(file)
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
 * 清掉**没有任何会话引用**的孤儿 blob，返回腾出的字节数（尽力而为，失败不抛）。
 *
 * 为什么只清孤儿、且必须避开 `keep`：
 *  · 被 `sessionSummaries.fileIds` 索引引用的原件不能动（那是在用的图 / 文件）；
 *  · `attachment-<sha256>` 前缀的文档附件原件不在 `fileIds` 里（引用关系在 `attachments` 表，
 *    见 #531），所以按前缀整类跳过；
 *  · `keep` 是调用方**还没写进去**的原件 id —— 它们是「孤儿」只是暂时的，删了就是丢数据。
 */
const sweepOrphanFiles = async (keep: ReadonlySet<string>): Promise<number> => {
  const tx = await openChatTransaction(['sessionSummaries', 'files'], 'readwrite')
  let freed = 0
  try {
    const referenced = new Set<string>()
    for (
      let cursor = await tx.objectStore('sessionSummaries').openCursor();
      cursor;
      cursor = await cursor.continue()
    ) {
      for (const id of cursor.value.fileIds ?? []) {
        referenced.add(id)
      }
    }
    const files = tx.objectStore('files')
    const doomed: string[] = []
    for (let cursor = await files.openCursor(); cursor; cursor = await cursor.continue()) {
      const key = String(cursor.key)
      if (referenced.has(key) || keep.has(key) || isAttachmentBlobKey(key)) {
        continue
      }
      doomed.push(key)
      freed += blobBytesOf(cursor.value)
    }
    // 先收齐再删：边删边 continue 的游标语义依赖实现细节
    for (const key of doomed) {
      await files.delete(key)
    }
  } catch (error) {
    abortTransaction(tx)
    throw error
  }
  await tx.done
  return freed
}

/**
 * 配额失败的兜底：**先 `estimate()` 预判，再清孤儿 blob**，最后由调用方重试一次。
 * 预判结果只用于留痕与「连该腾多少都算不出来」的判断，不拿它当写不写得进去的判据
 * （`estimate` 的 usage 含已排队但还没提交的数据，永远只能当参考）。
 */
const reclaimQuotaSpace = async (keepFileIds: readonly string[] = []): Promise<number> => {
  const before = await estimateStorage()
  const freed = await sweepOrphanFiles(new Set(keepFileIds)).catch(() => 0)
  const after = await estimateStorage()
  reportStorageNote(
    'quota reclaim',
    `usage ${before?.usage ?? '?'}→${after?.usage ?? '?'} / quota ${after?.quota ?? before?.quota ?? '?'} / freed ${freed}`
  )
  return freed
}

const writeSessionRecordOnce = async (session: Session): Promise<void> => {
  const summary = storedSummary(session)
  const tx = await openChatTransaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
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

/**
 * **事务 A（必须成功）**：只写 `sessions` + `sessionSummaries`（几 KB）。
 *
 * 两条自愈各只做**一次**（重试爆炸比失败更糟）：
 *  · `DataCloneError` → 剔掉不可克隆字段后重写（返回剔掉了哪些路径）；
 *  · `QuotaExceededError` → 清孤儿 blob 后重写。
 * 其余分类直接抛：这类失败重试也是同一个结果。
 */
const writeSessionRecord = async (session: Session): Promise<string[]> => {
  try {
    await writeSessionRecordOnce(session)
    return []
  } catch (error) {
    const kind = classifyStorageFailure(error)
    if (kind === 'clone') {
      const { value, removed } = stripNonCloneableFields(session)
      if (removed.length > 0) {
        try {
          await writeSessionRecordOnce(value)
          return removed
        } catch (retryError) {
          throw new SessionWriteError(storageFailureOf(retryError, STORES_SESSION), removed)
        }
      }
    }
    if (kind === 'quota') {
      await reclaimQuotaSpace()
      try {
        await writeSessionRecordOnce(session)
        return []
      } catch (retryError) {
        throw new SessionWriteError(storageFailureOf(retryError, STORES_SESSION))
      }
    }
    throw new SessionWriteError(storageFailureOf(error, STORES_SESSION))
  }
}

/**
 * **事务 B（可以失败）**：只写 `files` 里的附件 blob。失败**只降级这些附件**，
 * 已经提交的会话一个字都不动 —— 这是本单止血的核心：几 KB 的会话不该被几 MB 的 blob 拖下水。
 */
const writeAttachmentBlobs = async (
  files: StoredFile[],
  keepFileIds: readonly string[]
): Promise<FileDegradation[]> => {
  if (files.length === 0) {
    return []
  }
  let failure: StorageFailure
  try {
    await putFilesOnce(files)
    return []
  } catch (error) {
    failure = storageFailureOf(error, STORES_FILES)
    if (failure.kind === 'quota') {
      await reclaimQuotaSpace(keepFileIds)
      try {
        await putFilesOnce(files)
        return []
      } catch (retryError) {
        failure = storageFailureOf(retryError, STORES_FILES)
      }
    }
  }
  // 批量失败后**逐个**再试一次：一个坏附件不该让同一轮的其它附件一起降级。
  // 配额不足是全局条件，逐个试只是把同一个失败重复 N 次，跳过。
  if (files.length > 1 && failure.kind !== 'quota') {
    const degraded: FileDegradation[] = []
    for (const file of files) {
      try {
        await putFilesOnce([file])
      } catch (error) {
        degraded.push({ id: file.id, bytes: blobBytesOf(file), failure: storageFailureOf(error, STORES_FILES) })
      }
    }
    return degraded
  }
  return files.map((file) => ({ id: file.id, bytes: blobBytesOf(file), failure }))
}

/**
 * 保存一条会话 + 它的附件原件。**两个事务，不再是一个原子事务**（P0）。
 *
 * 改造前：`sessions + sessionSummaries + files` 放在**同一个** readwrite 事务里，
 * 于是任意一个 store 写失败（`DataCloneError` / `QuotaExceededError` / WebKit 写 blob 的
 * `UnknownError`）= **整条会话一个字都不落盘**，而内存里照常可用 → 用户清后台重开就回到上次状态，
 * 表现成「聊天记录少了几轮」（实测配额注入下：界面 3 轮、盘上 1 轮）。
 *
 * 现在：事务 A 落了就是落了；事务 B 失败只把**这一批附件**记成不可用（返回 `degradedFiles`），
 * 调用方保留原件引用以便重试。失败分类与自愈见 `classifyStorageFailure` / `writeSessionRecord`。
 */
export const saveSession = async (
  session: Session,
  files: StoredFile[] = [],
  options: SaveSessionOptions = {}
): Promise<SaveSessionOutcome> => {
  let strippedFields: string[] = []
  try {
    strippedFields = await writeSessionRecord(session)
  } catch (error) {
    const failure = error instanceof SessionWriteError ? error.failure : storageFailureOf(error, STORES_SESSION)
    const stripped = error instanceof SessionWriteError ? [...error.strippedFields] : []
    return { failure, degradedFiles: [], strippedFields: stripped }
  }
  const degradedFiles = await writeAttachmentBlobs(files, options.keepFileIds ?? [])
  return { failure: null, degradedFiles, strippedFields }
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const pinSession = async (id: string, pinnedAt: number | undefined): Promise<void> => {
  const tx = await openChatTransaction(['sessions', 'sessionSummaries'], 'readwrite')
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
  const tx = await openChatTransaction(['sessions', 'sessionSummaries'], 'readwrite')
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
  const tx = await openChatTransaction(
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
  const tx = await openChatTransaction([store], 'readwrite')
  await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
}

export const saveFiles = (files: StoredFile[]): Promise<void> => putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  (await runChatStoreRequest('files', 'readonly', (store) => store.get(id)))?.blob

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  const tx = await openChatTransaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await runChatStoreRequest('sessionsStaging', 'readwrite', (store) => store.add(session))
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  const tx = await openChatTransaction(['sessionsStaging'], 'readwrite')
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
  const tx = await openChatTransaction(
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
  const tx = await openChatTransaction(
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
  runChatStoreRequest('appAssets', 'readonly', (store) => store.get(key))

/** 写入/覆盖应用素材；固定 key 保证全局只有一份背景图。 */
export const saveAppAsset = async (key: string, blob: Blob): Promise<void> => {
  await runChatStoreRequest('appAssets', 'readwrite', (store) =>
    store.put({ key, blob, updatedAt: Date.now() })
  )
}

export const deleteAppAsset = async (key: string): Promise<void> => {
  await runChatStoreRequest('appAssets', 'readwrite', (store) => store.delete(key))
}

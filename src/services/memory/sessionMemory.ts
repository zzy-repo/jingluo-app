/**
 * sessionMemory.ts — 窗口记忆的**按会话隔离**存储层（#399）。
 *
 * 这是**本仓库自研代码**（不是同目录那批 vendored 上游 JS，来源与许可见 `./README.md`）。
 * 它的职责只有三件：按会话读写记忆、按会话做容量淘汰、把向量化交给 #398 的门。
 *
 * ## 1. 隔离是怎么做到的（关闭条件 1）
 *
 * 记忆存在既有的 `chat-demo` 库里（`chat/db.ts` 的 v14 新 store `sessionMemory`），
 * **主键里带会话 ID**：`id = `${sessionId}:${key}``（见 `db.ts` 的 `StoredSessionMemory`）。
 * 于是「同一个 key、不同会话」天生落在两条不同记录上：读一条记忆必须同时给出
 * `(sessionId, key)`，拿不到别的会话的键。`sessionId` 索引只用于「按会话取全量 / 整批删除」。
 *
 * 不新开第二套数据库（关闭条件的原文要求）：`chat-demo` 已经有一套版本迁移机制
 * （`DB_VERSION` + `upgrade` 里的 `contains()` 守卫），记忆只是又一个 store。
 *
 * ## 2. 容量与淘汰（关闭条件 2）
 *
 * 双限（`LIMITS.memory.maxEntriesPerSession` / `maxBytesPerSession`，数字与取值的理由都在
 * `services/limits.ts` 那张表里），**每次写入后就地淘汰**，而且**只淘汰本会话**的条目 ——
 * 跨会话回收等于隔离失效的另一种形态（A 写满把 B 的记忆挤掉），所以淘汰的候选集来自
 * `sessionId` 索引，永远不会看到别的会话的行。
 *
 * 规则 = **oldest-first**（`updatedAt` 升序，同一毫秒按 `id` 升序打破平局）。
 * 为什么选它而不是 LRU：LRU 要「每次召回命中都回写一次访问时间」，也就是一次 readwrite 事务 +
 * 索引更新的写放大；而窗口记忆的写入本身就是**随时间顺序追加**（chunk 序号 / 摘要块越晚越新），
 * 「最早写入 = 压缩链上离当前最远的片段 = 最可能已经不再相关」这条直觉与 LRU 的实际效果几乎重合，
 * 却只需要一个字段、一条排序。**确定且可测**是这里的硬要求：同毫秒同 `updatedAt` 时用主键兜底，
 * 所以「先淘汰哪一条」在任何实现（真 IDB / fake-indexeddb）上都是同一个答案。
 *
 * 淘汰**必须给提示**（不许静默丢）：一条 toast（`onMemoryNotice` → `App.tsx` 注册
 * `showToast`，与附件上传失败的提示同一套接法）+ 一条诊断日志（既有 `record`）。
 *
 * 单条就超过字节上限时**明确拒绝写入并提示**（不是「写进去再淘汰自己」）：这种情况压缩不了、
 * 也不该把两会话里唯一的那条悄悄丢掉 —— 与附件通路「超过编码上限就明确拒绝」同一口径。
 *
 * ## 3. 与 #398 的接线（顺便把 #398 的遗留收尾）
 *
 * 写入需要向量化时**只走** `embeddingGate.embed()`（关闭态它在任何网络调用之前抛错）。
 * 关闭态的处理是「**只存文本、不写向量**」，理由：`recall.js` 的 `recallSync()` 本来就是
 * 「embedding 没配 / 挂了 / 超时」时只跑本地 BM25 的那条路 —— 关掉开关等于这条降级路成为常态，
 * 记忆仍然可召回（按词面），只是不参与向量打分。**不给关闭态写零向量**：零向量在余弦里恒为 0，
 * 会被当成「算过但都不相关」，属于 #398 明确否掉的那种静默降级。
 *
 * ## 边界
 *
 * - 本单只做**存储与写入路径**：真正的召回打分（上游 `recall.js` 的混合检索）仍未接进 app 运行时
 *   （它是 classic script + `window.SCRecall`，见 `./README.md` 的边界说明）。
 * - 跨设备同步不做（#399 的「未测」项）。
 */

import type { LinkedMessage } from '../../i18n/index.js'
import type { EmbeddingResult } from '../api/embedding.js'
import { openChatTransaction, runChatStoreRequest, type StoredSessionMemory } from '../chat/db.js'
import { record } from '../diagnostics/collector.js'
import { LIMITS, kbOf } from '../limits.js'
import { EmbeddingDisabledError, embed, isEmbeddingEnabled } from './embeddingGate.js'

/** 一个浮点分量在向量里占的字节数（`number[]` 的每个元素在等价 float32 存储里的宽度） */
const BYTES_PER_VECTOR_COMPONENT = 4

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/**
 * 一条记忆占的字节数：正文的 UTF-8 字节 + 向量的 4 字节/分量。
 *
 * 口径只有这一份 —— 写库时算进 `StoredSessionMemory.bytes`，容量判定直接读那个字段，
 * 不再把整批正文读出来重算（也就不会出现「判定口径」和「存的值」两套算法）。
 */
export const memoryEntryBytes = (text: string, vec?: readonly number[]): number =>
  utf8Bytes(text) + (vec === undefined ? 0 : vec.length * BYTES_PER_VECTOR_COMPONENT)

/** 记忆条目的对外形状（不含库里的 `id` / `sessionId`：调用方本来就按会话读写，看不到别人的行） */
export type MemoryEntry = {
  key: string
  text: string
  vec?: number[]
  model?: string
  dim?: number
  bytes: number
  createdAt: number
  updatedAt: number
}

export type SaveMemoryInput = {
  /** 会话内的记忆键（chunk 序号 / 摘要块 id 等）；同一 key 重复写 = **覆盖**，不产生第二条 */
  key: string
  text: string
  /** 向量模型名；换模型后旧向量不该被当成同一空间比较，所以写进记录 */
  model?: string
}

/** 写入结果：写成功（可能伴随淘汰）或明确拒绝（单条超上限），两种都带得走的数字 */
export type SaveMemoryOutcome =
  | {
      written: true
      entry: MemoryEntry
      /** 本次淘汰掉的条数（0 = 没超限） */
      evicted: number
      /** 被淘汰的会话内 key，升序（按淘汰顺序），便于日志与用例断言 */
      evictedKeys: string[]
    }
  | { written: false; reason: 'entry-too-large'; bytes: number; limit: number }

/** 提示通道：界面层（`App.tsx`）注册一次 `showToast`，服务层不 import 组件（与 `onUploadNotice` 同一套） */
export type MemoryNoticeListener = (notice: LinkedMessage) => void

const noticeListeners = new Set<MemoryNoticeListener>()

/**
 * 订阅记忆相关的用户可⻅提示（目前只有「淘汰了 N 条」「单条超上限被拒绝」两种）。
 * 返回取消订阅函数 —— 与 `services/attachments.ts` 的 `onUploadNotice` 同形状。
 */
export const onMemoryNotice = (listener: MemoryNoticeListener): (() => void) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

const notifyMemoryNotice = (notice: LinkedMessage): void => {
  for (const listener of noticeListeners) {
    try {
      listener(notice)
    } catch {
      // 提示通道自己炸了不该拖垮记忆写入（提示是旁路，写库才是主路）
    }
  }
}

/**
 * 记忆主键：**会话 ID 是键的一部分**，这是隔离的唯一落点（`db.ts` 的 `StoredSessionMemory.id` 同口径）。
 *
 * 会话 ID 里不允许出现分隔符 `:`：`id` 用 `:` 拼接，若会话 ID 自带 `:`，`('a:b','c')` 与
 * `('a','b:c')` 会拼成同一个主键 —— 那正是隔离被绕过的一种形状，所以在入口就拒掉（不是 trim 了当没事）。
 * 会话 ID 由 `crypto.randomUUID()` 产生（见 `chat/store.ts`），正常永远不含 `:`。
 */
const assertSessionId = (sessionId: string): void => {
  if (sessionId === '' || sessionId.includes(':')) {
    throw new Error(`会话 ID 非法：${JSON.stringify(sessionId)}（记忆键必须能唯一归属到一个会话）`)
  }
}

export const memoryEntryId = (sessionId: string, key: string): string => {
  assertSessionId(sessionId)
  return `${sessionId}:${key}`
}

/**
 * 需要向量化时**唯一**的出口（#398 的门）：关闭态直接返回 `undefined`，连 `embed()` 都不进 ——
 * 所以关闭态 `fetchCalls === 0`（用例 T6 钉住这条）。
 */
const vectorize = async (
  sessionId: string,
  text: string,
  model: string | undefined
): Promise<number[] | undefined> => {
  if (!isEmbeddingEnabled()) {
    return undefined
  }
  let result: EmbeddingResult
  try {
    result = await embed(model === undefined ? { input: [text] } : { input: [text], model })
  } catch (error) {
    if (error instanceof EmbeddingDisabledError) {
      // 判定与调用之间用户关掉了开关：按关闭态收尾（不写向量、不重试、不发第二条请求）
      return undefined
    }
    throw error
  }
  if (!result.ok || result.vectors.length === 0) {
    // 降级为「只存文本」：召回仍能按词面命中，但这条故障必须留痕（不许静默）
    record('warning', 'warn', 'memory: 向量化失败，本条只存文本', {
      'memory.session': sessionId,
      'memory.reason': result.reason === '' ? 'unknown' : result.reason,
      'memory.text.bytes': utf8Bytes(text),
    })
    return undefined
  }
  return result.vectors[0]
}

const toEntry = (row: StoredSessionMemory): MemoryEntry => {
  const entry: MemoryEntry = {
    key: row.key,
    text: row.text,
    bytes: row.bytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.vec !== undefined) {
    entry.vec = row.vec
  }
  if (row.model !== undefined) {
    entry.model = row.model
  }
  if (row.dim !== undefined) {
    entry.dim = row.dim
  }
  return entry
}

/**
 * 写入一条记忆（**唯一写入口**）：同一 `(sessionId, key)` 覆盖写，不产生重复条目；
 * 写完后按双限就地淘汰本会话最老的条目，并把淘汰结果记进日志 + 提示给用户。
 *
 * 事务边界：读旧值 / 写新值 / 收候选 / 删淘汰项都在**同一个事务**里，要么全成要么全不成 ——
 * 不会出现「新条目写了、老的没删掉」或「老的删了、新的没写进去」这种半截状态。
 */
export const saveMemoryEntry = async (
  sessionId: string,
  input: SaveMemoryInput
): Promise<SaveMemoryOutcome> => {
  const id = memoryEntryId(sessionId, input.key)
  if (input.key === '') {
    throw new Error('记忆 key 不能为空（同会话内它是覆盖写的依据）')
  }
  const vec = await vectorize(sessionId, input.text, input.model)
  const bytes = memoryEntryBytes(input.text, vec)
  const byteLimit = LIMITS.memory.maxBytesPerSession
  if (bytes > byteLimit) {
    // 明确拒绝：写进去再把它当「最老的」淘汰掉，等于用户以为自己存上了
    notifyMemoryNotice({
      key: 'memoryEntryTooLarge',
      params: { kb: Math.max(1, kbOf(bytes)) },
    })
    record('warning', 'warn', 'memory: 单条记忆超容量上限，未写入', {
      'memory.session': sessionId,
      'memory.entry.bytes': bytes,
      'memory.limit.bytes': byteLimit,
    })
    return { written: false, reason: 'entry-too-large', bytes, limit: byteLimit }
  }

  const now = Date.now()
  const tx = await openChatTransaction(['sessionMemory'], 'readwrite')
  const run = async (): Promise<{ entry: MemoryEntry; evictedKeys: string[] }> => {
    const store = tx.objectStore('sessionMemory')
    const existing = await store.get(id)
    // 覆盖写保留 createdAt（这条记忆什么时候第一次出现），只推进 updatedAt（淘汰排序用）
    const createdAt = existing === undefined ? now : existing.createdAt
    const row: StoredSessionMemory = {
      id,
      sessionId,
      key: input.key,
      text: input.text,
      bytes,
      createdAt,
      updatedAt: now,
    }
    if (vec !== undefined) {
      row.vec = vec
      row.dim = vec.length
      if (input.model !== undefined) {
        row.model = input.model
      }
    }
    await store.put(row)

    // 候选集只来自本会话（`sessionId` 索引）—— 跨会话淘汰在这里不可能发生
    const rows: { id: string; key: string; updatedAt: number; bytes: number }[] = []
    for (
      let cursor = await store.index('sessionId').openCursor(sessionId);
      cursor;
      cursor = await cursor.continue()
    ) {
      rows.push({
        id: String(cursor.primaryKey),
        key: cursor.value.key,
        updatedAt: cursor.value.updatedAt,
        bytes: cursor.value.bytes,
      })
    }
    let totalBytes = 0
    for (const item of rows) {
      totalBytes += item.bytes
    }
    let count = rows.length
    // oldest-first：updatedAt 升序，同毫秒按主键升序（确定且可测，见文件头「为什么选它」）
    const order = [...rows].sort((a, b) =>
      a.updatedAt === b.updatedAt ? (a.id < b.id ? -1 : 1) : a.updatedAt - b.updatedAt
    )
    const evictedKeys: string[] = []
    for (const item of order) {
      if (
        count <= LIMITS.memory.maxEntriesPerSession &&
        totalBytes <= LIMITS.memory.maxBytesPerSession
      ) {
        break
      }
      if (item.id === id) {
        // 刚写的那条不淘汰自己：它的字节数上面已单独判过，留着它才能保证「写成功 = 读得到」
        continue
      }
      await store.delete(item.id)
      count -= 1
      totalBytes -= item.bytes
      evictedKeys.push(item.key)
    }
    return { entry: toEntry(row), evictedKeys }
  }

  let result: { entry: MemoryEntry; evictedKeys: string[] }
  try {
    const [outcome] = await Promise.all([run(), tx.done])
    result = outcome
  } catch (error) {
    try {
      tx.abort()
    } catch {
      // 事务已因请求失败中止
    }
    throw error
  }

  if (result.evictedKeys.length > 0) {
    // 淘汰**必须**给提示（不是静默丢）：toast 一句 + 诊断日志一条，两个都要
    notifyMemoryNotice({ key: 'memoryEvicted', params: { count: result.evictedKeys.length } })
    record('warning', 'warn', 'memory: 会话记忆超出容量上限，已淘汰最早的条目', {
      'memory.session': sessionId,
      'memory.evicted': result.evictedKeys.length,
      'memory.limit.entries': LIMITS.memory.maxEntriesPerSession,
      'memory.limit.bytes': LIMITS.memory.maxBytesPerSession,
      'memory.entry.bytes': bytes,
    })
  }
  return {
    written: true,
    entry: result.entry,
    evicted: result.evictedKeys.length,
    evictedKeys: result.evictedKeys,
  }
}

/** 读一条记忆：key 只在本会话内解析，拿不到别的会话的行（隔离的读侧） */
export const readMemoryEntry = async (
  sessionId: string,
  key: string
): Promise<MemoryEntry | undefined> => {
  assertSessionId(sessionId)
  const row = await runChatStoreRequest('sessionMemory', 'readonly', (store) =>
    store.get(memoryEntryId(sessionId, key))
  )
  return row === undefined ? undefined : toEntry(row)
}

/** 读一个会话的全部记忆，按 `createdAt` 升序（= 上游 chunk 的写入顺序） */
export const listMemoryEntries = async (sessionId: string): Promise<MemoryEntry[]> => {
  assertSessionId(sessionId)
  const rows = await runChatStoreRequest('sessionMemory', 'readonly', (store) =>
    store.index('sessionId').getAll(sessionId)
  )
  return rows
    .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt))
    .map(toEntry)
}

/** 删一条记忆；返回是否真删掉了（用于「覆盖写 / 重复删」这类断言） */
export const deleteMemoryEntry = async (sessionId: string, key: string): Promise<boolean> => {
  assertSessionId(sessionId)
  const id = memoryEntryId(sessionId, key)
  const tx = await openChatTransaction(['sessionMemory'], 'readwrite')
  const run = async (): Promise<boolean> => {
    const store = tx.objectStore('sessionMemory')
    if ((await store.count(id)) === 0) {
      return false
    }
    await store.delete(id)
    return true
  }
  const [deleted] = await Promise.all([run(), tx.done])
  return deleted
}

/**
 * 清空一个会话的全部记忆，返回删掉的条数（其它会话一条不碰）。
 *
 * 注意：**删会话的主路径不靠这个函数** —— 它走 `db.deleteSession()`，记忆与
 * `sessions` / `sessionSummaries` / 原件在**同一个事务**里清掉（见 `chat/db.ts`）。
 * 这里留给「用户主动清空某会话记忆」与用例的清场。
 */
export const clearSessionMemory = async (sessionId: string): Promise<number> => {
  assertSessionId(sessionId)
  const tx = await openChatTransaction(['sessionMemory'], 'readwrite')
  const run = async (): Promise<number> => {
    const store = tx.objectStore('sessionMemory')
    const keys: string[] = []
    for (
      let cursor = await store.index('sessionId').openKeyCursor(sessionId);
      cursor;
      cursor = await cursor.continue()
    ) {
      keys.push(String(cursor.primaryKey))
    }
    for (const key of keys) {
      await store.delete(key)
    }
    return keys.length
  }
  const [removed] = await Promise.all([run(), tx.done])
  return removed
}

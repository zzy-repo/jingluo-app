/**
 * 全量校验器（#910）：比较「源」与「目标」两个 `RawStoreSource`，不抽样。
 *
 * 每个 store 做四件事：
 *  1. 计数：`count()` 是否相等（另外核对 `count()` 与实际扫到的行数是否自洽）；
 *  2. 主键集合：输出 `missingKeys`（源有目标无）与 `extraKeys`（目标有源无）；
 *  3. 逐行规范化内容哈希（`hash.ts`：Blob 比字节、Date/NaN 带类型标签），输出 `contentMismatchKeys`；
 *  4. 语义不变量（见 `SemanticCollector`），两侧各算一遍。
 *
 * 语义不变量的口径是「**目标与源的差异才是错误**」：源里原有的瑕疵（摘要引用的原件早就不在、
 * 孤儿记忆……）在目标里必须原样存在，两侧相同不算问题；一侧有、另一侧没有才进 `semanticIssues`。
 * 因此校验器不会、也不许在目标里「修好」源的瑕疵。
 *
 * 不依赖主键排序：两侧各自扫一遍，用主键→哈希的表比对（内存与主键数成正比，不含行内容）。
 * 所以 IndexedDB（UTF-16 序）与 SQLite（字节序）的排序差异不会造成误判。
 */
import { isAttachmentBlobKey } from '../../attachments/blobKeys.js'
import { toSessionSummary } from '../../chat/types.js'
import { abortError, hashRow, hashValue, pageLimitFor, scanStore } from './hash.js'
import {
  RAW_STORE_NAMES,
  type RawRow,
  type RawStoreName,
  type RawStoreSource,
  type StoreVerification,
  type VerifyReport,
} from './types.js'

export type VerifyProgress = {
  store: RawStoreName
  side: 'source' | 'target'
  rowsScanned: number
  total: number
}

/** 仅供测试做负向对照：把某项检查关掉，对应的缺陷必须从「报错」变成「放过」。编排器不得传它。 */
export type VerifySkip = Partial<Record<'count' | 'keys' | 'content' | 'semantic', true>>

export type VerifyOptions = {
  source: RawStoreSource
  target: RawStoreSource
  signal?: AbortSignal
  onProgress?: (progress: VerifyProgress) => void
  pageRows?: number
  skip?: VerifySkip
}

// ---------------------------------------------------------------- 语义不变量

type Rec = Record<string, unknown>
const asRecord = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** 与 `chat/db.ts` 的 `referencedFileIds` 同口径：用户消息里引用的本地原件 id（去重）。 */
const referencedFileIds = (session: Rec): string[] => {
  const ids = new Set<string>()
  const messages = Array.isArray(session.messages) ? session.messages : []
  for (const message of messages) {
    const record = asRecord(message)
    if (record?.role !== 'user' || !Array.isArray(record.files)) {
      continue
    }
    for (const file of record.files) {
      const id = asString(asRecord(file)?.id)
      if (id !== undefined) {
        ids.add(id)
      }
    }
  }
  return [...ids].sort()
}

const sortedStrings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))].sort() : []

type SessionFacts = { summaryHash: string; fileIds: string[] }
type SummaryFacts = SessionFacts

/**
 * 一侧（源或目标）的语义事实收集器：逐行 `observe`，最后 `facts()` 给出一组「事实字符串」。
 * 事实 = 该侧存在的一个问题或计数；两侧事实集合不同才是错误。内存只存主键与小摘要，不存行内容。
 */
export class SemanticCollector {
  private readonly sessions = new Map<string, SessionFacts>()
  private readonly summaries = new Map<string, SummaryFacts>()
  private readonly fileKeys = new Set<string>()
  private readonly textKeys = new Set<string>()
  private readonly attachments: { id: string; localPath?: string; parsedTextPath?: string }[] = []
  private readonly memories: { id: string; sessionId?: string }[] = []
  private readonly malformed: string[] = []
  private readonly counted = new Map<RawStoreName, number>()

  async observe(store: RawStoreName, row: RawRow): Promise<void> {
    this.counted.set(store, (this.counted.get(store) ?? 0) + 1)
    switch (store) {
      case 'files':
        this.fileKeys.add(row.key)
        return
      case 'attachmentTexts':
        this.textKeys.add(row.key)
        return
      case 'sessions':
      case 'sessionSummaries':
      case 'attachments':
      case 'sessionMemory':
        break
      default:
        return
    }
    const value = asRecord(row.value)
    if (!value) {
      this.malformed.push(`${store}:${row.key}`)
      return
    }
    if (store === 'sessions') {
      const summary = toSessionSummary(value as never)
      this.sessions.set(row.key, {
        summaryHash: await hashValue(summary),
        fileIds: referencedFileIds(value),
      })
    } else if (store === 'sessionSummaries') {
      const summary = toSessionSummary(value as never)
      this.summaries.set(row.key, {
        summaryHash: await hashValue(summary),
        fileIds: sortedStrings(value.fileIds),
      })
    } else if (store === 'attachments') {
      this.attachments.push({
        id: row.key,
        localPath: asString(value.localPath),
        parsedTextPath: asString(value.parsedTextPath),
      })
    } else {
      this.memories.push({ id: row.key, sessionId: asString(value.sessionId) })
    }
  }

  /** 该侧实际扫到的行数（与 `count()` 对账用）。 */
  scanned(store: RawStoreName): number {
    return this.counted.get(store) ?? 0
  }

  facts(): Set<string> {
    const out = new Set<string>()
    for (const key of this.malformed) {
      out.add(`malformed-row:${key}`)
    }
    // 摘要与会话一一对应，摘要字段由会话派生一致
    for (const [id, session] of this.sessions) {
      const summary = this.summaries.get(id)
      if (!summary) {
        out.add(`summary-missing:${id}`)
        continue
      }
      if (summary.summaryHash !== session.summaryHash) {
        out.add(`summary-stale:${id}`)
      }
      if (summary.fileIds.join('\n') !== session.fileIds.join('\n')) {
        out.add(`summary-fileids-differ:${id}`)
      }
    }
    for (const id of this.summaries.keys()) {
      if (!this.sessions.has(id)) {
        out.add(`summary-orphan:${id}`)
      }
    }
    // 摘要 fileIds 引用的原件是否存在：缺失只作为事实记录（源里允许缺失，以源为基准）
    for (const [id, summary] of this.summaries) {
      for (const fileId of summary.fileIds) {
        if (!this.fileKeys.has(fileId)) {
          out.add(`summary-file-missing:${id}:${fileId}`)
        }
      }
    }
    // 附件元数据指向的原件与全文
    for (const attachment of this.attachments) {
      if (attachment.localPath !== undefined && !this.fileKeys.has(attachment.localPath)) {
        out.add(`attachment-blob-missing:${attachment.id}:${attachment.localPath}`)
      }
      if (attachment.parsedTextPath !== undefined && !this.textKeys.has(attachment.parsedTextPath)) {
        out.add(`attachment-text-missing:${attachment.id}:${attachment.parsedTextPath}`)
      }
    }
    // 记忆行的会话归属：主键 = `${sessionId}:${key}`，且会话存在
    for (const memory of this.memories) {
      if (memory.sessionId === undefined || !memory.id.startsWith(`${memory.sessionId}:`)) {
        out.add(`memory-id-mismatch:${memory.id}`)
      }
      if (memory.sessionId !== undefined && !this.sessions.has(memory.sessionId)) {
        out.add(`memory-orphan:${memory.id}`)
      }
    }
    // `attachment-` 前缀原件数量
    let attachmentBlobs = 0
    for (const key of this.fileKeys) {
      if (isAttachmentBlobKey(key)) {
        attachmentBlobs += 1
      }
    }
    out.add(`count:attachment-blobs=${attachmentBlobs}`)
    return out
  }
}

// ---------------------------------------------------------------- 校验

type Side = 'source' | 'target'

const scanSide = async (
  side: Side,
  source: RawStoreSource,
  store: RawStoreName,
  options: VerifyOptions,
  collector: SemanticCollector,
  onRow: (row: RawRow, hash: string | undefined) => void
): Promise<number> => {
  const total = await source.count(store)
  let scanned = 0
  await scanStore(
    source,
    store,
    { limit: pageLimitFor(store, options.pageRows ?? 100), signal: options.signal },
    async (row) => {
      const hash = options.skip?.content ? undefined : await hashRow(row)
      if (!options.skip?.semantic) {
        await collector.observe(store, row)
      }
      onRow(row, hash)
      scanned += 1
      if (scanned % 50 === 0 || scanned === total) {
        options.onProgress?.({ store, side, rowsScanned: scanned, total })
      }
    }
  )
  return scanned
}

export const verifyAll = async (options: VerifyOptions): Promise<VerifyReport> => {
  const { source, target, skip } = options
  const stores: StoreVerification[] = []
  const semanticIssues: string[] = []
  const sourceSemantic = new SemanticCollector()
  const targetSemantic = new SemanticCollector()
  let ok = true

  for (const store of RAW_STORE_NAMES) {
    if (options.signal?.aborted) {
      throw abortError(options.signal)
    }
    const sourceCount = await source.count(store)
    const targetCount = await target.count(store)

    // 源：主键 → 哈希
    const sourceHashes = new Map<string, string | undefined>()
    const sourceScanned = await scanSide('source', source, store, options, sourceSemantic, (row, hash) => {
      sourceHashes.set(row.key, hash)
    })
    // 目标：逐行与源表对账，匹配的从表里划掉，剩下的就是 missing
    const extraKeys: string[] = []
    const contentMismatchKeys: string[] = []
    const targetScanned = await scanSide('target', target, store, options, targetSemantic, (row, hash) => {
      if (!sourceHashes.has(row.key)) {
        extraKeys.push(row.key) // 含目标里主键重复出现的第二次
        return
      }
      const expected = sourceHashes.get(row.key)
      sourceHashes.delete(row.key)
      if (hash !== expected) {
        contentMismatchKeys.push(row.key)
      }
    })
    const missingKeys = [...sourceHashes.keys()]

    const countOk = skip?.count ? true : sourceCount === targetCount
    const keysOk = skip?.keys ? true : missingKeys.length === 0 && extraKeys.length === 0
    const contentOk = skip?.content ? true : contentMismatchKeys.length === 0
    // `count()` 与实际扫到的行数不自洽：任何一侧都说明读口本身不可信
    if (!skip?.count) {
      if (sourceScanned !== sourceCount) {
        semanticIssues.push(`count-inconsistent:source:${store}:count=${sourceCount}:scanned=${sourceScanned}`)
      }
      if (targetScanned !== targetCount) {
        semanticIssues.push(`count-inconsistent:target:${store}:count=${targetCount}:scanned=${targetScanned}`)
      }
    }
    stores.push({
      store,
      sourceCount,
      targetCount,
      keysMatch: skip?.keys ? true : missingKeys.length === 0 && extraKeys.length === 0,
      missingKeys: skip?.keys ? [] : missingKeys,
      extraKeys: skip?.keys ? [] : extraKeys,
      contentMismatchKeys: skip?.content ? [] : contentMismatchKeys,
      full: true,
    })
    if (!countOk || !keysOk || !contentOk) {
      ok = false
    }
  }

  if (!skip?.semantic) {
    const sourceFacts = sourceSemantic.facts()
    const targetFacts = targetSemantic.facts()
    for (const fact of sourceFacts) {
      if (!targetFacts.has(fact)) {
        semanticIssues.push(`semantic:source-only:${fact}`)
      }
    }
    for (const fact of targetFacts) {
      if (!sourceFacts.has(fact)) {
        semanticIssues.push(`semantic:target-only:${fact}`)
      }
    }
  }
  if (semanticIssues.length > 0) {
    ok = false
  }
  return { ok, stores, semanticIssues }
}

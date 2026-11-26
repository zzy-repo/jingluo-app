/**
 * 复制引擎（#910）：把 `RawStoreSource` 的全部行按 store、按主键升序分批 upsert 进 `RawStoreSink`。
 *
 * 约定：
 *  - 每批 `sink.writeBatch` 成功后才调用 `onCheckpoint`（由调用方持久化）；批内不留半成品语义，
 *    `writeBatch` 对同一主键幂等，所以「写成功但检查点没来得及落盘」的重放是安全的。
 *  - 从 `checkpoints` 续跑：`done` 的 store 跳过，否则从 `lastKey` 之后继续。
 *  - 批大小同时受行数（`batchSize`）与字节（`maxBatchBytes`）约束；单行超过字节上限时自成一批，
 *    不会把几百 MB 攒进内存。读页大小按已观测的平均行体积自适应。
 *  - `signal` 中止：在批边界停下（已写批的检查点已交出），返回 `completed: false`，不抛错。
 *  - 任一批读 / 写 / 落检查点失败：抛 `CopyError`（带 `store` / `lastKey`），不吞，也不继续写后续 store。
 *  - 不依赖 React / Capacitor / 具体后端。
 */
import { estimateRowBytes, pageLimitFor } from './hash.js'
import {
  RAW_STORE_NAMES,
  type MigrationCheckpoint,
  type RawRow,
  type RawStoreName,
  type RawStoreSink,
  type RawStoreSource,
} from './types.js'

export const DEFAULT_BATCH_ROWS = 200
/** 单批字节上限（按 `estimateRowBytes` 估算）：Android 单行 CursorWindow 约 2MB，批要远小于它的整数倍之外还得省内存。 */
export const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024

export type CopyPhase = 'read' | 'write' | 'checkpoint'

/** 复制失败。`lastKey` = 该 store 最后一个已确认写入并交出检查点的主键（`undefined` = 一行都没提交）。 */
export class CopyError extends Error {
  readonly store: RawStoreName
  readonly lastKey: string | undefined
  readonly phase: CopyPhase
  /** 失败那一批的第一个主键（读失败时为 `undefined`） */
  readonly batchFirstKey: string | undefined
  override readonly cause: unknown

  constructor(args: {
    store: RawStoreName
    lastKey: string | undefined
    phase: CopyPhase
    batchFirstKey?: string
    cause: unknown
  }) {
    const reason = args.cause instanceof Error ? args.cause.message : String(args.cause)
    super(`copy ${args.phase} failed at store=${args.store} lastKey=${args.lastKey ?? '<none>'}: ${reason}`)
    this.name = 'CopyError'
    this.store = args.store
    this.lastKey = args.lastKey
    this.phase = args.phase
    this.batchFirstKey = args.batchFirstKey
    this.cause = args.cause
  }
}

export type CopyProgress = {
  store: RawStoreName
  /** 本次运行里该 store 已写入的行数 */
  storeRowsCopied: number
  /** 该 store 的源计数（开始处理它时读取） */
  storeTotalRows: number
  /** 本次运行累计 */
  rowsCopied: number
  bytesCopied: number
}

export type CopyOptions = {
  source: RawStoreSource
  sink: RawStoreSink
  /** 上次运行交出的检查点（每个 store 取最后一条） */
  checkpoints?: readonly MigrationCheckpoint[]
  onCheckpoint?: (checkpoint: MigrationCheckpoint) => Promise<void> | void
  onProgress?: (progress: CopyProgress) => void
  signal?: AbortSignal
  batchSize?: number
  maxBatchBytes?: number
}

export type CopyResult = {
  /** `false` = 被 `signal` 中止，在批边界停下 */
  completed: boolean
  rowsCopied: number
  bytesCopied: number
  batches: number
  /** 本次运行里观测到的最大单批估算字节数（诊断用） */
  maxBatchBytesSeen: number
}

const latestCheckpoints = (
  checkpoints: readonly MigrationCheckpoint[] | undefined
): Map<RawStoreName, MigrationCheckpoint> => {
  const map = new Map<RawStoreName, MigrationCheckpoint>()
  for (const checkpoint of checkpoints ?? []) {
    const existing = map.get(checkpoint.store)
    // 同一 store 多条：done 优先，否则后来者覆盖
    if (!existing || !existing.done) {
      map.set(checkpoint.store, checkpoint)
    }
  }
  return map
}

export const copyAll = async (options: CopyOptions): Promise<CopyResult> => {
  const { source, sink, signal, onCheckpoint, onProgress } = options
  const batchRows = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_ROWS))
  const maxBatchBytes = Math.max(1, Math.floor(options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES))
  const resume = latestCheckpoints(options.checkpoints)
  const result: CopyResult = { completed: false, rowsCopied: 0, bytesCopied: 0, batches: 0, maxBatchBytesSeen: 0 }

  for (const store of RAW_STORE_NAMES) {
    if (signal?.aborted) {
      return result
    }
    const saved = resume.get(store)
    if (saved?.done) {
      continue
    }
    let committed: string | undefined = saved?.lastKey
    let storeRowsCopied = 0
    let storeTotalRows = 0
    try {
      storeTotalRows = await source.count(store)
    } catch (cause) {
      throw new CopyError({ store, lastKey: committed, phase: 'read', cause })
    }

    let after = committed
    let pageLimit = pageLimitFor(store, batchRows)
    let batch: RawRow[] = []
    let batchBytes = 0

    const flush = async (): Promise<void> => {
      if (batch.length === 0) {
        return
      }
      const rows = batch
      const bytes = batchBytes
      batch = []
      batchBytes = 0
      const firstKey = (rows[0] as RawRow).key
      const lastKey = (rows[rows.length - 1] as RawRow).key
      try {
        await sink.writeBatch(store, rows)
      } catch (cause) {
        throw new CopyError({ store, lastKey: committed, phase: 'write', batchFirstKey: firstKey, cause })
      }
      try {
        await onCheckpoint?.({ store, lastKey, done: false })
      } catch (cause) {
        throw new CopyError({ store, lastKey: committed, phase: 'checkpoint', batchFirstKey: firstKey, cause })
      }
      committed = lastKey
      storeRowsCopied += rows.length
      result.rowsCopied += rows.length
      result.bytesCopied += bytes
      result.batches += 1
      result.maxBatchBytesSeen = Math.max(result.maxBatchBytesSeen, bytes)
      onProgress?.({
        store,
        storeRowsCopied,
        storeTotalRows,
        rowsCopied: result.rowsCopied,
        bytesCopied: result.bytesCopied,
      })
    }

    for (;;) {
      if (signal?.aborted) {
        return result
      }
      let page
      try {
        page = await source.readBatch(store, after, pageLimit)
      } catch (cause) {
        throw new CopyError({ store, lastKey: committed, phase: 'read', cause })
      }
      if (page.rows.length > 0) {
        let pageBytes = 0
        for (const row of page.rows) {
          const size = estimateRowBytes(row)
          pageBytes += size
          // 加上这一行会超字节上限 → 先把已攒的写掉；超大的单行自成一批
          if (batch.length > 0 && batchBytes + size > maxBatchBytes) {
            await flush()
            if (signal?.aborted) {
              return result
            }
          }
          batch.push(row)
          batchBytes += size
          if (batch.length >= batchRows || batchBytes >= maxBatchBytes) {
            await flush()
            if (signal?.aborted) {
              return result
            }
          }
        }
        // 下一页大小：让一页大约装得下一批；平均行体积大就读少点
        const average = Math.max(1, pageBytes / page.rows.length)
        pageLimit = pageLimitFor(store, Math.max(1, Math.min(batchRows, Math.floor(maxBatchBytes / average))))
      }
      if (page.next === undefined || page.rows.length === 0) {
        break
      }
      if (page.next === after) {
        throw new CopyError({
          store,
          lastKey: committed,
          phase: 'read',
          cause: new Error(`readBatch did not advance past ${JSON.stringify(after)}`),
        })
      }
      after = page.next
    }
    await flush()
    try {
      await onCheckpoint?.({ store, lastKey: committed, done: true })
    } catch (cause) {
      throw new CopyError({ store, lastKey: committed, phase: 'checkpoint', cause })
    }
  }
  result.completed = true
  return result
}

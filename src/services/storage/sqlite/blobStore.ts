/**
 * 二进制原件的分块存储（ADR-0910）。**全仓只有本文件允许读写 `blob_meta` / `blob_chunks`。**
 *
 * 存法：一个原件 = `blob_meta` 一行（总长、块数、整体 sha256、MIME、`storage`/`file_path` 预留列）
 * + `blob_chunks` 若干行（每块 ≤ `BLOB_CHUNK_BYTES`，带自己的长度）。`owner` 是所属 store 名
 * （`files` / `filesStaging` / `appAssets`），原件的主键与所属行的主键相同。
 *
 * 读回必校验：块序号连续、每块长度与声明一致、总长一致、整体 sha256 一致；任一不符抛
 * `StorageUnavailableError`（`SqliteStorageError`），**不返回残缺字节**。
 * 写入不整块进内存：按块 `Blob.slice().arrayBuffer()`，边写边算 sha256。
 *
 * 将来原件落文件系统时，只需把本文件换成「文件 + 元数据」实现（`storage` 列区分），上层不变。
 */
import type { SqlRow, SqlTx } from './driver.js'
import { encodeKey } from './mapping.js'
import { isResultTooLarge, integrityError } from './repos/errors.js'
import { readColumnBytes } from './paged.js'
import { Sha256Stream } from './repos/sha256Stream.js'
import { BLOB_CHUNK_BYTES, BLOB_STORAGE_SQLITE_CHUNKS, type BlobOwner } from './schema.js'

export type BlobExec = Pick<SqlTx, 'run' | 'all' | 'allPaged'>

/** 一次读多少块：4 × 512 KiB = 2 MiB，不超过 Android `CursorWindow` 的窗口量级。 */
const READ_BATCH_CHUNKS = 4

/** 单条语句最多绑定多少个 id（旧版 SQLite 默认变量上限 999，留出 owner 等参数的余量）。 */
const ID_BATCH = 500

export type StoredBlobBytes = { parts: Uint8Array[]; mime: string; total: number }

const hex = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN)

/** 写入（覆盖）一个原件。必须在调用方的事务里跑：先清旧块，再写新块，最后写元数据。 */
export const writeBlob = async (exec: BlobExec, owner: BlobOwner, id: string, blob: Blob): Promise<void> => {
  await exec.run('DELETE FROM blob_chunks WHERE owner = ? AND id = ?', [owner, encodeKey(id)])
  await exec.run('DELETE FROM blob_meta WHERE owner = ? AND id = ?', [owner, encodeKey(id)])
  const hash = new Sha256Stream()
  let seq = 0
  for (let offset = 0; offset < blob.size; offset += BLOB_CHUNK_BYTES) {
    const chunk = new Uint8Array(await blob.slice(offset, offset + BLOB_CHUNK_BYTES).arrayBuffer())
    hash.update(chunk)
    await exec.run('INSERT INTO blob_chunks (owner, id, seq, len, data) VALUES (?, ?, ?, ?, ?)', [
      owner,
      encodeKey(id),
      seq,
      chunk.length,
      chunk,
    ])
    seq += 1
  }
  await exec.run(
    'INSERT INTO blob_meta (owner, id, total, chunks, sha256, mime, storage, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    [owner, encodeKey(id), blob.size, seq, hash.digestHex(), blob.type, BLOB_STORAGE_SQLITE_CHUNKS],
  )
}

/**
 * 退路（#940）：`SELECT … data` 一页就撞原生上限时，逐块读。
 * 先只取 `seq`/`len`（极小），再按列分块取 `data`，长度对账交给 `readColumnBytes`。
 */
const readChunkRowByRow = async (
  exec: BlobExec,
  owner: BlobOwner,
  id: string,
  fromSeq: number,
): Promise<SqlRow[]> => {
  const heads = await exec.all(
    'SELECT seq, len FROM blob_chunks WHERE owner = ? AND id = ? AND seq >= ? ORDER BY seq LIMIT ?',
    [owner, encodeKey(id), fromSeq, READ_BATCH_CHUNKS],
  )
  const out: SqlRow[] = []
  for (const head of heads) {
    const seq = num(head.seq)
    const read = await readColumnBytes(
      exec,
      { table: 'blob_chunks', column: 'data', where: 'owner = ? AND id = ? AND seq = ?', params: [owner, encodeKey(id), seq] },
      { chunkBytes: BLOB_CHUNK_BYTES },
    )
    out.push({ seq: head.seq ?? null, len: head.len ?? null, data: read.found ? read.value : null })
  }
  return out
}

/** 读一个原件的字节（分块，已校验）。不存在返回 `undefined`。 */
export const readBlobBytes = async (exec: BlobExec, owner: BlobOwner, id: string): Promise<StoredBlobBytes | undefined> => {
  const metaRows = await exec.all(
    'SELECT total, chunks, sha256, mime, storage FROM blob_meta WHERE owner = ? AND id = ?',
    [owner, encodeKey(id)],
  )
  const meta = metaRows[0]
  if (meta === undefined) {
    return undefined
  }
  if (meta.storage !== BLOB_STORAGE_SQLITE_CHUNKS) {
    throw integrityError(`${owner}/${id} 的存放位置 ${String(meta.storage)} 本构建不支持`)
  }
  const total = num(meta.total)
  const chunks = num(meta.chunks)
  const parts: Uint8Array[] = []
  const hash = new Sha256Stream()
  let bytes = 0
  let expectedSeq = 0
  while (expectedSeq < chunks) {
    let rows: Record<string, unknown>[]
    try {
      rows = await exec.all(
        'SELECT seq, len, data FROM blob_chunks WHERE owner = ? AND id = ? AND seq >= ? ORDER BY seq LIMIT ?',
        [owner, encodeKey(id), expectedSeq, READ_BATCH_CHUNKS],
      )
    } catch (error) {
      // #940：旧库（或更粗的分块）里单块本身就可能越过原生 4 MiB 上限 → 这一块按列分块读，别整条链失败
      if (!isResultTooLarge(error)) {
        throw error
      }
      rows = await readChunkRowByRow(exec, owner, id, expectedSeq)
    }
    if (rows.length === 0) {
      throw integrityError(`${owner}/${id} 缺块：期望 ${chunks} 块，读到 ${expectedSeq} 块`)
    }
    for (const row of rows) {
      const data = row.data
      if (num(row.seq) !== expectedSeq || !(data instanceof Uint8Array) || data.length !== num(row.len)) {
        throw integrityError(`${owner}/${id} 第 ${expectedSeq} 块序号或长度不符`)
      }
      if (data.length > BLOB_CHUNK_BYTES) {
        throw integrityError(`${owner}/${id} 第 ${expectedSeq} 块超过 ${BLOB_CHUNK_BYTES} 字节`)
      }
      hash.update(data)
      parts.push(data)
      bytes += data.length
      expectedSeq += 1
      if (expectedSeq > chunks) {
        throw integrityError(`${owner}/${id} 块数多于声明的 ${chunks}`)
      }
    }
  }
  if (bytes !== total) {
    throw integrityError(`${owner}/${id} 总长不符：声明 ${total}，实际 ${bytes}`)
  }
  if (hash.digestHex() !== hex(meta.sha256)) {
    throw integrityError(`${owner}/${id} sha256 不符`)
  }
  return { parts, mime: hex(meta.mime), total }
}

export const readBlob = async (exec: BlobExec, owner: BlobOwner, id: string): Promise<Blob | undefined> => {
  const stored = await readBlobBytes(exec, owner, id)
  return stored === undefined ? undefined : new Blob(stored.parts as unknown as BlobPart[], { type: stored.mime })
}

export const hasBlob = async (exec: BlobExec, owner: BlobOwner, id: string): Promise<boolean> =>
  (await exec.all('SELECT 1 AS one FROM blob_meta WHERE owner = ? AND id = ?', [owner, encodeKey(id)])).length > 0

export const deleteBlob = async (exec: BlobExec, owner: BlobOwner, id: string): Promise<void> => {
  await exec.run('DELETE FROM blob_chunks WHERE owner = ? AND id = ?', [owner, encodeKey(id)])
  await exec.run('DELETE FROM blob_meta WHERE owner = ? AND id = ?', [owner, encodeKey(id)])
}

export const deleteBlobs = async (exec: BlobExec, owner: BlobOwner, ids: readonly string[]): Promise<void> => {
  for (let start = 0; start < ids.length; start += ID_BATCH) {
    const batch = ids.slice(start, start + ID_BATCH)
    const marks = batch.map(() => '?').join(', ')
    await exec.run(`DELETE FROM blob_chunks WHERE owner = ? AND id IN (${marks})`, [owner, ...batch.map(encodeKey)])
    await exec.run(`DELETE FROM blob_meta WHERE owner = ? AND id IN (${marks})`, [owner, ...batch.map(encodeKey)])
  }
}

export const clearBlobs = async (exec: BlobExec, owner: BlobOwner): Promise<void> => {
  await exec.run('DELETE FROM blob_chunks WHERE owner = ?', [owner])
  await exec.run('DELETE FROM blob_meta WHERE owner = ?', [owner])
}

/** 把 `from` 里的一个原件复制成 `to` 里的同 id 原件（覆盖）。集合式 SQL，字节不进 JS。返回是否复制了。 */
export const copyBlob = async (exec: BlobExec, from: BlobOwner, to: BlobOwner, id: string): Promise<boolean> => {
  await exec.run('DELETE FROM blob_chunks WHERE owner = ? AND id = ?', [to, encodeKey(id)])
  await exec.run('DELETE FROM blob_meta WHERE owner = ? AND id = ?', [to, encodeKey(id)])
  await exec.run(
    'INSERT INTO blob_chunks (owner, id, seq, len, data) SELECT ?, id, seq, len, data FROM blob_chunks WHERE owner = ? AND id = ?',
    [to, from, encodeKey(id)],
  )
  const copied = await exec.run(
    'INSERT INTO blob_meta (owner, id, total, chunks, sha256, mime, storage, file_path) SELECT ?, id, total, chunks, sha256, mime, storage, file_path FROM blob_meta WHERE owner = ? AND id = ?',
    [to, from, encodeKey(id)],
  )
  return copied.changes > 0
}

/** 全部原件的字节数（元数据里的总长之和），用于体积估算。 */
export const blobTotalBytes = async (exec: BlobExec): Promise<number> => {
  const rows = await exec.all('SELECT COALESCE(SUM(total), 0) AS bytes FROM blob_meta')
  return num(rows[0]?.bytes) || 0
}

/** 某个 owner 下的原件个数（诊断 / 校验用）。 */
export const countBlobs = async (exec: BlobExec, owner: BlobOwner): Promise<number> => {
  const rows = await exec.all('SELECT COUNT(*) AS c FROM blob_meta WHERE owner = ?', [owner])
  return num(rows[0]?.c) || 0
}

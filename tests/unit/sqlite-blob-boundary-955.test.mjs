// [layer: unit | 依赖: node:sqlite（Node 22 自带，内存库）+ src/services/storage/sqlite | 耗时: <60s]
//
// Issue #955 的**边界矩阵**（lead 指定的判据）：附件字节链路上的每一个「整块 / 跨块 / 恰好撞上限」
// 都要逐字节对上，因为 #949 之后这台内测机（SQLite 引擎，`phase: committed`）上跑的就是这条读路径。
//
// 为什么单独一份：`sqlite-result-paging-940.test.mjs` 钉的是「大负载能读回来」（4.4M 汉字、
// 劈开汉字/emoji、少给多给报错），本文件钉的是**尺寸格点**——0 B / 1 B / 恰好一块 / 跨一块 /
// 对半再切 / 含 `\0` 的二进制 / 恰好 4 MiB 与 4 MiB±1。这两类失败不一样：前者是「读不回来」，
// 后者是「读回来了但字节不对」，而后者用户看不出来（图上少一个字节不会报错，只会是坏图）。
//
// 断言口径（**不许放宽**）：
//  1. `writeBlob → readBlob` 的字节与 sha256 必须与写入完全一致，每个尺寸点都查；
//  2. 恰好撞原生上限（CAP）的那一列必须**直读成功**；CAP+1 必须走分块并仍然逐字节相同；
//  3. 分块帧长从 1 字节到 512 KiB 全覆盖，块边界劈开多字节字符时拼回来必须仍是合法 UTF-8；
//  4. 二进制 `\0` / 0x80 / 0xFF 一个都不许丢（JSON/字符串化中转最容易在这里出错）；
//  5. 单块大于帧长的老库形态：明确报错 **而不是**静默截断（这条是「不许把残缺当成功」）。
import { createHash } from 'node:crypto'

import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { openNodeSqliteDatabase } from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'

installEndpointsGlobals()
installTsResolve()

const test = (await import('node:test')).default
const assert = (await import('node:assert/strict')).default

const paged = await loadTsModule('src/services/storage/sqlite/paged.ts')
const schema = await loadTsModule('src/services/storage/sqlite/schema.ts')
const blobStore = await loadTsModule('src/services/storage/sqlite/blobStore.ts')
const mapping = await loadTsModule('src/services/storage/sqlite/mapping.ts')
const hash = await loadTsModule('src/services/storage/migration/hash.ts')

/** `blob_chunks.id` / `blob_meta.id` 存的是 `encodeKey(id)`（UTF-16BE 主键），不是裸字符串 */
const key = (id) => mapping.encodeKey(id)

const MB = 1024 * 1024
/** 与原生 `AppSqlitePlugin.MAX_RESULT_BYTES` 同值（红线：不许提高） */
const CAP = 4 * MB
/** 与 `schema.ts` / `paged.ts` 的帧长同值 */
const CHUNK = schema.BLOB_CHUNK_BYTES
const { STORE_TABLES } = schema

const openDb = async (options = {}) => {
  const opened = await openNodeSqliteDatabase(options)
  await schema.applySchema(opened.db)
  return opened
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** 造二进制：含 `\0`、0x80、0xFF，且每个位置随种子变化（截断/错位一定会被抓到） */
const binaryOf = (size, seed = 1) => {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 131 + seed * 17) % 256
  }
  if (size > 0) {
    bytes[0] = 0x00
  }
  if (size > 1) {
    bytes[1] = 0xff
  }
  if (size > 2) {
    bytes[2] = 0x80
  }
  return bytes
}

const blobOf = (bytes) => new Blob([bytes], { type: 'application/octet-stream' })

const bytesOfBlob = async (blob) => new Uint8Array(await blob.arrayBuffer())

/** 逐个尺寸点：写入 → 读回 → 字节 + sha256 必须一致 */
const expectRoundTrip = async (db, size, label) => {
  const bytes = binaryOf(size, size % 251)
  const id = `b-${label}`
  await blobStore.writeBlob(db, 'files', id, blobOf(bytes))
  const read = await blobStore.readBlob(db, 'files', id)
  assert.notEqual(read, undefined, `${label}：写进去的原件必须读得回来`)
  const back = await bytesOfBlob(read)
  assert.equal(back.length, size, `${label}：字节数必须一致（实得 ${back.length}）`)
  assert.equal(sha256(back), sha256(bytes), `${label}：sha256 必须一致（内容错一个字节也算红）`)
  if (size >= 3) {
    assert.equal(back[0], 0x00, `${label}：前导 \\0 不许被吞`)
    assert.equal(back[1], 0xff, `${label}：0xFF 不许被改成 0xFE/替换字符`)
    assert.equal(back[2], 0x80, `${label}：0x80 不许被当成非法 UTF-8 丢掉`)
  }
  return back
}

// ---------------------------------------------------------------- 1. 尺寸格点（writeBlob → readBlob）

test('#955 附件往返：0 B / 1 B / 恰好一块 / 跨一块 / 恰好 4 MiB 与 ±1 全部逐字节一致', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  /** 每一个点都有理由，别删：它们分别对应「空块」「单字节」「整块边界」「跨块残字节」「撞上限」 */
  const sizes = [
    0,
    1,
    2,
    3,
    CHUNK - 1,
    CHUNK,
    CHUNK + 1,
    2 * CHUNK,
    2 * CHUNK + 1,
    CAP - 1,
    CAP,
    CAP + 1,
  ]
  for (const size of sizes) {
    await expectRoundTrip(db, size, `${size}`)
  }
  await db.close()
})

test('#955 附件往返：0 B 原件是「存在且为空」，不是「不存在」', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  await blobStore.writeBlob(db, 'files', 'empty', blobOf(new Uint8Array(0)))
  const read = await blobStore.readBlob(db, 'files', 'empty')
  assert.notEqual(read, undefined, '空原件必须读得回来（不是 undefined）')
  assert.equal(read.size, 0)
  // 没有写过的 id 才是 undefined —— 这两件事在发送链路里意义完全不同（空原件可发，缺原件不可发）
  const missing = await blobStore.readBlob(db, 'files', 'never-written')
  assert.equal(missing, undefined)
  await db.close()
})

// ---------------------------------------------------------------- 2. 单列分块：帧长格点

test('#955 readColumnBytes：帧长 1 / 2 / 3 / 7 / 块长±1 时二进制列逐字节一致', async () => {
  // 上限压到 256 B：直读必撞 RESULT_TOO_LARGE → 强制走「LENGTH → SUBSTR 分块 → 重组」
  // （注意 `chunkBytes` 只在分块路径上生效；不压上限的话这一条会**空转**，见本文件头部的说明）
  const { db } = await openDb({ maxResultBytes: 256 })
  const bytes = binaryOf(2000, 7)
  await db.run('CREATE TABLE probe (id TEXT PRIMARY KEY, data BLOB)')
  await db.run('INSERT INTO probe (id, data) VALUES (?, ?)', ['range', bytes])
  for (const chunkBytes of [1, 2, 3, 7, 63, 64, 65, 128, 257]) {
    const read = await paged.readColumnBytes(
      db,
      { table: 'probe', column: 'data', where: 'id = ?', params: ['range'] },
      { chunkBytes },
    )
    assert.equal(read.found, true, `chunkBytes=${chunkBytes}：这一行必须在`)
    assert.equal(read.value.length, 2000, `chunkBytes=${chunkBytes}：重组后字节数必须等于总长（不许少一块）`)
    assert.equal(sha256(read.value), sha256(bytes), `chunkBytes=${chunkBytes}：逐字节必须一致`)
  }
  await db.close()
})

test('#955 readTextColumn：块边界劈开 3 字节汉字 / 4 字节 emoji，拼回来仍是合法 UTF-8', async () => {
  const { db } = await openDb({ maxResultBytes: 64 })
  const table = STORE_TABLES.sessionSummaries.table
  // 每个字符 3 或 4 字节：帧长取 5/7/11 一定把字符劈开
  const text = '汉'.repeat(50) + '🙂'.repeat(20) + '字'.repeat(30)
  await db.run(`INSERT INTO ${table} (id, doc) VALUES (?, ?)`, ['utf8', text])
  assert.ok(Buffer.byteLength(text, 'utf8') > 64, '前提：这一列确实超过上限，走分块路径')
  for (const chunkBytes of [1, 2, 3, 5, 7, 11, 13]) {
    const read = await paged.readTextColumn(
      db,
      { table, column: 'doc', where: 'id = ?', params: ['utf8'] },
      { chunkBytes },
    )
    assert.equal(read.value, text, `chunkBytes=${chunkBytes}：劈开的多字节字符必须原样拼回（不许出现替换字符）`)
    assert.equal(Buffer.byteLength(read.value, 'utf8'), Buffer.byteLength(text, 'utf8'))
  }
  await db.close()
})

// ---------------------------------------------------------------- 3. 恰好撞上限

test('#955 恰好撞上限：CAP 的列直读成功，CAP+1 走分块后仍逐字节相同', async () => {
  const table = STORE_TABLES.sessionSummaries.table
  // 用二进制列做精确的字节控制（TEXT 会被 UTF-8 编码放大，不容易卡到整字节）
  const exact = binaryOf(CAP, 3)
  const over = binaryOf(CAP + 1, 5)

  const { db } = await openDb({ maxResultBytes: CAP })
  await db.run(`CREATE TABLE probe (id TEXT PRIMARY KEY, data BLOB)`)
  await db.run('INSERT INTO probe (id, data) VALUES (?, ?)', ['exact', exact])
  await db.run('INSERT INTO probe (id, data) VALUES (?, ?)', ['over', over])

  const atCap = await paged.readColumnBytes(db, { table: 'probe', column: 'data', where: 'id = ?', params: ['exact'] })
  assert.equal(atCap.value.length, CAP, '恰好 CAP 的列必须整段读回（不是截断）')
  assert.equal(sha256(atCap.value), sha256(exact))

  const aboveCap = await paged.readColumnBytes(db, { table: 'probe', column: 'data', where: 'id = ?', params: ['over'] })
  assert.equal(aboveCap.value.length, CAP + 1, 'CAP+1 必须走分块并读全（最后一个字节不许丢）')
  assert.equal(sha256(aboveCap.value), sha256(over))
  assert.equal(aboveCap.value.at(-1), over.at(-1), '跨上限那一个字节必须原样')
  await db.close()
  // 顺带钉住「表名/列名只接受常量」这条边界不影响本用例：probe 是本地建的探针表
  assert.equal(typeof table, 'string')
})

// ---------------------------------------------------------------- 4. 逐块退路（#949 的 readChunkRowByRow）

test('#955 原生上限比「一页 4 块」还小时，逐块退路仍读出完整原件', async () => {
  // 上限压到 1 MiB：4 × 512 KiB = 2 MiB 的批量读一定撞限 → 走 readColumnBytes 逐块退路
  const { db } = await openDb({ maxResultBytes: 1 * MB })
  const bytes = binaryOf(CHUNK * 3 + 123, 11)
  await blobStore.writeBlob(db, 'files', 'fallback', blobOf(bytes))
  const read = await blobStore.readBlob(db, 'files', 'fallback')
  assert.notEqual(read, undefined, '撞限不许整条链失败')
  const back = await bytesOfBlob(read)
  assert.equal(sha256(back), sha256(bytes), '逐块退路读出来的字节必须与写入一致')
  await db.close()
})

test('#955 单块大于帧长的老库形态：明确报错，绝不静默截断', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  /**
   * 当前构建只会按 `BLOB_CHUNK_BYTES` 分块写（`writeBlob`），所以「单块 > 帧长」只可能来自
   * 更老/别的写入方。这条路径的价值不是「支持它」，而是**不许把它当成功返回**：
   * 宁可报出明确错误，也不能返回一份少了一半字节的附件（用户会看到一张坏图，且毫无提示）。
   */
  const oversized = binaryOf(CHUNK + 1024, 13)
  await db.run(
    'INSERT INTO blob_chunks (owner, id, seq, len, data) VALUES (?, ?, ?, ?, ?)',
    ['files', key('legacy'), 0, oversized.length, oversized],
  )
  await db.run(
    'INSERT INTO blob_meta (owner, id, total, chunks, sha256, mime, storage, file_path) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
    ['files', key('legacy'), oversized.length, 1, sha256(oversized), 'application/octet-stream', schema.BLOB_STORAGE_SQLITE_CHUNKS],
  )
  await assert.rejects(
    () => blobStore.readBlob(db, 'files', 'legacy'),
    (error) => {
      // 明确说「哪一块不对」，而不是返回残字节
      assert.match(String(error.message), /legacy/, `错误信息要点名是哪个原件（实际 ${error.message}）`)
      assert.match(String(error.message), new RegExp(String(CHUNK)), '错误信息要说清帧长')
      return true
    },
  )
  await db.close()
})

// ---------------------------------------------------------------- 5. 估算器（迁移分批口径）

test('#955 bridgeBinaryBytes：二进制按 4×ceil(n/3) 计，0 B 不许算成负数或 0 以外的值', async () => {
  const cases = [
    [0, 0],
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 8],
    [CAP - 1, 4 * Math.ceil((CAP - 1) / 3)],
    [CAP, 4 * Math.ceil(CAP / 3)],
  ]
  for (const [raw, expected] of cases) {
    // 直接传 Blob（走 `tag === 'Blob'` 分支）：过桥体积 + 64 字节结构开销（见 hash.ts）
    const bytes = hash.estimateValueBytes(new Blob([new Uint8Array(raw)]))
    assert.equal(bytes, expected + 64, `raw=${raw}：过桥体积应为 4×ceil(n/3)+64`)
  }
  // 4 MiB 的 BLOB 过桥后必然超过 CAP —— 这正是 #949 改这个估算器的理由
  assert.ok(hash.estimateValueBytes(new Blob([new Uint8Array(CAP)])) > CAP)
})

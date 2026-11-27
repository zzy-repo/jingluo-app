// [layer: unit | 依赖: node:sqlite（Node 22 自带，内存库）+ src/services/storage/sqlite | 耗时: <60s]
//
// Issue #940 的核心回归：#940 的故障形态是「单次查询结果 > 4 MiB → 整条链报错」。
// 本文件守三件事，全部对着**真 SQLite** 跑（不是 mock）：
//
//  1. `queryAll()` 永远**取完**：即使驱动按字节预算提前收口，行数也一行不少；
//     而「说没读完却给空页 / 偏移不前进 / 行数对不上」一律抛 `RESULT_INCOMPLETE`，
//     绝不把「这一块」当「全部」（这是 #940 里最危险的那种失败：静默少数据）。
//  2. 单行/单列自己就超上限时，`readTextColumn` / `readBlobColumn` 按字节分块读回，
//     且**逐字节对账**：少一字节、多一字节都报错，不返回残缺内容。
//  3. 仓储与迁移读路径（`getRow` / `pageRows` / `selectRows` / `readBatch` / `readBlobBytes`）
//     在带 4 MiB 上限的驱动上仍然读出**完整内容** —— 这是 #940 的用户可见结果。
//
// 上限用测试驱动自己的 `maxResultBytes`（与原生 `queryOn` 同一套累加口径，见 helper 注释）模拟：
// 它会把超过上限的 `all()` 直接拒绝为 `code: 'RESULT_TOO_LARGE'`，和真机一模一样。
import { createHash } from 'node:crypto'

import { installEndpointsGlobals, installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { openNodeSqliteDatabase } from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'

installEndpointsGlobals()
installTsResolve()

const test = (await import('node:test')).default
const assert = (await import('node:assert/strict')).default

const paged = await loadTsModule('src/services/storage/sqlite/paged.ts')
const schema = await loadTsModule('src/services/storage/sqlite/schema.ts')
const rowsMod = await loadTsModule('src/services/storage/sqlite/repos/rows.ts')
const blobStore = await loadTsModule('src/services/storage/sqlite/blobStore.ts')
const rawMod = await loadTsModule('src/services/storage/sqlite/raw.ts')
const hash = await loadTsModule('src/services/storage/migration/hash.ts')

const MB = 1024 * 1024
const CAP = 4 * MB
const { STORE_TABLES } = schema

/** 中文正文：UTF-16 码元数 = 字数，UTF-8 是 3 字节/字 —— 正好用来验证「原生口径 ≠ UTF-8 字节数」。 */
const CJK = '次'.repeat(1)

const bytesOf = (text) => Buffer.byteLength(text, 'utf8')

/** 真实过桥体积：JSON 里的二进制是 `{"$b64": "…"}`（base64），不是原始字节。 */
const wireBytesOf = (value) => {
  const seen = new Set()
  const json = JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return { $b64: Buffer.from(item).toString('base64') }
    if (item instanceof Uint8Array || ArrayBuffer.isView(item)) {
      return { $b64: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString('base64') }
    }
    if (item instanceof ArrayBuffer) return { $b64: Buffer.from(item).toString('base64') }
    if (item !== null && typeof item === 'object') {
      // 环引用
      if (seen.has(item)) return undefined
      seen.add(item)
    }
    return item
  })
  return Buffer.byteLength(json, 'utf8')
}

const openDb = async (options = {}) => {
  const opened = await openNodeSqliteDatabase(options)
  await schema.applySchema(opened.db)
  return opened
}

// ---------------------------------------------------------------- 1. queryAll 取完

test('#940 queryAll：驱动按字节预算提前收口时仍取全量（一行不少）', async () => {
  const { db } = await openDb({ maxResultBytes: 32 * 1024 })
  const table = STORE_TABLES.sessions.table
  for (let index = 0; index < 200; index += 1) {
    const key = `s-${String(index).padStart(4, '0')}`
    await db.run(`INSERT INTO ${table} (id, doc) VALUES (?, ?)`, [key, 'x'.repeat(600)])
  }
  // 一行 ≈ 600 + 列名 ≈ 620 字节 → 32 KiB 上限下一页只能给约 50 行，必然多次收口
  const all = await paged.queryAll(db, `SELECT id AS k, doc FROM ${table} ORDER BY id`, [], { pageRows: 256 })
  assert.equal(all.length, 200, '必须一行不少')
  assert.deepEqual(
    all.map((row) => row.k),
    Array.from({ length: 200 }, (_v, index) => `s-${String(index).padStart(4, '0')}`),
    '顺序与全表扫一致',
  )
  // 对照：不分页的旧路径在这种上限下就是 #940 的原故障
  await assert.rejects(
    () => db.all(`SELECT id AS k, doc FROM ${table} ORDER BY id`),
    (error) => {
      assert.equal(error.code, 'RESULT_TOO_LARGE', '旧路径必须报稳定码')
      return true
    },
  )
  await db.close()
})

test('#940 queryAll：expectedRows 对不上 → RESULT_INCOMPLETE（不静默少给）', async () => {
  const { db } = await openDb()
  const table = STORE_TABLES.sessions.table
  await db.run(`INSERT INTO ${table} (id, doc) VALUES (?, ?)`, ['a', '{}'])
  await assert.rejects(
    () => paged.queryAll(db, `SELECT id AS k FROM ${table}`, [], { expectedRows: 2 }),
    (error) => {
      assert.equal(error.code, 'RESULT_INCOMPLETE')
      return true
    },
  )
  await db.close()
})

test('#940 queryAll：驱动说没读完却给空页 / 偏移不前进 → RESULT_INCOMPLETE（不死循环、不误判完成）', async () => {
  const empty = { allPaged: async () => ({ rows: [], done: false, nextOffset: 0 }) }
  await assert.rejects(
    () => paged.queryAll(empty, 'SELECT 1 AS k'),
    (error) => {
      assert.equal(error.code, 'RESULT_INCOMPLETE')
      return true
    },
  )
  const stuck = { allPaged: async () => ({ rows: [{ k: 1 }], done: false, nextOffset: 0 }) }
  await assert.rejects(
    () => paged.queryAll(stuck, 'SELECT 1 AS k'),
    (error) => {
      assert.equal(error.code, 'RESULT_INCOMPLETE')
      return true
    },
  )
  // 正常前进时必须能取完（防止上面的护栏把正常情况也判错）
  let page = 0
  const twoPages = {
    allPaged: async (_sql, _params, query) => {
      page += 1
      if (query.offset === 0) return { rows: [{ k: 1 }], done: false, nextOffset: 1 }
      return { rows: [{ k: 2 }], done: true, nextOffset: 2 }
    },
  }
  assert.deepEqual(await paged.queryAll(twoPages, 'SELECT 1 AS k'), [{ k: 1 }, { k: 2 }])
  assert.equal(page, 2)
})

// ---------------------------------------------------------------- 2. 单列分块

test('#940 readTextColumn：4.4M 汉字（13.2MB UTF-8）分块读回，逐字节相同', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  const table = STORE_TABLES.sessionSummaries.table
  const text = '汉'.repeat(4_400_000)
  const bytes = bytesOf(text)
  assert.ok(bytes > CAP, '前提：这一列的字节数确实超过原生上限')
  await db.run(`INSERT INTO ${table} (id, doc) VALUES (?, ?)`, ['big', text])

  const read = await paged.readTextColumn(db, {
    table,
    column: 'doc',
    where: 'id = ?',
    params: ['big'],
  })
  assert.equal(read.found, true)
  assert.equal(read.value.length, text.length)
  assert.equal(bytesOf(read.value), bytes, '字节数必须与原文一致')
  assert.ok(read.value === text, '内容必须逐字符相同')
  await db.close()
})

// ⚠️ 这条用例 2026-11-27 被查出**是空转的**，已重写（原版见 git 历史）：
// 原版文本只有 ~14 KB、远小于 4 MiB 上限 → `readColumnBytes` 第一步「一次直读」就成功了，
// `chunkBytes` 从头到尾**一次都没被用过**，「块边界劈开多字节字符」这条路径从未执行。
// 门禁是绿的，但它保护的东西没被验证过 —— 与 #946 那 12 条 doc-refs 同型（门禁存在 ≠ 规则生效）。
// 现在把驱动上限压到 64 B **强制**走分块，并用调用次数把「真的分块了」钉住：
//   · 直读必须发生且撞上限（否则又退化成假验证）；
//   · `SUBSTR` 调用次数必须等于 ceil(总长/块长) 且 > 1（按字节切，不是一次拿全）。
test('#940 readTextColumn：块边界劈开汉字 / emoji 也不出错（按字节切）', async () => {
  const SMALL_CAP = 64
  const { db } = await openDb({ maxResultBytes: SMALL_CAP })
  const table = STORE_TABLES.sessionSummaries.table
  // 3 字节汉字 + 4 字节 emoji 混排：任何 >1 的块长都会在某个字符中间断开
  const text = `开🙂${'汉字混排'.repeat(20)}尾😀`
  const total = bytesOf(text)
  assert.ok(total > SMALL_CAP, '前提：这一列的字节数确实超过驱动上限（否则不会走分块）')
  await db.run(`INSERT INTO ${table} (id, doc) VALUES (?, ?)`, ['mix', text])

  for (const chunkBytes of [1, 2, 3, 4, 5, 7, 13]) {
    const stats = { direct: 0, substr: 0 }
    /** 只替换 `all`，其余走真驱动：`readColumnBytes` 的入参就是 `Pick<SqlTx,'all'>`。 */
    const exec = {
      all: async (sql, params) => {
        if (sql.includes('SUBSTR')) stats.substr += 1
        else if (sql.includes(' AS v')) stats.direct += 1
        return db.all(sql, params)
      },
    }
    const spec = { table, column: 'doc', where: 'id = ?', params: ['mix'] }
    const read = await paged.readTextColumn(exec, spec, { chunkBytes })
    assert.equal(read.value, text, `chunkBytes=${chunkBytes} 时内容必须一致`)
    assert.equal(bytesOf(read.value), total, `chunkBytes=${chunkBytes} 时字节数必须一致`)
    assert.equal(stats.direct, 1, `chunkBytes=${chunkBytes}：必须先尝试一次直读（并撞上限），否则这条用例又成了空转`)
    assert.equal(
      stats.substr,
      Math.ceil(total / chunkBytes),
      `chunkBytes=${chunkBytes}：SUBSTR 段数应等于 ceil(${total}/${chunkBytes})`,
    )
    assert.ok(stats.substr > 1, `chunkBytes=${chunkBytes}：必须真的切成多段才叫验过分块路径`)
  }

  // 字节级同一性：分块读回的 BLOB 与原文 UTF-8 的 sha256 必须相等（重组没有错位/丢字节）
  const EXPECTED = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
  const blob = await paged.readBlobColumn(
    db,
    { table, column: 'doc', where: 'id = ?', params: ['mix'] },
    { chunkBytes: 1 },
  )
  assert.equal(createHash('sha256').update(blob.value).digest('hex'), EXPECTED, '分块重组的 sha256 必须与原文相同')
  await db.close()
})

test('#940 readTextColumn：found / NULL 必须分开（行不存在 ≠ 该列是 NULL）', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  // 正式表的 doc 都是 NOT NULL，这里用一个允许 NULL 的探针表
  await db.run('CREATE TABLE probe (id TEXT PRIMARY KEY, doc TEXT)')
  const missing = await paged.readTextColumn(db, { table: 'probe', column: 'doc', where: 'id = ?', params: ['nope'] })
  assert.deepEqual(missing, { found: false, value: null })
  await db.run('INSERT INTO probe (id, doc) VALUES (?, ?)', ['null', null])
  const nullDoc = await paged.readTextColumn(db, { table: 'probe', column: 'doc', where: 'id = ?', params: ['null'] })
  assert.deepEqual(nullDoc, { found: true, value: null })
  await db.close()
})

test('#940 readTextColumn：分块少给 / 多给字节都必须报错（绝不返回残缺内容）', async () => {
  const table = STORE_TABLES.sessionSummaries.table
  /** 直读一律超限，分块时按 spec 篡改返回字节。 */
  const fakeExec = (mutate) => ({
    all: async (sql, params) => {
      if (sql.includes('AS n, doc AS v')) {
        throw Object.assign(new Error('too large'), { code: 'RESULT_TOO_LARGE' })
      }
      if (sql.includes('AS n FROM')) return [{ n: 10 }]
      const [start, length] = params
      const part = new Uint8Array(length).fill(0x41)
      return [{ part: mutate(part, start, length) }]
    },
  })
  const short = fakeExec((part) => part.subarray(1))
  await assert.rejects(
    () => paged.readTextColumn(short, { table, column: 'doc', where: 'id = ?', params: ['x'] }),
    (error) => {
      assert.equal(error.code, 'RESULT_INCOMPLETE')
      return true
    },
  )
  const long = fakeExec((part) => new Uint8Array(part.length + 1).fill(0x41))
  await assert.rejects(
    () => paged.readTextColumn(long, { table, column: 'doc', where: 'id = ?', params: ['x'] }),
    (error) => {
      assert.equal(error.code, 'RESULT_INCOMPLETE')
      return true
    },
  )
})

// ---------------------------------------------------------------- 3. 仓储 / 迁移读路径

test('#940 getRow：单条 doc 超过 4 MiB 的会话必须原样读回', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  const value = { title: '巨会话', messages: [{ role: 'user', text: '汉'.repeat(4_400_000) }] }
  const doc = JSON.stringify(value)
  assert.ok(doc.length > CAP, '前提：doc 本身超过原生上限')
  // 主键是 UTF-16BE BLOB（`encodeKey`），裸 INSERT TEXT 会被读路径判成损坏 → 走仓储写口
  await rawMod.createSqliteRawSink(db).writeBatch('sessions', [{ key: 'giant', value }])

  const read = await rowsMod.getRow(db, 'sessions', 'giant')
  assert.equal(read.title, '巨会话')
  assert.equal(read.messages[0].text.length, 4_400_000, '正文一字不少')
  await db.close()
})

test('#940 pageRows：一页里藏着巨 doc 时退化为「取键 + 逐行分块」，行数与内容都不少', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  const giant = { title: 'g', messages: [{ text: '汉'.repeat(2_200_000) }] }
  await rawMod.createSqliteRawSink(db).writeBatch('sessions', [
    { key: 'a', value: giant },
    { key: 'b', value: giant },
    { key: 'c', value: { title: 'c' } },
  ])

  const page = await rowsMod.pageRows(db, 'sessions')
  assert.equal(page.items.length, 3, '三行都要在')
  assert.deepEqual(
    page.items.map((item) => item.title),
    ['g', 'g', 'c'],
  )
  assert.equal(page.next, null)
  await db.close()
})

test('#940 selectRows：全量条件读撞限时仍返回全部行（顺序不变）', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  const big = 'y'.repeat(1_200_000)
  await rawMod.createSqliteRawSink(db).writeBatch(
    'attachments',
    ['k1', 'k2', 'k3', 'k4'].map((id) => ({ key: id, value: { id, name: big } })),
  )
  const all = await rowsMod.selectRows(db, 'attachments')
  assert.deepEqual(
    all.map((row) => row.id),
    ['k1', 'k2', 'k3', 'k4'],
  )
  await db.close()
})

test('#940 readBatch：一条 4.4M 汉字的会话走迁移读路径必须原样读回（内测真实场景）', async () => {
  const { db } = await openDb({ maxResultBytes: CAP })
  const source = rawMod.createSqliteRawSource(db)
  const sink = rawMod.createSqliteRawSink(db)
  const value = { title: '内测巨会话', messages: [{ role: 'user', text: '汉'.repeat(4_400_000) }] }
  await sink.writeBatch('sessions', [{ key: 's1', value }])
  await sink.writeBatch('sessions', [{ key: 's2', value: { title: '小会话' } }])

  assert.equal(await source.count('sessions'), 2)
  const page = await source.readBatch('sessions', undefined, 10)
  assert.equal(page.rows.length, 2)
  assert.equal(page.rows[0].key, 's1')
  assert.equal(page.rows[0].value.title, '内测巨会话')
  assert.equal(page.rows[0].value.messages[0].text.length, 4_400_000, '正文一字不少')
  assert.equal(page.next, undefined)
  await db.close()
})

test('#940 readBlobBytes：上限比「一页 4 块」还小时仍能校验读回原件（逐块退路）', async () => {
  const cap = 300 * 1024
  const { db } = await openDb({ maxResultBytes: cap })
  const data = new Uint8Array(1_100_000)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251
  }
  const sha256 = createHash('sha256').update(Buffer.from(data)).digest('hex')
  await db.transaction(async (tx) => {
    await blobStore.writeBlob(tx, 'files', 'blob-1', new Blob([data]))
  })
  // 上限 300 KiB < 「一次取 4 块」（2 MiB）→ 必须走逐块退路；readBlobBytes 自己校验 sha256/总长
  const read = await db.transaction(async (tx) => blobStore.readBlobBytes(tx, 'files', 'blob-1'))
  assert.ok(read, '必须读到元数据')
  assert.equal(read.total, data.length)
  const joined = Buffer.concat(read.parts.map((part) => Buffer.from(part)))
  assert.equal(joined.length, data.length)
  assert.equal(createHash('sha256').update(joined).digest('hex'), sha256, 'sha256 必须一致')
  await db.close()
})

// ---------------------------------------------------------------- 4. 估算器（分批预算）

test('#940 estimateRowBytes 必须覆盖真实过桥体积（base64 膨胀）', () => {
  // Blob 无法 JSON.stringify（会变成 {}），所以用同为二进制、同样按 base64 过桥的 Uint8Array 做精确对账
  const row = { key: 'k', value: { id: 'k', blob: new Uint8Array(4 * MB) } }
  const estimate = hash.estimateRowBytes(row)
  const wire = wireBytesOf(row)
  assert.ok(wire > CAP, `前提：真实过桥 ${wire} 确实超过 4 MiB`)
  assert.ok(estimate >= wire, `估算 ${estimate} 必须 ≥ 真实过桥 ${wire}`)
  // 也不许倒向另一个极端（拍脑袋放大到离谱）：1.2 倍以内
  assert.ok(estimate <= wire * 1.2, `估算 ${estimate} 相对真实 ${wire} 不该超过 1.2 倍`)

  // Blob 走同一条口径（内测里存储层拿到的就是 Blob）
  const blobEstimate = hash.estimateValueBytes(new Blob([new Uint8Array(4 * MB)]))
  assert.ok(blobEstimate >= 4 * Math.ceil((4 * MB) / 3), `Blob 估算 ${blobEstimate} 必须含 base64 膨胀`)
})

test('#940 分批预算与真实过桥体积：一行 4 MiB 的 BLOB 不再被当成「4 MiB 以内」', () => {
  const blob = new Blob([new Uint8Array(4 * MB)])
  const row = { key: 'k', value: { id: 'k', blob } }
  assert.ok(
    hash.estimateRowBytes(row) > CAP,
    '按 base64 计应当越过 4 MiB —— 旧口径（按 blob.size 记）才会误判成「正好 4 MiB 以内」',
  )
  void CJK
})

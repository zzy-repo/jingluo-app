// [layer: unit | 依赖: node:sqlite（Node 22 自带）+ 待落地的 src/services/storage/sqlite/paged.ts | 耗时: <15s]
// Issue #940：**超过 4 MiB 也不能丢一个字节** —— C 组（TEXT 半）：单行/单列超大。
//
// 内测用户真实场景：**一条会话的 `messages` 字段本身就 >4 MiB**。分页救不了它 —— 一行就是一行，
// 原生 `queryOn()` 攒到 4 MiB 就抛 `result exceeds 4194304 bytes`，这条会话永远迁不过去。
// 修法（#940 fix 分支）：单列按字节边界分块读（`LENGTH(CAST(col AS BLOB))` 判长 + `SUBSTR` 分段），
// 读完对总长与内容做校验，少一块必须报错、不许返回短数据。
//
//   T1 `found:false` = 行不存在；`found:true, value:null` = 该列就是 SQL NULL（两者必须分得开）
//   T2 4.4M 汉字的 TEXT 列：分块读回逐字节相同（UTF-8 字节的 sha256 一致、长度相等）
//   T3 块边界故意取 1000 字节（汉字 3 字节 → 必然劈开多字节字符）：拼接结果仍逐字节相同
//   T4 5 MiB 的 BLOB 列：分块读回 sha256 与源一致
//   T5 负向：某一块被悄悄少给 1 个字节 → 必须报错（绝不静默返回短数据）
//   T6 负向：某一块被多给字节 → 必须报错（总长对账）
//   T7 端到端：一条 4.4M 汉字的会话，`createSqliteRawSource().readBatch()` 必须原样读回
//      （同一库上先证明「不分块直读真的会抛 RESULT_TOO_LARGE」，再证明读路径已经绕开它）
//
// **T1–T7 现在都是红的**：`paged.ts` 与读路径接线都在 #940 fix 分支上，`paged.ts` 尚未落地时
// T1–T6 直接以「接口不存在」失败；T7 走的是 main 上的旧 `readBatch`（一次 `SELECT doc`），
// 会如实撞到 `RESULT_TOO_LARGE`。断言不放宽，接口落地后即可转绿。
//
//   node tests/run-layer.mjs unit --case migration-large-payload-text
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { openNodeSqliteDatabase } from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'
import {
  deterministicBytes,
  nativeResultBytes,
  sha256Hex,
  utf8,
} from '../helpers/migration-large-payload/bridge-bytes.mjs'
import { withBridgeLimit } from '../helpers/migration-large-payload/paged-driver.mjs'

installTsResolve()

const PAGED_MODULE = 'src/services/storage/sqlite/paged.ts'
let paged = null
let pagedImportError = null
try {
  paged = await loadTsModule(PAGED_MODULE)
} catch (error) {
  pagedImportError = error
}

const need = () => {
  if (paged === null) {
    assert.fail(
      [
        `${PAGED_MODULE} 还没落地（#940 fix 分支）。`,
        `测试需要它导出：readTextColumn(exec, { table, column, where, params }, options?)、`,
        `readBlobColumn(同签名)、MAX_RESULT_BYTES、COLUMN_CHUNK_BYTES。`,
        `(import 错误：${pagedImportError?.message})`,
      ].join('\n')
    )
  }
  return paged
}

const { applySchema } = await loadTsModule('src/services/storage/sqlite/schema.ts')
const { createSqliteRawSink, createSqliteRawSource } = await loadTsModule('src/services/storage/sqlite/raw.ts')
const { encodeKey } = await loadTsModule('src/services/storage/sqlite/mapping.ts')

const MiB = 1024 * 1024
const CJK = '汉'

/** 开一个真库 + 「原生 4 MiB 上限」这一层（真机上 `queryOn()` 的替身）。 */
const MIB = 4 * 1024 * 1024
const openFixture = async ({ schema = true, maxResultBytes = MIB } = {}) => {
  const opened = await openNodeSqliteDatabase()
  if (schema) {
    await applySchema(opened.db)
  } else {
    await opened.db.run('CREATE TABLE probe (id BLOB PRIMARY KEY, txt TEXT, raw BLOB)')
  }
  const bridge = withBridgeLimit(opened.db, { maxResultBytes })
  return {
    opened,
    bridge,
    limit: maxResultBytes,
    exec: { all: (sql, params) => bridge.db.all(sql, params) },
    async close() {
      await opened.db.close().catch(() => undefined)
    },
  }
}

/** 造一个「比 4 MiB 还长」的列：按**原生计数口径**（TEXT = UTF-16 码元数）真的越线。 */
const oversizeCjkText = () => CJK.repeat(4_400_000)

test('T1 found 与 value 必须分开：行不存在 ≠ 该列是 NULL', async () => {
  const { readTextColumn } = need()
  const fixture = await openFixture({ schema: false })
  try {
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('has'), 'hello', null])
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('nulltxt'), null, null])

    const missing = await readTextColumn(fixture.exec, { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('nope')] })
    assert.equal(missing.found, false, '行不存在 → found:false')
    assert.equal(missing.value, null, '行不存在时 value 也应是 null，但 found 必须为 false')

    const isNull = await readTextColumn(fixture.exec, { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('nulltxt')] })
    assert.equal(isNull.found, true, '行存在 → found:true')
    assert.equal(isNull.value, null, '该列是 SQL NULL → value:null（不能被当成空字符串）')

    const ok = await readTextColumn(fixture.exec, { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('has')] })
    assert.equal(ok.found, true)
    assert.equal(ok.value, 'hello')
  } finally {
    await fixture.close()
  }
})

test('T2 4.4M 汉字的 TEXT 列：分块读回逐字节相同', async () => {
  const { readTextColumn } = need()
  const fixture = await openFixture({ schema: false })
  try {
    const text = oversizeCjkText()
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('big'), text, null])
    assert.ok(nativeResultBytes([{ txt: text }]) > fixture.limit, '夹具按原生口径必须越过 4 MiB')
    // 先证明这条列「直读必炸」：原生计数器按 UTF-16 码元数算，4.4M > 4 MiB
    await assert.rejects(
      () => fixture.bridge.db.all('SELECT txt FROM probe WHERE id = ?', [encodeKey('big')]),
      (error) => {
        assert.equal(error.code, 'RESULT_TOO_LARGE', '直读一条 4.4M 字符的列必须撞 4 MiB 上限')
        return true
      },
      '夹具没造出「>4 MiB 的单列」（否则这条用例测不到东西）'
    )

    const read = await readTextColumn(fixture.exec, { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('big')] })
    assert.equal(read.found, true)
    assert.ok(typeof read.value === 'string', `应返回字符串，实际 ${typeof read.value}`)
    assert.equal(read.value.length, text.length, `长度 ${read.value.length} ≠ 原始 ${text.length}`)
    assert.equal(sha256Hex(utf8(read.value)), sha256Hex(utf8(text)), 'UTF-8 字节 sha256 与源不一致（有字符被改/丢）')
    assert.deepEqual(Array.from(read.value.slice(0, 32)), Array.from(text.slice(0, 32)), '首部不同')
    assert.deepEqual(Array.from(read.value.slice(-32)), Array.from(text.slice(-32)), '尾部不同')
    // 读完后所有查询都没越过上限（分块真的生效了）
    assert.ok(
      fixture.bridge.stat.maxBytesSeen <= fixture.limit,
      `单次读 ${fixture.bridge.stat.maxBytesSeen} 超过上限 ${fixture.limit}`
    )
  } finally {
    await fixture.close()
  }
})

test('T3 块边界劈开多字节字符（chunkBytes=1000 + 汉字/emoji 混排）：拼接后仍逐字节相同', async () => {
  const { readTextColumn } = need()
  // 上限压到 64 KiB：这段文本必须走分块，1 字节都没到 4 MiB 也无所谓 —— 要测的是块边界，不是上限本身
  const fixture = await openFixture({ schema: false, maxResultBytes: 64 * 1024 })
  try {
    // 汉字 3 字节、emoji 4 字节且占 2 个 UTF-16 码元：任何「按字节切、按块解码」的实现都会在这里露馅
    const text = `${'汉字😀'.repeat(9000)}${'ab'.repeat(5000)}${'😀'.repeat(3000)}`
    assert.ok(Buffer.byteLength(text, 'utf8') > fixture.limit, `夹具要有 ${fixture.limit} 字节以上才走分块，实测 ${Buffer.byteLength(text, 'utf8')}`)
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('mixed'), text, null])
    const read = await readTextColumn(
      fixture.exec,
      { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('mixed')] },
      { chunkBytes: 1000 }
    )
    assert.equal(read.found, true)
    assert.equal(read.value, text, '块边界劈开多字节字符时，拼接结果必须与原文字符串完全相等')
    assert.equal(sha256Hex(utf8(read.value)), sha256Hex(utf8(text)))
  } finally {
    await fixture.close()
  }
})

test('T4 5 MiB 的 BLOB 列：分块读回 sha256 与源一致', async () => {
  const { readBlobColumn } = need()
  const fixture = await openFixture({ schema: false })
  try {
    const source = deterministicBytes(5 * MiB, 940)
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('blob'), null, source])
    const read = await readBlobColumn(fixture.exec, { table: 'probe', column: 'raw', where: 'id = ?', params: [encodeKey('blob')] })
    assert.equal(read.found, true)
    assert.ok(read.value instanceof Uint8Array, `应返回 Uint8Array，实际 ${Object.prototype.toString.call(read.value)}`)
    assert.equal(read.value.length, source.length, `长度 ${read.value.length} ≠ ${source.length}`)
    assert.equal(sha256Hex(read.value), sha256Hex(source), 'sha256 与源不一致（有字节被改/丢）')
    assert.deepEqual(Array.from(read.value.slice(0, 32)), Array.from(source.slice(0, 32)))
    assert.deepEqual(Array.from(read.value.slice(-32)), Array.from(source.slice(-32)))
  } finally {
    await fixture.close()
  }
})

/** 一个「会撒谎」的 exec：SUBSTR 分块时少给/多给字节，其余照常。 */
const lyingExec = (bridge, mode) => ({
  all: async (sql, params) => {
    const rows = await bridge.db.all(sql, params)
    if (!/SUBSTR/i.test(sql) || rows.length === 0) {
      return rows
    }
    const row = rows[0]
    const column = Object.keys(row)[0]
    const value = row[column]
    if (typeof value === 'string') {
      if (value.length === 0) return rows
      const tampered = mode === 'extra' ? `${value}x` : value.slice(0, -1)
      return [{ ...row, [column]: tampered }]
    }
    if (value instanceof Uint8Array) {
      if (value.length === 0) return rows
      const tampered =
        mode === 'extra' ? new Uint8Array([...value, 0x41]) : value.subarray(0, value.length - 1)
      return [{ ...row, [column]: tampered }]
    }
    return rows
  },
})

test('T5 负向：某块被少给 1 个字节 → 必须报错（不许静默返回短数据）', async () => {
  const { readTextColumn } = need()
  // 上限压到 64 KiB：200 KB 的文本必须走分块，负向才真的被执行到（不压的话走直读快路径，测了个寂寞）
  const fixture = await openFixture({ schema: false, maxResultBytes: 64 * 1024 })
  try {
    const text = 'abcdefghij'.repeat(20_000) // 200 KB，分 4 块
    assert.ok(Buffer.byteLength(text, 'utf8') > fixture.limit)
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('short'), text, null])
    await assert.rejects(
      () =>
        readTextColumn(
          lyingExec(fixture.bridge, 'extra'),
          { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('short')] },
          { chunkBytes: 16 * 1024 }
        ),
      (error) => {
        assert.ok(
          /总长|长度|长度不符|不符|incomplete|短/i.test(String(error.message)),
          `错误要指出长度不符，实际：${error.message}`
        )
        return true
      },
      '块被少给时必须抛错（静默返回短数据 = 静默数据损坏）'
    )
  } finally {
    await fixture.close()
  }
})

test('T6 负向：某块被多给字节 → 总长对账必须报错', async () => {
  const { readTextColumn } = need()
  const fixture = await openFixture({ schema: false, maxResultBytes: 64 * 1024 })
  try {
    const text = 'abcdefghij'.repeat(20_000)
    assert.ok(Buffer.byteLength(text, 'utf8') > fixture.limit)
    await fixture.bridge.db.run('INSERT INTO probe (id, txt, raw) VALUES (?, ?, ?)', [encodeKey('long'), text, null])
    // 先把真值读出来当对照（证明这条列本来能正确读回）
    const good = await readTextColumn(
      fixture.exec,
      { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('long')] },
      { chunkBytes: 16 * 1024 }
    )
    assert.equal(good.value.length, text.length, '对照组：不撒谎时必须完整读回')
    await assert.rejects(
      () =>
        readTextColumn(
          lyingExec(fixture.bridge, 'extra'),
          { table: 'probe', column: 'txt', where: 'id = ?', params: [encodeKey('long')] },
          { chunkBytes: 16 * 1024 }
        ),
      () => true,
      '块被多给时总长对不上，必须抛错'
    )
  } finally {
    await fixture.close()
  }
})

test('T7 端到端：一条 4.4M 汉字的会话，createSqliteRawSource().readBatch() 必须原样读回', async () => {
  const fixture = await openFixture()
  try {
    const content = oversizeCjkText()
    const session = {
      id: 's-big',
      title: '大会话',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 's-big-m1', role: 'user', content, createdAt: 1 },
        { id: 's-big-m2', role: 'assistant', content: '短回答', createdAt: 2 },
      ],
    }
    await createSqliteRawSink(fixture.bridge.db).writeBatch('sessions', [{ key: 's-big', value: session }])

    // 1) 先证明「一次 SELECT doc」在真机上必炸 —— 这就是内测用户撞到的那个错
    const docRows = await fixture.opened.db.all('SELECT doc FROM sessions WHERE id = ?', [encodeKey('s-big')])
    const doc = String(docRows[0].doc)
    assert.ok(
      nativeResultBytes([{ doc }]) > 4 * 1024 * 1024,
      `夹具的 doc 只有 ${nativeResultBytes([{ doc }])} 字节（原生口径），没越过 4 MiB → 测不到东西`
    )
    await assert.rejects(
      () => fixture.bridge.db.all('SELECT doc FROM sessions WHERE id = ?', [encodeKey('s-big')]),
      (error) => {
        assert.equal(error.code, 'RESULT_TOO_LARGE', '直读整行 doc 必须撞 4 MiB 上限')
        return true
      },
      '不分块的读法必须在这里失败（否则说明这层上限没生效，后面的通过不算数）'
    )

    // 2) 真正的验收线：读路径必须绕开上限，把这条会话原样读回
    const page = await createSqliteRawSource(fixture.bridge.db).readBatch('sessions', undefined, 8)
    const row = page.rows.find((item) => item.key === 's-big')
    assert.ok(row, `readBatch 没读回 s-big（读到 ${page.rows.map((item) => item.key).join(',')}）`)
    assert.equal(row.value.messages.length, 2, 'messages 条数不对')
    assert.equal(
      row.value.messages[0].content.length,
      content.length,
      `content 长度 ${row.value.messages[0].content.length} ≠ ${content.length}（被截断 = 丢数据）`
    )
    assert.equal(
      sha256Hex(utf8(row.value.messages[0].content)),
      sha256Hex(utf8(content)),
      'content 的 UTF-8 sha256 与源不一致'
    )
    assert.equal(row.value.messages[1].content, '短回答', '同一条会话的其它字段也要原样')
    assert.equal(row.value.title, '大会话')
    // 读路径上不许有任何一条查询越过上限
    assert.ok(
      fixture.bridge.stat.maxBytesSeen <= fixture.limit,
      `读路径上有查询到了 ${fixture.bridge.stat.maxBytesSeen} 字节 > 上限 ${fixture.limit}`
    )
  } finally {
    await fixture.close()
  }
})

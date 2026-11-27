// [layer: unit | 依赖: node:sqlite（Node 22 自带）+ 待落地的 src/services/storage/sqlite/paged.ts | 耗时: <15s]
// Issue #940：**超过 4 MiB 也不能丢一个字节** —— B 组（分页循环）与 D 组（常规路径不回归）。
//
// 事故链：原生 `queryOn()` 把全部结果行攒进一个 JSArray，攒到 4 MiB 就
// `throw result exceeds 4194304 bytes; refusing to truncate` —— 迁移读 3 万行会话时确定性失败。
// 修法（#940 fix 分支）：原生改分页，一次请求返回 `{ rows, done, nextOffset }`；TS 侧 `queryAll()` 循环取完。
//
// 本文件把**真 SQLite** 包成那个分页形状（`tests/helpers/migration-large-payload/paged-driver.mjs`，
// 预算与超限判定都按 `AppSqlitePlugin.queryOn()` 的口径），然后钉住：
//   B1 3 万行 / 累计 >4 MiB：行数、顺序、内容逐项一致（一个字节都不许少）
//   B2 `done` 语义：没到末尾不许 `done:true`；驱动被预算截断时循环必须继续
//   B3 负向：驱动「少给数据却 done:true」→ `queryAll` 的 expectedRows 自校验必须发现（RESULT_INCOMPLETE）
//   B4 负向：分页不前进 / done:false 却给空页 → 必须报错，不许死循环、不许当成功
//   B5 负向：驱动抛超限 → 错误带稳定 `code === 'RESULT_TOO_LARGE'`（不许只有英文 message）
//   D1 常规路径：<4 MiB 的结果走 queryAll 与一次性读取逐项一致
//   D2 空结果集：`rows: []`、`done: true`，不报错
//
// **现在这些用例是红的**，因为 `src/services/storage/sqlite/paged.ts` 还没落地（#940 fix 分支）。
// 红的原因是「接口不存在」，不是「断言放宽」；落地后不改断言即可转绿。
//
//   node tests/run-layer.mjs unit --case migration-paged-query
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { openNodeSqliteDatabase } from '../helpers/storage-sqlite/nodeSqliteDriver.mjs'
import {
  MAX_RESULT_BYTES as HELPER_MAX_RESULT_BYTES,
  nativeResultBytes,
} from '../helpers/migration-large-payload/bridge-bytes.mjs'
import { createBridgePagedDriver, readAllAtOnce } from '../helpers/migration-large-payload/paged-driver.mjs'

installTsResolve()

/** 被测模块（#940 fix 分支）：`queryAll` / `MAX_RESULT_BYTES` / `RESULT_TOO_LARGE`。 */
const PAGED_MODULE = 'src/services/storage/sqlite/paged.ts'
let paged = null
let pagedImportError = null
try {
  paged = await loadTsModule(PAGED_MODULE)
} catch (error) {
  pagedImportError = error
}

/** 拿被测模块；没落地就带着「要什么」失败（不是 skip：这条用例真的红）。 */
const need = () => {
  if (paged === null) {
    assert.fail(
      [
        `${PAGED_MODULE} 还没落地（#940 fix 分支）。`,
        `测试需要它导出：queryAll(db, sql, params?, { pageRows?, expectedRows?, signal? })、`,
        `MAX_RESULT_BYTES、RESULT_TOO_LARGE、nativeResultBytes。(import 错误：${pagedImportError?.message})`,
      ].join('\n')
    )
  }
  return paged
}

const MiB = 1024 * 1024

/** 建一张「像会话表」的表：3 万行，累计 >4 MiB。 */
const openBigTable = async ({ rows = 30000, bodyBytes = 150 } = {}) => {
  const opened = await openNodeSqliteDatabase()
  await opened.db.run('CREATE TABLE blobish (id INTEGER PRIMARY KEY, name TEXT, body TEXT)')
  const statements = []
  for (let i = 0; i < rows; i += 1) {
    // 每行长度略有差异，避免「整倍数」这种假边界
    const body = 'x'.repeat(bodyBytes + (i % 7))
    statements.push({ sql: 'INSERT INTO blobish (id, name, body) VALUES (?, ?, ?)', params: [i, `n-${i}`, body] })
  }
  for (let start = 0; start < statements.length; start += 5000) {
    await opened.db.batch(statements.slice(start, start + 5000))
  }
  return opened
}

const readExpectation = async (db, sql, params) =>
  (await db.all(sql, params)).map((row) => ({ id: row.id, name: row.name, body: row.body }))

const SQL_ALL = 'SELECT id, name, body FROM blobish ORDER BY id'

test('契约落地：paged.ts 导出 queryAll / MAX_RESULT_BYTES / RESULT_TOO_LARGE，且计数口径与测试替身一致', () => {
  const { queryAll, MAX_RESULT_BYTES, RESULT_TOO_LARGE, nativeResultBytes: implBytes } = need()
  assert.equal(typeof queryAll, 'function', 'queryAll 必须是函数')
  assert.equal(MAX_RESULT_BYTES, HELPER_MAX_RESULT_BYTES, 'MAX_RESULT_BYTES 必须与 Java 侧 4*1024*1024 同值')
  assert.equal(RESULT_TOO_LARGE, 'RESULT_TOO_LARGE', '稳定错误码的字面值不能被改动')
  // 超限计数口径只有一份：两边必须逐行相等（谁改了 `nativeResultBytes`，这里会红）
  assert.equal(typeof implBytes, 'function', 'nativeResultBytes 要导出（测试/诊断共用同一份口径）')
  const fixtures = [
    [{ doc: 'x'.repeat(1000) }],
    [{ doc: '中文'.repeat(500) }],
    [{ k: 'a', doc: 'y'.repeat(10) }, { k: 'b', doc: null }],
    [{ blob: new Uint8Array(4096), n: 42, f: 1.5 }],
  ]
  for (const rows of fixtures) {
    assert.equal(
      implBytes(rows),
      nativeResultBytes(rows),
      `nativeResultBytes 与测试替身口径不一致：${JSON.stringify(rows.map((row) => Object.keys(row)))}`
    )
  }
})

test('B1 3 万行 / 累计 >4 MiB：queryAll 取回的行数、顺序、内容逐项一致', async () => {
  const { queryAll } = need()
  const opened = await openBigTable()
  try {
    const totalBytes = (await opened.db.all('SELECT SUM(LENGTH(body)) AS b FROM blobish'))[0].b
    assert.ok(totalBytes > HELPER_MAX_RESULT_BYTES, `夹具要真的超过 4 MiB，实测 ${totalBytes}`)

    const driver = createBridgePagedDriver(opened.db)
    const rows = await queryAll(driver.db, SQL_ALL, [], { expectedRows: 30000, pageRows: 5000 })
    const expected = await readExpectation(opened.db, SQL_ALL, [])

    assert.equal(rows.length, expected.length, `行数 ${rows.length} ≠ ${expected.length}（少给 = 数据丢失）`)
    assert.deepEqual(
      rows.map((row) => row.id),
      expected.map((row) => row.id),
      '主键顺序必须与一次性读取完全一致'
    )
    for (const [index, row] of rows.entries()) {
      const want = expected[index]
      assert.equal(row.id, want.id, `第 ${index} 行主键不同`)
      assert.equal(row.name, want.name, `第 ${index} 行的 name 不同`)
      assert.equal(row.body, want.body, `第 ${index} 行的 body 不同（内容被改）`)
    }
    assert.ok(driver.stat.pages.length >= 2, `应该分多页取，实测 ${driver.stat.pages.length} 页`)
    assert.ok(
      driver.stat.maxBytesSeen <= HELPER_MAX_RESULT_BYTES,
      `单页 ${driver.stat.maxBytesSeen} 字节超过原生上限 ${HELPER_MAX_RESULT_BYTES}`
    )
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

test('B2 done 语义：预算把一页截短时 done 必须是 false，循环要靠 done 而不是「行数 < limit」', async () => {
  const { queryAll } = need()
  const opened = await openBigTable()
  try {
    // pageRows 开到比总行数还大：驱动只能靠字节预算截断，此时「返回行数 < limit」不代表到头
    const driver = createBridgePagedDriver(opened.db)
    const rows = await queryAll(driver.db, SQL_ALL, [], { expectedRows: 30000, pageRows: 40000 })
    assert.equal(rows.length, 30000, `应取回 30000 行，实测 ${rows.length}`)
    const trimmed = driver.stat.pages.filter((page) => page.fetched >= page.limit && !page.done)
    assert.ok(
      trimmed.length >= 1 || driver.stat.pages.some((page) => page.fetched > page.kept),
      `夹具没造出「被预算截断但仍未完」的页：${JSON.stringify(driver.stat.pages)}`
    )
    // 被截断的页必须是 done:false（否则调用方会把这一块当全部）
    for (const page of driver.stat.pages.slice(0, -1)) {
      assert.equal(page.done, false, `不是最后一页却 done:true：${JSON.stringify(page)}`)
    }
    assert.deepEqual(
      rows.map((row) => row.id),
      (await readExpectation(opened.db, SQL_ALL, [])).map((row) => row.id),
      '分页结果顺序必须与一次性读取一致'
    )
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

test('B3 负向：驱动「少给数据却 done:true」→ queryAll 必须靠 expectedRows 发现（RESULT_INCOMPLETE）', async () => {
  const { queryAll, RESULT_TOO_LARGE } = need()
  const opened = await openBigTable({ rows: 2000, bodyBytes: 64 })
  try {
    const driver = createBridgePagedDriver(opened.db, { faults: { forceDoneAfterFirstPage: true } })
    await assert.rejects(
      () => queryAll(driver.db, SQL_ALL, [], { expectedRows: 2000, pageRows: 500 }),
      (error) => {
        assert.notEqual(error.code, RESULT_TOO_LARGE, '这不是超限错误，是「拿到的不完整」')
        assert.equal(error.code, 'RESULT_INCOMPLETE', `必须带稳定 code RESULT_INCOMPLETE，实际 ${error.code}`)
        return true
      },
      '驱动少给数据却声称 done:true 时，queryAll 不许当成功返回（静默少给 = 静默数据丢失）'
    )
    // 反证：同样「少给」但调用方不传 expectedRows 时，queryAll 只能返回它拿到的那些行 ——
    // 这正是「调用方必须传总数」这条契约存在的原因，写出来免得有人以为不传也行。
    // （换一个全新的驱动：上一条已经把它的调用次数用掉了）
    const fresh = createBridgePagedDriver(opened.db, { faults: { forceDoneAfterFirstPage: true } })
    const partial = await queryAll(fresh.db, SQL_ALL, [], { pageRows: 500 })
    assert.ok(partial.length > 0 && partial.length < 2000, `不传 expectedRows 时只能拿到部分（${partial.length} 行）`)
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

test('B4 负向：分页不前进 / done:false 却给空页 → 必须报错，不许死循环也不许当成功', async () => {
  const { queryAll } = need()
  const opened = await openBigTable({ rows: 500, bodyBytes: 64 })
  try {
    const stale = createBridgePagedDriver(opened.db, { faults: { staleOffset: true } })
    await assert.rejects(
      () => queryAll(stale.db, SQL_ALL, [], { pageRows: 100 }),
      (error) => {
        assert.equal(error.code, 'RESULT_INCOMPLETE', `offset 不前进必须报 RESULT_INCOMPLETE，实际 ${error.code}`)
        assert.ok(/前进|offset|progress/i.test(String(error.message)), `信息要说清「没前进」，实际：${error.message}`)
        return true
      },
      'offset 不前进时 queryAll 会无限循环（或静默返回第一页），必须抛错'
    )

    const empty = createBridgePagedDriver(opened.db, { faults: { emptyUndone: true } })
    await assert.rejects(
      () => queryAll(empty.db, SQL_ALL, [], { pageRows: 100 }),
      (error) => {
        assert.equal(error.code, 'RESULT_INCOMPLETE', `done:false 却空页必须报 RESULT_INCOMPLETE，实际 ${error.code}`)
        return true
      },
      'done:false 却给空页 = 驱动自己坏了，不许当成功'
    )
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

test('B5 负向：驱动抛超限 → 错误必须带稳定 code === RESULT_TOO_LARGE', async () => {
  const { queryAll, RESULT_TOO_LARGE } = need()
  const opened = await openBigTable({ rows: 500, bodyBytes: 64 })
  try {
    const driver = createBridgePagedDriver(opened.db, { faults: { failFromCall: 2 } })
    await assert.rejects(
      () => queryAll(driver.db, SQL_ALL, [], { pageRows: 100 }),
      (error) => {
        assert.equal(error.code, RESULT_TOO_LARGE, `超限错误必须带 code=RESULT_TOO_LARGE，实际 ${error.code}`)
        assert.equal(RESULT_TOO_LARGE, 'RESULT_TOO_LARGE')
        return true
      },
      '超限错误不能只是一条英文 message（UI 靠 code 分类，英文原文不许直出给用户）'
    )
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

test('D1 常规路径：<4 MiB 的结果走 queryAll 与一次性读取逐项一致', async () => {
  const { queryAll } = need()
  const opened = await openBigTable({ rows: 200, bodyBytes: 100 })
  try {
    const driver = createBridgePagedDriver(opened.db)
    const pagedRows = await queryAll(driver.db, SQL_ALL, [], { expectedRows: 200, pageRows: 50 })
    const atOnce = await readAllAtOnce(opened.db, SQL_ALL, [])
    assert.equal(pagedRows.length, atOnce.length, '行数必须与一次性读取相同')
    assert.deepEqual(
      pagedRows.map((row) => ({ id: row.id, name: row.name, body: row.body })),
      atOnce.map((row) => ({ id: row.id, name: row.name, body: row.body })),
      '内容与顺序必须与一次性读取完全一致（常规路径不回归）'
    )
    // 带参数的查询同样不回归
    const filtered = await queryAll(driver.db, 'SELECT id, body FROM blobish WHERE id >= ? ORDER BY id', [150], {
      pageRows: 10,
    })
    assert.equal(filtered.length, 50)
    assert.equal(filtered[0].id, 150)
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

test('D2 空结果集：queryAll 返回 []，且驱动第一页就 done:true，不报错', async () => {
  const { queryAll } = need()
  const opened = await openBigTable({ rows: 10, bodyBytes: 32 })
  try {
    const driver = createBridgePagedDriver(opened.db)
    const rows = await queryAll(driver.db, 'SELECT id, body FROM blobish WHERE id < ?', [0], { pageRows: 100 })
    assert.deepEqual(rows, [], '空结果集必须是 []（不能是 undefined / null）')
    assert.equal(driver.stat.pages.length, 1, `空结果集只该问一次驱动，实测 ${driver.stat.pages.length} 次`)
    assert.equal(driver.stat.pages[0].done, true, '空结果集的第一页就该是 done:true')
    // 空结果集 + expectedRows: 0 也不许误报不完整
    const again = await queryAll(driver.db, 'SELECT id FROM blobish WHERE id < ?', [0], { expectedRows: 0 })
    assert.deepEqual(again, [])
  } finally {
    await opened.db.close().catch(() => undefined)
  }
})

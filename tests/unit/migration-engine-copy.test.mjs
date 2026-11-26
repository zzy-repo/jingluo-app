// [layer: unit | 依赖: 纯 Node + 内存版 RawStoreSource/Sink | 耗时: <10s]
//
// #910 迁移引擎：复制。钉：正常复制、幂等、中止后续跑、每个检查点杀掉重来、批大小按字节自适应、
// 故障注入（sink / source 在第 N 批抛错）、失败后不继续写后续 store。
//
//   node tests/run-layer.mjs unit --case migration-engine-copy
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { GeneratedBlob, QuotaExceededError, STORE_NAMES, createMem, makeFixture, memFromFixture } from '../helpers/migration-engine/mem.mjs'

installTsResolve()
const { copyAll, CopyError } = await loadTsModule('src/services/storage/migration/copy.ts')
const { verifyAll } = await loadTsModule('src/services/storage/migration/verify.ts')

const emptyTarget = () => createMem()
const run = (source, target, extra = {}) =>
  copyAll({ source: source.source, sink: target.sink, batchSize: 4, ...extra })
const assertIdentical = async (source, target) => {
  const report = await verifyAll({ source: source.source, target: target.source })
  assert.deepEqual(report.semanticIssues, [])
  assert.equal(report.ok, true, JSON.stringify(report.stores.filter((s) => !s.keysMatch || s.contentMismatchKeys.length)))
}

test('正常复制：9 个 store 全部到位，内容逐行一致，检查点每批一条 + 每个 store 一条 done', async () => {
  const source = memFromFixture({ sessions: 10 })
  const target = emptyTarget()
  const checkpoints = []
  const result = await run(source, target, { onCheckpoint: (c) => void checkpoints.push(c) })
  assert.equal(result.completed, true)
  assert.equal(result.rowsCopied, source.totalRows())
  for (const store of STORE_NAMES) {
    assert.equal(target.size(store), source.size(store), store)
  }
  assert.deepEqual(checkpoints.filter((c) => c.done).map((c) => c.store), STORE_NAMES)
  for (const c of checkpoints.filter((x) => !x.done)) {
    assert.ok(typeof c.lastKey === 'string')
  }
  await assertIdentical(source, target)
})

test('重复复制幂等：跑两遍结果与跑一遍相同，行数不增', async () => {
  const source = memFromFixture()
  const target = emptyTarget()
  await run(source, target)
  const rows = target.totalRows()
  await run(source, target)
  assert.equal(target.totalRows(), rows)
  await assertIdentical(source, target)
})

test('空库：不写任何批，但 9 个 store 各交出 done 检查点', async () => {
  const source = createMem()
  const target = emptyTarget()
  const checkpoints = []
  const result = await run(source, target, { onCheckpoint: (c) => void checkpoints.push(c) })
  assert.equal(result.completed, true)
  assert.equal(target.counters.writes, 0)
  assert.deepEqual(checkpoints, STORE_NAMES.map((store) => ({ store, lastKey: undefined, done: true })))
})

test('中途中止：在批边界停下，续跑得到与一次跑完相同的结果', async () => {
  const source = memFromFixture({ sessions: 12 })
  const target = emptyTarget()
  const controller = new AbortController()
  const saved = []
  const first = await run(source, target, {
    signal: controller.signal,
    onCheckpoint: (c) => {
      saved.push(c)
      if (saved.length === 5) controller.abort()
    },
  })
  assert.equal(first.completed, false)
  assert.equal(saved.length, 5, '中止后不再交出检查点')
  assert.ok(target.totalRows() < source.totalRows())
  // 每个已交出检查点的批都已落地
  for (const c of saved.filter((x) => !x.done)) {
    assert.ok(target.get(c.store, c.lastKey) !== undefined)
  }
  const second = await run(source, target, { checkpoints: saved })
  assert.equal(second.completed, true)
  await assertIdentical(source, target)
  // 续跑没有重写已检查点的行
  assert.ok(second.rowsCopied < source.totalRows())
})

test('每个检查点都杀掉重来（丢弃内存，只带持久化的检查点）：终态一致', async () => {
  const base = memFromFixture({ sessions: 7 })
  // 先数出一次完整运行有多少个检查点
  const total = []
  await run(base, emptyTarget(), { onCheckpoint: (c) => void total.push(c) })
  assert.ok(total.length > 10)
  for (let killAt = 1; killAt <= total.length; killAt++) {
    const target = emptyTarget()
    const persisted = []
    let n = 0
    const first = new AbortController()
    // 「杀」：在第 killAt 个检查点落盘之后立即中止（持久化与进程死亡的边界）
    await run(base, target, {
      signal: first.signal,
      onCheckpoint: (c) => {
        persisted.push(c)
        if (++n === killAt) first.abort()
      },
    })
    await run(base, target, { checkpoints: persisted })
    const report = await verifyAll({ source: base.source, target: target.source })
    assert.equal(report.ok, true, `killAt=${killAt}`)
  }
})

test('检查点落盘前被杀（写成功、检查点丢失）：续跑重写同一批，幂等不重复', async () => {
  const source = memFromFixture({ sessions: 9 })
  const target = emptyTarget()
  const persisted = []
  await assert.rejects(
    run(source, target, {
      onCheckpoint: (c) => {
        if (persisted.length === 3) throw new Error('killed before persisting')
        persisted.push(c)
      },
    }),
    (error) => error instanceof CopyError && error.phase === 'checkpoint'
  )
  await run(source, target, { checkpoints: persisted })
  await assertIdentical(source, target)
})

test('批大小按字节自适应：大附件单条一批，单批估算字节不超过上限（超大单行除外）', async () => {
  const rows = makeFixture({ sessions: 2 })
  for (let i = 0; i < 6; i++) {
    rows.files.push({ key: `big-${i}`, value: { id: `big-${i}`, blob: new GeneratedBlob(5 * 1024 * 1024, i) } })
  }
  const source = createMem(rows)
  const target = emptyTarget()
  const batchesOf = []
  const origWrite = target.sink.writeBatch
  target.sink.writeBatch = async (store, batch) => {
    batchesOf.push({ store, keys: batch.map((r) => r.key) })
    return origWrite(store, batch)
  }
  const result = await copyAll({ source: source.source, sink: target.sink, batchSize: 200, maxBatchBytes: 1024 * 1024 })
  assert.equal(result.completed, true)
  for (let i = 0; i < 6; i++) {
    const batch = batchesOf.find((b) => b.keys.includes(`big-${i}`))
    assert.deepEqual(batch.keys, [`big-${i}`], '超过上限的大附件必须自成一批')
  }
  assert.equal(target.size('files'), source.size('files'))
})

test('续跑从 lastKey 之后开始：已检查点的行不会再读到 sink', async () => {
  const source = memFromFixture({ sessions: 8 })
  const target = emptyTarget()
  const writes = []
  const origWrite = target.sink.writeBatch
  target.sink.writeBatch = async (store, batch) => {
    writes.push(...batch.map((r) => `${store}/${r.key}`))
    return origWrite(store, batch)
  }
  const keys = [...source.data.get('sessions').keys()].sort()
  await copyAll({
    source: source.source,
    sink: target.sink,
    batchSize: 3,
    checkpoints: [
      { store: 'sessions', lastKey: keys[3], done: false },
      { store: 'sessionSummaries', lastKey: undefined, done: true },
    ],
  })
  assert.ok(!writes.some((w) => w === `sessions/${keys[0]}` || w === `sessions/${keys[3]}`))
  assert.ok(writes.includes(`sessions/${keys[4]}`))
  assert.ok(!writes.some((w) => w.startsWith('sessionSummaries/')))
})

// ---------------------------------------------------------------- 故障注入

test('sink 在第 N 批抛 quota：抛带 store/lastKey 的 CopyError，不吞，不写后续 store', async () => {
  for (const failAt of [1, 2, 5, 9]) {
    const source = memFromFixture({ sessions: 10 })
    const target = emptyTarget()
    const persisted = []
    target.hooks.onWrite = (_store, _rows, nth) => {
      if (nth === failAt) throw new QuotaExceededError()
    }
    let caught
    try {
      await run(source, target, { onCheckpoint: (c) => void persisted.push(c) })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof CopyError, `failAt=${failAt}`)
    assert.equal(caught.phase, 'write')
    assert.equal(caught.cause.name, 'QuotaExceededError')
    const last = [...persisted].reverse().find((c) => c.store === caught.store && !c.done)
    assert.equal(caught.lastKey, last?.lastKey, 'lastKey = 最后一个已交出检查点的主键')
    // 失败的 store 之后的 store 一行都没写
    const index = STORE_NAMES.indexOf(caught.store)
    for (const later of STORE_NAMES.slice(index + 1)) {
      assert.equal(target.size(later), 0, `${later} 不该被写`)
    }
    // 重试（带检查点）能收敛
    target.hooks.onWrite = undefined
    await run(source, target, { checkpoints: persisted })
    await assertIdentical(source, target)
  }
})

test('sink 抛非 quota 错误：同样带上下文抛出', async () => {
  const source = memFromFixture()
  const target = emptyTarget()
  target.hooks.onWrite = (_s, _r, nth) => {
    if (nth === 3) throw Object.assign(new Error('disk I/O'), { code: 'SQLITE_IOERR' })
  }
  await assert.rejects(run(source, target), (error) => {
    assert.ok(error instanceof CopyError)
    assert.equal(error.cause.code, 'SQLITE_IOERR')
    assert.match(error.message, /store=\w+ lastKey=/)
    return true
  })
})

test('source 读第 N 批抛错：CopyError(phase=read)，已检查点的批保留，不继续后续 store', async () => {
  for (const failAt of [1, 3, 6]) {
    const source = memFromFixture({ sessions: 10 })
    const target = emptyTarget()
    const persisted = []
    source.hooks.onRead = (_store, _after, nth) => {
      if (nth === failAt) throw new Error('read boom')
    }
    let caught
    try {
      await run(source, target, { onCheckpoint: (c) => void persisted.push(c) })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof CopyError, `failAt=${failAt}`)
    assert.equal(caught.phase, 'read')
    const index = STORE_NAMES.indexOf(caught.store)
    for (const later of STORE_NAMES.slice(index + 1)) {
      assert.equal(target.size(later), 0)
    }
    source.hooks.onRead = undefined
    await run(source, target, { checkpoints: persisted })
    await assertIdentical(source, target)
  }
})

test('readBatch 不前进（next 等于 after）：抛错而不是死循环', async () => {
  const source = memFromFixture()
  const target = emptyTarget()
  const stuck = {
    count: source.source.count,
    estimateBytes: source.source.estimateBytes,
    // 无论从哪里读都返回同一行并声称还有下一页（next 恒为 'a'）：第二次调用 next === after
    readBatch: async () => ({ rows: [{ key: 'a', value: 1 }], next: 'a' }),
  }
  await assert.rejects(copyAll({ source: stuck, sink: target.sink, batchSize: 1 }), (error) => error instanceof CopyError)
})

test('起跑前已中止：什么都不写，completed=false', async () => {
  const source = memFromFixture()
  const target = emptyTarget()
  const controller = new AbortController()
  controller.abort()
  const result = await run(source, target, { signal: controller.signal })
  assert.equal(result.completed, false)
  assert.equal(target.counters.writes, 0)
})

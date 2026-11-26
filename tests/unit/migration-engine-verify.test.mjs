// [layer: unit | 依赖: 纯 Node + 内存版 RawStoreSource | 耗时: <10s]
//
// #910 迁移引擎：全量校验器。每一种缺陷都有两面：
//   ① 正向：缺陷存在 → `verifyAll` 报红，并点名主键；
//   ② 负向对照：把负责抓它的检查关掉（`skip`）→ 同一缺陷被放过（ok=true）。
//      ②成立才说明①真的是那项检查抓住的，而不是别处顺带红了。
// 另有「目标与源的差异才是错误」：源里原有的瑕疵原样带过去不算错，在目标里「修好」反而算。
//
//   node tests/run-layer.mjs unit --case migration-engine-verify
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import { GeneratedBlob, clone, createMem, makeFixture } from '../helpers/migration-engine/mem.mjs'

installTsResolve()
const { verifyAll } = await loadTsModule('src/services/storage/migration/verify.ts')

/** 一份源 + 一份与之相同的目标（各自深拷贝，Blob 共享无妨：只读） */
const pair = (options) => {
  const rows = makeFixture(options)
  const copy = Object.fromEntries(Object.entries(rows).map(([store, list]) => [store, list.map((r) => ({ key: r.key, value: clone(r.value) }))]))
  return { source: createMem(rows), target: createMem(copy) }
}
const verify = (p, skip) => verifyAll({ source: p.source.source, target: p.target.source, skip })
const store = (report, name) => report.stores.find((s) => s.store === name)

test('相同数据：ok，9 个 store 全量标记，无语义问题', async () => {
  const p = pair({ sessions: 5 })
  const report = await verify(p)
  assert.equal(report.ok, true)
  assert.deepEqual(report.semanticIssues, [])
  assert.equal(report.stores.length, 9)
  assert.ok(report.stores.every((s) => s.full && s.keysMatch && s.missingKeys.length === 0 && s.contentMismatchKeys.length === 0))
})

/**
 * 缺陷表：mutate 在目标上制造缺陷；detect 描述应被点名的位置；responsible 是负责抓它的检查。
 * 缺陷都落在 appAssets / sessionsStaging（语义不变量不观察的 store），语义检查有独立的用例。
 */
const ASSET = 'chat-background:default'
const defects = [
  {
    name: '少一行',
    responsible: ['count', 'keys'],
    mutate: (p) => p.target.remove('appAssets', ASSET),
    detect: (r) => assert.deepEqual(store(r, 'appAssets').missingKeys, [ASSET]),
  },
  {
    name: '多一行',
    responsible: ['count', 'keys'],
    mutate: (p) => p.target.set('appAssets', 'zzz-extra', { key: 'zzz-extra', blob: new Blob(['x']), updatedAt: 1 }),
    detect: (r) => assert.deepEqual(store(r, 'appAssets').extraKeys, ['zzz-extra']),
  },
  {
    name: '少一行同时多一行（计数持平）',
    responsible: ['keys'],
    mutate: (p) => {
      p.target.remove('sessionsStaging', 'stg-1')
      p.target.set('sessionsStaging', 'stg-2', { id: 'stg-2', title: 'staging', createdAt: 1, updatedAt: 1, messages: [] })
    },
    detect: (r) => {
      assert.equal(store(r, 'sessionsStaging').sourceCount, store(r, 'sessionsStaging').targetCount)
      assert.deepEqual(store(r, 'sessionsStaging').missingKeys, ['stg-1'])
      assert.deepEqual(store(r, 'sessionsStaging').extraKeys, ['stg-2'])
    },
  },
  {
    name: '改一个字段',
    responsible: ['content'],
    mutate: (p) => (p.target.get('appAssets', ASSET).updatedAt = 100),
    detect: (r) => assert.deepEqual(store(r, 'appAssets').contentMismatchKeys, [ASSET]),
  },
  {
    name: '丢一个字段',
    responsible: ['content'],
    mutate: (p) => delete p.target.get('sessionsStaging', 'stg-1').title,
    detect: (r) => assert.deepEqual(store(r, 'sessionsStaging').contentMismatchKeys, ['stg-1']),
  },
  {
    name: '多一个字段',
    responsible: ['content'],
    mutate: (p) => (p.target.get('sessionsStaging', 'stg-1').extra = 1),
    detect: (r) => assert.deepEqual(store(r, 'sessionsStaging').contentMismatchKeys, ['stg-1']),
  },
  {
    name: '改 Blob 一个字节（同长度同类型）',
    responsible: ['content'],
    mutate: (p) => {
      const value = p.target.get('appAssets', ASSET)
      value.blob = new Blob([new TextEncoder().encode('bX')], { type: 'image/jpeg' }) // 源是 'bg'
    },
    detect: (r) => assert.deepEqual(store(r, 'appAssets').contentMismatchKeys, [ASSET]),
  },
  {
    name: 'Blob 的 type 被改',
    responsible: ['content'],
    mutate: (p) => (p.target.get('appAssets', ASSET).blob = new Blob(['bg'], { type: 'image/png' })),
    detect: (r) => assert.deepEqual(store(r, 'appAssets').contentMismatchKeys, [ASSET]),
  },
  {
    name: '类型被悄悄改（Date → ISO 字符串）',
    responsible: ['content'],
    mutate: (p) => {
      p.source.get('sessionsStaging', 'stg-1').createdAt = new Date(1700000000000)
      p.target.get('sessionsStaging', 'stg-1').createdAt = new Date(1700000000000).toISOString()
    },
    detect: (r) => assert.deepEqual(store(r, 'sessionsStaging').contentMismatchKeys, ['stg-1']),
  },
  {
    name: '类型被悄悄改（number → string）',
    responsible: ['content'],
    mutate: (p) => (p.target.get('appAssets', ASSET).updatedAt = '99'),
    detect: (r) => assert.deepEqual(store(r, 'appAssets').contentMismatchKeys, [ASSET]),
  },
  {
    name: 'NaN 被改成 null',
    responsible: ['content'],
    mutate: (p) => {
      p.source.get('sessionsStaging', 'stg-1').score = Number.NaN
      p.target.get('sessionsStaging', 'stg-1').score = null
    },
    detect: (r) => assert.deepEqual(store(r, 'sessionsStaging').contentMismatchKeys, ['stg-1']),
  },
]

const CHECKS = ['count', 'keys', 'content', 'semantic']
for (const defect of defects) {
  test(`校验抓到：${defect.name}（负向对照：关掉 ${defect.responsible.join('+')} 就放过）`, async () => {
    const p = pair()
    defect.mutate(p)
    const report = await verify(p)
    assert.equal(report.ok, false)
    defect.detect(report)
    // 关掉无关的检查：仍然报红（不是别的检查顺带抓到的）
    const unrelated = Object.fromEntries(CHECKS.filter((c) => !defect.responsible.includes(c)).map((c) => [c, true]))
    assert.equal((await verify(p, unrelated)).ok, false, '关掉无关检查后应仍报红')
    // 负向对照：关掉负责的检查 → 放过
    const skipped = Object.fromEntries(defect.responsible.map((c) => [c, true]))
    const blind = await verify(p, skipped)
    assert.equal(blind.ok, true, `关掉 ${defect.responsible.join('+')} 后缺陷应被放过（证明是它们抓到的）`)
  })
}

test('改动落在大 Blob 的最后一个字节（跨 1MiB 片）也能抓到；相同的生成式 Blob 不误报', async () => {
  const mk = (flip) => {
    const rows = { appAssets: [{ key: 'big', value: { key: 'big', blob: new GeneratedBlob(2.5 * 1024 * 1024, 3), updatedAt: 1 } }] }
    const same = new GeneratedBlob(2.5 * 1024 * 1024, flip ? 4 : 3)
    return { source: createMem(rows), target: createMem({ appAssets: [{ key: 'big', value: { key: 'big', blob: same, updatedAt: 1 } }] }) }
  }
  assert.equal((await verify(mk(false))).ok, true)
  const bad = await verify(mk(true))
  assert.equal(bad.ok, false)
  assert.deepEqual(store(bad, 'appAssets').contentMismatchKeys, ['big'])
  assert.equal((await verify(mk(true), { content: true })).ok, true)
})

test('主键排序不同的两个后端（UTF-16 序 vs 字节序）互比不误报', async () => {
  const rows = { sessionsStaging: ['a', 'B', '😀', '\uffff', 'é', 'Z'].map((key) => ({ key, value: { id: key } })) }
  const byBytes = createMem(rows)
  const reorder = (s) => ({
    ...s,
    readBatch: async (st, after, limit) => {
      // 目标按「字节序」分页（与源的 UTF-16 序不同）：这里用 Buffer 比较重排
      const all = (await s.readBatch(st, undefined, 1000)).rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)))
      const start = after === undefined ? 0 : all.findIndex((r) => r.key === after) + 1
      const rowsPage = all.slice(start, start + limit)
      return start + limit < all.length ? { rows: rowsPage, next: rowsPage.at(-1).key } : { rows: rowsPage }
    },
  })
  const report = await verifyAll({ source: byBytes.source, target: reorder(byBytes.source) })
  assert.equal(report.ok, true)
})

// ---------------------------------------------------------------- 语义不变量

const onlySemantic = { count: true, keys: true, content: true }
const noSemantic = { semantic: true }

test('语义：摘要字段与会话不一致（目标侧摘要陈旧）→ 报；负向对照关语义就放过', async () => {
  const p = pair()
  // 源与目标的会话行完全相同，只有目标的摘要标题被改 → 内容哈希也会红；关掉内容后只剩语义
  p.target.get('sessionSummaries', 's001').title = 'stale'
  const report = await verify(p, onlySemantic)
  assert.equal(report.ok, false)
  assert.ok(report.semanticIssues.some((i) => i.includes('summary-stale:s001') && i.includes('target-only')), report.semanticIssues.join('\n'))
  assert.equal((await verify(p, { ...onlySemantic, semantic: true })).ok, true)
})

test('语义：摘要 fileIds 与会话引用不一致 → 报', async () => {
  const p = pair()
  p.target.get('sessionSummaries', 's002').fileIds = []
  const report = await verify(p, onlySemantic)
  assert.ok(report.semanticIssues.some((i) => i.includes('summary-fileids-differ:s002')))
  assert.equal((await verify(p, { ...onlySemantic, semantic: true })).ok, true)
})

test('语义：目标缺会话对应的摘要 / 多出孤儿摘要 → 报', async () => {
  const p = pair()
  p.target.remove('sessionSummaries', 's003')
  p.target.set('sessionSummaries', 'ghost', { id: 'ghost', title: 'g', createdAt: 1, updatedAt: 1, fileIds: [] })
  const report = await verify(p, onlySemantic)
  assert.ok(report.semanticIssues.some((i) => i.includes('summary-missing:s003')))
  assert.ok(report.semanticIssues.some((i) => i.includes('summary-orphan:ghost')))
})

test('语义：目标丢了摘要引用的原件 → 报（源里有、目标没有）；负向对照', async () => {
  const p = pair()
  p.target.remove('files', 'img-s001')
  const report = await verify(p, onlySemantic)
  assert.ok(report.semanticIssues.some((i) => i.startsWith('semantic:target-only:summary-file-missing:s001:img-s001')), report.semanticIssues.join('\n'))
  const full = await verify(p)
  assert.ok(full.stores.find((x) => x.store === 'files').missingKeys.includes('img-s001'))
  assert.equal(report.ok, false)
  assert.equal((await verify(p, { ...onlySemantic, semantic: true })).ok, true)
})

test('语义：附件 localPath / parsedTextPath 指向的原件与全文，目标比源少 → 报', async () => {
  const p = pair()
  const att = p.target.get('attachments', 'att-0')
  p.target.remove('files', att.localPath)
  p.target.remove('attachmentTexts', att.parsedTextPath)
  const report = await verify(p, onlySemantic)
  assert.ok(report.semanticIssues.some((i) => i.includes('attachment-blob-missing:att-0')))
  assert.ok(report.semanticIssues.some((i) => i.includes('attachment-text-missing:att-0')))
  assert.ok(report.semanticIssues.some((i) => i.includes('count:attachment-blobs')), 'attachment- 前缀原件数量也对不上')
  assert.equal((await verify(p, { ...onlySemantic, semantic: true })).ok, true)
})

test('语义：记忆行归属——主键与 sessionId 不一致、会话在目标里不存在 → 报', async () => {
  const p = pair()
  p.target.get('sessionMemory', 's000:chunk-1').sessionId = 's999'
  p.target.remove('sessions', 's004')
  const report = await verify(p, onlySemantic)
  assert.ok(report.semanticIssues.some((i) => i.includes('memory-id-mismatch:s000:chunk-1')))
  assert.ok(report.semanticIssues.some((i) => i.includes('memory-orphan:s004:chunk-0')))
  assert.equal((await verify(p, { ...onlySemantic, semantic: true })).ok, true)
})

test('以源为基准：源里原有的瑕疵（缺原件 / 孤儿记忆 / 孤儿摘要 / 附件悬空）原样带过去 → 不算错', async () => {
  const rows = makeFixture()
  const flaws = (r) => {
    const drop = (st, key) => (r[st] = r[st].filter((x) => x.key !== key))
    drop('files', 'img-s002') // 摘要引用的原件早就不在
    drop('attachmentTexts', r.attachments[0].value.parsedTextPath) // 全文悬空
    r.sessionMemory.push({ key: 'gone:k', value: { id: 'gone:k', sessionId: 'gone', key: 'k', text: 't', bytes: 1, createdAt: 1, updatedAt: 1 } })
    r.sessionSummaries.push({ key: 'orphan', value: { id: 'orphan', title: 't', createdAt: 1, updatedAt: 1, fileIds: [] } })
    return r
  }
  const source = createMem(flaws(rows))
  const target = createMem(flaws(makeFixture()))
  const report = await verifyAll({ source: source.source, target: target.source })
  assert.deepEqual(report.semanticIssues, [])
  assert.equal(report.ok, true)
  // 在目标里「修好」源的瑕疵反而是差异
  target.set('files', 'img-s002', { id: 'img-s002', blob: new Blob(['fix']) })
  const fixed = await verifyAll({ source: source.source, target: target.source })
  assert.equal(fixed.ok, false)
  assert.ok(fixed.semanticIssues.some((i) => i.startsWith('semantic:source-only:summary-file-missing:s002:img-s002')), fixed.semanticIssues.join('\n'))
})

test('计数口径不自洽（count() 说 N、实际扫到 M）→ 报', async () => {
  const p = pair()
  const lying = { ...p.target.source, count: async (st) => (st === 'sessionsStaging' ? 7 : p.target.source.count(st)) }
  const report = await verifyAll({ source: p.source.source, target: lying })
  assert.equal(report.ok, false)
  assert.ok(report.semanticIssues.some((i) => i.startsWith('count-inconsistent:target:sessionsStaging')))
})

test('signal 中止：校验抛 AbortError，不返回半份报告', async () => {
  const p = pair()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(verifyAll({ source: p.source.source, target: p.target.source, signal: controller.signal }), /abort/i)
})

test('源读取抛错：原样向上抛（不当成「校验通过」也不当成「校验失败」吞掉）', async () => {
  const p = pair()
  p.source.hooks.onRead = (_s, _a, nth) => {
    if (nth === 4) throw new Error('source read boom')
  }
  await assert.rejects(verify(p), /source read boom/)
})

test('字段映射不丢：嵌套对象里的 Date / Uint8Array / null 经深拷后通过全量校验', async () => {
  const p = pair({ sessions: 20 })
  p.source.get('sessions', 's000').messages[0].extra = { nested: [1, 'a', null, new Date(5), new Uint8Array([1, 2, 3])] }
  p.target.set('sessions', 's000', clone(p.source.get('sessions', 's000')))
  assert.equal((await verify(p)).ok, true)
})

// SessionRepo.save 的契约：原子边界（会话+摘要同成同败，原件只降级）、自愈、失败分类。
// 全部用例只看 `SaveSessionOutcome` 与接口读回，不碰物理存储名（`failure.stores` 是物理名，不断言）。
// 自愈口径来自 docs/storage-abstraction.md §4 末尾的【决定 2026-11-26】：save 内含「配额清孤儿再试一次」与「剔字段再试一次」。
import assert from 'node:assert/strict'
import { attKey, blobOf, ids, sessionOf, seed, stored, withFault } from './fixtures.mjs'

const KINDS = ['quota', 'clone', 'unavailable', 'unknown']

export const register = (suite) => {
  const S = suite.case.bind(suite)

  // ------------------------------------------------------------ 事务 A：会话 + 摘要同成同败
  for (const kind of KINDS) {
    S(`[save][失败分类] 会话写失败按 ${kind} 归类，outcome 带原始 name 与 ≤200 字符 message，库里不留半条 ← char-session 分类 / types:save`, async ({ backend, inject }) => {
      await withFault(inject, kind, { at: 'session', times: Infinity }, async (fault) => {
        const outcome = await backend.sessions.save(sessionOf('s1'))
        assert.equal(outcome.failure.kind, kind)
        assert.equal(outcome.failure.name, fault.errorName)
        assert.ok(outcome.failure.message === undefined || outcome.failure.message.length <= 200)
        assert.equal(typeof outcome.failure.at, 'number')
        assert.ok(fault.hits() >= 1, '注入点没被走到')
      })
      assert.equal(await backend.sessions.get('s1'), undefined)
      assert.deepEqual(await backend.sessions.listSummaries(), [])
    }, { needs: ['inject'] })
  }

  S('[save][原子] 摘要写失败：会话详情也不留（同成同败）← char-session 原子性 / types:save「会话与摘要是一个原子单元」', async ({ backend, inject }) => {
    await withFault(inject, 'unknown', { at: 'summary', times: Infinity }, async (fault) => {
      const outcome = await backend.sessions.save(sessionOf('s1'))
      assert.equal(outcome.failure.kind, 'unknown')
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    assert.equal(await backend.sessions.get('s1'), undefined, '摘要没写上，会话也不能留（半写）')
    assert.deepEqual(await backend.sessions.listSummaries(), [])
  }, { needs: ['inject'] })

  S('[save][原子] 会话详情写失败：摘要也不留 ← types:save 原子单元（对称方向）', async ({ backend, inject }) => {
    await withFault(inject, 'unknown', { at: 'session', times: Infinity }, async () => {
      assert.equal((await backend.sessions.save(sessionOf('s1'))).failure.kind, 'unknown')
    })
    assert.deepEqual(await backend.sessions.listSummaries(), [])
    assert.deepEqual(await backend.sessions.listReferencing('anything'), [])
  }, { needs: ['inject'] })

  S('[save][原子] 失败不得覆盖已有的好数据：详情与摘要都保持旧值 ← char-session 剔除兜底 / types:save', async ({ backend, inject }) => {
    await seed(backend, sessionOf('s1', { title: '旧标题' }))
    await withFault(inject, 'unknown', { at: 'summary', times: Infinity }, async () => {
      assert.equal((await backend.sessions.save(sessionOf('s1', { title: '新标题' }))).failure.kind, 'unknown')
    })
    assert.equal((await backend.sessions.get('s1')).title, '旧标题')
    assert.equal((await backend.sessions.listSummaries())[0].title, '旧标题')
  }, { needs: ['inject'] })

  S('[save][原子] 会话写失败时同一次调用带的原件一个都不写，degradedFiles 为空 ← char-session 原子性 / types:save', async ({ backend, inject }) => {
    await withFault(inject, 'unknown', { at: 'session', times: Infinity }, async () => {
      const outcome = await backend.sessions.save(sessionOf('s1', { files: ['f1'] }), [stored('f1', '不该落')])
      assert.equal(outcome.failure.kind, 'unknown')
      assert.deepEqual(outcome.degradedFiles, [], '会话失败时不进入原件阶段')
    })
    assert.equal(await backend.blobs.get('f1'), undefined)
  }, { needs: ['inject'] })

  // ------------------------------------------------------------ 事务 B：原件只降级
  S('[save][降级] 原件写失败不回滚会话：failure 为 null，degradedFiles 逐个报 id / bytes / 分类 ← char-session 降级 / types:save', async ({ backend, inject }) => {
    const session = sessionOf('s1', { files: ['bad'] })
    const file = stored('bad', '坏的')
    await withFault(inject, 'unavailable', { at: 'blob', times: Infinity }, async (fault) => {
      const outcome = await backend.sessions.save(session, [file])
      assert.equal(outcome.failure, null, '原件失败不得回滚会话')
      assert.equal(outcome.degradedFiles.length, 1)
      const [degraded] = outcome.degradedFiles
      assert.equal(degraded.id, 'bad')
      assert.equal(degraded.bytes, file.blob.size)
      assert.equal(degraded.failure.kind, 'unavailable')
      assert.ok(fault.hits() >= 1)
    })
    assert.deepEqual(await backend.sessions.get('s1'), session, '会话已提交')
    assert.equal(await backend.blobs.get('bad'), undefined, '写失败的原件不在库里')
  }, { needs: ['inject'] })

  S('[save][降级] 批量原件里一个失败：会话照常提交；没被降级的原件都读得到，被降级的都读不到 ← char-session 降级批量 / types:save degradedFiles', async ({ backend, inject }) => {
    await withFault(inject, 'unavailable', { at: 'blob', id: 'bad', times: Infinity }, async () => {
      const outcome = await backend.sessions.save(sessionOf('s1'), [stored('good', '好'), stored('bad', '坏'), stored('good2', '好2')])
      assert.equal(outcome.failure, null)
      const degraded = new Set(outcome.degradedFiles.map((item) => item.id))
      assert.ok(degraded.has('bad'), '写失败的那个必须被报出')
      for (const id of ['good', 'bad', 'good2']) {
        const present = (await backend.blobs.get(id)) !== undefined
        assert.equal(present, !degraded.has(id), `${id}：降级 ⇔ 不在库里`)
      }
    })
  }, { needs: ['inject'] })

  S('[save][自愈] 原件配额失败：清孤儿后重试一次，成功则不算降级，孤儿被清 ← char-session 降级配额 / docs §4 决定', async ({ backend, inject }) => {
    await backend.blobs.putMany([stored('orphan', '孤儿')])
    await withFault(inject, 'quota', { at: 'blob', id: 'f1', times: 1 }, async (fault) => {
      const outcome = await backend.sessions.save(sessionOf('s1', { files: ['f1'] }), [stored('f1', '这次')])
      assert.equal(outcome.failure, null)
      assert.deepEqual(outcome.degradedFiles, [])
      assert.ok(fault.hits() >= 1)
    })
    assert.equal(await (await backend.blobs.get('f1')).text(), '这次')
    assert.equal(await backend.blobs.get('orphan'), undefined, '腾空间时无人引用的原件被清掉')
  }, { needs: ['inject'] })

  S('[save][自愈] keepFileIds 里的原件腾空间时必须避开，即使没有会话引用 ← char-session keepFileIds / SaveSessionOptions', async ({ backend, inject }) => {
    await backend.blobs.putMany([stored('pending', '刚排队')])
    await withFault(inject, 'quota', { at: 'blob', id: 'f1', times: 1 }, async () => {
      const outcome = await backend.sessions.save(sessionOf('s1'), [stored('f1', '新的')], { keepFileIds: ['pending'] })
      assert.deepEqual(outcome.degradedFiles, [])
    })
    assert.equal(await (await backend.blobs.get('pending')).text(), '刚排队', '没写进会话的原件不能当孤儿删')
  }, { needs: ['inject'] })

  S('[save][自愈] 清孤儿不碰仍被会话引用的原件，也不碰 attachment- 文档原件 ← db.ts sweepOrphanFiles 注释 / docs §4', async ({ backend, inject }) => {
    await seed(backend, sessionOf('keep', { files: ['used'] }), [stored('used', '在用')])
    await backend.blobs.putMany([{ id: attKey('x'.repeat(64)), blob: blobOf('文档', 'text/plain') }, stored('orphan')])
    await withFault(inject, 'quota', { at: 'blob', id: 'f1', times: 1 }, async () => {
      await backend.sessions.save(sessionOf('s1'), [stored('f1')])
    })
    assert.ok(await backend.blobs.get('used'))
    assert.ok(await backend.blobs.get(attKey('x'.repeat(64))))
    assert.equal(await backend.blobs.get('orphan'), undefined)
  }, { needs: ['inject'] })

  S('[save][自愈] 会话配额失败：清孤儿后重试恰好一次，第二次成功即落盘 ← char-session 配额重试 / docs §4', async ({ backend, inject }) => {
    await backend.blobs.putMany([stored('orphan', '孤儿')])
    await withFault(inject, 'quota', { at: 'session', times: 1 }, async (fault) => {
      const outcome = await backend.sessions.save(sessionOf('s1'))
      assert.equal(outcome.failure, null, '重试那一次成功就该算成功')
      assert.ok(fault.hits() >= 2, '至少写了两次（第一次失败 + 一次重试）')
    })
    assert.equal((await backend.sessions.get('s1')).id, 's1')
    assert.equal(await backend.blobs.get('orphan'), undefined, '重试前要先清孤儿')
  }, { needs: ['inject'] })

  S('[save][自愈] 重试仍失败：如实报 quota，只重试一次，不留半条会话 ← char-session 配额重试仍失败 / docs §4', async ({ backend, inject }) => {
    await withFault(inject, 'quota', { at: 'session', times: Infinity }, async (fault) => {
      const outcome = await backend.sessions.save(sessionOf('s1'))
      assert.equal(outcome.failure.kind, 'quota')
      assert.equal(outcome.failure.name, fault.errorName)
      // 第一次 + 重试一次。每次尝试对会话详情至多一次写；允许后端在重试前多写（如清扫），不允许无限重试
      assert.ok(fault.hits() <= 4, `重试爆炸：命中 ${fault.hits()} 次`)
    })
    assert.equal(await backend.sessions.get('s1'), undefined)
    assert.deepEqual(await backend.sessions.listSummaries(), [])
  }, { needs: ['inject'] })

  S('[save][自愈] 非配额失败不重试：unknown 只写一次 ← docs §4「其余不重试」', async ({ backend, inject }) => {
    await withFault(inject, 'unknown', { at: 'session', times: Infinity }, async (fault) => {
      await backend.sessions.save(sessionOf('s1'))
      assert.equal(fault.hits(), 1)
    })
  }, { needs: ['inject'] })

  // ------------------------------------------------------------ 不可克隆字段（入库前剔除）
  S('[save][剔除] 顶层函数字段被去掉后会话照常落盘，其余字段不丢，调用方对象不被改 ← char-session 剔除 / docs §4 错误映射', async ({ backend }) => {
    const session = sessionOf('s1', { stray: () => '坏', note: '留着' })
    const outcome = await backend.sessions.save(session)
    assert.equal(outcome.failure, null)
    const loaded = await backend.sessions.get('s1')
    assert.equal(Object.hasOwn(loaded, 'stray'), false)
    assert.equal(loaded.note, '留着')
    assert.equal(Object.hasOwn(session, 'stray'), true, '剔除只作用于副本')
    assert.ok((await backend.sessions.listSummaries()).length === 1)
  })

  S('[save][剔除] 消息成员里的函数只剔成员，消息条数与正文都在 ← char-session 剔除成员', async ({ backend }) => {
    const session = sessionOf('s1', { messages: [{ id: 'm1', role: 'user', content: '正文', files: [], createdAt: 1, onDone: () => {} }] })
    assert.equal((await backend.sessions.save(session)).failure, null)
    const loaded = await backend.sessions.get('s1')
    assert.equal(loaded.messages.length, 1)
    assert.equal(loaded.messages[0].content, '正文')
    assert.equal(Object.hasOwn(loaded.messages[0], 'onDone'), false)
  })

  S('[save][剔除] 能克隆性强制失败的后端：strippedFields 报出被剔除的路径 ← char-session 剔除 / SaveSessionOutcome.strippedFields', async ({ backend }) => {
    const outcome = await backend.sessions.save(sessionOf('s1', { stray: () => 1, messages: [{ id: 'm', role: 'user', content: '', files: [], createdAt: 1, cb: () => 1 }] }))
    assert.deepEqual([...outcome.strippedFields].sort(), ['messages[0].cb', 'stray'])
  }, { needs: ['cap.rejectsNonCloneable'] })

  S('[save][自愈] clone 失败且无可剔字段：整次失败 kind=clone，不留空壳 ← docs §4「clone 剔一次字段再试一次」/ char-session 剔除兜底', async ({ backend, inject }) => {
    await seed(backend, sessionOf('s1', { title: '旧' }))
    await withFault(inject, 'clone', { at: 'session', times: Infinity }, async () => {
      const outcome = await backend.sessions.save(sessionOf('s1', { title: '新' }))
      assert.equal(outcome.failure.kind, 'clone')
      assert.deepEqual(outcome.strippedFields, [])
    })
    assert.equal((await backend.sessions.get('s1')).title, '旧')
  }, { needs: ['inject'] })

  S('[save][原件] 带原件的 save：原件按 id 可读，且 listReferencing 反映会话引用 ← types:save', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['a', 'b'] }), [stored('a', 'A'), stored('b', 'B')])
    assert.equal(await (await backend.blobs.get('a')).text(), 'A')
    assert.deepEqual(await backend.sessions.listReferencing('b'), ['s1'])
    assert.deepEqual(ids(await backend.sessions.listSummaries()), ['s1'])
  })
}

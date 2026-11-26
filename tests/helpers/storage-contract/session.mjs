// SessionRepo 契约（读、置顶、重命名、删除级联、反查、分页）。写入（save）的原子边界与降级见 save.mjs。
// 来源标注：`char-session` / `char-staging` / `char-blob` = tests/unit/storage-char-*.test.mjs；`types:X` = types.ts 的方法注释。
import assert from 'node:assert/strict'
import { allItems, attKey, blobOf, byId, drain, fileRef, ids, memOf, SHA_A, sessionOf, seed, stored, userMsg, withFault } from './fixtures.mjs'

const SUMMARY_KEYS = ['id', 'title', 'createdAt', 'updatedAt', 'pinnedAt', 'branchOf']

export const register = (suite) => {
  const S = suite.case.bind(suite)

  S('[session][读] get 不存在返回 undefined；空库 listSummaries 为 [] ← char-session 边界 / types:get', async ({ backend }) => {
    assert.equal(await backend.sessions.get('nope'), undefined)
    assert.deepEqual(await backend.sessions.listSummaries(), [])
  })

  S('[session][往返] save 后 get 原样读回，outcome 全空 ← char-session 往返', async ({ backend }) => {
    const session = sessionOf('s1', { files: ['f1'] })
    const outcome = await backend.sessions.save(session, [stored('f1', '原件')])
    assert.deepEqual(outcome, { failure: null, degradedFiles: [], strippedFields: [] })
    assert.deepEqual(await backend.sessions.get('s1'), session)
    assert.equal(await (await backend.blobs.get('f1')).text(), '原件')
  })

  S('[session][往返] 空会话（messages 为空、rootMessageId 为 null）原样往返 ← char-session 空会话', async ({ backend }) => {
    const session = sessionOf('empty', { rootMessageId: null })
    await seed(backend, session)
    assert.deepEqual(await backend.sessions.get('empty'), session)
  })

  S('[session][往返] 同 id 重复 save 是覆盖：只有一条，内容是最后一次 ← char-session 幂等', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { title: '第一次' }))
    await seed(backend, sessionOf('s1', { title: '第二次' }))
    assert.equal((await backend.sessions.get('s1')).title, '第二次')
    assert.deepEqual(ids(await backend.sessions.listSummaries()), ['s1'])
  })

  S('[session][摘要] 摘要只含列表字段，不带 messages / fileIds；与会话同步 ← char-session 摘要同步 / types:listSummaries', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['f1'], pinnedAt: 99 }), [stored('f1')])
    const [summary] = await backend.sessions.listSummaries()
    assert.deepEqual(summary, { id: 's1', title: '标题-s1', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_001, pinnedAt: 99 })
    for (const key of Object.keys(summary)) assert.ok(SUMMARY_KEYS.includes(key), `摘要出现了非列表字段 ${key}`)
  })

  S('[session][摘要] 未置顶、非分支的会话，摘要里不凭空多出 pinnedAt / branchOf 键 ← char-session branchOf / commit 摘要形状', async ({ backend }) => {
    await seed(backend, sessionOf('plain'))
    const [summary] = await backend.sessions.listSummaries()
    assert.equal(Object.hasOwn(summary, 'pinnedAt'), false)
    assert.equal(Object.hasOwn(summary, 'branchOf'), false)
  })

  S('[session][摘要] listSummaries 返回全部会话（顺序不保证，types 未承诺排序）← types:listSummaries', async ({ backend }) => {
    for (const id of ['c', 'a', 'b']) await seed(backend, sessionOf(id))
    assert.deepEqual(ids([...(await backend.sessions.listSummaries())].sort(byId)), ['a', 'b', 'c'])
  })

  S('[session][pin] 置顶写入详情与摘要；传 undefined 取消，字段消失而不是 null ← char-session pin / types:pin', async ({ backend }) => {
    await seed(backend, sessionOf('s1'))
    await backend.sessions.pin('s1', 123)
    assert.equal((await backend.sessions.get('s1')).pinnedAt, 123)
    assert.equal((await backend.sessions.listSummaries())[0].pinnedAt, 123)
    await backend.sessions.pin('s1', undefined)
    const session = await backend.sessions.get('s1')
    assert.equal(session.pinnedAt, undefined)
    assert.notEqual(session.pinnedAt, null)
    assert.equal((await backend.sessions.listSummaries())[0].pinnedAt, undefined)
    assert.notEqual((await backend.sessions.listSummaries())[0].pinnedAt, null)
  })

  S('[session][pin/rename] 目标不存在：不抛错、不新建记录 ← char-session / types:pin 「不存在时什么都不做」', async ({ backend }) => {
    await backend.sessions.pin('ghost', 1)
    await backend.sessions.rename('ghost', 'x')
    assert.equal(await backend.sessions.get('ghost'), undefined)
    assert.deepEqual(await backend.sessions.listSummaries(), [])
  })

  S('[session][rename] 详情与摘要的标题一起改，其余字段不动 ← char-session rename / types:rename', async ({ backend }) => {
    const session = sessionOf('s1', { files: ['f1'], pinnedAt: 5 })
    await seed(backend, session, [stored('f1')])
    await backend.sessions.rename('s1', '新标题')
    assert.deepEqual(await backend.sessions.get('s1'), { ...session, title: '新标题' })
    const [summary] = await backend.sessions.listSummaries()
    assert.equal(summary.title, '新标题')
    assert.equal(summary.pinnedAt, 5)
    assert.deepEqual(await backend.sessions.listReferencing('f1'), ['s1'], 'rename 不得丢掉原件引用')
  })

  // ------------------------------------------------------------ delete 级联
  S('[session][delete] 会话与摘要一起删；别的会话一条不动 ← char-session delete / types:delete', async ({ backend }) => {
    const keep = sessionOf('keep')
    await seed(backend, keep)
    await seed(backend, sessionOf('drop'))
    await backend.sessions.delete('drop')
    assert.equal(await backend.sessions.get('drop'), undefined)
    assert.deepEqual(ids(await backend.sessions.listSummaries()), ['keep'])
    assert.deepEqual(await backend.sessions.get('keep'), keep)
  })

  S('[session][delete] 共享原件保留、独占原件删除 ← char-session delete 引用计数 / types:delete', async ({ backend }) => {
    await seed(backend, sessionOf('keep', { files: ['shared'] }), [stored('shared', '共用')])
    await seed(backend, sessionOf('drop', { files: ['shared', 'only-drop'] }), [stored('only-drop', '独占')])
    await backend.sessions.delete('drop')
    assert.equal(await (await backend.blobs.get('shared')).text(), '共用', '还有会话引用的原件必须留着')
    assert.equal(await backend.blobs.get('only-drop'), undefined, '引用归零的原件要删')
  })

  S('[session][delete] 级联只清「被删会话引用」的原件：无主的杂项原件不动 ← char-blob D1 / types:delete 边界', async ({ backend }) => {
    await seed(backend, sessionOf('drop', { files: ['mine'] }), [stored('mine')])
    await backend.blobs.putMany([stored('stray', '无主')])
    await backend.sessions.delete('drop')
    assert.equal(await backend.blobs.get('mine'), undefined)
    assert.ok(await backend.blobs.get('stray'), '不是本会话引用的原件不属于级联范围')
  })

  S('[session][delete] attachment- 文档原件与附件元数据 / 全文不在级联范围 ← char-blob D1 / types:delete「不包含」', async ({ backend }) => {
    const att = await backend.attachments.add({ id: 'att-1', filename: 'a.txt', mimeType: 'text/plain', size: 3, sha256: SHA_A, status: 'pending', createdAt: 1 }, blobOf('doc', 'text/plain'))
    const text = await backend.attachments.writeText({ sha256: SHA_A, parserVersion: 'p1', text: '全文', status: 'success' })
    await seed(backend, sessionOf('s1', { files: ['img'] }), [stored('img')])
    await backend.sessions.delete('s1')
    assert.ok(await backend.blobs.get(attKey(SHA_A)), '文档原件仍在')
    assert.deepEqual(await backend.attachments.get('att-1'), att)
    assert.deepEqual(await backend.attachments.readText(text.key), text)
  })

  S('[session][delete] 本会话的记忆一并清掉，别的会话的记忆留着 ← char-session delete 记忆 / types:delete', async ({ backend }) => {
    await seed(backend, sessionOf('drop'))
    await seed(backend, sessionOf('keep'))
    await backend.memory.put(memOf('drop', 'k'), [])
    await backend.memory.put(memOf('keep', 'k'), [])
    await backend.sessions.delete('drop')
    assert.deepEqual(await backend.memory.listBySession('drop'), [])
    assert.deepEqual(ids(await backend.memory.listBySession('keep')), ['keep:k'])
  })

  S('[session][delete] 不存在的会话静默成功，不误删其它数据 ← char-session delete 不存在', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['f1'] }), [stored('f1')])
    await backend.sessions.delete('missing')
    assert.deepEqual(ids(await backend.sessions.listSummaries()), ['s1'])
    assert.ok(await backend.blobs.get('f1'))
  })

  S('[session][delete] 删父会话不级联改写子会话的 branchOf ← char-session 删父会话', async ({ backend }) => {
    const branchOf = { sessionId: 'parent', messageId: 'm1', createdAt: 5 }
    await seed(backend, sessionOf('parent'))
    await seed(backend, sessionOf('child', { branchOf }))
    await backend.sessions.delete('parent')
    assert.deepEqual((await backend.sessions.get('child')).branchOf, branchOf)
    assert.deepEqual((await backend.sessions.listSummaries())[0].branchOf, branchOf)
  })

  S('[session][delete][原子] 级联中途写失败：会话 / 摘要 / 原件 / 记忆都还在，错误抛给调用方 ← char-session delete 原子性 / types:delete 原子单元', async ({ backend, inject }) => {
    const session = sessionOf('s1', { files: ['f1'] })
    await seed(backend, session, [stored('f1', '原件')])
    await backend.memory.put(memOf('s1', 'k'), [])
    await withFault(inject, 'unknown', { at: 'blob', times: Infinity }, async (fault) => {
      await assert.rejects(backend.sessions.delete('s1'), (error) => error?.name === fault.errorName)
      assert.ok(fault.hits() >= 1, '注入点没被走到：delete 没有写原件，断言空转')
    })
    assert.deepEqual(await backend.sessions.get('s1'), session)
    assert.equal(await (await backend.blobs.get('f1')).text(), '原件')
    assert.deepEqual(ids(await backend.memory.listBySession('s1')), ['s1:k'])
    assert.deepEqual(ids(await backend.sessions.listSummaries()), ['s1'])
  }, { needs: ['inject'] })

  S('[session][delete][原子] 清记忆失败同样整体回滚：会话还在 ← types:delete 原子单元含记忆', async ({ backend, inject }) => {
    await seed(backend, sessionOf('s1'))
    await backend.memory.put(memOf('s1', 'k'), [])
    await withFault(inject, 'unknown', { at: 'memory', times: Infinity }, async (fault) => {
      await assert.rejects(backend.sessions.delete('s1'))
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    assert.ok(await backend.sessions.get('s1'))
    assert.equal((await backend.memory.listBySession('s1')).length, 1)
    assert.equal((await backend.sessions.listSummaries()).length, 1)
  }, { needs: ['inject'] })

  // ------------------------------------------------------------ 反查
  S('[session][listReferencing] 只数 user 消息里的文件引用，去重，会话多个引用只出现一次 ← char-staging fileIds 重建 / types:listReferencing', async ({ backend }) => {
    const s = sessionOf('d', { files: ['x', 'y'] })
    s.messages.push(userMsg('d-u2', '再来', [fileRef('x'), fileRef('z')]))
    await seed(backend, s)
    await seed(backend, sessionOf('e', { files: ['x'] }))
    assert.deepEqual([...(await backend.sessions.listReferencing('x'))].sort(), ['d', 'e'])
    assert.deepEqual(await backend.sessions.listReferencing('z'), ['d'])
    assert.deepEqual(await backend.sessions.listReferencing('nobody'), [])
  })

  S('[session][listReferencing] 第二次 save 去掉附件后引用跟着变，旧原件仍在 ← char-session fileIds 维护', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['f1'] }), [stored('f1')])
    await seed(backend, sessionOf('s1'))
    assert.deepEqual(await backend.sessions.listReferencing('f1'), [])
    assert.ok(await backend.blobs.get('f1'), 'save 不删原件')
  })

  S('[session][listReferencing] 删会话后不再被反查到 ← types:listReferencing', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['f1'] }), [stored('f1')])
    await seed(backend, sessionOf('s2', { files: ['f1'] }))
    await backend.sessions.delete('s1')
    assert.deepEqual(await backend.sessions.listReferencing('f1'), ['s2'])
  })

  S('[session][listBranchesOf] 返回从某会话分叉出的摘要（带 branchOf），无分支返回 []，排序不保证 ← char-session branchOf / types:listBranchesOf', async ({ backend }) => {
    const b1 = { sessionId: 'p', messageId: 'm1', createdAt: 1 }
    const b2 = { sessionId: 'p', messageId: 'm2', createdAt: 2 }
    await seed(backend, sessionOf('p'))
    await seed(backend, sessionOf('c1', { branchOf: b1 }))
    await seed(backend, sessionOf('c2', { branchOf: b2 }))
    await seed(backend, sessionOf('other-child', { branchOf: { sessionId: 'q', messageId: 'm', createdAt: 3 } }))
    await seed(backend, sessionOf('plain'))
    const branches = [...(await backend.sessions.listBranchesOf('p'))].sort(byId)
    assert.deepEqual(ids(branches), ['c1', 'c2'])
    assert.deepEqual(branches.map((row) => row.branchOf), [b1, b2])
    assert.equal(Object.hasOwn(branches[0], 'messages'), false, '返回的是摘要，不带 messages')
    assert.deepEqual(await backend.sessions.listBranchesOf('plain'), [])
    assert.deepEqual(await backend.sessions.listBranchesOf('nobody'), [])
  })

  // ------------------------------------------------------------ listFull 分页
  const seedMany = async (backend, count) => {
    const keys = Array.from({ length: count }, (_, i) => `s${String(i).padStart(3, '0')}`)
    for (const id of keys) await seed(backend, sessionOf(id))
    return keys
  }

  S('[session][listFull] 空库：items 为空且 next 为 null ← types:Page', async ({ backend }) => {
    assert.deepEqual(await backend.sessions.listFull(), { items: [], next: null })
    assert.deepEqual(await backend.sessions.listFull({ limit: 3 }), { items: [], next: null })
  })

  S('[session][listFull] 不依赖默认 limit：顺着 next 读到 null，拼起来是全部、主键升序 ← types:listFull / PageQuery「缺省由实现定」', async ({ backend }) => {
    const keys = await seedMany(backend, 7)
    const items = await allItems((q) => backend.sessions.listFull(q))
    assert.deepEqual(ids(items), keys)
    assert.equal(Object.hasOwn(items[0], 'messages'), true, 'listFull 给的是完整会话')
  })

  S('[session][listFull] limit 分页：非末页满 limit 条且 next = 本页最后一条主键；拼起来不重不漏 ← types:Page / PageQuery', async ({ backend }) => {
    const keys = await seedMany(backend, 7)
    const pages = await drain((q) => backend.sessions.listFull(q), 3)
    assert.deepEqual(pages.map((page) => page.items.length), [3, 3, 1])
    assert.equal(pages[0].next, 's002')
    assert.equal(pages[1].next, 's005')
    assert.equal(pages[2].next, null)
    assert.deepEqual(pages.flatMap((page) => ids(page.items)), keys)
  })

  S('[session][listFull] 总数恰为 limit 整倍数：最后一页的 next 为 null，不多给一个空页 ← types:Page「next 为 null 表示没有下一页」', async ({ backend }) => {
    await seedMany(backend, 6)
    const pages = await drain((q) => backend.sessions.listFull(q), 3)
    assert.deepEqual(pages.map((page) => page.items.length), [3, 3])
    assert.equal(pages[1].next, null)
    const one = await backend.sessions.listFull({ limit: 6 })
    assert.equal(one.items.length, 6)
    assert.equal(one.next, null)
    assert.equal((await backend.sessions.listFull({ limit: 100 })).next, null)
  })

  S('[session][listFull] after 是游标不是偏移：after 之后一条不含 after 自身；after 指向末尾或更后返回空页 ← types:PageQuery', async ({ backend }) => {
    await seedMany(backend, 4)
    assert.deepEqual(ids((await backend.sessions.listFull({ after: 's001' })).items), ['s002', 's003'])
    assert.deepEqual(await backend.sessions.listFull({ after: 's003' }), { items: [], next: null })
    assert.deepEqual(await backend.sessions.listFull({ after: 'zzz' }), { items: [], next: null })
    assert.deepEqual(ids((await backend.sessions.listFull({ after: 's001', limit: 1 })).items), ['s002'])
  })

  S('[session][listFull] 读到一半有人删/插：游标不漏行不重复（after 的那一行被删也能续读）← types:Page 设计理由', async ({ backend }) => {
    await seedMany(backend, 6)
    const first = await backend.sessions.listFull({ limit: 3 })
    assert.deepEqual(ids(first.items), ['s000', 's001', 's002'])
    await backend.sessions.delete('s002') // 游标指向的那一行没了
    await seed(backend, sessionOf('s0015')) // 插在游标之前：续读不该再看到它
    await seed(backend, sessionOf('s0025')) // 插在游标之后：续读必须看到它
    const rest = await allItems((q) => backend.sessions.listFull(q), 2, first.next)
    assert.deepEqual(ids(rest), ['s0025', 's003', 's004', 's005'])
  })

  S('[session][listFull] 分页读出的会话与 get 一致 ← types:listFull', async ({ backend }) => {
    const sessions = [sessionOf('a', { files: ['f'] }), sessionOf('b', { pinnedAt: 3 }), sessionOf('c', { branchOf: { sessionId: 'a', messageId: 'm', createdAt: 1 } })]
    for (const s of sessions) await seed(backend, s, s.id === 'a' ? [stored('f')] : [])
    const all = await allItems((q) => backend.sessions.listFull(q), 2)
    assert.deepEqual(all, sessions)
  })

  S('[session][delete→反查] 反查用的是摘要里的引用：删 → 再存同 id 引用回来 ← types:listReferencing', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['f1'] }))
    await backend.sessions.delete('s1')
    assert.deepEqual(await backend.sessions.listReferencing('f1'), [])
    await seed(backend, sessionOf('s1', { files: ['f1'] }))
    assert.deepEqual(await backend.sessions.listReferencing('f1'), ['s1'])
  })
}

// StagingRepo 契约：暂存、commit（整包替换）、merge（增量合并）、attachment- 前缀保留。
// 暂存区不对外可读，只能经 commit / merge 的结果间接证明。
// 刻意不写进契约（放 idb-only，见 tests/unit/storage-contract-idb.test.mjs）：
//   空暂存 commit 清库（char-staging [commit][空包][现状]）、merge 覆盖丢 pinnedAt 与旧图成孤儿、
//   暂存残留不隔离、暂存里带 attachment- 键时的覆盖顺序 —— types.ts 没承诺，SQLite 不该被迫复刻。
import assert from 'node:assert/strict'
import { allItems, attKey, blobOf, chatOf, fileRef, ids, memOf, SHA_A, SHA_B, sessionOf, seed, snapshot, stage, stored, T0, userMsg, fold, withFault } from './fixtures.mjs'

const T = { older: T0 - 500, same: T0, newer: T0 + 500 }
const emptyPlan = { added: 0, overwritten: 0, skipped: 0, skippedTitles: [], written: [] }

const seedLocal = async (backend) => {
  await seed(backend, chatOf('L1', { updatedAt: T0 + 1000, files: ['img-L1'] }), [stored('img-L1', 'local-1')])
  await seed(backend, chatOf('L2', { updatedAt: T0 + 2000, files: ['img-L2'] }), [stored('img-L2', 'local-22')])
  await backend.blobs.putMany([{ id: attKey(SHA_A), blob: blobOf('附件原文', 'text/plain') }, stored('stray-no-owner', 'stray')])
  await backend.memory.put(memOf('L1', 'm0'), [])
}
const fullSnap = (backend) => snapshot(backend, { memoryOf: ['L1', 'L2', 'dup', 'keep'] })

export const register = (suite) => {
  const S = suite.case.bind(suite)

  // ------------------------------------------------------------ 暂存本身
  S('[staging][clear] 空暂存上重复调用不抛错；不碰正式库 ← char-staging 暂存 clearStaging / types:clear', async ({ backend }) => {
    await seedLocal(backend)
    const before = await fullSnap(backend)
    await backend.staging.clear()
    await backend.staging.clear()
    assert.deepEqual(await fullSnap(backend), before)
  })

  S('[staging][写] 写暂存不污染正式库（会话 / 摘要 / 原件 / 记忆一字节不动）← char-staging 暂存互不污染 / types:addSession', async ({ backend }) => {
    await seedLocal(backend)
    const before = await fullSnap(backend)
    await stage(backend, { sessions: [chatOf('N1', { files: ['p'] })], files: [stored('p', 'pkg')] })
    assert.deepEqual(await fullSnap(backend), before)
  })

  S('[staging][addSession] 键冲突抛错，先写入的保留（add 语义，不静默覆盖）← char-staging 暂存 add 语义 / types:addSession', async ({ backend }) => {
    await backend.staging.clear()
    await backend.staging.addSession(sessionOf('dup', { title: '第一次' }))
    await assert.rejects(backend.staging.addSession(sessionOf('dup', { title: '第二次' })))
    await backend.staging.commit()
    assert.equal((await backend.sessions.get('dup')).title, '第一次')
  })

  S('[staging][putFiles] 同 id 后写覆盖前写；空数组合法 ← char-staging saveStagingFiles / types:putFiles', async ({ backend }) => {
    await backend.staging.clear()
    await backend.staging.addSession(sessionOf('N', { files: ['f'] }))
    await backend.staging.putFiles([stored('f', 'old')])
    await backend.staging.putFiles([stored('f', 'new')])
    await backend.staging.putFiles([])
    await backend.staging.commit()
    assert.equal(await (await backend.blobs.get('f')).text(), 'new')
  })

  S('[staging][updateFileTypes] 回填暂存会话里 user 消息文件的 MIME，保留 isImage，assistant 消息原样；正式库不受影响 ← char-staging updateStagingFileTypes / types:updateFileTypes', async ({ backend }) => {
    await seedLocal(backend)
    const staged = chatOf('S1', { files: ['p1', 'p2'] })
    staged.messages[0].files[1] = fileRef('p2', { isImage: false, mimeType: 'application/x-old' })
    await stage(backend, { sessions: [staged] })
    const live = await fullSnap(backend)
    await backend.staging.updateFileTypes(new Map([['p1', 'image/jpeg'], ['p2', 'text/plain']]))
    assert.deepEqual(await fullSnap(backend), live, '回填只动暂存')
    await backend.staging.merge('merge')
    const got = await backend.sessions.get('S1')
    assert.deepEqual(got.messages[0].files.map((f) => [f.id, f.mimeType, f.isImage]), [['p1', 'image/jpeg', true], ['p2', 'text/plain', false]])
    assert.deepEqual(got.messages[1], staged.messages[1])
  })

  S('[staging][updateFileTypes] 表里没有的文件 id 回填成空串（types 明写 `types.get(id) ?? \'\'`）← types:updateFileTypes', async ({ backend }) => {
    await stage(backend, { sessions: [chatOf('S1', { files: ['hit', 'miss'] })] })
    await backend.staging.updateFileTypes(new Map([['hit', 'image/png']]))
    await backend.staging.merge('merge')
    const files = (await backend.sessions.get('S1')).messages[0].files
    assert.equal(files.find((f) => f.id === 'hit').mimeType, 'image/png')
    assert.equal(files.find((f) => f.id === 'miss').mimeType, '')
  })

  // ------------------------------------------------------------ commit
  S('[staging][commit] 整包替换：旧会话 / 摘要 / 聊天图片 / 记忆全换掉，新数据逐条到位 ← char-staging commit 整包替换 / types:commit', async ({ backend }) => {
    await seedLocal(backend)
    const incoming = [chatOf('N1', { title: '新一', updatedAt: T0 + 10, files: ['img-N1'] }), chatOf('N2', { title: '新二', updatedAt: T0 + 20 })]
    await stage(backend, { sessions: incoming, files: [stored('img-N1', 'n1-bytes')] })
    const summaries = await backend.staging.commit()
    const all = await allItems((q) => backend.sessions.listFull(q), 10)
    assert.deepEqual(all, incoming, '会话记录原样落库')
    assert.deepEqual(await backend.memory.listBySession('L1'), [], '#399：旧会话记忆随整包替换清空')
    assert.deepEqual(await backend.sessions.listReferencing('img-N1'), ['N1'])
    assert.equal(await (await backend.blobs.get('img-N1')).text(), 'n1-bytes')
    for (const gone of ['img-L1', 'img-L2', 'stray-no-owner']) assert.equal(await backend.blobs.get(gone), undefined, `${gone} 应被替换掉`)
    assert.deepEqual([...summaries].sort((a, b) => (a.id < b.id ? -1 : 1)), [...(await backend.sessions.listSummaries())].sort((a, b) => (a.id < b.id ? -1 : 1)), '返回值 = 提交后读出的摘要')
  })

  S('[staging][commit] 提交后暂存已清空：再 commit 一次得到空库而不是重放旧包 ← char-staging commit / types:commit「两个暂存区最后清空」', async ({ backend }) => {
    await stage(backend, { sessions: [sessionOf('N')], files: [stored('x')] })
    await backend.staging.commit()
    // 空暂存的 commit 语义（清库）不写进契约；这里只看「重放旧包」不会发生：N 以外没有新增的东西
    await backend.staging.merge('merge')
    assert.deepEqual(ids(await backend.sessions.listSummaries()), ['N'])
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['x'])
  })

  S('[staging][commit] 返回的摘要只含摘要字段（无 messages / fileIds），带 pinnedAt / branchOf ← char-staging commit 返回摘要形状 / types:commit', async ({ backend }) => {
    const branchOf = { sessionId: 'parent', messageId: 'm1', createdAt: T0 }
    await stage(backend, { sessions: [sessionOf('c'), sessionOf('a', { pinnedAt: T0 + 5 }), sessionOf('b', { branchOf })] })
    const byIdMap = Object.fromEntries((await backend.staging.commit()).map((row) => [row.id, row]))
    assert.deepEqual(byIdMap.a, { id: 'a', title: '标题-a', createdAt: T0, updatedAt: T0 + 1, pinnedAt: T0 + 5 })
    assert.deepEqual(byIdMap.b, { id: 'b', title: '标题-b', createdAt: T0, updatedAt: T0 + 1, branchOf })
    for (const row of Object.values(byIdMap)) {
      assert.equal(Object.hasOwn(row, 'messages'), false)
      assert.equal(Object.hasOwn(row, 'fileIds'), false)
    }
    assert.equal(Object.hasOwn(byIdMap.c, 'pinnedAt'), false)
    assert.equal(Object.hasOwn(byIdMap.c, 'branchOf'), false)
  })

  S('[staging][commit] 摘要里的原件引用重建：按 user 消息去重，listReferencing 可反查 ← char-staging fileIds 重建 / types:commit', async ({ backend }) => {
    const session = chatOf('d', { files: ['x', 'y'] })
    session.messages.push(userMsg('d-u2', '再来', [fileRef('x'), fileRef('z')]))
    await stage(backend, { sessions: [session] })
    await backend.staging.commit()
    for (const id of ['x', 'y', 'z']) assert.deepEqual(await backend.sessions.listReferencing(id), ['d'], id)
  })

  S('[staging][commit][前缀] attachment- 键的文档原件整包替换后原地保留（含无人引用的），字节不变，附件元数据不动 ← char-staging commit blob 前缀 #531 / types:commit', async ({ backend }) => {
    const other = attKey(SHA_B)
    await backend.blobs.putMany([{ id: attKey(SHA_A), blob: blobOf('原件甲', 'text/plain') }, { id: other, blob: blobOf('无人引用的原件乙', 'text/plain') }, stored('plain-image', '图')])
    await backend.attachments.put({ id: 'att-1', filename: 'a', mimeType: 'text/plain', size: 1, sha256: SHA_A, localPath: attKey(SHA_A), status: 'pending', createdAt: 1 })
    await stage(backend, { sessions: [sessionOf('N')] })
    await backend.staging.commit()
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))).sort(), [attKey(SHA_A), other].sort())
    assert.deepEqual(await fold(await backend.blobs.get(attKey(SHA_A))), { type: 'text/plain', size: 9, text: '原件甲' })
    assert.deepEqual(ids(await backend.attachments.list()), ['att-1'], '附件元数据不在替换范围')
  })

  S('[staging][commit][前缀] 前缀判定只看「以 attachment- 开头」：大小写 / 中间含 / 仅前缀以外的近似键按聊天图片处理 ← char-staging commit blob 前缀边界 / blobKeys.ts', async ({ backend }) => {
    await backend.blobs.putMany([stored('Attachment-upper'), stored('x-attachment-mid'), stored('attachment'), stored('plain')])
    await stage(backend, { sessions: [sessionOf('N')] })
    await backend.staging.commit()
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [], '近似前缀的键都不属于文档原件，被替换掉')
  })

  S('[staging][commit][前缀] 记忆整表清空（含没有对应会话的孤儿记忆）← char-blob C5 / types:commit', async ({ backend }) => {
    await backend.memory.put(memOf('ghost', 'k'), [])
    await seed(backend, sessionOf('L'))
    await backend.memory.put(memOf('L', 'k'), [])
    await stage(backend, { sessions: [sessionOf('N')] })
    await backend.staging.commit()
    assert.deepEqual(await backend.memory.listBySession('ghost'), [])
    assert.deepEqual(await backend.memory.listBySession('L'), [])
  })

  S('[staging][commit] 大包：300 条会话 + 60 张图全部落库、摘要与会话一一对应 ← char-staging commit 超大包', async ({ backend }) => {
    const sessions = Array.from({ length: 300 }, (_, i) => sessionOf(`c-${String(i).padStart(3, '0')}`, { files: i < 60 ? [`img-${i}`] : [] }))
    await stage(backend, { sessions, files: Array.from({ length: 60 }, (_, i) => stored(`img-${i}`, `b${i}`)) })
    const summaries = await backend.staging.commit()
    assert.equal(summaries.length, 300)
    assert.equal((await allItems((q) => backend.sessions.listFull(q), 64)).length, 300)
    assert.equal((await allItems((q) => backend.blobs.listKeys(q), 64)).length, 60)
    assert.equal((await backend.sessions.listSummaries()).length, 300)
  })

  // ------------------------------------------------------------ commit 原子回滚
  const rollbackPoints = [
    ['写会话（第 2 条）', { at: 'session', nth: 2 }, 'quota'],
    ['写摘要', { at: 'summary', nth: 1 }, 'unknown'],
    ['写图片', { at: 'blob', id: 'img-N1' }, 'quota'],
    ['清旧图片', { at: 'blob', id: 'img-L1' }, 'unknown'],
    ['清记忆', { at: 'memory', nth: 1 }, 'unknown'],
    ['清暂存', { at: 'staging', nth: 1 }, 'unknown'],
  ]
  for (const [label, where, kind] of rollbackPoints) {
    S(`[staging][commit][回滚] ${label}失败（${kind}）：正式库整库逐条不变，错误抛给调用方 ← char-rollback commit 回滚 / types:commit 原子单元`, async ({ backend, inject }) => {
      await seedLocal(backend)
      await stage(backend, { sessions: [chatOf('N1', { files: ['img-N1'] }), chatOf('N2'), chatOf('N3')], files: [stored('img-N1', 'n1'), stored('img-N2', 'n2')] })
      const before = await fullSnap(backend)
      await withFault(inject, kind, { ...where, times: Infinity }, async (fault) => {
        await assert.rejects(backend.staging.commit(), (error) => error?.name === fault.errorName)
        assert.ok(fault.hits() >= (where.nth ?? 1), `注入点没被走到（${label}）：断言空转`)
      })
      assert.deepEqual(await fullSnap(backend), before, '失败后正式库逐条等于失败前')
      assert.deepEqual(ids(await backend.sessions.listSummaries()).sort(), ['L1', 'L2'])
    }, { needs: ['inject'] })
  }

  S('[staging][commit][回滚] 失败后立即重试同一份暂存可以成功（暂存没被半途消耗）← char-rollback commit 重试 / types:commit', async ({ backend, inject }) => {
    await seedLocal(backend)
    await stage(backend, { sessions: [sessionOf('N1'), sessionOf('N2')] })
    await withFault(inject, 'quota', { at: 'session', nth: 2, times: Infinity }, async () => {
      await assert.rejects(backend.staging.commit())
    })
    assert.deepEqual(ids(await backend.staging.commit()), ['N1', 'N2'])
    assert.deepEqual(ids(await backend.sessions.listSummaries()).sort(), ['N1', 'N2'])
  }, { needs: ['inject'] })

  // ------------------------------------------------------------ merge
  const seedMergeLocal = async (backend) => {
    await seed(backend, chatOf('keep', { updatedAt: T0, files: ['img-keep'], pinnedAt: T0 + 9 }), [stored('img-keep', 'keep-local')])
    await seed(backend, chatOf('dup', { title: '本地版', updatedAt: T0, files: ['img-dup-local'], pinnedAt: T0 + 7 }), [stored('img-dup-local', 'dup-local')])
    await backend.blobs.putMany([{ id: attKey(SHA_A), blob: blobOf('附件原文', 'text/plain') }])
    await backend.memory.put(memOf('dup', 'm0'), [])
  }

  S('[staging][merge][merge 策略] 新增 / 包内更新 / 时间相同 → 写入；包内更旧 → 跳过；plan 形状 ← char-staging merge 策略 / MergePlan', async ({ backend }) => {
    for (const [id, title] of [['ov', '本地ov'], ['eq', '本地eq'], ['old', '本地old']]) await seed(backend, sessionOf(id, { updatedAt: T0, title }))
    await stage(backend, {
      sessions: [sessionOf('eq', { updatedAt: T.same, title: '包内eq' }), sessionOf('fresh', { updatedAt: T.older, title: '包内fresh' }), sessionOf('old', { updatedAt: T.older, title: '包内old' }), sessionOf('ov', { updatedAt: T.newer, title: '包内ov' })],
    })
    const plan = await backend.staging.merge('merge')
    assert.equal(plan.added, 1)
    assert.equal(plan.overwritten, 2)
    assert.equal(plan.skipped, 1)
    assert.deepEqual(plan.skippedTitles, ['包内old'])
    assert.deepEqual([...plan.written].sort(), ['eq', 'fresh', 'ov'], 'written 的顺序 types 未承诺，只比集合')
    const titles = Object.fromEntries((await allItems((q) => backend.sessions.listFull(q))).map((s) => [s.id, s.title]))
    assert.deepEqual(titles, { eq: '包内eq', fresh: '包内fresh', old: '本地old', ov: '包内ov' })
    const summaryTitles = Object.fromEntries((await backend.sessions.listSummaries()).map((s) => [s.id, s.title]))
    assert.deepEqual(summaryTitles, titles, '摘要与会话同步（被跳过的保持本地版）')
  })

  S('[staging][merge][skip 策略] 本地已有同 id 一律保留（哪怕包内更新）；本地没有的新增 ← char-staging merge skip / MergePolicy', async ({ backend }) => {
    await seed(backend, sessionOf('dup', { updatedAt: T0, title: '本地版' }))
    await stage(backend, { sessions: [sessionOf('dup', { updatedAt: T.newer, title: '包内更新版' }), sessionOf('new', { title: '全新' })] })
    const plan = await backend.staging.merge('skip')
    assert.deepEqual(plan, { added: 1, overwritten: 0, skipped: 1, skippedTitles: ['包内更新版'], written: ['new'] })
    assert.equal((await backend.sessions.get('dup')).title, '本地版')
    assert.equal((await backend.sessions.get('new')).title, '全新')
  })

  S('[staging][merge][搬原件] 只搬被写入会话引用的原件；被跳过会话的、无人引用的都不落库；暂存随后清空 ← char-staging merge 互不污染 / types:merge「被跳过的会话不搬它的原件」', async ({ backend }) => {
    await seedMergeLocal(backend)
    await stage(backend, {
      sessions: [chatOf('dup', { title: '包内旧', updatedAt: T.older, files: ['img-dup-pkg'] }), chatOf('added', { files: ['img-added'] })],
      files: [stored('img-dup-pkg', 'pkg-skipped'), stored('img-added', 'pkg-added'), stored('img-unreferenced', 'no-owner')],
    })
    const before = await fullSnap(backend)
    const plan = await backend.staging.merge('merge')
    assert.deepEqual([plan.added, plan.overwritten, plan.skipped, plan.written], [1, 0, 1, ['added']])
    const after = await fullSnap(backend)
    assert.deepEqual(Object.keys(after.blobs).sort(), [attKey(SHA_A), 'img-added', 'img-dup-local', 'img-keep'].sort())
    assert.deepEqual(after.sessions.find((s) => s.id === 'keep'), before.sessions.find((s) => s.id === 'keep'))
    assert.deepEqual(after.sessions.find((s) => s.id === 'dup'), before.sessions.find((s) => s.id === 'dup'), '被跳过的会话字节不变')
    assert.deepEqual(after.memory, before.memory, 'merge 不碰记忆')
    assert.deepEqual(await backend.sessions.listReferencing('img-added'), ['added'])
    // 暂存已清：再合并一次是空包
    assert.deepEqual(await backend.staging.merge('merge'), emptyPlan)
  })

  S('[staging][merge][搬原件] 多个会话共用同一原件 id：有一个被写入就搬，全被跳过则不搬 ← char-staging merge 共用图片', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { updatedAt: T0 }))
    await seed(backend, sessionOf('s2', { updatedAt: T0 }))
    await stage(backend, { sessions: [sessionOf('s1', { updatedAt: T.older, files: ['shared'] }), sessionOf('s2', { updatedAt: T.older, files: ['shared'] }), sessionOf('s3', { files: ['shared'] })], files: [stored('shared', 'x')] })
    assert.deepEqual((await backend.staging.merge('merge')).written, ['s3'])
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['shared'])
    await backend.blobs.clearExcept(() => false)
    await stage(backend, { sessions: [sessionOf('s1', { updatedAt: T.older, files: ['shared'] })], files: [stored('shared', 'x')] })
    await backend.staging.merge('merge')
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [], '全被跳过 → 不留孤儿原件')
  })

  S('[staging][merge][不碰记忆] 覆盖 / 新增都不动任何会话的记忆 ← char-blob C5 / types:merge「也不碰记忆」', async ({ backend }) => {
    await seedMergeLocal(backend)
    await stage(backend, { sessions: [sessionOf('dup', { updatedAt: T.newer }), sessionOf('fresh')] })
    await backend.staging.merge('merge')
    assert.deepEqual(ids(await backend.memory.listBySession('dup')), ['dup:m0'])
  })

  S('[staging][merge][幂等] 同一份包连续合并两次：第二次全部按「时间相同 → 覆盖」，数据与第一次后相同；skip 下全部跳过 ← char-staging merge 幂等', async ({ backend }) => {
    const pkg = [sessionOf('a', { updatedAt: T0 }), sessionOf('b', { updatedAt: T0 + 1 })]
    await stage(backend, { sessions: pkg })
    const first = await backend.staging.merge('merge')
    const afterFirst = await fullSnap(backend)
    await stage(backend, { sessions: pkg })
    const second = await backend.staging.merge('merge')
    assert.deepEqual([first.added, first.overwritten, first.skipped], [2, 0, 0])
    assert.deepEqual([second.added, second.overwritten, second.skipped], [0, 2, 0])
    assert.deepEqual(await fullSnap(backend), afterFirst)
    await stage(backend, { sessions: pkg })
    assert.equal((await backend.staging.merge('skip')).skipped, 2)
  })

  S('[staging][merge][空包] 暂存为空：返回全零 plan，正式数据一字节不动 ← char-staging merge 空包 / types:merge', async ({ backend }) => {
    await seedMergeLocal(backend)
    await backend.staging.clear()
    const before = await fullSnap(backend)
    for (const policy of ['merge', 'skip']) assert.deepEqual(await backend.staging.merge(policy), emptyPlan)
    assert.deepEqual(await fullSnap(backend), before)
  })

  S('[staging][merge][大包] 200 条（半数与本地冲突）：计数、written 集合、落库条数都对 ← char-staging merge 超大包', async ({ backend }) => {
    const local = Array.from({ length: 100 }, (_, i) => sessionOf(`m-${String(i).padStart(3, '0')}`, { updatedAt: T0 + (i % 2 === 0 ? 1000 : -1000) }))
    for (const s of local) await seed(backend, s)
    await stage(backend, { sessions: Array.from({ length: 200 }, (_, i) => sessionOf(`m-${String(i).padStart(3, '0')}`, { updatedAt: T0, title: `包-${i}` })) })
    const plan = await backend.staging.merge('merge')
    assert.deepEqual([plan.added, plan.overwritten, plan.skipped], [100, 50, 50])
    assert.equal(plan.skippedTitles.length, 50)
    assert.equal(plan.written.length, 150)
    assert.equal((await backend.sessions.listSummaries()).length, 200)
  })

  // ------------------------------------------------------------ merge 原子回滚
  const mergePoints = [
    ['写会话（第 2 条）', { at: 'session', nth: 2 }, 'quota'],
    ['写摘要', { at: 'summary', nth: 1 }, 'unknown'],
    ['搬原件', { at: 'blob', nth: 1 }, 'quota'],
    ['清暂存', { at: 'staging', nth: 1 }, 'unknown'],
  ]
  for (const [label, where, kind] of mergePoints) {
    S(`[staging][merge][回滚] ${label}失败（${kind}）：已写入的一并回滚，正式库逐条等于失败前 ← char-rollback merge 回滚 / types:merge 原子单元`, async ({ backend, inject }) => {
      await seedMergeLocal(backend)
      await stage(backend, {
        sessions: [chatOf('dup', { title: '包内新', updatedAt: T.newer, files: ['img-p1'] }), chatOf('n1', { files: ['img-p2'] }), chatOf('n2')],
        files: [stored('img-p1', 'p1'), stored('img-p2', 'p2')],
      })
      const before = await fullSnap(backend)
      await withFault(inject, kind, { ...where, times: Infinity }, async (fault) => {
        await assert.rejects(backend.staging.merge('merge'), (error) => error?.name === fault.errorName)
        assert.ok(fault.hits() >= (where.nth ?? 1), `注入点没被走到（${label}）：断言空转`)
      })
      assert.deepEqual(await fullSnap(backend), before)
    }, { needs: ['inject'] })
  }
}

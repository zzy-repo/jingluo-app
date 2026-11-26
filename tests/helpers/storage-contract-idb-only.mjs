// IDB 专属用例（不属于跨后端契约）：特征化测试里「看似 bug、先钉死」的现状，以及 types.ts 没有承诺的语义。
// 它们仍只经 `StorageBackend` 接口断言，但 SQLite 不必复刻：SQLite 想改掉这些行为时，改的是这里，不是契约。
// 每条标注来源，并说明「为什么不进契约」。runner 通过 `runStorageContract({ extra: [registerIdbOnly] })` 注册。
import assert from 'node:assert/strict'
import { attKey, blobOf, chatOf, ids, memOf, sessionOf, seed, stage, stored, T0, withFault } from './storage-contract/fixtures.mjs'

export const registerIdbOnly = (suite) => {
  const S = suite.case.bind(suite)

  S('[idbOnly][commit 空包] 空暂存 commit 会清空正式库（会话 / 摘要 / 聊天原件 / 记忆），attachment- 原件保留 ← char-staging [commit][空包][现状]；不进契约：types 只说「整包替换」，没承诺空包等于清库', async ({ backend }) => {
    await seed(backend, sessionOf('L1', { files: ['img'] }), [stored('img')])
    await backend.memory.put(memOf('L1', 'k'), [])
    await backend.blobs.putMany([{ id: attKey('a'.repeat(64)), blob: blobOf('doc', 'text/plain') }])
    await backend.staging.clear()
    assert.deepEqual(await backend.staging.commit(), [])
    assert.deepEqual(await backend.sessions.listSummaries(), [])
    assert.deepEqual(await backend.memory.listBySession('L1'), [])
    assert.deepEqual((await backend.blobs.listKeys()).items, [attKey('a'.repeat(64))])
  })

  S('[idbOnly][merge 覆盖] 覆盖整条替换：本地 pinnedAt 丢失，旧图片原件成为无主原件，被覆盖会话的旧记忆不清 ← char-staging [merge][现状]；不进契约：看似 bug，types 未承诺', async ({ backend }) => {
    await seed(backend, chatOf('dup', { updatedAt: T0, pinnedAt: T0 + 7, files: ['img-local'] }), [stored('img-local')])
    await backend.memory.put(memOf('dup', 'm'), [])
    await stage(backend, { sessions: [chatOf('dup', { title: '包内新', updatedAt: T0 + 500, files: ['img-pkg'] })], files: [stored('img-pkg')] })
    await backend.staging.merge('merge')
    const session = await backend.sessions.get('dup')
    assert.equal(Object.hasOwn(session, 'pinnedAt'), false)
    assert.equal(Object.hasOwn((await backend.sessions.listSummaries())[0], 'pinnedAt'), false)
    assert.ok(await backend.blobs.get('img-local'), '旧图片留成孤儿')
    assert.equal((await backend.memory.listBySession('dup')).length, 1)
  })

  S('[idbOnly][merge 残留] 上次中断的暂存不隔离，会被一并合并 ← char-staging [merge][暂存残留]；不进契约：types 没规定暂存残留的归属', async ({ backend }) => {
    await stage(backend, { sessions: [sessionOf('stale')], files: [stored('stale-img')] })
    await stage(backend, { sessions: [sessionOf('fresh')], clear: false })
    assert.deepEqual([...(await backend.staging.merge('merge')).written].sort(), ['fresh', 'stale'])
  })

  S('[idbOnly][merge written 顺序] written 按会话 id 升序 ← char-staging merge 超大包；不进契约：types 未承诺顺序', async ({ backend }) => {
    await stage(backend, { sessions: [sessionOf('b'), sessionOf('c'), sessionOf('a')] })
    assert.deepEqual((await backend.staging.merge('merge')).written, ['a', 'b', 'c'])
  })

  S('[idbOnly][putMany 非原子] 批量写原件一条失败，已排队的先写入仍会提交（只抛错，不回滚前面的）← char-session「saveFiles 非原子（现状）」；与 types:putMany 「要么全写入要么全不写入」相反，见回复「接口/实现矛盾」', async ({ backend, inject }) => {
    await withFault(inject, 'unknown', { at: 'blob', id: 'f2', times: Infinity }, async () => {
      await assert.rejects(backend.blobs.putMany([stored('f1'), stored('f2'), stored('f3')]))
    })
    assert.ok(await backend.blobs.get('f1'), '【现状】失败前排队的 put 已提交')
  }, { needs: ['inject'] })

  S('[idbOnly][memory 入口] 非法 sessionId / 空 key 在仓储层不校验，原样落库 ← char-blob C3 在 sessionMemory.ts 的入口校验不在仓储里；不进契约：types 没规定', async ({ backend }) => {
    await backend.memory.put(memOf('s', ''), [])
    assert.equal((await backend.memory.listBySession('s')).length, 1)
  })

  S('[idbOnly][close 之后 health] 关闭后 health 返回 {ok:false, initFailure:"unavailable"} ← backend.ts 实现；不进契约：types:close「任何方法调用都应抛」与 health「不抛错」冲突，契约只断言不抛错', async ({ backend }) => {
    await backend.close()
    assert.deepEqual(await backend.health(), { ok: false, initFailure: 'unavailable' })
  })

  S('[idbOnly][读到自己的写] 批内读得到本批尚未提交的写 ← IDB 事务语义；不进契约：types 没承诺 read-your-writes', async ({ backend }) => {
    const seen = await backend.runAtomic(async (repos) => {
      await repos.blobs.putMany([stored('inside', 'x')])
      return (await repos.blobs.get('inside')) !== undefined
    })
    assert.equal(seen, true)
  })

  S('[idbOnly][并发 runAtomic] 两个并发批各写不相交的键，都成功；其中一个失败不影响另一个 ← IDB 事务排队；不进契约：types 没规定并发批的可见性与排队', async ({ backend }) => {
    const boom = new Error('b 失败')
    const [a, b] = await Promise.allSettled([
      backend.runAtomic((repos) => repos.blobs.putMany([stored('a')])),
      backend.runAtomic(async (repos) => {
        await repos.blobs.putMany([stored('b')])
        throw boom
      }),
    ])
    assert.equal(a.status, 'fulfilled')
    assert.equal(b.reason, boom)
    assert.deepEqual((await backend.blobs.listKeys()).items, ['a'])
  })

  S('[idbOnly][listFull 默认 limit] 不传 limit 返回全部 ← docs §6.3 默认决定；不进契约：types:PageQuery 写「调用方不该依赖不传就全给」，两处文字冲突', async ({ backend }) => {
    for (let i = 0; i < 120; i += 1) await seed(backend, sessionOf(`s${String(i).padStart(3, '0')}`))
    const page = await backend.sessions.listFull()
    assert.equal(page.items.length, 120)
    assert.equal(page.next, null)
    assert.deepEqual(ids(page.items).slice(0, 2), ['s000', 's001'])
  })
}

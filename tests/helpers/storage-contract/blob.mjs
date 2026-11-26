// BlobRepo 与 AssetRepo 契约。
// 刻意不断言：`putMany` 失败后「前面几个是否已提交」（char-session「saveFiles 非原子（现状）」是 IDB 的怪癖，
// 与 types:putMany「要么全写入要么全不写入」的承诺相反；契约只认注释里的承诺，该怪癖见 idb-only 用例）。
import assert from 'node:assert/strict'
import { allItems, attKey, blobOf, drain, fold, SHA_A, SHA_B, stored, withFault } from './fixtures.mjs'

export const register = (suite) => {
  const S = suite.case.bind(suite)

  // ------------------------------------------------------------ BlobRepo
  S('[blob][读] get 不存在返回 undefined；空库 listKeys 为空页 ← char-session saveFiles/loadFile / types:get', async ({ backend }) => {
    assert.equal(await backend.blobs.get('missing'), undefined)
    assert.deepEqual(await backend.blobs.listKeys(), { items: [], next: null })
  })

  S('[blob][往返] putMany 后 get 读回字节与 MIME；同 id 覆盖而不是追加 ← char-session saveFiles/loadFile / types:putMany', async ({ backend }) => {
    await backend.blobs.putMany([stored('f1', '你好'), stored('f2', '世界', 'text/plain')])
    assert.deepEqual(await fold(await backend.blobs.get('f1')), { type: 'image/png', size: 6, text: '你好' })
    assert.equal((await backend.blobs.get('f2')).type, 'text/plain')
    await backend.blobs.putMany([stored('f1', '覆盖')])
    assert.equal(await (await backend.blobs.get('f1')).text(), '覆盖')
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))).sort(), ['f1', 'f2'])
  })

  S('[blob][putMany] 空数组是合法的空操作 ← char-staging saveStagingFiles 空数组 / types:putMany', async ({ backend }) => {
    await backend.blobs.putMany([])
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [])
  })

  S('[blob][原子] putMany 一条失败则整批不落盘，错误抛给调用方 ← types:putMany「要么全写入要么全不写入」', async ({ backend, inject }) => {
    await backend.blobs.putMany([stored('old', '旧')])
    await withFault(inject, 'unknown', { at: 'blob', id: 'f2', times: Infinity }, async (fault) => {
      await assert.rejects(backend.blobs.putMany([stored('f1', '甲'), stored('f2', '乙'), stored('f3', '丙')]), (error) => error?.name === fault.errorName)
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    for (const id of ['f1', 'f2', 'f3']) assert.equal(await backend.blobs.get(id), undefined, `${id} 不应落盘`)
    assert.equal(await (await backend.blobs.get('old')).text(), '旧', '批外的旧数据不动')
  }, { needs: ['inject'] })

  S('[blob][delete] 删除一个原件；不存在不抛错；别的不动 ← types:delete', async ({ backend }) => {
    await backend.blobs.putMany([stored('a'), stored('b')])
    await backend.blobs.delete('a')
    await backend.blobs.delete('a')
    await backend.blobs.delete('never')
    assert.equal(await backend.blobs.get('a'), undefined)
    assert.ok(await backend.blobs.get('b'))
  })

  const keys = (n) => Array.from({ length: n }, (_, i) => `k${String(i).padStart(3, '0')}`)

  S('[blob][listKeys] 不依赖默认 limit：顺着 next 读完是全部键，且各页内与页间升序 ← types:listKeys / PageQuery', async ({ backend }) => {
    await backend.blobs.putMany(['k2', 'k0', 'k1', 'Z'].map((id) => stored(id)))
    const all = await allItems((q) => backend.blobs.listKeys(q))
    assert.deepEqual([...all].sort(), ['Z', 'k0', 'k1', 'k2'])
    assert.deepEqual(all, [...all].sort(), '同一后端内部按键升序（字节序；排序口径 types 只说「主键升序」，见回复）')
  })

  S('[blob][listKeys] limit 分页：next = 本页最后一个键，拼起来不重不漏；整倍数时末页 next 为 null ← types:Page / PageQuery', async ({ backend }) => {
    const all = keys(7)
    await backend.blobs.putMany(all.map((id) => stored(id)))
    const pages = await drain((q) => backend.blobs.listKeys(q), 3)
    assert.deepEqual(pages.map((page) => page.items.length), [3, 3, 1])
    assert.equal(pages[0].next, 'k002')
    assert.equal(pages[2].next, null)
    assert.deepEqual(pages.flatMap((page) => [...page.items]), all)
    const even = await drain((q) => backend.blobs.listKeys(q), 7)
    assert.deepEqual(even.map((page) => page.items.length), [7])
    assert.equal(even[0].next, null)
  })

  S('[blob][listKeys] after 是游标：不含 after 自身；越过末尾返回空页；after 的键被删后仍可续读 ← types:PageQuery', async ({ backend }) => {
    await backend.blobs.putMany(keys(5).map((id) => stored(id)))
    assert.deepEqual((await backend.blobs.listKeys({ after: 'k002' })).items, ['k003', 'k004'])
    assert.deepEqual(await backend.blobs.listKeys({ after: 'k004' }), { items: [], next: null })
    assert.deepEqual(await backend.blobs.listKeys({ after: 'zzz' }), { items: [], next: null })
    const first = await backend.blobs.listKeys({ limit: 2 })
    await backend.blobs.delete(first.next)
    assert.deepEqual((await backend.blobs.listKeys({ after: first.next, limit: 10 })).items, ['k002', 'k003', 'k004'])
  })

  S('[blob][listKeys] 只给键：聊天图片与 attachment- 文档原件共用键空间，都能列出 ← types:BlobRepo「共用一个键空间」', async ({ backend }) => {
    await backend.blobs.putMany([stored('img'), { id: attKey(SHA_A), blob: blobOf('d', 'text/plain') }])
    assert.deepEqual([...(await allItems((q) => backend.blobs.listKeys(q)))].sort(), [attKey(SHA_A), 'img'].sort())
  })

  // ------------------------------------------------------------ clearExcept
  S('[blob][clearExcept] 清空但保留 keep 命中的键；字节与 MIME 不变；keep 由调用方给，仓储不内置前缀规则 ← char-staging blob 前缀 / types:clearExcept', async ({ backend }) => {
    await backend.blobs.putMany([
      { id: attKey(SHA_A), blob: blobOf('原件甲', 'text/plain') },
      { id: attKey(SHA_B), blob: blobOf('原件乙', 'text/plain') },
      stored('attachment-'),
      stored('Attachment-upper'),
      stored('x-attachment-mid'),
      stored('plain-image'),
    ])
    await backend.blobs.clearExcept((key) => key.startsWith('attachment-'))
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))).sort(), ['attachment-', attKey(SHA_A), attKey(SHA_B)].sort())
    assert.deepEqual(await fold(await backend.blobs.get(attKey(SHA_A))), { type: 'text/plain', size: 9, text: '原件甲' })
  })

  S('[blob][clearExcept] keep 的判定函数是调用方的：换一个 keep 就保留另一批 ← types:clearExcept「仓储不内置任何键前缀规则」', async ({ backend }) => {
    await backend.blobs.putMany([stored('attachment-x'), stored('keepme'), stored('drop')])
    await backend.blobs.clearExcept((key) => key === 'keepme')
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['keepme'])
  })

  S('[blob][clearExcept] 全部命中 keep 时一个不删；空库上调用不抛错；keep 恒 false 清空 ← types:clearExcept', async ({ backend }) => {
    await backend.blobs.clearExcept(() => false)
    await backend.blobs.putMany([stored('a'), stored('b')])
    await backend.blobs.clearExcept(() => true)
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['a', 'b'])
    await backend.blobs.clearExcept(() => false)
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), [])
  })

  S('[blob][clearExcept][原子] 清空中途失败：所有原件（含 keep 之外的）都还在 ← types:clearExcept 原子单元 / char-rollback 清旧图片阶段', async ({ backend, inject }) => {
    await backend.blobs.putMany([stored('a', 'A'), stored('b', 'B'), stored('c', 'C')])
    await withFault(inject, 'unknown', { at: 'blob', nth: 2, times: Infinity }, async (fault) => {
      await assert.rejects(backend.blobs.clearExcept((key) => key === 'a'))
      assert.ok(fault.hits() >= 1, '注入点没被走到（clearExcept 没有任何写？）')
    })
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['a', 'b', 'c'], '失败整体回滚')
    assert.equal(await (await backend.blobs.get('b')).text(), 'B')
  }, { needs: ['inject'] })

  // ------------------------------------------------------------ AssetRepo
  S('[asset][读] get 未设置返回 undefined（不是 null、不抛错）← char-blob A1 / types:get', async ({ backend }) => {
    assert.equal(await backend.assets.get('bg'), undefined)
  })

  S('[asset][往返] put 后 get：key、字节、MIME 原样，updatedAt 为数字 ← char-blob A1 / types:put', async ({ backend }) => {
    await backend.assets.put('bg', blobOf('first', 'image/jpeg'))
    const asset = await backend.assets.get('bg')
    assert.equal(asset.key, 'bg')
    assert.equal(asset.blob.type, 'image/jpeg')
    assert.equal(await asset.blob.text(), 'first')
    assert.equal(typeof asset.updatedAt, 'number')
  })

  S('[asset][覆盖] 同 key 再写是覆盖，updatedAt 不回退 ← char-blob A1 / types:put「updatedAt 由实现填」', async ({ backend }) => {
    await backend.assets.put('bg', blobOf('first', 'image/jpeg'))
    const before = await backend.assets.get('bg')
    await backend.assets.put('bg', blobOf('second', 'image/png'))
    const after = await backend.assets.get('bg')
    assert.equal(await after.blob.text(), 'second')
    assert.equal(after.blob.type, 'image/png')
    assert.ok(after.updatedAt >= before.updatedAt)
  })

  S('[asset][delete] 幂等；删一个 key 不影响别的 key ← char-blob A2 / types:delete', async ({ backend }) => {
    await backend.assets.put('keep', blobOf('keep'))
    await backend.assets.put('drop', blobOf('drop'))
    await backend.assets.delete('drop')
    await backend.assets.delete('drop')
    await backend.assets.delete('never')
    assert.equal(await backend.assets.get('drop'), undefined)
    assert.equal(await (await backend.assets.get('keep')).blob.text(), 'keep')
  })

  S('[asset][隔离] 素材与原件互不可见：同名 key 不串 ← types:AssetRepo「生命周期独立于会话与附件」', async ({ backend }) => {
    await backend.assets.put('same', blobOf('asset'))
    await backend.blobs.putMany([stored('same', 'blob')])
    await backend.blobs.clearExcept(() => false)
    assert.equal(await (await backend.assets.get('same')).blob.text(), 'asset', '清空原件不得动素材')
    await backend.blobs.putMany([stored('same', 'blob2')])
    await backend.assets.delete('same')
    assert.equal(await (await backend.blobs.get('same')).text(), 'blob2', '删素材不得动同名原件')
  })

  S('[asset][原子] 写失败整条回滚：既无新 key 也不留半条，旧值不变 ← char-blob A4 / types:put', async ({ backend, inject }) => {
    await backend.assets.put('bg', blobOf('旧'))
    await withFault(inject, 'unknown', { at: 'asset', times: Infinity }, async (fault) => {
      await assert.rejects(backend.assets.put('bg', blobOf('新')), (error) => error?.name === fault.errorName)
      await assert.rejects(backend.assets.put('other', blobOf('x')))
      assert.ok(fault.hits() >= 2)
    })
    assert.equal(await (await backend.assets.get('bg')).blob.text(), '旧')
    assert.equal(await backend.assets.get('other'), undefined)
  }, { needs: ['inject'] })
}

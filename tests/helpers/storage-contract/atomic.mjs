// StorageBackend.runAtomic 契约。依据只有 types.ts 的注释：
//   回调里写 → 要么全提交要么全回滚；回调抛错 → 回滚后原样抛出；返回值提交后原样返回；
//   不允许嵌套（实现必须拒绝）；`immediate` 只是选项，不改变语义。
// 刻意不写进契约（types 没说，放 idb-only 并在回复里列出）：并发 runAtomic 的相互可见性与排队顺序、
//   回调内读到自己未提交的写（read-your-writes）、回调里调 save 时原件是否随批回滚。
import assert from 'node:assert/strict'
import { allItems, attKey, blobOf, ids, memOf, sessionOf, seed, snapshot, stored, withFault } from './fixtures.mjs'

const NESTED_GUARD_MS = 5000
const fullSnap = (backend) => snapshot(backend, { memoryOf: ['s1', 's2'] })

export const register = (suite) => {
  const S = suite.case.bind(suite)

  S('[atomic][提交] 回调的返回值原样返回；各仓储的写在批后都可见 ← types:runAtomic', async ({ backend }) => {
    const marker = { nested: ['原样', 1] }
    const result = await backend.runAtomic(async (repos) => {
      await repos.blobs.putMany([stored('f1', '原件')])
      await repos.assets.put('bg', blobOf('素材'))
      await repos.memory.put(memOf('s1', 'k'), [])
      return marker
    })
    assert.equal(result, marker, '返回值是同一个对象，不被克隆')
    assert.equal(await (await backend.blobs.get('f1')).text(), '原件')
    assert.equal(await (await backend.assets.get('bg')).blob.text(), '素材')
    assert.deepEqual(ids(await backend.memory.listBySession('s1')), ['s1:k'])
  })

  S('[atomic][提交] 回调只读：不写任何东西也能返回读到的值 ← types:runAtomic', async ({ backend }) => {
    await seed(backend, sessionOf('s1'))
    const title = await backend.runAtomic(async (repos) => (await repos.sessions.get('s1')).title)
    assert.equal(title, '标题-s1')
  })

  S('[atomic][回滚] 回调抛错：跨仓储的写全部撤销，错误对象原样抛出（同一个引用）← types:runAtomic「回调抛错 → 回滚后把该错误原样抛出」', async ({ backend }) => {
    await seed(backend, sessionOf('s1'))
    await backend.blobs.putMany([stored('keep', '旧')])
    const before = await fullSnap(backend)
    const boom = Object.assign(new Error('业务错误'), { code: 'BIZ' })
    await assert.rejects(
      backend.runAtomic(async (repos) => {
        await repos.blobs.putMany([stored('new-blob', 'x')])
        await repos.blobs.delete('keep')
        await repos.assets.put('bg', blobOf('x'))
        await repos.memory.put(memOf('s1', 'k'), [])
        await repos.sessions.rename('s1', '改了')
        throw boom
      }),
      (error) => error === boom,
    )
    assert.deepEqual(await fullSnap(backend), before, '整库逐条等于批前')
    assert.equal(await backend.assets.get('bg'), undefined)
  })

  S('[atomic][回滚] 回调抛出非 Error 值也原样抛出并回滚 ← types:runAtomic「任何错误」', async ({ backend }) => {
    const thrown = { plain: 'object' }
    await assert.rejects(
      backend.runAtomic(async (repos) => {
        await repos.blobs.putMany([stored('f')])
        throw thrown
      }),
      (error) => error === thrown,
    )
    assert.equal(await backend.blobs.get('f'), undefined)
  })

  S('[atomic][回滚] 一个仓储的写失败（底层错误）：已写的其它仓储一并回滚，错误分类保留 ← types:runAtomic / char-rollback', async ({ backend, inject }) => {
    await backend.blobs.putMany([stored('old', '旧')])
    const before = await fullSnap(backend)
    await withFault(inject, 'quota', { at: 'asset', times: Infinity }, async (fault) => {
      await assert.rejects(
        backend.runAtomic(async (repos) => {
          await repos.blobs.putMany([stored('f1', '先写的')])
          await repos.memory.put(memOf('s1', 'k'), [])
          await repos.assets.put('bg', blobOf('后写的，这里失败'))
        }),
        (error) => error?.name === fault.errorName,
      )
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    assert.deepEqual(await fullSnap(backend), before)
  }, { needs: ['inject'] })

  S('[atomic][回滚] 失败的批不拖垮后端：之后的普通读写与新批照常成功 ← types:runAtomic', async ({ backend }) => {
    await assert.rejects(backend.runAtomic(async (repos) => {
      await repos.blobs.putMany([stored('a')])
      throw new Error('x')
    }))
    await backend.blobs.putMany([stored('b')])
    await backend.runAtomic((repos) => repos.blobs.putMany([stored('c')]))
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['b', 'c'])
  })

  S('[atomic][回滚] 回调里用 delete 级联：批失败后会话 / 摘要 / 原件 / 记忆都还在 ← types:runAtomic + delete', async ({ backend }) => {
    await seed(backend, sessionOf('s1', { files: ['f1'] }), [stored('f1', '原件')])
    await backend.memory.put(memOf('s1', 'k'), [])
    const before = await fullSnap(backend)
    await assert.rejects(backend.runAtomic(async (repos) => {
      await repos.sessions.delete('s1')
      throw new Error('after delete')
    }))
    assert.deepEqual(await fullSnap(backend), before)
  })

  S('[atomic][嵌套] 回调里再调 runAtomic：实现必须拒绝，外层整体回滚 ← types:runAtomic「不允许嵌套」', async ({ backend }) => {
    const guard = new Promise((_, reject) => setTimeout(() => reject(new Error(`嵌套 runAtomic ${NESTED_GUARD_MS}ms 没有结论（死锁？）`)), NESTED_GUARD_MS).unref())
    const outcome = backend.runAtomic(async (repos) => {
      await repos.blobs.putMany([stored('outer')])
      await backend.runAtomic(async (inner) => {
        await inner.blobs.putMany([stored('inner')])
      })
    })
    await assert.rejects(Promise.race([outcome, guard]), (error) => !/没有结论/.test(String(error?.message)), '嵌套必须以拒绝收场')
    assert.equal(await backend.blobs.get('outer'), undefined)
    assert.equal(await backend.blobs.get('inner'), undefined)
  })

  S('[atomic][嵌套] 嵌套被拒绝之后后端仍可用 ← types:runAtomic', async ({ backend }) => {
    await assert.rejects(backend.runAtomic(() => backend.runAtomic(async () => {})))
    await backend.runAtomic((repos) => repos.blobs.putMany([stored('after')]))
    assert.ok(await backend.blobs.get('after'))
  })

  for (const immediate of [true, false]) {
    S(`[atomic][选项] immediate=${immediate}：提交与回滚语义相同 ← types:AtomicOptions`, async ({ backend }) => {
      await backend.runAtomic((repos) => repos.blobs.putMany([stored('ok')]), { immediate })
      await assert.rejects(backend.runAtomic(async (repos) => {
        await repos.blobs.putMany([stored('bad')])
        throw new Error('x')
      }, { immediate }))
      assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['ok'])
    })
  }

  S('[atomic][选项] 不传 options 与 {} 等价 ← types:AtomicOptions 缺省 immediate=true', async ({ backend }) => {
    await backend.runAtomic((repos) => repos.blobs.putMany([stored('a')]))
    await backend.runAtomic((repos) => repos.blobs.putMany([stored('b')]), {})
    assert.deepEqual((await allItems((q) => backend.blobs.listKeys(q))), ['a', 'b'])
  })

  S('[atomic][边界] 批里组合附件元数据与原件：回滚后两边都不留（add 自身是原子单元）← types:AttachmentRepo.add', async ({ backend }) => {
    await assert.rejects(backend.runAtomic(async (repos) => {
      await repos.attachments.add({ id: 'a1', filename: 'a', mimeType: 'text/plain', size: 1, sha256: 'c'.repeat(64), status: 'pending', createdAt: 1 }, blobOf('x', 'text/plain'))
      throw new Error('x')
    }))
    assert.deepEqual(await backend.attachments.list(), [])
    assert.equal(await backend.blobs.get(attKey('c'.repeat(64))), undefined)
    assert.deepEqual(await allItems((q) => backend.blobs.listKeys(q)), [])
  })
}

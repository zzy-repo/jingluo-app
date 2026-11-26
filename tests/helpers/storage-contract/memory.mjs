// MemoryRepo 契约。容量策略不在仓储里（types:put「仓储不做容量判定」），这里只验原子写与会话隔离。
// 刻意不测：非法 sessionId / 空 key 的入口拒绝（char-blob C3）。那是 sessionMemory.ts 的入口校验，
// 不在 types.ts 对 MemoryRepo 的承诺里 → 放 IDB 专属 runner。
import assert from 'node:assert/strict'
import { memOf, ids, withFault, T0 } from './fixtures.mjs'

export const register = (suite) => {
  const S = suite.case.bind(suite)

  S('[memory][读] get 不存在为 undefined；listBySession 不存在的会话为 [] ← char-blob C1 / types', async ({ backend }) => {
    assert.equal(await backend.memory.get('s', 'nope'), undefined)
    assert.deepEqual(await backend.memory.listBySession('s'), [])
  })

  S('[memory][往返] put 后 get / list 读回同一条（含向量字段）← char-blob C1 / types:put', async ({ backend }) => {
    const entry = memOf('s1', 'k1', { vec: [0.1, 0.2], model: 'm', dim: 2 })
    await backend.memory.put(entry, [])
    assert.deepEqual(await backend.memory.get('s1', 'k1'), entry)
    assert.deepEqual(await backend.memory.listBySession('s1'), [entry])
  })

  S('[memory][隔离] 两个会话用同一个 key：落在两条记录上，互相读不到；清一个不动另一个 ← memory-session-scope-399 / types:get「key 只在 sessionId 内解析」', async ({ backend }) => {
    await backend.memory.put(memOf('a', 'k', { text: 'A' }), [])
    await backend.memory.put(memOf('b', 'k', { text: 'B' }), [])
    assert.equal((await backend.memory.get('a', 'k')).text, 'A')
    assert.equal((await backend.memory.get('b', 'k')).text, 'B')
    assert.equal(await backend.memory.clearSession('a'), 1)
    assert.equal(await backend.memory.get('a', 'k'), undefined)
    assert.equal((await backend.memory.get('b', 'k')).text, 'B')
  })

  S('[memory][put] 覆盖写：同 sessionId+key 只留一条；覆盖后不残留旧向量字段 ← char-blob C4 / types:put 覆盖写', async ({ backend }) => {
    await backend.memory.put(memOf('s', 'k', { text: '旧', vec: [0.1, 0.2], model: 'old', dim: 2 }), [])
    await backend.memory.put(memOf('s', 'k', { text: '新' }), [])
    const rows = await backend.memory.listBySession('s')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].text, '新')
    for (const field of ['vec', 'model', 'dim']) assert.equal(Object.hasOwn(rows[0], field), false, `${field} 不得残留`)
  })

  S('[memory][listBySession] 按 createdAt 升序，同毫秒按主键升序 ← types:listBySession', async ({ backend }) => {
    await backend.memory.put(memOf('s', 'c', { createdAt: T0 + 2 }), [])
    await backend.memory.put(memOf('s', 'b', { createdAt: T0 + 1 }), [])
    await backend.memory.put(memOf('s', 'z', { createdAt: T0 }), [])
    await backend.memory.put(memOf('s', 'a', { createdAt: T0 + 1 }), [])
    assert.deepEqual(ids(await backend.memory.listBySession('s')), ['s:z', 's:a', 's:b', 's:c'])
  })

  S('[memory][put] 同一次 put 里淘汰 evictIds：新行在、被淘汰行不在；不在 evictIds 的不动 ← types:put 原子单元', async ({ backend }) => {
    for (const k of ['old1', 'old2', 'keep']) await backend.memory.put(memOf('s', k), [])
    await backend.memory.put(memOf('s', 'new'), ['s:old1', 's:old2'])
    assert.deepEqual(ids(await backend.memory.listBySession('s')).sort(), ['s:keep', 's:new'])
  })

  S('[memory][put] evictIds 里不存在的 id 被忽略，不抛错；evictIds 不波及别的会话 ← types:put', async ({ backend }) => {
    await backend.memory.put(memOf('other', 'k'), [])
    await backend.memory.put(memOf('s', 'k1'), ['s:ghost', 'other:k'.replace('other', 'nobody')])
    assert.deepEqual(ids(await backend.memory.listBySession('s')), ['s:k1'])
    assert.equal((await backend.memory.listBySession('other')).length, 1)
  })

  S('[memory][put][原子] 写新行失败：被淘汰的行还在（淘汰与写入同成同败）← types:put「要么全成要么全不成」', async ({ backend, inject }) => {
    await backend.memory.put(memOf('s', 'old'), [])
    await withFault(inject, 'unknown', { at: 'memory', id: 's:new', times: Infinity }, async (fault) => {
      await assert.rejects(backend.memory.put(memOf('s', 'new'), ['s:old']), (error) => error?.name === fault.errorName)
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    assert.deepEqual(ids(await backend.memory.listBySession('s')), ['s:old'])
    assert.equal(await backend.memory.get('s', 'new'), undefined)
  }, { needs: ['inject'] })

  S('[memory][put][原子] 删淘汰项失败：新行也不留 ← types:put 原子单元（对称方向）', async ({ backend, inject }) => {
    await backend.memory.put(memOf('s', 'old'), [])
    // 写点计数无法区分「写」与「删」，用 id 过滤到被淘汰的那一行：只有删它的操作才命中
    await withFault(inject, 'unknown', { at: 'memory', id: 's:old', times: Infinity }, async (fault) => {
      await assert.rejects(backend.memory.put(memOf('s', 'new'), ['s:old']))
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    assert.equal(await backend.memory.get('s', 'new'), undefined)
    assert.ok(await backend.memory.get('s', 'old'))
  }, { needs: ['inject'] })

  S('[memory][delete] 返回是否真的删掉；重复删为 false；不存在为 false ← char-blob C1 / types:delete', async ({ backend }) => {
    await backend.memory.put(memOf('s', 'k'), [])
    assert.equal(await backend.memory.delete('s', 'k'), true)
    assert.equal(await backend.memory.get('s', 'k'), undefined)
    assert.equal(await backend.memory.delete('s', 'k'), false)
    assert.equal(await backend.memory.delete('s', 'never'), false)
  })

  S('[memory][delete] 只删本会话的那一条：别的 key、别的会话同 key 都在 ← types:delete', async ({ backend }) => {
    for (const [s, k] of [['a', 'k'], ['a', 'j'], ['b', 'k']]) await backend.memory.put(memOf(s, k), [])
    await backend.memory.delete('a', 'k')
    assert.deepEqual(ids(await backend.memory.listBySession('a')), ['a:j'])
    assert.deepEqual(ids(await backend.memory.listBySession('b')), ['b:k'])
  })

  S('[memory][clearSession] 只清本会话并返回条数，重复清返回 0，别的会话一条不动 ← char-blob C2 / types:clearSession', async ({ backend }) => {
    for (const k of ['1', '2', '3']) await backend.memory.put(memOf('a', k), [])
    await backend.memory.put(memOf('b', '1'), [])
    assert.equal(await backend.memory.clearSession('a'), 3)
    assert.equal(await backend.memory.clearSession('a'), 0)
    assert.deepEqual(await backend.memory.listBySession('a'), [])
    assert.equal((await backend.memory.listBySession('b')).length, 1)
  })

  S('[memory][clearSession][原子] 清到一半失败：本会话的记忆一条不少 ← types:clearSession 原子单元', async ({ backend, inject }) => {
    for (const k of ['1', '2', '3']) await backend.memory.put(memOf('a', k), [])
    await withFault(inject, 'unknown', { at: 'memory', nth: 2, times: Infinity }, async (fault) => {
      await assert.rejects(backend.memory.clearSession('a'))
      assert.ok(fault.hits() >= 1, '注入点没被走到')
    })
    assert.equal((await backend.memory.listBySession('a')).length, 3)
  }, { needs: ['inject'] })
}

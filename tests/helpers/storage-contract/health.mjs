// health() / probe() 契约。types.ts 里这两个方法只回答「能不能用」，不回答「库里有没有数据」：
// StorageHealth = { ok:true } | { ok:false, initFailure }，StorageProbe 再多 versionTooNew / persisted 两项。
// 所以「空库」与「有数据」在这里的可断言内容是：两种状态下结论一致（都 ok），且探测本身不改数据。
import assert from 'node:assert/strict'
import { memOf, sessionOf, seed, snapshot, stored } from './fixtures.mjs'

const INIT_FAILURES = new Set(['blocked', 'version', 'unavailable'])

const assertProbeShape = (probe) => {
  assert.equal(typeof probe.health.ok, 'boolean')
  if (!probe.health.ok) assert.ok(INIT_FAILURES.has(probe.health.initFailure), `未知的 initFailure：${probe.health.initFailure}`)
  assert.equal(typeof probe.versionTooNew, 'boolean')
  assert.ok(probe.persisted === undefined || typeof probe.persisted === 'boolean', 'persisted 只能是 boolean | undefined')
}

export const register = (suite) => {
  const S = suite.case.bind(suite)

  S('[health][空库] 刚创建的空后端：health 为 {ok:true}，probe 无版本问题 ← types:health / probe', async ({ backend }) => {
    assert.deepEqual(await backend.health(), { ok: true })
    const probe = await backend.probe()
    assertProbeShape(probe)
    assert.deepEqual(probe.health, { ok: true })
    assert.equal(probe.versionTooNew, false)
  })

  S('[health][有数据] 有数据的后端：health / probe 结论与空库同形同值（接口不暴露「有无数据」）← types:health / probe', async ({ backend }) => {
    const empty = { health: await backend.health(), probe: await backend.probe() }
    await seed(backend, sessionOf('s1', { files: ['f'] }), [stored('f')])
    await backend.memory.put(memOf('s1', 'k'), [])
    assert.deepEqual(await backend.health(), empty.health)
    const probe = await backend.probe()
    assertProbeShape(probe)
    assert.deepEqual({ ...probe, persisted: undefined }, { ...empty.probe, persisted: undefined })
  })

  S('[health][只读] health / probe 不改数据：调用前后整库逐条相等，空库探测后仍是空库 ← types:probe「启动期探测」', async ({ backend }) => {
    const emptySnap = await snapshot(backend)
    await backend.health()
    await backend.probe()
    assert.deepEqual(await snapshot(backend), emptySnap)
    assert.deepEqual(await backend.sessions.listSummaries(), [])
    await seed(backend, sessionOf('s1'))
    const before = await snapshot(backend, { memoryOf: ['s1'] })
    await backend.health()
    await backend.probe()
    assert.deepEqual(await snapshot(backend, { memoryOf: ['s1'] }), before)
  })

  S('[health][幂等] 连续调用结论稳定 ← types:health', async ({ backend }) => {
    const first = await backend.probe()
    const second = await backend.probe()
    assert.deepEqual({ ...second, persisted: undefined }, { ...first, persisted: undefined })
    assert.deepEqual(await backend.health(), await backend.health())
  })

  S('[health][注入] 写失败不影响 health：它回答「能不能用」，不被一次配额失败判死 ← types:health「不抛错」', async ({ backend, inject }) => {
    const handle = inject.failNextWrite('quota', { at: 'any', times: Infinity })
    try {
      await assert.doesNotReject(backend.health())
      await assert.doesNotReject(backend.probe())
    } finally {
      handle.restore()
    }
  }, { needs: ['inject'] })
}

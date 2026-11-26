// 错误模型契约：三个错误类、四档分类、「不可用 / 不支持」语义。
// 依据：types.ts 的 OpenStorage / close 注释、docs/storage-abstraction.md §4 映射表、
//       docs/client-infra-standards.md（后端不可用必须抛带 kind 的错误；不得静默返回空结果，也不得降级到内存后返回成功）。
// 分类函数由 runner 经 `errorClasses.classify` 注入（套件不 import db.ts，也不 import @capacitor/*）。
import assert from 'node:assert/strict'
import { blobOf, memOf, sessionOf, seed, stored, withFault } from './fixtures.mjs'

const KINDS = ['quota', 'clone', 'unavailable', 'unknown']
const FAILURE_KEYS = new Set(['kind', 'name', 'message', 'stores', 'at'])

/** 每个仓储里「会写」的方法，及它们在 inject 里对应的写点。失败必须以 reject 体现，不得吞掉。 */
const WRITERS = [
  ['blobs.putMany', 'blob', (b) => b.blobs.putMany([stored('w1')])],
  ['assets.put', 'asset', (b) => b.assets.put('bg', blobOf('x'))],
  ['memory.put', 'memory', (b) => b.memory.put(memOf('s', 'k'), [])],
  ['attachments.put', 'attachment', (b) => b.attachments.put({ id: 'a', filename: 'a', mimeType: 'text/plain', size: 1, sha256: 'd'.repeat(64), localPath: 'attachment-' + 'd'.repeat(64), status: 'pending', createdAt: 1 })],
  ['attachments.writeText', 'attachment', (b) => b.attachments.writeText({ sha256: 'e', parserVersion: 'v', text: 't', status: 'success' })],
  ['staging.addSession', 'staging', (b) => b.staging.addSession(sessionOf('st'))],
]

/** 关闭后每个仓储至少一个读方法与一个写方法，全都必须 reject，而不是返回空值。 */
const AFTER_CLOSE = [
  ['sessions.get', (b) => b.sessions.get('x')],
  ['sessions.listSummaries', (b) => b.sessions.listSummaries()],
  ['sessions.save', (b) => b.sessions.save(sessionOf('x'))],
  ['sessions.listFull', (b) => b.sessions.listFull()],
  ['blobs.get', (b) => b.blobs.get('x')],
  ['blobs.listKeys', (b) => b.blobs.listKeys()],
  ['blobs.putMany', (b) => b.blobs.putMany([stored('x')])],
  ['assets.get', (b) => b.assets.get('x')],
  ['assets.put', (b) => b.assets.put('x', blobOf('x'))],
  ['attachments.list', (b) => b.attachments.list()],
  ['attachments.readText', (b) => b.attachments.readText('x:y')],
  ['memory.listBySession', (b) => b.memory.listBySession('x')],
  ['memory.put', (b) => b.memory.put(memOf('x', 'k'), [])],
  ['staging.clear', (b) => b.staging.clear()],
  ['staging.merge', (b) => b.staging.merge('merge')],
  ['runAtomic', (b) => b.runAtomic(async () => 1)],
]

export const register = (suite) => {
  const S = suite.case.bind(suite)

  // ------------------------------------------------------------ 三个错误类（形状）
  S('[errors][类] 三个错误类：继承 Error、name 等于类名；blocked / version 带 initFailure 档位 ← db.ts 错误类 / types:OpenStorage', async ({ errorClasses: c }) => {
    const unavailable = new c.StorageUnavailableError()
    const blocked = new c.StorageBlockedError()
    const tooNew = new c.StorageVersionTooNewError()
    for (const [error, name] of [[unavailable, 'StorageUnavailableError'], [blocked, 'StorageBlockedError'], [tooNew, 'StorageVersionTooNewError']]) {
      assert.ok(error instanceof Error)
      assert.equal(error.name, name)
      assert.ok(String(error.message).length > 0)
    }
    assert.equal(blocked.initFailure, 'blocked')
    assert.equal(tooNew.initFailure, 'version')
    assert.equal(unavailable.initFailure, undefined, 'unavailable 不是启动期换文案档')
  }, { needs: ['errorClasses'] })

  S('[errors][分类] 三个错误类落进的档位：Unavailable→unavailable、VersionTooNew→unavailable、Blocked→unknown ← docs §4 映射表', async ({ errorClasses: c }) => {
    assert.equal(c.classify(new c.StorageUnavailableError()), 'unavailable')
    assert.equal(c.classify(new c.StorageVersionTooNewError()), 'unavailable')
    assert.equal(c.classify(new c.StorageBlockedError()), 'unknown')
  }, { needs: ['errorClasses'] })

  S('[errors][分类] 底层错误名到四档：Quota→quota、DataClone→clone、Unknown/NotSupported→unavailable、InvalidState / 其余→unknown ← docs §4 / char-session 分类', async ({ errorClasses: c }) => {
    const named = (name) => Object.assign(new Error(name), { name })
    assert.equal(c.classify(named('QuotaExceededError')), 'quota')
    assert.equal(c.classify(named('DataCloneError')), 'clone')
    assert.equal(c.classify(named('UnknownError')), 'unavailable')
    assert.equal(c.classify(named('NotSupportedError')), 'unavailable')
    assert.equal(c.classify(named('InvalidStateError')), 'unknown')
    assert.equal(c.classify(named('SomethingElse')), 'unknown')
    assert.equal(c.classify('不是 Error'), 'unknown')
  }, { needs: ['errorClasses'] })

  // ------------------------------------------------------------ open 失败（runner 造条件）
  S('[errors][open] 宿主没有存储能力：reject StorageUnavailableError，不返回「空后端」也不退到内存 ← types:OpenStorage / infra-standards', async ({ errorClasses: c, openErrors }) => {
    const reason = await openErrors.unavailable()
    assert.ok(reason instanceof c.StorageUnavailableError, `实际：${reason?.name ?? reason}`)
    assert.equal(c.classify(reason), 'unavailable')
  }, { needs: ['errorClasses', 'openErrors.unavailable'] })

  S('[errors][open] 其它连接挡住升级：reject StorageBlockedError（而不是永远 pending）← types:OpenStorage', async ({ errorClasses: c, openErrors }) => {
    const reason = await openErrors.blocked()
    assert.ok(reason instanceof c.StorageBlockedError, `实际：${reason?.name ?? reason}`)
    assert.equal(reason.initFailure, 'blocked')
  }, { needs: ['errorClasses', 'openErrors.blocked'] })

  S('[errors][open] 库版本比代码新：reject StorageVersionTooNewError ← types:OpenStorage', async ({ errorClasses: c, openErrors }) => {
    const reason = await openErrors.versionTooNew()
    assert.ok(reason instanceof c.StorageVersionTooNewError, `实际：${reason?.name ?? reason}`)
    assert.equal(reason.initFailure, 'version')
  }, { needs: ['errorClasses', 'openErrors.versionTooNew'] })

  // ------------------------------------------------------------ close 之后：不可用必须报错，不得静默
  S('[errors][close] 关闭后每个仓储的读写与 runAtomic 一律 reject StorageUnavailableError，不返回空值 ← types:close / infra-standards「不得静默返回空结果」', async ({ backend, errorClasses: c }) => {
    await seed(backend, sessionOf('s1'))
    await backend.close()
    for (const [label, call] of AFTER_CLOSE) {
      await assert.rejects(
        Promise.resolve().then(() => call(backend)),
        (error) => error instanceof c.StorageUnavailableError && c.classify(error) === 'unavailable',
        `${label}：关闭后必须 reject StorageUnavailableError，而不是返回空结果`,
      )
    }
  }, { needs: ['errorClasses'] })

  S('[errors][close] 关闭后的写不能「悄悄成功」：重新打开同一份存储，数据与关闭前完全一致 ← infra-standards「禁止降级到内存后返回成功」', async ({ backend, reopen, adopt }) => {
    const session = sessionOf('s1')
    await seed(backend, session)
    await backend.close()
    await backend.sessions.save(sessionOf('ghost')).catch(() => {})
    await backend.blobs.putMany([stored('ghost')]).catch(() => {})
    const again = adopt(await reopen(backend))
    assert.deepEqual(await again.sessions.get('s1'), session)
    assert.equal(await again.sessions.get('ghost'), undefined)
    assert.equal(await again.blobs.get('ghost'), undefined)
  }, { needs: ['reopen'] })

  S('[errors][close] close 幂等：连续调用不抛错 ← types:close', async ({ backend }) => {
    await backend.close()
    await backend.close()
  })

  S('[errors][close] 关闭后 health / probe 不抛错、给出结论 ← types:health / probe「不抛错」', async ({ backend }) => {
    await backend.close()
    const health = await backend.health()
    assert.equal(typeof health.ok, 'boolean')
    const probe = await backend.probe()
    assert.equal(typeof probe.health.ok, 'boolean')
    assert.equal(typeof probe.versionTooNew, 'boolean')
  })

  S('[errors][close] 重新打开后数据都在，且可继续写 ← types:close / OpenStorage', async ({ backend, reopen, adopt }) => {
    await seed(backend, sessionOf('s1', { files: ['f'] }), [stored('f', '字节')])
    await backend.memory.put(memOf('s1', 'k'), [])
    const again = adopt(await reopen(backend))
    assert.equal((await again.sessions.get('s1')).id, 's1')
    assert.equal(await (await again.blobs.get('f')).text(), '字节')
    assert.equal((await again.memory.listBySession('s1')).length, 1)
    await seed(again, sessionOf('s2'))
    assert.equal((await again.sessions.listSummaries()).length, 2)
  }, { needs: ['reopen'] })

  // ------------------------------------------------------------ 四档注入：写必须 reject 且带分类
  for (const kind of KINDS) {
    S(`[errors][注入] ${kind}：每个仓储的写方法都 reject，且错误被归进 ${kind}，不静默成功 ← docs §4 / infra-standards 四档`, async ({ backend, inject, errorClasses: c }) => {
      for (const [label, at, call] of WRITERS) {
        await withFault(inject, kind, { at, times: Infinity }, async (fault) => {
          await assert.rejects(call(backend), (error) => error?.name === fault.errorName && c.classify(error) === kind, `${label}：${kind} 失败必须以同档错误 reject`)
          assert.ok(fault.hits() >= 1, `${label}：注入点没被走到`)
        })
      }
    }, { needs: ['inject', 'errorClasses'] })

    S(`[errors][注入] ${kind}：save 把失败装进 outcome.failure，只含元数据字段，不含会话正文 ← types:SaveSessionOutcome / StorageFailure`, async ({ backend, inject }) => {
      const secret = '机密正文-9f3a'
      await withFault(inject, kind, { at: 'session', times: Infinity }, async () => {
        const outcome = await backend.sessions.save(sessionOf('s1', { title: secret }))
        assert.equal(outcome.failure.kind, kind)
        for (const key of Object.keys(outcome.failure)) assert.ok(FAILURE_KEYS.has(key), `failure 多出非元数据字段 ${key}`)
        assert.equal(JSON.stringify(outcome).includes(secret), false, '失败描述里不得带用户内容')
        assert.ok((outcome.failure.message ?? '').length <= 200)
      })
    }, { needs: ['inject'] })
  }

  S('[errors][注入] 注入撤销后同一操作立刻成功：失败不留「坏状态」 ← types:StorageFailure', async ({ backend, inject }) => {
    const handle = inject.failNextWrite('unknown', { at: 'blob', times: Infinity })
    await assert.rejects(backend.blobs.putMany([stored('x')]))
    handle.restore()
    handle.restore()
    await backend.blobs.putMany([stored('x', '好了')])
    assert.equal(await (await backend.blobs.get('x')).text(), '好了')
  }, { needs: ['inject'] })

  S('[errors][注入] 读不受写注入影响：写失败期间 get / list 仍返回已有数据，而不是报错或空 ← types（读写注入口径）', async ({ backend, inject }) => {
    await seed(backend, sessionOf('s1'))
    await withFault(inject, 'unavailable', { at: 'any', times: Infinity }, async () => {
      assert.equal((await backend.sessions.get('s1')).id, 's1')
      assert.equal((await backend.sessions.listSummaries()).length, 1)
    })
  }, { needs: ['inject'] })
}

// [layer: unit | 依赖: 无（纯 Node：注入假 source，不发请求） | 耗时: <2s]
//
// Issue #896 **3c-3**：`api/managedKey.ts` 的「只重试一次」压回策略表。
//
// ## 这里有个必须写清的语义问题（不是纯搬家）
//
// 策略表里 `control.retry = 0`、`idempotent = false`，含义是**「这一类请求绝不自动发第二枪」**
// —— 因为卡密重复兑换、Key 重复创建都是重试重出来的（#484 §4.3）。
//
// 但 `ensureManagedKey` 确实会补发一次。那它是「特例」还是「一般策略」？
//
// **是特例，而且必须在表里写成特例**：它之所以敢补发一次，靠的不是「control 类可以重试」，
// 而是「这一次尝试的形状特殊」——
//   1. 每次尝试都**先 `GET /api/v1/keys` 查重**，命中就直接沿用（#803 第 2 条）；
//   2. `POST /keys` 的 `name` 是**设备固定名**，服务端按 name 去重 → 同设备补发不会长出第二把；
//   3. 401 之后补发前**必须先换凭据**，换不到就停在原地（拿旧 token 再打一次 = staging 那轮全 401）。
//
// 所以表里给这一族「先查重再写」的控制操作单独一个数 `control.dedupeRetry`（= 1 次补发），
// 而**不动** `control.retry`（仍是 0）。两条同时成立才是对的：
//   · 一般控制类（兑换卡密 / 扣费）—— 一次都不补发；
//   · 可判定的幂等控制操作（按固定名领取）—— 允许补发 `dedupeRetry` 次。
// 把这两条混成一个数，要么 key 重复创建，要么领取失败率上升。
//
//   node --test tests/unit/managed-key-policy-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'

installResolveHooks()

const policy = await import('../../src/services/net/requestPolicy.ts')
const managed = await import('../../src/services/api/managedKey.ts')

const { REQUEST_POLICY, requestPolicyOf, canAutoRetry } = policy
const { MANAGED_KEY_MAX_ATTEMPTS, ensureManagedKey } = managed

/** 假 source：按顺序回放预置的结局，并记下每次调用 */
const fakeSource = (script) => {
  const calls = { list: 0, create: 0, update: 0 }
  const source = {
    keys: {
      list: async () => {
        const step = script[calls.list++] ?? { ok: true, data: { items: [] }, status: 200, raw: null }
        return step
      },
      create: async () => {
        const step = script[calls.create++] ?? { ok: true, data: { key: 'sk-new', id: 7, name: 'app-x' }, status: 200, raw: null }
        return step
      },
      update: async () => {
        calls.update += 1
        return { ok: true, data: {}, status: 200, raw: null }
      },
    },
  }
  return { source, calls }
}

const fail401 = {
  ok: false,
  status: 401,
  raw: null,
  error: { status: 401, code: 'UNAUTHORIZED', message: 'unauthorized' },
}

test('[M1] 「只重试一次」这个数来自策略表，不再是本文件的私有常量', () => {
  const row = requestPolicyOf('control')
  assert.equal(
    typeof row.dedupeRetry,
    'number',
    'control 必须显式声明「先查重再写」型操作的补发上限（改前这个字段不存在）'
  )
  assert.equal(row.dedupeRetry, 1, '补发恰好一次：首次 + 一次')
  assert.equal(
    MANAGED_KEY_MAX_ATTEMPTS,
    1 + row.dedupeRetry,
    'MANAGED_KEY_MAX_ATTEMPTS 必须是「首发 1 次 + 表里的补发次数」，不是自己写 2'
  )
  assert.equal(MANAGED_KEY_MAX_ATTEMPTS, 2, '行为不变：改前就是 2')
})

test('[M2] 语义写清：换凭据/领 Key 是特例，没有把 control 的一般策略放宽', () => {
  const row = requestPolicyOf('control')
  assert.equal(row.retry, 0, 'control 的一般策略仍是「一次都不自动重发」')
  assert.equal(row.idempotent, false, 'control 仍然不是幂等类')
  // 一般策略没有被特例带跑
  for (const failure of ['timeout', 'offline', 'server5xx', 'rateLimited']) {
    assert.equal(
      canAutoRetry({ cls: 'control', failure, attempt: 0 }),
      false,
      `${failure}：一般控制类仍然不许自动补发`
    )
  }
  // 特例只属于 control；别的类没有这条口子（它们用 retry 那一个数）
  assert.equal(REQUEST_POLICY.data.dedupeRetry, 0)
  assert.equal(REQUEST_POLICY.stream.dedupeRetry, 0)
})

test('[M3] 行为不变：默认最多两次尝试，retry:false 只一次', async () => {
  const a = fakeSource([fail401, fail401])
  const first = await ensureManagedKey(a.source, { deviceId: 'd-abcdef0123456789', refresh: async () => 'expired' })
  assert.equal(first.ok, false)
  assert.equal(first.stop, 'refresh-failed', '401 且换不到凭据 → 停下（不拿旧 token 再打）')
  assert.equal(first.attempts, 1, '换凭据失败时只有 1 次尝试')

  const b = fakeSource([
    { ok: false, status: 500, raw: null, error: { status: 500, code: 'HTTP_500', message: 'boom' } },
    { ok: false, status: 500, raw: null, error: { status: 500, code: 'HTTP_500', message: 'boom' } },
  ])
  const second = await ensureManagedKey(b.source, { deviceId: 'd-abcdef0123456789' })
  assert.equal(second.ok, false)
  assert.equal(second.stop, 'attempts-exhausted')
  assert.equal(second.attempts, MANAGED_KEY_MAX_ATTEMPTS, '用满表里给的上限就停')
  assert.equal(b.calls.list, MANAGED_KEY_MAX_ATTEMPTS, '每次尝试都先查重（补发不会长出新 Key）')

  const c = fakeSource([fail401, fail401])
  const once = await ensureManagedKey(c.source, { deviceId: 'd-abcdef0123456789', retry: false })
  assert.equal(once.attempts, 1, 'retry:false = 只发一次')
})

test('[M4] 本文件不再自己写「2」，而是读策略表', () => {
  const raw = readFileSync(new URL('../../src/services/api/managedKey.ts', import.meta.url), 'utf8')
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(
    code.includes("from '../net/requestPolicy.js'"),
    true,
    '改前本文件不 import 策略表（上限自己写 2），改后必须读同一份'
  )
  assert.equal(
    /MANAGED_KEY_MAX_ATTEMPTS\s*=\s*2\b/.test(code),
    false,
    'MANAGED_KEY_MAX_ATTEMPTS 不许再是字面量 2'
  )
})

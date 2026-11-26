// [layer: unit | 依赖: 无（纯 Node：不发请求） | 耗时: <2s]
//
// Issue #896 **3c-4**：`ours/purchases.ts` 的可重试性判定与超时预算压回策略源。
//
// ## 改前真有的两份平行判定
//
//  1. **可重试性**：`RETRYABLE_KINDS = ['network','timeout','server','rateLimited']`
//     —— 与 `net/failureKind.ts` 的判据平行存在。同一个 429 在两处各判一次，
//     改一处不改另一处就会出现「界面给了重试按钮，判定却说别重试」。
//  2. **超时**：`PURCHASES_TIMEOUT_MS = 12000` 是本文件私有常量，和 `ours/api.ts` 的
//     `OURS_TIMEOUTS` 是两张表 —— 想统一调这一档就得知道「它其实在 purchases.ts 里」。
//
// ## 产品语义必须原样保留：**支付绝不自动重发**
//
// `retryable === true` 是**给界面**的意思（「要不要给用户一个重试按钮」），
// 而「我们要不要自己再发一次」在本仓恒为否：订单 / 支付链路是 `control` 语义。
// 本文件的 P5 把这两件事分开钉住 —— 合并判定**不许**顺手把自动重发也放开。
//
//   node --test tests/unit/purchases-policy-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'

installResolveHooks()

const purchases = await import('../../src/services/ours/purchases.ts')
const policy = await import('../../src/services/net/requestPolicy.ts')
const failure = await import('../../src/services/net/failureKind.ts')
const { OURS_TIMEOUTS } = await import('../../src/services/ours/api.ts')

const { PurchaseError, PURCHASES_TIMEOUT_MS, isRetryablePurchaseError } = purchases
const { canAutoRetry, transportBudgetOf, TRANSPORT_SLOTS, requestPolicyOf } = policy
const { retryableFailure } = failure

const KINDS = [
  'keyMissing',
  'unauthorized',
  'rejected',
  'network',
  'timeout',
  'server',
  'rateLimited',
  'badResponse',
]

const codeOf = (path) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('[C1] 可重试性不再是一份平行名单，而是读全仓唯一的判据', () => {
  const code = codeOf('../../src/services/ours/purchases.ts')
  assert.equal(
    code.includes("from '../net/failureKind.js'"),
    true,
    '改前本文件不 import 唯一判据（自己维护 RETRYABLE_KINDS 名单），改后必须读同一份'
  )
  assert.equal(
    code.includes('RETRYABLE_KINDS'),
    false,
    '平行的 RETRYABLE_KINDS 名单必须删掉（它和 failureKind 是同一件事的第二个答案）'
  )
  // 逐格：八个 kind 的结论必须与统一判据一致
  const expected = {
    keyMissing: false,
    unauthorized: false,
    rejected: false,
    network: true,
    timeout: true,
    server: true,
    rateLimited: true,
    badResponse: false,
  }
  for (const kind of KINDS) {
    assert.equal(
      new PurchaseError(kind, 'x').retryable,
      expected[kind],
      `${kind} 的 retryable 与改前行为不一致`
    )
  }
})

test('[C2] 429 / 5xx / 断网在两类入口给出同一个结论（不再两处各判）', () => {
  assert.equal(new PurchaseError('rateLimited', 'x').retryable, retryableFailure('rateLimited'))
  assert.equal(new PurchaseError('server', 'x').retryable, retryableFailure('server5xx'))
  assert.equal(new PurchaseError('network', 'x').retryable, retryableFailure('offline'))
  assert.equal(new PurchaseError('timeout', 'x').retryable, retryableFailure('timeout'))
  // `isRetryablePurchaseError` 只做类型收窄，口径跟着走
  assert.equal(isRetryablePurchaseError(new PurchaseError('timeout', 'x')), true)
  assert.equal(isRetryablePurchaseError(new PurchaseError('unauthorized', 'x')), false)
  assert.equal(isRetryablePurchaseError(new Error('boom')), false)
})

test('[C3] 超时预算从策略源的槽位出，不再是本文件的私有常量', () => {
  assert.equal(TRANSPORT_SLOTS['pay.orders'].cls, 'data', '订单查询是只读幂等，归 data 类')
  assert.equal(requestPolicyOf('data').connect, 60_000, 'data 类的建连预算来自 LIMITS（未被这一档改掉）')
  assert.equal(PURCHASES_TIMEOUT_MS, OURS_TIMEOUTS.orders, '常量只是 OURS_TIMEOUTS.orders 的名字')
  assert.equal(
    transportBudgetOf('pay.orders', OURS_TIMEOUTS.orders),
    OURS_TIMEOUTS.orders,
    '槽位 → 预算走同一条取值链（pay 系列与 consume 一样，base 由调用方给）'
  )
  assert.equal(PURCHASES_TIMEOUT_MS, 12_000, '值一个没改')
  const code = codeOf('../../src/services/ours/purchases.ts')
  assert.equal(code.includes('12000'), false, '代码里不许再写 12000（红前就在）')
})

test('[C5] 产品语义不变：支付链路永不自动重发（retryable 只影响按钮，不影响重发）', () => {
  const failures = ['timeout', 'offline', 'server5xx', 'rateLimited', 'empty', 'unknown']
  for (const f of failures) {
    assert.equal(
      canAutoRetry({ cls: 'control', failure: f, attempt: 0 }),
      false,
      `${f}：支付 / 订单链路不许自动再发一次（重复下单、重复扣费）`
    )
  }
  // 反证：同一批失败在 data 类上是可自动重发的 —— 说明上面那条是「类」的决定，不是「失败」的决定
  assert.equal(canAutoRetry({ cls: 'data', failure: 'timeout', attempt: 0 }), true)
})

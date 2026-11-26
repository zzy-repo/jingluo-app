// [layer: unit | 依赖: 无（纯 Node：不碰 DOM、不发请求） | 耗时: <2s]
//
// Issue #896 的 **3a**：`consume` / `pay` / `migration` 的超时从「构建期冻结」下沉到
// **运行期可读的策略源**（`src/services/net/timeoutBudget.ts`），并且**行为不变**。
//
// 为什么必须先做这一步（而不是直接上 3b 的 `RequestClass` 策略表）：
//   #896 的终态是「一张表定义 connect / firstByte / idle / total / retry / backoff」。
//   只要超时的**取值**还散在三个文件里各读各的（`__ENDPOINTS__.consume.timeoutMs` /
//   `OURS_TIMEOUTS` 常量 / `migration.timeoutMs`），那张表就只能是第四个副本 ——
//   而「同一个数字有四处来源」正是 #896 要消灭的东西。
//
// 本文件钉住三件事，缺一条都不算下沉成功：
//   T1~T2 **默认值一个没动**：没有覆盖层时，取到的值与改前的来源逐字相等（行为不变）；
//   T3~T5 **覆盖只影响被点名的那一档**，且非法值（0 / 负数 / 小数 / NaN）一律丢弃 ——
//         把预算调成 0 等于「永不超时」，是本仓库最贵的一类事故；
//   T6     **端到端真的用上了**：覆盖之后，传输层收到的 `timeoutMs` 就是覆盖值
//          （只改一个取值函数而调用点照旧读常量，是这类「下沉」最典型的假成功）。
//
//   node --test tests/unit/timeout-budget-896.test.mjs

import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { consumeTimeouts } from '../../scripts/lib/endpoints.mjs'

installResolveHooks()

const { timeoutBudget, setTimeoutBudgetOverlay, resetTimeoutBudgetOverlay, currentTimeoutBudgetOverlay } =
  await import('../../src/services/net/timeoutBudget.ts')
const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { OURS_TIMEOUTS } = await import('../../src/services/ours/api.ts')

const WITHOUT_OVERLAY = () => resetTimeoutBudgetOverlay()

test('[T1] 无覆盖层：消费侧三档与改前的来源逐字相等（行为不变）', () => {
  WITHOUT_OVERLAY()
  assert.equal(timeoutBudget.consume('read'), consumeTimeouts.read, 'read 档等于 config/endpoints.json 的值')
  assert.equal(timeoutBudget.consume('write'), consumeTimeouts.write, 'write 档同上')
  assert.equal(timeoutBudget.consume('redeem'), consumeTimeouts.redeem, 'redeem 档同上')
  assert.deepEqual(currentTimeoutBudgetOverlay(), { consume: {}, pay: {} }, '默认没有任何覆盖')
})

test('[T2] 无覆盖层：支付侧 / 迁移那一次调用仍用改前的基数', () => {
  WITHOUT_OVERLAY()
  for (const slot of ['keyProbe', 'redeem', 'payLink']) {
    assert.equal(
      timeoutBudget.pay(slot, OURS_TIMEOUTS[slot]),
      OURS_TIMEOUTS[slot],
      `${slot} 没有覆盖时必须等于 OURS_TIMEOUTS.${slot}`
    )
  }
  assert.equal(timeoutBudget.migration(20000), 20000, '没有覆盖时迁移预算就是配置里的那个数')
})

test('[T3] 覆盖只影响被点名的那一档，其余继续走原来源', () => {
  WITHOUT_OVERLAY()
  setTimeoutBudgetOverlay({ consume: { read: 45000 } })
  assert.equal(timeoutBudget.consume('read'), 45000, '被覆盖的那一档变了')
  assert.equal(timeoutBudget.consume('write'), consumeTimeouts.write, '没点名的档位一个字没动')
  assert.equal(timeoutBudget.consume('redeem'), consumeTimeouts.redeem, '同上')

  setTimeoutBudgetOverlay({ pay: { payLink: 30000 } })
  assert.equal(timeoutBudget.pay('payLink', OURS_TIMEOUTS.payLink), 30000)
  assert.equal(timeoutBudget.pay('keyProbe', OURS_TIMEOUTS.keyProbe), OURS_TIMEOUTS.keyProbe, '别的槽位不受影响')
  WITHOUT_OVERLAY()
})

test('[T4] 非法覆盖值一律丢弃（0 / 负数 / 小数 / NaN 不许变成「永不超时」）', () => {
  WITHOUT_OVERLAY()
  setTimeoutBudgetOverlay({ consume: { read: 0, write: -1, redeem: 1.5 }, pay: { payLink: Number.NaN }, migration: 0 })
  assert.equal(timeoutBudget.consume('read'), consumeTimeouts.read, '0 被丢弃（0 = 永不超时，不是「立刻超时」）')
  assert.equal(timeoutBudget.consume('write'), consumeTimeouts.write, '负数被丢弃')
  assert.equal(timeoutBudget.consume('redeem'), consumeTimeouts.redeem, '小数被丢弃（毫秒预算必须是整数）')
  assert.equal(timeoutBudget.pay('payLink', OURS_TIMEOUTS.payLink), OURS_TIMEOUTS.payLink, 'NaN 被丢弃')
  assert.equal(timeoutBudget.migration(20000), 20000, 'migration 的 0 被丢弃')
  assert.deepEqual(currentTimeoutBudgetOverlay(), { consume: {}, pay: {} }, '一个非法值都没进覆盖层')
  WITHOUT_OVERLAY()
})

test('[T5] reset 之后与「从没设置过」完全一致', () => {
  setTimeoutBudgetOverlay({ consume: { read: 45000 }, migration: 30000 })
  resetTimeoutBudgetOverlay()
  assert.equal(timeoutBudget.consume('read'), consumeTimeouts.read)
  assert.equal(timeoutBudget.migration(20000), 20000)
  assert.deepEqual(currentTimeoutBudgetOverlay(), { consume: {}, pay: {} })
})

test('[T6] 端到端：覆盖之后传输层收到的 timeoutMs 就是覆盖值', async () => {
  WITHOUT_OVERLAY()
  const endpoints = createConsumeHttp().endpoints
  const seen = []
  const http = createConsumeHttp({
    endpoints,
    accessToken: () => 'jwt-abc',
    // 假 transport：只记下拿到的预算，直接回一个成功信封（零网络）
    transport: async (request) => {
      seen.push(request.timeoutMs)
      return { kind: 'response', status: 200, text: '{"code":0,"data":{}}', headers: {} }
    },
  })

  await http.call({ method: 'GET', path: '/api/v1/payment/orders/my' })
  assert.deepEqual(seen, [consumeTimeouts.read], 'GET 走 read 档（改前口径）')

  setTimeoutBudgetOverlay({ consume: { read: 45000 } })
  try {
    await http.call({ method: 'GET', path: '/api/v1/payment/orders/my' })
    assert.equal(seen.at(-1), 45000, '运行期覆盖必须真的到达传输层，而不是只改了取值函数')
  } finally {
    WITHOUT_OVERLAY()
  }
})

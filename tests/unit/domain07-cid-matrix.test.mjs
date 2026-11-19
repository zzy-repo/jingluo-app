// [layer: unit | 依赖: 无（纯 Node，零浏览器、零 React、不发网络请求） | 耗时: <1s]
// C9「cid（订单归属客户）与脏值矩阵」—— 域 7 F7-13
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 G6「ensureCustomerId 无测试 + 回归层已死」= 本文件）
//
// #331 之后 cid 只剩一个用途：**查自己的历史订单**。所以它的口径是「拿不到也不能变坏」：
//   1. 只认正整数（0 / 负数 / 小数尾巴 / 字符串垃圾 / NaN 一律当「不知道」）；
//   2. 有缓存就用缓存，不再打扰网络；
//   3. 失败**绝不记忆**（Issue #135：曾经把「启动时还没网」记成「这个会话没有 cid」，
//      之后每次点「去支付」都被直接拒绝，直到重启 App）；
//   4. 拿不到 cid 只是看不到历史，不阻断任何流程（不抛异常）。
//
// 跑法：node --test tests/unit/domain07-cid-matrix.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from '../fixtures/domain06-07/harness.mjs'
import {
  createMemoryStorage,
  createRecorder,
  json,
  rawText,
  timeout,
} from '../fixtures/domain06-07/fakes.mjs'

const harness = await createHarness()
const {
  CUSTOMER_ID_STORAGE_KEY,
  cacheCustomerId,
  ensureCustomerId,
  fetchCustomerIdFromProfile,
  parseCustomerId,
  readCachedCustomerId,
  resetCustomerIdCache,
  setCustomerIdProvider,
} = await harness.importSource('src/services/ours/customerId.ts')
const { parsePaymentRecords, fetchPaymentRecords } = await harness.importSource(
  'src/services/ours/paymentRecords.ts'
)

const reset = () => {
  setCustomerIdProvider(null)
  resetCustomerIdCache()
}

// ------------------------------------------------------------------ 行 1：脏值矩阵

test('C9/1 F7-13 cid 只认正整数：0 / 负数 / 垃圾串 / NaN / 非数字 一律当「不知道」', () => {
  const CASES = [
    [10, 10],
    [10.9, 10],
    ['10', 10],
    [' 7 ', 7],
    ['0010', 10],
    [0, null],
    [-3, null],
    ['-3', null],
    ['abc', null],
    ['10abc', null],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [true, null],
    [{ id: 10 }, null],
    [[10], null],
  ]
  for (const [input, expected] of CASES) {
    assert.equal(
      parseCustomerId(input),
      expected,
      `parseCustomerId(${JSON.stringify(input)}) 应为 ${expected}`
    )
  }
})

// ------------------------------------------------------------------ 行 2/3/4：缓存与 provider

test('C9/2 F7-13 本地已缓存 cid：直接用，不调 provider、不发请求', async () => {
  reset()
  const storage = createMemoryStorage({ [CUSTOMER_ID_STORAGE_KEY]: '10' })
  let providerCalls = 0
  setCustomerIdProvider(async () => {
    providerCalls += 1
    return 99
  })

  assert.equal(readCachedCustomerId(storage), 10)
  assert.equal(await ensureCustomerId(storage), 10)
  assert.equal(providerCalls, 0, '有缓存就不该再问网络')
  reset()
})

test('C9/3 F7-13 provider 失败不记忆（#135）：第二次仍会重新问，且拿不到 cid 只是 null、不抛', async () => {
  reset()
  const storage = createMemoryStorage()
  let providerCalls = 0
  let answer = null
  setCustomerIdProvider(async () => {
    providerCalls += 1
    return answer
  })

  assert.equal(await ensureCustomerId(storage), null, '拿不到 cid 就是 null，不该抛异常')
  assert.equal(storage.getItem(CUSTOMER_ID_STORAGE_KEY), null, '失败的结果绝不写进 localStorage')

  answer = 10
  assert.equal(await ensureCustomerId(storage), 10, '第二次必须重新问（失败没被记住）')
  assert.equal(providerCalls, 2, '两次各问一次 provider')
  assert.equal(storage.getItem(CUSTOMER_ID_STORAGE_KEY), '10', '成功后写入缓存')
  reset()
})

test('C9/4 F7-13 provider 抛错 / 超时也不崩：异常按「不知道」处理，且不写脏缓存', async () => {
  reset()
  const storage = createMemoryStorage()
  setCustomerIdProvider(async () => {
    throw new Error('network down')
  })
  assert.equal(await ensureCustomerId(storage), null)
  assert.equal(storage.getItem(CUSTOMER_ID_STORAGE_KEY), null)
  reset()
})

// ------------------------------------------------------------------ 行 5：设备码通道取 cid

test('C9/5 F7-13 没有 Key 时走设备码通道 /me 取 cid：只有 2xx + 合法 customer_id 才算拿到', async () => {
  const DEVICE = 'd-88888888888888888888888888888888'
  const CASES = [
    { name: '200 customer_id=10', reply: json(200, { customer_id: 10 }), expect: 10 },
    { name: '200 customerId="7"（字符串）', reply: json(200, { customerId: '7' }), expect: 7 },
    { name: '200 customer_id=0（脏值）', reply: json(200, { customer_id: 0 }), expect: null },
    { name: '404', reply: json(404, { error: { code: 'device_not_found' } }), expect: null },
    { name: '503', reply: json(503, {}), expect: null },
    { name: '非法 JSON', reply: rawText(200, '<html>hi</html>'), expect: null },
    { name: '超时', reply: timeout(), expect: null },
  ]

  for (const item of CASES) {
    const recorder = createRecorder([item.reply])
    const cid = await fetchCustomerIdFromProfile({
      base: 'https://apia.ecsafe.cn',
      deviceId: DEVICE,
      transport: recorder.transport,
    })
    assert.equal(cid, item.expect, item.name)
    assert.deepEqual(recorder.paths, ['GET /me'], item.name)
    assert.equal(new URL(recorder.requests[0].url).searchParams.get('device_id'), DEVICE)
  }

  // 没有设备码：一条请求都不发
  const empty = createRecorder([json(200, { customer_id: 10 })])
  assert.equal(
    await fetchCustomerIdFromProfile({
      base: 'https://apia.ecsafe.cn',
      deviceId: '  ',
      transport: empty.transport,
    }),
    null
  )
  assert.deepEqual(empty.paths, [])
})

// ------------------------------------------------------------------ 行 6：/api/orders 顺带带回的 cid

test('C9/6 F7-13 /api/orders 的 customer_id 顺带落缓存；脏值不落（免得下次拿脏 cid 查别人的单）', async () => {
  const storage = createMemoryStorage()
  const recorder = createRecorder([
    json(200, { customer_id: 10, total_paid_yuan: 0, orders: [] }),
    json(200, { customer_id: 0, total_paid_yuan: 0, orders: [] }),
  ])

  const first = await fetchPaymentRecords('sk-ours-cid-00112233445566', recorder.transport, storage)
  assert.equal(first.kind, 'ok')
  assert.equal(first.data.customerId, 10)
  assert.equal(storage.getItem(CUSTOMER_ID_STORAGE_KEY), '10', '合法 cid 必须落缓存复用')

  const second = await fetchPaymentRecords(
    'sk-ours-cid-00112233445566',
    recorder.transport,
    storage
  )
  assert.equal(second.kind, 'ok')
  assert.equal(second.data.customerId, null)
  assert.equal(storage.getItem(CUSTOMER_ID_STORAGE_KEY), '10', '脏值不许覆盖已经缓存的好 cid')

  // 解析层单测：orders 不是数组 → null（调用方按 badResponse 报错），不是「空列表」
  assert.equal(parsePaymentRecords({ customer_id: 10 }), null)
  assert.equal(parsePaymentRecords({ customer_id: 10, orders: [] }).customerId, 10)
})

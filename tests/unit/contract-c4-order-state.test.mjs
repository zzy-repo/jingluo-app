// [layer: unit | 纯 Node（假 transport），零浏览器零网络 | 耗时: <1s]
//
// C4 —— 兑换 / 订单状态机（Issue #407 / 防 #135 #157）
//
// 历史事故：
//   #135（P0）下单没带 `cid` → 新人不限购、付款记录查不到。根因之一是「订单状态」与「客户身份」
//        两套口径在客户端各写一份，界面把「查不到单」显示成「没有订单」，用户以为钱没花出去。
//   #157 兑换链路把 202（`CREDIT_PENDING`，服务端受理但还没记账）当成失败，用户反复提交；
//        把 409（卡密已用）与 404（卡密不存在）显示成同一句话，客服无从处置。
//
// 本契约锁四件事（语义）：
//   T1 状态枚举闭合：五个合法状态；大小写无关；**认不出的归 failed，绝不当成 fulfilled**
//      （认错方向等于白送用户一次「已完成」的错觉）。
//   T2 不可回退：`fulfilled / expired / failed` 是终态，刷新不会再变，也不该继续轮询；
//      只有 `paid`（钱到了、卡还没发）值得继续刷。
//   T3 409 / 404 语义分层：404 = 这条记录不存在（不重试、不代表 Key 有问题），
//      409 = 卡密已被使用（提示不要重复提交），5xx / 超时 = 可重试。三层不许互相冒充。
//   T4 卡密与兑换的两个维度各自独立：`card_status`（leased/used/void）与
//      `redeem_state`（issued/redeemed）不是同一个字段，认不出就是「不知道」而不是某个默认值。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { PURCHASE_STATUSES, purchaseStatusOf, parsePurchaseOrder, fetchPurchasesVia, PurchaseError } = await import(
  '../../src/services/ours/purchases.ts'
)
const { TRAIL_ORDER_STATUSES, trailStatusOf, trailToneOf } = await import('../../src/services/ours/trail.ts')
const { redeemCard } = await import('../../src/services/ours/api.ts')
const { shouldKeepPolling } = await import(
  '../../src/components/settings/PaymentTrailView.ts'
)

const API_KEY = 'sk-contract-test-0001'

/** 假 transport：只回一次固定结果，把「请求了什么 / 怎么解释响应」拆开断言 */
const transportOf = (result) => async () => result
const respond = (status, body) => ({ kind: 'response', status, text: typeof body === 'string' ? body : JSON.stringify(body) })

/** 一行 = 一种「服务端这么说 → 界面必须是这个结论」 */
const STATE_ROWS = [
  {
    id: 'T1-a',
    what: '订单状态枚举闭合：只有五个，且顺序即「进度」（pending → paid → fulfilled）',
    check: () => {
      assert.deepEqual([...PURCHASE_STATUSES], ['pending', 'paid', 'fulfilled', 'expired', 'failed'])
      assert.deepEqual([...TRAIL_ORDER_STATUSES], ['created', 'paid', 'fulfilled', 'expired', 'failed'])
    },
  },
  {
    id: 'T1-b',
    what: '状态归一大小写无关（后端给 FULFILLED / Fulfilled 都认）',
    check: () => {
      for (const raw of ['FULFILLED', 'Fulfilled', ' fulfilled ']) {
        assert.equal(purchaseStatusOf(raw), 'fulfilled', `purchaseStatusOf(${JSON.stringify(raw)})`)
        assert.equal(trailStatusOf(raw), 'fulfilled', `trailStatusOf(${JSON.stringify(raw)})`)
      }
    },
  },
  {
    id: 'T1-c',
    what: '认不出的状态一律归 failed（绝不归 fulfilled —— 那等于白送用户一次「已完成」）',
    check: () => {
      for (const raw of ['', 'weird', 'PARTIALLY_REFUNDED', 'ok']) {
        assert.equal(purchaseStatusOf(raw), 'failed', `purchaseStatusOf(${JSON.stringify(raw)})`)
        assert.equal(trailStatusOf(raw), 'failed', `trailStatusOf(${JSON.stringify(raw)})`)
      }
    },
  },
  {
    id: 'T2-a',
    what: '终态不再轮询：fulfilled / expired / failed 刷新也不会变（不可回退的实现面）',
    check: () => {
      for (const status of ['fulfilled', 'expired', 'failed']) {
        assert.equal(shouldKeepPolling(status, 0), false, `${status} 不该继续轮询`)
        assert.equal(shouldKeepPolling(status, 1), false, `${status} 不该继续轮询`)
      }
    },
  },
  {
    id: 'T2-b',
    what: 'paid（钱到了、卡还没发）在封顶窗口内必须继续刷；超过封顶就停手（别无限转圈）',
    check: () => {
      assert.equal(shouldKeepPolling('paid', 0), true, 'paid 必须继续轮询（否则用户看不到发卡）')
      assert.equal(shouldKeepPolling('paid', Number.MAX_SAFE_INTEGER), false, '超过封顶必须停手')
      assert.equal(shouldKeepPolling('paid', Number.NaN), true, '非法耗时按 0 处理，不能因此判定成「永远别刷」')
    },
  },
  {
    id: 'T2-c',
    what: '色调不许把「过期」染成「失败」（expired 24h 内付款还能补发，是「有救」不是「钱没了」）',
    check: () => {
      assert.equal(trailToneOf('expired'), 'muted')
      assert.equal(trailToneOf('failed'), 'danger')
      assert.equal(trailToneOf('fulfilled'), 'success')
      assert.equal(trailToneOf('paid'), 'pending')
      assert.equal(trailToneOf('created'), 'pending')
    },
  },
  {
    id: 'T4-a',
    what: 'card_status 与 redeem_state 是两个独立维度：非法值一律 null（不许默认成 used/redeemed）',
    check: () => {
      const order = parsePurchaseOrder({
        out_trade_no: 'CP202611190000001',
        status: 'PAID',
        card_status: 'leased',
        redeem_state: 'issued',
        plan_points: 300,
        amount_yuan: 3,
      })
      assert.equal(order.status, 'paid')
      assert.equal(order.cardStatus, 'leased')
      assert.equal(order.redeemState, 'issued')
      const broken = parsePurchaseOrder({ out_trade_no: 'CP2', status: 'PAID', card_status: 'maybe', redeem_state: '?' })
      assert.equal(broken.cardStatus, null)
      assert.equal(broken.redeemState, null)
    },
  },
]

test('C4 状态机：枚举闭合 / 终态不回退 / 两个维度独立（防 #135 #157）', tableTest('C4', STATE_ROWS, (row) => row.check()))

/** 一行 = 一次兑换响应的**含义**（#157 的核心：202 不是失败、409 与 404 是两件事） */
const REDEEM_ROWS = [
  {
    id: 'T3-a',
    what: '202 / CREDIT_PENDING = 受理中，**不是失败**（界面不能说失败，也不能催用户重试）',
    response: respond(202, { code: 'CREDIT_PENDING' }),
    expect: { kind: 'pending' },
  },
  {
    id: 'T3-b',
    what: '200 + ok:true = 成功，并带回积分',
    response: respond(200, { ok: true, points: 300 }),
    expect: { kind: 'success', points: 300 },
  },
  {
    id: 'T3-c',
    what: '409 CARD_ALREADY_USED = 卡密已被使用：文案是「别重复提交」，不可重试',
    response: respond(409, { code: 'CARD_ALREADY_USED' }),
    expect: { kind: 'error', code: 'CARD_ALREADY_USED', messageKey: 'oursErrCardUsed', retryable: false },
  },
  {
    id: 'T3-d',
    what: '404 = 这条记录/卡密不存在：不可重试，也不许说成「已被使用」',
    response: respond(404, { code: 'CARD_NOT_FOUND' }),
    expect: { kind: 'error', code: 'CARD_NOT_FOUND', messageKey: 'oursErrCardNotFound', retryable: false },
  },
  {
    id: 'T3-e',
    what: '503 VERIFY_UNAVAILABLE = 服务暂时不可用：可重试，不能说成卡密有问题',
    response: respond(503, { code: 'VERIFY_UNAVAILABLE' }),
    expect: { kind: 'error', code: 'VERIFY_UNAVAILABLE', messageKey: 'oursErrVerifyUnavailable', retryable: true },
  },
  {
    id: 'T3-f',
    what: '400 API_KEY_INVALID = 要用户重填 Key：不可重试（重试同一把 Key 没有意义）',
    response: respond(400, { code: 'API_KEY_INVALID' }),
    expect: { kind: 'error', code: 'API_KEY_INVALID', messageKey: 'oursErrKeyInvalid', retryable: false },
  },
  {
    id: 'T3-g',
    what: '超时 = 可重试（request_id 用卡密本身，重发会被服务端识别成同一笔）',
    response: { kind: 'timeout' },
    expect: { kind: 'error', code: 'TIMEOUT', retryable: true },
  },
]

test('C4 兑换响应语义：202 不是失败 / 409≠404 / 5xx 可重试（防 #157）', tableTest('C4-redeem', REDEEM_ROWS, async (row) => {
  const result = await redeemCard(
    { cardNo: 'MUSE-3CYP-5NA3-AHSE-A3SR', apiKey: API_KEY, requestId: 'MUSE-3CYP-5NA3-AHSE-A3SR' },
    transportOf(row.response)
  )
  assert.equal(result.kind, row.expect.kind, `kind 不对：${JSON.stringify(result)}`)
  if (row.expect.kind === 'error') {
    assert.equal(result.code, row.expect.code)
    assert.equal(result.retryable, row.expect.retryable, '可重试与否是用户下一步动作的唯一依据')
    if (row.expect.messageKey) assert.equal(result.messageKey, row.expect.messageKey)
    // 卡号只许露后 4 位（#387 同族：错误路径最容易把原文带出去）
    assert.ok(!JSON.stringify(result).includes('MUSE-3CYP'), '错误结果里不许出现完整卡密')
  }
  if (row.expect.kind === 'success') assert.equal(result.points, row.expect.points)
}))

/** 订单查询：同一批 HTTP 状态码，在「订单列表」这条链路上必须是另一套解释 */
const ORDER_ERROR_ROWS = [
  { id: 'T3-h', what: '404 = 这条记录不存在（rejected，不重试、不需要重填 Key）', status: 404, kind: 'rejected', retryable: false, needsKey: false },
  { id: 'T3-i', what: '401/403 = Key 看不到这些订单（needsKey=true，重试没用）', status: 401, kind: 'unauthorized', retryable: false, needsKey: true },
  { id: 'T3-j', what: '429 = 限流（可重试）', status: 429, kind: 'rateLimited', retryable: true, needsKey: false },
  { id: 'T3-k', what: '5xx = 服务端故障（可重试，且不许说成「没有订单」）', status: 503, kind: 'server', retryable: true, needsKey: false },
]

test('C4 订单查询失败分层：404 不重试、401 要重填 Key、5xx 可重试（防 #135）', tableTest('C4-orders', ORDER_ERROR_ROWS, async (row) => {
  await assert.rejects(
    fetchPurchasesVia({ apiKey: API_KEY, limit: 20, offset: 0 }, transportOf(respond(row.status, { code: '' }))),
    (error) => {
      assert.ok(error instanceof PurchaseError, `不是 PurchaseError：${error}`)
      assert.equal(error.kind, row.kind)
      assert.equal(error.retryable, row.retryable)
      assert.equal(error.needsKey, row.needsKey)
      return true
    }
  )
}))

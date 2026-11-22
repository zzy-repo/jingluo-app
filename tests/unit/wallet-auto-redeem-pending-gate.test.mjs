// [layer: unit | 依赖: 无（纯 Node + 内存 localStorage + 可编程假 transport，零浏览器、零真实网络） | 耗时: <1s]
//
// #840 跟进 ——「自动兑现的待兑判据」收紧：用户自己兑换产生的记录（`GET orders/my` 里
// `payment_type=redeem_code` / `id` 为负 / `out_trade_no=redeem-…`，status=COMPLETED，且 `recharge_code`
// 是完整未打码的 32 位 hex）不是待兑订单；`redeem_state` 非 `issued`、`redeemable` 存在且不为 true 也不是。
// 字段缺失（老后端）时保持原行为：COMPLETED + 完整卡号 + history 交叉比对。
//
// 手法同 `wallet-auto-redeem-784.test.mjs`：真 `createConsumeClient` + `recordingTransport`，
// 断言真发出的端点与请求体；没登记的端点被打到就抛错。订单对象由真 `parseMyOrder` 从 snake_case 造出。
//
//   node tests/run-layer.mjs unit --only wallet-auto-redeem-pending-gate
import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'

import { installChatBridge, installEndpointsGlobals, setupDom } from '../helpers/dom-env.mjs'
import { panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

installChatBridge()
installEndpointsGlobals()
const dom = setupDom()
globalThis.__log = { records: [], events: [], actions: [] }

const autoRedeem = await import('../../src/components/consume/walletAutoRedeem.ts')
const ordersApi = await import('../../src/services/consume/orders.ts')
const { createConsumeClient } = await import('../../src/services/consume/index.ts')

test.after(() => dom.restore())
beforeEach(() => {
  autoRedeem.forgetAutoSubmitted()
  globalThis.__log.records.length = 0
})

const JWT = 'jwt-pending-gate-not-real'
/** 真实订单的卡号 */
const REAL_CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
/** staging 实测：兑换记录的 `recharge_code` 是完整 32 位 hex，没打码 */
const REDEEM_CARD = '0123456789abcdef0123456789abcdef'

const REDEEM_POST = 'POST /api/v1/redeem'
const HISTORY_GET = 'GET /api/v1/redeem/history'
const PROFILE_GET = 'GET /api/v1/user/profile'
const REDEEM_OK = panelOk({ message: 'success', type: 'balance', value: 10 })
const PROFILE_OK = panelOk({ id: 7, email: 'gate@example.com', balance: 12 })
const HISTORY_EMPTY = panelOk({ items: [], total: 0 })

const parse = (raw) => {
  const parsed = ordersApi.parseMyOrder(raw)
  assert.notEqual(parsed, null, '订单 fixture 必须能解析')
  return parsed
}

/** 一条真实订单（issued、完整卡号）；更早 */
const realOrder = (over = {}) =>
  parse({
    id: 501,
    out_trade_no: 'T-REAL-0001',
    status: 'COMPLETED',
    amount: 10,
    pay_amount: 9.9,
    payment_type: 'alipay',
    recharge_code: REAL_CARD,
    redeem_state: 'issued',
    created_at: '2026-11-13T10:00:00+08:00',
    paid_at: '2026-11-13T10:01:00+08:00',
    ...over,
  })

/** staging 实测的兑换记录；比真实订单**更新**（这样漏判时 `pickPendingOrder` 一定先挑到它） */
const redeemRecord = (over = {}) =>
  parse({
    id: -13259,
    out_trade_no: 'redeem-13259',
    status: 'COMPLETED',
    amount: 10,
    pay_amount: 0,
    payment_type: 'redeem_code',
    recharge_code: REDEEM_CARD,
    created_at: '2026-11-20T10:00:00+08:00',
    paid_at: '2026-11-20T10:00:00+08:00',
    ...over,
  })

/** 老后端形状：只有 COMPLETED + 完整卡号 + out_trade_no 之类，没有 id / payment_type / redeem_state / redeemable */
const legacyOrder = () =>
  parse({
    out_trade_no: 'T-LEGACY-0001',
    status: 'COMPLETED',
    amount: 10,
    recharge_code: REAL_CARD,
    created_at: '2026-11-13T10:00:00+08:00',
  })

const scene = (orders, replies = {}) => {
  const table = {
    [HISTORY_GET]: HISTORY_EMPTY,
    [REDEEM_POST]: REDEEM_OK,
    [PROFILE_GET]: PROFILE_OK,
    ...replies,
  }
  const recorder = recordingTransport((request) => {
    const key = `${request.method} ${pathOf(request.url).split('?')[0]}`
    if (!Object.hasOwn(table, key)) {
      throw new Error(`没有预期的端点被打到：${key}`)
    }
    return table[key]
  })
  const client = createConsumeClient({ accessToken: () => JWT, transport: recorder.transport })
  return {
    posts: () => recorder.calls.filter((request) => request.method === 'POST'),
    /** 某个端点（`METHOD /path`）被打了几次；`recorder.countOf` 只认方法名，不能拿来数端点 */
    hits: (key) => recorder.sequence().filter((item) => item === key).length,
    calls: recorder.calls,
    run: () => autoRedeem.runWalletAutoRedeem({ client, signedIn: true, loadOrders: async () => orders }),
  }
}

const bodyOf = (request) => (typeof request.body === 'string' ? JSON.parse(request.body) : request.body)

// ------------------------------------------------------------------ ① 只有兑换记录

test('① 只有一条 redeem_code 记录（id=-13259 / out_trade_no=redeem-13259 / 完整卡号 / COMPLETED）→ 0 次 POST /redeem，skipped:no-pending', async () => {
  const s = scene([redeemRecord()])
  const outcome = await s.run()
  assert.equal(s.hits(REDEEM_POST), 0, '兑换记录不是待兑订单，不许再发 POST /redeem')
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'no-pending' })
  assert.equal(s.calls.length, 0, '没有候选 → history 也不用查，一个请求都不发')
})

test('① 补：三个信号各自单独成立也排除（payment_type / 负 id / redeem- 前缀）', async () => {
  const variants = [
    { id: 900, out_trade_no: 'T-X-1', payment_type: 'redeem_code' },
    { id: -5, out_trade_no: 'T-X-2', payment_type: 'alipay' },
    { id: 901, out_trade_no: 'redeem-77', payment_type: 'alipay' },
  ]
  for (const over of variants) {
    autoRedeem.forgetAutoSubmitted()
    const s = scene([realOrder(over)])
    const outcome = await s.run()
    assert.equal(s.hits(REDEEM_POST), 0, `信号 ${JSON.stringify(over)} 应排除`)
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'no-pending' })
  }
})

// ------------------------------------------------------------------ ② 真实订单 + 兑换记录

test('② 真实订单（issued）+ 兑换记录同时存在 → 只对真实订单发 1 次 POST，code 是真实订单卡号', async () => {
  const s = scene([redeemRecord(), realOrder()])
  const outcome = await s.run()
  assert.equal(outcome.kind, 'credited')
  assert.equal(s.hits(REDEEM_POST), 1)
  assert.equal(s.posts().length, 1, '全程只有这一发 POST')
  assert.equal(bodyOf(s.posts()[0]).code, REAL_CARD, 'body.code 必须是真实订单的卡号，不是兑换记录的 hex')
  assert.notEqual(bodyOf(s.posts()[0]).code, REDEEM_CARD)
})

// ------------------------------------------------------------------ ③ redeem_state 非 issued

for (const state of ['redeemed', 'void', 'expired']) {
  test(`③ redeem_state=${state} → 不发请求（skipped:no-pending）`, async () => {
    const s = scene([realOrder({ redeem_state: state })])
    const outcome = await s.run()
    assert.equal(s.hits(REDEEM_POST), 0)
    assert.deepEqual(outcome, { kind: 'skipped', reason: 'no-pending' })
    assert.equal(s.calls.length, 0)
  })
}

// ------------------------------------------------------------------ ④ redeemable

test('④ redeemable=false（字段存在且不为 true）→ 不发请求', async () => {
  const s = scene([realOrder({ redeemable: false })])
  const outcome = await s.run()
  assert.equal(s.hits(REDEEM_POST), 0)
  assert.deepEqual(outcome, { kind: 'skipped', reason: 'no-pending' })
})

test('④ redeemable=true 且 redeem_state=issued → 发 1 次 POST，body 是该卡号', async () => {
  const s = scene([realOrder({ redeemable: true, redeem_state: 'issued' })])
  const outcome = await s.run()
  assert.equal(outcome.kind, 'credited')
  assert.equal(s.hits(REDEEM_POST), 1)
  assert.equal(bodyOf(s.posts()[0]).code, REAL_CARD)
})

test('④ 补：直接喂 isPendingOrder，字段类型不对不抛错、不误排除', () => {
  // id 是字符串 / paymentType 是数字 / redeemState 是 null：认不出 = 没表态 = 不触发对应排除
  const weird = { status: 'COMPLETED', rechargeCode: REAL_CARD, id: '-5', paymentType: 7, outTradeNo: 12, redeemState: null }
  assert.equal(autoRedeem.isPendingOrder(weird), true)
  // redeemable 不是 true 的任何存在值（含字符串 'yes'）→ 排除
  assert.equal(autoRedeem.isPendingOrder({ status: 'COMPLETED', rechargeCode: REAL_CARD, redeemable: 'yes' }), false)
  assert.equal(autoRedeem.pickPendingOrder([weird]), weird)
})

// ------------------------------------------------------------------ ⑤ 向后兼容

test('⑤ 向后兼容：redeem_state / redeemable / payment_type / id / out_trade_no 全缺失，仅 COMPLETED + 完整卡号 → 仍发 1 次', async () => {
  const bare = parse({ status: 'COMPLETED', recharge_code: REAL_CARD, created_at: '2026-11-13T10:00:00+08:00' })
  assert.equal(bare.outTradeNo, '')
  assert.equal(bare.paymentType, '')
  assert.equal('id' in bare, false)
  assert.equal('redeemState' in bare, false)
  assert.equal('redeemable' in bare, false)
  const s = scene([bare])
  const outcome = await s.run()
  assert.equal(outcome.kind, 'credited')
  assert.equal(s.hits(REDEEM_POST), 1)
  assert.equal(bodyOf(s.posts()[0]).code, REAL_CARD)
})

test('⑤ 向后兼容：老后端订单（有 out_trade_no，其余新字段缺失）仍发 1 次；history 里已有这张卡则仍跳过', async () => {
  const s1 = scene([legacyOrder()])
  assert.equal((await s1.run()).kind, 'credited')
  assert.equal(s1.hits(REDEEM_POST), 1)

  autoRedeem.forgetAutoSubmitted()
  const s2 = scene([legacyOrder()], { [HISTORY_GET]: panelOk({ items: [{ code: REAL_CARD, type: 'balance', value: 10 }], total: 1 }) })
  assert.deepEqual(await s2.run(), { kind: 'skipped', reason: 'already-redeemed' })
  assert.equal(s2.hits(REDEEM_POST), 0)
})

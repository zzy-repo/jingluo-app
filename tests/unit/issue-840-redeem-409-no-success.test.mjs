// [layer: unit | 依赖: 无（纯 Node，可编程假 transport，零网络） | 耗时: <0.3s]
//
// **#840 回归**：重复兑换一张已经兑换过的卡密，页面不许再显示「兑换成功」。
//
// 根因（`src/services/consume/redeem.ts` 的 `interpret`）：收到 `409 REDEEM_CODE_USED` 时先拉一页
// `GET /api/v1/redeem/history`，只要历史里有这张卡（全码匹配或「末 4 位 + 长度」匹配）就返回
// `{kind:'redeemed', credited:'history'}` —— 界面按成功处理、还刷新了余额。
// 那段兜底本意是救「超时但其实成功」，但它分不清「本次成功的响应丢了」和「这张卡以前就兑换过」。
//
// 本文件钉的就是 #840 的五条关闭条件里能纯逻辑验证的四条（第 5 条见 CARD_* 那几行）：
//   N1 409 + `REDEEM_CODE_USED` + **历史里确实有这张卡** → 仍是失败，且一次 history 都没发
//   N2 409 + `REDEEM_CODE_ALREADY_REDEEMED` + 历史命中 → 仍是失败，显示后端 message
//   N3 4xx 全家（USED / ALREADY_REDEEMED / DISABLED / EXPIRED / NOT_FOUND / 429）都不回查历史
//   N4 超时 / 连不上 / 5xx + 历史里有这张卡 → **才**判成功（`credited:'history'`）—— 兜底没有丢
//   N5 5xx + 历史未命中 → `pending`（可重试但必须用户点），不是失败也不是成功
//   N6「我的卡密」判定：`issued` + `redeemable` 才给「去兑换」，`void` / `expired` 不给
//
//   node --test tests/unit/issue-840-redeem-409-no-success.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { jsonReply, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { redeemCode } = await import('../../src/services/consume/redeem.ts')
const { isOrderRedeemable, parseMyOrder } = await import('../../src/services/consume/orders.ts')

/** 卡密尾 4 位 = 8401；服务端在历史里会打码成 `MUSE-****-8401` */
const CODE = 'MUSE-ISSUE-840-0000-8401'

/** 历史里**有**这张卡（旧实现就是靠这条把重复兑换翻成「兑换成功」） */
const HISTORY_HIT = {
  code: 0,
  message: 'success',
  data: { items: [{ code: 'MUSE-****-8401', type: 'balance', value: 10 }], total: 1 },
}
const HISTORY_MISS = { code: 0, message: 'success', data: { items: [], total: 0 } }

const POST = 'POST /api/v1/redeem'
const HISTORY = 'GET /api/v1/redeem/history'

const scene = ({ post, history }) => {
  const recorder = recordingTransport((request) => {
    // `pathOf` 会剥掉 host 与部署前缀（`/staging`），断言只认端点本身
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/redeem') {
      return post()
    }
    if (request.method === 'GET' && path === '/api/v1/redeem/history') {
      return history()
    }
    throw new Error(`没有预期的端点被打到：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => 'jwt-840', transport: recorder.transport })
  return { http, ...recorder }
}

/** 4xx 的五个业务码（后端契约表，#840 那张表就是唯一口径） */
const REJECTIONS = [
  { reason: 'REDEEM_CODE_USED', status: 409, message: '该卡密已被兑换', key: 'consumeErrCardUsed' },
  { reason: 'REDEEM_CODE_ALREADY_REDEEMED', status: 409, message: '你已兑换过这张卡密', key: 'consumeErrCardAlreadyRedeemed' },
  { reason: 'REDEEM_CODE_DISABLED', status: 409, message: '该卡密已作废', key: 'consumeErrCardDisabled' },
  { reason: 'REDEEM_CODE_EXPIRED', status: 409, message: '该卡密已过期', key: 'consumeErrCardNotFoundOrExpired' },
  { reason: 'REDEEM_CODE_NOT_FOUND', status: 404, message: '卡密不存在，请检查后重试', key: 'consumeErrCardNotFound' },
]

const ROWS = [
  {
    id: 'N1',
    what: '#840 核心：409 REDEEM_CODE_USED + 历史里**有**这张卡 → 失败（不判成功），且一次 history 都没发',
    run: async () => {
      const s = scene({
        post: () => jsonReply(409, { code: 409, message: '该卡密已被兑换', reason: 'REDEEM_CODE_USED' }),
        history: () => jsonReply(200, HISTORY_HIT),
      })
      const outcome = await redeemCode(s.http, { code: CODE })
      assert.deepEqual(s.sequence(), [POST], '4xx 一律不回查历史（修复前这里会是 [POST, GET /api/v1/redeem/history]）')
      assert.equal(outcome.kind, 'failed', '重复兑换必须显示失败，不能是 redeemed')
      assert.equal(outcome.error.code, 'REDEEM_CODE_USED')
      assert.equal(outcome.error.showServerMessage, true, '界面显示后端本地化的 message')
      assert.equal(outcome.error.message, '该卡密已被兑换')
      assert.equal('refreshProfile' in outcome, false, '失败不重拉 /user/profile（旧实现把 409 判成功后还会刷余额）')
    },
  },
  {
    id: 'N2',
    what: '409 REDEEM_CODE_ALREADY_REDEEMED（本人已兑换过）+ 历史命中 → 失败，message 上屏',
    run: async () => {
      const s = scene({
        post: () => jsonReply(409, { code: 409, message: '你已兑换过这张卡密', reason: 'REDEEM_CODE_ALREADY_REDEEMED' }),
        history: () => jsonReply(200, HISTORY_HIT),
      })
      const outcome = await redeemCode(s.http, { code: CODE })
      assert.deepEqual(s.sequence(), [POST], '新码同样是 4xx 终态：不回查历史')
      assert.equal(outcome.kind, 'failed')
      assert.equal(outcome.error.code, 'REDEEM_CODE_ALREADY_REDEEMED', '新错误码要被认出来，不许掉进 HTTP 兜底')
      assert.equal(outcome.error.i18nKey, 'consumeErrCardAlreadyRedeemed')
      assert.equal(outcome.error.showServerMessage, true)
      assert.equal(outcome.error.message, '你已兑换过这张卡密')
    },
  },
  {
    id: 'N3',
    what: '4xx 全家（USED / ALREADY_REDEEMED / DISABLED / EXPIRED / NOT_FOUND / 429）一律不回查历史',
    run: async () => {
      for (const item of REJECTIONS) {
        const s = scene({
          post: () => jsonReply(item.status, { code: item.status, message: item.message, reason: item.reason }),
          history: () => jsonReply(200, HISTORY_HIT),
        })
        const outcome = await redeemCode(s.http, { code: CODE })
        assert.deepEqual(s.sequence(), [POST], `${item.reason}：4xx 不许回查历史`)
        assert.equal(outcome.kind, 'failed', `${item.reason}：终态失败`)
        assert.equal(outcome.error.code, item.reason)
        assert.equal(outcome.error.i18nKey, item.key, `${item.reason}：前端兜底文案`)
        assert.equal(outcome.error.showServerMessage, true, `${item.reason}：服务端 message 可上屏`)
      }
      // 429 也是 4xx：同样不回查（旧实现把它当 retryable 去查历史）
      const limited = scene({
        post: () => jsonReply(429, { code: 429, message: 'redeem rate limited', reason: 'REDEEM_RATE_LIMITED' }),
        history: () => jsonReply(200, HISTORY_HIT),
      })
      const limitedOutcome = await redeemCode(limited.http, { code: CODE })
      assert.deepEqual(limited.sequence(), [POST], '429 也是 4xx：不回查历史')
      assert.equal(limitedOutcome.kind, 'failed')
    },
  },
  {
    id: 'N4',
    what: '兜底还在：超时 / 连不上 / 5xx + 历史里有这张卡 → 判成功（`credited:"history"`）',
    run: async () => {
      for (const post of [
        { why: '超时', reply: () => ({ kind: 'timeout' }) },
        { why: '连不上', reply: () => ({ kind: 'network' }) },
        { why: '5xx', reply: () => jsonReply(503, { code: 503, message: 'gateway down' }) },
      ]) {
        const s = scene({ post: post.reply, history: () => jsonReply(200, HISTORY_HIT) })
        const outcome = await redeemCode(s.http, { code: CODE })
        assert.deepEqual(s.sequence(), [POST, HISTORY], `${post.why}：结果不可知 → 才允许查一次历史`)
        assert.equal(outcome.kind, 'redeemed', `${post.why} + 历史命中 = 已到账（兜底没被砍掉）`)
        assert.equal(outcome.credited, 'history')
        assert.equal(outcome.refreshProfile, true)
      }
    },
  },
  {
    id: 'N5',
    what: '5xx + 历史未命中 → pending（可重试但必须用户点）：既不是成功，也不是「失败」',
    run: async () => {
      const s = scene({ post: () => jsonReply(502, { code: 502, message: 'bad gateway' }), history: () => jsonReply(200, HISTORY_MISS) })
      const outcome = await redeemCode(s.http, { code: CODE })
      assert.deepEqual(s.sequence(), [POST, HISTORY])
      assert.equal(outcome.kind, 'pending')
      assert.equal(outcome.verified, 'not_credited')
      assert.equal(outcome.canRetry, true)
    },
  },
  {
    id: 'N6',
    what: '#840 关闭条件 5：「我的卡密」`issued` + `redeemable` 才给「去兑换」，`void` / `expired` 不给',
    run: async () => {
      // 服务端 `GET /api/v1/payment/orders/my` 的条目（snake_case 原样喂进去）
      const order = (fields) =>
        parseMyOrder({
          out_trade_no: 'T-840',
          status: 'COMPLETED',
          recharge_code: 'MUSE-TEST-8401',
          amount: 10,
          ...fields,
        })

      // 服务端说能兑 → 给按钮
      assert.equal(isOrderRedeemable(order({ redeem_state: 'issued', redeemable: true })), true)
      // 已作废 / 已过期 → 不给（这条正是 #840 的第二个毛病：作废的卡上还长着「去兑换」）
      assert.equal(order({ redeem_state: 'void' }).redeemState, 'void', '`void` 要被认出来，不许解析成 null')
      assert.equal(order({ redeem_state: 'expired' }).redeemState, 'expired', '`expired` 要被认出来')
      assert.equal(isOrderRedeemable(order({ redeem_state: 'void' })), false)
      assert.equal(isOrderRedeemable(order({ redeem_state: 'expired' })), false)
      // 已兑换 / 服务端显式说不可兑 / 没有卡号 → 都不给
      assert.equal(isOrderRedeemable(order({ redeem_state: 'redeemed' })), false)
      assert.equal(isOrderRedeemable(order({ redeem_state: 'issued', redeemable: false })), false)
      assert.equal(isOrderRedeemable(parseMyOrder({ out_trade_no: 'T-1', status: 'PENDING' })), false)
      // 老服务端（不发 redeem_state / redeemable）：沿用「有卡号就能兑」，不把线上未兑换的卡锁死
      assert.equal(order({ redeem_state: 'issued' }).redeemable, undefined)
      assert.equal(isOrderRedeemable(order({ redeem_state: 'issued' })), true)
      assert.equal(isOrderRedeemable(order({})), true)
    },
  },
]

test('C840 重复兑换不再判成功：4xx 不回查历史', tableTest('C840', ROWS, async (row) => row.run()))

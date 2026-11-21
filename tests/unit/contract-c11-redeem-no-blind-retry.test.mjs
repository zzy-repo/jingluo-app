// [layer: unit | 依赖: 无（纯 Node，可编程假 transport，零网络） | 耗时: <0.2s]
//
// C11 —— redeem **绝不盲目重试**（对外契约；#487 阶段③，替代被删的 C4）
//
// 契约原文（`docs/sub2api-client-contract.md` §5 第一行）：
//   `POST /api/v1/redeem` 没有幂等键 → 超时后**先核对到账**（`GET /api/v1/redeem/history`），
//   未到账才允许重试，且**要用户手动确认**。
//
// 所以对外承诺只有三句（换实现也必须继续成立）：
//   ① 为同一张卡，**每次调用最多 2 发 POST**，且只有「用户明确确认」时才可能有第二发；
//   ② 结果不确定时，结论只能是「已到账」或「待确认」，**不许**是「兑换失败」；
//   ③ 第二发之前一定要有一次 history 查询 —— 顺序是承诺的一部分，次数对、顺序错一样是重复兑换。
//
// 推论（Y8 锁的那条）：`202 {code:0,message:"accepted"}` / `status:"accepted|processing|pending"`
// 是「结果不确定」的一种，**2xx ≠ 到账**；没经过 history 核对就回「已到账」同样违反 ②。
//
// 与 `consume-redeem-compensation.test.mjs`（L0）的分工：L0 钉的是**当前实现**的分支走法，
// 这里钉的是**接口承诺**（换实现也要过）。所以本文件按「调用方观察到的结论 + 调用序列」写，
// 不碰内部函数名，也不断言四态之外的东西。
//
// 负向验证（本单实测）：把 `redeemCode` 里的「先 history 再确认重发」改成「先重试」→ Y1/Y6 红；
// 把 409 直接判成失败（不查 history）→ Y7 红；把 `interpret` 的 pending 改成 failed → Y4/Y5 红；
// 把 202 直接判成 redeemed（不查 history）→ Y8 红。
//
//   node --test tests/unit/contract-c11-redeem-no-blind-retry.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { jsonReply, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { redeemCode } = await import('../../src/services/consume/redeem.ts')

const CODE = 'MUSE-C11-0000-WXYZ-9876'
const POST = 'POST /api/v1/redeem'
const HISTORY = 'GET /api/v1/redeem/history'

const HISTORY_HIT = { code: 0, message: 'success', data: { items: [{ code: 'MUSE-C11-****-9876', type: 'balance', value: 30 }], total: 1 } }
const HISTORY_MISS = { code: 0, message: 'success', data: { items: [], total: 0 } }

/** 首发回应（四种「结果不确定」的入口 + 一种确定的业务失败） */
const FIRST_SHOTS = {
  timeout: () => ({ kind: 'timeout' }),
  '5xx': () => jsonReply(503, { code: 503, message: 'gateway down' }),
  '409-used': () => jsonReply(409, { code: 409, message: 'code already used', reason: 'REDEEM_CODE_USED' }),
  '404-not-found': () => jsonReply(404, { code: 404, message: 'redeem code not found', reason: 'REDEEM_CODE_NOT_FOUND' }),
  // 受理态：2xx + `code:0`，但语义是「已受理、结果待定」（契约 §4 的异步形状）—— 结果同样**不确定**
  '202-accepted': () => jsonReply(202, { code: 0, message: 'accepted' }),
}

/** 一次完整的「首发 → 补偿核对」场景 */
const runScene = async ({ first, history, confirm = false }) => {
  const recorder = recordingTransport((request) => {
    const path = request.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/redeem') {return FIRST_SHOTS[first]()}
    if (request.method === 'GET' && path === '/api/v1/redeem/history') {return history()}
    throw new Error(`没有预期的端点被打到：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => 'jwt-c11', transport: recorder.transport })
  const outcome = await redeemCode(http, confirm ? { code: CODE, retryAfterConfirm: true } : { code: CODE })
  return { outcome, sequence: recorder.sequence(), postCount: recorder.countOf('POST') }
}

const ROWS = [
  {
    id: 'Y1',
    what: '同一张卡每次调用最多 2 发 POST；**没确认就只发 1 发**（不论首发是超时、5xx 还是 409）',
    run: async () => {
      for (const first of Object.keys(FIRST_SHOTS)) {
        const withoutConfirm = await runScene({ first, history: () => jsonReply(200, HISTORY_MISS) })
        assert.equal(withoutConfirm.postCount, 1, `${first}：未确认时只许发一次（实际 ${withoutConfirm.postCount}）`)
        const withConfirm = await runScene({ first, history: () => jsonReply(200, HISTORY_MISS), confirm: true })
        assert.ok(withConfirm.postCount <= 2, `${first}：一次调用最多两发（实际 ${withConfirm.postCount}）`)
      }
    },
  },
  {
    id: 'Y2',
    what: '结果不确定（超时 / 5xx）→ 结论**绝不是**「兑换失败」：只可能是「已到账」或「待确认」',
    run: async () => {
      for (const first of ['timeout', '5xx']) {
        for (const history of [() => jsonReply(200, HISTORY_HIT), () => jsonReply(200, HISTORY_MISS), () => jsonReply(500, { code: 500, message: 'x' })]) {
          const { outcome } = await runScene({ first, history })
          assert.notEqual(outcome.kind, 'failed', `${first}：不确定成败时告诉用户「失败」= 让用户去重复兑换`)
          assert.ok(['redeemed', 'pending'].includes(outcome.kind), `${first}：${outcome.kind} 不在 {redeemed,pending} 里`)
        }
      }
    },
  },
  {
    id: 'Y3',
    what: '核对命中 → 结论「已到账」，并提示刷新余额（界面不需要再发一次兑换）',
    run: async () => {
      for (const first of ['timeout', '5xx', '409-used']) {
        const { outcome, postCount } = await runScene({ first, history: () => jsonReply(200, HISTORY_HIT) })
        assert.equal(postCount, 1, `${first}：核对命中时不许重发`)
        assert.equal(outcome.kind, 'redeemed', `${first}：核对命中就是已到账`)
        assert.equal(outcome.credited, 'history', '依据明说：来自历史核对，不是服务端直接回的成功')
        assert.equal(outcome.refreshProfile, true, '余额要重读一次（客户端不自己加）：重拉 /user/profile')
        assert.equal(outcome.refreshUsage, undefined, '旧字段名 refreshUsage 已废弃：它指的是刷 /v1/usage，口径是 Key 的 quota')
      }
    },
  },
  {
    id: 'Y4',
    what: '核对未命中 → 「待确认」（pending）：可重试但**必须用户点**，不许自动接力',
    run: async () => {
      const { outcome, postCount } = await runScene({ first: 'timeout', history: () => jsonReply(200, HISTORY_MISS) })
      assert.equal(postCount, 1)
      assert.equal(outcome.kind, 'pending')
      assert.equal(outcome.canRetry, true)
      assert.equal(outcome.retried, false, '这一发是首发：标记为「还没重试过」')
      assert.equal(outcome.verified, 'not_credited')
    },
  },
  {
    id: 'Y5',
    what: '核对本身失败 → 仍是「待确认」，且到账结论是 `unknown`（**不可知不许当没到账**）',
    run: async () => {
      const { outcome, postCount } = await runScene({ first: 'timeout', history: () => jsonReply(500, { code: 500, message: 'db down' }) })
      assert.equal(postCount, 1, '查不出来就更不能重发')
      assert.equal(outcome.kind, 'pending')
      assert.equal(outcome.verified, 'unknown')
      assert.equal(outcome.canRetry, true)
    },
  },
  {
    id: 'Y6',
    what: '顺序承诺：第二次 POST 之前**一定**有一次 history 查询（6 个场景矩阵逐条断言序列）',
    run: async () => {
      const matrix = []
      for (const first of ['timeout', '5xx', '409-used']) {
        for (const history of [() => jsonReply(200, HISTORY_HIT), () => jsonReply(200, HISTORY_MISS)]) {
          matrix.push({ first, history })
        }
      }
      for (const scene of matrix) {
        const { sequence } = await runScene({ ...scene, confirm: true })
        const historyAt = sequence.indexOf(HISTORY)
        assert.notEqual(historyAt, -1, `${scene.first}：整场没有 history 查询 = 盲重试`)
        const secondPostAt = sequence.indexOf(POST, sequence.indexOf(POST) + 1)
        if (secondPostAt !== -1) {
          assert.ok(historyAt < secondPostAt, `${scene.first}：第二发在第 ${secondPostAt} 位，history 在第 ${historyAt} 位 —— 顺序反了就是重复兑换`)
        }
      }
    },
  },
  {
    id: 'Y7',
    what: '409 已用过：必须核对后才给结论（命中→已到账；未命中→明确未到账，不说「失败原因不明」）',
    run: async () => {
      const hit = await runScene({ first: '409-used', history: () => jsonReply(200, HISTORY_HIT) })
      assert.equal(hit.postCount, 1)
      assert.deepEqual(hit.sequence, [POST, HISTORY], '409 也不许直接判失败：先核对')
      assert.equal(hit.outcome.kind, 'redeemed')

      const miss = await runScene({ first: '409-used', history: () => jsonReply(200, HISTORY_MISS) })
      assert.equal(miss.postCount, 1, '409 是终态，重发只会再拿一个 409')
      assert.deepEqual(miss.sequence, [POST, HISTORY])
      assert.equal(miss.outcome.kind, 'failed')
      assert.equal(miss.outcome.verified, 'not_credited', '结论来自核对结果，不是凭 409 猜')
      assert.equal(miss.outcome.error.i18nKey, 'consumeErrCardUsed', '文案要提示「若余额已增加无需重复兑换」')
    },
  },
  {
    id: 'Y8',
    what: '202 accepted 不是到账：受理态必须查一次 history；未命中 → processing（不判成功、也不给「可重试」）',
    run: async () => {
      // 命中：只有 history 认了才算成功（承诺 ②「已到账」）
      const hit = await runScene({ first: '202-accepted', history: () => jsonReply(200, HISTORY_HIT) })
      assert.equal(hit.postCount, 1, '受理态更不许重发')
      assert.deepEqual(hit.sequence, [POST, HISTORY], '202 也要先核对：没有 history 就是盲判成功')
      assert.equal(hit.outcome.kind, 'redeemed')
      assert.equal(hit.outcome.credited, 'history', '依据必须是核对结果，不是那句 accepted')

      // 未命中：受理 ≠ 到账，也不是失败；且不许给客户端「重试」的把手
      const miss = await runScene({ first: '202-accepted', history: () => jsonReply(200, HISTORY_MISS) })
      assert.equal(miss.postCount, 1)
      assert.deepEqual(miss.sequence, [POST, HISTORY], '受理态与超时一样，结论只能来自核对')
      assert.notEqual(miss.outcome.kind, 'redeemed', '「已受理」≠「已到账」（承诺 ②）')
      assert.equal(miss.outcome.kind, 'processing', '是「正在确认」，不是「失败」也不是「待确认重试」')
      assert.equal(miss.outcome.verified, 'not_credited')
      assert.equal('canRetry' in miss.outcome, false, '服务端已接单：再发一枪就是重复兑换')
    },
  },
]

test('C11 redeem 绝不盲目重试：先核对到账，再谈重试', tableTest('C11', ROWS, async (row) => row.run()))

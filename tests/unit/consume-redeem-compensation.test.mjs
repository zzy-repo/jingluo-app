// [layer: unit | 依赖: 无（纯 Node，可编程假 transport，零网络） | 耗时: <1s]
//
// L0-3（#487 阶段③ 并行补基准，方案见 `docs/testing/rebuild-plan.md` §3）：
// **卡密兑换的幂等补偿**（`src/services/consume/redeem.ts`）—— 全仓最不能写错的一段。
//
// 事实前提（#484 §4.3 / §五，实测 `handler/redeem_handler.go` 只收 `code`）：
// `POST /api/v1/redeem` **没有幂等键**。所以「超时 → 直接重发」的两种结局都不能接受：
//   · 上次其实成功了 → 再发得到 `409 REDEEM_CODE_USED`，用户看到「卡被别人用了」；
//   · 上次其实没成功 → 用户以为兑换过，卡还在手里而界面说失败。
// 正确流程只有一条：**不确定成败时先查 `GET /api/v1/redeem/history` 核对**，
// 已到账按成功返回，未到账给 `pending`（重试必须由用户确认），查不出来就说「待确认」。
//
// 本文件锁的是**结论 + 调用序列**（不只数次数）：「第二次 POST 之前一定有一次 history 查询」
// 这条只数次数是证明不了的，所以每行都断言 `sequence()`。
//
// 覆盖（每行注释标明它盯的是哪条分支）：
//   R1 超时 + history 命中 → 不重发，按「已到账」返回     R2 超时 + history 未命中 → pending（不自动第二枪）
//   R3 用户确认后重试一次 → 恰好 2 发，且第二发之前有核对  R4 history 本身失败 → 停手报「待确认」，仍不重发
//   R5 409 已用过 + history 命中 → 是**自己上次成功**       R6 409 已用过 + history 未命中 → 明确「未到账」
//   R7 明确的业务失败（卡密不存在）→ 不查历史、不重试、也不给 pending
//
// 已知缺口（观察，本单不改 `src/`，只记录）：服务端若回 `202 {code:0,message:"accepted"}`
// （`docs/sub2api-client-contract.md` §4 的异步受理形状），`http.call()` 会把它当成功 →
// `redeemCode` 直接返回 `redeemed`（**未经过 history 核对**）。真实实例目前回收 200，故此处按
// 「pending 只能由可重试失败产生」写用例；该缺口写进 PR 评论，等 W 侧确认后再补一条红用例。
//
//   node --test tests/unit/consume-redeem-compensation.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'
import { jsonReply, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { redeemCode } = await import('../../src/services/consume/redeem.ts')

/** 兑换用的卡密（尾 4 位是 1234：history 里服务端会打码成 `MUSE-****-1234`） */
const CODE = 'MUSE-TEST-0000-ABCD-1234'

/** history 命中（服务端打码形态，实测口径）：`GET /api/v1/redeem/history` 的**面板信封** */
const HISTORY_HIT = { code: 0, message: 'success', data: { items: [{ code: 'MUSE-****-1234', type: 'balance', value: 10 }], total: 1 } }
/** history 未命中：空列表（**空 ≠ 没兑换成功**，只是这一页没有 → 结论是「未到账」） */
const HISTORY_MISS = { code: 0, message: 'success', data: { items: [], total: 0 } }

/** 造一个「按端点应答」的兑换场景：`post` / `history` 各自决定这一发回什么 */
const scenario = ({ post, history, token = 'jwt-redeem' }) => {
  const recorder = recordingTransport((request) => {
    const path = request.url.replace(/^https?:\/\/[^/]+/, '')
    if (request.method === 'POST' && path.startsWith('/api/v1/redeem')) {return post(request)}
    if (request.method === 'GET' && path.startsWith('/api/v1/redeem/history')) {return history(request)}
    throw new Error(`没有预期的端点被打到：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => token, transport: recorder.transport })
  return { http, ...recorder }
}

const REDEEM_POST = 'POST /api/v1/redeem'
const HISTORY_GET = 'GET /api/v1/redeem/history'

const ROWS = [
  {
    id: 'R1',
    what: '首次超时 + history 命中 → **不重发**，按「已到账」返回（credited:"history"），并提示刷新余额',
    run: async () => {
      const scene = scenario({ post: () => ({ kind: 'timeout' }), history: () => jsonReply(200, HISTORY_HIT) })
      const outcome = await redeemCode(scene.http, { code: CODE })
      assert.equal(scene.countOf('POST'), 1, '超时也不许重发（重发就等于再赌一次卡密）')
      assert.deepEqual(scene.sequence(), [REDEEM_POST, HISTORY_GET], '先查历史，再下结论')
      assert.equal(outcome.kind, 'redeemed')
      assert.equal(outcome.credited, 'history', '依据是历史，不是重发的运气')
      assert.equal(outcome.refreshUsage, true)
    },
  },
  {
    id: 'R2',
    what: '首次超时 + history 未命中 → pending（canRetry 但**必须用户确认**），绝不自动第二枪',
    run: async () => {
      const scene = scenario({ post: () => ({ kind: 'timeout' }), history: () => jsonReply(200, HISTORY_MISS) })
      const outcome = await redeemCode(scene.http, { code: CODE })
      assert.equal(scene.countOf('POST'), 1, '未确认到账也不许自动重试')
      assert.equal(outcome.kind, 'pending', 'pending ≠ 失败：界面提示「正在确认 / 请核对」而不是「兑换失败」')
      assert.equal(outcome.verified, 'not_credited')
      assert.equal(outcome.retried, false)
      assert.equal(outcome.canRetry, true, '可以重试，但只能由用户点')
    },
  },
  {
    id: 'R3',
    what: '用户确认后重试：恰好 2 发，且**第二发之前**有一次 history 核对；第二次仍超时 → 仍 pending，不无限重试',
    run: async () => {
      const scene = scenario({ post: () => ({ kind: 'timeout' }), history: () => jsonReply(200, HISTORY_MISS) })
      const outcome = await redeemCode(scene.http, { code: CODE, retryAfterConfirm: true })
      assert.equal(scene.countOf('POST'), 2, '首发 + 用户确认后的一发，仅此两次')
      assert.deepEqual(scene.sequence(), [REDEEM_POST, HISTORY_GET, REDEEM_POST, HISTORY_GET], '顺序就是契约：核对 → 确认 → 重发 → 再核对')
      assert.equal(outcome.kind, 'pending')
      assert.equal(outcome.retried, true)
      assert.equal(outcome.canRetry, true, '第二个 pending 仍可重试，但同样得用户点')
      const before = scene.countOf('POST')
      await redeemCode(scene.http, { code: CODE, retryAfterConfirm: true })
      assert.equal(scene.countOf('POST') - before, 2, '每次调用最多 2 发：不存在自动接力重试')
    },
  },
  {
    id: 'R4',
    what: 'history 自身失败（5xx）→ 结论「待确认」（verified:"unknown"），**仍不重发**',
    run: async () => {
      const scene = scenario({ post: () => ({ kind: 'timeout' }), history: () => jsonReply(500, { code: 500, message: 'boom' }) })
      const outcome = await redeemCode(scene.http, { code: CODE })
      assert.equal(scene.countOf('POST'), 1, '查不出来就更不能重发（那才是重复兑换）')
      assert.equal(outcome.kind, 'pending')
      assert.equal(outcome.verified, 'unknown', '「不可知」不许当成「没到账」')
      assert.equal(outcome.error.status, 0, '保留首发那条超时错误（界面据此说「请求超时」而不是「服务端 500」）')
    },
  },
  {
    id: 'R5',
    what: '409 REDEEM_CODE_USED + history 命中 → 是**自己上次成功**，按已到账返回，不是「兑换失败」',
    run: async () => {
      const scene = scenario({
        post: () => jsonReply(409, { code: 409, message: 'code already used', reason: 'REDEEM_CODE_USED' }),
        history: () => jsonReply(200, HISTORY_HIT),
      })
      const outcome = await redeemCode(scene.http, { code: CODE })
      assert.equal(scene.countOf('POST'), 1)
      assert.deepEqual(scene.sequence(), [REDEEM_POST, HISTORY_GET], '409 也不许直接判失败：必须先核对')
      assert.equal(outcome.kind, 'redeemed')
      assert.equal(outcome.credited, 'history')
      assert.equal(outcome.refreshUsage, true)
    },
  },
  {
    id: 'R6',
    what: '409 REDEEM_CODE_USED + history 未命中 → 明确「未到账」（verified:"not_credited"），不重试',
    run: async () => {
      const scene = scenario({
        post: () => jsonReply(409, { code: 409, message: 'code already used', reason: 'REDEEM_CODE_USED' }),
        history: () => jsonReply(200, HISTORY_MISS),
      })
      const outcome = await redeemCode(scene.http, { code: CODE })
      assert.equal(scene.countOf('POST'), 1, '409 是终态：重发只会再拿一个 409')
      assert.equal(outcome.kind, 'failed')
      assert.equal(outcome.verified, 'not_credited', '结论来自核对，不是凭 409 猜的')
      assert.equal(outcome.kind === 'failed' ? outcome.error.code : '', 'REDEEM_CODE_USED')
    },
  },
  {
    id: 'R7',
    what: '明确的业务失败（REDEEM_CODE_NOT_FOUND）→ 不查历史、不重试，也**不**给 pending',
    run: async () => {
      const scene = scenario({
        post: () => jsonReply(404, { code: 404, message: 'redeem code not found', reason: 'REDEEM_CODE_NOT_FOUND' }),
        history: () => jsonReply(200, HISTORY_HIT),
      })
      const outcome = await redeemCode(scene.http, { code: CODE })
      assert.deepEqual(scene.sequence(), [REDEEM_POST], '卡密不存在是确定的结论：不该去翻历史（也就不会误判 pending）')
      assert.equal(outcome.kind, 'failed')
      assert.equal(outcome.error.i18nKey, 'consumeErrCardNotFound')
      assert.equal(outcome.verified, 'unknown')
    },
  },
]

test('L0 redeem 幂等补偿：先核对到账再决定能不能重试', tableTest('consume-redeem-compensation', ROWS, async (row) => row.run()))

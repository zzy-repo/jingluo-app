// [layer: unit | 依赖: 无（纯 Node，可编程假 transport / 假 profile 源，零网络） | 耗时: <1s]
//
// #676 §五 —— 兑换成功后要重拉的是 **`/api/v1/user/profile`**，不是某把 Key 的 `quota`。
//
// 契约原文：
//   > 成功后余额直接进 `user.balance`，**不再是某把 Key 的 quota**。客户端要重新拉 `/user/profile` 刷新余额。
//
// 旧写法把这件事叫 `refreshUsage`（= 去刷 `/v1/usage`），而 `/v1/usage` 是**用 Key 自己**鉴权的额度接口：
// 老 Key 的 `quota` 已被置成 0（= 不限），拿它当余额会显示成「不限」或 0。字段改名 + 真的去拉 profile
// 一起改，才算对得上契约（只改名不发请求 = 假对齐）。
//
// 覆盖（一行一条）：
//   F1 `redeemed`（服务端直接到账）→ 恰好拉一次 `/user/profile`，余额带出来（元）
//   F2 `redeemed`（超时后 history 核对到账）→ **同样**要拉（结论来自核对，余额一样变了）
//   F3 `pending`  / `processing` / `failed` → **零次** profile 请求（余额没变，不许请求放大）
//   F4 profile 回 ok:false → 结论仍是成功，只是没有余额（不许把成功翻成失败）
//   F5 profile 抛异常（配置缺失这类）→ 不抛、不中断，只是没有余额
//   F6 真实 HTTP 链路：兑换 → profile 两次请求的**方法 / 路径 / Authorization 头**逐个断言
//   F7 负向对照：把「想刷新」接到 `/v1/usage` 上（旧 `refreshUsage` 的语义），F6 的路径断言必红
//
//   node --test tests/unit/consume-676-redeem-profile-refresh.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks } from '../helpers/contract.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

installResolveHooks()

const { createConsumeHttp } = await import('../../src/services/consume/http.ts')
const { redeemCode } = await import('../../src/services/consume/redeem.ts')
const { getProfile } = await import('../../src/services/consume/auth.ts')
const { afterRedeemed } = await import('../../src/components/consume/myCardsModel.ts')

const CODE = 'MUSE-TEST-0000-ABCD-1234'
const JWT = 'jwt-676-redeem'

/** `POST /api/v1/redeem` 的成功体（`redeem_handler.go` 的形状：`{message,type,value,new_balance}`） */
const REDEEM_OK = { code: 0, message: 'success', data: { message: '兑换成功', type: 'balance', value: 2, new_balance: 3.6 } }
/** history 命中（服务端打码形态） */
const HISTORY_HIT = { code: 0, message: 'success', data: { items: [{ code: 'MUSE-****-1234', type: 'balance', value: 2 }], total: 1 } }
/** `/user/profile` 的真实形状（余额单位元） */
const PROFILE = { id: 1, email: 'a@b.com', balance: 3.6, frozen_balance: 0, concurrency: 5, status: 'active' }

/** 四个结局的构造器：`outcome` 直接给，`afterRedeemed` 只关心 `kind` 与 `refreshProfile` */
const redeemed = (credited = 'response') => ({ kind: 'redeemed', credited, result: { message: 'ok', type: 'balance', value: 2 }, refreshProfile: true })
const other = (kind) => ({ kind, error: { kind: 'redeem', code: 'X', message: 'x', status: 0, retryable: false, envelope: 'panel', i18nKey: 'consumeRedeemProcessing' } })

/** 记录型 profile 源：断言「调了几次、有没有调」 */
const profileSpy = (reply) => {
  const calls = []
  return {
    calls,
    source: {
      profile: async () => {
        calls.push(1)
        if (reply instanceof Error) {throw reply}
        return reply
      },
    },
  }
}

const okProfile = () => ({ ok: true, status: 200, raw: {}, data: { id: 1, email: 'a@b.com', balance: 3.6 } })

const ROWS = [
  {
    id: 'F1',
    what: 'redeemed（服务端直接到账）→ 恰好一次 profile，余额带出来',
    run: async () => {
      const spy = profileSpy(okProfile())
      const aftermath = await afterRedeemed(redeemed('response'), spy.source)
      assert.equal(spy.calls.length, 1, '兑换成功后必须拉一次 /user/profile（只一次）')
      assert.equal(aftermath.refresh, true)
      assert.equal(aftermath.balance, 3.6, '余额原样（元），客户端不换算')
    },
  },
  {
    id: 'F2',
    what: 'redeemed（history 核对到账）→ 同样要拉一次',
    run: async () => {
      const spy = profileSpy(okProfile())
      const aftermath = await afterRedeemed(redeemed('history'), spy.source)
      assert.equal(spy.calls.length, 1, '结论来自核对也一样：余额已经变了')
      assert.equal(aftermath.refresh, true)
      assert.equal(aftermath.balance, 3.6)
    },
  },
  {
    id: 'F3',
    what: 'pending / processing / failed → 零次 profile 请求（余额没变，不许放大请求）',
    run: async () => {
      for (const kind of ['pending', 'processing', 'failed']) {
        const spy = profileSpy(okProfile())
        const aftermath = await afterRedeemed(other(kind), spy.source)
        assert.equal(spy.calls.length, 0, `${kind}：一次都不许拉`)
        assert.equal(aftermath.refresh, false, `${kind}：不需要刷新`)
      }
    },
  },
  {
    id: 'F4',
    what: 'profile 回 ok:false → 仍是「兑换成功」（只是不显示余额）',
    run: async () => {
      const spy = profileSpy({ ok: false, status: 500, raw: {}, error: { kind: 'server', code: 'X', message: 'x', status: 500, retryable: true, envelope: 'none' } })
      const aftermath = await afterRedeemed(redeemed(), spy.source)
      assert.equal(aftermath.refresh, true, '该拉的那次拉了（只是没读到）')
      assert.equal(aftermath.balance, undefined, '读不到余额就不显示，绝不当 0')
    },
  },
  {
    id: 'F5',
    what: 'profile 抛异常（配置缺失等）→ 不抛、结论不变',
    run: async () => {
      const spy = profileSpy(new Error('__ENDPOINTS__.consume 缺失'))
      const aftermath = await afterRedeemed(redeemed(), spy.source)
      assert.equal(aftermath.refresh, true)
      assert.equal(aftermath.balance, undefined)
    },
  },
]

for (const row of ROWS) {
  test(`${row.id} ${row.what}`, async () => {
    await row.run()
  })
}

test('F6 真实链路：POST /api/v1/redeem → GET /api/v1/user/profile（方法 / 路径 / Authorization 逐个断言）', async () => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/redeem') {return jsonReply(200, REDEEM_OK)}
    if (request.method === 'GET' && path === '/api/v1/user/profile') {return panelOk(PROFILE)}
    if (request.method === 'GET' && path === '/api/v1/redeem/history') {return jsonReply(200, HISTORY_HIT)}
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => JWT, transport: recorder.transport })
  const outcome = await redeemCode(http, { code: CODE })
  assert.equal(outcome.kind, 'redeemed')
  assert.equal(outcome.refreshProfile, true, '`refreshUsage` 改名的结果：指向 profile 而不是 /v1/usage')
  assert.equal(outcome.refreshUsage, undefined, '旧字段必须真的没了（留着就是第二份口径）')

  const aftermath = await afterRedeemed(outcome, { profile: () => getProfile(http) })
  assert.deepEqual(recorder.sequence(), ['POST /api/v1/redeem', 'GET /api/v1/user/profile'], '兑换之后只跟一次 profile')
  const profileRequest = recorder.calls[1]
  assert.equal(profileRequest.headers.authorization, `Bearer ${JWT}`, 'profile 用 JWT（面板通道）')
  assert.ok(!profileRequest.url.includes('/v1/usage'), '不许拿 /v1/usage 当余额（那是 Key 的 quota）')
  assert.equal(aftermath.balance, 3.6, '余额来自 /user/profile 的 balance（元）')
})

test('F7 负向对照：把「刷新」错接到 /v1/usage（旧 refreshUsage 语义）→ F6 的路径断言必红', async () => {
  const recorder = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/redeem') {return jsonReply(200, REDEEM_OK)}
    if (request.method === 'GET' && path === '/v1/usage') {return jsonReply(200, { mode: 'quota_limited', quota: { limit: 0, used: 0, remaining: 0, unit: 'CNY' }, remaining: 0, unit: 'CNY' })}
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const http = createConsumeHttp({ accessToken: () => JWT, apiKey: () => 'sk-test', transport: recorder.transport })
  await redeemCode(http, { code: CODE })
  // 错的那一下：拿 Key 通道的额度当余额
  await http.request({ method: 'GET', path: '/v1/usage', timeout: 'read' })
  assert.deepEqual(
    recorder.sequence(),
    ['POST /api/v1/redeem', 'GET /v1/usage'],
    '负向对照先自证：它确实打到了 Key 通道'
  )
  assert.notDeepEqual(
    recorder.sequence(),
    ['POST /api/v1/redeem', 'GET /api/v1/user/profile'],
    'F6 的那条断言对「刷 /v1/usage」的实现必然为红'
  )
  // 修完的实现同一断言为绿
  const scene = recordingTransport((request) => {
    const path = pathOf(request.url).split('?')[0]
    if (request.method === 'POST' && path === '/api/v1/redeem') {return jsonReply(200, REDEEM_OK)}
    if (request.method === 'GET' && path === '/api/v1/user/profile') {return panelOk(PROFILE)}
    throw new Error(`不该被打到的端点：${request.method} ${path}`)
  })
  const okHttp = createConsumeHttp({ accessToken: () => JWT, transport: scene.transport })
  const outcome = await redeemCode(okHttp, { code: CODE })
  await afterRedeemed(outcome, { profile: () => getProfile(okHttp) })
  assert.deepEqual(scene.sequence(), ['POST /api/v1/redeem', 'GET /api/v1/user/profile'], '修完的实现必须是这条路')
})

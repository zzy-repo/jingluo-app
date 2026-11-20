// [layer: unit | 依赖: 无（纯 Node，零浏览器、零 React、不发网络请求） | 耗时: <1s]
// C1「兑换结果矩阵」—— 域 6 F6-10 / F6-11 / F6-12 / F6-13（docs/testing/coverage/domain-06-07.md §4.1）
//
// 一张 11 行的结果矩阵跑完「卡密兑换」的全部对外形态：
//   成功（含 duplicate）/ 202 处理中（两种信封）/ 已用 409 / 无此卡 404 / Key 无效 400 /
//   服务不可用 503 / 限流 429 / 超时 / 池路由不存在 → 兜底旧接口。
//
// 断言对象是**真代码在假传输上发出的请求 + 真解析结果**（不是打桩的预期值）：
//   - 请求：`POST /redeem-card`，body 只有 {card_no, api_key}（池按卡号幂等，不需要 request_id）；
//   - 结果：kind / points / duplicate / messageKey / retryable，以及「卡密只露后 4 位」。
//
// 覆盖的 P0/P1 缺口：兑换四条失败态文案与「处理中不是失败」（G7）、卡号脱敏（F6-11/F7-09 共用 mask）。
//
// 跑法：node --test tests/unit/domain06-redeem-matrix.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from '../fixtures/domain06-07/harness.mjs'
import { createRecorder, json, timeout } from '../fixtures/domain06-07/fakes.mjs'

const harness = await createHarness()
const { redeemCardMigrated, POOL_ERROR_KEYS } = await harness.importSource(
  'src/services/invite/api.ts'
)
const { zh } = await harness.importSource('src/i18n/zh.ts')

const CARD = 'MUSE-8f3a-9b7c-2d44-71bb'
const CARD_TAIL = CARD.slice(-4)
const KEY = 'sk-ours-redeem-matrix-00112233445566'
const POOL = 'POST /redeem-card'
const LEGACY = 'POST /api/redeem'

/** 成功响应：池的真实字段（points / quota_points / remaining_points / duplicate） */
const success = (extra = {}) =>
  json(200, { ok: true, points: 100, quota_points: 400, remaining_points: 400, ...extra })

/**
 * 结果矩阵：一张表 11 行。
 *
 * `reply` 是服务端会怎么回（全是假数据）；`expect` 是**真代码**必须给出的解释；
 * `requests` 是期望真的发出去的请求序列。
 */
const ROWS = [
  {
    id: '1',
    name: 'F6-10 卡密有效 → 成功到账（points 来自服务端，不是客户端算的）',
    reply: success(),
    expect: { kind: 'success', points: 100, duplicate: false, tail: CARD_TAIL },
    requests: [POOL],
  },
  {
    id: '2',
    name: 'F6-13 同一张卡重发 → duplicate:true 按成功处理（不是错误、不二次记账）',
    reply: success({ duplicate: true }),
    expect: {
      kind: 'success',
      duplicate: true,
      messageKey: 'oursRedeemDuplicate',
      tail: CARD_TAIL,
    },
    requests: [POOL],
  },
  {
    id: '3',
    name: 'F6-12 HTTP 202 → 「处理中」，既不是失败也不催重试',
    reply: json(202, { code: 'CREDIT_PENDING' }),
    expect: { kind: 'pending', messageKey: 'oursRedeemProcessing' },
    requests: [POOL],
  },
  {
    id: '4',
    name: 'F6-12 200 + {error:{code:CREDIT_PENDING}}（嵌套信封）同样只算「处理中」',
    reply: json(200, { error: { code: 'CREDIT_PENDING', message: 'credit pending' } }),
    expect: { kind: 'pending', messageKey: 'oursRedeemProcessing' },
    requests: [POOL],
  },
  {
    id: '5',
    name: 'F6-11 卡已用 409 card_used → 「已使用」文案，且不可重试（重试不长出积分）',
    reply: json(409, { code: 'card_used' }),
    expect: { kind: 'error', code: 'card_used', messageKey: 'oursErrCardUsed', retryable: false },
    requests: [POOL],
  },
  {
    id: '6',
    name: 'F6-11 卡不存在 404 card_not_found → 「不存在或已过期」，不能糊成网络错误',
    reply: json(404, { code: 'card_not_found' }),
    expect: {
      kind: 'error',
      code: 'card_not_found',
      messageKey: 'oursErrCardNotFoundOrExpired',
      retryable: false,
    },
    requests: [POOL],
  },
  {
    id: '7',
    name: 'F6-11 Key 无效 400 api_key_invalid → 「Key 未下发」，不提示换卡当成功',
    reply: json(400, { code: 'api_key_invalid' }),
    expect: {
      kind: 'error',
      code: 'api_key_invalid',
      messageKey: 'oursErrApiKeyNotIssued',
      retryable: false,
    },
    requests: [POOL],
  },
  {
    id: '8',
    name: 'F6-11 服务不可用 503（无业务码）→ 可重试',
    reply: json(503, { message: 'service unavailable' }),
    expect: { kind: 'error', messageKey: 'oursErrUnknown', retryable: true },
    requests: [POOL],
  },
  {
    id: '9',
    name: 'F6-11 限流 429 rate_limited → 可重试（原样重发是同一张卡，幂等安全）',
    reply: json(429, { code: 'rate_limited' }),
    expect: {
      kind: 'error',
      code: 'rate_limited',
      messageKey: 'oursErrRateLimited',
      retryable: true,
    },
    requests: [POOL],
  },
  {
    id: '10',
    name: 'F6-11 超时 → 池算「链路不通」再兜底旧接口；两条都超时 → 可重试，绝不说「卡无效」',
    reply: timeout(),
    expect: { kind: 'error', code: 'TIMEOUT', messageKey: 'oursErrTimeout', retryable: true },
    requests: [POOL, LEGACY],
  },
  {
    id: '11',
    name: 'F6-10 池路由不存在（404 无业务码）→ 兜底旧 /api/redeem，request_id 固定用卡密本身',
    reply: () => json(404, { message: 'not found' }),
    // 第二条响应给旧接口
    replies: [json(404, { message: 'not found' }), json(200, { ok: true, points: 100 })],
    expect: { kind: 'success', points: 100, via: 'legacy', tail: CARD_TAIL },
    requests: [POOL, LEGACY],
    legacyBody: { request_id: CARD },
  },
]

for (const row of ROWS) {
  test(`C1/${row.id} ${row.name}`, async () => {
    const recorder = createRecorder(row.replies ?? [row.reply])
    const result = await redeemCardMigrated({ cardNo: CARD, apiKey: KEY }, recorder.transport)

    assert.equal(result.kind, row.expect.kind, `kind 应为 ${row.expect.kind}，实际 ${result.kind}`)
    if (row.expect.points !== undefined) {
      assert.equal(result.points, row.expect.points)
    }
    if (row.expect.duplicate !== undefined) {
      assert.equal(result.duplicate, row.expect.duplicate)
    }
    if (row.expect.via !== undefined) {
      assert.equal(result.via, row.expect.via)
    }
    if (row.expect.code !== undefined) {
      assert.equal(result.code, row.expect.code)
    }
    if (row.expect.messageKey !== undefined) {
      assert.equal(result.messageKey, row.expect.messageKey)
      // 文案必须真的存在（漏配 key 会显示 <missing:…>，这一行就红）
      assert.match(zh[row.expect.messageKey], /\S/u, `${row.expect.messageKey} 没有中文文案`)
    }
    if (row.expect.retryable !== undefined) {
      assert.equal(result.retryable, row.expect.retryable)
    }
    if (row.expect.tail !== undefined) {
      assert.equal(result.cardTail, row.expect.tail)
    }

    // 请求序列：真发了哪几条、按什么顺序
    assert.deepEqual(recorder.paths, row.requests)

    // 池请求只带卡号 + Key（不多带 request_id：池按卡号幂等）
    const poolBody = JSON.parse(recorder.requests[0].body)
    assert.deepEqual(poolBody, { card_no: CARD, api_key: KEY })
    assert.equal(recorder.requests[0].headers['Content-Type'], 'application/json')

    if (row.legacyBody !== undefined) {
      const legacyBody = JSON.parse(recorder.requests[1].body)
      assert.deepEqual(legacyBody.request_id, row.legacyBody.request_id)
      assert.equal(legacyBody.card_no, CARD)
    }

    // F6-11 / F7-09 口径：结果里只出现卡密后 4 位，完整卡密一个字节都不外泄
    assert.equal(
      JSON.stringify(result).includes(CARD.slice(0, 12)),
      false,
      '返回值里出现了完整卡密'
    )
    if (result.kind !== 'error' || result.cardTail !== '') {
      assert.equal(result.cardTail, CARD_TAIL)
    }
  })
}

test('C1/12 F6-10 空卡密 / 空 Key 本地就拦下：一条请求都不发', async () => {
  for (const [label, input] of [
    ['空卡密', { cardNo: '   ', apiKey: KEY }],
    ['空 Key', { cardNo: CARD, apiKey: '' }],
  ]) {
    const recorder = createRecorder([json(200, { ok: true, points: 1 })])
    const result = await redeemCardMigrated(input, recorder.transport)
    assert.equal(result.kind, 'error', label)
    assert.deepEqual(recorder.paths, [], `${label}：不该发请求`)
    assert.match(zh[result.messageKey], /\S/u)
  }
})

test('C1/13 池错误码表：每个码都映射到中文文案（漏映射会退化成英文码上屏）', async () => {
  for (const [code, expectedKey] of Object.entries(POOL_ERROR_KEYS)) {
    assert.equal(typeof expectedKey, 'string')
    assert.match(zh[expectedKey], /\S/u, `${code} → ${expectedKey} 没有中文文案`)
    assert.equal(/^[a-z_]+$/u.test(zh[expectedKey]), false, `${expectedKey} 的文案看着像英文码`)
  }
})

// ------------------------------------------------------------------ P2 并发兑换同一张卡（Issue #452）

/**
 * 并发桩：一个**按卡号加锁**的假池。
 *
 * 真实池对 `card_no` 有唯一约束（#452 P2 的资损点就在这里）：
 *   - 一张卡同一时刻只放一笔进来 → 第一笔落账（账本 +points）后回 200；
 *   - 同一张卡在「第一笔还没落账」时再来 → 409 `card_used`（不是 500、不是重复记账）。
 *
 * 桩里刻意**不**做客户端侧的串行化：两路请求是真的一起发出去的
 * （`Promise.all` 同 tick 起跑），这样才能验「客户端同时点两下/两端同时兑换」时
 * 界面拿到的是「一成一败」，而不是两笔都算成功、额度加两次。
 */
const createConcurrentPool = ({ start = 300, points = 100 } = {}) => {
  const state = { balance: start, inFlight: new Set(), used: new Set(), requests: [] }
  const conflict = () => json(409, { error: { code: 'card_used' } })
  const transport = (request) => {
    state.requests.push(request)
    const card = JSON.parse(request.body).card_no
    // 已经用过、或第一笔还在飞 → 这张卡现在不可再兑换
    if (state.used.has(card) || state.inFlight.has(card)) {
      return Promise.resolve(conflict())
    }
    state.inFlight.add(card)
    return new Promise((resolve) => {
      setTimeout(() => {
        state.inFlight.delete(card)
        state.used.add(card)
        state.balance += points
        resolve(
          json(200, {
            ok: true,
            points,
            quota_points: state.balance,
            remaining_points: state.balance,
          })
        )
      }, 1)
    })
  }
  return { transport, state }
}

/**
 * 一张表 3 行：并发数 ×「同一张卡 / 不同卡」。
 *
 * 断言的资产口径：**账本只加一次**（`state.balance`），不是「界面看着像成功几次」。
 */
const CONCURRENT_ROWS = [
  {
    id: '1',
    name: 'P2/F6-13 两个请求同时打同一张卡 → 只成功一次，另一次 409 card_used（额度只加一次）',
    cards: [CARD, CARD],
    success: 1,
    conflicts: 1,
  },
  {
    id: '2',
    name: 'P2/F6-13 三路并发（连点 + 另一端）→ 仍然只成功一次，其余两笔 409',
    cards: [CARD, CARD, CARD],
    success: 1,
    conflicts: 2,
  },
  {
    id: '3',
    name: 'P2/F6-13 并发锁只按卡号：两张不同的卡同时兑换 → 各自成功，额度各加一次',
    cards: [CARD, 'MUSE-1a2b-3c4d-5e6f-99aa'],
    success: 2,
    conflicts: 0,
  },
]

test('P2/F6-13 并发兑换同一张卡：只成功一次、额度只加一次（表驱动 3 行）', async (t) => {
  for (const row of CONCURRENT_ROWS) {
    t.diagnostic(`P2/${row.id} ${row.name}`)
    const pool = createConcurrentPool({ start: 300, points: 100 })
    // 同 tick 起跑：这才是「用户连点两下 / 两端同时兑换」的真实形状
    const results = await Promise.all(
      row.cards.map((cardNo) => redeemCardMigrated({ cardNo, apiKey: KEY }, pool.transport))
    )

    const successes = results.filter((result) => result.kind === 'success')
    const conflicts = results.filter((result) => result.kind === 'error')

    assert.equal(
      successes.length,
      row.success,
      `成功笔数应为 ${row.success}，实际 ${successes.length}：${JSON.stringify(results.map((r) => r.kind))}`
    )
    assert.equal(
      conflicts.length,
      row.conflicts,
      `冲突笔数应为 ${row.conflicts}，实际 ${conflicts.length}`
    )

    // 资损口径：账本只加 success 次（重复兑换绝不能二次记账）
    assert.equal(
      pool.state.balance,
      300 + 100 * row.success,
      `额度只该加 ${row.success} 次，实际加到 ${pool.state.balance}`
    )
    // 每条成功响应里的额度都是「它自己那一笔落账之后」的服务端值：一笔 → 400；两笔 → {400, 500}
    assert.deepEqual(
      successes.map((success) => success.remainingPoints).sort((a, b) => a - b),
      Array.from({ length: row.success }, (_, index) => 300 + 100 * (index + 1)),
      '剩余额度必须来自服务端响应，不能由客户端自己累加'
    )
    for (const success of successes) {
      assert.equal(success.points, 100, '积分取服务端给的值')
    }

    for (const conflict of conflicts) {
      assert.equal(conflict.code, 'card_used', '并发冲突必须归到「卡已用」，不能糊成网络错误')
      assert.equal(conflict.messageKey, 'oursErrCardUsed')
      assert.equal(conflict.retryable, false, '409 不可重试：再重试就是第三次提交同一张卡')
      // 文案必须是用户能看懂的「不要重复提交」，不是英文码
      assert.match(zh[conflict.messageKey], /不要重复提交/u, `文案不对：${zh[conflict.messageKey]}`)
      assert.notEqual(conflict.messageKey, 'oursErrNetwork', '并发冲突不是网络错误')
    }

    // 每个调用方都真的发了一条：并发不是客户端串行化/丢弃（服务端唯一约束才是真相）
    assert.equal(pool.state.requests.length, row.cards.length)
    for (const [index, request] of pool.state.requests.entries()) {
      assert.equal(request.url.endsWith('/redeem-card'), true)
      assert.equal(
        JSON.parse(request.body).card_no,
        row.cards[index],
        `第 ${index + 1} 条请求的卡号`
      )
    }
    // 完整卡密不出现在任何结果里（F6-11 / F7-09 同一口径）
    for (const result of results) {
      assert.equal(JSON.stringify(result).includes(CARD.slice(0, 12)), false)
    }
  }
})

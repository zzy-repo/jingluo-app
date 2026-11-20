// [layer: unit —— 组件级（真弹层组件 + 真服务层，假传输 / 假 Browser），零浏览器 | 耗时: <1s]
// C6「购买链路：plans → pay-link → App 内打开 → 关页刷新」—— 域 7 F7-01 F7-02 F7-03 F7-04 F7-05 F7-12
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 G1「域 7 的 L1/L2 整体失效」= 本文件）
//
// Issue #331 之后「购买」不再是「下单 + 轮询」：
//   套餐全线下架（`/api/plans` 返回空）→ 点「前往购买」现取 `/api/pay-link` → 在 **App 内** 打开
//   联动小铺收款页 → 关掉页面回到 App 时只刷新一次额度。App 侧**没有订单**。
//
// 所以本文件分两半：
//   上半（行 1–6）：新链路的顺序与每种失败的可读文案；
//   下半（行 7）：**已下线能力的哨兵表** —— 正常下单 / 覆盖单号(#157) / latest_fulfilled 兜底 /
//     订单过期这四种历史状态，在今天的产品里必须表现为「一个订单接口都不发」。
//     这不是给已删代码补测试，而是把「已下线」这件事钉成可执行断言，防止有人把轮询拼回来。
//
// 跑法：node --test tests/unit/domain07-buy-chain.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource(
  'src/components/settings/OursServicesDialog.tsx'
)
const oursApi = await harness.importSource('src/services/ours/api.ts')
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-77777777777777777777777777777777'
const KEY = 'sk-ours-buy-chain-0011223344556677'
const PAY_URL = 'https://wzyp.cn/shop/pay/xyz'

const profile = (remaining = 300) => ({
  invite_code: 'K3M9QW2P',
  invited_count: 0,
  max_invites: 3,
  bonus_points: 0,
  redeemed: false,
  quota_points: remaining,
  used_points: 0,
  remaining_points: remaining,
  key_status: 'active',
  device_id: DEVICE,
})

const scripted = (table) => {
  const counters = new Map()
  return (request) => {
    const key = `${request.method} ${request.path}`
    const responses = table[key]
    if (responses === undefined) {
      throw new Error(`用例没有为 ${key} 准备响应`)
    }
    const index = counters.get(key) ?? 0
    counters.set(key, index + 1)
    return responses[Math.min(index, responses.length - 1)]
  }
}

/**
 * #421：本机有 Key 时打开弹层会多一条**只读**的邮箱入口探测（`GET /email/status`）。
 * 服务端未开邮箱功能时它回 404 `not_found`，界面一个字都不变 —— 所以统一在 prepare 里兜住，
 * 各用例的请求序列断言用 withoutEmailProbe 先把它摘掉，避免噪音盖住真正要钉的链路。
 */
const EMAIL_PROBE = 'GET /email/status'
const withoutEmailProbe = (paths) => paths.filter((path) => path !== EMAIL_PROBE)
const EMAIL_DISABLED = TRANSPORT.json(404, { error: { code: 'not_found' } })

const prepare = (table) => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  globalThis.localStorage.setItem('chat-demo:ours-device-id', DEVICE)
  harness.ctx.oursOpen = true
  harness.ctx.reply(scripted({ [EMAIL_PROBE]: [EMAIL_DISABLED], ...table }))
}

test('C6/1 F7-02 购买区不发 /api/plans：直接给「套餐已下架」空态，入口照常可点', async () => {
  prepare({
    'GET /me': [TRANSPORT.json(200, profile())],
    'GET /api/pay-link': [TRANSPORT.json(200, { ok: true, url: PAY_URL, note: '' })],
  })
  const view = await harness.mount(OursServicesRow, {})

  assert.deepEqual(
    withoutEmailProbe(harness.ctx.paths),
    ['GET /me'],
    '空态是默认展示，不该为它多发一条套餐请求'
  )
  assert.equal(view.text('ours-plans-empty'), zh.oursPayEmpty)
  assert.equal(view.has('ours-buy'), true, '套餐下架不等于入口消失')
  assert.notEqual(view.node('ours-buy').props.disabled, true, '购买按钮必须可点')
  view.unmount()
})

test('C6/2 F7-01/F7-02 数据层：空列表与「全部 disabled」都是 empty（不是加载失败）；5xx 才是可重试错误', async () => {
  const CASES = [
    { name: '空数组', reply: TRANSPORT.json(200, { plans: [] }), expect: { status: 'empty' } },
    {
      name: '全部下架（enabled:false）',
      reply: TRANSPORT.json(200, {
        plans: [{ id: 'p1', name: '100 积分', price: 1, points: 100, enabled: false }],
      }),
      expect: { status: 'empty' },
    },
    {
      name: '一条有效套餐',
      reply: TRANSPORT.json(200, {
        plans: [{ id: 'p2', name: '300 积分', price: 3, points: 300, enabled: true }],
      }),
      expect: { status: 'success', planId: 'p2', priceText: '¥3.00' },
    },
    {
      name: '503',
      reply: TRANSPORT.json(503, {}),
      expect: { status: 'error', messageKey: 'oursPlansFailed' },
    },
    {
      name: '非法 JSON',
      reply: TRANSPORT.text(200, '<html>502</html>'),
      expect: { status: 'error', messageKey: 'oursPlansFailed' },
    },
  ]
  for (const item of CASES) {
    const state = await oursApi.fetchPlans(async () => item.reply)
    assert.equal(state.status, item.expect.status, `${item.name}：status 不对`)
    if (item.expect.messageKey !== undefined) {
      assert.equal(state.messageKey, item.expect.messageKey, item.name)
    }
    if (item.expect.planId !== undefined) {
      assert.equal(state.plans[0].id, item.expect.planId)
      assert.equal(oursApi.formatPlanPrice(state.plans[0]), item.expect.priceText)
    }
  }
})

test('C6/3 F7-03 收款页地址每次现取：连点两次就是两条 GET /api/pay-link（永不写死）', async () => {
  prepare({
    'GET /me': [TRANSPORT.json(200, profile())],
    'GET /api/pay-link': [TRANSPORT.json(200, { ok: true, url: PAY_URL, note: '' })],
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-buy')
  await view.click('ours-buy')

  assert.deepEqual(withoutEmailProbe(harness.ctx.paths), [
    'GET /me',
    'GET /api/pay-link',
    'GET /api/pay-link',
  ])
  assert.deepEqual(harness.ctx.browser.opens, [PAY_URL, PAY_URL], '每次都得真的打开一次')
  view.unmount()
})

test('C6/4 F7-04/F7-05 关页回调只算一次：连点关闭也只刷新一条 /me，且绝不显示「支付成功」', async () => {
  prepare({
    'GET /me': [TRANSPORT.json(200, profile(300)), TRANSPORT.json(200, profile(600))],
    'GET /api/pay-link': [TRANSPORT.json(200, { ok: true, url: PAY_URL, note: '' })],
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-buy')

  const close = harness.ctx.browser.onClosed
  assert.equal(typeof close, 'function')
  close()
  close() // 用户手快点两下 / 插件重复派发
  await view.settle()

  // 「最多回调一次」是 transport 的契约（真实现见 pay-link.test.mjs[C]）；这里断言的是
  // 「一次关闭 = 恰好一次额度刷新」，也就是 N1 那个从未被断言过的组合行为。
  assert.deepEqual(
    withoutEmailProbe(harness.ctx.paths),
    ['GET /me', 'GET /api/pay-link', 'GET /me'],
    '一次关闭只该刷新一条 /me'
  )
  assert.equal(view.text('ours-quota-value'), `600 ${zh.oursPointsUnit}`)
  assert.equal(view.html().includes('支付成功'), false)
  view.unmount()
})

test('C6/5 F7-12 收款通道四类失败：一律「通道暂不可用」+ 不打开任何页面（不白屏、不整页跳走）', async () => {
  const CASES = [
    { name: '503', reply: TRANSPORT.json(503, { code: 'PAY_LINK_NOT_CONFIGURED' }) },
    { name: 'ok:false', reply: TRANSPORT.json(200, { ok: false, url: PAY_URL }) },
    { name: '非法 JSON', reply: TRANSPORT.text(200, 'not json at all') },
    {
      name: '非 https 地址',
      reply: TRANSPORT.json(200, { ok: true, url: 'http://wzyp.cn/shop/pay/xyz' }),
    },
    { name: '超时', reply: TRANSPORT.timeout() },
  ]
  for (const item of CASES) {
    prepare({
      'GET /me': [TRANSPORT.json(200, profile())],
      'GET /api/pay-link': [item.reply],
    })
    const view = await harness.mount(OursServicesRow, {})
    await view.click('ours-buy')

    assert.deepEqual(harness.ctx.browser.opens, [], `${item.name}：不可信的地址绝不打开`)
    const expected = item.name === '超时' ? zh.oursErrTimeout : zh.oursPayUnavailable
    assert.equal(view.text('ours-pay-notice'), expected, `${item.name}：文案不对`)
    assert.equal(view.has('ours-buy'), true, `${item.name}：失败后入口还在（用户可重试）`)
    view.unmount()
  }
})

test('C6/6 已下线链路（#331）：startCheckout / pollOrder / orderStore 那套接口不再对外暴露', async () => {
  for (const name of ['startCheckout', 'pollOrder', 'withBuyCustomerId', 'pointsToYuan']) {
    assert.equal(oursApi[name], undefined, `${name} 应该已随 #331 一起删除，别再拼回来`)
  }
  assert.equal(typeof oursApi.fetchPayLink, 'function')
  assert.equal(typeof oursApi.isOpenableCheckout, 'function')
})

test('C6/7 订单状态哨兵表：正常下单 / 覆盖单号(#157) / latest_fulfilled 兜底 / 订单过期 —— App 一条订单请求都不发', async () => {
  /**
   * 四种历史状态各自的服务端样子。**它们都在传输层就地抛错**：只要 App 真的去请求订单接口，
   * 用例立刻红 —— 这就是「已下线」的可执行断言（不是给已删代码补测试）。
   */
  const LEGACY_STATES = [
    {
      name: '正常下单（收银台 302 + 单号 + order_token）',
      legacy: () => {
        throw new Error('App 侧不该再建单（/buy）')
      },
    },
    {
      name: '重新下单覆盖本地单号（#157）',
      legacy: () => {
        throw new Error('App 侧不该再存单号（orderStore 已删）')
      },
    },
    {
      name: 'latest_fulfilled 兜底展示',
      legacy: () => {
        throw new Error('App 侧不该再读 latest_fulfilled（服务端兜底字段只对旧链路有意义）')
      },
    },
    {
      name: '订单过期 / 支付后未回调',
      legacy: () => {
        throw new Error('App 侧没有订单可查，也不该轮询')
      },
    },
  ]

  for (const state of LEGACY_STATES) {
    prepare({
      'GET /me': [TRANSPORT.json(200, profile())],
      'GET /api/pay-link': [TRANSPORT.json(200, { ok: true, url: PAY_URL, note: '' })],
      // 任何订单接口被碰到就炸
      'GET /api/orders': [state.legacy],
      'GET /api/order': [state.legacy],
      'POST /buy': [state.legacy],
      'POST /api/buy': [state.legacy],
      'GET /buy': [state.legacy],
    })
    const view = await harness.mount(OursServicesRow, {})
    await view.click('ours-buy')

    assert.deepEqual(
      withoutEmailProbe(harness.ctx.paths),
      ['GET /me', 'GET /api/pay-link'],
      `${state.name}：整条链路只允许「查额度 + 取收款页地址」两条请求`
    )
    assert.deepEqual(harness.ctx.browser.opens, [PAY_URL])
    assert.equal(
      view.html().includes('支付成功'),
      false,
      `${state.name}：App 不再有「支付成功」这种状态`
    )
    view.unmount()
  }
})

// ------------------------------------------------------------------ P3 订单过期后重新下单（Issue #452）

/**
 * #452 P3：「订单过期后重新下单 → 本地单号被覆盖、旧单不再轮询、不重复建单」。
 *
 * **先说清今天还剩下什么**（否则就会像 #362 §0.1 警告的那样去测已删代码）：
 * `42a3a68`（#331）把 `/api/buy` 建单、订单存档（`orderStore`）、查单与**那套订单轮询**
 * 整条删掉了，App 侧现在「没有本地单号可覆盖」——那三个子项里前两个的现状由本文件
 * C6/6、C6/7 的哨兵表钉着（一个订单接口都不发）。真正**还活着**的同族风险只剩一个：
 * **旧单会不会继续被轮询、会不会叠出第二个定时器**（唯一存活的轮询就是支付记录时间线，
 * `PaymentTrailDialog`：PAID 未发卡每 4 秒静默重拉、上限 2 分钟）。
 *
 * 所以 P3 落在这里，一条表驱动钉三件事（都是 EXPIRED / 旧单在界面上留下的真实痕迹）：
 *   1. **过期单不轮询**：`EXPIRED ≠ 等待发卡`，一个定时器都不该起，界面也不出现「正在准备卡密」；
 *   2. **不重复建单（不重复计时）**：paid 单恰好 1 个定时器，4 秒到点只再打一条请求，
 *      定时器数**始终是 1**（叠加 = 后台无限刷）；
 *   3. **旧单不再轮询**：切到「已关闭」筛选后旧单定时器清零，离开弹层后也清零。
 *
 * 另：重新下单本身（点「前往购买」）每次现取 `/api/pay-link`，连点两次就是两条请求
 * —— 这条**不是**「重复建单」，而是 F7-03 的口径，已由 C6/3 断言；这里不重复测。
 */
const trailOrder = (outTradeNo, status) => ({
  outTradeNo,
  planId: 'pro',
  amountYuan: 29.9,
  status,
  statusText: `SERVER_${status}`,
  createdAt: 1_760_000_000,
  paidAt: status === 'paid' ? 1_760_000_100 : null,
  expireAt: status === 'expired' ? 1_760_086_400 : null,
  card: null,
  timeline: [],
  nextStep: '',
})

const trailPage = (orders) => ({
  customerId: 1,
  total: orders.length,
  limit: 20,
  offset: 0,
  totalPaidYuan: 29.9,
  orders,
})

/**
 * 4 秒轮询时钟：只统计 `TRAIL_POLL_INTERVAL_MS` 的定时器（`settle()` 自己用的
 * `setTimeout(0)` 不掺进来），并允许用例手动「让 4 秒到点」。
 */
const createPollClock = (interval) => {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending = new Map()
  let created = 0
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest)
    if (ms === interval) {
      pending.set(id, fn)
      created += 1
    }
    return id
  }
  globalThis.clearTimeout = (id) => {
    pending.delete(id)
    return realClearTimeout(id)
  }
  return {
    get count() {
      return pending.size
    },
    get created() {
      return created
    },
    /** 让「4 秒到了」真的发生：真跑那个回调（轮询请求会真的发出去） */
    fire() {
      const entry = [...pending.entries()][0]
      if (entry === undefined) {
        return false
      }
      const [id, fn] = entry
      pending.delete(id)
      realClearTimeout(id)
      fn()
      return true
    },
    restore() {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
      for (const id of pending.keys()) {
        realClearTimeout(id)
      }
      pending.clear()
    },
  }
}

const P3_ROWS = [
  {
    id: '1',
    name: 'F7-11/F7-16 过期单（EXPIRED）→ 一个轮询定时器都不起，也不显示「正在准备卡密」',
    orders: [trailOrder('NO-EXPIRED-1', 'expired')],
    steps: [],
    timers: 0,
    created: 0,
  },
  {
    id: '2',
    name: 'F7-16 paid 未发卡 → 恰好 1 个定时器；4 秒到点只再拉一条，定时器不叠加（不重复建单）',
    orders: [trailOrder('NO-PAID-1', 'paid')],
    steps: ['fire'],
    timers: 1,
    created: 2,
  },
  {
    id: '3',
    name: 'F7-16 旧单不再轮询：切到「已关闭」筛选后定时器清零，且不再起新的',
    orders: [trailOrder('NO-PAID-2', 'paid')],
    steps: ['tab-expired'],
    timers: 0,
    created: 1,
  },
]

test('P3/F7-16 过期单重新下单后旧单不再轮询、不重复计时（表驱动 3 行）', async (t) => {
  for (const row of P3_ROWS) {
    t.diagnostic(`P3/${row.id} ${row.name}`)
    const { TRAIL_POLL_INTERVAL_MS } = await harness.importSource(
      'src/components/settings/PaymentTrailView.ts'
    )
    const { PaymentTrailDialog } = await harness.importSource(
      'src/components/settings/PaymentTrailDialog.tsx'
    )

    harness.ctx.reset()
    harness.ctx.apiKey = KEY
    // 轨迹页的门禁只认自有渠道（shouldShowPaymentTrail）
    harness.ctx.kind = 'ours'
    const requests = []
    // 服务端的筛选是**真的**：切到「已关闭」只回过期单，于是「旧单还在不在」由数据本身决定
    const fetchTrail = async (query) => {
      requests.push(query)
      const status = query.status ?? null
      return trailPage(
        status === null ? row.orders : row.orders.filter((order) => order.status === status)
      )
    }

    const clock = createPollClock(TRAIL_POLL_INTERVAL_MS)
    try {
      const view = await harness.mount(PaymentTrailDialog, { onClose: () => {}, fetchTrail })
      assert.equal(requests.length, 1, '挂载时只拉第一页')

      if (row.orders[0].status === 'expired') {
        assert.equal(view.has('trail-waiting-card'), false, '过期单不能显示「正在准备卡密」')
      } else {
        assert.equal(view.has('trail-waiting-card'), true, 'paid 未发卡才该显示「正在准备卡密」')
      }

      if (row.steps.includes('fire')) {
        const before = requests.length
        assert.equal(clock.fire(), true, 'paid 单必须存在待触发的轮询定时器')
        await view.settle()
        assert.equal(requests.length, before + 1, '4 秒到点应该真的再拉一条（静默轮询）')
        assert.equal(clock.count, 1, `轮询定时器不能叠加，实际 ${clock.count} 个`)
      }

      if (row.steps.includes('tab-expired')) {
        await view.click('trail-tab-expired')
        assert.equal(requests.at(-1).status, 'expired', '切到「已关闭」要带 status=expired 重新拉')
        assert.equal(view.has('trail-waiting-card'), false, '过期筛选里没有等待发卡的单')
      }

      assert.equal(
        clock.count,
        row.timers,
        `轮询定时器数量：期望 ${row.timers}，实际 ${clock.count}`
      )
      assert.equal(
        clock.created,
        row.created,
        `一共建过 ${clock.created} 个定时器，期望 ${row.created} 个`
      )

      // 关掉弹层 = 用户离开这页：不许在后台继续轮询旧单
      view.unmount()
      assert.equal(clock.count, 0, '关闭弹层后必须清掉轮询定时器')
    } finally {
      clock.restore()
    }
  }
})

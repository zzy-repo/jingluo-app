// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <2s] 说明见 tests/README.md
//
// Issue #157（P0）：重新下单没覆盖本地单号 → 付款成功后界面一直「等待支付」。
// 这一层只测**纯逻辑**（不碰 React / DOM / Capacitor），浏览器里那一遍见
// tests/integration/ours-order-overwrite.test.mjs（同一套桩后端 + 390/360 截图）。
//
//   [1] 存档是「覆盖」不是追加：连下两单后只留第二单
//   [2] 存档变化会通知订阅者（含跨标签页的 storage 事件，别的 key 不通知）
//   [3] pollOrder 每 tick 回读最新存档：旧的那次轮询自己换到新单，且不再问旧单
//   [4] pollOrder 换单时 60s 预算重新计时（新单是刚建的，不能沿用旧单的余量）
//   [5] /api/order 的 latest_fulfilled：解析出来 → 直接给卡；缺卡密/已完成单上不认
//   [6] consumeOrderReturn：回跳覆盖旧存档时明确报 replacedUnpaidOrder
import { registerHooks } from 'node:module'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})

const api = await import('../../src/services/ours/api.ts')
const orderStore = await import('../../src/services/ours/orderStore.ts')
const { consumeOrderReturn } = await import('../../src/services/ours/returnParams.ts')

/** Issue #157 的两笔真实单号 */
const FIRST_UNPAID = 'CP202611182105334E806605'
const PAID_ORDER = 'CP202611182359489D46C638'
const PAID_CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${label} = ${a}`)
  } else {
    bad(`${label}：期望 ${b}，实际 ${a}`)
  }
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))

const fakeStorage = () => {
  const data = new Map()
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  }
}

/** 假 window：只要能收 storage 事件（跨标签页写入） */
const fakeWindow = () => {
  const handlers = new Set()
  return {
    handlers,
    addEventListener: (type, fn) => {
      if (type === 'storage') handlers.add(fn)
    },
    removeEventListener: (type, fn) => {
      if (type === 'storage') handlers.delete(fn)
    },
    fire: (key) => {
      for (const fn of handlers) fn({ key })
    },
  }
}

const pendingBody = (no, extra = {}) => ({
  out_trade_no: no,
  status: 'pending',
  amount_fen: 100,
  card_no: null,
  expire_at: 1795019285,
  message: '等待支付',
  ...extra,
})

const fulfilledBody = (no) => ({
  out_trade_no: no,
  status: 'fulfilled',
  amount_fen: 100,
  card_no: PAID_CARD,
  expire_at: 1795019285,
  message: '已发卡',
})

// ---------------------------------------------------------------- [1] 覆盖
console.log('\n[1] 存档是覆盖，不是追加')
{
  const storage = fakeStorage()
  orderStore.writeStoredOrder(
    { outTradeNo: FIRST_UNPAID, orderToken: 'tok-first', planId: 'newbie', startedAt: 1 },
    storage
  )
  orderStore.writeStoredOrder(
    { outTradeNo: PAID_ORDER, orderToken: 'tok-paid', planId: 'newbie', startedAt: 2 },
    storage
  )
  const stored = orderStore.readStoredOrder(storage)
  eq(stored?.outTradeNo, PAID_ORDER, '1.1 第二次写入覆盖第一次（只剩一个存档 key）')
  eq(stored?.orderToken, 'tok-paid', '1.2 令牌一起换掉')
  eq(storage.data.size, 1, '1.3 全局只有一个存档 key（不是列表）')
  orderStore.writeStoredOrder(null, storage)
  eq(orderStore.readStoredOrder(storage), null, '1.4 写 null 即清空')
}

// ---------------------------------------------------------------- [2] 订阅
console.log('\n[2] 存档变化通知（进程内 + 跨标签页）')
{
  const storage = fakeStorage()
  const win = fakeWindow()
  let hits = 0
  const stop = orderStore.subscribeStoredOrder(() => {
    hits += 1
  }, win)
  orderStore.writeStoredOrder(
    { outTradeNo: PAID_ORDER, orderToken: 'tok-paid', planId: 'newbie', startedAt: 1 },
    storage
  )
  eq(hits, 1, '2.1 写存档通知一次')
  win.fire(orderStore.ORDER_STORAGE_KEY)
  eq(hits, 2, '2.2 别的标签页写了同一个 key → 也通知')
  win.fire('chat-demo:api-key')
  eq(hits, 2, '2.3 别的 key 的变化不打扰订单轮询')
  win.fire(null)
  eq(hits, 3, '2.4 localStorage.clear()（key=null）当作存档可能变了')
  stop()
  orderStore.writeStoredOrder(null, storage)
  eq(hits, 3, '2.5 退订后不再通知')
  // 写 null 也要通知：否则轮询会守着已经清空的存档
  let removed = 0
  const stop2 = orderStore.subscribeStoredOrder(() => {
    removed += 1
  })
  orderStore.writeStoredOrder(
    { outTradeNo: PAID_ORDER, orderToken: 'tok-paid', planId: 'newbie', startedAt: 1 },
    storage
  )
  orderStore.writeStoredOrder(null, storage)
  eq(removed, 2, '2.6 写入与清空都通知')
  stop2()
}

// 假时钟 + 假传输：每一次 /api/order 都记下来
const makeTransport = (answer) => {
  const calls = []
  return {
    calls,
    transport: async (request) => {
      const url = new URL(request.url)
      calls.push({
        path: url.pathname,
        outTradeNo: url.searchParams.get('out_trade_no') ?? '',
        token: url.searchParams.get('order_token') ?? '',
      })
      return { kind: 'response', status: 200, text: JSON.stringify(answer(url)) }
    },
  }
}

// ---------------------------------------------------------------- [3] 轮询换单
console.log('\n[3] pollOrder：存档一换，旧的那次轮询自己切到新单')
{
  // 第 2 个 tick 起，存档被「重新下单」覆盖成第二单（模拟 startCheckout 的覆盖写）
  const switchAt = 2000
  let paidQueries = 0
  const clock = { t: 0 }
  const fake = makeTransport((url) => {
    const no = url.searchParams.get('out_trade_no')
    if (no === PAID_ORDER) {
      paidQueries += 1
      return paidQueries >= 2 ? fulfilledBody(no) : pendingBody(no)
    }
    return pendingBody(no)
  })
  const switches = []
  const updates = []
  const result = await api.pollOrder({
    outTradeNo: FIRST_UNPAID,
    orderToken: 'tok-first',
    transport: fake.transport,
    intervalMs: 2000,
    timeoutMs: 60000,
    latest: () => (clock.t >= switchAt ? { outTradeNo: PAID_ORDER, orderToken: 'tok-paid' } : null),
    onSwitch: (next) => switches.push(next),
    onUpdate: (order) => updates.push(order.outTradeNo),
    sleep: async (ms) => {
      clock.t += ms
    },
    now: () => clock.t,
  })
  eq(result.kind, 'ok', '3.1 轮询以「已发卡」收尾（不是查旧单查到超时）')
  eq(switches, [{ outTradeNo: PAID_ORDER, orderToken: 'tok-paid' }], '3.2 换单回调带着新单号与新令牌')
  eq(
    fake.calls.map((item) => item.outTradeNo),
    [FIRST_UNPAID, PAID_ORDER, PAID_ORDER],
    '3.3 换单后一次都没有再问旧单'
  )
  eq(
    fake.calls.filter((item) => item.outTradeNo === PAID_ORDER).every((item) => item.token === 'tok-paid'),
    true,
    '3.4 新单用的是新令牌（旧的查不到新单，会 403）'
  )
  eq(updates, [FIRST_UNPAID, PAID_ORDER, PAID_ORDER], '3.5 界面回调里单号跟着换')
  eq(result.kind === 'ok' ? result.order.cardNo : '', PAID_CARD, '3.6 拿到第二单的卡密')
  eq(
    fake.calls.length,
    3,
    '3.7 只有 3 次查询（旧单 1 次 + 新单 2 次），没有两个轮询各查各的'
  )
}

// ---------------------------------------------------------------- [4] 换单重开预算
console.log('\n[4] 换单时 60s 预算重新计时')
{
  const clock = { t: 0 }
  let switched = false
  const fake = makeTransport((url) => {
    const no = url.searchParams.get('out_trade_no')
    // 旧单一直 pending；新单第 3 次查才发卡
    if (no === PAID_ORDER) {
      return clock.t >= 8000 ? fulfilledBody(no) : pendingBody(no)
    }
    return pendingBody(no)
  })
  const result = await api.pollOrder({
    outTradeNo: FIRST_UNPAID,
    orderToken: 'tok-first',
    transport: fake.transport,
    intervalMs: 2000,
    timeoutMs: 6000,
    latest: () => {
      // 第 3 个 tick（t=4000）时才换单：旧单已经用掉 4s，超时上限只有 6s
      if (!switched && clock.t >= 4000) {
        switched = true
        return { outTradeNo: PAID_ORDER, orderToken: 'tok-paid' }
      }
      return null
    },
    sleep: async (ms) => {
      clock.t += ms
    },
    now: () => clock.t,
  })
  eq(result.kind, 'ok', '4.1 换单后重新给满预算 → 能等到新单发卡（不是沿用旧单的余量立刻超时）')
  truthy(clock.t >= 8000, `4.2 真的等到了新单发卡那一刻（t=${clock.t}ms）`)
}

// ---------------------------------------------------------------- [5] latest_fulfilled
console.log('\n[5] /api/order 的兜底字段 latest_fulfilled')
{
  const withLatest = makeTransport(() =>
    pendingBody(FIRST_UNPAID, {
      latest_fulfilled: {
        out_trade_no: PAID_ORDER,
        plan_id: 'newbie',
        amount_yuan: 1.0,
        card_no: PAID_CARD,
        paid_at: 1795015210,
      },
    })
  )
  const one = await api.queryOrder({ outTradeNo: FIRST_UNPAID, orderToken: 'tok-first' }, withLatest.transport)
  eq(one.kind, 'ok', '5.1 查询成功')
  const latest = one.kind === 'ok' ? one.order.latestFulfilled : null
  eq(latest?.outTradeNo, PAID_ORDER, '5.2 解析出兜底单号')
  eq(latest?.cardNo, PAID_CARD, '5.3 兜底卡密（完整卡号只在内存里）')
  eq(latest?.cardTail, '••••A3SR', '5.4 界面只显示尾号')
  eq(latest?.amountYuan, 1, '5.5 金额（元）')
  eq(latest?.paidAtSeconds, 1795015210, '5.6 支付时间（秒）')
  eq(one.kind === 'ok' ? one.order.status : '', 'pending', '5.7 当前单状态照旧 pending（不冒充已发卡）')

  const noCard = makeTransport(() =>
    pendingBody(FIRST_UNPAID, { latest_fulfilled: { out_trade_no: PAID_ORDER, plan_id: 'newbie', amount_yuan: 1 } })
  )
  const two = await api.queryOrder({ outTradeNo: FIRST_UNPAID, orderToken: 't' }, noCard.transport)
  eq(two.kind === 'ok' ? two.order.latestFulfilled : 'x', null, '5.8 兜底记录没有卡密就不展示（不摆一张空卡）')

  const alreadyFulfilled = makeTransport(() =>
    fulfilledBody(FIRST_UNPAID)
  )
  const three = await api.queryOrder({ outTradeNo: FIRST_UNPAID, orderToken: 't' }, alreadyFulfilled.transport)
  eq(three.kind === 'ok' ? three.order.latestFulfilled : 'x', null, '5.9 自己这单已发卡时不看兜底字段')

  const pendingOnly = makeTransport(() => pendingBody(FIRST_UNPAID))
  const four = await api.queryOrder({ outTradeNo: FIRST_UNPAID, orderToken: 't' }, pendingOnly.transport)
  eq(four.kind === 'ok' ? four.order.latestFulfilled : 'x', null, '5.10 服务端没带这个字段时是 null')
}

// ---------------------------------------------------------------- [6] 回跳覆盖
console.log('\n[6] consumeOrderReturn：回跳覆盖旧存档时要能报出来')
{
  const winOf = (search) => {
    const parsed = new URL(search, 'https://chat.example.com')
    return {
      location: { search: parsed.search, pathname: parsed.pathname, hash: parsed.hash },
      history: { replaceState: () => {} },
    }
  }
  const storage = fakeStorage()
  orderStore.writeStoredOrder(
    { outTradeNo: FIRST_UNPAID, orderToken: 'tok-first', planId: 'newbie', startedAt: 1 },
    storage
  )
  const first = consumeOrderReturn(winOf(`?no=${PAID_ORDER}&order_token=tok-paid`), { now: () => 2, storage })
  eq(first?.outTradeNo, PAID_ORDER, '6.1 回跳单号被认出来')
  eq(first?.replacedUnpaidOrder, true, '6.2 覆盖掉一笔未完成旧单 → 要求界面提示「上一笔未支付订单已失效」')
  eq(orderStore.readStoredOrder(storage)?.outTradeNo, PAID_ORDER, '6.3 存档已被覆盖成回跳那一单')

  const again = consumeOrderReturn(winOf(`?no=${PAID_ORDER}&order_token=tok-paid`), { now: () => 3, storage })
  eq(again?.replacedUnpaidOrder, false, '6.4 同一个单号再回跳一次不算「覆盖」')

  const stale = fakeStorage()
  orderStore.writeStoredOrder(
    {
      outTradeNo: FIRST_UNPAID,
      orderToken: 'tok-first',
      planId: 'newbie',
      startedAt: 1,
    },
    stale
  )
  const old = consumeOrderReturn(winOf(`?no=${PAID_ORDER}&order_token=tok-paid`), {
    now: () => 1 + orderStore.ORDER_RESUME_MAX_AGE_MS + 1000,
    storage: stale,
  })
  eq(old?.replacedUnpaidOrder, false, '6.5 超过 30 分钟的旧存档本来就不会再查，不提示')
}

console.log('')
if (failures.length === 0) {
  console.log(`ours-order-overwrite: 全部通过（${checks.n} 项）`)
} else {
  console.error(`ours-order-overwrite: ${failures.length} 项失败 / 共 ${checks.n} 项`)
  for (const item of failures) console.error(` - ${item}`)
  process.exitCode = 1
}

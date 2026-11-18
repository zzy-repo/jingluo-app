// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// Issue #115（付款记录：下单带 cid + 重新下单覆盖单号 + 展示历史订单）的单测：
//   [1] 所有 /buy 请求都要带 cid（漏了必须红；拿不到 customer_id 时明确报错，不发不带 cid 的请求）
//   [2] 连续两次下单：本地存档必须是**最新**单号，轮询跟最新单
//   [3] /api/orders 解析：金额 / 三态状态 / 时间 / 卡号后 4 位 / total_paid_yuan，空列表也不炸
//   [4] 两账号隔离：Key 无效（401）时明确报 UNAUTHORIZED，不糊成「没有订单」
import { registerHooks } from 'node:module'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
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

// 新模块：还没实现时这里会抛，直接记成一次失败（而不是整个文件崩掉，红证据要看得见）
let records = null
let recordsImportError = ''
try {
  records = await import('../../src/services/ours/paymentRecords.ts')
} catch (error) {
  recordsImportError = error instanceof Error ? error.message : String(error)
}

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  checks.n += 1
  failures.push(message)
  console.log(`  FAIL ${message}`)
}
const eq = (actual, expected, message) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${message} = ${a}`)
  } else {
    bad(`${message}: 期望 ${b}，实际 ${a}`)
  }
}
const truthy = (value, message) => {
  if (value) {
    ok(message)
  } else {
    bad(message)
  }
}

const NO_1 = 'CP20261118210500AAAAAAAA'
const NO_2 = 'CP20261118211300BBBBBBBB'
const TOKEN_1 = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'
const TOKEN_2 = 'Qq7w1ZtNeWmRkPvCyGuHjXbA4dEsF3Ln'

/** 实测（2026-11-18）收银台地址：out_trade_no 在自己身上，order_token 在 return_url 的 query 里 */
const cashierUrl = (outTradeNo, orderToken) =>
  'https://pay.xiaodouap.cn/submit.php?pid=1001' +
  `&out_trade_no=${outTradeNo}&money=0.10` +
  `&return_url=${encodeURIComponent(`https://apia.ecsafe.cn/return?no=${outTradeNo}&order_token=${orderToken}`)}`

const fakeStorage = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  }
}

const makeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.shift()
    if (next === undefined) {
      throw new Error(`unexpected request: ${request.method} ${request.url}`)
    }
    return next
  }
  return { transport, calls }
}

const jsonResponse = (status, body) => ({
  kind: 'response',
  status,
  text: JSON.stringify(body),
  location: '',
})

// ---------------------------------------------------------------------------
console.log('[1] /buy 必须带 cid（下单归属该客户）')
{
  const url = api.buyUrl('p1', 10)
  truthy(url.includes('plan=p1'), '1.1 buyUrl 带上套餐：' + url)
  truthy(url.includes('cid=10'), '1.2 buyUrl 带上 cid=10：' + url)

  // 缓存里的 cid 也要自动带上（弹层里 navigateTopLevel(buyUrl(planId)) 的老调用点没有第二参数）
  const storage = fakeStorage()
  if (records === null) {
    bad(`1.3 付款记录模块缺失，无法建立 cid 缓存：${recordsImportError}`)
  } else {
    records.cacheCustomerId(10, storage)
    const cached = api.buyUrl('p1', undefined, storage)
    truthy(cached.includes('cid=10'), '1.3 buyUrl 从缓存补 cid：' + cached)
  }

  // 原生路径：实际发出的请求 URL
  const order = makeTransport([{ kind: 'response', status: 302, text: '', location: cashierUrl(NO_1, TOKEN_1) }])
  const result = await api.startCheckout('p1', order.transport, {
    customerId: 10,
    storage: fakeStorage(),
  })
  eq(result.kind, 'ok', '1.4 startCheckout 成功')
  eq(order.calls.length, 1, '1.5 只发一次 /buy')
  truthy(
    (order.calls[0]?.url ?? '').includes('cid=10'),
    '1.6 startCheckout 发出的 /buy 带 cid：' + (order.calls[0]?.url ?? '')
  )

  // 拿不到 customer_id：不许静默发不带 cid 的请求
  const blind = makeTransport([{ kind: 'response', status: 302, text: '', location: cashierUrl(NO_1, TOKEN_1) }])
  const missing = await api.startCheckout('p1', blind.transport, { customerId: null, storage: fakeStorage() })
  eq(missing.kind, 'error', '1.7 没有 customer_id 时返回错误')
  eq(missing.kind === 'error' ? missing.code : '', 'CUSTOMER_ID_MISSING', '1.8 错误码 CUSTOMER_ID_MISSING')
  eq(
    missing.kind === 'error' ? missing.messageKey : '',
    'oursErrCustomerMissing',
    '1.9 有可展示的提示文案 key'
  )
  eq(blind.calls.length, 0, '1.10 一个请求都不发（绝不发不带 cid 的 /buy）')

  // 源码级：除了 api.ts 的 buyUrl，不许有第二个 /buy?plan= 构造点（逐点核对，防漏）
  const root = path.resolve(import.meta.dirname, '../..')
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : walk(full)
      }
      return /\.(ts|tsx)$/u.test(entry.name) ? [full] : []
    })
  const offenders = walk(path.join(root, 'src'))
    .filter((file) => !file.endsWith(path.join('ours', 'api.ts')))
    // 只看真正的代码行：注释里提到 /buy?plan=… 不算构造点
    .filter((file) =>
      /buy\?plan=/u.test(
        readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '')
      )
    )
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
  eq(offenders, [], '1.11 /buy?plan= 只在 api.ts 的 buyUrl 里拼（没有漏掉的构造点）')
}

// ---------------------------------------------------------------------------
console.log('[2] 连续两次下单：存档必须是最新单号')
{
  const storage = fakeStorage()
  const first = makeTransport([{ kind: 'response', status: 302, text: '', location: cashierUrl(NO_1, TOKEN_1) }])
  const second = makeTransport([{ kind: 'response', status: 302, text: '', location: cashierUrl(NO_2, TOKEN_2) }])

  const r1 = await api.startCheckout('p1', first.transport, { customerId: 10, storage })
  const r2 = await api.startCheckout('p2', second.transport, { customerId: 10, storage })

  eq(r1.kind, 'ok', '2.1 第一单下单成功')
  eq(r2.kind, 'ok', '2.2 第二单下单成功')
  eq(r1.kind === 'ok' ? r1.replacedUnpaidOrder : null, false, '2.3 第一单没有可覆盖的旧单')
  eq(r2.kind === 'ok' ? r2.replacedUnpaidOrder : null, true, '2.4 第二单覆盖了上一笔未支付订单')

  const stored = orderStore.readStoredOrder(storage)
  eq(stored?.outTradeNo, NO_2, '2.5 本地存档是最新单号（旧实现在此红）')
  eq(stored?.orderToken, TOKEN_2, '2.6 令牌也是最新单的')
  eq(stored?.planId, 'p2', '2.7 套餐跟着最新单')

  // 轮询必须跟最新单：查单 URL 用的是存档里的单号 + 令牌
  const poller = makeTransport([
    jsonResponse(200, { status: 'fulfilled', out_trade_no: NO_2, amount_fen: 10, card_no: 'CARD-2222' }),
  ])
  const polled = await api.queryOrder(
    // 存档里没有单号时不要在这里炸掉：2.5 已经红过一次，后面继续跑完给完整证据
    { outTradeNo: stored?.outTradeNo ?? '', orderToken: stored?.orderToken ?? '' },
    poller.transport
  )
  eq(polled.kind, 'ok', '2.8 按最新单查单成功')
  const queryUrl = poller.calls[0]?.url ?? '(没有发出查单请求)'
  truthy(queryUrl.includes(`out_trade_no=${NO_2}`), '2.9 查的是最新单号：' + queryUrl)
  truthy(queryUrl.includes(`order_token=${TOKEN_2}`), '2.10 用的是最新单的令牌')
}

// ---------------------------------------------------------------------------
console.log('[3] /api/orders 解析：金额 / 状态 / 时间 / 卡号后 4 位 / total_paid_yuan')
if (records === null) {
  bad(`付款记录模块缺失，[3][4] 全部无法验证：${recordsImportError}`)
} else {
  // 实测真实响应（该账号还没有已支付订单）：
  //   {"customer_id": 10, "total_paid_yuan": 0.0, "orders": []}
  const emptyParsed = records.parsePaymentRecords({ customer_id: 10, total_paid_yuan: 0.0, orders: [] })
  eq(emptyParsed?.customerId, 10, '3.1 空列表也解析出 customer_id')
  eq(emptyParsed?.totalPaidYuan, 0, '3.2 total_paid_yuan 原样读回')
  eq(emptyParsed?.orders, [], '3.3 空列表不报错')

  const body = {
    customer_id: 10,
    total_paid_yuan: 3.1,
    orders: [
      {
        out_trade_no: NO_1,
        plan_id: 'p1',
        amount_fen: 10,
        status: 'EXPIRED',
        card_no: '',
        created_at: 1_766_900_000,
        paid_at: null,
      },
      {
        out_trade_no: NO_2,
        plan_id: 'p2',
        amount_fen: 3900,
        status: 'FULFILLED',
        card_no: 'MUSE-XWBF-J4TZ-WHSQ-QHJ5',
        created_at: 1_766_900_500,
        paid_at: 1_766_900_560,
        redeemed_at: null,
      },
    ],
  }
  const parsed = records.parsePaymentRecords(body)
  eq(parsed?.totalPaidYuan, 3.1, '3.4 total_paid_yuan 读回')
  eq(parsed?.orders.length, 2, '3.5 两笔订单')
  eq(parsed?.orders[0]?.outTradeNo, NO_2, '3.6 最新的排在前面')
  eq(parsed?.orders[0]?.status, 'completed', '3.7 FULFILLED → 已完成')
  eq(parsed?.orders[0]?.amountYuan, 39, '3.8 金额换成元（39.00）')
  eq(parsed?.orders[0]?.paidAt, 1_766_900_560, '3.9 支付时间读回（秒）')
  eq(parsed?.orders[1]?.status, 'expired', '3.10 EXPIRED → 已过期')
  // 隐私：列表只用尾号
  const tail = parsed?.orders[0]?.cardTail ?? ''
  truthy(tail.endsWith('QHJ5'), '3.11 卡号后 4 位 QHJ5：' + tail)
  truthy(!tail.includes('MUSE-XWBF'), '3.12 列表里的尾号不含完整卡密')
  eq(parsed?.orders[0]?.cardNo, 'MUSE-XWBF-J4TZ-WHSQ-QHJ5', '3.13 完整卡密只给「查看卡密 / 去兑换」')

  // 待支付也算一种（三种展示态）
  const pending = records.parsePaymentRecords({
    customer_id: 10,
    total_paid_yuan: 0,
    orders: [{ out_trade_no: NO_1, amount_fen: 10, status: 'PENDING', created_at: 1_766_900_000 }],
  })
  eq(pending?.orders[0]?.status, 'pending', '3.14 PENDING → 待支付')

  // 最多 50 条，按时间倒序
  const many = {
    customer_id: 10,
    total_paid_yuan: 1,
    orders: Array.from({ length: 60 }, (_, index) => ({
      out_trade_no: `CP${index}`,
      amount_fen: 10,
      status: 'FULFILLED',
      card_no: 'CARD-0000',
      created_at: 1_766_900_000 + index,
    })),
  }
  const manyParsed = records.parsePaymentRecords(many)
  eq(manyParsed?.orders.length, 50, '3.15 最多 50 条')
  eq(manyParsed?.orders[0]?.outTradeNo, 'CP59', '3.16 最新的一笔在最前面')
  eq(manyParsed?.orders[49]?.outTradeNo, 'CP10', '3.17 第 50 条是倒数第 50 新')

  // 坏数据：整块不认，调用方按「加载失败」处理，不当成「没有订单」
  eq(records.parsePaymentRecords({ orders: 'oops' }), null, '3.18 坏数据返回 null')

  // -------------------------------------------------------------------------
  console.log('[4] fetchPaymentRecords：鉴权 / 两账号隔离 / cid 落缓存')
  const storage = fakeStorage()
  const okTransport = makeTransport([
    jsonResponse(200, { customer_id: 10, total_paid_yuan: 0.0, orders: [] }),
  ])
  const fetched = await records.fetchPaymentRecords('sk-live-test', okTransport.transport, storage)
  eq(fetched.kind, 'ok', '4.1 拉取成功')
  eq(okTransport.calls[0]?.url, 'https://apia.ecsafe.cn/api/orders', '4.2 打的是 /api/orders')
  eq(okTransport.calls[0]?.headers?.Authorization, 'Bearer sk-live-test', '4.3 带 Bearer Key')
  if (fetched.kind === 'ok') {
    eq(fetched.data.customerId, 10, '4.4 顺带拿到 customer_id')
  }
  eq(records.readCachedCustomerId(storage), 10, '4.5 customer_id 落进缓存（下单时用它拼 cid）')

  const denied = makeTransport([
    jsonResponse(401, { code: 'UNAUTHORIZED', message: 'API Key 无效', request_id: 'cfe4a32c6726' }),
  ])
  const deniedResult = await records.fetchPaymentRecords('sk-live-bad', denied.transport, fakeStorage())
  eq(deniedResult.kind, 'error', '4.6 无效 Key 报错而不是「没有订单」')
  eq(deniedResult.kind === 'error' ? deniedResult.code : '', 'UNAUTHORIZED', '4.7 错误码 UNAUTHORIZED')
  eq(
    deniedResult.kind === 'error' ? deniedResult.messageKey : '',
    'oursErrUnauthorized',
    '4.8 提示 Key 无效（与 api.ts 的 401 文案同一个 key，全 App 口径一致）'
  )

  const empty = makeTransport([jsonResponse(200, { customer_id: 11, total_paid_yuan: 0, orders: [] })])
  const otherAccount = await records.fetchPaymentRecords('sk-live-other', empty.transport, fakeStorage())
  eq(
    otherAccount.kind === 'ok' ? otherAccount.data.orders.length : -1,
    0,
    '4.9 另一个账号：列表为空（看不到别人的订单）'
  )

  // 没有 Key 时一次请求都不发
  const noKey = makeTransport([])
  const noKeyResult = await records.fetchPaymentRecords('   ', noKey.transport, fakeStorage())
  eq(noKeyResult.kind, 'error', '4.10 没 Key 直接报错')
  eq(noKey.calls.length, 0, '4.11 没 Key 不发请求')
}

console.log('')
if (failures.length === 0) {
  console.log(`ours-payment-records: 全部通过（${checks.n} 项）`)
  process.exit(0)
}
console.log(`ours-payment-records: ${failures.length}/${checks.n} 项失败`)
for (const item of failures) {
  console.log(`  - ${item}`)
}
process.exit(1)

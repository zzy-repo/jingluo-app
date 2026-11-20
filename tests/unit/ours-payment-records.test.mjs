// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// Issue #115（付款记录：展示历史订单 / 两账号隔离）的单测。
//
// Issue #331：下单链路已停用（我们不建单、不查单），原 [1]（/buy 必须带 cid）与
// [2]（连续两次下单存档跟最新单）跟着旧链路一起删除 —— 现在只剩「翻自己的历史订单」这一件事：
//   [1] /api/orders 解析：金额 / 三态状态 / 时间 / 卡号后 4 位 / total_paid_yuan，空列表也不炸
//   [2] 两账号隔离：Key 无效（401）时明确报 UNAUTHORIZED，不糊成「没有订单」
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

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
console.log('[1] /api/orders 解析：金额 / 状态 / 时间 / 卡号后 4 位 / total_paid_yuan')
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
  console.log('[2] fetchPaymentRecords：鉴权 / 两账号隔离 / cid 落缓存')
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

// [layer: unit | 依赖: 无（纯 Node，零浏览器） | 耗时: <1s] 说明见 tests/README.md
// Issue #36（网页版购买）的订正后单测：
//   网页版点「去支付」= 浏览器顶层导航到 /buy?plan=<id>（不是 fetch 读 302），
//   付款回到我们页面后从 ?no=&order_token= 进「订单查询」。
//
// 本文件只测纯逻辑（不碰 React / DOM / Capacitor）：
//   [1] buyUrl：跨域顶层跳转的目标地址，plan 必须编码
//   [2] startCheckout（原生路径）用的仍是同一个入口，行为不变
//   [3] parseOrderReturn：`?no=` 与 `?order_token=` 都齐才算回跳，缺一个就不查单
//   [4] consumeOrderReturn：认出回跳 → 清地址栏参数 → 落盘（供弹层续查）
//   [4b] replacedUnpaidOrder（#157）：只有「覆盖 30 分钟内的另一笔存档」才是 true
//   [5] 没有回跳参数时：不查单、不动地址栏、不写存档
//   [6] orderStore：读写往返 / 坏数据 / 无 storage 都不抛
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'

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

const { buyUrl, OURS_API_BASE, parseOrderReturn, startCheckout } = await import('../../src/services/ours/api.ts')
const { consumeOrderReturn, ORDER_RETURN_KEYS, stripOrderReturn } = await import(
  '../../src/services/ours/returnParams.ts'
)
const { ORDER_RESUME_MAX_AGE_MS, ORDER_STORAGE_KEY, readStoredOrder, writeStoredOrder } = await import(
  '../../src/services/ours/orderStore.ts'
)

const OUT_TRADE_NO = 'CP2026111816102637F0F8AA'
const ORDER_TOKEN = 'Lsx2M8cBadOaJrXElnZBLISmtImUtfp9'

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

/** 假 localStorage：断言「存了什么」 */
const fakeStorage = () => {
  const data = new Map()
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  }
}

/** 假 window：只提供 returnParams 用到的 location / history */
const fakeWindow = (url) => {
  const parsed = new URL(url, 'https://chat.example.com')
  const state = {
    replaced: [],
    location: { search: parsed.search, pathname: parsed.pathname, hash: parsed.hash },
    history: {
      replaceState: (data, unused, next) => {
        state.replaced.push(next)
      },
    },
  }
  return state
}

// ---------------------------------------------------------------- [1] buyUrl
console.log('\n[1] buyUrl：网页版顶层导航的目标')
{
  eq(buyUrl('p1'), `${OURS_API_BASE}/buy?plan=p1`, 'buyUrl(p1)')
  eq(OURS_API_BASE, 'https://apia.ecsafe.cn', 'base 是 HTTPS 支付域名（跨域顶层跳转的目标）')
  eq(buyUrl(' p2 '), `${OURS_API_BASE}/buy?plan=p2`, 'plan id 去空白')
  eq(
    buyUrl('a&b=c'),
    `${OURS_API_BASE}/buy?plan=a%26b%3Dc`,
    'plan id 做 URL 编码（不让用户输入改变查询串结构）'
  )
  truthy(buyUrl('p1').startsWith('https://'), '顶层跳转目标是 https（明文地址不开）')
}

// ---------------------------------------------------------------- [2] 原生路径不变
console.log('\n[2] startCheckout（原生）与 buyUrl 同源，行为不变')
{
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return { kind: 'response', status: 302, text: '', location: '' }
  }
  const result = await startCheckout('p1', transport, { customerId: 10 })
  eq(calls.length, 1, '原生只发一次 /buy')
  eq(calls[0].url, buyUrl('p1', 10), '原生请求的 URL 就是 buyUrl(p1, 10)（与网页版同一个带 cid 的地址）')
  eq(calls[0].followRedirects, false, '原生仍然不跟随重定向')
  eq(result.kind, 'no-location', '读不到 Location → no-location（不猜单号）')
}

// ---------------------------------------------------------------- [3] 回跳参数解析
console.log('\n[3] parseOrderReturn：`no` + `order_token` 都齐才算回跳')
{
  eq(parseOrderReturn(`?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`), {
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
  }, '标准回跳参数（收银台 return_url 的结构）')
  eq(parseOrderReturn(`no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`), {
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
  }, '不带问号也认')
  eq(parseOrderReturn(`?out_trade_no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`), {
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
  }, 'out_trade_no 是 no 的别名')
  eq(parseOrderReturn(`?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}&plan=p1`), {
    outTradeNo: OUT_TRADE_NO,
    orderToken: ORDER_TOKEN,
  }, '多余参数不影响')
  eq(parseOrderReturn(`?no=${OUT_TRADE_NO}`), null, '只有单号（没有令牌）→ 不查单')
  eq(parseOrderReturn(`?order_token=${ORDER_TOKEN}`), null, '只有令牌（没有单号）→ 不查单')
  eq(parseOrderReturn(''), null, '空查询串 → 不查单')
  eq(parseOrderReturn('?plan=p1'), null, '只有 plan → 不查单（正常打开页面绝不查单）')
  eq(parseOrderReturn('?no=%20&order_token=%20'), null, '空白值不算数')
}

// ---------------------------------------------------------------- [4][5] 启动时消费回跳
console.log('\n[4] consumeOrderReturn：认出回跳 → 清地址栏 → 落盘')
{
  const win = fakeWindow(`/?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}&plan=p1`)
  const storage = fakeStorage()
  const result = consumeOrderReturn(win, { now: () => 1763000000000, storage })
  // Issue #157：返回值多一个 replacedUnpaidOrder（这次覆盖掉了一笔未完成旧单才为 true）
  eq(
    result,
    { outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN, replacedUnpaidOrder: false },
    '返回单号与令牌（+ #157 的「是否覆盖了未完成旧单」）'
  )
  eq(win.replaced.length, 1, '只清一次地址栏')
  eq(win.replaced[0], '/?plan=p1', '地址栏去掉 no / order_token，保留其它参数')
  const stored = readStoredOrder(storage)
  eq(stored?.outTradeNo, OUT_TRADE_NO, '存档里的单号')
  eq(stored?.orderToken, ORDER_TOKEN, '存档里的 order_token（没有它查单 403）')
  eq(stored?.planId, '', '回跳单没有套餐信息 → planId 空串')
  eq(stored?.startedAt, 1763000000000, '存档时间用注入的 now（续查窗口按它算）')

  // 落盘失败（隐私模式 / 存储满）也不能挡住查单
  const broken = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('quota')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }
  const win2 = fakeWindow(`/?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`)
  eq(
    consumeOrderReturn(win2, { storage: broken }),
    { outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN, replacedUnpaidOrder: false },
    '存储不可用时仍返回回跳参数（本次查单照跑）'
  )
  eq(win2.replaced[0], '/', '没有其它参数时地址栏回到 pathname')
}

// ------------------------------------------- [4b] replacedUnpaidOrder（Issue #157）
// 语义（见 src/services/ours/returnParams.ts:70-85 与 orderStore.ts:13）：
//   网页版付款回跳时单号只能靠 ?no=&order_token= 带回来，所以**覆盖存档就发生在
//   consumeOrderReturn 里**。只有下面三条同时成立，replacedUnpaidOrder 才为 true：
//     (1) 旧存档确实存在（readStoredOrder 认得）
//     (2) 旧存档的单号与本次回跳不同（同单号 = 刷新/重复回跳，什么都没被覆盖）
//     (3) 旧存档 startedAt 距今 ≤ ORDER_RESUME_MAX_AGE_MS（30 分钟，闭区间）
//   即「上一笔还没完成的订单被这一单顶掉了」，界面据此提示「上一笔未支付订单已失效」。
//   「未完成」没有独立标记，30 分钟窗口就是唯一判据（订单本身 15 分钟就过期）。
//   注意：单号不同但旧存档很老（>30 分钟）时是 false —— 那种旧单早已不在续查窗口内，
//   再提示「上一笔失效」会误导用户。
console.log('\n[4b] replacedUnpaidOrder：只有覆盖 30 分钟内的另一笔存档才是 true')
{
  const NOW = 1763000000000
  const OLD_OUT_TRADE_NO = 'CP2026111816090000AAAAAAAA'
  /** 先塞一份「上一笔」存档，模拟上一次下单/回跳留下的痕迹 */
  const seed = (storage, outTradeNo, startedAt) =>
    writeStoredOrder({ outTradeNo, orderToken: 'old-order-token', planId: 'p1', startedAt }, storage)
  const consume = (storage) =>
    consumeOrderReturn(fakeWindow(`/?no=${OUT_TRADE_NO}&order_token=${ORDER_TOKEN}`), {
      now: () => NOW,
      storage,
    })

  // 1) 窗口内 + 单号不同 → 真的覆盖了一笔未支付订单
  {
    const storage = fakeStorage()
    seed(storage, OLD_OUT_TRADE_NO, NOW - 60 * 1000)
    eq(
      consume(storage),
      { outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN, replacedUnpaidOrder: true },
      '一分钟前的旧单被覆盖 → true（完整返回形状）'
    )
    eq(readStoredOrder(storage)?.outTradeNo, OUT_TRADE_NO, '存档换成新单号（旧单不再续查）')
    eq(readStoredOrder(storage)?.orderToken, ORDER_TOKEN, '存档里的令牌也换成新单的')
    eq(readStoredOrder(storage)?.startedAt, NOW, '存档时间换成这次回跳的时间')
    eq(readStoredOrder(storage)?.planId, '', '回跳单没有套餐信息 → planId 空串')
  }

  // 2) 恰好卡在窗口边界：实现是 `<=`（闭区间），仍算被覆盖
  {
    const storage = fakeStorage()
    seed(storage, OLD_OUT_TRADE_NO, NOW - ORDER_RESUME_MAX_AGE_MS)
    eq(consume(storage)?.replacedUnpaidOrder, true, '旧存档恰好 30 分钟 → 仍为 true（闭区间）')
  }

  // 3) 超过窗口 1ms：旧单早就不自动续查了，不该再提示「上一笔失效」
  {
    const storage = fakeStorage()
    seed(storage, OLD_OUT_TRADE_NO, NOW - ORDER_RESUME_MAX_AGE_MS - 1)
    eq(consume(storage)?.replacedUnpaidOrder, false, '旧存档超过 30 分钟 → false')
  }

  // 4) 单号相同（付款页刷新 / 重复回跳同一单）→ 没有覆盖任何东西
  {
    const storage = fakeStorage()
    seed(storage, OUT_TRADE_NO, NOW - 60 * 1000)
    eq(consume(storage)?.replacedUnpaidOrder, false, '单号相同（重复回跳）→ false')
  }

  // 5) 没有旧存档（第一次下单就付款回来）→ false
  {
    const storage = fakeStorage()
    eq(consume(storage)?.replacedUnpaidOrder, false, '首次回跳、没有旧存档 → false')
  }
}

console.log('\n[5] 没有回跳参数：不查单、不动地址栏、不写存档')
{
  const win = fakeWindow('/?plan=p1')
  const storage = fakeStorage()
  eq(consumeOrderReturn(win, { storage }), null, '返回 null（不进入订单查询）')
  eq(win.replaced, [], '不调用 replaceState')
  eq(storage.data.size, 0, '不写存档')

  const winOnlyNo = fakeWindow(`/?no=${OUT_TRADE_NO}`)
  eq(consumeOrderReturn(winOnlyNo, { storage }), null, '缺 order_token 时同样不查单')
  eq(winOnlyNo.replaced, [], '缺令牌时也不动地址栏')
}

// ---------------------------------------------------------------- [6] 存档
console.log('\n[6] orderStore / stripOrderReturn')
{
  const storage = fakeStorage()
  eq(readStoredOrder(storage), null, '没有存档时返回 null')
  writeStoredOrder({ outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN, planId: 'p1', startedAt: 1 }, storage)
  eq(readStoredOrder(storage)?.planId, 'p1', '写入后可读回')
  writeStoredOrder(null, storage)
  eq(readStoredOrder(storage), null, '写 null 即删除存档')

  storage.setItem(ORDER_STORAGE_KEY, '{oops')
  eq(readStoredOrder(storage), null, '坏 JSON 当作没有存档')
  storage.setItem(ORDER_STORAGE_KEY, JSON.stringify({ outTradeNo: OUT_TRADE_NO }))
  eq(readStoredOrder(storage), null, '缺 order_token 的存档不认（查单必 403）')
  writeStoredOrder({ outTradeNo: OUT_TRADE_NO, orderToken: ORDER_TOKEN, planId: 'p1', startedAt: 1 }, null)
  ok('storage 为 null 时写入不抛')

  eq(
    stripOrderReturn({ search: `?no=1&order_token=2&plan=p1`, pathname: '/', hash: '' }),
    '/?plan=p1',
    'stripOrderReturn 只删三个回跳键'
  )
  eq(
    stripOrderReturn({ search: '', pathname: '/x', hash: '#y' }),
    '/x#y',
    '没有查询串时保留 pathname + hash'
  )
  eq([...ORDER_RETURN_KEYS], ['no', 'out_trade_no', 'order_token'], '回跳键名单（no 与 out_trade_no 同义）')
}

// ---------------------------------------------------------------- [7] 源码防回归
// 「网页版不能再 fetch 读 302」这件事在浏览器里由 tests/integration/ours-webpay.test.mjs 实测
// （document 顶层导航 1 次、fetch/xhr 0 次）。这里补一条源码断言，防止以后又把它改回 fetch。
console.log('\n[7] 源码防回归：网页版购买只有一个出口（window.location.assign）')
{
  const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')
  const transport = source('../../src/services/ours/transport.ts')
  const dialog = source('../../src/components/settings/OursServicesDialog.tsx')
  // Issue #115：顶层导航前必须补 cid —— 不带 cid 的 /buy 建出来的单不知道属于谁，
  // 付完款 App 只能一直显示「等待支付」（就是这次事故）。所以这里断言两件事：
  // 导航只发生在 withBuyCustomerId 放行之后的地址上，且仍然只有 window.location.assign 一个出口。
  truthy(
    /export const navigateTopLevel = \(url: string\): void => \{\s*const ready = withBuyCustomerId\(url, readCachedCustomerId\(\)\)/u.test(
      transport
    ),
    'navigateTopLevel 先补 cid 再导航（withBuyCustomerId + 已知 cid 走同步分支）'
  )
  truthy(
    /if \(ready !== null\) \{\s*window\.location\.assign\(ready\)/u.test(transport),
    'navigateTopLevel 的同步分支就是 window.location.assign(补过 cid 的地址)'
  )
  truthy(
    !/window\.location\.assign\(url\)/u.test(transport),
    '不再出现 window.location.assign(url)：原样跳转（可能不带 cid）的写法被禁止'
  )
  truthy(
    dialog.includes('navigateTopLevel(buyUrl(planId))'),
    '「去支付」的网页版分支调用 navigateTopLevel(buyUrl(planId))'
  )
  // 只看「去支付」这一段：组件别处还有 fetchPlans / fetchInviteProfile 这类请求
  const buyStart = dialog.indexOf('const buy = async () => {')
  const buyBody = buyStart === -1 ? '' : dialog.slice(buyStart, dialog.indexOf('\n  }', buyStart) + 4)
  truthy(buyBody !== '', '定位到「去支付」的实现（buy）')
  truthy(!/fetch\(/u.test(buyBody), '「去支付」里没有 fetch(（网页版不再自己发请求读 302）')
  truthy(!buyBody.includes("redirect: 'manual'"), '「去支付」里没有 redirect: manual（读不到 Location 的写法）')
  truthy(
    !/startCheckout\(/u.test(buyBody.slice(0, buyBody.indexOf('if (!isNativePlatform()) {'))),
    '网页版分支在 startCheckout 之前就返回（原生那条路径没被动到）'
  )
  truthy(
    !dialog.includes('oursBuyWebUnsupported'),
    '「网页版拿不到收银台地址 → 请在 App 内购买」的旧提示已删除'
  )
}

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败（共 ${checks.n} 项检查）`)
  for (const failure of failures) {
    console.error(`  - ${failure}`)
  }
  process.exit(1)
}
console.log(`✓ 全部通过（${checks.n} 项检查）`)

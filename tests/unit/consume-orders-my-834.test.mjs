// [layer: unit | 依赖: 无（纯 Node + renderToStaticMarkup + 假 transport，零浏览器、零真实网络） | 耗时: <1s]
//
// Issue #834 ——「我的卡密」的数据源换成 `GET /api/v1/payment/orders/my`，并连带把**自动兑现**的
// 数据源一起换掉（旧接口 apia `GET /api/orders` 在账号迁移后恒 401，自动兑现静默失效）。
//
// 为什么补这一份：新契约的三条口径全是「数据怎么解释」，一条断言都没有的话，任何改动都能
// 悄悄把列表弄成空白或把卡号泄露出去：
//
//   ① **信封解析**：`data.items[] / total / page / page_size / pages` 五个字段落地；
//   ② **缺字段容错（#209 能力探测）**：`recharge_code` / `paid_at` 缺了不报错、不产生 NaN，
//      条目结构坏掉只丢那一条（不整页红），根不是对象才算「响应异常」；
//   ③ **非 COMPLETED 不带卡号**：卡号只属于已完成订单 —— 服务端只在 COMPLETED 才给
//      `recharge_code`，客户端这边也不许别的状态带卡号（否则既会把没付钱的卡铺到列表上，
//      也会让自动兑现去兑一张未完成的单）；
//   ④ **数据源只走 consume 层**：`listMyOrders()` 打的就是
//      `GET /api/v1/payment/orders/my?page&page_size`，带的是登录态 JWT，且列表与自动兑现
//      **都不再碰** `fetchPurchases` / `/api/orders`；
//   ⑤ **390 / 360 两档 markup**：有卡号的订单显示掩码卡号（复制仍取**完整**卡号）、
//      没有卡号的订单**没有卡号节点也没有复制按钮**，且不长出新 CSS（不引入 flex `gap` 依赖，#173）。
//
// 被测的是真代码：`src/services/consume/orders.ts`（解析 + 拉取）与
// `src/components/consume/myCardsListView.ts`（渲染，`.ts` 才能裸 Node `renderToStaticMarkup`）。
//
//   node --test tests/unit/consume-orders-my-834.test.mjs
//   node tests/run-layer.mjs unit --only consume-orders-my-834
import '../helpers/injected.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { createElement } from 'react'

import { installChatBridge, installEndpointsGlobals, installTsResolve, ROOT, setupDom } from '../helpers/dom-env.mjs'
import { jsonReply, panelOk, pathOf, recordingTransport } from '../helpers/consume-fixtures.mjs'

// 原生桥（`@capacitor/core`）+ 诊断写入口替身 + 构建期注入值（`__ENDPOINTS__.consume`）
installChatBridge()
installEndpointsGlobals()
installTsResolve()
// localStorage / window：视图本身不碰它们，但 `panels.ts` → 诊断链会在装载时摸一下
const dom = setupDom()
test.after(() => dom.restore())

const { renderToStaticMarkup } = await import('react-dom/server')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const orders = await import('../../src/services/consume/orders.ts')
const listView = await import('../../src/components/consume/myCardsListView.ts')
const { createConsumeHttp } = await import('../../src/services/consume/http.ts')

/** 登录态 JWT（一眼假；只用来断言请求确实带着凭据） */
const JWT = 'jwt-834-not-real'
/** 服务端发的**完整**卡号（真实形态：带分隔符的大写串，尾 4 位 A3SR） */
const CARD = 'MUSE-3CYP-5NA3-AHSE-A3SR'
const CARD_MASKED = '••••A3SR'
/** 新接口的端点（断言用；`pathOf` 会剥掉 host 与环境前缀 `/staging`） */
const ORDERS_MY = '/api/v1/payment/orders/my'

/**
 * 一条**服务端真实形状**的订单（snake_case，2026-11-22 staging 实测字段）：
 * 解析函数与视图都从它出发 —— 字段名一旦被改，用例当场红，而不是对着一份平行真理断言。
 */
const serverOrder = (over = {}) => ({
  out_trade_no: 'CP20261119103910EAF8D09A',
  status: 'COMPLETED',
  amount: 5,
  pay_amount: 4.9,
  payment_type: 'legacy_cardpay',
  recharge_code: CARD,
  created_at: '2026-11-19T10:39:10+08:00',
  paid_at: '2026-11-19T10:39:30+08:00',
  ...over,
})

const secondsOf = (iso) => Math.floor(Date.parse(iso) / 1000)

// ────────────────────────────────────────────────── ① 信封解析

test('① 信封解析：items / total / page / page_size / pages 五个字段都落到解析结果上', () => {
  const page = orders.parseMyOrdersPage({
    items: [serverOrder(), serverOrder({ out_trade_no: 'CP-SECOND', status: 'PENDING', recharge_code: '' })],
    total: 2,
    page: 1,
    page_size: 20,
    pages: 1,
  })

  assert.notEqual(page, null, '合法信封必须解析出来')
  assert.deepEqual(Object.keys(page).sort(), ['items', 'page', 'pageSize', 'pages', 'total'], '解析结果的字段集合就是契约那五个')
  assert.equal(page.page, 1)
  assert.equal(page.pageSize, 20)
  assert.equal(page.pages, 1)
  assert.equal(page.total, 2, '`total` 用服务端给的，不是「这一页有几条」')
  assert.equal(page.items.length, 2)

  assert.deepEqual(page.items[0], {
    outTradeNo: 'CP20261119103910EAF8D09A',
    status: 'COMPLETED',
    amountYuan: 5,
    payAmountYuan: 4.9,
    createdAt: secondsOf('2026-11-19T10:39:10+08:00'),
    paidAt: secondsOf('2026-11-19T10:39:30+08:00'),
    paymentType: 'legacy_cardpay',
    rechargeCode: CARD,
  }, '逐字段对照服务端 snake_case：out_trade_no / amount / pay_amount / created_at / paid_at / payment_type / recharge_code')
})

// ────────────────────────────────────────────────── ② 缺字段容错（#209）

test('② 缺字段容错：items / total / 分页 / 单条结构坏掉都不报错，也不产生 NaN', () => {
  // 根不是对象：连结构都不对 → null（调用方按「响应异常」报错）
  assert.equal(orders.parseMyOrdersPage(null), null)
  assert.equal(orders.parseMyOrdersPage('nope'), null)
  assert.equal(orders.parseMyOrdersPage([serverOrder()]), null, '数组不是信封')

  // items 不是数组 → 空列表（不是整页报错）
  assert.deepEqual(orders.parseMyOrdersPage({ total: 0 }).items, [])
  assert.deepEqual(orders.parseMyOrdersPage({ items: 'nope' }).items, [])

  // total 缺失/非法 → 退化成这一页的条数；pages 缺失 → 按 total/pageSize 算
  const fallbackTotal = orders.parseMyOrdersPage({ items: [serverOrder()] }, { page: 2, pageSize: 10 })
  assert.equal(fallbackTotal.total, 1, '`total` 缺失 → 用这一页的条数（不会凭空说「还有下一页」）')
  assert.equal(fallbackTotal.page, 2, '`page` 缺失 → 用请求时的分页')
  assert.equal(fallbackTotal.pageSize, 10)
  assert.equal(fallbackTotal.pages, 1)

  // 分页字段非法 → 夹回合法区间（0 / 负数 / 字符串都不许变成 NaN）
  const clamped = orders.parseMyOrdersPage({ items: [], total: 0, page: -3, page_size: 'abc', pages: 0 })
  assert.equal(clamped.page, 1)
  assert.equal(clamped.pageSize, 20)
  assert.equal(clamped.pages, 1)
  assert.equal(orders.MY_ORDERS_MAX_PAGE_SIZE, 100, '每页上限有常量（与其它分页接口同一口径）')
  assert.equal(orders.parseMyOrdersPage({ items: [], total: 0, page_size: 999 }).pageSize, 100, '超上限夹到 100')

  // 单条：非对象条目丢掉，其余照解析
  const mixed = orders.parseMyOrdersPage({
    items: [null, 'nope', 42, {}, serverOrder({ amount: 'not-a-number', total_xx: 1 })],
    total: 2,
  })
  assert.equal(mixed.items.length, 2, '只有真正的对象留下（`{}` 也算一条：缺字段是容错，不是丢弃）')

  const empty = mixed.items[0]
  assert.equal(empty.outTradeNo, '', '缺 out_trade_no → 空串（保留这条记录）')
  assert.equal(empty.status, '', '缺 status → 空串（界面按「状态未知」显示）')
  assert.equal(empty.amountYuan, 0, '缺 amount → 0（不是 NaN）')
  assert.equal(empty.payAmountYuan, 0)
  assert.equal(empty.createdAt, 0)
  assert.equal(empty.paidAt, null, '缺 paid_at → null（只有「没付款」才是 null）')
  assert.equal(empty.rechargeCode, null, '缺 recharge_code → null（非 COMPLETED 的正常形态，不报错）')

  const numberString = mixed.items[1]
  assert.equal(numberString.amountYuan, 0, 'amount 给了非数字串 → 0（不产生 NaN）')
  assert.equal(orders.parseMyOrder(serverOrder({ amount: '5.5' })).amountYuan, 5.5, '纯数字串认（老版本后端会这么给）')
  assert.equal(orders.parseMyOrder(serverOrder({ paid_at: null })).paidAt, null, '`paid_at: null` 不报错')
  assert.equal(orders.parseMyOrder(serverOrder({ created_at: 'not-a-date' })).createdAt, 0, '时间认不出来 → 0')
})

// ────────────────────────────────────────────────── ③ 非 COMPLETED 不带卡号

test('③ 非 COMPLETED 不带卡号：只有 COMPLETED 才保留 recharge_code（其余状态即便服务端给了也丢掉）', () => {
  const completed = orders.parseMyOrder(serverOrder())
  assert.equal(completed.rechargeCode, CARD, '已完成订单带完整卡号（不打码；打码是展示层的事）')
  assert.equal(orders.rechargeCodeOf(completed), CARD, '`rechargeCodeOf` 交出的就是服务端那份原值')

  for (const status of ['PENDING', 'EXPIRED', 'CANCELLED', 'FAILED', 'REFUNDED', '']) {
    const other = orders.parseMyOrder(serverOrder({ status }))
    assert.equal(
      other.rechargeCode,
      null,
      `status=${JSON.stringify(status)} 的订单不许带卡号（卡号只属于已完成订单；未付款的卡不该被展示/自动兑）`
    )
    assert.equal(orders.rechargeCodeOf(other), '', '拿卡号的地方一律得到空串，调用方不必再判 null')
    assert.equal(orders.isCompletedOrder(other), false, '`isCompletedOrder` 也认这个状态为「未完成」')
  }

  // 大小写：服务端给的是大写枚举，但判定不做大小写假设
  assert.equal(orders.parseMyOrder(serverOrder({ status: 'completed' })).rechargeCode, CARD)
  assert.equal(orders.MY_ORDER_COMPLETED, 'COMPLETED', '判定用的状态字就是契约里的那个（写死在常量里，别处不许再抄）')
})

// ────────────────────────────────────────────────── ④ 走 consume 层（端点 + JWT）

test('④ 数据源只走 consume 层：GET /api/v1/payment/orders/my + JWT，2xx 信封不对算失败', async () => {
  const seen = recordingTransport(() =>
    panelOk({ items: [serverOrder()], total: 1, page: 1, page_size: 20, pages: 1 })
  )
  const http = createConsumeHttp({ accessToken: () => JWT, transport: seen.transport })
  const result = await orders.listMyOrders(http, { page: 1, pageSize: 20 })

  assert.equal(result.ok, true, '面板信封 `{code:0,data}` 应被解开')
  assert.equal(result.data.items.length, 1)
  assert.equal(result.data.items[0].outTradeNo, 'CP20261119103910EAF8D09A')
  assert.deepEqual(seen.sequence(), ['GET /api/v1/payment/orders/my'], '只打这一发，没有第二条链路')
  assert.equal(pathOf(seen.calls[0].url), `${ORDERS_MY}?page=1&page_size=20`, '查询串就是 page / page_size')
  assert.ok(String(seen.calls[0].headers.authorization).includes(JWT), '带的是登录态 JWT（不是 sk- Key）')
  assert.equal(seen.calls[0].url.includes('key'), false, 'JWT 不进 query（只进 Authorization 头）')

  // 2xx 但信封不是分页对象 → 不能当「空列表」（否则界面显示「没有记录」而不是「响应异常」）
  const bad = recordingTransport(() => panelOk('nope'))
  const badHttp = createConsumeHttp({ accessToken: () => JWT, transport: bad.transport })
  const badResult = await orders.listMyOrders(badHttp)
  assert.equal(badResult.ok, false, '结构不对就是失败')
  assert.equal(badResult.error.i18nKey, 'consumeErrInvalidResponse', '文案 key 由消费层给，界面不另编一句')
  assert.equal(badResult.error.retryable, false, '结构不对重试也一样 → 不给重试按钮')

  // 401（未登录 / 会话过期）：归一成 auth 错误，界面据此给登录出口
  const unauthorized = recordingTransport(() =>
    jsonReply(401, { code: 401, message: 'User not authenticated', reason: 'UNAUTHORIZED' })
  )
  const unauthHttp = createConsumeHttp({ accessToken: () => '', transport: unauthorized.transport })
  const unauthResult = await orders.listMyOrders(unauthHttp)
  assert.equal(unauthResult.ok, false)
  assert.equal(unauthResult.error.kind, 'auth', '401 → auth（不是网络错误）')
  assert.equal(unauthResult.error.status, 401)
})

// ────────────────────────────────────────────────── ⑤ 390 / 360 markup

/** 与 `i18n/index.ts` 同一套占位符规则（不 import 那份带 zustand 的实现） */
const t = (key, params) => {
  const text = zh[key]
  assert.equal(typeof text, 'string', `文案表里没有键 ${String(key)}`)
  return text.replace(/\{(\w+)\}/gu, (whole, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : whole
  })
}

/** CSS Module 类名替身：断言的是「用的是哪个类」，不是打包后的哈希名 */
const c = new Proxy({}, { get: (_target, name) => String(name) })

/**
 * 设计系统按钮的替身：`testId` → `data-testid`，并把 props 收进 `seen` —— 这样
 * 「复制按钮交出去的是完整卡号」可以**真的按下去**断言，而不是读源码猜。
 */
const renderWithClicks = (props) => {
  const seen = []
  const Button = (buttonProps) => {
    seen.push(buttonProps)
    return createElement(
      'button',
      { type: 'button', 'data-testid': buttonProps.testId, disabled: buttonProps.disabled === true },
      buttonProps.children
    )
  }
  const markup = renderToStaticMarkup(
    createElement(listView.CardsListView, { t, c, Button, ...props })
  )
  return { markup, seen }
}

const countOfText = (haystack, needle) => haystack.split(needle).length - 1

test('⑤ 390 / 360 markup：有卡号显示掩码 + 复制取完整；无卡号没有卡号节点也不报错', () => {
  const withCode = orders.parseMyOrder(serverOrder())
  const withoutCode = orders.parseMyOrder(serverOrder({ out_trade_no: 'CP-PENDING-0002', status: 'PENDING', recharge_code: '' }))

  // 两档（仓库的既有验收宽度）：markup 与宽度无关，但两档都要过一遍才是「窄屏也这样」
  for (const width of [390, 360]) {
    const copied = []
    const used = []
    const { markup, seen } = renderWithClicks({
      orders: [withCode, withoutCode],
      busy: false,
      onCopy: (code) => copied.push(code),
      onRedeem: (code) => used.push(code),
    })

    assert.equal(countOfText(markup, 'data-testid="account-consume-card-row"'), 2, `${width}：两条订单两条行（没有卡号的那条也在）`)
    assert.equal(countOfText(markup, 'data-testid="account-consume-card-no"'), 1, `${width}：只有有卡号的那条渲染卡号节点`)
    assert.ok(markup.includes(CARD_MASKED), `${width}：卡号按后 4 位展示（••••A3SR）`)
    assert.equal(markup.includes(CARD), false, `${width}：完整卡号不进 DOM 文本`)
    assert.ok(markup.includes('已完成'), `${width}：COMPLETED 的文案由界面按 status 映射（不依赖 status_text）`)
    assert.ok(markup.includes('待支付'), `${width}：PENDING 也有自己的文案`)
    assert.ok(markup.includes('¥5.00'), `${width}：到账额度按元显示`)
    assert.ok(markup.includes('2026-11-19 10:39'), `${width}：时间来自 created_at`)

    // 「没有 recharge_code 的订单不显示卡号、不报错」：没有卡号节点、也没有复制按钮
    assert.equal(countOfText(markup, 'data-testid="account-consume-card-copy"'), 1, `${width}：无卡号的订单没有复制按钮（复制空串是假动作）`)
    assert.equal(countOfText(markup, 'data-testid="account-consume-card-redeem"'), 1, `${width}：无卡号的订单也没有「去兑换」`)

    // 复制按钮交出去的是**完整**卡号（用户要的就是能粘到别处的那串）
    const copyButton = seen.find((button) => button.testId === 'account-consume-card-copy')
    assert.notEqual(copyButton, undefined, `${width}：复制按钮真的渲染了`)
    copyButton.onClick()
    assert.deepEqual(copied, [CARD], `${width}：复制取完整卡号（不是掩码）`)

    // 「去兑换」只把卡号填进输入框（由容器做），这里断言它交出去的也是完整卡号
    seen.find((button) => button.testId === 'account-consume-card-redeem').onClick()
    assert.deepEqual(used, [CARD])
  }

  // 全是「没有卡号」的订单：渲染不抛、没有卡号节点、也没有任何按钮（空列表由容器的空态负责）
  const onlyMissing = renderWithClicks({ orders: [withoutCode], busy: false, onCopy: () => {}, onRedeem: () => {} })
  assert.equal(countOfText(onlyMissing.markup, 'data-testid="account-consume-card-no"'), 0, '一条都没有卡号时：一个卡号节点都不渲染')
  assert.equal(onlyMissing.seen.length, 0, '没有卡号就没有按钮（不报错、也不给假动作）')
  assert.ok(onlyMissing.markup.includes('待支付'))

  // busy（兑换请求在飞）→ 「去兑换」禁用，防止第二个 POST
  const busyRender = renderWithClicks({ orders: [withCode], busy: true, onCopy: () => {}, onRedeem: () => {} })
  assert.ok(
    busyRender.seen.find((button) => button.testId === 'account-consume-card-redeem').disabled === true,
    'busy 时「去兑换」禁用（兑换没有幂等键）'
  )

  // 窄屏不靠新 CSS：视图只用既有的那批类名，`.tail` 允许断行、`.itemTop` 允许折行（360 也不横向溢出）
  const css = readFileSync(path.join(ROOT, 'src/components/consume/AccountConsume.module.css'), 'utf8')
  const viewSource = readFileSync(path.join(ROOT, 'src/components/consume/myCardsListView.ts'), 'utf8')
  const usedClasses = [...viewSource.matchAll(/\bc\.([A-Za-z0-9_]+)/gu)].map((match) => match[1])
  assert.ok(usedClasses.length >= 5, `视图确实在用类名表（实际 ${usedClasses.length} 处）`)
  for (const name of new Set(usedClasses)) {
    assert.ok(new RegExp(`\\.${name}\\s*\\{`, 'u').test(css), `类名 \`.${name}\` 必须已存在于 AccountConsume.module.css（不新增 CSS，也就不新增 gap 依赖 #173）`)
  }
  assert.match(css, /\.tail\s*\{[^}]*overflow-wrap:\s*anywhere/u, '卡号允许断行（360 窄屏不会被撑出横向滚动）')
  assert.match(css, /\.itemTop\s*\{[^}]*flex-wrap:\s*wrap/u, '行首两栏放不下就折行')
})

// ────────────────────────────────────────────────── ⑥ 状态文案 zh/en 成对

test('⑥ 状态文案：status → i18n key 的映射 zh/en 成对，未知状态有单独一句（绝不当成「已完成」）', () => {
  for (const [status, key] of Object.entries(listView.ORDER_STATUS_KEYS)) {
    assert.equal(typeof zh[key], 'string', `status=${status} 的中文文案存在（${String(key)}）`)
    assert.equal(typeof en[key], 'string', `status=${status} 的英文文案存在（${String(key)}）`)
    assert.equal(listView.orderStatusKeyOf(status), key, `${status} → ${key}`)
    assert.equal(listView.orderStatusKeyOf(` ${status.toLowerCase()} `), key, '大小写 / 空格无关')
  }
  assert.equal(listView.orderStatusKeyOf('SOMETHING_NEW'), listView.ORDER_STATUS_UNKNOWN_KEY, '认不出的状态落到「状态未知」')
  assert.notEqual(listView.ORDER_STATUS_UNKNOWN_KEY, listView.ORDER_STATUS_KEYS.COMPLETED, '未知状态**不是**「已完成」（不能白送一个已完成）')
  assert.equal(typeof zh[listView.ORDER_STATUS_UNKNOWN_KEY], 'string')
  assert.equal(typeof en[listView.ORDER_STATUS_UNKNOWN_KEY], 'string')
})

// ────────────────────────────────────────────────── ⑦ 接线：旧路径不再被列表与自动兑现使用

/** 仓库内源码（`.tsx` 裸 Node import 不了，接线只能读源码断言） */
const sourceOf = (file) => readFileSync(path.join(ROOT, file), 'utf8')

/**
 * 去掉整行注释与块注释：**注释里提到旧名字不算接线**（否则写一句「这里不再用 fetchPurchases」
 * 就会假红），反之注释里承诺了什么也不算代码。
 */
const stripComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')

const codeOf = (file) => stripComments(sourceOf(file))

const MY_CARDS_TAB = 'src/components/consume/MyCardsTab.tsx'
const PAGE = 'src/components/consume/AccountConsumePage.tsx'
const AUTO_REDEEM = 'src/components/consume/walletAutoRedeem.ts'
const LIST_VIEW = 'src/components/consume/myCardsListView.ts'

test('⑦ 接线：列表与自动兑现都走 `consume.orders.my()`，两处都不再出现 fetchPurchases / /api/orders', () => {
  const cards = codeOf(MY_CARDS_TAB)
  assert.ok(cards.includes('consume.orders.my('), '「我的卡密」的数据源 = consume 层的新接口')
  assert.equal(cards.includes('fetchPurchases'), false, '不再 import 旧的 fetchPurchases（apia /api/orders）')
  assert.equal(cards.includes('/api/orders'), false, '不再出现旧端点字面量')
  assert.ok(cards.includes("from './myCardsListView.js'"), '列表渲染走可测的 `.ts` 视图')
  assert.ok(cards.includes('afterRedeemed'), '兑换成功后重拉 /user/profile 的行为不变')
  assert.ok(cards.includes('void loadOrders()'), '兑换成功后重拉列表的行为不变（afterRedeemed → loadOrders）')

  const page = codeOf(PAGE)
  assert.ok(page.includes('consume.orders.my('), '自动兑现的订单来源也是新接口（#834 的连带修复）')
  assert.equal(page.includes('fetchPurchases'), false, '付款回来那条链路不再打旧接口')
  assert.equal(page.includes('loadOrders'), true, '注入点还在（没有会话就不注入 → 一个请求都不发）')

  const auto = codeOf(AUTO_REDEEM)
  assert.ok(auto.includes("from '../../services/consume/orders.js'"), '自动兑现读的是新契约的类型与判定')
  assert.equal(auto.includes('fetchPurchases'), false, '自动兑现内不再有旧数据源')
  assert.equal(auto.includes('redeemState'), false, '不再依赖「卡是否已兑换」这个旧字段（新接口没有）')
  assert.equal(auto.includes('.cardNo'), false, '不再读旧契约的 `cardNo` 字段（新字段是 recharge_code → rechargeCode）')
  assert.ok(auto.includes('redeem.history('), '已兑过就跳过：靠既有 getRedeemHistory 交叉比对（#834 边界的做法）')

  // 全仓：「我的卡密」/ 自动兑现那条链上没有任何一处还引用 apia 的订单模块
  for (const file of [MY_CARDS_TAB, PAGE, AUTO_REDEEM, LIST_VIEW]) {
    assert.equal(codeOf(file).includes('ours/purchases'), false, `${file} 不该再碰 ours/purchases`)
  }
})

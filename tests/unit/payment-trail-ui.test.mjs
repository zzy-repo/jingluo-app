// [layer: unit | 依赖: 无（纯 Node，renderToStaticMarkup） | Issue #189]
//
// 回归对象：支付记录时间线展示层 `src/components/settings/PaymentTrailView.ts`（`.ts` 才能被 Node 直接 import）。
//
// 为什么测「.ts 视图模块」而不是 .tsx：#158 的教训 —— `.tsx` 进不了 Node 测试，
// 一测就得开浏览器，最后只能靠肉眼截图。这里把展示逻辑放进 `.ts`（createElement），
// `.tsx` 只剩容器与 CSS Module，测试直接渲染**生产同一份代码**。
//
// 验收要的五种状态、空态、请求失败、长列表滚动、渠道门禁，都在这里盯住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerHooks } from 'node:module'

// Capacitor 替身 + `.js` → `.ts` 解析（视图模块的类型来自数据层，数据层会 import transport.ts）
const capacitorStub = `data:text/javascript,${encodeURIComponent(`
export const Capacitor = { isNativePlatform: () => false }
export const CapacitorHttp = {
  request: () => {
    throw new Error('单测不应该走原生桥')
  },
}
export const registerPlugin = () => ({
  open: async () => ({}),
  resolveLocation: async () => ({}),
})
`)}`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@capacitor/core') {
      return { url: capacitorStub, shortCircuit: true }
    }
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

const { parseTrailOrder } = await import('../../src/services/ours/trail.ts')

const {
  PAYMENT_TRAIL_PAGE_SIZE,
  TRAIL_POLL_INTERVAL_MS,
  TRAIL_POLL_MAX_MS,
  PaymentTrailView,
  CardTrailPanel,
  describeTrailError,
  formatTrailTime,
  loadTrailPage,
  maskTrailCard,
  shouldKeepPolling,
  shouldShowPaymentTrail,
  trailEventText,
} = await import('../../src/components/settings/PaymentTrailView.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const fixtures = await import('../fixtures/domain06-07/ours-trail.mjs')

/** 与 i18n/index.ts 的 createTranslate 同一套占位符规则（测试里不 import 那份带 zustand 的实现） */
const makeTranslate = (table) => (key, params) => {
  const text = table[key]
  assert.equal(typeof text, 'string', `文案表里没有键 ${String(key)}`)
  return text.replace(/\{(\w+)\}/g, (placeholder, name) => {
    const value = params?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : placeholder
  })
}

const t = makeTranslate(zh)

/** 设计系统 Button 的替身：把 testId 变成 data-testid，其余属性原样透出 */
const Btn = ({ testId, children, onClick, ...rest }) =>
  createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

const baseProps = (overrides = {}) => ({
  t,
  classNames: {},
  button: Btn,
  view: { status: 'ok', page: null },
  ...overrides,
})

const render = (props) => renderToStaticMarkup(PaymentTrailView(props))

/** 渲染并收集所有 data-testid（次数 + 属性），避免在字符串上做正则猜结构 */
const scan = (markup) => {
  const found = []
  for (const match of markup.matchAll(/data-testid="([^"]+)"/gu)) {
    found.push(match[1])
  }
  const count = (testId) => found.filter((item) => item === testId).length
  return { found, count }
}

const pageOf = (orders, extra = {}) => ({
  customerId: fixtures.TRAIL_CUSTOMER_ID,
  total: orders.length,
  limit: 20,
  offset: 0,
  totalPaidYuan: 72.7,
  orders,
  ...extra,
})

/** 夹具是**服务端原始 JSON**（snake_case）：视图只吃数据层解析后的形状，所以这里先过一遍真解析器 */
const parseAll = async () => fixtures.trailPage.orders.map((raw) => parseTrailOrder(raw))
const toOrders = (rawList) =>
  rawList.map((raw) => {
    const { outTradeNo } = { outTradeNo: raw.out_trade_no }
    return { raw, outTradeNo }
  })

/** 元素树遍历：静态 HTML 没有事件处理器，交互要回到元素树上直接调 onClick */
const collect = (node, testId, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, testId, out)
    return out
  }
  const props = node.props ?? {}
  if (props['data-testid'] === testId) out.push(node)
  const children = props.children
  if (children !== undefined) collect(children, testId, out)
  return out
}

// ------------------------------------------------------------------ 渠道门禁（#166 的教训：入口不能无条件渲染）

test('#189 入口只在自有渠道（ours）出现，别的渠道一条 DOM 都不留', () => {
  assert.equal(shouldShowPaymentTrail('ours'), true)
  for (const kind of ['deepseek', 'anthropic', 'openai', '', undefined, 'custom']) {
    assert.equal(shouldShowPaymentTrail(kind), false, `${String(kind)} 不该看到支付记录入口`)
  }
})

// ------------------------------------------------------------------ 时间 / 卡号

test('#189 时间按本地时区显示到分钟，无效值给占位符', () => {
  assert.match(formatTrailTime(fixtures.trailOrderCreated.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u)
  assert.equal(formatTrailTime(null), '—')
  assert.equal(formatTrailTime(0), '—')
  assert.equal(formatTrailTime(Number.NaN), '—')
})

test('#189 卡号只露后 4 位（时间线是分享 / 截图高频页面）', () => {
  assert.equal(maskTrailCard('MUSE-3CYP-5NA3-AHSE-A3SR'), '••••A3SR')
  assert.equal(maskTrailCard(''), '')
  assert.equal(maskTrailCard(null), '')
})

// ------------------------------------------------------------------ 五种状态

test('#189 五种状态各渲染一条，data-status 与色调分开（EXPIRED ≠ FAILED）', async () => {
  const orders = (await parseAll()).slice(0, 5)
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf(orders) } }))
  const { count } = scan(markup)
  assert.equal(count('trail-order'), 5)
  assert.equal(count('trail-status'), 5)
  for (const status of ['created', 'paid', 'fulfilled', 'expired', 'failed']) {
    assert.ok(markup.includes(`data-status="${status}"`), `缺少 ${status} 状态`)
  }
  assert.ok(markup.includes('data-tone="success"'), 'fulfilled 要绿色调')
  assert.ok(markup.includes('data-tone="pending"'), 'created / paid 要等待色调')
  assert.ok(markup.includes('data-tone="danger"'), 'failed 要危险色调')
  assert.ok(markup.includes('data-tone="muted"'), 'expired 要弱化色调，不能和失败同色')
  // 服务端给的中文状态直接展示
  assert.ok(markup.includes('待支付'))
  assert.ok(markup.includes('已关闭'))
})

test('#189 status_text 缺失时回落到 i18n 文案（不出现空标签，也不出现英文原文）', async () => {
  const markup = render(
    baseProps({
      view: {
        status: 'ok',
        page: pageOf([{ ...(await parseAll())[2], statusText: '' }]),
      },
    })
  )
  assert.ok(markup.includes(zh.oursTrailStatusFulfilled))
  assert.ok(!markup.includes('undefined'))
})

// ------------------------------------------------------------------ 时间线

test('#189 时间线一根轴串起全部事件：数量、时间、文案、节点都在', async () => {
  const orders = await parseAll()
  const fulfilled = orders[2]
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf([fulfilled]) } }))
  const { count } = scan(markup)
  assert.equal(count('trail-timeline'), 1)
  assert.equal(count('trail-event'), fulfilled.timeline.length)
  assert.equal(count('trail-event-time'), fulfilled.timeline.length)
  assert.equal(count('trail-event-dot'), fulfilled.timeline.length)
  assert.ok(markup.includes(zh.oursTrailEventCardRedeemed))
  // 已知事件一律走本地文案：服务端中文原文不能再漏到页面上（英文界面会中英混排）
  assert.ok(!markup.includes('已下单，等待支付'), 'order_created 是已知事件，应走 i18n')
  assert.ok(!markup.includes('卡密已兑换，积分到账'), 'card_redeemed 是已知事件，应走 i18n')
})

test('#189 长链路（9 个事件）一条不漏：长列表靠容器滚动，不是截断', async () => {
  const orders = await parseAll()
  const long = orders[5]
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf([long]) } }))
  const { count } = scan(markup)
  assert.equal(count('trail-event'), 9)
  assert.ok(markup.includes('data-event="late_paid_recovered"'))
  assert.ok(markup.includes('data-event="amount_reconciled"'))
})

test('#189 未知事件用服务端 text 兜底，不许凭空消失也不许显示原始 event 名', () => {
  const markup = render(
    baseProps({
      view: {
        status: 'ok',
        page: pageOf([
          {
            outTradeNo: 'CP1',
            planId: 'pro',
            amountYuan: 29.9,
            status: 'fulfilled',
            statusText: '已完成',
            createdAt: fixtures.trailOrderCreated.created_at,
            paidAt: null,
            expireAt: null,
            card: null,
            timeline: [
              { at: fixtures.trailOrderCreated.created_at, event: 'amount_reconciled', text: '对账完成，金额一致', detail: {}, backfilled: false },
              { at: null, event: 'brand_new_event', text: '', detail: {}, backfilled: false },
            ],
            nextStep: '',
          },
        ]),
      },
    })
  )
  assert.ok(markup.includes('对账完成，金额一致'), '未知事件必须展示服务端 text')
  assert.ok(!markup.includes('amount_reconciled<'), '不能把 event 原始名当文案给用户')
  assert.ok(markup.includes(zh.oursTrailEventUnknown), '连 text 都没有时给通用兜底文案')
})

test('#189 backfilled（历史补录）要标出来，否则用户会把估算时间当准点', async () => {
  const orders = await parseAll()
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf([orders[5]]) } }))
  assert.ok(markup.includes('data-backfilled="true"'))
  assert.ok(markup.includes(zh.oursTrailBackfilled))
})

test('#189 已支付未发卡：不显示卡密块，并提示「等几秒」', async () => {
  const orders = await parseAll()
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf([orders[1]]) } }))
  const { count } = scan(markup)
  assert.equal(count('trail-card'), 0)
  assert.ok(markup.includes(zh.oursTrailWaitingCard))
})

test('#189 已发卡：卡密块显示掩码卡号 / 积分 / 兑换状态，完整卡号不进 DOM', async () => {
  const orders = await parseAll()
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf([orders[2]]) } }))
  const { count } = scan(markup)
  assert.equal(count('trail-card'), 1)
  assert.ok(markup.includes('••••A3SR'), '卡号要掩码到后 4 位')
  assert.ok(!markup.includes('MUSE-3CYP-5NA3-AHSE-A3SR'), '完整卡号不允许出现在页面里')
  assert.ok(markup.includes('3,000'))
  assert.ok(markup.includes(zh.oursTrailCardRedeemed))
})

// ------------------------------------------------------------------ 超时关闭的可救回口径

test('#189 EXPIRED 不是「失败」：给下一步与一键复制单号，不给「失败了」的结论', async () => {
  const orders = await parseAll()
  const calls = []
  const tree = PaymentTrailView(
    baseProps({
      view: { status: 'ok', page: pageOf([orders[3]]) },
      onCopyOrderNo: (value) => calls.push(value),
      onRefresh: () => calls.push('refresh'),
    })
  )
  const markup = renderToStaticMarkup(tree)
  const { count } = scan(markup)
  assert.equal(count('trail-next-step'), 1)
  assert.ok(markup.includes(orders[3].nextStep))
  assert.ok(markup.includes(zh.oursTrailExpiredHint))
  assert.equal(count('trail-copy-order-no'), 1)
  assert.equal(count('trail-refresh'), 1)
  assert.ok(!markup.includes(zh.oursTrailStatusFailed), 'EXPIRED 不能显示成失败状态')
  const [copy] = collect(tree, 'trail-copy-order-no')
  copy.props.onClick()
  assert.deepEqual(calls, [orders[3].outTradeNo])
})

// ------------------------------------------------------------------ 空态 / 失败态

test('#189 空列表：显示「还没有记录」，不是错误也不是空白', () => {
  const markup = render(baseProps({ view: { status: 'ok', page: pageOf([]) } }))
  const { count } = scan(markup)
  assert.equal(count('trail-empty'), 1)
  assert.equal(count('trail-error'), 0)
  assert.ok(markup.includes(zh.oursTrailEmpty))
})

test('#189 加载中：显示进度文案，不闪空态', () => {
  const markup = render(baseProps({ view: { status: 'loading' } }))
  const { count } = scan(markup)
  assert.equal(count('trail-loading'), 1)
  assert.equal(count('trail-empty'), 0)
})

test('#189 503 停服：报「服务暂时不可用」+ 可重试，绝不能显示成「没有记录」', () => {
  const tree = PaymentTrailView(
    baseProps({
      view: { status: 'error', error: describeTrailError({ kind: 'unavailable', retryable: true }) },
      onRetry: () => {},
    })
  )
  const markup = renderToStaticMarkup(tree)
  const { count } = scan(markup)
  assert.equal(count('trail-error'), 1)
  assert.equal(count('trail-empty'), 0, '停服时显示空态 = 骗用户「你没买过」')
  assert.equal(count('trail-retry'), 1)
  assert.ok(markup.includes(zh.oursTrailErrUnavailable))
})

test('#189 401 / 没填 Key：提示重新填 Key，不给「重试」按钮（重试必然还是 401）', () => {
  for (const [kind, key] of [
    ['unauthorized', 'oursTrailErrUnauthorized'],
    ['keyMissing', 'oursTrailErrKeyMissing'],
  ]) {
    const markup = render(
      baseProps({ view: { status: 'error', error: describeTrailError({ kind, needsKey: true }) } })
    )
    const { count } = scan(markup)
    assert.equal(count('trail-retry'), 0, `${kind} 不该给重试`)
    assert.ok(markup.includes(zh[key]))
  }
})

test('#189 404 单号查不到：说「没有找到这笔记录」，不区分是不是别人的单', () => {
  const error = describeTrailError({ kind: 'notFound' })
  assert.equal(error.messageKey, 'oursTrailErrNotFound')
  assert.equal(error.retryable, false)
  const markup = render(baseProps({ view: { status: 'error', error } }))
  assert.ok(markup.includes(zh.oursTrailErrNotFound))
})

test('#189 未知错误类型也有兜底文案（数据层换实现不会白屏）', () => {
  const error = describeTrailError({ kind: 'wat' })
  assert.equal(error.messageKey, 'oursTrailErrUnknown')
  assert.equal(describeTrailError(null).messageKey, 'oursTrailErrUnknown')
})

// ------------------------------------------------------------------ 轮询（PAID 自动刷新，封顶 2 分钟）

test('#189 PAID 每 3~5 秒自动刷新一次，最多 2 分钟，其它状态不轮询', () => {
  assert.ok(TRAIL_POLL_INTERVAL_MS >= 3000 && TRAIL_POLL_INTERVAL_MS <= 5000, '间隔要在 3~5 秒')
  assert.equal(TRAIL_POLL_MAX_MS, 120000)
  assert.equal(shouldKeepPolling('paid', 0), true)
  assert.equal(shouldKeepPolling('paid', 119000), true)
  assert.equal(shouldKeepPolling('paid', 120000), false, '封顶后停手，不要无限轮询')
  for (const status of ['created', 'fulfilled', 'expired', 'failed']) {
    assert.equal(shouldKeepPolling(status, 0), false, `${status} 不该轮询`)
  }
})

// ------------------------------------------------------------------ 卡密溯源面板

test('#189 卡密溯源：已兑换显示积分 / 时间 / Key 尾号 / 是否本人', () => {
  const parsed = {
    cardNo: fixtures.cardTrailRedeemed.card_no,
    purchase: null,
    redemption: {
      redeemed: true,
      at: fixtures.cardTrailRedeemed.redemption.at,
      points: 3000,
      keyTail: '013812',
      byMe: true,
      source: 'in_app',
    },
  }
  const markup = renderToStaticMarkup(
    CardTrailPanel({ t, classNames: {}, view: { status: 'ok', trail: parsed } })
  )
  const { count } = scan(markup)
  assert.equal(count('trail-card-panel'), 1)
  assert.ok(markup.includes('••••A3SR'))
  assert.ok(!markup.includes('MUSE-3CYP-5NA3-AHSE-A3SR'))
  assert.ok(markup.includes('3,000'))
  assert.ok(markup.includes('013812'))
  assert.ok(markup.includes(zh.oursTrailRedeemedByMe))
})

test('#189 卡密溯源：未兑换显示「还没兑换」，不是空白面板', () => {
  const markup = renderToStaticMarkup(
    CardTrailPanel({
      t,
      classNames: {},
      view: {
        status: 'ok',
        trail: {
          cardNo: fixtures.cardTrailUnredeemed.card_no,
          purchase: null,
          redemption: { redeemed: false, at: null, points: 0, keyTail: '', byMe: null, source: '' },
        },
      },
    })
  )
  assert.ok(markup.includes(zh.oursTrailCardNotRedeemed))
})

// ------------------------------------------------------------------ 数据装配（永不抛）

test('#189 加载一页：没 Key 不发请求；失败归一成视图状态；成功透传分页大小', async () => {
  const noKey = await loadTrailPage({ fetchTrail: async () => assert.fail('不该发请求'), apiKey: '  ', offset: 0 })
  assert.equal(noKey.status, 'error')
  assert.equal(noKey.error.messageKey, 'oursTrailErrKeyMissing')

  const failed = await loadTrailPage({
    fetchTrail: async () => {
      throw { kind: 'unavailable', retryable: true }
    },
    apiKey: 'sk-x',
    offset: 0,
  })
  assert.equal(failed.status, 'error')
  assert.equal(failed.error.messageKey, 'oursTrailErrUnavailable')

  const sent = []
  const ok = await loadTrailPage({
    fetchTrail: async (params) => {
      sent.push(params)
      return { customerId: 10, total: 0, limit: 20, offset: 0, totalPaidYuan: 0, orders: [] }
    },
    apiKey: 'sk-x',
    offset: 20,
  })
  assert.equal(ok.status, 'ok')
  assert.deepEqual(sent, [{ apiKey: 'sk-x', limit: PAYMENT_TRAIL_PAGE_SIZE, offset: 20 }])
})

// ------------------------------------------------------------------ i18n

test('#189 新增文案中英都有，且展示层只从文案表取字', () => {
  const keys = [
    'oursTrailTitle',
    'oursTrailEntry',
    'oursTrailEmpty',
    'oursTrailLoading',
    'oursTrailRetry',
    'oursTrailRefresh',
    'oursTrailCopyOrderNo',
    'oursTrailNextStep',
    'oursTrailExpiredHint',
    'oursTrailWaitingCard',
    'oursTrailCardRedeemed',
    'oursTrailCardNotRedeemed',
    'oursTrailRedeemedByMe',
    'oursTrailRedeemedByOther',
    'oursTrailBackfilled',
    'oursTrailEventUnknown',
    'oursTrailEventOrderCreated',
    'oursTrailEventNotifyOk',
    'oursTrailEventPaidConfirmed',
    'oursTrailEventCardIssued',
    'oursTrailEventCardRedeemed',
    'oursTrailEventOrderExpired',
    'oursTrailEventLateRecovered',
    'oursTrailEventWaitingStock',
    'oursTrailEventBadAmount',
    'oursTrailStatusCreated',
    'oursTrailStatusPaid',
    'oursTrailStatusFulfilled',
    'oursTrailStatusExpired',
    'oursTrailStatusFailed',
    'oursTrailErrKeyMissing',
    'oursTrailErrUnauthorized',
    'oursTrailErrNotFound',
    'oursTrailErrUnavailable',
    'oursTrailErrRateLimited',
    'oursTrailErrTimeout',
    'oursTrailErrNetwork',
    'oursTrailErrServer',
    'oursTrailErrBadResponse',
    'oursTrailErrUnknown',
    'oursTrailCount',
    'oursTrailTotalPaid',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.notEqual(zh[key], '', `zh.${key} 是空串`)
    assert.notEqual(en[key], '', `en.${key} 是空串`)
    assert.notEqual(zh[key], en[key], `${key} 中英一模一样，八成是漏翻译`)
  }
  assert.equal(Object.keys(zh).length, Object.keys(en).length)
})

test('#189 已知事件文案随语言切换（英文界面不出现中文）', () => {
  const te = makeTranslate(en)
  const markup = renderToStaticMarkup(
    CardTrailPanel({ t: te, classNames: {}, view: { status: 'error', error: describeTrailError({ kind: 'notFound' }) } })
  )
  assert.ok(markup.includes(en.oursTrailErrNotFound))
  assert.equal(trailEventText('order_created', '已下单，等待支付', te), en.oursTrailEventOrderCreated)
  assert.equal(trailEventText('amount_reconciled', '对账完成，金额一致', te), '对账完成，金额一致')
  assert.equal(trailEventText('amount_reconciled', '', te), en.oursTrailEventUnknown)
})

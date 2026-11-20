// [layer: unit | 依赖: 无（纯 Node，renderToStaticMarkup） | Issue #325]
//
// 回归对象：**卡密溯源接入界面**（#325）。这条能力的代码此前是死代码（`CardTrailPanel` /
// `fetchCardTrailVia` 除单测外零调用点），本文件盯的是「接上之后」的四条线：
//
//  1. **入口**：支付记录里已发卡的卡密块上多个「查这张卡」；点击回传**完整**卡号，
//     但渲染出来的 DOM 只有后 4 位（时间线是截图 / 转发高频页面）。
//  2. **三态**：加载 / 有数据 / 404。「没有找到这笔记录」是 404 的唯一说法，
//     不区分「卡不存在」与「卡不是你的」—— 区分就等于送了一个拿卡号试探别人订单的接口。
//  3. **只读 + Key 位置**：`GET`，卡号只在 query，Key 只在 `Authorization`，URL 里没有 Key。
//  4. **卡号不进日志 / 埋点 / 剪贴板**：对源码做静态断言（这类泄漏靠渲染断言看不出来）。
//
// 为什么测 `.ts` 视图模块而不是 `.tsx`：与 #189 同一套理由 —— `.tsx` 进不了裸 Node，
// 一测就要开浏览器；这里对**生产同一份代码**跑 `renderToStaticMarkup`。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fixtureUrl, installTsResolve } from '../helpers/dom-env.mjs'

installTsResolve({
  stubs: { '@capacitor/core': fixtureUrl('domain03-04/ours-web-capacitor.mjs') },
})

const { fetchCardTrailVia, parseTrailOrder } = await import('../../src/services/ours/trail.ts')
const { CardTrailPanel, PaymentTrailView, cardSourceText, loadCardTrail } = await import(
  '../../src/components/settings/PaymentTrailView.ts'
)
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const fixtures = await import('../fixtures/domain06-07/ours-trail.mjs')

const KEY = 'sk-card-trail-325'
const BASE = 'https://apia.ecsafe.cn'
const FULL_CARD_NO = fixtures.cardTrailRedeemed.card_no

/** 只认 zh 表：本用例断言的重点是「哪句文案」，不是语言切换 */
const t = (key) => {
  assert.equal(typeof zh[key], 'string', `文案表里没有键 ${String(key)}`)
  return zh[key]
}

/** 设计系统 `Button` 的替身：`testId` → `data-testid`，其余属性透传（与其它视图用例同一形状） */
const Btn = ({ testId, children, onClick, ...rest }) =>
  createElement('button', { type: 'button', 'data-testid': testId, onClick, ...rest }, children)

/** 静态 HTML 里没有事件处理器：交互回到元素树上直接调 `onClick` */
const nodesWithTestId = (node, testId, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) nodesWithTestId(child, testId, out)
    return out
  }
  const props = node.props ?? {}
  if (props['data-testid'] === testId) out.push(node)
  if (props.children !== undefined) nodesWithTestId(props.children, testId, out)
  return out
}

const countTestId = (markup, testId) =>
  markup.split(`data-testid="${testId}"`).length - 1

/** 一条已发卡（已兑换）的订单：解析走**真的** `parseTrailOrder`，不手搓 camelCase 形状 */
const redeemedOrder = () => parseTrailOrder(fixtures.trailOrderFulfilled)

const viewOf = (orders) => ({
  status: 'ok',
  page: {
    customerId: fixtures.TRAIL_CUSTOMER_ID,
    total: orders.length,
    limit: 20,
    offset: 0,
    totalPaidYuan: 29.9,
    orders,
  },
})

// ------------------------------------------------------------------ 入口（#325 关闭条件 1）

test('#325 已发卡的卡密块上有「查这张卡」，没传回调就不渲染入口', () => {
  const withEntry = renderToStaticMarkup(
    PaymentTrailView({
      t,
      classNames: {},
      button: Btn,
      view: viewOf([redeemedOrder()]),
      onLookupCard: () => {},
    })
  )
  assert.equal(countTestId(withEntry, 'trail-card'), 1)
  assert.equal(countTestId(withEntry, 'trail-card-lookup'), 1)
  assert.ok(withEntry.includes(zh.oursTrailCardLookup), '按钮文案要走 i18n')

  // 别的宿主复用这个视图时不该冒出一个按不动的按钮
  const withoutEntry = renderToStaticMarkup(
    PaymentTrailView({ t, classNames: {}, button: Btn, view: viewOf([redeemedOrder()]) })
  )
  assert.equal(countTestId(withoutEntry, 'trail-card-lookup'), 0)
})

test('#325 入口回传完整卡号，但 DOM 里只有后 4 位', () => {
  const seen = []
  const tree = PaymentTrailView({
    t,
    classNames: {},
    button: Btn,
    view: viewOf([redeemedOrder()]),
    onLookupCard: (cardNo) => seen.push(cardNo),
  })
  const markup = renderToStaticMarkup(tree)
  assert.ok(markup.includes('••••A3SR'))
  assert.equal(markup.includes(FULL_CARD_NO), false, '完整卡号不许进 DOM（截图 / 转发会带走）')

  const buttons = nodesWithTestId(tree, 'trail-card-lookup')
  assert.equal(buttons.length, 1)
  buttons[0].props.onClick()
  assert.deepEqual(seen, [FULL_CARD_NO], '查询要的是完整卡号')
})

// ------------------------------------------------------------------ 三态（#325 关闭条件 2）

test('#325 三态：加载中有话说，有数据渲染面板，404 只有「没有找到这笔记录」', () => {
  const loading = renderToStaticMarkup(CardTrailPanel({ t, classNames: {}, view: { status: 'loading' } }))
  assert.equal(countTestId(loading, 'trail-loading'), 1)
  assert.ok(loading.includes(zh.oursTrailLoading))

  const error = {
    status: 'error',
    error: { messageKey: 'oursTrailErrNotFound', retryable: false, needsKey: false },
  }
  const notFound = renderToStaticMarkup(CardTrailPanel({ t, classNames: {}, view: error }))
  assert.ok(notFound.includes(zh.oursTrailErrNotFound))
  assert.equal(countTestId(notFound, 'trail-error'), 1)
  // 404 不能被渲染成空态（#189 的「停服≠没记录」同一口径）
  assert.equal(countTestId(notFound, 'trail-empty'), 0)
  assert.equal(countTestId(notFound, 'trail-card-retry'), 0, '404 重试没有意义')

  const parsed = {
    cardNo: FULL_CARD_NO,
    purchase: redeemedOrder(),
    redemption: { redeemed: true, at: 1, points: 3000, keyTail: '013812', byMe: true, source: 'in_app' },
  }
  const ok = renderToStaticMarkup(CardTrailPanel({ t, classNames: {}, view: { status: 'ok', trail: parsed } }))
  assert.equal(countTestId(ok, 'trail-card-panel'), 1)
  assert.equal(ok.includes(FULL_CARD_NO), false, '面板里也只有掩码')
  assert.ok(ok.includes(zh.oursTrailCardLookupHint), '权限边界要写在用户看得见的地方')
})

test('#325 503 可重试且不是空态；401 引导重新绑定 Key', () => {
  const unavailable = renderToStaticMarkup(
    CardTrailPanel({
      t,
      classNames: {},
      button: Btn,
      onRetry: () => {},
      view: { status: 'error', error: { messageKey: 'oursTrailErrUnavailable', retryable: true, needsKey: false } },
    })
  )
  assert.ok(unavailable.includes(zh.oursTrailErrUnavailable))
  assert.equal(countTestId(unavailable, 'trail-card-retry'), 1)
  assert.equal(countTestId(unavailable, 'trail-empty'), 0)

  const unauthorized = renderToStaticMarkup(
    CardTrailPanel({
      t,
      classNames: {},
      button: Btn,
      onRetry: () => {},
      view: { status: 'error', error: { messageKey: 'oursTrailErrUnauthorized', retryable: false, needsKey: true } },
    })
  )
  assert.ok(unauthorized.includes(zh.oursTrailErrUnauthorized))
  assert.ok(unauthorized.includes(zh.oursTrailNeedKey))
  assert.equal(countTestId(unauthorized, 'trail-card-retry'), 0, '401 重试没用，别给按钮')
})

// ------------------------------------------------------------------ 兑换来源（#325 关闭条件点名）

test('#325 兑换来源：认识的原样翻译，不认识的显示服务端原值', () => {
  assert.equal(cardSourceText('in_app', t), zh.oursTrailCardSourceInApp)
  assert.equal(cardSourceText('WEB', t), zh.oursTrailCardSourceWeb)
  assert.equal(cardSourceText('', t), zh.oursTrailCardSourceUnknown)
  assert.equal(cardSourceText('mini_program', t), 'mini_program', '服务端加新来源时别吞成「未知」')
})

// ------------------------------------------------------------------ 数据装配（三态归一，永不抛）

test('#325 没 Key / 空卡号都不发请求；404 与 503 归一成视图状态', async () => {
  const boom = async () => assert.fail('不该发请求')

  const noKey = await loadCardTrail({ fetchCardTrail: boom, apiKey: '  ', cardNo: FULL_CARD_NO })
  assert.equal(noKey.status, 'error')
  assert.equal(noKey.error.messageKey, 'oursTrailErrKeyMissing')

  const noCard = await loadCardTrail({ fetchCardTrail: boom, apiKey: KEY, cardNo: '   ' })
  assert.equal(noCard.status, 'error')
  assert.equal(noCard.error.messageKey, 'oursTrailErrNotFound')

  const notFound = await loadCardTrail({
    fetchCardTrail: async () => {
      throw { kind: 'notFound', retryable: false }
    },
    apiKey: KEY,
    cardNo: FULL_CARD_NO,
  })
  assert.equal(notFound.error.messageKey, 'oursTrailErrNotFound')
  assert.equal(notFound.error.retryable, false)

  const unavailable = await loadCardTrail({
    fetchCardTrail: async () => {
      throw { kind: 'unavailable', retryable: true }
    },
    apiKey: KEY,
    cardNo: FULL_CARD_NO,
  })
  assert.equal(unavailable.error.messageKey, 'oursTrailErrUnavailable')
  assert.equal(unavailable.error.retryable, true)

  const sent = []
  const ok = await loadCardTrail({
    fetchCardTrail: async (params) => {
      sent.push(params)
      return { cardNo: FULL_CARD_NO, purchase: null, redemption: { redeemed: false, at: null, points: 0, keyTail: '', byMe: null, source: '' } }
    },
    apiKey: ` ${KEY} `,
    cardNo: ` ${FULL_CARD_NO} `,
  })
  assert.equal(ok.status, 'ok')
  assert.deepEqual(sent, [{ apiKey: KEY, cardNo: FULL_CARD_NO }], 'Key 与卡号两侧空白都要去掉')
})

test('#325 解析：redemption 段缺字段时给安全默认值', async () => {
  const trail = await fetchCardTrailVia(
    { apiKey: KEY, cardNo: FULL_CARD_NO },
    async () => ({ kind: 'response', status: 200, text: JSON.stringify(fixtures.cardTrailUnredeemed) }),
    BASE
  )
  assert.equal(trail.redemption.redeemed, false)
  assert.equal(trail.redemption.points, 0)
  assert.equal(trail.redemption.keyTail, '')
  assert.equal(trail.redemption.byMe, null)
  assert.equal(trail.redemption.source, '')
})

// ------------------------------------------------------------------ 请求形状（只读 / Key 只在头）

test('#325 卡号只在 query，Key 只在 Authorization，方法只读 GET', async () => {
  const calls = []
  await fetchCardTrailVia(
    { apiKey: KEY, cardNo: FULL_CARD_NO },
    async (request) => {
      calls.push(request)
      return { kind: 'response', status: 200, text: JSON.stringify(fixtures.cardTrailRedeemed) }
    },
    BASE
  )
  assert.equal(calls.length, 1)
  const [request] = calls
  assert.equal(request.method, 'GET', '溯源是只读能力，不许出现写请求')
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`)
  assert.equal(request.url.includes(KEY), false, 'Key 不许出现在 URL 里')

  const url = new URL(request.url)
  assert.equal(url.origin + url.pathname, `${BASE}/api/card/trail`)
  assert.equal(url.searchParams.get('card_no'), FULL_CARD_NO)
  assert.deepEqual([...url.searchParams.keys()], ['card_no'], 'query 里只该有 card_no')

  // 其它头里不许夹带卡号（埋点 / trace 头是最容易漏的地方）
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === 'authorization') continue
    assert.equal(String(value).includes(FULL_CARD_NO), false, `${name} 头里出现了完整卡号`)
  }
})

// ------------------------------------------------------------------ 隐私（静态断言，渲染断言看不出来）

test('#325 卡号不进日志 / 埋点 / 剪贴板（扫源码）', async () => {
  const files = [
    'src/components/settings/PaymentTrailView.ts',
    'src/services/ours/trail.ts',
    'src/components/settings/PaymentTrailDialog.tsx',
  ]
  for (const relative of files) {
    const source = await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8')
    assert.equal(/console\.(?:log|info|debug|warn|error)/u.test(source), false, `${relative} 里不许 console.*（卡号可能随参数进日志）`)
    assert.equal(/copyText\(\s*(?:cardNo|card\.cardNo|params\.cardNo)/u.test(source), false, `${relative} 不许把卡号写进剪贴板`)
    assert.equal(/(?:track|report|beacon|sendBeacon)\([^)]*cardNo/u.test(source), false, `${relative} 不许把卡号送进埋点`)
  }
})

// ------------------------------------------------------------------ i18n（zh / en 成对）

test('#325 新增文案中英成对且没有空值', () => {
  const keys = [
    'oursTrailCardLookup',
    'oursTrailCardLookupTitle',
    'oursTrailCardLookupHint',
    'oursTrailCardSourceLabel',
    'oursTrailCardSourceInApp',
    'oursTrailCardSourceWeb',
    'oursTrailCardSourceUnknown',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.notEqual(zh[key].trim(), '', `zh ${key} 是空值`)
    assert.notEqual(en[key].trim(), '', `en ${key} 是空值`)
  }
  assert.equal(zh.oursTrailCardLookupTitle, '卡密溯源')
})

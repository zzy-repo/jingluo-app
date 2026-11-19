// [layer: unit —— 组件级（真弹层组件 + 真服务层，假传输 / 假 Browser），零浏览器 | 耗时: <1s]
// C3「打开弹层只读 + 选择态 + 刷新额度 + 关收款页刷新」—— 域 6 F6-01 F6-02 F6-06 + 域 7 F7-05
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 N1「关收款页 → 刷新额度组合零断言」= 本文件第 5 行）
//
// 这条用例存在的唯一理由：`OursServicesDialog.tsx` 的编排从来没人跑过（#100 的「打开弹层自动 /apply」
// 就是这么漏到真机的）。这里挂载的是**真组件**（`OursServicesRow` → `OursServicesDialog`），
// 只把传输层与 App 内浏览器换成假的，因此断言的是「打开弹层到底发了几条请求」这件事本身。
//
// 六行表：
//   1 有 Key → 只发 1 条 GET /me，不覆盖已有 Key
//   2 无 Key → 一条请求都不发，停在选择态
//   3 /me 404 device_not_found → 只读、不补 /apply，提示「本机还没有绑定」
//   4 点「刷新额度」→ 再发一条 GET /me，额度按服务端新值变
//   5 点「前往购买」→ /api/pay-link → App 内打开 → 关页后**恰好一条** /me（且绝不说「支付成功」）
//   6 pay-link 503 → 不打开浏览器、弹层内给「收款通道暂不可用」、不多发 /me
//
// 跑法：node --test tests/unit/domain06-dialog-open-readonly.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource(
  'src/components/settings/OursServicesDialog.tsx'
)
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-33333333333333333333333333333333'
const KEY = 'sk-ours-dialog-open-0011223344556677'
const PAY_URL = 'https://wzyp.cn/shop/pay/abc'

const profile = (remaining = 300, extra = {}) => ({
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
  ...extra,
})

/** 按 `METHOD /path` 排队给响应（同一条路径第 N 次请求用第 N 条，用完就一直用最后一条） */
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

/** 每个场景都从干净状态开始：本地设备码固定、Key 由用例决定、请求记录清零 */
const prepare = ({ apiKey = '', table, deviceId = DEVICE }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = apiKey
  if (deviceId !== '') {
    globalThis.localStorage.setItem('chat-demo:ours-device-id', deviceId)
  }
  harness.ctx.oursOpen = true
  harness.ctx.reply(scripted(table))
}

const mountDialog = () => harness.mount(OursServicesRow, {})

/** 已下线链路的哨兵：任何一条都说明「不建单、不查单、不轮询」被破坏了 */
const ORDER_ENDPOINTS = ['/buy', '/api/buy', '/api/order', '/api/orders', '/invite/rotate']

const assertNoOrderTraffic = (paths) => {
  for (const path of paths) {
    for (const endpoint of ORDER_ENDPOINTS) {
      assert.equal(
        path.endsWith(` ${endpoint}`),
        false,
        `${path}：打开弹层/买卡链路里不该出现订单接口（#331 已下线建单与轮询）`
      )
    }
  }
}

test('C3/1 F6-01 本机已有 Key：打开只发一条 GET /me，不自动领取、不覆盖已有 Key', async () => {
  prepare({ apiKey: KEY, table: { 'GET /me': [TRANSPORT.json(200, profile(300))] } })
  const view = await mountDialog()

  assert.deepEqual(harness.ctx.paths, ['GET /me'], '#100：打开弹层只读，一条写请求都不该有')
  assert.equal(harness.ctx.keyWrites.length, 0, '打开弹层不该改写本地 Key')
  assert.equal(view.text('ours-quota-value'), `300 ${zh.oursPointsUnit}`)
  assert.equal(view.has('ours-open-choice'), false, '有档案时不该停在选择态')
  assertNoOrderTraffic(harness.ctx.paths)
  view.unmount()
})

test('C3/2 F6-02 本机没有 Key：一条请求都不发，停在「领取新 Key / 我已有 Key」选择态', async () => {
  prepare({ apiKey: '', table: {} })
  const view = await mountDialog()

  assert.deepEqual(harness.ctx.paths, [], '#100：没有凭据时连 /me 都不该发')
  assert.equal(view.has('ours-open-choice'), true)
  assert.match(view.text('ours-open-choice'), /领取新 Key/u)
  assert.match(view.text('ours-open-choice'), /我已有 Key/u)
  view.unmount()
})

test('C3/3 F6-01 /me 返回 device_not_found：只发那一条 GET /me，不补 /apply，提示「本机还没有绑定」', async () => {
  prepare({
    apiKey: KEY,
    table: { 'GET /me': [TRANSPORT.json(404, { error: { code: 'device_not_found' } })] },
  })
  const view = await mountDialog()

  assert.deepEqual(harness.ctx.paths, ['GET /me'], 'device_not_found 绝不能在客户端静默补 /apply')
  assert.equal(view.text('ours-quota-value'), zh.oursQuotaNeedsBind)
  view.unmount()
})

test('C3/4 F6-06 点「刷新额度」：再发一条 GET /me，额度按服务端新值显示（不拿 /api/balance 当余额）', async () => {
  prepare({
    apiKey: KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300)), TRANSPORT.json(200, profile(120))],
    },
  })
  const view = await mountDialog()
  assert.equal(view.text('ours-quota-value'), `300 ${zh.oursPointsUnit}`)

  await view.click('ours-quota-refresh')
  assert.deepEqual(harness.ctx.paths, ['GET /me', 'GET /me'])
  assert.equal(view.text('ours-quota-value'), `120 ${zh.oursPointsUnit}`)
  view.unmount()
})

test('C3/5 F7-05 点「前往购买」→ 现取收款页地址 → App 内打开 → 关页后刷新额度（恰好一次）', async () => {
  prepare({
    apiKey: KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300)), TRANSPORT.json(200, profile(500))],
      'GET /api/pay-link': [TRANSPORT.json(200, { ok: true, url: PAY_URL, note: '联动小铺' })],
    },
  })
  const view = await mountDialog()
  await view.click('ours-buy')

  // 1) 地址每次现取（不写死），2) 交给 App 内浏览器打开
  assert.deepEqual(harness.ctx.paths, ['GET /me', 'GET /api/pay-link'])
  assert.deepEqual(harness.ctx.browser.opens, [PAY_URL])
  assert.equal(view.text('ours-pay-notice'), zh.oursPayHint)

  // 3) 用户关掉收款页 → 回 App：只刷新额度，别的什么都不做
  assert.equal(
    typeof harness.ctx.browser.onClosed,
    'function',
    '关页回调没注册：额度不会刷新（N1 缺口）'
  )
  harness.ctx.browser.onClosed()
  await view.settle()

  assert.deepEqual(
    harness.ctx.paths,
    ['GET /me', 'GET /api/pay-link', 'GET /me'],
    '关页应恰好再发一条 /me'
  )
  assert.equal(
    view.text('ours-quota-value'),
    `500 ${zh.oursPointsUnit}`,
    '关页后的额度必须是服务端最新值'
  )
  assert.equal(view.html().includes('支付成功'), false, '没有订单可查：绝不显示「支付成功」')
  assertNoOrderTraffic(harness.ctx.paths)
  view.unmount()
})

test('C3/6 F7-05 收款通道 503：不打开浏览器、留在弹层里给可读文案、不多发 /me', async () => {
  prepare({
    apiKey: KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300))],
      'GET /api/pay-link': [TRANSPORT.json(503, { code: 'PAY_LINK_NOT_CONFIGURED' })],
    },
  })
  const view = await mountDialog()
  await view.click('ours-buy')

  assert.deepEqual(harness.ctx.paths, ['GET /me', 'GET /api/pay-link'])
  assert.deepEqual(harness.ctx.browser.opens, [], '地址不可用时绝不能打开任何页面')
  assert.equal(view.text('ours-pay-notice'), zh.oursPayUnavailable)
  assert.equal(harness.ctx.browser.onClosed ?? null, null)
  assertNoOrderTraffic(harness.ctx.paths)
  view.unmount()
})

// [layer: unit —— 组件级（真弹层组件 + 真服务层，假传输），零浏览器 | 耗时: <1s]
// C4「领取 / 绑定 / 换 Key / 兑换 的 UI 编排」—— 域 6 F6-03 F6-14 F6-15 F6-16 + F6-10
// （docs/testing/coverage/domain-06-07.md §4.1；缺口 N3「弹层按钮编排零测试」= 本文件）
//
// L0 只能验「单个函数怎么解释一次响应」；这里验的是跨层顺序：
//   点击 → 发哪条请求 → 落盘（setApiKey）→ 刷新额度（/me）或直接用响应里的档案 → 界面文案
//
// 四条不允许破坏的编排约束（每行断言一条）：
//   1. 领取成功后 Key 立刻落盘，且余额直接用 /apply 响应里的档案（不必再查 /me）；
//   2. 服务端说「已领过」时，界面文案绝不是「领取成功」（#261 的取舍）；
//   3. 绑定成功要走「保存 Key → 刷新额度 → 关掉设置弹层」这条完整链路；
//   4. 换 Key 必须点两下（二次确认）才发请求，失败时本地旧 Key 一个字节都不动（#90）。
//
// #421 起：有账号（本机有 Key）或领取/绑定成功后，会多一条**只读**的 `GET /email/status`
// 探测邮箱入口。所有「发了几条请求」的断言都先用 withoutEmailProbe 把它摘掉再比，
// 避免这条与本次改动无关的只读请求把每条旧断言都变成噪音。
//
// 跑法：node --test tests/unit/domain06-claim-ui-orchestration.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource(
  'src/components/settings/OursServicesDialog.tsx'
)
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-44444444444444444444444444444444'
const OLD_KEY = 'sk-ours-ui-old-key-00112233445566'
const NEW_KEY = 'sk-ours-ui-new-key-ffeeddccbbaa99'
const CARD = 'MUSE-9a8b-7c6d-5e4f-71bb'

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
 * #421：邮箱入口探测（只读）。断言请求序列前先摘掉它，再单独断言它不影响别的东西。
 */
const EMAIL_PROBE = 'GET /email/status'
const withoutEmailProbe = (paths) => paths.filter((path) => path !== EMAIL_PROBE)
/** 服务端未开邮箱功能时的真实返回：404 + not_found（入口不出现，旧流程不变） */
const EMAIL_DISABLED = TRANSPORT.json(404, { error: { code: 'not_found' } })

const prepare = ({ apiKey = '', table, deviceId = DEVICE }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = apiKey
  globalThis.localStorage.setItem('chat-demo:ours-device-id', deviceId)
  harness.ctx.oursOpen = true
  harness.ctx.reply(scripted(table))
}

test('C4/1 F6-03 点「领取新 Key」→ POST /apply → Key 立刻落盘 + 余额取响应档案（不再查 /me）', async () => {
  prepare({
    apiKey: '',
    table: {
      'POST /apply': [
        TRANSPORT.json(201, { ...profile(300), key: NEW_KEY, new_user_granted: true }),
      ],
      'GET /api/balance': [TRANSPORT.json(200, { valid: true })],
      [EMAIL_PROBE]: [EMAIL_DISABLED],
    },
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-open-choice-claim')

  assert.deepEqual(
    withoutEmailProbe(harness.ctx.paths),
    ['POST /apply', 'GET /api/balance'],
    '领取后不该再查 /me（档案就在响应里）'
  )
  assert.deepEqual(harness.ctx.keyWrites, [NEW_KEY], '服务端发的 Key 必须落盘')
  assert.equal(
    view.text('ours-claim-status'),
    zh.oursClaimOk.replace('{points}', `300 ${zh.oursPointsUnit}`)
  )
  assert.equal(view.text('ours-quota-value'), `300 ${zh.oursPointsUnit}`)
  assert.equal(view.has('ours-open-choice'), false, '领取成功后应离开选择态')
  view.unmount()
})

test('C4/2 F6-04 服务端说「已领过」→ 文案绝不是「领取成功」，并且不覆盖本机已有的 Key', async () => {
  prepare({
    apiKey: OLD_KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300))],
      'POST /apply': [
        TRANSPORT.json(200, {
          ...profile(300),
          key: NEW_KEY,
          already_claimed: true,
          new_user_granted: true,
        }),
      ],
      'GET /api/balance': [TRANSPORT.json(200, { valid: true })],
      [EMAIL_PROBE]: [EMAIL_DISABLED],
    },
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-claim')

  assert.deepEqual(withoutEmailProbe(harness.ctx.paths), ['GET /me', 'POST /apply', 'GET /api/balance'])
  assert.deepEqual(harness.ctx.keyWrites, [], '本机已有 Key 时不许自动覆盖')
  assert.equal(view.text('ours-claim-status'), zh.oursClaimOkExisting)
  assert.equal(view.text('ours-claim-status').includes('已领取，剩余'), false)
  // 服务端的 Key 与本地不同 → 只给「使用此 Key」让用户自己决定
  assert.equal(view.has('ours-claim-use'), true)
  view.unmount()
})

test('C4/3 F6-15 绑定已有 Key → POST /bind → 保存 → 刷新额度 → 关掉设置弹层', async () => {
  prepare({
    apiKey: '',
    table: {
      'POST /bind': [
        TRANSPORT.json(200, { key: NEW_KEY, already_bound: false, remaining_points: 800 }),
      ],
      'GET /me': [TRANSPORT.json(200, profile(800))],
      [EMAIL_PROBE]: [EMAIL_DISABLED],
    },
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-open-choice-bind')
  await view.type('ours-bind-input', NEW_KEY)
  await view.click('ours-bind-submit')

  assert.deepEqual(
    withoutEmailProbe(harness.ctx.paths),
    ['POST /bind', 'GET /me'],
    '绑定成功后必须刷新一次额度'
  )
  assert.deepEqual(harness.ctx.keyWrites, [NEW_KEY])
  // 成功文案只有一条（binding 与首次绑定完全一样），由 bindSuccessKey 判定 → C2/B1 逐字断言；
  // 这里断言的是编排末端的「关掉设置弹层」，因为弹层一关，文案节点就不在树上了。
  assert.equal(
    harness.ctx.settingsClosed,
    1,
    '绑定成功后要关掉设置页（这里以 closeSettings 计数为准）'
  )
  assert.equal(harness.ctx.oursOpen, false, '弹层应关闭')
  view.unmount()
})

test('C4/4 F6-14 换 Key 必须点两下：确认前 0 条请求；确认后 /rotate → 落盘 → 额度取响应档案', async () => {
  prepare({
    apiKey: OLD_KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300))],
      [EMAIL_PROBE]: [EMAIL_DISABLED],
      'POST /rotate': [
        TRANSPORT.json(200, {
          key: NEW_KEY,
          rotated: true,
          carried_used_points: 0,
          quota_points: 400,
          remaining_points: 400,
          invite_code: 'K3M9QW2P',
          device_id: DEVICE,
        }),
      ],
    },
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-rotate-open')

  // 二次确认还没点：一条 /rotate 都不许发（破坏性操作）
  assert.deepEqual(withoutEmailProbe(harness.ctx.paths), ['GET /me'])
  assert.equal(view.has('ours-rotate-confirm'), true)
  assert.match(view.text('ours-rotate-confirm-body'), /立即失效/u)

  await view.click('ours-rotate-submit')
  assert.deepEqual(
    withoutEmailProbe(harness.ctx.paths),
    ['GET /me', 'POST /rotate'],
    '成功后不该再查 /me（档案在响应里）'
  )
  assert.deepEqual(harness.ctx.keyWrites, [NEW_KEY])
  assert.equal(view.text('ours-rotate-result'), zh.oursRotateOk)
  assert.equal(view.text('ours-quota-value'), `400 ${zh.oursPointsUnit}`)
  view.unmount()
})

test('C4/5 F6-14 换 Key 失败：本地旧 Key 一个字节都不动，文案明确「旧 Key 仍可继续使用」', async () => {
  prepare({
    apiKey: OLD_KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300))],
      [EMAIL_PROBE]: [EMAIL_DISABLED],
      'POST /rotate': [TRANSPORT.json(404, { error: { code: 'device_not_found' } })],
    },
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-rotate-open')
  await view.click('ours-rotate-submit')

  assert.deepEqual(harness.ctx.keyWrites, [])
  assert.equal(harness.ctx.apiKey, OLD_KEY, '旧 Key 必须原地不动')
  const result = view.text('ours-rotate-result')
  assert.ok(result.includes(zh.oursRotateErrDeviceNotFound), `缺失败原因文案：${result}`)
  assert.ok(result.includes(zh.oursRotateKeptOldKey), `缺「旧 Key 仍可用」：${result}`)
  view.unmount()
})

test('C4/6 F6-10 兑换成功 → 清空输入 + 刷新一次额度；卡密只露后 4 位', async () => {
  prepare({
    apiKey: OLD_KEY,
    table: {
      'GET /me': [TRANSPORT.json(200, profile(300)), TRANSPORT.json(200, profile(400))],
      [EMAIL_PROBE]: [EMAIL_DISABLED],
      'POST /redeem-card': [
        TRANSPORT.json(200, { ok: true, points: 100, quota_points: 400, remaining_points: 400 }),
      ],
    },
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.type('ours-redeem-input', CARD)
  await view.click('ours-redeem-submit')

  assert.deepEqual(withoutEmailProbe(harness.ctx.paths), ['GET /me', 'POST /redeem-card', 'GET /me'])
  const redeemCall = harness.ctx.requests.find((request) => request.path === '/redeem-card')
  assert.deepEqual(JSON.parse(redeemCall.body), { card_no: CARD, api_key: OLD_KEY })
  const result = view.text('ours-redeem-result')
  assert.ok(
    result.includes(zh.oursRedeemSuccess.replace('{points}', `100 ${zh.oursPointsUnit}`)),
    `兑换成功文案不对：${result}`
  )
  assert.match(result, /71bb/u)
  assert.equal(result.includes(CARD), false, '界面上不许出现完整卡密')
  assert.equal(view.node('ours-redeem-input').props.value, '', '兑换成功后应清空输入')
  assert.equal(view.text('ours-quota-value'), `400 ${zh.oursPointsUnit}`)
  view.unmount()
})

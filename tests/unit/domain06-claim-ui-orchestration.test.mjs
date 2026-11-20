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

  // 二次确认还没点：一条 /rotate 都不许发（仍保留点两下）
  assert.deepEqual(withoutEmailProbe(harness.ctx.paths), ['GET /me'])
  assert.equal(view.has('ours-rotate-confirm'), true)
  // #357：/rotate 改成「原地重置额度、不换 Key 字符串」，确认文案跟着改口径
  // （原来这里断言的是「旧 Key 立即失效」，那句已经和实际不符）
  assert.match(view.text('ours-rotate-confirm-body'), /额度/u)

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

// ------------------------------------------------------------------ P1 / P4（Issue #452）

/**
 * 带闸门的响应器：`/redeem-card` 先挂起，由用例决定什么时候放行。
 *
 * 目的只有一个 —— 在**请求还在飞**的那一瞬间读界面状态。`settle()` 在请求挂着时不会
 * 反复渲染（组件没有状态更新），所以「点了兑换、但还没回包」这个中间态可以被稳定地断言：
 * 提交按钮是不是禁用、输入框是不是锁住（#452 P1「禁止重复提交」只在这一点上成立）。
 */
const prepareGated = ({ cardReply }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = OLD_KEY
  globalThis.localStorage.setItem('chat-demo:ours-device-id', DEVICE)
  harness.ctx.oursOpen = true
  const me = [TRANSPORT.json(200, profile(300)), TRANSPORT.json(200, profile(400))]
  let meIndex = 0
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  harness.ctx.reply(async (request) => {
    if (request.path === '/redeem-card') {
      await gate
      return cardReply
    }
    if (request.path === '/me') {
      return me[Math.min(meIndex++, me.length - 1)]
    }
    if (request.path === '/email/status') {
      return EMAIL_DISABLED
    }
    throw new Error(`P1/P4 用例没有为 ${request.method} ${request.path} 准备响应`)
  })
  return { release, gate }
}

/**
 * P1：兑换返回 202「处理中」——三行表（两种 202 信封 + 空 body 的 202）。
 *
 * 一条 202 要被界面解释成三件事，缺一条都会让用户反复点：
 *   1. **进入「处理中」态**：文案是「兑换处理中，稍后自动到账」，绝不含「失败」字样；
 *   2. **禁止重复提交**：请求在飞时按钮禁用；回包后输入框已清空、且没有「重试」按钮
 *      （pending 只剩「刷新额度」，不会给用户一个一键重发的按钮）；
 *   3. **最终怎么确认到账**：点「刷新额度」再打一条 `GET /me`，额度按服务端新值显示
 *      —— 没有轮询、没有「支付成功」这种假结论。
 */
const PENDING_ROWS = [
  {
    id: '1',
    name: 'F6-12 HTTP 202 + {code:CREDIT_PENDING}',
    reply: TRANSPORT.json(202, { code: 'CREDIT_PENDING', points: 100 }),
  },
  {
    id: '2',
    name: 'F6-12 HTTP 200 + {code:CREDIT_PENDING}（池的另一种信封）',
    reply: TRANSPORT.json(200, { ok: true, code: 'CREDIT_PENDING' }),
  },
  {
    id: '3',
    name: 'F6-12 HTTP 202 空 body（真实网关可能什么都不带）',
    reply: TRANSPORT.text(202, ''),
  },
]

test('P1/F6-12 兑换 202「处理中」：处理中态 + 禁止重复提交 + 靠刷新额度确认到账（表驱动 3 行）', async (t) => {
  for (const row of PENDING_ROWS) {
    t.diagnostic(`P1/${row.id} ${row.name} → 处理中态、请求在飞时禁止重复提交、靠刷新额度确认到账`)
    const { release } = prepareGated({ cardReply: row.reply })
    const view = await harness.mount(OursServicesRow, {})
    await view.type('ours-redeem-input', CARD)
    await view.click('ours-redeem-submit')

    // ---- 1. 请求还在飞：提交按钮与输入框都必须锁住（这是「禁止重复提交」唯一有效的位置）
    assert.equal(
      view.node('ours-redeem-submit').props.disabled,
      true,
      '兑换请求在飞时按钮必须禁用，否则用户连点就是两笔'
    )
    assert.equal(view.node('ours-redeem-input').props.disabled, true, '请求在飞时输入框也要锁住')
    assert.equal(harness.ctx.paths.filter((path) => path === 'POST /redeem-card').length, 1)

    release()
    await view.settle()

    // ---- 2. 回包是 202：进入「处理中」态，不是失败，也不催重试
    const result = view.text('ours-redeem-result')
    assert.equal(result.includes(zh.oursRedeemProcessing), true, `202 必须显示处理中：${result}`)
    assert.match(result, /71bb/u, '卡密后 4 位要带上，用户才知道是哪张卡')
    assert.equal(result.includes('失败'), false, `处理中绝不能说失败：${result}`)
    assert.equal(result.includes(zh.oursErrTimeout), false, '处理中不是超时/失败')
    assert.equal(view.has('ours-redeem-retry'), false, '处理中不给「重试」按钮（会变成第二次提交）')
    assert.equal(view.has('ours-redeem-refresh'), true, '处理中要给「刷新额度」让用户自己确认到账')
    assert.equal(view.node('ours-redeem-input').props.value, '', '处理中也要清空输入框')
    assert.equal(view.node('ours-redeem-submit').props.disabled, false, '回包后按钮要恢复可点')

    // ---- 3. 确认到账：点「刷新额度」→ 再打一条只读 /me，额度按服务端新值显示
    await view.click('ours-redeem-refresh')
    assert.deepEqual(withoutEmailProbe(harness.ctx.paths), [
      'GET /me',
      'POST /redeem-card',
      'GET /me',
      'GET /me',
    ])
    assert.equal(view.text('ours-quota-value'), `400 ${zh.oursPointsUnit}`, '刷新后额度要显示服务端新值')
    assert.equal(view.text('ours-redeem-result').includes(zh.oursRedeemProcessing), true, '刷新额度不改写「处理中」结论')

    // ---- 4. 输入框已清空 = 同一张卡不会被二次提交（空提交本地拦下，一条请求都不发）
    const before = harness.ctx.paths.filter((path) => path === 'POST /redeem-card').length
    await view.click('ours-redeem-submit')
    assert.equal(
      harness.ctx.paths.filter((path) => path === 'POST /redeem-card').length,
      before,
      '空卡密提交必须本地拦下，绝不能把同一张卡再打一遍'
    )
      view.unmount()
  }
})

/**
 * P4：兑换成功但额度刷新失败（`/me` 超时 / 断网）。
 *
 * #452 P4 的风险不是「额度没刷出来」（那是小事），而是**界面把兑换说成失败**，
 * 用户以为没到账 → 再兑一次 = 第二次扣卡。所以两行（超时 / 断网）都盯住三件事：
 *   1. 兑换结果区仍然是「兑换成功，+100」（绝无「失败」字样、绝不被额度错误盖掉）；
 *   2. 额度区如实报错并保留「刷新额度」按钮（错误可以说，但不能张冠李戴）；
 *   3. 刷新成功之后额度更新，执行重试时**不再发第二条 /redeem-card**（重试的是 /me，不是兑换）。
 */
const REFRESH_FAIL_ROWS = [
  {
    id: '1',
    name: 'F6-10/F6-06 兑换成功 + 随后的 /me 超时',
    refreshReply: TRANSPORT.timeout(),
    expectedKey: 'oursErrTimeout',
  },
  {
    id: '2',
    name: 'F6-10/F6-06 兑换成功 + 随后的 /me 断网',
    refreshReply: TRANSPORT.network(),
    expectedKey: 'oursErrNetwork',
  },
]

test('P4/F6-10 兑换成功但额度刷新失败（/me 超时/断网）：界面仍显示成功，绝不显示「兑换失败」（表驱动 2 行）', async (t) => {
  for (const row of REFRESH_FAIL_ROWS) {
    t.diagnostic(`P4/${row.id} ${row.name} → 界面仍显示兑换成功（绝不显示「兑换失败」），额度稍后刷新`)
    prepare({
      apiKey: OLD_KEY,
      table: {
        // 打开弹层 → 300；兑换成功后的那次刷新 → 失败；用户手动再刷 → 400
        'GET /me': [TRANSPORT.json(200, profile(300)), row.refreshReply, TRANSPORT.json(200, profile(400))],
        [EMAIL_PROBE]: [EMAIL_DISABLED],
        'POST /redeem-card': [
          TRANSPORT.json(200, { ok: true, points: 100, quota_points: 400, remaining_points: 400 }),
        ],
      },
    })
    const view = await harness.mount(OursServicesRow, {})
    await view.type('ours-redeem-input', CARD)
    await view.click('ours-redeem-submit')

    // ---- 1. 兑换结论：成功。额度刷新失败不能把这句话改掉
    const result = view.text('ours-redeem-result')
    assert.equal(
      result.includes(zh.oursRedeemSuccess.replace('{points}', `100 ${zh.oursPointsUnit}`)),
      true,
      `兑换成功文案被盖掉了：${result}`
    )
    assert.equal(result.includes('失败'), false, `额度刷新失败不能写成兑换失败：${result}`)
    assert.equal(result.includes(zh.oursErrTimeout), false, '额度错误不能串到兑换结果区')
    assert.equal(result.includes(zh.oursErrNetwork), false, '额度错误不能串到兑换结果区')

    // ---- 2. 额度区如实报错（错的是「刷新」，不是「兑换」），并留着重试入口
    assert.equal(view.text('ours-quota-value'), zh[row.expectedKey], '额度区要如实说清刷新失败的原因')
    assert.equal(view.has('ours-quota-refresh'), true, '刷新失败要留「刷新额度」按钮')

    // ---- 3. 重试的是 /me，不是兑换：再兑一次才是真正的重复扣卡
    const before = harness.ctx.paths.filter((path) => path === 'POST /redeem-card').length
    await view.click('ours-quota-refresh')
    assert.equal(view.text('ours-quota-value'), `400 ${zh.oursPointsUnit}`, '手动刷新后额度应显示 400')
    assert.equal(
      harness.ctx.paths.filter((path) => path === 'POST /redeem-card').length,
      before,
      '刷新额度绝不能重发 /redeem-card'
    )
    assert.equal(
      view.text('ours-redeem-result').includes(zh.oursRedeemSuccess.replace('{points}', `100 ${zh.oursPointsUnit}`)),
      true,
      '刷新成功后兑换结果仍然是成功（不因中间失败而改写）'
    )
      view.unmount()
  }
})

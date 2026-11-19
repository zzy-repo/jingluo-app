// [layer: unit —— 组件级（真弹层组件 + 真 invite services，假传输 + 假时钟），零浏览器 | 耗时: <3s]
// Issue #427 —— 邮箱适配回归基线（界面层）：提示分流 / 交互反馈。
//
// 覆盖两组，都是「改坏了用户直接看到错的东西」的那类：
//   1. **提示分流**：已绑邮箱的用户不再被催「复制设备码备份」（#421 第 5 点）。
//      绑上邮箱之后账号能靠邮箱找回，那条提示的前提就没了；反过来，没绑的人设备码仍是唯一凭据，
//      提示必须照旧出现 —— 两个方向都要断言，只测一边等于没测。
//   2. **交互反馈**：`retry_after` / `attempts_left` / `bound_email_masked` 三个附加字段
//      在界面上真的变成了用户读得懂的话（多少秒后再试 / 还剩几次机会 / 已绑的是哪个邮箱）。
//
// 时间与网络：**零真实等待、零真实请求**。所有响应由 harness 的假 transport 给出；
// 涉及时间的那条用假时钟（Date.now 冻结 + 记录所有非零延时定时器），证明文案里的秒数
// 完全来自服务端 `retry_after`，与本地时钟无关。
//
// 未覆盖（如实记录，见 docs/testing/email-regression.md）：秒级倒计时器当前**不存在**
// —— 实现只在结果区显示一次「N 秒后再试」的静态文案，没有逐秒递减的 UI 状态。
//
//   node tests/run-layer.mjs unit --only email-427
//   pnpm test:email
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource('src/components/settings/OursServicesDialog.tsx')
const { DEVICE_ID_STORAGE_KEY, DEVICE_BACKUP_HINT_KEY } = await harness.importSource(
  'src/services/invite/device.ts'
)
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-77777777777777777777777777777777'
const OTHER_DEVICE = 'd-88888888888888888888888888888888'
const KEY = 'sk-ours-device-code-0011223344556677'
const MASKED = 'e***@example.com'
const EMAIL = 'someone@example.com'

/** 文案插值：与生产 `createTranslate` 同一套规则（`{name}` → 参数） */
const fill = (template, params) =>
  template.replaceAll(/\{(\w+)\}/gu, (placeholder, name) =>
    name in params ? String(params[name]) : placeholder
  )

const profile = (extra = {}) => ({
  invite_code: 'K3M9QW2P',
  invited_count: 0,
  max_invites: 3,
  bonus_points: 0,
  redeemed: false,
  quota_points: 300,
  used_points: 0,
  remaining_points: 300,
  key_status: 'active',
  device_id: DEVICE,
  ...extra,
})

/**
 * 统一准备：`/me` 回显请求里的 device_id，`/email/status` 回 `emailStatus`，
 * `/email/send-code` 与 `/email/verify` 回给到的结果。其余路径一律抛（宁可红，也不许悄悄打别的接口）。
 */
const prepare = ({ emailStatus, send = null, verify = null, body = null, hintSeen = null }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  globalThis.localStorage.setItem(DEVICE_ID_STORAGE_KEY, DEVICE)
  if (hintSeen !== null) {
    globalThis.localStorage.setItem(DEVICE_BACKUP_HINT_KEY, hintSeen)
  }
  harness.ctx.oursOpen = true
  harness.ctx.reply((request) => {
    if (request.path === '/email/status') {
      return emailStatus
    }
    if (request.path === '/email/send-code') {
      if (send === null) {
        throw new Error('本用例不准备发验证码，却收到了 /email/send-code')
      }
      return send
    }
    if (request.path === '/email/verify') {
      if (verify === null) {
        throw new Error('本用例不准备提交验证码，却收到了 /email/verify')
      }
      return verify
    }
    if (request.method === 'GET' && request.path === '/me') {
      return TRANSPORT.json(
        200,
        body ?? profile({ device_id: new URL(request.url).searchParams.get('device_id') })
      )
    }
    throw new Error(`未准备的请求：${request.method} ${request.path}`)
  })
}

/** 展开表单 → 填邮箱 → 点「发送验证码」 */
const sendCode = async (view) => {
  await view.click('ours-email-bind')
  await view.type('ours-email-input', EMAIL)
  await view.click('ours-email-send')
}

/** 再填 6 位验证码 → 点「提交验证码」 */
const verifyCode = async (view, code = '123456') => {
  await view.type('ours-email-code', code)
  await view.click('ours-email-verify')
}

/**
 * 假时钟：冻结 `Date.now`，并把所有**非零延时**的 setTimeout 记下来而不真正排程。
 * 用来证明两件事：文案里的秒数不是本地算的；整条链路零 sleep（没有非零定时器）。
 */
const installFakeClock = () => {
  const realSetTimeout = globalThis.setTimeout
  const realNow = Date.now
  const scheduled = []
  let now = 1_760_000_000_000
  Date.now = () => now
  globalThis.setTimeout = (handler, delay, ...rest) => {
    if (typeof delay === 'number' && delay > 0) {
      scheduled.push(delay)
      return realSetTimeout(() => {}, 0)
    }
    return realSetTimeout(handler, delay, ...rest)
  }
  return {
    advance(ms) {
      now += ms
    },
    scheduled,
    restore() {
      globalThis.setTimeout = realSetTimeout
      Date.now = realNow
    },
  }
}

// ================================================================ J. 提示分流

test('J1 已绑邮箱（备份提示还没确认过）→ 也不出现「复制设备码备份」', async () => {
  prepare({ emailStatus: TRANSPORT.json(200, { has_email: true, email_masked: MASKED }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-email-masked'), true)
  assert.equal(
    view.has('ours-device-backup-hint'),
    false,
    '提示的前提是「设备码 = 账号，丢了找不回」；能靠邮箱找回就不成立'
  )
  view.unmount()
})

test('J2 对照：未绑邮箱 + 首次进入 → 备份提示照旧出现（没绑的人设备码仍是唯一凭据）', async () => {
  prepare({ emailStatus: TRANSPORT.json(200, { has_email: false }) })
  const view = await harness.mount(OursServicesRow, {})

  assert.equal(view.has('ours-device-backup-hint'), true)
  assert.ok(view.text('ours-device-backup-hint').includes(zh.oursDeviceBackupHint))
  view.unmount()
})

test('J3 绑定成功之后（同一次会话内）备份提示立刻消失，不必重开弹层', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    verify: TRANSPORT.json(200, { action: 'bound', has_email: true, email_masked: MASKED }),
  })
  const view = await harness.mount(OursServicesRow, {})
  assert.equal(view.has('ours-device-backup-hint'), true, '绑定之前提示还在')

  await view.click('ours-email-bind')
  await view.type('ours-email-input', EMAIL)
  await verifyCode(view)

  assert.equal(view.has('ours-device-backup-hint'), false, '刚绑上邮箱，提示的前提当场失效')
  assert.equal(view.text('ours-email-masked'), MASKED)
  view.unmount()
})

// ================================================================ K. 交互反馈

test('K1 发送被频控：retry_after 原样变成「N 秒后再试」，本地时钟不参与计算', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: TRANSPORT.json(429, { error: { code: 'too_frequent', retry_after: 42 } }),
  })
  const clock = installFakeClock()
  try {
    const view = await harness.mount(OursServicesRow, {})
    await sendCode(view)

    const text = view.text('ours-email-result')
    assert.ok(text.includes(zh.oursInviteErrEmailTooFrequent), `频控文案：${text}`)
    assert.ok(
      text.includes(fill(zh.oursEmailRetryAfter, { seconds: 42 })),
      `秒数必须是服务端给的 42：${text}`
    )
    assert.equal(text.includes('42 秒后再试'), true)

    // 本地时间往前走 41 秒，文案不变 —— 秒数不是本地倒计时算出来的
    clock.advance(41_000)
    await view.settle()
    assert.equal(view.text('ours-email-result'), text, '文案不许随本地时钟漂移')
    // 零 sleep：整条链路没有排过任何非零延时定时器
    assert.deepEqual(clock.scheduled, [], `不该排真等待，实际排了 ${clock.scheduled.join(',')}`)
    view.unmount()
  } finally {
    clock.restore()
  }
})

test('K2 验证码错：attempts_left 变成「还剩 N 次机会」（0 也要显示）', async () => {
  for (const [attempts, expected] of [
    [4, fill(zh.oursEmailAttemptsLeft, { attempts: 4 })],
    [0, fill(zh.oursEmailAttemptsLeft, { attempts: 0 })],
  ]) {
    prepare({
      emailStatus: TRANSPORT.json(200, { has_email: false }),
      verify: TRANSPORT.json(400, { error: { code: 'code_invalid', attempts_left: attempts } }),
    })
    const view = await harness.mount(OursServicesRow, {})
    await view.click('ours-email-bind')
    await view.type('ours-email-input', EMAIL)
    await verifyCode(view)

    const text = view.text('ours-email-result')
    assert.ok(text.includes(zh.oursInviteErrEmailCodeInvalid), `验证码错文案：${text}`)
    assert.ok(text.includes(expected), `剩余次数（${attempts}）：${text}`)
    view.unmount()
  }
})

test('K3 409 已绑邮箱：显示的是「已绑过邮箱」+ 已绑的那个脱敏地址，不是「已绑定邀请码」', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    verify: TRANSPORT.json(409, {
      error: { code: 'customer_has_email', bound_email_masked: MASKED },
    }),
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-email-bind')
  await view.type('ours-email-input', EMAIL)
  await verifyCode(view)

  const text = view.text('ours-email-result')
  assert.ok(text.includes(zh.oursInviteErrCustomerHasEmail), `必须是「已绑过邮箱」：${text}`)
  assert.equal(
    text.includes(zh.oursInviteErrAlreadyRedeemed),
    false,
    '这条正是 #421 点名的误报：邮箱 409 不许显示成「邀请码已绑定」'
  )
  assert.ok(
    text.includes(fill(zh.oursEmailBoundMaskedHint, { masked: MASKED })),
    `已绑的是哪个邮箱也要说：${text}`
  )
  view.unmount()
})

test('K4 login 成功：设备码切到服务端值、Key 落到渠道配置、界面不出现 Key 原文', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    verify: TRANSPORT.json(200, {
      action: 'login',
      device_id: OTHER_DEVICE,
      key: KEY,
      email_masked: MASKED,
    }),
  })
  const clock = installFakeClock()
  try {
    const view = await harness.mount(OursServicesRow, {})
    await view.click('ours-email-bind')
    await view.type('ours-email-input', EMAIL)
    await verifyCode(view)

    assert.equal(view.text('ours-email-result'), zh.oursEmailLoginOk)
    assert.equal(view.text('ours-device-code'), OTHER_DEVICE, '采用之后界面必须显示新设备码')
    assert.equal(
      globalThis.localStorage.getItem(DEVICE_ID_STORAGE_KEY),
      OTHER_DEVICE,
      '内存里的设备码也要跟着换，否则下次冷启动又回到旧号'
    )
    assert.deepEqual(harness.ctx.keyWrites, [KEY], 'Key 走 setApiKey 落盘（与 /apply、/bind 同一个口）')
    assert.equal(view.html().includes(KEY), false, '界面上不许出现 Key 原文')
    assert.deepEqual(clock.scheduled, [], '零 sleep')
    view.unmount()
  } finally {
    clock.restore()
  }
})

test('K5 bound 成功：设备码不动、不落 Key，成功文案与「绑定已有 Key」同一条', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    verify: TRANSPORT.json(200, { action: 'bound', device_id: OTHER_DEVICE, key: KEY, email_masked: MASKED }),
  })
  const view = await harness.mount(OursServicesRow, {})
  await view.click('ours-email-bind')
  await view.type('ours-email-input', EMAIL)
  await verifyCode(view)

  assert.equal(view.text('ours-email-result'), zh.oursBindOk)
  assert.equal(view.text('ours-device-code'), DEVICE, 'bound 分支不看 server device_id')
  assert.equal(globalThis.localStorage.getItem(DEVICE_ID_STORAGE_KEY), DEVICE)
  assert.deepEqual(harness.ctx.keyWrites, [], '绑定分支绝不碰 Key')
  view.unmount()
})

test('K6 发码请求是真的发出去了：路径、body 与 UI 输入一致（不是只改了界面状态）', async () => {
  prepare({
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: TRANSPORT.json(200, { resend_after: 60 }),
  })
  const view = await harness.mount(OursServicesRow, {})
  await sendCode(view)

  const sent = harness.ctx.requests.find((request) => request.path === '/email/send-code')
  assert.ok(sent, '必须真的发了一次 /email/send-code')
  assert.equal(sent.method, 'POST')
  assert.deepEqual(sent.json, { device_id: DEVICE, email: EMAIL })
  assert.equal(view.has('ours-email-sent'), true, '发送成功后给「已发送」提示')
  assert.equal(view.text('ours-email-sent'), zh.oursEmailSentHint)
  view.unmount()
})

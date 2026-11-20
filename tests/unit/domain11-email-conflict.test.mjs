// [layer: unit —— 组件级（真弹层组件 + 真 api/email/emailCooldown，假传输），零浏览器 | 耗时: <3s]
// Issue #421 第 3 点（登录冲突弹窗）与第 4 点（发码倒计时 / 剩余次数）。
// 域 11 落位（#438）：冲突弹窗与逐秒倒计时需要**假定时器**逐秒 tick，只有组件级 L0 做得到；
// L1（真浏览器）只验「真实倒计时会把按钮锁住」那一条，不重复这里的秒级断言。
//
// 验收报告（`issuecomment-7025138020`）判 FAIL 的两项就在这里兜住：
//   C  —— `device_has_account` 不再落到「操作失败，请稍后重试」，而是弹窗展示
//         `email_masked` + `device_remaining_points`，并让用户在
//         `use_email` / `keep_device` 之间选，然后**带同一个验证码**重发 `/email/verify`。
//   D3 —— 发送按钮按 `resend_after`（发码成功后）与 `retry_after`（429 频控）**逐秒递减**，
//         倒计时期间 disabled，归零后可点；验证码错误时显示 `attempts_left`。
//
// 断言点（域 11 的冲突 / 倒计时就只有这一份，别在别处再写一遍）：
//   C1 冲突响应 → 弹窗出现；`device_remaining_points` 的**数字出现在界面上**；
//      脱敏邮箱出现；「切换后额度暂时无法使用 / 需客服处理」在文案里；
//      第一次 `/email/verify` 的 body **没有 choice**（不替用户先选），验证码输入框仍在（没被消耗）。
//   C2 点 `use_email` → 第二次 `/email/verify` body 的 `code` / `email` 与第一次**完全一致**、
//      `choice === 'use_email'`；成功后设备码与 Key 切到原账号、弹窗消失。
//   C3 点 `keep_device` → `choice === 'keep_device'`；设备码与 Key 一个字不动（保留本机账号）。
//   D1 `resend_after: 60` → 按钮 disabled 且文案「60 秒后可重发」；每秒递减 59 → 58；
//      倒计时期间点不动；归零后按钮恢复可点、文案回到「发送验证码」。
//   D2 429 `too_frequent` + `retry_after: 30` → 按钮同样进入倒计时，错误文案里的秒数**跟着递减**。
//   D3 `code_invalid` + `attempts_left: 4` → 显示「还剩 4 次机会」。
//   P  （纯函数）冲突解析（缺 options → 两个都给 / 坏 options 被忽略）与倒计时边界
//      （null / 0 / 负数 / 超过小时级上限 → 不倒计时；向上取整语义）。
//
// 服务端邮箱功能只在开发分支，本文件全部用假传输，**不发任何真请求**；真机端到端不在此假装验证。
//
//   node --test tests/unit/domain11-email-conflict.test.mjs
// #507：`__ENDPOINTS__` 全局兜底 —— 装载即挂（幂等）。单跑本文件（不经 run-layer 的 `--import` 预加载）也不会
// `ReferenceError: __ENDPOINTS__ is not defined`；走门禁时与预加载是同一份模块，无副作用叠加。
import '../helpers/injected.mjs'

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness, TRANSPORT } from '../fixtures/domain06-07/harness.mjs'

const harness = await createHarness()
const { OursServicesRow } = await harness.importSource('src/components/settings/OursServicesDialog.tsx')
const { DEVICE_ID_STORAGE_KEY, DEVICE_BACKUP_HINT_KEY } = await harness.importSource(
  'src/services/invite/device.ts'
)
const api = await harness.importSource('src/services/invite/api.ts')
const cooldown = await harness.importSource('src/services/invite/emailCooldown.ts')
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-11111111111111111111111111111111'
const OTHER_DEVICE = 'd-22222222222222222222222222222222'
const KEY = 'sk-ours-device-code-0011223344556677'
const OTHER_KEY = 'sk-ours-email-account-8899aabbccddeeff'
const EMAIL = 'user@example.com'
const MASKED = 'e***@example.com'
const CODE = '123456'

/** 服务端「本机已有账号」的原始响应（#421 第 3 点原文，字段一个不改） */
const CONFLICT_BODY = {
  error: {
    code: 'device_has_account',
    device_remaining_points: 100.0,
    options: ['use_email', 'keep_device'],
    email_masked: MASKED,
  },
}

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
 * 统一准备：`/me` 回显请求里的 device_id，`/email/status` 给 `emailStatus`，
 * `/email/send-code` 与 `/email/verify` 按第几次调用给 `send` / `verify` 的返回值。
 * 其余路径一律报错（宁可红，也不许悄悄打到别的接口）。
 */
const prepare = ({ emailStatus, send, verify }) => {
  harness.ctx.reset()
  harness.ctx.apiKey = KEY
  globalThis.localStorage.setItem(DEVICE_ID_STORAGE_KEY, DEVICE)
  globalThis.localStorage.setItem(DEVICE_BACKUP_HINT_KEY, 'seen')
  harness.ctx.oursOpen = true
  const calls = { send: 0, verify: 0 }
  harness.ctx.reply((request) => {
    if (request.path === '/email/status') {
      return emailStatus
    }
    if (request.method === 'GET' && request.path === '/me') {
      return TRANSPORT.json(
        200,
        profile({ device_id: new URL(request.url).searchParams.get('device_id') })
      )
    }
    if (request.method === 'POST' && request.path === '/email/send-code') {
      calls.send += 1
      return send(calls.send, request)
    }
    if (request.method === 'POST' && request.path === '/email/verify') {
      calls.verify += 1
      return verify(calls.verify, request)
    }
    throw new Error(`未准备的请求：${request.method} ${request.path}`)
  })
  return calls
}

/** 展开邮箱表单 → 填邮箱 → 发码（两步都是为了走到「填验证码」那一步） */
const openFormAndSend = async (view, sendBody = { resend_after: 60 }) => {
  await view.click('ours-email-bind')
  await view.type('ours-email-input', EMAIL)
  await view.click('ours-email-send')
  return sendBody
}

/**
 * 挂载弹层并把「一定要卸载」这件事挂到用例上（`t.after`）。
 *
 * 不这么做的话：断言一红就跳过了 `view.unmount()`，组件里那个每秒 tick 的
 * `setInterval` 会一直挂着 —— node --test 于是等不到事件循环空闲（实测整文件挂住不退出）。
 */
const mountDialog = async (t, options) => {
  const calls = prepare(options)
  const view = await harness.mount(OursServicesRow, {})
  t.after(() => view.unmount())
  return { view, calls }
}

/** 最近一次 `/email/verify` 的请求（重发会追加一条，别按索引数） */
const lastVerify = () => {
  const found = [...harness.ctx.requests].reverse().find((request) => request.path === '/email/verify')
  assert.ok(found !== undefined, '没有发出 /email/verify 请求')
  return found
}

/** 按「第几次」从数组里取响应，取完就不再变（多取 = 用例写错） */
const nth = (replies) => (count) => {
  const reply = replies[count - 1]
  assert.ok(reply !== undefined, `第 ${count} 次请求没有准备响应（只准备了 ${replies.length} 个）`)
  return reply
}

const verifyBody = (request) => request.json ?? {}

// ---------------------------------------------------------------- C. 登录冲突弹窗

test('C1 device_has_account → 弹窗展示 remaining_points + 脱敏邮箱 + 「额度暂时无法使用」，验证码不消耗', async (t) => {
  const { view, calls } = await mountDialog(t, {
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: () => TRANSPORT.json(200, { resend_after: 60 }),
    verify: () => TRANSPORT.json(409, CONFLICT_BODY),
  })
  await openFormAndSend(view)
  await view.type('ours-email-code', CODE)
  await view.click('ours-email-verify')

  // 断言点：弹窗出现（而不是「操作失败，请稍后重试」那一行）
  assert.equal(view.has('ours-email-conflict'), true, 'device_has_account 必须弹窗，不能落成普通错误')
  assert.equal(view.has('ours-email-result'), false, '冲突不是错误，不许出现错误文案框')

  // 断言点：额度数字必须上屏（这是 #421 第 3 点的硬要求）
  const pointsLine = view.text('ours-email-conflict-points')
  assert.ok(pointsLine.includes('100'), `额度数字必须出现在弹窗里，实际：${pointsLine}`)
  assert.equal(pointsLine, zh.oursEmailConflictPoints.replace('{points}', '100 积分'))

  // 断言点：脱敏邮箱原样展示（不改写、不还原）
  assert.equal(view.text('ours-email-conflict-masked'), zh.oursEmailConflictEmail.replace('{masked}', MASKED))

  // 断言点：取舍后果必须写清楚（服务端不合并 / 数据保留 / 需客服处理）
  const warning = view.text('ours-email-conflict-warning')
  assert.equal(warning, zh.oursEmailConflictWarning)
  assert.ok(warning.includes('暂时无法使用'), '必须说明切换后本机原账号额度暂时用不了')
  assert.ok(warning.includes('客服'), '必须说明要客服处理（服务端不自动合并）')

  // 断言点：还没选之前**不能**带 choice（不替用户先做决定），且这次是三字段的第一次提交
  assert.equal(calls.verify, 1)
  const first = verifyBody(lastVerify())
  assert.deepEqual(Object.keys(first).sort(), ['code', 'device_id', 'email'])
  assert.equal(first.code, CODE, '冲突那次验证码就发出去了 —— 服务端没消耗，客户端要留着')

  // 断言点：验证码输入框还在（表单没被关掉）、里面的值没被清空，用户可以选完直接重发
  assert.equal(view.node('ours-email-code').props.value, CODE, '验证码要留在输入框里，冲突那次没被消耗')
})

test('C2 选「用邮箱账号」→ 带同一验证码 + choice:"use_email" 重发 → 切到原账号', async (t) => {
  const { view, calls } = await mountDialog(t, {
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: () => TRANSPORT.json(200, { resend_after: 60 }),
    verify: nth([
      TRANSPORT.json(409, CONFLICT_BODY),
      TRANSPORT.json(200, {
        action: 'login',
        device_id: OTHER_DEVICE,
        key: OTHER_KEY,
        email_masked: MASKED,
        has_email: true,
      }),
    ]),
  })
  await openFormAndSend(view)
  await view.type('ours-email-code', CODE)
  await view.click('ours-email-verify')
  const beforeSwitch = verifyBody(lastVerify())

  await view.click('ours-email-conflict-use-email')

  // 断言点：第二次请求 = 同一个验证码 + 同一个邮箱 + choice
  assert.equal(calls.verify, 2)
  const afterSwitch = verifyBody(lastVerify())
  assert.equal(afterSwitch.choice, 'use_email')
  assert.equal(afterSwitch.code, beforeSwitch.code, '必须带**同一个**验证码（服务端没消耗过它）')
  assert.equal(afterSwitch.email, beforeSwitch.email)
  assert.equal(afterSwitch.device_id, beforeSwitch.device_id)

  // 断言点：登录成功后设备码 / Key 切成原账号（走 adoptServerDeviceId，不是另写一套）
  assert.equal(globalThis.localStorage.getItem(DEVICE_ID_STORAGE_KEY), OTHER_DEVICE)
  assert.equal(harness.ctx.apiKey, OTHER_KEY)

  // 断言点：弹窗收起，成功文案说明「已切换到原账号」
  assert.equal(view.has('ours-email-conflict'), false)
  assert.equal(view.text('ours-email-result'), zh.oursEmailLoginOk)
})

test('C3 选「保留本机账号」→ choice:"keep_device" 重发 → 设备码与 Key 一个字不动', async (t) => {
  const { view, calls } = await mountDialog(t, {
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: () => TRANSPORT.json(200, { resend_after: 60 }),
    verify: nth([
      TRANSPORT.json(409, CONFLICT_BODY),
      TRANSPORT.json(200, { action: 'bound', email_masked: MASKED, has_email: true }),
    ]),
  })
  await openFormAndSend(view)
  await view.type('ours-email-code', CODE)
  await view.click('ours-email-verify')
  await view.click('ours-email-conflict-keep-device')

  assert.equal(calls.verify, 2)
  assert.equal(verifyBody(lastVerify()).choice, 'keep_device')
  // 断言点：保留本机账号 = 不换设备码、不换 Key
  assert.equal(globalThis.localStorage.getItem(DEVICE_ID_STORAGE_KEY), DEVICE)
  assert.equal(harness.ctx.apiKey, KEY)
  assert.equal(view.has('ours-email-conflict'), false)
  assert.equal(view.text('ours-email-result'), zh.oursBindOk)
})

// ---------------------------------------------------------------- D3. 倒计时 / 剩余次数

test('D1 resend_after:60 → 按钮 disabled 且逐秒递减，归零后可点', async (t) => {
  // 只 mock setInterval 与 Date：`settle()` 靠真 setTimeout 让出 macrotask，mock 掉就永远等不到
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 })

  const { view, calls } = await mountDialog(t, {
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: () => TRANSPORT.json(200, { resend_after: 60 }),
    verify: () => TRANSPORT.json(409, CONFLICT_BODY),
  })
  await openFormAndSend(view)

  // 断言点：发码成功 → 立刻进入 60 秒倒计时，按钮禁用、文案给出剩余秒数
  assert.equal(view.node('ours-email-send').props.disabled, true, '倒计时期间发送按钮必须 disabled')
  assert.equal(view.text('ours-email-send'), zh.oursEmailSendCountdown.replace('{seconds}', '60'))

  // 断言点：逐秒递减（1 → 59，2 → 58）
  t.mock.timers.tick(1000)
  await view.settle()
  assert.equal(view.text('ours-email-send'), zh.oursEmailSendCountdown.replace('{seconds}', '59'))
  t.mock.timers.tick(1000)
  await view.settle()
  assert.equal(view.text('ours-email-send'), zh.oursEmailSendCountdown.replace('{seconds}', '58'))

  // 断言点：倒计时期间点不动（组件真的把 disabled 传给按钮，不是只改文案）
  await assert.rejects(() => view.click('ours-email-send'), /禁用态/)
  assert.equal(calls.send, 1, '倒计时期间不许再发码')

  // 断言点：归零 → 按钮恢复可点、文案回到「发送验证码」
  t.mock.timers.tick(58_000)
  await view.settle()
  assert.equal(view.node('ours-email-send').props.disabled, false)
  assert.equal(view.text('ours-email-send'), zh.oursEmailSendAction)
  await view.click('ours-email-send')
  assert.equal(calls.send, 2, '归零后应当能再发一次')
})

test('D2 429 too_frequent + retry_after:30 → 按钮同样倒计时，错误文案里的秒数跟着递减', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_700_000_000_000 })

  const { view } = await mountDialog(t, {
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: () => TRANSPORT.json(429, { error: { code: 'too_frequent', retry_after: 30 } }),
    verify: () => TRANSPORT.json(409, CONFLICT_BODY),
  })
  await openFormAndSend(view)

  // 断言点：频控错误 → 文案 + 按钮倒计时（不能只给一句静态文案然后让用户连点）
  assert.equal(view.node('ours-email-send').props.disabled, true)
  assert.equal(view.text('ours-email-send'), zh.oursEmailSendCountdown.replace('{seconds}', '30'))
  assert.ok(view.text('ours-email-result').includes(zh.oursEmailRetryAfter.replace('{seconds}', '30')))

  // 断言点：错误文案里的秒数与按钮同步递减（静态数字过一秒就不对了）
  t.mock.timers.tick(1000)
  await view.settle()
  assert.equal(view.text('ours-email-send'), zh.oursEmailSendCountdown.replace('{seconds}', '29'))
  assert.ok(
    view.text('ours-email-result').includes(zh.oursEmailRetryAfter.replace('{seconds}', '29')),
    '错误文案要跟着倒计时走'
  )
})

test('D3 验证码错误 → 显示 attempts_left（还剩几次机会）', async (t) => {
  const { view } = await mountDialog(t, {
    emailStatus: TRANSPORT.json(200, { has_email: false }),
    send: () => TRANSPORT.json(200, { resend_after: 60 }),
    verify: () => TRANSPORT.json(400, { error: { code: 'code_invalid', attempts_left: 4 } }),
  })
  await openFormAndSend(view)
  await view.type('ours-email-code', '000000')
  await view.click('ours-email-verify')

  const result = view.text('ours-email-result')
  assert.ok(result.includes(zh.oursInviteErrEmailCodeInvalid), result)
  assert.ok(result.includes(zh.oursEmailAttemptsLeft.replace('{attempts}', '4')), result)
})

// ---------------------------------------------------------------- P. 纯函数（同一份契约的直接断言）

test('P1 冲突解析：缺 options → 两个都给；坏 options 被忽略；额度 / 脱敏邮箱原样带出', async () => {
  const transport = async () => TRANSPORT.json(409, CONFLICT_BODY)
  const result = await api.verifyEmailCode(
    { deviceId: DEVICE, email: EMAIL, code: CODE },
    transport
  )
  assert.equal(result.kind, 'conflict')
  assert.equal(result.emailMasked, MASKED)
  assert.equal(result.deviceRemainingPoints, 100)
  assert.deepEqual(result.options, ['use_email', 'keep_device'])

  const noOptions = await api.verifyEmailCode({ deviceId: DEVICE, email: EMAIL, code: CODE }, async () =>
    TRANSPORT.json(409, { error: { code: 'device_has_account' } })
  )
  assert.deepEqual(noOptions.options, ['use_email', 'keep_device'], '服务端没给 options 时按契约的两个都给')

  const junkOptions = await api.verifyEmailCode({ deviceId: DEVICE, email: EMAIL, code: CODE }, async () =>
    TRANSPORT.json(409, {
      error: { code: 'device_has_account', options: ['use_email', 'merge_everything'] },
    })
  )
  assert.deepEqual(junkOptions.options, ['use_email'], '不认识的选项一律丢掉（客户端不实现没约定的语义）')
})

test('P2 冲突分支不落到「操作失败」：只有 device_has_account 走 conflict，别的 409 仍是错误', async () => {
  const conflict = await api.verifyEmailCode({ deviceId: DEVICE, email: EMAIL, code: CODE }, async () =>
    TRANSPORT.json(409, CONFLICT_BODY)
  )
  assert.equal(conflict.kind, 'conflict')

  const other = await api.verifyEmailCode({ deviceId: DEVICE, email: EMAIL, code: CODE }, async () =>
    TRANSPORT.json(409, { error: { code: 'customer_has_email', bound_email_masked: MASKED } })
  )
  assert.equal(other.kind, 'error')
  assert.equal(other.messageKey, 'oursInviteErrCustomerHasEmail')
})

test('P3 倒计时纯函数：不倒计时的三种情形 + 向上取整 + 归零', () => {
  const NOW = 1_700_000_000_000
  assert.equal(cooldown.startEmailCooldown(null, NOW), null, '服务端没给秒数 → 不倒计时')
  assert.equal(cooldown.startEmailCooldown(0, NOW), null)
  assert.equal(cooldown.startEmailCooldown(-5, NOW), null)
  assert.equal(cooldown.startEmailCooldown(Number.NaN, NOW), null)

  const sixty = cooldown.startEmailCooldown(60, NOW)
  assert.deepEqual(sixty, { untilMs: NOW + 60_000, totalSeconds: 60 })
  assert.equal(cooldown.emailCooldownRemaining(sixty, NOW), 60, '起手就是 60，不是 59')
  assert.equal(cooldown.emailCooldownRemaining(sixty, NOW + 500), 60)
  assert.equal(cooldown.emailCooldownRemaining(sixty, NOW + 1000), 59)
  assert.equal(cooldown.emailCooldownRemaining(sixty, NOW + 60_000), 0)
  assert.equal(cooldown.emailCooldownRemaining(sixty, NOW + 99_999), 0)
  assert.equal(cooldown.emailCooldownRemaining(null, NOW), 0)

  // 小时级限流不做秒级倒计时（#421 验收：小时级显示「稍后再试」）
  assert.equal(cooldown.startEmailCooldown(3600, NOW), null)
  assert.equal(cooldown.startEmailCooldown(cooldown.EMAIL_COOLDOWN_MAX_SECONDS + 1, NOW), null)
  assert.notEqual(cooldown.startEmailCooldown(cooldown.EMAIL_COOLDOWN_MAX_SECONDS, NOW), null)
})

test('P4 中文文案与阈值：冲突文案不许暗示「自动合并」，只能是否定式表述', () => {
  assert.ok(zh.oursEmailConflictWarning.includes('不自动合并'), '只允许否定式「不自动合并」')
  assert.ok(!/更安全|防止被盗/.test(zh.oursEmailConflictWarning))
  assert.ok(zh.oursEmailSendCountdown.includes('{seconds}'), '倒计时文案必须带秒数占位符')
})

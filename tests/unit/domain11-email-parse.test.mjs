// [layer: unit | 依赖: 无（纯 Node，假 transport，零浏览器零网络） | 耗时: <1s]
//
// 域 11（邮箱账号，Issue #421）的 L0 回归基准 —— Issue #438 按五层落位的第一层。
//
// 这一层只钉**判断**，四张表各管一件事（表驱动，不为覆盖率堆用例）：
//   T1 三态解析：`has_email` / `email_masked` 缺字段 = `null`（= 服务端没有这个功能），
//      **不是** `false`（= 服务端明确说「没绑」）。把两者混成 boolean，界面就会在老部署上
//      渲染一个点了必然报错的「绑定邮箱」按钮。
//   T2 请求形态：两个 `/email/*` 写接口的路径 / body 字段集 / 超时 / 不跟随重定向 / 指纹降级。
//      多带一个字段、少带一个超时，都是「看起来没坏、实际换了个语义」的改动。
//   T3 错误码：13 条服务端错误码 → 文案 key 逐条命中，**409 必须先按 `error.code` 匹配**
//      （按状态码先匹配会把 `customer_has_email` 显示成「已绑定过邀请码」）；附加字段
//      （`attempts_left` / `retry_after` / `bound_email_masked` / `device_remaining_points`）
//      必须原样带出来，`device_has_account` 必须翻成冲突（不是错误）。
//   T4 功能探测：只有 `404 + error.code === "not_found"` 才算「服务端没开」→ 隐藏入口；
//      `404 + device_not_found`（这台设备没记录）与网络失败都不是「没开」，但也同样不出入口。
//
// 服务端邮箱功能在生产未启用（#421 正文），本文件一条真请求都不发：所有响应由假 transport 给出。
// 「真机端到端能跑通」由 L1（`tests/integration/domain11-email-flow.test.mjs`，真浏览器）
// 与黄金层（`tests/golden/g11-email.test.mjs`）负责，本文件不假装证明它。
//
//   node --test tests/unit/domain11-email-parse.test.mjs
//
// 关联：#421（被测功能）、#438（本基准）、docs/testing/coverage/domain-11.md
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const api = await import('../../src/services/invite/api.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const DEVICE = 'd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MASKED = 'e***@example.com'
const FP = '0123456789abcdef'.repeat(4)

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

const reply = (status, body) => ({
  kind: 'response',
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})

/** 假 transport：按给定响应回，同时记下请求（断言「发了什么」用） */
const fakeTransport = (response) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return typeof response === 'function' ? response(request) : response
  }
  transport.calls = calls
  return transport
}

// ---------------------------------------------------------------- T1 三态解析

/**
 * 三态表：`null`（服务端没这个字段）≠ `false`（服务端明确说没绑）。
 * 同一张表同时喂 `/me` 的档案解析（`parseInviteProfile`）与 `/email/status` 的探测解析
 * —— 两条来源口径必须一致，否则「档案说没绑、探测说没开」会在界面上打架。
 */
const TRI_STATE_ROWS = [
  { id: 'missing', what: '字段缺失 → null（老服务端 = 功能未开启）', body: {}, hasEmail: null, masked: null },
  { id: 'explicit-no', what: 'has_email:false → false，且不编造脱敏邮箱', body: { has_email: false }, hasEmail: false, masked: null },
  { id: 'bound', what: 'has_email:true + email_masked → true + 原样带出脱敏值', body: { has_email: true, email_masked: MASKED }, hasEmail: true, masked: MASKED },
  { id: 'junk', what: '垃圾值（字符串 / 数字）→ null，不当成 true 也不当成 false', body: { has_email: 'yes', email_masked: '   ' }, hasEmail: null, masked: null },
  { id: 'numeric', what: 'has_email:1（不是布尔）→ null', body: { has_email: 1 }, hasEmail: null, masked: null },
]

test('D11-T1 三态表：has_email / email_masked 缺字段 = null（≠ false），档案与探测两条来源一致', async (t) => {
  await tableTest('D11-T1', TRI_STATE_ROWS, async (row) => {
    const parsed = api.parseInviteProfile(profile(row.body))
    assert.equal(parsed.hasEmail, row.hasEmail, `parseInviteProfile.hasEmail（${row.what}）`)
    assert.equal(parsed.emailMasked, row.masked, `parseInviteProfile.emailMasked（${row.what}）`)

    const probed = await api.fetchEmailStatus(DEVICE, fakeTransport(reply(200, row.body)))
    assert.equal(probed.kind, 'ok')
    assert.equal(probed.hasEmail, row.hasEmail, `fetchEmailStatus.hasEmail（${row.what}）`)
    assert.equal(probed.emailMasked, row.masked, `fetchEmailStatus.emailMasked（${row.what}）`)
  })(t)
})

// ---------------------------------------------------------------- T2 请求形态

test('D11-T2 请求形态表：send-code / verify 的路径、body 字段集、超时、不跟随重定向、指纹降级', async () => {
  // 发码：body **只有** device_id + email（多带字段等于私自扩契约）
  const sendTransport = fakeTransport(reply(200, { resend_after: 60 }))
  const sent = await api.sendEmailCode({ deviceId: DEVICE, email: 'a@b.com' }, sendTransport, FP)
  assert.equal(sent.kind, 'ok')
  assert.equal(sent.resendAfter, 60, 'resend_after 原样带出（界面拿它起倒计时）')
  const [sendCall] = sendTransport.calls
  assert.equal(sendCall.method, 'POST')
  assert.equal(sendCall.url, `${api.INVITE_API_BASE}/email/send-code`)
  assert.deepEqual(Object.keys(JSON.parse(sendCall.body)).sort(), ['device_id', 'email'])
  assert.deepEqual(JSON.parse(sendCall.body), { device_id: DEVICE, email: 'a@b.com' })
  assert.equal(sendCall.timeoutMs, api.INVITE_TIMEOUTS.emailSend)
  assert.equal(sendCall.followRedirects, false, '写接口不跟随重定向')
  assert.equal(sendCall.headers['X-Device-Fp'], FP, '指纹形状合法才带')

  // 指纹不合格 → 头干脆不出现（降级不留痕，别把坏指纹送上去）
  const badFpTransport = fakeTransport(reply(200, {}))
  await api.sendEmailCode({ deviceId: DEVICE, email: 'a@b.com' }, badFpTransport, 'not-a-fp')
  assert.equal('X-Device-Fp' in badFpTransport.calls[0].headers, false)

  // 提交验证码：body = device_id + email + code；冲突确认时**才**多一个 choice
  const verifyTransport = fakeTransport(reply(200, { action: 'bound', has_email: true, email_masked: MASKED }))
  const verified = await api.verifyEmailCode({ deviceId: DEVICE, email: 'a@b.com', code: '123456' }, verifyTransport)
  assert.equal(verified.kind, 'ok')
  assert.equal(verified.action, 'bound')
  const [verifyCall] = verifyTransport.calls
  assert.equal(verifyCall.url, `${api.INVITE_API_BASE}/email/verify`)
  assert.deepEqual(Object.keys(JSON.parse(verifyCall.body)).sort(), ['code', 'device_id', 'email'])
  assert.equal(verifyCall.timeoutMs, api.INVITE_TIMEOUTS.emailVerify)
  assert.equal(verifyCall.followRedirects, false)

  const choiceTransport = fakeTransport(reply(200, { action: 'login', device_id: DEVICE, key: 'sk-x' }))
  await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456', choice: 'use_email' },
    choiceTransport
  )
  assert.equal(JSON.parse(choiceTransport.calls[0].body).choice, 'use_email', 'choice 只在用户选过之后才带')

  // action 缺失 / 不是 bound|login → 响应异常（绝不猜一个分支）
  for (const body of [{}, { action: 'merge' }, { action: '' }]) {
    const broken = await api.verifyEmailCode(
      { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
      fakeTransport(reply(200, body))
    )
    assert.equal(broken.kind, 'error')
    assert.equal(broken.code, 'INVALID_RESPONSE')
    assert.equal(broken.messageKey, 'oursInviteErrInvalidResponse')
  }
})

// ---------------------------------------------------------------- T3 错误码

/** 13 条服务端错误码（#421 表格逐条）：code → 该落到的文案 key */
const ERROR_ROWS = [
  { id: 'bad_email', status: 400, retryable: false },
  { id: 'email_domain_blocked', status: 400, retryable: false },
  { id: 'code_invalid', status: 400, retryable: false },
  { id: 'code_expired', status: 400, retryable: false },
  { id: 'code_locked', status: 400, retryable: false },
  { id: 'too_frequent', status: 429, retryable: true },
  { id: 'email_hour_limit', status: 429, retryable: true },
  { id: 'ip_hour_limit', status: 429, retryable: true },
  { id: 'device_hour_limit', status: 429, retryable: true },
  { id: 'email_daily_cap', status: 503, retryable: true },
  { id: 'send_failed', status: 502, retryable: true },
  { id: 'customer_has_email', status: 409, retryable: false },
  { id: 'account_frozen', status: 403, retryable: false },
]

test('D11-T3 错误码表：13 条逐条命中自己的文案，409 先按 error.code 匹配（不落到「已绑定邀请码」）', async (t) => {
  assert.equal(
    ERROR_ROWS.length,
    13,
    '表必须正好是 #421 约定的 13 条错误码（多一条少一条都要显式改这张表）'
  )
  await tableTest('D11-T3', ERROR_ROWS, async (row) => {
    const expectedKey = api.EMAIL_ERROR_KEYS[row.id]
    assert.ok(expectedKey, `${row.id} 必须在 EMAIL_ERROR_KEYS 里`)

    // 三条路径（发码 / 验码 / 探测）共用同一套映射：逐条都验，别只验一条就以为全对
    const results = [
      await api.sendEmailCode(
        { deviceId: DEVICE, email: 'a@b.com' },
        fakeTransport(reply(row.status, { error: { code: row.id } }))
      ),
      await api.verifyEmailCode(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        fakeTransport(reply(row.status, { error: { code: row.id } }))
      ),
      await api.fetchEmailStatus(
        DEVICE,
        fakeTransport(reply(row.status, { error: { code: row.id } }))
      ),
    ]
    for (const result of results) {
      assert.equal(result.kind, 'error', `${row.id} 应当判成错误`)
      assert.equal(result.code, row.id, `${row.id} 的 code 必须原样带出`)
      assert.equal(result.messageKey, expectedKey, `${row.id} 必须落到自己那条文案`)
      assert.equal(result.retryable, row.retryable, `${row.id} 的可重试判定`)
      // 409 的两个语义不能互相串：这里是本基准最贵的一条断言
      assert.notEqual(
        result.messageKey,
        'oursInviteErrAlreadyRedeemed',
        `${row.id} 绝不许显示成「已绑定过邀请码」（#421 点名的误报）`
      )
    }

    // 文案本身要真的存在，且 zh / en 一一对齐（占位符集合相等）
    assert.equal(typeof zh[expectedKey], 'string', `zh 缺 ${expectedKey}`)
    assert.equal(typeof en[expectedKey], 'string', `en 缺 ${expectedKey}`)
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(placeholders(zh[expectedKey]), placeholders(en[expectedKey]), `${expectedKey} 占位符不一致`)
  })(t)

  assert.notEqual(
    zh.oursInviteErrCustomerHasEmail,
    zh.oursInviteErrAlreadyRedeemed,
    '两条 409 文案必须真的不同，否则「先按 code 匹配」在用户眼里仍然没区别'
  )
})

test('D11-T3 附加字段与冲突分流：attempts_left / retry_after / bound_email_masked / device_has_account', async () => {
  // 只认服务端给的数字，不自己算窗口
  const invalid = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(400, { error: { code: 'code_invalid', attempts_left: 4 } }))
  )
  assert.equal(invalid.attemptsLeft, 4)
  assert.equal(invalid.retryAfter, null)

  const frequent = await api.sendEmailCode(
    { deviceId: DEVICE, email: 'a@b.com' },
    fakeTransport(reply(429, { error: { code: 'too_frequent', retry_after: 42 } }))
  )
  assert.equal(frequent.retryAfter, 42, 'retry_after 在 error 里面也要读出来')

  // 服务端把附加字段放到顶层时不丢（换位置 ≠ 换契约）
  const topLevel = await api.sendEmailCode(
    { deviceId: DEVICE, email: 'a@b.com' },
    fakeTransport(reply(429, { code: 'too_frequent', retry_after: 7 }))
  )
  assert.equal(topLevel.retryAfter, 7)

  const hasEmail = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(409, { error: { code: 'customer_has_email', bound_email_masked: MASKED } }))
  )
  assert.equal(hasEmail.boundEmailMasked, MASKED, '已绑的是哪个邮箱要让用户看到')

  // 409 没有 code / 不认识的 code → 中性文案（仍然不是「已绑定过邀请码」）
  for (const body of [{}, { error: { code: '' } }, { error: { code: 'something_new' } }]) {
    const neutral = await api.verifyEmailCode(
      { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
      fakeTransport(reply(409, body))
    )
    assert.equal(neutral.kind, 'error')
    assert.equal(neutral.messageKey, 'oursInviteErrUnknown')
  }

  // device_has_account → 冲突（不是错误）；options 缺省给两个、坏值被丢掉
  const conflictBody = {
    error: {
      code: 'device_has_account',
      device_remaining_points: 100,
      email_masked: MASKED,
      options: ['use_email', 'keep_device'],
    },
  }
  const conflict = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(409, conflictBody))
  )
  assert.equal(conflict.kind, 'conflict')
  assert.equal(conflict.deviceRemainingPoints, 100, '本机原账号剩余额度必须带出来（界面要显示）')
  assert.equal(conflict.emailMasked, MASKED)
  assert.deepEqual(conflict.options, ['use_email', 'keep_device'])

  const noOptions = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(409, { error: { code: 'device_has_account' } }))
  )
  assert.deepEqual(noOptions.options, ['use_email', 'keep_device'], '服务端没给 options 时按契约的两个都给')

  const junkOptions = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(409, { error: { code: 'device_has_account', options: ['use_email', 'merge_all'] } }))
  )
  assert.deepEqual(junkOptions.options, ['use_email'], '不认识的选项一律丢掉（客户端不实现没约定的语义）')
})

// ---------------------------------------------------------------- T4 功能探测

/** 探测判定表：什么响应算「服务端没开邮箱功能」，什么算「真错误」 */
const PROBE_ROWS = [
  {
    id: 'disabled',
    what: '404 + not_found → disabled（服务端没开这个功能）',
    response: () => reply(404, { error: { code: 'not_found', message: 'unknown path' } }),
    kind: 'disabled',
    show: false,
  },
  {
    id: 'device-not-found',
    what: '404 + device_not_found → 真错误（这台设备没记录），不许当成「功能没开」',
    response: () => reply(404, { error: { code: 'device_not_found' } }),
    kind: 'error',
    code: 'device_not_found',
    messageKey: 'oursInviteErrDeviceNotFound',
    show: false,
  },
  { id: 'bare-404', what: '404 但没有业务码（老部署 / 反代没配）→ 错误，不是 disabled', response: () => reply(404, ''), kind: 'error', code: 'HTTP_404', show: false },
  { id: 'network', what: '网络失败 → 错误，入口不出现（宁可不显示）', response: () => ({ kind: 'network' }), kind: 'error', code: 'NETWORK', show: false },
  { id: 'timeout', what: '超时 → 错误，入口不出现', response: () => ({ kind: 'timeout' }), kind: 'error', code: 'TIMEOUT', show: false },
  { id: 'bound', what: '200 + has_email:true → 入口出现（显示脱敏邮箱）', response: () => reply(200, { has_email: true, email_masked: MASKED }), kind: 'ok', show: true },
  { id: 'unbound', what: '200 + has_email:false → 入口出现（给「绑定邮箱」）', response: () => reply(200, { has_email: false }), kind: 'ok', show: true },
  { id: 'legacy', what: '200 + 缺字段 → 入口出现，三态为 null', response: () => reply(200, {}), kind: 'ok', show: true },
]

test('D11-T4 探测判定表：只有 404 + not_found 算「未开启」，其余失败一律不出入口', async (t) => {
  await tableTest('D11-T4', PROBE_ROWS, async (row) => {
    const transport = fakeTransport(row.response())
    const status = await api.fetchEmailStatus(DEVICE, transport, FP)
    assert.equal(status.kind, row.kind, `${row.what}（kind）`)
    if (row.code !== undefined) assert.equal(status.code, row.code, `${row.what}（code）`)
    if (row.messageKey !== undefined) assert.equal(status.messageKey, row.messageKey, `${row.what}（文案）`)
    assert.equal(api.shouldShowEmailEntry(status), row.show, `${row.what}（入口显隐）`)

    // 探测请求本身：只读 GET，超时与 /me 同档，带指纹（形状合法时）
    const [call] = transport.calls
    assert.equal(call.method, 'GET')
    assert.equal(
      call.url,
      `${api.INVITE_API_BASE}/email/status?device_id=${encodeURIComponent(DEVICE)}`
    )
    assert.equal(call.timeoutMs, api.INVITE_TIMEOUTS.emailStatus)
    assert.equal(call.followRedirects, false)
    assert.equal(call.headers['X-Device-Fp'], FP)
  })(t)

  // 没有设备码就不发请求（别用一个空 device_id 去问服务端「我绑没绑」）
  const emptyTransport = fakeTransport(reply(200, {}))
  const missing = await api.fetchEmailStatus('   ', emptyTransport)
  assert.equal(missing.kind, 'error')
  assert.equal(missing.code, 'DEVICE_MISSING')
  assert.equal(emptyTransport.calls.length, 0)
})

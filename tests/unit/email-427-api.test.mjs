// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发任何网络请求） | 耗时: <1s]
// Issue #427 —— 邮箱适配回归基线（契约层）：三态 / 13 条错误码逐条 / 409 先按 code /
// 无 code 时的状态码兜底 / 入口探测 / 附加字段（attempts_left · retry_after · bound_email_masked）。
//
// 与 email-421-contract.test.mjs 的分工：那一份钉的是 #426 落地那一刻的契约形状；
// 这一份补齐 #427 覆盖矩阵里还没被钉住的格子 —— 每条断言都对准「改坏了会红」的那一位
// （文案 key、retryable、兜底来源），而不只是「有没有 kind:'error'」。
//
// 为什么全是 mock：服务端邮箱功能只在 `feat/email-signup`，生产未启用（#421 正文）。
// 本文件**一条真网络请求都不发**，响应一律由本地假 transport 给出；真机端到端在 mock 下证明不了，
// 也不假装（未覆盖边界见 docs/testing/email-regression.md）。
//
//   node tests/run-layer.mjs unit --only email-427
//   pnpm test:email
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { installTsResolve, loadTsModule } from '../helpers/dom-env.mjs'
import {
  allowedHosts,
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts,
} from '../../scripts/lib/endpoints.mjs'

// 构建期注入值（rspack DefinePlugin 的 __ENDPOINTS__）在裸 Node 下的兜底：
// 唯一来源是 config/endpoints.json（#274）。用 `??=`：由 runner 的 --import 预加载注入时以那份为准。
globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([...allowedHosts]),
})

installTsResolve()
const api = await loadTsModule('src/services/invite/api.ts')

const DEVICE = 'd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const MASKED = 'e***@example.com'

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

/** 假 transport：按下表回响应，同时记下请求（断言「发了什么」用） */
const fakeTransport = (response) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return typeof response === 'function' ? response(request) : response
  }
  transport.calls = calls
  return transport
}

const send = (body, status) =>
  api.sendEmailCode({ deviceId: DEVICE, email: 'a@b.com' }, fakeTransport(reply(status, body)))

const verify = (body, status) =>
  api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(status, body))
  )

// ================================================================ A. 三态解析

test('A1 三态：has_email / email_masked 缺失 → null（老服务端 = 功能未开启，不是「没绑」）', async () => {
  const parsed = api.parseInviteProfile(profile())
  assert.equal(parsed.hasEmail, null)
  assert.equal(parsed.emailMasked, null, '缺字段不许编造一个空脱敏值')

  const status = await api.fetchEmailStatus(DEVICE, fakeTransport(reply(200, {})))
  assert.deepEqual(status, { kind: 'ok', hasEmail: null, emailMasked: null })
})

test('A2 三态：has_email:false → false（服务端明确说没绑），且不带脱敏邮箱', async () => {
  const parsed = api.parseInviteProfile(profile({ has_email: false }))
  assert.equal(parsed.hasEmail, false)
  assert.equal(parsed.emailMasked, null, 'false 不能变成 null，null 也不能变成 false')

  const status = await api.fetchEmailStatus(DEVICE, fakeTransport(reply(200, { has_email: false })))
  assert.deepEqual(status, { kind: 'ok', hasEmail: false, emailMasked: null })
})

test('A3 三态：has_email:true + email_masked → true + 原样脱敏值（不改写、不补全）', async () => {
  const parsed = api.parseInviteProfile(profile({ has_email: true, email_masked: MASKED }))
  assert.equal(parsed.hasEmail, true)
  assert.equal(parsed.emailMasked, MASKED)

  const status = await api.fetchEmailStatus(
    DEVICE,
    fakeTransport(reply(200, { has_email: true, email_masked: MASKED }))
  )
  assert.deepEqual(status, { kind: 'ok', hasEmail: true, emailMasked: MASKED })
})

test('A4 三态：垃圾值一律 null —— 字符串/数字/null/对象都不许被当成 true 或 false', async () => {
  for (const garbage of ['true', 'yes', 1, 0, null, {}, ['true']]) {
    const parsed = api.parseInviteProfile(profile({ has_email: garbage, email_masked: MASKED }))
    assert.equal(parsed.hasEmail, null, `has_email=${JSON.stringify(garbage)} 必须解析成 null`)
    assert.equal(parsed.emailMasked, MASKED, 'has_email 坏了不影响 email_masked 的解析')
  }
  for (const garbage of [123, null, {}, '', '   ']) {
    const parsed = api.parseInviteProfile(profile({ has_email: true, email_masked: garbage }))
    assert.equal(parsed.emailMasked, null, `email_masked=${JSON.stringify(garbage)} 必须解析成 null`)
    assert.equal(parsed.hasEmail, true)
  }
})

test('A5 三态：has_email:true 但没给 email_masked → true + null（已绑但不知道是哪个邮箱）', async () => {
  const parsed = api.parseInviteProfile(profile({ has_email: true }))
  assert.equal(parsed.hasEmail, true)
  assert.equal(parsed.emailMasked, null, '不许拿 invite_code 之类的东西顶上去')
})

// ================================================================ B. 错误码（13 条逐条）

/**
 * #421 表格的 13 条，一条不落。`retryable` 一起钉住：
 * 频控 / 服务端故障可以原样重试，语义错误（格式、验证码、已绑过）重试没意义 ——
 * 界面按钮的「再试一次」就挂在这个位上，改错了用户会一直点一直错。
 */
const ERROR_TABLE = [
  { code: 'bad_email', status: 400, key: 'oursInviteErrEmailInvalid', retryable: false },
  { code: 'email_domain_blocked', status: 400, key: 'oursInviteErrEmailDomainBlocked', retryable: false },
  { code: 'code_invalid', status: 400, key: 'oursInviteErrEmailCodeInvalid', retryable: false },
  { code: 'code_expired', status: 400, key: 'oursInviteErrEmailCodeExpired', retryable: false },
  { code: 'code_locked', status: 400, key: 'oursInviteErrEmailCodeLocked', retryable: false },
  { code: 'too_frequent', status: 429, key: 'oursInviteErrEmailTooFrequent', retryable: true },
  { code: 'email_hour_limit', status: 429, key: 'oursInviteErrEmailHourLimit', retryable: true },
  { code: 'ip_hour_limit', status: 429, key: 'oursInviteErrIpHourLimit', retryable: true },
  { code: 'device_hour_limit', status: 429, key: 'oursInviteErrDeviceHourLimit', retryable: true },
  { code: 'email_daily_cap', status: 503, key: 'oursInviteErrEmailDailyCap', retryable: true },
  { code: 'send_failed', status: 502, key: 'oursInviteErrEmailSendFailed', retryable: true },
  { code: 'customer_has_email', status: 409, key: 'oursInviteErrCustomerHasEmail', retryable: false },
  { code: 'account_frozen', status: 403, key: 'oursInviteErrAccountFrozen', retryable: false },
]

test('B1 13 条错误码在 /email/send-code 上逐条命中（code + 文案 key + retryable）', async () => {
  assert.equal(ERROR_TABLE.length, 13, '表必须是 13 条；漏一条就是漏一条分流')
  for (const item of ERROR_TABLE) {
    const result = await send({ error: { code: item.code } }, item.status)
    assert.equal(result.kind, 'error', item.code)
    assert.equal(result.code, item.code, `${item.code} 的 code 要原样带出`)
    assert.equal(result.messageKey, item.key, `${item.code} 必须落到自己那条文案`)
    assert.equal(result.retryable, item.retryable, `${item.code} 的 retryable 语义`)
  }
})

test('B2 同样 13 条在 /email/verify 上也逐条命中（两条路由共用一张表）', async () => {
  for (const item of ERROR_TABLE) {
    const result = await verify({ error: { code: item.code } }, item.status)
    assert.equal(result.kind, 'error', item.code)
    assert.equal(result.messageKey, item.key, `${item.code} 在 verify 上与 send-code 必须同一句文案`)
  }
})

test('B3 409 硬要求：customer_has_email 先按 error.code 匹配，绝不落到「已绑定过邀请码」', async () => {
  const sent = await send(
    { error: { code: 'customer_has_email', bound_email_masked: MASKED } },
    409
  )
  assert.equal(sent.messageKey, 'oursInviteErrCustomerHasEmail')
  assert.equal(sent.boundEmailMasked, MASKED)

  const verified = await verify(
    { error: { code: 'customer_has_email', bound_email_masked: MASKED } },
    409
  )
  assert.equal(verified.messageKey, 'oursInviteErrCustomerHasEmail')
  assert.notEqual(
    verified.messageKey,
    'oursInviteErrAlreadyRedeemed',
    '这正是 #421 点名的误报：邀请码那条文案挂在 INVITE_STATUS_KEYS[409] 上'
  )
  assert.equal(verified.boundEmailMasked, MASKED, '已绑的是哪个邮箱要让用户看到')
})

test('B4 409 但 code 不在邮箱表里（邀请码链路的码串进来）→ 中性文案，绝不串到邀请表', async () => {
  // 409 在 /redeem 上的语义是「已绑定过邀请码」；邮箱链路拿到同一状态码时**不能**借用那句。
  for (const code of ['already_redeemed', 'code_exhausted', 'circular_invite', 'key_already_bound']) {
    const result = await verify({ error: { code } }, 409)
    assert.notEqual(
      result.messageKey,
      'oursInviteErrAlreadyRedeemed',
      `${code} 不许落到「已绑定过邀请码」`
    )
    assert.equal(result.messageKey, 'oursInviteErrUnknown', `${code} 该给中性文案`)
  }
  // 结构性保险：兜底表本身就不许把 409 指向邀请表那条
  assert.notEqual(api.EMAIL_STATUS_KEYS[409], 'oursInviteErrAlreadyRedeemed')
  for (const key of Object.values(api.EMAIL_STATUS_KEYS)) {
    assert.notEqual(key, 'oursInviteErrAlreadyRedeemed', 'EMAIL_STATUS_KEYS 里不许出现邀请链路的 409 文案')
  }
})

// ================================================================ C. 无 code 时的状态码兜底

test('C1 没有 error.code → 按状态码兜底（400/403/409/429/502/503 各有归宿）', async () => {
  const fallbacks = [
    [400, 'oursInviteErrUnknown'],
    [403, 'oursInviteErrAccountFrozen'],
    [409, 'oursInviteErrUnknown'],
    [429, 'oursInviteErrEmailTooFrequent'],
    [502, 'oursInviteErrEmailSendFailed'],
    [503, 'oursInviteErrEmailDailyCap'],
  ]
  for (const [status, key] of fallbacks) {
    const sent = await send({}, status)
    assert.equal(sent.kind, 'error')
    assert.equal(sent.code, `HTTP_${status}`, '没有业务码时 code 用 HTTP_<status> 占位')
    assert.equal(sent.messageKey, key, `${status} 的兜底文案`)
    const verified = await verify({}, status)
    assert.equal(verified.messageKey, key, `${status} 在 verify 上兜底一致`)
  }
})

test('C2 表外状态码（404 / 500 / 418）→ 中性文案；5xx 仍可重试', async () => {
  for (const status of [404, 500, 418]) {
    const result = await send({}, status)
    assert.equal(result.messageKey, 'oursInviteErrUnknown', `${status} 没有专门文案时给中性句`)
    assert.equal(result.retryable, status >= 500, `${status} 的 retryable 只看 5xx`)
  }
})

test('C3 空响应体 / 非 JSON / code 是空串 → 仍然落到状态码兜底，不炸也不误判', async () => {
  for (const body of ['', 'not json', { error: { code: '' } }, { error: {} }]) {
    const result = await verify(body, 400)
    assert.equal(result.kind, 'error')
    assert.equal(result.messageKey, 'oursInviteErrUnknown', `body=${JSON.stringify(body)}`)
  }
  const notJson = await send('oops', 503)
  assert.equal(notJson.code, 'HTTP_503')
  assert.equal(notJson.messageKey, 'oursInviteErrEmailDailyCap')
})

// ================================================================ D. 入口探测（404 分流）

test('D1 404 + not_found → disabled（隐藏入口）：error 里和顶层的 code 都认', async () => {
  for (const body of [{ error: { code: 'not_found' } }, { code: 'not_found' }]) {
    const transport = fakeTransport(reply(404, body))
    const status = await api.fetchEmailStatus(DEVICE, transport)
    assert.deepEqual(status, { kind: 'disabled' }, `body=${JSON.stringify(body)}`)
    assert.equal(api.shouldShowEmailEntry(status), false)
    const [call] = transport.calls
    assert.equal(call.method, 'GET', '探测必须是只读 GET')
    assert.equal(call.url, `${api.INVITE_API_BASE}/email/status?device_id=${encodeURIComponent(DEVICE)}`)
    assert.equal(call.followRedirects, false, '反代把 404 重定向到首页会变成假 200')
  }
})

test('D2 404 + device_not_found → 真错误（这台设备没记录），只是入口同样不出现', async () => {
  const status = await api.fetchEmailStatus(
    DEVICE,
    fakeTransport(reply(404, { error: { code: 'device_not_found' } }))
  )
  assert.equal(status.kind, 'error')
  assert.equal(status.code, 'device_not_found', '必须与「功能没开」区分开：这条要走自愈 / 提示领取')
  assert.equal(status.messageKey, 'oursInviteErrDeviceNotFound')
  assert.notEqual(status.messageKey, 'oursInviteErrUnknown')
  assert.equal(api.shouldShowEmailEntry(status), false)
})

test('D3 网络失败 / 超时 / 404 无业务码 / 500 → 都隐藏，但 code 各有真身（不糊成一个）', async () => {
  const cases = [
    [{ kind: 'network' }, 'NETWORK', 'oursInviteErrNetwork'],
    [{ kind: 'timeout' }, 'TIMEOUT', 'oursInviteErrTimeout'],
    [reply(404, ''), 'HTTP_404', 'oursInviteErrUnknown'],
    [reply(500, { error: { code: 'boom' } }), 'boom', 'oursInviteErrUnknown'],
  ]
  for (const [response, code, key] of cases) {
    const status = await api.fetchEmailStatus(DEVICE, fakeTransport(response))
    assert.equal(status.kind, 'error', code)
    assert.equal(status.code, code)
    assert.equal(status.messageKey, key)
    assert.equal(api.shouldShowEmailEntry(status), false, `${code} 时不许出现入口`)
  }
})

test('D4 设备码为空 → DEVICE_MISSING，且一个请求都不发（不做无用探测）', async () => {
  const transport = fakeTransport(reply(200, { has_email: false }))
  const status = await api.fetchEmailStatus('   ', transport)
  assert.equal(status.kind, 'error')
  assert.equal(status.code, 'DEVICE_MISSING')
  assert.equal(status.messageKey, 'oursInviteErrDeviceMissing')
  assert.equal(transport.calls.length, 0, '本地就能判死的输入不该打到服务端')
})

test('D5 200 但字段是垃圾 → 三态全 null，入口仍然出现（探测成功 ≠ 一定已绑）', async () => {
  const status = await api.fetchEmailStatus(
    DEVICE,
    fakeTransport(reply(200, { has_email: 'yes', email_masked: 42 }))
  )
  assert.deepEqual(status, { kind: 'ok', hasEmail: null, emailMasked: null })
  assert.equal(api.shouldShowEmailEntry(status), true)
})

// ================================================================ E. 附加字段

test('E1 attempts_left / retry_after / bound_email_masked 从 error 里带出来', async () => {
  const invalid = await verify({ error: { code: 'code_invalid', attempts_left: 4 } }, 400)
  assert.equal(invalid.attemptsLeft, 4)
  assert.equal(invalid.retryAfter, null)
  assert.equal(invalid.boundEmailMasked, null)

  const frequent = await send({ error: { code: 'too_frequent', retry_after: 42 } }, 429)
  assert.equal(frequent.retryAfter, 42)
  assert.equal(frequent.attemptsLeft, null)

  const bound = await verify(
    { error: { code: 'customer_has_email', bound_email_masked: MASKED } },
    409
  )
  assert.equal(bound.boundEmailMasked, MASKED)
})

test('E2 服务端把附加字段挪到顶层也认（error 内优先）', async () => {
  const topLevel = await send({ code: 'too_frequent', retry_after: 7 }, 429)
  assert.equal(topLevel.retryAfter, 7)

  const both = await verify(
    { error: { code: 'code_locked', attempts_left: 0 }, attempts_left: 9 },
    400
  )
  assert.equal(both.attemptsLeft, 0, 'error 里的才是契约位置；0 也是有效值，不许当「没有」')
})

test('E3 附加字段是垃圾值 / 传输层失败 → 全 null，绝不编造 0 或空串', async () => {
  for (const body of [
    { error: { code: 'code_invalid', attempts_left: '4' } },
    { error: { code: 'code_invalid', attempts_left: null } },
    { error: { code: 'customer_has_email', bound_email_masked: '   ' } },
    { code: 'code_invalid' },
    'not json',
  ]) {
    const result = await verify(body, 400)
    assert.equal(result.attemptsLeft, null, `body=${JSON.stringify(body)}`)
    assert.equal(result.retryAfter, null)
    assert.equal(result.boundEmailMasked, null)
  }
  const offline = await api.sendEmailCode(
    { deviceId: DEVICE, email: 'a@b.com' },
    fakeTransport({ kind: 'network' })
  )
  assert.equal(offline.code, 'NETWORK')
  assert.deepEqual(
    [offline.attemptsLeft, offline.retryAfter, offline.boundEmailMasked],
    [null, null, null]
  )
})

// ================================================================ F. 入参守卫与形状判定

test('F1 入参缺失：device / email / code 为空 → 本地判死，一个请求都不发', async () => {
  const transport = fakeTransport(reply(200, { action: 'bound' }))
  const noDevice = await api.sendEmailCode({ deviceId: ' ', email: 'a@b.com' }, transport)
  assert.equal(noDevice.code, 'DEVICE_MISSING')
  const noEmail = await api.sendEmailCode({ deviceId: DEVICE, email: '  ' }, transport)
  assert.equal(noEmail.code, 'EMAIL_MISSING')
  assert.equal(noEmail.messageKey, 'oursInviteErrEmailInvalid')
  const noCode = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: ' ' },
    transport
  )
  assert.equal(noCode.code, 'CODE_MISSING')
  assert.equal(noCode.messageKey, 'oursInviteErrEmailCodeInvalid')
  assert.equal(transport.calls.length, 0, '缺入参不该产生任何请求')
})

test('F2 形状判定只判「像不像」：6 位数字验证码 / 带点的邮箱', () => {
  assert.equal(api.isEmailCodeShape('123456'), true)
  assert.equal(api.isEmailCodeShape(' 123456 '), true)
  for (const bad of ['12345', '1234567', 'abcdef', '12 34 56', '']) {
    assert.equal(api.isEmailCodeShape(bad), false, `验证码形状：${bad}`)
  }
  assert.equal(api.isEmailShape('a@b.com'), true)
  for (const bad of ['a@b', 'a b@c.com', 'a@@b.com', '', '@b.com']) {
    assert.equal(api.isEmailShape(bad), false, `邮箱形状：${bad}`)
  }
})

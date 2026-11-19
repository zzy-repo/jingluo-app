// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发任何网络请求） | 耗时: <1s]
// Issue #421 客户端适配（不含服务端联调）：邮箱三态解析 / 错误码映射（409 按 code 分流）/
// 入口探测（404 not_found）/ `action:"login"` 时 device_id 与 Key 的采用 / 文案键 zh+en。
//
// 为什么全是 mock：服务端邮箱功能只在开发分支 `feat/email-signup`，生产未启用（#421 正文）。
// 本文件因此**一条真网络请求都不发**，所有响应由本地假 transport 给出；
// 「真机端到端能跑通」这件事本文件证明不了，也不假装证明（未测边界见 PR 正文）。
//
//   node tests/run-layer.mjs unit --only email-421-contract
//
// 覆盖（对应 Issue #421 的适配点 1 / 2 / 4）：
//   [1] InviteProfile.hasEmail / emailMasked 三态：字段缺失 → null、false → false、true → true
//   [2] /email/send-code 与 /email/verify 的请求形态（路径、body、X-Device-Fp、超时、不跟随重定向）
//   [3] 错误码表逐条（13 条），以及 409 **先按 error.code 匹配**、匹配不到才按状态码兜底
//   [4] 附加字段 attempts_left / retry_after / bound_email_masked 被带出来（不是装饰）
//   [5] GET /email/status：404 + not_found → disabled（隐藏入口）；404 + device_not_found → 真错误
//   [6] action:"login" → 走 adoptServerDeviceId + 落 Key（坏值/相同值不写）；action:"bound" → 不动设备码
//   [7] 文案键 zh / en 都存在且一一对应（`node scripts/check-i18n.mjs` 之外的第二道保险）
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 端点地址唯一来源：config/endpoints.json（#274）。api.ts 模块顶层就读 __ENDPOINTS__，
// 所以必须在 import 之前放好（run-layer 的 --import 预加载也注入同一份）。
import {
  allowedHosts,
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts,
} from '../../scripts/lib/endpoints.mjs'

globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([...allowedHosts]),
})

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const api = await import('../../src/services/invite/api.ts')
const email = await import('../../src/services/invite/email.ts')
const device = await import('../../src/services/invite/device.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const DEVICE = 'd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_DEVICE = 'd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const KEY = 'sk-live-email421-unit-test-0000000000000000'
const MASKED = 'e***@example.com'
const FP = 'f'.repeat(0) + '0123456789abcdef'.repeat(4)

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

/** 内存版设备码存储：__261 的采用路径要写它 */
const fakeStorage = (initial = '') => {
  let value = initial
  return {
    read: () => (value === '' ? null : value),
    write: (next) => {
      value = next
    },
    get value() {
      return value
    },
  }
}

// ---------------------------------------------------------------- [1] 三态解析

test('R1 三态：has_email 缺字段 → null（不是 false），email_masked 缺字段 → null', () => {
  const parsed = api.parseInviteProfile(profile())
  assert.equal(parsed.hasEmail, null, '缺字段必须解析成 null：老服务端 = 邮箱功能未开启')
  assert.equal(parsed.emailMasked, null)
})

test('R1 三态：has_email:false → false（服务端明确说「没绑」），且不编造脱敏邮箱', () => {
  const parsed = api.parseInviteProfile(profile({ has_email: false }))
  assert.equal(parsed.hasEmail, false)
  assert.equal(parsed.emailMasked, null)
})

test('R1 三态：has_email:true + email_masked → true + 脱敏值（原样带出，不改写）', () => {
  const parsed = api.parseInviteProfile(profile({ has_email: true, email_masked: MASKED }))
  assert.equal(parsed.hasEmail, true)
  assert.equal(parsed.emailMasked, MASKED)
})

test('R1 三态：has_email 是垃圾值（字符串）→ null，不当成 true/false', () => {
  const parsed = api.parseInviteProfile(profile({ has_email: 'yes', email_masked: '   ' }))
  assert.equal(parsed.hasEmail, null)
  assert.equal(parsed.emailMasked, null, '空串按「没有这个字段」处理')
})

// ---------------------------------------------------------------- [2] 请求形态

test('R2 send-code：POST /email/send-code，body 只有 device_id + email，带 X-Device-Fp 与既有超时', async () => {
  const transport = fakeTransport(reply(200, { resend_after: 60 }))
  const result = await api.sendEmailCode({ deviceId: DEVICE, email: 'a@b.com' }, transport, FP)
  assert.equal(result.kind, 'ok')
  assert.equal(result.resendAfter, 60)
  const [call] = transport.calls
  assert.equal(call.method, 'POST')
  assert.equal(call.url, `${api.INVITE_API_BASE}/email/send-code`)
  assert.deepEqual(JSON.parse(call.body), { device_id: DEVICE, email: 'a@b.com' })
  assert.equal(call.headers['X-Device-Fp'], FP, '指纹形状合法才带')
  assert.equal(call.timeoutMs, api.INVITE_TIMEOUTS.emailSend)
  assert.equal(call.followRedirects, false)
})

test('R2 send-code：指纹不合格 → 头干脆不出现（降级不留痕）', async () => {
  const transport = fakeTransport(reply(200, {}))
  await api.sendEmailCode({ deviceId: DEVICE, email: 'a@b.com' }, transport, 'not-a-fp')
  assert.equal('X-Device-Fp' in transport.calls[0].headers, false)
})

test('R2 verify：POST /email/verify，body 带 device_id + email + code（6 位码原样发）', async () => {
  const transport = fakeTransport(reply(200, { action: 'bound', has_email: true, email_masked: MASKED }))
  const result = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    transport
  )
  assert.equal(result.kind, 'ok')
  assert.equal(result.action, 'bound')
  assert.equal(result.hasEmail, true)
  assert.equal(result.emailMasked, MASKED)
  const [call] = transport.calls
  assert.equal(call.url, `${api.INVITE_API_BASE}/email/verify`)
  assert.deepEqual(JSON.parse(call.body), { device_id: DEVICE, email: 'a@b.com', code: '123456' })
  assert.equal(call.timeoutMs, api.INVITE_TIMEOUTS.emailVerify)
})

test('R2 verify：action 缺失 / 不是 bound|login → 响应异常（绝不猜一个）', async () => {
  for (const body of [{}, { action: 'merge' }, { action: '' }]) {
    const result = await api.verifyEmailCode(
      { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
      fakeTransport(reply(200, body))
    )
    assert.equal(result.kind, 'error')
    assert.equal(result.code, 'INVALID_RESPONSE')
    assert.equal(result.messageKey, 'oursInviteErrInvalidResponse')
  }
})

test('R2 verify：网络层失败 → 既有网络 / 超时文案，不是「验证码错」', async () => {
  const timedOut = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport({ kind: 'timeout' })
  )
  assert.equal(timedOut.messageKey, 'oursInviteErrTimeout')
  assert.equal(timedOut.retryable, true)
  assert.equal(timedOut.attemptsLeft, null)

  const offline = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport({ kind: 'network' })
  )
  assert.equal(offline.messageKey, 'oursInviteErrNetwork')
})

// ---------------------------------------------------------------- [3] 错误码映射

test('R3 错误码表逐条命中（13 条，一条不落）', async () => {
  const table = [
    ['bad_email', 400],
    ['email_domain_blocked', 400],
    ['code_invalid', 400],
    ['code_expired', 400],
    ['code_locked', 400],
    ['too_frequent', 429],
    ['email_hour_limit', 429],
    ['ip_hour_limit', 429],
    ['device_hour_limit', 429],
    ['email_daily_cap', 503],
    ['send_failed', 502],
    ['customer_has_email', 409],
    ['account_frozen', 403],
  ]
  assert.ok(
    Object.keys(api.EMAIL_ERROR_KEYS).length >= table.length,
    '表里 13 条必须全在（另允许复用既有码，如 device_not_found）'
  )
  for (const [code, status] of table) {
    const result = await api.sendEmailCode(
      { deviceId: DEVICE, email: 'a@b.com' },
      fakeTransport(reply(status, { error: { code } }))
    )
    assert.equal(result.kind, 'error', code)
    assert.equal(result.code, code)
    assert.equal(
      result.messageKey,
      api.EMAIL_ERROR_KEYS[code],
      `${code} 必须落到自己那条文案，不能串到别处`
    )
  }
})

test('R3 409 硬要求：customer_has_email 先按 code 匹配，绝不落到「已绑定过邀请码」', async () => {
  const result = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(
      reply(409, {
        error: { code: 'customer_has_email', message: 'has email', bound_email_masked: MASKED },
      })
    )
  )
  assert.equal(result.kind, 'error')
  assert.equal(result.messageKey, 'oursInviteErrCustomerHasEmail')
  assert.notEqual(result.messageKey, 'oursInviteErrAlreadyRedeemed', '这正是 #421 点名的误报')
  assert.equal(result.boundEmailMasked, MASKED, '已绑的是哪个邮箱要让用户看到')
})

test('R3 409 兜底：没有 code / 不认识的 code → 中性文案，仍然不是「已绑定过邀请码」', async () => {
  for (const body of [{}, { error: { code: '' } }, { error: { code: 'something_new' } }]) {
    const result = await api.verifyEmailCode(
      { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
      fakeTransport(reply(409, body))
    )
    assert.equal(result.kind, 'error')
    assert.equal(result.messageKey, 'oursInviteErrUnknown')
    assert.notEqual(result.messageKey, 'oursInviteErrAlreadyRedeemed')
  }
})

test('R3 附加字段：attempts_left / retry_after 被带出来，频控可重试、语义错误不重试', async () => {
  const codeInvalid = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(400, { error: { code: 'code_invalid', attempts_left: 4 } }))
  )
  assert.equal(codeInvalid.attemptsLeft, 4)
  assert.equal(codeInvalid.retryAfter, null)
  assert.equal(codeInvalid.retryable, false, '验证码错重试同一串码没意义')

  const frequent = await api.sendEmailCode(
    { deviceId: DEVICE, email: 'a@b.com' },
    fakeTransport(reply(429, { error: { code: 'too_frequent', retry_after: 42 } }))
  )
  assert.equal(frequent.retryAfter, 42)
  assert.equal(frequent.messageKey, 'oursInviteErrEmailTooFrequent')
  assert.equal(frequent.retryable, true, '频控到点后重发是安全的')

  const locked = await api.verifyEmailCode(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(400, { error: { code: 'code_locked' } }))
  )
  assert.equal(locked.messageKey, 'oursInviteErrEmailCodeLocked')
  assert.equal(locked.retryable, false)
})

test('R3 附加字段在顶层也算（服务端换位置时不丢）', async () => {
  const result = await api.sendEmailCode(
    { deviceId: DEVICE, email: 'a@b.com' },
    fakeTransport(reply(429, { code: 'too_frequent', retry_after: 7 }))
  )
  assert.equal(result.retryAfter, 7)
})

// ---------------------------------------------------------------- [4] 入口探测

test('R4 404 + not_found → disabled（隐藏入口），不是错误', async () => {
  const transport = fakeTransport(reply(404, { error: { code: 'not_found' } }))
  const status = await api.fetchEmailStatus(DEVICE, transport)
  assert.deepEqual(status, { kind: 'disabled' })
  assert.equal(api.shouldShowEmailEntry(status), false)
  const [call] = transport.calls
  assert.equal(call.method, 'GET')
  assert.equal(
    call.url,
    `${api.INVITE_API_BASE}/email/status?device_id=${encodeURIComponent(DEVICE)}`
  )
})

test('R4 404 + device_not_found → 真错误（这台设备没记录），绝不当成「功能没开」', async () => {
  const status = await api.fetchEmailStatus(
    DEVICE,
    fakeTransport(reply(404, { error: { code: 'device_not_found' } }))
  )
  assert.equal(status.kind, 'error')
  assert.equal(status.code, 'device_not_found')
  assert.equal(status.messageKey, 'oursInviteErrDeviceNotFound')
  assert.equal(api.shouldShowEmailEntry(status), false, '但入口同样不出现：探测没成功')
})

test('R4 404 但没有业务码（老部署 / 反代没配）→ 错误，不是 disabled', async () => {
  const status = await api.fetchEmailStatus(DEVICE, fakeTransport(reply(404, '')))
  assert.equal(status.kind, 'error')
  assert.equal(status.code, 'HTTP_404')
})

test('R4 200：已绑带脱敏邮箱 / 未绑 / 缺字段三态', async () => {
  const bound = await api.fetchEmailStatus(
    DEVICE,
    fakeTransport(reply(200, { has_email: true, email_masked: MASKED }))
  )
  assert.deepEqual(bound, { kind: 'ok', hasEmail: true, emailMasked: MASKED })
  assert.equal(api.shouldShowEmailEntry(bound), true)

  const unbound = await api.fetchEmailStatus(DEVICE, fakeTransport(reply(200, { has_email: false })))
  assert.deepEqual(unbound, { kind: 'ok', hasEmail: false, emailMasked: null })

  const legacy = await api.fetchEmailStatus(DEVICE, fakeTransport(reply(200, {})))
  assert.deepEqual(legacy, { kind: 'ok', hasEmail: null, emailMasked: null })
})

test('R4 探测失败（网络）→ 不显示入口', async () => {
  const status = await api.fetchEmailStatus(DEVICE, fakeTransport({ kind: 'network' }))
  assert.equal(status.kind, 'error')
  assert.equal(api.shouldShowEmailEntry(status), false)
})

// ---------------------------------------------------------------- [5] action:"login" 的采用

test('R5 action:"login"：device_id 走 adoptServerDeviceId 写回、Key 落到 saveKey，文案走 bindSuccessKey', async () => {
  const storage = fakeStorage(DEVICE)
  const saved = []
  const transport = fakeTransport(
    reply(200, { action: 'login', device_id: OTHER_DEVICE, key: KEY, email_masked: MASKED })
  )
  const outcome = await email.verifyEmailAndAdopt(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    transport,
    { storage, currentDeviceId: DEVICE, saveKey: (key) => saved.push(key) }
  )
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.action, 'login')
  assert.equal(outcome.value.deviceId, OTHER_DEVICE, '采用后本地应当使用服务端的 device_id')
  assert.equal(storage.value, OTHER_DEVICE, 'adoptServerDeviceId 必须真把值写进存储')
  assert.deepEqual(saved, [KEY], 'Key 走 saveKey 落盘（与 /apply、/bind 同一个口）')
  assert.equal(outcome.value.deviceIdAdopted, true)
  assert.equal(outcome.value.keyAdopted, true)
  assert.equal(outcome.value.successKey, 'oursBindOk')
  assert.equal(JSON.stringify(outcome).includes(KEY), false, '结果里不回显 Key')
})

test('R5 action:"login"：服务端回填坏 device_id → 当没回，本地一字不动（Key 仍然落盘）', async () => {
  const storage = fakeStorage(DEVICE)
  const saved = []
  const outcome = await email.verifyEmailAndAdopt(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(200, { action: 'login', device_id: 'bad id!', key: KEY })),
    { storage, currentDeviceId: DEVICE, saveKey: (key) => saved.push(key) }
  )
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.deviceId, DEVICE)
  assert.equal(storage.value, DEVICE, '坏值绝不许写进本地（#261 的同一条约束）')
  assert.equal(outcome.value.deviceIdAdopted, false)
  assert.deepEqual(saved, [KEY])
})

test('R5 action:"login" 但响应没有 Key → 当失败（KEY_MISSING），绝不显示「已登录」', async () => {
  const storage = fakeStorage(DEVICE)
  const saved = []
  const outcome = await email.verifyEmailAndAdopt(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(200, { action: 'login', device_id: OTHER_DEVICE })),
    { storage, currentDeviceId: DEVICE, saveKey: (key) => saved.push(key) }
  )
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.code, 'KEY_MISSING')
  assert.equal(outcome.messageKey, 'oursInviteErrKeyMissing')
  assert.equal(storage.value, DEVICE, '没成功就不许动本地')
  assert.deepEqual(saved, [])
})

test('R5 action:"bound"：设备码一个字都不动，也不落 Key（绑定就是把邮箱挂到当前设备码上）', async () => {
  const storage = fakeStorage(DEVICE)
  const saved = []
  const outcome = await email.verifyEmailAndAdopt(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(200, { action: 'bound', device_id: OTHER_DEVICE, email_masked: MASKED })),
    { storage, currentDeviceId: DEVICE, saveKey: (key) => saved.push(key) }
  )
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.action, 'bound')
  assert.equal(outcome.value.deviceId, DEVICE)
  assert.equal(storage.value, DEVICE)
  assert.equal(outcome.value.hasEmail, true)
  assert.equal(outcome.value.emailMasked, MASKED)
  assert.deepEqual(saved, [], '绑定分支不碰 Key')
})

test('R5 采用路径与 #261 / #86 是同一份实现（不另起一套覆盖逻辑）', async () => {
  // 同一组输入，adoptServerDeviceId 的结论必须与 verifyEmailAndAdopt 里的采用一致
  const cases = [
    { server: OTHER_DEVICE, expected: OTHER_DEVICE },
    { server: DEVICE, expected: DEVICE },
    { server: '', expected: DEVICE },
    { server: '   ', expected: DEVICE },
    { server: 'bad id!', expected: DEVICE },
  ]
  for (const item of cases) {
    const storage = fakeStorage(DEVICE)
    const direct = device.adoptServerDeviceId(storage, DEVICE, item.server)
    const storageB = fakeStorage(DEVICE)
    await email.verifyEmailAndAdopt(
      { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
      fakeTransport(reply(200, { action: 'login', device_id: item.server, key: KEY })),
      { storage: storageB, currentDeviceId: DEVICE, saveKey: () => {} }
    )
    assert.equal(storageB.value, item.expected, `server=${item.server}`)
    assert.equal(direct, item.expected)
  }
})

// ---------------------------------------------------------------- [6] 文案键

test('R6 13 条错误码 + 入口文案在 zh / en 都存在，且占位符一一对齐', () => {
  const keys = [
    ...Object.values(api.EMAIL_ERROR_KEYS),
    'oursEmailTitle',
    'oursEmailDescription',
    'oursEmailBindAction',
    'oursEmailInputPlaceholder',
    'oursEmailCodePlaceholder',
    'oursEmailSendAction',
    'oursEmailSendBusy',
    'oursEmailVerifyAction',
    'oursEmailVerifyBusy',
    'oursEmailSentHint',
    'oursEmailCodeShapeHint',
    'oursEmailRetryAfter',
    'oursEmailAttemptsLeft',
    'oursEmailBoundMaskedHint',
    'oursEmailLoginOk',
  ]
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
    assert.notEqual(zh[key].trim(), '', `zh 的 ${key} 是空文案`)
    assert.notEqual(en[key].trim(), '', `en 的 ${key} 是空文案`)
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 的占位符不一致`)
  }
  // 409 的两条文案必须真的不一样（否则「先按 code 匹配」在用户眼里还是没区别）
  assert.notEqual(
    zh.oursInviteErrCustomerHasEmail,
    zh.oursInviteErrAlreadyRedeemed,
    '「已绑邮箱」与「已绑定邀请码」不能是同一句'
  )
})

test('R6 邮箱文案不许吹「更安全 / 防被盗」（#421 已知局限 1）', () => {
  const text = `${zh.oursEmailDescription} ${en.oursEmailDescription}`
  for (const banned of ['更安全', '防盗', 'safer', 'secure', 'protect']) {
    assert.equal(text.includes(banned), false, `文案里不该出现「${banned}」`)
  }
  assert.ok(zh.oursEmailDescription.includes('不会让其他设备失效'))
})

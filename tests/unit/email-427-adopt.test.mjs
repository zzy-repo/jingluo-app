// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发任何网络请求） | 耗时: <1s]
// Issue #427 —— 邮箱适配回归基线（采用路径）：`action:"login"` / `action:"bound"` 之后
// 本机凭据到底动没动。
//
// 为什么这一组必须单独钉住：采用路径是全链路里**唯一会写本地凭据**的地方。
// 写错了用户不会看到任何报错 —— 他看到的是「登录成功」，然后下一个请求查到一个不存在的设备，
// 表现成「号丢了」（#261 / #100 就是这么来的）。所以这里断言的是存储与落 Key 口的**副作用**，
// 不是返回值的形状。
//
// 全 mock：假 transport + 内存版设备码存储，零真实网络、零真实 localStorage。
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

globalThis.__ENDPOINTS__ ??= Object.freeze({
  chatBaseUrl,
  feedbackUrl,
  inviteBaseUrl,
  legacyHosts: Object.freeze([...legacyHosts]),
  allowedHosts: Object.freeze([...allowedHosts]),
})

installTsResolve()
const email = await loadTsModule('src/services/invite/email.ts')
const device = await loadTsModule('src/services/invite/device.ts')

const DEVICE = 'd-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_DEVICE = 'd-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const KEY = 'sk-live-email427-adopt-000000000000000000'
const MASKED = 'e***@example.com'

const reply = (status, body) => ({
  kind: 'response',
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})

const fakeTransport = (response) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return typeof response === 'function' ? response(request) : response
  }
  transport.calls = calls
  return transport
}

/** 内存版设备码存储：`writes` 记录「真的写了几次」，坏值不许出现在里面 */
const fakeStorage = (initial = DEVICE) => {
  let value = initial
  const writes = []
  return {
    read: () => (value === '' ? null : value),
    write: (next) => {
      writes.push(next)
      value = next
    },
    get value() {
      return value
    },
    writes,
  }
}

const run = async (body, { storage = fakeStorage(), saved = [], status = 200 } = {}) => {
  const outcome = await email.verifyEmailAndAdopt(
    { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
    fakeTransport(reply(status, body)),
    { storage, currentDeviceId: DEVICE, saveKey: (key) => saved.push(key) }
  )
  return { outcome, storage, saved }
}

// ================================================================ G. action:"login"

test('G1 login：服务端 device_id 被采用并写进存储，Key 落到 saveKey 口', async () => {
  const { outcome, storage, saved } = await run({
    action: 'login',
    device_id: OTHER_DEVICE,
    key: KEY,
    email_masked: MASKED,
  })
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.action, 'login')
  assert.equal(outcome.value.deviceId, OTHER_DEVICE, '采用后本地应当用服务端的设备码')
  assert.equal(outcome.value.deviceIdAdopted, true)
  assert.equal(outcome.value.keyAdopted, true)
  assert.equal(storage.value, OTHER_DEVICE)
  assert.deepEqual(storage.writes, [OTHER_DEVICE], '写一次就好，不许来回覆盖')
  assert.deepEqual(saved, [KEY])
})

test('G2 login：结果对象里不回显 Key（Key 只从 saveKey 过一手）', async () => {
  const { outcome } = await run({ action: 'login', device_id: OTHER_DEVICE, key: KEY })
  assert.equal(outcome.kind, 'ok')
  assert.equal(
    JSON.stringify(outcome).includes(KEY),
    false,
    '返回值会被界面 / 日志拿着用，Key 混进去就是泄一次'
  )
  assert.equal(outcome.value.successKey, 'oursBindOk', '成功文案与 /bind 同一条')
})

test('G3 login：服务端回填坏 device_id → 一个字节都不落盘（Key 仍然落）', async () => {
  const bad = ['', '   ', 'bad id!', 'short', 'x'.repeat(200), '带中文的id']
  for (const server of bad) {
    const storage = fakeStorage()
    const saved = []
    const { outcome } = await run(
      { action: 'login', device_id: server, key: KEY },
      { storage, saved }
    )
    assert.equal(outcome.kind, 'ok', `server=${JSON.stringify(server)}`)
    assert.equal(outcome.value.deviceId, DEVICE, '坏值当没回')
    assert.equal(outcome.value.deviceIdAdopted, false)
    assert.deepEqual(storage.writes, [], `坏 device_id 绝不许进本地：${JSON.stringify(server)}`)
    assert.equal(storage.value, DEVICE)
    assert.deepEqual(saved, [KEY], '设备码坏了不影响把 Key 落盘：这把 Key 仍然能用')
  }
})

test('G4 login：服务端回的 device_id 与本地相同 → 不写存储（相同不写，避免无意义抖动）', async () => {
  const storage = fakeStorage()
  const { outcome } = await run({ action: 'login', device_id: DEVICE, key: KEY }, { storage })
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.deviceId, DEVICE)
  assert.equal(outcome.value.deviceIdAdopted, false)
  assert.deepEqual(storage.writes, [], '#261 的「相同不写」在邮箱登录上同样成立')
})

test('G5 login 但没 Key / Key 是空白 → 当失败（KEY_MISSING），本地一动不动', async () => {
  for (const body of [
    { action: 'login', device_id: OTHER_DEVICE },
    { action: 'login', device_id: OTHER_DEVICE, key: '' },
    { action: 'login', device_id: OTHER_DEVICE, key: '   ' },
    { action: 'login', device_id: OTHER_DEVICE, key: 42 },
  ]) {
    const storage = fakeStorage()
    const saved = []
    const { outcome } = await run(body, { storage, saved })
    assert.equal(outcome.kind, 'error', `body=${JSON.stringify(body)}`)
    assert.equal(outcome.code, 'KEY_MISSING')
    assert.equal(outcome.messageKey, 'oursInviteErrKeyMissing')
    assert.equal(outcome.retryable, true)
    assert.equal(storage.value, DEVICE, '没成功就不许把设备码换掉')
    assert.deepEqual(storage.writes, [])
    assert.deepEqual(saved, [], '没 Key 就没有可落的 Key')
  }
})

// ================================================================ H. action:"bound"

test('H1 bound：设备码与 Key 一个字都不动（邮箱挂在当前设备码上）', async () => {
  const storage = fakeStorage()
  const saved = []
  const { outcome } = await run(
    { action: 'bound', device_id: OTHER_DEVICE, key: KEY, email_masked: MASKED },
    { storage, saved }
  )
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.action, 'bound')
  assert.equal(outcome.value.deviceId, DEVICE, 'bound 分支不看 server device_id')
  assert.equal(outcome.value.deviceIdAdopted, false)
  assert.equal(outcome.value.keyAdopted, false)
  assert.equal(storage.value, DEVICE)
  assert.deepEqual(storage.writes, [])
  assert.deepEqual(saved, [], '绑定分支绝不碰 Key')
})

test('H2 bound：hasEmail / emailMasked 落到结果上，缺字段时中性成 true（服务端刚说绑成功）', async () => {
  const withFields = await run({ action: 'bound', has_email: true, email_masked: MASKED })
  assert.equal(withFields.outcome.value.hasEmail, true)
  assert.equal(withFields.outcome.value.emailMasked, MASKED)

  const withoutFields = await run({ action: 'bound' })
  assert.equal(withoutFields.outcome.value.hasEmail, true, '绑定成功之后服务端一定 has_email:true')
  assert.equal(withoutFields.outcome.value.emailMasked, null, '不知道是哪个邮箱就 null，不编造')
  assert.equal(withoutFields.outcome.value.successKey, 'oursBindOk')
})

test('H3 bound：响应里顺带回了档案 → 原样透传（界面少查一次 /me）', async () => {
  const { outcome } = await run({
    action: 'bound',
    invite_code: 'K3M9QW2P',
    remaining_points: 260,
    has_email: true,
    email_masked: MASKED,
  })
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.value.profile.remainingPoints, 260)
  assert.equal(outcome.value.profile.inviteCode, 'K3M9QW2P')
})

// ================================================================ I. 失败分支不产生副作用

test('I1 验证码错 / 409 已绑 → 原样是错误，且不写设备码、不落 Key', async () => {
  const cases = [
    [{ error: { code: 'code_invalid', attempts_left: 3 } }, 400],
    [{ error: { code: 'customer_has_email', bound_email_masked: MASKED } }, 409],
    [{ error: { code: 'code_expired' } }, 400],
  ]
  for (const [body, status] of cases) {
    const storage = fakeStorage()
    const saved = []
    const { outcome } = await run(body, { storage, saved, status })
    assert.equal(outcome.kind, 'error', `body=${JSON.stringify(body)}`)
    assert.equal(storage.value, DEVICE)
    assert.deepEqual(storage.writes, [])
    assert.deepEqual(saved, [])
  }
})

test('I2 失败时附加字段原样穿过采用层（界面要拿它显示「还剩 N 次」）', async () => {
  const { outcome } = await run({ error: { code: 'code_invalid', attempts_left: 2 } }, { status: 400 })
  assert.equal(outcome.kind, 'error')
  assert.equal(outcome.attemptsLeft, 2)
  assert.equal(outcome.retryable, false)
})

test('I3 采用用的就是 device.ts 那一条实现（不另起一套覆盖逻辑）', async () => {
  // 同一组服务端回填值，直接调 adoptServerDeviceId 与走邮箱登录，结论必须一一相同
  const cases = [
    { server: OTHER_DEVICE, expected: OTHER_DEVICE },
    { server: DEVICE, expected: DEVICE },
    { server: '   ', expected: DEVICE },
    { server: 'bad id!', expected: DEVICE },
  ]
  for (const item of cases) {
    const direct = fakeStorage()
    assert.equal(device.adoptServerDeviceId(direct, DEVICE, item.server), item.expected)
    const viaEmail = fakeStorage()
    await run(
      { action: 'login', device_id: item.server, key: KEY },
      { storage: viaEmail }
    )
    assert.equal(viaEmail.value, direct.value, `server=${JSON.stringify(item.server)}`)
  }
})

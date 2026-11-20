// [layer: unit | 纯 Node（假 transport / 内存存储），零浏览器零网络 | 耗时: <1s]
//
// C9 —— 邮箱账号的**跨端语义**（Issue #438 / 被测功能 #421）
//
// 为什么需要契约层：域 11 的分支细节已经有 L0（`domain11-email-parse` 等）与 L1
// （`tests/integration/domain11-email-flow.test.mjs`）盯着，但那两处盯的是「某条路径的结论」。
// 这里锁的是**四条一旦被"看起来无害"的改动碰坏、用户就会静默走错分支的语义**：
//   E1 三态：`has_email` 缺字段 = 「服务端没有这个功能」（`null`），**不是** `false`
//      （= 服务端明确说没绑）。混成 boolean 的后果：老部署上渲染一个点了必然报错的入口。
//   E2 错误码优先级：**先按 `error.code` 匹配，匹配不到才退回状态码**。409 在两条链路里
//      语义相反（`/redeem` = 已绑定邀请码；`/email/*` = 本账号已绑过邮箱），先看状态码就会
//      把后者显示成前者。
//   E3 登录成功后本地账号必须切换：`action:"login"` 的 `device_id` / `key` 是原账号的凭据，
//      必须走 `adoptServerDeviceId`（#261 同一条路径）写回 + `saveKey` 落盘；不切换的后果是
//      「显示已登录、实际还挂在旧设备码上」，额度与后续兑换全查错账号。
//   E4 未开启时入口必须隐藏：只有 `404 + error.code === "not_found"` 才是「服务端没开」；
//      `404 + device_not_found` 与网络失败都不是，但也同样不出入口（宁可不显示）。
//
// 与 C1–C8 同级：一契约一文件、表驱动多断言，不按分支堆用例。
//
//   node --test tests/unit/contract-c9-email.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const api = await import('../../src/services/invite/api.ts')
const email = await import('../../src/services/invite/email.ts')
const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')

const DEVICE = 'd-11111111111111111111111111111111'
const OTHER_DEVICE = 'd-22222222222222222222222222222222'
const KEY = 'sk-contract-c9-email-0000000000000000'
const MASKED = 'c***@example.com'

const reply = (status, body) => ({
  kind: 'response',
  status,
  text: typeof body === 'string' ? body : JSON.stringify(body),
})

const transportOf = (response) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return typeof response === 'function' ? response(request) : response
  }
  transport.calls = calls
  return transport
}

/** 内存版设备码存储（E3 要写它，断言「真的落盘」） */
const memoryDeviceStorage = (initial) => {
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

/** 契约表：一行 = 一条跨端语义 */
const CONTRACT_ROWS = [
  {
    id: 'E1',
    what: '三态字段：缺字段 = 未开启（null），不是 false；界面只认 true 才算已绑',
    run: async () => {
      const legacy = api.parseInviteProfile({
        invite_code: 'K3M9QW2P',
        remaining_points: 300,
      })
      assert.equal(legacy.hasEmail, null, '老服务端没有 has_email → null（未开启），绝不能是 false')
      assert.equal(legacy.emailMasked, null)
      assert.notStrictEqual(legacy.hasEmail, false, 'null 与 false 是两件事（false = 服务端明确说没绑）')

      const explicitNo = api.parseInviteProfile({ invite_code: 'K3M9QW2P', remaining_points: 0, has_email: false })
      assert.equal(explicitNo.hasEmail, false)
      assert.equal(explicitNo.emailMasked, null, '没绑就不许编造脱敏邮箱')

      const status = await api.fetchEmailStatus(DEVICE, transportOf(reply(200, { has_email: true, email_masked: MASKED })))
      assert.deepEqual(status, { kind: 'ok', hasEmail: true, emailMasked: MASKED })
    },
  },
  {
    id: 'E2',
    what: '错误码优先级：code 先于 status，409 绝不落到「已绑定过邀请码」',
    run: async () => {
      // 同一个 409，两个 code 必须给两句不同的话，且都不等于 /redeem 的那句
      const hasEmail = await api.verifyEmailCode(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        transportOf(reply(409, { error: { code: 'customer_has_email' } }))
      )
      assert.equal(hasEmail.messageKey, 'oursInviteErrCustomerHasEmail')
      assert.notEqual(hasEmail.messageKey, 'oursInviteErrAlreadyRedeemed')

      // 不认识的 code（含空 code）→ 中性文案；状态码兜底也不许用 INVITE_STATUS_KEYS 那张表
      for (const body of [{}, { error: { code: 'brand_new_code' } }]) {
        const fallback = await api.verifyEmailCode(
          { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
          transportOf(reply(409, body))
        )
        assert.equal(fallback.messageKey, 'oursInviteErrUnknown')
        assert.notEqual(fallback.messageKey, 'oursInviteErrAlreadyRedeemed')
      }

      // 反过来：code 认识时**不许**被状态码改写（429 + code_invalid 仍旧是验证码错）
      const codeWins = await api.verifyEmailCode(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        transportOf(reply(429, { error: { code: 'code_invalid' } }))
      )
      assert.equal(codeWins.messageKey, 'oursInviteErrEmailCodeInvalid')
      assert.equal(codeWins.code, 'code_invalid')
    },
  },
  {
    id: 'E3',
    what: '登录成功后本地账号必须切换（adoptServerDeviceId 写回 + Key 落盘），绑定分支一个字节都不动',
    run: async () => {
      const loginStorage = memoryDeviceStorage(DEVICE)
      const saved = []
      const login = await email.verifyEmailAndAdopt(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        transportOf(reply(200, { action: 'login', device_id: OTHER_DEVICE, key: KEY, email_masked: MASKED })),
        { storage: loginStorage, currentDeviceId: DEVICE, saveKey: (key) => saved.push(key) }
      )
      assert.equal(login.kind, 'ok')
      assert.equal(loginStorage.value, OTHER_DEVICE, '登录成功必须把原账号的 device_id 写回本地')
      assert.deepEqual(saved, [KEY], 'Key 走 saveKey 落盘（与 /apply、/bind 同一个口）')
      assert.equal(JSON.stringify(login).includes(KEY), false, '结果对象绝不回显 Key')

      // 坏 device_id 当没回：本地一字不动（#261 的同一条约束，别为邮箱另开一条路）
      const brokenStorage = memoryDeviceStorage(DEVICE)
      const broken = await email.verifyEmailAndAdopt(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        transportOf(reply(200, { action: 'login', device_id: 'bad id!', key: KEY })),
        { storage: brokenStorage, currentDeviceId: DEVICE, saveKey: () => {} }
      )
      assert.equal(broken.kind, 'ok')
      assert.equal(brokenStorage.value, DEVICE, '坏值绝不许写进本地')

      // 没有 Key 的 login = 失败（不许显示「已登录」却留一把空 Key）
      const noKeyStorage = memoryDeviceStorage(DEVICE)
      const noKey = await email.verifyEmailAndAdopt(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        transportOf(reply(200, { action: 'login', device_id: OTHER_DEVICE })),
        { storage: noKeyStorage, currentDeviceId: DEVICE, saveKey: () => {} }
      )
      assert.equal(noKey.kind, 'error')
      assert.equal(noKey.code, 'KEY_MISSING')
      assert.equal(noKeyStorage.value, DEVICE)

      // 绑定分支：邮箱挂到当前设备码上，设备码 / Key 都不动
      const boundStorage = memoryDeviceStorage(DEVICE)
      const boundSaved = []
      const bound = await email.verifyEmailAndAdopt(
        { deviceId: DEVICE, email: 'a@b.com', code: '123456' },
        transportOf(reply(200, { action: 'bound', device_id: OTHER_DEVICE, email_masked: MASKED })),
        { storage: boundStorage, currentDeviceId: DEVICE, saveKey: (key) => boundSaved.push(key) }
      )
      assert.equal(bound.kind, 'ok')
      assert.equal(boundStorage.value, DEVICE, '绑定不许改设备码（哪怕服务端回了别的）')
      assert.deepEqual(boundSaved, [])
      assert.equal(bound.value.hasEmail, true, '绑定成功后界面必须认为「已绑」')
    },
  },
  {
    id: 'E4',
    what: '未开启时入口必须隐藏：只有 404 + not_found 算「没开」，其余失败同样不出入口',
    run: async () => {
      const disabled = await api.fetchEmailStatus(DEVICE, transportOf(reply(404, { error: { code: 'not_found' } })))
      assert.deepEqual(disabled, { kind: 'disabled' })
      assert.equal(api.shouldShowEmailEntry(disabled), false, '服务端没开 → 入口整块不渲染')

      const deviceMissing = await api.fetchEmailStatus(
        DEVICE,
        transportOf(reply(404, { error: { code: 'device_not_found' } }))
      )
      assert.equal(deviceMissing.kind, 'error', '「这台设备没记录」不是「功能没开」')
      assert.equal(deviceMissing.code, 'device_not_found')
      assert.equal(api.shouldShowEmailEntry(deviceMissing), false, '但探测没成功，同样不出入口')

      const offline = await api.fetchEmailStatus(DEVICE, transportOf({ kind: 'network' }))
      assert.equal(api.shouldShowEmailEntry(offline), false)

      const ok = await api.fetchEmailStatus(DEVICE, transportOf(reply(200, { has_email: false })))
      assert.equal(api.shouldShowEmailEntry(ok), true, '探测成功才出入口')
    },
  },
  {
    id: 'E5',
    what: '文案边界：13 条错误码 zh / en 都存在且占位符对齐，且不许吹「更安全 / 防盗」',
    run: async () => {
      const keys = [
        ...Object.values(api.EMAIL_ERROR_KEYS),
        'oursEmailTitle',
        'oursEmailBindAction',
        'oursEmailSendAction',
        'oursEmailVerifyAction',
        'oursEmailSendCountdown',
        'oursEmailLoginOk',
        'oursEmailConflictTitle',
        'oursEmailConflictWarning',
        'oursEmailConflictUseEmail',
        'oursEmailConflictKeepDevice',
      ]
      const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      for (const key of keys) {
        assert.equal(typeof zh[key], 'string', `zh 缺 ${key}`)
        assert.equal(typeof en[key], 'string', `en 缺 ${key}`)
        assert.notEqual(zh[key].trim(), '', `zh 的 ${key} 是空文案`)
        assert.notEqual(en[key].trim(), '', `en 的 ${key} 是空文案`)
        assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), `${key} 的占位符不一致`)
      }
      const copy = `${zh.oursEmailDescription} ${en.oursEmailDescription} ${zh.oursEmailConflictWarning}`
      for (const banned of ['更安全', '防盗', 'safer', 'secure', 'protect']) {
        assert.equal(copy.includes(banned), false, `邮箱文案不许出现「${banned}」（#421 已知局限 1）`)
      }
      assert.ok(zh.oursEmailConflictWarning.includes('不自动合并'), '冲突文案只能是否定式「不自动合并」')
    },
  },
]

test('C9 邮箱账号跨端语义：三态 / 错误码优先级 / 登录切换本地账号 / 未开启隐藏入口 / 文案边界', tableTest('C9', CONTRACT_ROWS, async (row) => row.run()))

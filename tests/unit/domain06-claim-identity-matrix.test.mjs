// [layer: unit | 依赖: 无（纯 Node，零浏览器、零 React、不发网络请求） | 耗时: <1s]
// C2「领取 / 绑定 / 换 Key：身份与落盘矩阵」—— 域 6 F6-03 / F6-04 / F6-05 / F6-14 / F6-15 / F6-17
// （docs/testing/coverage/domain-06-07.md §4.1）
//
// 三张表跑完「这台设备到底是谁」的全部判定：
//   表 A 领取（身份矩阵）：同 device 重放 / 换 device 同指纹（含老 build 的静默新号）/
//                          指纹大小写变体 / 明文指纹不上报 / 换 IP 被限流 / 设备自愈只一次
//   表 B 绑定：「我已有 Key」的成功文案与「业务错误不换域名」
//   表 C 换 Key：**失败绝不清旧 Key**（saveKey 只在成功且拿到非空 Key 时调一次）
//
// 口径（#261 / #264）：判「这台设备领没领过」只认服务端字段，客户端只上报指纹、不自己判定；
// 因此本文件把「换 IP」写成「服务端按 IP 限流 → 客户端如实报错、不自愈不重试」，
// 而不是假装客户端能验 IP。
//
// 跑法：node --test tests/unit/domain06-claim-identity-matrix.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHarness } from '../fixtures/domain06-07/harness.mjs'
import {
  createMemoryStorage,
  createRecorder,
  json,
  network,
} from '../fixtures/domain06-07/fakes.mjs'

const harness = await createHarness()
const { applyForKey, claimMessageKeyFor, runWithDeviceSelfHeal, fetchInviteProfile } =
  await harness.importSource('src/services/invite/api.ts')
const { adoptServerDeviceId, DEVICE_ID_STORAGE_KEY } = await harness.importSource(
  'src/services/invite/device.ts'
)
const { bindExistingKey, bindSuccessKey } = await harness.importSource(
  'src/services/invite/bind.ts'
)
const { rotateKey, rotateSuccessKey } = await harness.importSource('src/services/invite/rotate.ts')
const { zh } = await harness.importSource('src/i18n/zh.ts')

const DEVICE = 'd-11111111111111111111111111111111'
const OTHER_DEVICE = 'd-22222222222222222222222222222222'
const DEVICE_FP = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const KEY = 'sk-ours-claim-matrix-key-001122334455'
const NEW_KEY = 'sk-ours-claim-matrix-key-ffeeddccbbaa'

/** 服务端成功响应：/apply 与 /me 同款字段 */
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

/** `services/invite/device.ts` 只认 { read, write } 这个最小形状（与 localStorage 解耦） */
const deviceStorageOf = (storage) => ({
  read: () => storage.getItem(DEVICE_ID_STORAGE_KEY),
  write: (value) => storage.setItem(DEVICE_ID_STORAGE_KEY, value),
})

const readLocalDeviceId = (storage) => storage.getItem(DEVICE_ID_STORAGE_KEY)

// ------------------------------------------------------------------ 表 A：领取身份矩阵

const CLAIM_ROWS = [
  {
    id: 'A1',
    name: 'F6-03 首次领取 201 + new_user_granted:true → granted（唯一允许显示「领取成功」的分支）',
    reply: json(201, { ...profile(), key: NEW_KEY, new_user_granted: true }),
    expect: { outcome: 'granted', messageKey: 'oursClaimOk', hasFp: true, key: NEW_KEY },
    deviceId: DEVICE,
    deviceFp: DEVICE_FP,
  },
  {
    id: 'A2',
    name: 'F6-04 同 device 重放 200（老服务端无新字段）→ 同一账号同一把 Key，不重复发额度',
    reply: json(200, { ...profile(), key: KEY }),
    expect: {
      outcome: 'already-same-account',
      messageKey: 'oursClaimOkExisting',
      hasFp: false,
      key: KEY,
    },
    deviceId: DEVICE,
    deviceFp: '',
  },
  {
    id: 'A3',
    name: 'F6-05 换 device 同指纹 → already_claimed:true + 服务端回填原账号 device_id：认同一账号并把 device_id 写回本地',
    reply: json(200, {
      ...profile(),
      key: KEY,
      already_claimed: true,
      new_user_granted: true,
      device_id: OTHER_DEVICE,
    }),
    expect: {
      outcome: 'already-same-account',
      messageKey: 'oursClaimOkExisting',
      key: KEY,
      adoptedDeviceId: OTHER_DEVICE,
    },
    deviceId: DEVICE,
    deviceFp: DEVICE_FP,
  },
  {
    id: 'A4',
    name: 'F6-05 老 build 静默建号（new_user_granted:false + 另一个 device_id）→ already-other-account，绝不许显示「领取成功」',
    reply: json(200, {
      ...profile({ remaining_points: 0 }),
      key: NEW_KEY,
      new_user_granted: false,
      device_id: OTHER_DEVICE,
    }),
    expect: {
      outcome: 'already-other-account',
      messageKey: 'oursClaimAlreadyGranted',
      adoptedDeviceId: OTHER_DEVICE,
    },
    deviceId: DEVICE,
    deviceFp: DEVICE_FP,
  },
  {
    id: 'A5',
    name: 'F6-04 只有 device_fp_bound:true（两个新字段都缺）+ 200 → 也算已领过（兜底不回归）',
    reply: json(200, { ...profile(), key: KEY, device_fp_bound: true }),
    expect: { outcome: 'already-same-account', messageKey: 'oursClaimOkExisting' },
    deviceId: DEVICE,
    deviceFp: DEVICE_FP,
  },
  {
    id: 'A6',
    name: 'F6-03 指纹大小写 / 空白变体 → 上报前归一化成 64 位小写十六进制（同一枚指纹不能变成两个账号）',
    reply: json(201, { ...profile(), key: NEW_KEY, new_user_granted: true }),
    expect: { outcome: 'granted', messageKey: 'oursClaimOk', fpSent: DEVICE_FP },
    deviceId: DEVICE,
    deviceFp: `  ${DEVICE_FP.toUpperCase()}  `,
  },
  {
    id: 'A7',
    name: 'F6-03 指纹形状不对（明文 / 短串）→ 一个头都不加，注册照常（绝不外发明文标识）',
    reply: json(201, { ...profile(), key: NEW_KEY, new_user_granted: true }),
    expect: { outcome: 'granted', messageKey: 'oursClaimOk', fpSent: null },
    deviceId: DEVICE,
    deviceFp: 'ANDROID_ID-PLAINTEXT-123',
  },
  {
    id: 'A8',
    name: 'F6-17 换 IP 触发服务端限流 429 → 如实报错、可重试，但**不自愈不重发**（只有一条请求）',
    reply: json(429, { error: { code: 'rate_limited', message: 'too many' } }),
    expect: {
      kind: 'error',
      code: 'rate_limited',
      messageKey: 'oursInviteErrRateLimited',
      retryable: true,
    },
    deviceId: DEVICE,
    deviceFp: DEVICE_FP,
    asError: true,
  },
  {
    id: 'A9',
    name: 'F6-03 200 但响应里没有 key → KEY_MISSING 当失败（绝不落一把空 Key）',
    reply: json(200, { ...profile(), new_user_granted: true }),
    expect: {
      kind: 'error',
      code: 'KEY_MISSING',
      messageKey: 'oursInviteErrKeyMissing',
      retryable: true,
    },
    deviceId: DEVICE,
    deviceFp: DEVICE_FP,
    asError: true,
  },
]

for (const row of CLAIM_ROWS) {
  test(`C2/${row.id} ${row.name}`, async () => {
    const storage = createMemoryStorage({ [DEVICE_ID_STORAGE_KEY]: row.deviceId })
    const recorder = createRecorder([row.reply])
    const result = await applyForKey(row.deviceId, recorder.transport, row.deviceFp)

    assert.deepEqual(recorder.paths, ['POST /apply'])
    assert.deepEqual(JSON.parse(recorder.requests[0].body), { device_id: row.deviceId })

    // 指纹只上报、且只上报归一化后的值；形状不对就一个头都不加
    const sentFp = recorder.requests[0].headers['X-Device-Fp'] ?? null
    if (row.expect.fpSent !== undefined) {
      assert.equal(sentFp, row.expect.fpSent)
    } else if (row.expect.hasFp === true) {
      assert.equal(sentFp, DEVICE_FP)
    } else if (row.expect.hasFp === false) {
      assert.equal(sentFp, null)
    }

    if (row.asError === true) {
      assert.equal(result.kind, 'error')
      assert.equal(result.code, row.expect.code)
      assert.equal(result.messageKey, row.expect.messageKey)
      assert.match(zh[result.messageKey], /\S/u)
      return
    }

    assert.equal(result.kind, 'ok')
    // 判定结论只来自服务端字段（#261），文案由 claimMessageKeyFor 翻
    assert.equal(result.outcome, row.expect.outcome)
    assert.equal(claimMessageKeyFor(result.outcome), row.expect.messageKey)
    assert.match(zh[row.expect.messageKey], /\S/u)
    if (row.expect.key !== undefined) {
      assert.equal(result.apiKey, row.expect.key)
    }
    if (row.expect.adoptedDeviceId !== undefined) {
      // 服务端回填的 device_id 必须写回本地：否则后续 /me、兑换全查错设备（#261）
      const adopted = adoptServerDeviceId(
        deviceStorageOf(storage),
        row.deviceId,
        result.serverDeviceId
      )
      assert.equal(adopted, row.expect.adoptedDeviceId)
      assert.equal(readLocalDeviceId(storage), row.expect.adoptedDeviceId)
    }
  })
}

// ------------------------------------------------------------------ 表 A'：设备自愈（F6-17）

const HEAL_ROWS = [
  {
    id: 'A10',
    name: 'F6-17 device_not_found → POST /apply 补一把 Key 并落盘，然后**只重试一次**原请求',
    replies: [
      json(404, { error: { code: 'device_not_found' } }),
      json(200, { ...profile(), key: NEW_KEY }),
      json(200, profile()),
    ],
    expect: { paths: ['GET /me', 'POST /apply', 'GET /me'], healed: true, savedKey: NEW_KEY },
  },
  {
    id: 'A11',
    name: 'F6-17 invalid_device → 重建设备码后**只读**重查；绝不补 /apply（否则「绑定已有 Key」永远 409）',
    replies: [json(400, { error: { code: 'invalid_device' } }), json(200, profile())],
    expect: { paths: ['GET /me', 'GET /me'], healed: true, savedKey: null, regenerated: true },
  },
  {
    id: 'A12',
    name: 'F6-17 自愈只做一次：重试后还是 device_not_found 就如实报错，绝不循环',
    replies: [
      json(404, { error: { code: 'device_not_found' } }),
      json(200, { ...profile(), key: NEW_KEY }),
      json(404, { error: { code: 'device_not_found' } }),
    ],
    expect: {
      paths: ['GET /me', 'POST /apply', 'GET /me'],
      healed: true,
      savedKey: NEW_KEY,
      code: 'device_not_found',
    },
  },
  {
    id: 'A13',
    name: 'F6-17 429 不自愈：一条请求就收手（限流时再打只会更糟）',
    replies: [json(429, { error: { code: 'rate_limited' } })],
    expect: {
      paths: ['GET /me'],
      healed: false,
      savedKey: null,
      code: 'rate_limited',
      messageKey: 'oursInviteErrApplyRateLimited',
    },
  },
]

for (const row of HEAL_ROWS) {
  test(`C2/${row.id} ${row.name}`, async () => {
    const recorder = createRecorder(row.replies)
    const writes = []
    const persisted = []
    const outcome = await runWithDeviceSelfHeal(
      {
        deviceId: DEVICE,
        transport: recorder.transport,
        saveKey: (key) => writes.push(key),
        regenerate: () => OTHER_DEVICE,
        persistDeviceId: (id) => persisted.push(id),
      },
      (deviceId) => fetchInviteProfile(deviceId, recorder.transport)
    )

    assert.deepEqual(recorder.paths, row.expect.paths)
    assert.equal(outcome.healed, row.expect.healed)
    assert.deepEqual(writes, row.expect.savedKey === null ? [] : [row.expect.savedKey])
    if (row.expect.code !== undefined) {
      assert.equal(outcome.kind, 'error')
      assert.equal(outcome.code, row.expect.code)
    } else {
      assert.equal(outcome.kind, 'ok')
    }
    if (row.expect.regenerated === true) {
      // 重生成的设备码必须真的用于下一次请求（否则重查还打在坏设备码上）
      assert.equal(new URL(recorder.requests[1].url).searchParams.get('device_id'), OTHER_DEVICE)
    }
  })
}

// ------------------------------------------------------------------ 表 B：绑定已有 Key（F6-15）

const BIND_ROWS = [
  {
    id: 'B1',
    name: 'F6-15 already_bound:true 也是成功：文案与首次绑定一模一样（不出现「已绑定过」）',
    replies: [
      json(200, {
        key: KEY,
        customer_id: 10,
        invite_code: 'K3M9QW2P',
        already_bound: true,
        remaining_points: 300,
      }),
    ],
    expect: { paths: ['POST /bind'], kind: 'ok', alreadyBound: true, messageKey: 'oursBindOk' },
  },
  {
    id: 'B2',
    name: 'F6-15 业务错误 409 key_already_bound：只发一条（不换域名重放），文案指向「这把 Key 已被占用」',
    replies: [json(409, { error: { code: 'key_already_bound' } })],
    expect: {
      paths: ['POST /bind'],
      kind: 'error',
      messageKey: 'oursBindErrKeyAlreadyBound',
      retryable: false,
    },
  },
  {
    id: 'B3',
    name: 'F6-15 链路本身不通（连不上）→ 换 https 备用域名重试一次，第二次成功即算成功',
    replies: [network(), json(200, { key: KEY, already_bound: false, remaining_points: 300 })],
    // 备用域名是 https 的 /invite/bind（当前域名不同、路径也不同）
    expect: {
      paths: ['POST /bind', 'POST /invite/bind'],
      kind: 'ok',
      via: 'fallback',
      messageKey: 'oursBindOk',
    },
  },
]

for (const row of BIND_ROWS) {
  test(`C2/${row.id} ${row.name}`, async () => {
    const recorder = createRecorder(row.replies)
    const result = await bindExistingKey({ deviceId: DEVICE, apiKey: KEY }, recorder.transport)
    assert.deepEqual(recorder.paths, row.expect.paths)
    assert.equal(result.kind, row.expect.kind)
    if (row.expect.kind === 'ok') {
      assert.equal(bindSuccessKey(result), row.expect.messageKey)
      assert.equal(result.alreadyBound, row.expect.alreadyBound ?? result.alreadyBound)
      if (row.expect.via !== undefined) {
        assert.equal(result.via, row.expect.via)
        // 兜底必须真的换了域名到 https 备用地址
        assert.match(new URL(recorder.requests[1].url).href, /^https:\/\//u)
      }
    } else {
      assert.equal(result.messageKey, row.expect.messageKey)
      assert.equal(result.retryable, row.expect.retryable)
      assert.match(zh[result.messageKey], /\S/u)
    }
  })
}

// ------------------------------------------------------------------ 表 C：换 Key（F6-14）

const ROTATE_ROWS = [
  {
    id: 'C1',
    name: 'F6-14 成功：saveKey 恰好一次，旧 Key 已被服务端作废；已用量取 carried_used_points（不是 0）',
    replies: [
      json(200, {
        customer_id: 10,
        invite_code: 'K3M9QW2P',
        key: NEW_KEY,
        rotated: true,
        carried_used_points: 120,
        quota_points: 400,
        remaining_points: 280,
        key_status: 'active',
      }),
    ],
    expect: {
      paths: ['POST /rotate'],
      kind: 'ok',
      saved: [NEW_KEY],
      replaced: true,
      usedPoints: 120,
      messageKey: 'oursRotateOk',
    },
  },
  {
    id: 'C2',
    name: 'F6-14 失败 404 device_not_found：一个字节都不落盘（旧 Key 继续可用），且绝不补 /apply',
    replies: [json(404, { error: { code: 'device_not_found' } })],
    expect: {
      paths: ['POST /rotate'],
      kind: 'error',
      saved: [],
      keptOldKey: true,
      messageKey: 'oursRotateErrDeviceNotFound',
    },
  },
  {
    id: 'C3',
    name: 'F6-14 200 却没有 key：当失败（绝不拿空 Key 覆盖本地，那比旧 Key 更糟）',
    replies: [json(200, { rotated: true })],
    expect: {
      paths: ['POST /rotate'],
      kind: 'error',
      saved: [],
      keptOldKey: true,
      messageKey: 'oursRotateErrNoKeyInResponse',
    },
  },
  {
    id: 'C4',
    name: 'F6-14 本地没有设备码：一条请求都不发',
    replies: [json(200, { key: NEW_KEY, rotated: true })],
    expect: {
      paths: [],
      kind: 'error',
      saved: [],
      keptOldKey: true,
      messageKey: 'oursRotateErrDeviceMissing',
    },
    deviceId: '   ',
  },
]

for (const row of ROTATE_ROWS) {
  test(`C2/${row.id} ${row.name}`, async () => {
    const recorder = createRecorder(row.replies)
    const saved = []
    const outcome = await rotateKey({
      deviceId: row.deviceId ?? DEVICE,
      transport: recorder.transport,
      currentKey: KEY,
      saveKey: (key) => saved.push(key),
    })
    assert.deepEqual(recorder.paths, row.expect.paths)
    assert.deepEqual(saved, row.expect.saved)
    assert.equal(outcome.kind, row.expect.kind)
    if (row.expect.kind === 'ok') {
      assert.equal(outcome.replaced, row.expect.replaced)
      assert.equal(outcome.profile.usedPoints, row.expect.usedPoints)
      assert.equal(rotateSuccessKey(outcome), row.expect.messageKey)
    } else {
      assert.equal(outcome.keptOldKey, true)
      assert.equal(outcome.messageKey, row.expect.messageKey)
      assert.match(zh[outcome.messageKey], /\S/u)
    }
  })
}

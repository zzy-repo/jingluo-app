// [layer: unit | 纯 Node（假 transport），零浏览器零网络 | 耗时: <1s]
//
// C6 —— 额度与 Key 语义（Issue #407 / 防 #243 #261）
//
// 历史事故：
//   #261 同一枚设备指纹换 `device_id` 重复领新人额度（每次 100 分 ≈ ¥1，可无限刷）；
//        客户端当时把「服务端说这次没发」渲染成「领取成功」，用户与服务端两边都看不出来。
//   #243 `device_id` 是客户端自己存的一个字符串，清数据就换一个 —— 客户端唯一能做的是
//        **如实上报一个用户改不动的指纹**；上报口径错了就等于把这个漏洞放大（#395 的常量指纹）。
//   额度侧的老账（#75 / #90）：积分**不做**人民币折算，换 Key 之后额度与已用量必须原样带过去。
//
// 本契约锁三件事（语义）：
//   Q1 「1 元 = 100 积分」只是**额度口径**，客户端不许把积分反算成人民币（折算函数删过一次，
//      不许拼回来），额度只看服务端下发的 `remaining_points`（缺了就报「查不到」，不许当 0）。
//   Q2 换 Key 额度不丢：已用量从 `carried_used_points` 带过来（不当 0），换失败一个字节都不写本地。
//   Q3 同指纹不重复发新人额度：`new_user_granted:false` 绝不判成 `granted`；
//      常量 / 全零指纹当作「没有指纹」，不发 `X-Device-Fp` 头（否则多台设备被串成一个账号）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installResolveHooks, tableTest } from '../helpers/contract.mjs'

installResolveHooks()

const { formatPoints, formatPlanMeta } = await import('../../src/services/ours/api.ts')
const { parseInviteProfile, classifyClaim, claimMessageKeyFor, applyForKey } = await import(
  '../../src/services/invite/api.ts'
)
const { rotateKey } = await import('../../src/services/invite/rotate.ts')
const { normalizeDeviceFp, isConstantDeviceFp, DEVICE_FP_HEADER } = await import(
  '../../src/services/invite/fingerprint.ts'
)

const DEVICE_ID = 'd-0123456789abcdef0123456789abcdef'
const GOOD_FP = 'ab'.repeat(32)
const ZERO_FP = '0'.repeat(64)

const respond = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })
const transportOf = (result) => async () => result

/** 一行 = 一条额度口径断言 */
const QUOTA_ROWS = [
  {
    id: 'Q1-a',
    what: '积分只显示积分，不做人民币折算（`formatPoints` 不读价格、不带 ¥）',
    check: () => {
      assert.equal(formatPoints(300, '积分'), '300 积分')
      assert.equal(formatPoints(3900, '积分'), '3,900 积分')
      assert.ok(!formatPoints(300, '积分').includes('¥'), '积分文案里不许出现人民币符号')
    },
  },
  {
    id: 'Q1-b',
    what: '套餐副标题两半都来自服务端：价格用下发的 price、积分用下发的 points（不是 points÷100 反算）',
    check: () => {
      // p1 线上实测是 ¥0.10 / 300 积分 —— 若客户端按 1:100 反算，这里会显示 ¥3.00
      assert.equal(formatPlanMeta({ id: 'p1', name: 'p1', price: 0.1, points: 300, currency: 'CNY', enabled: true }, '积分'), '¥0.10 · 300 积分')
    },
  },
  {
    id: 'Q1-c',
    what: '额度只认 remaining_points：字段缺失 → 解析失败（不许默默当 0 分）',
    check: () => {
      const ok = parseInviteProfile({ invite_code: 'INV1', remaining_points: 250, quota_points: 500, used_points: 250 })
      assert.equal(ok.remainingPoints, 250)
      assert.equal(parseInviteProfile({ invite_code: 'INV1' }), null, '缺 remaining_points 必须判「查不到额度」')
      assert.equal(parseInviteProfile({ invite_code: '', remaining_points: 1 }), null, '缺邀请码同样不算有效档案')
    },
  },
]

test('C6 额度口径：只显示积分 / 不折算人民币 / 只认 remaining_points（防 #75）', tableTest('C6-quota', QUOTA_ROWS, (row) => row.check()))

/** 一行 = 一次 `/apply` 响应的**领取语义**（#261 的关闭条件） */
const CLAIM_ROWS = [
  {
    id: 'Q3-a',
    what: '201 + new_user_granted:true = 真的发了新人额度 → granted',
    input: { firstTime: true, newUserGranted: true, serverDeviceId: DEVICE_ID, localDeviceId: DEVICE_ID },
    expect: 'granted',
  },
  {
    id: 'Q3-b',
    what: '同一设备重复 /apply（200，无新字段）= 已申请过，不是「又领了一次」',
    input: { firstTime: false, newUserGranted: null, serverDeviceId: DEVICE_ID, localDeviceId: DEVICE_ID },
    expect: 'already-same-account',
  },
  {
    id: 'Q3-c',
    what: '同指纹换了新 device_id 且服务端已发过（new_user_granted:false）→ 绝不判成 granted（防 #261 复发）',
    input: { firstTime: true, newUserGranted: false, serverDeviceId: 'd-ffffffffffffffffffffffffffffffff', localDeviceId: DEVICE_ID },
    expect: 'already-other-account',
  },
  {
    id: 'Q3-d',
    what: 'already_claimed:true（服务端把原账号交还）→ 同一账号，哪怕 device_id 不同',
    input: { firstTime: true, newUserGranted: null, alreadyClaimed: true, serverDeviceId: 'd-ffffffffffffffffffffffffffffffff', localDeviceId: DEVICE_ID },
    expect: 'already-same-account',
  },
  {
    id: 'Q3-e',
    what: '老服务端（无新字段）+ device_fp_bound:true + 非首次 → 也算领过',
    input: { firstTime: false, newUserGranted: null, deviceFpBound: true, serverDeviceId: DEVICE_ID, localDeviceId: DEVICE_ID },
    expect: 'already-same-account',
  },
]

test('C6 领取语义：只有 granted 才允许显示「领取成功」（防 #261）', tableTest('C6-claim', CLAIM_ROWS, (row) => {
  const outcome = classifyClaim(row.input)
  assert.equal(outcome, row.expect)
  // 文案层只在这三档之间切换：granted 才说「领取成功」，其余都必须说「已领过」那一档
  if (row.expect !== 'granted') {
    assert.notEqual(claimMessageKeyFor(outcome), 'oursClaimOk', '「已领过」被渲染成「领取成功」= #261 的界面症状')
  }
}))

test('C6 指纹只上报、不判定：常量指纹当作「没有指纹」，不发 X-Device-Fp 头（防 #243 #395）', async () => {
  // 形状对但内容是常量 → 规范化后为空，调用方因此不会发这个头
  assert.equal(isConstantDeviceFp(ZERO_FP), true)
  assert.equal(normalizeDeviceFp(ZERO_FP), '')
  assert.equal(normalizeDeviceFp('AB'.repeat(32)), GOOD_FP, '合法指纹要转小写后原样上报')

  const seen = []
  const capture = async (request) => {
    seen.push(request)
    return respond(201, {
      key: 'sk-new-key-0001',
      invite_code: 'INV1',
      device_id: DEVICE_ID,
      remaining_points: 100,
      new_user_granted: true,
    })
  }
  await applyForKey(DEVICE_ID, capture, GOOD_FP)
  await applyForKey(DEVICE_ID, capture, ZERO_FP)
  assert.equal(seen[0].headers[DEVICE_FP_HEADER], GOOD_FP, '有可信指纹时必须上报（否则服务端没法识别「同一台机器」）')
  assert.equal(seen[1].headers[DEVICE_FP_HEADER], undefined, '常量指纹不许上报 —— 那会把无关设备串成一个账号（#395）')
  // 客户端只上报不判定：请求体里没有任何「我领过了」的判断字段
  assert.deepEqual(Object.keys(JSON.parse(seen[0].body)), ['device_id'])
})

test('C6 换 Key 额度不丢：已用量从 carried_used_points 带过来，换失败一个字节都不写（防 #90）', async () => {
  const saved = []
  const ok = await rotateKey({
    deviceId: DEVICE_ID,
    currentKey: 'sk-old-key-0001',
    saveKey: (key) => saved.push(key),
    transport: transportOf(
      respond(200, {
        key: 'sk-new-key-0002',
        invite_code: 'INV1',
        rotated: true,
        // /rotate 没有 used_points，只有 carried_used_points：读成 0 就等于「一分没用过」
        carried_used_points: 250,
        quota_points: 500,
        remaining_points: 250,
        key_status: 'active',
      })
    ),
  })
  assert.equal(ok.kind, 'ok')
  assert.deepEqual(saved, ['sk-new-key-0002'], '成功时才落盘，且只落一次')
  assert.equal(ok.profile.remainingPoints, 250, '剩余额度必须原样带过来')
  assert.equal(ok.profile.usedPoints, 250, '已用量必须跟着带过来（读成 0 = 用户的积分凭空变多）')

  // 失败分支：旧 Key 继续可用，本地一个字节都不许动
  const afterFail = []
  const failed = await rotateKey({
    deviceId: DEVICE_ID,
    currentKey: 'sk-old-key-0001',
    saveKey: (key) => afterFail.push(key),
    transport: transportOf(respond(404, { code: 'device_not_found' })),
  })
  assert.equal(failed.kind, 'error')
  assert.equal(failed.keptOldKey, true)
  assert.deepEqual(afterFail, [], '换 Key 失败却写了本地 = 用户连原来那把也没了')
})

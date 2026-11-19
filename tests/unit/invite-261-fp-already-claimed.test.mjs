// [layer: unit | 依赖: 无（纯 Node，零浏览器，不发网络请求） | 耗时: <1s] 说明见 tests/README.md
// 同一设备指纹换 device_id 再领取时的**响应语义**（Issue #261）。
//
//   cd /d/all_project/runs/fix261 && node tests/unit/invite-261-fp-already-claimed.test.mjs
//
// 只 import src/services/invite/{api,device}.ts 与 src/i18n/{zh,en}.ts，用假 transport / 假存储
// 断言行为，不碰 DOM、不发网络请求、不打印任何凭据。
//
// 这一层能保证什么、不能保证什么（如实写在测试里，避免以后被读成「漏洞已修复」）：
//   ✅ 服务端**说**「已领过」（new_user_granted:false / device_fp_bound:true）时，客户端
//      一定渲染「已领取」而不是「领取成功」；
//   ✅ 服务端回填的 device_id 一定写回本地，后续 /me 不再问到一台不存在的设备；
//   ❌ 服务端仍然静默新建 0 额度账号时，**额度回到原账号**是服务端的事，客户端做不到；
//      这里只能保证「不谎报成功」。
//
// 覆盖：
//   [1] 服务端返回原账号（200，device_id 与本地相同）→ 已领过 / 同一把 Key
//   [2] 服务端仍然静默建新号（201，回另一个 device_id、0 额度）→ 已领过 / **不显示成功**
//   [3] 真新人（201，new_user_granted:true）→ 领取成功
//   [4] 老服务端（没有 new_user_granted 字段）→ 退化到 #261 之前的判定，不误报「已领过」
//   [5] device_id 写回：只认合法值，同值不重复写，坏值绝不写坏本地
//   [6] 自愈链路（device_not_found → /apply）也用服务端回填的 device_id 重试并落盘
//   [7] 文案：三种语义各一句、zh/en 成对、绝不含 device_id / Key
import { registerHooks } from 'node:module'

// 与打包器一致：源码内部用 .js 说明符指向 .ts 文件
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

const { zh } = await import('../../src/i18n/zh.ts')
const { en } = await import('../../src/i18n/en.ts')
const {
  applyForKey,
  claimMessageKeyFor,
  classifyClaim,
  fetchInviteProfile,
  readOptionalBoolean,
  runWithDeviceSelfHeal,
} = await import('../../src/services/invite/api.ts')
const { DEVICE_ID_STORAGE_KEY, adoptServerDeviceId, isDeviceId } = await import(
  '../../src/services/invite/device.ts'
)

/** 本地的设备码（客户端自己生成、存在 localStorage 的那个） */
const LOCAL_ID = 'd-0123456789abcdef0123456789abcdef'
/** 服务端回填的**另一个** device_id（原账号 / 被分配的新号）—— 与 LOCAL_ID 必然不同 */
const SERVER_ID = 'd-fedcba9876543210fedcba9876543210'
const KEY_A = 'sk-live-261-aaaa1111bbbb2222cccc3333dddd4444'
const KEY_B = 'sk-live-261-eeee5555ffff6666aaaa7777bbbb8888'

/** 服务端 /apply 的档案字段（2026-11-19 实测的原样命名） */
const PROFILE = {
  invite_code: 'G7TA7UR3',
  invited_count: 0,
  max_invites: 20,
  bonus_points: 0,
  redeemed: false,
  quota_points: 100,
  used_points: 0,
  remaining_points: 100,
  key_status: 'active',
}
/** 静默新建的 0 额度账号（#261 实测的 customer 25 那种） */
const PROFILE_ZERO = { ...PROFILE, quota_points: 0, used_points: 0, remaining_points: 0 }

const failures = []
const checks = { n: 0 }
const ok = (message) => {
  checks.n += 1
  console.log(`  ok  ${message}`)
}
const bad = (message) => {
  failures.push(message)
  console.error(`  ✗   ${message}`)
}
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    ok(`${label} = ${a}`)
  } else {
    bad(`${label}：期望 ${b}，实际 ${a}`)
  }
}
const truthy = (condition, label) => (condition ? ok(label) : bad(label))

const fakeTransport = (responses) => {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    const next = responses.length > 1 ? responses.shift() : responses[0]
    return typeof next === 'function' ? next(request) : next
  }
  return { transport, calls }
}
const json = (status, body) => ({ kind: 'response', status, text: JSON.stringify(body) })
const errorBody = (code) => ({ error: { code, message: 'server says no' } })
const memStorage = (initial) => {
  const store = new Map(initial === undefined ? [] : [[DEVICE_ID_STORAGE_KEY, initial]])
  return {
    store,
    read: () => store.get(DEVICE_ID_STORAGE_KEY) ?? null,
    write: (value) => store.set(DEVICE_ID_STORAGE_KEY, value),
  }
}

// ---------------------------------------------------------------- [1] 服务端返回原账号
console.log('\n[1] 服务端返回原账号（200 + 同一个 device_id）→ 已领过，同一把 Key')
{
  const { transport, calls } = fakeTransport([
    json(200, {
      ...PROFILE,
      key: KEY_A,
      device_id: LOCAL_ID,
      customer_id: 24,
      new_user_granted: false,
      device_fp_bound: true,
    }),
  ])
  const result = await applyForKey(LOCAL_ID, transport, 'f'.repeat(64))
  eq(result.kind, 'ok', '200 → ok（不是错误）')
  eq(result.outcome, 'already-same-account', '语义 = 已领过、同一账号')
  truthy(result.outcome !== 'granted', '绝不判成「领取成功」')
  eq(result.newUserGranted, false, 'new_user_granted:false 被读出来（不是 null）')
  eq(result.deviceFpBound, true, 'device_fp_bound:true 被读出来')
  eq(result.serverDeviceId, LOCAL_ID, '服务端回填的 device_id 拿到手')
  eq(result.apiKey, KEY_A, 'Key 就是原账号那把')
  eq(result.profile.remainingPoints, 100, '额度显示原值 100（不是 0）')
  eq(result.firstTime, false, '200 → firstTime:false（旧字段语义不变）')
  eq(claimMessageKeyFor(result.outcome), 'oursClaimOkExisting', '文案 →「此前已领取，继续使用同一把 Key」')
  eq(calls.length, 1, '只发一次请求')
  eq(JSON.parse(calls[0].body), { device_id: LOCAL_ID }, '请求体仍然只有 device_id（指纹只走头）')

  // 同一账号：本地 device_id 不动、存储不写
  const storage = memStorage(LOCAL_ID)
  eq(adoptServerDeviceId(storage, LOCAL_ID, result.serverDeviceId), LOCAL_ID, '同值 → 返回原值')
  eq(storage.store.get(DEVICE_ID_STORAGE_KEY), LOCAL_ID, '同值 → 不写存储')
}

// ---------------------------------------------------------------- [2] 服务端静默建新号
console.log('\n[2] 服务端仍然静默建新号（201 + 回另一个 device_id + 0 额度）→ 不许显示成功')
{
  const { transport } = fakeTransport([
    json(201, {
      ...PROFILE_ZERO,
      key: KEY_B,
      device_id: SERVER_ID,
      customer_id: 25,
      new_user_granted: false,
      device_fp_bound: true,
    }),
  ])
  const result = await applyForKey(LOCAL_ID, transport, 'f'.repeat(64))
  eq(result.kind, 'ok', '201 → ok')
  eq(result.firstTime, true, '201 → firstTime:true（HTTP 语义没变）')
  eq(result.outcome, 'already-other-account', '语义 = 已领过、且是另一个账号')
  truthy(result.outcome !== 'granted', '【核心】即使 201 也不许判成「领取成功」')
  eq(result.profile.remainingPoints, 0, '额度如实是 0（不编造 100）')
  eq(result.serverDeviceId, SERVER_ID, '新 device_id 拿到手')
  eq(claimMessageKeyFor(result.outcome), 'oursClaimAlreadyGranted', '文案 →「这台设备已领过新人额度」')
  truthy(
    claimMessageKeyFor(result.outcome) !== 'oursClaimOk',
    '【核心】文案 key 不是「领取成功」那句'
  )
  truthy(zh.oursClaimAlreadyGranted.includes('已领过'), '中文文案明确说「已领过」')
  truthy(!zh.oursClaimAlreadyGranted.includes('成功'), '中文文案里不出现「成功」')

  // 关键：新 device_id 必须写回本地，否则后续 /me 全查错设备
  const storage = memStorage(LOCAL_ID)
  eq(adoptServerDeviceId(storage, LOCAL_ID, result.serverDeviceId), SERVER_ID, '新 device_id 采纳')
  eq(storage.store.get(DEVICE_ID_STORAGE_KEY), SERVER_ID, '写回 localStorage（覆盖旧值）')
}

// ---------------------------------------------------------------- [3] 真新人
console.log('\n[3] 真新人（201 + new_user_granted:true）→ 领取成功')
{
  const { transport } = fakeTransport([
    json(201, {
      ...PROFILE,
      key: KEY_A,
      device_id: LOCAL_ID,
      customer_id: 24,
      new_user_granted: true,
      device_fp_bound: true,
    }),
  ])
  const result = await applyForKey(LOCAL_ID, transport, 'f'.repeat(64))
  eq(result.outcome, 'granted', '语义 = 领取成功')
  eq(result.newUserGranted, true, 'new_user_granted:true 读出来')
  eq(claimMessageKeyFor(result.outcome), 'oursClaimOk', '文案 →「已领取，剩余 N」')
  eq(result.profile.remainingPoints, 100, '新人额度 100')

  // 服务端没回 device_id（老服务端 / 省略该字段）时也要正常成功，不能因此报错
  const bare = await applyForKey(
    LOCAL_ID,
    fakeTransport([json(201, { ...PROFILE, key: KEY_A })]).transport
  )
  eq(bare.kind, 'ok', '没有 device_id 字段 → 仍然 ok（不因缺字段失败）')
  eq(bare.serverDeviceId, '', '缺字段 → serverDeviceId 空串')
  eq(bare.outcome, 'granted', '缺字段 + 201 → 仍按成功处理')
}

// ---------------------------------------------------------------- [4] 老服务端
console.log('\n[4] 老服务端没有 new_user_granted 字段 → 退化到旧判定，不误报「已领过」')
{
  const fresh = await applyForKey(
    LOCAL_ID,
    fakeTransport([json(201, { ...PROFILE, key: KEY_A })]).transport
  )
  eq(fresh.newUserGranted, null, '缺字段 → null（不是 false）')
  eq(fresh.deviceFpBound, null, 'device_fp_bound 缺字段 → null')
  eq(fresh.outcome, 'granted', '201 且无字段 → 成功（老服务端首次领取）')

  const again = await applyForKey(
    LOCAL_ID,
    fakeTransport([json(200, { ...PROFILE, key: KEY_A })]).transport
  )
  eq(again.outcome, 'already-same-account', '200 且无字段 → 仍是旧的「已申请过」语义')
  eq(claimMessageKeyFor(again.outcome), 'oursClaimOkExisting', '文案与改造前一致（不回归）')

  // device_fp_bound:true 单独出现（没有 new_user_granted）也要能判「已领过」
  const boundOnly = await applyForKey(
    LOCAL_ID,
    fakeTransport([json(201, { ...PROFILE, key: KEY_A, device_fp_bound: true })]).transport
  )
  eq(boundOnly.outcome, 'already-same-account', 'device_fp_bound:true 单独足够判定已领过')

  // 字段类型不对（字符串 / 数字）一律当没有：不猜
  eq(readOptionalBoolean({ new_user_granted: 'false' }, 'new_user_granted'), null, "'false' 字符串 → null")
  eq(readOptionalBoolean({ new_user_granted: 0 }, 'new_user_granted'), null, '0 → null')
  eq(readOptionalBoolean({}, 'new_user_granted'), null, '缺字段 → null')
  eq(readOptionalBoolean(null, 'new_user_granted'), null, 'null 记录 → null')
}

// ---------------------------------------------------------------- [5] device_id 写回
console.log('\n[5] device_id 写回：只认合法值，同值不写，坏值绝不写坏本地')
{
  const storage = memStorage(LOCAL_ID)
  eq(adoptServerDeviceId(storage, LOCAL_ID, ''), LOCAL_ID, '空串 → 保持本地值')
  eq(storage.store.get(DEVICE_ID_STORAGE_KEY), LOCAL_ID, '空串 → 不写')

  eq(adoptServerDeviceId(storage, LOCAL_ID, 'short'), LOCAL_ID, '太短 → 保持本地值')
  eq(adoptServerDeviceId(storage, LOCAL_ID, 'has space----'), LOCAL_ID, '含空格 → 保持本地值')
  eq(adoptServerDeviceId(storage, LOCAL_ID, 'x'.repeat(129)), LOCAL_ID, '超 128 位 → 保持本地值')
  eq(storage.store.get(DEVICE_ID_STORAGE_KEY), LOCAL_ID, '坏值一个都没写进去')

  eq(adoptServerDeviceId(storage, LOCAL_ID, `  ${SERVER_ID}  `), SERVER_ID, '前后空白 → 去空白后采纳')
  truthy(isDeviceId(storage.store.get(DEVICE_ID_STORAGE_KEY)), '写进去的值一定合法')
  eq(storage.store.get(DEVICE_ID_STORAGE_KEY), SERVER_ID, '确实写的是服务端那个')

  // 本地是脏值（老版本/手工改坏）时，服务端给的合法值直接覆盖
  const dirty = memStorage('bad id!')
  eq(adoptServerDeviceId(dirty, 'bad id!', SERVER_ID), SERVER_ID, '本地脏值 → 被服务端合法值覆盖')
}

// ---------------------------------------------------------------- [6] 自愈链路
console.log('\n[6] 自愈：device_not_found → /apply 回填的 device_id 用来重试并落盘')
{
  const { transport, calls } = fakeTransport([
    json(404, errorBody('device_not_found')),
    json(201, { ...PROFILE, key: KEY_B, device_id: SERVER_ID, new_user_granted: false, device_fp_bound: true }),
    json(200, { ...PROFILE, device_id: SERVER_ID }),
  ])
  const saved = []
  const persisted = []
  const outcome = await runWithDeviceSelfHeal(
    {
      deviceId: LOCAL_ID,
      transport,
      saveKey: (key) => saved.push(key),
      persistDeviceId: (id) => persisted.push(id),
    },
    (id) => fetchInviteProfile(id, transport)
  )
  eq(calls.length, 3, '三次请求：原 /me → /apply → 重试 /me')
  truthy(calls[1].url.endsWith('/apply'), '第二次是 /apply')
  truthy(calls[2].url.includes(`device_id=${SERVER_ID}`), '重试用的是服务端回填的 device_id')
  eq(outcome.kind, 'ok', '自愈成功')
  eq(outcome.deviceId, SERVER_ID, 'outcome 带出最终 device_id（界面据此 setState）')
  eq(persisted, [SERVER_ID], 'persistDeviceId 被调用一次，值正确')
  eq(saved, [KEY_B], '拿到的 Key 落盘一次')
}

// ---------------------------------------------------------------- [7] 文案
console.log('\n[7] 文案：三种语义各一句，zh/en 成对，绝不含 device_id / Key')
{
  const keys = ['oursClaimOk', 'oursClaimOkExisting', 'oursClaimAlreadyGranted']
  for (const key of keys) {
    truthy(typeof zh[key] === 'string' && zh[key].length > 0, `zh.${key} 存在且非空`)
    truthy(typeof en[key] === 'string' && en[key].length > 0, `en.${key} 存在且非空`)
  }
  truthy(zh.oursClaimAlreadyGranted !== zh.oursClaimOkExisting, '「已领过」与「同一把 Key」是两句不同的话')
  truthy(zh.oursClaimAlreadyGranted !== zh.oursClaimOk, '「已领过」与「领取成功」是两句不同的话')

  // 文案里只允许 {points} 这种占位；不允许把设备码 / Key 拼进去
  const allowedPlaceholder = /\{points\}/g
  for (const key of keys) {
    for (const table of [zh, en]) {
      const left = table[key].replace(allowedPlaceholder, '')
      truthy(!left.includes('{'), `${key} 的占位符只有 {points}`)
      truthy(!/[0-9a-f]{16,}/.test(table[key]), `${key} 文案里没有长十六进制串（设备码/Key）`)
    }
  }

  // classifyClaim 的三条分支直接断言（纯函数，界面文案靠它）
  eq(
    classifyClaim({ firstTime: true, newUserGranted: true, serverDeviceId: LOCAL_ID, localDeviceId: LOCAL_ID }),
    'granted',
    'classifyClaim：真的发了额度 → granted'
  )
  eq(
    classifyClaim({ firstTime: false, newUserGranted: false, serverDeviceId: LOCAL_ID, localDeviceId: LOCAL_ID }),
    'already-same-account',
    'classifyClaim：已领过 + 同一账号'
  )
  eq(
    classifyClaim({ firstTime: true, newUserGranted: false, serverDeviceId: SERVER_ID, localDeviceId: LOCAL_ID }),
    'already-other-account',
    'classifyClaim：已领过 + 另一个账号'
  )
}

// ---------------------------------------------------------------- 汇总
console.log(`\n${checks.n - failures.length}/${checks.n} 项通过`)
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：`)
  for (const item of failures) console.error(`  - ${item}`)
  process.exitCode = 1
} else {
  console.log('全部通过 ✅')
}
